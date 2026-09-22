<script setup lang="ts">
/**
 * DeepSeek Harness 页：把 DSH Web UI 用带令牌的地址内嵌进来。
 *
 * 这一页的复杂度全在"令牌"上：dsh 的访问令牌是**进程私有**的，只在启动时打印一次
 * （`dsh web: http://…?token=…`），没有接口能事后取回。所以分三种情形：
 *   1. 本应用启动的 dsh → 从终端输出里捕获到令牌，自动载入
 *   2. 外部实例 → 拿不到令牌，顶部常驻提醒 + 给出「重启为受管实例」的出路
 *      也可以把启动它的终端里那条完整地址粘进输入框临时载入
 *   3. 没在跑 → 提示回控制台启动
 *
 * 迁移前的这些判断散在 app.js 的 updateUiHint / renderTokenWarning 里，用
 * `classList.add('hidden')` 和 `setText` 表达；现在是模板里的 v-if 与 computed。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { restartThenOpenHarness } from '../lib/restart-flow.js';
import { harnessArrivalNotice } from '../lib/restart-nav.js';
import {
  currentTab,
  dsh,
  immersive,
  immersiveAutoEntered,
  settings,
  uiLoadable,
} from '../lib/store.js';
import type { WebviewElement, WebviewFailLoadEvent } from '../lib/webview.js';

const api = window.dshConsole;

const view = ref<WebviewElement | null>(null);
const note = ref('还没有拿到带令牌的地址');
const urlInput = ref('');
const busy = ref(false);

/** 用户手动粘贴的带令牌地址（令牌是进程级的，不做持久化） */
const pastedUrl = ref('');
let viewReady = false;
let loadedOnce = false;
let loadedUrl = '';

/** 可用的带令牌地址：优先本应用从终端输出里捕获的，其次用户粘贴的 */
const resolvedUrl = computed(() => dsh.value?.uiUrl || pastedUrl.value);

/** 有 dsh 在跑、但本应用没有它的令牌 → 顶部常驻提醒 */
const tokenWarning = computed(() => {
  const d = dsh.value;
  if (!d || resolvedUrl.value || !d.probe?.reachable) return '';
  const isExternal = d.phase === 'external' || !d.owned;
  return isExternal
    ? '当前 dsh 不是本应用启动的，拿不到它的访问令牌，内嵌界面无法显示。请点「重启为受管实例」，或先在控制台停止它、再由本应用启动 —— 之后这里会自动可用。'
    : '还没拿到访问令牌，内嵌界面暂不可用。等本应用启动的 dsh 打印出带令牌地址后会自动可用。';
});

function maskUrl(url: unknown): string {
  return String(url || '').replace(/(token=)[^&\s]+/i, '$1***');
}

function escapeHtml(text: unknown): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 空状态（未载入/失败时的说明）。pinned 表示"这是具体错误，别被自动提示覆盖"
const hintTitle = ref('还没载入界面');
const hintBody = ref('');
const hintVisible = ref(true);
let hintPinned = false;

function showHint(title: string, bodyHtml: string, pinned?: boolean): void {
  hintTitle.value = title;
  hintBody.value = bodyHtml;
  hintVisible.value = true;
  hintPinned = Boolean(pinned);
}

function hideHint() {
  hintVisible.value = false;
  hintPinned = false;
}

/** 没有具体错误时，根据状态给出该做什么的提示 */
function updateHint() {
  if (!dsh.value || hintPinned) return;
  if (resolvedUrl.value) return;
  if (!dsh.value.probe?.reachable) {
    showHint(
      'dsh 未运行',
      '内嵌界面需要 <code>dsh web</code> 处于运行状态。回到「控制台」点<b>启动</b>，由本应用拉起的实例会自动带上访问令牌。',
    );
    return;
  }
  if (dsh.value.phase === 'external') {
    showHint(
      '内嵌界面需要由本应用启动 dsh',
      'dsh 的访问令牌是<b>进程私有</b>的：它只在启动时打印一次（<code>dsh web: http://…?token=…</code>），没有接口能事后取回。' +
        '当前实例是外部启动的，本应用拿不到这个令牌，而裸地址只会返回 <code>401 dsh web authentication required</code>。<br><br>' +
        '<b>正确做法</b>：点上方 <b>「重启为受管实例」</b>（或先在控制台停止它，再由本应用启动）—— 之后令牌会被自动捕获，本页自动可用。' +
        '<br><br>如果你手上还留着启动它的那个终端，也可以把那条完整地址粘到上面的输入框临时载入。',
    );
    return;
  }
  showHint(
    '还没捕获到带令牌的地址',
    '等本应用启动的 dsh 打印出 <code>dsh web: http://…?token=…</code> 后，本页会自动可用。',
  );
}

function loadUrl(url?: string | null): void {
  const el = view.value;
  if (!el || !url) return;
  hideHint();
  note.value = `载入中：${maskUrl(url)}`;
  loadedOnce = true;
  loadedUrl = url;
  if (viewReady) {
    // 用 loadURL 并吞掉 promise，避免切换地址时上一笔导航被中止而抛 ERR_ABORTED
    try {
      const pending = el.loadURL(url);
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      return;
    } catch {
      /* 落到 src 赋值 */
    }
  }
  el.src = url;
}

function maybeLoad(force?: boolean): void {
  if (!dsh.value) return;
  const url = resolvedUrl.value;
  if (!url) {
    updateHint();
    note.value = '需要先捕获带令牌的地址';
    return;
  }
  if (loadedOnce && !force && loadedUrl === url) {
    hideHint();
    return;
  }
  loadUrl(url);
}

function applyPastedUrl() {
  const value = String(urlInput.value || '').trim();
  if (!value) {
    note.value = '先在输入框里粘贴 dsh 打印的带令牌地址';
    return;
  }
  if (!/^https?:\/\//i.test(value)) {
    note.value = '地址需要以 http:// 或 https:// 开头';
    return;
  }
  pastedUrl.value = value;
  loadUrl(value);
}

function reload() {
  view.value?.reload();
}

function goBack() {
  const el = view.value;
  if (el?.canGoBack()) el.goBack();
}

async function restartManaged() {
  if (busy.value) return;
  busy.value = true;
  try {
    await restartThenOpenHarness(api, () => dsh.value, 'ui');
  } finally {
    busy.value = false;
  }
}

/** 应用内全屏开关（顶栏的退出按钮、Esc 改的是同一个状态） */
function toggleFullscreen() {
  immersive.value = !immersive.value;
}

/** 顺带把新的访问令牌捕获回来；内嵌界面随即可用 */
function refreshViewport() {
  const el = view.value;
  if (!el) return;
  el.style.height = 'calc(100% - 1px)';
  void el.offsetHeight;
  el.style.height = '';
}

onMounted(() => {
  const el = view.value;
  if (!el) return;

  el.addEventListener('dom-ready', () => {
    viewReady = true;
  });
  el.addEventListener('did-start-loading', () => (note.value = '载入中…'));
  el.addEventListener('did-finish-load', async () => {
    const url = el.getURL();
    let body = '';
    try {
      body = await el.executeJavaScript(
        'document.body ? document.body.innerText.slice(0, 500) : ""',
      );
    } catch {
      /* 拿不到页面文本就跳过鉴权判定 */
    }
    if (/dsh web authentication required/i.test(body)) {
      note.value = '鉴权失败：缺访问令牌';
      showHint(
        '这个地址没通过 dsh 的鉴权',
        '返回的是 <code>401 dsh web authentication required</code>：地址里的 <code>token</code> 缺失或已失效（令牌只在对应那次启动期间有效）。<br>' +
          '用上方 <b>「重启为受管实例」</b> 重新拉起，或粘贴当前实例打印的最新地址。',
        true,
      );
      return;
    }
    hideHint();
    note.value = `已载入 ${url}`;
  });
  el.addEventListener('did-fail-load', (event) => {
    const detail = event as WebviewFailLoadEvent;
    if (detail.errorCode === -3) return; // 被新导航取代/主动取消，不算失败
    note.value = `载入失败 (${detail.errorCode}) ${detail.errorDescription}`;
    showHint(
      '载入失败',
      `错误码 <code>${detail.errorCode}</code>：${escapeHtml(detail.errorDescription)}<br>地址：<code>${escapeHtml(maskUrl(detail.validatedURL))}</code>`,
      true,
    );
  });

  // 捕获到新令牌 = 新的 dsh 进程，之前载入的页面（含旧 cookie）作废
  api.onUiUrl(() => {
    loadedOnce = false;
    pastedUrl.value = '';
    if (currentTab.value === 'ui') maybeLoad(true);
  });

  /**
   * 第一次进本页时按设置自动全屏 —— 但**只有内嵌界面真的能用（或即将能用）才做**：
   * 外部实例拿不到令牌时这里只有一段说明，为它收起整屏（藏掉左栏与底栏）没有意义。
   * 用户粘贴了地址也算能用，所以额外看 pastedUrl。
   */
  function maybeAutoFullscreen(): void {
    if (immersiveAutoEntered.value) return;
    if (!settings.value.uiFullscreenOnStart) return;
    if (!uiLoadable.value && !pastedUrl.value) return;
    immersiveAutoEntered.value = true;
    immersive.value = true;
  }

  // 切到本页：刷新提示 + 按需载入 + 按设置自动全屏
  watch(
    currentTab,
    (tab) => {
      if (tab !== 'ui') return;
      updateHint();
      maybeLoad(false);
      refreshViewport();
      maybeAutoFullscreen();
    },
    { immediate: true },
  );

  // dsh 状态变化时：刷新提示，并在本页可见时尝试载入。
  // 后者不能省：切到本页时快照可能还没到（maybeLoad 里 !dsh 会提前返回），
  // 等令牌随快照到达时若不重试，页面就永远停在"还没载入界面"（踩过）。
  watch(dsh, () => {
    updateHint();
    if (currentTab.value !== 'ui') return;
    maybeLoad(false);
    // 令牌是后到的（先起服务、后打印地址）：这时补一次自动全屏，别让"进页时还没有令牌"变成永不生效
    maybeAutoFullscreen();
  });
});
</script>

<template>
  <div class="bar">
    <button id="btn-ui-open" class="btn small primary" @click="maybeLoad(true)">
      <svg class="i"><use href="#i-browser" /></svg><span>载入</span>
    </button>
    <button id="btn-ui-fullscreen" class="btn small" @click="toggleFullscreen">
      <svg class="i"><use :href="immersive ? '#i-collapse' : '#i-expand'" /></svg>
      <span>{{ immersive ? '退出全屏' : '全屏' }}</span>
    </button>
    <button
      id="btn-ui-managed"
      class="btn small"
      :disabled="busy"
      :aria-busy="busy ? 'true' : undefined"
      @click="restartManaged"
    >
      <svg class="i"><use href="#i-restart" /></svg><span>重启为受管实例</span>
    </button>
    <button id="btn-ui-reload" class="btn small ghost" @click="reload">
      <span>重新载入</span>
    </button>
    <button id="btn-ui-back" class="btn small ghost" @click="goBack">
      <svg class="i"><use href="#i-back" /></svg><span>后退</span>
    </button>
    <div class="spacer"></div>
    <span class="bar-note" id="ui-note">{{ note }}</span>
  </div>

  <div v-if="tokenWarning" id="ui-token-warning" class="banner">
    <svg class="i"><use href="#i-warn" /></svg>
    <span id="ui-token-warning-text">{{ tokenWarning }}</span>
  </div>

  <div class="ui-paste">
    <input
      id="ui-url-input"
      v-model="urlInput"
      type="text"
      spellcheck="false"
      placeholder="可选：粘贴 dsh 打印的带令牌地址"
      @keydown.enter="applyPastedUrl"
    />
    <button id="btn-ui-load-pasted" class="btn small" @click="applyPastedUrl">
      用这个地址载入
    </button>
  </div>

  <div class="webview-wrap">
    <!-- 刚刚重启过 dsh：装配层的改动已经加载（t46 / docs/plugin-restart.md §3）。
         **轻提示**：浮在内嵌界面顶部、几秒后自己消失 —— 没有按钮，不会常驻（用户裁定）。
         放在 .webview-wrap 里是为了不压住上面那排工具；pointer-events: none 保证不挡内嵌页的点击。 -->
    <div v-if="harnessArrivalNotice" id="ui-arrival" class="toast" role="status">
      <svg class="i"><use href="#i-restart" /></svg>
      <span id="ui-arrival-text">{{ harnessArrivalNotice }}</span>
    </div>
    <webview
      class="embedded-view"
      id="ui-view"
      ref="view"
      partition="persist:dsh-ui"
      allowpopups
    ></webview>
    <div id="ui-empty" class="empty empty-fill" :class="{ hidden: !hintVisible }">
      <svg class="i empty-i"><use href="#i-browser" /></svg>
      <h2 id="ui-hint-title">{{ hintTitle }}</h2>
      <!-- 内容是本组件用 escapeHtml 转义后拼出来的，不含外部输入的可执行标记 -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div id="ui-hint-body" class="empty-body" v-html="hintBody"></div>
    </div>
  </div>
</template>
