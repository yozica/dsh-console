/**
 * 引擎用到的 IO 底层：探测 / 注册表 / 网络 / 临时目录。
 *
 * t52 从 `node-installer.ts` 拆出来的；上面那层（`NodeInstaller` 类）只调这里的函数，
 * 自己不管"怎么读注册表、怎么起一次探测、怎么取网络"。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import type { EnvInstallState, EnvNodePlan } from '../shared/ipc';

import { DEVELOPER_MODE_KEY, OUTPUT_TAIL_CHARS, PROBE_TIMEOUT_MS } from './node-shared';
import type { InstallFailureReason } from './node-failure';
import { detectInstallerFlavor, type InstallerFlavor } from './node-flavor';
import { isDeveloperModeEnabled, type ElevationProbe } from './node-plan';
import { expandEnvReferences, type ReleaseAsset } from './node-release';
import { envWithKnownBins, homeDir, isWindows, launchSpec, type LaunchSpec } from './process-utils';

/** 一次下载的结果（内部用；`kind` 让「成功 / 取消 / 失败」成为一组可穷尽的分支） */
export interface TransferResult {
  kind: 'ok';
  file: string;
  bytes: number;
  total: number | null;
}

/** 等一次下载的结果 */
export type TransferOutcome =
  TransferResult | { kind: 'cancelled' } | { kind: 'failed'; error: string };

/**
 * 算计划的结果。`plan.usable === false` 时 **`unusableReason` 一定在**：
 * 「不能走」也有类别（网络 / 架构 / 提权），界面与日志照实说，不糊成一句"不支持"。
 */
export type PlanResult =
  | { ok: true; plan: EnvNodePlan; unusableReason?: InstallFailureReason }
  | { ok: false; reason: InstallFailureReason };

/** 子进程收尾的四种情况：正常退出 / 没起来 / 我们不再等待 / 等待上限到了由调用方收尾 */
export type CloseOutcome =
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
export interface SignatureInfo {
  /** Valid / NotSigned / HashMismatch / UnknownError / NotTrusted（PowerShell 的原话） */
  status: string;
  subject: string | null;
}

export function messageOf(error: unknown): string {
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
export function visibleFailureText(reason: InstallFailureReason): string {
  const keepExact = reason.kind === 'permission' || reason.kind === 'cancelled';
  if (keepExact || !reason.hint) return reason.message;
  return `${reason.message} ${reason.hint}`;
}

export function idleState(): EnvInstallState {
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

export function system32(file: string): string {
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
export function spawnSpec(spec: LaunchSpec, extra: NodeJS.ProcessEnv): ChildProcess {
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
export function runProbe(file: string, args: string[], timeoutMs = PROBE_TIMEOUT_MS): ProbeOutput {
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
export function parseRegQueryOutput(text: string): Record<string, string> {
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

export function findValue(values: Record<string, string>, name: string): string | null {
  const key = Object.keys(values).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? values[key] : null;
}

/** PowerShell 单引号字符串：路径里的单引号写成两个 */
export function psQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 读安装包，认出它是 Inno 还是 NSIS（IO：读文件的全部字节；10~40 MB 一次读，够快）。
 *
 * 读不到就返回 `unknown` —— 那意味着"静默参数不敢猜"，走可见向导并把这件事告诉用户。
 */
export function readInstallerFlavor(file: string): InstallerFlavor {
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
export function runProbeAsync(
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
export function readDeveloperMode(): boolean {
  const probe = runProbe(system32('reg.exe'), ['query', DEVELOPER_MODE_KEY]);
  if (probe.error !== null || probe.code !== 0) return false;
  const match = /REG_DWORD\s+(\S+)/i.exec(probe.stdout);
  return isDeveloperModeEnabled(match ? match[1] : null);
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
export function installTempDir(): string {
  return path.join(userDataDir(), 'env-install');
}

/** 下载通道（Electron 的网络栈；不顶层 import，保证这个模块能被普通 Node import） */
export interface NetRequest {
  on(event: 'response', handler: (response: NetResponse) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
  abort(): void;
  end(): void;
}
export interface NetResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  on(event: 'data', handler: (chunk: Buffer) => void): void;
  on(event: 'end', handler: () => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
}
interface NetModule {
  request(options: { method: string; url: string; redirect: string }): NetRequest;
}

export function electronNet(): NetModule | null {
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
export function contentLength(
  headers: Record<string, string | string[] | undefined>,
): number | null {
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'content-length');
  const raw = key ? headers[key] : undefined;
  const text = Array.isArray(raw) ? raw[0] : raw;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** 算一个文件的 sha256（读不出来返回 null；校验拿不到值就当"这次没能校验"） */
export async function sha256OfFile(file: string): Promise<string | null> {
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
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

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
export function readRegistryEnvironment(): RegistryEnvSnapshot | null {
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
export interface GithubRelease {
  prerelease: boolean;
  draft: boolean;
  /** 发布说明正文：nvm 在这里自述这一次的构建签没签名 */
  body: string;
  assets: ReleaseAsset[];
}

export function parseGithubReleases(text: string): GithubRelease[] {
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
