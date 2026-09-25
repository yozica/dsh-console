/**
 * dsh 运行时快照：状态、事件日志、端口/启动信息、会话与设置
 *
 * 主进程 ↔ 渲染层契约的一部分（t55 从 `shared/ipc.ts` 拆出来的；那个文件现在只是 barrel）。
 * 约定不变：**只放类型与纯常量，禁止 import 任何运行时依赖**（渲染层要读这些类型，
 * 拖进 fs/path 就会被卷进包里）—— 叶子模块之间只允许 `import type`。
 */
import type { UpdateState } from './ipc-update';

import type { EnvWizardStepId } from './ipc-env';

import type { CloseAction, ThemeInfo, ThemeMode } from './ipc-shell';

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
