<script setup>
/**
 * 顶栏（同时是窗口标题栏，见 README「关于应用内全屏与标题栏」）。
 *
 * 三个显示值都来自共享 store；「退出全屏」按钮只改 store 里的 immersive，
 * 真正的 body 属性与内嵌页视口重算由 app.js 监听后处理（那部分还没迁移）。
 */
import { computed } from 'vue'
import { currentTab, dsh, immersive, owned, phase, phaseInfo } from '../lib/store.js'

const PAGE_TITLES = {
  dashboard: '控制台',
  terminal: 'dsh 终端',
  shell: '本地 Shell',
  ui: 'DeepSeek Harness',
  usage: 'DeepSeek 用量',
  archive: '归档会话',
  settings: '设置'
}

const title = computed(() => PAGE_TITLES[currentTab.value] || currentTab.value)

/** 退出全屏：只改共享状态，body 属性与内嵌页视口由 app.js / UiPane 各自 watch */
function exitImmersive() {
  immersive.value = false
}

/** 状态灯：全屏时左栏被藏起来，灯挪到这一条里，状态词放 tooltip */
const lampTitle = computed(() =>
  `${phaseInfo.value.title}${phaseInfo.value.desc ? `：${phaseInfo.value.desc}` : ''}`
)

/**
 * 右侧上下文信息：控制台页自己有一整块事实区，这里就不重复了。
 * 去掉 http:// 前缀（本机地址，协议没有信息量），给标题栏省地方。
 */
const note = computed(() => {
  const d = dsh.value
  if (!d || currentTab.value === 'dashboard') return ''
  const pid = owned.value
    ? d.pid
      ? `PID ${d.pid}`
      : 'PID 识别中'
    : d.externalPid
      ? `外部实例 PID ${d.externalPid}`
      : '未运行'
  return `${String(d.origin || '').replace(/^https?:\/\//, '')}，${pid}`
})
</script>

<template>
  <header class="topbar">
    <span class="lamp immersive-only" id="topbar-lamp" :data-phase="phase" :title="lampTitle"></span>
    <h1 class="page-title" id="page-title">{{ title }}</h1>
    <div class="spacer"></div>
    <span class="topbar-note" id="topbar-note">{{ note }}</span>
    <button
      id="btn-exit-immersive"
      class="btn small ghost immersive-only"
      title="退出全屏（Esc）"
      @click="exitImmersive"
    >
      <svg class="i"><use href="#i-collapse" /></svg><span>退出全屏</span>
    </button>
  </header>
</template>
