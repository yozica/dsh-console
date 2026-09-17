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

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { dshArgsFor, resolveDshLauncher } from './process-utils';
import { resolveDshHome } from './session-archive';
import type { Settings, SettingsValues } from './settings';
import type {
  PluginEntry,
  PluginFiberPhase,
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

  constructor(
    private readonly settings: Settings,
    /** 当前 dsh 的带令牌地址（DshManager.uiUrl）；由 main.ts 注入 */
    getTokenUrl: () => string | null = () => null,
  ) {
    this.live = new LiveClient(getTokenUrl);
  }

  /** profile 目录（$DSH_HOME/profiles/web） */
  profileDir(): string {
    return path.join(resolveDshHome(), 'profiles', PLUGIN_PROFILE);
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
    };
  }
}
