<script setup lang="ts">
/**
 * 左侧导航（外壳的一部分）。
 *
 * 原来这些元素由 app.js 里的 render() 手工更新：`setText('status-text', …)`、
 * 循环给 `[data-tab]` 加 active、再单独绑一遍主题开关。现在它们都是这里的
 * computed 与模板绑定，跟着共享 store 走。
 *
 * 切页只改 store 里的 currentTab；真正的副作用（终端 fit、内嵌页载入等）
 * 由 app.ts 与各页自己的 watch 处理。
 */
import { computed } from 'vue';
import { closeEnvDetailOnTabChange } from '../lib/env-layer.js';
import {
  currentTab,
  dsh,
  phase,
  phaseInfo,
  settings,
  setThemeMode,
  snapshot,
  type TabId,
} from '../lib/store.js';
import { formatUptime } from '../lib/format.js';

interface NavTab {
  id: TabId;
  icon: string;
  label: string;
}

const TABS: NavTab[] = [
  { id: 'dashboard', icon: 'i-gauge', label: '控制台' },
  // 「dsh 终端」与「本地 Shell」合并成一个「终端」页（一条统一会话条，见 AGENTS §7.30）：
  // dsh 终端是会话条上固定存在的第一项，各本地 Shell 排在它后面。
  { id: 'terminal', icon: 'i-terminal', label: '终端' },
  { id: 'ui', icon: 'i-browser', label: 'DeepSeek Harness' },
  { id: 'usage', icon: 'i-usage', label: 'DeepSeek 用量' },
  { id: 'archive', icon: 'i-archive', label: '归档会话' },
  { id: 'plugin', icon: 'i-plugin', label: '插件' },
  // 「环境自检」不再是左栏一项：设置页「运行环境」卡的详情视图（t45）
  { id: 'settings', icon: 'i-sliders', label: '设置' },
];

const themeMode = computed(
  () => snapshot.value?.theme?.mode || settings.value.themeMode || 'system',
);

const owned = computed(() => Boolean(dsh.value?.owned));

/** 切页：只改共享状态，"各页自己的副作用"由 app.ts 与各页的 watch 处理 */
function selectTab(id: TabId): void {
  // 环境自检的详情层盖着页面区（t45）：切页先把它收掉，免得挡住用户刚点的那一页
  closeEnvDetailOnTabChange();
  currentTab.value = id;
}

/** 常驻状态块的副行：窄栏放不下"运行时长 + 延迟"两段，所以只留运行时长 */
const serviceMeta = computed(() => {
  const d = dsh.value;
  if (!d) return '—';
  if (owned.value && d.uptimeMs) return `已运行 ${formatUptime(d.uptimeMs)}`;
  if (d.probe?.reachable) return '服务已就绪';
  return d.origin || '—';
});
</script>

<template>
  <aside class="rail">
    <div class="rail-brand">
      <span class="rail-logo">DSH</span>
      <span class="rail-logo-sub">Console</span>
    </div>

    <!-- 常驻服务状态：切到任何页面都看得到 -->
    <div class="rail-service" id="status-chip" :data-phase="phase">
      <div class="rail-service-line">
        <span class="lamp"></span>
        <span class="rail-service-state" id="status-text">{{ phaseInfo.title }}</span>
      </div>
      <div class="rail-service-meta" id="rail-service-meta">{{ serviceMeta }}</div>
    </div>

    <nav class="rail-nav">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        class="rail-item"
        :class="{ active: currentTab === tab.id }"
        :data-tab="tab.id"
        @click="selectTab(tab.id)"
      >
        <svg class="i"><use :href="`#${tab.icon}`" /></svg><span>{{ tab.label }}</span>
      </button>
    </nav>

    <div class="rail-foot">
      <div class="theme-switch" id="theme-switch" role="group" aria-label="界面主题">
        <button
          type="button"
          data-theme-mode="system"
          title="跟随系统的深色模式"
          :class="{ active: themeMode === 'system' }"
          @click="setThemeMode('system')"
        >
          自动
        </button>
        <button
          type="button"
          data-theme-mode="light"
          title="亮色"
          :class="{ active: themeMode === 'light' }"
          @click="setThemeMode('light')"
        >
          亮
        </button>
        <button
          type="button"
          data-theme-mode="dark"
          title="深色"
          :class="{ active: themeMode === 'dark' }"
          @click="setThemeMode('dark')"
        >
          深
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/* 左栏自己的样式（t48 样式分层）：原来在 styles.css 的「骨架」与「指示灯」两节里。
   跨组件的布局契约（`.app` / `.workspace` / `.pane`）与 `html`/`body` 状态开关留在全局表。 */

.rail {
  display: flex;
  flex-direction: column;
  padding: 16px 12px 12px;
  background: var(--rail);
  border-right: 1px solid var(--hairline);
}

.rail-brand {
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 0 6px 16px;
}

.rail-logo {
  font-size: var(--t-lg);
  font-weight: 600;
  color: var(--ink);
}

.rail-logo-sub {
  font-size: var(--t-sm);
  color: var(--ink-faint);
}

/* 常驻状态块：切页面也在，替代了原先顶栏那枚重复的 pill */
.rail-service {
  padding: 10px 12px;
  margin-bottom: 14px;
  background: var(--surface);
  border: 1px solid var(--hairline);
  border-radius: var(--r-panel);
}

.rail-service-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rail-service-state {
  font-size: var(--t-sm);
  font-weight: 600;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rail-service-meta {
  margin-top: 4px;
  color: var(--ink-faint);
  font-size: var(--t-xs);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rail-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rail-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-control);
  background: transparent;
  color: var(--ink-dim);
  font-size: var(--t-md);
  text-align: left;
  cursor: pointer;
  transition:
    background var(--dur) ease,
    color var(--dur) ease;
}

.rail-item:hover {
  background: var(--surface);
  color: var(--ink);
}

.rail-item.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.rail-foot {
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--hairline);
}

.theme-switch {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px;
  padding: 2px;
  background: var(--surface);
  border: 1px solid var(--hairline);
  border-radius: var(--r-control);
}

.theme-switch button {
  height: 24px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ink-faint);
  font-size: var(--t-xs);
  cursor: pointer;
  transition:
    background var(--dur) ease,
    color var(--dur) ease;
}

.theme-switch button:hover {
  color: var(--ink);
}

.theme-switch button.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.rail-service[data-phase='running'] .lamp {
  background: var(--run);
  box-shadow: 0 0 0 3px var(--run-soft);
}

.rail-service[data-phase='external'] .lamp {
  background: var(--sky);
  box-shadow: 0 0 0 3px var(--sky-soft);
}

.rail-service[data-phase='starting'] .lamp,
.rail-service[data-phase='stopping'] .lamp {
  background: var(--amber);
  animation: breathe 1.2s ease-in-out infinite;
}

.rail-service[data-phase='degraded'] .lamp,
.rail-service[data-phase='conflict'] .lamp {
  background: var(--rose);
  box-shadow: 0 0 0 3px var(--rose-soft);
}
</style>
