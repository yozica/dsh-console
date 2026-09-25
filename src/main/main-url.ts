/**
 * 外链：交给系统默认程序的**唯一**入口。t57 从 `main.ts` 拆出来。
 *
 * 为什么要单独有个函数（真机踩过：弹「DSH Console 出错了（未处理的 Promise 拒绝）」）：
 * `shell.openExternal` 返回的是 promise，系统里没有对应处理程序的 URL 会让它 reject；
 * 而这个调用原先写在 `setWindowOpenHandler` 里、用 `void` 丢掉返回值 —— reject 就没人接，
 * 变成未处理的 Promise 拒绝。内嵌的 DSH 界面里点一个 `dsh-resource:` 文件引用就够触发一次。
 *
 * 所以这里做两件事：scheme 不在白名单就只记一行日志（不打扰系统），在白名单里也**接住失败**。
 */

import { shell } from 'electron';

import type { LogLevel } from '../shared/ipc';

/** 交给系统默认程序打开的白名单：其余 scheme（DSH 自己的 `dsh-resource:` 文件引用、`vscode:` 之类）不往外抛 */
export const EXTERNAL_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export interface ExternalContext {
  /** 事件日志（主进程的 dshManager.log） */
  log: (level: LogLevel, text: string) => void;
}

export function createExternalOpener(ctx: ExternalContext): {
  openExternalSafely(url: string, from: string): Promise<boolean>;
} {
  /**
   * 打开外链：主窗口、内嵌页、渲染层 IPC 三处都走它。
   * `from` 只进日志（"来自主窗口 / 内嵌页 / 渲染层"），便于排查是谁点的。
   */
  async function openExternalSafely(url: string, from: string): Promise<boolean> {
    let scheme = '';
    try {
      scheme = new URL(url).protocol;
    } catch {
      // 不是合法 URL（裸路径之类）：当作不在白名单
    }
    if (!EXTERNAL_URL_SCHEMES.has(scheme)) {
      ctx.log('info', `不用系统程序打开（scheme ${scheme || '未知'}）：${url} — 来自${from}`);
      return false;
    }
    try {
      await shell.openExternal(url);
      return true;
    } catch (error) {
      ctx.log('error', `用系统默认程序打开失败：${url} — 来自${from}：${String(error)}`);
      return false;
    }
  }

  return { openExternalSafely };
}
