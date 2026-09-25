/**
 * pnpm 定位与 VC++ 运行库检测（含"这份 profile 是哪个大版本 pnpm 装的"）
 *
 * 找 pnpm 并匹配 profile 的 store 大版本（从 `process-utils.ts` 拆出来的；那个文件现在只做 barrel 再导出，
 * 6 个消费者与两个反例脚本的 import 路径不用改）。
 */
import { launchSpec } from './process-launch';
import { homeDir } from './process-proc';
import {
  isExecutableFile,
  versionManagerInstalls,
  whichSync,
  windowsBinCandidates,
} from './process-shell';
import { isWindows } from './process-types';

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
  for (const candidate of knownPnpmPaths()) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** `findPnpm()` 扫的那几个已知安装位置（PATH 里没有 pnpm 时的兜底，顺序即优先级） */
function knownPnpmPaths(): string[] {
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
  return candidates;
}

/**
 * 从 profile 的 `node_modules/.modules.yaml` 原文里读出**这份依赖是哪个大版本的 pnpm 装的**。
 *
 * pnpm 把这条记在 `.modules.yaml` 的 `packageManager: pnpm@10.15.0` 里；store 布局按大版本走
 * （9 → `store/v3`、10 → `store/v10`），所以"装插件用哪份 pnpm"必须和这一条对上，否则 pnpm 会
 * 直接拒绝动手（真机踩过：PATH 里先命中 nvm 里的 corepack shim = pnpm 9，而 profile 是 10 装的，
 * 报错是 `… currently linked from the store at … store/v10 … pnpm now wants … store/v3`）。
 *
 * 纯函数（不读盘），自检直接喂文本。
 */
export function parseProfilePnpmMajor(text: string): string | null {
  const version = /^packageManager:\s*pnpm@(\d+)(?:\.\d+)*/m.exec(text)?.[1];
  return version ?? null;
}

/** 读一份 profile 记的 pnpm 大版本（文件不在 / 没这一行 → null） */
export function readProfilePnpmMajor(profileDir: string): string | null {
  try {
    const text = fs.readFileSync(path.join(profileDir, 'node_modules', '.modules.yaml'), 'utf8');
    return parseProfilePnpmMajor(text);
  } catch {
    return null;
  }
}

/** 实测一份 pnpm 的版本号（进程内缓存；拿不到就 null —— 版本不认的候选不参与"对得上"的判定） */
const pnpmVersionCache = new Map<string, string | null>();
export function pnpmVersionOf(file: string): string | null {
  if (pnpmVersionCache.has(file)) return pnpmVersionCache.get(file) ?? null;
  let version: string | null = null;
  try {
    const spec = launchSpec(file, ['-v'], process.platform);
    // 用 spawnSync 而不是 execFileSync：Windows 上 shim 分支要带 `windowsVerbatimArguments`
    // （那是 spawn 系才有的选项），而且"跑不起来"我们要的是 null 而不是抛异常。
    const result = spawnSync(spec.file, spec.args, {
      timeout: 8000,
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    version = /(\d+)\.\d+\.\d+/.exec(`${result.stdout || ''}${result.stderr || ''}`)?.[0] ?? null;
  } catch {
    /* 跑不起来：这个候选不参与"对得上"的判定，记成 null 就行 */
  }
  pnpmVersionCache.set(file, version);
  return version;
}

/** `findPnpmForProfile()` 的结果：选中的那份 + 期望的大版本 + 有没有对上 */
export interface PnpmPick {
  file: string | null;
  version: string | null;
  /** profile 记的期望大版本（读不到 → null，这时只能沿用老规矩：PATH 优先那份） */
  expectedMajor: string | null;
  /** 选中的这份是不是对上了（expectedMajor 为 null 时视为"没有依据，按老规矩"= true） */
  matched: boolean;
}

/** 参与"按大版本挑"的候选：PATH 里那份 + 各已知安装位置（POSIX / Windows 各一条线） */
function pnpmPickCandidates(): string[] {
  const list: string[] = [];
  const push = (file: string | null) => {
    if (file && !list.includes(file)) list.push(file);
  };
  push(findPnpm());
  if (isWindows) {
    const vcRuntime = hasVcRuntime();
    for (const dir of windowsBinCandidates(process.env, homeDir())) {
      for (const name of pnpmExeNames(vcRuntime)) {
        const full = path.win32.join(dir, name);
        if (isExecutableFile(full)) push(full);
      }
    }
    return list;
  }
  for (const candidate of knownPnpmPaths()) {
    if (isExecutableFile(candidate)) push(candidate);
  }
  return list;
}

/**
 * 给某份 profile 挑 pnpm：**大版本与它 `node_modules` 里记的一致者优先**。
 *
 * 为什么要有这一条：装插件走的是 `dsh plugin …`，dsh 在 profile 目录里裸 `spawnSync('pnpm')`
 * —— 它只认 PATH。PATH 里第一份 pnpm 未必是当初装这份 profile 的那一档，而 store 布局按大版本走，
 * 拿错版本去动别人的 `node_modules` 只会得到一段用户看不懂的 pnpm 报错（真机踩过）。
 * 挑不到对得上的，就把最靠前的那份交出去并 `matched: false`，让调用方**说清楚**再试。
 */
export function findPnpmForProfile(profileDir: string): PnpmPick {
  const expectedMajor = readProfilePnpmMajor(profileDir);
  const candidates = pnpmPickCandidates();
  const first = candidates[0] ?? null;
  if (!expectedMajor) {
    return {
      file: first,
      version: first ? pnpmVersionOf(first) : null,
      expectedMajor: null,
      matched: true,
    };
  }
  for (const file of candidates) {
    const version = pnpmVersionOf(file);
    if (version && version.split('.')[0] === expectedMajor) {
      return { file, version, expectedMajor, matched: true };
    }
  }
  return {
    file: first,
    version: first ? pnpmVersionOf(first) : null,
    expectedMajor,
    matched: false,
  };
}
