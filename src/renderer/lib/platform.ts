/**
 * 平台判定与平台相关文案（macOS 适配的核心小工具）。
 *
 * 渲染层需要按平台分叉的地方只有三类：
 *   1. 应用级快捷键用 Cmd（macOS）还是 Ctrl（其它平台）—— app.ts / xterm.ts 的处理器
 *   2. 顶栏要不要给左上角的红绿灯留位置 —— styles.css 认 html[data-platform]
 *   3. 界面上写给人看的快捷键提示与文案（⌘+1~9 / Ctrl+1~9）
 *
 * 判定来源有两处：
 *   - `navigator.userAgent`（同步，模块加载时就能用）—— 首帧样式不能等 IPC
 *   - 主进程快照里的 `env.platform`（权威）—— 快照到了再校准一次
 * 正常情况下两者一致；用 ref 是为了万一副进程环境特殊，界面能跟着更新。
 */

import { computed, ref } from 'vue';

const ua = typeof navigator === 'undefined' ? '' : String(navigator.userAgent || '');

function detectPlatform(): string {
  if (/Macintosh|Mac OS X/i.test(ua)) return 'darwin';
  if (/Windows/i.test(ua)) return 'win32';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return '';
}

export const platform = ref(detectPlatform());
export const isMac = computed(() => platform.value === 'darwin');

/** 用主进程的权威值校准（store 拿到快照后调用） */
export function setPlatform(next?: string): string {
  if (next && typeof next === 'string') platform.value = next;
  return platform.value;
}

/** 落到 <html data-platform>：styles.css 靠它给 macOS 的红绿灯留出让位空间 */
export function applyPlatformAttribute(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.platform = platform.value;
}

/** 应用级快捷键的修饰键是否按下（macOS 认 Cmd，其它平台认 Ctrl） */
export function isAppModifier(event: KeyboardEvent): boolean {
  return isMac.value ? Boolean(event.metaKey) : Boolean(event.ctrlKey);
}

/** 快捷键文案里的修饰键：⌘ / Ctrl */
export function modLabel(): string {
  return isMac.value ? '⌘' : 'Ctrl';
}

/** 拼一条快捷键提示，例如 ⌘+1~9 / Ctrl+1~9 */
export function shortcutLabel(key: string): string {
  return `${modLabel()}+${key}`;
}

// 模块加载即落地：首帧的顶栏留白不能等异步快照
applyPlatformAttribute();
