'use strict'

/**
 * contextBridge：把主进程能力暴露给渲染层，渲染层不直接碰 Node。
 */

const { contextBridge, ipcRenderer } = require('electron')

/** 订阅工具：返回取消订阅函数 */
function subscribe(channel, handler) {
  const listener = (_event, payload) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('dshConsole', {
  // 快照 / 设置
  getSnapshot: () => ipcRenderer.invoke('app:snapshot'),
  patchSettings: (patch) => ipcRenderer.invoke('settings:patch', patch),

  // 主题
  setTheme: (mode) => ipcRenderer.invoke('theme:set', mode),
  onTheme: (handler) => subscribe('theme:changed', handler),

  // 系统窗口全屏状态（macOS 绿灯 / Windows F11）：全屏时红绿灯会自动隐藏，
  // 渲染层据此取消为它预留的空白
  onFullscreen: (handler) => subscribe('app:fullscreen', handler),

  // dsh 进程控制
  start: () => ipcRenderer.invoke('dsh:start'),
  stop: (options) => ipcRenderer.invoke('dsh:stop', options || {}),
  restart: () => ipcRenderer.invoke('dsh:restart'),

  // dsh 终端
  dshInput: (data) => ipcRenderer.invoke('dsh:input', data),
  dshResize: (cols, rows) => ipcRenderer.invoke('dsh:resize', { cols, rows }),
  dshReplay: () => ipcRenderer.invoke('dsh:replay'),

  // 额外终端会话（本地 Shell）
  createShell: (cols, rows) => ipcRenderer.invoke('shell:create', { cols, rows }),
  sessionInput: (id, data) => ipcRenderer.invoke('session:input', { id, data }),
  sessionResize: (id, cols, rows) => ipcRenderer.invoke('session:resize', { id, cols, rows }),
  sessionKill: (id) => ipcRenderer.invoke('session:kill', id),
  sessionRename: (id, label) => ipcRenderer.invoke('session:rename', { id, label }),

  // 系统集成
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  revealUserData: () => ipcRenderer.invoke('app:revealUserData'),
  confirm: (payload) => ipcRenderer.invoke('app:confirm', payload),

  // 事件
  onState: (handler) => subscribe('dsh:state', handler),
  onOutput: (handler) => subscribe('dsh:output', handler),
  onDshExit: (handler) => subscribe('dsh:exit', handler),
  onLog: (handler) => subscribe('dsh:log', handler),
  onUiUrl: (handler) => subscribe('dsh:ui-url', handler),
  onSessionOutput: (handler) => subscribe('session:output', handler),
  onSessionExit: (handler) => subscribe('session:exit', handler)
})
