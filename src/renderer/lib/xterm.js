/**
 * xterm 相关的共享部分：配色、建实例、尺寸同步。
 *
 * dsh 终端页和本地 Shell 页都要用，而且配色不能走 CSS（xterm 的 theme 是 JS 选项），
 * 所以放在这里共用一份，避免两页各写一遍然后慢慢走样。
 *
 * 这里**直接导入** xterm 与 addon 的类，不再经过 window 全局：
 * 迁移时留过一层 `window.FitAddon = FitAddon` 的过渡，而那是错的 ——
 * UMD 全局是命名空间对象（`window.FitAddon.FitAddon` 才是类），把 ESM 导入的类本身
 * 挂上去之后，再读 `.FitAddon` 就是 undefined，于是 fit addon 静默装不上、
 * 终端永远停在默认的 80×24（踩过：容器 966×723，终端却一直只画 572×432）。
 */

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { isAppModifier, isMac } from './platform.js'

/** 终端配色，与 styles.css 的两套主题对应 */
export const TERM_THEMES = {
  dark: {
    background: '#0b0e13',
    foreground: '#e6e9ef',
    cursor: '#4f7cff',
    selectionBackground: '#2b3a63',
    black: '#1b1f27',
    red: '#ef5350',
    green: '#38d39f',
    yellow: '#f0b429',
    blue: '#4f7cff',
    magenta: '#c586e0',
    cyan: '#4dd0e1',
    white: '#d5dae3'
  },
  light: {
    background: '#ffffff',
    foreground: '#1b1f27',
    cursor: '#2f6bff',
    selectionBackground: '#cfe0ff',
    black: '#24292f',
    red: '#b3261e',
    green: '#0f7b4f',
    yellow: '#8a5a00',
    blue: '#1a4fd6',
    magenta: '#8250df',
    cyan: '#0b6f8a',
    white: '#57606a'
  }
}

/**
 * 等宽字体栈按平台给：终端里的字符宽度是 xterm 量出来的，
 * 用系统自带等宽字体最稳（避免随包分发的 webfont 迟到导致列宽算错），
 * 中日韩文字另外挂一个系统的中文兜底，否则 dsh 的中文输出会退化成方框。
 */
function monoStack() {
  return isMac.value
    ? 'Menlo, Monaco, "SF Mono", "PingFang SC", "IBM Plex Mono", monospace'
    : 'Consolas, "Cascadia Mono", "Microsoft YaHei", "IBM Plex Mono", monospace'
}

export function terminalOptions(resolved) {
  return {
    fontFamily: monoStack(),
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: { ...(TERM_THEMES[resolved] || TERM_THEMES.dark) }
  }
}

/**
 * 把终端配色同步到容器元素的 CSS 变量上。
 *
 * 终端面板要"一整块连续的颜色"：容器的内边距、空状态覆盖层都得跟 xterm 自己的
 * 底色一致，否则会看到"终端是一块、留白是另一块"。颜色只在 TERM_THEMES 里定义一次，
 * 这里把它交给 CSS（`var(--term-bg)` / `var(--term-fg)`），不在样式表里再抄一遍。
 */
export function applyTerminalSurface(el, resolved) {
  if (!el) return
  const theme = TERM_THEMES[resolved] || TERM_THEMES.dark
  el.style.setProperty('--term-bg', theme.background)
  el.style.setProperty('--term-fg', theme.foreground)
}

/** 建一个终端实例并打开在 host 上，返回 { term, fit } */
export function attachTerminal(host, resolved) {
  applyTerminalSurface(host, resolved)
  const term = new Terminal(terminalOptions(resolved))
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  term.open(host)
  return { term, fit }
}

/**
 * 让应用级快捷键穿过终端。
 *
 * 不这么做的话，xterm 会把 Ctrl+2~7 / ⌘2~7 当成控制字符吃掉（^@、^[、^\、^]、^^、^_）、
 * 并停止冒泡，window 上那个切换页面的处理器就永远收不到 ——
 * 症状是"在终端里只有 Ctrl+1 能切页，2~7 全都没反应"（Ctrl+1 恰好不在它的表里）。
 *
 * 用 xterm 的正式接口：处理函数返回 false = 终端不处理，事件继续冒泡给应用。
 * 修饰键按平台取（macOS 认 Cmd，其它平台认 Ctrl），与 app.js 的处理器保持一致。
 * `includeReload` 用来决定 Ctrl+R / ⌘R 归谁：dsh 终端里输入本来就没用，交给应用重载；
 * 本地 Shell 里 Ctrl+R 是它自己的反向历史搜索，得留给 shell。
 */
export function passAppShortcutsThrough(term, { includeReload = false } = {}) {
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    if (!isAppModifier(event) || event.shiftKey || event.altKey) return true
    if (/^[1-7]$/.test(event.key)) return false
    if (includeReload && String(event.key).toLowerCase() === 'r') return false
    return true
  })
}

/**
 * 适应容器尺寸，并且只在行列数真的变了才通知主进程 ——
 * 拖动窗口时 ResizeObserver 会逐帧触发，不设这道闸就会刷爆 IPC。
 */
export function fitAndSync(entry, send) {
  if (!entry?.fit) return
  const before = `${entry.term.cols}x${entry.term.rows}`
  try {
    entry.fit.fit()
  } catch {
    return
  }
  const after = `${entry.term.cols}x${entry.term.rows}`
  if (after !== before) send(entry.term.cols, entry.term.rows)
}
