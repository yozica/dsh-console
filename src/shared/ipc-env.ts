/**
 * 运行环境自检与首启门禁：检查项、步骤、报告与门禁状态
 *
 * 主进程 ↔ 渲染层契约的一部分（t55 从 `shared/ipc.ts` 拆出来的；那个文件现在只是 barrel）。
 * 约定不变：**只放类型与纯常量，禁止 import 任何运行时依赖**（渲染层要读这些类型，
 * 拖进 fs/path 就会被卷进包里）—— 叶子模块之间只允许 `import type`。
 */
import type { EnvNodeOwner } from './ipc-node';

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
  /** 这份 Node 是谁管的（§7.7）。界面据此决定「更新」走哪条路、能不能自动更新 */
  nodeOwner: EnvNodeOwner;
  /** 归属判定的证据（人话，逐条：用了哪条路径 / 哪个变量 / 模型的哪条结论）；没有证据时是空数组。
   *  进日志，也进确认区的「详情」—— 评审时能对账"为什么是这一条" */
  nodeOwnerEvidence: string[];
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
