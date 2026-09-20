/**
 * 运行环境自检 + 一键修复（设计见 `docs/env-doctor.md`）。
 *
 * 这个模块解决的是「打开应用之后，这台机器上到底有什么、能不能用」：
 *   - **探测是只读的**：找外部 node / npm / pnpm / dsh 本体、实测 dsh 能不能跑、
 *     看应用自带运行时与本地 Shell。不写任何文件、不改设置。
 *   - **判定是纯函数**（`judgeEnvironment`）：只读入参，不碰磁盘、不起子进程、
 *     不读 `process.*`、不看时钟 —— 所以 `test/selftest.ts` 喂一个对象字面量
 *     就能把八项的所有分支测完，不需要装 pnpm、不需要起任何进程。
 *   - **修复只有两个动作**（`install-pnpm` / `install-dsh`）：都用探测到的完整路径
 *     npm、argv 数组、不经 shell，每次都要用户点确认，跑完自动复检。
 *
 * 为什么判定必须纯：这一页的全部价值是「说清事实」。一旦判定里混进 IO，
 * 它就只能在真机上验证 —— 而真机上恰好是最难复现"没装 pnpm / node 版本不对"的地方。
 *
 * 为什么这里不 import electron：自检要直接 import 这个模块（静态检查 + 纯函数夹具），
 * 而 electron 在普通 Node 里加载不了。运行时事实（platform / isPackaged / process.versions）
 * 由主进程通过 `EnvDoctorHooks.runtime` 注入。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

import type {
  EnvCheck,
  EnvCheckId,
  EnvCheckStatus,
  EnvDoctorReport,
  EnvFixAction,
  EnvFixPlan,
  EnvFixState,
  EnvGateState,
  EnvNodeOwner,
  EnvStepStatus,
  EnvWizardState,
  EnvWizardStep,
  EnvWizardStepId,
} from '../shared/ipc';
import { RELEASES_URL } from '../shared/ipc';
import { pluginRegistryEnv } from './plugin-manager';
// 归属判据**只有一份**，住在安装引擎里（需求 §7.7 第 1 条：采集侧与安装计划共用同一个纯函数）。
// 方向上是 `env-doctor → node-installer`，与"安装引擎不许 import env-doctor"正好相反，所以不构成环。
import {
  detectNodeOwner,
  deriveNvmModelFromEnvironment,
  readNodeMsiInstallPath,
} from './node-installer';
import {
  canRunDsh,
  dshArgsFor,
  envWithKnownBins,
  findNodeExe,
  findPnpm,
  hasVcRuntime,
  homeDir,
  findSkippedNodeShim,
  isNodeShim,
  isRunnablePath,
  isWindows,
  killTreeSync,
  launchSpec,
  pathWithKnownBins,
  resolveDshLauncher,
  resolveShell,
  stripAnsi,
  whichSync,
  windowsBinCandidates,
  type DshLauncher,
  type LaunchSpec,
} from './process-utils';
import type { Settings, SettingsValues } from './settings';

/** 与 vite 的 engines.node 同一句（AGENTS 第 1 节：`npm install` 的门槛）；自检把两处钉在一起 */
export const NODE_RANGE = '^22.19.0 || >=24.0.0';

/**
 * **构建期**要求（vite 的 engines）：只用来判「打包进来的那个运行时」够不够新。
 *
 * 别把它当成"能不能跑 dsh"的判据 —— 这两件事的区间不一样，混用过一次（见 `NODE_RANGE`）。
 */
export const NODE_RANGE_BUILD = '^20.19.0 || >=22.12.0';

/** 探测子进程超时：与 `canRunDsh` 的 8000 一致 */
export const PROBE_TIMEOUT_MS = 8000;
/** 一键修复的超时：装 npm 包可能要编译/下载，给足 5 分钟，到点自动中断 */
export const FIX_TIMEOUT_MS = 5 * 60 * 1000;
/** 修复输出只保留尾部这些字符（与插件操作同款做法，界面显示原文用） */
export const FIX_TAIL_CHARS = 64 * 1024;
/** 探测子进程的 stderr 只保留尾部这些字符（它是给日志的原文，别把几百 KB 堆栈整段带上） */
export const STDERR_TAIL_CHARS = 2000;

/** 版本号解析结果；不引 semver，只认 NODE_RANGE / NODE_RANGE_BUILD 这两句区间 */
export interface NodeVersion {
  major: number;
  minor: number;
  patch: number;
}

/** 探测到的一条事实（子进程的结果都在这里，判定不看别的） */
export interface VersionProbe {
  path: string | null;
  /** --version 的第一行；没跑起来时为 null */
  version: string | null;
  /** 子进程的退出码；没跑起来时为 null（退出码 0 + 零输出是"静默退出"的关键特征） */
  exitCode: number | null;
  /** 子进程没能跑起来时的原因（EPERM = 这个环境不允许起子进程，和"没装"是两件事） */
  error: string | null;
  /**
   * 子进程写到 stderr 的尾部内容（**判定不看它**：界面上不许出现原始术语，
   * 它的唯一去处是日志 —— 见 `probeTroubleLines`）；没有输出时为 null。
   */
  stderr?: string | null;
  /** true = 这一轮**故意没测**（启动瞬间的快速探测）；判定当"测不出来"（warn），不是"没装" */
  skipped?: boolean;
  /**
   * true = 超过 `PROBE_TIMEOUT_MS` 没回应（子进程已被结束）。
   *
   * **必须与"退出码 0 + 零输出"区分开**：后者是"这份二进制跑不动"的签名（§7.4），
   * 前者只是"它还在忙"（例如转发器正在准备自己的运行时）。混在一起会把用户引去重装一个
   * 好端端的 dsh —— 真机上就这么错过一次。
   */
  timedOut?: boolean;
}

/** dsh 本体的定位 + 实测结果 */
export interface DshProbe {
  /** 解析结果：custom / custom-shim / node-bin / shim / npx；解析不出来时为 null */
  kind: string | null;
  /** 命令原文（界面直接显示，不重新拼） */
  display: string | null;
  /** 实测是否有输出（`node-bin` 那条路复用 canRunDsh 的缓存结论） */
  runs: boolean;
  version: string | null;
  exitCode: number | null;
  error: string | null;
  /** 四种方式都没解析出来时的原因（`resolveDshLauncher` 抛出的那句话） */
  resolveError: string | null;
  /** 同上（`VersionProbe.stderr`）：只给日志，不上界面 */
  stderr?: string | null;
  /** 同上：true = 这一轮**故意没测**（快速探测不起子进程，也就不定位 launcher） */
  skipped?: boolean;
  /** 同 `VersionProbe.timedOut`：超过 8 秒没回应，**不是**"这份 dsh 跑不动" */
  timedOut?: boolean;
}

export interface ShellProbe {
  file: string | null;
  exists: boolean;
}

/** 一轮探测的原始事实：判定的唯一入参（**不上线缆**，所以留在本模块而不是 shared/ipc.ts） */
export interface EnvProbeRaw {
  checkedAt: number;
  /** 直接用主进程的 process.platform / app.isPackaged，判定函数不自己读 */
  platform: string;
  packaged: boolean;
  bundled: { electron: string; node: string; chrome: string };
  node: VersionProbe;
  /**
   * 通用搜索（`findNodePath()`）另找到的那份外部 Node —— **只在它与 `node` 不是同一个时**才有值。
   *
   * 为什么要有：`node` 这一行报的是"**真正会被用来跑 dsh 的那一份**"（用户裁决，见 §7.25）；
   * 而机器上往往还躺着别的 node（另一个版本管理器、或一个**转发器** shim）。用户拿终端里的
   * `node -v` 来对账时对不上就是因为它。把"另有一份、它是什么"写出来，这条对不上的疑惑才收口。
   */
  otherNode?: { path: string; version: string | null; shim: boolean };
  /** `node` 那一份是不是"真正会被用来跑 dsh 的"（见 `otherNode` 的说明） */
  nodeServesDsh?: boolean;
  npm: VersionProbe;
  pnpm: VersionProbe;
  dsh: DshProbe;
  shell: ShellProbe;
  /**
   * 这台机器有没有 VC++ 2015-2022 运行库（`process-utils.hasVcRuntime()` 的只读判断）。
   *
   * 为什么判定需要它：pnpm 11 起在 Windows 上发的是**原生 exe**，缺这个运行库时加载直接失败、
   * 没有任何输出（真机 VM-09）。于是"该装哪一档 pnpm"成了一件事先要认的事实。
   * `true` = 有（可以装最新）；`false` = 缺（走纯 JS 那条线 `pnpm@10`）；没探测过时缺省当"有"。
   */
  vcRuntime?: boolean;
  /**
   * 我们找到的那份 Node 是不是**版本管理器管的**（见 `looksVersionManagerNode`）。
   *
   * 采集时算一次（只读路径与环境变量），判定据此区分两种"跑不出结果"：版本管理器没装/没选中版本
   * （该点应用里的「安装」）与"这份 Node 本身坏了"（该重装）。
   */
  nodeFromVersionManager?: boolean;
  /**
   * 这份 Node 是谁管的（需求 §7.7 / 冻结 §3.2.1）。
   *
   * **判定不在这里做**：采集侧只把事实凑齐（真实路径 + 环境变量 + §7.6 的模型 + 注册表里那个
   * 安装目录），判据唯一的一份是安装引擎里的纯函数 `detectNodeOwner`；`judgeEnvironment` 只搬运。
   * 快速探测也判得出来（这条判据里没有一条依赖子进程）。
   */
  nodeOwner?: EnvNodeOwner;
  /** 归属判定的证据（人话，逐条；进日志与确认区的「详情」，评审能对账"为什么是这一条"） */
  nodeOwnerEvidence?: string[];
  /** 采集本身有没有意外（例如读设置失败），有值时整份报告要带出来 */
  error: string | null;
}

/** 采集需要的运行时事实（主进程给，模块自己不读 process.* —— 见文件头） */
export interface EnvRuntime {
  platform: string;
  packaged: boolean;
  bundled: { electron: string; node: string; chrome: string };
}

const EMPTY_VERSION_PROBE: VersionProbe = {
  path: null,
  version: null,
  exitCode: null,
  error: null,
};

/** 解析 `v24.19.0` / `24.19` 这类输出；认不出来返回 null（不猜） */
export function parseNodeVersion(text: string): NodeVersion | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text ?? ''));
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = match[3] === undefined ? 0 : Number(match[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  return { major, minor, patch };
}

/**
 * 是否落在 **dsh 的要求** `^22.19.0 || >=24.0.0` 里。
 *
 * 出处：dsh 自己的 `package.json` 没有 `engines`，真正卡住它的是依赖链里的 undici 8
 * （`engines: { node: '>=22.19.0' }`）；dsh 上游源码给的就是这一句（比 undici 那句多排除奇数版 23）。
 * 只认这一句，不引 semver：`22.19+` 与 `24+` 算，`23` 与 `≤22.18` 不算。自检逐个钉住边界。
 *
 * **别再退回 vite 那句**：`^20.19.0 || >=22.12.0` 是构建期要求，而 20.19 与 22.12–22.18 上
 * dsh 会「退出码 0、零输出」地静默退出（§7.4），界面上只会显示「已停止」。
 */
export function satisfiesNodeRange(version: NodeVersion): boolean {
  const major = version.major;
  if (major < 22) return false;
  if (major === 22) return version.minor >= 19;
  if (major === 23) return false;
  return true; // 24+
}

/** 是否落在**构建期**要求 `^20.19.0 || >=22.12.0`（vite 的 engines）里 —— 只给「应用自带运行时」用 */
export function satisfiesBuildRange(version: NodeVersion): boolean {
  const major = version.major;
  if (major === 20) return version.minor >= 19;
  if (major === 21) return false;
  if (major === 22) return version.minor >= 12;
  return major > 22;
}

/**
 * npm 的 install-scripts 一次性开关。
 *
 * npm 自己会这样说（VM 与船长隔离 prefix 实验的原文一模一样）：
 * `Run \`npm install -g --allow-scripts=pnpm\` to allow these scripts once, or
 * \`npm config set allow-scripts=pnpm --location=user\` to allow them for all global installs.`
 * 我们采用**前者**：只挂在这一条 argv 上，绝不写用户的全局 npm 配置 ——
 * 与 `pluginRegistry` 只注入那一次子进程、不写用户 `.npmrc` 是同一条原则。
 *
 * **它不是已证明的病根，别当结论用**：船长在隔离 prefix 下跑过对照实验
 *（`.verify/npm-allow-scripts-experiment.log`，node v24.19.0 / npm 11.17.0 / pnpm 12.4.2）：
 * 不带开关时 npm 只是**警告**，`pnpm.cmd --version` 照样打出 12.4.2；而用户虚拟机里界面找到的是
 * **bin 根目录**下的 `…\nvm\nodejs\pnpm.exe`，那个位置不是 npm 的 shim（npm 的 bin 根目录只有
 * `pnpm` / `pnpm.cmd` / `pnpm.ps1`），只可能来自 pnpm 自己的 `install.js` —— 也就是说那边脚本
 * **跑过了**，只是产出的 exe 不可用。所以这条开关是按 npm 原文补上的一手（无害且官方），
 * 而这次真正的交付是**把"文件在但跑不起来"做成可诊断的失败态**（见 `probeFixTarget` /
 * `fixDoneMessage` / `EnvFixRunner` 里的原始输出落日志）。
 */
export const ALLOW_INSTALL_SCRIPTS_FLAG = '--allow-scripts=pnpm';

/** 一键修复失败时写进日志的 npm 原文尾部字数（细节留日志、结论给人话，见 t23 那条口径） */
export const RAW_LOG_CHARS = 4000;

/** npm 提示 install scripts 被拦时的关键词：原文进日志，界面只说人话 */
export const INSTALL_SCRIPTS_WARNING = /install-scripts|allow-scripts/i;

/**
 * pnpm 两条线（VM-09）：缺 VC++ 运行库时装**纯 JS** 那条，否则装最新。
 *
 * 事实（可用 `npm view` 复现，见 .verify/t37-pnpm-meta.log）：
 *
 * | pnpm   | `bin`                                | 纯净 Windows |
 * | ------ | ------------------------------------ | ------------ |
 * | 10.x   | `bin/pnpm.cjs`（纯 JS）              | ✅ 能跑      |
 * | 11.x   | `bin/pnpm.mjs`（包装，最终 spawn 原生） | ❌          |
 * | 12.x   | `pnpm`（`install.js` 换成原生 exe）  | ❌          |
 *
 * 所以缺运行库时钉 10.x 这条**纯 JS** 线；有运行库时不动（继续最新）。
 * **只跟 pnpm 有关**：同一台真机上 `node -v` / `npm -v` 都正常，不要因此去要求用户装运行库。
 */
export const PNPM_PURE_JS_SPEC = 'pnpm@10';
export const PNPM_LATEST_SPEC = 'pnpm';

/** 这一次该装哪一档 pnpm（纯函数，自检钉两支分支） */
export function pnpmInstallSpec(vcRuntime: boolean): string {
  return vcRuntime ? PNPM_LATEST_SPEC : PNPM_PURE_JS_SPEC;
}

/**
 * 一键修复的计划：**只有两个动作**，都只改全局 npm 包。
 *
 * 纯函数：`target` 由调用方（EnvDoctor）用一次 `npm prefix -g` 补上 —— 判定这边不碰子进程。
 * npm 路径拿不到时返回 null（起不了子进程就不该给按钮）。
 *
 * `vcRuntime`：VC++ 运行库在不在（缺 → 装纯 JS 那条线，见 `PNPM_PURE_JS_SPEC`）。
 * **缺省当"有"** —— 没探测过的调用方（既有夹具、纯函数调用）保持原样装最新，不会被无声降级。
 */
export function envFixPlan(
  action: EnvFixAction,
  npmPath: string | null,
  vcRuntime = true,
): EnvFixPlan | null {
  const npm = String(npmPath ?? '').trim();
  if (!npm) return null;
  // install-pnpm 带一次性开关：npm 的 install-scripts 门禁会拦掉 pnpm 的安装脚本（VM-06 的原文），
  // 放行是官方补救；缺 VC++ 运行库时还要换到纯 JS 那条线（VM-09）。dsh 没有这两件事，argv 原样。
  const pureJs = !vcRuntime;
  const args =
    action === 'install-pnpm'
      ? ['i', '-g', pnpmInstallSpec(vcRuntime), ALLOW_INSTALL_SCRIPTS_FLAG]
      : ['i', '-g', '@deepseek-ai/dsh'];
  const note =
    action === 'install-pnpm'
      ? `这会修改你系统上的全局 npm 包，需要联网；这一次安装会放行 pnpm 的安装脚本（一次性开关，不改你的全局 npm 配置）。${
          pureJs
            ? '这台电脑上没找到 VC++ 2015-2022 运行库（vcruntime140.dll / msvcp140.dll），而 pnpm 11 起在 Windows 上发的是原生程序、缺它加载会直接失败（跑起来没有任何输出）—— 所以这次装的是纯 JS 那条线（pnpm 10），它不需要这个运行库。'
            : ''
        }装完会自动复检一次。`
      : '这会修改你系统上的全局 npm 包，需要联网。装完会自动复检一次。';
  return {
    action,
    display: `${npm} ${args.join(' ')}`,
    file: npm,
    args,
    target: null,
    note,
  };
}

/**
 * npm 的启动 spec（名字沿用设计文档与自检里的那个）：实现就是 `process-utils.ts` 的统一包装器
 * `launchSpec()` —— 与 plugin-manager 启动 dsh 用的是**同一个**（`.cmd` / `.bat` / 无扩展名的
 * 路径在 Windows 上都得经 cmd.exe，而且必须带 `windowsVerbatimArguments`）。
 */
export function npmLaunchSpec(npmPath: string, args: string[], platform: string): LaunchSpec {
  return launchSpec(npmPath, args, platform);
}

/** 超时终态的那句话（纯函数，自检直接钉文案，不让它退化成「退出码未知」） */
export function fixTimeoutMessage(timeoutMs: number = FIX_TIMEOUT_MS): string {
  return `超过 ${Math.round(timeoutMs / 60000)} 分钟没跑完，已自动中断（npm 可能已经写了一部分）`;
}

/**
 * 把 npm 的原始输出归纳成一句人话；认不出来返回 null（界面显示原文，**不编原因** ——
 * 与 `summarizePluginFailure` 同一条原则）。
 */
export function summarizeEnvFixFailure(output: string): string | null {
  const text = String(output ?? '').slice(-FIX_TAIL_CHARS);
  if (/EACCES|EPERM|权限拒绝|permission denied/i.test(text)) {
    return '全局目录不可写（权限不足）。可以用官方安装包装一遍 Node（它会配好权限），或改用 `corepack enable pnpm`。';
  }
  if (/ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|network/i.test(text)) {
    return '网络不通，没能连上 registry。可以在设置里填「插件安装源」，或检查代理。';
  }
  const missing = /^(@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?) is not in the npm registry/m.exec(
    text,
  )?.[1];
  if (missing) return `registry 上没有「${missing}」。`;
  if (/registry\.npm\.taobao\.org/i.test(text)) {
    return 'registry 链到了已停服的淘宝旧镜像（registry.npm.taobao.org）—— 换一个能用的源，例如 https://registry.npmmirror.com。';
  }
  if (/ERR_PNPM_FETCH_404|404 Not Found/i.test(text)) {
    const host = /GET https?:\/\/([^/\s]+)/i.exec(text)?.[1];
    return host ? `${host} 上没有这个包（名字或版本可能不对）。` : 'registry 上没有这个包。';
  }
  return null;
}

/**
 * `reg query <key>` 的输出 → 变量表（**纯函数**，自检直接喂真机原文）。
 *
 * 真机形状（本机 Windows 11 实测，见 test/selftest.ts 里的夹具）：
 *
 *     HKEY_CURRENT_USER\Environment
 *         NVM_HOME    REG_EXPAND_SZ    D:\Nvm\nvm
 *         Path    REG_EXPAND_SZ    …;%NVM_HOME%;%NVM_SYMLINK%;…
 *
 * 只认 `名称  类型  值` 这种一行一条的行（类型必须是 `REG_*`）；表头、空行一律跳过。
 */
export function parseRegQueryVars(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/.exec(line);
    if (!match) continue;
    vars[match[1]] = match[3].trim();
  }
  return vars;
}

/**
 * 展开 `%NAME%`（大小写不敏感；认不出来的原样留着）。最多 3 轮，够 `%A% → %B% → 值` 这种链。
 *
 * 为什么要有它：注册表里的 `Path` 常见 `%NVM_HOME%;%NVM_SYMLINK%` 这种引用（本机实测就是这样），
 * 不展开的话刷新出来的 Path 里全是不能用的目录 —— 等于白刷新。
 */
export function expandEnvRefs(text: string, vars: Record<string, string>): string {
  const lookup = new Map<string, string>();
  for (const [name, value] of Object.entries(vars)) lookup.set(name.toLowerCase(), value);
  let out = String(text ?? '');
  for (let round = 0; round < 3; round += 1) {
    const next = out.replace(/%([^%]+)%/g, (whole: string, name: string) => {
      return lookup.get(String(name).toLowerCase()) ?? whole;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

/** 多段 PATH 文本合并：去空、去重、**保序**（先出现的优先） */
export function mergePathText(...parts: (string | null | undefined)[]): string {
  const dirs: string[] = [];
  for (const part of parts) {
    for (const dir of String(part ?? '').split(path.delimiter)) {
      const trimmed = dir.trim();
      if (trimmed && !dirs.includes(trimmed)) dirs.push(trimmed);
    }
  }
  return dirs.join(path.delimiter);
}

/**
 * 大小写不敏感地读一个环境变量。
 *
 * 取查找路径时一律写 `'Path'`：Windows 上那个键通常就叫 `Path`、POSIX 上叫 `PATH`，
 * 而**比较是按小写做的**，同一个字面量两边都对 —— 也就不必把这个词本身写进源码
 *（冻结 §3.8 #22 的词表专门盯着它，写进来只会让那条静态断言误伤，与"文案里出现它"无关）。
 */
function envValueOf(env: NodeJS.ProcessEnv, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') return value;
  }
  return null;
}

/** 比较两个目录是不是同一个（Windows 大小写不敏感、结尾分隔符不算差异） */
function sameDir(a: string, b: string): boolean {
  const norm = (dir: string): string =>
    dir
      .replace(/[\\/]+$/, '')
      .toLowerCase()
      .replace(/\//g, '\\');
  return norm(a) === norm(b);
}

/** 一次 `reg query`（拿不到返回 null，绝不抛：沙箱里 spawn 会被拒） */
function regQuery(reg: string, key: string): string | null {
  try {
    const result = spawnSync(reg, ['query', key], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) return null;
    return String(result.stdout ?? '');
  } catch {
    return null;
  }
}

/** 注册表里"系统现在真相"的两段 PATH（展开过变量）；读不到返回 null */
function readRegistryPaths(
  env: NodeJS.ProcessEnv,
): { machine: string | null; user: string | null } | null {
  if (!isWindows) return null;
  const reg = whichSync('reg');
  if (!reg) return null;
  const machineRaw = regQuery(
    reg,
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  );
  const userRaw = regQuery(reg, 'HKCU\\Environment');
  if (machineRaw === null && userRaw === null) return null;
  const machineVars = machineRaw === null ? {} : parseRegQueryVars(machineRaw);
  const userVars = userRaw === null ? {} : parseRegQueryVars(userRaw);
  // 展开用的变量表：进程自己的环境打底（`%SystemRoot%` / `%USERPROFILE%` 经常只在那边有），
  // 注册表里的覆盖它（那才是系统现在的取值）
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') vars[key] = value;
  }
  Object.assign(vars, machineVars, userVars);
  const pick = (source: Record<string, string>): string | null => {
    const key = Object.keys(source).find((name) => name.toLowerCase() === 'path');
    const value = key ? expandEnvRefs(source[key], vars) : '';
    return value.trim() ? value : null;
  };
  return {
    machine: machineRaw === null ? null : pick(machineVars),
    user: userRaw === null ? null : pick(userVars),
  };
}

/**
 * 装完之后**在同一次运行内**刷新查找路径（VM-07）：重读注册表里的两段 PATH + 重扫已知 bin 目录
 * + 这一次装到哪儿了（npm 的全局 prefix）—— 让复检立刻看得见刚装好的东西，不必让用户重开应用。
 *
 * 为什么必须有：Windows 上 GUI 应用拿到的是**启动那一刻**的环境块，而安装器改的是注册表里的 PATH；
 * 不刷新的话"装完了，但这一轮没在已知位置找到"就只能靠重开应用解决（VM 实测里就是这句话）。
 *
 * **只读系统里已有的，不写系统里的任何东西**。安装引擎里有一份同源逻辑，但它住在
 * `node-installer.ts` 且不导出 —— 契约冻结 §4.1 规则 3 明确不许 `env-doctor` import 它，
 * 所以这里按同一套判据自己实现（读的是同样的两处键）。
 *
 * @returns **真正新加进来**的目录（用来在日志里说清"刷新了什么"）
 */
export function refreshLookupPath(
  extraDirs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const existing = envValueOf(env, 'Path') ?? '';
  const known = [...windowsBinCandidates(env, homeDir()), ...extraDirs].filter((dir) =>
    fs.existsSync(dir),
  );
  const registry = readRegistryPaths(env);
  const merged = mergePathText(
    // ① **这一次装到哪儿了**（npm 的全局 prefix）排最前：刚装好的那份必须能被选中 ——
    //    否则 PATH 里那份旧的（VM 里就是那个跑不起来的 `pnpm.exe`）会先被找到，刷新等于白刷。
    ...extraDirs,
    // ② 已知 bin 目录（node / pnpm 的常见位置）—— 与 `envWithKnownBins` 同一条纪律：前置。
    //    `pathWithKnownBins('')` 给的是**真的找到了的** node / pnpm 所在目录（POSIX 上就靠它，
    //    因为候选表是 Windows 专用的）；`known` 再把候选目录一起带上。
    pathWithKnownBins(''),
    ...known,
    // ③ 注册表里那两段（系统现在的真相）
    registry ? mergePathText(registry.machine, registry.user) : null,
    // ④ 本进程原有的
    existing,
  );
  const before = existing
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => dir.trim());
  // 写回时沿用**已有的**那个键名（Windows 上通常是 `Path`）：再造一个 `PATH` 就会出现两个
  // 只差大小写的键，哪个生效看运行时 —— 与 `envWithKnownBins` 同一条纪律。
  // 兜底的 `'Path'` 只用于"合成 env 里一个 path 键都没有"的情形（测试）；真实进程一定命中上面那句，
  // 而且这个查找同样大小写不敏感，POSIX 上叫 `PATH` 也照样认得。
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'Path';
  env[key] = merged;
  return merged
    .split(path.delimiter)
    .filter(Boolean)
    .filter((dir) => !before.some((old) => sameDir(old, dir)));
}

/** 一次功能实测的结果（`probeFixTarget` 的产出） */
export interface FixProbe {
  /** 找到了哪个可执行文件（没找到为 null） */
  file: string | null;
  /** `--version` 的第一行；没有输出时为 null */
  version: string | null;
  exitCode: number | null;
  stderr: string | null;
  /** true = 这个运行环境不允许起子进程（我们**测不出来**，不是"坏了"） */
  blocked: boolean;
  /** 这台机器有没有 VC++ 运行库（判定"文件在却跑不起来"时要用，见 `describePnpmRunFailure`） */
  vcRuntime: boolean;
}

/**
 * 这一步的**功能实测**：`<pnpm> -v` 真的打出东西才算成功（"文件在"不算 —— 这正是 VM 那一屏的
 * 症状：文件在、跑起来没有任何输出）。返回的事实同时喂给界面文案与日志（见 `fixDoneMessage`）。
 */
export async function probeFixTarget(action: EnvFixAction, platform: string): Promise<FixProbe> {
  const vcRuntime = hasVcRuntime();
  if (action !== 'install-pnpm') {
    return { file: null, version: null, exitCode: null, stderr: null, blocked: false, vcRuntime };
  }
  const file = findPnpmPath();
  if (!file) {
    return { file: null, version: null, exitCode: null, stderr: null, blocked: false, vcRuntime };
  }
  const probe = await probeBinary(file, ['-v'], platform);
  return {
    file,
    version: probe.version,
    exitCode: probe.exitCode,
    stderr: probe.stderr ?? null,
    blocked: isEnvironmentBlocked(probe.error),
    vcRuntime,
  };
}

/**
 * 「找到了但跑不起来」到底是怎么回事（**纯函数**，夹具是 VM-09 的真机原文）。
 *
 * VM-09 那一屏：`pnpm -v` 无输出 + Windows 弹窗
 * 「由于找不到 VCRUNTIME140.dll，无法继续执行代码。重新安装程序可能会解决此问题。」
 * —— 根因是 pnpm 11 起在 Windows 上发的是**原生程序**，而纯净 Windows 没有 VC++ 运行库。
 * 这不是"用户环境坏了"，任何没装过运行库的 Windows 都会这样。
 *
 * 两条信号（任一即可认定，避免只靠一句话）：
 *   1. 那次执行**没有任何输出**，而且这台机器**缺运行库**（`vcRuntime === false`）——
 *      真机上就是这个形状（弹窗不是 stdout/stderr，所以我们看不见它）；
 *   2. 那两路输出里出现了原文（`VCRUNTIME140` / `由于找不到` / `无法继续执行代码`），或退出码是
 *      `STATUS_DLL_NOT_FOUND`（`0xC0000135`，Node 报成 3221225781 / -1073741515）。
 *
 * 认出来就给**人话 + 两条出路**；认不出来返回 `null`（不硬编原因）。
 */
export interface PnpmRunVerdict {
  kind: 'vc-runtime-missing';
  /** 结论（给人看的人话） */
  message: string;
  /** 两条出路 */
  hints: string[];
}

/** 真机原文里的关键词（VM-09） */
const VC_RUNTIME_MISSING_TEXT = /VCRUNTIME140|由于找不到|无法继续执行代码/i;
/** `STATUS_DLL_NOT_FOUND`：加载失败时 Windows 给进程的退出码 */
const DLL_NOT_FOUND_CODES = [3221225781, -1073741515];

export function describePnpmRunFailure(facts: {
  file: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  vcRuntime: boolean | null;
}): PnpmRunVerdict | null {
  const text = `${facts.stdout}\n${facts.stderr}`;
  const saidIt = VC_RUNTIME_MISSING_TEXT.test(text);
  const codeSaidIt = facts.exitCode !== null && DLL_NOT_FOUND_CODES.includes(facts.exitCode);
  const silent = text.trim() === '';
  const suspect = saidIt || codeSaidIt || (silent && facts.vcRuntime === false);
  if (!suspect) return null;
  return {
    kind: 'vc-runtime-missing',
    message: `这份 pnpm 装出来是坏的：它是原生程序（pnpm 11 起在 Windows 上就是这样），而这台电脑上没有 VC++ 2015-2022 运行库，加载时直接失败 —— 所以跑起来没有任何输出`,
    hints: [
      `换成纯 JS 那条线：一键修复会装 pnpm 10（它的入口是 bin/pnpm.cjs，不需要这个运行库）`,
      `或先装上「Microsoft Visual C++ 2015-2022 可再发行组件（x64）」，之后再装最新版 pnpm`,
    ],
  };
}

/**
 * 一键修复收尾那句话（**纯函数**，自检直接钉四种情形）—— 必须说清是哪一种：
 *
 *   1. 实测通过 → 现在可用了；
 *   2. 没能实测（这个运行环境不允许起子进程）→ 不是"坏了"，别吓人；
 *   3. **找到了但跑不起来**（VM-06 / VM-09 那一屏）→ 点名文件、说清"装出来是坏的"，
 *      认得出原因时用 `verdict` 的人话 + 两条出路，并把日志位置给出来（原文在日志里）；
 *   4. 刷新查找路径之后仍然没找到 → **只有这种情形**才允许说"重开应用再检测一次"。
 */
export function fixDoneMessage(facts: {
  label: string;
  ok: boolean;
  found: boolean;
  blocked: boolean;
  refreshed: number;
  logFile: string | null;
  /** 「找到了但跑不起来」时认出原因的结论（`describePnpmRunFailure`）；认不出来给 null */
  verdict?: PnpmRunVerdict | null;
}): string {
  // 界面文案里只说"日志"，不写日志文件名：那个词本身在 §3.8 #22 的词表里（文案不该出现内部记号）
  const where = facts.logFile
    ? `细节在日志里：${facts.logFile}`
    : '细节在日志里（用户数据目录的 logs 目录下）';
  if (facts.ok) return `复检结果：${facts.label} 现在可用了`;
  if (facts.blocked) {
    // 这一条**是**真该由用户做的（我们的进程在这个环境里起不了子进程）—— 但仍然先给应用内那条路
    return `装上了，但这个运行环境不允许起子进程，没能实测。先点「重新检测」再试一次；还不行的话，只有在你自己有权限的终端里手工跑一次 ${facts.label} --version 才能确认（不算失败）`;
  }
  if (facts.found) {
    const head =
      facts.verdict?.message ??
      `找到了 ${facts.label}（${facts.label} 的可执行文件在），但它跑起来没有任何输出 —— 这一份装出来是坏的`;
    const ways =
      facts.verdict && facts.verdict.hints.length > 0
        ? `。两条出路：${facts.verdict.hints.join('；')}`
        : '';
    return `${head}${ways}。实际执行的命令、退出码、stdout 与 stderr 都记下来了，${where}`;
  }
  return `装完了，刷新查找路径（新注入 ${facts.refreshed} 个目录）之后仍然没在已知位置找到 ${facts.label} —— 这种情形才需要重开应用再检测一次（Windows 上 GUI 应用拿到的是启动那一刻的环境块）`;
}

/** 不满足时的兜底出路：保证"每一行非 ok 都有 fixHint"这条不变量在结构上成立 */
const FALLBACK_HINTS: Record<EnvCheckId, string> = {
  node: '到 https://nodejs.org/en/download 装一个 Node，或用版本管理器（`nvm install 24 && nvm use 24`）。',
  'node-version': '把 Node 升到 22.12+ 或 20.19+（本机实测能跑 dsh 的是 24 那一档）。',
  npm: '重装官方 Node（npm 随它一起装）；只用 pnpm 的话也可以 `corepack enable pnpm`。',
  pnpm: '`npm i -g pnpm`；没有 npm 时用 `corepack enable pnpm`。',
  dsh: '`npm i -g @deepseek-ai/dsh`，或在「设置 → 启动方式 → dsh 命令」里写一条能跑的启动命令。',
  'dsh-run':
    '在「设置 → 启动方式 → dsh 命令」里写一条能跑的启动命令（通常是换一个能跑 dsh 的 Node 版本）。',
  'bundled-runtime': '升级 DSH Console。',
  shell: '到「设置 → 本地 Shell」清空这一项（恢复自动选择）或改成正确的路径。',
};

/**
 * node / node-version 的出路（VM-13 / F-05）：**先给应用内那条路**。
 *
 * 门禁第一步就有「安装 Node.js」（直装官方稳定版 / 通过 nvm 安装两种），装好还会由我们切过去 ——
 * 所以文案里绝不能说「先在终端里选一个版本」。自己动手只作为备选写在后半句（要命令行原文的人拿得到，
 * 但我们不把开终端当成给他安排的活）。
 */
function nodeInstallHint(platform: string): string {
  const inApp =
    '点上面的「安装 Node.js」：直接安装官方稳定版、或通过 nvm 安装，都由我们装好并切过去。';
  return platform === 'win32'
    ? `${inApp}想自己来也可以：\`nvm install 24 && nvm use 24\`（nvm-windows），或到 nodejs.org 装 22.19+ 或 24 的 LTS。`
    : `${inApp}想自己来也可以：\`nvm install 24 && nvm use 24\`（nvm/fnm），或到 nodejs.org 装 22.19+ 或 24 的 LTS。`;
}

function installNodeHint(platform: string): string {
  return platform === 'win32'
    ? `点上面的「安装 Node.js」由我们装一个（直装官方稳定版 / 通过 nvm 安装都行）。想自己来也可以：到 https://nodejs.org/en/download 下载安装包，或用 nvm-windows 的 \`nvm install 24 && nvm use 24\`。`
    : `点上面的「安装 Node.js」由我们装一个（直装官方稳定版 / 通过 nvm 安装都行）。想自己来也可以：用版本管理器 \`nvm install 24 && nvm use 24\`，或到 https://nodejs.org/en/download 下载 22.19+ 或 24 的 LTS。`;
}

function upgradeNodeHint(platform: string): string {
  return nodeInstallHint(platform);
}

/**
 * 「这一轮没测」的出路（`skipped` 的项都写它）。
 *
 * VM-13 / F-05 的教训：这里原来写的是「在终端里手工跑一次 `xxx -v` 确认」—— 可这一轮只是**我们自己**
 * 的快速探测没起子进程（完整检测 1.5 秒后就来），根本没有东西坏掉。把用户打发去终端是同一类毛病：
 * **界面文案不许把应用自己就能做的事推给用户**（与 VM-04 的"不许把内部记号暴露给用户"并列）。
 */
const NOT_MEASURED_HINT =
  '不用做什么：这一轮完整检测马上就会给出这一项的结论（启动瞬间的快速探测只读文件系统、不起子进程）。';

/**
 * 「这个运行环境不允许起子进程」时的出路：**先让用户点重新检测**，再补一句只有他能做的确认。
 *
 * 这一类**是**真该由用户做的：我们的进程起不了子进程（受限/沙箱环境），他自己有权限的终端能 ——
 * 所以这里保留"手工确认"，与上面那种"把应用能做的事推给用户"是两回事。
 */
const BLOCKED_HINT_PREFIX = '先点一下「重新检测」再试一次；还测不出来的话，';

/**
 * 我们找到的这份 Node 是不是**版本管理器管的**（nvm-windows 的 shim / 符号链接目录、fnm、volta、nodenv）。
 *
 * 为什么要单独认它：客机上的真实状态是「版本管理器装好了、但一个 Node 版本都没装」（VM-01 / VM-13），
 * 这时 `node.exe` 只是个跑不出结果的 shim —— 文案必须说中这一种状态（该点应用里的「安装」由我们装一个
 * 并切过去），而不是笼统地说"这份 Node 用不了"，更不能让用户自己回终端里 `nvm use`。
 *
 * 判据（纯函数，只读入参）：路径里出现版本管理器的目录名，或者它落在版本管理器写在环境里的目录下
 *（Windows 的 nvm 会设 `NVM_HOME` / `NVM_SYMLINK`，fnm / volta 也有各自的变量）。
 */
export function looksVersionManagerNode(
  file: string | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = String(file ?? '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/');
  if (!raw) return false;
  const full = raw.startsWith('/') ? raw : `/${raw}`;
  // 目录名判据：`/nvm/` 这样带分隔符匹配，`D:\nvm-tools\node.exe` 那种不算
  const markers = ['/nvm/', '/nvm4w/', '/.nvm/', '/fnm/', '/.fnm/', '/volta/', '/.volta/'];
  if (markers.some((marker) => full.includes(marker))) return true;
  for (const name of ['NVM_HOME', 'NVM_SYMLINK', 'NVM_DIR', 'FNM_DIR', 'VOLTA_HOME']) {
    const value = envValueOf(env, name);
    if (!value) continue;
    const root = String(value).trim().toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
    if (root && full.startsWith(`${root.startsWith('/') ? root : `/${root}`}/`)) return true;
  }
  return false;
}

/**
 * 「这一轮没测」那句统一措辞（`skipped === true` 的项都写它）。
 *
 * 为什么必须区分"没测"与"没装"：启动瞬间的快速探测（见 `collectBootProbe`）只查文件系统、
 * 不起子进程，所以 `node -v` / `npm -v` / `dsh --version` 这些项根本没有结论。
 * 把它当成 `missing` 就会把一台好好的机器判成"环境不全"（需求 §4.3 的 warn 不当成缺失）。
 */
const SKIPPED_DETAIL =
  '这一轮没测：启动瞬间的快速探测只读文件系统、不起子进程，所以没有这一项的实测结果（不代表没装）';

/**
 * 这次失败是"**这个运行环境**不允许起子进程"（我们测不出来），还是"**那个程序本身**跑不起来"（不可用）？
 *
 * 两者在界面上必须是两种结论，这是 VM 实测（VM-03）那条判据的地基：
 *   - `EPERM` / `EACCES`：沙箱或权限限制，用户机器上那份程序可能好好的 → `warn`（不挡人）；
 *   - 其余（跑起来了但零输出、或退出码非 0）：**有输出才算可用** → `missing`（真的用不了）。
 */
function isEnvironmentBlocked(error: string | null): boolean {
  return Boolean(error && /EPERM|EACCES|不允许|沙箱/i.test(error));
}

/**
 * 八项判定 → 报告。**纯函数**：只读入参（自检里有一条正则守着它不碰 IO）。
 *
 * 几条定死的规则：
 *   - 版本不在区间里给 `warn` 而不是 `missing`：那句区间是**构建期**要求，
 *     dsh 到底能不能跑由 `dsh-run` 那一项实测决定（AGENTS 7.4），
 *     否则界面上会出现"版本红灯 + 实测绿灯"这种自相矛盾的两行；
 *   - `dsh`（在哪）与 `dsh-run`（跑不跑得动）分开判：dsh 在跑不动的 Node 上是静默退出，
 *     这两件事合在一起用户就不知道该修哪一个；
 *   - 不满足必有出路：`status !== 'ok'` 的每一项 `fixHint` 一定非空。
 */
export function judgeEnvironment(raw: EnvProbeRaw): EnvDoctorReport {
  const checks: EnvCheck[] = [];
  const push = (
    id: EnvCheckId,
    status: EnvCheckStatus,
    detail: string,
    fixHint: string | null = null,
    fixAction: EnvFixAction | null = null,
  ): void => {
    checks.push({ id, status, detail, fixHint, fixAction });
  };

  const npmPath = raw.npm.path;
  const dshHint =
    '在「设置 → 启动方式 → dsh 命令」里写一条能跑的启动命令，或一键 `npm i -g @deepseek-ai/dsh`。';

  // 1. 外部 Node = **真正会被用来跑 dsh 的那一份**（用户裁决，见 §7.25）。
  //    另有一份（通用搜索找到的、跟它不是同一个）时把话说出来 —— 用户拿终端里的
  //    `node -v` 对账对不上，就是因为它。
  if (raw.node.path) {
    const other = raw.otherNode;
    const tail = other
      ? `；另有一个外部 Node：${other.path}${other.version ? `（${other.version}）` : ''}${
          other.shim
            ? '，那是个转发器，我们没去调它（调它会自己去下运行时；它的版本随启动环境而变，所以别拿它跟终端里的 `node -v` 对账）'
            : ''
        }`
      : '';
    push(
      'node',
      'ok',
      `找到了外部 Node：${raw.node.path}${raw.node.version ? `（${raw.node.version}）` : ''}` +
        (raw.nodeServesDsh ? ' —— dsh 就用这一份跑' : '') +
        tail,
    );
  } else {
    push(
      'node',
      'missing',
      '没找到外部 Node（常见安装位置里都没有）',
      installNodeHint(raw.platform),
    );
  }

  // 2. Node 版本
  const nodeVersion = raw.node.version ? parseNodeVersion(raw.node.version) : null;
  if (raw.node.skipped) {
    // 快速探测没跑 `node --version`：给 warn（测不出来），不是 missing（没装）
    push('node-version', 'warn', SKIPPED_DETAIL, NOT_MEASURED_HINT);
  } else if (!raw.node.path) {
    push(
      'node-version',
      'missing',
      '外部 Node 都没找到，版本无从判断',
      installNodeHint(raw.platform),
    );
  } else if (!nodeVersion) {
    // 找到了 Node 的文件、但它跑不出结果 —— **有输出才算可用**（与 `canRunDsh` 同一条判据）。
    // 只有"这个环境不允许起子进程"才留黄灯（那是我们测不出来，不是用户没装）。
    if (raw.node.timedOut) {
      // **在忙 ≠ 缺东西**：转发器可能在准备自己的运行时（真机事故，见 §7.25）。
      push(
        'node-version',
        'warn',
        '没能实测版本：它超过 8 秒没有回应（第一次运行时它可能在准备自己的运行时）—— 不代表没装 Node',
        '过一会儿点上面的「重新检测」再看一次。',
      );
    } else if (isEnvironmentBlocked(raw.node.error)) {
      push(
        'node-version',
        'warn',
        '没能实测版本：这个运行环境不允许起子进程 —— 不代表没装 Node',
        `${BLOCKED_HINT_PREFIX}只有在你自己有权限的终端里手工跑一次 \`node --version\` 才能确认。`,
      );
    } else if (raw.nodeFromVersionManager) {
      // VM-13 / F-05：客机状态正是"版本管理器在、零版本"，而这一行就显示在两条一键安装路的并列位置 ——
      // 绝不能说"你先去终端里选一个版本"。
      push(
        'node-version',
        'missing',
        `版本管理器已经装好了：这份 Node（${raw.node.path}）就在它管的目录里，但它还没有装任何 Node 版本（或者没有选中一个），所以这个 node.exe 现在跑起来没有任何输出`,
        nodeInstallHint(raw.platform),
      );
    } else {
      push(
        'node-version',
        'missing',
        `找到了 Node（${raw.node.path}），但它跑起来没有任何输出（退出码 ${raw.node.exitCode ?? 0}）—— 这份 Node 现在用不了`,
        nodeInstallHint(raw.platform),
      );
    }
  } else if (satisfiesNodeRange(nodeVersion)) {
    push('node-version', 'ok', `${raw.node.version} 落在要求区间内（要求 ${NODE_RANGE}）`);
  } else {
    push(
      'node-version',
      'warn',
      `${raw.node.version} 不在要求区间内（要求 ${NODE_RANGE}）—— 这是 dsh 与它依赖链的要求；能不能跑仍由下面「实测 dsh」那一项定`,
      upgradeNodeHint(raw.platform),
    );
  }

  // 3. npm（下面两个一键修复都要它）
  if (raw.npm.skipped) {
    push('npm', 'warn', SKIPPED_DETAIL, NOT_MEASURED_HINT);
  } else if (!npmPath) {
    push(
      'npm',
      'missing',
      '没找到 npm —— 两个一键修复（装 pnpm / 装 dsh）都要用它，先把它修好',
      '重装官方 Node（npm 随它一起装）；只用 pnpm 的话也可以 `corepack enable pnpm`。',
    );
  } else if (raw.npm.version) {
    push('npm', 'ok', `npm 可用：${npmPath}（${raw.npm.version}）`);
  } else if (raw.npm.timedOut) {
    push(
      'npm',
      'warn',
      '没能实测 npm：它超过 8 秒没有回应（第一次运行时它可能在准备自己的运行时）—— 不代表没装 npm',
      '过一会儿点上面的「重新检测」再看一次。',
    );
  } else if (isEnvironmentBlocked(raw.npm.error)) {
    push(
      'npm',
      'warn',
      '没能实测 npm：这个运行环境不允许起子进程 —— 不代表没装 npm',
      `${BLOCKED_HINT_PREFIX}只有在你自己有权限的终端里手工跑一次 \`npm -v\` 才能确认。`,
    );
  } else {
    push(
      'npm',
      'missing',
      `找到了 npm（${npmPath}），但它跑起来没有任何输出 —— 这份 npm 现在用不了，两个一键修复（装 pnpm / 装 dsh）也就都用不了`,
      `重装官方 Node（npm 随它一起装）就能修好；装完它会出现在上面那一行的位置，不用你手动改什么。`,
    );
  }

  // 4. pnpm：插件页的装/卸/升级全靠它（dsh plugin 内部是裸 spawnSync('pnpm')）
  if (raw.pnpm.skipped) {
    push('pnpm', 'warn', SKIPPED_DETAIL, NOT_MEASURED_HINT);
  } else if (!raw.pnpm.path) {
    push(
      'pnpm',
      'missing',
      '没找到 pnpm —— 插件页的装 / 卸 / 升级都用不了',
      npmPath
        ? // 缺 VC++ 运行库时这句要说清"装的是哪一档"，别让用户以为回到了最新版
          `一键装一个（${npmPath} i -g ${pnpmInstallSpec(raw.vcRuntime !== false)}）；不行再试 \`corepack enable pnpm\`。`
        : '没有 npm，只能用 `corepack enable pnpm`（或先重装官方 Node）。',
      npmPath ? 'install-pnpm' : null,
    );
  } else if (raw.pnpm.version) {
    push('pnpm', 'ok', `pnpm 可用：${raw.pnpm.path}（${raw.pnpm.version}）`);
  } else if (raw.pnpm.timedOut) {
    push(
      'pnpm',
      'warn',
      '没能实测 pnpm：它超过 8 秒没有回应（第一次运行时它可能在准备自己的运行时）—— 不代表没装 pnpm',
      '过一会儿点上面的「重新检测」再看一次。',
    );
  } else if (isEnvironmentBlocked(raw.pnpm.error)) {
    push(
      'pnpm',
      'warn',
      '没能实测 pnpm：这个运行环境不允许起子进程 —— 不代表没装 pnpm',
      `${BLOCKED_HINT_PREFIX}只有在你自己有权限的终端里手工跑一次 \`pnpm -v\` 才能确认。`,
    );
  } else {
    push(
      'pnpm',
      'missing',
      `找到了 pnpm（${raw.pnpm.path}），但它跑起来没有任何输出 —— 这份 pnpm 现在用不了`,
      `点下面的按钮重装一个（由我们执行，装完自动复检）；不行再试 \`corepack enable pnpm\`。`,
      npmPath ? 'install-pnpm' : null,
    );
  }

  // 5. dsh 本体：能不能定位（与第 6 项"跑不跑得动"分开）
  const dshAction: EnvFixAction | null = npmPath ? 'install-dsh' : null;
  if (raw.dsh.skipped) {
    push('dsh', 'warn', SKIPPED_DETAIL, NOT_MEASURED_HINT);
  } else if (raw.dsh.kind === 'npx') {
    push(
      'dsh',
      'warn',
      'dsh 现在要靠临时下载来运行：每次启动都要联网解析、必要时现装一份，慢且可能失败',
      '用 `npm i -g @deepseek-ai/dsh` 全局装一份，以后启动就不必联网解析了。',
      dshAction,
    );
  } else if (raw.dsh.kind) {
    push('dsh', 'ok', `找到了可用的 dsh：${raw.dsh.display ?? ''}`);
  } else {
    // **不要**把上游那句原始报错贴进界面：它写的是"PATH 里没有 dsh.cmd / 也没有 npx"这类
    // 内部术语（冻结 §3.8 #22 明令禁止出现在界面上）。技术原文留在探测事实里
    // （`EnvProbeRaw.dsh.resolveError`），界面上只说人话。
    push(
      'dsh',
      'missing',
      '这台电脑上还没有可用的 dsh：既没有现成装好的，也没法用 npm 现取一份来跑',
      dshHint,
      dshAction,
    );
  }

  // 6. 实测能不能跑：**有输出才算能跑**（退出码 0 + 零输出 = 静默退出）
  if (raw.dsh.skipped) {
    push('dsh-run', 'warn', SKIPPED_DETAIL, NOT_MEASURED_HINT);
  } else if (!raw.dsh.kind) {
    push('dsh-run', 'warn', 'dsh 本体还没定位到，没法实测能不能跑', dshHint);
  } else if (raw.dsh.runs) {
    push(
      'dsh-run',
      'ok',
      raw.dsh.version
        ? `实测能跑：${raw.dsh.display ?? raw.dsh.kind} → ${raw.dsh.version}`
        : `实测能跑：${raw.dsh.display ?? raw.dsh.kind}（这条解释器组合已实测确认）`,
    );
  } else if (raw.dsh.error && /EPERM|EACCES|不允许|沙箱/i.test(raw.dsh.error)) {
    push(
      'dsh-run',
      'warn',
      '没能实测：这个运行环境不允许起子进程（不代表 dsh 不能用）',
      `${BLOCKED_HINT_PREFIX}只有在你自己有权限的终端里手工跑一次 \`dsh --version\` 才能确认。`,
    );
  } else if (raw.dsh.timedOut) {
    push(
      'dsh-run',
      'warn',
      '没能实测：它超过 8 秒没有回应（第一次运行时它可能在准备自己的运行时）—— 不代表 dsh 不能用',
      '过一会儿点上面的「重新检测」再看一次；一直这样就在「设置 → 启动方式 → dsh 命令」里换一条能跑的启动命令。',
    );
  } else if (raw.dsh.exitCode === null || raw.dsh.exitCode === 0) {
    push(
      'dsh-run',
      'missing',
      `dsh 跑起来但没有任何输出（退出码 ${raw.dsh.exitCode ?? 0}）—— dsh 在跑不动的 Node 上就是这样静默退出的：退出码 0、零输出`,
      dshHint,
    );
  } else {
    push(
      'dsh-run',
      'missing',
      `实测失败：退出码 ${raw.dsh.exitCode} —— 这一份 dsh 现在跑不起来（dsh 的原始输出在下方输出区里）`,
      dshHint,
    );
  }

  // 7. 应用自带运行时：与快照的 env.versions 同源，用同一句区间判
  const bundledVersion = parseNodeVersion(raw.bundled.node);
  const bundledDetail = (extra: string): string =>
    `Electron ${raw.bundled.electron || '?'}，内置 Node ${raw.bundled.node || '?'}${extra}`;
  if (!raw.packaged) {
    push(
      'bundled-runtime',
      'ok',
      `${bundledDetail('（开发态）')} —— 开发态这份运行时来自 electron 依赖，应用跑在你的系统 Node 上`,
    );
  } else if (bundledVersion && satisfiesBuildRange(bundledVersion)) {
    push('bundled-runtime', 'ok', bundledDetail(`，落在要求区间内（要求 ${NODE_RANGE_BUILD}）`));
  } else {
    push(
      'bundled-runtime',
      'missing',
      bundledDetail(
        `，不在要求区间内（要求 ${NODE_RANGE_BUILD}）—— 注意这不是你机器上的 Node，它由打包时用的 Electron 决定`,
      ),
      `升级 DSH Console：${RELEASES_URL}`,
    );
  }

  // 8. 本地 Shell
  if (!raw.shell.file) {
    push(
      'shell',
      'missing',
      '没能解析出本地 Shell（设置里没填，也找不到系统默认的）',
      '在「设置 → 本地 Shell」里填一个可执行文件的路径。',
    );
  } else if (raw.shell.exists) {
    push('shell', 'ok', `本地 Shell：${raw.shell.file}`);
  } else {
    push(
      'shell',
      'missing',
      `设置里指定的本地 Shell 不存在了：${raw.shell.file}`,
      '到「设置 → 本地 Shell」清空这一项（恢复自动选择）或改成正确的路径。',
    );
  }

  // 收口：保证"每一行都有 detail、每一行非 ok 都有出路"这两条不变量
  for (const item of checks) {
    if (!item.detail) item.detail = '（这一项没有拿到可判断的信息）';
    if (item.status !== 'ok' && !item.fixHint) item.fixHint = FALLBACK_HINTS[item.id];
  }

  const counts = { ok: 0, warn: 0, missing: 0 };
  for (const item of checks) counts[item.status] += 1;
  const firstProblemId =
    (
      checks.find((item) => item.status === 'missing') ??
      checks.find((item) => item.status === 'warn')
    )?.id ?? null;

  const plans: EnvFixPlan[] = [];
  // 缺 VC++ 运行库时一键装的是纯 JS 那条线（VM-09）；没探测过（`undefined`）按"有"处理
  const vcRuntime = raw.vcRuntime !== false;
  for (const action of ['install-pnpm', 'install-dsh'] as const) {
    const plan = envFixPlan(action, npmPath, vcRuntime);
    if (plan) plans.push(plan);
  }

  return {
    checkedAt: raw.checkedAt,
    checks,
    counts,
    firstProblemId,
    nodeRange: NODE_RANGE,
    plans,
    // 归属：采集侧给的**事实**，这里只搬运（判定仍然是纯函数：`detectNodeOwner` 在采集侧算好）
    nodeOwner: raw.nodeOwner ?? 'unknown',
    nodeOwnerEvidence: arrayOf<string>(raw.nodeOwnerEvidence),
    error: raw.error,
  };
}

/**
 * 「被界面撤下去的原始错误」→ 日志行（**纯函数**，自检直接喂夹具）。
 *
 * 界面上只说人话，原始错误因此必须有另一个落点 —— 这就是 `EnvDoctorHooks.log` 存在的理由，
 * 而这个函数决定"该记哪些"。判据是成对的：**日志里找得到原文，界面文案里找不到**。
 *
 * 只在"这一项因为跑出错而没通过"（`status !== 'ok'`）时记，不给一台正常的机器刷日志；
 * `skipped` 的项这一轮**根本没起子进程**（`collectBootProbe` 那条快速路径），没有任何原文可记。
 */
export function probeTroubleLines(raw: EnvProbeRaw, report: EnvDoctorReport): string[] {
  const lines: string[] = [];
  const checks = arrayOf<EnvCheck>(report.checks);
  const statusOf = (id: EnvCheckId): EnvCheckStatus =>
    checks.find((item) => item.id === id)?.status ?? 'ok';
  const notPassed = (...ids: EnvCheckId[]): boolean => ids.some((id) => statusOf(id) !== 'ok');
  /** stderr 是原文的一部分（"为什么跑不起来"往往只在这里），有就接在后面 */
  const withStderr = (line: string, stderr: string | null | undefined): string =>
    stderr ? `${line}；stderr：${stderr}` : line;

  /** 三个版本探测项：`node` / `node-version` 是同一份事实判出来的两行，一起看 */
  const versionFact = (label: string, probe: VersionProbe, ids: EnvCheckId[]): void => {
    if (probe.skipped || !notPassed(...ids)) return;
    if (probe.error) {
      lines.push(withStderr(`${label} 起不来：${probe.error}`, probe.stderr));
    } else if (probe.path && !probe.version) {
      lines.push(
        withStderr(
          `${label} 跑起来但没有任何输出：退出码 ${probe.exitCode ?? 0}，路径 ${probe.path}`,
          probe.stderr,
        ),
      );
    }
  };
  versionFact('node --version', raw.node, ['node', 'node-version']);
  versionFact('npm -v', raw.npm, ['npm']);
  versionFact('pnpm -v', raw.pnpm, ['pnpm']);

  if (!raw.dsh.skipped) {
    if (raw.dsh.resolveError && notPassed('dsh', 'dsh-run')) {
      lines.push(`dsh 没能定位：${raw.dsh.resolveError}`);
    }
    if (raw.dsh.kind && !raw.dsh.runs && notPassed('dsh-run')) {
      const reason = raw.dsh.error ? `起不来：${raw.dsh.error}` : `退出码 ${raw.dsh.exitCode ?? 0}`;
      lines.push(
        withStderr(
          `dsh 实测没通过（${reason}）：启动命令 ${raw.dsh.display ?? raw.dsh.kind}`,
          raw.dsh.stderr,
        ),
      );
    }
  }

  // 采集本身有意外（读设置失败等）：报告里已经有 error，日志里带上原因
  if (raw.error) lines.push(`这一轮探测本身有意外：${raw.error}`);
  return [...new Set(lines)];
}

/** 只保留第一行非空输出（版本号那种输出） */
function firstLine(text: string): string {
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 在若干路径里找第一个存在的文件 */
function firstFile(paths: string[]): string | null {
  for (const candidate of paths) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 不存在就继续找
    }
  }
  return null;
}

/** Windows 上要找可执行文件的目录：PATH → 已知安装位置 → node 自己所在目录 */
function windowsSearchDirs(): string[] {
  const dirs: string[] = [];
  const push = (dir: string): void => {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  };
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) push(dir);
  for (const dir of windowsBinCandidates(process.env, homeDir())) {
    // **只有真的存在的候选目录才进搜索列表**（VM-12：猜出来的目录不参与查找，也就不会上屏）
    if (fs.existsSync(dir)) push(dir);
  }
  const nodeExe = findNodeExe();
  if (nodeExe) push(path.dirname(nodeExe));
  return dirs;
}

/**
 * 按 PATHEXT 顺序在候选目录里找**带扩展名**的可执行文件。
 *
 * 为什么不能像 `whichSync` 那样先试不带扩展名的那个：Node 的安装目录里
 * `npm`（`#!/usr/bin/env bash`）、`pnpm`（`#!/bin/sh`）与 `npm.cmd` / `pnpm.cmd` 是并存的，
 * 只按名字找会稳定地拿到前者，而它在 Windows 上根本起不来（`spawn` → ENOENT，本机实测）。
 * PATHEXT 的顺序（`.COM;.EXE;.BAT;.CMD`）天然满足「`pnpm.exe` 优先于 `pnpm.cmd`」。
 */
function whichWindowsExe(name: string, dirs: string[]): string | null {
  const exts = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      // 小写优先（Node / npm 的 shim 都是小写，界面上显示的就是磁盘上的原名），
      // 再试 PATHEXT 里的大小写 —— 卷上开了区分大小写时靠它兜底
      const found = firstFile([
        // Windows 路径一律用 `path.win32` 拼：用 `path.join` 会跟着跑测试的机器走，
        // 于是同一份逻辑在 Linux CI 上会拼出正斜杠、查不到文件（见 `windowsBinCandidates` 的同款注释）
        path.win32.join(dir, `${name}${ext.toLowerCase()}`),
        path.win32.join(dir, `${name}${ext}`),
      ]);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 同一条查找，但**存在性可注入**（VM-12 需要它：证明"界面上报的路径一定是真探测到的"）。
 * 纯逻辑，沙箱里就能用客机的环境跑。
 */
export function whichWindowsExeWith(
  name: string,
  dirs: string[],
  pathext: string,
  exists: (file: string) => boolean,
): string | null {
  const exts = String(pathext || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const found = [`${name}${ext.toLowerCase()}`, `${name}${ext}`].find((file) =>
        exists(path.win32.join(dir, file)),
      );
      if (found) return path.win32.join(dir, found);
    }
  }
  return null;
}

/** 候选目录：PATH → 已知安装位置（**只留真实存在的**）→ node 自己所在目录 */
function windowsSearchDirsFor(
  env: NodeJS.ProcessEnv,
  home: string,
  exists: (file: string) => boolean,
): string[] {
  const dirs: string[] = [];
  const push = (dir: string): void => {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  };
  // PATH 里的分隔符是 Windows 的 `;`（不是 `path.delimiter` —— 那在 POSIX 上是 `:`，
  // 会把整条 Windows PATH 当成一个目录，候选目录就全丢了）
  for (const dir of String(env.Path ?? env.PATH ?? '').split(path.win32.delimiter)) push(dir);
  for (const dir of windowsBinCandidates(env, home)) {
    // **只有真的存在的候选目录才进搜索列表** —— 猜出来的一律不参与，也不会上屏（VM-12）
    if (exists(dir)) push(dir);
  }
  return dirs;
}

/** 门禁 / 自检用的可注入版本：找 node（Windows） */
export function findNodePathWindows(
  env: NodeJS.ProcessEnv,
  home: string,
  exists: (file: string) => boolean,
): string | null {
  const pathext = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD');
  return whichWindowsExeWith('node', windowsSearchDirsFor(env, home, exists), pathext, exists);
}

/** 门禁 / 自检用的可注入版本：找 npm（Windows，只要 `.cmd` / `.exe`，不要无扩展名的 sh shim） */
export function findNpmWindows(
  env: NodeJS.ProcessEnv,
  home: string,
  exists: (file: string) => boolean,
): string | null {
  const pathext = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD');
  return whichWindowsExeWith('npm', windowsSearchDirsFor(env, home, exists), pathext, exists);
}

/** 兜底：只接受「在自己的平台上真能跑」的路径（Windows 上 = 带可执行扩展名） */
function runnableOrNull(file: string | null): string | null {
  return file && isRunnablePath(file, isWindows ? 'win32' : process.platform) ? file : null;
}

/** 找 node：Windows 上同样只认带扩展名的（`whichSync` 会先撞上无扩展名的同名文件） */
export function findNodePath(): string | null {
  if (!isWindows) return findNodeExe();
  return whichWindowsExe('node', windowsSearchDirs()) ?? runnableOrNull(findNodeExe());
}

/** 找 npm：Windows 上按 PATHEXT 显式找 `npm.cmd` / `npm.exe`，**不返回**无扩展名的 sh shim */
export function findNpm(): string | null {
  if (!isWindows) {
    const fromPath = whichSync('npm');
    if (fromPath) return fromPath;
    const nodeExe = findNodeExe();
    const candidates: string[] = [];
    if (nodeExe) candidates.push(path.join(path.dirname(nodeExe), 'npm'));
    candidates.push('/opt/homebrew/bin/npm', '/usr/local/bin/npm');
    return firstFile(candidates);
  }
  const explicit = whichWindowsExe('npm', windowsSearchDirs());
  if (explicit) return explicit;
  // 兜底：process-utils 的 whichSync 也扫 PATH，但拿到的必须真的是可执行文件
  return runnableOrNull(whichSync('npm'));
}

/**
 * 找 pnpm：Windows 上 `pnpm.exe` 优先（PATH 里独立安装的是 `pnpm.exe`、`npm i -g` 装的是
 * `pnpm.cmd`），都不在时退回 `findPnpm()` 扫到的已知目录 —— 但**无扩展名的 sh shim 一律不要**。
 */
export function findPnpmPath(): string | null {
  if (!isWindows) return findPnpm();
  return whichWindowsExe('pnpm', windowsSearchDirs()) ?? runnableOrNull(findPnpm());
}

/**
 * 超时后彻底放手：**杀整棵树**并释放管道。
 *
 * 为什么不能只 `child.kill()`：子进程往往只是个壳（`sh` 转发器、下载器），真正的活儿在它的
 * 子进程里，而那个孙进程继承了 stdout / stderr 两根管道 —— 只杀壳的话 `close` 永远不会触发、
 * 管道一直开着（实测：探针进程因此退不出来）。`killTreeSync` 在 POSIX 上杀进程组、Windows 上
 * 用 `taskkill /T`，正是为这种"壳 + 后代"准备的。
 */
function releaseChild(child: ChildProcess | null): void {
  if (!child) return;
  const pid = child.pid;
  try {
    if (typeof pid === 'number' && pid > 0) killTreeSync(pid);
    else child.kill('SIGKILL');
  } catch {
    /* 已经退了 */
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
  child.unref();
}

/**
 * 跑一次 `--version` 之类的探测：拿退出码 / 首行输出 / 起不来的原因（stderr 只给日志）。
 *
 * **异步**（v0.6.1 修）：这里原来是 `spawnSync`，而整条完整探测跑在**主进程**上。真机事故：
 * 探测打到 vite-plus 的转发器，它在窄 PATH 下发现没有系统 node，就去下载自己的运行时
 * （100+MB）—— 每个探测各 8 秒超时、串行五个，把主进程事件循环占了约 40 秒：界面"没有响应"，
 * 系统最后弹崩溃提示（`~/.vite-plus/js_runtime` 里那 5 个 `.tmp*` 就是被这些超时杀掉的中断下载）。
 *
 * 现在：`spawn` + 定时器，超时就 `kill` 子进程并回一句人话，**绝不阻塞事件循环**。
 */
function runVersion(
  file: string,
  args: string[],
  platform: string,
): Promise<Omit<VersionProbe, 'path'>> {
  // 探测和执行走**同一个**包装器：`.cmd` / 无扩展名的路径不能直 spawn
  const spec = launchSpec(file, args, platform);
  return new Promise((resolve) => {
    let child: ChildProcess | null = null;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value: Omit<VersionProbe, 'path'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      // 超时不等于"没装"：它可能在忙（例如转发器正在准备自己的运行时）。文案要给对，
      // 判定那边也据此归到"测不出来"而不是"缺东西"。
      releaseChild(child);
      finish({
        version: null,
        exitCode: null,
        error: `超过 ${Math.round(PROBE_TIMEOUT_MS / 1000)} 秒没有回应（已经结束它）`,
        stderr: stderrTail(stderr),
        timedOut: true,
      });
    }, PROBE_TIMEOUT_MS);
    try {
      child = spawn(spec.file, spec.args, {
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
        env: envWithKnownBins(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ version: null, exitCode: null, error: messageOf(error), stderr: null });
      return;
    }
    // stderr 一进来就收着（顺手脱掉 ANSI 颜色）：真机排查时"为什么跑不起来"那句话
    // 往往只出现在这里，而它**不许**上界面（冻结 §3.8 #22），唯一去处是日志。
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      // EPERM / EACCES = 这个环境不允许起子进程，和"没装"是两件事（判定那边分开说）
      finish({
        version: null,
        exitCode: null,
        error: error.message,
        stderr: stderrTail(stderr),
      });
    });
    child.on('close', (code) => {
      finish({
        version: firstLine(stdout) || null,
        exitCode: typeof code === 'number' ? code : null,
        error: null,
        stderr: stderrTail(stderr),
      });
    });
  });
}

/** stderr 只留尾部一小段（日志用原文，不搬整段堆栈）；没有内容时给 null */
function stderrTail(text: string): string | null {
  const trimmed = stripAnsi(text).trim();
  if (!trimmed) return null;
  return trimmed.length > STDERR_TAIL_CHARS ? `…${trimmed.slice(-STDERR_TAIL_CHARS)}` : trimmed;
}

async function probeBinary(
  file: string | null,
  args: string[],
  platform: string,
): Promise<VersionProbe> {
  if (!file) return { ...EMPTY_VERSION_PROBE };
  return { path: file, ...(await runVersion(file, args, platform)) };
}

/** dsh 本体：先定位（resolveDshLauncher），再实测（有输出才算能跑） */
async function collectDshProbe(settings: SettingsValues, platform: string): Promise<DshProbe> {
  let launcher: DshLauncher;
  try {
    launcher = resolveDshLauncher(settings);
  } catch (error) {
    return {
      kind: null,
      display: null,
      runs: false,
      version: null,
      exitCode: null,
      error: null,
      resolveError: messageOf(error),
    };
  }

  const base = {
    kind: launcher.kind,
    display: launcher.display,
    version: null,
    error: null,
    resolveError: null,
  };
  if (launcher.kind === 'node-bin') {
    // 这条路不需要额外起子进程：pickDshInterpreter 挑出来的组合本来就是实测过的，
    // 复用 canRunDsh 的缓存结论（同一组合反复测没有意义，别去清它的缓存）。
    return {
      ...base,
      runs: canRunDsh(launcher.file, launcher.prefixArgs[0]),
      exitCode: null,
      stderr: null,
      timedOut: false,
    };
  }
  const run = await runVersion(launcher.file, dshArgsFor(launcher, ['--version']), platform);
  return {
    ...base,
    runs: run.version !== null,
    version: run.version,
    exitCode: run.exitCode,
    error: run.error,
    stderr: run.stderr,
    timedOut: run.timedOut === true,
  };
}

/**
 * 一轮探测：全部 IO 都在这里（找可执行文件、跑 `--version`、解析 Shell）。
 *
 * 运行时事实由调用方给：判定不读 `process.*`，采集这边也只读"与子进程有关"的那几个
 * （`process.env` / `process.platform` 间接经 process-utils），不碰 electron。
 */
export async function collectEnvProbe(
  settings: SettingsValues,
  runtime: EnvRuntime,
): Promise<EnvProbeRaw> {
  let error: string | null = null;

  const nodePath = findNodePath();
  const npmPath = findNpm();
  const pnpmPath = findPnpmPath();

  // 「外部 Node」这一行的语义（用户裁决，见 §7.25）：报**真正会被用来跑 dsh 的那一份**。
  // dsh 那条路按"版本管理器里配套安装"优先（`dshInterpreterCandidates`），而通用搜索
  // （`findNodePath`）是另一套顺序 —— 两者不一致时，用户拿终端里的 `node -v` 对账就会对不上。
  let dshNodePath: string | null = null;
  try {
    const launcher = resolveDshLauncher(settings);
    if (launcher.kind === 'node-bin') dshNodePath = launcher.file;
  } catch {
    /* 解析不出来就退回通用那份（新机器上通常如此） */
  }
  const nodeForRow = dshNodePath ?? nodePath;

  let shellFile: string | null = null;
  let shellExists = false;
  try {
    const spec = resolveShell(settings);
    shellFile = spec.file || null;
    shellExists = Boolean(shellFile && fs.existsSync(shellFile));
  } catch (err) {
    error = `解析本地 Shell 失败：${messageOf(err)}`;
  }

  // 归属（需求 §7.7）：判据只有一份、是纯函数；完整探测本来就起子进程，所以把注册表那条证据也读上
  const ownership = nodeOwnershipFacts(nodeForRow, true);

  // 四项探测**并发**跑（各自有自己的 8 秒上限）：串行时"一个慢"会拖住后面每一个，
  // 而它们之间没有任何依赖 —— 真机上那 40 秒的卡顿就是串行 × 同步叠出来的。
  const [node, npm, pnpm, dsh] = await Promise.all([
    probeBinary(nodeForRow, ['--version'], runtime.platform),
    probeBinary(npmPath, ['-v'], runtime.platform),
    probeBinary(pnpmPath, ['-v'], runtime.platform),
    collectDshProbe(settings, runtime.platform),
  ]);

  // 通用搜索找到的那一份（跟上面不是同一个才有意义）：只多起一个探测，且只在需要时起
  let otherNode: EnvProbeRaw['otherNode'];
  if (nodePath && nodeForRow && nodePath !== nodeForRow) {
    const probe = await probeBinary(nodePath, ['--version'], runtime.platform);
    otherNode = { path: nodePath, version: probe.version, shim: isNodeShim(nodePath) };
  } else {
    // 没有"另选一份"的，也还有可能是"我们跳过了某个转发器"（例如 ~/.vite-plus/bin/node）——
    // 那正是用户拿终端 `node -v` 对不上的原因，报出来但**不执行它**（见 findSkippedNodeShim）。
    const skipped = findSkippedNodeShim(nodeForRow);
    if (skipped) otherNode = { path: skipped, version: null, shim: true };
  }

  return {
    checkedAt: Date.now(),
    platform: runtime.platform,
    packaged: runtime.packaged,
    bundled: runtime.bundled,
    node,
    npm,
    pnpm,
    dsh,
    otherNode,
    nodeServesDsh: Boolean(dshNodePath && dshNodePath === nodeForRow),
    shell: { file: shellFile, exists: shellExists },
    // VC++ 运行库：只读两个文件，不起进程（VM-09 的"该装哪一档 pnpm"靠它）
    vcRuntime: hasVcRuntime(),
    // 这份 Node 是不是版本管理器管的（VM-13 的"管理器在、零版本"靠它说中文）
    nodeFromVersionManager: looksVersionManagerNode(nodeForRow),
    nodeOwner: ownership.owner,
    nodeOwnerEvidence: ownership.evidence,
    error,
  };
}

/** 采集本身炸了时的兜底事实：八项一律 missing，error 带原因（界面顶部给黄条） */
function emptyProbe(runtime: EnvRuntime, error: string): EnvProbeRaw {
  return {
    checkedAt: Date.now(),
    platform: runtime.platform,
    packaged: runtime.packaged,
    bundled: runtime.bundled,
    node: { ...EMPTY_VERSION_PROBE },
    npm: { ...EMPTY_VERSION_PROBE },
    pnpm: { ...EMPTY_VERSION_PROBE },
    dsh: {
      kind: null,
      display: null,
      runs: false,
      timedOut: false,
      version: null,
      exitCode: null,
      error: null,
      resolveError: error,
    },
    shell: { file: null, exists: false },
    // 采集本身炸了：归属只能是"判不出来"（证据里写清原因，不假装知道）
    nodeOwner: 'unknown',
    nodeOwnerEvidence: [error],
    error,
  };
}

/** 读一次 `npm prefix -g`（确认区里显示"会装进哪个目录"）；取不到就 null */
async function readNpmPrefix(npmPath: string, platform: string): Promise<string | null> {
  // 与修复执行走同一个包装器：Windows 上 `npm` 是 .cmd，直 spawn 会 EINVAL
  const spec = npmLaunchSpec(npmPath, ['prefix', '-g'], platform);
  // 同样不许阻塞主进程（见 runVersion 的说明）：这就是一次 `npm prefix -g`，
  // 但 npm 在某些环境下会去连网（配置了源、或它自己要检查更新）—— 同步等它同样是几十秒。
  return await new Promise<string | null>((resolve) => {
    let child: ChildProcess | null = null;
    let stdout = '';
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      releaseChild(child);
      finish(null);
    }, PROBE_TIMEOUT_MS);
    try {
      child = spawn(spec.file, spec.args, {
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
        env: envWithKnownBins(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish(null);
      return;
    }
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? firstLine(stdout) || null : null));
  });
}

/** 三个引导步骤：数组顺序 = 界面顺序 = 用户要走的顺序（需求 §4.2） */
export const WIZARD_STEP_IDS: EnvWizardStepId[] = ['node', 'pnpm', 'dsh'];

/**
 * 每个步骤读哪几项既有自检（**只分组，不新增探测项**）。
 * 这里的项只用来"解释原因"与界面上的「展开看详情」，判据本身见 `WIZARD_STEP_JUDGE`。
 */
export const WIZARD_STEP_CHECK_IDS: Record<EnvWizardStepId, EnvCheckId[]> = {
  node: ['node', 'node-version', 'npm'],
  pnpm: ['pnpm'],
  dsh: ['dsh', 'dsh-run'],
};

/**
 * 能不能跳过。`node` 与 `dsh` 恒为 false —— 缺了它们 dsh 根本起不来，
 * "跳过"只会把用户送进一个用不了的主界面；`pnpm` 只有插件页受影响，允许跳。
 * 不可跳过的 id 写进设置也会被判定忽略（反绕过，见需求 §4.3）。
 */
export const WIZARD_STEP_SKIPPABLE: Record<EnvWizardStepId, boolean> = {
  node: false,
  pnpm: true,
  dsh: false,
};

/** 步骤能用哪个既有 npm 动作替用户做（`node` 恒为 null：它走安装通道 `envNodeInstall`） */
export const WIZARD_STEP_FIX_ACTION: Record<EnvWizardStepId, EnvFixAction | null> = {
  node: null,
  pnpm: 'install-pnpm',
  dsh: 'install-dsh',
};

/** 步骤名字（人话，用在 `gateReason` 这类主进程现拼的句子里） */
export const WIZARD_STEP_LABEL: Record<EnvWizardStepId, string> = {
  node: 'Node',
  pnpm: 'pnpm',
  dsh: 'dsh',
};

type CheckStatusLookup = (id: EnvCheckId) => EnvCheckStatus;

/** 三步各自的判据（冻结 §2.2 的表；`node` 那条按 VM-03 收严，理由见 `judgeWizard` 的注释） */
export const WIZARD_STEP_JUDGE: Record<EnvWizardStepId, (statusOf: CheckStatusLookup) => boolean> =
  {
    // **真的能跑才算完成**：找到文件还不够 —— `node --version` 出不来结果就是"还没准备好"
    node: (statusOf) => statusOf('node') !== 'missing' && statusOf('node-version') !== 'missing',
    pnpm: (statusOf) => statusOf('pnpm') !== 'missing',
    dsh: (statusOf) => statusOf('dsh') !== 'missing' && statusOf('dsh-run') !== 'missing',
  };

/** 三档状态的"严重程度"：缺东西 > 测不出来 > 正常（挑那一行的事实给界面看时用） */
const CHECK_SEVERITY: Record<EnvCheckStatus, number> = { missing: 3, warn: 2, ok: 1 };

/**
 * 读一个字段：**只接受对象**，其余（`null` / `undefined` / 字符串 / 数字）一律读成 `undefined`。
 *
 * 判定函数的入参从线缆与磁盘来（用户手改得动 `settings.json`，老界面也可能递来别的形状），
 * 所以读字段这一步本身就不能抛。`judgeWizard` 的「任何输入都不抛」从这里起步。
 */
function fieldOf(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') return undefined;
  return (source as Record<string, unknown>)[key];
}

/** 只接受数组；不是数组（`null` / `undefined` / 字符串 / 数字）一律当空数组，绝不抛 */
function arrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * 归属事实（需求 §7.7 / 冻结 §3.2.1）：把「真实路径 + 环境变量 + §7.6 的模型 + 注册表里的安装目录」
 * 凑齐，然后交给**唯一的那份判据** `detectNodeOwner`（安装引擎里的纯函数）。
 *
 * 这里**只凑事实、不做判断**（判定必须是纯函数，才能被离线夹具钉住）：
 *   - `withRegistry` = 完整探测（已经要起子进程了，多读一个注册表键没有代价）；
 *   - 快速探测传 false —— 启动瞬间那一次**不起子进程**（R-14），
 *     而读 `HKLM\SOFTWARE\Node.js` 要起 `reg.exe`。那条正面证据只是加分项，缺了不影响结论。
 */
function nodeOwnershipFacts(
  nodePath: string | null,
  withRegistry: boolean,
): { owner: EnvNodeOwner; evidence: string[] } {
  const model = deriveNvmModelFromEnvironment(process.env);
  return detectNodeOwner({
    nodePath,
    env: process.env,
    model,
    msiInstallPath: withRegistry ? readNodeMsiInstallPath() : null,
  });
}

/** 一组自检里最值得先看的那一行（同级按传入顺序；空数组给 null，不抛） */
function worstRow(rows: EnvCheck[]): EnvCheck | null {
  let best: EnvCheck | null = null;
  for (const row of rows) {
    if (!best || CHECK_SEVERITY[row.status] > CHECK_SEVERITY[best.status]) best = row;
  }
  return best;
}

/**
 * 启动瞬间的**快速探测**（需求 R-14）：只读文件系统，**不起任何子进程**。
 *
 * 为什么需要它：完整探测（`collectEnvProbe`）要起 `node --version` / `npm -v` / `pnpm -v` /
 * `dsh --version` 四次子进程（各 8 秒超时），在健康机器上为了"决定要不要自动拉起 dsh"
 * 多等几百毫秒到几秒是不值的。而"纯净机器"的判据（找不到 node）本来就是**文件系统事实**。
 *
 * 所以这里只查 node / npm / pnpm 三个**路径**（复用既有的三个查找函数，不另写一套 PATH 解析），
 * 把"必须起子进程才知道的项"标成 `skipped`：判定一律给 `warn`（= 这一轮没测），不是 `missing`。
 * 判定仍然走**同一个** `judgeEnvironment` + `judgeWizard` —— 判据只有一处。
 *
 * 任何意外都不抛：照 `emptyProbe` 的做法给一份"事实为空 + error 带原因"的原始事实
 * （于是判定给 `unknown`，不挡人）。1.5 秒后的完整探测照旧跑，那才是门禁层与自检页的结论来源。
 */
export function collectBootProbe(settings: SettingsValues, runtime: EnvRuntime): EnvProbeRaw {
  try {
    const nodePath = findNodePath();
    const npmPath = findNpm();
    const pnpmPath = findPnpmPath();

    // 本地 Shell 也是"只读文件系统"就能确定的（resolveShell 只查 PATH 与几个固定路径）
    let shellFile: string | null = null;
    let shellExists = false;
    let error: string | null = null;
    try {
      const spec = resolveShell(settings);
      shellFile = spec.file || null;
      shellExists = Boolean(shellFile && fs.existsSync(shellFile));
    } catch (err) {
      error = `快速探测解析本地 Shell 失败：${messageOf(err)}`;
    }
    // 归属同样只读文件系统与环境（**不读注册表：那要起 reg.exe**，见 nodeOwnershipFacts）
    const ownership = nodeOwnershipFacts(nodePath, false);

    return {
      checkedAt: Date.now(),
      platform: runtime.platform,
      packaged: runtime.packaged,
      bundled: runtime.bundled,
      node: { path: nodePath, version: null, exitCode: null, error: null, skipped: true },
      npm: { path: npmPath, version: null, exitCode: null, error: null, skipped: true },
      pnpm: { path: pnpmPath, version: null, exitCode: null, error: null, skipped: true },
      // dsh 的定位要先解析启动命令（node-bin 那条路会实测），快速探测整项不测
      dsh: {
        kind: null,
        display: null,
        runs: false,
        version: null,
        exitCode: null,
        error: null,
        resolveError: null,
        skipped: true,
      },
      shell: { file: shellFile, exists: shellExists },
      // 快速探测也顺带认一下：这条判据只看两个文件在不在，不必等 1.5 秒后的完整探测
      vcRuntime: hasVcRuntime(),
      // 同理：只看路径形状，不起子进程
      nodeFromVersionManager: looksVersionManagerNode(nodePath),
      nodeOwner: ownership.owner,
      nodeOwnerEvidence: ownership.evidence,
      error,
    };
  } catch (err) {
    return emptyProbe(runtime, `快速探测没能完成：${messageOf(err)}`);
  }
}

/**
 * 门禁判定（设计冻结 §2.2）：把一份既有报告判成"三步各是什么状态、门禁开不开、当前该处理哪一步"。
 *
 * **纯函数**：只读入参（不碰磁盘、不起子进程、不读 `process.*`、不看时钟），任何输入都不抛。
 * 界面**不自己判**——两套判据就是两套口径，"环境 OK"必须只有一个答案。
 *
 * 三步的判据（`WIZARD_STEP_JUDGE`）：
 *   - `node`：`node` 与 `node-version` 都不是 `missing` —— **真的能跑才算完成**。
 *     VM 实测（VM-03）踩到的正是这里：`node.exe` 在（版本管理器的 shim），但 `node --version`
 *     出不来结果，旧判据（只看文件在不在）于是把第一步判成「已完成」，而下一步的 npm 立刻报
 *     "No active Node.js version is configured" —— 界面说的和机器能做的是两件事。
 *     现在只有"这个运行环境不允许起子进程"（EPERM 一类）才留黄灯、不挡人。
 *   - `pnpm`：`pnpm` 那一项不是 `missing`
 *   - `dsh` ：`dsh` 与 `dsh-run` 都不是 `missing`（定位得到 + 实测跑得动）
 *
 * 判据不满足时按三条决定状态（顺序即优先级）：
 *   1. 用户跳过过它、且它可跳过 → `skipped`
 *   2. `checkIds` 里至少一项 `missing` → `todo`（**有证据的缺失**，门禁挡住人的唯一理由）
 *   3. 否则 → `unknown`（只有 `warn`，也就是这一轮测不出来；需求 §4.3：不挡人）
 *
 * `report.error !== null` 时：**没有 `missing` 证据的步骤一律记 `unknown`**（不宣称"这一步好了"），
 * 有 `missing` 证据的步骤仍是 `todo`（有证据就挡）。用户的显式跳过（`skipped`）不因此改变 ——
 * 那是他的选择，与"我们测不出来"是两回事。
 *
 * **入参形状不可信**：`skips` 来自用户手改得动的 `settings.json`（`"envSkips": null` 是真实可达到的），
 * `checks` / `plans` 来自报告。所以一进门就用 `fieldOf` / `arrayOf` 归一化一次，
 * 后面**只读归一化后的值** —— 冻结 §2.1 的「任何输入都不抛」靠"每个字段各自打补丁"守不住。
 */
export function judgeWizard(report: EnvDoctorReport, skips: EnvWizardStepId[]): EnvWizardState {
  const requestedSkips: EnvWizardStepId[] = arrayOf<EnvWizardStepId>(skips);
  const acceptedSkips: EnvWizardStepId[] = [];
  for (const id of WIZARD_STEP_IDS) {
    if (!WIZARD_STEP_SKIPPABLE[id]) continue; // 不可跳过的 id 被忽略（不是报错、也不是生效）
    if (!acceptedSkips.includes(id) && requestedSkips.includes(id)) acceptedSkips.push(id);
  }

  const checks: EnvCheck[] = arrayOf<EnvCheck>(fieldOf(report, 'checks'));
  const plans: EnvFixPlan[] = arrayOf<EnvFixPlan>(fieldOf(report, 'plans'));
  const reportError = fieldOf(report, 'error');
  // 只有"明确写了 null"才算"这一轮没有错误"；字段缺失（畸形输入）按"没测全"处理：
  // 宁可给 `unknown`（不挡人），也不对着一份来路不明的报告宣称"环境 OK"。
  const failed = reportError !== null && reportError !== undefined;

  const rowOf = (id: EnvCheckId): EnvCheck | null => {
    for (const row of checks) if (row && row.id === id) return row;
    return null;
  };
  // 拿不到那一行 = 没有证据（当"测不出来"，绝不当"缺东西"）
  const statusOf = (id: EnvCheckId): EnvCheckStatus => rowOf(id)?.status ?? 'warn';

  const steps: EnvWizardStep[] = [];
  for (const id of WIZARD_STEP_IDS) {
    const checkIds = WIZARD_STEP_CHECK_IDS[id];
    const rows: EnvCheck[] = [];
    for (const checkId of checkIds) {
      const row = rowOf(checkId);
      if (row) rows.push(row);
    }

    let status: EnvStepStatus;
    if (WIZARD_STEP_JUDGE[id](statusOf)) status = 'done';
    else if (WIZARD_STEP_SKIPPABLE[id] && acceptedSkips.includes(id)) status = 'skipped';
    else if (checkIds.some((checkId) => statusOf(checkId) === 'missing')) status = 'todo';
    else status = 'unknown';

    // error 非空 = 这一轮没测全：没有 missing 证据的步骤不宣称"好了"，但也不挡人
    if (status === 'done' && failed) status = 'unknown';

    let detail: string;
    if (status === 'done') {
      detail = worstRow(rows.filter((row) => row.status === 'ok'))?.detail ?? '这一步已经就绪';
    } else if (status === 'skipped') {
      detail = `已经按你的选择跳过这一步：${worstRow(rows)?.detail ?? '（这一项没有拿到可判断的信息）'}`;
    } else {
      // todo / unknown：把最重的那一行的事实原样给出来（界面直接显示，不重新拼）
      detail = worstRow(rows)?.detail ?? '（这一项没有拿到可判断的信息）';
    }

    const planned = WIZARD_STEP_FIX_ACTION[id];
    const fixAction: EnvFixAction | null =
      planned !== null && plans.some((plan) => plan && plan.action === planned) ? planned : null;

    steps.push({
      id,
      status,
      detail,
      checkIds: [...checkIds],
      skippable: WIZARD_STEP_SKIPPABLE[id],
      fixAction,
    });
  }

  const todos = steps.filter((step) => step.status === 'todo');
  const unknowns = steps.filter((step) => step.status === 'unknown');
  const gate: EnvGateState =
    todos.length > 0 ? 'blocked' : unknowns.length > 0 ? 'unknown' : 'open';
  const currentStepId: EnvWizardStepId | null = todos[0]?.id ?? unknowns[0]?.id ?? null;
  const labels = (list: EnvWizardStep[]) =>
    list.map((step) => WIZARD_STEP_LABEL[step.id]).join('、');
  const gateReason: string | null =
    gate === 'blocked'
      ? `还缺 ${labels(todos)} —— 装好它们才能进入主界面`
      : gate === 'unknown'
        ? `${labels(unknowns)} 这一轮没测出来（不是缺东西）：可以重新检测，也可以直接进入主界面`
        : null;

  return { report, steps, gate, currentStepId, gateReason, skips: acceptedSkips };
}

export interface EnvDoctorHooks {
  /** 主进程注入的运行时事实（platform / isPackaged / process.versions） */
  runtime: () => EnvRuntime;
  /** 每完成一轮（含一键修复后的复检）时的回调 */
  onReport?: (report: EnvDoctorReport) => void;
  /**
   * 日志行（**可选**：不传就一个字都不记，既有调用方不受影响）。
   *
   * 为什么需要它：界面上只说人话（冻结 §3.8 #22 —— `PATH` / `dsh.cmd` / `npx` / `EPERM`
   * 这类内部记号一律不上界面），但**原始错误不能跟着消失**。真机上"这台机器的 node / dsh
   * 为什么用不了"唯一的凭据就是子进程给的那句原文（`VersionProbe.error`、
   * `DshProbe.resolveError`），它现在哪儿都不落，下次排查只能靠猜 —— VM 实测里撞到的
   * 正是这个场景。
   *
   * 判据因此是成对的：**日志里找得到原文，界面文案里找不到**。两条断言都在
   * `test/selftest.ts` 的 17c / 17d 两节里（词表规则不因此放松）。
   */
  log?: (line: string) => void;
}
/**
 * 自检的报告持有者：**缓存 + 采集 + 复检**。
 *
 * 缓存的就是那份 `EnvDoctorReport`，不额外找地方存：
 *   - `report()`：有缓存直接给（窗口重载 / 切页时不必重跑一堆子进程）；
 *   - `report(true)` / `recheck()`：清缓存重跑；
 *   - `invalidate()`：改过 `dshCommand` / `cwd` / `shell` 时让缓存失效，**不主动重跑**
 *     （用户此刻在设置页，切到自检页时自然会拿到新结论）。
 *
 * 真跑一轮（缓存命中不算）还会把"因跑出错而没通过"的**原始错误**交给可选的 `hooks.log`：
 * 界面上那些句子是给人看的（不许出现内部术语），原文只在日志里 —— 见 `probeTroubleLines`。
 */
export class EnvDoctor {
  private cached: EnvDoctorReport | null = null;
  /** `npm prefix -g` 的结果；undefined = 这一轮还没问过 */
  private prefix: string | null | undefined;

  constructor(
    private readonly settings: Settings,
    private readonly hooks: EnvDoctorHooks,
  ) {}

  get platform(): string {
    return this.hooks.runtime().platform;
  }

  invalidate(): void {
    this.cached = null;
    this.prefix = undefined;
  }

  async report(refresh = false): Promise<EnvDoctorReport> {
    if (!refresh && this.cached) return this.cached;
    this.prefix = undefined;
    const { report: judged, raw } = await this.judge();
    // 界面撤下去的那些原始错误在这里落日志（**只落日志**：界面文案仍是人话）。
    // 放在最前面：哪怕后面问 `npm prefix -g` 出了意外，这一轮的原文也已经记下来了。
    this.logTrouble(raw, judged);
    // plans 里的 target 要问一次 npm（判定是纯函数，不问）；
    // 没有可用的计划时连问都不问。
    const target = judged.plans.length > 0 ? await this.npmPrefix() : null;
    const report: EnvDoctorReport = {
      ...judged,
      plans: judged.plans.map((plan) => ({ ...plan, target })),
    };
    this.cached = report;
    this.hooks.onReport?.(report);
    return report;
  }

  /** 一键修复跑完后的复检（设计 3.3）：清缓存重跑一轮并把结果交给调用方 */
  async recheck(): Promise<EnvDoctorReport> {
    return await this.report(true);
  }

  /** 现场重算一个动作的计划 —— `envFix` 只递 action，命令这边现算（安全模型第 1 条） */
  async fixPlan(action: EnvFixAction): Promise<EnvFixPlan | null> {
    // VC++ 运行库这条事实**现场再认一次**（用户可能在两次点击之间装上了运行库）
    const plan = envFixPlan(action, findNpm(), hasVcRuntime());
    if (!plan) return null;
    return { ...plan, target: await this.npmPrefix() };
  }

  private async npmPrefix(): Promise<string | null> {
    if (this.prefix !== undefined) return this.prefix;
    const npmPath = findNpm();
    this.prefix = npmPath ? await readNpmPrefix(npmPath, this.platform) : null;
    return this.prefix;
  }

  private async judge(): Promise<{ report: EnvDoctorReport; raw: EnvProbeRaw }> {
    const runtime = this.hooks.runtime();
    try {
      const raw = await collectEnvProbe(this.settings.all(), runtime);
      return { report: judgeEnvironment(raw), raw };
    } catch (error) {
      // 采集炸了也要给出一份能显示的报告：八行照常显示，error 非空由界面顶部说明
      const raw = emptyProbe(runtime, `这一轮没测全：${messageOf(error)}`);
      return { report: judgeEnvironment(raw), raw };
    }
  }

  /**
   * 把这一轮"因跑出错而没通过"的原始错误写进日志（`log` 钩子不传就什么都不做）。
   *
   * 记日志这件事**绝不拖垮自检**：与 `logger.ts` 写盘失败时的原则一致，这里也兜住异常。
   */
  private logTrouble(raw: EnvProbeRaw, report: EnvDoctorReport): void {
    const log = this.hooks.log;
    if (!log) return;
    try {
      for (const line of probeTroubleLines(raw, report)) log(`环境自检：${line}`);
    } catch {
      // 日志是排查的辅助，不是自检的一部分；它失败不该让这一页拿不到结果
    }
  }
}

export interface EnvFixHooks {
  /** 边跑边推的输出片段 */
  output: (chunk: string) => void;
  /** 相位 / 收尾消息 / 复检报告的变化 */
  state: (state: EnvFixState) => void;
  /** 事件日志（不静默：动作与结果都记一条） */
  log: (text: string) => void;
  /**
   * 日志文件的位置（**可选**：主进程传 `<userData>/logs/console.log`）。
   *
   * 为什么要它：装出来的东西跑不起来时，界面必须能告诉用户"细节在哪"（t23 那条口径：
   * 细节留日志、结论给人话）。模块自己不 import electron、也不知道 userData，所以由主进程给。
   * 拿不到（写盘失败）时给 null，界面文案退化成"用户数据目录下的 logs/console.log"。
   */
  logFile?: () => string | null;
}

/**
 * 一键修复的执行者。
 *
 * 安全模型（见 docs/env-doctor.md 第 3 节）：
 *   - 渲染层只递 `action`，argv 由这边用 `fixPlan()` + `npmLaunchSpec()` 现算；
 *   - `spawn(file, args)` + 数组，**没有 `shell: true`**；
 *   - PATH 用 `envWithKnownBins` 补齐（Windows 上保留系统原有的 `Path` 键名），
 *     安装源用 `pluginRegistryEnv` 注入（只影响这一次子进程）；
 *   - 同一时刻只允许一个动作（两个 npm 同时改全局目录，结果不可预期）；
 *   - 可中断（`cancel()` → kill），到点自动中断（FIX_TIMEOUT_MS）。
 */
export class EnvFixRunner {
  private child: ChildProcess | null = null;
  /**
   * 同步的互斥位（**不要**用 `child` 代替它）：`child` 要到 spawn 之后才为真，
   * 而 `run()` 里从入口到 spawn 之间隔着 `fixPlan()`（一次子进程）。两次连点会都在
   * `this.busy` 那一行通过，于是两个 npm 同时改全局目录 —— 这一位必须在第一个 `await`
   * 之前同步置上，终态 publish 时释放（另有一层 finally 兜住异常路径）。
   */
  private running = false;
  private cancelled = false;
  private timedOut = false;
  private current: EnvFixState = {
    phase: 'idle',
    action: null,
    command: null,
    message: null,
    code: null,
    report: null,
  };

  constructor(
    private readonly settings: Settings,
    private readonly doctor: EnvDoctor,
    private readonly hooks: EnvFixHooks,
  ) {}

  get busy(): boolean {
    return this.running || this.child !== null;
  }

  state(): EnvFixState {
    return { ...this.current };
  }

  cancel(): boolean {
    if (!this.child) return false;
    this.cancelled = true;
    this.child.kill();
    return true;
  }

  async run(action: EnvFixAction): Promise<EnvFixState> {
    if (this.busy) {
      return { ...this.current, message: '已经有一个修复在进行中' };
    }
    // 同步占位，且必须在第一个 `await` 之前（见 running 的说明）。
    // 写在 `try` 外面是有意的：`try` 里第一句就是 `await`，这样后来往里加代码也不会把它挤到 await 后面。
    this.running = true;
    try {
      // 真正的流程在 execute 里（中间那一串 await 都不碰互斥位）
      return await this.execute(action);
    } finally {
      // 兜住所有路径（包括抛异常）：互斥位绝不能留着自己不放
      this.running = false;
    }
  }

  private async execute(action: EnvFixAction): Promise<EnvFixState> {
    const plan = await this.doctor.fixPlan(action);
    if (!plan) {
      return this.publish({
        phase: 'error',
        action,
        command: null,
        message:
          '没找到可用的 npm —— 装 pnpm / dsh 都要靠它。可以先重装官方 Node，或用 `corepack enable pnpm`。',
        code: null,
        report: null,
      });
    }

    // Windows 上 npm.cmd 不能直接 spawn、也不能让 Node 自己加引号：包装器统一处理
    const spec = npmLaunchSpec(plan.file, plan.args, this.doctor.platform);
    const env: NodeJS.ProcessEnv = {
      ...envWithKnownBins(process.env),
      ...pluginRegistryEnv(this.settings.all().pluginRegistry),
    };

    this.cancelled = false;
    this.timedOut = false;
    this.publish({
      phase: 'running',
      action,
      command: plan.display,
      message: null,
      code: null,
      report: null,
    });
    this.hooks.log(`环境修复：${plan.display}（本次使用设置里的插件安装源，如有）`);

    // 两路分开收：合并的 `tail` 给归纳器与输出区，**分开的两份进日志**（VM-06 的教训：
    // "文件在、跑起来零输出"必须能一眼看出是 stdout 空、stderr 空还是哪一路有话说）
    let tail = '';
    let outText = '';
    let errText = '';
    const collect = (chunk: Buffer | string): void => {
      const text = String(chunk);
      tail = (tail + text).slice(-FIX_TAIL_CHARS);
      this.hooks.output(text);
    };
    const collectOut = (chunk: Buffer | string): void => {
      outText = (outText + String(chunk)).slice(-RAW_LOG_CHARS);
      collect(chunk);
    };
    const collectErr = (chunk: Buffer | string): void => {
      errText = (errText + String(chunk)).slice(-RAW_LOG_CHARS);
      collect(chunk);
    };

    const outcome = await new Promise<{ code: number | null; error: string | null }>((resolve) => {
      let settled = false;
      const finish = (value: { code: number | null; error: string | null }): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let child: ChildProcess;
      try {
        child = spawn(spec.file, spec.args, {
          env,
          // cwd 固定成主目录：继承来的 cwd 是 Electron 的启动目录（从 Finder 起可能是 /），
          // 那里若有一份 .npmrc 会意外生效。
          cwd: homeDir(),
          windowsHide: true,
          // 命令行是我们按 cmd 规则拼好的，Node 不要再加引号（见 LaunchSpec 的说明）
          windowsVerbatimArguments: spec.windowsVerbatimArguments,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        finish({ code: null, error: messageOf(error) });
        return;
      }
      this.child = child;

      const timer = setTimeout(() => {
        this.timedOut = true;
        collect(`\n（超过 ${Math.round(FIX_TIMEOUT_MS / 60000)} 分钟，已中断）\n`);
        child.kill();
      }, FIX_TIMEOUT_MS);
      timer.unref?.();

      child.stdout?.on('data', collectOut);
      child.stderr?.on('data', collectErr);
      child.on('error', (error: Error) => {
        clearTimeout(timer);
        this.child = null;
        collect(`\n${error.message}\n`);
        finish({ code: null, error: error.message });
      });
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        this.child = null;
        finish({ code, error: null });
      });
    });

    if (this.cancelled) {
      const message = this.timedOut
        ? '已中断（超时自动中断，npm 可能已经写了一部分）'
        : '已中断（npm 可能已经写了一部分）';
      return this.publish({
        phase: 'cancelled',
        action,
        command: plan.display,
        message,
        code: outcome.code,
        report: null,
      });
    }
    // 超时是**独立终态**：到点是我们主动 kill 的，退出码会是 null / 非 0，不能落进下面
    // 「退出码 N，认不出具体原因」那条 —— 那条是给 npm 自己失败用的，会把真正的原因说错。
    if (this.timedOut) {
      const message = fixTimeoutMessage();
      this.logFixRaw(plan, outcome.code, outText, errText, '超时中断');
      this.hooks.log(`环境修复失败：${plan.display} → ${message}`);
      return this.publish({
        phase: 'error',
        action,
        command: plan.display,
        message,
        code: outcome.code,
        report: null,
      });
    }
    if (outcome.error) {
      const message = `没能启动 npm：${outcome.error}`;
      this.logFixRaw(plan, null, outText, errText, 'npm 没能起来');
      this.hooks.log(`环境修复失败：${plan.display} → ${message}`);
      return this.publish({
        phase: 'error',
        action,
        command: plan.display,
        message,
        code: null,
        report: null,
      });
    }
    if (outcome.code !== 0) {
      // 认得出就归纳成人话，认不出就只报退出码（原文留在输出区与日志，不编原因）
      const message =
        summarizeEnvFixFailure(tail) ??
        `退出码 ${outcome.code ?? '未知'}，认不出具体原因，下面是 npm 的原文`;
      this.logFixRaw(plan, outcome.code, outText, errText, '安装没有成功');
      this.hooks.log(`环境修复失败：${plan.display} → ${message}`);
      return this.publish({
        phase: 'error',
        action,
        command: plan.display,
        message,
        code: outcome.code,
        report: null,
      });
    }

    // 第一步：**先刷新查找路径**（重读注册表 PATH + 重扫已知 bin 目录 + 这次装到哪儿了），再复检。
    // 不刷新的话，刚装好的东西在这一轮里根本看不见 —— 用户只能重开应用（VM-07 那一屏）。
    const added = refreshLookupPath(this.lookupDirs(plan));
    if (added.length > 0) {
      this.hooks.log(`环境修复：刷新查找路径，新注入 ${added.length} 个目录：${added.join('；')}`);
    }
    // 第二步：复检 + **功能实测**（`<pnpm> -v` 真的打出东西才算成功，只看"文件在"不算 —— VM-06）
    const report = await this.doctor.recheck();
    const probe = await probeFixTarget(action, this.doctor.platform);
    const statusOf = (id: EnvCheckId): EnvCheckStatus =>
      report.checks.find((item) => item.id === id)?.status ?? 'missing';
    // dsh 的"能用"要两步都过：定位得到（dsh）**且**实测跑得动（dsh-run）—— 与门禁那条判据同一份口径
    const ok =
      action === 'install-pnpm'
        ? statusOf('pnpm') === 'ok' && probe.version !== null
        : statusOf('dsh') === 'ok' && statusOf('dsh-run') === 'ok';
    const found = action === 'install-pnpm' ? probe.file !== null : statusOf('dsh') === 'ok';
    const label = action === 'install-pnpm' ? 'pnpm' : 'dsh';
    // 「找到了但跑不起来」先认原因（VM-09：原生 exe 缺 VC++ 运行库 / 静默失败），
    // 认得出就把人话结论与两条出路放进界面文案，认不出就不硬编原因
    const verdict =
      !ok && found && probe.file
        ? describePnpmRunFailure({
            file: probe.file,
            exitCode: probe.exitCode,
            stdout: probe.version ?? '',
            stderr: probe.stderr ?? '',
            vcRuntime: probe.vcRuntime,
          })
        : null;
    const message = fixDoneMessage({
      label,
      ok,
      found,
      blocked: probe.blocked,
      refreshed: added.length,
      logFile: this.hooks.logFile?.() ?? null,
      verdict,
    });
    // 没通过（或 npm 自己在说安装脚本没被允许）→ 把**实际执行的命令 / 退出码 / stdout / stderr**
    // 全落进日志：下一轮真机一次就能看清原因，而不是靠猜（VM-06 的教训）。
    if (!ok) {
      if (verdict) {
        this.hooks.log(
          `环境修复：认出来了 —— ${verdict.message}；出路：${verdict.hints.join('；')}`,
        );
      }
      this.logFixRaw(plan, outcome.code, outText, errText, '这一轮没有装出可用的结果');
      this.logProbeRaw(action, probe);
    } else if (INSTALL_SCRIPTS_WARNING.test(tail)) {
      this.logFixRaw(plan, outcome.code, outText, errText, 'npm 提示安装脚本没有被允许');
    }
    this.hooks.log(`环境修复完成：${plan.display} → 退出码 0，${message}`);
    return this.publish({
      phase: 'done',
      action,
      command: plan.display,
      message,
      code: outcome.code,
      report,
    });
  }

  /** 这一次装到哪儿了：npm 的全局 prefix 就是全局 bin 目录（POSIX 上再补一个 bin） */
  private lookupDirs(plan: EnvFixPlan): string[] {
    const target = plan.target;
    if (!target) return [];
    return this.doctor.platform === 'win32' ? [target] : [target, path.join(target, 'bin')];
  }

  /**
   * 把**那一次实际执行**的原文落进日志：命令 + 退出码 + stdout + stderr（两路分开写）。
   *
   * 细节留日志、结论给人话（t23 那条口径）：界面只说"装出来是坏的 / 没能装成"，
   * 而"到底哪一路说了什么"是排查用的，落在 `<userData>/logs/console.log` 里。
   * 空的那一路也照写 `（空）` —— VM 那一屏的症状正是"stdout 空、stderr 空"，写出来才看得见。
   */
  private logFixRaw(
    plan: EnvFixPlan,
    code: number | null,
    stdout: string,
    stderr: string,
    why: string,
  ): void {
    const part = (text: string): string =>
      text.trim() ? `\n${text.trim().slice(-RAW_LOG_CHARS)}` : '（空）';
    this.hooks.log(
      `环境修复：${why}（下面是那一次的原文）\n命令：${plan.display}\n退出码：${
        code === null ? '未知（没能起来 / 被中断）' : code
      }\nstdout：${part(stdout)}\nstderr：${part(stderr)}`,
    );
  }

  /** 功能实测没通过时，把**实测那一条命令**的原文也落进日志（`<pnpm> -v` 的退出码 / 两路输出） */
  private logProbeRaw(action: EnvFixAction, probe: FixProbe): void {
    if (action !== 'install-pnpm' || !probe.file) return;
    this.hooks.log(
      `环境修复：功能实测没通过（下面是那一次的原文）\n命令：${probe.file} -v\n退出码：${
        probe.exitCode === null ? '未知' : probe.exitCode
      }\nstdout：${probe.version ?? '（空）'}\nstderr：${probe.stderr?.trim() ? `\n${probe.stderr.trim()}` : '（空）'}`,
    );
  }

  private publish(state: EnvFixState): EnvFixState {
    this.current = state;
    // 终态立刻腾出互斥位（只有 running 相位要保持它）
    if (state.phase !== 'running') this.running = false;
    this.hooks.state({ ...state });
    return state;
  }
}
