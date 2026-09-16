/**
 * 渲染层的全局声明：把 preload 暴露的那份 API 挂到 window 上。
 *
 * 类型直接取自 src/shared/ipc.ts 的 DshConsoleApi —— 契约只此一份，
 * 主进程、preload、渲染层三边保持一致；漏写或改签名都会在这里编译失败。
 */

/// <reference types="vite/client" />

import type { DshConsoleApi } from '../shared/ipc';

declare global {
  interface Window {
    /** preload 通过 contextBridge 注入；dev 下若 preload 没加载，运行时会是 undefined */
    dshConsole: DshConsoleApi;
  }
}

export {};
