<script setup lang="ts">
/**
 * 关闭确认卡片（Windows / Linux）。
 *
 * 为什么不用原生 `dialog.showMessageBox`：那个弹窗的长相完全归系统管 —— 字体、配色、
 * 间距、动画一个都改不了，是**全应用唯一一个不像这个应用的面孔**。改成自己的卡片之后，
 * 还顺带能做到原生做不到的事：把真实状态写进去（哪个 dsh 会被停掉、PID 是多少）。
 * 原生那条路没有被删掉，它是渲染层卡住时的兜底（见 src/main/main.ts 的
 * `askRendererForCloseAction`：3 秒没回答就退回原生弹窗）。
 *
 * 这里只负责"问"：用户选完立刻把卡片收掉，收起窗口 / 退出应用由主进程执行。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';

import type { CloseAnswer, CloseAnswerAction, CloseRequest } from '../../shared/ipc';

const api = window.dshConsole;

const request = ref<CloseRequest | null>(null);
const remember = ref(false);
let stopWatch: (() => void) | null = null;

/** 卡片上那句"会发生什么"：只把主进程给的事实写成人话，不自己判断进程归属 */
const impact = computed(() => {
  const info = request.value;
  if (!info) return '';
  if (info.phase === 'stopped') return 'dsh 当前没有在运行。';
  const who = info.owned ? '本应用启动的 dsh' : '外部启动的 dsh（本应用只是接管了显示）';
  const pid = info.pid ? `，PID ${info.pid}` : '';
  if (!info.owned) return `${who}${pid} —— 退出 DSH Console 不会影响它。`;
  return info.killOnExit
    ? `${who}${pid} —— 按当前设置会被一并停止（「关闭应用时停止本应用启动的 dsh」）。`
    : `${who}${pid} —— 按当前设置不会被停止，退出后它继续在后台运行。`;
});

/**
 * Esc = 取消。用**捕获阶段**并掐断传播：app.ts 的全局 Esc（退出全屏 / 跳过启动锁）也挂在
 * window 上，不拦的话一次按键会做两件事。
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !request.value) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  void answer('cancel');
}

onMounted(() => {
  // 主进程推 null = 这次不问了（它已经退回原生弹窗），把卡片收起来别叠两个
  stopWatch = api.onCloseRequest((next) => {
    request.value = next;
    remember.value = false;
    /**
     * 立刻确认"卡片已经显示了"：主进程收到它才撤掉握手的时限，之后等用户慢慢选。
     * 不确认的话，用户多看了两秒就会被判成"渲染层卡住"，系统弹窗自己冒出来。
     */
    if (next) void api.ackClose();
  });
  window.addEventListener('keydown', onKeydown, true);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown, true);
  if (stopWatch) stopWatch();
});

async function answer(action: CloseAnswerAction): Promise<void> {
  // 先收起卡片：主进程收到回答后要么收起窗口、要么退出应用，界面不该还挂着一张卡片
  request.value = null;
  const payload: CloseAnswer = { action, remember: action === 'cancel' ? false : remember.value };
  try {
    await api.answerClose(payload);
  } catch {
    // 主进程已经超时走了原生兜底（那时它自己会弹一个），这里没有可做的
  }
}
</script>

<template>
  <!-- Teleport：挂在页面里会被各级层叠上下文限制住，盖不住顶栏、左栏与底栏 -->
  <Teleport to="body">
    <div v-if="request" class="close-dialog">
      <div class="close-card" role="dialog" aria-modal="true" aria-labelledby="close-dialog-title">
        <h2 class="close-title" id="close-dialog-title">关闭 DSH Console</h2>
        <p class="close-lead">要把它收到系统托盘，还是直接退出？</p>
        <p class="close-impact">{{ impact }}</p>
        <label class="check">
          <input type="checkbox" v-model="remember" />
          <span>记住我的选择，以后不再询问</span>
        </label>
        <div class="btn-row">
          <button class="btn primary" @click="answer('tray')">收起到托盘</button>
          <button class="btn" @click="answer('quit')">退出应用</button>
          <button class="btn ghost" @click="answer('cancel')">取消</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 关闭确认卡片自己的样式（t48 样式分层）：整节从 styles.css 搬来，含进入动画的关键帧。 */

/* ============================================================ 关闭确认卡片

   关窗时问"收起还是退出"。**有意不用原生 `dialog.showMessageBox`** —— 系统弹窗的长相
   改不了（字体、配色、间距、动画），是全应用唯一一个不像这个应用的面孔；自己画还顺带
   能把"哪个 dsh 会被停掉、PID 是多少"写进去（见 shell/CloseDialog.vue）。
   与上面的聚焦蒙层相反：**这层是模态的**，要挡住点击 —— 不选就不该操作后面的界面。 */

.close-dialog {
  position: fixed;
  inset: 0;
  z-index: 96;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--scrim);
  animation: close-dialog-in 160ms ease-out 1;
}

@keyframes close-dialog-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

.close-card {
  width: min(440px, 100%);
  padding: 20px;
  background: var(--surface);
  border: 1px solid var(--hairline);
  border-radius: var(--r-card);
  /* 全局唯一那处阴影（--shadow-focus）就是给这种浮起来的卡片用的 */
  box-shadow: var(--shadow-focus);
}

.close-title {
  font-size: var(--t-lg);
  font-weight: 600;
}

.close-lead {
  margin-top: 6px;
  color: var(--ink-dim);
  font-size: var(--t-sm);
}

/* "会发生什么"：左强调条 + 下沉井底色，与别处的提示块同一个写法 */
.close-impact {
  margin-top: 14px;
  padding: 10px 12px;
  background: var(--surface-2);
  border-left: 3px solid var(--accent);
  border-radius: var(--r-control);
  color: var(--ink-dim);
  font-size: var(--t-sm);
  line-height: 1.6;
}

/* 按钮靠右：与系统弹窗的习惯一致，主操作（收起）在最左 */
.close-card .btn-row {
  margin-top: 18px;
  justify-content: flex-end;
}
</style>
