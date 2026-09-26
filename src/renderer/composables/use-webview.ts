/**
 * 内嵌页（`<webview>`）的宿主：把两个内嵌页里逐字重复的那几段收进来。
 *
 * 收进来的判据是"两页一字不差"，不是"看起来像"：
 *   - `refreshViewport()`：先压 1px 再放开，让 guest 重算视口 —— 两页逐字相同；
 *   - `reload()` / `goBack()`；
 *   - `load()` 里那段"**用 `loadURL` 并吞掉 promise**，否则退到 `src` 赋值"——
 *     切换地址时上一笔导航会被中止而抛 `ERR_ABORTED`，两页的注释都在说这件事；
 *   - `onMounted` 里那四个事件与 `did-fail-load` 的 **-3 过滤**（被新导航取代不算失败）；
 *   - 「切到本页时做事」的接线（见 `use-tab-activation.ts`）。
 *
 * **没**收进来的（两页真的不同，硬合并会变成一堆回调）：载入地址从哪来（令牌 vs 设置）、
 * 失败时说什么、`did-finish-load` 之后要补做什么（Harness 页要查鉴权）。这些交给 hooks。
 *
 * 状态归属：`view` / `note` 由这里持有（两页各自的那一份），其余判据留在页面里 ——
 * 与 §7.33「只有一处用的跟那一处走」同源。
 */

import { onMounted, ref, type Ref } from 'vue';

import { useTabActivation } from './use-tab-activation.js';
import type { TabId } from '../state/store.js';
import type { WebviewElement, WebviewFailLoadEvent } from '../utils/webview.js';

export interface WebviewHostOptions {
  /** 这一页在左栏里的 id（`useTabActivation` 用） */
  tabId: TabId;
  /** 还没开始载入时状态条那句（两页不同） */
  idleNote: string;
  /** 切到本页时要做什么（各页不同：更新提示、按需载入、重算视口、自动全屏…） */
  onActivate?: (host: WebviewHost) => void;
  /** 载入完成（失败与 -3 已经在宿主里处理掉了） */
  onLoaded?: (el: WebviewElement, host: WebviewHost) => void;
  /** 载入失败（`errorCode === -3` 已被过滤）—— 说什么由调用方决定 */
  onFailed?: (detail: WebviewFailLoadEvent, host: WebviewHost) => void;
}

export interface WebviewHost {
  /** 绑到模板上的 `<webview ref>` */
  view: Ref<WebviewElement | null>;
  /** 状态条那一句 */
  note: Ref<string>;
  /** 当前载入的地址（`''` = 还没载入过）。不是响应式的，与改造前那个 `let` 一致 */
  url(): string;
  /** 载入地址；`progressNote` 用来写那句"载入中：…"（两页的措辞不同） */
  load(url: string, progressNote?: string): void;
  /** 作废当前这一次载入（新令牌 = 新进程），下次 activate 会重新载入 */
  reset(): void;
  /** 让 guest 重算视口（切页回来、窗口变化后用） */
  refreshViewport(): void;
  reload(): void;
  goBack(): void;
}

export function useWebview(options: WebviewHostOptions): WebviewHost {
  const view = ref<WebviewElement | null>(null);
  const note = ref(options.idleNote);
  // 这两个都是"纯记账"：改造前是组件里的 `let`，不是响应式的
  let ready = false;
  let loadedUrl = '';

  const host: WebviewHost = {
    view,
    note,
    url: () => loadedUrl,
    load(url: string, progressNote?: string): void {
      const el = view.value;
      if (!el || !url) return;
      note.value = progressNote ?? `载入中：${url}`;
      loadedUrl = url;
      if (ready) {
        // 用 loadURL 并吞掉 promise：切换地址时上一笔导航会被中止而抛 ERR_ABORTED
        try {
          const pending = el.loadURL(url);
          if (pending && typeof pending.catch === 'function') pending.catch(() => {});
          return;
        } catch {
          /* 落到 src 赋值 */
        }
      }
      el.src = url;
    },
    reset(): void {
      loadedUrl = '';
    },
    refreshViewport(): void {
      const el = view.value;
      if (!el) return;
      el.style.height = 'calc(100% - 1px)';
      void el.offsetHeight;
      el.style.height = '';
    },
    reload(): void {
      view.value?.reload();
    },
    goBack(): void {
      const el = view.value;
      if (el?.canGoBack()) el.goBack();
    },
  };

  onMounted(() => {
    const el = view.value;
    if (!el) return;

    el.addEventListener('dom-ready', () => {
      ready = true;
    });
    el.addEventListener('did-start-loading', () => (note.value = '载入中…'));
    el.addEventListener('did-finish-load', () => options.onLoaded?.(el, host));
    el.addEventListener('did-fail-load', (event) => {
      const detail = event as WebviewFailLoadEvent;
      if (detail.errorCode === -3) return; // 被新导航取代/主动取消，不算失败
      options.onFailed?.(detail, host);
    });

    // 接线放在 mounted 里：改造前两页的 watch 都在 onMounted 内，顺序（先绑事件、再激活）
    // 与那时一致 —— immediate 那一下要读得到 `view`。
    useTabActivation(options.tabId, () => options.onActivate?.(host));
  });

  return host;
}
