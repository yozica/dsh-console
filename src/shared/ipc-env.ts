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
 * 一键修复能做的事。**三个**，语义各不相同：
 *
 * - `install-pnpm`：**还没有 pnpm 时**用 npm 装一份（`<npm> i -g pnpm`）。插件页缺 pnpm 时也走它。
 * - `install-dsh`：`<npm> i -g @deepseek-ai/dsh`，可带一个**已校验**的版本（`@<version>`）；
 *   「装一份」与「更新 dsh」是同一个动作，差别只在按钮文案与是否显示目标版本。
 * - `update-pnpm`：**按那份 pnpm 现有的来源**更新它（standalone 自更新 / Corepack / npm 全局 /
 *   Homebrew，见 `EnvPnpmOwner`）。它**不**等于"用 npm 装一份" —— 那会把 pnpm 装到另一个地方，
 *   而插件页用的是 profile 匹配到的那一份（真机踩过：装在 v22 的全局树里，而 dsh 在 v24 上跑）
 *   —— 这正是新增这个动作的原因，见 `docs/env-doctor.md` 的「pnpm 的来源与更新方式」。
 *
 * 这三个动作**不**装 Node、不改 PATH、不写 .npmrc、不主动提权。
 * 装 Node 走独立通道 `envNodeInstall`（见 docs/env-wizard-freeze.md §3.2）：
 * 它不是 npm 包，而且"开始之后不杀"的停止语义与这里相反
 * （见 `EnvInstallState.cancellable` / `detached`）。
 */
export type EnvFixAction = 'install-pnpm' | 'install-dsh' | 'update-pnpm';

/**
 * 一项的**版本读数**：本机现在这一份 vs 安装源上的目标（`env:pkg-updates` 的返回值）。
 *
 * 它是**按需查的只读快照**，不进 `EnvDoctorReport`：那条路首启门禁也在读，
 * 往里塞网络请求会把门禁变成"断网就进不去"（见 docs/env-doctor.md 的「版本比对」一节）。
 *
 * - `current`：本机那一份的版本（探测来的原文里抠出来的；测不出来时 null）
 * - `target`：那条更新命令**真的会装到**的版本；查不到 / 没有可用目标时为 null
 * - `newer`：target 比 current 新（两边都拿得到时才可能为真）
 * - `ahead`：current 比 target 还新（本机在 alpha 那条线上时真会发生）——
 *   界面据此不写"已是最新版"，因为点了那个按钮反而是降级
 * - `error`：这一轮没查到时的原因（给人看的一句话）；成功时为 null
 * - `versions` / `tags`：安装源上的全部已发布版本（倒序）与 dist-tags，给「选择版本」那个下拉用。
 *   **两项都带**（dsh 与 pnpm 两档界面都用同一个控件画）：它们来自**同一次查询**
 *   （`fetchPackageMetadata` 本来就返回这两样），按项给只会多一层分支；而 `versions` 另有一个
 *   用处 —— 主进程校验用户递回来的版本号时就拿它当白名单（`env:fix` 只认列表里的版本）。
 * - `major`：这一档**被钉在哪条大版本线上**（`'10'`）—— 只有 pnpm 有。它同时解释了两件事：
 *   为什么 `versions` 里只有那一条线的版本（过滤在**主进程**做，界面不自己判规则），
 *   以及界面上那句"钉在 10.x 这条线上"是从哪来的。dsh 没有这条约束，所以是 null。
 */
export interface EnvPkgUpdate {
  current: string | null;
  target: string | null;
  newer: boolean;
  ahead: boolean;
  error: string | null;
  /**
   * 可以挑的版本，**倒序**（最新在前）。**只有 dsh 那一档会给**（它的更新入口带版本下拉）；
   * **pnpm 恒为 `[]`** —— 它不做选版本：目标固定在 profile 那条大版本线内的最新版，跨大版本要连同
   * profile 的依赖一起迁移（store 布局按大版本走），那是一次单独的迁移动作，见 `docs/env-doctor.md`。
   * 查不到 / 没有可用时也是 `[]`。
   */
  versions: string[];
  /** 安装源上的 dist-tags（`latest` / `next` / `alpha` …）；查不到时为 `{}` */
  tags: Record<string, string>;
  /** 钉住的大版本线（pnpm 那一档才有）；没有这条约束时为 null */
  major: string | null;
}

/** dsh 与 pnpm 两项的版本读数（一次查询同时给，`checkedAt` 是这次查询的时刻） */
export interface EnvPkgUpdates {
  dsh: EnvPkgUpdate;
  pnpm: EnvPkgUpdate;
  checkedAt: number;
}

/**
 * 「更新 dsh」该用哪个 npm 的**绑定事实**（方案 A，见 docs/env-doctor.md §3.5）。
 *
 * 为什么要有它：dsh 可能装在某个 Node 版本的全局树下（nvm / fnm / 官方安装包各有一份），
 * 拿别的 npm 去 `i -g` 会装进**另一棵树** —— 那份 dsh 一个字没变，而界面仍提示有新版本，
 * 于是永远不收敛（真机 bug）。所以"要升级的那份 dsh 属于哪个 Node"必须先认出来。
 *
 * - `bound`：`path` 是与被升级的 dsh **同一个 Node** 的 npm（同目录），更新入口可以用它；
 * - `fallback`：没有"被升级的那份 dsh"可绑（还没装 / 只能靠 `npx`）→ `path` 是 `findNpm()` 的结果，
 *   谁都能装一份新的，与既有行为一致；
 * - `unbound`：定位到了 dsh，却推不出它属于哪个 Node（shim / 自定义命令），或那份 npm 不可用
 *   → `path` 为 null，**不给更新入口**；界面改用 `evidence` 写一条诚实边界、`hint` 给可自己执行的命令。
 */
export interface DshNpmBinding {
  kind: 'bound' | 'fallback' | 'unbound';
  /** 要用的 npm 可执行文件；`unbound` 时为 null */
  path: string | null;
  /** 这句事实的依据（人话，进日志，也在 `unbound` 时当那条诚实边界的正文） */
  evidence: string;
  /** `unbound` 时给用户自己执行的命令；其余情况为 null */
  hint: string | null;
}

/**
 * 这份 pnpm **当初是怎么装的** —— 决定"更新它"该用哪条命令。
 *
 * 为什么必须分类：pnpm 有四条互不相通的安装路径，各有一条自己的更新命令；拿错方法的结果是
 * **装出来的是另一份 pnpm**，而插件页用的还是原来那份（用户看到"更新成功"但版本没变）。
 * 判据只有一条是决定性的：**`realpath` 落在哪儿**（`fs.realpathSync` 跟着符号链接走）。
 *
 * - `standalone`：pnpm 官方安装脚本（`~/Library/pnpm/pnpm` / `~/.local/share/pnpm/pnpm`），
 *   是个**普通文件**（62 MB 的自带运行时）→ `pnpm self-update [<版本>]`
 * - `corepack`：`realpath` 落在 `…/node_modules/corepack/…`（Node 自带/用户 enable 的 shim）
 *   → 用**同一个 Node** 的 `corepack prepare pnpm@<版本> --activate`
 * - `npm-global`：`realpath` 落在 `…/node_modules/pnpm/…`（`npm i -g pnpm` 装的那种）
 *   → 用**同一个 Node** 的 npm `i -g pnpm@<版本>`
 * - `homebrew`：路径在 `/opt/homebrew/**` 或 `realpath` 落在 `/usr/local/Cellar/**`
 *   → `brew upgrade pnpm`（**不能钉版本**，Homebrew 只认 formula）
 * - `unknown`：其余一切 → **不给自动动作**，只给手工步骤（与 Node 归属那套诚实边界同构）
 */
export type EnvPnpmOwner = 'standalone' | 'corepack' | 'npm-global' | 'homebrew' | 'unknown';

/**
 * 「更新 pnpm」要用的**归属事实**（与 `DshNpmBinding` 同构：都是"先认清对象，再决定动谁"）。
 *
 * **更新对象不是 PATH 上那份 `findPnpm()`，而是 `findPnpmForProfile()` 挑出来的那份** ——
 * 也就是插件页真正会用的那一份（store 布局按大版本走，挑错大版本 pnpm 会直接拒绝动手）。
 *
 * - `file`：更新对象；`unknown` / 没有 pnpm 时为 null
 * - `expectedMajor`：profile 的 `node_modules/.modules.yaml` 里 `packageManager: pnpm@10.x` 的大版本
 *   （读不到 → null，这时退回"跟随当前那份的 major"）
 * - `matched`：选中的那份与 `expectedMajor` 对得上（`expectedMajor` 为 null 时视为 true）
 * - **`canAutoUpdate`**：能不能替用户自动更新 —— 归属认得出 **且** 那条路要用的工具真的在
 *   （corepack / npm / brew 有一份）。界面据此决定给不给一键按钮：**false 时走诚实边界**
 *   （一行说明 + 手工步骤 + 「重新检测」），与 Node 归属那套同构。
 * - `blockedReason`：不能自动更新时那句人话（诚实边界正文）；能时 null
 * - `evidence`：逐条依据（进日志；不能自动更新时也一起给人看）
 * - `hint`：不能自动更新时给用户的**手工步骤**（不是单一命令：认不出来就不能替用户猜）
 */
export interface EnvPnpmBinding {
  owner: EnvPnpmOwner;
  file: string | null;
  version: string | null;
  expectedMajor: string | null;
  matched: boolean;
  canAutoUpdate: boolean;
  blockedReason: string | null;
  evidence: string[];
  hint: string | null;
}

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
  /**
   * 「更新 dsh」那份 npm 的绑定事实（方案 A）。界面据此决定**给不给** dsh 的更新入口：
   * `unbound` 时不给，并在 dsh 那一行写一条诚实边界（说不准该装进哪个 Node 的全局目录）。
   */
  dshNpm: DshNpmBinding;
  /**
   * 「更新 pnpm」的归属事实。界面据此决定**按钮文案**（用 Corepack / 用 Homebrew / 自更新）与
   * **给不给**：`unknown` 时不给一键按钮，改走诚实边界（一行说明 + 手工步骤）。
   */
  pnpmBinding: EnvPnpmBinding;
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
  /**
   * 这一轮跑完的时刻（毫秒）；`running` / `idle` 时为 null。
   *
   * 界面为什么需要这个事实：**更新 dsh 不会停它**（npm 换的只是磁盘上的文件），所以"要不要提示
   * 重启 dsh"不能只问"用户有没有关过这条提示" —— 那是个会话内的布尔，用户在更新之后自己重启了
   * dsh，只要那个布尔被复位，提示就会又冒出来（真机踩过）。正确的问法是**比事实**：拿它与
   * `dsh.startedAt` 比，现在跑着的那份比这次更新还旧，才提示。
   */
  finishedAt: number | null;
}

/** 一键修复边跑边推的输出片段（界面原样贴进输出区，与 plugin:output 同一套做法） */
export interface EnvFixOutputEvent {
  chunk: string;
}

/**
 * 起一轮修复时**调用方**给的状态：与 `EnvFixState` 只差 `finishedAt`。
 *
 * 为什么要有这个名字：`finishedAt` 是"这一轮什么时候跑完"的**事实**，只该由
 * `EnvFixRunner.publish()` 在终态那一刻派生（一处，一轮一次）—— 让每个发布点各自
 * `Date.now()`，迟早会不一致，而界面的重启提示判据全靠它准（见 `finishedAt` 的说明）。
 * 类型上把它排除掉，调用方想给也给不了。
 */
export type EnvFixDraft = Omit<EnvFixState, 'finishedAt'>;

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
