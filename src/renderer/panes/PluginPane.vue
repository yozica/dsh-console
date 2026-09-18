<script setup lang="ts">
/**
 * 插件页：**装配层**的只读视图。
 *
 * 这一页回答的不是"有哪些插件在跑"（那是 dsh 自己界面里「设置 → 插件」的活），
 * 而是"我装了什么、按什么顺序叠上去的、生效配置最后长什么样、哪一处悄悄没生效"。
 *
 * 三个刻意的设计决定：
 *  1. **左边是层，不是插件**。领域的心智模型就是层叠（bundle 层 → 你的 patch 层 →
 *     机器级 patch 层），顺序本身有语义：越靠后越优先。用编号列表表达它，
 *     比一张按字母排的插件表更接近真相。
 *  2. **生效配置是同一页的第二个视图**，因为它跟层栈是同一件事的两面：
 *     "这个插件到底生效了吗" = 层栈里找到它 + 配置里搜到它的条目。
 *  3. **dsh 没在跑也要能用**。数据来自磁盘与 `dsh web --dump-config`，不依赖服务；
 *     插件把启动打挂时，恰恰只有这一页还能看。
 */
import { computed, ref, watch } from 'vue';
import { currentTab } from '../lib/store.js';
import type {
  PluginEntry,
  PluginLayerEditAction,
  PluginOpAction,
  PluginInspectResult,
  PluginLayer,
  PluginLiveEntry,
  PluginProblem,
} from '../../shared/ipc.js';

const api = window.dshConsole;

const data = ref<PluginInspectResult | null>(null);
const loading = ref(false);
const error = ref('');
const view = ref<'stack' | 'config'>('stack');
const query = ref('');
const onlyOverridden = ref(false);
const onlyDisabled = ref(false);
/** 只看某一层（从层栈详情跳过来时设置） */
const layerFilter = ref('');

let loadedOnce = false;

function say(message: string): void {
  window.dispatchEvent(new CustomEvent('dsh:status-message', { detail: message }));
}

async function load(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    const result = await api.pluginInspect();
    if (!result.ok) {
      error.value = result.error || '读取插件装配信息失败';
      return;
    }
    data.value = result;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

function refresh(): void {
  void load().then(() => {
    if (!error.value && data.value) {
      say(`插件装配：${data.value.entryCount ?? 0} 个条目 · ${data.value.layers?.length ?? 0} 层`);
    }
  });
}

// ---------------------------------------------------------------- 装 / 卸 / 升级
//
// 全部走主进程的 `dsh plugin --profile web …`（转发给 pnpm），输出边走边推上来贴进输出区。
// 三条与界面有关的约定：
//   1. 装 / 卸 / 升级改的是 package.json 与 node_modules → **必须重启 dsh**，所以做完挂一条黄条；
//   2. 同一时刻只允许一个操作（同一个 profile 目录不能被两个 pnpm 同时改）；
//   3. 确认框里必须写清"会从网络取代码、git 源可能执行构建脚本"，不能默默装。

const installOpen = ref(false);
const installSpec = ref('');
const opBusy = ref(false);
const opOpen = ref(false);
const opTitle = ref('');
const opText = ref('');
const opStatus = ref<'' | 'running' | 'ok' | 'failed'>('');
const opSummary = ref('');
/** 内置包被拦下时的"插进我的层"（主进程给的 id + 包名） */
const opNeedsEnable = ref<{ id: string; name: string } | null>(null);
const pendingRestart = ref(false);

const opStateLabel = computed(() => {
  if (opStatus.value === 'running') return '进行中…';
  if (opStatus.value === 'ok') return '完成';
  if (opStatus.value === 'failed') return '失败';
  return '';
});

api.onPluginOutput((payload) => {
  // 只留最近一段，避免一次大安装把内存与 DOM 撑爆
  opText.value = (opText.value + payload.chunk).slice(-40000);
});

async function startOp(action: PluginOpAction, spec: string): Promise<void> {
  if (opBusy.value) return;
  const target = spec.trim();
  if (action !== 'update' && target.length === 0) return;

  const titles: Record<PluginOpAction, string> = {
    add: '安装插件',
    remove: '移除插件',
    update: '升级插件',
  };
  const details: Record<PluginOpAction, string> = {
    add: `会把 ${target} 装进 web profile —— 代码从网络取；如果是 git 源，安装时可能执行它的构建脚本（等于允许它的代码在你的机器上跑）。装完要重启 dsh 才生效。`,
    remove: `会从 web profile 里移除 ${target}，它贡献的条目会一起消失。做完要重启 dsh 才生效。`,
    update: `会把 ${target || '所有树外插件'} 升到最新版。做完要重启 dsh 才生效。`,
  };
  const ok = await api.confirm({
    type: 'warning',
    title: titles[action],
    message: target || '（全部树外插件）',
    detail: details[action],
  });
  if (!ok) return;

  opBusy.value = true;
  opStatus.value = 'running';
  opText.value = '';
  opSummary.value = '';
  opNeedsEnable.value = null;
  opOpen.value = true;
  view.value = 'stack';
  opTitle.value = `dsh plugin --profile web ${action} ${target}`.trimEnd();

  const result = await api.pluginRun({ action, spec: target });
  opBusy.value = false;
  opStatus.value = result.ok ? 'ok' : 'failed';
  opSummary.value = result.summary || result.error || '';
  // 内置包、而且还没启用：就地给一个「插进我的层」，别让人自己去翻 cordis.patch.yml
  opNeedsEnable.value = result.needsEnable ?? null;

  if (result.ok) {
    pendingRestart.value = true;
    installOpen.value = false;
    installSpec.value = '';
    await load();
    say(
      action === 'add'
        ? '已安装，重启 dsh 后生效'
        : action === 'remove'
          ? '已移除，重启 dsh 后生效'
          : '已升级，重启 dsh 后生效',
    );
  }
}

// ---------------------------------------------------------------- 改你自己的补丁层
//
// 三个动作都只写 profile 的 `cordis.patch.yml`（用户层），主进程会先备份再原子写；
// 这一层是 patchReload: live，所以改完即时生效、不需要重启 dsh —— 界面上不能写成"要重启"。

const LAYER_ACTIONS: Record<PluginLayerEditAction, string> = {
  insert: '插进我的层',
  disable: '禁用',
  enable: '启用',
  'remove-insert': '移除我的插入',
};

/** 你自己那张补丁层的文件路径（层栈里 kind 是 profile-patch）；拿不到就没法改 */
const myPatchPath = computed(
  () => data.value?.layers?.find((layer) => layer.kind === 'profile-patch')?.name ?? '',
);

/** 这一组条目是不是你自己那张补丁层插入的（是的话可以整条移除） */
function isMyLayer(source: string): boolean {
  return myPatchPath.value !== '' && source === myPatchPath.value;
}

async function editLayer(action: PluginLayerEditAction, id: string, name?: string): Promise<void> {
  if (opBusy.value) return;
  const where = myPatchPath.value || 'profile 的 cordis.patch.yml';
  const detail =
    action === 'insert'
      ? `会往你自己的补丁层加一条 insert（id: ${id}，name: ${name ?? ''}）。写之前先备份原文件，只改这一处；这一层是即时生效的，不用重启 dsh。`
      : `会改你自己的补丁层 ${where}。写之前先备份原文件（.bak-时间戳），只改匹配到的那一段；这一层是即时生效的，不用重启 dsh。`;
  const ok = await api.confirm({
    type: 'warning',
    title: `${LAYER_ACTIONS[action]}：${id}`,
    message: where,
    detail,
  });
  if (!ok) return;

  const result = await api.pluginEditLayer({ action, id, name });
  opNeedsEnable.value = null;
  opOpen.value = true;
  opTitle.value = `${LAYER_ACTIONS[action]}：${id}`;
  opStatus.value = result.ok ? 'ok' : 'failed';
  opText.value = result.content ?? '';
  const wrote =
    result.changed && result.file
      ? `写到 ${result.file}${result.backup ? `（改动前的原文已备份到 ${result.backup}）` : ''}`
      : '';
  opSummary.value = result.ok
    ? [result.detail, wrote].filter(Boolean).join('—— ')
    : result.error || '改不了你的补丁层';
  if (result.ok) {
    await load();
    view.value = 'config';
    say(result.detail ?? '补丁层已更新');
  }
}

async function cancelOp(): Promise<void> {
  await api.pluginCancel();
}

async function restartDsh(): Promise<void> {
  await api.restart();
  pendingRestart.value = false;
  say('正在重启 dsh…');
}

// 这一页要起一个 dsh 子进程（dump-config），所以不在启动时就跑，等真正切过来再读一次
watch(
  currentTab,
  (tab) => {
    if (tab !== 'plugin' || loadedOnce) return;
    loadedOnce = true;
    void load();
  },
  { immediate: true },
);

const layers = computed<PluginLayer[]>(() => data.value?.layers || []);
const problems = computed<PluginProblem[]>(() => data.value?.problems || []);
const treeLayers = computed(() => data.value?.treeLayers || []);

const selectedIndex = ref(0);
const selected = computed<PluginLayer | null>(() => layers.value[selectedIndex.value] || null);

/** 层在界面上的名字：bundle 用包名，patch 层用缩短后的路径 */
function layerName(layer: PluginLayer): string {
  if (layer.kind === 'in-box' || layer.kind === 'out-of-tree') return layer.name;
  const home = data.value?.home || '';
  if (layer.resolvedPath === null) return layer.name.replace(home ? `${home}/` : '', '~/');
  return layer.resolvedPath.replace(home ? `${home}/` : '', '~/');
}

/** 是"你自己的层"——界面上要一眼看得出来，别和装的 bundle 混在一起 */
function isOwnLayer(layer: PluginLayer): boolean {
  return layer.kind === 'profile-patch' || layer.kind === 'home-patch';
}

function kindLabel(kind: PluginLayer['kind']): string {
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
function ownLayerState(layer: PluginLayer): 'missing' | 'unmatched' | 'empty' {
  if (!layer.resolvedPath) return 'missing';
  const hit = problems.value.some(
    (item) => item.kind === 'unmatched-patch' && item.file === layer.name,
  );
  return hit ? 'unmatched' : 'empty';
}

function ownLayerTag(layer: PluginLayer): string {
  const state = ownLayerState(layer);
  if (state === 'missing') return '未创建';
  if (state === 'unmatched') return '没匹配上';
  return '空 []';
}

function ownLayerWhy(layer: PluginLayer): string {
  const state = ownLayerState(layer);
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
const liveById = computed(() => {
  const map = new Map<string, PluginLiveEntry>();
  for (const entry of data.value?.live?.entries ?? []) {
    map.set(stripIncludePrefix(entry.entryId), entry);
  }
  return map;
});

/** 运行中但配置里没有的行（根 include + 三个哈希 id 的原生选择器/HMR）—— 这就是两个数量对不上的差额 */
const liveOnly = computed(() =>
  (data.value?.live?.entries ?? []).filter(
    (entry) => !staticIds.value.has(stripIncludePrefix(entry.entryId)),
  ),
);

const staticIds = computed(() => {
  const ids = new Set<string>();
  for (const group of data.value?.treeLayers ?? []) {
    for (const entry of group.entries) ids.add(entry.id);
  }
  return ids;
});

function stripIncludePrefix(entryId: string): string {
  const prefix = 'include:';
  return entryId.startsWith(prefix) ? entryId.slice(prefix.length) : entryId;
}

/** 条目的运行状态：接口读不到时返回 null，界面就什么都不标 */
function liveState(id: string): PluginLiveEntry | null {
  return liveById.value.get(id) ?? null;
}

function stateLabel(phase: PluginLiveEntry['fiberPhase']): string {
  if (phase === 'active') return '运行中';
  if (phase === 'failed') return '加载失败';
  if (phase === 'loading') return '加载中';
  if (phase === 'unloading') return '卸载中';
  if (phase === 'pending') return '待加载';
  return '未挂载';
}

function problemLabel(kind: PluginProblem['kind']): string {
  if (kind === 'unmatched-patch') return '指向了不存在的条目';
  if (kind === 'parse-error') return '解析失败';
  if (kind === 'plain-dependency') return '不形成层';
  if (kind === 'missing-layer') return '没有贡献';
  return '提示';
}

/** 这一层在生效配置里的条目（自己插入的 + 它覆盖掉的） */
function entriesOf(layer: PluginLayer): PluginEntry[] {
  const out: PluginEntry[] = [];
  for (const group of treeLayers.value) {
    const own = group.source === layer.name && group.patchedBy === null;
    const overridden = group.patchedBy === layer.name;
    if (own || overridden) out.push(...group.entries);
  }
  return out;
}

const selectedEntries = computed(() => (selected.value ? entriesOf(selected.value) : []));

/** 生效配置视图里的条目（按层分组 + 搜索 + 过滤） */
const visibleGroups = computed(() => {
  const q = query.value.trim().toLowerCase();
  return treeLayers.value
    .map((group) => {
      if (
        layerFilter.value &&
        group.source !== layerFilter.value &&
        group.patchedBy !== layerFilter.value
      ) {
        return { ...group, entries: [] };
      }
      const entries = group.entries.filter((entry) => {
        if (onlyDisabled.value && !entry.disabled) return false;
        if (onlyOverridden.value && group.patchedBy === null) return false;
        if (!q) return true;
        return entry.id.toLowerCase().includes(q) || entry.name.toLowerCase().includes(q);
      });
      return { ...group, entries };
    })
    .filter((group) => group.entries.length > 0);
});

const shownEntries = computed(() =>
  visibleGroups.value.reduce((sum, group) => sum + group.entries.length, 0),
);

function jumpToLayer(layer: PluginLayer): void {
  layerFilter.value = layer.name;
  onlyOverridden.value = false;
  onlyDisabled.value = false;
  query.value = '';
  view.value = 'config';
  say(`只看 ${layerName(layer)} 相关`);
}

function clearFilters(): void {
  layerFilter.value = '';
  onlyOverridden.value = false;
  onlyDisabled.value = false;
  query.value = '';
}
</script>

<template>
  <div class="plugin">
    <div class="bar">
      <button
        id="btn-plugin-refresh"
        class="btn small primary"
        :disabled="loading"
        :aria-busy="loading ? 'true' : undefined"
        @click="refresh"
      >
        <svg class="i"><use href="#i-replay" /></svg><span>刷新</span>
      </button>
      <button
        id="btn-plugin-install"
        class="btn small"
        :disabled="opBusy"
        @click="installOpen = !installOpen"
      >
        + 安装插件
      </button>
      <div class="plugin-views">
        <button class="plugin-view" :class="{ active: view === 'stack' }" @click="view = 'stack'">
          装配层栈
        </button>
        <button class="plugin-view" :class="{ active: view === 'config' }" @click="view = 'config'">
          生效配置
        </button>
      </div>
      <div class="spacer"></div>
      <span v-if="error" class="bar-note">{{ error }}</span>
      <template v-else-if="data">
        <span v-if="data.live" class="bar-note">
          运行中 {{ data.live.counts.total }} 条（{{ data.live.counts.active }} 已挂载<template
            v-if="data.live.counts.idle"
          >
            · {{ data.live.counts.idle }} 未挂载</template
          ><template v-if="data.live.counts.failed">
            · <b class="plugin-failed">{{ data.live.counts.failed }} 加载失败</b></template
          >）
        </span>
        <span v-else class="bar-note"
          >{{ data.entryCount }} 个组合条目 · {{ layers.length }} 层</span
        >
        <span v-if="!data.live" class="plugin-tag muted" :title="data.liveError || ''"
          >运行中清单不可用</span
        >
        <span v-if="data.patchReload" class="bar-hint">
          {{ data.patchReload === 'live' ? 'patch 层改动即时生效' : 'patch 层只在启动时应用' }}
        </span>
        <span class="bar-hint">{{ data.profileDir }}</span>
      </template>
    </div>

    <!-- 安装行：不用弹窗，跟 Harness 页「粘贴地址」同一形态 -->
    <div v-if="installOpen" class="plugin-install">
      <input
        id="plugin-install-spec"
        v-model="installSpec"
        class="plugin-install-input"
        placeholder="包名 / ./本地目录 / .tgz / github:owner/repo#sha"
        @keyup.enter="startOp('add', installSpec)"
      />
      <button
        class="btn small primary"
        :disabled="opBusy || installSpec.trim().length === 0"
        @click="startOp('add', installSpec)"
      >
        安装
      </button>
      <span class="bar-hint">代码从网络取；本地目录的相对路径按主目录解析，建议写绝对路径</span>
      <span class="bar-hint">
        源：{{ data?.registry || '跟随系统 npm 配置' }}（设置页「插件安装源」可改）
      </span>
      <span v-if="data?.pnpm && !data.pnpm.found" class="plugin-tag warn">没找到 pnpm</span>
    </div>

    <!-- 装/卸/升级改的是 package.json 与 node_modules → 必须重启 dsh -->
    <div v-if="pendingRestart" class="banner">
      <svg class="i"><use href="#i-warn" /></svg>
      <span>
        <b>已改到装配层，重启 dsh 后生效。</b>
        bundle 列表是启动时读的；改你自己的 <code>cordis.patch.yml</code> 才是即时生效。
      </span>
      <span class="spacer"></span>
      <button class="btn ghost small" @click="pendingRestart = false">稍后</button>
      <button class="btn small" @click="restartDsh">立即重启 dsh</button>
    </div>

    <!-- 空态 / 出错 -->
    <div v-if="error" class="empty">
      <svg class="empty-i"><use href="#i-warn" /></svg>
      <h2>读不出插件装配信息</h2>
      <p>{{ error }}</p>
      <button class="btn small" @click="refresh">重试</button>
    </div>
    <div v-else-if="!data" class="empty">
      <h2>{{ loading ? '正在读 profile…' : '还没有数据' }}</h2>
    </div>

    <template v-else>
      <!-- "没报错的错"：不会让命令失败，但会让改动悄悄不生效 -->
      <section v-if="problems.length" class="panel plugin-problems">
        <header class="panel-head">
          <h3>需要注意的 {{ problems.length }} 处</h3>
          <div class="spacer"></div>
          <span class="bar-hint">这些不会让命令失败，但会让改动悄悄不生效</span>
        </header>
        <ul class="plugin-problem-list">
          <li v-for="(item, i) in problems" :key="`${item.kind}-${i}`" class="plugin-problem">
            <span class="plugin-problem-kind" :data-kind="item.kind">
              {{ problemLabel(item.kind) }}
            </span>
            <span class="plugin-problem-text">{{ item.detail }}</span>
          </li>
        </ul>
      </section>

      <!-- 视图一：装配层栈 -->
      <div v-if="view === 'stack'" class="plugin-body">
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
              @click="selectedIndex = i"
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
                <li
                  v-for="entry in selectedEntries.slice(0, 12)"
                  :key="entry.id"
                  class="plugin-entry"
                >
                  <span class="plugin-entry-id">{{ entry.id }}</span>
                  <span class="plugin-entry-name">{{ entry.name }}</span>
                  <span v-if="entry.disabled" class="plugin-tag muted">disabled</span>
                </li>
              </ul>
              <p v-if="selectedEntries.length > 12" class="hint">
                还有 {{ selectedEntries.length - 12 }} 条，点右上角在生效配置里看全部。
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
                这一层在生效配置里没有条目。装进来的包如果没声明 <code>dsh.bundle</code>，
                就只会当普通依赖存在，不形成配置层。
              </template>
            </p>

            <!-- 只有树外插件能升级 / 移除：内置的随 dsh 安装目录，动不了也不该动 -->
            <div v-if="selected.kind === 'out-of-tree'" class="plugin-detail-actions">
              <button
                class="btn small"
                :disabled="opBusy"
                @click="startOp('update', selected.name)"
              >
                升级到最新
              </button>
              <span class="spacer"></span>
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

      <!-- 视图二：生效配置 -->
      <section v-else class="panel plugin-config">
        <div class="plugin-config-bar">
          <input
            id="plugin-search"
            v-model="query"
            class="plugin-search"
            type="search"
            placeholder="搜条目 id 或插件包名…"
          />
          <button
            class="plugin-filter"
            :class="{ active: onlyOverridden }"
            @click="onlyOverridden = !onlyOverridden"
          >
            只看被覆盖的
          </button>
          <button
            class="plugin-filter"
            :class="{ active: onlyDisabled }"
            @click="onlyDisabled = !onlyDisabled"
          >
            只看禁用
          </button>
          <span v-if="layerFilter" class="plugin-tag">只看 {{ layerFilter }}</span>
          <div class="spacer"></div>
          <span class="bar-hint">{{ shownEntries }} / {{ data.entryCount }} 条</span>
          <button v-if="layerFilter" class="btn tiny" @click="clearFilters">清除筛选</button>
        </div>

        <div v-if="data.rawDump" class="plugin-raw">
          <p class="hint">没能把 dump 解析成结构（dsh 的输出格式可能变了），下面是原样输出。</p>
          <pre class="plugin-raw-text">{{ data.rawDump }}</pre>
        </div>

        <div v-else class="plugin-config-body">
          <p class="plugin-scope">
            口径：这里是 <code>--dump-config</code> 组合出来的<b>行</b>（各 bundle 的 patch + 你的
            patch 层）。运行中的 Loader 条目还多出几行 —— 启动时挂上的根
            <code>include</code> 与原生目录选择器 /
            HMR，它们不在配置文件里（见下面的「运行时挂载」）。两个数字回答的不是同一个问题，
            所以不等。<template v-if="data.live">dsh 在跑时，两个数都给你。</template>
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
                  v-if="liveState(entry.id)"
                  class="plugin-state"
                  :data-phase="liveState(entry.id)?.fiberPhase"
                  >{{ stateLabel(liveState(entry.id)?.fiberPhase ?? null) }}</span
                >
                <!-- 改你自己的补丁层：禁用/启用是"写一条覆盖"，移除只对自己插入的条目开放 -->
                <span class="plugin-entry-actions">
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
          <template v-if="liveOnly.length && !query && !layerFilter">
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

          <p v-if="data.live?.presets.length" class="plugin-presets">
            会话插件（Agent 预设按会话组装的行数）：
            <span v-for="preset in data.live.presets" :key="preset.id" class="plugin-tag mono"
              >{{ preset.id }}<template v-if="preset.isDefault">（默认）</template>
              {{ preset.rows }} 行</span
            >
          </p>
        </div>
      </section>

      <!-- 操作输出：pnpm 的原始输出原样贴出来，不假装进度条（与 dsh 终端同族） -->
      <div v-if="opStatus && opOpen" class="plugin-op">
        <div class="plugin-op-head">
          <span class="plugin-op-cmd">{{ opTitle }}</span>
          <span class="plugin-op-state" :data-state="opStatus">{{ opStateLabel }}</span>
          <span class="spacer"></span>
          <button v-if="opBusy" class="btn tiny" @click="cancelOp">中断</button>
          <button v-else class="btn tiny" @click="opOpen = false">收起</button>
        </div>
        <pre class="plugin-op-out">{{ opText || '（等待输出…）' }}</pre>
        <p v-if="opSummary" class="plugin-op-summary">{{ opSummary }}</p>
        <!-- 内置包被拦下、而且还没启用：就地给一个按钮，不用自己去翻 cordis.patch.yml -->
        <div v-if="opNeedsEnable" class="plugin-op-actions">
          <button
            class="btn small primary"
            :disabled="opBusy"
            @click="editLayer('insert', opNeedsEnable.id, opNeedsEnable.name)"
          >
            插进我的层
          </button>
          <span class="bar-hint">
            往你的补丁层加一条 insert（id:
            {{ opNeedsEnable.id }}），写之前备份原文件；这一层即时生效
          </span>
        </div>
      </div>
    </template>
  </div>
</template>
