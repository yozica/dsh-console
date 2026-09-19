/**
 * Node 安装 / 更新引擎（需求见 `docs/env-wizard.md` 第 7 / 9 节，实现契约见
 * `docs/env-wizard-freeze.md` §3.2 / §4.2）。只在 Windows 上真正动手。
 *
 * 这是整条链路里**唯一会动用户机器**的模块，所以重点不是功能数量，而是三件事：
 *
 * 1. **失败必须说人话**：安装器的原文（退出码 / stderr / 收尾尾巴）先经
 *    `classifyInstallFailure()` 归纳成结构化的一类（网络 / 权限 / 校验 / 目标被占用 /
 *    磁盘空间 / 架构不支持 / 取消 / 认不出来），界面拿到的是一句话，不是一段 stderr。
 *    「这台电脑上什么都没改」这类断言**只有复检事实支持时才说**（见 `settleFailure`）。
 * 2. **权限只由安装器自己触发**：应用启动、探测、打开向导、展开确认区都不弹提权询问；
 *    需要管理员权限的那一步就是把安装包交给系统自带的安装程序去跑。
 *    `isElevatedProbeOutput()` 负责一件相反的事：**发现我们自己是提权跑的时候**，
 *    拦下「用版本管理器安装」这条不该以管理员身份走的路（nvm 官方文档的警告）。
 * 3. **可回滚或说清补救**：我们自己写的东西只有「用户数据目录下的临时文件」（取消 / 失败 /
 *    退出时删）与「本进程内存里的那份环境」（**不写**系统设置、不改系统查找路径）；
 *    安装器改的东西不归我们回滚，失败时给一句明确的补救说明。
 *
 * 为什么不 import `electron` / `main/env-doctor` / `main/dsh-manager`：
 *   - 复检与「更新前停 dsh」由编排通过 `NodeInstallHooks` 注入（冻结文档 §4.1 方向规则 2），
 *     这样引擎能被普通 Node 直接 import —— 自检与反例脚本（离线、无网络）测它的纯函数；
 *   - Electron 的网络栈（下载，遵循系统代理）与用户数据目录用**按需 require**（照
 *     `main/updater.ts` 的做法）：拿不到就退回 `os.tmpdir()` 与「这次没有可用的下载通道」。
 *
 * 冻结清单之外的导出（都是**纯函数 / 类型**，是上面那些冻结签名的实现手段，不改任何冻结形状）：
 *   - `classifyInstallFailure` / `InstallFailureKind` / `InstallFailureReason`
 *     —— 失败分类（验收点名要求「错误分类要能在没有网络的机器上被测到」）；
 *   - `expandEnvReferences` —— 展开系统里 `%NVM_HOME%` 这类引用（读注册表是 IO，展开是判定；
 *     `mergePathFromRegistry` 的签名里只有两段文本、没有变量表，所以展开只能在它外面那层做）；
 *   - `parseReleaseSigning` —— 发布说明里「这一次签没签名」的自述（船长后补的裁决，见 §3.2 的
 *     `releaseSigning`；计划阶段的 `signer === null` **不**表示未签名）；
 *   - `nodeInstallerFileName` —— 安装包命名规则（与 `nodeInstallerUrl` 同一套，校验清单里查的就是它）。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import type {
  EnvDoctorReport,
  EnvInstallState,
  EnvNodeChannel,
  EnvNodeMethod,
  EnvNodeMode,
  EnvNodeOwner,
  EnvNodePlan,
  EnvNodeRequest,
} from '../shared/ipc';
import {
  envWithKnownBins,
  findNodeExe,
  homeDir,
  isWindows,
  launchSpec,
  pathWithKnownBins,
  whichSync,
  type LaunchSpec,
} from './process-utils';
import type { Settings } from './settings';

/** 官方版本清单（Node 的 index.json：新版本在前，`lts` 是代号或 false） */
const NODE_INDEX_PATH = 'index.json';
const NODE_DIST_HOST = 'https://nodejs.org/dist';
/** 版本管理器（nvm-windows）的发布资产；匿名访问有频次上限，失败时不缓存、不重试、不换源 */
const NVM_RELEASES_API = 'https://api.github.com/repos/nvm-windows/nvm/releases?per_page=20';
/** 给人看的发布页（拒绝类计划里 `url` 指向它 —— 那才是用户真有得去的地方） */
const NVM_RELEASES_PAGE = 'https://github.com/nvm-windows/nvm/releases';
/**
 * 装完版本管理器之后，我们要从系统里重读并注入本进程的变量名。
 *
 * nvm-windows 的安装程序改的是**两个**变量（`NVM_HOME` 放各版本、`NVM_SYMLINK` 是当前版本
 * 的符号链接位置）加 PATH；只补 PATH 不够（VM 实测那条链就断在这里）。白名单是显式的：
 * 不把系统里任意变量扫进我们的进程。
 */
const INJECTED_ENV_NAMES = ['NVM_HOME', 'NVM_SYMLINK', 'NVM_DIR'];
/** 确认区里的「自己装」出口 */
const NODE_DOWNLOAD_PAGE = 'https://nodejs.org/en/download';
/** 一次下载的总时限（超过就按「下载超时」收尾，临时文件删掉） */
const TRANSFER_TIMEOUT_MS = 10 * 60 * 1000;
/** 安装器/等待用户的最长时限；超过就**停止等待**（不杀安装器，见 `waitForClose`） */
const INSTALLER_TIMEOUT_MS = 30 * 60 * 1000;
/** 版本管理器自己下载 Node 的时限（它要拉几十 MB），同样只停止等待 */
const NVM_INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
/** 切换版本应当很快 */
const NVM_USE_TIMEOUT_MS = 2 * 60 * 1000;
/** 只读探测（注册表 / 提权 / 签名）的超时 */
const PROBE_TIMEOUT_MS = 15 * 1000;
/** `nvm list` 之类应当很快的版本管理器子命令 */
const NVM_LIST_TIMEOUT_MS = 60 * 1000;
/** 每条版本管理器命令写进日志的原文上限（stdout / stderr 各自截尾；空的那路写「（空）」） */
const STEP_EVIDENCE_CHARS = 1200;
/** 一次性提权（UAC 询问要等用户点）的时限 */
const ELEVATED_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Windows「开发者模式」的注册表值：开着时普通用户也能创建符号链接
 * （`nvm use` 在 Windows 上就是建符号链接，普通权限没开这个就会失败 —— VM 实测那条路）。
 */
const DEVELOPER_MODE_KEY =
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock\\AllowDevelopmentWithoutDevLicense';
/** 输出尾巴只留这么多字符：归纳失败原因与贴进输出区都用它 */
const OUTPUT_TAIL_CHARS = 64 * 1024;
/** 临时目录里的残留超过这个时长就可以清掉（下载中断 / 应用被杀之后留下的） */
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;
/** 忙位上的那句话：与编排、界面 `title` 文案同一句（冻结文档 §4.3） */
const BUSY_MESSAGE = '正在执行上一步的操作，完成后按钮会自动恢复';
/** 「不再等待」的结论句（交互规格 §7.4 原样） */
const DETACHED_MESSAGE =
  '我们不等了：安装可能还在后台进行，请按它自己的提示把它做完，做完点「重新检测」。';

// ---------------------------------------------------------------- 纯函数（冻结清单，离线可测）

export interface NodeReleaseEntry {
  version: string;
  lts: string | false;
  files: string[];
  npm?: string;
}

/** 官方版本清单（index.json）→ 条目数组；解析失败返回空数组（不抛） */
export function parseNodeReleaseIndex(text: string): NodeReleaseEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const list: NodeReleaseEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const record: Record<string, unknown> = { ...item };
    const version = typeof record.version === 'string' ? record.version : '';
    if (!version) continue;
    const files = Array.isArray(record.files)
      ? record.files.filter((file): file is string => typeof file === 'string')
      : [];
    const entry: NodeReleaseEntry = {
      version,
      lts: typeof record.lts === 'string' ? record.lts : false,
      files,
    };
    if (typeof record.npm === 'string') entry.npm = record.npm;
    list.push(entry);
  }
  return list;
}

/**
 * 选档：`lts` = 清单里第一条 `lts !== false`（清单是新版本在前，所以这就是最新稳定版）；
 * `current` = 第一条。都不满足返回 null。
 */
export function pickNodeRelease(
  list: NodeReleaseEntry[],
  channel: EnvNodeChannel,
): NodeReleaseEntry | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  if (channel === 'current') return list[0];
  return list.find((entry) => entry.lts !== false) ?? null;
}

/**
 * 该档在这台电脑的架构上有没有 Windows 安装包（读 `files` 里的 `win-<arch>-msi`）。
 *
 * **真机事实（2026-09，866 条清单全量扫描）**：index.json 里从来没有 `win-arm64-msi`
 * 这一项（出现 0 次，`win-x64-msi` 出现 631 次），但同一个版本目录下的校验清单里**确实有**
 * `node-v<版本>-arm64.msi`（对 v24.21.0 实测两个文件都 HTTP 200：x64 33230848 字节、
 * arm64 29671424 字节）。按冻结文档 §4.2 的字面（只读 `files`）实现，结果是 arm64 机器上
 * 「直接安装官方版本」这条路会被判成架构不支持 —— 这不是猜测，是已核对的外部事实，
 * 已按「与冻结冲突就报给船长」的规矩上报，等裁定；在那之前不擅自放宽判据。
 */
/** Node 官方只出这三种 Windows msi 命名 */
const WINDOWS_MSI_ARCHES = ['x64', 'arm64', 'ia32'];

/**
 * 官方下载地址（纯拼装；**存在性不在这里判**）。
 *
 * 为什么不再读 `files` 数组（船长 2026-09 裁定，推翻冻结 §4.2 的初稿）：
 * index.json 的 866 条里 `win-arm64-msi` 出现 **0 次**（`win-x64-msi` 631 次、
 * `win-arm64-zip` 161 次），可同一个版本目录下的 `SHASUMS256.txt` 里
 * `node-v<版本>-arm64.msi` 确实存在（v26.9.0 两个 msi 的 HEAD 都是 200：
 * x64 36520960 字节 / arm64 32501760 字节）。所以**存在性以版本目录里的校验清单
 * 为权威证据**（为了校验哈希我们本来就要取它），index.json 只用来列版本。
 * 于是这里只负责按架构拼出规范地址；认不出的架构 / 版本返回 null。
 */
export function nodeInstallerUrl(entry: NodeReleaseEntry, arch: string): string | null {
  const normalized = String(arch ?? '').toLowerCase();
  if (!WINDOWS_MSI_ARCHES.includes(normalized)) return null;
  if (!/^v\d+\.\d+\.\d+$/.test(String(entry.version ?? ''))) return null;
  return `${NODE_DIST_HOST}/${entry.version}/node-${entry.version}-${normalized}.msi`;
}

/** 安装包文件名（与 `nodeInstallerUrl` 同一套规则；校验清单里查的就是它） */
export function nodeInstallerFileName(version: string, arch: string): string {
  return `node-${version}-${arch}.msi`;
}

/** 官方校验清单文本 → 目标文件的 sha256；清单里没有这个文件返回 null */
export function parseShasums(text: string, fileName: string): string | null {
  const target = String(fileName ?? '').trim();
  if (!target) return null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (!match) continue;
    if (match[2] === target) return match[1].toLowerCase();
  }
  return null;
}

/** `v24.19.0` / `24.19.0` / `24.19` → [24,19,0]；认不出来返回 null */
function versionParts(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const parts: [number, number, number] = [
    Number(match[1]),
    Number(match[2]),
    match[3] === undefined ? 0 : Number(match[3]),
  ];
  return parts.every((part) => Number.isFinite(part)) ? parts : null;
}

/** Node 版本比较（只认 `vX.Y.Z` / `X.Y.Z` / `X.Y` 这类串；认不出按 0 处理，不抛） */
export function compareNodeVersions(a: string, b: string): number {
  const left = versionParts(a) ?? [0, 0, 0];
  const right = versionParts(b) ?? [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    const diff = left[index] - right[index];
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** 版本管理器的目录名特征（除 nvm 之外的版本管理器：认得出「不是系统装的」，但不当成 nvm） */
const OTHER_MANAGER_DIRS = ['volta', 'fnm', 'nvs', 'nodist', 'scoop'];

/** nvm 的目录名：**独立的一段**才算（`D:\nvm-tools\node.exe` 不误判 —— N4c 那条判据继续成立） */
const NVM_DIR_NAMES = ['nvm', 'nvm4w'];

/** 取自环境的一份值（键名大小写不敏感；Windows 上 NVM_HOME / Nvm_Home 都见过） */
function envValue(env: NodeJS.ProcessEnv, name: string): string {
  const key = Object.keys(env).find((item) => item.toLowerCase() === name.toLowerCase());
  const value = key ? env[key] : undefined;
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeForCompare(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/"/g, '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

function isUnder(child: string, parent: string): boolean {
  const target = normalizeForCompare(child);
  const root = normalizeForCompare(parent);
  if (!target || !root) return false;
  return target === root || target.startsWith(`${root}\\`);
}

/**
 * 「当前这份 Node 是谁管的」——**纯函数**：只读入参、没有 IO、不抛（冻结 §4.2 的 t29 形状，需求 §7.7）。
 *
 * 三条定死的规矩：
 *  1. **判据只有一份**：采集侧（`main/env-doctor.ts` 的完整探测与快速探测）与安装计划都调这一个导出，
 *     全仓库没有第二处路径归属判断（渲染层更不许自己猜）；
 *  2. 判据里**没有一条依赖子进程**：`nvm env` 只是加分证据（这里连它都不需要），
 *     所以启动瞬间的快速探测也判得出来；
 *  3. **没有"剩下的一律当系统装的"这条兜底**：`system` 必须**有正面证据**（官方默认安装位 /
 *     官方安装包自己写下的安装目录），其余一律 `unknown` —— 那条兜底正是 VM-14
 *     （在版本管理器管的机器上按"系统装的"又装一份官方 MSI）。
 *
 * 顺序即优先级：版本管理器的目录（模型给的根 / 版本目录 / 当前版本目录 + `NVM_*` 变量）→
 * 路径里那条独立的 `nvm` / `nvm4w` 目录名 → 官方安装位 → 其余（含 volta / fnm 等别的管理器）`unknown`。
 */
export function detectNodeOwner(input: {
  /** 自检报告里那份 Node 的真实路径（`findNodePath()` 的结果）；没找到时 null */
  nodePath: string | null;
  env: NodeJS.ProcessEnv;
  /** §7.6 推导出来的版本管理器模型（`deriveNvmModel` 的产物）；推不出来时 null */
  model: NvmModel | null;
  /** 官方安装包写在注册表里的安装目录（`HKLM\SOFTWARE\Node.js` 的 `InstallPath`）；读不到时 null */
  msiInstallPath: string | null;
}): { owner: EnvNodeOwner; evidence: string[] } {
  const target = normalizeForCompare(input.nodePath ?? '');
  if (!target) {
    return { owner: 'unknown', evidence: ['没找到 Node 的可执行文件，所以判不出这份 Node 归谁管'] };
  }
  const shown = String(input.nodePath ?? '').trim();

  // ① 版本管理器（nvm-windows）：模型的目录 / 变量给的目录 / 路径里那条独立的目录名
  const nvmEvidence: string[] = [];
  const model = input.model;
  if (model) {
    const dirs: [string, string][] = [
      ['版本管理器的版本目录', model.installsDir ?? ''],
      ['版本管理器的当前版本目录', model.activeDir ?? ''],
      ['版本管理器的程序根目录', model.root],
    ];
    for (const [label, dir] of dirs) {
      if (dir && isUnder(target, dir)) nvmEvidence.push(`${label} ${dir}`);
    }
  }
  for (const name of ['NVM_SYMLINK', 'NVM_HOME', 'NVM_DIR']) {
    const value = envValue(input.env, name);
    if (value && isUnder(target, value)) nvmEvidence.push(`环境变量 ${name}=${value}`);
  }
  const segments = target.split('\\').map((segment) => segment.replace(/^\./, ''));
  const nvmSegment = segments.find((segment) => NVM_DIR_NAMES.includes(segment));
  if (nvmSegment) {
    nvmEvidence.push(`路径里那条独立的 ${nvmSegment} 目录名：${shown}`);
  }
  if (nvmEvidence.length > 0) {
    return { owner: 'nvm', evidence: nvmEvidence.map((item) => `这份 Node 归版本管理器：${item}`) };
  }

  // ② 官方安装包的**正面证据**：官方默认安装位，或安装包自己写下的安装目录
  const systemEvidence: string[] = [];
  const programFiles = envValue(input.env, 'ProgramFiles');
  const programFilesX86 = envValue(input.env, 'ProgramFiles(x86)');
  const officialDirs = [
    programFiles ? path.win32.join(programFiles, 'nodejs') : 'C:\\Program Files\\nodejs',
    programFilesX86 ? path.win32.join(programFilesX86, 'nodejs') : '',
    input.msiInstallPath ?? '',
  ].filter((dir) => dir !== '');
  for (const dir of officialDirs) {
    if (isUnder(target, dir)) systemEvidence.push(dir);
  }
  if (systemEvidence.length > 0) {
    return {
      owner: 'system',
      evidence: systemEvidence.map((dir) => `这份 Node 在官方安装包的安装位：${dir}`),
    };
  }

  // ③ 其余全部 `unknown`：别的版本管理器也在这里（它们既不是 nvm，也不该按"系统装的那一份"去覆盖）
  const other = segments.find((segment) => OTHER_MANAGER_DIRS.includes(segment));
  if (other) {
    return {
      owner: 'unknown',
      evidence: [
        `这份 Node 归别的版本管理器（路径里有 ${other} 目录），不是 nvm，也不该当成系统装的那一份`,
      ],
    };
  }
  return { owner: 'unknown', evidence: [`认不出这份 Node 是谁装的：${shown}`] };
}

/**
 * 用户级 + 机器级 PATH 合成一段（去重、顺序稳定、保留调用方给的原文与键名）。
 *
 * 为什么是纯函数：读注册表是 IO（真机上才跑得到），而「两段怎么合」是判定 ——
 * 这段合并逻辑必须能在没有 Windows 的机器上被反例钉住（需求 §7.4）。
 * 分隔符固定 `;`：这两段 PATH 来自 Windows 注册表，这里的语义就是 Windows 的。
 */
export function mergePathFromRegistry(machine: string | null, user: string | null): string {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const segment of [machine, user]) {
    for (const raw of String(segment ?? '').split(';')) {
      const dir = raw.trim();
      if (!dir) continue;
      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      dirs.push(dir);
    }
  }
  return dirs.join(';');
}

/**
 * 下载源校验：只认 http(s)，去掉末尾斜杠；写错 / 留空返回 null（当没填，走官方直连）。
 * 与既有的「插件安装源」同款做法：**只影响我们这一次下载，不写用户任何配置文件**。
 */
export function normalizeNodeSource(value: string): string | null {
  const text = String(value ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!text) return null;
  if (!/^https?:\/\/[^\s/]+/i.test(text)) return null;
  return text;
}

/**
 * 「当前进程是不是提权跑的」的判定（喂一次只读探测的输出与退出码）。
 *
 * 用的探针是 `whoami /groups`：它的输出里有完整性级别的 SID，**与系统语言无关**
 * （本机实测非提权时那一行是 `Mandatory Label\Medium Mandatory Level Label S-1-16-8192`，
 * 退出码 0）。只认正向证据：读到 High（`S-1-16-12288`）/ System（`S-1-16-16384`）才算
 * 「提权」。读不出来（没跑成、输出不认识）按**否**处理，因为这条判定的用途是拦下
 * 「管理员身份装版本管理器」（冻结文档 R-23）；没有证据就不拦人，确认区仍然会写明
 * 「不要用管理员身份运行」这句话。
 */
export function isElevatedProbeOutput(stdout: string, status: number | null): boolean {
  if (status !== 0) return false;
  return /s-1-16-(?:12288|16384)\b/i.test(String(stdout ?? ''));
}

/** GitHub 发布资产的最小形状（只取我们要的字段 + 摘要） */
export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  /** GitHub 给的 `sha256:<值>`；老发布 / 老接口可能没有 */
  digest?: string | null;
}

/** 每个架构在资产名里可能出现的写法（`x64` 在 nvm 里叫 `amd64`） */
const ARCH_TOKENS: Record<string, string[]> = {
  x64: ['amd64', 'x64'],
  arm64: ['arm64', 'aarch64'],
  ia32: ['x86', 'ia32'],
};
const ALL_ARCH_TOKENS = ['amd64', 'x64', 'arm64', 'aarch64', 'x86', 'ia32'];
/** 资产名里的预发布标记（发布级的 `prerelease` 由调用方过滤，这里是第二道闸） */
const PRERELEASE_TOKENS = ['alpha', 'beta', 'rc', 'pre', 'preview', 'hotfix', 'nightly', 'dev'];

/**
 * 在发布资产里挑版本管理器的安装包：**按模式挑**，不写死文件名
 * （v1 是 `nvm-setup.exe`，v2 变成 `nvm-<版本>-<架构>-setup.exe`）。
 *
 * 规则（真机核对过 GitHub 上两种命名都在）：只认 `setup.exe`（这一条同时排掉
 * `nvm-setup.zip` / `nvm-noinstall.zip` / `nvm-update.exe` / `*-sync.exe`）；
 * 名字里有预发布标记的跳过；名字里带了架构标记就必须与本机架构一致;
 * **没有**架构标记的老式名字（v1）只对 x64 有效。挑不到返回 null。
 */
export function pickNvmSetupAsset(assets: ReleaseAsset[], arch: string): ReleaseAsset | null {
  if (!Array.isArray(assets)) return null;
  const wanted = ARCH_TOKENS[arch] ?? [String(arch ?? '').toLowerCase()];
  let best: { asset: ReleaseAsset; score: number; version: string } | null = null;
  for (const asset of assets) {
    if (!asset || typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string')
      continue;
    const name = asset.name.toLowerCase();
    if (!/^nvm-.*setup\.exe$/.test(name)) continue;
    const segments = name.split(/[-._]/);
    if (segments.some((segment) => PRERELEASE_TOKENS.includes(segment))) continue;
    const exact = wanted.some((token) => segments.includes(token));
    const otherArch = ALL_ARCH_TOKENS.some(
      (token) => !wanted.includes(token) && segments.includes(token),
    );
    if (otherArch) continue;
    // 老式名字（v1.1.x 的 nvm-setup.exe）没有架构标记，那是 x64 的构建
    if (!exact && arch !== 'x64') continue;
    const version = /nvm-(\d+(?:\.\d+)*)/.exec(name)?.[1] ?? '';
    const score = exact ? 0 : 1;
    if (
      !best ||
      score < best.score ||
      (score === best.score && compareNodeVersions(version, best.version) > 0)
    ) {
      best = { asset, score, version };
    }
  }
  return best ? best.asset : null;
}

/** 资产的 sha256（`sha256:<值>` → 值）；没有 / 认不出返回 null（界面要说"这次没能校验完整性"） */
export function assetSha256(asset: ReleaseAsset): string | null {
  const digest = typeof asset.digest === 'string' ? asset.digest.trim() : '';
  const match = /^sha256:([0-9a-f]{64})$/i.exec(digest);
  return match ? match[1].toLowerCase() : null;
}

/**
 * 发布说明里**自己声明**的签名状态（纯函数，离线可测）。
 *
 * nvm-windows 的发布说明正文里有机器可读的一行（实测 2026-09）：
 * - `Unsigned community build from \`cli/src/manifest.json\` version \`2.0.0\`.`（最新稳定 v2.0.0）
 * - `Authenticode-signed community build from \`…\``（v2.0.1-hotfix.2，prerelease）
 * - 1.2.x 那条线**没有这一行** → `unknown`
 *
 * 顺序要紧：`Unsigned …` 必须在 `Authenticode-signed …` 之前判 —— "Unsigned" 里也含 "signed"。
 */
export function parseReleaseSigning(body: string): 'signed' | 'unsigned' | 'unknown' {
  const text = String(body ?? '');
  if (/unsigned community build/i.test(text)) return 'unsigned';
  if (/authenticode-signed community build/i.test(text)) return 'signed';
  return 'unknown';
}

/**
 * 展开 `%NAME%` 这类环境变量引用（键名大小写不敏感）；查不到的引用**原样留着**
 * —— 一个用户自己写的目录不该被我们悄悄删掉。
 *
 * 为什么需要它：Windows 的 PATH 里常见 `%NVM_HOME%;%NVM_SYMLINK%`（本机实测就是），
 * 不展开的话合并出来的那一段里没有任何真实目录，nvm 装完照样找不到 Node。
 */
export function expandEnvReferences(value: string, vars: Record<string, string>): string {
  const lookup = new Map<string, string>();
  for (const [key, text] of Object.entries(vars)) {
    if (typeof text === 'string') lookup.set(key.toLowerCase(), text);
  }
  const replacer = (whole: string, name: string): string => lookup.get(name.toLowerCase()) ?? whole;
  return String(value ?? '').replace(/%([^%]+)%/g, replacer);
}

// ---------------------------------------------------------------- 失败分类（冻结清单之外的实现手段）

/** 安装 / 更新失败的结构化类别（界面据此说人话，不解析 stderr） */
export type InstallFailureKind =
  | 'network'
  | 'permission'
  | 'checksum'
  | 'unsigned'
  | 'busy'
  | 'disk'
  | 'unsupported'
  | 'cancelled'
  | 'timeout'
  /** 版本管理器那条路：装完了但没有 active 的 Node（VM 实测：npm shim 存在却跑不起来） */
  | 'nvm-inactive'
  /** `nvm use` 建符号链接没权限（Windows 普通权限 + 开发者模式没开） */
  | 'symlink'
  /** 要建链接的位置已经有一个同名文件夹 */
  | 'target-exists'
  /**
   * 提权那一次**等太久**（F-02）：这不是"没有权限"，是"我们不等了、那次提权可能还在进行"。
   * 结论只在事实复检之后才给（见 `settleElevationTimeout`）。
   */
  | 'elevation-timeout'
  /** 用户在 UAC 对话框上没允许（明确的"没同意"） */
  | 'elevation-declined'
  /** 提权那条路本身没跑通（PowerShell 报错 / 退出码读不出来） */
  | 'elevation-failed'
  | 'unknown';

/** 一条失败：类别 + 一句给用户看的人话 + 给事件日志的出路 */
export interface InstallFailureReason {
  kind: InstallFailureKind;
  message: string;
  hint: string | null;
}

/** 安装器 / 系统给的退出码 → 类别（Windows Installer 那几个编号是稳定契约） */
const EXIT_CODE_KINDS: Record<number, InstallFailureKind> = {
  // Windows Installer
  112: 'disk', // 磁盘空间不足
  1602: 'cancelled', // 用户取消了安装（也可能是关掉了提权询问 —— 分不清时只说第 2 条）
  1223: 'permission', // 用户在提权询问上点了"否"
  1925: 'permission', // 没有足够的权限做整机安装
  1730: 'permission', // 没有足够的权限
  1303: 'permission', // 目录写不进去
  1304: 'permission',
  1625: 'permission', // 被系统策略拦下
  1314: 'permission',
  1618: 'busy', // 系统里已经有一个安装在进行
  1622: 'unknown', // 写日志失败
  1601: 'unknown', // 安装服务不可用
  1603: 'unknown', // 致命错误（细节在安装日志尾部）
  1619: 'unknown', // 安装包打不开（多半是下载不完整）
  1620: 'unknown',
};
const EXIT_CODE_MESSAGES: Partial<Record<InstallFailureKind, string>> = {
  permission: '你拒绝了管理员权限，这台电脑上什么都没改。',
  cancelled: '安装没有完成，这台电脑上什么都没改。',
  busy: '系统里已经有一个安装正在进行，这一次没能开始。',
  disk: '这台电脑的可用空间不够，安装没有开始。',
};

const FAILURE_HINTS: Record<InstallFailureKind, string> = {
  network:
    '① 用浏览器打开官方下载页自己装 ② 换一个下载源 ③ 装好后点「重新检测」。下载页：' +
    NODE_DOWNLOAD_PAGE,
  permission: '可以改用不用管理员权限的方式安装（版本管理器），或者点「重新检测」看当前情况。',
  checksum: '可以换一个下载源再试，或者用浏览器打开下载页自己装。',
  unsigned: '可以用浏览器打开官方下载页自己装，或者换一个下载源再试。',
  busy: '等那个安装结束后点「重新检测」，或者关掉它再试一次。',
  disk: '清出一些空间再试一次；也可以在系统设置里卸掉不再需要的东西。',
  unsupported: '可以换一个版本档，或者用浏览器打开下载页自己装。',
  cancelled: '可以重新试一次，或者自己到官方下载页装。',
  timeout: '安装可能还在后台继续；按它自己的提示做完，再点「重新检测」。',
  'nvm-inactive':
    '重开一次应用再重试这一步就行 —— 我们会自己挑一个稳定版装好并切过去；如果还是不行，日志里有每一步的命令、退出码与原文，可以拿它来排查。',
  symlink:
    '两条路：① 在「设置 → 系统 → 开发者选项」里打开「开发者模式」，再重试这一步；② 或者重开应用时用管理员身份运行一次，让这一步能建链接。',
  'target-exists':
    '把那个同名文件夹改名或删掉再重试；如果它是之前安装的 Node，删掉之后版本管理器就能接管这个位置。',
  'elevation-timeout':
    '可以等一会儿再点「重新检测」（提权之后的那一步可能还在进行）；也可以先在 Windows 的「设置 → 系统 → 开发者选项」里打开「开发者模式」，再重试这一步。',
  'elevation-declined':
    '想要建这个链接，可以打开 Windows 的「开发者模式」后重试（那样就不需要管理员权限），或者在重开应用时用管理员身份运行一次。',
  'elevation-failed':
    '可以打开 Windows 的「开发者模式」后重试（那样就不需要管理员权限），或者在重开应用时用管理员身份运行一次。',
  unknown:
    '如果系统里留下了装了一半的东西，可以到「应用」里把它卸载掉再重试；也可以自己到官方下载页装。',
};

const FAILURE_MESSAGES: Record<InstallFailureKind, string> = {
  network: '下载没成功（连接超时或连不上）。',
  permission: '你拒绝了管理员权限，这台电脑上什么都没改。',
  checksum: '完整性校验没通过，已删除，没有安装任何东西。',
  unsigned: '这个安装包没有数字签名，我们没有安装它。',
  busy: '系统里已经有一个安装正在进行，这一次没能开始。',
  disk: '这台电脑的可用空间不够，安装没有开始。',
  unsupported: '这条安装路径现在不能走。',
  cancelled: '安装没有完成，这台电脑上什么都没改。',
  timeout: '这一步超过时限没结束，我们已经停止等待。',
  'nvm-inactive': '版本管理器装好了，但还没有任何一个 Node 版本被它启用，所以这一步没有完成。',
  symlink: '这一步要在系统里创建一个链接，但没有权限，所以没有完成。',
  'target-exists': '要创建链接的位置已经有一个同名的文件夹，所以没有完成。',
  'elevation-timeout':
    '权限询问等太久，我们已经停止等待；这次提权操作可能仍在系统里进行，我们会用事实复检之后再下结论。',
  'elevation-declined': '创建链接需要一次管理员权限，这一次没有允许，所以这一步没有完成。',
  'elevation-failed': '没能通过一次管理员权限完成这一步。',
  unknown: '安装没有成功，这台电脑上什么都没改。',
};

/** 提权那段：UAC 对话框等太久时的状态句（是"未确定"，不是"失败"） */
const ELEVATION_TIMEOUT_MESSAGE =
  '权限询问等太久，我们已经停止等待，但这次提权操作可能仍在系统里进行。';
/** 提权那段：请求权限时先推给界面的状态（必须在 UAC 对话框出现之前就渲染出来） */
const ELEVATION_WAITING_MESSAGE = '正在请求一次管理员权限、请在弹出的窗口里选择。';

/** 「读到它明确未签名 / 签名无效」那一条：结论在下载之后才有，所以别处不出现 */
function unsignedFailure(message: string): InstallFailureReason {
  return { kind: 'unsigned', message, hint: FAILURE_HINTS.unsigned };
}

/**
 * 把安装过程的原文与退出码归纳成结构化的一条失败；**认不出来也只是 `unknown`，不编因果**。
 *
 * 纯函数（不碰磁盘 / 不起子进程 / 不看时钟），夹具可以直接喂
 * `'Access is denied.'` / `1602` 这些真机见过的原文。
 */
export function classifyInstallFailure(text: string, code: number | null): InstallFailureReason {
  const tail = String(text ?? '').slice(-OUTPUT_TAIL_CHARS);
  const make = (kind: InstallFailureKind, message?: string): InstallFailureReason => ({
    kind,
    message: message ?? FAILURE_MESSAGES[kind],
    hint: FAILURE_HINTS[kind],
  });

  // 1. 我们自己的判定（校验与下载器写得出的稳定句子）优先
  if (/完整性校验没通过|校验值不一致|签名与安装包内容不一致/.test(tail)) return make('checksum');
  if (/没有数字签名|未签名/.test(tail)) return make('unsigned');
  // 2. 退出码（Windows Installer 的编号是稳定契约，比文本可靠）
  if (code !== null) {
    const mapped = EXIT_CODE_KINDS[code];
    if (mapped) {
      const message = EXIT_CODE_MESSAGES[mapped];
      if (message) return make(mapped, message);
      // 编号认识、但具体原因认不出：把人话补上编号（原文与安装日志在输出区）
      return make(mapped, `安装没有成功（退出码 ${code}），这台电脑上什么都没改。`);
    }
  }
  // 3. 原文。**版本管理器那条路的原文优先**：它们说的都是"哪一步没成"，
  //    比笼统的权限 / 未知准得多（VM 实测的三句都在下面）
  //    - `No active Node.js version is configured. Run \`nvm install <version>\` then \`nvm use <version>\`.`
  //    - `You do not have sufficient privileges to complete this operation. Please run this command as administrator.`
  //    - `Cannot create a file when that file already exists.`
  if (/No active Node\.js version is configured|no active version/i.test(tail)) {
    return make('nvm-inactive');
  }
  if (/already exists|已存在|目标文件夹/i.test(tail)) return make('target-exists');
  if (
    /sufficient privileges|symbolic link|symlink|SeCreateSymbolicLinkPrivilege|developer mode|开发者模式/i.test(
      tail,
    )
  ) {
    return make('symlink');
  }
  if (
    /EACCES|EPERM|access is denied|access denied|拒绝访问|权限不足|permission denied/i.test(tail)
  ) {
    return make('permission');
  }
  if (
    /ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETWORK|ENOTSUP|socket hang up|网络|连接超时|连接不上|HTTP [45]\d\d/i.test(
      tail,
    )
  ) {
    return make('network');
  }
  if (/ENOSPC|no space left|disk full|空间不足|磁盘已满/i.test(tail)) return make('disk');
  if (/another installation|EBUSY|正在进行的安装/i.test(tail)) return make('busy');
  // 4. 退出码给不出结论时，把人话补上编号，界面照实显示
  if (code !== null && code !== 0) {
    return make('unknown', `安装没有成功（退出码 ${code}），这台电脑上什么都没改。`);
  }
  return make('unknown');
}

// ---------------------------------------------------------------- 安装器形态与 nvm 输出（纯函数）

/** 安装包是谁做出来的：决定"静默安装"的参数长什么样（两家用的字母完全不同） */
export type InstallerFlavor = 'inno' | 'nsis' | 'unknown';

/**
 * 从安装包的字节里认出它是 Inno Setup 还是 NSIS（纯函数，夹具喂几个字节就能测）。
 *
 * 为什么要认：静默参数是**两家各自的**约定 —— Inno 是 `/VERYSILENT`（NSIS 的 `/S` 它不认），
 * NSIS 是 `/S`。写死一个就会在另一家上什么也不发生（最糟的是"看起来成功、其实弹了向导"）。
 * 标记都是各自 overlay 里的固定字符串：NSIS 是 `NullsoftInst`（"Nullsoft Install System"），
 * Inno 是 `Inno Setup Setup Data`。都找不到就老实说 `unknown`（那时按可见向导走并提示用户）。
 */
export function detectInstallerFlavor(bytes: Buffer | null | undefined): InstallerFlavor {
  if (!bytes || bytes.length === 0) return 'unknown';
  // NSIS 放在前面判：它的标记更独特；而 Inno 的安装包里不会同时出现 Nullsoft 的 overlay
  if (bytes.includes(Buffer.from('NullsoftInst'))) return 'nsis';
  if (bytes.includes(Buffer.from('Inno Setup'))) return 'inno';
  return 'unknown';
}

/**
 * 静默安装参数（纯函数）。认不出来时返回**空数组** —— 那就走它自己的可见向导，
 * 并且必须把"需要你在窗口里点一下"告诉用户（VM-02 的教训：不许让界面说"只管等"）。
 */
export function installerSilentArgs(flavor: InstallerFlavor): string[] {
  if (flavor === 'nsis') return ['/S'];
  if (flavor === 'inno') return ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'];
  return [];
}

/** `nvm list` 的解析结果：装了哪些版本、当前 active 的是哪个 */
export interface NvmListOutput {
  versions: string[];
  active: string | null;
}

/**
 * 解析 `nvm list`。
 *
 * **两种真实形状都要认**（VM-11 的客机是 v2）：
 * - v2（`docs.nvm-windows.com/command/list`）：**一行里空格分开的一串**
 *   `* 24.1.0    (default)  22.14.0  20.19.1` —— 星号标的是 active/当前默认；
 * - v1（阶段一实测）：每行一个，`* 22.12.0 (Currently using 64-bit executable)`；
 * - 一个版本都没有：v2 说 `No versions installed.`、v1 说 `No installations recognized.`
 *   —— 两种都没有版本号 token，自然得到空清单。
 *
 * 所以这里按 **token 扫**（不按"每行开头一个版本"扫），否则 v2 那一行里只会认出第一个，
 * 后面那些装好的版本会被当成没装（"装完了却看不见"就是这么来的）。
 * **认不出来时给空清单 + null**，不猜。
 */
export function parseNvmListOutput(text: string): NvmListOutput {
  const versions: string[] = [];
  let active: string | null = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    let starred = false;
    for (const token of tokens) {
      if (token === '*') {
        starred = true;
        continue;
      }
      const bare = token.startsWith('*') ? token.slice(1) : token;
      const version = /^v?(\d+\.\d+\.\d+)$/.exec(bare);
      if (!version) {
        // v2 把当前默认标成 `(default)`：认它（兜住"星号与版本不在一行"的排版差异）
        if (token === '(default)' && versions.length > 0 && active === null) {
          active = versions[versions.length - 1];
        }
        continue;
      }
      if (!versions.includes(version[1])) versions.push(version[1]);
      if (starred || token.startsWith('*')) active = version[1];
      starred = false;
    }
  }
  return { versions, active };
}

// ---------------------------------------------------------------- nvm v2 的模型（纯函数，VM-11 / VM-12）

/** `nvm env` 的结论（v2 的机器可读来源之一；认不出来就都是 null / unknown，不猜） */
export interface NvmEnvReport {
  version: string | null;
  /** on / off（版本管理开关） */
  status: string | null;
  /** shim（v2 推荐，无符号链接）/ link（v1 风格，junction/symlink） */
  mode: 'shim' | 'link' | 'unknown';
  /** 版本装在哪（v2：`<root>\installs`） */
  installsDir: string | null;
  /** 装了几个版本（`Total: 0 (0 MB)` → 0） */
  versionsTotal: number | null;
  /** 当前默认版本（`Default: not set` → null） */
  defaultVersion: string | null;
  /** 程序根目录（`Installation → Path`，就是 nvm.exe 所在目录） */
  programRoot: string | null;
  nodeMirror: string | null;
  npmMirror: string | null;
}

/** 去掉 nvm env 里的树线（`├─` / `└─` / `│`）与多余空白 */
function stripTreeGlyphs(line: string): string {
  return line
    .replace(/[│├└─]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析 `nvm env`（纯函数）。
 *
 * 认**两种真实排版**（`docs.nvm-windows.com/command/env` 的样例 + VM-11 客机那份带分节的报告）：
 * - 扁平：`├─ Version : v2.0.0` / `├─ Status : on` / `├─ Operating Mode : shim` / `└─ Installed Versions : 4`；
 * - 分节：`Version Management` 段里给 `Status` / `Operating Mode`，
 *   `Installed Versions` 段里给 `Total: 0 (0 MB)` / `Default: not set` / `Path: <root>\installs`，
 *   `Download Sources` 段里给 `Node.js: …` / `npm: …`。
 *
 * 分节信息必须留着：**两个 `Path` 含义不同**（`Installation → Path` 是程序根、
 * `Installed Versions → Path` 是版本目录），只看键名会把它们混成一个。
 */
export function parseNvmEnvOutput(text: string): NvmEnvReport {
  const report: NvmEnvReport = {
    version: null,
    status: null,
    mode: 'unknown',
    installsDir: null,
    versionsTotal: null,
    defaultVersion: null,
    programRoot: null,
    nodeMirror: null,
    npmMirror: null,
  };
  let section = '';
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = stripTreeGlyphs(rawLine);
    if (!line) continue;
    const at = line.indexOf(':');
    if (at < 0) {
      // 没有冒号 = 分节标题（Computer / Installation / Version Management / …）
      section = line.toLowerCase();
      continue;
    }
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    // 「等于号」那种写法也认（客机报告里有 `Status = on` 这种）
    const eq = value.indexOf('=');
    const normalized = eq >= 0 ? value.slice(eq + 1).trim() : value;
    const inVersions = /version|install/.test(section);
    const inInstallation = /installation/.test(section);
    const inSources = /source|mirror|download/.test(section);

    if (key === 'version' || key === 'nvm version') {
      report.version = report.version ?? normalized;
    } else if (key === 'status') {
      report.status = report.status ?? normalized;
    } else if (key === 'operating mode' || key === 'mode') {
      const mode = normalized.toLowerCase();
      if (/shim/.test(mode)) report.mode = 'shim';
      else if (/link|symlink/.test(mode)) report.mode = 'link';
    } else if (key === 'installed versions') {
      const count = Number.parseInt(normalized, 10);
      if (Number.isFinite(count)) report.versionsTotal = count;
    } else if (key === 'total') {
      const count = Number.parseInt(normalized, 10);
      if (Number.isFinite(count)) report.versionsTotal = count;
    } else if (key === 'default' || key === 'active version') {
      report.defaultVersion = /not set|none|\(none\)/i.test(normalized) ? null : normalized || null;
    } else if (key === 'path' || key === 'install path' || key === 'installed versions path') {
      if (inVersions && !inInstallation) report.installsDir = report.installsDir ?? normalized;
      else if (inInstallation || !report.programRoot)
        report.programRoot = report.programRoot ?? normalized;
    } else if (key === 'node.js' || key === 'node') {
      if (inSources || report.nodeMirror === null)
        report.nodeMirror = report.nodeMirror ?? normalized;
    } else if (key === 'npm') {
      if (inSources || report.npmMirror === null) report.npmMirror = report.npmMirror ?? normalized;
    }
  }
  return report;
}

/** `nvm install` 的成功标记（v2 原文：`Installed Node.js v24.1.0`）；认不出来返回 null */
export function parseNvmInstallOutput(text: string): string | null {
  return /Installed Node\.js\s+v?(\d+\.\d+\.\d+)/i.exec(String(text ?? ''))?.[1] ?? null;
}

/** `nvm use` 的成功标记（v2 原文：`Now using Node.js v24.1.0 by default.`）；认不出来返回 null */
export function parseNvmUseOutput(text: string): string | null {
  return /Now using Node\.js\s+v?(\d+\.\d+\.\d+)/i.exec(String(text ?? ''))?.[1] ?? null;
}

/**
 * 这一句是**版本管理器的 shim 在说"没有激活任何版本"**（VM-11 客机的逐字原文）：
 * `No active Node.js version is configured. Run \`nvm install <version>\` then \`nvm use <version>\`.`
 *
 * 这是本任务的核心信号：`node.exe` 在、但它跑不起来 —— 于是**应用要自己去装一个版本**，
 * 而不是把这句话转给用户。
 */
export function isInactiveNodeShimOutput(text: string): boolean {
  return /No active Node\.js version is configured/i.test(String(text ?? ''));
}

/**
 * 这台机器上版本管理器的**模型**（根目录 / 版本目录 / 当前版本从哪儿来 / 什么模式）。
 *
 * 全部来自**真实证据**：`nvm.exe` 的真实路径、`nvm env` 的报告、注册表里的偏好、
 * 以及用户级 PATH 里那几个真实条目。**不依赖 `NVM_HOME` / `NVM_SYMLINK`**
 * —— v2 不设这两个变量（VM-11 客机实测 `HKCU\Environment` 只有 `Path`/`TEMP`/`TMP`/`OneDrive`）；
 * 它们只作为 v1 风格机器的**兜底**候选（真有就按真的来，不写死排斥）。
 */
export interface NvmModel {
  exe: string;
  root: string;
  mode: 'shim' | 'link' | 'unknown';
  /** 版本装在哪（v2 = 注册表/nvm env 给的 InstallRoot；v1 = 根目录下的版本目录） */
  installsDir: string | null;
  /** 当前 Node 从哪个目录暴露出来（v2 = `<root>\.nodejs`；v1 = NVM_SYMLINK / `<root>\nodejs`） */
  activeDir: string | null;
  /** 每一条结论的来源（写日志用，评审时能对账） */
  evidence: string[];
}

/** 这条 PATH 目录看起来是版本管理器的程序根吗（`<...>\nvm`；v2 的 PATH 里就有它） */
export function looksLikeNvmRoot(dir: string): boolean {
  const base = path.win32.basename(String(dir ?? '').replace(/[\\/]+$/, '')).toLowerCase();
  return base === 'nvm' || base === '.nvm' || base === 'nvm-windows';
}

/**
 * 从真实证据推出模型（纯函数，`exists` 可注入 → 沙箱里就能用客机的夹具跑）。
 *
 * 证据优先级（高到低）：
 * 1. `nvm.exe` 的真实路径（从 PATH 找到的**真文件**）→ 根目录 = 它的目录；
 * 2. `nvm env` / 注册表给的程序根；
 * 3. 用户级 PATH 里那条 `…\nvm`（v2 装完就是这么写的）；
 * 4. `NVM_HOME`（**只**作为 v1 风格机器的兜底）。
 *
 * 版本目录与"当前版本从哪儿来"同理：先信 `nvm env`/注册表的 `InstallRoot`，
 * 再看 PATH 里真实存在的 `.nodejs`，最后才用 v1 的 `NVM_SYMLINK` / `<root>\nodejs`。
 */
export function deriveNvmModel(input: {
  exe: string | null;
  env: NodeJS.ProcessEnv;
  report: NvmEnvReport | null;
  /** 用户级 PATH 的条目（已展开 `%VAR%`；真实值，不是我们拼的） */
  pathDirs: string[];
  /** 存在性判定（注入以便离线测；默认 `fs.existsSync`） */
  exists?: (file: string) => boolean;
}): NvmModel | null {
  const exists = input.exists ?? ((file: string): boolean => fs.existsSync(file));
  const evidence: string[] = [];
  const envValue = (name: string): string => {
    const key = Object.keys(input.env).find((item) => item.toLowerCase() === name.toLowerCase());
    const value = key ? input.env[key] : undefined;
    return typeof value === 'string' ? value.trim() : '';
  };

  const pathRoots = input.pathDirs.filter((dir) => looksLikeNvmRoot(dir));
  const exeCandidate =
    input.exe ?? (envValue('NVM_HOME') ? path.win32.join(envValue('NVM_HOME'), 'nvm.exe') : null);
  let root = '';
  if (exeCandidate) {
    root = path.win32.dirname(exeCandidate);
    evidence.push(`nvm 命令：${exeCandidate}`);
  } else if (input.report?.programRoot) {
    root = input.report.programRoot;
    evidence.push(`nvm env 的程序根：${root}`);
  } else if (pathRoots.length > 0) {
    root = pathRoots[0];
    evidence.push(`用户 PATH 里的版本管理器目录：${root}`);
  }
  if (!root) return null;
  if (!exeCandidate) evidence.push(`（没有直接找到 nvm.exe，按证据推出根目录 ${root}）`);

  const mode: NvmModel['mode'] =
    input.report && input.report.mode !== 'unknown'
      ? input.report.mode
      : // 没有 nvm env 时看磁盘：v2 的 `.nodejs` 在就是 shim，v1 的软链在就是 link
        exists(path.win32.join(root, '.nodejs', 'node.exe')) ||
          exists(path.win32.join(root, '.nodejs'))
        ? 'shim'
        : envValue('NVM_SYMLINK')
          ? 'link'
          : 'unknown';
  evidence.push(
    `模式：${mode}${input.report?.mode ? '（nvm env 说的）' : '（按磁盘上的 .nodejs / NVM_SYMLINK 推的）'}`,
  );

  const installsDir =
    input.report?.installsDir ??
    (exists(path.win32.join(root, 'installs')) ? path.win32.join(root, 'installs') : null);
  if (installsDir) evidence.push(`版本目录：${installsDir}`);

  // 当前 Node 从哪儿来：PATH 里真实存在的 `.nodejs` 优先（那是用户机器上真在用的），
  // 再看 nvm v1 的软链，最后才是根目录下的 nodejs 目录。
  const activeFromPath = input.pathDirs.find(
    (dir) =>
      path.win32.basename(dir.replace(/[\\/]+$/, '')).toLowerCase() === '.nodejs' &&
      exists(path.win32.join(dir, 'node.exe')),
  );
  const symlink = envValue('NVM_SYMLINK');
  const candidates = [
    activeFromPath ?? '',
    path.win32.join(root, '.nodejs'),
    symlink,
    path.win32.join(root, 'nodejs'),
  ].filter((dir) => dir !== '');
  const activeDir =
    candidates.find((dir) => exists(path.win32.join(dir, 'node.exe'))) ?? candidates[0] ?? null;
  if (activeDir) {
    evidence.push(
      `当前 Node 的目录：${activeDir}${exists(path.win32.join(activeDir, 'node.exe')) ? '（node.exe 在）' : '（node.exe 不在，是推断的落点）'}`,
    );
  }
  return {
    exe: exeCandidate ?? path.win32.join(root, 'nvm.exe'),
    root,
    mode,
    installsDir,
    activeDir,
    evidence,
  };
}

/**
 * 版本管理器自己的命令在哪：查找路径 → `NVM_HOME` → 安装程序的默认目录（`%APPDATA%\nvm`）
 * → v1 软链旁边。**只读文件系统**（`exists` 与 `onPath` 可注入，所以离线也能测）。
 */
export function locateNvmExe(input: {
  env: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
  /** 查找路径解析（默认 `whichSync`，它按 `PATHEXT` 展开）；注入以便离线测 */
  onPath?: (name: string) => string | null;
}): string | null {
  const exists = input.exists ?? ((file: string): boolean => fs.existsSync(file));
  const onPath = input.onPath ?? ((name: string): string | null => whichSync(name));
  const fromPath = onPath('nvm');
  if (fromPath && exists(fromPath)) return fromPath;
  const home = envValue(input.env, 'NVM_HOME');
  if (home) {
    const candidate = path.win32.join(home, 'nvm.exe');
    if (exists(candidate)) return candidate;
  }
  const appData = envValue(input.env, 'APPDATA');
  if (appData) {
    const candidate = path.win32.join(appData, 'nvm', 'nvm.exe');
    if (exists(candidate)) return candidate;
  }
  const symlink = envValue(input.env, 'NVM_SYMLINK');
  if (symlink) {
    const candidate = path.win32.join(path.win32.dirname(symlink), 'nvm', 'nvm.exe');
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * 只靠"环境 + 磁盘上有什么"推出的版本管理器模型（**不起子进程**）。
 *
 * 为什么单独导出：需求 §7.7 第 1 条要求归属判据**只有一份**、采集侧与安装计划共用，
 * 而采集侧（完整探测与启动瞬间的快速探测）**不能**跑去问 `nvm env`（那是子进程）。
 * `nvm env` / 注册表偏好只是加分证据，判据里没有一条依赖它们。
 */
export function deriveNvmModelFromEnvironment(
  env: NodeJS.ProcessEnv,
  exists?: (file: string) => boolean,
): NvmModel | null {
  const pathDirs = String(envValue(env, 'Path'))
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean);
  const exe = locateNvmExe({ env, exists });
  return deriveNvmModel({ exe, env, report: null, pathDirs, exists });
}

/**
 * 计划里那条「事实 → 方法 / 档位」的判定（**纯函数**：只读入参、没有 IO、不抛）。
 *
 * 需求 §7.8 的方法表与 §8.5 的档位规则都落在这一处，`buildPlan()` 只负责把网络与磁盘事实凑齐：
 *   - **方法跟随归属**：`nvm` → `'nvm'`、`system` → `'direct'`；归属**未知**时默认值不能替用户做决定
 *     （找到了一份 Node → 不预选 + `needChoice: 'choose-method'`；一份都没找到 → 有版本管理器用它、否则官方直装）；
 *   - **档位跟随当前**：`update` 省略档位 = 跟随当前档位，`install` 省略档位 = 设计默认（最新稳定版）；
 *     **跨档只可能由"目标档 ≠ 当前档"产生**（显式换档，或 `install` 的设计默认正好跨档）；
 *   - `direction === 'older'` ⟹ `switchesChannel === true`（**按构造**：目标更低本身就是一次换档动作）；
 *   - `needChoice !== null` ⟹ 一定有 `refuse`（界面这次不给「开始」）。
 */
export interface NodePlanDecision {
  method: EnvNodeMethod;
  channel: EnvNodeChannel;
  /** 跟档挑出来的那一条（目标版本）；`needChoice === 'choose-channel'` 时为 null（还没有目标） */
  release: NodeReleaseEntry | null;
  currentVersion: string | null;
  currentChannel: EnvNodeChannel | null;
  switchesChannel: boolean;
  direction: 'newer' | 'same' | 'older' | null;
  needChoice: 'choose-method' | 'choose-channel' | null;
  installsManager: boolean;
  /** 非 null = 这次不给「开始」（`needChoice !== null` 时一定有它） */
  refuse: InstallFailureReason | null;
  /** 用户显式点名了与归属不一致的那条路（§7.8 的三个例外）时，确认区必须带上的并存风险句（§7.9 第 4 条） */
  coexistWarning: string | null;
}

/** §7.9 第 4 条原样那一句：三个例外的确认区都用它（不许改写） */
export const NODE_COEXIST_WARNING =
  '这样这台电脑上会有两份 Node：一份是原来的（不会被删掉），一份是这次装的。之后 `node` 用哪一份，看系统查找路径里谁在前。';

/** 已装版本在官方清单里那一条的档（`lts === false` → `current`，否则 `lts`）；清单里没有它 → null（不许猜） */
export function nodeChannelOfVersion(
  list: NodeReleaseEntry[],
  version: string,
): EnvNodeChannel | null {
  const found = list.find((entry) => compareNodeVersions(entry.version, version) === 0);
  if (!found) return null;
  return found.lts === false ? 'current' : 'lts';
}

/** 目标版本相对当前的方向；当前版本取不到时 null（`compareNodeVersions` 的结论） */
export function nodePlanDirection(
  target: string,
  current: string | null,
): 'newer' | 'same' | 'older' | null {
  if (!current) return null;
  const diff = compareNodeVersions(target, current);
  return diff > 0 ? 'newer' : diff < 0 ? 'older' : 'same';
}

export function decideNodePlan(input: {
  mode: EnvNodeMode;
  /** 请求里显式点名的方法；省略 = 跟随归属 */
  requestMethod?: EnvNodeMethod;
  /** 请求里显式点名的档位；省略 = 跟随（`install` → 最新稳定版、`update` → 当前档位） */
  requestChannel?: EnvNodeChannel;
  owner: EnvNodeOwner;
  /** 这台机器上有没有一个可辨认的版本管理器（`deriveNvmModel` 推出了根） */
  nvmPresent: boolean;
  /** 有没有找到一份 Node（路径）—— 与 `owner === 'unknown'` 合起来决定"要不要问用户" */
  nodeFound: boolean;
  /** 找到的那份 Node 的版本号（`vX.Y.Z`）；取不到 null */
  currentVersion: string | null;
  /** 官方版本清单（判当前档位与挑目标版本都用它；空数组 = 清单里什么都没有） */
  releases: NodeReleaseEntry[];
  /** 当前进程是不是提权态（R-23：nvm 那条路在提权态下不可用，替代出路是官方直装） */
  elevated: boolean;
}): NodePlanDecision {
  const currentChannel = input.currentVersion
    ? nodeChannelOfVersion(input.releases, input.currentVersion)
    : null;
  /** 事实能定的方法：`nvm` / `system`；归属未知时**没有**事实方法 */
  const factMethod: EnvNodeMethod | null =
    input.owner === 'nvm' ? 'nvm' : input.owner === 'system' ? 'direct' : null;

  let needChoice: NodePlanDecision['needChoice'] = null;
  let refuse: InstallFailureReason | null = null;
  let coexist = false;
  let method: EnvNodeMethod;

  if (input.requestMethod === undefined) {
    if (factMethod !== null) {
      // 归属已知：方法由事实定，不由默认值定
      method = factMethod;
    } else if (input.nodeFound) {
      // 归属判不出来 + 找到了一份 Node：**一条都不预选**（VM-14 的核心裁定）
      needChoice = 'choose-method';
      // 契约要求计划带一个方法（`EnvNodePlan.method` 是必填）。这里给**最不可能造出第二份 Node** 的那条：
      // 有可辨认的版本管理器就用它（它只管自己那份），没有才落到直装。
      // 这个值**不是预选** —— `needChoice === 'choose-method'` 时界面必须两条路都列、一条都不选中。
      method = input.nvmPresent ? 'nvm' : 'direct';
      refuse =
        input.mode === 'update'
          ? {
              kind: 'unsupported',
              message: '我们认不出这个 Node 是怎么装的，所以不会替它做自动更新。',
              hint: '可以用「打开官方下载页」自己装，或者点「重新检测」再确认一次。',
            }
          : {
              kind: 'unsupported',
              message: '我们认不出这台电脑上这份 Node 是怎么装的，所以不替你选路。',
              hint: '请显式选一条：用版本管理器安装，或直接安装官方版本（两条路都会在这台电脑上放两份 Node）。',
            };
    } else {
      // 一份 Node 都没找到：给一条**有事实支撑**的默认（有默认 ≠ 默默 —— 事实行必须把方法说出来）
      method = input.nvmPresent ? 'nvm' : 'direct';
    }
  } else {
    method = input.requestMethod;
    if (factMethod !== null && method !== factMethod) {
      // 归属已知时另一条路只有两个例外（§7.8），且都必须用户**显式点名**：
      //   ① 归属 = system，用户拒绝了管理员权限 → 改走版本管理器；
      //   ② 归属 = nvm，但当前进程是提权态（R-23）→ nvm 那条路走不了 → 改走官方直装。
      const allowed =
        (input.owner === 'system' && method === 'nvm') ||
        (input.owner === 'nvm' && method === 'direct' && input.elevated);
      if (allowed) {
        coexist = true;
      } else {
        refuse = {
          kind: 'unsupported',
          message:
            input.owner === 'nvm'
              ? '这台电脑上的 Node 是版本管理器管的，所以这次不能再用官方安装包装一份。'
              : '这台电脑上的 Node 是官方安装包装的，所以这次不能用版本管理器再装一份。',
          hint:
            input.owner === 'nvm'
              ? '点「重新检测」再确认一次；确实想要两份并存时，用官方下载页自己装。'
              : '点「重新检测」再确认一次，或者用官方安装包更新它。',
        };
      }
    } else if (factMethod === null) {
      // 归属未知 + 用户显式点名 = §7.8 的例外 1：允许走，但确认区要带上那句并存风险
      coexist = true;
    }
  }

  // ---- 档位：跟随（默认）还是显式换档 ----
  let channel: EnvNodeChannel;
  if (input.requestChannel !== undefined) {
    channel = input.requestChannel;
  } else if (input.mode === 'update') {
    if (currentChannel !== null) {
      channel = currentChannel;
    } else {
      // 判不出当前档位 → 不替用户选（需求 §8.5 第 3 条）。
      // `channel` 在这里只是**占位**（设计默认档）；`needChoice === 'choose-channel'` 时界面必须
      // 让用户显式选一档，**不许**把这个占位显示成目标档位，也不许据此算目标版本。
      //
      // 已经因为别的原因被拒（例如归属已知、用户却点名了另一条路）时**不再**改 `needChoice`：
      // 界面一次只该被问一件事，那个字段回答的是"为什么现在给不出开始"。
      if (refuse === null) {
        needChoice = 'choose-channel';
        refuse = {
          kind: 'unsupported',
          message: '我们判不出这份 Node 属于哪一档，所以这次不能自动更新。',
          hint: '请显式选一档（当前版 / 稳定版）；选完这一次就是一次显式的换档。',
        };
      }
      channel = 'lts';
    }
  } else {
    // 第一次装 / 给这台机器装一个能用的：设计默认 = 最新稳定版（§7.2）
    channel = 'lts';
  }

  const release = needChoice === 'choose-channel' ? null : pickNodeRelease(input.releases, channel);
  const direction = release ? nodePlanDirection(release.version, input.currentVersion) : null;
  /**
   * **这一次是不是「换档」**：在**所有**分支上都算（含 `install` 的设计默认），所以
   * `direction === 'older' ⟹ switchesChannel` **无条件成立** —— 是按构造保证的，不是靠
   * "跟随时现实中不会出现更低的目标"。两个来源：
   *   1. 目标档位与**当前档位**不同（显式换档，或 `install` 的设计默认正好跨了她当时的档 ——
   *      装了当前版的机器上点"安装"同样是一次换档，界面必须说得出「换成稳定版」）；
   *   2. 目标版本比现在低（同一档里退回旧版本同样是换档动作）。
   * 判不出当前档位时（`currentChannel === null`）没得比，一律 `false`。
   */
  const switchesChannel =
    direction === 'older' || (currentChannel !== null && channel !== currentChannel);
  return {
    method,
    channel,
    release,
    currentVersion: input.currentVersion,
    currentChannel,
    switchesChannel,
    direction,
    needChoice,
    // 直装恒为 true（官方安装包必须下载）；nvm 且机器上已经有可辨认的版本管理器 → false
    installsManager: method === 'nvm' ? !input.nvmPresent : true,
    refuse,
    coexistWarning: coexist ? NODE_COEXIST_WARNING : null,
  };
}

/** 判定 + 归属事实 → 计划里的那些 t29 字段（**只有这一处映射**：界面读到的就是判定本身） */
export interface NodePlanFacts {
  owner: EnvNodeOwner;
  nvmPresent: boolean;
  currentVersion: string | null;
  currentChannel: EnvNodeChannel | null;
  switchesChannel: boolean;
  direction: 'newer' | 'same' | 'older' | null;
  needChoice: 'choose-method' | 'choose-channel' | null;
  installsManager: boolean;
}

export function nodePlanFacts(
  owner: EnvNodeOwner,
  nvmPresent: boolean,
  decision: NodePlanDecision,
): NodePlanFacts {
  return {
    owner,
    nvmPresent,
    currentVersion: decision.currentVersion,
    currentChannel: decision.currentChannel,
    switchesChannel: decision.switchesChannel,
    direction: decision.direction,
    needChoice: decision.needChoice,
    installsManager: decision.installsManager,
  };
}

/**
 * 「开发者模式」的注册表值是不是开着（纯函数，喂 `reg query` 里那一段文本）。
 *
 * 认得出 `0x1` / `1` 才算 true；`0x0` / 没有这一项 / 读不出来都是 false
 * —— 这条只用来**决定要不要提醒用户去开它**，不用来拦人（没证据就不拦，与提权探测同款纪律）。
 */
export function isDeveloperModeEnabled(value: string | null): boolean {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  return text === '0x1' || text === '1';
}

// ---------------------------------------------------------------- 提权那一次的结果（纯函数，F-02）

/** 提权那一次的结果：成功 / 用户没允许 / **等太久** / 没跑通 */
export type ElevationOutcome = 'ok' | 'declined' | 'timeout' | 'failed';

/** 提权探测的原始事实（喂给下面的纯函数；夹具直接构造这四件事） */
export interface ElevationProbe {
  /** PowerShell 的退出码（没跑起来时 null） */
  code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  /** 我们自己的等待上限到了（UAC 对话框等了太久）—— **不是**"用户没允许" */
  timedOut: boolean;
}

/**
 * 一次提权尝试 → 四种结果之一（纯函数，离线可测）。
 *
 * 判定顺序即优先级，关键是**超时最先判**：它是"我们不等了"，与"用户点了否"是两件事，
 * 混在一起会把用户引到错误的下一步（F-02 第 1 条）。
 */
export function classifyElevationOutcome(probe: ElevationProbe): ElevationOutcome {
  if (probe.timedOut) return 'timeout';
  const text = `${probe.stdout}\n${probe.stderr}\n${probe.error ?? ''}`;
  if (/cancel|取消/i.test(text) && /operation|操作|request/i.test(text)) return 'declined';
  if (probe.error) return 'failed';
  const lines = probe.stdout.trim().split(/\r?\n/);
  const line = lines.length > 0 ? lines[lines.length - 1] : '';
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === 'object') {
      const record: Record<string, unknown> = { ...parsed };
      const exitCode = typeof record.ExitCode === 'number' ? record.ExitCode : null;
      if (exitCode === 0) return 'ok';
      return 'failed';
    }
  } catch {
    // 读不出 JSON：下面按退出码兜底
  }
  return probe.code === 0 ? 'ok' : 'failed';
}

/** 三种"没成功"的提权结果 → 各自的类别 / 文案 / 出路（纯函数；超时**不许**归成"没权限"） */
export function elevationFailure(outcome: Exclude<ElevationOutcome, 'ok'>): InstallFailureReason {
  if (outcome === 'timeout') {
    return {
      kind: 'elevation-timeout',
      message: ELEVATION_TIMEOUT_MESSAGE,
      hint: FAILURE_HINTS['elevation-timeout'],
    };
  }
  if (outcome === 'declined') {
    return {
      kind: 'elevation-declined',
      message: FAILURE_MESSAGES['elevation-declined'],
      hint: FAILURE_HINTS['elevation-declined'],
    };
  }
  return {
    kind: 'elevation-failed',
    message: FAILURE_MESSAGES['elevation-failed'],
    hint: FAILURE_HINTS['elevation-failed'],
  };
}

/**
 * 一段输出里有没有「Node 的版本号」（纯函数）。
 *
 * 「装完必须实测可用」这条判据（`<node> --version` 有输出）就落在它身上；
 * 提权超时之后那次事实复检用的是同一把尺 —— 链接建好了就该看到版本号，
 * 而没有 active version 时看到的是那句 `No active Node.js version is configured…`（VM 实测原文）。
 */
export function hasNodeVersionOutput(text: string): boolean {
  return /(?:^|\s)v?\d+\.\d+\.\d+(?:\s|$)/m.test(String(text ?? ''));
}

// ---------------------------------------------------------------- 有状态部分

export interface NodeInstallHooks {
  /** 安装过程的原始输出（推给渲染层） */
  output: (chunk: string) => void;
  /** 状态变化（推给渲染层） */
  state: (state: EnvInstallState) => void;
  /** 事件日志 */
  log: (text: string) => void;
  /** 复检：由编排注入（引擎不 import env-doctor） */
  recheck: () => Promise<EnvDoctorReport>;
  /** 更新前先停掉本应用启动的 dsh：由编排注入（引擎不 import dsh-manager） */
  stopDsh: () => Promise<void>;
  /** 下载器：默认走 Electron 的网络栈（遵循系统代理）；测试可注入 */
  download?: (url: string) => Promise<{ file: string; bytes: number; total: number | null }>;
  /**
   * 提权执行器（F-02 第 3 条要的**可注入边界**）：默认走异步 PowerShell
   * （`Start-Process -Verb RunAs -Wait -PassThru`）。测试可以注入它，把
   * 「成功 / 用户拒绝 / 等太久 / 没跑通」四种结果真跑出来（不必真的有 UAC）。
   */
  elevate?: (request: { file: string; args: string[] }) => Promise<ElevationOutcome>;
  /**
   * **计划阶段的文本取回**（官方版本清单 `index.json` / 校验清单 `SHASUMS256.txt` / 版本管理器的
   * 发布信息）：默认走 Electron 的网络栈（遵循系统代理、跟随 301、有超时）。
   *
   * 为什么它也要能注入（t29）：VM-14 / VM-15 的核心判据是"**这一次计划**里方法是哪条、目标档位是哪个"，
   * 而 `plan()` 默认要经 Electron 的网络栈 —— 在没有 Electron 的进程里它连版本清单都拿不到，
   * 于是"归属 → 方法"这件事就只剩"读代码下结论"。注入它之后，独立反例可以喂一份真的清单
   * （客机那种 nvm 形状 + 系统直装形状 + 未知形状）**真调一次 `plan()`**，断言它没有规划出
   * 官方 MSI 到 `C:\Program Files\nodejs`。与 `download` / `elevate` 同一条纪律：只影响这一次实例。
   */
  fetchText?: (url: string) => Promise<string | null>;
}

/** 一次下载的结果（内部用；`kind` 让「成功 / 取消 / 失败」成为一组可穷尽的分支） */
interface TransferResult {
  kind: 'ok';
  file: string;
  bytes: number;
  total: number | null;
}

/** 等一次下载的结果 */
type TransferOutcome = TransferResult | { kind: 'cancelled' } | { kind: 'failed'; error: string };

/**
 * 算计划的结果。`plan.usable === false` 时 **`unusableReason` 一定在**：
 * 「不能走」也有类别（网络 / 架构 / 提权），界面与日志照实说，不糊成一句"不支持"。
 */
type PlanResult =
  | { ok: true; plan: EnvNodePlan; unusableReason?: InstallFailureReason }
  | { ok: false; reason: InstallFailureReason };

/** 子进程收尾的四种情况：正常退出 / 没起来 / 我们不再等待 / 等待上限到了由调用方收尾 */
type CloseOutcome =
  | { kind: 'exit'; code: number | null }
  | { kind: 'error'; error: string }
  | { kind: 'detached' }
  /** 等待上限到了，而调用方要自己决定怎么收尾（提权那段用它：F-02） */
  | { kind: 'timeout' };

/** 只读探测的结果 */
interface ProbeOutput {
  code: number | null;
  stdout: string;
  /** 只读探测的 stderr（提权那次用它认"用户取消了"） */
  stderr: string;
  error: string | null;
}

/** 从注册表读到的环境快照（PATH 已经展开过 `%VAR%`） */
interface RegistryEnvSnapshot {
  machinePath: string | null;
  userPath: string | null;
  vars: Record<string, string>;
}

/** 安装包签名（读不到时为 null） */
interface SignatureInfo {
  /** Valid / NotSigned / HashMismatch / UnknownError / NotTrusted（PowerShell 的原话） */
  status: string;
  subject: string | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 界面上那一句话：冻结文案在前，**需要用户自己动手的出路接在后**。
 *
 * 两种不加出路：提权被拒 / 用户取消 —— 那两行的文案是冻结的「原样」，而且分不清
 * 是"拒绝"还是"取消"时我们**只说那一句、不编因果**（交互规格 §7.6 的注意条）。
 * 其余失败（网络 / 校验 / 空间 / 被占用 / 认不出来）都把补救说明一起说清 ——
 * 「这台电脑上什么都没改」之后总得告诉用户下一步能干什么。
 */
function visibleFailureText(reason: InstallFailureReason): string {
  const keepExact = reason.kind === 'permission' || reason.kind === 'cancelled';
  if (keepExact || !reason.hint) return reason.message;
  return `${reason.message} ${reason.hint}`;
}

function idleState(): EnvInstallState {
  return {
    phase: 'idle',
    method: null,
    mode: null,
    percent: null,
    bytes: null,
    cancellable: false,
    detached: false,
    message: null,
    code: null,
    report: null,
    plan: null,
    observedVersion: null,
  };
}

/** 这台机器的 Windows 目录（安装器与系统命令都用完整路径，不经查找） */
function systemRoot(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return root.replace(/[\\/]+$/, '');
}

function system32(file: string): string {
  return path.join(systemRoot(), 'System32', file);
}

/**
 * 起一个子进程：**一律 `file + argv` 数组**，绝不过 shell。
 *
 * 与既有 `EnvFixRunner` 同一套（冻结文档 §3.8 第 19 条钉着这一句）：`launchSpec()`
 * 算好的 spec 原样传下去（Windows 上 `.cmd` / `.bat` 必须经 cmd.exe，且必须带
 * `windowsVerbatimArguments`），子进程环境用 `envWithKnownBins` 补齐已知目录，
 * 额外的注入（安装源）只影响这一个进程。
 */
function spawnSpec(spec: LaunchSpec, extra: NodeJS.ProcessEnv): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...envWithKnownBins(process.env), ...extra };
  const file = spec.file;
  const args = spec.args;
  return spawn(file, args, {
    env,
    // cwd 固定成主目录：继承来的 cwd 是 Electron 的启动目录（从开始菜单起可能是别处）
    cwd: homeDir(),
    windowsHide: true,
    // 命令行是我们按 cmd 规则拼好的，Node 不要再加引号（见 LaunchSpec 的说明）
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** 一次性只读探测（注册表 / 提权 / 签名 / 提权执行）：同步、带超时、失败不抛 */
function runProbe(file: string, args: string[], timeoutMs = PROBE_TIMEOUT_MS): ProbeOutput {
  if (!isWindows) return { code: null, stdout: '', stderr: '', error: 'not-windows' };
  const spec = launchSpec(file, args, 'win32');
  try {
    const result = spawnSync(spec.file, spec.args, {
      timeout: timeoutMs,
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      env: envWithKnownBins(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) {
      return { code: null, stdout: '', stderr: '', error: result.error.message };
    }
    return {
      code: typeof result.status === 'number' ? result.status : null,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      error: null,
    };
  } catch (error) {
    return { code: null, stdout: '', stderr: '', error: messageOf(error) };
  }
}

/** `reg query` 的一段输出 → 键值表（键名大小写照原文；`(默认)` 丢掉） */
function parseRegQueryOutput(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s{2,}(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    if (!name || name.toLowerCase() === '(default)') continue;
    values[name] = match[3].trim();
  }
  return values;
}

function findValue(values: Record<string, string>, name: string): string | null {
  const key = Object.keys(values).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? values[key] : null;
}

/** PowerShell 单引号字符串：路径里的单引号写成两个 */
function psQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 读安装包，认出它是 Inno 还是 NSIS（IO：读文件的全部字节；10~40 MB 一次读，够快）。
 *
 * 读不到就返回 `unknown` —— 那意味着"静默参数不敢猜"，走可见向导并把这件事告诉用户。
 */
function readInstallerFlavor(file: string): InstallerFlavor {
  try {
    return detectInstallerFlavor(fs.readFileSync(file));
  } catch {
    return 'unknown';
  }
}

/**
 * 异步版只读探测：`spawn` + Promise，**不阻塞主进程**（F-03）。
 *
 * 用在"用户看得见"的两处：提权那一趟（UAC 可能等好几分钟）与提权探测（`whoami /groups`）。
 * 同步的 `runProbe` 留给毫秒级、且本来就处在一次性准备阶段里的小探测（注册表 / 签名 / `--version`）。
 */
function runProbeAsync(
  file: string,
  args: string[],
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ElevationProbe> {
  return new Promise((resolve) => {
    if (!isWindows) {
      resolve({ code: null, stdout: '', stderr: '', error: 'not-windows', timedOut: false });
      return;
    }
    const spec = launchSpec(file, args, 'win32');
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | null = null;
    const finish = (value: ElevationProbe): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      resolve({ ...value, stdout, stderr, timedOut });
    };
    let child: ChildProcess;
    try {
      child = spawnSpec(spec, {});
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error: messageOf(error), timedOut: false });
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + String(chunk)).slice(-OUTPUT_TAIL_CHARS);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + String(chunk)).slice(-OUTPUT_TAIL_CHARS);
    });
    timer = setTimeout(() => {
      // 到点只**停止等待**，不杀它：这个模块里没有任何 `kill`（"不杀进程"是硬性质，
      // 请按 §3.8 第 20 条理解）。`whoami` 这种只读探测会自己退，退了我们忽略结果即可。
      timedOut = true;
      finish({ code: null, stdout: '', stderr: '', error: null, timedOut: true });
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (error: Error) =>
      finish({ code: null, stdout: '', stderr: '', error: error.message, timedOut }),
    );
    child.on('close', (code: number | null) =>
      finish({ code, stdout: '', stderr: '', error: null, timedOut }),
    );
  });
}

/** Windows「开发者模式」开着没有（IO：读一处只读注册表值；读不到当 false，只影响提示） */
function readDeveloperMode(): boolean {
  const probe = runProbe(system32('reg.exe'), ['query', DEVELOPER_MODE_KEY]);
  if (probe.error !== null || probe.code !== 0) return false;
  const match = /REG_DWORD\s+(\S+)/i.exec(probe.stdout);
  return isDeveloperModeEnabled(match ? match[1] : null);
}

/**
 * v2 的偏好写在 `HKCU\Software\<发布方>\Preferences\nvm`（官方安装脚本里就是这条键；
 * 发布方标签从**真实根目录**推出来 —— `…\Local\Author Software\nvm` → `Author Software`）。
 */
export function nvmPreferenceKey(root: string): string | null {
  const clean = String(root ?? '').replace(/[\\/]+$/, '');
  const label = path.win32.basename(path.win32.dirname(clean));
  const alias = path.win32.basename(clean);
  if (!label || !alias) return null;
  return `HKCU\\Software\\${label}\\Preferences\\${alias}`;
}

/** 注册表偏好里我们要的那几项（都是 v2 的真实键名） */
export interface NvmRegistryPreferences {
  installsDir: string | null;
  mode: 'shim' | 'link' | 'unknown';
  defaultVersion: string | null;
  version: string | null;
  status: string | null;
}

/** 注册表值 → 偏好（纯函数，夹具直接喂 `reg query` 的输出文本） */
export function parseNvmRegistryPreferences(text: string): NvmRegistryPreferences {
  const values = parseRegQueryOutput(text);
  const get = (name: string): string | null => findValue(values, name);
  const modeText = (get('OperatingMode') ?? '').toLowerCase();
  const enabled = get('Enabled');
  const version = get('Version');
  const active = get('ActiveVersion');
  return {
    installsDir: get('InstallRoot'),
    mode: /shim/.test(modeText) ? 'shim' : /link|symlink/.test(modeText) ? 'link' : 'unknown',
    defaultVersion: active && !/not set|none/i.test(active) ? active : null,
    version: version && /^v?\d+/.test(version) ? version : null,
    status: enabled === null ? null : enabled === '0x0' || enabled === '0' ? 'off' : 'on',
  };
}

/** 读一次 v2 的注册表偏好（IO）；读不到返回 null（v1 的机器没有这条键） */
function readNvmRegistryPreferences(root: string): NvmRegistryPreferences | null {
  const key = nvmPreferenceKey(root);
  if (!key) return null;
  const probe = runProbe(system32('reg.exe'), ['query', key]);
  if (probe.error !== null || probe.code !== 0) return null;
  const parsed = parseNvmRegistryPreferences(probe.stdout);
  const empty =
    parsed.installsDir === null && parsed.defaultVersion === null && parsed.mode === 'unknown';
  return empty ? null : parsed;
}

/** 用户数据目录（拿不到 Electron 时退回临时目录；只用来放这次下载的临时文件） */
function userDataDir(): string {
  try {
    const load = createRequire(__filename);
    const electron: unknown = load('electron');
    if (electron && typeof electron === 'object') {
      const app = (electron as { app?: unknown }).app;
      if (app && typeof app === 'object') {
        const getPath = (app as { getPath?: unknown }).getPath;
        if (typeof getPath === 'function') {
          const dir = (getPath as (name: string) => unknown)('userData');
          if (typeof dir === 'string' && dir) return dir;
        }
      }
    }
  } catch {
    // 不在 Electron 里（自检 / 反例脚本）：用临时目录
  }
  return os.tmpdir();
}

/** 这次下载 / 校验用的临时目录 */
function installTempDir(): string {
  return path.join(userDataDir(), 'env-install');
}

/** 下载通道（Electron 的网络栈；不顶层 import，保证这个模块能被普通 Node import） */
interface NetRequest {
  on(event: 'response', handler: (response: NetResponse) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
  abort(): void;
  end(): void;
}
interface NetResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  on(event: 'data', handler: (chunk: Buffer) => void): void;
  on(event: 'end', handler: () => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
}
interface NetModule {
  request(options: { method: string; url: string; redirect: string }): NetRequest;
}

function electronNet(): NetModule | null {
  try {
    const load = createRequire(__filename);
    const electron: unknown = load('electron');
    if (!electron || typeof electron !== 'object') return null;
    const net = (electron as { net?: unknown }).net;
    if (!net || typeof net !== 'object') return null;
    const request = (net as { request?: unknown }).request;
    if (typeof request !== 'function') return null;
    return net as NetModule;
  } catch {
    return null;
  }
}

/** 响应头里的总字节数（拿不到 → null，界面整行不出现） */
function contentLength(headers: Record<string, string | string[] | undefined>): number | null {
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'content-length');
  const raw = key ? headers[key] : undefined;
  const text = Array.isArray(raw) ? raw[0] : raw;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** 算一个文件的 sha256（读不出来返回 null；校验拿不到值就当"这次没能校验"） */
async function sha256OfFile(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(file);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', () => resolve(null));
      stream.on('end', () => resolve(hash.digest('hex')));
    } catch {
      resolve(null);
    }
  });
}

/** 地址里的主机名（正文只显示主机名，完整地址留给详情区）；解析不出来就原样返回 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Node 的安装 / 更新执行者（一个实例，住在主进程）。
 *
 * 相位（契约 `EnvInstallPhase`）与「停止」的两种语义（冻结文档 §3.2 的 `cancellable`）：
 * `preparing` / `downloading` / `verifying` 停下 = **真取消**（断掉下载、删临时文件、系统零改动）；
 * `installing` / `waiting` 停下 = **只停止等待**（`detached: true`，安装器继续跑，互斥位继续持有）。
 *
 * 互斥位（`busy()`）在三种情况之一发生时释放（冻结文档 R-06）：复检事实显示这一步已经不再缺 /
 * 用户再点一次「我确认安装已经结束」 / 应用重启（互斥位只在内存里）。
 */
export class NodeInstaller {
  private child: ChildProcess | null = null;
  /**
   * 同步的互斥位（**不要**用 `child` 代替：`child` 要到 spawn 之后才为真，而 `run()` 从入口到
   * spawn 之间隔着好几次网络 IO，两次连点会都通过）。必须在第一个 `await` 之前同步置上。
   */
  private running = false;
  /** 已经「不再等待」但安装可能还在后台跑：互斥位**继续持有**（R-06） */
  private holding = false;
  private cancelled = false;
  private detachedFlag = false;
  private current: EnvInstallState = idleState();
  /** 断掉这一次下载（Electron 请求的 abort；注入的下载器没有可断的东西） */
  private downloadAbort: (() => void) | null = null;
  /** 让「取消下载」立刻从等待里放手（不等对方真的停：临时文件随后删） */
  private releaseTransfer: (() => void) | null = null;
  /** 让「不再等待」立刻从安装器等待里放手（不杀安装器） */
  private releaseWait: (() => void) | null = null;
  /** 提权探测只做一次（一次只读子进程） */
  private elevated: boolean | null = null;
  /** 已经「不再等待」，但安装器还在后台跑：它一退出就用复检事实收尾（R-06 第 ① 条） */
  private detachedWatch = false;
  /** 收尾只跑一次（`finishDetached` 与「我确认安装已经结束」可能撞在一起） */
  private detachedSettling = false;
  /**
   * 刚才「不再等待」的那一次是**版本管理器的安装程序**：它终于退出之后，我们还要把
   * `nvm install` / `nvm use` 补完（VM 实测那台机器上，用户晚点才点完向导，
   * 我们早就停止等待了 —— 不补的话就会停在"版本管理器装好但没有 active Node"）。
   */
  private detachedNvmResume = false;
  /** 这一次跑的计划（`finishDetached` 补做 nvm 两步时要用它） */
  private activePlan: EnvNodePlan | null = null;
  /** 本次下载 / 校验落过盘的东西（取消 / 失败 / 退出时按这个清单删） */
  private readonly tempFiles = new Set<string>();
  /** 上次推给界面的下载百分比：一样就不重复推（每 64KB 一个事件会把 IPC 刷满） */
  private lastPercent: number | null = null;
  /** 最近一次子进程退出码：复检与结果态都要带着它（界面能显示"退出码几"） */
  private lastCode: number | null = null;

  constructor(
    private readonly settings: Settings,
    private readonly hooks: NodeInstallHooks,
  ) {}

  /**
   * 计划（确认区用）。拿不到计划（版本清单取不到 / 解析失败 / 平台不支持）→ `null`，不抛。
   *
   * **请求形状是 t29 的那个**（冻结 §3.2.1）：`{ mode, method?, channel? }` ——
   * `method` 省略 = **跟随归属**（§7.8），`channel` 省略 = **跟随档位**（`install` → 最新稳定版、
   * `update` → 当前档位，§8.5）。只有显式给值才是"用户点名的那条路 / 那次换档"。
   */
  async plan(request: EnvNodeRequest): Promise<EnvNodePlan | null> {
    try {
      const built = await this.buildPlan(request);
      return built.ok ? built.plan : null;
    } catch (error) {
      this.hooks.log(`安装计划没能算出来：${messageOf(error)}`);
      return null;
    }
  }

  /** 跑一次安装 / 更新。业务失败**不抛**：终态是 `phase: 'error'` + 一句人话 */
  async run(request: EnvNodeRequest): Promise<EnvInstallState> {
    if (this.busy()) return { ...this.current, message: BUSY_MESSAGE };
    // 同步占位，且必须在第一个 `await` 之前（见 running 的说明）
    this.running = true;
    try {
      return await this.execute(request);
    } catch (error) {
      // 认得出就归纳，认不出就给一句带原文的兜底：绝不让界面拿到一个空结论
      const reason = classifyInstallFailure(messageOf(error), null);
      this.hooks.log(`环境安装异常：${messageOf(error)}`);
      return this.publish('error', { message: visibleFailureText(reason), report: null });
    } finally {
      this.running = false;
    }
  }

  /**
   * 停止。同步、不抛。
   *
   * - 下载 / 校验 / 准备：真取消（断网请求 + 删临时文件），终态由 `run()` 里的收尾写；
   * - 安装 / 等待：只置 `detached`（不杀安装器），`run()` 的 Promise 就地解析；
   * - **已经 `detached` 再点一次** = 界面上那句「我确认安装已经结束」：释放互斥位，
   *   并且仍然让复检事实给结论。
   */
  stop(): EnvInstallState {
    const phase = this.current.phase;
    if (phase === 'preparing' || phase === 'downloading' || phase === 'verifying') {
      this.cancelled = true;
      this.downloadAbort?.();
      this.releaseTransfer?.();
      return this.state();
    }
    if (phase === 'installing' || phase === 'waiting') {
      if (this.current.detached) {
        // 「我确认安装已经结束」：锁解除，但结论仍然由复检给（不许无复检断言）
        this.holding = false;
        this.confirmDetached().catch((error: unknown) => {
          this.hooks.log(`解除等待之后的复检没能跑完：${messageOf(error)}`);
        });
        return this.state();
      }
      this.releaseWait?.();
      this.releaseWait = null;
      return this.state();
    }
    return this.state();
  }

  /** 当前状态（IPC 初值 / 复检后的广播） */
  state(): EnvInstallState {
    const bytes = this.current.bytes;
    return { ...this.current, bytes: bytes ? { ...bytes } : null };
  }

  /** 自己有没有在跑（编排用它合成全局忙位）；`detached` 期间仍然算忙 */
  busy(): boolean {
    return this.running || this.child !== null || this.holding;
  }

  /**
   * 当前 Node 是哪条路管的（界面决定「更新」走哪条；也是「换一个 Node」的判据）。
   *
   * **判据只有一份**：`detectNodeOwner`（需求 §7.7 第 1 条），这里只把入参凑齐。
   * 同步、不起子进程（`nvm env` 不是判据的一部分），所以调用方不必等一轮探测。
   */
  currentNodeOwner(): EnvNodeOwner {
    return this.ownership(null).owner;
  }

  /** 归属事实 + 模型（入参凑齐之后交给唯一的判据 `detectNodeOwner`） */
  private ownership(msiInstallPath: string | null): {
    owner: EnvNodeOwner;
    evidence: string[];
    model: NvmModel | null;
  } {
    const model = deriveNvmModelFromEnvironment(process.env);
    const ownership = detectNodeOwner({
      nodePath: this.probeNodePath(),
      env: process.env,
      model,
      msiInstallPath,
    });
    return { ...ownership, model };
  }

  /**
   * 应用退出时调用：下载 / 校验 → 取消 + 删临时文件；安装 / 等待 → 放弃引用、
   * **不杀、不等**（安装器是独立进程，父进程退出后继续跑完；它在用的那个安装包也不能删）。
   */
  detachOnQuit(): void {
    const phase = this.current.phase;
    if (phase === 'preparing' || phase === 'downloading' || phase === 'verifying') {
      this.cancelled = true;
      this.abortTransfer();
      this.discardTempDir();
    }
    this.child = null;
    this.holding = false;
  }

  // -------------------------------------------------------------- run 的三个阶段

  private async execute(request: EnvNodeRequest): Promise<EnvInstallState> {
    const mode: EnvNodeMode = request.mode === 'update' ? 'update' : 'install';
    this.cancelled = false;
    this.detachedFlag = false;
    this.holding = false;
    this.lastCode = null;

    // `method` 这时候还不知道（省略 = 跟随归属，要等计划算出来）——契约里它本来就是 `| null`
    this.publish('preparing', {
      method: request.method ?? null,
      mode,
      plan: null,
      observedVersion: null,
      message: '正在准备安装…',
    });
    if (this.cancelled) return this.settleCancelledDownload();
    if (!isWindows) {
      return await this.settleFailure(
        {
          kind: 'unsupported',
          message: '自动安装只在 Windows 上提供。可以自己到官方下载页装。',
          hint: FAILURE_HINTS.unsupported,
        },
        false,
      );
    }

    const built = await this.buildPlan(request);
    if (this.cancelled) return this.settleCancelledDownload();
    if (!built.ok) return await this.settleFailure(built.reason, false);
    const installed = built.plan;
    if (!installed.usable) {
      // 「不能走」也有类别：网络取不到清单 / 架构没有安装包 / 提权态不许装版本管理器 /
      // 归属未知要用户显式选（`needChoice`）
      const reason = built.unusableReason ?? {
        kind: 'unsupported' as const,
        message: installed.refuseReason ?? FAILURE_MESSAGES.unsupported,
        hint: FAILURE_HINTS.unsupported,
      };
      return await this.settleFailure(reason, false);
    }
    // 存下来：`finishDetached` 在"不再等待"之后补做 nvm 两步时要重新算同一份计划的事实
    this.activePlan = installed;
    const plan = installed;
    this.publish('preparing', {
      method: plan.method,
      mode: plan.mode,
      plan,
      message: '正在准备安装…',
    });

    // 「更新会先停掉正在运行的 dsh」是确认区上写着的承诺（`docs/env-wizard.md` §8.3 / 交互 §10.5 第 7 条）：
    // **只要这一次是更新就先停一次，而且只在这一处停**（`installPhase()` 里那次已经移走）——
    // 不管走哪条路、要不要下载。原先它住在 `installPhase()` 里，而"机器上已经有版本管理器"
    // （`installsManager === false`）那条路**整个跳过**安装阶段，于是那句承诺会 quietly 落空
    // （用户点的是"更新 Node"，界面说会先停 dsh，实际没停）。
    // 钩子只停**本应用启动的**那个 dsh（外部实例不属于我们，需求 §14）。
    if (plan.mode === 'update') await this.stopDshForUpdate();

    // 1~3. 下载 → 校验 → 安装**要下载的东西**。
    // 机器上已经有可辨认的版本管理器时（`installsManager === false`）这一步**整个跳过**：
    // 用户点的是"更新 Node"，不是"重装版本管理器"（冻结 §3.2.1 的 `installsManager`）。
    if (!plan.installsManager) {
      this.hooks.log('这台电脑上已经有可辨认的版本管理器：这次不下载、不校验，直接用它装 Node');
      this.publish('installing', {
        message: `正在用这台电脑上已经装好的版本管理器装 Node.js ${plan.version}`,
      });
    } else {
      const transferred = await this.transferPhase(plan);
      if (transferred.kind === 'cancelled') return this.settleCancelledDownload();
      if (transferred.kind === 'failed') return await this.settleFailure(transferred.reason, false);

      // 校验（通不过就不安装）
      const verified = await this.verifyPhase(plan, transferred.file);
      if (verified.kind === 'cancelled') return this.settleCancelledDownload();
      if (verified.kind === 'failed') return await this.settleFailure(verified.reason, false);

      // 安装（这一步起，停止的语义只剩"不再等待"）
      const installer = await this.installPhase(plan, transferred.file);
      if (installer.kind === 'detached') return this.state();
      if (installer.kind === 'failed') return await this.settleFailure(installer.reason, true);
    }

    // 3b. 版本管理器那条路：用它把 Node 装上、切过去（`nvm install` → `nvm list` 核对 → `nvm use`）
    if (plan.method === 'nvm') {
      const nodeStep = await this.installNodeWithNvm(plan);
      if (nodeStep.kind === 'detached') return this.state();
      if (nodeStep.kind === 'failed') return await this.settleFailure(nodeStep.reason, true);
    }

    // 4. 复检（重读系统里的环境之后）
    return await this.settleSuccess(plan);
  }

  // -------------------------------------------------------------- 计划

  /**
   * 把网络与磁盘上的事实凑齐，然后交给**唯一的纯判定** `decideNodePlan()`（需求 §7.7 / §7.8 / §8.5）。
   *
   * 这里只做三件事：读归属事实（`detectNodeOwner`）、取官方版本清单、按判定结果装出计划
   * （能用 / 不能用 / 要用户显式选）。**没有一处"默认直装"的兜底** —— VM-14 就死在那条兜底上。
   */
  private async buildPlan(request: EnvNodeRequest): Promise<PlanResult> {
    const mode: EnvNodeMode = request.mode === 'update' ? 'update' : 'install';
    if (!isWindows) {
      // 非 Windows 上一律不给计划（冻结文档 R-20）：界面据此连「开始」都不给
      return {
        ok: false,
        reason: {
          kind: 'unsupported',
          message: '自动安装只在 Windows 上提供。可以自己到官方下载页装。',
          hint: FAILURE_HINTS.unsupported,
        },
      };
    }
    const arch = process.arch;
    // 下载源（留空 = 官方直连）只改**我们发起的下载**：版本清单与 Node 的安装包都按同一个
    // 相对路径拼（`v<版本>/<文件名>`）；版本管理器自己的安装包不套用它（GitHub 资产没有镜像语义）
    const source = normalizeNodeSource(this.settings.get('envNodeSource'));
    const indexBase = source ?? NODE_DIST_HOST;

    // —— t29 的事实：这份 Node 是谁管的（判据只有一份：`detectNodeOwner`）——
    // 安装计划这一侧读得到注册表，所以把 `InstallPath` 这条正面证据也带上（读不到不影响结论）。
    const ownership = this.ownership(readNodeMsiInstallPath());
    const nodePath = this.probeNodePath();
    const currentVersion = nodePath ? await this.readNodeVersion(nodePath) : null;

    // 版本清单：两条路都要知道"装哪个 Node 版本"（直装是下载它，版本管理器是用 nvm 装它）
    const indexText = await this.fetchText(`${indexBase}/${NODE_INDEX_PATH}`);
    if (indexText === null) {
      return {
        ok: false,
        reason: {
          kind: 'network',
          message: FAILURE_MESSAGES.network,
          hint: FAILURE_HINTS.network,
        },
      };
    }
    const list = parseNodeReleaseIndex(indexText);
    const decision = decideNodePlan({
      mode,
      requestMethod: request.method,
      requestChannel: request.channel,
      owner: ownership.owner,
      nvmPresent: ownership.model !== null,
      nodeFound: nodePath !== null,
      currentVersion,
      releases: list,
      // 提权探测只在这一条分支上才有意义（R-23 的例外：归属 = nvm + 提权态才允许改走官方直装），
      // 别为了它给每一次"打开确认区"都塞一次 `whoami` 子进程。
      elevated:
        request.method === 'direct' && ownership.owner === 'nvm' ? await this.isElevated() : false,
    });
    const facts = nodePlanFacts(ownership.owner, ownership.model !== null, decision);
    this.hooks.log(
      `安装计划的事实：归属=${ownership.owner}（${ownership.evidence.join('；')}）；` +
        `版本管理器=${ownership.model ? ownership.model.root : '没有'}；当前版本=${currentVersion ?? '没测到'}；` +
        `当前档位=${decision.currentChannel ?? '判不出来'}；目标方法=${decision.method}；目标档位=${decision.channel}` +
        `${decision.switchesChannel ? '（换档）' : ''}${decision.needChoice ? `；要用户显式选：${decision.needChoice}` : ''}`,
    );

    // 「这次给不出开始」的两种：要用户显式选（`needChoice`）与归属已知时点了不该走的那条路。
    // 两者都**不是** `null`（界面照常显示版本与来源，只是不给「开始」）。
    if (decision.needChoice !== null || decision.refuse !== null) {
      return this.buildRefusalPlan(decision, facts, mode);
    }
    const release = decision.release;
    if (!release) {
      return {
        ok: false,
        reason: {
          kind: 'unsupported',
          message: '没能从官方版本清单里挑出可以装的版本（清单可能变了）。',
          hint: `${FAILURE_HINTS.unsupported} 下载页：${NODE_DOWNLOAD_PAGE}`,
        },
      };
    }

    if (decision.method === 'nvm') {
      return await this.buildNvmPlan(release, mode, decision, facts, arch, ownership.model);
    }
    return await this.buildDirectPlan(release, mode, decision, facts, arch, source);
  }

  /**
   * 「这次不能自动走」的计划（需求 §7.7 第 3 条 / §7.8 的三个例外）。
   *
   * 为什么给计划而不是 `null`：`null` 只留给"连版本清单都算不出来"那四类；
   * 这里版本清单是好的、结论也明确（要用户显式选哪一条 / 为什么不给走），界面要照实显示。
   * `url` 指向官方下载页 —— 那是用户真有得去的地方，**不是**我们会去下载的地址。
   */
  private buildRefusalPlan(
    decision: NodePlanDecision,
    facts: NodePlanFacts,
    mode: EnvNodeMode,
  ): PlanResult {
    const reason: InstallFailureReason = decision.refuse ?? {
      kind: 'unsupported',
      message: '这次没有可以自动走的路。',
      hint: FAILURE_HINTS.unsupported,
    };
    return {
      ok: true,
      plan: {
        method: decision.method,
        mode,
        channel: decision.channel,
        version: decision.release?.version ?? '',
        url: NODE_DOWNLOAD_PAGE,
        sourceHost: hostOf(NODE_DOWNLOAD_PAGE),
        sha256: null,
        evidence: decision.release ? '官方版本清单' : '还没有可用的目标档位',
        // 计划阶段恒为 unknown（官方直装那侧没有发布自述）；这里连下载都不会发生
        releaseSigning: 'unknown',
        signer: null,
        usable: false,
        refuseReason: reason.message,
        needsElevation: decision.method === 'direct',
        affectsRunningDsh: false,
        display: decision.release ? `Node.js ${decision.release.version}` : '',
        target: null,
        note: `${reason.message}${reason.hint ? ` ${reason.hint}` : ''}${
          decision.coexistWarning ? ` ${decision.coexistWarning}` : ''
        }`,
        ...facts,
      },
      unusableReason: reason,
    };
  }

  /**
   * 发布里挑安装包：**逐个发布往前找**（列表是新发布在前），跳过预发布与草稿 ——
   * 「默认只选不是预发布的稳定版」是硬要求（需求 §7.3）。挑不到返回 null，不换源、不重试。
   *
   * 挑中的那个发布要一起带回去：它的说明正文里有"这一次签没签名"的自述，
   * 而确认区那句额外确认依赖它（`EnvNodePlan.releaseSigning`）。
   */
  private pickReleaseAsset(
    releases: GithubRelease[],
    arch: string,
  ): { asset: ReleaseAsset; release: GithubRelease } | null {
    for (const release of releases) {
      if (release.prerelease || release.draft) continue;
      const asset = pickNvmSetupAsset(release.assets, arch);
      if (asset) return { asset, release };
    }
    return null;
  }

  private async buildDirectPlan(
    release: NodeReleaseEntry,
    mode: EnvNodeMode,
    decision: NodePlanDecision,
    facts: NodePlanFacts,
    arch: string,
    source: string | null,
  ): Promise<PlanResult> {
    const channel = decision.channel;
    const base = source ?? NODE_DIST_HOST;
    const fileName = nodeInstallerFileName(release.version, arch);
    const canonical = nodeInstallerUrl(release, arch);
    const url = source ? `${base}/${release.version}/${fileName}` : canonical;
    const installPath = process.env.ProgramFiles
      ? path.win32.join(process.env.ProgramFiles, 'nodejs')
      : 'C:\\Program Files\\nodejs';
    /** 显式点名了与归属不同的那条路（§7.8 的例外）时，确认区必须带上那句并存风险 */
    const coexist = decision.coexistWarning ? ` ${decision.coexistWarning}` : '';
    const refuse = (reason: InstallFailureReason, evidence: string): PlanResult => ({
      ok: true,
      plan: {
        method: 'direct',
        mode,
        channel,
        version: release.version,
        url: `${base}/${release.version}/${fileName}`,
        sourceHost: hostOf(base),
        sha256: null,
        evidence,
        signer: null,
        // 官方直装：nodejs.org 那侧没有"签没签名"的发布自述，恒为 unknown
        releaseSigning: 'unknown',
        usable: false,
        refuseReason: reason.message,
        needsElevation: true,
        affectsRunningDsh: mode === 'update',
        display: fileName,
        target: installPath,
        note: `${reason.message}${reason.hint ? ` ${reason.hint}` : ''}${coexist}`,
        ...facts,
      },
      unusableReason: reason,
    });

    // 认不出的架构 / 版本号：连地址都拼不出来（这也不是"架构不支持"，是我们不认识这个输入）
    if (!canonical || !url) {
      return refuse(
        {
          kind: 'unsupported',
          message: '这个版本没有适合这台电脑的安装包。',
          hint: `${FAILURE_HINTS.unsupported} 下载页：${NODE_DOWNLOAD_PAGE}`,
        },
        '这一档没有这台电脑架构的官方安装包',
      );
    }

    // **权威证据是同一版本目录下的官方校验清单**（船长裁定：不再读 index.json 的 files 数组）：
    // 它里面有没有 `node-v<版本>-<arch>.msi` 这一行，就是"这个安装包存在不存在"。
    // 取不到清单 = 网络失败，**不许**降级成"这台电脑不支持"。
    const shasums = await this.fetchText(`${base}/${release.version}/SHASUMS256.txt`);
    if (shasums === null) {
      return refuse(
        {
          kind: 'network',
          message: '没能取到官方的校验清单（连不上或超时），所以这一次没法确认安装包是哪一个。',
          hint: FAILURE_HINTS.network,
        },
        '这一轮没取到官方校验清单 —— 连不上或超时',
      );
    }
    const sha256 = parseShasums(shasums, fileName);
    if (sha256 === null) {
      return refuse(
        {
          kind: 'unsupported',
          message: '这个版本没有适合这台电脑的安装包。',
          hint: `${FAILURE_HINTS.unsupported} 下载页：${NODE_DOWNLOAD_PAGE}`,
        },
        '官方校验清单里没有这台电脑架构的安装包',
      );
    }

    return {
      ok: true,
      plan: {
        method: 'direct',
        mode,
        channel,
        version: release.version,
        url,
        sourceHost: hostOf(url),
        sha256,
        evidence: '与安装包同一个目录下的官方校验清单',
        // Authenticode 只能读文件才有：计划阶段 `null` 只表示"还没读"，
        // **不是**"未签名"（界面因此不得加一次确认，见 docs 的裁定）。
        signer: null,
        // 官方直装：nodejs.org 那侧没有"签没签名"的发布自述
        releaseSigning: 'unknown',
        usable: true,
        refuseReason: null,
        needsElevation: true,
        affectsRunningDsh: mode === 'update',
        display: `msiexec /i ${fileName} /qb /norestart`,
        target: `${installPath}（官方安装包的默认位置）`,
        note: `${[
          `会用系统自带的安装程序装到 ${installPath}，需要一次管理员权限询问。`,
          '这台电脑上原来的 Node 会被换成这个版本。',
          '下载完成后会先核对完整性，再读一次安装包的数字签名；签名与内容对不上、或读到它确实没有签名，都不会安装。',
        ].join(' ')}${coexist}`,
        ...facts,
      },
    };
  }

  private async buildNvmPlan(
    release: NodeReleaseEntry,
    mode: EnvNodeMode,
    decision: NodePlanDecision,
    facts: NodePlanFacts,
    arch: string,
    model: NvmModel | null,
  ): Promise<PlanResult> {
    const channel = decision.channel;
    /** 显式点名了与归属不同的那条路（§7.8 的例外）时，确认区必须带上那句并存风险 */
    const coexist = decision.coexistWarning ? ` ${decision.coexistWarning}` : '';
    /**
     * 这条路不能走时的计划：**仍然给一份计划**（`usable: false`）而不是 `null` ——
     * 确认区要显示"版本是哪个、卡在哪、还有哪条出路"；`plan() === null` 只留给
     * "连版本清单都算不出来"（平台不对 / index 取不到 / 解析不出来）。
     * 不能走的时候 `url` 指向**发布页**（那才是用户真有得去的地方），不是我们会去下载的地址。
     */
    const refuse = (reason: InstallFailureReason, evidence: string): PlanResult => ({
      ok: true,
      plan: {
        method: 'nvm',
        mode,
        channel,
        version: release.version,
        url: NVM_RELEASES_PAGE,
        sourceHost: hostOf(NVM_RELEASES_PAGE),
        sha256: null,
        evidence,
        signer: null,
        releaseSigning: 'unknown',
        usable: false,
        refuseReason: reason.message,
        needsElevation: false,
        affectsRunningDsh: mode === 'update',
        display: '版本管理器的安装包',
        target: null,
        note: `${reason.message}${reason.hint ? ` ${reason.hint}` : ''}${coexist}`,
        ...facts,
      },
      unusableReason: reason,
    });

    if (await this.isElevated()) {
      return refuse(
        {
          kind: 'unsupported',
          message:
            '请不要用管理员身份运行 DSH Console 来安装版本管理器，否则它会被配置给管理员账户；可以用「直接安装官方版本」，或换一个普通权限的账户。',
          hint: '改用「直接安装官方版本」。',
        },
        '管理员身份下这条路不提供',
      );
    }

    const versionArg = release.version.replace(/^v/, '');
    // **机器上已经有一个可辨认的版本管理器时，不许再装它一遍**（冻结 §3.2.1 的 `installsManager`）：
    // 这次**没有任何东西要下载**，所以下载与校验两段整个跳过 —— 用户点的是"更新 Node"，
    // 不是"重装版本管理器"（那会多几十 MB 下载、重写它自己的偏好与 PATH 条目）。
    if (!decision.installsManager) {
      const root = model?.root ?? null;
      return {
        ok: true,
        plan: {
          method: 'nvm',
          mode,
          channel,
          version: release.version,
          // 我们**不会**去下载这个地址：它只是"这次没有任何东西要下载"时，用户真有得去的地方（发布页）
          url: NVM_RELEASES_PAGE,
          sourceHost: hostOf(NVM_RELEASES_PAGE),
          sha256: null,
          evidence: '用这台电脑上已经装好的版本管理器装 Node：不下载、不校验',
          signer: null,
          releaseSigning: 'unknown',
          usable: true,
          refuseReason: null,
          needsElevation: false,
          affectsRunningDsh: mode === 'update',
          display: `nvm install ${versionArg}`,
          target: root ? `${root}（这台电脑上已经装好的版本管理器）` : null,
          note: `${[
            `这台电脑上已经有版本管理器了，所以这次不再装它一遍、也没有任何东西要下载：直接让它装 Node.js ${release.version} 并切过去。`,
            '原来的那份 Node 不会被删掉，也不会往官方安装包的位置再放一份。',
            '装完会实测 `node --version` 与 `npm --version` 都有输出才算完成。',
          ].join(' ')}${coexist}`,
          ...facts,
        },
      };
    }

    const text = await this.fetchText(NVM_RELEASES_API);
    if (text === null) {
      return refuse(
        {
          kind: 'network',
          message: '没能取到版本管理器的发布信息（可能连不上，也可能这一会儿访问太频繁）。',
          hint: `可以稍后再试，或者用浏览器打开官方发布页自己装：${NVM_RELEASES_PAGE}`,
        },
        '这一轮没取到版本管理器的发布信息 —— 连不上或超时',
      );
    }
    const release0 = parseGithubReleases(text);
    const picked = this.pickReleaseAsset(release0, arch);
    if (!picked) {
      return refuse(
        {
          kind: 'unsupported',
          message: '版本管理器的发布里没有适合这台电脑的安装包。',
          hint: `可以用「直接安装官方版本」，或者自己到发布页装：${NVM_RELEASES_PAGE}`,
        },
        '发布里没有这台电脑架构的安装包',
      );
    }
    const { asset, release: chosen } = picked;
    const releaseSigning = parseReleaseSigning(chosen.body);

    const sha256 = assetSha256(asset);
    const nvmHome = envValue(process.env, 'NVM_HOME');
    // 界面上报的路径必须是**探测到的真路径**（VM-12 的教训：推测出来的路径会显示一条不存在的目录）：
    // 先看这台机器上真实存在的 `nvm.exe`（v2 装完 PATH 里就有它），再看 v1 的 `NVM_HOME`；
    // 都没有就**不报路径**，只说"安装程序会让你选目录"。
    const nvmExeNow = locateNvmExe({ env: process.env });
    const installTarget = nvmExeNow
      ? `${path.win32.dirname(nvmExeNow)}（这台电脑上已经装着的版本管理器目录）`
      : nvmHome
        ? `${nvmHome}（版本管理器自己的目录）`
        : '安装程序会让你选目录（默认在你的用户目录下）';

    return {
      ok: true,
      plan: {
        method: 'nvm',
        mode,
        channel,
        version: release.version,
        url: asset.browser_download_url,
        sourceHost: hostOf(asset.browser_download_url),
        sha256,
        evidence: sha256 ? '发布方在发布页给出的完整性摘要' : '这一轮没取到发布方给的完整性摘要',
        // 计划阶段的 `null` = "还没读"，不是"未签名"：界面不得据此加确认（船长裁定）
        signer: null,
        releaseSigning,
        usable: true,
        refuseReason: null,
        needsElevation: false,
        affectsRunningDsh: mode === 'update',
        display: asset.name,
        target: installTarget,
        note: `${[
          '先装一个版本管理器，再由它装 Node；不需要管理员权限。',
          '这台电脑上原来的 Node 不会被删掉，之后用哪个版本由版本管理器决定。',
          '版本管理器的安装包仍然从官方地址下载；会尽量用静默方式装到它的默认位置（不弹向导）；如果它仍然弹出了窗口，请在窗口里把向导点完，我们会等它。',
          '下载完成后会先核对完整性，再读一次安装包的数字签名；签名与内容对不上、或读到它确实没有签名，都不会安装。',
        ].join(' ')}${coexist}`,
        ...facts,
      },
    };
  }

  // -------------------------------------------------------------- 下载 / 校验

  private async transferPhase(
    plan: EnvNodePlan,
  ): Promise<
    | { kind: 'ok'; file: string }
    | { kind: 'cancelled' }
    | { kind: 'failed'; reason: InstallFailureReason }
  > {
    const dir = installTempDir();
    const fileName = this.fileNameOf(plan);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      return { kind: 'failed', reason: classifyInstallFailure(messageOf(error), null) };
    }
    this.cleanStaleTemp(dir);
    const dest = path.join(dir, fileName);
    this.tempFiles.add(dest);
    this.lastPercent = null;
    const label = plan.method === 'nvm' ? '版本管理器的安装包' : `Node.js ${plan.version}`;

    this.publish('downloading', {
      method: plan.method,
      mode: plan.mode,
      message: `正在下载 ${label}…`,
      percent: null,
      bytes: null,
      code: null,
      report: null,
    });
    this.hooks.log(
      `开始下载：${label}（来源 ${hostOf(plan.url)}${plan.sha256 ? '，有官方校验值' : '，这次没有校验值'}）`,
    );

    const outcome = await this.awaitTransfer(dest, () => this.download(plan.url, dest));
    if (outcome.kind === 'cancelled') return { kind: 'cancelled' };
    if (outcome.kind === 'failed') {
      this.removeQuietly(dest);
      return { kind: 'failed', reason: classifyInstallFailure(outcome.error, null) };
    }
    this.publish('downloading', {
      message: `正在下载 ${label}…100%`,
      percent: 100,
      bytes: { downloaded: outcome.bytes, total: outcome.total ?? outcome.bytes },
    });
    return { kind: 'ok', file: outcome.file };
  }

  private async verifyPhase(
    plan: EnvNodePlan,
    file: string,
  ): Promise<
    { kind: 'ok' } | { kind: 'cancelled' } | { kind: 'failed'; reason: InstallFailureReason }
  > {
    this.publish('verifying', {
      method: plan.method,
      mode: plan.mode,
      message: '正在校验安装包完整性',
      percent: null,
      bytes: null,
    });
    if (plan.sha256) {
      const actual = await sha256OfFile(file);
      if (actual === null) {
        this.hooks.log('校验：读不出安装包的校验值，跳过这一步（确认区里已经说明过）');
      } else if (actual.toLowerCase() !== plan.sha256.toLowerCase()) {
        this.removeQuietly(file);
        this.hooks.log('校验：与官方校验清单不一致，已删除，没有安装');
        return {
          kind: 'failed',
          reason: classifyInstallFailure('完整性校验没通过：校验值与官方清单不一致', null),
        };
      } else {
        this.hooks.log('校验：与官方校验清单一致');
        this.hooks.output(`校验通过：与官方校验清单一致\n`);
      }
    }
    if (this.cancelled) return { kind: 'cancelled' };

    // 数字签名（船长裁定：读到结果才说话，读不到 ≠ 未签名）
    //   Valid        → 记签名者，继续
    //   NotSigned    → **不安装**（读到它明确没有签名）
    //   NotTrusted   → **不安装**（签名链不被这台电脑信任 = 签名无效）
    //   HashMismatch → **不安装**（签名在，但与文件内容对不上 = 被改过）
    //   UnknownError / 其它 → 读取失败或结论不明确：继续装，但结果里如实写"这次没能读到签名"
    const signature = this.readSignature(file);
    const status = signature?.status ?? '';
    if (status === 'HashMismatch') {
      this.removeQuietly(file);
      this.hooks.log('校验：数字签名与安装包内容不一致，已删除，没有安装');
      return {
        kind: 'failed',
        reason: classifyInstallFailure('签名与安装包内容不一致，已删除', null),
      };
    }
    if (status === 'NotSigned' || status === 'NotTrusted') {
      // 发布元数据自己说是未签名构建 → 用户在确认区已经确认过这一次，可以继续
      if (plan.releaseSigning === 'unsigned') {
        this.hooks.log(
          `校验：安装包${status === 'NotSigned' ? '没有数字签名' : '的签名不被信任'}，但发布方的说明里已经声明是未签名构建（用户在确认区确认过），继续`,
        );
        this.hooks.output('安装包没有数字签名（发布方已经声明过这次是未签名构建）\n');
      } else {
        this.removeQuietly(file);
        this.hooks.log(
          `校验：安装包${status === 'NotSigned' ? '明确没有数字签名' : '的签名不被信任'}，计划里没有这一声明，已删除，没有安装`,
        );
        return {
          kind: 'failed',
          reason: unsignedFailure(
            status === 'NotSigned'
              ? '这个安装包没有数字签名，我们没有安装它。'
              : '这个安装包的签名没有被这台电脑信任，我们没有安装它。',
          ),
        };
      }
    }
    if (status === 'Valid') {
      this.hooks.log(`校验：安装包签名有效（${signature?.subject ?? '读不到签名者'}）`);
      this.hooks.output(`安装包签名：${signature?.subject ?? '有效'}\n`);
    } else {
      this.hooks.log(`校验：这次没能读到安装包的数字签名（${status || '读不到'}）`);
      this.hooks.output('这次没能读到安装包的数字签名\n');
    }
    if (this.cancelled) return { kind: 'cancelled' };
    return { kind: 'ok' };
  }

  // -------------------------------------------------------------- 安装

  private async installPhase(
    plan: EnvNodePlan,
    file: string,
  ): Promise<
    { kind: 'ok' } | { kind: 'detached' } | { kind: 'failed'; reason: InstallFailureReason }
  > {
    // 注意：「更新前先停 dsh」**不在这里**（它已经提到 `execute()` 里、任何系统改动之前，
    // 因为这条路在"管理器已经在机器上"时会被整个跳过）。搬回来就会变成停两次。
    this.publish('installing', {
      method: plan.method,
      mode: plan.mode,
      message: '正在等待安装程序',
      code: null,
      report: null,
    });
    this.hooks.log(`开始安装：${plan.display}`);

    const launched = this.launchInstaller(plan, file);
    if (!launched.ok) return { kind: 'failed', reason: launched.reason };
    // 版本管理器那条路：这次等的是它的安装程序，**如果不再等待，它退出之后还要补 nvm 两步**
    const nvmManager = plan.method === 'nvm';
    if (nvmManager) this.detachedNvmResume = true;
    const outcome = await this.waitForClose(launched.child, INSTALLER_TIMEOUT_MS);
    if (nvmManager && outcome.kind !== 'detached') this.detachedNvmResume = false;
    if (outcome.kind === 'detached') {
      this.hooks.log('安装：我们不再等待（安装器继续跑，不做结论）');
      return { kind: 'detached' };
    }
    if (outcome.kind === 'error') {
      return {
        kind: 'failed',
        reason: classifyInstallFailure(outcome.error, null),
      };
    }
    this.lastCode = outcome.code;
    // 安装器自己的原文（msiexec 把过程写进日志；设置类的安装包直接刷在 stdout 上）
    this.flushInstallerLog(launched.logFile);
    if (outcome.code === 0) return { kind: 'ok' };
    return {
      kind: 'failed',
      reason: classifyInstallFailure(launched.tail(), outcome.code),
    };
  }

  private launchInstaller(
    plan: EnvNodePlan,
    file: string,
  ):
    | { ok: true; child: ChildProcess; tail: () => string; logFile: string | null }
    | { ok: false; reason: InstallFailureReason } {
    const tailRef = { text: '' };
    const collect = (chunk: string): void => {
      tailRef.text = (tailRef.text + chunk).slice(-OUTPUT_TAIL_CHARS);
    };

    if (plan.method === 'direct') {
      const msiexec = system32('msiexec.exe');
      if (!fs.existsSync(msiexec)) {
        return {
          ok: false,
          reason: {
            kind: 'unsupported',
            message: '没找到系统自带的安装程序，这一次没法自动装。',
            hint: FAILURE_HINTS.unsupported,
          },
        };
      }
      const logFile = `${file}.install.log`;
      const args = ['/i', file, '/qb', '/norestart', '/l*v', logFile];
      const spec = launchSpec(msiexec, args, 'win32');
      this.tempFiles.add(logFile);
      this.hooks.output(`命令：${plan.display}\n`);
      return {
        ok: true,
        child: this.spawnInstaller(spec, collect),
        tail: () => tailRef.text,
        logFile,
      };
    }

    // 版本管理器的安装程序。VM-02 实测：**不带静默参数时它的许可协议窗口会一直等用户点选**，
    // 而界面只会说"安装已经在进行"，用户只能干等。所以先按安装包的真实形态给静默参数：
    // Inno Setup 用 `/VERYSILENT`（NSIS 的 `/S` 它不认），NSIS 用 `/S`；认不出来才退回可见向导，
    // 那时**必须**把"请到窗口里操作"说给用户听。
    const flavor = readInstallerFlavor(file);
    const silentArgs = installerSilentArgs(flavor);
    if (silentArgs.length > 0) {
      this.hooks.output(
        `安装器形态：${flavor === 'inno' ? 'Inno Setup' : 'NSIS'} → 用静默参数 ${silentArgs.join(' ')}（不需要你在窗口里点任何东西）\n`,
      );
      this.publish('installing', { message: '正在静默安装版本管理器（不会弹出向导）…' });
    } else {
      this.hooks.output(
        '没能认出这个安装包用的是哪家的安装器，所以不敢给静默参数：它会弹出自己的窗口，请到那个窗口里把向导点完（例如许可协议），我们会等它结束。\n',
      );
      this.publish('installing', {
        message:
          '正在等待安装程序：它有一个窗口需要你点选（例如许可协议），请到那个窗口里完成；点完之后我们会自动继续。',
      });
    }
    const spec = launchSpec(file, silentArgs, 'win32');
    this.hooks.output(
      `命令：${plan.display}${silentArgs.length ? ` ${silentArgs.join(' ')}` : ''}\n`,
    );
    return {
      ok: true,
      child: this.spawnInstaller(spec, collect),
      tail: () => tailRef.text,
      logFile: null,
    };
  }

  private spawnInstaller(spec: LaunchSpec, collect: (chunk: string) => void): ChildProcess {
    const child = spawnSpec(spec, {});
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = String(chunk);
      collect(text);
      this.hooks.output(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = String(chunk);
      collect(text);
      this.hooks.output(text);
    });
    return child;
  }

  /** msiexec 的过程写在日志里；把尾巴贴进输出区（退出码之外，用户与我们都靠它看原因） */
  private flushInstallerLog(logFile: string | null): void {
    if (!logFile) return;
    try {
      const size = fs.statSync(logFile).size;
      const start = Math.max(0, size - OUTPUT_TAIL_CHARS);
      const handle = fs.openSync(logFile, 'r');
      const buffer = Buffer.alloc(size - start);
      fs.readSync(handle, buffer, 0, buffer.length, start);
      fs.closeSync(handle);
      const text = buffer.toString('utf8');
      if (text.trim()) this.hooks.output(`${text}\n`);
      this.removeQuietly(logFile);
    } catch {
      // 日志没写出来（例如提权询问就被拒）：不影响结论，退出码已经说了
    }
  }

  /**
   * 版本管理器那条路的第二步：用它把 Node **装成真的可用**（VM-01 的修法；VM-11 按 v2 的模型重做）。
   *
   * VM-11 的客机（nvm **v2.0.0**，shim 模式）证明了两件事：
   *   1. v2 **不设** `NVM_HOME` / `NVM_SYMLINK`，PATH 里是 `<root>` 与 `<root>\.nodejs`，
   *      版本装在 `<root>\installs` —— 所以模型必须从**真实证据**推（`nvm env` / 注册表 / PATH），
   *      不能再假设 v1 的那两个变量与 `<root>\nodejs`；
   *   2. **装版本是应用自己的事**：客机 `nvm list` → `No versions installed.`，
   *      于是 `<root>\.nodejs\node.exe` 这个 shim 跑起来只说
   *      `No active Node.js version is configured. Run \`nvm install <version>\` then \`nvm use <version>\`.`
   *      —— 用户被这句话打发去终端，而我们要**自己去装**（选稳定版 → `nvm install` → `nvm use` → 复检）。
   */
  private async installNodeWithNvm(
    plan: EnvNodePlan,
  ): Promise<
    { kind: 'ok' } | { kind: 'detached' } | { kind: 'failed'; reason: InstallFailureReason }
  > {
    // 版本管理器刚装完：系统里的 **PATH 与它写的环境变量都要立刻进本进程**
    this.refreshProcessPathFromSystem();
    const probed = await this.probeNvmModel();
    if (probed === 'detached') return { kind: 'detached' };
    if (!probed) {
      return {
        kind: 'failed',
        reason: {
          kind: 'nvm-inactive',
          message: '版本管理器装完了，但我们没找到它的命令，所以没能让它装 Node。',
          hint: FAILURE_HINTS['nvm-inactive'],
        },
      };
    }
    const model = probed;
    this.hooks.log(
      `版本管理器模型：根=${model.root}；模式=${model.mode}；${model.evidence.join('；')}`,
    );
    const source = normalizeNodeSource(this.settings.get('envNodeSource'));
    const extra: NodeJS.ProcessEnv = source ? { NVM_NODEJS_ORG_MIRROR: source } : {};
    const versionArg = plan.version.replace(/^v/, '');

    // 1. 先问清现状：装了哪些、active 是谁（客机：`No versions installed.` → 空清单）
    const before = await this.readNvmList(model.exe, extra);
    if (before === 'detached') return { kind: 'detached' };
    const alreadyInstalled =
      before !== null &&
      before.versions.some((version) => compareNodeVersions(version, versionArg) === 0);
    this.hooks.log(
      `安装前盘点：装了 ${before?.versions.join(', ') || '（空）'}；active=${before?.active ?? '（没有）'}；目标 ${plan.version} ${alreadyInstalled ? '已在清单里' : '还没装'}`,
    );

    // 2. 没装就**真的装**（v2 的 `nvm install <版本>`；v1 也能跑同一条命令）
    if (!alreadyInstalled) {
      const installed = await this.runNvmCommand(
        model.exe,
        ['install', versionArg],
        NVM_INSTALL_TIMEOUT_MS,
        extra,
        `正在让它下载并安装 Node.js ${plan.version}`,
        'nvm install',
      );
      if (installed.kind !== 'ok') return installed;
      const marker = parseNvmInstallOutput(installed.tail);
      this.hooks.log(
        marker
          ? `nvm install 成功标记：Installed Node.js v${marker}`
          : 'nvm install 退出码 0，但没看到 `Installed Node.js …` 那行标记（继续用清单与实测判断）',
      );
      // 退出码之外还要**事实**：它自己的清单里有没有这个版本
      const afterInstall = await this.readNvmList(model.exe, extra);
      if (afterInstall === 'detached') return { kind: 'detached' };
      if (afterInstall === null) {
        this.hooks.log('`nvm list` 没读懂（拿不到清单）——继续走后面的实测，不在这里下结论');
      } else {
        this.hooks.log(
          `安装后盘点：装了 ${afterInstall.versions.join(', ') || '（空）'}；active=${afterInstall.active ?? '（没有）'}`,
        );
        if (
          !afterInstall.versions.some((version) => compareNodeVersions(version, versionArg) === 0)
        ) {
          return {
            kind: 'failed',
            reason: {
              kind: 'nvm-inactive',
              message: `版本管理器说装完了，但它的清单里没有 Node.js ${plan.version}。`,
              hint: FAILURE_HINTS['nvm-inactive'],
            },
          };
        }
      }
    }

    // 3. 切换：active 不是它就跑 `nvm use <版本>`
    const activeNow = before?.active ?? null;
    if (activeNow !== null && compareNodeVersions(activeNow, versionArg) === 0) {
      this.hooks.log(`当前 active 已经是 ${activeNow}，跳过 nvm use`);
    } else {
      const used = await this.useNvmVersion(model, versionArg, plan.version, extra);
      if (used.kind !== 'ok') return used;
    }

    // 4. 环境再刷新一次（v2 的 shim 目录 / v1 的软链都变了），然后实测 node 与 npm
    this.refreshProcessPathFromSystem();
    return await this.verifyActiveNode(plan, model);
  }

  /**
   * 把版本管理器的模型从真实证据里读出来：`nvm.exe` 的真路径 + `nvm env` 的报告 +
   * 注册表偏好 + 用户级 PATH 的条目。**不读 `NVM_HOME` / `NVM_SYMLINK` 当主证**（v2 不设它们）。
   *
   * 返回 `'detached'` 表示"用户点了不再等待"，`null` 表示"确实没找到版本管理器"。
   */
  private async probeNvmModel(): Promise<NvmModel | null | 'detached'> {
    const exe = this.findNvmExe();
    let report: NvmEnvReport | null = null;
    if (exe) {
      const probe = await this.runNvmCommand(
        exe,
        ['env'],
        NVM_LIST_TIMEOUT_MS,
        {},
        '正在读取版本管理器的环境报告',
        'nvm env',
      );
      if (probe.kind === 'detached') return 'detached';
      if (probe.kind === 'ok') {
        report = parseNvmEnvOutput(probe.tail);
        this.hooks.log(
          `nvm env：版本=${report.version ?? '（没给）'}；开关=${report.status ?? '（没给）'}；模式=${report.mode}；程序根=${report.programRoot ?? '（没给）'}；版本目录=${report.installsDir ?? '（没给）'}；版本数=${report.versionsTotal ?? '（没给）'}；默认=${report.defaultVersion ?? '（没设）'}`,
        );
      } else {
        this.hooks.log(
          `nvm env 没跑成（${probe.reason.kind}）——v1 没有这条命令，继续用注册表 / PATH 的证据`,
        );
      }
    }
    // v2 的安装器把偏好写在 `HKCU\Software\<发布方>\Preferences\nvm`（见 VM-11 的实测与官方安装脚本）
    const rootGuess = exe ? path.win32.dirname(exe) : envValue(process.env, 'NVM_HOME');
    if (rootGuess) {
      const registry = readNvmRegistryPreferences(rootGuess);
      if (registry) {
        report = {
          version: registry.version ?? report?.version ?? null,
          status: registry.status ?? report?.status ?? null,
          mode: registry.mode !== 'unknown' ? registry.mode : (report?.mode ?? 'unknown'),
          installsDir: registry.installsDir ?? report?.installsDir ?? null,
          versionsTotal: report?.versionsTotal ?? null,
          defaultVersion: registry.defaultVersion ?? report?.defaultVersion ?? null,
          programRoot: report?.programRoot ?? rootGuess,
          nodeMirror: report?.nodeMirror ?? null,
          npmMirror: report?.npmMirror ?? null,
        };
        this.hooks.log(
          `注册表偏好：InstallRoot=${registry.installsDir ?? '（没给）'}；OperatingMode=${registry.mode}；ActiveVersion=${registry.defaultVersion ?? '（没设）'}`,
        );
      }
    }
    const pathDirs = String(process.env.Path ?? process.env.PATH ?? '')
      .split(path.delimiter)
      .map((dir) => dir.trim())
      .filter(Boolean);
    return deriveNvmModel({ exe, env: process.env, report, pathDirs });
  }

  /** 每一条版本管理器命令的**可诊断证据**：命令 / 退出码 / stdout / stderr（空的那路写「（空）」） */
  private logNvmStep(
    label: string,
    args: string[],
    code: number | null,
    stdout: string,
    stderr: string,
  ): void {
    const show = (text: string): string => {
      const trimmed = String(text ?? '').trim();
      return trimmed ? trimmed.slice(-STEP_EVIDENCE_CHARS) : '（空）';
    };
    this.hooks.log(
      `${label}：nvm ${args.join(' ')} → 退出码 ${code ?? '未知'}；stdout：${show(stdout)}；stderr：${show(stderr)}`,
    );
  }

  /** 跑一条版本管理器命令：看退出码、收输出（`nvm install` / `nvm use` / `nvm list` / `nvm env` 共用） */
  private async runNvmCommand(
    nvm: string,
    args: string[],
    timeoutMs: number,
    extra: NodeJS.ProcessEnv,
    label: string,
    /** 写日志用的步骤名（默认取子命令名）；证据里要能认出是哪一步 */
    step?: string,
  ): Promise<
    | { kind: 'ok'; tail: string; code: number | null }
    | { kind: 'detached' }
    | { kind: 'failed'; reason: InstallFailureReason; tail: string }
  > {
    const name = step ?? args[0] ?? 'nvm';
    this.publish('installing', { message: label, code: null, report: null });
    this.hooks.output(`命令：${path.basename(nvm)} ${args.join(' ')}\n`);
    const spec = launchSpec(nvm, args, 'win32');
    const child = spawnSpec(spec, extra);
    this.child = child;
    // stdout / stderr **分开收**：验收要求每一步都能在 console.log 里看到
    // 「命令 / 退出码 / stdout / stderr（空的那路写（空））」，合并成一个尾巴就分不清了。
    const outRef = { text: '' };
    const errRef = { text: '' };
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = String(chunk);
      outRef.text = (outRef.text + text).slice(-OUTPUT_TAIL_CHARS);
      this.hooks.output(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = String(chunk);
      errRef.text = (errRef.text + text).slice(-OUTPUT_TAIL_CHARS);
      this.hooks.output(text);
    });
    const outcome = await this.waitForClose(child, timeoutMs);
    const tail = (outRef.text + errRef.text).slice(-OUTPUT_TAIL_CHARS);
    if (outcome.kind === 'detached') {
      this.logNvmStep(`${name}（不再等待）`, args, null, outRef.text, errRef.text);
      return { kind: 'detached' };
    }
    if (outcome.kind === 'error') {
      this.logNvmStep(name, args, null, outRef.text, errRef.text);
      return {
        kind: 'failed',
        reason: classifyInstallFailure(outcome.error, null),
        tail,
      };
    }
    this.lastCode = outcome.code;
    this.logNvmStep(name, args, outcome.code, outRef.text, errRef.text);
    if (outcome.code !== 0) {
      return {
        kind: 'failed',
        reason: classifyInstallFailure(`${args[0]}: ${tail}`, outcome.code),
        tail,
      };
    }
    return { kind: 'ok', tail, code: outcome.code };
  }

  /** 问一次版本管理器自己的清单（`nvm list`）；跑不动或读不懂都返回 null，由调用方决定怎么办 */
  private async readNvmList(
    nvm: string,
    extra: NodeJS.ProcessEnv,
  ): Promise<NvmListOutput | null | 'detached'> {
    const listing = await this.runNvmCommand(
      nvm,
      ['list'],
      NVM_LIST_TIMEOUT_MS,
      extra,
      '正在确认已安装的 Node 版本',
    );
    if (listing.kind === 'detached') return 'detached';
    if (listing.kind === 'failed') return null;
    return parseNvmListOutput(listing.tail);
  }

  /**
   * `nvm use <版本>`（v2 的 shim 模式 / v1 的 link 模式都走这一条）。
   *
   * **权限模型据实收窄（VM-11 第 5 条）**：v2 的官方说明是
   * 「Shim mode - no symlinks, fast (written in Zig)」「No mandatory administrator privileges」
   * —— 客机也是 `Developer Mode: Disabled` + 非管理员而链路照样走通。
   * 所以**只有 link/symlink 模式**（v1 那种要建 junction/symlink 的）才走一次性提权；
   * shim 模式失败时**不弹 UAC**，如实报错并说明模式（不再对 v2 做一次没必要的提权）。
   */
  private async useNvmVersion(
    model: NvmModel,
    versionArg: string,
    displayVersion: string,
    extra: NodeJS.ProcessEnv,
  ): Promise<
    { kind: 'ok' } | { kind: 'detached' } | { kind: 'failed'; reason: InstallFailureReason }
  > {
    const first = await this.runNvmCommand(
      model.exe,
      ['use', versionArg],
      NVM_USE_TIMEOUT_MS,
      extra,
      `正在切到 Node.js ${displayVersion}`,
      'nvm use',
    );
    if (first.kind === 'ok') {
      const marker = parseNvmUseOutput(first.tail);
      this.hooks.log(
        marker
          ? `nvm use 成功标记：Now using Node.js v${marker} by default.`
          : 'nvm use 退出码 0，但没看到 `Now using Node.js …` 那行标记（继续用实测判断）',
      );
      return { kind: 'ok' };
    }
    if (first.kind === 'detached') return { kind: 'detached' };
    const privilege =
      first.reason.kind === 'symlink' ||
      /sufficient privileges|symbolic link|symlink|junction|SeCreateSymbolicLinkPrivilege|拒绝访问/i.test(
        first.tail,
      );
    if (!privilege) return { kind: 'failed', reason: first.reason };

    // 权限类失败：先看模式。v2 的 shim 模式**不需要**提权建链接 —— 那时弹 UAC 是没必要的。
    if (model.mode === 'shim') {
      this.hooks.log(
        `nvm use 失败看起来是权限类，但模型是 shim 模式（v2 无符号链接、官方说明不需要管理员）——不请求提权，照实报`,
      );
      return { kind: 'failed', reason: first.reason };
    }

    const developerMode = readDeveloperMode();
    const elevatedNow = await this.isElevated();
    this.hooks.log(
      `nvm use 失败（${model.mode === 'link' ? 'link 模式要建链接' : '模式未知'}，需要权限）；开发者模式：${developerMode ? '已开启' : '未开启'}；当前进程${elevatedNow ? '是' : '不是'}管理员`,
    );
    if (elevatedNow || developerMode) {
      // 已经是管理员、或开发者模式本来就能建链接，仍然失败 → 如实报（再弹 UAC 也解决不了）
      return {
        kind: 'failed',
        reason: {
          kind: 'symlink',
          message: FAILURE_MESSAGES.symlink,
          hint: FAILURE_HINTS.symlink,
        },
      };
    }

    const elevated = await this.runElevated(model.exe, ['use', versionArg]);
    if (elevated.kind === 'ok') {
      this.hooks.log('一次性提权成功，链接已创建');
      return { kind: 'ok' };
    }
    if (elevated.kind === 'stopped') {
      // 用户点了「不再等待」、或提权进程还在跑：保持"未确定"，由事实/用户确认收尾
      this.hooks.log('提权那一步没有结论（停止等待或进程仍在跑）：保持"未确定"');
      return { kind: 'detached' };
    }
    this.hooks.log(`一次性提权没有完成（${elevated.kind}）：${elevated.text.trim().slice(0, 200)}`);
    // 三种"没成功"各自有自己的类别与文案（超时**不许**归成"没权限"：F-02 第 1 条）
    return { kind: 'failed', reason: elevationFailure(elevated.kind) };
  }

  /**
   * 一次性提权跑一条命令（`Start-Process -Verb RunAs -Wait -PassThru`）：只弹一次 UAC。
   *
   * **异步、先说后做**（F-03）：`publish` 那条"正在请求一次管理员权限、请在弹出的窗口里选择"
   * 排在 `spawn` **之前**，而且整段不阻塞事件循环 —— UAC 对话框出现时界面已经渲染出了这句话；
   * 以前用 `spawnSync` 时主进程会停住，用户看到的是"应用卡死"，连要不要点 UAC 都不知道。
   *
   * 四种结果（F-02）：`ok` / `declined`（用户没允许）/ **`timeout`**（我们等太久）/ `failed`。
   * 超时**不杀**这个 PowerShell（它 `-Wait` 的那个提权进程是独立的，可能还在把链接建好），
   * 也**不当成"没权限"**：先按"未确定"发布，再用事实复检决定结论（`settleElevationTimeout`）。
   */
  private async runElevated(
    file: string,
    args: string[],
  ): Promise<{ kind: ElevationOutcome | 'stopped'; text: string }> {
    // 可注入边界（F-02 第 3 条）：夹具可以把四种结果真跑出来，不必真的有 UAC
    const injected = this.hooks.elevate;
    if (injected) {
      const outcome = await injected({ file, args });
      return { kind: outcome, text: `（注入的提权执行器返回 ${outcome}）` };
    }
    const shell = this.powerShell();
    if (!shell) {
      return { kind: 'failed', text: '这台电脑上找不到 PowerShell，没法请求一次权限。' };
    }
    const script = [
      `$p = Start-Process -FilePath ${psQuote(file)} -ArgumentList ${args.map((arg) => psQuote(arg)).join(',')} -Verb RunAs -Wait -PassThru`,
      `[pscustomobject]@{ ExitCode = $p.ExitCode } | ConvertTo-Json -Compress`,
    ].join('; ');
    // 顺序是这条修复的一部分：状态先出去，再起进程
    this.publish('installing', { message: ELEVATION_WAITING_MESSAGE, code: null, report: null });
    this.hooks.output(
      '这一步要在系统里创建一个链接，普通权限做不到，所以会弹一次权限询问；允许之后我们会继续。\n',
    );
    const spec = launchSpec(shell, ['-NoProfile', '-NonInteractive', '-Command', script], 'win32');
    const child = spawnSpec(spec, {});
    this.child = child;
    let text = '';
    const collect = (chunk: Buffer): void => {
      const raw = String(chunk);
      text = (text + raw).slice(-OUTPUT_TAIL_CHARS);
      this.hooks.output(raw);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const outcome = await this.waitForClose(child, ELEVATED_TIMEOUT_MS, 'stop-waiting');
    if (outcome.kind === 'timeout') return await this.settleElevationTimeout(text);
    if (outcome.kind === 'detached') return { kind: 'stopped', text };
    return {
      kind: classifyElevationOutcome({
        code: outcome.kind === 'exit' ? outcome.code : null,
        stdout: text,
        stderr: '',
        error: outcome.kind === 'error' ? outcome.error : null,
        timedOut: false,
      }),
      text,
    };
  }

  /**
   * 提权**等太久**的收尾（F-02 第 2 条）：在事实复检之前**不下结论**。
   *
   * - 复检证明链接已经建好 → 改口说"已经落地"，继续往下走（这是"机器真的被改了、
   *   界面却说没完成"那条的唯一堵法）；
   * - 那个提权进程还在跑 → 保持**未确定**（锁继续持有；它退出时 `finishDetached` 会再复检一次）；
   * - 进程已经结束、链接也没建起来 → 现在才可以下结论：`elevation-timeout`
   *   （**不是** `symlink` —— 我们等超时了，不等于用户没权限）。
   */
  private async settleElevationTimeout(
    text: string,
  ): Promise<{ kind: ElevationOutcome | 'stopped'; text: string }> {
    this.holding = true;
    this.detachedFlag = true;
    this.publish('waiting', {
      message: ELEVATION_TIMEOUT_MESSAGE,
      percent: null,
      bytes: null,
      code: null,
      report: null,
      detached: true,
    });
    this.hooks.log('提权：等待权限询问超时（不杀那个进程）；先按"未确定"发布，再用事实复检');
    if (this.recheckActiveNodeLanded()) {
      this.holding = false;
      this.detachedFlag = false;
      this.hooks.log('提权超时之后复检发现链接已经建好 → 按"已经落地"继续');
      this.hooks.output('复检发现链接已经建好，继续。\n');
      return { kind: 'ok', text };
    }
    if (this.child !== null) {
      // 提权进程还在跑：不许下结论（它可能马上就建好了）
      this.detachedWatch = true;
      this.hooks.log('提权进程还在跑：保持"未确定"（锁继续持有，等它退出或用户确认）');
      return { kind: 'stopped', text };
    }
    this.holding = false;
    this.detachedFlag = false;
    this.hooks.log('提权进程已经结束、链接仍没建起来 → 按"等太久"下结论（不是"没权限"）');
    return { kind: 'timeout', text };
  }

  /**
   * 事实复检：**现在到底有没有一个能跑的 Node**。
   *
   * 判据不是"某个目录在不在"，而是**真的跑一次**（v2 的 shim 会自己派发；没有 active 版本时
   * 它会照实说 `No active Node.js version is configured…`，那句话**不算可用**）。
   * 先问 PATH 解析到的那个 node（用户机器上真在用的就是这个），再问模型给的目录。
   */
  private recheckActiveNodeLanded(): boolean {
    this.refreshProcessPathFromSystem();
    const fromPath = whichSync('node') ?? findNodeExe();
    if (fromPath && fs.existsSync(fromPath)) {
      const probe = this.probeCommand(fromPath, ['--version']);
      this.hooks.output(`复检：${fromPath} --version → ${probe.text.trim() || '（没有输出）'}\n`);
      if (hasNodeVersionOutput(probe.text) && !isInactiveNodeShimOutput(probe.text)) return true;
    }
    return false;
  }

  /**
   * 收尾实测：**`<node> --version` 与 `<npm> --version` 都要真的拿到输出**才算这一步完成。
   *
   * 这条就是 VM-01 / VM-11 的判据（不是"nvm.exe 存在"，也不是"某个目录存在"）：
   * 没有 active version 时 v2 的 shim 会照实说
   * `No active Node.js version is configured. Run \`nvm install <version>\` then \`nvm use <version>\`.`
   * —— **那句话不算可用**（这里有专门一条 `isInactiveNodeShimOutput` 认它）。
   *
   * 探谁：**优先 PATH 解析到的那个 node**（用户机器上真在用的就是它，v2 是 `<root>\.nodejs`、
   * v1 是软链目录；不再自己拼一个"应该是"的路径 —— VM-12 的教训），模型给的目录作为补充证据。
   */
  private async verifyActiveNode(
    plan: EnvNodePlan,
    model: NvmModel,
  ): Promise<{ kind: 'ok' } | { kind: 'failed'; reason: InstallFailureReason }> {
    const fromPath = whichSync('node') ?? findNodeExe();
    const fromModel =
      model.activeDir && fs.existsSync(path.win32.join(model.activeDir, 'node.exe'))
        ? path.win32.join(model.activeDir, 'node.exe')
        : null;
    // v1 风格的机器：真设了 `NVM_SYMLINK` 且那里真有 node.exe 时也探一下（**以真实存在的为准**，
    // 不是假设；v2 不设这个变量，所以这里通常不会加进来 —— VM-11 的教训）
    const symlinkDir = envValue(process.env, 'NVM_SYMLINK');
    const fromSymlink =
      symlinkDir && fs.existsSync(path.win32.join(symlinkDir, 'node.exe'))
        ? path.win32.join(symlinkDir, 'node.exe')
        : null;
    const targets: string[] = [];
    for (const candidate of [fromPath, fromModel, fromSymlink]) {
      if (candidate && !targets.includes(candidate)) targets.push(candidate);
    }
    if (targets.length === 0) targets.push(''); // 一个都没有 → 走下面那条"找不到 node"的失败

    let nodeText = '';
    let usedNode = '';
    for (const target of targets) {
      const probe = this.probeCommand(target || null, ['--version']);
      this.hooks.output(
        `实测：${target || '（没找到 node）'} --version → ${probe.text.trim() || '（没有输出）'}\n`,
      );
      nodeText = probe.text;
      usedNode = target;
      if (hasNodeVersionOutput(probe.text) && !isInactiveNodeShimOutput(probe.text)) break;
    }
    if (!hasNodeVersionOutput(nodeText) || isInactiveNodeShimOutput(nodeText)) {
      const evidence = nodeText.trim() || '零输出';
      this.hooks.log(
        `nvm 收尾实测失败：${usedNode || '（没找到 node）'} 跑不出可用版本 → ${evidence.slice(0, 200)}`,
      );
      return {
        kind: 'failed',
        reason: {
          kind: 'nvm-inactive',
          message: isInactiveNodeShimOutput(nodeText)
            ? '版本管理器的 shim 还在说"没有激活任何版本"，所以这一步没有完成。'
            : '装完了，但这一步没能让 Node 跑起来（node --version 没有输出）。',
          hint: FAILURE_HINTS['nvm-inactive'],
        },
      };
    }
    // npm 要找**和刚才那个 node 同一个目录**里的那份（v2 的 shim 就在旁边），否则退回 PATH
    const npmBeside = usedNode ? path.win32.join(path.win32.dirname(usedNode), 'npm.cmd') : null;
    const npmTarget = npmBeside && fs.existsSync(npmBeside) ? npmBeside : whichSync('npm');
    const npmProbe = this.probeCommand(npmTarget, ['--version']);
    this.hooks.output(
      `实测：${npmTarget ?? '（没找到 npm）'} --version → ${npmProbe.text.trim() || '（没有输出）'}\n`,
    );
    if (!hasNodeVersionOutput(npmProbe.text)) {
      const classified = classifyInstallFailure(npmProbe.text, npmProbe.code);
      this.hooks.log(
        `nvm 收尾实测失败：npm --version 没拿到版本号 → ${npmProbe.text.trim().slice(0, 200) || '零输出'}`,
      );
      return {
        kind: 'failed',
        reason:
          classified.kind === 'nvm-inactive'
            ? classified
            : {
                kind: 'nvm-inactive',
                message: '装完了，但这一步没能让 npm 跑起来（npm --version 没有输出）。',
                hint: FAILURE_HINTS['nvm-inactive'],
              },
      };
    }
    // `nvm list` 的 active 也记一行（证据：谁在生效），但它不是判据 —— 判据是上面两条实测
    if (model.exe) {
      const source = normalizeNodeSource(this.settings.get('envNodeSource'));
      const extra = source ? { NVM_NODEJS_ORG_MIRROR: source } : {};
      const listing = await this.readNvmList(model.exe, extra);
      if (listing !== 'detached' && listing !== null) {
        this.hooks.log(
          `nvm 收尾：active=${listing.active ?? '（没有）'}；装了 ${listing.versions.join(', ') || '（空）'}`,
        );
        if (listing.active && compareNodeVersions(listing.active, plan.version) !== 0) {
          this.hooks.output(
            `注意：版本管理器当前激活的是 ${listing.active}，这次装的是 ${plan.version}。\n`,
          );
        }
      }
    }
    return { kind: 'ok' };
  }

  /** 跑一次 `<file> --version` 这类实测：拿到退出码与（stdout+stderr 的）原文，失败不抛 */
  private probeCommand(file: string | null, args: string[]): { code: number | null; text: string } {
    if (!file) return { code: null, text: '' };
    const probe = runProbe(file, args, PROBE_TIMEOUT_MS);
    const text = `${probe.stdout}${probe.stderr}${probe.error ? `\n${probe.error}` : ''}`;
    return { code: probe.code, text };
  }

  /** 更新前停掉本应用启动的 dsh：失败只记一行（不让它挡住整条通道，安装器的退出码会说话） */
  private async stopDshForUpdate(): Promise<void> {
    try {
      await this.hooks.stopDsh();
      this.hooks.log('更新前已停止本应用启动的 dsh');
    } catch (error) {
      this.hooks.log(`更新前停 dsh 失败（继续安装，安装器自己会说结果）：${messageOf(error)}`);
    }
  }

  // -------------------------------------------------------------- 收尾

  private async settleSuccess(plan: EnvNodePlan): Promise<EnvInstallState> {
    this.refreshProcessPathFromSystem();
    // **实测**：装完必须真的跑一次 `<新 node> --version` 并拿到输出才算成功 ——
    // 安装器的退出码只说"它自己退出了"，说不了"这台电脑上现在有一个能跑的 Node"
    const observed = this.probeInstalledNode();
    this.publish('rechecking', { message: '正在重新检测' });
    const report = await this.safeRecheck();
    if (!report) {
      return this.publish('error', {
        message: '装完了，但这一轮没能重新检测。重开一次应用再检测一次。',
        report: null,
      });
    }
    const terminalNote = '其它已经打开的终端窗口需要重开一次，才会用上新装的 Node。';
    if (!observed || this.nodeMissing(report)) {
      // 装完了但没找到（或找不到能跑的）：**不算成功**，出路交给界面（交互规格 §4.5）
      this.hooks.log(
        `安装结束，但没能实测到可用的 Node（路径 ${observed?.path ?? '没找到'}，输出 ${observed?.version ?? '无'}）`,
      );
      this.discardTempDir();
      return this.publish('error', {
        message: `装完了，但我们还没找到 Node。${terminalNote}也可以重开一次应用。`,
        report,
        observedVersion: null,
      });
    }
    this.hooks.log(`安装完成并实测通过：${observed.path} → ${observed.version}`);
    // 装完了、复检也认了，我们落过的临时文件（安装包与安装日志）就没有用处了
    this.discardTempDir();
    const sameTarget = observed.version === plan.version;
    return this.publish('done', {
      message: sameTarget
        ? `Node.js ${observed.version} 装好了，这一项已经变成「正常」。${terminalNote}`
        : // 实测到的版本与这次装的目标不一样（例如系统查找路径里还排着一个旧的 Node）：
          // 照实说，别把"装好了"说成"你正在用的就是它"
          `装完了。现在这台电脑上找到的是 ${observed.version}（这次装的是 ${plan.version}）。${terminalNote}`,
      report,
      // 「更新后版本」必须是**实测**到的那个（冻结 §3.2.1）：目标版本不许冒充实测版本
      observedVersion: observed.version,
    });
  }

  /**
   * 读**当前这份 Node** 的版本号（`vX.Y.Z`）——`EnvNodePlan.currentVersion` 的事实来源。
   *
   * 异步（不阻塞主进程）、认不出就 `null`（**不猜**：档位跟着它走，猜错就是 VM-15 那种"看起来像降级"）。
   */
  private async readNodeVersion(nodePath: string): Promise<string | null> {
    const probe = await runProbeAsync(nodePath, ['--version'], PROBE_TIMEOUT_MS);
    const line = `${probe.stdout}${probe.stderr}`
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => hasNodeVersionOutput(item));
    if (!line) {
      if (probe.error) this.hooks.log(`没能读到当前这份 Node 的版本：${probe.error}`);
      return null;
    }
    const match = /v?\d+\.\d+(?:\.\d+)?/.exec(line);
    if (!match) return null;
    return match[0].startsWith('v') ? match[0] : `v${match[0]}`;
  }

  /**
   * 实测一次：找到的 node 跑 `--version` 有没有输出（有输出才算可用，与阶段一
   * `canRunDsh` 的判据同一条：dsh 在跑不动的 Node 上是"退出码 0 + 零输出"）。
   */
  private probeInstalledNode(): { path: string; version: string } | null {
    const nodePath = this.probeNodePath();
    if (!nodePath) return null;
    const probe = runProbe(nodePath, ['--version'], PROBE_TIMEOUT_MS);
    if (probe.error) {
      this.hooks.log(`实测新装的 Node 没能跑起来：${probe.error}`);
      return null;
    }
    const version = String(probe.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => hasNodeVersionOutput(line));
    if (!version) return null;
    return { path: nodePath, version };
  }

  private async settleCancelledDownload(): Promise<EnvInstallState> {
    this.hooks.log('安装：用户取消了下载（临时文件已删，系统上没有任何改动）');
    this.discardTempDir();
    this.holding = false;
    return this.publish('cancelled', {
      message: '已取消下载，这台电脑上什么都没改。',
      percent: null,
      bytes: null,
    });
  }

  /**
   * 失败收尾。**起了安装器的失败必须由复检事实说话**：
   * 「这台电脑上什么都没改」这句话只有在复检仍然说"缺"的时候才成立；
   * 复检说已经正常，那就照实说"其实已经落地"。
   */
  private async settleFailure(
    reason: InstallFailureReason,
    installerRan: boolean,
  ): Promise<EnvInstallState> {
    this.hooks.log(
      `环境安装失败：${reason.kind} → ${reason.message}${reason.hint ? `（${reason.hint}）` : ''}`,
    );
    if (!installerRan) {
      this.holding = false;
      this.discardTempDir();
      return this.publish('error', {
        message: visibleFailureText(reason),
        percent: null,
        bytes: null,
        report: null,
        observedVersion: null,
      });
    }
    this.refreshProcessPathFromSystem();
    this.publish('rechecking', { message: '正在重新检测' });
    const report = await this.safeRecheck();
    if (!report) {
      return this.publish('error', {
        message: `${visibleFailureText(reason)} 我们也没能重新检测（重开一次应用再看）。`,
        report: null,
      });
    }
    if (!this.nodeMissing(report)) {
      this.hooks.log('安装报错，但复检显示 Node 已经可用（以事实为准）');
      this.discardTempDir();
      return this.publish('done', {
        message: '安装其实已经落地：复检显示 Node 这一项已经正常。',
        report,
      });
    }
    this.discardTempDir();
    return this.publish('error', { message: visibleFailureText(reason), report });
  }

  /** 用户点了「我确认安装已经结束」：锁已经松开，但结论仍然由复检给 */
  private async confirmDetached(): Promise<void> {
    if (this.detachedSettling) return;
    this.detachedSettling = true;
    this.detachedWatch = false;
    this.refreshProcessPathFromSystem();
    this.publish('rechecking', { message: '正在重新检测', detached: true });
    const report = await this.safeRecheck();
    this.detachedFlag = false;
    // 用户已经确认安装结束，我们落下的临时文件（安装包 / 日志）不再需要
    this.discardTempDir();
    this.detachedSettling = false;
    if (!report) {
      this.publish('error', {
        message: '这一轮没能重新检测。重开一次应用再看。',
        detached: false,
        report: null,
        observedVersion: null,
      });
      return;
    }
    if (this.nodeMissing(report)) {
      this.publish('error', {
        message: '安装结束了，但复检显示这一项还是缺的。',
        detached: false,
        report,
        observedVersion: this.probeInstalledNode()?.version ?? null,
      });
      return;
    }
    this.publish('done', {
      message: '复检显示 Node 这一项已经正常。',
      detached: false,
      report,
      observedVersion: this.probeInstalledNode()?.version ?? null,
    });
  }

  /** 复检：注入的钩子说不清楚时只记一行、返回 null（**不编结论**） */
  private async safeRecheck(): Promise<EnvDoctorReport | null> {
    try {
      return await this.hooks.recheck();
    } catch (error) {
      this.hooks.log(`重新检测没能跑完：${messageOf(error)}`);
      return null;
    }
  }

  private nodeMissing(report: EnvDoctorReport): boolean {
    return (report.checks.find((check) => check.id === 'node')?.status ?? 'missing') === 'missing';
  }

  private publish(
    phase: EnvInstallState['phase'],
    patch: Partial<EnvInstallState>,
  ): EnvInstallState {
    const cancellable = phase === 'preparing' || phase === 'downloading' || phase === 'verifying';
    const next: EnvInstallState = {
      phase,
      method: this.current.method,
      mode: this.current.mode,
      percent: null,
      bytes: null,
      cancellable,
      detached: this.detachedFlag,
      message: null,
      code: this.lastCode,
      report: null,
      // 计划与实测版本要**跨页面重挂载**都能读到（冻结 §3.2.1 的 `EnvInstallState` 增量）：
      // 界面不许靠"我这次会话里记着计划"来渲染进度与收尾，收尾的"更新后版本"也必须是实测到的那个
      plan: this.current.plan,
      observedVersion: this.current.observedVersion,
      ...patch,
    };
    this.current = next;
    // 终态之后不再需要这一轮的计划（`finishDetached` 的补做只在未确定期间发生）
    if (phase === 'done' || phase === 'cancelled' || phase === 'error') this.activePlan = null;
    this.hooks.state(this.state());
    return this.state();
  }

  // -------------------------------------------------------------- 下载、等待与系统事实

  /** 下载（注入的下载器优先；默认走 Electron 的网络栈，遵循系统代理） */
  private download(url: string, dest: string): Promise<TransferResult> {
    if (this.hooks.download) {
      return this.hooks.download(url).then((result) => ({
        kind: 'ok',
        file: result.file,
        bytes: result.bytes,
        total: result.total,
      }));
    }
    return this.downloadWithElectron(url, dest);
  }

  /**
   * 等一次下载：用户点「取消下载」时**立刻放手**（不等对方真的停），
   * 临时文件在对方终于结束之后再删 —— 这样"取消"不会让界面卡在一个不响应的等待里。
   * `work()` **只起一次**（两次调用就是两次下载）。
   */
  private async awaitTransfer(
    dest: string,
    work: () => Promise<TransferResult>,
  ): Promise<TransferOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: TransferOutcome): void => {
        if (settled) return;
        settled = true;
        this.releaseTransfer = null;
        resolve(value);
      };
      const started = work();
      this.releaseTransfer = () => {
        this.abortTransfer();
        // 对方可能还在写文件：等它终于结束再清（清不掉就留给下一轮的残留清理）
        void started.then(
          () => this.removeQuietly(dest),
          () => this.removeQuietly(dest),
        );
        finish({ kind: 'cancelled' });
      };
      started.then(
        (value) => finish(value),
        (error: unknown) => finish({ kind: 'failed', error: messageOf(error) }),
      );
    });
  }

  private downloadWithElectron(url: string, dest: string): Promise<TransferResult> {
    return new Promise((resolve, reject) => {
      const net = electronNet();
      if (!net) {
        reject(new Error('ENOTSUP: 这次没有可用的下载通道（不在应用里运行）'));
        return;
      }
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let stream: fs.WriteStream | null = null;
      let request: NetRequest | null = null;
      const stopTimer = (): void => {
        if (timer) clearTimeout(timer);
        timer = null;
      };
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        stopTimer();
        this.downloadAbort = null;
        action();
      };
      const abort = (): void => {
        try {
          request?.abort();
        } catch {
          // 已经结束
        }
        stream?.destroy();
      };
      try {
        request = net.request({ method: 'GET', url, redirect: 'follow' });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.downloadAbort = abort;
      timer = setTimeout(() => {
        abort();
        finish(() => reject(new Error('ETIMEDOUT: 下载超时')));
      }, TRANSFER_TIMEOUT_MS);
      timer.unref?.();

      request.on('error', (error: Error) => {
        finish(() => reject(new Error(`ENETWORK: ${error.message}`)));
      });
      request.on('response', (response: NetResponse) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          abort();
          finish(() => reject(new Error(`ENETWORK: HTTP ${response.statusCode}`)));
          return;
        }
        const total = contentLength(response.headers);
        let downloaded = 0;
        stream = fs.createWriteStream(dest);
        stream.on('error', (error: Error) => {
          abort();
          finish(() => reject(error));
        });
        stream.on('finish', () => {
          finish(() => resolve({ kind: 'ok', file: dest, bytes: downloaded, total }));
        });
        response.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          stream?.write(chunk);
          this.reportProgress(downloaded, total);
        });
        response.on('end', () => {
          stream?.end();
        });
        response.on('error', (error: Error) => {
          abort();
          finish(() => reject(new Error(`ENETWORK: ${error.message}`)));
        });
      });
      request.end();
    });
  }

  /** 下载进度：算得出百分比才给（算不出就不画进度条）；百分比没变就不推 */
  private reportProgress(downloaded: number, total: number | null): void {
    const percent =
      total && total > 0 ? Math.min(100, Math.floor((downloaded / total) * 100)) : null;
    if (percent !== null && percent === this.lastPercent) return;
    this.lastPercent = percent;
    const label = this.current.method === 'nvm' ? '版本管理器的安装包' : 'Node.js';
    this.publish('downloading', {
      message: percent === null ? `正在下载 ${label}…` : `正在下载 ${label}…${percent}%`,
      percent,
      bytes: total ? { downloaded, total } : null,
    });
  }

  /**
   * 等一个子进程收尾。四种结果：正常退出 / 没起来 / **我们不再等待** / **等待上限到了**。
   *
   * 两个"没等到"的差别（F-02）：
   * - `detach`（默认，安装器与版本管理器命令用）：超时 = 我们不再等待 —— 发布未确定结论、
   *   互斥位继续持有、**不杀**（把安装器杀在半路比不装更糟）；
   * - `stop-waiting`（提权那趟用）：超时只把控制权交回调用方，**不清锁、不发结论** ——
   *   调用方要先做事实复检，再决定是"其实已经落地"还是"等太久"（见 `settleElevationTimeout`）。
   */
  private waitForClose(
    child: ChildProcess,
    timeoutMs: number,
  ): Promise<Exclude<CloseOutcome, { kind: 'timeout' }>>;
  private waitForClose(
    child: ChildProcess,
    timeoutMs: number,
    onTimeout: 'stop-waiting',
  ): Promise<CloseOutcome>;
  private waitForClose(
    child: ChildProcess,
    timeoutMs: number,
    onTimeout: 'detach' | 'stop-waiting' = 'detach',
  ): Promise<CloseOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (value: CloseOutcome): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        this.releaseWait = null;
        resolve(value);
      };
      const detach = (): void => {
        this.detachedFlag = true;
        this.holding = true;
        this.detachedWatch = true;
        this.publish('waiting', {
          percent: null,
          bytes: null,
          message: DETACHED_MESSAGE,
          code: null,
          report: null,
        });
        this.hooks.log('安装：不再等待（安装器继续跑，不做结论，互斥位仍然持有）');
        finish({ kind: 'detached' });
      };
      timer = setTimeout(() => {
        if (onTimeout === 'stop-waiting') {
          // 把结论留给调用方（它要先复检事实）；这里**不**改锁、**不**发任何结论
          this.hooks.log('等待上限到了（stop-waiting）：交回调用方做事实复检');
          finish({ kind: 'timeout' });
          return;
        }
        detach();
      }, timeoutMs);
      timer.unref?.();
      this.releaseWait = detach;
      child.on('error', (error: Error) => {
        this.child = null;
        if (this.detachedWatch) {
          // 已经不再等待了：错误不当结论，但要收尾（后台复检，见 finishDetached）
          this.detachedWatch = false;
          void this.finishDetached(null);
          return;
        }
        finish({ kind: 'error', error: error.message });
      });
      child.on('close', (code: number | null) => {
        this.child = null;
        if (this.detachedWatch) {
          // 冻结文档 R-06 的第 ① 条：不再等待之后安装器**真的结束了**，
          // 那就用复检事实决定锁还在不在（装成了就解锁并给结论；没装成继续保持未确定）
          this.detachedWatch = false;
          void this.finishDetached(code);
          return;
        }
        finish({ kind: 'exit', code });
      });
    });
  }

  /**
   * 「不再等待」之后安装器终于退出：**用复检事实说话**（R-06 第 ① 条）。
   *
   * - 复检证明这一步已经不再缺 → 解开互斥位、把结论从"未确定"改成事实；
   * - 复检仍然说缺 → **保持"未确定"与互斥位**（界面照旧给「重新检测」与「我确认安装已经结束」，
   *   后者的第二条路是 `stop()` 再点一次，第三条是应用重启）。
   */
  private async finishDetached(code: number | null): Promise<void> {
    if (!this.holding || this.detachedSettling) return;
    this.detachedSettling = true;
    try {
      this.lastCode = code;
      this.refreshProcessPathFromSystem();
      // VM 实测补的一步：我们"不再等待"的那一次如果是**版本管理器的安装程序**
      // （用户在它自己的窗口里点了很久才点完），它退出之后要把 nvm 的两步补完 ——
      // 不补的话就会停在"版本管理器装好、但没有 active Node"，下一步 npm 必然报
      // `No active Node.js version is configured…`。
      if (this.detachedNvmResume) {
        this.detachedNvmResume = false;
        const plan = this.activePlan;
        if (plan && plan.method === 'nvm') {
          this.hooks.log(
            '不再等待之后版本管理器的安装程序退出了：接着把它装 Node、切版本这两步补完',
          );
          const resumed = await this.installNodeWithNvm(plan);
          if (resumed.kind === 'failed') {
            this.holding = false;
            this.detachedFlag = false;
            this.discardTempDir();
            this.publish('error', {
              message: visibleFailureText(resumed.reason),
              detached: false,
              report: null,
            });
            return;
          }
          if (resumed.kind === 'detached') {
            // 补做的过程里用户又点了「不再等待」：保持未确定，等他确认或重启
            this.publish('waiting', { message: DETACHED_MESSAGE, detached: true });
            return;
          }
        }
      }
      this.publish('rechecking', { message: '正在重新检测', detached: true });
      const report = await this.safeRecheck();
      if (!report) {
        this.publish('waiting', { message: DETACHED_MESSAGE, detached: true });
        return;
      }
      if (this.nodeMissing(report)) {
        this.hooks.log(
          `不再等待之后安装器退出了（退出码 ${code ?? '未知'}），但复检仍然说这一步缺东西：保持"未确定"`,
        );
        this.publish('waiting', { message: DETACHED_MESSAGE, detached: true, report });
        return;
      }
      this.holding = false;
      this.detachedFlag = false;
      this.hooks.log(
        `不再等待之后安装器退出了（退出码 ${code ?? '未知'}），复检证明已经落地：解锁`,
      );
      this.discardTempDir();
      this.publish('done', {
        message: '安装结束了：复检显示 Node 这一项已经正常。',
        detached: false,
        report,
        observedVersion: this.probeInstalledNode()?.version ?? null,
      });
    } finally {
      this.detachedSettling = false;
    }
  }

  /**
   * 装完之后重读系统里的环境，把它并进**本进程**的查找路径（冻结文档 §4.2）：
   * nvm 把 Node 放在自己的目录里、并且写在用户级的查找路径里，不重读的话复检永远认不出来，
   * 用户就得重开应用。**只读系统里已有的，不写系统里的任何东西**；其它已经打开的终端窗口
   * 我们管不了，所以界面上照旧提示"重开一次"。
   */
  private refreshProcessPathFromSystem(): void {
    const snapshot = readRegistryEnvironment();
    if (!snapshot) return;
    const merged = mergePathFromRegistry(snapshot.machinePath, snapshot.userPath);
    if (merged) {
      // 注册表里那一段排在前面（它才是系统现在的真相），我们已知的 bin 目录接在后面
      const key = Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
      process.env[key] = mergePathFromRegistry(merged, pathWithKnownBins(''));
    }
    // 版本管理器写的是**两个**变量（NVM_HOME / NVM_SYMLINK），只补 PATH 不够：
    // `nvm use` 建符号链接的位置来自 NVM_SYMLINK，子进程读不到它就会去用别的默认位置。
    const injected: string[] = [];
    for (const name of INJECTED_ENV_NAMES) {
      const value = findValue(snapshot.vars, name);
      if (value) {
        process.env[name] = value;
        injected.push(`${name}=${value}`);
      }
    }
    if (injected.length > 0) this.hooks.log(`已重读系统环境并注入本进程：${injected.join('；')}`);
  }

  /**
   * 提权探测只做一次，而且**异步**（F-03）：`whoami /groups` 走异步 spawn，不阻塞事件循环 ——
   * 它会被 `plan()` 调用（用户在确认区切选项时就触发），同步 15 秒的探测会把界面卡住。
   * 结果缓存，一次进程只探一次（替代不了真机验证，见交付说明）。
   */
  private async isElevated(): Promise<boolean> {
    if (this.elevated === null) {
      const probe = await runProbeAsync(system32('whoami.exe'), ['/groups'], PROBE_TIMEOUT_MS);
      this.elevated = probe.error === null && isElevatedProbeOutput(probe.stdout, probe.code);
    }
    return this.elevated;
  }

  private readSignature(file: string): SignatureInfo | null {
    const script = [
      `$s = Get-AuthenticodeSignature -LiteralPath ${psQuote(file)}`,
      `[pscustomobject]@{ Status = [string]$s.Status; Subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress`,
    ].join('; ');
    const shell = this.powerShell();
    if (!shell) return null;
    const probe = runProbe(shell, ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (probe.error || !probe.stdout.trim()) return null;
    try {
      const parsed: unknown = JSON.parse(probe.stdout.trim().split(/\r?\n/).pop() ?? '');
      if (!parsed || typeof parsed !== 'object') return null;
      const record: Record<string, unknown> = { ...parsed };
      const status = typeof record.Status === 'string' ? record.Status : '';
      const subject = typeof record.Subject === 'string' && record.Subject ? record.Subject : null;
      if (!status) return null;
      return { status, subject };
    } catch {
      return null;
    }
  }

  private powerShell(): string | null {
    const fromPath = whichSync('powershell.exe');
    if (fromPath) return fromPath;
    const fallback = system32('WindowsPowerShell\\v1.0\\powershell.exe');
    if (fs.existsSync(fallback)) return fallback;
    return whichSync('pwsh');
  }

  private probeNodePath(): string | null {
    return whichSync('node') ?? findNodeExe();
  }

  /** 版本管理器自己的命令：查找路径 → 它自己写的目录 → 安装程序的默认目录 */
  private findNvmExe(): string | null {
    const fromPath = whichSync('nvm');
    if (fromPath) return fromPath;
    const home = envValue(process.env, 'NVM_HOME');
    if (home) {
      const candidate = path.win32.join(home, 'nvm.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
    const appData = envValue(process.env, 'APPDATA');
    if (appData) {
      const candidate = path.win32.join(appData, 'nvm', 'nvm.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
    const symlink = envValue(process.env, 'NVM_SYMLINK');
    if (symlink) {
      const candidate = path.win32.join(path.win32.dirname(symlink), 'nvm', 'nvm.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** 一次简单的文本取回（版本清单 / 校验清单 / 发布信息）：不落盘、有超时 */
  private async fetchText(url: string): Promise<string | null> {
    return new Promise((resolve) => {
      // 注入口优先（独立反例要真调 plan()，见 `NodeInstallHooks.fetchText`）
      const injected = this.hooks.fetchText;
      if (injected) {
        Promise.resolve(injected(url)).then(
          (text) => resolve(typeof text === 'string' ? text : null),
          () => resolve(null),
        );
        return;
      }
      const net = electronNet();
      if (!net) {
        resolve(null);
        return;
      }
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let request: NetRequest | null = null;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      try {
        request = net.request({ method: 'GET', url, redirect: 'follow' });
      } catch {
        finish(null);
        return;
      }
      timer = setTimeout(() => {
        try {
          request?.abort();
        } catch {
          // 已经结束
        }
        finish(null);
      }, PROBE_TIMEOUT_MS);
      timer.unref?.();
      request.on('error', () => finish(null));
      request.on('response', (response: NetResponse) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          finish(null);
          return;
        }
        const parts: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          parts.push(Buffer.from(chunk));
        });
        response.on('end', () => finish(Buffer.concat(parts).toString('utf8')));
        response.on('error', () => finish(null));
      });
      request.end();
    });
  }

  /** 文件名：直装是 Node 的安装包，版本管理器那条路是它的安装包 */
  private fileNameOf(plan: EnvNodePlan): string {
    if (plan.method === 'nvm') {
      const fromUrl = plan.url.split('/').pop() ?? 'nvm-setup.exe';
      return fromUrl.split('?')[0] || 'nvm-setup.exe';
    }
    return nodeInstallerFileName(plan.version, process.arch);
  }

  /** 取消下载（Electron 请求的 abort + 让等待放手） */
  private abortTransfer(): void {
    this.downloadAbort?.();
    this.releaseTransfer?.();
  }

  /** 临时目录里的残留：只清"上一轮留下的"（超过一天的），正在被安装器使用的那个不动 */
  private cleanStaleTemp(dir: string): void {
    try {
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        try {
          const stat = fs.statSync(file);
          if (Date.now() - stat.mtimeMs > STALE_TEMP_MS) this.removeQuietly(file);
        } catch {
          // 读不到就跳过
        }
      }
    } catch {
      // 目录还没有（第一次下载）就算正常
    }
  }

  private discardTempDir(): void {
    for (const file of [...this.tempFiles]) this.removeQuietly(file);
    this.tempFiles.clear();
  }

  /** 本次下载 / 校验落过盘的东西（取消 / 失败 / 退出时按这个清单删） */
  private removeQuietly(file: string): void {
    try {
      fs.rmSync(file, { force: true });
      this.tempFiles.delete(file);
    } catch {
      // 还被安装器占着（Windows 上删不掉正在使用的文件）：留给下一轮的残留清理
      this.tempFiles.add(file);
    }
  }
}

// ---------------------------------------------------------------- 注册表与环境（IO 层）

/**
 * `HKLM\SOFTWARE\Node.js` 的 `InstallPath` —— 官方安装包**自己写下的**安装目录（需求 §7.7 的正面证据之一）。
 *
 * 读不到（不是 Windows / 没有这个键 / 探测被拒）一律 `null`：它是加分证据，不是必需事实，
 * 读不到也不影响结论（官方默认安装位那条判据仍然在）。
 */
export function readNodeMsiInstallPath(): string | null {
  if (!isWindows) return null;
  const probe = runProbe(system32('reg.exe'), [
    'query',
    'HKLM\\SOFTWARE\\Node.js',
    '/v',
    'InstallPath',
  ]);
  if (probe.error !== null) return null;
  return findValue(parseRegQueryOutput(probe.stdout), 'InstallPath');
}

/** 读两处注册表：用户级环境与机器级环境（都只读；拿不到就返回 null，不动本进程） */
function readRegistryEnvironment(): RegistryEnvSnapshot | null {
  if (!isWindows) return null;
  const machineRaw = runProbe(system32('reg.exe'), [
    'query',
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  ]);
  const userRaw = runProbe(system32('reg.exe'), ['query', 'HKCU\\Environment']);
  if (machineRaw.error !== null && userRaw.error !== null) return null;
  const machineVars = machineRaw.error === null ? parseRegQueryOutput(machineRaw.stdout) : {};
  const userVars = userRaw.error === null ? parseRegQueryOutput(userRaw.stdout) : {};
  const vars: Record<string, string> = { ...machineVars, ...userVars };
  // PATH 里常见 %NVM_HOME%;%NVM_SYMLINK% 这类引用（本机实测就是），先展开再合并
  for (let round = 0; round < 3; round += 1) {
    for (const key of Object.keys(vars)) vars[key] = expandEnvReferences(vars[key], vars);
  }
  const machinePath =
    machineRaw.error === null
      ? expandEnvReferences(findValue(machineVars, 'Path') ?? '', vars)
      : null;
  const userPath =
    userRaw.error === null ? expandEnvReferences(findValue(userVars, 'Path') ?? '', vars) : null;
  return {
    machinePath: machinePath || null,
    userPath: userPath || null,
    vars,
  };
}

/** GitHub 发布的最小形状（内部用，不上线缆） */
interface GithubRelease {
  prerelease: boolean;
  draft: boolean;
  /** 发布说明正文：nvm 在这里自述这一次的构建签没签名 */
  body: string;
  assets: ReleaseAsset[];
}

function parseGithubReleases(text: string): GithubRelease[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const releases: GithubRelease[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const record: Record<string, unknown> = { ...item };
    const assets: ReleaseAsset[] = [];
    if (Array.isArray(record.assets)) {
      for (const raw of record.assets) {
        if (!raw || typeof raw !== 'object') continue;
        const asset: Record<string, unknown> = { ...raw };
        if (typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string')
          continue;
        assets.push({
          name: asset.name,
          browser_download_url: asset.browser_download_url,
          digest: typeof asset.digest === 'string' ? asset.digest : null,
        });
      }
    }
    releases.push({
      prerelease: record.prerelease === true,
      draft: record.draft === true,
      body: typeof record.body === 'string' ? record.body : '',
      assets,
    });
  }
  return releases;
}
