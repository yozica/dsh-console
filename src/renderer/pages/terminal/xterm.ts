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

import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

import { copyToClipboard } from '../../utils/clipboard.js';
import { isAppModifier, isMac } from '../../utils/platform.js';
import type { ResolvedTheme } from '../../../shared/ipc';

/** 一个终端实例 + 它的 fit addon（页面自己保管，卸载时 dispose） */
export interface TerminalEntry {
  term: Terminal;
  fit: FitAddon;
}

/** 终端配色，与 styles.css 的两套主题对应 */
export const TERM_THEMES: Record<ResolvedTheme, Record<string, string>> = {
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
    white: '#d5dae3',
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
    white: '#57606a',
  },
};

/**
 * 等宽字体栈按平台给：终端里的字符宽度是 xterm 量出来的，
 * 用系统自带等宽字体最稳（避免随包分发的 webfont 迟到导致列宽算错），
 * 中日韩文字另外挂一个系统的中文兜底，否则 dsh 的中文输出会退化成方框。
 */
function monoStack(): string {
  return isMac.value
    ? 'Menlo, Monaco, "SF Mono", "PingFang SC", "IBM Plex Mono", monospace'
    : 'Consolas, "Cascadia Mono", "Microsoft YaHei", "IBM Plex Mono", monospace';
}

export function terminalOptions(resolved: ResolvedTheme): ITerminalOptions {
  return {
    fontFamily: monoStack(),
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: { ...(TERM_THEMES[resolved] || TERM_THEMES.dark) },
  };
}

/**
 * 把终端配色同步到容器元素的 CSS 变量上。
 *
 * 终端面板要"一整块连续的颜色"：容器的内边距、空状态覆盖层都得跟 xterm 自己的
 * 底色一致，否则会看到"终端是一块、留白是另一块"。颜色只在 TERM_THEMES 里定义一次，
 * 这里把它交给 CSS（`var(--term-bg)` / `var(--term-fg)`），不在样式表里再抄一遍。
 */
export function applyTerminalSurface(
  el: HTMLElement | null | undefined,
  resolved: ResolvedTheme,
): void {
  if (!el) return;
  const theme = TERM_THEMES[resolved] || TERM_THEMES.dark;
  el.style.setProperty('--term-bg', theme.background);
  el.style.setProperty('--term-fg', theme.foreground);
}

/** 建一个终端实例并打开在 host 上，返回 { term, fit } */
export function attachTerminal(host: HTMLElement, resolved: ResolvedTheme): TerminalEntry {
  applyTerminalSurface(host, resolved);
  const term = new Terminal(terminalOptions(resolved));
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(host);
  return { term, fit };
}

/**
 * 这一次按键该不该被当成"复制"（而不是发给终端的控制字符）。
 *
 * 单独做成纯函数是为了能被自检直接断言：判断依据只有两个 —— **平台**与**有没有选中文字**。
 * 两个都不要漏：
 *  - 没有选中时必须落回原语义（把 \x03 发下去），否则"用 Ctrl+C 停当前命令"这条路就没了。
 *  - macOS **一条都不拦**：那儿复制是 ⌘C（走原生菜单 + xterm 自己挂在元素上的 `copy` 监听），
 *    中断是 ⌃C —— 两个键本来就不冲突，我们插进去只会平白多一条"会吞按键"的路径
 *    （用户的裁定，2026-09-30）。所以这条里的平台判据，作用是**排除 mac**。
 *
 * 于是非 macOS 上只剩两个键位，都是有选中才成立：
 *  - `Ctrl+C`（Windows Terminal 这么做，VS Code 的 Windows 绑定 `copyAndClearSelection` 也是）；
 *  - `Ctrl+Shift+C`（GNOME 系终端的复制键位，VS Code 在 Win/Linux 上也是这个）。
 *
 * ⚠️ 复制之后必须把选中**清掉**（在 `passAppShortcutsThrough` 里做）：不清的话第二下 Ctrl+C
 * 还是命中这一条、还是复制 —— 于是"选中着还想中断"就永远中断不了。清掉之后是
 * **第一下复制、第二下 \x03**（VS Code 那条命令的名字就叫 Copy and Clear Selection）。
 */
export function shouldCopySelection(event: KeyboardEvent, hasSelection: boolean): boolean {
  if (event.type !== 'keydown' || !hasSelection) return false;
  // macOS：⌘C 复制、⌃C 中断，两个键不冲突 —— 一条都不拦，交回给原生与 xterm 自己
  if (isMac.value) return false;
  if (String(event.key).toLowerCase() !== 'c') return false;
  // AltGr 在 Windows 上是 Ctrl+Alt（Alt+Ctrl+字母是输符号的手势）；Win 键也不该当复制
  if (!event.ctrlKey || event.altKey || event.metaKey) return false;
  return true;
}

/**
 * 让应用级快捷键穿过终端。
 *
 * 不这么做的话，xterm 会把 Ctrl+2~8 / ⌘2~8 当成控制字符吃掉（^@、^[、^\、^]、^^、^_、^?）、
 * 并停止冒泡，window 上那个切换页面的处理器就永远收不到 ——
 * 症状是"在终端里只有 Ctrl+1 能切页，2~8 全都没反应"（Ctrl+1 恰好不在它的表里）。
 *
 * 用 xterm 的正式接口：处理函数返回 false = 终端不处理，事件继续冒泡给应用。
 * 修饰键按平台取（macOS 认 Cmd，其它平台认 Ctrl），与 app.ts 的处理器保持一致。
 * `includeReload` 用来决定 Ctrl+R / ⌘R 归谁：dsh 终端里输入本来就没用，交给应用重载；
 * 本地 Shell 里 Ctrl+R 是它自己的反向历史搜索，得留给 shell。
 *
 * `copyOnSelection` 打开后（**两条终端都开**，见下）多一条：**有选中文字时 Ctrl+C（或
 * Ctrl+Shift+C）变成复制**。macOS 上这一条不生效 —— 那儿的复制是 ⌘C，见 `shouldCopySelection`。
 * 复制走 `copyToClipboard`，它自己会说一句状态栏回话、失败也不抛。
 * 这里**不 await**：按键处理器必须是同步的，而复制是异步的 ——
 * 好在这条路径是用户手势的直接续写，剪贴板的写权限拿得到。
 *
 * ⚠️ 复制前先 `clearSelection()`。用户的裁定（2026-09-30："自建终端还是不支持复制"）是
 * **本地 Shell 也要能复制**，而它的 Ctrl+C 同时是"停当前命令" —— 两个语义只能靠"选中在不在"
 * 分开。所以命中时把选中清掉：第一下复制、第二下才是 \x03（Windows Terminal 就是这么分的，
 * 界面上不用教）。不清选中就等于"只要有选中，中断就永远按不出来"。
 *
 * 为什么是「选中即复制」而不是加个复制按钮：能复制的东西就是屏幕上那段文字，而用户为了复制
 * 已经在拖选了 —— 再让他把手移到工具栏点一下是多余的一步（用户的裁定）。
 */
export function passAppShortcutsThrough(
  term: Terminal,
  {
    includeReload = false,
    copyOnSelection = false,
  }: { includeReload?: boolean; copyOnSelection?: boolean } = {},
): void {
  term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    if (event.type !== 'keydown') return true;
    if (copyOnSelection && shouldCopySelection(event, term.hasSelection())) {
      const text = term.getSelection();
      // 顺序要紧：先取文字、再清选中、最后复制（清了选中之后 getSelection 就是空串了）
      term.clearSelection();
      void copyToClipboard(text);
      return false;
    }
    if (!isAppModifier(event) || event.shiftKey || event.altKey) return true;
    if (/^[1-7]$/.test(event.key)) return false;
    if (includeReload && String(event.key).toLowerCase() === 'r') return false;
    return true;
  });
}

/**
 * 适应容器尺寸，并且只在行列数真的变了才通知主进程 ——
 * 拖动窗口时 ResizeObserver 会逐帧触发，不设这道闸就会刷爆 IPC。
 */
export function fitAndSync(
  entry: TerminalEntry | null | undefined,
  send: (cols: number, rows: number) => void,
): void {
  if (!entry?.fit) return;
  const before = `${entry.term.cols}x${entry.term.rows}`;
  try {
    entry.fit.fit();
  } catch {
    return;
  }
  const after = `${entry.term.cols}x${entry.term.rows}`;
  if (after !== before) send(entry.term.cols, entry.term.rows);
}
