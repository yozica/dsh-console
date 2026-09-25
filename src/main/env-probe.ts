/**
 * 只读探测与二进制定位（含本机 dsh 安装树的 Node 要求）
 *
 * t51 从 `env-doctor.ts` 拆出来的；那个文件现在只做 barrel + 两个有状态的类（`EnvDoctor` /
 * `EnvFixRunner`），别的模块与两个反例脚本的 import 路径都不用改。
 */
import type { SettingsValues } from './settings';
import { npmLaunchSpec } from './env-fix-plan';
import { looksVersionManagerNode } from './env-judge';
import { highestNodeRequirement } from './env-node-range';
import type { LocalDshRequirement, NodeEngineDeclaration } from './env-node-range';
import { EMPTY_VERSION_PROBE, PROBE_TIMEOUT_MS, STDERR_TAIL_CHARS } from './env-probe-types';
import type { DshProbe, EnvProbeRaw, EnvRuntime, VersionProbe } from './env-probe-types';
import { nodeOwnershipFacts } from './env-wizard';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  canRunDsh,
  dshArgsFor,
  envWithKnownBins,
  findNodeExe,
  findPnpm,
  findSkippedNodeShim,
  hasVcRuntime,
  homeDir,
  isNodeShim,
  isRunnablePath,
  isWindows,
  killTreeSync,
  launchSpec,
  resolveDshLauncher,
  resolveShell,
  stripAnsi,
  whichSync,
  windowsBinCandidates,
} from './process-utils';
import type { DshLauncher } from './process-utils';

/** 只保留第一行非空输出（版本号那种输出） */
function firstLine(text: string): string {
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

export function messageOf(error: unknown): string {
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

// ---- 本机这份 dsh 对 Node 的要求（离线读它的安装树）----------------------------------------
//
// 为什么要读磁盘而不是只信常量：**不是所有人装的是同一份 dsh**（用户裁决）。上游那句
// `^22.19.0 || >=24.0.0` 只是某一刻的仓库根；用户装的那一份依赖链要什么，只有它的安装树
// 说得清。本机实测（0.1.5-rc.1 / 524 个包）：`undici@8.10.2` 的 `>=22.19.0`。

/** 扫描护栏：目录层数与包数都设上限（异常深 / 异常大的树不许把启动拖住） */
const SCAN_MAX_DEPTH = 7;
const SCAN_MAX_PACKAGES = 2000;

/** 像 dsh 入口脚本的路径（`…/@deepseek-ai/dsh/lib/bin.js`） */
function looksLikeDshBinJs(file: string): boolean {
  return /[/\\]lib[/\\]bin\.js$/i.test(file);
}

interface DshManifest {
  name?: unknown;
  version?: unknown;
  engines?: { node?: unknown };
}

function readManifest(file: string): DshManifest | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as DshManifest;
  } catch {
    return null; // 没有 / 不是 JSON / 读不动：都当"这里没有清单"
  }
}

function isDshPackageRoot(dir: string): boolean {
  return readManifest(path.join(dir, 'package.json'))?.name === '@deepseek-ai/dsh';
}

/**
 * 从启动方式反推 dsh 的安装根（`…/node_modules/@deepseek-ai/dsh`）。**认不出来返回 null**（不猜）。
 *
 * 四条来源，按可靠性排：入口脚本的路径最直接（`node-bin` 与"自定义命令 + bin.js"都走它）；
 * 其次是跟着 shim 的符号链接找真入口（npm 装的 shim 就是软链）；Windows 的 `.cmd` 是批处理、
 * `realpath` 拆不开，只能按 npm 的两种全局布局在它旁边找。最后**一定读 package.json 验名**
 * —— 名字对不上就不是我们要的那一份。
 */
export function dshRootFromLauncher(launcher: DshLauncher): string | null {
  const candidates: string[] = [];
  const entry = launcher.prefixArgs.find((arg) => looksLikeDshBinJs(arg));
  if (entry) candidates.push(path.dirname(path.dirname(entry)));
  // Windows 的 shim / custom-shim 那条路，真正那个 shim 藏在 cmd.exe 的前置参数里（带引号）
  const shim = /^"(.*)"$/.exec(launcher.prefixArgs[3] ?? '')?.[1] ?? launcher.file;
  for (const file of [shim, launcher.file]) {
    const real = ((): string | null => {
      try {
        return fs.realpathSync(file);
      } catch {
        return null; // 软链断了 / 文件不在：试下一条
      }
    })();
    if (real && looksLikeDshBinJs(real)) candidates.push(path.dirname(path.dirname(real)));
  }
  for (const file of [shim, launcher.file]) {
    const dir = path.dirname(file);
    candidates.push(
      path.join(dir, 'node_modules', '@deepseek-ai', 'dsh'),
      path.join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
    );
  }
  for (const candidate of candidates) {
    if (isDshPackageRoot(candidate)) return candidate;
  }
  return null;
}

/** 递归收一棵 `node_modules` 里所有 `engines.node`（读不动的地方跳过，绝不抛） */
function collectNodeEngines(root: string): { entries: NodeEngineDeclaration[]; scanned: number } {
  const entries: NodeEngineDeclaration[] = [];
  let scanned = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > SCAN_MAX_DEPTH || scanned >= SCAN_MAX_PACKAGES) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // 按名字排序再走：`readdirSync` 的顺序各家文件系统不保证，而"同一条下限时点名哪个包"
    // 直接由它决定 —— 不排的话同一台机器上界面里的包名可能变来变去（也没法写断言）。
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      if (scanned >= SCAN_MAX_PACKAGES) return;
      if (!dirent.isDirectory()) continue;
      if (dirent.name === '.bin' || dirent.name === '.cache') continue;
      const full = path.join(dir, dirent.name);
      if (dirent.name.startsWith('@')) {
        walk(full, depth); // 作用域目录不算一层
        continue;
      }
      const manifest = readManifest(path.join(full, 'package.json'));
      if (manifest) {
        scanned += 1;
        if (typeof manifest.engines?.node === 'string' && typeof manifest.name === 'string') {
          entries.push({
            range: manifest.engines.node,
            name: manifest.name,
            version: typeof manifest.version === 'string' ? manifest.version : '',
          });
        }
      }
      walk(path.join(full, 'node_modules'), depth + 1);
    }
  };
  walk(root, 0);
  return { entries, scanned };
}

/**
 * 读**本机这一份** dsh 的 Node 要求：它自己声明的 `engines` + 依赖链里要得最狠的那条下限。
 *
 * 离线、只读、跟随安装的那一份 —— 不联网、不问 registry、也不依赖我们抄来的常量。
 * 拿不到安装根时返回 null（调用方退回 `NODE_RANGE` 并在文案里说清来源）。
 */
export function readLocalDshRequirement(launcher: DshLauncher): LocalDshRequirement | null {
  const root = dshRootFromLauncher(launcher);
  if (!root) return null;
  const own = readManifest(path.join(root, 'package.json'));
  const ownVersion = typeof own?.version === 'string' ? own.version : null;
  const declared = typeof own?.engines?.node === 'string' ? own.engines.node : null;
  const { entries, scanned } = collectNodeEngines(path.join(root, 'node_modules'));
  if (declared)
    entries.push({ range: declared, name: '@deepseek-ai/dsh', version: ownVersion ?? '' });
  return {
    version: ownVersion,
    root,
    declared,
    required: highestNodeRequirement(entries),
    scanned,
  };
}

export async function probeBinary(
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
  let dshLauncher: DshLauncher | null = null;
  try {
    const launcher = resolveDshLauncher(settings);
    dshLauncher = launcher;
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
  // 先把四项子进程**发出去**（`Promise.all` 的数组一求值就 spawn），再趁它们跑的时候扫本机那份
  // dsh 的安装树（同步、本机实测 ~20ms）—— 顺序反过来这 20ms 就白加在总时长上了。
  const probes = Promise.all([
    probeBinary(nodeForRow, ['--version'], runtime.platform),
    probeBinary(npmPath, ['-v'], runtime.platform),
    probeBinary(pnpmPath, ['-v'], runtime.platform),
    collectDshProbe(settings, runtime.platform),
  ]);
  const localDsh = dshLauncher ? (readLocalDshRequirement(dshLauncher) ?? undefined) : undefined;
  const [node, npm, pnpm, dsh] = await probes;

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
    localDsh,
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
export function emptyProbe(runtime: EnvRuntime, error: string): EnvProbeRaw {
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
export async function readNpmPrefix(npmPath: string, platform: string): Promise<string | null> {
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
