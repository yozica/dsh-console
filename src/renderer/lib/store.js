/**
 * 渲染层的共享状态（外壳与已迁移的页面都从这里取，不再各订阅一份）。
 *
 * 为什么需要它：迁移是逐页做的，先是每个页面各自 `getSnapshot()` + `onState()`，
 * 于是同一份快照被订阅了好几遍。外壳开始迁移时把它收成一份 —— 一处订阅，
 * 大家读同一份响应式状态。
 *
 * 还没迁移的 app.js 也 import 它：它负责的那几页（终端 / Shell / Harness / 用量）
 * 用的依然是同一份快照。
 */

import { computed, ref } from 'vue'
import { phaseText } from './phase-text.js'

const api = window.dshConsole

/** 最近一次完整快照（getSnapshot 的返回结构） */
export const snapshot = ref(null)
/** 快照里的 dsh 状态（onState 只推这一部分） */
export const dsh = computed(() => snapshot.value?.dsh || null)
export const settings = computed(() => snapshot.value?.settings || {})
export const phase = computed(() => dsh.value?.phase || 'stopped')
export const phaseInfo = computed(() => phaseText(phase.value))
/** 归属判断只看 dsh.owned */
export const owned = computed(() => Boolean(dsh.value?.owned))

/** 当前页面（外壳的导航与各页共用） */
export const currentTab = ref('dashboard')
/** 应用内全屏（顶栏的退出按钮、Harness 页的全屏按钮、Esc 都改它） */
export const immersive = ref(false)
/** 自动进入过一次全屏后置位：手动退出后不再自动拉回去 */
export const immersiveAutoEntered = ref(false)
/** 启动时是否已经自动打开过 Harness 页 */
export const uiAutoOpened = ref(false)

let pending = null

/** 主题落地到 <html data-theme>：CSS 变量全挂在它上面（xterm 的配色不走 CSS，各自处理） */
function syncDocumentTheme() {
  const resolved = snapshot.value?.theme?.resolved === 'light' ? 'light' : 'dark'
  document.documentElement.dataset.theme = resolved
}

/**
 * 建立唯一的订阅。幂等，而且**第二次调用会等第一次完成** ——
 * 这里必须缓存 Promise，不能只用一个 boolean：
 * main.js 是 `void startStore()` 先发起，组件挂载后再 `await startStore()`，
 * 若第二次直接返回，组件会在快照还是 null 时就去读（踩过：事件日志首个挂载是空的）。
 */
export function startStore() {
  if (!pending) {
    pending = (async () => {
      snapshot.value = await api.getSnapshot()
      syncDocumentTheme()
      api.onState((next) => {
        snapshot.value = { ...(snapshot.value || {}), dsh: next }
      })
      api.onTheme((info) => {
        if (snapshot.value) snapshot.value.theme = info
        syncDocumentTheme()
      })
    })()
  }
  return pending
}

/** 主题三态开关与设置页共用：改完把结果写回快照 */
export async function setThemeMode(mode) {
  const info = await api.setTheme(mode)
  if (snapshot.value) snapshot.value.theme = info
  return info
}
