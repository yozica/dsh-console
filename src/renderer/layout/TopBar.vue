<script setup lang="ts">
/**
 * 顶栏（同时是窗口标题栏，见 README「关于应用内全屏与标题栏」）。
 *
 * 三个显示值都来自共享 store；「退出全屏」按钮只改 store 里的 immersive，
 * 真正的 body 属性与内嵌页视口重算由 app.ts 监听后处理。
 *
 * 门禁层显示期间（冻结 §1 R-03）：标题换成「运行环境准备」，右侧与页面相关的控件
 * **收起**（不是禁用 —— 禁用会留下一个说不清用途的空槽）。四条约束：顶栏高度、
 * 标题左边缘、可拖动区域不变；收起不留空槽、不加过渡动画；门禁收起后同一帧恢复；
 * 取值只有一个来源 —— `state/env-wizard.ts` 的 `gateVisible`（自检盯着这一条）。
 */
import { computed } from 'vue';

import { gateVisible } from '../state/env-wizard.js';
import { envDetailOpen } from '../state/env-layer.js';
import { harnessArrivalNotice } from '../state/restart-nav.js';
import { currentTab, dsh, immersive, owned, phase, phaseInfo, updateHint } from '../state/store.js';
import { openUpdateSettings } from '../state/update-anchor.js';

const PAGE_TITLES = {
  dashboard: '控制台',
  terminal: '终端',
  ui: 'DeepSeek Harness',
  usage: 'DeepSeek 用量',
  archive: '归档会话',
  plugin: '插件',
  settings: '设置',
};

/**
 * 标题：门禁层显示期间是「运行环境准备」；环境自检详情层打开时是「<当前页> › 运行环境」
 * （摆法预览 2A 里就是这么画的，见 docs/rail-simplify-choices.html）—— 详情层盖在**当前页**
 * 上面，所以面包屑前半段跟着 currentTab 走：从控制台横幅进来就是「控制台 › 运行环境」。
 */
const title = computed(() => {
  if (gateVisible.value) return '运行环境准备';
  const page = PAGE_TITLES[currentTab.value] || currentTab.value;
  return envDetailOpen.value ? `${page} › 运行环境` : page;
});

/** 退出全屏：只改共享状态，body 属性与内嵌页视口由 app.ts / UiPane 各自 watch */
function exitImmersive() {
  immersive.value = false;
}

/** 状态灯：全屏时左栏被藏起来，灯挪到这一条里，状态词放 tooltip */
const lampTitle = computed(
  () => `${phaseInfo.value.title}${phaseInfo.value.desc ? `：${phaseInfo.value.desc}` : ''}`,
);

/**
 * 右侧上下文信息：控制台页自己有一整块事实区，这里就不重复了。
 * 去掉 http:// 前缀（本机地址，协议没有信息量），给标题栏省地方。
 */
const contextNote = computed(() => {
  const d = dsh.value;
  if (!d || currentTab.value === 'dashboard') return '';
  const pid = owned.value
    ? d.pid
      ? `PID ${d.pid}`
      : 'PID 识别中'
    : d.externalPid
      ? `外部实例 PID ${d.externalPid}`
      : '未运行';
  return `${String(d.origin || '').replace(/^https?:\/\//, '')}，${pid}`;
});

/**
 * 这一格显示的正文：重启就绪之后的 4 秒里让位给那句轻提示（t46）。
 *
 * 为什么是**顶栏这一格**（而不是 Harness 页工具条右端那格 `#ui-note`）：应用内全屏时
 * Harness 页的整条工具条会被藏起来（`body[data-immersive='true'] #pane-ui .bar`），
 * 而顶栏两种模式下都在。轻提示的摆法与取舍见 docs/harness-arrival-design.html。
 */
const note = computed(() => harnessArrivalNotice.value || contextNote.value);
</script>

<template>
  <header class="topbar">
    <span
      class="lamp immersive-only"
      id="topbar-lamp"
      :data-phase="phase"
      :title="lampTitle"
    ></span>
    <h1 class="page-title" id="page-title">{{ title }}</h1>
    <div class="spacer"></div>
    <!-- 应用内全屏时底栏被藏起来，更新提示得在这条里也有一份（见 §7.17）。
         摆法（用户真机指出）：**排在地址那一格的左边** —— 右边那格说的是"当前连的是哪个实例"
         （`127.0.0.1:3080，外部实例 PID …`），紧贴「退出全屏」；更新提示是一句动作，
         排在它前面。写在后面的话，那句话会夹在地址与退出按钮之间，读起来像地址的尾巴。 -->
    <button
      v-if="immersive && updateHint"
      id="btn-topbar-update"
      class="update-hint"
      @click="openUpdateSettings"
    >
      {{ updateHint }}
    </button>
    <!-- 与页面相关的控件：门禁层显示期间整条收起（v-if，不留空槽、不加过渡） -->
    <span
      v-if="!gateVisible"
      class="topbar-note"
      id="topbar-note"
      :class="{ lit: harnessArrivalNotice }"
      >{{ note }}</span
    >

    <button
      v-if="!gateVisible"
      id="btn-exit-immersive"
      class="btn small ghost immersive-only"
      title="退出全屏（Esc）"
      @click="exitImmersive"
    >
      <svg class="i"><use href="#i-collapse" /></svg><span>退出全屏</span>
    </button>
  </header>
</template>

<style scoped>
/* 顶栏自己的样式（t48 样式分层）：`.topbar` / `.page-title` / `.topbar-note`。
   macOS 红绿灯留白与系统全屏撤回那几条状态规则仍在全局表（它们挂在 html/body 上）。 */

/* 顶栏同时是窗口的标题栏：
   Windows/Linux 是 titleBarStyle: 'hidden' + 右上角系统控件浮层，
   macOS 是 hiddenInset + 左上角红绿灯（见下面的 data-platform 覆盖）。
   整条可拖动，系统控件的位置由内边距让出来，「退出全屏」按钮落在另一侧。 */
.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: var(--bar-h);
  padding: 0 12px 0 20px;
  /* 必须用 100vw（窗口宽）而不是 100%：100% 是顶栏所在容器的宽度，非全屏时
     那个容器已经被左栏切掉 188px，减出来是负数（踩过：顶栏右侧被挤没、
     地址显示成 "http://127."）。100vw - 可用宽度 = 系统控件占的宽度，
     最后 +12px 是气口 —— 否则内容右边缘会紧贴系统按钮，看着发闷。 */
  padding-right: calc(100vw - env(titlebar-area-width, calc(100vw - 150px)) + 12px);
  /* 注意：不要给顶栏加 z-index。启动锁（.boot-lock）要能盖住它 ——
     否则锁期间左上角会孤零零留一个页面标题，看着就是"没遮住"。 */
  -webkit-app-region: drag;
  flex: 0 0 auto;
}

.topbar button,
.topbar input,
.topbar select {
  -webkit-app-region: no-drag;
}

.page-title {
  font-size: var(--t-lg);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.topbar-note {
  color: var(--ink-faint);
  font-size: var(--t-sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 55%;
}

/* 顶栏在内嵌界面 / 应用内全屏下的两小块（t48 样式分层）：`.immersive-only` 与
   重启到达提示那格 `.topbar-note.lit`。`body[data-immersive]` 那几条状态规则在全局表。 */

/* 只在全屏时出现的顶栏元素（退出按钮、状态灯） */
.immersive-only {
  display: none;
}

/* 顶栏那格"亮一下"（t46 轻提示）：`#topbar-note` 在重启就绪后的 4 秒里变成
   绿色 + 一点点底色，然后自己换回"<地址>，PID …"。
   选它而不是 Harness 页工具条右端那格：应用内全屏时工具条整条会被藏起来，顶栏则两种模式下都在。
   为什么不做成浮层/胶囊：用户否了（"不好看"）—— 浮在别人页面的正文上、又没有层级，
   而这一格本来就在，读起来就是一句状态（见 docs/harness-arrival-design.html 方案 A）。 */
.topbar-note.lit {
  color: var(--run);
  background: var(--run-soft);
  border-radius: 999px;
  padding: 1px 9px;
  max-width: none;
}
</style>
