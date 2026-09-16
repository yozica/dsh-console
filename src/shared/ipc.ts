/**
 * 主进程 ↔ 渲染层之间的**契约类型**。
 *
 * 为什么单独一个目录：这些形状两边都要用（主进程产出、渲染层消费），
 * 放在任何一侧都会让另一侧为了一个类型去 import 主进程代码（渲染层会把 fs/path 拖进包里）。
 * 所以放在 shared/：只允许**类型**与纯常量，禁止 import 任何运行时依赖。
 *
 * 约定：这里描述的是"跨进程线缆上的形状"，不是内部实现细节 ——
 * 主进程内部的类型（比如进程树终止参数）就留在各自的模块里。
 */

/** 界面主题：mode 是用户选择，resolved 是实际生效的明暗 */
export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export interface ThemeInfo {
  mode: ThemeMode
  resolved: ResolvedTheme
}

/** dsh 状态机的取值（与 main/dsh-manager.ts 的 PHASE 一一对应） */
export type DshPhase =
  'stopped' | 'starting' | 'running' | 'degraded' | 'stopping' | 'external' | 'conflict'

export type LogLevel = 'info' | 'warn' | 'error'

/** 事件日志的一条 */
export interface DshLogEntry {
  at: number
  level: LogLevel
  text: string
}

/** 健康探测的最近一次结果 */
export interface DshProbeInfo {
  reachable: boolean
  isDsh: boolean
  statusCode: number | null
  latencyMs: number | null
  checkedAt: number | null
  error: string | null
}

/** 端口占用者（界面显示"占用进程"用） */
export interface PortOwnerInfo {
  pid: number | null
  name?: string
  port?: number
  local?: string
}

/** 启动命令的描述（界面显示"将要执行什么"） */
export interface LaunchInfo {
  file: string
  args: string[]
  display: string
  /** custom / custom-shim / node-bin / shim / npx / error */
  kind: string
  error?: string
}

/** dsh 进程的完整状态快照（dsh:state 事件与快照的 dsh 字段） */
export interface DshSnapshot {
  phase: DshPhase
  /** 本应用自己拉起的 dsh 是否在运行（界面一律用这个判断归属，别看 pid 的真假值） */
  owned: boolean
  sessionAlive: boolean
  /** 可能为 null：PTY 刚拉起、PID 还没就绪 */
  pid: number | null
  startedAt: number | null
  uptimeMs: number | null
  lastExit: { code: number; signal: number | null; at: number } | null
  lastError: string | null
  host: string
  port: number
  origin: string
  uiUrl: string | null
  probe: DshProbeInfo
  portOwner: PortOwnerInfo | null
  externalPid: number | null
  externalName: string
  launch: LaunchInfo
  latencyHistory: number[]
  logs: DshLogEntry[]
}

/**
 * 设置项的形状。**加设置项要动两处**：这里（契约）与 main/settings.ts 的 DEFAULTS（默认值）——
 * 两边不一致时 tsc 会直接报错，所以不会悄悄漂移。
 */
export interface SettingsValues {
  settingsVersion: number
  host: string
  port: number
  dshCommand: string
  cwd: string
  extraArgs: string
  shell: string
  themeMode: ThemeMode
  deepseekUrl: string
  autoStart: boolean
  openUiOnStart: boolean
  uiFullscreenOnStart: boolean
  killOnExit: boolean
  pollIntervalMs: number
  startTimeoutMs: number
  stopGraceMs: number
}

/** PTY 会话的元信息：dsh 终端与本地 Shell 共用（kind 区分） */
export interface SessionMeta {
  kind?: 'dsh' | 'shell' | string
  /** 标签页标题（本地 Shell 可重命名） */
  label?: string
  /** 启动命令，显示在标签提示里 */
  command?: string
  cwd?: string
  cols?: number
  rows?: number
}

/** 会话列表里的一项（快照的 sessions 字段） */
export interface SessionInfo {
  id: string
  pid: number
  createdAt: number
  meta: SessionMeta
}

/** 运行环境信息（快照的 env 字段） */
export interface EnvInfo {
  /** process.platform：darwin / win32 / linux */
  platform: string
  /** 是否打包运行：渲染层据此决定装不装开发期诊断快捷键 */
  packaged: boolean
  /** 应用自身版本 */
  app: string
  /** 本次是不是"覆盖升级后第一次启动"（NSIS 会带 --updated） */
  updated: boolean
  /** 系统窗口是否处于全屏（macOS 绿灯 / F11） */
  nativeFullscreen: boolean
  versions: { electron: string; node: string; chrome: string }
}

/** app:snapshot 的返回值：渲染层启动时拉一次全量状态 */
export interface AppSnapshot {
  dsh: DshSnapshot
  settings: SettingsValues
  sessions: SessionInfo[]
  launch: LaunchInfo
  env: EnvInfo
  userData: string
  theme: ThemeInfo
}

/** 渲染层要往 dsh 的 PTY 里写数据时的载荷 */
export interface DshOutputEvent {
  id: string
  chunk: string
}

/** dsh 进程退出（signal 是 node-pty 给的信号编号） */
export interface DshExitEvent {
  exitCode: number
  signal?: number | null
}

/** 本地 Shell 的输入输出与退出（会话 id 区分标签页） */
export interface SessionOutputEvent {
  id: string
  chunk: string
}

export interface SessionExitEvent {
  id: string
  exitCode: number
  signal?: number | null
  meta?: SessionMeta
}

/** 新建本地 Shell 的返回值 */
export interface CreateShellResult {
  ok: boolean
  id?: string
  label?: string
  command?: string
  error?: string
}

/** 启动/停止/重启这类操作的统一回执 */
export interface DshActionResult {
  ok: boolean
  state?: DshSnapshot
  error?: string
}

/** 重命名会话的返回值 */
export interface RenameSessionResult {
  ok: boolean
  id?: string
  label?: string
  error?: string
}

/** 确认对话框的载荷（主进程用 dialog.showMessageBox 呈现） */
export interface ConfirmRequest {
  type?: 'question' | 'warning' | 'info'
  title?: string
  message?: string
  detail?: string
  buttons?: string[]
}

/**
 * preload 暴露给渲染层的 API（window.dshConsole）。
 * 渲染层写 `api.xxx()` 时能看到签名与返回类型，这是这次 TS 迁移最直接的收益。
 */
export interface DshConsoleApi {
  getSnapshot: () => Promise<AppSnapshot>
  patchSettings: (patch: Partial<SettingsValues>) => Promise<SettingsValues>

  setTheme: (mode: ThemeMode) => Promise<ThemeInfo>
  onTheme: (handler: (info: ThemeInfo) => void) => () => void
  onFullscreen: (handler: (on: boolean) => void) => () => void

  start: () => Promise<DshActionResult>
  stop: (options?: { force?: boolean; killExternal?: boolean }) => Promise<DshActionResult>
  restart: () => Promise<DshActionResult>

  dshInput: (data: string) => Promise<boolean>
  dshResize: (cols: number, rows: number) => Promise<boolean>
  dshReplay: () => Promise<string>

  createShell: (cols: number, rows: number) => Promise<CreateShellResult>
  sessionInput: (id: string, data: string) => Promise<boolean>
  sessionResize: (id: string, cols: number, rows: number) => Promise<boolean>
  sessionKill: (id: string) => Promise<boolean>
  sessionRename: (id: string, label: string) => Promise<RenameSessionResult>

  openExternal: (url?: string) => Promise<string>
  revealUserData: () => Promise<string>
  confirm: (payload: ConfirmRequest) => Promise<boolean>

  onState: (handler: (snapshot: DshSnapshot) => void) => () => void
  onOutput: (handler: (payload: DshOutputEvent) => void) => () => void
  onDshExit: (handler: (payload: DshExitEvent) => void) => () => void
  onLog: (handler: (entry: DshLogEntry) => void) => () => void
  onUiUrl: (handler: (url: string) => void) => () => void
  onSessionOutput: (handler: (payload: SessionOutputEvent) => void) => () => void
  onSessionExit: (handler: (payload: SessionExitEvent) => void) => () => void
}
