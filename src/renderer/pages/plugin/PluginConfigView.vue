<script setup lang="ts">
/**
 * 插件页的**生效配置视图**（t64 从 `PluginPane.vue` 拆出来）：组合出来的条目按层分组 + 搜索 / 过滤，
 * 以及"改你自己的补丁层"那三个动作（禁用 / 启用 / 移除我的插入）与"运行中但不在配置里"的那几行。
 *
 * **它不持有状态**：搜索词、两个过滤开关、分组、运行中索引、基线与忙位都由父级拿着 ——
 * 同一份数据父级的层栈视图与操作输出也在读（`activeData` / `opBusy`），拆开就会变成两个真源。
 * 这里只把输入与点击报回去；分组与过滤是父级用 `pages/plugin/plugin-view.ts` 的纯函数算好的。
 */
import { stateLabel } from './plugin-view.js';
import type {
  PluginEntry,
  PluginInspectResult,
  PluginLiveEntry,
  PluginLayerEditAction,
} from '../../../shared/ipc.js';

/** 按层分好组、过滤完的条目（`pages/plugin/plugin-view.ts` 的 `visibleGroupsOf` 的输出） */
interface ConfigGroup {
  label: string;
  source: string;
  patchedBy: string | null;
  entries: PluginEntry[];
}

const props = defineProps<{
  /** 搜索词（`v-model` 在父级，这里只报回去） */
  query: string;
  /** 「只看被覆盖的」开着吗 */
  onlyOverridden: boolean;
  /** 「只看禁用」开着吗 */
  onlyDisabled: boolean;
  /** 只看某一层（从层栈详情跳过来时设置）；空串 = 不过滤 */
  layerFilter: string;
  /** 当前筛出来多少条 */
  shownEntries: number;
  /** 这一屏读的是哪份数据：基线（救援）还是完整配置 */
  activeData: PluginInspectResult | null;
  /** 是不是"只看内置层"那一轮（基线下不给改自己的层） */
  baseline: PluginInspectResult | null;
  /** 过滤后的分组 */
  visibleGroups: ConfigGroup[];
  /** 运行中但配置里没有的行（根 include + 原生选择器 / HMR） */
  liveOnly: PluginLiveEntry[];
  /** 会话插件行数（来自运行中的 dsh） */
  presets: { id: string; isDefault: boolean; rows: number }[];
  /** 有操作在跑：三个行内按钮都要禁用 */
  opBusy: boolean;
  /** 条目 id → 运行中事实 */
  liveById: Map<string, PluginLiveEntry>;
  /** 你自己那张补丁层的路径（空串 = 没认出来，不给"移除我的插入"） */
  myPatchPath: string;
}>();

const emit = defineEmits<{
  'update:query': [value: string];
  'toggle-overridden': [];
  'toggle-disabled': [];
  'clear-filters': [];
  'back-to-full': [];
  'edit-layer': [action: PluginLayerEditAction, id: string];
}>();

function onQuery(event: Event): void {
  emit('update:query', (event.target as HTMLInputElement).value);
}

function toggleOverridden(): void {
  emit('toggle-overridden');
}

function toggleDisabled(): void {
  emit('toggle-disabled');
}

function clearFilters(): void {
  emit('clear-filters');
}

function backToFull(): void {
  emit('back-to-full');
}

function editLayer(action: PluginLayerEditAction, id: string): void {
  emit('edit-layer', action, id);
}

/** 条目的运行状态：接口读不到时返回 null，界面就什么都不标 */
function liveState(id: string): PluginLiveEntry | null {
  return props.liveById.get(id) ?? null;
}

/** 这一组条目是不是你自己那张补丁层插入的（是的话可以整条移除） */
function isMyLayer(source: string): boolean {
  return props.myPatchPath !== '' && source === props.myPatchPath;
}
</script>

<template>
  <section class="panel plugin-config">
    <div class="plugin-config-bar">
      <input
        id="plugin-search"
        :value="query"
        @input="onQuery"
        class="plugin-search"
        type="search"
        placeholder="搜条目 id 或插件包名…"
      />
      <button class="plugin-filter" :class="{ active: onlyOverridden }" @click="toggleOverridden">
        只看被覆盖的
      </button>
      <button class="plugin-filter" :class="{ active: onlyDisabled }" @click="toggleDisabled">
        只看禁用
      </button>
      <span v-if="layerFilter" class="plugin-tag">只看 {{ layerFilter }}</span>
      <div class="spacer"></div>
      <span class="bar-hint">{{ shownEntries }} / {{ activeData?.entryCount }} 条</span>
      <button v-if="layerFilter" class="btn tiny" @click="clearFilters">清除筛选</button>
    </div>

    <div v-if="activeData?.rawDump" class="plugin-raw">
      <p class="hint">没能把 dump 解析成结构（dsh 的输出格式可能变了），下面是原样输出。</p>
      <pre class="plugin-raw-text">{{ activeData.rawDump }}</pre>
    </div>

    <div v-else class="plugin-config-body">
      <p class="plugin-scope">
        口径：这里是 <code>--dump-config</code> 组合出来的<b>行</b>（各 bundle 的 patch + 你的 patch
        层）。运行中的 Loader 条目还多出几行 —— 启动时挂上的根 <code>include</code> 与原生目录选择器
        / HMR，它们不在配置文件里（见下面的「运行时挂载」）。两个数字回答的不是同一个问题，
        所以不等。<template v-if="activeData?.live">dsh 在跑时，两个数都给你。</template>
      </p>
      <p v-if="baseline" class="plugin-baseline-note">
        <b>这是 dsh 自带的组合结果</b>（<code>--dump-default-config</code>，不解析你的层与
        <code>--patch</code>）。跟平时的「生效配置」对比，就能看出问题出在你的层还是内置层。
        <button class="btn tiny" @click="backToFull">回到完整配置</button>
      </p>
      <template v-for="(group, gi) in visibleGroups" :key="`${group.label}-${gi}`">
        <div class="plugin-group" :class="{ overridden: group.patchedBy !== null }">
          <span class="plugin-group-name">{{ group.source }}</span>
          <span class="plugin-group-note">
            <template v-if="group.patchedBy">— 被 {{ group.patchedBy }} 覆盖，</template>
            {{ group.entries.length }} 条
          </span>
        </div>
        <ul class="plugin-entry-list">
          <li
            v-for="entry in group.entries"
            :key="`${group.label}-${entry.id}`"
            class="plugin-entry"
          >
            <span class="plugin-entry-id">{{ entry.id }}</span>
            <span class="plugin-entry-name">{{ entry.name }}</span>
            <span v-if="entry.disabled" class="plugin-tag muted">disabled</span>
            <span v-else-if="group.patchedBy" class="plugin-tag accent">被覆盖</span>
            <span
              v-if="!baseline && liveState(entry.id)"
              class="plugin-state"
              :data-phase="liveState(entry.id)?.fiberPhase"
              >{{ stateLabel(liveState(entry.id)?.fiberPhase ?? null) }}</span
            >
            <!-- 改你自己的补丁层：禁用/启用是"写一条覆盖"，移除只对自己插入的条目开放 -->
            <span v-if="!baseline" class="plugin-entry-actions">
              <button
                class="btn tiny"
                :disabled="opBusy"
                :title="`在你自己的补丁层里${entry.disabled ? '去掉' : '加上'} disabled`"
                @click="editLayer(entry.disabled ? 'enable' : 'disable', entry.id)"
              >
                {{ entry.disabled ? '启用' : '禁用' }}
              </button>
              <button
                v-if="isMyLayer(group.source)"
                class="btn tiny"
                :disabled="opBusy"
                title="从你的补丁层里删掉这条插入"
                @click="editLayer('remove-insert', entry.id)"
              >
                移除我的插入
              </button>
            </span>
          </li>
        </ul>
      </template>
      <p v-if="visibleGroups.length === 0" class="hint">没有匹配的条目。</p>

      <!-- 运行中但配置里没有的行：根 include + 启动时挂的原生选择器 / HMR。
         这正是「运行中」与「组合条目」两个数字对不上的那几行。 -->
      <template v-if="liveOnly.length && !query && !layerFilter && !baseline">
        <div class="plugin-group">
          <span class="plugin-group-name">运行时挂载</span>
          <span class="plugin-group-note"
            >— 不在配置文件里，启动时由 dsh 自己挂的，{{ liveOnly.length }} 条</span
          >
        </div>
        <ul class="plugin-entry-list">
          <li v-for="entry in liveOnly" :key="entry.entryId" class="plugin-entry">
            <span class="plugin-entry-id">{{ entry.entryId }}</span>
            <span class="plugin-entry-name">{{ entry.moduleName }}</span>
            <span class="plugin-state" :data-phase="entry.fiberPhase">{{
              stateLabel(entry.fiberPhase)
            }}</span>
          </li>
        </ul>
      </template>

      <p v-if="presets.length" class="plugin-presets">
        会话插件（Agent 预设按会话组装的行数）：
        <span v-for="preset in presets" :key="preset.id" class="plugin-tag mono"
          >{{ preset.id }}<template v-if="preset.isDefault">（默认）</template>
          {{ preset.rows }} 行</span
        >
      </p>
    </div>
  </section>
</template>

<style scoped>
/* t64：这 26 条原来在 `PluginPane.vue` 的 <style scoped> 里 —— 生效配置视图只有这一块在用，
   跟着组件走（`.plugin-entry*` / `.plugin-tag*` 是父子共用的，t59 起已经在全局表）。 */

/* 生效配置每行右侧的「禁用 / 启用 / 移除我的插入」：不抢条目宽度，靠右对齐 */
.plugin-entry-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  flex: 0 0 auto;
}

/* 运行状态：只有在拿到运行中清单时才出现（拿不到就什么都不标，不猜） */
.plugin-state {
  display: inline-flex;
  align-items: center;
  height: 17px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--run-soft);
  color: var(--run);
  font-size: 10.5px;
  white-space: nowrap;
}

.plugin-state[data-phase='failed'] {
  background: var(--rose-soft);
  color: var(--rose);
}

.plugin-state[data-phase='pending'],
.plugin-state[data-phase='loading'],
.plugin-state[data-phase='unloading'] {
  background: var(--amber-soft);
  color: var(--amber);
}

/* fiberPhase 为空 = 没有存活的根 fiber（多半被上层禁用了），不是"正常" */
.plugin-state[data-phase=''] {
  background: transparent;
  color: var(--ink-faint);
}

/* 会话插件（Agent 预设）行数：解释 Harness 里那个"28 个" */
.plugin-presets {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin: 0;
  padding: 10px 16px 14px;
  color: var(--ink-faint);
  font-size: var(--t-xs);
}

/* 详情里每一行都自己带 16px 内边距（条目行要整行 hover / 分隔线，不能靠父级 padding），
   所以这里的说明句必须单独补 —— 漏了就会像"贴到面板边上"那样顶头。 */
.plugin-entries > .hint,
.plugin-detail-body > .hint,
.plugin-config-body > .hint {
  padding: 0 16px;
}

/* ---- 视图二：生效配置 ---- */
.plugin-config {
  flex: 1 1 auto;
  min-height: 0;
  /* 与两边对齐的那一套一致：左右 20px、底部 20px */
  margin: 0 20px 20px;
}

.plugin-config-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 16px;
  border-bottom: 1px solid var(--hairline);
  flex: 0 0 auto;
}

.plugin-search {
  height: 30px;
  min-width: 240px;
  padding: 0 10px;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--r-control);
  background: var(--well);
  color: var(--ink);
  font-family: var(--mono);
  font-size: var(--t-sm);
}

.plugin-search::placeholder {
  color: var(--ink-faint);
}

.plugin-filter {
  height: 23px;
  padding: 0 9px;
  border: 1px solid var(--hairline);
  border-radius: 999px;
  background: transparent;
  color: var(--ink-faint);
  font-size: var(--t-xs);
}

.plugin-filter.active {
  border-color: transparent;
  background: var(--accent-soft);
  color: var(--accent);
}

.plugin-config-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

/* 口径说明：生效配置数的是"组合出来的行"，与 Harness 那份"运行中的 Loader 条目"不是一个口径 ——
   用户对着两个数字会问，所以写在数字所在的那一屏里，而不是藏在 tooltip 里。 */
.plugin-scope {
  margin: 0;
  padding: 10px 16px 12px;
  color: var(--ink-faint);
  font-size: var(--t-xs);
  line-height: 1.7;
}

.plugin-scope b {
  color: var(--ink-dim);
  font-weight: 600;
}

/* 分组标题：dump 自己是按"源层 / 被谁覆盖"分段的，这里照抄它的语义 */
.plugin-group {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 16px;
  border-top: 1px solid var(--hairline);
  border-bottom: 1px solid var(--hairline);
  background: var(--surface-2);
  font-size: var(--t-xs);
}

.plugin-group:first-child {
  border-top: 0;
}

.plugin-group-name {
  font-family: var(--mono);
  color: var(--ink);
}

.plugin-group-note {
  color: var(--ink-faint);
}

.plugin-group.overridden .plugin-group-name {
  color: var(--sky);
}

/* 解析不出结构时的降级视图：原文照贴，而不是显示成空白 */
.plugin-raw {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 12px 16px;
}

.plugin-raw .hint {
  margin: 0 0 10px;
}

.plugin-raw-text {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--hairline);
  border-radius: var(--r-panel);
  background: var(--well);
  color: var(--ink-dim);
  font-family: var(--mono);
  font-size: var(--t-xs);
  line-height: 1.7;
  white-space: pre-wrap;
}

/* 基线视图（--dump-default-config）的说明条 */
.plugin-baseline-note {
  margin: 0 0 10px;
  padding: 8px 10px;
  border: 1px solid var(--hairline-strong);
  border-left: 3px solid var(--accent);
  border-radius: var(--r-control);
  background: var(--well);
  font-size: var(--t-sm);
  color: var(--ink-dim);
}

.plugin-baseline-note .btn {
  margin-left: 8px;
}
</style>
