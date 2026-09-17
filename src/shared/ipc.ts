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
export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

// ---------------------------------------------------------------- 自动更新

/**
 * 自动更新的相位（主进程 updater.ts 是唯一写入方）。
 *
 * - `idle`：没有正在进行的动作（还没检查过，或已是最新版本）
 * - `checking`：正在请求更新元数据（latest.yml）
 * - `available`：发现了新版本，**等用户点「下载」**（我们不会自动下载）
 * - `downloading`：正在下载，percent 从 0 到 100
 * - `downloaded`：下载完成，**等用户点「重启并安装」**（退出时也不会偷偷装）
 * - `error`：任意一步失败，原因摘成一句中文放在 message 里
 * - `unsupported`：这个平台/运行形态用不了自动更新（macOS 的 ad-hoc 签名、开发态）
 */
export type UpdatePhase =
  'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | 'unsupported';

/** 自动更新的当前状态（app:update 事件、快照的 update 字段、设置页的更新卡片共用） */
export interface UpdateState {
  phase: UpdatePhase;
  /** 当前安装的版本（app.getVersion()） */
  currentVersion: string;
  /** 发现 / 已下载的新版本号；没有就是 null */
  version: string | null;
  /** 下载进度 0~100；只有 downloading 相位有意义 */
  percent: number | null;
  /** 给用户看的一句中文（错误原因也在这里，不是只写 console） */
  message: string | null;
  /** 这个运行形态能不能自动更新（macOS 与开发态为 false） */
  canAutoUpdate: boolean;
  /** 能不能检查有没有新版本：macOS 不能自动装、但**照样能查**（开发态为 false） */
  canCheck: boolean;
  /** 不能自动更新时的出路：Releases 页面 */
  releasesUrl: string;
}

/**
 * GitHub Releases 页面。与 package.json 的 build.publish（owner: yozica / repo: dsh-console）
 * 是同一处；主进程用它填 UpdateState.releasesUrl，渲染层用它做「打开下载页」的兜底。
 */
export const RELEASES_URL = 'https://github.com/yozica/dsh-console/releases';

/**
 * 版本检查用的更新源（GitHub 的 "latest" 别名指向最新一个**已发布**的 Release，
 * 草稿不算 —— 与 Windows 走 electron-updater 时读的是同一份 `latest-mac.yml`）。
 *
 * macOS 上装不了自动更新（ad-hoc 签名），但我们仍然想知道"有没有新版本"：
 * 主进程直接取这个小文件、比一下版本号就行，不引入 Squirrel 那套。
 * 与 `build.publish` 的 owner/repo 是同一处，自检会核对它们一致。
 */
export const UPDATE_MAC_FEED_URL =
  'https://github.com/yozica/dsh-console/releases/latest/download/latest-mac.yml';

export interface ThemeInfo {
  mode: ThemeMode;
  resolved: ResolvedTheme;
}

/** dsh 状态机的取值（与 main/dsh-manager.ts 的 PHASE 一一对应） */
export type DshPhase =
  'stopped' | 'starting' | 'running' | 'degraded' | 'stopping' | 'external' | 'conflict';

export type LogLevel = 'info' | 'warn' | 'error';

/** 事件日志的一条 */
export interface DshLogEntry {
  at: number;
  level: LogLevel;
  text: string;
}

/** 健康探测的最近一次结果 */
export interface DshProbeInfo {
  reachable: boolean;
  isDsh: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  checkedAt: number | null;
  error: string | null;
}

/** 端口占用者（界面显示"占用进程"用） */
export interface PortOwnerInfo {
  pid: number | null;
  name?: string;
  port?: number;
  local?: string;
}

/** 启动命令的描述（界面显示"将要执行什么"） */
export interface LaunchInfo {
  file: string;
  args: string[];
  display: string;
  /** custom / custom-shim / node-bin / shim / npx / error */
  kind: string;
  error?: string;
}

/** dsh 进程的完整状态快照（dsh:state 事件与快照的 dsh 字段） */
export interface DshSnapshot {
  phase: DshPhase;
  /** 本应用自己拉起的 dsh 是否在运行（界面一律用这个判断归属，别看 pid 的真假值） */
  owned: boolean;
  sessionAlive: boolean;
  /** 可能为 null：PTY 刚拉起、PID 还没就绪 */
  pid: number | null;
  startedAt: number | null;
  uptimeMs: number | null;
  lastExit: { code: number; signal: number | null; at: number } | null;
  lastError: string | null;
  host: string;
  port: number;
  origin: string;
  uiUrl: string | null;
  probe: DshProbeInfo;
  portOwner: PortOwnerInfo | null;
  externalPid: number | null;
  externalName: string;
  launch: LaunchInfo;
  latencyHistory: number[];
  logs: DshLogEntry[];
}

/**
 * 设置项的形状。**加设置项要动两处**：这里（契约）与 main/settings.ts 的 DEFAULTS（默认值）——
 * 两边不一致时 tsc 会直接报错，所以不会悄悄漂移。
 */
export interface SettingsValues {
  settingsVersion: number;
  host: string;
  port: number;
  dshCommand: string;
  cwd: string;
  extraArgs: string;
  shell: string;
  themeMode: ThemeMode;
  deepseekUrl: string;
  autoStart: boolean;
  openUiOnStart: boolean;
  uiFullscreenOnStart: boolean;
  killOnExit: boolean;
  /** 自动检查更新：启动后检查一次，之后每 6 小时一次（发现新版本仍要用户确认才下载） */
  autoCheckUpdates: boolean;
  pollIntervalMs: number;
  startTimeoutMs: number;
  stopGraceMs: number;
}

/** PTY 会话的元信息：dsh 终端与本地 Shell 共用（kind 区分） */
export interface SessionMeta {
  kind?: 'dsh' | 'shell' | string;
  /** 标签页标题（本地 Shell 可重命名） */
  label?: string;
  /** 启动命令，显示在标签提示里 */
  command?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}

/** 会话列表里的一项（快照的 sessions 字段） */
export interface SessionInfo {
  id: string;
  pid: number;
  createdAt: number;
  meta: SessionMeta;
}

/** 运行环境信息（快照的 env 字段） */
export interface EnvInfo {
  /** process.platform：darwin / win32 / linux */
  platform: string;
  /** 是否打包运行：渲染层据此决定装不装开发期诊断快捷键 */
  packaged: boolean;
  /** 应用自身版本 */
  app: string;
  /** 本次是不是"覆盖升级后第一次启动"（NSIS 会带 --updated） */
  updated: boolean;
  /** 系统窗口是否处于全屏（macOS 绿灯 / F11） */
  nativeFullscreen: boolean;
  versions: { electron: string; node: string; chrome: string };
}

/** app:snapshot 的返回值：渲染层启动时拉一次全量状态 */
export interface AppSnapshot {
  dsh: DshSnapshot;
  settings: SettingsValues;
  sessions: SessionInfo[];
  launch: LaunchInfo;
  env: EnvInfo;
  /**
   * 自动更新的当前状态。放进快照是因为它天生是"主进程先有、渲染层后连上"的：
   * macOS / 开发态在窗口加载前就已经是 unsupported，只靠 app:update 事件会丢。
   */
  update: UpdateState;
  userData: string;
  theme: ThemeInfo;
}

/** 渲染层要往 dsh 的 PTY 里写数据时的载荷 */
export interface DshOutputEvent {
  id: string;
  chunk: string;
}

/** dsh 进程退出（signal 是 node-pty 给的信号编号） */
export interface DshExitEvent {
  exitCode: number;
  signal?: number | null;
}

/** 本地 Shell 的输入输出与退出（会话 id 区分标签页） */
export interface SessionOutputEvent {
  id: string;
  chunk: string;
}

export interface SessionExitEvent {
  id: string;
  exitCode: number;
  signal?: number | null;
  meta?: SessionMeta;
}

/** 新建本地 Shell 的返回值 */
export interface CreateShellResult {
  ok: boolean;
  id?: string;
  label?: string;
  command?: string;
  error?: string;
}

/** 启动/停止/重启这类操作的统一回执 */
export interface DshActionResult {
  ok: boolean;
  state?: DshSnapshot;
  error?: string;
}

/** 重命名会话的返回值 */
export interface RenameSessionResult {
  ok: boolean;
  id?: string;
  label?: string;
  error?: string;
}

/** 确认对话框的载荷（主进程用 dialog.showMessageBox 呈现） */
export interface ConfirmRequest {
  type?: 'question' | 'warning' | 'info';
  title?: string;
  message?: string;
  detail?: string;
  buttons?: string[];
}

// ---------------------------------------------------------------- 归档会话页

/** DSH 数据目录的位置与可用性 */
export interface DshHomeInfo {
  home: string;
  exists: boolean;
}

/** 归档列表里的一条（标题/首句来自投影缓存，logSize 来自日志文件） */
export interface ArchivedSessionSummary {
  id: string;
  title: string;
  firstPrompt: string;
  lastPromptAt: number | null;
  createdAt: number | null;
  cwd: string | null;
  turnCount: number;
  logSize: number | null;
  logFile: string | null;
  /** 标题 + 首句 + 每轮问答拼成的检索文本（页面内搜索用） */
  searchBlob: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
  time: number | null;
}

/** 读取某个归档会话的对话全文 */
export interface ConversationReadResult {
  id: string;
  title: string;
  hasLog: boolean;
  messages: ConversationMessage[];
  truncated: boolean;
  eventCount?: number;
}

/** 取消归档：只改 workspace.json 的 archivedSessionIds */
export interface UnarchiveResult {
  id: string;
  /** dsh 在跑时磁盘改动要重启才反映到它的界面里，由调用方补上这个标记 */
  dshRunning?: boolean;
}

/** 删除归档会话（日志目录 + 投影缓存一起删） */
export interface RemoveArchivedResult {
  id: string;
  removedLogBytes: number;
  removedCache: boolean;
  dshRunning?: boolean;
}

/**
 * 归档这几个 IPC 统一用 `{ ok }` 包一层（失败时带上 error），
 * 于是渲染层不必区分"抛异常"和"业务失败"。
 */
export interface ArchiveListResult extends Partial<DshHomeInfo> {
  ok: boolean;
  error?: string;
  dshRunning?: boolean;
  sessions?: ArchivedSessionSummary[];
}

export interface ArchiveReadResult {
  ok: boolean;
  error?: string;
  session?: ConversationReadResult;
}

export interface ArchiveUnarchiveResult extends Partial<UnarchiveResult> {
  ok: boolean;
  error?: string;
}

export interface ArchiveRemoveResult extends Partial<RemoveArchivedResult> {
  ok: boolean;
  error?: string;
}

/**
 * preload 暴露给渲染层的 API（window.dshConsole）。
 * 渲染层写 `api.xxx()` 时能看到签名与返回类型，这是这次 TS 迁移最直接的收益。
 */
export interface DshConsoleApi {
  getSnapshot: () => Promise<AppSnapshot>;
  patchSettings: (patch: Partial<SettingsValues>) => Promise<SettingsValues>;

  setTheme: (mode: ThemeMode) => Promise<ThemeInfo>;
  onTheme: (handler: (info: ThemeInfo) => void) => () => void;
  onFullscreen: (handler: (on: boolean) => void) => () => void;

  start: () => Promise<DshActionResult>;
  stop: (options?: { force?: boolean; killExternal?: boolean }) => Promise<DshActionResult>;
  restart: () => Promise<DshActionResult>;

  dshInput: (data: string) => Promise<boolean>;
  dshResize: (cols: number, rows: number) => Promise<boolean>;
  dshReplay: () => Promise<string>;

  createShell: (cols: number, rows: number) => Promise<CreateShellResult>;
  sessionInput: (id: string, data: string) => Promise<boolean>;
  sessionResize: (id: string, cols: number, rows: number) => Promise<boolean>;
  sessionKill: (id: string) => Promise<boolean>;
  sessionRename: (id: string, label: string) => Promise<RenameSessionResult>;

  openExternal: (url?: string) => Promise<string>;
  revealUserData: () => Promise<string>;
  confirm: (payload: ConfirmRequest) => Promise<boolean>;

  // 自动更新：状态由主进程持有，渲染层只下命令 + 订阅（见 main/updater.ts）
  checkForUpdates: () => Promise<UpdateState>;
  downloadUpdate: () => Promise<UpdateState>;
  installUpdate: () => Promise<boolean>;
  onUpdateState: (handler: (state: UpdateState) => void) => () => void;

  // 归档会话管理
  archiveList: () => Promise<ArchiveListResult>;
  archiveRead: (id: string) => Promise<ArchiveReadResult>;
  archiveUnarchive: (id: string) => Promise<ArchiveUnarchiveResult>;
  archiveRemove: (id: string) => Promise<ArchiveRemoveResult>;

  onState: (handler: (snapshot: DshSnapshot) => void) => () => void;
  onOutput: (handler: (payload: DshOutputEvent) => void) => () => void;
  onDshExit: (handler: (payload: DshExitEvent) => void) => () => void;
  onLog: (handler: (entry: DshLogEntry) => void) => () => void;
  onUiUrl: (handler: (url: string) => void) => () => void;
  onSessionOutput: (handler: (payload: SessionOutputEvent) => void) => () => void;
  onSessionExit: (handler: (payload: SessionExitEvent) => void) => () => void;
}
