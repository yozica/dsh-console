/**
 * 首启环境向导（入口门禁）在渲染层的共享状态与相位机。
 *
 * 三条分工（与 `lib/env-doctor.ts` 同一套纪律）：
 *   1. **判定在主进程**（`main/env-doctor.ts` 的纯函数 `judgeWizard`）：这里只搬运结论，
 *      界面**不自己判**"环境够不够"。两套判据就是两套口径。
 *   2. **报告与门禁状态都是"拉"的**：`envWizard()` 是唯一取结论的路径（主进程有缓存，
 *      `{ refresh: true }` 才清缓存重跑一轮）；只有安装过程是推的（`env:install-state`）。
 *   3. **逃生口不依赖任何安装动作**：`escapeGate()` 只改内存里这一个相位（不写盘、不发 IPC、
 *      不看安装状态）—— 安装引擎坏了、网络断了、探测卡住了，用户仍然必须能进主界面。
 *
 * 相位机（只能单向自动推进，见 docs/env-wizard-interaction.md §2.2 与冻结 §1 R-18）：
 *
 *     idle → checking → (blocked | released | unknown) → escaped | entered → done
 *
 *   - 走到 `escaped` / `entered` / `done` 之后，**后续的判定结果不会再把门禁层拉回来**
 *     （数据照旧更新，横幅照旧跟着变）；用户想再看到向导只能走交互 §2.8 的三条明路，
 *     那三条最终都调 `reopenGate()` —— 它是用户显式发起的新一轮，不是自动重锁。
 *   - 单向状态机管的是"门禁层还显不显示"，**不管"门禁层里显示哪一步"**：
 *     显示期间步骤状态、当前步骤、复检结论每轮都按最新报告重算（冻结 §1 R-18）。
 *   - **正文画哪一步**另外有一层"视图相位"（t43 / 冻结 §0.3 的 R-29 / R-30）：默认跟着判定给的
 *     当前步骤；用户在左轨点了走过的节点之后**钉住**，判定再前进也不动它（只出一行提示）。
 *     纯规则在 `lib/wizard-view.ts`，这里只存"钉住了哪一步"。
 *
 * `gateVisible` 是**唯一**的"门禁层此刻该不该显示"来源（顶栏 R-03 也读它）：
 *
 *     (相位 blocked) 或 (相位 checking 且这一轮的检查中属于门禁层)
 *     或 (相位 released 且本轮显示过挡住页) 且 启动锁不在显示中
 *
 * 三条细节都有理由：
 *   - `checking` 只在"门禁层本来就该在屏幕上"时显示：挂载后的第一轮必须显示
 *     （交互 §2.3「不许空白」），从挡住页/放行页里点「重新检测」也要显示；
 *     但从主界面横幅点「重新检测」（那时层是收起的）就**不该**弹出一张全屏卡片。
 *   - `released` 只在"本轮真挡过人"时显示：门禁层原地变成放行页（交互 §2.4 离开条件 1、
 *     §2.11），健康机器第一次判定就是 `open`，不该看到任何全屏层（冻结 §4.5 的三种屏）。
 *   - 启动锁在显示中一律不显示门禁层（冻结 §1 R-08：两层互相压，先让锁说完）。
 */

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';

import { bootLockVisible } from './boot-lock.js';
import { canViewStep, resolveViewedStep, type ViewPin } from './wizard-view.js';
import { envFix, envReport } from './env-doctor.js';
import type {
  EnvInstallPhase,
  EnvInstallState,
  EnvNodePlan,
  EnvNodeRequest,
  EnvWizardState,
  EnvWizardStepId,
} from '../../shared/ipc';

const api = window.dshConsole;

/** 安装过程的输出只留尾部：一次安装的输出可能很长，DOM 与内存都不该跟着涨 */
const OUTPUT_TAIL = 64000;

/** 门禁层的相位（只能单向推进；`reopenGate()` 是唯一允许重开一轮的入口） */
export type GatePhase =
  'idle' | 'checking' | 'blocked' | 'released' | 'unknown' | 'escaped' | 'entered' | 'done';

/** 最近一次门禁结论（主进程那份判定的镜像；第一份报告回来前是 null） */
export const wizard: Ref<EnvWizardState | null> = ref(null);
/** 门禁层的相位 */
export const gatePhase: Ref<GatePhase> = ref('idle');
/** 拉门禁结论时 IPC 自己出的错（不是"某项不满足"） */
export const wizardError: Ref<string | null> = ref(null);

const EMPTY_INSTALL: EnvInstallState = {
  phase: 'idle',
  method: null,
  mode: null,
  percent: null,
  bytes: null,
  cancellable: false,
  detached: false,
  message: null,
  code: null,
  report: null,
  // t29：计划与实测版本都由主进程推（冻结 §3.2.1）—— 界面不许靠"我这次会话里记着"
  plan: null,
  observedVersion: null,
};

/** 安装 / 更新的当前状态：主进程是唯一状态机，这里只是镜像 */
export const install: Ref<EnvInstallState> = ref({ ...EMPTY_INSTALL });
/** 安装过程的流式输出（尾部 64 KB） */
export const installOutput = ref('');

/** 「进行中」的安装相位：这些相位（含 `detached`）都算忙（冻结 §4.4，R-06） */
const BUSY_INSTALL_PHASES: EnvInstallPhase[] = [
  'preparing',
  'downloading',
  'verifying',
  'installing',
  'waiting',
  'rechecking',
];

// ------------------------------------------------------------ 相位机的内部位

/** 本次运行是否已经开始过新一轮判定（决定第一轮要不要显示"检查中"） */
let started = false;
/** 用户刚刚点了「重新打开环境向导 / 继续配置」：新一轮必须显示"检查中" */
let reopenRequested = false;
/** 本轮门禁层是否显示过挡住页（决定 `released` 是不是"原地变放行页"） */
let blocking = false;
/** 这一轮是用户显式重开的（`reopenGate()`）：判成 `open` 也要显示放行页（t43 / R-31） */
let reopened = false;
/** 相位是 `checking` 时门禁层要不要显示 */
let checkingVisible = false;

/**
 * 一次 `env:wizard` 往返的**兜底时限**：超过它，旧的那次就作废（下一个人来拉时不再共用它）。
 *
 * 为什么需要这条兜底：`inflight` 是"并发共用同一次往返"的手段，它隐含一个前提 ——
 * **每次 invoke 都会 settle**。这条前提不能当公理：主进程那次 `ipcMain.handle` 可能卡在一个
 * 永远回不来的探测里，界面与主进程半新半旧时那个通道甚至可能压根不存在。前提一破，
 * 旧实现会把**所有**后续拉取都挂在那颗死掉的 Promise 上：用户点「重新检测」不会有任何反应，
 * 而且连一条错误都不会显示（比报错更难排查）。
 *
 * 所以两条规则：显式 `refresh`（用户主动要新结论）与 `reopenGate()`（用户显式重开向导）
 * **一律**作废旧的；其余调用只在往返年轻于这个时限时才共用。检查是**懒的**（在下一次拉取时判）
 * —— 没有调用者的时候，那颗旧 Promise 留着也不影响任何人，不需要为此挂一个定时器。
 */
export const INFLIGHT_STALE_MS = 15_000;

/**
 * 同一时刻只发一次 `env:wizard`（并发调用共用同一次往返）。
 *
 * 存的是"往返 + 它的发起时刻"而不是裸 Promise：作废旧的一次时要能干净地把新的换上去
 * （旧那次的 `.then` 用**身份**判断，见 `loadWizard` 末尾）。
 */
let inflight: { task: Promise<EnvWizardState | null>; at: number } | null = null;
let wired = false;

/**
 * 全局忙位：既有的一键修复（可能正在改全局 npm 包）或安装通道正在动系统。
 * 界面用它禁用其它动作。
 *
 * 口径**只有一处**：主进程推来的状态（`EnvFixState.phase` / `EnvInstallState.phase`）。
 * 安装通道真正的互斥位住在引擎里（`NodeInstaller.busy()`），连 `detached`（"不再等待"）
 * 期间的持有与解除也由它自己管（安装器真退出后它会复检、证明落地就解锁并推 `done`）——
 * 所以这里**不额外记**任何"detached 永远算忙"的本地状态，只镜像推来的相位。
 * 显式带上 `detached` 是对齐冻结 §4.4 的措辞（R-06），它与"正在等待"的相位同时出现，
 * 不会比主进程多算一秒。
 *
 * 逃生口**不看它**：门禁层被任何"忙"挡住的逃生口就不叫逃生口了（冻结 §4.4）。
 */
export const anyoneBusy: ComputedRef<boolean> = computed(
  () =>
    envFix.value.phase === 'running' ||
    BUSY_INSTALL_PHASES.includes(install.value.phase) ||
    install.value.detached,
);

/**
 * 门禁层此刻该不该显示（唯一来源）。逐条理由见文件头。
 * 注意它读 `bootLockVisible`：锁在显示时永远不显示门禁层（防两层互相压的回归）。
 */
export const gateVisible: ComputedRef<boolean> = computed(() => {
  if (bootLockVisible.value) return false;
  const phase = gatePhase.value;
  if (phase === 'blocked') return true;
  if (phase === 'checking') return checkingVisible;
  // released：本轮挡过人（原地变放行页）**或**这一轮是用户显式重开的（"重新打开环境向导"的目的
  // 就是看这一屏，判成 open 也留在屏幕上 —— t43 / R-31）。健康机器首轮两条都不成立，什么都不显示。
  if (phase === 'released') return blocking || reopened;
  return false;
});

/**
 * 正文「钉住」在看哪一步（t43 / R-29）：null = 跟着判定给的当前步骤。
 *
 * 只存一个 id，不存"钉住时的状态"：报告换了之后那一步可能已经不是 `done` 了，
 * `resolveViewedStep` 会据当下的报告判断还看不看得动，看不动的静默回到当前步骤。
 */
export const pinnedStepId: Ref<EnvWizardStepId | null> = ref(null);

/**
 * 钉住那一刻判定给的当前步骤（t43 / R-30）：`advanceNotice` 靠它回答"判定前进了没有"。
 * 存下来而不是现算 —— 现算只能得到"正在看的 ≠ 当前"，那会把"用户往回翻看、判定原地没动"
 * 也当成一次前进（真机验证时抓到的第一版就是这个错）。
 */
const pinnedAtStepId: Ref<EnvWizardStepId | null> = ref(null);

/** 正文实际画哪一步（默认 = 判定的当前步骤；钉住且仍看得动 = 那一步） */
export const viewedStepId: ComputedRef<EnvWizardStepId | null> = computed(() =>
  resolveViewedStep(
    wizard.value?.currentStepId ?? null,
    pinnedStepId.value,
    wizard.value?.steps ?? [],
  ),
);

/** 正文是不是"回看"（钉住的不是判定给的当前步骤）—— 界面据此画只读回看卡 */
export const reviewing: ComputedRef<boolean> = computed(
  () => viewedStepId.value !== null && viewedStepId.value !== (wizard.value?.currentStepId ?? null),
);

/** 钉住状态此刻还成立吗（钉的那一步仍然看得动）—— 不成立时一律按"没钉住"对待 */
export const pinActive: ComputedRef<boolean> = computed(
  () => pinnedStepId.value !== null && viewedStepId.value === pinnedStepId.value,
);

/**
 * 此刻仍然成立的那次「钉住回看」（没钉住 / 钉住已失效时为 null）。
 *
 * 带着"钉住那一刻判定在哪一步"一起给界面 —— `advanceNotice` 靠它回答"判定前进了没有"。
 * 没钉住与"钉住时本来就没有当前步骤"**必须分得开**，所以这里给的是一个对象而不是可空 id
 * （见 `wizard-view.ts` 的 `ViewPin`）。
 */
export const activePin: ComputedRef<ViewPin | null> = computed(() =>
  pinActive.value && pinnedStepId.value !== null
    ? { stepId: pinnedStepId.value, currentAtPin: pinnedAtStepId.value }
    : null,
);

/** 点左轨节点（R-28）：看得动就钉住；点当前这一步、或点一个看不动的 → 回来 */
export function selectViewedStep(stepId: EnvWizardStepId): void {
  const state = wizard.value;
  const step = state?.steps.find((item) => item.id === stepId);
  if (!state || !step) return;
  const viewable = canViewStep(step, state.currentStepId);
  pinnedStepId.value = viewable ? stepId : null;
  // 连"钉住那一刻判定在哪一步"一起记下来：判定后来往前挪了才出提示（R-30）
  pinnedAtStepId.value = viewable ? state.currentStepId : null;
}

/** 回到判定给出的当前步骤（回看卡的主按钮、提示行的按钮） */
export function clearViewedStep(): void {
  pinnedStepId.value = null;
  pinnedAtStepId.value = null;
}

function isRetired(): boolean {
  const phase = gatePhase.value;
  return phase === 'escaped' || phase === 'entered' || phase === 'done';
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 把一份结论并进相位机（门禁层"还显不显示"的**唯一**收敛点）。
 *
 * `escaped` / `entered` / `done` 之后不再改变相位：数据照旧更新（横幅要跟着变），
 * 但门禁层不会被一次新的判定重新扣上来（交互 §2.2 第 115 行那条纪律）。
 */
function applyWizardState(state: EnvWizardState): void {
  wizard.value = state;
  started = true;
  reopenRequested = false;
  checkingVisible = false;

  if (isRetired()) {
    // 已经离开过门禁层：只更新数据，相位收敛到 done
    gatePhase.value = 'done';
    return;
  }

  if (state.gate === 'blocked') {
    blocking = true;
    gatePhase.value = 'blocked';
    return;
  }
  if (state.gate === 'unknown') {
    // 不挡人：收起门禁层，主界面 + 常驻横幅（交互 §2.6）
    gatePhase.value = 'unknown';
    return;
  }
  // open：本轮挡过人 → 原地变成放行页；没挡过（健康机器）→ 门禁层从头就没出现过
  gatePhase.value = 'released';
}

/**
 * 拉一份门禁结论。`refresh` 为真时请主进程清缓存重跑一轮完整探测
 *（用户自己装了东西之后要看新结论）。
 *
 * 同一时刻只发一次往返（同一份结论不该打两次子进程）；失败返回 null 并把原因写进
 * `wizardError`（业务失败不在这里表达）。
 *
 * **可以共用的前提是"每次 invoke 都会 settle"** —— 这条前提写在 `INFLIGHT_STALE_MS` 的注释里，
 * 而这里是对它的兜底：显式 `refresh` / `reopenGate()` 直接作废旧的那次，其余调用只在往返
 * 年轻于 `INFLIGHT_STALE_MS` 时才共用。作废是安全的：旧那次回来时按**身份**判断
 * （`inflight === entry`），既不会清掉新的，也不会覆盖新的结论。
 */
export function loadWizard(options?: { refresh?: boolean }): Promise<EnvWizardState | null> {
  const refresh = Boolean(options?.refresh);
  // 用户明确要一轮新的（refresh / reopenGate），或者手上这次已经太老 → 旧的作废，发新的
  if (inflight && (refresh || Date.now() - inflight.at >= INFLIGHT_STALE_MS)) inflight = null;
  if (inflight) return inflight.task;

  /**
   * 这一轮的 `checking` 要不要**显示门禁层**：判据是"这一轮属不属于门禁层"，
   * **不是**"是不是一次 refresh"（R-08 ② / §3.8 #15）。三种属于门禁层的情形：
   *   ① 挂载后的第一轮（交互 §2.3：不许空白）；
   *   ② 用户点了「重新打开环境向导 / 继续配置」（`reopenRequested`）；
   *   ③ 门禁层**此刻已经在屏幕上**（层内的「重新检测」）。
   * 从主界面横幅点「重新检测」时层是收起的（相位是 unknown / escaped / done），
   * 于是这一轮只更新数据、**绝不弹出全屏门禁层** —— 用户在会话中重检时整个界面被替换
   * 是惊吓而不是保护（船长裁定）。
   *
   * 注意这里读 `gateVisible` 必须在改相位**之前**：它读的就是 `gatePhase` / `checkingVisible`。
   */
  const layerWasVisible = gateVisible.value;
  const quiet = !refresh && started && !reopenRequested;
  if (!isRetired() && !quiet) {
    const belongsToGateLayer = !started || reopenRequested || layerWasVisible;
    gatePhase.value = 'checking';
    checkingVisible = belongsToGateLayer;
  }

  wizardError.value = null;
  const task = (async (): Promise<EnvWizardState | null> => {
    try {
      const state = await api.envWizard(refresh ? { refresh: true } : undefined);
      applyWizardState(state);
      return state;
    } catch (cause) {
      wizardError.value = messageOf(cause);
      // 探测失败 / IPC 不通 ≠ 把用户关在外面，也 ≠ 假装已经判完：
      //   - 门禁层**留在"检查中"**并靠 `wizardError` 明说"上一轮检查没能完成"
      //     （交互 §2.3 与 EnvGate 的检查中屏读的正是它），不让用户对着一颗转圈的环干等；
      //   - 逃生口照常可点，而且它**不发任何 IPC**（`escapeGate()` 只改内存相位）——
      //     这正是"门禁坏了也要能进主界面"这条硬要求的落点。
      // 这里不动相位、不改判定：只有用户点逃生口才离开这一屏。
      return null;
    }
  })();
  const entry = { task, at: Date.now() };
  inflight = entry;
  // 清在赋值之后（而不是写在 finally 里）：`api.envWizard` 不存在时（界面与主进程半新半旧）
  // 那个 async 体会同步走完 finally，若在 finally 里清，紧接着的赋值又会把已结算的 Promise 挂回去。
  // 按**身份**判断：这一次已经被作废过（`inflight` 换成了新的一次）时，绝不许把它清掉。
  void task.then(() => {
    if (inflight === entry) inflight = null;
  });
  return task;
}

/** 跳过 / 取消跳过一个可跳过的步骤（真正的设置写入在主进程；渲染层不碰 patchSettings） */
export async function skipStep(step: EnvWizardStepId, skip: boolean): Promise<void> {
  try {
    const state = await api.envWizardSkip({ step, skip });
    wizardError.value = null;
    applyWizardState(state);
  } catch (cause) {
    wizardError.value = messageOf(cause);
  }
}

/**
 * 取一次安装 / 更新的计划（确认区用）；拿不到计划时返回 null（界面据此不给「开始」）。
 *
 * 请求形状与契约同源（`EnvNodeRequest`，冻结 §3.2.1）：`method` / `channel` 都可以**省略** ——
 * 省略 = 跟随归属 / 跟随档位；只有用户显式点名时才给值。
 */
export async function loadNodePlan(request: EnvNodeRequest): Promise<EnvNodePlan | null> {
  try {
    const plan = await api.envNodePlan(request);
    wizardError.value = null;
    return plan;
  } catch (cause) {
    wizardError.value = messageOf(cause);
    return null;
  }
}

/** 跑一次安装 / 更新：只递选择（mode / method? / channel?），地址与校验值由主进程现场重算 */
export async function runNodeInstall(request: EnvNodeRequest): Promise<void> {
  installOutput.value = '';
  try {
    applyInstallState(await api.envNodeInstall(request));
  } catch (cause) {
    // IPC 自己失败（业务失败走 install.phase）—— 绝不能停在"正在安装"的转圈里
    wizardError.value = messageOf(cause);
    install.value = {
      ...EMPTY_INSTALL,
      phase: 'error',
      message: `安装没能开始：${messageOf(cause)}`,
    };
  }
}

/**
 * 停止：下载 / 校验 = 真取消并删临时文件；安装 / 等待 = 只停止等待（**不杀安装器**）。
 * 两种含义都由主进程的 `cancellable` / `detached` 表达，这里不自己判断。
 */
export async function stopNodeInstall(): Promise<void> {
  try {
    applyInstallState(await api.envNodeStop());
  } catch (cause) {
    wizardError.value = messageOf(cause);
  }
}

/**
 * 逃生口：收起门禁层，**不写盘、不改判定、不发任何 IPC**（冻结 §1 R-16）。
 * 它是"我们的探测/安装坏掉了"时唯一的出路 —— 所以这里连 `wizard` 都不看。
 */
export function escapeGate(): void {
  gatePhase.value = 'escaped';
  checkingVisible = false;
  // 离开门禁层就不再是"用户要看的那一轮"，钉住也一并清掉（下次重开从当前步骤重新开始）
  reopened = false;
  pinnedStepId.value = null;
  pinnedAtStepId.value = null;
}

/** 放行页的「进入 DSH Console」：收起门禁层，走阶段一的正常流程 */
export function enterMainUi(): void {
  gatePhase.value = 'entered';
  checkingVisible = false;
  reopened = false;
  pinnedStepId.value = null;
  pinnedAtStepId.value = null;
}

/**
 * 横幅 / 自检页的「继续配置 / 重新打开环境向导」（用三次也仍然有效）。
 * 用户显式发起的新一轮：允许把门禁层重新显示出来，并立刻用主进程的缓存报告给结论。
 */
export function reopenGate(): void {
  // 用户显式重开：手上那次往返一律作废（它可能永远不回来，也不该再覆盖这一轮的结论）
  inflight = null;
  started = false;
  reopenRequested = true;
  blocking = false;
  // 这一轮是"用户自己要看向导"：判成 open 也停在放行页（R-31）；正文回到当前步骤（R-29）
  reopened = true;
  pinnedStepId.value = null;
  pinnedAtStepId.value = null;
  gatePhase.value = 'checking';
  checkingVisible = true;
  void loadWizard();
}

/**
 * 一键修复跑完要**在同一轮里**重拉一次门禁结论（VM-07）。
 *
 * 复检报告随 `env:fix-state` 回来，由 `lib/env-doctor.ts` 落进 `envFix`；这里盯的正是它。
 * 为什么必须盯：`install-pnpm` 就是门禁第二步的修复动作（冻结 R-07：pnpm 不许开第二条路），
 * 而**门禁的步骤状态是另一条读法** —— 走 `env:wizard` 拿 `judgeWizard` 的结论。少了这一步，
 * 用户装完 pnpm 之后第二步仍然停在「待办」上，只有重开应用才看得到。
 *
 * 为什么用 `watch(envFix)` 而不是自己再订阅一次 `env:fix-state`：同一条 IPC 只该有一个订阅者
 * （`lib/env-doctor.ts` 已经订了），共享状态也只该有一个真源。
 */
function watchFixReports(): void {
  watch(envFix, (state) => {
    // 只有带复检报告的那几条才算"结论变了"（成功 / 复检后失败都会带）
    if (!state.report) return;
    // 安静刷新：主进程的缓存刚被复检刷新过（不 refresh）、不加启动锁、不改任何判定
    void loadWizard();
  });
}

/**
 * 建立两条安装事件的订阅，并接上一键修复的复检报告。幂等：重复调用不做第二次（与 `wireEnvDoctor` 同款）
 */
export function wireEnvWizard(): void {
  if (wired) return;
  wired = true;
  api.onEnvInstallState((state) => applyInstallState(state));
  api.onEnvInstallOutput((payload) => {
    installOutput.value = (installOutput.value + payload.chunk).slice(-OUTPUT_TAIL);
  });
  watchFixReports();
}

/**
 * 把一份安装状态并进共享状态。带复检报告时顺手刷新自检页的报告，并重算一次门禁结论
 * （冻结 §1 R-18：门禁层显示期间，步骤状态每轮都按最新报告重算）。
 */
function applyInstallState(state: EnvInstallState): void {
  install.value = state;
  if (state.report) {
    envReport.value = state.report;
    // 安静刷新：报告刚在主进程里重新采过，这一次只更新数据、不把界面切回"检查中"
    void loadWizard();
  }
}
