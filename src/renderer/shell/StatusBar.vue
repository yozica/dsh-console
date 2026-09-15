<script setup>
/**
 * 底部状态栏。
 *
 * 它有两个用途：常驻显示当前状态，以及临时显示一句操作结果（「设置已保存」这类）。
 * 临时消息通过 `dsh:status-message` 事件进来（已迁移的页面和 app.js 都这么发），
 * 显示几秒后自动回落到常驻状态 —— 这样 app.js 不需要再直接改这里的文字，
 * 也不会被下一次响应式更新抹掉。
 */
import { computed, onUnmounted, ref } from 'vue'
import { dsh, phaseInfo, snapshot } from '../lib/store.js'
import { shortcutLabel } from '../lib/platform.js'

const MESSAGE_MS = 6000

const message = ref('')
let timer = null

function onMessage(event) {
  if (!event.detail) return
  message.value = String(event.detail)
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => (message.value = ''), MESSAGE_MS)
}

window.addEventListener('dsh:status-message', onMessage)
onUnmounted(() => {
  window.removeEventListener('dsh:status-message', onMessage)
  if (timer) clearTimeout(timer)
})

const state = computed(() => {
  const info = phaseInfo.value
  const origin = dsh.value?.origin
  return origin ? `${info.title}，${origin}` : info.title
})

const env = computed(() => {
  const versions = snapshot.value?.env?.versions
  if (!versions) return '—'
  const kind = dsh.value?.launch?.kind || '—'
  return `Electron ${versions.electron}，Node ${versions.node}，命令解析方式 ${kind}`
})

/** 快捷键提示按平台写：macOS 是 ⌘1~6，其它平台是 Ctrl+1~6 */
const tabHint = computed(() => `${shortcutLabel('1~6')} 切换页面`)
</script>

<template>
  <footer class="statusbar">
    <span id="footer-state">{{ message || state }}</span>
    <div class="spacer"></div>
    <span class="kbd-hint">{{ tabHint }}</span>
    <span id="footer-env">{{ env }}</span>
  </footer>
</template>
