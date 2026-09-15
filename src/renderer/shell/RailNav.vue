<script setup>
/**
 * 左侧导航（外壳的一部分）。
 *
 * 原来这些元素由 app.js 里的 render() 手工更新：`setText('status-text', …)`、
 * 循环给 `[data-tab]` 加 active、再单独绑一遍主题开关。现在它们都是这里的
 * computed 与模板绑定，跟着共享 store 走。
 *
 * 切页只改 store 里的 currentTab；真正的副作用（终端 fit、内嵌页载入等）
 * 由 app.js 监听 currentTab 自己处理 —— 那几页还没迁移。
 */
import { computed } from 'vue'
import { currentTab, dsh, phase, phaseInfo, settings, setThemeMode, snapshot } from '../lib/store.js'
import { formatUptime } from '../lib/format.js'

const TABS = [
  { id: 'dashboard', icon: 'i-gauge', label: '控制台' },
  { id: 'terminal', icon: 'i-terminal', label: 'dsh 终端' },
  { id: 'shell', icon: 'i-shell', label: '本地 Shell' },
  { id: 'ui', icon: 'i-browser', label: 'DeepSeek Harness' },
  { id: 'usage', icon: 'i-usage', label: 'DeepSeek 用量' },
  { id: 'settings', icon: 'i-sliders', label: '设置' }
]

const themeMode = computed(() => snapshot.value?.theme?.mode || settings.value.themeMode || 'system')

const owned = computed(() => Boolean(dsh.value?.owned))

/** 切页：只改共享状态，"那几页自己的副作用"由各页与 app.js 的 watch 处理 */
function selectTab(id) {
  currentTab.value = id
}

/** 常驻状态块的副行：窄栏放不下"运行时长 + 延迟"两段，所以只留运行时长 */
const serviceMeta = computed(() => {
  const d = dsh.value
  if (!d) return '—'
  if (owned.value && d.uptimeMs) return `已运行 ${formatUptime(d.uptimeMs)}`
  if (d.probe?.reachable) return '服务已就绪'
  return d.origin || '—'
})
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
