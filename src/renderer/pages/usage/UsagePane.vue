<script setup lang="ts">
/**
 * DeepSeek 用量页：一个浏览器视图，加载设置里的地址（默认开放平台用量页），
 * 用独立分区 `persist:deepseek` 保存登录态。本应用不读取页面内容。
 *
 * 迁移前，这一页的每个提示都是 app.js 里的 `setText('usage-note', …)` /
 * `document.getElementById('usage-empty').classList.add('hidden')`；现在是模板 + ref。
 *
 * `<webview>` 的事件只能命令式挂（Vue 不代理自定义元素的事件），
 * 那部分留在 onMounted 里，用 onUnmounted 配平 —— 这正是用组件表达生命周期的好处。
 */
import { ref, watch } from 'vue';
import { useWebview } from '../../composables/use-webview.js';
import { settings } from '../../state/store.js';

const api = window.dshConsole;

const USAGE_FALLBACK_URL = 'https://platform.deepseek.com/usage';

/** 内嵌页宿主：`view` / `note` / 载入记账 / 那四个事件都由它管（见 composables/use-webview.ts） */
const host = useWebview({
  tabId: 'usage',
  idleNote: '还没有打开',
  onLoaded: () => {
    hintVisible.value = false;
    note.value = `已载入 ${view.value?.getURL() ?? ''}`;
  },
  onFailed: (detail) => {
    note.value = `载入失败 (${detail.errorCode})`;
    showEmpty(
      '用量页没能载入',
      `<p>错误码 <code>${detail.errorCode}</code>：${escapeHtml(detail.errorDescription)}</p>` +
        `<p>地址：<code>${escapeHtml(host.url())}</code></p>` +
        '<p>先检查网络；也可以点右上角「在浏览器打开」。地址能在「设置 → DeepSeek 用量页」里改。</p>',
    );
  },
  onActivate: () => {
    // 第一次进来才真正加载（等一帧，让刚变可见的页面先完成布局，guest 才会拿到正确的视口尺寸）；
    // 之后只是重算视口
    if (!host.url()) requestAnimationFrame(() => open());
    else host.refreshViewport();
  },
});
const { view, note, reload, goBack } = host;
const hintTitle = ref('还没打开用量页');
/** 仅出错时替换为空状态正文；正常时用模板里的默认说明 */
const hintBody = ref('');
const hintVisible = ref(true);

function targetUrl() {
  const raw = String(settings.value.deepseekUrl || '').trim();
  return /^https?:\/\//i.test(raw) ? raw : USAGE_FALLBACK_URL;
}

function escapeHtml(text: unknown): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function showEmpty(title: string, bodyHtml?: string): void {
  hintTitle.value = title;
  if (bodyHtml !== undefined) hintBody.value = bodyHtml;
  hintVisible.value = true;
}

/** 打开配置里的地址。「重新载入」按钮和切到本页时都走它。 */
function open() {
  hintVisible.value = false;
  host.load(targetUrl(), `载入中：${targetUrl()}`);
}

function openExternal() {
  void api.openExternal(host.url() || targetUrl());
}

// 设置里改了地址：已经打开过就按新地址重新加载
watch(
  () => settings.value.deepseekUrl,
  () => {
    if (host.url()) open();
  },
);
</script>

<template>
  <div class="bar">
    <button
      id="btn-usage-open"
      class="btn small primary"
      title="重新加载配置里的地址"
      @click="open"
    >
      <svg class="i"><use href="#i-usage" /></svg><span>打开用量页</span>
    </button>
    <button id="btn-usage-reload" class="btn small ghost" @click="reload">
      <span>重新载入</span>
    </button>
    <button id="btn-usage-back" class="btn small ghost" @click="goBack">
      <svg class="i"><use href="#i-back" /></svg><span>后退</span>
    </button>
    <div class="spacer"></div>
    <button
      id="btn-usage-external"
      class="btn small ghost"
      title="在系统浏览器里打开（需要扫码或弹窗登录时用它）"
      @click="openExternal"
    >
      <svg class="i"><use href="#i-external" /></svg><span>在浏览器打开</span>
    </button>
    <span class="bar-note" id="usage-note">{{ note }}</span>
  </div>

  <div class="webview-wrap">
    <webview
      class="embedded-view"
      id="usage-view"
      ref="view"
      partition="persist:deepseek"
      allowpopups
    ></webview>
    <div id="usage-empty" class="empty empty-fill" :class="{ hidden: !hintVisible }">
      <svg class="i empty-i"><use href="#i-usage" /></svg>
      <h2 id="usage-hint-title">{{ hintTitle }}</h2>
      <!-- 内容是本组件用 escapeHtml 转义后拼出来的，不含外部输入的可执行标记 -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-if="hintBody" id="usage-hint-body" class="empty-body" v-html="hintBody"></div>
      <div v-else id="usage-hint-body" class="empty-body">
        <p>这一页用来查看 DeepSeek API 的 token 用量，加载的是开放平台的页面。</p>
        <p>
          第一次打开需要在那里登录一次。登录状态保存在本机这个应用自己的浏览器分区里，之后就是登录态；
          本应用不读取页面内容，也不会拿到你的账号数据。
        </p>
        <p>
          想换成别的页面（例如官网主页 <code>https://www.deepseek.com</code>），到「设置 → DeepSeek
          用量页」改地址即可。
        </p>
      </div>
    </div>
  </div>
</template>
