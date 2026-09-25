/**
 * 命令查找与 PATH 展开：whichSync / windowsBinCandidates / 转发器识别 / findNodeExe
 *
 * 在 PATH 与各版本管理器目录里找可执行文件（从 `process-utils.ts` 拆出来的；那个文件现在只做 barrel 再导出，
 * 6 个消费者与两个反例脚本的 import 路径不用改）。
 */
import { homeDir } from './process-proc';
import type { VersionManagerInstall } from './process-types';
import { isWindows } from './process-types';

import fs from 'node:fs';
import path from 'node:path';

/** 去掉 ANSI 转义序列，便于从终端输出里提取 URL。 */
export function stripAnsi(input: string): string {
  return String(input)
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B[@-Z\\-_]/g, '')
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/** 是普通文件（bin.js 这种交给 node 执行的脚本不需要可执行位） */
export function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 是文件且（POSIX 下）有可执行位。Windows 只看是不是文件。 */
export function isExecutableFile(file: string): boolean {
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
export function versionManagerInstalls(): VersionManagerInstall[] {
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
  /**
   * PATH 上那个 node 如果是**转发器**，它不算"找到了真 node"。
   *
   * 为什么：`~/.vite-plus/env` 会把 `~/.vite-plus/bin` 塞到 PATH **最前面**（用户的 .zshrc 里就
   * 有一行 `. "$HOME/.vite-plus/env"`），而那里的 `node` 是指向 `vp` 的符号链接 —— 它报出来的
   * 版本**随启动环境变**：终端里转发到 nvm 的 22.17.1、GUI 的窄 PATH 下回退到它自带的 24.21.0
   *（真机事故见 §7.25）。所以真 node 永远优先，PATH 上那个转发器只在"一个真 node 都找不到"
   * 时兜底 —— 有总比没有强。
   */
  const pathShim = fromPath !== null && isNodeShim(fromPath) ? fromPath : null;
  if (fromPath && !pathShim) return fromPath;
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
  return pathShim;
}
