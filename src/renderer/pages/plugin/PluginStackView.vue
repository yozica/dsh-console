<script setup lang="ts">
/**
 * 插件页的**层栈视图**（t59 从 `PluginPane.vue` 拆出来）：左边是层、右边是选中那一层的详情。
 *
 * 领域的心智模型就是层叠（bundle 层 → 你的 patch 层 → 机器级 patch 层），顺序本身有语义 ——
 * 所以这一块只画"有哪些层、谁覆盖了谁、这一层做了什么"，判定全在 `pages/plugin/plugin-view.ts` 里
 * （这一层不自己认归属，也不自己数条目）。
 *
 * **它不持有状态**：选中哪一层、操作忙不忙、数据是哪一份，都由父级拿着 —— 父级那边还有
 * 同一个选中层的"在生效配置里看这几条"跳转与增删改操作。这里只把点击报回去。
 */
import type { PluginEntry, PluginInspectResult, PluginLayer } from '../../../shared/ipc.js';
import {
  isOwnLayer,
  kindLabel,
  layerName as viewLayerName,
  ownLayerTag as viewOwnLayerTag,
  ownLayerWhy as viewOwnLayerWhy,
} from './plugin-view.js';

const props = defineProps<{
  /** 这一屏读的那份装配信息（基线视图里是内置层的结果，见父级的 `activeData`） */
  data: PluginInspectResult;
  /** 层栈（越靠前越先应用） */
  layers: PluginLayer[];
  /** 当前选中的层在 `layers` 里的下标 */
  selectedIndex: number;
  /** 当前选中的层（拿不到时 null） */
  selected: PluginLayer | null;
  /** 选中那一层在生效配置里的条目（自己插入的 + 它覆盖掉的） */
  selectedEntries: PluginEntry[];
  /** 有操作在跑：升级 / 移除 / 临时停用都要禁用 */
  opBusy: boolean;
}>();

const emit = defineEmits<{
  select: [index: number];
  'jump-to-layer': [layer: PluginLayer];
  'start-op': [action: 'update' | 'remove', spec: string];
  'edit-bundle': [action: 'suspend', name: string];
}>();

/** 点左边那一列 = 换选中层（父级持有 `selectedIndex`） */
function select(index: number): void {
  emit('select', index);
}

function jumpToLayer(layer: PluginLayer): void {
  emit('jump-to-layer', layer);
}

function startOp(action: 'update' | 'remove', spec: string): void {
  emit('start-op', action, spec);
}

function editBundle(action: 'suspend', name: string): void {
  emit('edit-bundle', action, name);
}

// —— 展示判据都在 `pages/plugin/plugin-view.ts` 里；这里只把 props 喂进去（AGENTS §7.36）
const layerName = (layer: PluginLayer): string => viewLayerName(layer, props.data.home || '');
const ownLayerTag = (layer: PluginLayer): string =>
  viewOwnLayerTag(layer, props.data.problems || []);
const ownLayerWhy = (layer: PluginLayer): string =>
  viewOwnLayerWhy(layer, props.data.problems || []);
</script>

<template>
  <div class="plugin-body">
    <section class="panel plugin-side">
      <header class="panel-head">
        <h3>层栈</h3>
        <div class="spacer"></div>
        <span class="bar-hint">从上到下依次应用</span>
      </header>
      <div class="plugin-stack">
        <p class="plugin-stack-note">
          从上到下依次应用，后一层按 <code>id</code> 整条覆盖前一层（替换整个
          <code>config</code>，不是深合并）。最后两行是你自己的 patch 层：profile 级只影响这个
          profile，机器级影响所有 profile、优先级更高。
        </p>
        <div
          v-for="(layer, i) in layers"
          :key="layer.name"
          class="plugin-layer"
          :class="{ active: i === selectedIndex, own: isOwnLayer(layer) }"
          :data-kind="layer.kind"
          @click="select(i)"
        >
          <span class="plugin-layer-order">{{ layer.order ?? '·' }}</span>
          <div class="plugin-layer-main">
            <div class="plugin-layer-name">{{ layerName(layer) }}</div>
            <div class="plugin-layer-meta">
              <span class="plugin-tag">{{ kindLabel(layer.kind) }}</span>
              <span v-if="layer.version" class="plugin-tag mono">{{ layer.version }}</span>
              <span v-if="layer.contributions.inserted" class="plugin-tag">
                {{ layer.contributions.inserted }} 条
              </span>
              <span v-if="layer.contributions.patched" class="plugin-tag">
                覆盖 {{ layer.contributions.patched }}
              </span>
              <span v-if="!layer.present" class="plugin-tag muted">{{
                isOwnLayer(layer) ? ownLayerTag(layer) : '没有贡献'
              }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="panel plugin-detail">
      <header class="panel-head">
        <h3>{{ selected ? layerName(selected) : '选中一层' }}</h3>
        <span v-if="selected?.version" class="plugin-tag mono">{{ selected.version }}</span>
        <div class="spacer"></div>
        <button
          v-if="selected && selectedEntries.length"
          class="btn tiny"
          @click="jumpToLayer(selected)"
        >
          在生效配置里看这 {{ selectedEntries.length }} 条
        </button>
      </header>

      <div v-if="selected" class="plugin-detail-body">
        <dl class="plugin-meta">
          <dt>类型</dt>
          <dd>
            {{ kindLabel(selected.kind) }}
            <span v-if="selected.order"> · profile 层序第 {{ selected.order }}</span>
          </dd>
          <dt>位置</dt>
          <dd>{{ selected.resolvedPath || '（没解析到）' }}</dd>
          <dt>来源</dt>
          <dd>
            {{ selected.spec || (selected.kind === 'in-box' ? '随 dsh 安装目录解析' : '—') }}
          </dd>
          <dt>这一层做了什么</dt>
          <dd>
            插入 {{ selected.contributions.inserted }} 条
            <template v-if="selected.contributions.patched">
              · 覆盖下层 {{ selected.contributions.patched }} 条（其中
              {{ selected.contributions.patchedDisabled }} 条是把下层关掉）
            </template>
          </dd>
        </dl>

        <div v-if="selectedEntries.length" class="plugin-entries">
          <div class="block-head">
            <span>这一层的条目</span>
            <span class="block-note">最多列 12 条</span>
          </div>
          <ul class="plugin-entry-list">
            <li v-for="entry in selectedEntries.slice(0, 12)" :key="entry.id" class="plugin-entry">
              <span class="plugin-entry-id">{{ entry.id }}</span>
              <span class="plugin-entry-name">{{ entry.name }}</span>
              <span v-if="entry.disabled" class="plugin-tag muted">disabled</span>
            </li>
          </ul>
          <p v-if="selectedEntries.length > 12" class="hint">
            还有
            {{ selectedEntries.length - 12 }} 条，点右上角在生效配置里看全部。
          </p>
        </div>
        <p v-else class="hint">
          <template v-if="isOwnLayer(selected)">
            这一层还没有生效的内容（{{ ownLayerWhy(selected) }}）。它的用途是三件事：按条目 id
            覆盖下面某一层、插入新条目（官方随包但默认不启用的插件就是靠这个挂进来），或把某条
            <code>disabled</code> 掉；改完{{
              data.patchReload === 'live' ? '即时生效，不用重启 dsh' : '下次启动 dsh 时生效'
            }}。
          </template>
          <template v-else>
            这一层在生效配置里没有条目。装进来的包如果没声明
            <code>dsh.bundle</code>， 就只会当普通依赖存在，不形成配置层。
          </template>
        </p>

        <!-- 只有树外插件能升级 / 移除：内置的随 dsh 安装目录，动不了也不该动 -->
        <div v-if="selected.kind === 'out-of-tree'" class="plugin-detail-actions">
          <button class="btn small" :disabled="opBusy" @click="startOp('update', selected.name)">
            升级到最新
          </button>
          <span class="spacer"></span>
          <button
            class="btn small"
            :disabled="opBusy"
            title="从 dsh.profile.bundles 里摘掉它（会先备份），重启 dsh 后生效"
            @click="editBundle('suspend', selected.name)"
          >
            临时停用
          </button>
          <button
            class="btn danger small"
            :disabled="opBusy"
            @click="startOp('remove', selected.name)"
          >
            移除
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* t59：这些规则原来在 `PluginPane.vue` 的 <style scoped> 里 —— 只有这一块在用，跟着组件走
   （§7.33：只有这一处在用的规则进组件的 scoped 块；两边都在用的 `.plugin-tag` / `.plugin-entry*`
   已经收进全局表）。 */

/* ---- 视图一：层栈 + 详情 ---- */
.plugin-body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  gap: 14px;
  /* 页面容器的内边距由各页自己给（.pane 只负责定位），这里的值与
     .archive-body / .settings 一致：左右与底部各 20px，顶部 2px（工具条自己有 10px）。 */
  padding: 2px 20px 20px;
}

.plugin-side {
  width: 300px;
  flex: 0 0 300px;
}

.plugin-stack {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

/* 层栈顶部的一句说明：顺序语义 + 最后两行是谁（用户问过"下面这两个是什么"） */
.plugin-stack-note {
  margin: 0;
  padding: 10px 16px 12px;
  border-bottom: 1px solid var(--hairline);
  color: var(--ink-faint);
  font-size: var(--t-xs);
  line-height: 1.7;
}

.plugin-layer {
  position: relative;
  display: flex;
  gap: 10px;
  padding: 10px 14px 10px 12px;
  border-top: 1px solid var(--hairline);
}

.plugin-layer:first-child {
  border-top: 0;
}

.plugin-layer:hover {
  background: var(--surface-2);
}

/* 选中态用伪元素竖线，避免切换时文字左右抖动（归档侧栏踩过这个） */
.plugin-layer.active {
  background: var(--accent-soft);
}

.plugin-layer.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 2px;
  border-radius: 0 2px 2px 0;
  background: var(--accent);
}

.plugin-layer-order {
  flex: 0 0 14px;
  width: 14px;
  padding-top: 1px;
  text-align: right;
  font-family: var(--mono);
  font-size: var(--t-xs);
  color: var(--ink-faint);
}

.plugin-layer-main {
  min-width: 0;
  flex: 1 1 auto;
}

.plugin-layer-name {
  font-family: var(--mono);
  font-size: var(--t-sm);
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 内置层是"本来就有的"，比你自己装的东西淡一档 */
.plugin-layer[data-kind='in-box'] .plugin-layer-name {
  color: var(--ink-dim);
}

.plugin-layer.own .plugin-layer-name {
  color: var(--sky);
}

.plugin-layer-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  margin-top: 5px;
}

/* 详情里只给树外插件的那两个动作 */
.plugin-detail-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--hairline);
}

.plugin-detail {
  flex: 1 1 auto;
  min-width: 0;
}

.plugin-detail-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 0 0 14px;
}

.plugin-meta {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 7px 12px;
  margin: 0;
  padding: 6px 16px 14px;
  font-size: var(--t-sm);
}

.plugin-meta dt {
  color: var(--ink-faint);
  font-size: var(--t-xs);
  padding-top: 1px;
}

.plugin-meta dd {
  margin: 0;
  color: var(--ink-dim);
  font-family: var(--mono);
  font-size: var(--t-sm);
  overflow-wrap: anywhere;
}

.plugin-entries {
  padding-top: 4px;
}

.plugin-entries .block-head {
  padding: 0 16px;
}
</style>
