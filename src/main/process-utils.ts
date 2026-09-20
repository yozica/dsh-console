/**
 * 进程/网络相关工具：dsh 命令探测、端口占用查询、进程树终止、HTTP 健康探测。
 *
 * Windows 依赖自带的 netstat/tasklist/taskkill；
 * macOS/Linux 用 lsof（端口占用）、ps（进程名）、POSIX 信号（终止）。
 * 除这两组系统命令外不需要任何额外组件。
 */

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { SettingsValues } from './settings';

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const COMSPEC = process.env.ComSpec || 'cmd.exe';

/** 要执行的命令：file + args 交给 PTY，display 只用于界面与日志 */
export interface InvocationSpec {
  file: string;
  args: string[];
  display: string;
  kind: string;
}

/** 「解释器 + dsh 入口脚本」的一个候选组合 */
export interface InterpreterCandidate {
  node: string;
  binJs: string;
  source: string;
}

/**
 * 「怎么调用 dsh」——把解释器与入口脚本的解析从"启动 web 应用"里拆出来。
 *
 * 拆的理由：同一个 dsh 还有别的子命令要调（`plugin` 管插件、`web --dump-config`
 * 看生效配置），它们必须用**同一个解释器**。dsh 的 CLI 在旧 Node 上会静默退出
 * （退出码 0、零输出），所以这里挑出来的组合是实测能跑的，不能各自再猜一遍。
 */
export interface DshLauncher {
  /** 真正要 spawn 的可执行文件（node / dsh shim / npx，Windows 上可能是 cmd.exe） */
  file: string;
  /** 位于 dsh 子命令之前的固定参数（入口脚本路径、npx 的 -y 等） */
  prefixArgs: string[];
  /** true 表示 file 是 cmd.exe、prefixArgs 开头是 /d /s /c + 脚本，后续参数要按 cmd 的规则转义 */
  viaCmd: boolean;
  /** 给人看的调用前缀（不含子命令），用于 display 与日志 */
  display: string;
  kind: string;
}

/** HTTP 探测结果 */
export interface ProbeResult {
  reachable: boolean;
  isDsh: boolean;
  latencyMs: number;
  statusCode?: number;
  body?: string;
  location?: string;
  error?: string;
}

/** 监听某个端口的进程 */
export interface PortOwner {
  pid: number;
  local: string;
  port: number;
}

/** 本地 Shell 的启动描述 */
export interface ShellSpec {
  file: string;
  args: string[];
  display: string;
}

/** 一个 Node 版本的安装目录（bin 与全局 node_modules） */
interface VersionManagerInstall {
  bin: string;
  modules: string;
}

/** 去掉 ANSI 转义序列，便于从终端输出里提取 URL。 */
export function stripAnsi(input: string): string {
  return String(input)
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B[@-Z\\-_]/g, '')
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/** 是普通文件（bin.js 这种交给 node 执行的脚本不需要可执行位） */
function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 是文件且（POSIX 下）有可执行位。Windows 只看是不是文件。 */
function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (!isWindows) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在 PATH 中查找可执行文件（Windows 下自动尝试 PATHEXT）。
 * POSIX 下额外确认可执行位 —— PATH 里躺着同名不可执行文件时不能当真。
 *
 * **Windows 上先按 PATHEXT 试带扩展名的，而且不返回无扩展名的同名文件**（t9 round-2 修）：
 * Node 的安装目录里 `npm`（`#!/usr/bin/env bash`）、`pnpm`（`#!/bin/sh`）与 `npm.cmd` /
 * `pnpm.cmd` 是并存的，而 CreateProcess / `spawn` 起不了那个 sh 脚本（实测 ENOENT），
 * 原来"裸名优先"的候选顺序会稳定地挑中它 —— 结果是 `npm -v` 探测不到输出、一键修复直接
 * ENOENT。PATHEXT 的顺序（`.COM;.EXE;.BAT;.CMD`）天然满足「`pnpm.exe` 优先于 `pnpm.cmd`」。
 * POSIX 上仍然是裸名优先（那边 `npm` 就是对的，不看扩展名）。
 *
 * @param name 例如 dsh.cmd / dsh / node.exe
 */
export function whichSync(name: string): string | null {
  const hasExt = path.extname(name) !== '';
  const exts = isWindows
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((ext) => ext.trim())
        .filter(Boolean)
    : [];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidates = hasExt
      ? [name]
      : isWindows
        ? exts.map((ext) => name + ext.toLowerCase())
        : [name];
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

/**
 * 各版本管理器（nvm / fnm / nodenv）下每个 Node 版本的 bin 与全局 node_modules 目录。
 *
 * 为什么需要：macOS 上从 Finder / Dock 启动的 GUI 应用拿到的 PATH 通常只有
 * `/usr/bin:/bin:/usr/sbin:/sbin`，homebrew、nvm、fnm 装的东西**都不在**里面 ——
 * 只靠 PATH 找 node/dsh 会直接失败，于是退到又慢又脆的 `npx -y`（要联网解析/安装包）。
 */
function versionManagerInstalls(): VersionManagerInstall[] {
  const home = homeDir();
  const installs: VersionManagerInstall[] = [];
  const scan = (base: string, toInstall: (dir: string) => VersionManagerInstall) => {
    let names: string[];
    try {
      names = fs.readdirSync(base);
    } catch {
      return; // 没装这个版本管理器
    }
    // 版本号倒序（数值比较，别让 v9 排到 v24 前面）：装多个 Node 时优先较新的那个
    const key = (name: string) =>
      name
        .replace(/^v/i, '')
        .split('.')
        .map((part) => Number(part) || 0);
    names.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      for (let i = 0; i < Math.max(ka.length, kb.length); i += 1) {
        const diff = (kb[i] || 0) - (ka[i] || 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });
    for (const name of names) installs.push(toInstall(path.join(base, name)));
  };
  scan(path.join(home, '.nvm', 'versions', 'node'), (dir) => ({
    bin: path.join(dir, 'bin'),
    modules: path.join(dir, 'lib', 'node_modules'),
  }));
  scan(path.join(home, '.local', 'share', 'fnm', 'node-versions'), (dir) => ({
    bin: path.join(dir, 'installation', 'bin'),
    modules: path.join(dir, 'installation', 'lib', 'node_modules'),
  }));
  scan(path.join(home, '.nodenv', 'versions'), (dir) => ({
    bin: path.join(dir, 'bin'),
    modules: path.join(dir, 'lib', 'node_modules'),
  }));
  return installs;
}

/**
 * Windows 上 node / pnpm 的已知安装位置（给"PATH 里没有"兜底）。
 *
 * 为什么要它：Windows 上 GUI 启动的应用拿到的是**启动那一刻**的环境块，而 npm / pnpm 的
 * 安装脚本改的是注册表里的 PATH —— 刚装完还没重新登录时，终端里能用、应用里找不到。
 * 键名大小写不统一（`LocalAppData` / `LOCALAPPDATA` 都见过），所以这里先按小写建索引。
 *
 * 纯函数（不读 process.env、不碰磁盘）—— Windows 分支在 macOS 上也要能测。
 */
export function windowsBinCandidates(env: NodeJS.ProcessEnv, home: string): string[] {
  const lower = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value !== '') lower.set(key.toLowerCase(), value);
  }
  const at = (name: string): string => lower.get(name) ?? '';
  // 这些是 **Windows** 路径：用 path.win32 拼，不受跑测试的这台机器的分隔符影响
  const under = (base: string, child: string): string => (base ? path.win32.join(base, child) : '');
  const dirs: string[] = [];
  const push = (dir: string) => {
    if (dir !== '' && !dirs.includes(dir)) dirs.push(dir);
  };
  // pnpm 独立安装包自己写的变量（`%LOCALAPPDATA%\pnpm` 那份 pnpm.exe 就在这儿）
  push(at('pnpm_home'));
  // `npm i -g pnpm` 的全局 bin（pnpm.cmd）
  push(under(at('appdata'), 'npm'));
  push(under(at('localappdata'), 'pnpm'));
  // 官方 node 安装包与 nvm-windows 的软链目录（都放 node.exe）
  push(under(at('programfiles'), 'nodejs'));
  push(at('nvm_symlink'));
  // **nvm v2 的目录形状（VM-11）**：v2 不设 `NVM_HOME` / `NVM_SYMLINK`，它把**自己**放进 PATH
  // （`…\Author Software\nvm`），当前版本的 shim 放在同级的 `.nodejs` 里。所以从 PATH 里
  // 认出"像版本管理器根目录"的那几条，各自补上 `.nodejs` —— 这一条在 PATH 还没刷新（刚装完）
  // 或者只写了根目录的机器上都救得回来。纯拼装、不判存在性（调用方各自查存在性）。
  for (const raw of String(at('path') || '').split(';')) {
    const dir = raw.trim().replace(/[\\/]+$/, '');
    if (dir === '') continue;
    const base = path.win32.basename(dir).toLowerCase();
    if (base === 'nvm' || base === '.nvm' || base === 'nvm-windows') {
      push(path.win32.join(dir, '.nodejs'));
      // v2 的版本装在 `<root>\installs`（每个版本一个目录）；把里面的目录也交给调用方去扫
      // 会让"找 node"多一层，这里只补 `.nodejs` 这个**当前版本**的位置，保持候选简单。
    }
  }
  push(path.win32.join(home, '.volta', 'bin'));
  return dirs;
}

/** 在候选目录里找一个可执行文件（按顺序，先到先得） */
function firstExisting(dirs: string[], names: string[]): string | null {
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

/**
 * 找 node 时的候选目录列表（**顺序即优先级**），`findNodeExe` 与"报出被跳过的转发器"共用它。
 * 抽出来是为了两处不各写一遍 —— 顺序一漂，界面上那句"另有一个外部 Node"就会跟实际挑选对不上。
 */
function nodeCandidatePaths(): string[] {
  const home = homeDir();
  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    path.join(home, '.volta', 'bin', 'node'),
    path.join(home, '.vite-plus', 'bin', 'node'),
    path.join(home, 'Library', 'pnpm', 'node'),
  ];
  for (const install of versionManagerInstalls()) candidates.push(path.join(install.bin, 'node'));
  return candidates;
}

/**
 * 被我们**跳过**的那份转发器（第一份存在、且不是 `chosen` 的）。
 *
 * 为什么要单独找它：重排候选之后，通用搜索也挑到真 node 了 —— 转发器不再是"选中的那份"，
 * 于是"机器上还躺着一个 vite-plus 转发器"这件事就没人说了。而它正是用户拿终端 `node -v`
 * 对账对不上的原因，所以还是要报出来（但**不去执行它**：执行它就是当初那次下载的起因）。
 */
export function findSkippedNodeShim(chosen: string | null): string | null {
  const target = chosen ? path.resolve(chosen) : '';
  for (const candidate of nodeCandidatePaths()) {
    if (!isExecutableFile(candidate)) continue;
    if (target && path.resolve(candidate) === target) continue;
    if (isNodeShim(candidate)) return candidate;
  }
  return null;
}

/**
 * 这个路径是不是一个**转发器**（shim）：跟着符号链接走到最终目标，看它的名字还是不是 `node`。
 *
 * 为什么需要它：`~/.vite-plus/bin/node` 是指向 `current/bin/vp` 的符号链接，**它会在被调用时
 * 决定跑哪个 node** —— 在终端里（PATH 有 nvm）它转发到系统那份，而在 GUI 应用的窄 PATH 下
 * 它会回退到自己下载的运行时（真机事故：我们第一次探测就触发了那次 100+MB 的下载，并把主进程
 * 卡了约 40 秒，见 §7.25）。而 `/opt/homebrew/bin/node` 这类符号链接**指向的是真 node**，
 * 所以判据必须是"**最终目标**的名字"，不能只看"它是不是符号链接"。
 */
export function isNodeShim(file: string): boolean {
  try {
    const real = fs.realpathSync(file);
    return (
      path.basename(real).toLowerCase() !== 'node' &&
      path.basename(real).toLowerCase() !== 'node.exe'
    );
  } catch {
    return false; // 读不出来就别乱扣帽子
  }
}

/** 找 node 可执行文件：PATH 优先，其次常见安装位置（GUI 启动时 PATH 很窄） */
export function findNodeExe(): string | null {
  // Windows 上不写死 `node.exe`：交给 whichSync 按 PATHEXT 展开（`pnpm.exe` / `node.exe` 都可能）
  const fromPath = whichSync('node');
  if (fromPath) return fromPath;
  if (isWindows) return firstExisting(windowsBinCandidates(process.env, homeDir()), ['node.exe']);
  const candidates = nodeCandidatePaths();
  // **两趟**：先要真 node（能看到版本、不会替我们装东西），实在没有才退到转发器。
  // 一趟扫描会让 `~/.vite-plus/bin/node` 抢在 nvm 那些真 node 前面 —— 它不是错的路径，
  // 但它会在被调用时自己决定跑哪个 node（见 isNodeShim 与 §7.25）。
  for (const candidate of candidates) {
    if (isExecutableFile(candidate) && !isNodeShim(candidate)) return candidate;
  }
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * VC++ 2015-2022（x64）运行库那两个 DLL —— Windows 上原生 exe 的加载依赖。
 *
 * 为什么要认它：**pnpm 11 起在 Windows 上发的是原生程序**（12.x 的 `install.js` 会把包里的
 * 占位文件换成 44 MB 的原生 exe），而**纯净 Windows 11 没有这个运行库**；缺了它 exe 加载失败、
 * 进程没有任何输出（真机 VM-09：`pnpm -v` 无输出 + 弹窗「由于找不到 VCRUNTIME140.dll…」）。
 * 本项目要覆盖的正是"什么都没装过"的机器，所以这条事实必须自己认。
 *
 * **只读、不需要管理员**（就是看两个文件在不在）；而且**只跟 pnpm 有关**：
 * 真机上同一台机器 `node -v` / `npm -v` 都正常，所以不要因此去要求用户装运行库。
 */
export const VC_RUNTIME_DLLS = ['vcruntime140.dll', 'msvcp140.dll'];

/** 那两个 DLL 在 `%SystemRoot%\System32` 里的位置（纯字符串拼装，不判存在性） */
export function vcRuntimePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const root = (() => {
    const lower = new Map<string, string>();
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string') lower.set(key.toLowerCase(), value);
    }
    return lower.get('systemroot') ?? lower.get('windir') ?? 'C:\\Windows';
  })();
  // `%SystemRoot%\System32` 是 **Windows** 路径：用 `path.win32` 拼（`path.join` 跟着跑测试的机器走，
  // 在 Linux 上会拼出 `D:\Windows/System32/…` 这种混合分隔符 —— 自检就是这么红的）
  return VC_RUNTIME_DLLS.map((name) => path.win32.join(root, 'System32', name));
}

/**
 * 这台机器有没有 VC++ 运行库。
 *
 * `exists` 可注入 —— 自检用它把「缺 / 有」两支分支都真跑一遍，不必真的去动系统里的 DLL。
 * 非 Windows 恒为 true：这条只在 Windows 上成立（POSIX 的 pnpm 是 JS 入口）。
 */
export function hasVcRuntime(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = (file) => fs.existsSync(file),
): boolean {
  if (!isWindows) return true;
  return vcRuntimePaths(env).every((file) => exists(file));
}

/**
 * Windows 上 pnpm 的候选文件名，**按"能不能跑"排序**（不是按 PATH 顺序）。
 *
 * - 缺 VC++ 运行库：**`.cmd` 优先** —— `pnpm.cmd` 是 npm 生成的批处理，指向包内的 JS 入口
 *   （`pnpm@10` 的 `bin` 就是 `bin/pnpm.cjs`），而同一目录里的 `pnpm.exe` 是原生程序，
 *   在这台机器上注定加载失败（VM-09）。PATH 顺序在这里让位给"能不能跑"。
 * - 有运行库：`.exe` 优先（原生，最快；也照顾"独立安装包只放了 pnpm.exe"那一路）。
 *
 * 纯函数（不碰磁盘）：自检直接钉两支分支。
 */
export function pnpmExeNames(vcRuntime: boolean): string[] {
  return vcRuntime ? ['pnpm.exe', 'pnpm.cmd'] : ['pnpm.cmd', 'pnpm.exe'];
}

/**
 * 在 Windows 上找 pnpm：**名字优先于目录顺序**（见 `pnpmExeNames` 的理由）。
 *
 * 先扫 `env` 里的 PATH，再扫已知安装位置（`windowsBinCandidates`）。`exists` 可注入，
 * 所以自检能真跑「同一个目录里既有坏的 pnpm.exe、又有能跑的 pnpm.cmd」这一支。
 *
 * 导出它是为了自检与 `findPnpm()` 用**同一份**偏好：`findPnpm()` 只是拿真实运行库事实调它一次
 * （`process-utils` 是最底层，不许 import 上层，所以事实只能由它自己探测）。
 */
export function findPnpmWindows(
  vcRuntime: boolean,
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = isExecutableFile,
): string | null {
  const names = pnpmExeNames(vcRuntime);
  const pathDirs: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() !== 'path' || typeof value !== 'string') continue;
    for (const dir of value.split(path.win32.delimiter)) {
      if (dir.trim()) pathDirs.push(dir.trim());
    }
  }
  const known = windowsBinCandidates(env, homeDir()).filter((dir) => fs.existsSync(dir));
  for (const name of names) {
    for (const dir of [...pathDirs, ...known]) {
      // 这些是 **Windows** 路径：用 `path.win32` 拼，别用 `path.join` —— 后者跟着**跑测试的这台机器**
      // 的分隔符走，于是同一条断言在 Windows 上绿、在 macOS / Linux 上假红（VM-09 的自检就踩过）。
      const full = path.win32.join(dir, name);
      if (exists(full)) return full;
    }
  }
  return null;
}

/**
 * 找 pnpm 可执行文件。
 *
 * 为什么必须自己找：`dsh plugin` 内部是 `spawnSync('pnpm', …)`（`stdio: 'inherit'`），
 * **完全依赖子进程的 PATH**；而 macOS 上从 Finder/Dock 启动的应用 PATH 通常只有
 * `/usr/bin:/bin:/usr/sbin:/sbin`，nvm / homebrew / `~/Library/pnpm` 都不在里面。
 * Windows 上 GUI 启动的应用拿到的是启动那一刻的环境块，刚装完 pnpm 还没重新登录时同理。
 * 不补的话用户看到的是 `dsh: pnpm not found on PATH`，退出码 127。
 *
 * **Windows 上还要选"能跑的那个"**：缺 VC++ 运行库时原生 `pnpm.exe` 加载会失败（VM-09），
 * 所以偏好交给 `findPnpmWindows()`（同一份判据，插件路径也走这里，两边不会各挑一个）。
 */
export function findPnpm(): string | null {
  if (isWindows) return findPnpmWindows(hasVcRuntime());
  const fromPath = whichSync('pnpm');
  if (fromPath) return fromPath;
  const home = homeDir();
  const candidates = [
    // pnpm 官方安装脚本在这台机器上就装在这儿（PATH 里没有）
    path.join(home, 'Library', 'pnpm', 'pnpm'),
    '/opt/homebrew/bin/pnpm',
    '/usr/local/bin/pnpm',
    path.join(home, '.local', 'share', 'pnpm', 'pnpm'),
    path.join(home, '.npm-global', 'bin', 'pnpm'),
  ];
  for (const install of versionManagerInstalls()) candidates.push(path.join(install.bin, 'pnpm'));
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * 给子进程的 PATH 前置已知的 bin 目录（node 与 pnpm 所在目录）。
 * 只影响我们 spawn 的那一个子进程，不动应用自己的环境。
 */
export function pathWithKnownBins(base: string | undefined): string {
  const extra: string[] = [];
  const push = (exe: string | null) => {
    const dir = exe ? path.dirname(exe) : '';
    if (dir && !extra.includes(dir)) extra.push(dir);
  };
  push(findNodeExe());
  push(findPnpm());
  const rest = String(base || '')
    .split(path.delimiter)
    .filter((dir) => dir && !extra.includes(dir));
  return [...extra, ...rest].join(path.delimiter);
}

/**
 * 复制一份环境变量并把已知 bin 目录补进 PATH。
 *
 * **Windows 上这个键通常叫 `Path`**（Node 原样保留系统的大小写）。如果直接写
 * `{ ...process.env, PATH: patched }`，就会同时存在 `Path` 与 `PATH` 两个只差大小写的键 ——
 * 哪个生效取决于运行时怎么构造环境块，等于"补了 pnpm 目录却可能白补"。所以这里先找到
 * 已有的那个键、**原地改它**（没有才新写 `PATH`）。
 */
export function envWithKnownBins(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
  env[key] = pathWithKnownBins(env[key]);
  return env;
}

/** 全局 node_modules 的候选目录（PATH 里没有 shim 时直接来这里找包） */
function globalNodeModulesRoots(): string[] {
  const home = homeDir();
  const roots: string[] = [];
  const push = (dir: string) => {
    if (dir && !roots.includes(dir)) roots.push(dir);
  };
  // 1. 从 node 自己所在的位置反推 npm 前缀，**排最前**：
  //    这样选到的包和将要执行它的 node 是同一份安装，不会出现版本错配
  const nodeExe = findNodeExe();
  if (nodeExe) {
    let real = nodeExe;
    try {
      real = fs.realpathSync(nodeExe);
    } catch {
      /* 用原始路径 */
    }
    const prefix = path.dirname(path.dirname(real));
    push(path.join(prefix, 'lib', 'node_modules'));
    push(path.join(prefix, 'node_modules'));
  }
  // 2. 常见的系统级全局目录
  push('/usr/local/lib/node_modules');
  push('/opt/homebrew/lib/node_modules');
  push(path.join(home, '.npm-global', 'lib', 'node_modules'));
  push(path.join(home, 'Library', 'pnpm', 'global', '5', 'node_modules'));
  // 3. 版本管理器里其它 Node 版本的全局目录（兜底）
  for (const install of versionManagerInstalls()) push(install.modules);
  return roots;
}

/** 从全局安装目录里找 @deepseek-ai/dsh 的 bin.js（不依赖 PATH 里的 shim） */
export function findGlobalDshBinJs(): string | null {
  for (const root of globalNodeModulesRoots()) {
    const candidate = path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * 「解释器 + dsh 入口脚本」的候选组合，按"最可能可用"排序。
 *
 * 为什么要成对而不是各自独立挑：dsh 的 CLI 对 Node 版本敏感 —— 实测同一份
 * bin.js，`node 22` 上会**静默什么都不做就退出（无输出、退出码 0）**，
 * `node 24` 上正常打印版本号并起服务。而 macOS 上 PATH 里的 node 未必是能跑它的那个
 * （这台机器 PATH 里是 vite-plus 包装的 v22，nvm 下另有 v24）。
 * 所以优先给出"同一个安装目录里的 node + dsh"这种天然匹配的组合，
 * 再由 canRunDsh 实测确认。
 */
export function dshInterpreterCandidates(): InterpreterCandidate[] {
  const out: InterpreterCandidate[] = [];
  const seen = new Set<string>();
  const push = (node: string | null, binJs: string | null, source: string) => {
    if (!node || !binJs) return;
    const key = `${node}\u0000${binJs}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ node, binJs, source });
  };

  // 1. PATH 里的 node + PATH shim 反推出的 bin.js（最贴近用户当前环境，Windows 常态）
  const pathNode = whichSync(isWindows ? 'node.exe' : 'node');
  const shim = findDshShim();
  const shimBinJs = shim ? (binJsCandidates(shim).find(isFile) ?? null) : null;
  push(pathNode, shimBinJs, 'PATH shim');

  // 2. 版本管理器里"配套"的 node + dsh（同一个版本目录，最新版本优先）
  if (!isWindows) {
    for (const install of versionManagerInstalls()) {
      push(
        path.join(install.bin, 'node'),
        path.join(install.modules, '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
        'nvm/fnm 配套安装',
      );
    }
  }

  // 3. PATH 里的 node + 任意扫到的全局安装
  push(pathNode, findGlobalDshBinJs(), 'PATH node + 全局安装');

  // 4. 其它常见位置找到的 node + 全局安装
  const foundNode = isWindows ? pathNode : findNodeExe();
  push(foundNode, findGlobalDshBinJs(), '已知位置 node + 全局安装');

  return out.filter((candidate) => isExecutableFile(candidate.node) && isFile(candidate.binJs));
}

/** 探针结果缓存：键是"解释器 + 入口脚本"，取值是否可用 */
const dshProbeCache = new Map<string, boolean>();

/**
 * 实测「这个 node 能不能跑这份 dsh」——跑一次 `--version`，有输出才算能用。
 *
 * 比硬编码"要求 Node ≥ x"稳：dsh 的版本要求会变，而且它不满足要求时**不报错**，
 * 只安静地退出（退出码 0、零输出），光看退出码根本发现不了。
 * 结果缓存，所以同一组合每个进程只测一次。
 */
export function canRunDsh(nodeExe: string, binJs: string): boolean {
  const key = `${nodeExe}\u0000${binJs}`;
  const cached = dshProbeCache.get(key);
  if (cached !== undefined) return cached;
  let ok: boolean;
  try {
    const stdout = execFileSync(nodeExe, [binJs, '--version'], {
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    ok = String(stdout || '').trim().length > 0;
  } catch {
    // 起不来 / 超时 / 没有输出：都当作"这个组合不可用"
    ok = false;
  }
  dshProbeCache.set(key, ok);
  return ok;
}

/**
 * 挑一个真能跑 dsh 的解释器组合。
 * 所有候选都测不过（例如受限环境不允许再起子进程）时，退回第一个候选 ——
 * 宁可把问题留给运行期，也不要在这里直接失败。
 */
export function pickDshInterpreter(): InterpreterCandidate | null {
  const candidates = dshInterpreterCandidates();
  if (candidates.length === 0) return null;
  for (const candidate of candidates) {
    if (canRunDsh(candidate.node, candidate.binJs)) return candidate;
  }
  return candidates[0];
}

/** 拆分带引号的参数串，例如 --flag "a b" -> ['--flag', 'a b'] */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(String(text || ''))) !== null) {
    out.push(match[1] ?? match[2] ?? match[3]);
  }
  return out;
}

/** 把字符串参数包成 cmd.exe 可安全执行的形式（仅 Windows 用） */
function quoteForCmd(value: string): string {
  return /[\s&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 平台感应的 dsh shim 文件（Windows 的 dsh.cmd / POSIX 的 dsh） */
function findDshShim(): string | null {
  if (isWindows) return whichSync('dsh.cmd') || whichSync('dsh.exe');
  return whichSync('dsh');
}

/**
 * npm 全局安装的 dsh 包根目录里那条 bin.js 的候选位置。
 * 布局因平台而异：Windows 的 %APPDATA%\npm 把 shim 与 node_modules 放同一层，
 * POSIX 的全局 bin（如 /opt/homebrew/bin）的 shim 是指向 ../lib/node_modules 的符号链接。
 */
function binJsCandidates(shimPath: string): string[] {
  const prefix = path.dirname(shimPath);
  const candidates = [path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')];
  if (!isWindows) {
    const real = (() => {
      try {
        return fs.realpathSync(shimPath);
      } catch {
        return shimPath;
      }
    })();
    const realDir = path.dirname(real);
    candidates.push(
      path.join(realDir, '..', 'lib', 'bin.js'),
      path.join(prefix, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      path.join(realDir, '..', '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    );
  }
  return candidates;
}

/**
 * 解析"怎么调用 dsh"（不含子命令）。
 * 优先级：自定义命令 > node + dsh 入口脚本（实测能跑的组合）> dsh shim > npx
 *
 * 两道保险都是为了"明明装了 dsh 却起不来"这类问题：
 *  1. 不依赖 PATH：shim 不在 PATH 里时直接扫 nvm/fnm、homebrew、pnpm 的全局安装目录
 *     （macOS 上 GUI 启动的 PATH 很窄，只有 /usr/bin:/bin:/usr/sbin:/sbin）。
 *  2. 解释器要实测：dsh 的 CLI 在旧 Node 上会**静默退出**（无输出、退出码 0），
 *     所以候选组合会跑一次 `--version` 验证，只挑真能跑的那个（见 pickDshInterpreter）。
 */
export function resolveDshLauncher(settings: SettingsValues): DshLauncher {
  const override = String(settings.dshCommand || '').trim();
  if (override) {
    // 支持写整条命令行，例如「/path/to/node /path/to/@deepseek-ai/dsh/lib/bin.js」——
    // 这样"换一个能跑 dsh 的 Node"才表达得出来（第一个 token 是可执行文件，其余是我们的前置参数）
    const parts = splitArgs(override);
    const file = parts[0];
    const prefixArgs = parts.slice(1);
    if (/\.(cmd|bat)$/i.test(file) && !isWindows) {
      throw new Error(
        `自定义命令 ${file} 是 Windows 批处理脚本，macOS 上无法执行。可以改成「node 的绝对路径 + dsh 入口脚本」，例如 /path/to/bin/node /path/to/@deepseek-ai/dsh/lib/bin.js。`,
      );
    }
    if (/\.(cmd|bat)$/i.test(file)) {
      return {
        file: COMSPEC,
        prefixArgs: ['/d', '/s', '/c', `"${file}"`, ...prefixArgs],
        viaCmd: true,
        display: override,
        kind: 'custom-shim',
      };
    }
    return { file, prefixArgs, viaCmd: false, display: override, kind: 'custom' };
  }

  const picked = pickDshInterpreter();
  if (picked) {
    return {
      file: picked.node,
      prefixArgs: [picked.binJs],
      viaCmd: false,
      display: `${picked.node} ${picked.binJs}`,
      kind: 'node-bin',
    };
  }
  const dshShim = findDshShim();
  if (dshShim) {
    if (isWindows) {
      return {
        file: COMSPEC,
        prefixArgs: ['/d', '/s', '/c', `"${dshShim}"`],
        viaCmd: true,
        display: dshShim,
        kind: 'shim',
      };
    }
    return { file: dshShim, prefixArgs: [], viaCmd: false, display: dshShim, kind: 'shim' };
  }
  const npx = whichSync(isWindows ? 'npx.cmd' : 'npx');
  if (npx) {
    const prefixArgs = ['-y', '@deepseek-ai/dsh'];
    if (isWindows) {
      return {
        file: COMSPEC,
        prefixArgs: ['/d', '/s', '/c', `"${npx}"`, ...prefixArgs],
        viaCmd: true,
        display: `${npx} ${prefixArgs.join(' ')}`,
        kind: 'npx',
      };
    }
    return {
      file: npx,
      prefixArgs,
      viaCmd: false,
      display: `${npx} ${prefixArgs.join(' ')}`,
      kind: 'npx',
    };
  }
  throw new Error(
    isWindows
      ? '找不到 dsh：PATH 里既没有 dsh.cmd，也没有 node/npx。请在设置里指定启动命令。'
      : '找不到 dsh：既没有全局安装的 @deepseek-ai/dsh，PATH 里也没有 node/npx。请在设置里指定启动命令。',
  );
}

/**
 * 把 dsh 子命令拼成最终 argv。
 * cmd.exe 那条路要按 cmd 的转义规则处理（`&`、引号等），这是唯一需要平台分支的地方。
 */
export function dshArgsFor(launcher: DshLauncher, args: string[]): string[] {
  if (!launcher.viaCmd) return [...launcher.prefixArgs, ...args];
  return [...launcher.prefixArgs, ...args.map(quoteForCmd)];
}

/**
 * Windows 上「这个文件真的起得来」的扩展名：`.exe` / `.com` 是 PE，`.cmd` / `.bat` 交给 cmd.exe。
 * 无扩展名的同名文件（Node 安装目录里的 `npm` 是 `#!/usr/bin/env bash`）不在其中 ——
 * `spawn` 它直接 ENOENT（本机实测）。
 */
const WIN_RUNNABLE_EXTS = new Set(['.exe', '.com', '.cmd', '.bat']);

/** 一条真正能交给 `spawn` / `execFile` 的启动描述 */
export interface LaunchSpec {
  file: string;
  args: string[];
  /**
   * true = `args` 已经是我们按 cmd.exe 的规则拼好的**一整条命令行**，Node 不要再加引号。
   *
   * Windows 上必须声明它（调用方要原样传给 `spawn` / `execFile`）：Node 自己的引号规则与 cmd
   * 不一样，`"C:\…\dsh.cmd"` 会被再转义成 `\"C:\…\dsh.cmd\"`，cmd 于是报
   * `'"…dsh.cmd"' is not recognized as an internal or external command`（本机实测）。
   * 这是「.cmd 不能直接 spawn（EINVAL）」之外的第二道坑，两条都在这里收口。
   */
  windowsVerbatimArguments: boolean;
}

function isCmdExe(file: string): boolean {
  // Windows 路径一律 `path.win32`（§7.23）：用 `path.basename` 会跟着"跑测试这台机器"走 ——
  // 在 macOS / Linux 上 `basename('C:\\Windows\\system32\\cmd.exe')` 返回整串，于是这里判成
  // false、走进 `.exe` 那条直连分支（门禁里 `M launchSpec` 红的就是这一条）。
  // Windows 上 `path.win32.basename === path.basename`，所以生产行为不变。
  const base = path.win32.basename(file).toLowerCase();
  return base === 'cmd.exe' || base === 'cmd';
}

/** PE 映像可以直接 spawn；其它可执行文件（`.cmd` / `.bat`）在 Windows 上都要经 cmd.exe */
function isPeImage(file: string): boolean {
  const ext = path.win32.extname(file).toLowerCase();
  return ext === '.exe' || ext === '.com';
}

/**
 * 这份路径在**自己的平台**上能不能被起起来。
 *
 * Windows 上只看扩展名：Node 安装目录里 `npm`（POSIX sh 脚本）与 `npm.cmd` 是并存的，
 * 只按 PATH 找「叫 npm 的那个文件」会拿到前者 —— 而它既不是 PE，也不是 cmd 能执行的批处理。
 * 所以**解析侧只认带可执行扩展名的**，执行侧再按扩展名决定要不要经 cmd.exe。
 */
export function isRunnablePath(file: string, platform: string): boolean {
  if (platform !== 'win32') return true;
  // 同上：这个是 Windows 专用判据（`platform === 'win32'` 才走），用 win32 的取扩展名规则，
  // 才能在非 Windows 的机器上被用例脚本测到（§7.23）。
  return WIN_RUNNABLE_EXTS.has(path.win32.extname(file).toLowerCase());
}

/**
 * 统一包装器：把「可执行文件 + argv」变成真正能起的 spec。
 * **凡是自己起 dsh / npm 的地方都用它**（env-doctor 的探测与一键修复、plugin-manager 的
 * dump 与装/卸/升级）—— 各写一遍就会出现「一条路能跑、另一条路报 not recognized」。
 *
 * - 非 Windows：原样返回 argv 数组；
 * - Windows + PE（`.exe` / `.com`）：可以直接 spawn，不需要 cmd 这层；
 * - Windows 其它（`.cmd` / `.bat` / 无扩展名），以及**已经是 cmd.exe 的调用**
 *   （`resolveDshLauncher` 给的 shim / npx / custom-shim 那条路）：经 `cmd.exe`，把 `/d /s /c`
 *   之后的整条命令拼成**一个**参数，再整条套一层引号 —— `/s` 会把最外层那对引号剥掉，
 *   剥完才是真命令行（cmd 的既定行为，`cross-spawn` 一类库也是这么拼的），否则路径里带空格 /
 *   最后一个参数带引号时会被 `/s` 的引号剥离规则切坏（真机实测：`C:\Program Files\nodejs\npm.cmd`
 *   会被切成 `'C:\Program Files' is not recognized as an internal or external command`）。
 */
export function launchSpec(file: string, args: string[], platform: string): LaunchSpec {
  if (platform !== 'win32') {
    return { file, args: [...args], windowsVerbatimArguments: false };
  }
  if (!isCmdExe(file) && isPeImage(file)) {
    return { file, args: [...args], windowsVerbatimArguments: false };
  }
  const parts =
    isCmdExe(file) && args[0] === '/d' && args[1] === '/s' && args[2] === '/c'
      ? args.slice(3) // 已经是引好的段落（dshArgsFor 拼的），原样接在后面
      : [file, ...args].map(quoteForCmd);
  return {
    file: isCmdExe(file) ? file : COMSPEC,
    args: ['/d', '/s', '/c', `"${parts.join(' ')}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * 「启动 dsh」的统一入口：解析出来的 launcher（含 shim / npx / 自定义 shim 这三条回退分支）
 * 经它变成能真的 `spawn` / `execFile` 的 spec。
 *
 * 为什么必须走这里：`resolveDshLauncher()` 在这些回退分支上给的是 `cmd.exe` + `/d /s /c`
 * 前缀（见该函数），直接 `spawn(launcher.file, dshArgsFor(...))` 时 Node 会把内嵌的引号再
 * 转义一遍，cmd 报 `'"…dsh.cmd"' is not recognized` —— 也就是"用户自己装了 dsh 却解析不到"时
 * 插件页一整块功能都不可用。
 */
export function dshLaunchSpec(launcher: DshLauncher, args: string[], platform: string): LaunchSpec {
  return launchSpec(launcher.file, dshArgsFor(launcher, args), platform);
}

/** 解析要启动的 dsh web（= `dsh web --no-open` + 监听地址与附加参数） */
export function resolveDshInvocation(settings: SettingsValues): InvocationSpec {
  const args = ['web', '--no-open'];
  const host = String(settings.host || '127.0.0.1').trim();
  const port = Number(settings.port);
  if (host && host !== '127.0.0.1') args.push('--host', host);
  if (Number.isInteger(port) && port > 0) args.push('--port', String(port));
  args.push(...splitArgs(settings.extraArgs));

  const launcher = resolveDshLauncher(settings);
  return {
    file: launcher.file,
    args: dshArgsFor(launcher, args),
    display: [launcher.display, ...args].join(' '),
    kind: launcher.kind,
  };
}

/**
 * 选择本地 Shell（用于"新建本地 Shell"标签）。
 * Windows：pwsh > powershell > cmd；macOS/Linux：$SHELL > zsh > bash > sh。
 */
export function resolveShell(settings: SettingsValues): ShellSpec {
  const override = String(settings.shell || '').trim();
  if (override) return { file: override, args: [], display: override };

  if (isWindows) {
    const pwsh = whichSync('pwsh.exe');
    if (pwsh) return { file: pwsh, args: ['-NoLogo'], display: pwsh };
    const powershell = whichSync('powershell.exe');
    if (powershell) return { file: powershell, args: ['-NoLogo'], display: powershell };
    return { file: COMSPEC, args: [], display: COMSPEC };
  }

  // macOS/Linux：优先用户当前交互 shell（登录模式，PATH 与终端里一致），
  // 依次回退 zsh / bash / sh。GUI 启动的应用 PATH 很窄，不加 -l 会找不到 homebrew 装的东西。
  //
  // 注意：POSIX 上**不要**自动优先 pwsh。装了 PowerShell 的 mac 不少（GitHub 的 macOS
  // runner 就自带），自动挑它会让"新建本地 Shell"意外开出 PowerShell，而不是用户自己的 zsh；
  // 自检也因此在 CI 上红过一条。想用 pwsh / fish 之类，就在设置里显式填路径。
  const fromEnv = String(process.env.SHELL || '').trim();
  if (fromEnv && fs.existsSync(fromEnv)) return { file: fromEnv, args: ['-l'], display: fromEnv };
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (fs.existsSync(candidate)) return { file: candidate, args: ['-l'], display: candidate };
  }
  return { file: '/bin/sh', args: ['-l'], display: '/bin/sh' };
}

/** 判断 HTTP 响应是否来自 dsh web。 */
export function isDshResponse(statusCode: number | undefined, body: unknown): boolean {
  const text = String(body || '');
  if (/dsh web authentication required/.test(text)) return true;
  if (statusCode === 200 && /__DSH_BOOT__|DeepSeek Harness/i.test(text)) return true;
  return false;
}

/** 探测一个 HTTP 地址。 */
export function probeHttp(url: string, timeoutMs = 1500): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const finish = (value: Omit<ProbeResult, 'latencyMs'>) => {
      if (settled) return;
      settled = true;
      resolve({ latencyMs: Date.now() - started, ...value });
    };
    let request: http.ClientRequest;
    try {
      request = http.get(
        url,
        { timeout: timeoutMs, headers: { 'user-agent': 'dsh-console' } },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            if (body.length < 65536) body += chunk;
          });
          res.on('end', () => {
            finish({
              reachable: true,
              statusCode: res.statusCode,
              isDsh: isDshResponse(res.statusCode, body),
              body: body.slice(0, 300),
              location: res.headers.location,
            });
          });
          res.on('error', (error: Error) =>
            finish({ reachable: false, error: error.message, isDsh: false }),
          );
        },
      );
    } catch (error) {
      finish({
        reachable: false,
        error: error instanceof Error ? error.message : String(error),
        isDsh: false,
      });
      return;
    }
    request.on('timeout', () => {
      request.destroy();
      finish({ reachable: false, error: 'timeout', isDsh: false });
    });
    request.on('error', (error: Error) =>
      finish({ reachable: false, error: error.message, isDsh: false }),
    );
  });
}

/**
 * 从 netstat -ano 输出里解析监听指定端口的 PID（纯函数，便于单测）。
 */
export function parseNetstatForPort(stdout: string, port: number): PortOwner | null {
  const wanted = `:${port}`;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const [proto, local, , state, pidText] = cols;
    if (proto.toUpperCase() !== 'TCP') continue;
    if (state.toUpperCase() !== 'LISTENING') continue;
    if (!local.endsWith(wanted)) continue;
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    return { pid, local, port: Number(port) };
  }
  return null;
}

/**
 * 从 `lsof -nP -iTCP:<port> -sTCP:LISTEN` 输出里解析监听者 PID（纯函数，便于单测）。
 * 行形如：COMMAND   PID USER   FD  TYPE DEVICE SIZE/OFF NODE NAME
 *          node   42112  abc   20u IPv4 0x...      0t0  TCP 127.0.0.1:3080 (LISTEN)
 * NAME 列在协议名（TCP）之后：可能是 *:3080、127.0.0.1:3080 或 [::1]:3080。
 */
export function parseLsofForPort(stdout: string, port: number): PortOwner | null {
  const wanted = `:${Number(port)}`;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!/\(LISTEN\)/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    const pid = Number(cols[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const tcpAt = cols.indexOf('TCP');
    const name = tcpAt >= 0 ? cols[tcpAt + 1] || '' : '';
    const local = name.split('->')[0]; // 只看本地地址，别把 ESTABLISHED 的对端算进来
    if (!local || !local.endsWith(wanted)) continue;
    return { pid, local, port: Number(port) };
  }
  return null;
}

/** 用平台自带命令找出监听指定端口的进程 PID。 */
export function portOwnerSync(port: number): Promise<PortOwner | null> {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0) {
      resolve(null);
      return;
    }
    const finish = (stdout: string | undefined) => {
      if (!stdout) {
        resolve(null);
        return;
      }
      resolve(isWindows ? parseNetstatForPort(stdout, port) : parseLsofForPort(stdout, port));
    };
    try {
      if (isWindows) {
        execFile(
          'netstat',
          ['-ano', '-p', 'tcp'],
          { windowsHide: true, timeout: 8000 },
          (error, stdout) => {
            if (error) {
              resolve(null);
              return;
            }
            finish(stdout);
          },
        );
      } else {
        // lsof 查询端口时经常要 sudo 才全（别的用户的进程看不见）；
        // 本应用场景只关心自己启动的 dsh，无权限时返回 null 由状态机兜底。
        execFile(
          'lsof',
          ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'],
          { timeout: 8000 },
          (error, stdout) => {
            if (error) {
              resolve(null);
              return;
            }
            finish(stdout);
          },
        );
      }
    } catch {
      // 系统命令起不来（受限环境）：当作未知，不影响状态机
      resolve(null);
    }
  });
}

/** 查询 PID 对应的进程名（尽力而为）。 */
export function processNameSync(pid: number): Promise<string> {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      resolve('');
      return;
    }
    try {
      if (isWindows) {
        execFile(
          'tasklist',
          ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
          { windowsHide: true, timeout: 8000 },
          (error, stdout) => {
            if (error || !stdout) {
              resolve('');
              return;
            }
            const match = stdout.match(/^"([^"]+)","(\d+)"/m);
            resolve(match ? match[1] : '');
          },
        );
      } else {
        execFile('ps', ['-o', 'comm=', '-p', String(pid)], { timeout: 8000 }, (error, stdout) => {
          if (error || !stdout) {
            resolve('');
            return;
          }
          const name = String(stdout).trim().split(/\s+/)[0] || '';
          resolve(name);
        });
      }
    } catch {
      resolve('');
    }
  });
}

/** POSIX：递归收集 pid 的所有后代（pgrep -P 一层层展开，子先父后） */
function collectDescendants(pid: number, exec: typeof execFileSync): number[] {
  const out: number[] = [];
  const queue: number[] = [pid];
  let guard = 0;
  while (queue.length > 0 && guard < 64) {
    guard += 1;
    const parent = queue.shift() as number;
    let children: number[];
    try {
      const stdout = exec('pgrep', ['-P', String(parent)]);
      children = String(stdout || '')
        .split(/\s+/)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0);
    } catch {
      children = [];
    }
    out.unshift(...children);
    queue.push(...children);
  }
  return out;
}

/** POSIX：优先杀"自己的进程组"（pgid==pid 时整组一起清），否则按后代顺序逐个终止。 */
function killPosixTree(pid: number, signal: NodeJS.Signals): void {
  try {
    const pgid = Number(
      String(
        execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      ).trim(),
    );
    if (Number.isInteger(pgid) && pgid > 0 && pgid === pid) {
      process.kill(-pgid, signal);
      return;
    }
  } catch {
    /* ps 不可用：退回逐个终止 */
  }
  try {
    const targets = [...collectDescendants(pid, execFileSync), pid];
    for (const target of targets) {
      try {
        process.kill(target, signal);
      } catch {
        /* 进程可能已退出 */
      }
    }
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* 进程可能已退出 */
    }
  }
}

/** 终止进程树（Windows 用 taskkill /T /F，POSIX 用信号按组/按后代清）。 */
export function killTree(pid: number, force = true): Promise<boolean> {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      resolve(false);
      return;
    }
    if (isWindows) {
      const args = ['/PID', String(pid), '/T'];
      if (force) args.push('/F');
      try {
        execFile('taskkill', args, { windowsHide: true, timeout: 8000 }, (error) =>
          resolve(!error),
        );
      } catch {
        resolve(false);
      }
      return;
    }
    try {
      killPosixTree(pid, force ? 'SIGKILL' : 'SIGTERM');
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

/** 同步终止，用于退出应用前的兜底清理。 */
export function killTreeSync(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (isWindows) {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 8000,
      });
    } else {
      killPosixTree(pid, 'SIGKILL');
    }
  } catch {
    /* 进程可能已退出 */
  }
}

/** 判断 PID 是否存活。 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function homeDir(): string {
  try {
    return os.homedir();
  } catch {
    return process.cwd();
  }
}
