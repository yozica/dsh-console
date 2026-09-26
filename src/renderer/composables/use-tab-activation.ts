/**
 * 「切到这一页时才做事」的唯一写法。
 *
 * 抽它的原因：这条形状在渲染层出现了 5 次（插件页、终端页、dsh 终端、两个内嵌页），
 * 每次都要手写 `watch(currentTab, (tab) => { if (tab !== 'x') return; … }, { immediate: true })`
 * —— 少写 `immediate` 或写错 id 都不会报错，只会"切过去什么都没发生"。收在一处之后，
 * id 由调用方给、形状由这里保证。
 *
 * 为什么用 `immediate: true`：界面刷新时可能就停在那一页上（`currentTab` 来自快照），
 * 不 immediate 的话那一页永远不初始化。
 *
 * 注意它**不负责**"只做一次"：那是调用方的事（比如插件页的 `loadedOnce`）——
 * 有的页每次切回来都要重算视口或刷新提示。`immediate: false` 给"只在切过来时补一下、
 * 初次挂载不补"那种（终端页的补 fit）。
 */

import { watch } from 'vue';

import { currentTab, type TabId } from '../state/store.js';

export function useTabActivation(
  tabId: TabId,
  onActivate: () => void,
  options: { immediate?: boolean } = {},
): void {
  watch(
    currentTab,
    (tab) => {
      if (tab !== tabId) return;
      onActivate();
    },
    { immediate: options.immediate ?? true },
  );
}
