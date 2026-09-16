<script setup lang="ts">
/**
 * dsh 终端页。
 *
 * 这一页是"输出视图"而不是交互式终端：`dsh web` 不读 stdin，所以在这里打字不会有反应
 * （dsh 的行为，不是界面坏了）。工具栏上的「发送 Ctrl+C」和「启动」才是可用的动作。
 *
 * 迁移前这些逻辑散在 app.js 里（ensureDshTerminal / syncTerminalEmptyState /
 * observeTerminalSize / fitAndSync + 四个按钮的处理），生命周期靠手工挂载与卸载；
 * 现在收在一个组件里：onMounted 建终端、onUnmounted 销毁并把 ResizeObserver 断掉。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  applyTerminalSurface,
  attachTerminal,
  fitAndSync,
  passAppShortcutsThrough,
  TERM_THEMES,
} from '../lib/xterm.js';
import { currentTab, dsh, phaseInfo, snapshot } from '../lib/store.js';
import type { TerminalEntry } from '../lib/xterm.js';

const api = window.dshConsole;

const host = ref<HTMLElement | null>(null);
const hasContent = ref(false);
const busyStart = ref(false);
let entry: TerminalEntry | null = null;
let observer: ResizeObserver | null = null;
let offOutput: (() => void) | null = null;
let offExit: (() => void) | null = null;

const own = computed(() => Boolean(dsh.value?.owned));
const note = computed(() => {
  if (!own.value) return phaseInfo.value.title;
  return dsh.value?.pid ? `运行中，PID ${dsh.value.pid}` : '运行中，PID 识别中';
});
// 说清"为什么打字没反应"，否则这个终端看着像坏了
const hint = computed(() => (own.value ? 'dsh web 不读键盘输入，Ctrl+C 可以让它退出' : ''));
const emptyVisible = computed(() => !own.value && !hasContent.value);

function resolvedTheme() {
  return snapshot.value?.theme?.resolved === 'light' ? 'light' : 'dark';
}

function syncFit() {
  if (!entry || !host.value) return;
  fitAndSync(entry, (cols, rows) => api.dshResize(cols, rows));
}

function clearDisplay() {
  entry?.term.clear();
  window.dispatchEvent(
    new CustomEvent('dsh:status-message', {
      detail: '已清空终端显示，dsh 的输出还在主进程缓冲里（可用「重新显示历史」找回）',
    }),
  );
}

async function replay() {
  const text = await api.dshReplay();
  if (!entry) return;
  entry.term.reset();
  if (text) {
    entry.term.write(text);
    hasContent.value = true;
  } else {
    entry.term.write('\u001b[2m（缓冲里还没有输出）\u001b[0m\r\n');
  }
}

function sendCtrlC() {
  api.dshInput('\u0003');
  window.dispatchEvent(
    new CustomEvent('dsh:status-message', { detail: '已发送 Ctrl+C，等 dsh 自己退出' }),
  );
}

async function startDsh() {
  if (busyStart.value) return;
  busyStart.value = true;
  try {
    const result = await api.start();
    if (!result.ok) alert(`启动失败：${result.error}`);
  } finally {
    busyStart.value = false;
  }
}

/**
 * 建终端。**第一次切到本页时才建**，不在 mounted 时建：
 * 挂载那一刻 Vue 刚渲染完 DOM、布局还没定型，xterm 会按中间态的尺寸算出行列数；
 * 容器随后长大时 ResizeObserver 已经错过了那次变化，屏幕就永远停在小尺寸
 * （踩过：容器 966×667，xterm 的 .xterm-screen 却是 572×432 —— 用户在 DevTools 里看到的）。
 * 输出不会丢：主进程一直缓存着，建好之后 replay 回来。
 */
function ensureTerminal() {
  if (entry || !host.value) return entry;
  entry = attachTerminal(host.value, resolvedTheme());
  // 让 Ctrl+1~7 与 Ctrl+R 穿过终端交给应用（dsh 终端本来就不读键盘输入）
  passAppShortcutsThrough(entry.term, { includeReload: true });
  entry.term.onData((data) => api.dshInput(data));
  entry.term.onResize(({ cols, rows }) => api.dshResize(cols, rows));
  syncFit();

  // 把主进程里缓存的输出补上，切页不丢历史
  void api.dshReplay().then((text) => {
    if (text && text.length > 0) {
      entry?.term.write(text);
      hasContent.value = true;
    }
  });

  offOutput = api.onOutput(({ chunk }) => {
    entry?.term.write(chunk);
    if (!hasContent.value) hasContent.value = true;
  });

  offExit = api.onDshExit(({ exitCode, signal }) => {
    const reason = signal ? `信号 ${signal}` : `退出码 ${exitCode}`;
    entry?.term.write(`\r\n\u001b[2m── dsh 已退出（${reason}）──\u001b[0m\r\n`);
    hasContent.value = true;
    window.dispatchEvent(
      new CustomEvent('dsh:status-message', { detail: `dsh 已退出（${reason}）` }),
    );
  });

  // 尺寸跟着容器走。不按"当前是否在本页"过滤：页面用 visibility 隐藏、布局一直有效，
  // 所以窗口变化时即使人在别的页也一并算准 —— 切回来就是对的。
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => syncFit());
    observer.observe(host.value);
  }
  return entry;
}

onMounted(() => {
  // 挂载时如果本页就是当前页（例如刷新时停在终端页），直接建
  if (currentTab.value === 'terminal') ensureTerminal();
});

onUnmounted(() => {
  if (observer) observer.disconnect();
  if (offOutput) offOutput();
  if (offExit) offExit();
  entry?.term.dispose();
  entry = null;
});

// 切到本页：没有终端就现在建（此时页面已可见、布局已定型），然后 fit 并聚焦
watch(
  currentTab,
  (tab) => {
    if (tab !== 'terminal') return;
    ensureTerminal();
    requestAnimationFrame(() => {
      syncFit();
      entry?.term.focus();
      // 再补一拍：切页那一帧容器的尺寸可能还没最终确定
      setTimeout(syncFit, 200);
    });
  },
  { immediate: true },
);

// 主题变化：xterm 的配色是 JS 选项，得显式改；面板底色也一起跟上
watch(
  () => snapshot.value?.theme?.resolved,
  () => {
    applyTerminalSurface(host.value, resolvedTheme());
    if (entry) entry.term.options.theme = { ...TERM_THEMES[resolvedTheme()] };
  },
);
</script>

<template>
  <div class="bar">
    <span class="bar-title">dsh web 进程终端</span>
    <span class="bar-note" id="term-note">{{ note }}</span>
    <span class="bar-hint" id="term-hint">{{ hint }}</span>
    <div class="spacer"></div>
    <button
      id="btn-term-clear"
      class="btn small ghost"
      title="只清空这里的显示，不影响 dsh 本身"
      :disabled="emptyVisible"
      @click="clearDisplay"
    >
      <svg class="i"><use href="#i-trash" /></svg><span>清空显示</span>
    </button>
    <button
      id="btn-term-replay"
      class="btn small ghost"
      title="把本应用缓存的历史输出重新显示一遍（最近 512 KB）"
      :disabled="emptyVisible"
      @click="replay"
    >
      <svg class="i"><use href="#i-replay" /></svg><span>重新显示历史</span>
    </button>
    <button
      id="btn-term-ctrlc"
      class="btn small danger"
      title="向 dsh 发送 Ctrl+C，让它自己退出"
      :disabled="!own"
      @click="sendCtrlC"
    >
      <svg class="i i-fill"><use href="#i-stop" /></svg><span>发送 Ctrl+C</span>
    </button>
  </div>

  <div class="term-host">
    <!-- xterm 会往 #term-dsh 里 append 自己的 DOM；这个元素里不能有 Vue 管理的子节点，
         否则两边争夺同一块 DOM（症状：终端只画一部分、下面出现奇怪的色块）。 -->
    <div id="term-dsh" class="term-mount" ref="host"></div>
    <div id="term-empty" class="empty empty-fill" :class="{ hidden: !emptyVisible }">
      <svg class="i empty-i"><use href="#i-terminal" /></svg>
      <h2 id="term-empty-title">dsh 没有在运行</h2>
      <p>
        这里显示 dsh 进程自己打印的东西。<b>dsh web 不读取键盘输入</b>，在这个框里打字不会有反应；
        要停它，用右上角的「发送 Ctrl+C」或控制台的「停止」。
      </p>
      <button id="btn-term-start" class="btn primary" :disabled="busyStart" @click="startDsh">
        <svg class="i i-fill"><use href="#i-play" /></svg><span>启动 dsh</span>
      </button>
    </div>
  </div>
</template>
