/**
 * 「插件」页的纯展示判据。
 *
 * 这些函数原来长在 `panes/PluginPane.vue` 的 `<script setup>` 里，虽然一条 DOM 都不碰，却和
 * `ref` / `computed` 混在一起 —— 于是"某一层叫什么、算不算没贡献、巡检里这条能不能点"
 * 这些**规则**没法单独读、也没法单独测。搬到这里之后：组件里只剩一层薄包装（把 `data` /
 * `problems` 这些响应式来源喂进来）。
 *
 * 纯函数，不许碰 DOM（见 AGENTS §7.36）。
 */

import type {
  PluginEntry,
  PluginLayer,
  PluginLayerEditAction,
  PluginLiveEntry,
  PluginProblem,
  PluginTreeLayer,
} from '../../shared/ipc.js';

/** 层里那一排动作按钮的文案 */
export const LAYER_ACTIONS: Record<PluginLayerEditAction, string> = {
  insert: '插进我的层',
  disable: '禁用',
  enable: '启用',
  'remove-insert': '移除我的插入',
  drop: '删掉这一行',
};

/** 层在界面上的名字：bundle 用包名，patch 层用缩短后的路径（`home` 换成 `~`） */
export function layerName(layer: PluginLayer, home: string): string {
  if (layer.kind === 'in-box' || layer.kind === 'out-of-tree') return layer.name;
  const prefix = home ? `${home}/` : '';
  if (layer.resolvedPath === null) return layer.name.replace(prefix, '~/');
  return layer.resolvedPath.replace(prefix, '~/');
}

/** 是"你自己的层"——界面上要一眼看得出来，别和装的 bundle 混在一起 */
export function isOwnLayer(layer: PluginLayer): boolean {
  return layer.kind === 'profile-patch' || layer.kind === 'home-patch';
}

export function kindLabel(kind: PluginLayer['kind']): string {
  if (kind === 'in-box') return '内置';
  if (kind === 'out-of-tree') return '树外';
  if (kind === 'profile-patch') return '你的层';
  return '机器级';
}

/**
 * 你自己的 patch 层"没贡献"的三种情况，别混成一句：
 * missing = 文件还没建；unmatched = 有 patch 行但一条都没匹配上（那些行会被 dsh 忽略）；
 * empty = 文件里就是 []（这一层什么都不改）。
 */
export function ownLayerState(
  layer: PluginLayer,
  problems: PluginProblem[],
): 'missing' | 'unmatched' | 'empty' {
  if (!layer.resolvedPath) return 'missing';
  const hit = problems.some((item) => item.kind === 'unmatched-patch' && item.file === layer.name);
  return hit ? 'unmatched' : 'empty';
}

export function ownLayerTag(layer: PluginLayer, problems: PluginProblem[]): string {
  const state = ownLayerState(layer, problems);
  if (state === 'missing') return '未创建';
  if (state === 'unmatched') return '没匹配上';
  return '空 []';
}

export function ownLayerWhy(layer: PluginLayer, problems: PluginProblem[]): string {
  const state = ownLayerState(layer, problems);
  if (state === 'missing') return '文件还没创建';
  if (state === 'unmatched') {
    return '里面有 patch 行，但没有一条匹配到现存条目（见页面上方的「需要注意的」）';
  }
  return '文件里是 []';
}

/**
 * 运行中的条目按"配置里的 id"建索引：接口返回的 id 带 `include:` 前缀（它们是从根
 * include 加载进来的），剥掉才和生效配置里的 id 对得上。哈希命名的那些（启动时挂的
 * 目录选择器 / HMR）没有对应配置行，单独列。
 */
export function buildLiveIndex(entries: PluginLiveEntry[]): Map<string, PluginLiveEntry> {
  const map = new Map<string, PluginLiveEntry>();
  for (const entry of entries) map.set(stripIncludePrefix(entry.entryId), entry);
  return map;
}

/** 生效配置里出现过的全部 id（按层分组的那份树） */
export function collectStaticIds(treeLayers: PluginTreeLayer[]): Set<string> {
  const ids = new Set<string>();
  for (const group of treeLayers) {
    for (const entry of group.entries) ids.add(entry.id);
  }
  return ids;
}

/** 运行中但配置里没有的行（根 include + 三个哈希 id 的原生选择器/HMR）—— 两个数量对不上的差额 */
export function liveEntriesOnly(
  entries: PluginLiveEntry[],
  staticIds: Set<string>,
): PluginLiveEntry[] {
  return entries.filter((entry) => !staticIds.has(stripIncludePrefix(entry.entryId)));
}

export function stripIncludePrefix(entryId: string): string {
  const prefix = 'include:';
  return entryId.startsWith(prefix) ? entryId.slice(prefix.length) : entryId;
}

export function stateLabel(phase: PluginLiveEntry['fiberPhase']): string {
  if (phase === 'active') return '运行中';
  if (phase === 'failed') return '加载失败';
  if (phase === 'loading') return '加载中';
  if (phase === 'unloading') return '卸载中';
  if (phase === 'pending') return '待加载';
  return '未挂载';
}

export function problemLabel(kind: PluginProblem['kind']): string {
  if (kind === 'unmatched-patch') return '指向了不存在的条目';
  if (kind === 'parse-error') return '解析失败';
  if (kind === 'plain-dependency') return '不形成层';
  if (kind === 'suspended-bundle') return '掉出了层列表';
  if (kind === 'missing-layer') return '没有贡献';
  return '提示';
}

// 巡检这一块原来只能看。三种"悄悄不生效"里，两种有明确的、安全的出路：
//   1. patch 指向了不存在的 id → 删掉那一行（**只在它能改的那份层上**）；
//   2. 装成了普通依赖、不形成层 → 卸掉它（走 dsh plugin remove，所以要重启 dsh）。
// 第三种（列在 bundles 里却一条都没贡献）没有通用的修法，只把话说清楚。
//
// 还有第四种、也是"临时停用之后回不去"的根因：**包自己声明了 dsh.bundle，却不在
// dsh.profile.bundles 里**（`suspended-bundle`）。它既不是层、也不在 bundles 里 ——
// 层栈详情点不到它，别处也没有入口。这里必须给「放回层里」，否则停用就是个单向门。

/** 这条能不能就地删掉：必须是 profile 那份补丁层里的、而且主进程认得那个文件是它 */
export function canDrop(item: PluginProblem): boolean {
  return item.kind === 'unmatched-patch' && item.editable === true && Boolean(item.entryId);
}

/** 这条能不能就地卸掉：两种"不形成层"都有包名 */
export function canRemove(item: PluginProblem): boolean {
  return (
    (item.kind === 'plain-dependency' || item.kind === 'suspended-bundle') &&
    Boolean(item.packageName)
  );
}

/** 这条能不能放回层里：被摘掉的 bundle（声明过 dsh.bundle 的那种） */
export function canRestore(item: PluginProblem): boolean {
  return item.kind === 'suspended-bundle' && Boolean(item.packageName);
}

/** 这一层在生效配置里的条目（自己插入的 + 它覆盖掉的） */
export function entriesOfLayer(layer: PluginLayer, treeLayers: PluginTreeLayer[]): PluginEntry[] {
  const out: PluginEntry[] = [];
  for (const group of treeLayers) {
    const own = group.source === layer.name && group.patchedBy === null;
    const overridden = group.patchedBy === layer.name;
    if (own || overridden) out.push(...group.entries);
  }
  return out;
}

export interface GroupFilters {
  layerFilter: string;
  onlyDisabled: boolean;
  onlyOverridden: boolean;
  query: string;
}

/** 生效配置视图里的条目（按层分组 + 搜索 + 过滤）；条目被滤空的那些层直接不显示 */
export function visibleGroupsOf(
  treeLayers: PluginTreeLayer[],
  filters: GroupFilters,
): PluginTreeLayer[] {
  const q = filters.query.trim().toLowerCase();
  return treeLayers
    .map((group) => {
      if (
        filters.layerFilter &&
        group.source !== filters.layerFilter &&
        group.patchedBy !== filters.layerFilter
      ) {
        return { ...group, entries: [] };
      }
      const entries = group.entries.filter((entry) => {
        if (filters.onlyDisabled && !entry.disabled) return false;
        if (filters.onlyOverridden && group.patchedBy === null) return false;
        if (!q) return true;
        return entry.id.toLowerCase().includes(q) || entry.name.toLowerCase().includes(q);
      });
      return { ...group, entries };
    })
    .filter((group) => group.entries.length > 0);
}

/** 上面那份筛选结果里一共还有多少条（"显示 N 条"那句） */
export function countEntries(groups: PluginTreeLayer[]): number {
  return groups.reduce((sum, group) => sum + group.entries.length, 0);
}
