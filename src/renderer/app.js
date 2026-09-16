'use strict'

/**
 * 渲染层剩下的"应用级胶水"：没有 DOM 归属、但需要一个地方待着的逻辑。
 *
 * 界面本身已经全部是 Vue 组件了（shell/ 是外壳，panes/ 是六个页面，lib/ 是共享状态与工具），
 * 这里只留四件事：
 *   1. 启动守卫（preload / xterm 没就绪时给一句能看懂的报错，而不是白屏）
 *   2. 启动锁：应用启动时自动拉起 dsh 的那几秒，锁住界面，就绪后解锁
 *   3. 自动打开：dsh 就绪后按设置切到 Harness 页并进全屏
 *   4. 键盘快捷键：Ctrl+R / ⌘R 重载、Ctrl+1~6 / ⌘1~6 切页、Esc 退出全屏/跳过启动锁
 *
 * 它们都在"状态之上"而不是"界面之上"，所以不需要组件外壳；等启动锁也做成组件后，
 * 这里会只剩守卫与快捷键。
 */

import { watch } from 'vue'
import { phaseText } from './lib/phase-text.js'
import { isAppModifier } from './lib/platform.js'
import {
  currentTab,
  dsh,
  immersive,
  immersiveAutoEntered,
  settings,
  snapshot,
  startStore
} from './lib/store.js'

const api = window.dshConsole

function showBootError(message) {
  const div = document.createElement('div')
  div.id = 'boot-error'
  div.textContent = `DSH Console 启动失败\n\n${message}`
  document.body.appendChild(div)
}

if (!api) {
  showBootError('preload 未注入：window.dshConsole 不存在。请检查 src/preload/preload.js 路径。')
} else {
  void main()
}

async function main() {
  await startStore()
  wireBootLock()
  wireAutoOpen()
  wireImmersive()
  wirePaneVisibility()
  wireShortcuts()
  announceUpdate()
}

// ------------------------------------------------------------ 升级提示

/**
 * 覆盖升级后的第一次启动：NSIS 会用 `--updated` 拉起应用（见 electron-builder 的
 * NSIS 模板），主进程把它放进快照的 env，这里在状态栏说一句。
 *
 * 之所以延迟一下：启动锁盖着整个界面（含状态栏），立刻说会被盖掉。
 */
function announceUpdate() {
  if (!snapshot.value?.env?.updated) return
  const version = snapshot.value.env.app || ''
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('dsh:status-message', { detail: `已更新到 ${version}` }))
  }, 2000)
}

// ------------------------------------------------------------ 应用内全屏

/**
 * 全屏状态住在 store 里（顶栏的「退出全屏」、Harness 页的「全屏」按钮、Esc 都改它），
 * 但**真正让界面变全屏的是 CSS** —— 它认的是 body[data-immersive]。
 * 所以这里必须把这个属性同步出去，否则按钮改了状态、界面毫无反应
 * （踩过：重写 app.js 时漏了这一段，全屏整个失效）。
 */
function wireImmersive() {
  watch(
    immersive,
    (on) => {
      document.body.dataset.immersive = on ? 'true' : 'false'
    },
    { immediate: true }
  )
}

// ------------------------------------------------------------ 页面可见性

/**
 * 切页时把 active 类打到页面容器上（`.pane.active { visibility: visible }` 是
 * 这一页显示与否的唯一开关 —— 刻意不用 display:none，因为内嵌页需要常驻布局）。
 *
 * 页面容器目前还留在 index.html 里（六个 <section class="pane">），所以这段归属
 * "应用级胶水"。等它们也搬进一个根组件，这段就该由模板的 :class 直接表达。
 */
function wirePaneVisibility() {
  watch(
    currentTab,
    (name) => {
      for (const pane of document.querySelectorAll('.pane')) {
        pane.classList.toggle('active', pane.id === `pane-${name}`)
      }
    },
    { immediate: true }
  )
}

// ------------------------------------------------------------ 启动锁

/**
 * 应用启动时由本应用自动拉起 dsh 的那几秒，界面状态还在变、点哪儿都不作数，
 * 所以锁住整个窗口；等 dsh 就绪、Harness 页打开后解锁。
 * 失败 / 异常 / 超时 / 手动跳过，一律解锁 —— 锁只是免打扰，不是把人关在外面。
 *
 * 状态机只能单向推进：idle → waiting → done。
 * 早期版本用"布尔量 + 每次状态变化重新判定"，结果解锁后只要条件又变回不满足
 * （例如用户手动退出全屏），锁就会重新扣上来 —— done 之后直接返回，杜绝这类回归。
 */
const BOOT_LOCK_MAX_MS = 90000
let bootLockState = 'idle'
let bootLockDeadline = 0
let bootLockStartedAt = 0

function setBootLock(on) {
  document.body.dataset.locked = on ? 'true' : 'false'
  document.getElementById('boot-lock')?.classList.toggle('hidden', !on)
}

/** 解锁是一次性的：走到 done 就再也不会重新上锁 */
function releaseBootLock() {
  bootLockState = 'done'
  setBootLock(false)
}

/** 锁上的那几秒给个时间感：已等待几秒 + 接下来会自动发生什么 */
function updateBootLockNote() {
  if (bootLockState !== 'waiting') return
  const waited = Math.max(1, Math.round((Date.now() - bootLockStartedAt) / 1000))
  const note = document.getElementById('boot-note')
  if (note) note.textContent = `已等待 ${waited} 秒 · 就绪后自动打开 DeepSeek Harness 并进入全屏`
}

function updateBootLock(phase) {
  if (bootLockState === 'done') return

  if (bootLockState === 'idle') {
    // 只有"启动应用时就在拉起"才加锁；用户自己点「启动」不加锁（那时他要看日志）
    if (phase !== 'starting') {
      bootLockState = 'done'
      return
    }
    bootLockState = 'waiting'
    bootLockStartedAt = Date.now()
    bootLockDeadline = Date.now() + BOOT_LOCK_MAX_MS
    setBootLock(true)
    updateBootLockNote()
  }

  // waiting：就绪 = dsh 跑起来了、该开的页面也开了
  // （自动全屏和"打开 Harness 页"是同一次流程里做的，所以不把全屏当解锁条件）
  const wantsUi = Boolean(settings.value.openUiOnStart)
  const ready = phase === 'running' && (!wantsUi || uiAutoOpened)
  const abnormal = ['stopped', 'degraded', 'conflict', 'external'].includes(phase)
  const timedOut = Date.now() > bootLockDeadline

  if (ready || abnormal || timedOut) {
    releaseBootLock()
    return
  }
  const desc = document.getElementById('boot-desc')
  if (desc) desc.textContent = phaseText(phase).desc || '正在拉起进程并等待健康检查'
}

function wireBootLock() {
  document.getElementById('btn-boot-skip')?.addEventListener('click', () => releaseBootLock())
  setInterval(() => {
    updateBootLockNote()
    // 锁着的时候超时判定也得跑，否则状态不再变化就永远不解锁
    if (bootLockState === 'waiting' && dsh.value) updateBootLock(dsh.value.phase)
  }, 1000)
  watch(
    () => dsh.value?.phase || 'stopped',
    (phase) => updateBootLock(phase),
    { immediate: true }
  )
}

// ------------------------------------------------------------ 自动打开

/** 启动时是否已经自动打开过 Harness 页 */
let uiAutoOpened = false

/**
 * dsh 就绪后按设置切到 Harness 页并进全屏 —— "打开应用直接开始用"。
 * 只在应用启动后发生一次（用户后来自己点「启动」不会把界面抢走）。
 */
function wireAutoOpen() {
  watch(
    () => dsh.value?.phase,
    (phase) => {
      if (uiAutoOpened || phase !== 'running' || !settings.value.openUiOnStart) return
      uiAutoOpened = true
      if (currentTab.value !== 'ui') currentTab.value = 'ui'
      // 切页时 UiPane 已按设置进过一次全屏，这里只是兜住"本来就在该页"的情况
      if (!immersiveAutoEntered.value && settings.value.uiFullscreenOnStart) {
        immersiveAutoEntered.value = true
        immersive.value = true
      }
    }
  )
}

// ------------------------------------------------------------ 快捷键

function wireShortcuts() {
  window.addEventListener('keydown', (event) => {
    // 启动锁期间键盘捷径也一并挡住 —— 锁的意义就是"别乱动"
    if (bootLockState === 'waiting') {
      if (event.key === 'Escape') {
        releaseBootLock()
        event.preventDefault()
      }
      return
    }
    // 全屏时 Esc 退出（这也是键盘用户的唯一出路）
    if (event.key === 'Escape' && immersive.value) {
      immersive.value = false
      event.preventDefault()
      return
    }
    // 默认菜单被移除了，Ctrl+R / ⌘R 的默认重载也随之消失；这里补回来
    if (isAppModifier(event) && !event.shiftKey && event.key.toLowerCase() === 'r') {
      location.reload()
      event.preventDefault()
      return
    }
    if (isAppModifier(event) && !event.shiftKey && /^[1-7]$/.test(event.key)) {
      const order = ['dashboard', 'terminal', 'shell', 'ui', 'usage', 'archive', 'settings']
      currentTab.value = order[Number(event.key) - 1]
      event.preventDefault()
    }
  })
}
