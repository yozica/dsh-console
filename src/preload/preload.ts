/**
 * contextBridge：把主进程能力暴露给渲染层，渲染层不直接碰 Node。
 *
 * 这里刻意标注成 DshConsoleApi（src/shared/ipc.ts）：preload 是那条 IPC 边界的
 * 唯一出口，形状写在这里就等于把"渲染层能用什么"固化下来 —— 漏写一个方法、
 * 或者参数顺序对不上，渲染层那边（Step 2 起）就是编译错误而不是运行时才发现。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type { DshConsoleApi } from '../shared/ipc';

/** 订阅工具：返回取消订阅函数 */
function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: DshConsoleApi = {
  // 快照 / 设置
  getSnapshot: () => ipcRenderer.invoke('app:snapshot'),
  patchSettings: (patch) => ipcRenderer.invoke('settings:patch', patch),

  // 主题
  setTheme: (mode) => ipcRenderer.invoke('theme:set', mode),
  onTheme: (handler) => subscribe('theme:changed', handler),

  // 系统窗口全屏状态（macOS 绿灯 / Windows F11）：全屏时红绿灯会自动隐藏，
  // 渲染层据此取消为它预留的空白
  onFullscreen: (handler) => subscribe('app:fullscreen', handler),

  // 主进程改了设置（目前只有关闭对话框的「记住我的选择」）：界面那份表单要跟着更新
  onSettings: (handler) => subscribe('settings:changed', handler),

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

  // 关闭确认：主进程问、渲染层答（卡片在渲染层，见 shell/CloseDialog.vue）
  // ack 是"卡片已经显示了"：主进程收到它才撤掉兜底时限，之后等用户慢慢选
  onCloseRequest: (handler) => subscribe('app:close-request', handler),
  ackClose: () => ipcRenderer.invoke('app:close-ack'),
  answerClose: (answer) => ipcRenderer.invoke('app:close-answer', answer),

  // 自动更新：状态由主进程推（app:update），这里只下命令
  checkForUpdates: () => ipcRenderer.invoke('app:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('app:update-download'),
  installUpdate: () => ipcRenderer.invoke('app:update-install'),
  onUpdateState: (handler) => subscribe('app:update', handler),

  // 归档会话管理
  archiveList: () => ipcRenderer.invoke('archive:list'),
  archiveRead: (id) => ipcRenderer.invoke('archive:read', id),
  archiveUnarchive: (id) => ipcRenderer.invoke('archive:unarchive', id),
  archiveRemove: (id) => ipcRenderer.invoke('archive:remove', id),

  // 插件装配层
  pluginInspect: () => ipcRenderer.invoke('plugin:inspect'),
  pluginRun: (request) => ipcRenderer.invoke('plugin:run', request),
  pluginCancel: () => ipcRenderer.invoke('plugin:cancel'),
  pluginEditLayer: (request) => ipcRenderer.invoke('plugin:edit-layer', request),
  pluginDefaultConfig: () => ipcRenderer.invoke('plugin:default-config'),
  pluginBundleEdit: (request) => ipcRenderer.invoke('plugin:bundle-edit', request),
  pluginRescue: (request) => ipcRenderer.invoke('plugin:rescue', request),

  // 运行环境自检 + 一键修复（报告靠 envCheck 拉，修复过程靠两条订阅推）
  envCheck: (options) => ipcRenderer.invoke('env:check', options || {}),
  envFix: (request) => ipcRenderer.invoke('env:fix', request),
  envFixCancel: () => ipcRenderer.invoke('env:fix-cancel'),
  onEnvFixState: (handler) => subscribe('env:fix-state', handler),
  onEnvFixOutput: (handler) => subscribe('env:fix-output', handler),

  // 首启环境向导（门禁）+ Node 安装 / 更新通道（见 docs/env-wizard-freeze.md §3.3）。
  // 门禁状态与安装状态都是"拉一份 + 订阅"：报告类的靠 invoke，过程类的靠事件。
  envWizard: (options) => ipcRenderer.invoke('env:wizard', options || {}),
  envWizardSkip: (request) => ipcRenderer.invoke('env:wizard-skip', request),
  envNodePlan: (request) => ipcRenderer.invoke('env:node-plan', request),
  envNodeInstall: (request) => ipcRenderer.invoke('env:node-install', request),
  envNodeStop: () => ipcRenderer.invoke('env:node-stop'),
  onEnvInstallState: (handler) => subscribe('env:install-state', handler),
  onEnvInstallOutput: (handler) => subscribe('env:install-output', handler),

  // 事件
  onState: (handler) => subscribe('dsh:state', handler),
  onOutput: (handler) => subscribe('dsh:output', handler),
  onDshExit: (handler) => subscribe('dsh:exit', handler),
  onLog: (handler) => subscribe('dsh:log', handler),
  onUiUrl: (handler) => subscribe('dsh:ui-url', handler),
  onSessionOutput: (handler) => subscribe('session:output', handler),
  onSessionExit: (handler) => subscribe('session:exit', handler),
  onPluginOutput: (handler) => subscribe('plugin:output', handler),
};

contextBridge.exposeInMainWorld('dshConsole', api);
