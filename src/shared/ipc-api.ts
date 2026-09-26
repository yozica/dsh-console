/**
 * `DshConsoleApi`：渲染层能看到的全部通道（preload 照它实现）
 *
 * 主进程 ↔ 渲染层契约的一部分（t55 从 `shared/ipc.ts` 拆出来的；那个文件现在只是 barrel）。
 * 约定不变：**只放类型与纯常量，禁止 import 任何运行时依赖**（渲染层要读这些类型，
 * 拖进 fs/path 就会被卷进包里）—— 叶子模块之间只允许 `import type`。
 */
import type { UpdateState } from './ipc-update';

import type {
  PluginBundleEditResult,
  PluginInspectResult,
  PluginLayerEditAction,
  PluginLayerEditResult,
  PluginOpAction,
  PluginOpResult,
  PluginOutputEvent,
  PluginRescueResult,
} from './ipc-plugin';

import type {
  EnvInstallOutputEvent,
  EnvInstallState,
  EnvNodeChannel,
  EnvNodeMethod,
  EnvNodeMode,
  EnvNodePlan,
} from './ipc-node';

import type {
  EnvDoctorReport,
  EnvFixAction,
  EnvFixOutputEvent,
  EnvFixState,
  EnvWizardState,
  EnvWizardStepId,
} from './ipc-env';

import type { CloseAnswer, CloseRequest, ThemeInfo, ThemeMode } from './ipc-shell';

import type {
  ArchiveListResult,
  ArchiveReadResult,
  ArchiveRemoveResult,
  ArchiveUnarchiveResult,
} from './ipc-archive';

import type {
  AppSnapshot,
  ConfirmRequest,
  CreateShellResult,
  DshActionResult,
  DshExitEvent,
  DshLogEntry,
  DshOutputEvent,
  DshSnapshot,
  RenameSessionResult,
  SessionExitEvent,
  SessionOutputEvent,
  SettingsValues,
} from './ipc-runtime';

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
   * 主进程问「关窗要怎么办」时进来（渲染层弹自己的确认卡片，见 layout/CloseDialog.vue）。
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
