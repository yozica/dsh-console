/**
 * 开发期诊断：Ctrl+Shift+D（macOS 上 ⌘⇧D）把当前界面的元素结构导出到日志文件。
 *
 * 为什么需要它：界面出问题时（某块是黑的、某块不撑满、被谁挡住），
 * 只看截图容易靠猜 —— 而"每个元素的尺寸/位置/背景/display"是确定的。
 * 这条快捷键把整棵树打进 console，而渲染层的 console 会转发到主进程日志文件，
 * 于是**排查的一方（人或 agent）可以直接读那个文件**，不必反复要截图。
 *
 * 另外 F12 / Ctrl+Shift+I（macOS 上 ⌘⌥I）由主进程处理（见 main.js 的 wireDevTools），
 * 那是真正的开发者工具；这里只是"一键导出结构"的轻量版。
 *
 * 只在开发态安装：打包后 main.js 不会调 installDevDiagnostics()。
 */

import { isAppModifier, shortcutLabel } from './lib/platform.js'

const MAX_DEPTH = 12
const MAX_LINES = 600

/**
 * 跳过对排查布局没用的子树：
 *   - 图标精灵（内联 SVG 的一堆 symbol，全 0x0）
 *   - 列表项（事件日志最多 250 条、形状完全一样，会把 600 行的预算吃光，
 *     结果还没走到要看的那一页就截断了）
 */
function skip(el) {
  return el.classList?.contains('sprite') || el.tagName === 'LI'
}

function describe(el) {
  const rect = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  const id = el.id ? `#${el.id}` : ''
  const classes = el.classList.length ? `.${[...el.classList].slice(0, 3).join('.')}` : ''
  const size = `${Math.round(rect.width)}x${Math.round(rect.height)}`
  const pos = `@${Math.round(rect.left)},${Math.round(rect.top)}`
  const flags = [
    `display=${style.display}`,
    style.visibility === 'hidden' ? 'visibility=hidden' : '',
    style.overflow !== 'visible' ? `overflow=${style.overflow}` : '',
    style.backgroundColor !== 'rgba(0, 0, 0, 0)' ? `bg=${style.backgroundColor}` : '',
    style.zIndex !== 'auto' ? `z=${style.zIndex}` : ''
  ].filter(Boolean)
  return `${el.tagName.toLowerCase()}${id}${classes} ${size}${pos} ${flags.join(' ')}`
}

/** 当前可见的是哪一页：以 .pane.active 为准（body[data-page] 可能是陈旧值，会误导） */
function activePage() {
  const active = document.querySelector('.pane.active')
  return active ? active.id.replace(/^pane-/, '') : '?'
}

function dumpDom() {
  const lines = []
  const walk = (el, depth) => {
    if (lines.length >= MAX_LINES || depth > MAX_DEPTH || skip(el)) return
    lines.push(`${'  '.repeat(depth)}${describe(el)}`)
    for (const child of el.children) walk(child, depth + 1)
  }
  walk(document.body, 0)
  const truncated = lines.length >= MAX_LINES ? `（已截断到 ${MAX_LINES} 行）` : ''
  console.log(`[dom-dump] 当前页面：${activePage()} ${truncated}\n${lines.join('\n')}`)
}

/** 顺带把"当前状态"也打一行：界面不对时，往往先要确认状态对不对 */
function dumpState() {
  const panes = [...document.querySelectorAll('.pane')].map(
    (pane) => `${pane.id}${pane.classList.contains('active') ? '(active)' : ''}`
  )
  console.log(
    `[dom-state] page=${activePage()} immersive=${document.body.dataset.immersive}` +
      ` locked=${document.body.dataset.locked} theme=${document.documentElement.dataset.theme}` +
      ` panes=${panes.join(' ')}`
  )
}

export function installDevDiagnostics() {
  window.addEventListener('keydown', (event) => {
    if (!isAppModifier(event) || !event.shiftKey) return
    const key = String(event.key).toLowerCase()
    if (key === 'd') {
      event.preventDefault()
      dumpState()
      dumpDom()
    }
  })
  console.log(
    `[dev] 诊断快捷键已就绪：F12 开发者工具，${shortcutLabel('Shift+D')} 导出界面结构到日志`
  )
}
