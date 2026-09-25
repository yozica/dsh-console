/**
 * nvm-windows 的输出解析、模型推导与注册表偏好
 *
 * t52 从 `node-installer.ts` 拆出来的（那个文件现在只剩 `NodeInstaller` 类 + `NodeInstallHooks`
 * 接口 + barrel；`buildPlan` 与 `transferPhase` 必须留在同一个文件里 —— 反例脚本按这对锚点
 * 切源码，见 AGENTS §7.35）。
 */
import { whichSync } from './process-utils';

import path from 'node:path';

import fs from 'node:fs';

import { findValue, parseRegQueryOutput, runProbe, system32 } from './node-io';

import { envValue } from './node-owner';

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
export function readNvmRegistryPreferences(root: string): NvmRegistryPreferences | null {
  const key = nvmPreferenceKey(root);
  if (!key) return null;
  const probe = runProbe(system32('reg.exe'), ['query', key]);
  if (probe.error !== null || probe.code !== 0) return null;
  const parsed = parseNvmRegistryPreferences(probe.stdout);
  const empty =
    parsed.installsDir === null && parsed.defaultVersion === null && parsed.mode === 'unknown';
  return empty ? null : parsed;
}
