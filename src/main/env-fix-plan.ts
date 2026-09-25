/**
 * 一键修复的计划、argv、注册表查找路径与人话文案
 *
 * t51 从 `env-doctor.ts` 拆出来的；那个文件现在只做 barrel + 两个有状态的类（`EnvDoctor` /
 * `EnvFixRunner`），别的模块与两个反例脚本的 import 路径都不用改。
 */
import { probeBinary } from './env-probe';

import type { LaunchSpec } from './process-utils';

import type { EnvFixAction, EnvFixPlan } from '../shared/ipc';
import { isEnvironmentBlocked } from './env-judge';
import { FIX_TAIL_CHARS, FIX_TIMEOUT_MS, PROBE_TIMEOUT_MS } from './env-probe-types';
import { findPnpmPath } from './env-probe';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  hasVcRuntime,
  homeDir,
  isWindows,
  launchSpec,
  pathWithKnownBins,
  whichSync,
  windowsBinCandidates,
} from './process-utils';

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
export function envValueOf(env: NodeJS.ProcessEnv, name: string): string | null {
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
