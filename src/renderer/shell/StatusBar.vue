<script setup lang="ts">
/**
 * 底部状态栏。
 *
 * 它有两个用途：常驻显示当前状态，以及临时显示一句操作结果（「设置已保存」这类）。
 * 临时消息通过 `dsh:status-message` 事件进来（各页与 app.ts 都这么发），
 * 显示几秒后自动回落到常驻状态 —— 这样 app.ts 不需要再直接改这里的文字，
 * 也不会被下一次响应式更新抹掉。
 */
import { computed, onUnmounted, ref } from 'vue';
import { currentTab, dsh, phaseInfo, snapshot, update } from '../lib/store.js';
import { shortcutLabel } from '../lib/platform.js';
import { requestUpdateCardFocus } from '../lib/update-anchor.js';

const MESSAGE_MS = 6000;

const message = ref('');
let timer: ReturnType<typeof setTimeout> | null = null;

function onMessage(event: Event): void {
  const detail = (event as CustomEvent<string>).detail;
  if (!detail) return;
  message.value = String(detail);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => (message.value = ''), MESSAGE_MS);
}

window.addEventListener('dsh:status-message', onMessage);
onUnmounted(() => {
  window.removeEventListener('dsh:status-message', onMessage);
  if (timer) clearTimeout(timer);
});

const state = computed(() => {
  const info = phaseInfo.value;
  const origin = dsh.value?.origin;
  return origin ? `${info.title}，${origin}` : info.title;
});

const env = computed(() => {
  const versions = snapshot.value?.env?.versions;
  if (!versions) return '—';
  const kind = dsh.value?.launch?.kind || '—';
  return `Electron ${versions.electron}，Node ${versions.node}，命令解析方式 ${kind}`;
});

/** 快捷键提示按平台写：macOS 是 ⌘1~8，其它平台是 Ctrl+1~8（页面数见 app.ts 的 TAB_ORDER） */
const tabHint = computed(() => `${shortcutLabel('1~8')} 切换页面`);

/**
 * 有新版本（发现 / 已下载）时在底栏加一句可点的提示，点它去设置页的更新卡片。
 * 只在"需要用户动手"的两个相位出现，其余时间底栏保持原样。
 */
const updateHint = computed(() => {
  if (update.value.phase === 'available') {
    return `发现新版本 ${update.value.version || ''}，点此查看`;
  }
  if (update.value.phase === 'downloaded') return '新版本已下载，点此查看';
  return '';
});

function openUpdateSettings(): void {
  currentTab.value = 'settings';
  // 光切页不够：设置页有好几屏，更新卡片在「关于」里 —— 让设置页把它滚进视野并亮一次
  requestUpdateCardFocus();
}
</script>

<template>
  <footer class="statusbar">
    <span id="footer-state">{{ message || state }}</span>
    <button v-if="updateHint" class="update-hint" @click="openUpdateSettings">
      {{ updateHint }}
    </button>
    <div class="spacer"></div>
    <span class="kbd-hint">{{ tabHint }}</span>
    <span id="footer-env">{{ env }}</span>
  </footer>
</template>
