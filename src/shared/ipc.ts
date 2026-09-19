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

/**
 * 点窗口关闭（X）时的行为（macOS 不适用：那边关窗就是关窗，Dock 常驻）。
 *
 * - `ask`：问一次「收起到托盘 / 退出应用」，对话框里带「记住我的选择」—— 默认值；
 * - `tray`：直接收起到系统托盘，应用与本应用启动的 dsh 继续在后台运行；
 * - `quit`：直接退出应用，按 `killOnExit` 决定要不要一并停掉 dsh。
 */
export type CloseAction = 'ask' | 'tray' | 'quit';

/** 用户在关闭确认卡片上选了什么（`cancel` = 什么都不做，窗口留着） */
export type CloseAnswerAction = 'tray' | 'quit' | 'cancel';

/**
 * 关闭确认卡片要展示的**事实**（主进程给）。
 *
 * 界面只负责把这几项写成人话，不自己判断"哪个 dsh 会被停掉" —— 那要看进程归属，
 * 只有主进程知道（`owned` 一看 pty 会话是否存在，见 7.5）。
 */
export interface CloseRequest {
  /** 退出时会不会一并停掉本应用启动的 dsh（设置 `killOnExit`） */
  killOnExit: boolean;
  /** dsh 是不是本应用启动的：只有它会被 `killOnExit` 停掉 */
  owned: boolean;
  /** dsh 的 PID；可能还没就绪（PTY 异步） */
  pid: number | null;
  /** dsh 当前相位：界面据此写"没在运行"那句话 */
  phase: DshPhase;
}

/** 渲染层对关闭询问的回答 */
export interface CloseAnswer {
  action: CloseAnswerAction;
  /** 勾了「记住我的选择」：主进程把它写回 `closeAction`，以后不再问 */
  remember: boolean;
}

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
  /** 点窗口关闭（X）时的行为；对话框里勾了「记住我的选择」也会写回这里（见 CloseAction） */
  closeAction: CloseAction;
  /**
   * 内部标记（**不是给用户调的**，设置页里没有控件）：这台机器上是否已经弹过
   * 「已收起到托盘」的气泡。持久化是必须的 —— 只记在内存里的话每次开应用都会再提示一遍。
   */
  trayHintShown: boolean;
  /**
   * 插件装/卸/升级用的 npm registry；留空则跟随系统 npm 配置。
   * 只注入给 `dsh plugin` 那一次子进程（`npm_config_registry`），**不写用户的 .npmrc**。
   */
  pluginRegistry: string;
  /** 自动检查更新：启动后检查一次，之后每 6 小时一次（发现新版本仍要用户确认才下载） */
  autoCheckUpdates: boolean;
  /**
   * 用户明确跳过的引导步骤（只可能是可跳过的那些）。内部标记，设置页没有控件；
   * 恢复入口在被跳过的那一行上（见 docs/env-wizard-interaction.md 5.4）。
   */
  envSkips: EnvWizardStepId[];
  /**
   * Node / 版本管理器安装包的下载基地址；留空 = 官方直连。
   * 只认 http(s)（写错当没填），只影响我们这一次下载，不写任何用户配置文件。
   */
  envNodeSource: string;
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
 * 插件页：**装配层**的只读视图（装了什么 bundle、层序如何、生效配置长什么样）。
 *
 * 与 dsh 自己界面里的「设置 → 插件」分工不同，别混：
 *   - 那边管**运行层**：已挂载条目的清单与它们的设置项（需要插件注册 settings 命名空间）。
 *   - 这边管**装配层**：profile 的 bundle 层栈、每个 bundle 的版本与来源、
 *     你的 patch 层、以及"没报错的错"（未匹配的 patch 行等）。
 * 这里全部来自磁盘上的 profile + `dsh web --dump-config`，不依赖 dsh 是否在跑
 * ——插件把启动打挂时，恰恰只有这份数据还能看。
 */

/** 层栈里的一层：内置 bundle / 树外 bundle / profile patch / 机器级 patch */
export interface PluginLayer {
  /** in-box=随 dsh 安装目录解析 | out-of-tree=pnpm 装进 profile 的 | profile-patch / home-patch=你自己的 tweak 层 */
  kind: 'in-box' | 'out-of-tree' | 'profile-patch' | 'home-patch';
  /** 包名或文件路径（原样，界面按 kind 决定怎么显示） */
  name: string;
  version: string | null;
  /** 从磁盘上解析到的位置；解析不到为 null（不看真假值，看它是不是 null） */
  resolvedPath: string | null;
  /** pnpm 的 spec（`link:../x`、`github:you/x#sha`…）；内置层为 null */
  spec: string | null;
  /** 在 `dsh.profile.bundles` 里的序号（从 1 开始）；patch 层没有序号 */
  order: number | null;
  /** 有没有在生效配置里出现（false = 它在层栈里但什么都没贡献） */
  present: boolean;
  /** 这一层干了什么：插入多少条、覆盖多少条、其中多少条是把下层关掉 */
  contributions: {
    inserted: number;
    insertedDisabled: number;
    patched: number;
    patchedDisabled: number;
  };
}

/** 生效配置里的一条 */
export interface PluginEntry {
  id: string;
  name: string;
  disabled: boolean;
  hasConfig: boolean;
}

/** 生效配置按源层分组后的一段（dump 本身就是这么标注的） */
export interface PluginTreeLayer {
  /** dump 里的原始标签（含 `patched by`），用于展示真实来源 */
  label: string;
  source: string;
  patchedBy: string | null;
  entries: PluginEntry[];
}

/** "没报错的错"：这些不会让命令失败，但会让用户的改动悄悄不生效 */
export interface PluginProblem {
  kind: 'unmatched-patch' | 'parse-error' | 'plain-dependency' | 'missing-layer' | 'other';
  /** 人类可读的一句话（已经是我们归纳过的说法） */
  detail: string;
  /** 涉及的文件（patch 层文件） */
  file?: string;
  /** unmatched-patch：指向了哪个不存在的 id */
  entryId?: string;
  /** parse-error：dsh 报的层标签（overlay / bundle 名） */
  layer?: string;
  /** plain-dependency：装进来却不形成层的那个包名（界面据此给「卸掉它」） */
  packageName?: string;
  /**
   * unmatched-patch：这一条所在的文件**是不是本页能改的那份**（profile 的
   * `cordis.patch.yml`）。机器级的 `$DSH_HOME/cordis.patch.yml` 不在本页的能力范围里 ——
   * 界面据此决定给不给「删掉这一行」，不给时要说明文件在哪。
   */
  editable?: boolean;
}

/** 运行中的 Loader 条目的 fiber 阶段（null = 没有存活的根 fiber，多半是被禁用/被覆盖了） */
export type PluginFiberPhase = 'pending' | 'active' | 'loading' | 'failed' | 'unloading' | null;

/**
 * 运行中的一条（来自 dsh 的 pluginInventory/list 接口，不是配置文件）。
 * entryId 带 `include:` 前缀（根 include 加载进来的），与配置里的 id 对照时要去掉。
 */
export interface PluginLiveEntry {
  entryId: string;
  moduleName: string;
  enabled: boolean;
  fiberPhase: PluginFiberPhase;
}

/** 每个 Agent 预设会给会话挂多少行（Harness 里那个「会话插件 N 个」就是这个） */
export interface PluginLivePreset {
  id: string;
  name: string | null;
  isDefault: boolean;
  broken: string | null;
  rows: number;
}

/** 装 / 卸 / 升级：add = 安装，remove = 卸载，update = 升级 */
export type PluginOpAction = 'add' | 'remove' | 'update';

/**
 * 一次插件操作的结果。
 * code 是 dsh 的退出码；summary 是我们把 pnpm 输出归纳成的一句人话（认不出来就没有，
 * 界面显示原始输出），error 是连命令都没跑起来时（例如已经有一个操作在跑）的原因。
 */
export interface PluginOpResult {
  ok: boolean;
  code?: number | null;
  error?: string;
  summary?: string | null;
  /**
   * 这个包是随 dsh 装好的内置包、**而且你还没启用它**时给出来：界面据此在现场给一个
   * 「插进我的层」按钮（而不是让用户自己去翻 cordis.patch.yml）。
   */
  needsEnable?: { id: string; name: string };
}

/** 改「你自己的补丁层」的四个动作：插入 / 禁用 / 启用 / 移除自己的插入 */
/** 涉及 patch 层的改动动作。`drop` = 删掉一条指向了不存在 id 的条目（巡检给的出路） */
export type PluginLayerEditAction = 'disable' | 'enable' | 'insert' | 'remove-insert' | 'drop';

/** 改完的结果：是否落盘、改了哪个文件、备份到哪、改完的原文 */
export interface PluginLayerEditResult {
  ok: boolean;
  error?: string;
  changed?: boolean;
  /** 一句人话：做了什么 / 为什么没做（界面直接显示） */
  detail?: string;
  file?: string;
  backup?: string | null;
  content?: string;
}

/** 装/卸/升级时边跑边推的输出片段（界面把它们原样贴进输出区） */
export interface PluginOutputEvent {
  chunk: string;
}

/** 运行中的清单。只有 dsh 由本应用启动（手上有令牌）时才拿得到；拿不到就是 null + 一句原因。 */
export interface PluginLiveSnapshot {
  entries: PluginLiveEntry[];
  presets: PluginLivePreset[];
  counts: { total: number; active: number; failed: number; idle: number };
}

export interface PluginInspectResult {
  ok: boolean;
  error?: string;
  /** 恒为 'web'：console 启动的就是 `dsh web`（= `--profile web`） */
  profile?: string;
  home?: string;
  profileDir?: string;
  /** profile 的 package.json 里的 name，例如 dsh-profile-web */
  profileName?: string | null;
  /** live = 改 patch 即时生效；startup = 只在启动时应用；null = 老 profile 的历史默认 */
  patchReload?: string | null;
  /** 按**应用顺序**排列：先应用的在前，所以越靠后越优先 */
  layers?: PluginLayer[];
  treeLayers?: PluginTreeLayer[];
  problems?: PluginProblem[];
  entryCount?: number;
  /** 页面会跑的命令（给人看"这些数字是怎么来的"） */
  commands?: string[];
  /** 解析不出结构时的原文（界面降级为纯文本，而不是显示空白） */
  rawDump?: string | null;
  /** 运行中的清单；拿不到时是 null（看 liveError 的原因），页面退回纯静态视图 */
  live?: PluginLiveSnapshot | null;
  liveError?: string;
  /** 装/卸/升级要 pnpm；`dsh plugin` 内部是裸 spawn('pnpm')，所以这里先把结论告诉界面 */
  pnpm?: { found: boolean; path: string | null };
  /** 本次装/卸/升级实际走的源（设置里留空时为 null，含义是"跟随系统 npm 配置"） */
  registry?: string | null;
  /**
   * profile 的 bundle 列表（带"是不是内置"）。**`ok: false` 时也给** —— dump 读不出来
   * （比如某个 bundle 解析不到、dsh 因此起不来）时，救援条只能靠它点名"可以停用哪个"。
   * 内置包不能停用（那是 dsh 自己的骨架），所以这里就把 `inBox` 标出来。
   */
  bundles?: { name: string; inBox: boolean }[];
  /**
   * true = 这份结果来自 `--dump-default-config`（dsh 自带的组合，**不含你的层**）。
   * 配置被改坏时的救援视图，界面上必须写明"这不是你现在真正生效的配置"。
   */
  baseline?: boolean;
}

/** 补丁层的备份（救援时可以从这里恢复） */
export interface PluginPatchBackup {
  name: string;
  path: string;
  /** 修改时间（毫秒） */
  at: number;
  bytes: number;
}

/** 救援结果：修成空配置 / 列备份 / 从备份恢复，三种动作共用 */
export interface PluginRescueResult {
  ok: boolean;
  error?: string;
  changed?: boolean;
  detail?: string;
  file?: string;
  backup?: string | null;
  content?: string;
  /** 只有 list-backups 会带 */
  backups?: PluginPatchBackup[];
}

/** 救援动作：把一个 bundle 从 `dsh.profile.bundles` 里摘掉 / 放回原位 */
export interface PluginBundleEditResult {
  ok: boolean;
  error?: string;
  changed?: boolean;
  detail?: string;
  file?: string;
  backup?: string | null;
  /** 它原来的位置（0 起）：恢复时要带回来，否则层序会被改掉 */
  index?: number;
}

// ---------------------------------------------------------------- 运行环境自检

/**
 * 单项自检的结论。
 *
 * - `ok`：满足，不需要用户做任何事；
 * - `warn`：能用，但有隐患或者这一轮没法确定（例如运行环境不允许起子进程）；
 * - `missing`：不满足，且某项功能因此不可用（没 pnpm → 插件装卸用不了）。
 *
 * 红黄两色由界面按这个字段决定，**不要**让界面去解析 detail 那串人话。
 */
export type EnvCheckStatus = 'ok' | 'warn' | 'missing';

/**
 * 自检项 id。这个联合类型同时也是**界面顺序**：主进程按它产出 checks，
 * 界面按数组顺序渲染。渲染层的标题映射写成 `Record<EnvCheckId, string>`，
 * 于是漏一个 id 就是 tsc 报错，不会出现"多了一项没人认识"。
 *
 * - `node`            外部 Node 可执行文件找不找得到
 * - `node-version`    它的版本满不满足我们声明的下限（`^20.19.0 || >=22.12.0`）
 * - `npm`             npm 能不能用（下面两个一键修复都要它）
 * - `pnpm`            pnpm 能不能用（插件装/卸/升级要它）
 * - `dsh`             dsh 本体（自定义命令 / node+bin.js / shim / npx）能不能定位
 * - `dsh-run`         实测 `dsh --version` 有没有输出（版本不兼容时它是静默退出）
 * - `bundled-runtime` 应用自带的 Electron / Node
 * - `shell`           本地 Shell 可执行文件
 */
export type EnvCheckId =
  'node' | 'node-version' | 'npm' | 'pnpm' | 'dsh' | 'dsh-run' | 'bundled-runtime' | 'shell';

/**
 * 一键修复能做的事。**只有这两个**，而且都只改全局 npm 包：
 * - `install-pnpm`：`npm i -g pnpm`（插件页缺 pnpm 时也走这一条）
 * - `install-dsh`：`npm i -g @deepseek-ai/dsh`
 *
 * 这两个动作**不**装 Node、不改 PATH、不写 .npmrc、不主动提权。
 * 装 Node 走独立通道 `envNodeInstall`（见 docs/env-wizard-freeze.md §3.2）：
 * 它不是 npm 包，而且"开始之后不杀"的停止语义与这里相反
 * （见 `EnvInstallState.cancellable` / `detached`）。
 */
export type EnvFixAction = 'install-pnpm' | 'install-dsh';

/** 一项自检的结论（界面一行） */
export interface EnvCheck {
  id: EnvCheckId;
  status: EnvCheckStatus;
  /** 判定依据的一句人话，带事实（路径 / 版本 / 阈值 / 为什么），界面直接显示 */
  detail: string;
  /** 用户能自己执行的命令或步骤；没有可执行建议时为 null */
  fixHint: string | null;
  /** 能替用户做的一键修复动作；null = 只能照 fixHint 自己来 */
  fixAction: EnvFixAction | null;
}

/**
 * 一键修复的**计划**：命令原文 + 会改到哪里。
 * 界面拿它做确认区的文案（不自己拼命令——渲染层不编命令，同 7.18 的原则）。
 *
 * `file` / `args` 是**给人看的**：`envFix` 只接受 action，真正 spawn 的 argv
 * 由主进程用 `envFixPlan()` + `npmLaunchSpec()` 现场重算，
 * 绝不使用渲染层递回来的这两个字段。
 */
export interface EnvFixPlan {
  action: EnvFixAction;
  /** 命令原文，例如 `C:\Program Files\nodejs\npm.cmd i -g pnpm` */
  display: string;
  file: string;
  args: string[];
  /** 会装进哪个全局目录（`npm prefix -g` 的结果）；取不到时为 null */
  target: string | null;
  /** 确认区里那句风险说明（会修改系统上的全局 npm 包、需要联网） */
  note: string;
}

/** 一轮自检的报告（`envCheck` 的返回值、`EnvFixState.report` 共用） */
export interface EnvDoctorReport {
  /** 检查时刻（毫秒）：界面显示"上次检查 x 分钟前"，判定函数不自己看时钟 */
  checkedAt: number;
  /** 固定八项，数组顺序就是界面顺序 */
  checks: EnvCheck[];
  /** 三种状态的个数（界面顶部的统计直接用它，不再数一遍） */
  counts: { ok: number; warn: number; missing: number };
  /** 最值得先处理的那一项：missing 优先于 warn，同级按 checks 顺序；全 ok 时为 null */
  firstProblemId: EnvCheckId | null;
  /** 这次探测用的版本区间原文（写清"要求是怎么来的"） */
  nodeRange: string;
  /** 一键修复可用的动作；npm 找不到时为空数组（起不了子进程就别给按钮） */
  plans: EnvFixPlan[];
  /** 探测本身出了意外（不是"某项不满足"，而是这一轮没测全）时的原因 */
  error: string | null;
}

/** 一键修复的相位。一次只跑一个动作，与插件操作同构（可中断）。 */
export type EnvFixPhase = 'idle' | 'running' | 'done' | 'cancelled' | 'error';

/** 一键修复的当前状态（envFix 的返回值、env:fix-state 事件共用） */
export interface EnvFixState {
  phase: EnvFixPhase;
  /** 正在跑的（或刚跑完的）动作；idle 时为 null */
  action: EnvFixAction | null;
  /** 将要执行 / 已执行的命令原文（确认前就显示它） */
  command: string | null;
  /** 收尾的一句人话（成功 / 被中断 / 失败原因） */
  message: string | null;
  /** 退出码；没跑起来时为 null */
  code: number | null;
  /** 跑完自动复检的结论；还没复检时为 null */
  report: EnvDoctorReport | null;
}

/** 一键修复边跑边推的输出片段（界面原样贴进输出区，与 plugin:output 同一套做法） */
export interface EnvFixOutputEvent {
  chunk: string;
}

// ---------------------------------------------------------------- 首启环境向导（门禁）

/** 引导步骤的 id。数组顺序 = 界面顺序 = 用户要走的顺序 */
export type EnvWizardStepId = 'node' | 'pnpm' | 'dsh';

/** 一个步骤的状态：`unknown` = 这一轮测不出来（不是用户缺东西） */
export type EnvStepStatus = 'done' | 'todo' | 'skipped' | 'unknown';

/** 门禁三态。`unknown` 也允许进入（见 docs/env-wizard.md 4.3） */
export type EnvGateState = 'open' | 'blocked' | 'unknown';

/** 一步引导的结论（界面按数组顺序渲染） */
export interface EnvWizardStep {
  id: EnvWizardStepId;
  status: EnvStepStatus;
  /** 判据那句话（人话，带事实：路径 / 版本 / 为什么），界面直接显示 */
  detail: string;
  /** 这一步用到了哪几项既有自检（界面用它做「展开看详情」） */
  checkIds: EnvCheckId[];
  /** 能不能跳过。`node` / `dsh` 恒为 false，界面据此不给「跳过」按钮 */
  skippable: boolean;
  /** 能不能用既有的两个 npm 动作替用户做（`node` 恒为 null：它走安装通道） */
  fixAction: EnvFixAction | null;
}

/**
 * 门禁的完整状态（`envWizard` 的返回值）。
 *
 * 判定规则见 docs/env-wizard-freeze.md §2.2：步骤状态 → 门禁三态 → 当前步骤。
 * 界面**不自己判**，只读这里的结论。
 */
export interface EnvWizardState {
  /** 步骤判据读的那份报告（就是阶段一的报告，不复制一份） */
  report: EnvDoctorReport;
  steps: EnvWizardStep[];
  gate: EnvGateState;
  /**
   * 当前步骤：第一个 `todo`；没有 `todo` 时是第一个 `unknown`；都没有时为 null。
   * 门禁为 `blocked` 时它一定是 `todo`，所以界面上永远有可做的动作。
   */
  currentStepId: EnvWizardStepId | null;
  /** 为什么是这个门禁状态（blocked / unknown 时非空，open 时为 null） */
  gateReason: string | null;
  /** 用户已经跳过的步骤（只可能是可跳过的那些；不可跳过的 id 会被判定忽略） */
  skips: EnvWizardStepId[];
}

// ---------------------------------------------------------------- Node 安装 / 更新通道

/** 装 / 更新 Node 的两条路 */
export type EnvNodeMethod = 'direct' | 'nvm';

/** 第一次装还是更新：只影响前置（更新会先停掉本应用启动的 dsh）与文案 */
export type EnvNodeMode = 'install' | 'update';

/** 版本档：默认 `lts`（最新稳定版），可切到 `current`（最新当前版） */
export type EnvNodeChannel = 'lts' | 'current';

/**
 * **发布元数据的**签名自述（不是读文件得到的结论，见 R-27）：
 * - `signed` / `unsigned`：发布说明或资产元数据**明确自述**了这个构建的签名状态；
 * - `unknown`：没有这种自述 / 认不出来 —— **官方直装恒为 `unknown`**，nvm 认不出来也是它。
 * 计划阶段的未签名确认**只**由 `unsigned` 触发；`unknown` 一律不出现任何签名断言。
 */
export type EnvReleaseSigning = 'signed' | 'unsigned' | 'unknown';

/**
 * 安装通道的相位。与 `EnvFixPhase` 分开：多了下载与校验，
 * 而且 `installing` 之后的"停止"语义相反（只停止等待，不杀安装器）。
 */
export type EnvInstallPhase =
  | 'idle'
  | 'preparing'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'waiting'
  | 'rechecking'
  | 'done'
  | 'cancelled'
  | 'error';

/** 一次安装 / 更新的计划：确认区要显示的全部事实（渲染层不自己拼、不自己猜） */
export interface EnvNodePlan {
  method: EnvNodeMethod;
  mode: EnvNodeMode;
  channel: EnvNodeChannel;
  /** 目标 Node 版本（来自官方版本清单的**具体**版本号） */
  version: string;
  /** 这次要下载的东西的完整地址（direct = Node 安装包；nvm = 版本管理器的安装包） */
  url: string;
  /** 下载来源的主机名（正文显示主机名，完整地址放详情） */
  sourceHost: string;
  /** 期望的 sha256（Node 来自同版本 SHASUMS256.txt；nvm 来自发布资产的 digest）。
   *  取不到时为 null，**行为按路径分**（R-25 / R-27 第 4 条）：
   *  - 官方直装：拿不到清单 = 判不了架构存在性也校验不了 → 不给「开始」（**没有**"仍然继续"）；
   *  - nvm 旧发布线（1.2.x 的资产 digest 是 none）：**正常情形** → 走「这次没能校验安装包的完整性」
   *    确认（换一个下载源再试是默认焦点 / 仍然继续）。**不许**用 `.checksum.txt` 去猜 exe 的哈希 */
  sha256: string | null;
  /** 校验依据的人话（例如"官方发布的校验清单"） */
  evidence: string;
  /** **发布元数据的**签名自述（R-27）。官方直装恒为 `'unknown'`；
   *  计划阶段的未签名确认**只**由 `'unsigned'` 触发，`'signed'` / `'unknown'` 一律不出现签名断言 */
  releaseSigning: EnvReleaseSigning;
  /** 安装包签名者。**计划阶段恒为 null，语义是"尚未读取"**（Authenticode 要读文件才拿得到，见 R-26）：
   *  计划阶段不许据此说"没有数字签名"、也不许因此多一次确认；下载后读到有效签名才填发行方名字。
   *  「发布元数据自述未签名」不走这个字段 —— 它是 `releaseSigning`（R-27） */
  signer: string | null;
  /** 这条路径现在能不能走。`false` 的六种情形（完整清单见 `plan()` 的注释）：
   *  官方直装 —— 认不出架构 / 版本号、**校验清单取不到（网络类）**、清单里没有这台机器架构的 msi；
   *  版本管理器 —— 提权态（R-23）、**发布信息取不到（网络类，含匿名限流）**、发布里没有适合的架构。
   *  网络类**不许**被说成"这台机器不支持"；`usable: false` 时 `url` 的语义见 `plan()` 的注释 */
  usable: boolean;
  /** 不能走的原因（给用户看的一句人话）；`usable` 为 true 时为 null */
  refuseReason: string | null;
  needsElevation: boolean;
  /** 会不会动到正在运行的 dsh（`mode === 'update'` 时为 true） */
  affectsRunningDsh: boolean;
  /** 命令原文或安装包名（确认区显示） */
  display: string;
  /** 会装到哪里（人话）；取不到时 null */
  target: string | null;
  /** 确认区里的风险说明（会改什么、要联网、会弹一次提权询问） */
  note: string;
}

/** 一次安装 / 更新的当前状态（`envNodeInstall` 的返回值、`env:install-state` 事件共用） */
export interface EnvInstallState {
  phase: EnvInstallPhase;
  /** 正在跑（或刚跑完）的是哪条路 / 哪个模式；idle 时为 null */
  method: EnvNodeMethod | null;
  mode: EnvNodeMode | null;
  /** 下载进度 0~100；算不出来时 null（界面不画进度条） */
  percent: number | null;
  /** 已下载 / 总字节；任一未知时 null（界面整行不出现） */
  bytes: { downloaded: number; total: number } | null;
  /** 现在还能不能"停止"：下载 / 校验为 true；安装 / 等待之后为 false */
  cancellable: boolean;
  /**
   * 我们已经不再等待，但安装可能还在后台进行。
   * true 时：界面给"未确定"结论、互斥锁**仍然持有**，直到复检证明落地 /
   * 用户点「我确认安装已经结束」/ 应用重启。
   */
  detached: boolean;
  /** 一句人话（进行中 / 收尾结论 / 失败原因） */
  message: string | null;
  /** 安装器或子进程的退出码；没跑起来时 null */
  code: number | null;
  /** 跑完自动复检的结论；还没复检时 null */
  report: EnvDoctorReport | null;
}

/** 安装过程的输出片段（界面原样贴进输出区，与 `env:fix-output` 同一套做法） */
export interface EnvInstallOutputEvent {
  chunk: string;
}

// ---------------------------------------------------------------- t29 增量：归属（VM-14）与档位（VM-15）

/**
 * 冻结文档 §3.2.1 是这一段 t29 增量的权威文本（需求 §11.2.1 与它逐字对齐）。
 *
 * **为什么写成"同名接口再声明一次"而不是改上面那些接口**：自检「契约（F-03）」把冻结 §3.1~§3.4
 * 的逐字 ts 块与本文逐字比对（`includes`），上面那几段必须原样保留 —— t29 的增量在冻结里也是
 * 写成"既有字段一个不动 + 这一段"。同一模块里同名 `interface` 是**合并声明**：消费方
 * （主进程 / preload / 渲染层）看到的是合并后的完整形状，运行期只是多两个字段。
 */

/**
 * 「当前这份 Node 是谁管的」。判据与证据见 `docs/env-wizard.md` §7.7 —— 判据只有一份、是纯函数、可离线测。
 * - `nvm`：落在版本管理器（nvm-windows）的目录下 —— v2 的 `<root>\installs\<版本>` 与 `<root>\.nodejs`（shim）、
 *   v1 的 `NVM_SYMLINK` / `NVM_HOME`，或路径里那条**独立**的 `nvm` / `nvm4w` 目录名（`D:\nvm-tools\node.exe` 不算）；
 * - `system`：**有正面证据**说明它是官方安装包装的那一份 —— 落在官方默认安装位
 *   （`%ProgramFiles%\nodejs`、`%ProgramFiles(x86)%\nodejs`，变量读不到时 `C:\Program Files\nodejs`），
 *   或落在官方安装包自己写下的安装目录里（`HKLM\SOFTWARE\Node.js` 的 `InstallPath`，读得到时才算）；
 * - `unknown`：**其余全部** —— 没找到 Node / 找到但认不出归谁 / 归别的版本管理器（volta / fnm / nvs / nodist / scoop）。
 *   **故意不是"剩下的一律当系统装的"**：那正是 VM-14（在版本管理器管的机器上按"系统装的"去装一份官方 MSI）。
 */
export type EnvNodeOwner = 'nvm' | 'system' | 'unknown';

/** `EnvDoctorReport` 增量（采集侧给事实，判定函数只搬运 —— `judgeEnvironment` 仍然是纯函数） */
export interface EnvDoctorReport {
  /** 这份 Node 是谁管的（§7.7）。界面据此决定「更新」走哪条路、能不能自动更新 */
  nodeOwner: EnvNodeOwner;
  /** 归属判定的证据（人话，逐条：用了哪条路径 / 哪个变量 / 模型的哪条结论）；没有证据时是空数组。
   *  进日志，也进确认区的「详情」—— 评审时能对账"为什么是这一条" */
  nodeOwnerEvidence: string[];
}

/** `EnvNodePlan` 增量（既有字段一个不动） */
export interface EnvNodePlan {
  /** 这份 Node 是谁管的（与报告里是同一个事实、由同一个函数算出来） */
  owner: EnvNodeOwner;
  /** 这台机器上有没有一个**可辨认的版本管理器**（`deriveNvmModel` 推出了根）。
   *  **只在"一份 Node 都没找到"时**参与决策：有 → 默认用它（需求 §7.5 那条默认现在有事实支撑）；
   *  没有 → 默认官方直装（既有设计默认，事实行必须写出方法）。
   *  **归属判不出来、但找到了一份 Node 时它不参与决策** —— 那时是不预选 + `needChoice: 'choose-method'`（需求 §7.7 第 3 条） */
  nvmPresent: boolean;
  /** 动作开始前那份 Node 的版本（自检报告 `node-version` 那一行的事实）；取不到时 null */
  currentVersion: string | null;
  /** **当前档位**：`currentVersion` 在官方版本清单里那一条的档（`lts === false` → `'current'`，否则 `'lts'`）。
   *  清单里没有这个版本 / 拿不到清单 → **null，不许猜**（需求 §8.5 第 1 条） */
  currentChannel: EnvNodeChannel | null;
  /** 目标档位与当前档位不同 = **这是「换档」，不是「更新」**（需求 §8.5 第 3 条） */
  switchesChannel: boolean;
  /** 目标版本相对当前的方向（`compareNodeVersions` 的结论）；`currentVersion` 取不到时 null。
   *  **`'older'` 只可能来自显式换档**（跟随档位时目标一定是那一档最新的，不可能更低）；
   *  `'older'` 时界面必须用「换档」这个词，并写出"版本比现在低"（需求 §8.5 第 4 条） */
  direction: 'newer' | 'same' | 'older' | null;
  /** 这次为什么给不出「开始」：`null` = 给得出。
   *  - `'choose-method'`：**找到了一份 Node，但归属判不出来**（需求 §7.7 第 3 条）→ 界面给两条路让用户**显式选**；
   *  - `'choose-channel'`：**更新时判不出当前档位**（需求 §8.5 第 3 条）→ 界面让用户**显式选**一档。
   *  约定（要写成断言）：`needChoice !== null` ⟹ `usable === false`；
   *  只有 `needChoice === null && usable === false` 时才走既有的三条出路（换源 / 官方下载页 / 重新检测） */
  needChoice: 'choose-method' | 'choose-channel' | null;
  /** 这条路要不要先装 / 升级**版本管理器本身**。`method === 'nvm'` 且机器上已经有可辨认的版本管理器时为 `false` ——
   *  那时这次**没有任何东西要下载**：`url` 指向发布页（给人看 / 当出路，不是我们要下的东西）、`sha256` 为 `null` 是正常的、
   *  下载与校验两段**直接跳过**（界面不出现下载进度，也不出现"这次没能校验安装包的完整性"那次确认），
   *  流程就是 §4.2 那四步：`nvm install <目标版本>` → `nvm list` 核对 → `nvm use <目标版本>` → 实测复检。
   *  直装恒为 `true`（官方安装包必须下载） */
  installsManager: boolean;
}

/** `EnvInstallState` 增量（既有字段一个不动） */
export interface EnvInstallState {
  /** 这一次跑的计划（确认区那份）。**状态要能跨页面重挂载**：界面不许靠"我这次会话里记着计划"来渲染进度与收尾
   *  （与既有 `report` 同一个理由：结论由主进程推）。idle 时为 null */
  plan: EnvNodePlan | null;
  /** 收尾**实测**到的版本（复检那一刻 `node --version` 的输出，形如 `v26.9.0`）。
   *  「更新前 → 更新后」的前一半取自 `plan.currentVersion`，后一半取自这里；
   *  还没到收尾 / 没测到时为 null —— 界面照实说"没测到"，**不许拿目标版本冒充实测版本** */
  observedVersion: string | null;
}

/**
 * 一次安装 / 更新的请求形状（`envNodePlan` 与 `envNodeInstall` 共用；冻结 §3.2.1，VM-14 / VM-15 的根治点）
 */
export interface EnvNodeRequest {
  mode: EnvNodeMode;
  /** 省略 = **跟随归属**（需求 §7.8）。给具体值 = **用户显式点名的那条路**
   *  （只有"归属判不出来"与"拒绝管理员权限之后的替代出路"这两处由界面给） */
  method?: EnvNodeMethod;
  /** 省略 = **跟随档位**：`mode === 'install'` → 最新稳定版（设计默认）；`mode === 'update'` → **当前档位**（需求 §8.5 第 2 条）。
   *  给具体值 = **用户显式换档** —— 「换档」只可能由这个字段产生，**不可能由省略或默认值产生**（需求 §8.5 第 3 条） */
  channel?: EnvNodeChannel;
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
  /**
   * 主进程改了设置时推给渲染层。
   * 目前只有一处：关闭窗口的对话框里勾了「记住我的选择」——主进程直接写盘，
   * 界面那份表单不跟着更新的话，用户下次一按保存就把旧值写回去了。
   */
  onSettings: (handler: (settings: SettingsValues) => void) => () => void;

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

  /**
   * 主进程问「关窗要怎么办」时进来（渲染层弹自己的确认卡片，见 shell/CloseDialog.vue）。
   * 传 `null` 表示**这次不问了** —— 渲染层没能确认接住，主进程已经退回原生的兜底弹窗，
   * 界面要把卡片收起来，别让两个弹窗同时挂着。
   */
  onCloseRequest: (handler: (request: CloseRequest | null) => void) => () => void;
  /**
   * 「卡片已经显示了」——收到请求后**立刻**回这一条。
   *
   * 主进程只给这个握手设时限：确认之后就不再计时，**等用户慢慢选**。
   * 少了它，主进程只能按"多久没回答"来猜，那样连"用户正在想"也会被算成"渲染层卡住"
   * （踩过：卡片明明已经显示出来，两三秒后就自己冒出系统弹窗）。
   */
  ackClose: () => Promise<boolean>;
  /** 把用户的选择回给主进程；当时没有待回答的询问时返回 false（例如已经兜底过了） */
  answerClose: (answer: CloseAnswer) => Promise<boolean>;

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

  // 插件装配层
  pluginInspect: () => Promise<PluginInspectResult>;
  pluginRun: (request: { action: PluginOpAction; spec: string }) => Promise<PluginOpResult>;
  pluginCancel: () => Promise<boolean>;
  /**
   * 改你自己的补丁层（插入 / 禁用 / 启用 / 移除插入 / 删掉指向不存在 id 的条目）；
   * 只动 profile 的 cordis.patch.yml
   */
  pluginEditLayer: (request: {
    action: PluginLayerEditAction;
    id: string;
    name?: string;
  }) => Promise<PluginLayerEditResult>;
  /** 只看 dsh 自带的组合结果（救援用；配置改坏时 `pluginInspect` 会失败，这条通常还能成） */
  pluginDefaultConfig: () => Promise<PluginInspectResult>;
  /**
   * 救援：把你的补丁层修回可用状态。
   * - `repair-empty`：只认"只剩注释/空文件"这一种坏法，补一个 `[]`
   * - `list-backups`：列出 `cordis.patch.yml.bak-*`（最近的在前）
   * - `restore-backup`：用指定备份覆盖（当前内容也会先备份，所以同样可逆）
   */
  pluginRescue: (request: {
    action: 'repair-empty' | 'list-backups' | 'restore-backup';
    backup?: string;
  }) => Promise<PluginRescueResult>;
  /** 临时停用 / 恢复一个 bundle（改 profile 的 dsh.profile.bundles，会先备份） */
  pluginBundleEdit: (request: {
    action: 'suspend' | 'restore';
    name: string;
    index?: number;
  }) => Promise<PluginBundleEditResult>;
  onPluginOutput: (handler: (payload: PluginOutputEvent) => void) => () => void;

  // 运行环境自检 + 一键修复（见 docs/env-doctor.md）
  /** 拉一份自检报告；refresh = true 时清掉缓存重跑一轮 */
  envCheck: (options?: { refresh?: boolean }) => Promise<EnvDoctorReport>;
  /** 跑一个一键修复动作：只递 action，命令由主进程自己构造 */
  envFix: (request: { action: EnvFixAction }) => Promise<EnvFixState>;
  /** 中断正在跑的修复（没有在跑的返回 false） */
  envFixCancel: () => Promise<boolean>;
  /** 修复状态变化（相位 / 收尾消息 / 复检报告）都走这一条 */
  onEnvFixState: (handler: (state: EnvFixState) => void) => () => void;
  /** 修复过程中 npm 的输出片段 */
  onEnvFixOutput: (handler: (payload: EnvFixOutputEvent) => void) => () => void;

  // 首启环境向导（门禁）+ Node 安装 / 更新通道（见 docs/env-wizard-freeze.md）
  /** 拉一份门禁状态；refresh = true 时清掉报告缓存重跑一轮完整探测 */
  envWizard: (options?: { refresh?: boolean }) => Promise<EnvWizardState>;
  /** 跳过 / 取消跳过一个可跳过的步骤；不可跳过的 id 会被忽略。设置写入在主进程 */
  envWizardSkip: (request: { step: EnvWizardStepId; skip: boolean }) => Promise<EnvWizardState>;
  /** 取一次安装 / 更新的计划（确认区用）。拿不到计划时返回 null（界面不给「开始」） */
  envNodePlan: (request: {
    mode: EnvNodeMode;
    method?: EnvNodeMethod;
    channel?: EnvNodeChannel;
  }) => Promise<EnvNodePlan | null>;
  /** 跑一次安装 / 更新：只递选择，地址与校验值由主进程现场重算 */
  envNodeInstall: (request: {
    mode: EnvNodeMode;
    method?: EnvNodeMethod;
    channel?: EnvNodeChannel;
  }) => Promise<EnvInstallState>;
  /** 停止：下载 / 校验 = 真取消并删临时文件；安装 / 等待 = 只停止等待（不杀安装器） */
  envNodeStop: () => Promise<EnvInstallState>;
  /** 安装状态变化（相位 / 进度 / 收尾结论 / 复检报告）都走这条 */
  onEnvInstallState: (handler: (state: EnvInstallState) => void) => () => void;
  /** 安装过程的输出片段 */
  onEnvInstallOutput: (handler: (payload: EnvInstallOutputEvent) => void) => () => void;

  onState: (handler: (snapshot: DshSnapshot) => void) => () => void;
  onOutput: (handler: (payload: DshOutputEvent) => void) => () => void;
  onDshExit: (handler: (payload: DshExitEvent) => void) => () => void;
  onLog: (handler: (entry: DshLogEntry) => void) => () => void;
  onUiUrl: (handler: (url: string) => void) => () => void;
  onSessionOutput: (handler: (payload: SessionOutputEvent) => void) => () => void;
  onSessionExit: (handler: (payload: SessionExitEvent) => void) => () => void;
}
