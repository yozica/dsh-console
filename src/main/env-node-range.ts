/**
 * Node 版本区间：解析、比较与"这句话满不满足"的纯函数（不引 semver，只认这两句区间）
 *
 * t51 从 `env-doctor.ts` 拆出来的；那个文件现在只做 barrel + 两个有状态的类（`EnvDoctor` /
 * `EnvFixRunner`），别的模块与两个反例脚本的 import 路径都不用改。
 */
import type { NodeVersion } from './env-probe-types';

/** 与 vite 的 engines.node 同一句（AGENTS 第 1 节：`npm install` 的门槛）；自检把两处钉在一起 */
export const NODE_RANGE = '^22.19.0 || >=24.0.0';

/**
 * **构建期**要求（vite 的 engines）：只用来判「打包进来的那个运行时」够不够新。
 *
 * 别把它当成"能不能跑 dsh"的判据 —— 这两件事的区间不一样，混用过一次（见 `NODE_RANGE`）。
 */
export const NODE_RANGE_BUILD = '^20.19.0 || >=22.12.0';

/** 解析 `v24.19.0` / `24.19` 这类输出；认不出来返回 null（不猜） */
export function parseNodeVersion(text: string): NodeVersion | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text ?? ''));
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = match[3] === undefined ? 0 : Number(match[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  return { major, minor, patch };
}

/** 比大小（只比 major.minor.patch）：a < b → -1、相等 → 0、a > b → 1 */
export function compareNodeVersion(a: NodeVersion, b: NodeVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/** 区间里那半个版本号 + 它写了几段（`22` → 1、`22.19` → 2、`22.19.0` → 3） */
interface RangeAtom {
  version: NodeVersion;
  parts: 1 | 2 | 3;
}

const RANGE_ATOM = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

function rangeAtomOf(text: string): RangeAtom | null {
  // 预发布 / build 元数据一律丢掉：`22.19.0-rc.1` 当 `22.19.0`（不引 semver，也不猜预发布序）
  const cleaned = String(text ?? '')
    .trim()
    .replace(/[-+].*$/, '');
  // `22.x` / `22.19.x` / `22.*` 当"这一档随便"（= 再退回一段）
  const wildcard = /^(.*?)\.(?:x|X|\*)$/.exec(cleaned);
  const body = wildcard ? wildcard[1] : cleaned;
  const match = RANGE_ATOM.exec(body);
  if (!match) return null;
  const parts = (match[3] !== undefined ? 3 : match[2] !== undefined ? 2 : 1) as 1 | 2 | 3;
  return {
    version: {
      major: Number(match[1]),
      minor: match[2] === undefined ? 0 : Number(match[2]),
      patch: match[3] === undefined ? 0 : Number(match[3]),
    },
    parts,
  };
}

/** 一个比较符：`>=22.19.0` / `<23.0.0` / `=22.19.0`（`^` `~` 与 x-range 在解析时就展开成这些） */
interface Comparator {
  op: '>=' | '>' | '<=' | '<' | '=';
  version: NodeVersion;
}

const nextMajor = (v: NodeVersion): NodeVersion => ({ major: v.major + 1, minor: 0, patch: 0 });
const nextMinor = (v: NodeVersion): NodeVersion => ({
  major: v.major,
  minor: v.minor + 1,
  patch: 0,
});

/**
 * 解析一组比较符（`||` 之间的一段）。**认不出来返回 null**，调用方据此"不猜"。
 *
 * 支持 npm `engines` 里真会出现的写法：`>=` `>` `<=` `<` `=`、`^`、`~`、x-range（`22` / `22.19`
 * / `22.x`）、`*`，以及空格分隔的"与"（`>=22 <23`）。**故意不实现预发布序**：dsh 的依赖链里
 * 没有一条用它，而猜错预发布比说"不知道"更糟（见文件头"不猜"那条）。
 */
function parseComparatorSet(text: string): Comparator[] | null {
  // `>= 22.19.0` 这种"算符与版本之间带空格"是合法写法，先粘回去再按空格切
  const normalized = String(text ?? '')
    .trim()
    .replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1');
  if (!normalized) return [];
  const out: Comparator[] = [];
  for (const token of normalized.split(/\s+/)) {
    if (!token) continue;
    if (token === '*' || token === 'x' || token === 'X') continue; // 随便哪一档
    const caret = token.startsWith('^');
    const tilde = token.startsWith('~');
    const prefixed = /^(>=|<=|>|<|=)/.exec(token);
    const body =
      caret || tilde ? token.slice(1) : prefixed ? token.slice(prefixed[1].length) : token;
    const atom = rangeAtomOf(body);
    if (!atom) return null;
    if (caret || tilde) {
      if (atom.version.major === 0) return null; // `^0.x` 的语义与 Node 无关，别硬套
      out.push({ op: '>=', version: atom.version });
      if (caret) out.push({ op: '<', version: nextMajor(atom.version) });
      else if (atom.parts === 1) out.push({ op: '<', version: nextMajor(atom.version) });
      else out.push({ op: '<', version: nextMinor(atom.version) });
      continue;
    }
    if (prefixed) {
      out.push({ op: prefixed[1] as Comparator['op'], version: atom.version });
      continue;
    }
    // 光写一个版本号：`22.19.0` 是"恰好"、`22.19` 与 `22` 是"这一档"
    if (atom.parts === 3) out.push({ op: '=', version: atom.version });
    else if (atom.parts === 2) {
      out.push({ op: '>=', version: atom.version });
      out.push({ op: '<', version: nextMinor(atom.version) });
    } else {
      out.push({ op: '>=', version: atom.version });
      out.push({ op: '<', version: nextMajor(atom.version) });
    }
  }
  return out;
}

function holdsComparator(version: NodeVersion, comparator: Comparator): boolean {
  const order = compareNodeVersion(version, comparator.version);
  switch (comparator.op) {
    case '>=':
      return order >= 0;
    case '>':
      return order > 0;
    case '<=':
      return order <= 0;
    case '<':
      return order < 0;
    default:
      return order === 0;
  }
}

/**
 * 判一个版本落不落在一句 npm 风格的区间里。**认不出来返回 null**（不是 false）——
 * 调用方据此退回兜底判据，而不是把"没看懂"说成"不满足"。
 *
 * 有这个通用版的原因：区间的出处不再只有我们常量里那两句 —— 本机装的那份 dsh 依赖链里
 * 的下限是**运行时读出来的任意一句**，它没法写死。
 *
 * 语义注意：**顺序无关**。`>=22.19.0 || 乱写` 与 `乱写 || >=22.19.0` 都是 true（有一段说得清、
 * 且它满足就够了）；只有"没有任何一段满足、而且有段认不出来"才是 null。
 */
export function satisfiesSimpleRange(version: NodeVersion, range: string): boolean | null {
  let unknown = false;
  for (const group of String(range ?? '').split('||')) {
    const comparators = parseComparatorSet(group);
    if (!comparators) {
      unknown = true;
      continue;
    }
    if (comparators.every((comparator) => holdsComparator(version, comparator))) return true;
  }
  return unknown ? null : false;
}

/**
 * 一句区间里**最低可接受的版本**（用来给多句区间排名次：谁要的下限最高，谁就是这条依赖链的真门槛）。
 *
 * 只取"下界"侧的比较符；`^22.19.0` 算 22.19.0。认不出来返回 null。
 */
export function minNodeOfRange(range: string): NodeVersion | null {
  let floor: NodeVersion | null = null;
  for (const group of String(range ?? '').split('||')) {
    const comparators = parseComparatorSet(group);
    if (!comparators) return null;
    let groupFloor: NodeVersion | null = null;
    for (const comparator of comparators) {
      if (comparator.op === '<' || comparator.op === '<=') continue;
      if (!groupFloor || compareNodeVersion(comparator.version, groupFloor) < 0) {
        groupFloor = comparator.version;
      }
    }
    if (groupFloor && (!floor || compareNodeVersion(groupFloor, floor) < 0)) floor = groupFloor;
  }
  return floor;
}

/** 一条读到的 `engines.node` 声明（`highestNodeRequirement` 的入参形状） */
export interface NodeEngineDeclaration {
  range: string;
  name: string;
  version: string;
}

/**
 * 一条"谁要的什么下限"：`{ range: '>=22.19.0', name: 'undici', version: '8.10.2', count: 3 }`。
 *
 * `count` = **同一条下限还有几个包也在要**（含自己）。为什么要说这个数：要得狠的往往不止一个包，
 * 只点名其中一个会让人以为那是某个包的怪癖（本机 524 个包里有 3 个都要 `>=22.19.0`）。
 */
export interface NodeRequirement extends NodeEngineDeclaration {
  count: number;
}

/**
 * 一堆 `engines.node` 里**要得最狠**的那条（下限最高的），并数一下同一条下限有几个包。
 *
 * 这就是"本机这份 dsh 到底要哪个 Node"的离线答案：把它的依赖树读一遍，挑出最高的那条下限。
 * 本机实测（dsh 0.1.5-rc.1 / 524 个包）：3 个包要 `>=22.19.0`（其中就有 undici 8）—— 与上游
 * 仓库根那句 `^22.19.0 || >=24.0.0` 的下限一致（上游多排除了奇数版 23）。
 */
export function highestNodeRequirement(entries: NodeEngineDeclaration[]): NodeRequirement | null {
  let best: NodeRequirement | null = null;
  let bestFloor: NodeVersion | null = null;
  for (const entry of entries) {
    const floor = minNodeOfRange(entry.range);
    if (!floor) continue;
    if (!bestFloor || compareNodeVersion(floor, bestFloor) > 0) {
      best = { ...entry, count: 1 };
      bestFloor = floor;
    } else if (best && compareNodeVersion(floor, bestFloor) === 0) {
      best.count += 1;
    }
  }
  return best;
}

/**
 * 是否落在 **dsh 的要求** `^22.19.0 || >=24.0.0` 里（**兜底那句**，见 `effectiveNodeRange`）。
 *
 * 出处（**上游仓库根**，2026-09-20 核过）：
 * https://github.com/deepseek-ai/deepseek-harness/blob/master/package.json
 * → `"engines": { "node": "^22.19.0 || >=24.0.0" }`（那份是 monorepo 根，`private: true`）。
 *
 * 两个容易看走眼的地方：
 *   1. **发布出去的 `@deepseek-ai/dsh` 的 manifest 里没有 `engines`** —— 所以在 `node_modules`
 *      里翻是翻不到的（本机 0.1.5-rc.1 实测如此），npm 也不会因此给任何警告；
 *   2. 真正卡住它的一致下限来自依赖链：undici 8 写着 `engines: { node: '>=22.19.0' }`。
 *
 * 边界：`22.19+` 与 `24+` 算，`23` 与 `≤22.18` 不算。**这条只是兜底** —— 本机装的那份 dsh 是谁、
 * 要什么，运行期读得出来（`readLocalDshRequirement`），别拿这句常量去覆盖它。
 *
 * **别再退回 vite 那句**：`^20.19.0 || >=22.12.0` 是构建期要求，而 20.19 与 22.12–22.18 上
 * dsh 会「退出码 0、零输出」地静默退出（§7.4），界面上只会显示「已停止」。
 */
export function satisfiesNodeRange(version: NodeVersion): boolean {
  return satisfiesSimpleRange(version, NODE_RANGE) === true;
}

/** 是否落在**构建期**要求 `^20.19.0 || >=22.12.0`（vite 的 engines）里 —— 只给「应用自带运行时」用 */
export function satisfiesBuildRange(version: NodeVersion): boolean {
  return satisfiesSimpleRange(version, NODE_RANGE_BUILD) === true;
}

/**
 * **本机装的那一份 dsh 对 Node 的要求**（运行期离线读出来的，见 `readLocalDshRequirement`）。
 *
 * 为什么必须有它（用户裁决）：**不是所有人装的是同一份 dsh**，而我们此前只有一句抄来的常量。
 * 用户"24 以下的 Node 上 dsh 会静默退出"那个观察，真相就在这份数据里 —— 分界线是**这一份**
 * 依赖链要的下限（本机 = `>=22.19.0`，来自 undici 8.10.2），不是"24"。
 */
export interface LocalDshRequirement {
  /** 这份 dsh 自己的版本（读它的 package.json） */
  version: string | null;
  /** 它的安装根（扫描起点；点出来用户能核对是哪一份） */
  root: string | null;
  /** 它在自己 manifest 里声明的 `engines.node`（0.1.5-rc.1 没有 → null） */
  declared: string | null;
  /** 依赖链（含它自己）里要得最狠的那条下限 */
  required: NodeRequirement | null;
  /** 扫过多少个 package.json（证据规模：0 说明根本没读到树） */
  scanned: number;
}

/** 本机那份 dsh 说的 Node 要求（`source` 说明是依赖链还是它自己声明的） */
export interface LocalNodeRange {
  range: string;
  source: 'local' | 'declared';
  by: NodeRequirement;
}

/**
 * 本机那份 dsh 说的要求是哪一句：**依赖链里最高的下限 → 它自己声明的 `engines`**。
 *
 * 为什么依赖链优先：声明可能过期（上游改了但这份还没升），而依赖链是**装进来的事实**。
 * 两句都认不出来时返回 null（调用方退回兜底常量，并在文案里说清来源）。
 */
export function localNodeRange(
  local: LocalDshRequirement | null | undefined,
): LocalNodeRange | null {
  const required = local?.required ?? null;
  if (required && minNodeOfRange(required.range)) {
    return { range: required.range, source: 'local', by: required };
  }
  const declared = local?.declared ?? null;
  if (declared && minNodeOfRange(declared)) {
    return {
      range: declared,
      source: 'declared',
      by: { range: declared, name: '@deepseek-ai/dsh', version: local?.version ?? '', count: 1 },
    };
  }
  return null;
}

/** 「Node 版本」这一行的判据结果（状态与文案都从这里来，纯函数、可离线钉） */
export interface NodeVersionVerdict {
  status: 'ok' | 'warn';
  /** 本机那份 dsh 说的要求；读不到时为 null（这一轮只剩兜底那句） */
  local: LocalNodeRange | null;
  /** 判定实际卡在哪一句：`local` / `upstream` / null（都满足）。文案据此换说法 */
  failedBy: 'local' | 'upstream' | null;
}

/**
 * 判「Node 版本」，**两句都要满足**：本机那份 dsh 说的 + 兜底那句常量。
 *
 * 为什么不是"二选一"（本轮踩过）：依赖链那条下限是数学区间，**它不知道 dsh 的入口用了哪个
 * Node API**。本机这份 dsh 的下限是 `>=22.19.0`，数学上包含奇数版 23，而 23 这条线早于
 * `import.meta.main`（22 线 22.18 / 24 线 24.2 才有）—— 在 23 上 dsh 照样静默空跑。上游那句
 * `^22.19.0 || >=24.0.0` 正是靠 `^22.19.0` 的**上界**把 23 挡在外面的。所以两句取"都要满足"：
 * 本机证据能在它更严时把门槛抬上去（将来 dsh 要 `>=26` 就按 26 判），兜底那句负责挡住
 * 依赖链看不见的那些线。**任何输入都不抛**（放进来的是一份读磁盘读出来的事实）。
 */
export function judgeNodeVersion(
  version: NodeVersion,
  local: LocalDshRequirement | null | undefined,
): NodeVersionVerdict {
  const localRange = localNodeRange(local);
  const localOk = localRange ? satisfiesSimpleRange(version, localRange.range) === true : true;
  const upstreamOk = satisfiesSimpleRange(version, NODE_RANGE) === true;
  return {
    status: localOk && upstreamOk ? 'ok' : 'warn',
    local: localRange,
    failedBy: localOk && upstreamOk ? null : localOk ? 'upstream' : 'local',
  };
}

/**
 * 把一句区间说成"**谁**要的什么"（界面文案用）。
 *
 * 本机证据与兜底常量的区别必须写在脸上：前者是本机测出来的、用户能核对（`来自依赖 undici 8.10.2`）。
 */
export function requirementPhrase(choice: LocalNodeRange): string {
  if (choice.source === 'declared') {
    const version = choice.by.version ? `（${choice.by.version}）` : '';
    return `本机这份 dsh${version}自己声明的要求 ${choice.range}`;
  }
  const who = choice.by.version ? `${choice.by.name} ${choice.by.version}` : choice.by.name;
  const others = choice.by.count > 1 ? ` 等 ${choice.by.count} 个包` : '';
  return `本机这份 dsh 的要求 ${choice.range}（来自依赖 ${who}${others}）`;
}
