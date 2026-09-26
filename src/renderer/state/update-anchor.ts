/**
 * 设置页「更新卡片」的锚点信号。
 *
 * 底栏的更新提示（layout/StatusBar.vue）点一下要落到设置页那张卡片上：切页由调用方负责
 * （currentTab），"把卡片缓动带进视野、再用一层蒙层把整张「关于」卡片单独亮出来"
 * 由设置页自己做 —— 中间就靠这个信号。
 *
 * 为什么是递增的请求号而不是布尔量：连点两次也该各走一遍。布尔量第二次没有变化，
 * watch 不会触发 —— 看起来就像"点了没反应"。
 */

import { ref } from 'vue';

import { currentTab, immersive } from './store.js';

/** 请求号。0 = 还没有人请求过（所以设置页可以直接 watch，不必先判断初次） */
export const updateCardFocus = ref(0);

/** 请求聚焦设置页的更新卡片 */
export function requestUpdateCardFocus(): void {
  updateCardFocus.value += 1;
}

/**
 * 「有更新」被点之后做什么：**先退出应用内全屏**（全屏时左栏是藏着的，直接切到设置页会让人
 * 找不到北），再切到设置页，最后把「关于」里的更新卡片滚进视野并亮一次。
 * 底栏那条提示与顶栏那格（全屏时可用的那一处）共用这一份。
 */
export function openUpdateSettings(): void {
  immersive.value = false;
  currentTab.value = 'settings';
  requestUpdateCardFocus();
}
