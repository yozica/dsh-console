/**
 * 插件装配层：profile 的 bundle 层栈、生效配置、以及"没报错的错"。
 *
 * 为什么单独一个模块：dsh 的插件有**两个层面**——
 *   - 运行层：已经挂载进配置树的条目、它们的设置项。这一层 dsh 自己的界面
 *     （设置 → 插件）已经在管，console 不重做。
 *   - 装配层：装了什么 bundle、哪个版本、从哪儿来、层序如何、生效配置长什么样。
 *     没有任何界面管这个，而且它是"dsh 因为插件起不来"时唯一的入口。
 *
 * 数据来源只有两处，都是真源：
 *   1. profile 目录本身（`$DSH_HOME/profiles/<name>`）：package.json 的
 *      `dsh.profile.bundles`、`dependencies` 与 `cordis.patch.yml`；
 *   2. `dsh web --dump-config` 的输出：组合后的条目列表，**自带层归因**
 *      （`# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app` 这种注释标签）。
 *      未匹配到条目的 patch 行不在这份输出里，而是打在同一进程的 stderr 上，所以
 *      两份都要收——那正是"静默失效"藏身的地方。
 *
 * 两个必须守住的点：
 *   - **空输出不等于成功**。dsh 的 CLI 在跑不动的 Node 上是"退出码 0 + 零输出"
 *     （见 process-utils 里 pickDshInterpreter 的说明），所以这里把"退出码 0 但
 *     没有输出"当成明确失败并说清原因，绝不静默显示成"没有插件"。
 *   - **`--dump-config` 会写 profile 根文件 `cordis.yml`**（实测：目录只读时报
 *     EPERM）。它不是纯读操作，但那个文件是 dsh 自己在每次启动时维护的，所以
 *     与正在运行的 dsh 不冲突；失败时按"profile 不可写"报出来。
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { applyPatchEdit, type PatchEditRequest, type PatchEditResult } from './patch-layer';
import {
  dshArgsFor,
  findPnpm,
  homeDir,
  pathWithKnownBins,
  resolveDshLauncher,
} from './process-utils';
import { resolveDshHome } from './session-archive';
import type { Settings, SettingsValues } from './settings';
import type {
  PluginEntry,
  PluginFiberPhase,
  PluginOpAction,
  PluginOpResult,
  PluginInspectResult,
  PluginLayer,
  PluginLiveEntry,
  PluginLivePreset,
  PluginLiveSnapshot,
  PluginProblem,
  PluginTreeLayer,
} from '../shared/ipc';

/**
 * console 启动的就是 `dsh web`，而 `dsh web` 是 `--profile web` 的别名，
 * 所以插件页永远针对 `web` 这个 profile。
 * `desktop` 是 CLI 保留给 Electron 的名字（`bin.js` 直接报错），我们不碰也不需要。
 */
export const PLUGIN_PROFILE = 'web';

/** dump 是启动前的组合计算，不该慢；超时按失败处理而不是无限等 */
const DUMP_TIMEOUT_MS = 20_000;
/** 运行中清单走本机 HTTP，正常是毫秒级；超时按"读不到"处理 */
const LIVE_TIMEOUT_MS = 5_000;
/** dsh 客户端的 Remote 端点：`<service>/<method>` 就是 /api 后面的路径 */
const LIVE_ENDPOINT = 'pluginInventory/list';
/** 装/卸/升级最慢的是 pnpm 拉包；给它一个上限，避免界面永远停在"进行中" */
const OP_TIMEOUT_MS = 10 * 60 * 1000;
/** 归纳失败原因时只看尾部这些字节（pnpm 的报错通常在最后） */
const OP_TAIL_CHARS = 8000;
/** 本机 web profile 的 dump 约 17 KB；留足余量，异常大时按失败处理 */
const DUMP_MAX_BUFFER = 8 * 1024 * 1024;

// ---------------------------------------------------------------- 磁盘上的形状

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

function asRecord(value: unknown): Record<string, unknown> {
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
 */
export function parseProblems(stderr: string): PluginProblem[] {
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

interface DumpRun {
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
 * 跑一次 `dsh web --dump-config`。
 *
 * 用 resolveDshLauncher 选出**和启动 dsh 同一个**解释器：dsh 的 CLI 在跑不动的
 * Node 上是"退出码 0 + 零输出"，换一个解释器就等于换一套结果。
 * 另外把解释器所在目录前置进 PATH——node 自己不需要，但 dsh 内部 spawn 的东西要。
 */
async function runDump(settings: SettingsValues): Promise<DumpRun> {
  const launcher = resolveDshLauncher(settings);
  const args = dshArgsFor(launcher, ['web', '--dump-config']);
  const display = [launcher.display, 'web', '--dump-config'].join(' ');
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PATH = [path.dirname(launcher.file), env.PATH].filter(Boolean).join(path.delimiter);

  const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      execFile(
        launcher.file,
        args,
        { timeout: DUMP_TIMEOUT_MS, maxBuffer: DUMP_MAX_BUFFER, windowsHide: true, env },
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
function resolveModuleDir(name: string, dirs: readonly string[]): string | null {
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
function buildLayers(options: {
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

/** 树外依赖里没有形成层的那些：装进来了但不贡献配置（dsh 自己也会打一行 warning） */
export function plainDependencies(manifest: ProfileManifest): PluginProblem[] {
  const bundles = new Set(manifest.bundles);
  return Object.keys(manifest.dependencies)
    .filter((name) => !bundles.has(name))
    .map((name) => ({
      kind: 'plain-dependency' as const,
      detail: `${name} 装成了普通依赖，但它没有声明 dsh.bundle，所以不形成配置层`,
    }));
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
function pluginProfileDir(): string {
  return path.join(resolveDshHome(), 'profiles', PLUGIN_PROFILE);
}

/** 用户的 patch 层里是否已经插入了这个包（读不到文件就算没有） */
function profilePatchEnables(packageName: string): boolean {
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
export function summarizePluginFailure(output: string, requested?: string): string | null {
  const text = output.slice(-OP_TAIL_CHARS);
  if (/pnpm not found on PATH/i.test(text)) {
    return '没找到 pnpm —— `dsh plugin` 通过它管理插件。装一个 pnpm，或在设置里确认 PATH。';
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

/** 一次插件的安装/卸载/升级 */
class PluginRunner {
  private child: ChildProcess | null = null;

  constructor(private readonly settings: Settings) {}

  /** 当前是否有操作在跑（界面上按钮据此禁用，也避免两个 pnpm 同时改同一个目录） */
  get busy(): boolean {
    return this.child !== null;
  }

  cancel(): boolean {
    if (!this.child) return false;
    this.child.kill();
    return true;
  }

  /**
   * 真跑一次 `dsh plugin --profile web <args>`，把输出边读边推给界面。
   * 返回退出码与输出尾部（尾部用于归纳失败原因）。
   */
  private async spawnOnce(
    file: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    onOutput: (chunk: string) => void,
  ): Promise<{ code: number | null; tail: string; error?: string }> {
    let tail = '';
    const collect = (chunk: Buffer | string) => {
      const text = String(chunk);
      tail = (tail + text).slice(-OP_TAIL_CHARS);
      onOutput(text);
    };

    return await new Promise((resolve) => {
      const child = spawn(file, args, {
        env,
        // cwd 必须固定：相对路径（`./hello-plugin`）由 dsh 按**调用目录**解析，
        // 而继承来的 cwd 是 Electron 的启动目录（从 Finder 起可能是 /）—— 那样
        // 用户填的相对路径会莫名其妙地找不到。固定成主目录，界面上也这么写。
        cwd: homeDir(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;

      const timer = setTimeout(() => {
        collect(`\n（超过 ${Math.round(OP_TIMEOUT_MS / 60000)} 分钟，已中断）\n`);
        child.kill();
      }, OP_TIMEOUT_MS);
      timer.unref?.();

      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.on('error', (error) => {
        clearTimeout(timer);
        this.child = null;
        collect(`\n${error.message}\n`);
        resolve({ code: null, tail, error: error.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        this.child = null;
        resolve({ code, tail });
      });
    });
  }

  async run(
    action: PluginOpAction,
    spec: string,
    onOutput: (chunk: string) => void,
  ): Promise<PluginOpResult> {
    if (this.busy) return { ok: false, error: '已经有一个插件操作在进行中' };
    const parsed = parsePluginSpec(spec);
    if (!parsed) return { ok: false, error: '请填写要安装的包名或路径' };

    // 归纳失败原因时只对 npm 包带上"用户写的包名"（本地目录 / git 的 spec 不是包名）
    const requested = parsed.kind === 'npm' ? spec : undefined;

    const launcher = resolveDshLauncher(this.settings.all());

    // 内置包（随 dsh 装好的）装了也白装：它不在"从 registry 取"的路径上，而且
    // 用户真正想做的通常是**启用**它 —— 那是 patch 层 insert 的事。
    if (action === 'add' && parsed.kind === 'npm') {
      const name = packageNameOf(spec);
      const dshRoot =
        launcher.kind === 'node-bin' && launcher.prefixArgs.length > 0
          ? path.dirname(path.dirname(launcher.prefixArgs[0]))
          : null;
      if (name && dshRoot && resolveModuleDir(name, [dshRoot]) !== null) {
        const enabled = profilePatchEnables(name);
        const id = suggestEntryId(name);
        return {
          ok: false,
          error: enabled
            ? `「${name}」是随 dsh 一起装好的内置插件，而且你自己的 patch 层里已经 insert 了它 —— 它已经启用了，这里不需要装任何东西（插件页左边「你的层」那一栏就是它）。内置包的分发不经过 registry，所以 registry 上也确实没有"装了就能用"这回事。`
            : `「${name}」是随 dsh 一起装好的内置插件（已经在 dsh 安装目录里），不需要用 pnpm 再装一遍。要启用它，请在 profile 的 cordis.patch.yml 里 insert 一行 —— 插件页左边「你的层」那一栏就是它。`,
          // 还没启用时，界面就地给一个「插进我的层」按钮（见 PluginPane 的输出区）
          ...(enabled ? {} : { needsEnable: { id, name } }),
        };
      }
    }

    // 没装 pnpm 就别起子进程了：`dsh plugin` 内部是裸 spawnSync("pnpm")，只会以
    // 退出码 127 失败（实测：`dsh: pnpm not found on PATH`），而且它**会先把 profile
    // 初始化出来**才失败 —— 白改一遍磁盘。这里提前说清怎么办。
    // `findPnpm()` 查的就是我们等下要塞给子进程的那份 PATH 加几个已知目录，
    // 所以它说没有，子进程一定找不到。
    if (findPnpm() === null) {
      return {
        ok: false,
        error:
          '这台机器上没找到 pnpm —— dsh 通过它管理 profile 里的插件依赖。装一个（`npm i -g pnpm`，或 `corepack enable pnpm`）再回来，插件页会自己认出来。',
      };
    }

    // `dsh plugin --profile web <action> [-w] <spec>`：spec 永远是**一个** argv，不拼 shell。
    // `-w` 只在 pnpm 自己要求时加（见下面重试）：profile 里那份 pnpm-workspace.yaml 是
    // dsh 模板写的（`packages: [.]`，没有 ignore-workspace-root-check），pnpm 9 会把它
    // 当 workspace root，于是 `add` 直接报 ERR_PNPM_ADDING_TO_ROOT。
    const argsFor = (extra: string[]): string[] =>
      dshArgsFor(launcher, [
        'plugin',
        '--profile',
        PLUGIN_PROFILE,
        action,
        ...extra,
        ...(action === 'update' && spec.trim() === '' ? [] : [spec]),
      ]);
    // 安装源：设置里填了才覆盖，且只覆盖这一个子进程（见 pluginRegistryEnv）
    const registryOverride = pluginRegistryEnv(this.settings.all().pluginRegistry);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: pathWithKnownBins(process.env.PATH),
      ...registryOverride,
    };
    const registry = registryOverride.npm_config_registry;
    if (registry) onOutput(`（本次操作使用 registry：${registry}）\n`);

    const first = await this.spawnOnce(launcher.file, argsFor([]), env, onOutput);
    if (first.error) return { ok: false, code: null, error: first.error };
    if (first.code === 0) return { ok: true, code: first.code };

    if (/ADDING_TO_ROOT|workspace root/i.test(first.tail)) {
      onOutput('\n（pnpm 说这是 workspace root，加 -w 重试）\n');
      const retry = await this.spawnOnce(launcher.file, argsFor(['-w']), env, onOutput);
      if (retry.error) return { ok: false, code: null, error: retry.error };
      if (retry.code === 0) return { ok: true, code: retry.code };
      return {
        ok: false,
        code: retry.code,
        summary: summarizePluginFailure(retry.tail, requested),
      };
    }
    return { ok: false, code: first.code, summary: summarizePluginFailure(first.tail, requested) };
  }
}

// ---------------------------------------------------------------- 运行中的清单
//
// 静态组合（dump）拿不到"运行中"的事实：根 include 行、两个原生目录选择器、HMR
// 这几行是启动时挂的，配置里根本没有；条目是被禁用还是真的活着也只有进程知道。
// 这些只在 dsh 的 Loader 里，而访问它要先过 dsh web 的鉴权 —— 所以走它自己的接口：
//
//   1. GET  <origin>/?token=<控制台捕获的令牌>   → 303 + Set-Cookie: dsh-auth-<hash>=…
//   2. POST <origin>/api/pluginInventory/list   → 带 cookie 与下面这个信封
//
// 这是 rc 版本的内部协议（cookie 名、路径形状、信封字段），上游一改就会失效，
// 所以整条路都是"尽力而为"：任何一步失败都只记一句原因，页面退回纯静态视图。

/** `http://127.0.0.1:3080/?token=xyz` → { origin, token }；没有令牌或不是 URL 时返回 null */
export function parseTokenUrl(
  url: string | null | undefined,
): { origin: string; token: string } | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const token = parsed.searchParams.get('token');
    if (!token) return null;
    return { origin: parsed.origin, token };
  } catch {
    return null;
  }
}

/** 运行中的条目 id 带 `include:` 前缀（它们是从根 include 加载进来的），对配置里的 id 时要剥掉 */
export function stripIncludePrefix(entryId: string): string {
  const prefix = 'include:';
  return entryId.startsWith(prefix) ? entryId.slice(prefix.length) : entryId;
}

/** 一元调用的请求信封（dsh 客户端协议：type / rpcId / method / payload.args） */
export function unaryEnvelope(method: string, rpcId: string): string {
  return JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: {} } });
}

/** 从 server-response 信封里取出 value；ok:false 或形状不对时返回 null */
export function unwrapLiveValue(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const envelope = asRecord(parsed);
  if (envelope.type !== 'server-response') return null;
  const result = asRecord(envelope.result);
  if (result.ok !== true) return null;
  return result.value;
}

/** 把接口返回整理成界面要的形状（计数、预设行数） */
export function summarizeLive(value: unknown): PluginLiveSnapshot {
  const raw = asRecord(value);
  const entries: PluginLiveEntry[] = (Array.isArray(raw.entries) ? raw.entries : []).map((item) => {
    const entry = asRecord(item);
    const phase = entry.fiberPhase;
    return {
      entryId: typeof entry.entryId === 'string' ? entry.entryId : String(entry.entryId ?? ''),
      moduleName: typeof entry.moduleName === 'string' ? entry.moduleName : '',
      enabled: entry.enabled === true,
      fiberPhase: (typeof phase === 'string' ? phase : null) as PluginFiberPhase,
    };
  });
  const presets: PluginLivePreset[] = (Array.isArray(raw.agentPresets) ? raw.agentPresets : []).map(
    (item) => {
      const preset = asRecord(item);
      return {
        id: typeof preset.id === 'string' ? preset.id : '',
        name: typeof preset.name === 'string' ? preset.name : null,
        isDefault: preset.isDefault === true,
        broken: typeof preset.broken === 'string' ? preset.broken : null,
        rows: Array.isArray(preset.rows) ? preset.rows.length : 0,
      };
    },
  );
  return {
    entries,
    presets,
    counts: {
      total: entries.length,
      active: entries.filter((entry) => entry.fiberPhase === 'active').length,
      failed: entries.filter((entry) => entry.fiberPhase === 'failed').length,
      idle: entries.filter((entry) => entry.fiberPhase === null).length,
    },
  };
}

/**
 * 运行中清单的客户端：令牌换 cookie（30 天），再用 cookie 调一次接口。
 * cookie 缓存在实例里；401 时自动重换一次（dsh 重启后旧 cookie 就失效了）。
 */
class LiveClient {
  private cookie: string | null = null;

  constructor(private readonly getTokenUrl: () => string | null) {}

  private async authenticate(origin: string, token: string): Promise<void> {
    const response = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
    });
    const raw = response.headers.getSetCookie?.() ?? [];
    const cookie = raw.map((line) => line.split(';')[0]).find((pair) => pair.includes('='));
    if (!cookie) throw new Error('dsh 没有回访问 cookie（可能这个地址不是它的）');
    this.cookie = cookie;
  }

  private async post(origin: string, method: string, rpcId: string): Promise<Response> {
    return fetch(`${origin}/api/${LIVE_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: unaryEnvelope(method, rpcId),
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
    });
  }

  async fetchInventory(): Promise<PluginLiveSnapshot> {
    const target = parseTokenUrl(this.getTokenUrl());
    if (!target) {
      throw new Error('dsh 不是本应用启动的（拿不到访问令牌），运行中的清单读不到');
    }
    if (!this.cookie) await this.authenticate(target.origin, target.token);

    let response = await this.post(target.origin, LIVE_ENDPOINT, 'plugin-inventory-1');
    if (response.status === 401) {
      // cookie 过期（dsh 重启过）：重换一次再试
      this.cookie = null;
      await this.authenticate(target.origin, target.token);
      response = await this.post(target.origin, LIVE_ENDPOINT, 'plugin-inventory-2');
    }
    if (!response.ok) throw new Error(`dsh 返回 ${response.status}`);
    const value = unwrapLiveValue(await response.text());
    if (value === null) throw new Error('dsh 的应答看不懂（协议可能变了）');
    return summarizeLive(value);
  }
}

// ---------------------------------------------------------------- 对外

export class PluginManager {
  private readonly live: LiveClient;
  private readonly runner: PluginRunner;

  constructor(
    private readonly settings: Settings,
    /** 当前 dsh 的带令牌地址（DshManager.uiUrl）；由 main.ts 注入 */
    getTokenUrl: () => string | null = () => null,
  ) {
    this.live = new LiveClient(getTokenUrl);
    this.runner = new PluginRunner(settings);
  }

  /** 装 / 卸 / 升级：输出边走边推给界面，返回最终结果 */
  async runOperation(
    action: PluginOpAction,
    spec: string,
    onOutput: (chunk: string) => void,
  ): Promise<PluginOpResult> {
    return await this.runner.run(action, spec, onOutput);
  }

  /**
   * 改你自己的补丁层（插入 / 禁用 / 启用 / 移除插入）。
   *
   * **只写 profile 的 `cordis.patch.yml`** —— 那是 profile 级的用户层，不影响 `$DSH_HOME`
   * 级的 `cordis.patch.yml`，也不碰各 bundle。落盘前会备份、原子写；细节见 patch-layer.ts。
   * 这一层是 `patchReload: live`，所以改完即时生效（界面照实写，不催重启）。
   */
  async editLayer(request: PatchEditRequest): Promise<PatchEditResult> {
    const result = applyPatchEdit(this.profileDir(), request);
    if (!result.ok || !result.changed || !result.file) return result;

    // 回读验证：这是我们唯一会写的**用户文件**，"dsh 认不认"必须当场知道，不能等用户
    // 下次打开插件页才发现（真机事故：移除最后一条 insert 之后文件只剩注释，dsh 判它不是
    // 顶层数组，整个插件页读不出来）。只有失败指向这份 overlay 时才回滚 —— dsh 因为别的
    // 原因跑不起来（解释器不对等）不该把一次正确的改动撤掉。
    try {
      await runDump(this.settings.all());
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 必须"点名到这份文件"才算我们写坏了：别的 overlay（比如 $DSH_HOME 级那份）坏了，
      // 不该把这次正确的改动撤掉。
      const blamed = result.file !== undefined && message.includes(result.file);
      if (!blamed || !/top-level YAML array|overlay/i.test(message)) return result;
      const restored = this.rollbackEdit(result);
      return {
        ok: false,
        file: result.file,
        backup: result.backup,
        error: `${message}${restored ? ' —— 已经把补丁层回滚到改动前的内容，没有写坏。' : ' —— 回滚也没成功，请从备份文件手工恢复。'}`,
      };
    }
  }

  /** 把上一次改动用备份还原（没有备份说明改动前这个文件不存在，那就删掉它） */
  private rollbackEdit(result: PatchEditResult): boolean {
    if (!result.file) return false;
    try {
      if (result.backup) fs.copyFileSync(result.backup, result.file);
      else fs.rmSync(result.file, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  cancelOperation(): boolean {
    return this.runner.cancel();
  }

  /** 操作在跑时界面要禁用另一处入口（同一个 profile 目录不能被两个 pnpm 同时改） */
  get operationBusy(): boolean {
    return this.runner.busy;
  }

  /** profile 目录（$DSH_HOME/profiles/web） */
  profileDir(): string {
    return pluginProfileDir();
  }

  /**
   * 一次读完：层栈 + 生效配置 + 所有"没报错的错"。
   * 只跑一次 dump（两次调用等于同一个组合算两遍），页面加载时就调它。
   */
  async inspect(): Promise<PluginInspectResult> {
    const home = resolveDshHome();
    const profileDir = this.profileDir();
    const manifest = readProfileManifest(profileDir);

    // 内置层从 dsh 安装目录解析；树外层与共享目录也各算一个候选
    const launcher = resolveDshLauncher(this.settings.all());
    const dshRoot =
      launcher.kind === 'node-bin' && launcher.prefixArgs.length > 0
        ? path.dirname(path.dirname(launcher.prefixArgs[0]))
        : null;
    const moduleDirs = [profileDir, ...(dshRoot ? [dshRoot] : []), path.join(home, 'profiles')];

    // dump（静态组合）与运行中清单互不依赖，并行取；运行中清单是"尽力而为"，失败不影响页面
    const [run, liveResult] = await Promise.all([
      runDump(this.settings.all()),
      this.live
        .fetchInventory()
        .then((snapshot) => ({ snapshot, error: '' }))
        .catch((error: unknown) => ({
          snapshot: null,
          error: error instanceof Error ? error.message : String(error),
        })),
    ]);
    const dumpLayers = parseDump(run.stdout);
    const problems = [
      ...parseProblems(run.stderr),
      ...plainDependencies(manifest),
      ...missingLayers(manifest, dumpLayers),
    ];

    const treeLayers: PluginTreeLayer[] = dumpLayers.map((layer) => ({
      label: layer.label,
      source: layer.source,
      patchedBy: layer.patchedBy,
      entries: layer.entries.map((entry): PluginEntry => ({
        id: entry.id,
        name: entry.name,
        disabled: entry.disabled,
        hasConfig: entry.hasConfig,
      })),
    }));

    return {
      ok: true,
      profile: PLUGIN_PROFILE,
      home,
      profileDir,
      profileName: manifest.name,
      patchReload: manifest.patchReload,
      layers: buildLayers({ manifest, profileDir, home, dumpLayers, moduleDirs }),
      treeLayers,
      problems,
      entryCount: dumpLayers.reduce((sum, layer) => sum + layer.entries.length, 0),
      commands: [run.display],
      // 解析不出来（上游改了格式）时保留原文，界面降级成纯文本视图而不是空白
      rawDump: dumpLayers.length === 0 ? run.stdout : null,
      live: liveResult.snapshot,
      liveError: liveResult.error || undefined,
      // 装/卸/升级要 pnpm；`dsh plugin` 自己是裸 spawn，所以这里先把结论告诉界面
      pnpm: (() => {
        const found = findPnpm();
        return { found: found !== null, path: found };
      })(),
      // 界面上要能看见"这次装会走哪个源"；null = 跟随系统 npm 配置
      registry: pluginRegistryEnv(this.settings.all().pluginRegistry).npm_config_registry ?? null,
    };
  }
}
