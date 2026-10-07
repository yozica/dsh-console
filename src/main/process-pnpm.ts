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

import type { EnvPnpmBinding, EnvPnpmOwner } from '../shared/ipc';

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
/**
 * 探测 pnpm 版本时给子进程的环境。
 *
 * **为什么必须关掉 Corepack 的项目绑定**（真机实测 2026-10-07，会在仓库根复现）：Corepack 的 shim
 * 一被调用就看它所在目录有没有 `packageManager` 字段，没有就**替这个项目钉一个**。我们原来
 * 既不给 cwd、也不给 env 地 `spawnSync(pnpm, ['-v'])`，于是"自检"这个本该纯只读的动作会
 * **悄悄改掉用户项目的 `package.json`**：实测多出一行
 * `"packageManager": "pnpm@9.6.0+sha512.…"`（跑一次加一行，跑两次加两次）。
 * `COREPACK_ENABLE_PROJECT_SPEC=0` 是 Corepack 官方的关法；`pnpmProbeCwd()` 再兜一层 ——
 * 万一还有别的工具也按 cwd 写项目文件。
 */
export function pnpmProbeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, COREPACK_ENABLE_PROJECT_SPEC: '0' };
}

/** 探测 pnpm 时的中立工作目录：**绝不能是用户的项目目录**（见 `pnpmProbeEnv` 的说明） */
export function pnpmProbeCwd(): string {
  return os.tmpdir();
}

export function pnpmVersionOf(file: string): string | null {
  if (pnpmVersionCache.has(file)) return pnpmVersionCache.get(file) ?? null;
  let version: string | null = null;
  try {
    const spec = launchSpec(file, ['-v'], process.platform);
    // 用 spawnSync 而不是 execFileSync：Windows 上 shim 分支要带 `windowsVerbatimArguments`
    // （那是 spawn 系才有的选项），而且"跑不起来"我们要的是 null 而不是抛异常。
    // `cwd` / `env` 是**必须**的：不给就会让 Corepack 去改当前目录的 package.json（见 pnpmProbeEnv）。
    const result = spawnSync(spec.file, spec.args, {
      timeout: 8000,
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      cwd: pnpmProbeCwd(),
      env: pnpmProbeEnv(process.env),
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

// ---------------------------------------------------------------- pnpm 的来源 → 怎么更新它

/**
 * 判定归属要喂的那几件事实（**纯函数入参**：反例脚本直接给字面量，不碰磁盘）。
 *
 * `realPath` 是决定性的那一条（跟着符号链接走）：Corepack 与 npm 全局装的 pnpm 都是
 * **符号链接**，只看路径名分不出来（`~/.nvm/…/bin/pnpm` 与 `~/.npm-global/bin/pnpm` 长得一样）。
 */
export interface PnpmOwnerFacts {
  /** 更新对象（那份 pnpm 本身），绝对路径 */
  file: string;
  /** `fs.realpathSync(file)`；取不到时给 `file` 本身 */
  realPath: string;
  isSymlink: boolean;
  /** 是**普通文件**（standalone 那份 62 MB 自带运行时就是这么认的） */
  isFile: boolean;
  platform: string;
  home: string;
}

export interface PnpmOwnerVerdict {
  owner: EnvPnpmOwner;
  /** 逐条依据（人话，进日志；`unknown` 时当那条诚实边界的正文） */
  evidence: string[];
}

/** 把路径归一成可比较的形状（统一正斜杠、去尾斜杠、小写 —— Windows 上大小写不敏感） */
function normalizePathForCompare(value: string): string {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** `file` 是不是正好是 `dir` 下的直系文件（不比大小写、不认结尾分隔符） */
function samePath(one: string, two: string): boolean {
  return normalizePathForCompare(one) === normalizePathForCompare(two);
}

/** 路径里有没有这一段（`/node_modules/corepack/` 这种；跨平台归一之后判断） */
function pathHasSegment(file: string, segment: string): boolean {
  return normalizePathForCompare(file).includes(normalizePathForCompare(segment));
}

/**
 * 这份 pnpm **当初是怎么装的**（纯函数，只读喂进来的事实）。
 *
 * 判据顺序是有意的：**先认那两个"realpath 落在 node_modules 里"的**（Corepack 与 npm 全局装的都是
 * 符号链接，只有 realpath 能区分），再认官方安装脚本那种"普通文件 + 固定位置"。
 *
 * 认不出来一律 `unknown` —— 那意味着**不能替用户猜更新方式**：拿错方式的结果是装出另一份 pnpm，
 * 而插件页用的还是原来那份（用户看到"更新成功"但版本没变）。界面据此走诚实边界。
 */
export function detectPnpmOwner(facts: PnpmOwnerFacts): PnpmOwnerVerdict {
  const { file, realPath, isSymlink, isFile, platform, home } = facts;

  // 1) Corepack：realpath 落在 **/node_modules/corepack/
  if (pathHasSegment(realPath, '/node_modules/corepack/')) {
    return {
      owner: 'corepack',
      evidence: [`realpath 落在 Corepack 的 node_modules 下（${realPath}）→ 它是 Corepack 的 shim`],
    };
  }

  // 2) npm 全局：realpath 落在 **/node_modules/pnpm/
  if (pathHasSegment(realPath, '/node_modules/pnpm/')) {
    return {
      owner: 'npm-global',
      evidence: [
        `realpath 落在全局 node_modules/pnpm 下（${realPath}）→ 它是 \`npm i -g pnpm\` 装的`,
      ],
    };
  }

  // 3) 官方安装脚本（standalone）：固定位置 + **普通文件**。
  //    macOS 是 <home>/Library/pnpm/pnpm、Linux 是 <home>/.local/share/pnpm/pnpm。
  //    "必须是普通文件"这条不能省：同一个位置若是个符号链接，说明那是别处 shim 过来的，不是自带运行时的单文件。
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const standalone =
    platform === 'darwin'
      ? join(home, 'Library', 'pnpm', 'pnpm')
      : join(home, '.local', 'share', 'pnpm', 'pnpm');
  if (samePath(file, standalone) && isFile && !isSymlink) {
    return {
      owner: 'standalone',
      evidence: [
        `${file} 是 pnpm 官方安装脚本的位置（${platform}），而且是普通文件（不是符号链接）→ 自带运行时的那一份`,
      ],
    };
  }

  // 4) Homebrew：装在 /opt/homebrew/** 下，或 realpath 落在 Cellar 里
  //    （`/usr/local/bin/pnpm` 是个符号链接，只有 realpath 会落到 /usr/local/Cellar/**）
  if (pathHasSegment(file, '/opt/homebrew/') || pathHasSegment(realPath, '/Cellar/')) {
    return {
      owner: 'homebrew',
      evidence: [`路径在 Homebrew 的目录下（${file}${isSymlink ? ` → ${realPath}` : ''}）`],
    };
  }

  return {
    owner: 'unknown',
    evidence: [
      `认不出这份 pnpm 是怎么装的：${file}${
        isSymlink ? `（符号链接 → ${realPath}）` : isFile ? '（普通文件）' : ''
      }`,
      '既不在 Corepack / 全局 node_modules 下，也不是官方安装脚本的位置，更不在 Homebrew 的目录下',
    ],
  };
}

/** 从磁盘读上面那几件事实（`realpath` / 符号链接 / 普通文件；任一步失败都不抛） */
export function readPnpmOwnerFacts(file: string): PnpmOwnerFacts {
  let realPath = file;
  try {
    realPath = fs.realpathSync(file);
  } catch {
    // 读不到（权限 / 中间某一段不见了）：退回 file 本身，归属判定会落到 unknown —— 不猜
  }
  let isSymlink = false;
  try {
    isSymlink = fs.lstatSync(file).isSymbolicLink();
  } catch {
    // 读不到（文件在查的那一瞬间被换掉 / 权限）：保持 false —— 判定会落到 unknown，不猜
  }
  let isFile = false;
  try {
    isFile = fs.statSync(file).isFile();
  } catch {
    // 同上：读不到就当"不是普通文件"，判定自然走 unknown 那条
  }
  return { file, realPath, isSymlink, isFile, platform: process.platform, home: homeDir() };
}

/**
 * 认不出归属时给用户的**手工步骤**（不是单一命令 —— 认不出来就不能替用户猜用哪条）。
 *
 * 写成步骤而不是命令是有意的：`fixHint` 的约定是"用户能自己执行的命令或步骤"，
 * 而这里恰好只有"按你当初装的哪种方式来"这一句人话是对的。
 */
export const PNPM_MANUAL_STEPS =
  '按你当初装它的方式手工更新到同一个大版本：Corepack 装的用 `corepack prepare pnpm@<版本> --activate`；' +
  'npm 全局装的用 `npm i -g pnpm@<版本>`；官方安装脚本装的用 `pnpm self-update <版本>`；' +
  'Homebrew 装的用 `brew upgrade pnpm`。目标版本取同一个大版本线内的最新（跨大版本会让 profile 的 store 对不上）。';

/**
 * 「更新 pnpm」的归属事实：**更新对象是 `findPnpmForProfile()` 挑出来的那份**
 * （也就是插件页真正会用的那份），不是 PATH 上随便一份 `findPnpm()`。
 *
 * 这一条与 dsh 那边"绑定到被升级那份所属的 Node"是同一个教训：拿别的 pnpm 去更新，
 * 用户看到"成功"而实际用的那份一个字没变。
 */
export function pnpmBindingForProfile(profileDir: string): EnvPnpmBinding {
  const pick = findPnpmForProfile(profileDir);
  const base = {
    file: pick.file,
    version: pick.version,
    expectedMajor: pick.expectedMajor,
    matched: pick.matched,
  };
  if (!pick.file) {
    return {
      ...base,
      owner: 'unknown',
      canAutoUpdate: false,
      blockedReason: '这台机器上没有找到任何一份 pnpm，所以说不准该更新哪一份。',
      evidence: ['这台机器上没有找到任何一份 pnpm（PATH、已知安装位置都扫过了）'],
      hint: '先在 pnpm 那一行点「一键安装 pnpm」，装好再来更新它。',
    };
  }
  const facts = readPnpmOwnerFacts(pick.file);
  const verdict = detectPnpmOwner(facts);
  const helpers = pnpmHelpersFor({ owner: verdict.owner, file: pick.file }, facts, facts.platform);
  const evidence = [
    `更新对象（profile 匹配到的那份）：${pick.file}${pick.version ? `（${pick.version}）` : ''}`,
    `realpath：${facts.realPath}${facts.isSymlink ? '（是符号链接）' : '（不是符号链接）'}`,
    ...verdict.evidence,
    pick.expectedMajor
      ? `profile 的 .modules.yaml 记的是 pnpm@${pick.expectedMajor}.x → 这份${
          pick.matched ? '对得上' : '**对不上**（store 布局可能不匹配）'
        }`
      : 'profile 没记 pnpm 大版本 → 退回"跟随当前这份的 major"',
  ];
  // 能不能自动更新：归属认得出 **且** 那条路要用的工具真的在。
  // 缺工具时**一律不给按钮**（例如归属是 corepack 却找不到同目录的 corepack）—— 拿错工具更新的结果是
  // 装出另一份 pnpm，而插件页用的还是原来那份。
  const helper = ((): { ok: boolean; why: string } => {
    if (verdict.owner === 'standalone') return { ok: true, why: '' };
    if (verdict.owner === 'corepack') {
      return helpers.corepackFile
        ? { ok: true, why: '' }
        : {
            ok: false,
            why: `归属是 Corepack，但同一个 Node 的目录里没有找到 \`corepack\`（${pick.file} 旁边）`,
          };
    }
    if (verdict.owner === 'npm-global') {
      return helpers.npmFile
        ? { ok: true, why: '' }
        : {
            ok: false,
            why: `归属是 npm 全局安装，但没能从 ${facts.realPath} 反推出那个 Node 的 npm`,
          };
    }
    if (verdict.owner === 'homebrew') {
      return helpers.brewFile
        ? { ok: true, why: '' }
        : { ok: false, why: '归属是 Homebrew，但没有找到 `brew` 本体' };
    }
    return { ok: false, why: `认不出这份 pnpm 当初是怎么装的（${pick.file}）` };
  })();
  const canAutoUpdate = helper.ok;
  const blockedReason = canAutoUpdate
    ? null
    : `${helper.why} —— 说不准该用哪种方式更新它，所以这里不替你动。`;
  if (!canAutoUpdate) evidence.push(blockedReason ?? '');
  return {
    ...base,
    owner: verdict.owner,
    canAutoUpdate,
    blockedReason,
    evidence,
    hint: canAutoUpdate ? null : PNPM_MANUAL_STEPS,
  };
}

/** 归属 → 那条更新命令要用的"工具"（corepack / npm / brew）；找不到的给 null */
export interface PnpmHelpers {
  corepackFile: string | null;
  npmFile: string | null;
  brewFile: string | null;
}

/**
 * 找归属对应的那个工具（IO；`unknown` 不需要）。
 *
 * - **Corepack**：corepack 与那份 shim 在同一个 `bin/` 里（`<nodeDir>/bin/pnpm` → `<nodeDir>/bin/corepack`），
 *   所以从 shim 自己的目录推 —— 这才保证动的是**同一个 Node** 的 corepack。
 * - **npm 全局**：从 realpath 反推 Node / 前缀（`…/lib/node_modules/pnpm/…` → `…`；nvm-windows 没有 `lib`），
 *   再取那个前缀下的 `bin/npm`（POSIX）/ `npm.cmd`（Windows）。
 * - **Homebrew**：`brew` 本体（PATH 里没有就试两个标准位置）。
 */
export function pnpmHelpersFor(
  /** 只需要这两样：归属决定用哪个工具，`file` 是推同目录/同 Node 工具的起点 */
  target: { owner: EnvPnpmOwner; file: string | null },
  facts: PnpmOwnerFacts,
  platform: string,
): PnpmHelpers {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const empty: PnpmHelpers = { corepackFile: null, npmFile: null, brewFile: null };
  const binding = target;
  if (!binding.file) return empty;

  if (binding.owner === 'corepack') {
    const binDir =
      platform === 'win32' ? path.win32.dirname(binding.file) : path.posix.dirname(binding.file);
    const name = platform === 'win32' ? 'corepack.cmd' : 'corepack';
    const candidate = join(binDir, name);
    return { ...empty, corepackFile: isExecutableFile(candidate) ? candidate : null };
  }

  if (binding.owner === 'npm-global') {
    const prefix = nodePrefixFromPnpmRealPath(facts.realPath, platform);
    if (!prefix) return empty;
    const candidate = platform === 'win32' ? join(prefix, 'npm.cmd') : join(prefix, 'bin', 'npm');
    return { ...empty, npmFile: isExecutableFile(candidate) ? candidate : null };
  }

  if (binding.owner === 'homebrew') {
    const fromPath = whichSync('brew');
    if (fromPath) return { ...empty, brewFile: fromPath };
    for (const candidate of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
      if (isExecutableFile(candidate)) return { ...empty, brewFile: candidate };
    }
    return empty;
  }

  return empty;
}

/**
 * 从"npm 全局装的那份 pnpm"的 realpath 反推它所在 Node / 前缀（纯函数，反例脚本直接喂）。
 *
 * 两种布局都认：nvm / 官方 Node 是 `<prefix>/lib/node_modules/pnpm/…`，
 * 而 `~/.npm-global` 这类是 `<prefix>/lib/node_modules/pnpm/…`、Windows 上则是 `<prefix>\node_modules\pnpm\…`。
 * 认不出来给 null（调用方据此**不给**自动动作，而不是猜一个 npm 出来）。
 */
export function nodePrefixFromPnpmRealPath(realPath: string, platform: string): string | null {
  const separators = platform === 'win32' ? /[\\/]/ : /\//;
  const normalized = platform === 'win32' ? realPath.replace(/\//g, '\\') : realPath;
  const marker = 'node_modules';
  const parts = normalized.split(separators).filter((part) => part.length > 0);
  const at = parts.lastIndexOf(marker);
  if (at <= 0 || parts[at + 1] !== 'pnpm') return null;
  // 去掉末尾的 `lib`（POSIX 布局里的 `<prefix>/lib/node_modules`）
  const head = parts.slice(0, at);
  if (head[head.length - 1] === 'lib') head.pop();
  if (head.length === 0) return null;
  const root = platform === 'win32' ? head.join('\\') : `/${head.join('/')}`;
  return root;
}

/** 归属 + 目标版本 → 真正要执行的 spec（**纯函数**；`null` = 这条路不能自动做） */
export interface PnpmUpdateCommand {
  file: string;
  args: string[];
}

/**
 * 「更新 pnpm」的命令。**版本一定要钉上**（`self-update` / `prepare` / `npm i -g` 不带版本都会跳到
 * 最新，而最新很可能是下一个大版本 —— profile 的 store 布局按大版本走，跨大版本会被 pnpm 拒绝，
 * 见 `parseProfilePnpmMajor` 的注释）。所以：
 *
 * - **没有目标版本就不给命令**（拿不到 registry 时宁可不动，也不装一个跨大版本的）；
 * - **Homebrew 不能钉版本**（只认 formula）：目标与当前不在同一条大版本线上时**拒绝**，
 *   能钉的那三条则一律把目标版本拼进 argv。
 */
export function pnpmUpdateCommand(input: {
  binding: EnvPnpmBinding;
  helpers: PnpmHelpers;
  /** 已算好/已校验的目标版本；null = 这一轮没拿到 → 拒绝 */
  target: string | null;
  /** 更新对象现在那一份的版本（判"大版本是否一致"用） */
  currentVersion: string | null;
}): PnpmUpdateCommand | null {
  const { binding, helpers, target, currentVersion } = input;
  if (!binding.file || binding.owner === 'unknown') return null;
  const major = majorOf(target);
  const currentMajor = majorOf(currentVersion);

  if (binding.owner === 'homebrew') {
    if (!helpers.brewFile) return null;
    // `brew upgrade pnpm` 不能钉版本：只有"目标与当前同一条大版本线"时才允许 —— 否则它可能把
    // profile 的 store 布局换个代（Homebrew 的 formula 只跟最新）
    if (!major || !currentMajor || major !== currentMajor) return null;
    return { file: helpers.brewFile, args: ['upgrade', 'pnpm'] };
  }

  if (!target) return null;
  if (binding.owner === 'standalone') {
    return { file: binding.file, args: ['self-update', target] };
  }
  if (binding.owner === 'corepack') {
    if (!helpers.corepackFile) return null;
    return { file: helpers.corepackFile, args: ['prepare', `pnpm@${target}`, '--activate'] };
  }
  if (binding.owner === 'npm-global') {
    if (!helpers.npmFile) return null;
    return { file: helpers.npmFile, args: ['i', '-g', `pnpm@${target}`] };
  }
  return null;
}

/** 版本号的大版本（`10.15.0` → `10`；认不出来给 null） */
export function majorOf(version: string | null | undefined): string | null {
  const matched = /^(\d+)\.\d+\.\d+/.exec(String(version ?? '').trim());
  return matched ? matched[1] : null;
}
