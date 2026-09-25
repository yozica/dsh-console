/**
 * profile manifest、`--dump-config` 的解析、层归因、巡检与缺层判定（纯函数为主）
 *
 * t54 从 `plugin-manager.ts` 拆出来的；那个文件现在只剩三个类（Runner / Live / Manager）+ barrel，
 * 别的模块与自检的 import 路径不用改。
 */
import { resolveDshHome } from './session-archive';

import path from 'node:path';

import fs from 'node:fs';

import { execFile } from 'node:child_process';

import { dshLaunchSpec, resolveDshLauncher } from './process-utils';

import type { PluginLayer, PluginProblem, SettingsValues } from '../shared/ipc';

import { DUMP_MAX_BUFFER, DUMP_TIMEOUT_MS, OP_TAIL_CHARS, PLUGIN_PROFILE } from './plugin-shared';

/** profile 的 package.json 里我们用到的部分（别人写的文件，一律按可能缺字段建模） */
interface RawManifest {
  name?: unknown;
  dependencies?: unknown;
  dsh?: { profile?: { bundles?: unknown; patchReload?: unknown } };
}

/** 规范化之后的 profile manifest */
export interface ProfileManifest {
  name: string | null;
  /** 树外依赖：包名 → pnpm 的 spec（`link:../x`、`github:you/x#sha`…） */
  dependencies: Record<string, string>;
  /** 层序（`dsh.profile.bundles`）：内置与树外混在一起，顺序就是应用顺序 */
  bundles: string[];
  /** live（改 patch 即时生效）| startup（只在启动时应用）| null（老 profile 的历史默认） */
  patchReload: string | null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function asStringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(asRecord(value))) {
    if (typeof raw === 'string') out[key] = raw;
  }
  return out;
}

/** 读并规范化 profile 的 manifest；文件不存在或不是 JSON 时抛错（调用方转成界面文案） */
export function readProfileManifest(profileDir: string): ProfileManifest {
  const file = path.join(profileDir, 'package.json');
  const raw: RawManifest = JSON.parse(fs.readFileSync(file, 'utf8')) as RawManifest;
  const profile = asRecord(asRecord(raw.dsh).profile);
  const patchReload = typeof profile.patchReload === 'string' ? profile.patchReload : null;
  return {
    name: typeof raw.name === 'string' ? raw.name : null,
    dependencies: asStringMap(raw.dependencies),
    bundles: asStringArray(profile.bundles),
    patchReload,
  };
}

// ---------------------------------------------------------------- dump 的解析

/** dump 里的一个条目（`- id:` 那一段） */
export interface DumpEntry {
  id: string;
  /** 插件模块标识（`@deepseek-ai/dsh-session-title`，或包内的子路径） */
  name: string;
  disabled: boolean;
  /** 这一条有没有 config 块（生效配置里有值的条目） */
  hasConfig: boolean;
}

/** dump 里的一个层段（相邻同源的行会被合成一段，所以同一层名可能出现多次） */
export interface DumpLayer {
  /** 原始标签，例如 `@deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app` */
  label: string;
  /** 条目本来属于哪一层 */
  source: string;
  /** 被哪一层按 id 覆盖了；null 表示没被覆盖 */
  patchedBy: string | null;
  entries: DumpEntry[];
}

/** 层标签的分隔符：`<源层>, patched by <覆盖层>` */
const PATCHED_BY_RE = /^(.*?), patched by (.*)$/;

/**
 * 解析 `--dump-config` 的输出。
 *
 * 形状（真实样本见 test/fixtures/dump-config-web.txt）：
 *   # == @deepseek-ai/dsh-base
 *   - id: timer
 *     name: '@deepseek-ai/cordis-plugin-timer'
 *   - id: hmr
 *     name: '@deepseek-ai/cordis-plugin-hmr'
 *     disabled: true
 *     config:
 *       root:
 *         - .
 *
 * 只认结构，不做 YAML 求值：本函数是纯函数，好断言、也好在上游改格式时第一时间发现。
 * 认不出来（例如一条 `- id:` 都没有）时返回空数组，由调用方决定降级为原始文本。
 */
export function parseDump(text: string): DumpLayer[] {
  const layers: DumpLayer[] = [];
  let current: DumpLayer | null = null;
  let entry: DumpEntry | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const groupMatch = /^#\s*==\s*(.+?)\s*$/.exec(rawLine);
    if (groupMatch) {
      current = splitLayerLabel(groupMatch[1]);
      layers.push(current);
      entry = null;
      continue;
    }
    const idMatch = /^-\s*id:\s*(.+?)\s*$/.exec(rawLine);
    if (idMatch) {
      if (!current) {
        current = { label: '(未标注层)', source: '(未标注层)', patchedBy: null, entries: [] };
        layers.push(current);
      }
      entry = { id: idMatch[1], name: '', disabled: false, hasConfig: false };
      current.entries.push(entry);
      continue;
    }
    if (!entry) continue;
    const nameMatch = /^\s+name:\s*'?([^']*?)'?\s*$/.exec(rawLine);
    if (nameMatch) {
      entry.name = nameMatch[1];
      continue;
    }
    if (/^\s+disabled:\s*true\s*$/.test(rawLine)) {
      entry.disabled = true;
      continue;
    }
    if (/^\s+config:\s*$/.test(rawLine)) entry.hasConfig = true;
  }

  return layers.filter((layer) => layer.entries.length > 0);
}

/** 把 `A, patched by B` 拆成 source/patchedBy；没有覆盖关系时 patchedBy 为 null */
export function splitLayerLabel(label: string): DumpLayer {
  const match = PATCHED_BY_RE.exec(label.trim());
  if (!match) return { label: label.trim(), source: label.trim(), patchedBy: null, entries: [] };
  return { label: label.trim(), source: match[1], patchedBy: match[2], entries: [] };
}

// ---------------------------------------------------------------- stderr 的解析

/**
 * 从 stderr 里挑出**最像诊断**的那一行。
 *
 * 不能直接取第一行：patch 解析失败时 dsh 是抛异常，stderr 前面是 Node 的堆栈
 * （第一行是 `file:///…/index.js:1197`，真正的消息在 `Error: dsh: failed to parse …`）。
 * 取错了用户看到的就是一串看不懂的路径。
 */
export function firstMeaningfulLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.find((line) => /^(Error|dsh):/.test(line)) ?? lines[0] ?? '';
}

/**
 * 解析 dump/plugin 命令 stderr 上的"没报错的错"。
 *
 * 两种实测格式（都来自真实运行，见 test/fixtures）：
 *   dsh: [/Users/…/profiles/web/cordis.patch.yml] patch: entry "这个条目不存在" not found
 *   Error: dsh: failed to parse overlay /Users/…/profiles/web/cordis.patch.yml: YAMLException: …
 *
 * 未匹配的 patch 行退出码是 0，所以这些**必须**单独看；解析失败则是抛异常（退出码 1）
 * 外加一坨堆栈。堆栈不进 problems（那是日志的事），这里只留能指着某个文件的那几行。
 *
 * `ownPatchFile` 是 profile 那份 `cordis.patch.yml` 的全路径：dsh 在 stderr 上打的层文件
 * 可能是它、也可能是机器级的 `$DSH_HOME/cordis.patch.yml`，而本页只能改前者 —— 所以这里就
 * 把结论（`editable`）算好，别让界面自己去比路径。
 */
export function parseProblems(stderr: string, ownPatchFile?: string): PluginProblem[] {
  const own = ownPatchFile ? path.resolve(ownPatchFile) : '';
  const problems: PluginProblem[] = [];
  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const unmatched = /dsh:\s*\[(.+?)\]\s*patch:\s*entry\s+"(.+?)"\s+not found/.exec(line);
    if (unmatched) {
      problems.push({
        kind: 'unmatched-patch',
        file: unmatched[1],
        entryId: unmatched[2],
        editable: own !== '' && samePath(unmatched[1], own),
        detail: `patch 里指向的条目 "${unmatched[2]}" 不存在，这一行被忽略了`,
      });
      continue;
    }
    const parseError = /dsh:\s*failed to parse\s+(\S+)\s+(.+?):\s+(.*)$/.exec(line);
    if (parseError) {
      problems.push({
        kind: 'parse-error',
        file: parseError[2],
        layer: parseError[1],
        detail: parseError[3] || line,
      });
      continue;
    }
    // 只收"看起来是 dsh 自己说的"那类行；Node 的堆栈与源码摘录留给日志
    if (/^dsh:/.test(line)) problems.push({ kind: 'other', detail: line });
  }
  return problems;
}

// ---------------------------------------------------------------- 跑 dump

export interface DumpRun {
  stdout: string;
  stderr: string;
  display: string;
}

/**
 * 判定一次 dump 的结果。**空输出不是成功**：dsh 的 CLI 在跑不动的 Node 上是
 * 「退出码 0 + 零输出」（见 process-utils 里 pickDshInterpreter 的说明），把它
 * 当成功就会静默显示成"没有插件"。返回 null 表示这次调用可用，否则返回给用户的原因。
 *
 * 单独抽成纯函数是为了能被自检直接钉住——这类"静默坏掉"的判据放自检才有人看着。
 */
export function checkDumpResult(code: number, stdout: string, stderr: string): string | null {
  if (code !== 0) {
    const reason = firstMeaningfulLine(stderr) || `退出码 ${code}`;
    return `没能读出生效配置：${reason}`;
  }
  if (stdout.trim().length === 0) {
    return 'dsh 没有输出任何配置（退出码 0、零输出）。这通常说明选中的解释器跑不动 dsh 的 CLI —— 旧版 Node 上它就是这样静默退出的。可以在设置里把「启动命令」写成「node 的绝对路径 + dsh 入口脚本」。';
  }
  return null;
}

/**
 * 跑一次 `dsh web --dump-config`（`defaultOnly` 时改成 `--dump-default-config`：**不解析
 * 你的层与 `--patch`**，只打印 dsh 自带的组合结果 —— 这是配置被改坏时的唯一出路，
 * 因为它在 patch 文件语法错误时仍然成功（见 §救援流程）。
 *
 * 用 resolveDshLauncher 选出**和启动 dsh 同一个**解释器：dsh 的 CLI 在跑不动的
 * Node 上是"退出码 0 + 零输出"，换一个解释器就等于换一套结果。
 * 另外把解释器所在目录前置进 PATH——node 自己不需要，但 dsh 内部 spawn 的东西要。
 */
export async function runDump(settings: SettingsValues, defaultOnly = false): Promise<DumpRun> {
  const launcher = resolveDshLauncher(settings);
  const flag = defaultOnly ? '--dump-default-config' : '--dump-config';
  // 经统一包装器：Windows 上 shim / npx / 自定义 shim 这三条回退分支给的是 cmd.exe + `/d /s /c`，
  // 直接 execFile 会让 Node 再转义一遍引号，cmd 报 `'"…dsh.cmd"' is not recognized`。
  const spec = dshLaunchSpec(launcher, ['web', flag], process.platform);
  const display = [launcher.display, 'web', flag].join(' ');
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PATH = [path.dirname(launcher.file), env.PATH].filter(Boolean).join(path.delimiter);

  const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      execFile(
        spec.file,
        spec.args,
        {
          timeout: DUMP_TIMEOUT_MS,
          maxBuffer: DUMP_MAX_BUFFER,
          windowsHide: true,
          // 命令行是我们按 cmd 规则拼好的，Node 不要再加引号（见 process-utils 的 launchSpec）
          windowsVerbatimArguments: spec.windowsVerbatimArguments,
          env,
        },
        (error, stdout, stderr) => {
          if (error && typeof (error as { code?: unknown }).code !== 'number') {
            reject(error);
            return;
          }
          const code = error ? Number((error as { code?: unknown }).code ?? 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    },
  );

  const failure = checkDumpResult(result.code, result.stdout, result.stderr);
  if (failure !== null) throw new Error(failure);
  return { stdout: result.stdout, stderr: result.stderr, display };
}

// ---------------------------------------------------------------- 层栈的组装

/** 每个 bundle 的 patch 文件在磁盘上的位置（内置层从 dsh 安装目录解析，树外从 profile 解析） */
export function resolveModuleDir(name: string, dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    const candidate = path.join(dir, 'node_modules', name);
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // 不在这个目录，继续找下一个
    }
  }
  return null;
}

function readVersion(moduleDir: string | null): string | null {
  if (!moduleDir) return null;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(moduleDir, 'package.json'), 'utf8'));
    const version = asRecord(raw).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/** 按层标签把 dump 的层段合并成"这一层做了什么" */
function contributionsOf(
  layers: readonly DumpLayer[],
  name: string,
): {
  inserted: number;
  insertedDisabled: number;
  patched: number;
  patchedDisabled: number;
} {
  let inserted = 0;
  let insertedDisabled = 0;
  let patched = 0;
  let patchedDisabled = 0;
  for (const layer of layers) {
    if (layer.source === name && layer.patchedBy === null) {
      inserted += layer.entries.length;
      insertedDisabled += layer.entries.filter((entry) => entry.disabled).length;
    }
    if (layer.patchedBy === name) {
      patched += layer.entries.length;
      patchedDisabled += layer.entries.filter((entry) => entry.disabled).length;
    }
  }
  return { inserted, insertedDisabled, patched, patchedDisabled };
}

/**
 * 组装层栈：按**应用顺序**（从先到后）列出每一层。
 * 后应用的层优先，所以界面上"越靠下越优先"。
 */
export function buildLayers(options: {
  manifest: ProfileManifest;
  profileDir: string;
  home: string;
  dumpLayers: readonly DumpLayer[];
  moduleDirs: readonly string[];
}): PluginLayer[] {
  const { manifest, profileDir, home, dumpLayers, moduleDirs } = options;
  const layers: PluginLayer[] = [];
  const dependencyNames = new Set(Object.keys(manifest.dependencies));

  manifest.bundles.forEach((name, index) => {
    const outOfTree = dependencyNames.has(name);
    const moduleDir = resolveModuleDir(name, moduleDirs);
    layers.push({
      kind: outOfTree ? 'out-of-tree' : 'in-box',
      name,
      version: readVersion(moduleDir),
      resolvedPath: moduleDir,
      spec: outOfTree ? (manifest.dependencies[name] ?? null) : null,
      order: index + 1,
      present: dumpLayers.some((layer) => layer.source === name || layer.patchedBy === name),
      contributions: contributionsOf(dumpLayers, name),
    });
  });

  const profilePatch = path.join(profileDir, 'cordis.patch.yml');
  layers.push({
    kind: 'profile-patch',
    name: profilePatch,
    version: null,
    resolvedPath: fs.existsSync(profilePatch) ? profilePatch : null,
    spec: null,
    order: null,
    // 这一层"有没有贡献"要看两件事：它插入的行（source 是它）与它覆盖掉的行（patchedBy 是它）——
    // 只看 patchedBy 会把"只插入、没覆盖"的 patch 层误判成空。
    present: dumpLayers.some(
      (layer) => layer.source === profilePatch || layer.patchedBy === profilePatch,
    ),
    contributions: contributionsOf(dumpLayers, profilePatch),
  });

  const homePatch = path.join(home, 'cordis.patch.yml');
  layers.push({
    kind: 'home-patch',
    name: homePatch,
    version: null,
    resolvedPath: fs.existsSync(homePatch) ? homePatch : null,
    spec: null,
    order: null,
    // 这一层"有没有贡献"要看两件事：它插入的行（source 是它）与它覆盖掉的行（patchedBy 是它）——
    // 只看 patchedBy 会把"只插入、没覆盖"的 patch 层误判成空。
    present: dumpLayers.some(
      (layer) => layer.source === homePatch || layer.patchedBy === homePatch,
    ),
    contributions: contributionsOf(dumpLayers, homePatch),
  });

  return layers;
}

/**
 * 一份 package.json 的内容里有没有声明 `dsh.bundle`（纯函数，不碰磁盘）。
 *
 * 这是分两档的**唯一**依据：声明了却是普通依赖 = 它本来该形成层，是被人从
 * `dsh.profile.bundles` 里摘掉的（临时停用 / 手工删过）；没声明 = 它本来就不是 bundle。
 * 两者的出路完全不同（放回层里 / 卸掉它），所以不能只看"不在 bundles 里"。
 */
export function bundleDeclared(raw: unknown): boolean {
  const bundle = asRecord(asRecord(raw).dsh).bundle;
  return bundle !== undefined && bundle !== null && bundle !== false;
}

/** 装进来的那个包**自己**有没有声明 `dsh.bundle`：读 profile 的 node_modules（`link:` 是软链，也读得到） */
export function declaresBundle(profileDir: string, name: string): boolean {
  const moduleDir = resolveModuleDir(name, [profileDir]);
  if (!moduleDir) return false;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(moduleDir, 'package.json'), 'utf8'));
    return bundleDeclared(raw);
  } catch {
    return false;
  }
}

/**
 * 树外依赖里没有形成层的那些：装进来了但不贡献配置（dsh 自己也会打一行 warning）。
 *
 * 分两档（见 `bundleDeclared`）：**声明了 `dsh.bundle` 却不在列表里**的给
 * `suspended-bundle` —— 界面据此给「放回层里」，这是"临时停用之后回不去了"的唯一入口
 * （停用后它既不是层、也不在 bundles 里，别处都点不到它）；真·普通依赖给
 * `plain-dependency`，出路只有「卸掉它」。
 */
export function plainDependencies(manifest: ProfileManifest, profileDir: string): PluginProblem[] {
  const bundles = new Set(manifest.bundles);
  return Object.keys(manifest.dependencies)
    .filter((name) => !bundles.has(name))
    .map((name) =>
      declaresBundle(profileDir, name)
        ? {
            kind: 'suspended-bundle' as const,
            packageName: name,
            detail: `${name} 声明了 dsh.bundle，却不在 dsh.profile.bundles 里 —— 它是被摘掉的（临时停用 / 手工删过），现在不形成配置层`,
          }
        : {
            kind: 'plain-dependency' as const,
            packageName: name,
            detail: `${name} 装成了普通依赖，但它没有声明 dsh.bundle，所以不形成配置层`,
          },
    );
}

/**
 * 两个路径是不是同一个文件。dsh 打出来的是它自己解析过的路径，可能经过 realpath
 * （macOS 上 `/var` → `/private/var`、以及软链接），所以先比 resolve、再比 realpath。
 */
function samePath(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  const real = (value: string): string => {
    try {
      return fs.realpathSync(value);
    } catch {
      return '';
    }
  };
  const resolved = real(a);
  return resolved !== '' && resolved === real(b);
}

/** 列在 bundles 里却在 dump 里没有任何条目：dsh 启动时会明确失败 */
export function missingLayers(
  manifest: ProfileManifest,
  dumpLayers: readonly DumpLayer[],
): PluginProblem[] {
  const seen = new Set<string>();
  for (const layer of dumpLayers) {
    seen.add(layer.source);
    if (layer.patchedBy) seen.add(layer.patchedBy);
  }
  return manifest.bundles
    .filter((name) => !seen.has(name))
    .map((name) => ({
      kind: 'missing-layer' as const,
      detail: `${name} 在层栈里，但生效配置里没有任何来自它的条目 —— dsh 启动时可能因此直接失败`,
    }));
}

// ---------------------------------------------------------------- 装 / 卸 / 升级
//
// 全部走 `dsh plugin --profile web <pnpm 参数>`：它会在 profile 目录里转发给 pnpm，
// 然后按"装出来的包有没有声明 dsh.bundle"重算 `dsh.profile.bundles`。我们不自己改
// package.json、也不自己拼 pnpm 命令 —— 那两个都是 dsh 的职责。
//
// 三条必须守住的：
//   1. spec 是**一个 argv 原样透传**，不经过 shell（不引号、不拼接）—— 拼错一次就是注入；
//   2. 子进程 PATH 要补上 pnpm（见 pathWithKnownBins），否则 GUI 启动必然 127；
//   3. 装/卸/升级改的是 package.json 与 node_modules，**必须重启 dsh 才生效**。

/** 用户输入的是哪类来源（只用于确认文案与提示，命令照原样透传） */
export interface PluginSpec {
  kind: 'npm' | 'local' | 'tarball' | 'git';
  /** 给人看的"代码从哪来" */
  source: string;
  /** git 源是否已经固定了 commit sha（没固定就该提醒） */
  pinned: boolean;
}

/**
 * 这份 patch 层文本里有没有"插入某个包"？只看 `name:` 的值位置（不比注释、不比别的字面量）。
 *
 * 用途：用户在插件页填一个内置包的名字时，得说清他到底想干什么 —— 内置包的分发不经过
 * registry，"装"这个动作对他通常是"启用"（往 patch 层 insert 一行）。而那些早就自己
 * 插过一行的用户（真机上就有）看到"请去 insert 一行"只会更困惑：他以为自己已经装过了。
 */
export function patchLayerInserts(text: string, packageName: string): boolean {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*name:\\s*['"]?${escaped}['"]?\\s*$`, 'm').test(text);
}

/** profile 目录：`$DSH_HOME/profiles/web`（inspect 与 run 都要用） */
export function pluginProfileDir(): string {
  return path.join(resolveDshHome(), 'profiles', PLUGIN_PROFILE);
}

/** 用户的 patch 层里是否已经插入了这个包（读不到文件就算没有） */
export function profilePatchEnables(packageName: string): boolean {
  try {
    return patchLayerInserts(
      fs.readFileSync(path.join(pluginProfileDir(), 'cordis.patch.yml'), 'utf8'),
      packageName,
    );
  } catch {
    return false;
  }
}

/** 从 spec 里取出包名（去掉版本/标签）：`@scope/name@1.2.3` → `@scope/name` */ export function packageNameOf(
  spec: string,
): string {
  const trimmed = spec.trim();
  if (trimmed.startsWith('@')) {
    const scoped = /^(@[^/]+\/[^@]+)/.exec(trimmed);
    return scoped ? scoped[1] : trimmed;
  }
  const at = trimmed.indexOf('@');
  return at === -1 ? trimmed : trimmed.slice(0, at);
}

/**
 * 给一个内置包起一个条目 id：`@deepseek-ai/dsh-time-context` → `time-context`。
 * 这是"插进你的层"时那条 insert 的 id（真机上用户自己那条就是这么写的）。
 */
export function suggestEntryId(packageName: string): string {
  const base = packageName.split('/').pop() ?? packageName;
  return base.replace(/^dsh-/, '');
}

/**
 * 把设置里的"插件安装源"变成子进程环境变量；留空或写错都返回空对象（= 跟随系统 npm 配置）。
 *
 * 只认 http(s) 的 URL：pnpm 也接受 `registry.npmjs.org` 这种裸主机，但那更容易写错，
 * 而写错的代价是"装不上"而不是"报错说配置错了" —— 宁可让它退回系统配置。
 * 注意这是**注入给那一次 `dsh plugin` 子进程**（`npm_config_registry`），
 * 不碰用户的 `~/.npmrc`，也不影响别的项目。
 */
export function pluginRegistryEnv(raw: string | undefined): Record<string, string> {
  const value = String(raw ?? '').trim();
  if (value.length === 0) return {};
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {};
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return {};
  // 去掉末尾斜杠：pnpm 会把 `//` 拼成 `//`，报错信息里看着像另一个主机
  const normalized = value.replace(/\/+$/, '');
  return { npm_config_registry: normalized };
}

/** 认一下 spec 的类型；空值返回 null（界面据此禁用按钮） */
export function parsePluginSpec(raw: string): PluginSpec | null {
  const spec = raw.trim();
  if (spec.length === 0) return null;
  if (/^github:|^git\+|^git@|\.git(?:#|$)|^https?:\/\/github\.com\//i.test(spec)) {
    return {
      kind: 'git',
      source: 'git 仓库（源码，安装时可能执行它的构建脚本）',
      pinned: /#[0-9a-f]{7,40}$/i.test(spec),
    };
  }
  // 打包文件要排在"本地路径"前面判：`./x-0.1.0.tgz` 也以 ./ 开头
  if (spec.endsWith('.tgz') || spec.endsWith('.tar.gz')) {
    return { kind: 'tarball', source: '本地打包文件', pinned: true };
  }
  if (
    spec.startsWith('./') ||
    spec.startsWith('../') ||
    spec.startsWith('/') ||
    spec.startsWith('file:') ||
    spec.startsWith('link:')
  ) {
    return { kind: 'local', source: '本地目录（pnpm 会 link，改源码即改插件）', pinned: true };
  }
  return { kind: 'npm', source: 'npm registry', pinned: false };
}

/**
 * 把 dsh / pnpm 的原始输出归纳成一句人话；认不出来就返回 null，
 * 让界面老老实实显示原文，而不是编一个原因。
 *
 * `requested` 是用户填的 spec（只对 npm 包有意义）：pnpm 404 时缺的常常**不是**用户
 * 写的那个包，而是它某个依赖 —— 不点破这一层，用户会一直去怀疑自己的包名。
 */
export function summarizePluginFailure(
  output: string,
  requested?: string,
  /** 这一轮用的是哪份 pnpm、profile 期望哪一档（`findPnpmForProfile()` 的结果） */
  pnpm?: { used: string | null; expectedMajor: string | null },
): string | null {
  const text = output.slice(-OP_TAIL_CHARS);
  if (/pnpm not found on PATH/i.test(text)) {
    return '没找到 pnpm —— `dsh plugin` 通过它管理插件。装一个 pnpm，或在设置里确认 PATH。';
  }
  // store 布局按 pnpm 大版本走（9 → store/v3、10 → store/v10）。拿另一个大版本去动这份
  // node_modules，pnpm 会拒绝动手并打一段用户看不懂的话 —— 这里把它翻成人话 + 出路。
  // （真机踩过：PATH 里先命中 nvm 里的 corepack shim = pnpm 9，而 profile 是 pnpm 10 装的。）
  if (
    /currently linked from the store at|wants to use the store at|different major version of pnpm/i.test(
      text,
    )
  ) {
    const expected = pnpm?.expectedMajor ? ` pnpm ${pnpm.expectedMajor}` : '另一个大版本的 pnpm';
    const used = pnpm?.used ? `pnpm ${pnpm.used}` : '这次用的那份 pnpm';
    return `这份 profile 的依赖是用${expected}装的，而这次用的是${used} —— 两个大版本的 store 布局不一样（v3 / v10），pnpm 会拒绝动手。换成与 profile 一致的那一档 pnpm 再装（或按 pnpm 的提示把这份依赖重装一次）。`;
  }
  if (/ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED|Ignored build scripts|approve-builds/i.test(text)) {
    return '它需要在安装时构建（等于执行它的代码），pnpm 默认拦住了。按上面打印的键写进 profile 的 pnpm-workspace.yaml（allowBuilds）再重试。';
  }
  if (/ADDING_TO_ROOT|workspace root/i.test(text)) {
    return 'pnpm 把 profile 当成 workspace root 拒了（加 -w 重试也没成）。可以检查 profile 里的 pnpm-workspace.yaml。';
  }
  // 缺的是哪个包：pnpm 会把「没能取到的那个包」单独打一行。它和用户写的包常常不是
  // 同一个 —— 这时按"包不存在"去解释会把人引向错的方向（实测：装
  // @deepseek-ai/dsh-time-context，真正缺的是它依赖链上的 @deepseek-ai/dsh-type-meta，
  // 而那个包在任何 registry 上都没有）。这条要在"淘宝镜像"之前判：换源救不了这种情况。
  const missing = /^(@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?) is not in the npm registry/m.exec(
    text,
  )?.[1];
  const asked = requested ? packageNameOf(requested) : null;
  if (missing && asked && missing !== asked) {
    return `缺的不是你写的「${asked}」，而是它依赖的「${missing}」—— registry 上没有它。换源也未必有用。`;
  }
  // 淘宝旧镜像既会 404 又不该被说成"包不存在"
  if (/registry\.npm\.taobao\.org/i.test(text)) {
    return 'registry 链到了已停服的淘宝旧镜像（registry.npm.taobao.org）—— 换一个能用的源再试，例如 https://registry.npmmirror.com。';
  }
  if (/ERR_PNPM_FETCH_404|404 Not Found/i.test(text)) {
    const host = /GET https?:\/\/([^/\s]+)/i.exec(text)?.[1];
    return host
      ? `${host} 上没有这个包（名字或版本可能不对）。`
      : 'registry 上没有这个包（名字或版本可能不对）。';
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|network/i.test(text)) {
    return '网络不通，没能连上 registry。';
  }
  if (/EPERM|EACCES/i.test(text)) {
    return '权限不足（profile 目录或缓存不可写）。';
  }
  return null;
}
