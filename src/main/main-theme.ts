/**
 * 主题与系统控件配色（窗口底色、标题栏浮层）。t56 从 `main.ts` 拆出来。
 *
 * 为什么这三件事在一起：它们都由"当前是明是暗"决定，而且**必须两边一致** —— 窗口底色
 * 与渲染层 CSS 的 `--bg` / `--ink` 是同一组值（主进程侧唯一的颜色重复处）；标题栏高度
 * 与渲染层的 `--bar-h` 对齐（否则系统按钮和顶栏错位）。
 *
 * 这一层不持有窗口：窗口是 `main.ts` 的可变单例，通过 `getWindow()` 取当前那一个。
 */

import { nativeTheme, type BrowserWindow } from 'electron';

import type { ResolvedTheme, ThemeInfo, ThemeMode } from '../shared/ipc';

const THEME_MODES = ['system', 'light', 'dark'] as const;

function isThemeMode(value: string): value is ThemeMode {
  return (THEME_MODES as readonly string[]).includes(value);
}

export interface ThemeContext {
  /** macOS 的红绿灯由系统画在左上角，没有 titleBarOverlay */
  isMac: boolean;
  /** 当前主窗口（可能是 null / 已销毁） */
  getWindow: () => BrowserWindow | null;
  /** 推给渲染层（`theme:changed`） */
  send: (channel: string, payload: unknown) => void;
  /** 设置里的 `themeMode` 原值（可能是任何东西：这一层负责收口） */
  getMode: () => unknown;
}

export interface ThemeTools {
  WINDOW_BG: Record<ResolvedTheme, string>;
  TITLEBAR_COLORS: Record<ResolvedTheme, { color: string; symbolColor: string }>;
  TITLEBAR_HEIGHT: number;
  themeInfo(): ThemeInfo;
  applyThemeSource(mode: unknown): ThemeMode;
  applyTitleBarOverlay(resolved: ResolvedTheme): void;
  broadcastTheme(): ThemeInfo;
}

export function createThemeTools(ctx: ThemeContext): ThemeTools {
  /**
   * 窗口底色与标题栏配色：与渲染层 CSS 的 --bg / --ink 保持一致。
   * （这是主进程侧唯一的颜色重复处 —— 窗口底色和系统控件浮层只能由主进程设置。）
   */
  const WINDOW_BG: Record<ResolvedTheme, string> = { dark: '#0a0c10', light: '#eef1f5' };
  const TITLEBAR_COLORS: Record<ResolvedTheme, { color: string; symbolColor: string }> = {
    dark: { color: '#0a0c10', symbolColor: '#e8eaf0' },
    light: { color: '#eef1f5', symbolColor: '#131a26' },
  };
  /** 标题栏高度：和渲染层的 --bar-h 对齐，否则系统控件会和顶栏错位 */
  const TITLEBAR_HEIGHT = 36;

  /** 当前主题：mode 是用户选择，resolved 是实际生效的明暗 */
  function themeInfo(): ThemeInfo {
    const mode = String(ctx.getMode() || 'system');
    return {
      mode: isThemeMode(mode) ? mode : 'system',
      resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    };
  }

  /** 把设置里的 mode 应用到 Electron（system 时交给系统决定） */
  function applyThemeSource(mode: unknown): ThemeMode {
    const text = String(mode);
    const next: ThemeMode = isThemeMode(text) ? text : 'system';
    if (nativeTheme.themeSource !== next) nativeTheme.themeSource = next;
    return next;
  }

  /**
   * 系统控件浮层的配色（最小化/最大化/关闭由 Windows 画在右上角，颜色得由我们给）。
   * 窗口不是用 titleBarOverlay 建的、或平台不支持时（macOS 用红绿灯，没有浮层），
   * 这里会抛异常，直接吞掉即可。
   */
  function applyTitleBarOverlay(resolved: ResolvedTheme): void {
    if (ctx.isMac) return; // macOS 的红绿灯由系统绘制在左上角，没有 titleBarOverlay
    const win = ctx.getWindow();
    if (!win || win.isDestroyed()) return;
    const colors = TITLEBAR_COLORS[resolved] || TITLEBAR_COLORS.dark;
    try {
      win.setTitleBarOverlay({ ...colors, height: TITLEBAR_HEIGHT });
    } catch {
      /* 没有启用 titleBarOverlay 时忽略 */
    }
  }

  function broadcastTheme(): ThemeInfo {
    const info = themeInfo();
    const win = ctx.getWindow();
    if (win && !win.isDestroyed()) {
      win.setBackgroundColor(WINDOW_BG[info.resolved]);
      applyTitleBarOverlay(info.resolved);
    }
    ctx.send('theme:changed', info);
    return info;
  }

  return {
    WINDOW_BG,
    TITLEBAR_COLORS,
    TITLEBAR_HEIGHT,
    themeInfo,
    applyThemeSource,
    applyTitleBarOverlay,
    broadcastTheme,
  };
}
