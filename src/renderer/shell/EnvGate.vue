<script setup lang="ts">
/**
 * 首启环境向导 / 入口门禁（交互 §2~§8，视觉 §2~§5）。
 *
 * 它**不是**一个弹窗，而是"这台应用把中段让给了向导"：左轨（`--rail`，188px，
 * 与既有左栏同宽同位）+ 内容列（`--bg`，20px 内边距，与九页内容同一条竖线）+
 * 底条（`--rail`，与状态栏同位）。三块的位置在任何状态下都不变 —— 失败、等待、
 * 未确定**都在原地发生**，不弹窗、不跳页、不换屏。
 *
 * 五条纪律（每条都有理由，别在实现里"顺手改"）：
 *   1. **判定只在主进程**（`judgeWizard`）：这一层只读 `wizard` / `gateVisible`
 *      的结论，不自己判"环境够不够"。两套判据就是两套口径。
 *   2. **逃生口永远可点、永远在 Tab 顺序最后**：不因相位、不因探测失败、不因安装
 *      在跑而禁用，也不被任何"只有某种情况下才显示"的条件挡住（交互 §2.7）。
 *   3. **一屏只有一件事可做**：队列只在左轨上；正文里只有"当前步骤"这一块是可操作的，
 *      后续步骤不可点、不可展开、不进 Tab（交互 §2.4 第 5 条 / 冻结 §1 R-01）。
 *   4. **颜色是第二信号**：第一信号是形状与状态词。未标定的结果（我们不等了）
 *      一律中性，不给绿也不给红 —— 颜色代表"我们确定的事实"。
 *   5. **`Esc` 只退、不前进**（交互 §0.4）：确认区展开时 = 取消；下载 / 校验中 =
 *      取消下载；**安装阶段什么都不做**。这里的处理器用捕获阶段接管，压过 app.ts
 *      里那条"门禁可见时 Esc = 逃生"的兜底（那条是给没有更具体规则的情况用的）。
 *
 * **Tab 顺序（这里是唯一的书面说明，交互 §11.2 / §11.3 / §11.4 的落点）**：
 *   - 挡住页：当前步骤的单选项 → 「安装」 → 次操作（自己下载 / 先跳过）→「展开看详情」
 *     → 缓存里后续步骤**没有**可聚焦元素（左轨节点是纯读数）→ 「重新检测」→ **逃生口**；
 *   - 确认区展开时焦点移进确认区：「开始」→「取消」，`Esc` 收起并把焦点还给触发它的按钮；
 *   - 检查中：逃生口（默认焦点）→「重新检测」（进行中禁用、不进 Tab）；
 *   - 放行页：「进入 DSH Console」（默认焦点）→「再看看环境自检」；底条没有按钮。
 *   评审 T11-C（「展开看详情」排在哪）**已按交互 §11.1 定稿**：这一块在 DOM 里排在两个操作
 *   **之后**，所以 Tab 与 §11.1 / §11.4 的枚举逐项一致。原来它紧跟事实行（视觉 §5.0 A 把展开器
 *   画在事实行的右端），那会让它排在两个操作之前；两份规格在这里只能满足一个 —— 交互给的是
 *   **逐项枚举**，视觉那里只是一张排布示意，所以取交互；代价是展开器不再画在事实行右端
 *   （实现位置见模板里那一段的注释，改判时回退动作也写在那里）。
 *
 * **左栏那 36px 带：判据是几何，不是列举（VM-08 + VM-10）。**
 * 门禁层可见时由 `setAppBrandConceded()` 写 `body[data-gate-visible='true']`，`styles.css`
 * 里那一条把**应用左栏的全部直接子元素**都藏掉（`.rail > *`），只留门禁左轨自己的内容。
 *
 * 规则只有一条，而且是几何的：**门禁覆盖层从 `top: var(--bar-h)`（36px）起，而应用左栏是
 * 贯穿全列的整列**（顶栏只属于 workspace 那一列）—— 所以左栏里凡是纵向落在 `0..var(--bar-h)`
 * 的东西都会露在覆盖层之上，还会被那条边裁掉一半。VM-08 是品牌块（两行「DSH Console」），
 * VM-10 是服务状态块（状态点 + 阶段词 + 状态说明被切掉下半截）—— 同一个根因的两次显形。
 * **下次往左栏顶部加任何东西都落在同一条规则里**，不需要再补名字：这也是为什么按容器藏，
 * 而不是按名字逐个藏 —— 逐个藏不收敛（藏掉品牌 → 服务块上移到带里 → 再藏服务块 → 第一个
 * 导航项又移进来）。用 `visibility` 而不是 `display`：布局原样保留、不位移，`.rail` 自己的底
 * 与右缘发丝线留着，那 36px 带与下面被门禁盖住的部分接得上。
 *
 * 选这一侧（而不是让门禁不画自己的品牌/左轨）的理由：设计里那一行**本来就是向导的** ——
 * 视觉 §4.1 写着门禁左轨"沿用既有左栏的品牌块"、副标题给门禁状态（「运行环境准备」），而 §2
 * 的构图原则就是"这台应用把中段让给向导"；反过来会把让位方向弄反。几何一律不动：左栏仍是
 * 188px、覆盖层仍在 `top: var(--bar-h)`，三步与脊线的位置尺寸都没碰；层一收起（逃生 / 放行 /
 * 判定不挡）开关立刻回到 'false'，左栏整列内容当帧恢复。
 */
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';

import {
  cancelEnvFix,
  clearEnvFixOutput,
  envFix,
  envFixOutput,
  runEnvFix,
} from '../lib/env-doctor.js';
import {
  anyoneBusy,
  enterMainUi,
  escapeGate,
  activePin,
  gatePhase,
  gateVisible,
  install,
  installOutput,
  loadNodePlan,
  loadWizard,
  runNodeInstall,
  selectViewedStep,
  clearViewedStep,
  skipStep,
  stopNodeInstall,
  viewedStepId,
  wizard,
  wizardError,
} from '../lib/env-wizard.js';
import { advanceNotice, canViewStep } from '../lib/wizard-view.js';
import { currentTab, settings } from '../lib/store.js';
import type {
  EnvCheck,
  EnvCheckId,
  EnvCheckStatus,
  EnvFixAction,
  EnvFixPlan,
  EnvFixPhase,
  EnvInstallPhase,
  EnvInstallState,
  EnvNodeChannel,
  EnvNodeMethod,
  EnvNodeMode,
  EnvNodeOwner,
  EnvNodePlan,
  EnvStepStatus,
  EnvWizardStep,
  EnvWizardStepId,
} from '../../shared/ipc.js';

const api = window.dshConsole;

/** 官方下载页：装不上 / 不想让我们装时的出路（本应用改动为零） */
const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download';

/** 后台忙时的统一说明：与被禁用的按钮成对出现，禁用必须看得到原因（交互 §2.9 / §11.6） */
const BUSY_HINT = '正在执行上一步的操作，完成后按钮会自动恢复';

const STEP_LABELS: Record<EnvWizardStepId, string> = {
  node: '第一步',
  pnpm: '第二步',
  dsh: '第三步',
};

const STEP_TITLES: Record<EnvWizardStepId, string> = {
  node: '安装 Node.js',
  pnpm: '安装 pnpm',
  dsh: '安装 dsh',
};

const STEP_CARD_TITLES: Record<EnvWizardStepId, string> = {
  node: '第一步：安装 Node.js',
  pnpm: '第二步：安装 pnpm',
  dsh: '第三步：安装 dsh',
};

const STEP_WHY: Record<EnvWizardStepId, string> = {
  node: '没有它 dsh 起不来，也无法安装后面的东西',
  pnpm: '装插件、卸插件、升级插件都要用它',
  dsh: 'dsh 是 DSH Console 要启动的服务本体；没有它界面里什么都做不了',
};

const CHECK_TITLES: Record<EnvCheckId, string> = {
  node: '外部 Node',
  'node-version': 'Node 版本',
  npm: 'npm',
  pnpm: 'pnpm',
  dsh: 'dsh 本体',
  'dsh-run': 'dsh 能不能跑',
  'bundled-runtime': '应用自带运行时',
  shell: '本地 Shell',
};

/** 事实行的结论词：三种既有状态 + 两个"不是状态"的态（视觉 §6.1 的五个词逐字照用） */
const FACT_STATUS_WORDS: Record<EnvCheckStatus | 'skipped' | 'unknown', string> = {
  ok: '正常',
  warn: '需要注意',
  missing: '不可用',
  skipped: '已跳过',
  unknown: '没测出来',
};

const STEP_STATE_WORDS: Record<EnvStepStatus, string> = {
  done: '已完成',
  todo: '待办',
  skipped: '已跳过',
  unknown: '没测出来',
};

/** 事实行的灯：三种既有的自检状态 + 两个"不是状态"的态（见视觉 §6.1） */
type FactStatus = EnvCheckStatus | 'skipped' | 'unknown';

/**
 * 「这份 Node 是谁管的」这一件事实**只由主进程给**（需求 §7.7 的纯函数），
 * 这一层按它决定选择区长什么样 —— 判得出归属时只给一条路、判不出来时不预选（§7.8 那张表）。
 */
type MethodArea = 'fact-nvm' | 'fact-system' | 'choose' | 'choose-fresh';

/**
 * 选择区里"方法"那一块的事实行（逐字来自交互 §4.1 的 t29 修订 4-a；`choose-fresh` 那一支见 4-c）。
 * **`choose-fresh` 故意不在表里**：它的事实行要按"这台机器上有没有版本管理器"分两种说法，
 * 所以由 `methodFact` 现算 —— 见下面的 computed。
 */
const METHOD_FACTS: Record<Exclude<MethodArea, 'choose-fresh'>, string> = {
  'fact-nvm': '这份 Node 是版本管理器（nvm）管的，所以我们也用它来装 / 换。',
  'fact-system': '这份 Node 是官方安装包装的，所以我们也用官方安装包把它换到同一个位置。',
  choose: '我们认不出这个 Node 是怎么装的。',
};

/** 档位控件的两个选项（与 §4.1 第 4-b 条逐字一致：不用 `LTS` 这类术语） */
const CHANNEL_OPTIONS: { id: EnvNodeChannel; title: string; note: string }[] = [
  { id: 'lts', title: '最新稳定版', note: '发布更久、坑更少。' },
  { id: 'current', title: '最新当前版', note: '追最新特性，可能还没进入稳定期。' },
];

/** 两条安装路（§4.1 的说明行逐字照用）；归属判不出来时这两条各带一句并存风险 */
const METHOD_OPTIONS: { id: EnvNodeMethod; title: string; note: string }[] = [
  {
    id: 'direct',
    title: '直接安装官方版本（会问一次管理员权限）',
    note: '官方安装包，装到系统的默认位置；这台电脑上原来的 Node 会被换成这个版本。',
  },
  {
    id: 'nvm',
    title: '用版本管理器安装（不用管理员权限，可以装多个版本）',
    note: '先装一个版本管理器（nvm），再用它装 Node；不会动系统里原有的 Node，之后可以随时切换版本。',
  },
];

/** 档位词（事实行与「版本档位」那一行用它） */
const CHANNEL_TITLES: Record<EnvNodeChannel, string> = {
  lts: '最新稳定版',
  current: '最新当前版',
};

/** 档位短词（并排显示与换档句用它） */
const CHANNEL_SHORT: Record<EnvNodeChannel, string> = { lts: '稳定版', current: '当前版' };

/** 用户**显式点名**的方法与这份 Node 的归属不一致时，确认区必须带这句并存风险
 *  （需求 §7.8 的三个例外 / §7.9 第 4 条：原句里"哪一份生效"说成系统查找路径） */
const METHOD_RISK =
  '这样这台电脑上会有两份 Node：一份是原来的（不会被删掉），一份是这次装的。之后哪一份生效，看系统查找路径里谁在前。';

interface FactRow {
  key: string;
  title: string;
  detail: string;
  status: FactStatus;
}

interface QueueRow {
  id: EnvWizardStepId;
  step: string;
  title: string;
  word: string;
  /** 左轨节点的形态（视觉 §4.3 的五态 + 两个当前态） */
  state: string;
  /** 放行页三行成果用的原始状态 */
  status: EnvStepStatus;
  /** 能不能点开看（t43 / R-28：走过的步骤可以） */
  viewable: boolean;
  /** 正文现在画的是不是它（`aria-current`） */
  viewed: boolean;
}

/** 安装通道里"还在跑"的相位 */
const INSTALL_BUSY_PHASES: EnvInstallPhase[] = [
  'preparing',
  'downloading',
  'verifying',
  'installing',
  'waiting',
  'rechecking',
];

function installRunning(state: EnvInstallState): boolean {
  return !state.detached && INSTALL_BUSY_PHASES.includes(state.phase);
}

/** 有终态结论了：跑完 / 取消 / 失败，或用户"不再等待"（`detached` 时不给成功也不给失败） */
function installSettled(state: EnvInstallState): boolean {
  return (
    state.detached ||
    state.phase === 'done' ||
    state.phase === 'cancelled' ||
    state.phase === 'error'
  );
}

function isFixSettled(phase: EnvFixPhase): boolean {
  return phase === 'done' || phase === 'cancelled' || phase === 'error';
}

// ------------------------------------------------------------ 界面状态

/** 展开着详情的那一步（一次只开一个） */
const detailsFor = ref<EnvWizardStepId | null>(null);
/** 流式输出默认收起（与既有的"一键修复"同一种形状） */
const outputOpen = ref(false);

/** 用户**显式点名**的那条路（只在三个例外里给值：归属判不出来、拒绝管理员权限之后、提权态下
 *  nvm 不可用）；`null` = 省略方法字段 = **跟随这份 Node 的真实归属**（需求 §7.8）。
 *  机器上有没有版本管理器、这份 Node 归谁管，都不是这一层判的 —— 读主进程给的事实。 */
const nodeMethod = ref<EnvNodeMethod | null>(null);
/** 目标档位：默认「最新稳定版」（设计规定，§4.2）；**只有用户动过控件**才把它递回去（那才是换档） */
const nodeChannel = ref<EnvNodeChannel>('lts');
const channelPicked = ref(false);
/** Node 的确认区挂在哪个步骤的卡里：'node' = 第一步；'dsh' = 第三步的「换一个 Node」 */
const nodeHost = ref<'node' | 'dsh'>('node');
const nodeConfirmOpen = ref(false);
const nodePlan = ref<EnvNodePlan | null>(null);
const planLoading = ref(false);
const planDetailsOpen = ref(false);
/**
 * 需要用户明确确认一次的两种场合（视觉 §6.3：这两种场合不出现主按钮、安全的一侧在左）：
 *   - `unsigned`：**发布元数据自己说这个构建未签名**（nvm 那条路；
 *     注意 `signer === null` 不是这个信号 —— 它只表示"还没读到"，Authenticode 必须读文件）；
 *   - `unverified`：拿不到官方校验值，这次没法核对完整性。
 * 两种同时成立时按 `unsigned` 处理（它更需要一次明确的"我知道"），两条提示都会显示。
 */
const decision = ref<'unverified' | 'unsigned' | null>(null);

/** 一键修复（pnpm / dsh）的确认区 */
const fixConfirmAction = ref<EnvFixAction | null>(null);
/** 「先跳过这一步」的二次确认 */
const skipConfirmOpen = ref(false);
/** 这一步在跑哪条通道：决定"进行中"与"结果行"读哪一份状态 */
const activeFlow = ref<'node' | 'fix' | null>(null);

const escapeRef = ref<HTMLButtonElement | null>(null);
const primaryRef = ref<HTMLButtonElement | null>(null);
const startRef = ref<HTMLButtonElement | null>(null);
const enterRef = ref<HTMLButtonElement | null>(null);
const outputRef = ref<HTMLElement | null>(null);

/** 触发确认区的那个按钮：收起确认区时把焦点还给它（交互 §11.3） */
let confirmTrigger: HTMLElement | null = null;

// ------------------------------------------------------------ 判定结论（只读）

const steps = computed<EnvWizardStep[]>(() => wizard.value?.steps ?? []);
const currentStepId = computed<EnvWizardStepId | null>(() => wizard.value?.currentStepId ?? null);
const currentStep = computed<EnvWizardStep | null>(
  () => steps.value.find((step) => step.id === currentStepId.value) ?? null,
);
const warnCount = computed(() => wizard.value?.report.counts.warn ?? 0);
const pnpmSkipped = computed(() => (wizard.value?.skips ?? []).includes('pnpm'));

const checking = computed(() => gatePhase.value === 'checking' || gatePhase.value === 'idle');

// ------------------------------------------------ 视图相位：正在看哪一步（t43 / R-29 / R-30）

/** 正文画的那一步（钉住时是钉住的那一步，否则是判定的当前步骤） */
const viewStep = computed<EnvWizardStep | null>(
  () => steps.value.find((step) => step.id === viewedStepId.value) ?? null,
);

/** 是不是"回看"：正文画的不是判定的当前步骤 → 只读回看卡 */
const reviewStep = computed<EnvWizardStep | null>(() => {
  const id = viewedStepId.value;
  if (id === null || id === currentStepId.value) return null;
  return viewStep.value;
});

/** 钉住期间判定前进了 → 卡片上方那一行提示（R-30；没前进时为 null） */
const notice = computed(() =>
  advanceNotice(currentStepId.value, activePin.value, (id) => STEP_TITLES[id]),
);

/** 左轨节点：点它 = 回看（R-28）；点当前这一步 = 回来 */
function viewStepFromRail(id: EnvWizardStepId): void {
  if (busy.value) return;
  dismissAllConfirms();
  selectViewedStep(id);
}

/** 回看卡的主按钮 / 提示行的按钮：回到判定给出的当前步骤，并解除钉住（R-29 / R-30） */
function backToCurrent(): void {
  dismissAllConfirms();
  clearViewedStep();
  void nextTick(() => focusDefault());
}

/** 三块屏：检查中（报告还没回来）/ 挡住页 / 放行页。文案与结构见交互 §2.3 / §2.4 / §2.11
 *
 * 回看优先于放行（t43 / R-30）：钉住期间判定即使已经放行，正文也留在那张只读回看卡上 ——
 * 提示行会给「看看结果」，点了才进放行页。 */
const screen = computed<'checking' | 'blocked' | 'released'>(() => {
  const state = wizard.value;
  if (!state) return 'checking';
  if (reviewStep.value) return 'blocked';
  return state.gate === 'open' ? 'released' : 'blocked';
});

/** 全局忙位：既有一键修复（可能正在改全局 npm 包）+ 安装通道，加上"安装还在后台"（R-06） */
const busy = computed(() => anyoneBusy.value || envFix.value.phase === 'running');

// ------------------------------------------------------------ 当前步骤的通道

const nodeHere = computed(
  () => currentStepId.value !== null && nodeHost.value === currentStepId.value,
);
const stepFixAction = computed<EnvFixAction | null>(() => currentStep.value?.fixAction ?? null);
const fixActive = computed(
  () =>
    stepFixAction.value !== null &&
    envFix.value.action === stepFixAction.value &&
    envFix.value.phase !== 'idle',
);

/** Node 这条通道的进行中 / 结果（只在托它的那一步的卡里显示） */
const nodeRunning = computed(
  () => nodeHere.value && activeFlow.value === 'node' && installRunning(install.value),
);
const nodeSettled = computed(
  () =>
    nodeHere.value &&
    activeFlow.value === 'node' &&
    install.value.method !== null &&
    install.value.phase !== 'idle' &&
    installSettled(install.value),
);

/** 一键修复这条通道的进行中 / 结果（只在这一步自己的动作上显示） */
const fixRunning = computed(() => fixActive.value && envFix.value.phase === 'running');
const fixSettled = computed(() => fixActive.value && isFixSettled(envFix.value.phase));

const stepRunning = computed(() => nodeRunning.value || fixRunning.value);
const stepSettled = computed(() => nodeSettled.value || fixSettled.value);

// ------------------------------------------------------------ 左轨队列

const queue = computed<QueueRow[]>(() => {
  const id = currentStepId.value;
  return steps.value.map((step) => {
    const isCurrent = step.id === id;
    const running = isCurrent && stepRunning.value;
    let state: string;
    let word: string;
    if (running) {
      state = 'busy';
      word = '进行中';
    } else if (step.status === 'done') {
      state = 'done';
      word = STEP_STATE_WORDS.done;
    } else if (step.status === 'skipped') {
      state = 'skipped';
      word = STEP_STATE_WORDS.skipped;
    } else if (step.status === 'unknown') {
      state = isCurrent ? 'current-unknown' : 'unknown';
      word = STEP_STATE_WORDS.unknown;
    } else if (isCurrent) {
      state = 'current';
      word = STEP_STATE_WORDS.todo;
    } else {
      // 还没轮到、判定同为「待办」的步骤**不刷红**：这台机器什么都没装是事实，
      // 但把三步全刷成红色等于告诉用户"电脑坏透了"（视觉 §4.3）
      state = 'todo';
      word = '等上一步完成';
    }
    return {
      id: step.id,
      step: STEP_LABELS[step.id],
      title: STEP_TITLES[step.id],
      word,
      state,
      status: step.status,
      // 走过的节点可点（R-28）：正文切到它、画只读回看卡
      viewable: canViewStep(step, id),
      viewed: step.id === viewedStepId.value,
    };
  });
});

const railSubtitle = computed(() =>
  screen.value === 'released' ? '运行环境已就绪' : '运行环境准备',
);

/** 检查中不画步骤清单：那时还没有结论（交互 §2.3） */
const showQueue = computed(() => wizard.value !== null && screen.value !== 'checking');

// ------------------------------------------------------------ 当前步骤的事实

function checkOf(id: EnvCheckId): EnvCheck | null {
  return wizard.value?.report.checks.find((check) => check.id === id) ?? null;
}

function checksOfStep(step: EnvWizardStep): EnvCheck[] {
  return step.checkIds
    .map((id) => checkOf(id))
    .filter((check): check is EnvCheck => check !== null);
}

/** 一步的灯：有 `missing` 证据就是"不可用"；只有 `warn` 就是"需要注意"；
 *  `unknown` / `skipped` 两个"不是状态"的态单独走墨色（视觉 §6.1） */
function stepFactStatus(step: EnvWizardStep): FactStatus {
  if (step.status === 'unknown') return 'unknown';
  if (step.status === 'skipped') return 'skipped';
  const checks = checksOfStep(step);
  if (checks.some((check) => check.status === 'missing')) return 'missing';
  if (checks.some((check) => check.status === 'warn')) return 'warn';
  return 'ok';
}

const currentFacts = computed<FactRow[]>(() => {
  const step = currentStep.value;
  if (!step) return [];
  const rows: FactRow[] = [
    {
      key: step.id,
      title: CHECK_TITLES[step.id],
      detail: step.detail,
      status: stepFactStatus(step),
    },
  ];
  // 第三步的完成判据是两件事：找得到 dsh **并且**实测跑得动（交互 §6.3）
  if (step.id === 'dsh') {
    const run = checkOf('dsh-run');
    if (run) {
      rows.push({
        key: 'dsh-run',
        title: CHECK_TITLES['dsh-run'],
        detail: run.detail,
        status: run.status,
      });
    }
  }
  return rows;
});

const currentChecks = computed<EnvCheck[]>(() =>
  currentStep.value ? checksOfStep(currentStep.value) : [],
);

const npmMissing = computed(() => checkOf('npm')?.status === 'missing');

// ------------------------------------------------------------ 方法（跟随归属）与档位（显式换档）

/** 这台电脑上找到了一份 Node 吗（报告里 `node` 那一行不是"缺东西"） */
const nodeFound = computed(() => {
  const check = checkOf('node');
  return check !== null && check.status !== 'missing';
});

/**
 * 只在"归属判不出来、又一份 Node 都没找到"时才需要的那份事实：主进程的 `nvmPresent`
 * （这台机器上有没有一个可辨认的版本管理器 —— 它只在没有任何 Node 时参与默认，见需求 §7.7 第 3 条）。
 * `owner` / `nvmPresent` 都只有一个来源：主进程的计划。
 */
const defaultPlan = ref<EnvNodePlan | null>(null);
let defaultPlanSeq = 0;

async function loadDefaultPlan(): Promise<void> {
  const seq = (defaultPlanSeq += 1);
  const state = wizard.value;
  const needProbe =
    state !== null &&
    state.currentStepId === 'node' &&
    state.report.nodeOwner === 'unknown' &&
    !nodeFound.value &&
    !busy.value;
  if (!needProbe) {
    defaultPlan.value = null;
    return;
  }
  const plan = await loadNodePlan({ mode: 'install' });
  if (seq !== defaultPlanSeq) return;
  defaultPlan.value = plan;
}

/** 一份 Node 都没有时的默认方法（**只是默认**，用户随时能改成另一条） */
const freshDefaultMethod = computed<EnvNodeMethod>(() =>
  defaultPlan.value?.nvmPresent ? 'nvm' : 'direct',
);

/**
 * 选择区的"方法"那一块该长什么样：
 *   - 判得出归属（`nvm` / `system`）→ 只给一条路，只说出方法（更新时不许偷偷换方法，见 VM-14）；
 *   - 有一份 Node 但归属判不出来 → 两条路都列、**一条都不预选**；
 *   - **一份 Node 都没有 → 也把两条路都列出来让用户选**（VM-16：安装本来就该让用户挑直接装还是用版本管理器），
 *     只是给一个**有事实支撑**的默认（机器上已有可辨认的版本管理器就用它，否则官方安装包）。
 */
const methodArea = computed<MethodArea>(() => {
  const owner: EnvNodeOwner = wizard.value?.report.nodeOwner ?? 'unknown';
  if (owner === 'nvm') return 'fact-nvm';
  if (owner === 'system') return 'fact-system';
  return nodeFound.value ? 'choose' : 'choose-fresh';
});

/** 事实行：`choose-fresh` 那一支要按"这台机器上有没有版本管理器"分两种说法，且写出的是**方法**（不只是档位） */
const methodFact = computed(() => {
  if (methodArea.value !== 'choose-fresh') return METHOD_FACTS[methodArea.value];
  return freshDefaultMethod.value === 'nvm'
    ? '这台电脑上还没有 Node，但已经装了一个版本管理器（nvm）：默认用它装，之后可以随时切换版本。也可以改用官方安装包（会问一次管理员权限，装到系统默认位置）。'
    : '这台电脑上还没有 Node：默认用官方安装包装到系统默认位置。也可以改用版本管理器（不用管理员权限、可以装多个版本）。';
});

/** 两条路都列出来让用户选：找到了一份 Node 但归属判不出来 / 一份 Node 都没有 */
const methodChoosable = computed(
  () => methodArea.value === 'choose' || methodArea.value === 'choose-fresh',
);
/** 选择区里显示为"选中"的那一条：用户点过就用他的；没点过时**只有全新安装那一支给默认** */
const effectiveMethod = computed<EnvNodeMethod | null>(() => {
  if (nodeMethod.value !== null) return nodeMethod.value;
  return methodArea.value === 'choose-fresh' ? freshDefaultMethod.value : null;
});
/** 一条都没选中才算"要用户先选"（全新安装那一支有默认，所以不拦） */
const methodNeedsPick = computed(() => methodChoosable.value && effectiveMethod.value === null);
/** 并存风险只属于"已经有一份 Node、又选了另一条路"：全新安装是这台机器上的第一份，没有两份可撞 */
const methodRiskShown = computed(() => methodArea.value === 'choose');

/** 这次递回去的选择：方法只在用户显式点名时给，档位只在用户动过控件时给（其余一律跟随） */
function nodeInstallRequest(): {
  mode: EnvNodeMode;
  method?: EnvNodeMethod;
  channel?: EnvNodeChannel;
} {
  const request: { mode: EnvNodeMode; method?: EnvNodeMethod; channel?: EnvNodeChannel } = {
    mode: 'install',
  };
  if (nodeMethod.value) request.method = nodeMethod.value;
  if (channelPicked.value) request.channel = nodeChannel.value;
  return request;
}

/** 「版本（档位）」的人话：档位判不出来时写**档位未知**，不许省略、不许猜 */
function versionWithChannel(version: string | null, channel: EnvNodeChannel | null): string {
  const word = channel ? CHANNEL_SHORT[channel] : '档位未知';
  return version ? `${version}（${word}）` : `版本没测到（${word}）`;
}

const ownerRowText = computed(() => {
  const owner = nodePlan.value?.owner ?? wizard.value?.report.nodeOwner ?? 'unknown';
  if (owner === 'nvm') return '版本管理器（nvm）管的';
  if (owner === 'system') return '官方安装包装的';
  return nodeFound.value ? '我们认不出这个 Node 是怎么装的。' : '这台电脑上还没有 Node。';
});

/** 「版本档位」那一行：值与选择区那个控件是同一个。档位没定下来时**不许**写出目标版本号 */
const channelRowText = computed(() => {
  const word = CHANNEL_TITLES[nodeChannel.value];
  const plan = nodePlan.value;
  if (!plan || plan.needChoice !== null) return word;
  return `${word}（${plan.version}）`;
});

/** 换档说明：目标档与当前档不同就得说成换档；目标更低时写出「降到」（需求 §8.5 第 4 条） */
const channelSwitchNotice = computed(() => {
  const plan = nodePlan.value;
  if (!plan || !plan.switchesChannel) return '';
  const target = CHANNEL_SHORT[plan.channel];
  const before = plan.currentVersion ?? '（没测到）';
  if (plan.direction === 'older') {
    return `这会把现在这份 Node 换成${target}，版本从 ${before} 降到 ${plan.version}。`;
  }
  const from = plan.currentChannel ? CHANNEL_SHORT[plan.currentChannel] : '判不出来';
  return `版本会从 ${before} 变成 ${plan.version}，档位从${from}换到${target}。`;
});

/** 用户显式点名的方法与这份 Node 的归属不一致 = 会多出一份 Node：确认区必须写清后果 */
const showsMethodRisk = computed(() => {
  const plan = nodePlan.value;
  const method = nodeMethod.value;
  if (!plan || method === null) return false;
  if (plan.owner === 'system') return method === 'nvm';
  if (plan.owner === 'nvm') return method === 'direct';
  return false;
});

const elevationText = computed(() => {
  const plan = nodePlan.value;
  if (plan && plan.needsElevation) {
    return '需要 —— 接下来 Windows 会问你一次是否允许安装（管理员权限）';
  }
  return '不需要';
});

/** 用户设置过的安装源（只在确认区里说明，不静默替换） */
const configuredSourceHost = computed(() => {
  const raw = settings.value.envNodeSource;
  if (!raw) return '';
  try {
    return new URL(raw).host;
  } catch {
    return '';
  }
});

const fixSourceText = computed(() =>
  configuredSourceHost.value
    ? `本次使用你设置的安装源：${configuredSourceHost.value}`
    : '默认是系统 npm 配置',
);

const fixConfirmPlan = computed<EnvFixPlan | null>(() => {
  const action = fixConfirmAction.value;
  if (!action) return null;
  return wizard.value?.report.plans.find((plan) => plan.action === action) ?? null;
});

// ------------------------------------------------------------ 进行中

const progressText = computed(() => {
  if (fixRunning.value) {
    return currentStepId.value === 'dsh' ? '正在安装 dsh…' : '正在安装 pnpm…';
  }
  const state = install.value;
  // 主进程给的 `message` 本来就是一句自足的状态行（例如「正在下载 Node.js v24.21.0…42%」），
  // 有就照它显示；没有时才按相位拼一句。百分比只来自 `percent`，**不往文案里再补一个**。
  if (state.message) return state.message;
  switch (state.phase) {
    case 'preparing':
      return '正在准备下载…';
    case 'downloading':
      return '正在下载 Node.js…';
    case 'verifying':
      return '正在校验安装包完整性';
    case 'installing':
      return '正在安装 Node.js';
    case 'waiting':
      return '正在等待安装程序';
    case 'rechecking':
      return '正在重新检测';
    default:
      return '';
  }
});

/** 只在能算的时候给百分比；校验阶段**不画**进度条（交互 §7.5：算不出来就不画） */
const progressPercent = computed<number | null>(() => {
  if (fixRunning.value) return null;
  if (install.value.phase !== 'downloading') return null;
  return install.value.percent;
});

const progressBytes = computed(() => {
  if (fixRunning.value) return '';
  if (install.value.phase !== 'downloading') return '';
  const bytes = install.value.bytes;
  if (!bytes) return '';
  return `${formatBytes(bytes.downloaded)} / ${formatBytes(bytes.total)}`;
});

const progressNotice = computed(() => {
  if (fixRunning.value) return '';
  if (install.value.phase === 'waiting') {
    return '接下来 Windows 会问你一次是否允许安装（管理员权限）。按它的提示选择就好。安装已经在进行，这里只能停止等待，不会去停止安装。装完之后点「重新检测」看结果。';
  }
  if (install.value.phase === 'installing') {
    return '安装已经在进行，这里只能停止等待，不会去停止安装。装完之后点「重新检测」看结果。';
  }
  return '';
});

const stopLabel = computed(() => {
  if (fixRunning.value) return '中断';
  const phase = install.value.phase;
  if (phase === 'installing' || phase === 'waiting') return '不再等待（安装可能还在后台进行）';
  if (phase === 'verifying') return '取消';
  return '取消下载';
});

/** 复检中**没有按钮**（交互 §7.1 的那一行）；其余进行中的相位都有一个明确的按钮 */
const stopVisible = computed(() => {
  if (fixRunning.value) return true;
  if (!nodeRunning.value) return false;
  const state = install.value;
  return state.cancellable || state.phase === 'installing' || state.phase === 'waiting';
});

// ------------------------------------------------------------ 结果行

/** 管理员权限询问的三种结果：拒绝（1223 / 5）/ 取消（1602）/ 认不出来就只说"没完成" */
type NodeOutcome = 'done' | 'detached' | 'refused' | 'failed';

const nodeOutcome = computed<NodeOutcome>(() => {
  const state = install.value;
  if (state.detached) return 'detached';
  if (state.phase === 'done') return 'done';
  if (state.code === 1223 || state.code === 5) return 'refused';
  return 'failed';
});

const fixOutcome = computed<EnvFixPhase>(() => envFix.value.phase);

const resultDot = computed(() => {
  if (activeFlow.value === 'node') {
    if (nodeOutcome.value === 'done') return 'ok';
    if (nodeOutcome.value === 'detached') return 'unknown';
    return 'failed';
  }
  if (fixOutcome.value === 'done') return 'ok';
  return 'failed';
});

/** 结论句：主进程给的 `message` 优先（它是那句"人话"），拿不到时才用交互规格钉住的措辞 */
const resultTitle = computed(() => {
  if (activeFlow.value === 'node') {
    const message = install.value.message;
    if (message) return message;
    switch (nodeOutcome.value) {
      case 'done':
        return 'Node.js 装好了，这一项已经变成「正常」。';
      case 'detached':
        return '我们不等了：安装可能还在后台进行，请按它自己的提示把它做完，做完点「重新检测」。';
      case 'refused':
        return '你拒绝了管理员权限，这台电脑上什么都没改。';
      default:
        return '安装没有完成，这台电脑上什么都没改。';
    }
  }
  const message = envFix.value.message;
  if (message) return message;
  if (fixOutcome.value === 'done') {
    return envFix.value.action === 'install-dsh'
      ? 'dsh 装好了，并且在这台电脑上跑得起来。'
      : 'pnpm 装好了，插件页的装 / 卸 / 升级现在可以用了。';
  }
  return '安装没有完成，这台电脑上什么都没改。';
});

/** 结论句之下那句说明：复检结论 / 复检事实（"什么都没改"这句话必须由复检支撑） */
const resultNote = computed(() => {
  if (activeFlow.value !== 'node') return recheckNote(envFix.value.report?.checks ?? null);
  const outcome = nodeOutcome.value;
  if (outcome === 'done') {
    return '其它已经打开的终端窗口需要重开一次，才会用上新装的 Node。';
  }
  const report = install.value.report;
  const fact = report ? recheckNote(report.checks) : '';
  if (outcome === 'detached') {
    return fact ? `${fact} 装完之后点「重新检测」看结果。` : '装完之后点「重新检测」看结果。';
  }
  return fact;
});

/** 复检里和当前步骤有关的那几行原文（界面不解析、不归纳，照贴） */
function recheckNote(checks: EnvCheck[] | null): string {
  const step = currentStep.value;
  if (!checks || !step) return '';
  const rows = checks.filter((check) => step.checkIds.includes(check.id));
  if (rows.length === 0) return '';
  return `这一轮检查：${rows.map((check) => check.detail).join(' ')}`;
}

// ------------------------------------------------------------ 动作

function say(message: string): void {
  window.dispatchEvent(new CustomEvent('dsh:status-message', { detail: message }));
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    say('已复制到剪贴板');
  } catch {
    say('复制失败，请手动选中这一行');
  }
}

function rememberTrigger(): void {
  const active = document.activeElement;
  confirmTrigger = active instanceof HTMLElement ? active : null;
}

function focusBack(): void {
  const target = confirmTrigger;
  confirmTrigger = null;
  if (target && document.contains(target)) {
    target.focus();
    return;
  }
  void focusDefault();
}

async function focusDefault(): Promise<void> {
  await nextTick();
  if (stepRunning.value || stepSettled.value) return;
  if (nodeConfirmOpen.value || fixConfirmAction.value !== null || skipConfirmOpen.value) {
    startRef.value?.focus();
    return;
  }
  if (screen.value === 'released') {
    enterRef.value?.focus();
    return;
  }
  if (screen.value === 'checking') {
    escapeRef.value?.focus();
    return;
  }
  primaryRef.value?.focus();
}

/** 逃生口：收起门禁层 —— 不写盘、不改判定、不依赖任何安装动作成功（冻结 §1 R-16） */
function escape(): void {
  escapeGate();
}

/** 放行页的主按钮：收起门禁层，走阶段一的正常流程（自动启动由 app.ts 负责） */
function enter(): void {
  enterMainUi();
}

/**
 * 收起门禁层之前先把展开着的东西收掉：留着的话，用户从横幅回到向导时会看到
 * 上一次那份确认区（里面还有旧的来源 / 计划），那正是"界面记着我们已经放弃的决定"。
 */
function dismissAllConfirms(): void {
  nodeConfirmOpen.value = false;
  fixConfirmAction.value = null;
  skipConfirmOpen.value = false;
  planDetailsOpen.value = false;
  decision.value = null;
}

/** 「再看看环境自检」/「去环境自检看详情」：收起门禁层并切到左栏第 8 项 */
function openEnvPane(): void {
  dismissAllConfirms();
  escapeGate();
  currentTab.value = 'env';
}

/** 「在设置里写死一条能跑的启动命令」：既有出路（设置页的 dshCommand） */
function openSettings(): void {
  dismissAllConfirms();
  escapeGate();
  currentTab.value = 'settings';
}

function refresh(): void {
  if (busy.value) return;
  // 请主进程清缓存重跑一轮；门禁层不收起、结论区自己标成"检查中"（交互 §2.9）
  void loadWizard({ refresh: true });
}

async function openDownloadPage(): Promise<void> {
  await api.openExternal(NODE_DOWNLOAD_URL);
}

/** 换一个下载源：把用户送进自检页那张来源控件（不静默换源，只能由用户改） */
function openSourcePanel(): void {
  dismissAllConfirms();
  escapeGate();
  currentTab.value = 'env';
  say('在「安装下载来源」里填一个新的地址，保存之后回来重新检测');
}

// ------------------------------------------------------------ 步骤 1：两条路与确认区

function pickMethod(method: EnvNodeMethod): void {
  if (busy.value) return;
  nodeMethod.value = method;
  // 换路只是换一份确认区的内容，不动任何东西（交互 §4.2：开始之前随时能改主意）
  if (nodeConfirmOpen.value) void loadPlan();
}

function openNodeConfirm(): void {
  if (busy.value) return;
  rememberTrigger();
  nodeHost.value = currentStepId.value === 'dsh' ? 'dsh' : 'node';
  activeFlow.value = null;
  fixConfirmAction.value = null;
  skipConfirmOpen.value = false;
  nodeConfirmOpen.value = true;
  void loadPlan();
}

function closeNodeConfirm(): void {
  nodeConfirmOpen.value = false;
  planDetailsOpen.value = false;
  decision.value = null;
  focusBack();
}

async function loadPlan(): Promise<void> {
  planLoading.value = true;
  planDetailsOpen.value = false;
  const plan = await loadNodePlan(nodeInstallRequest());
  nodePlan.value = plan;
  planLoading.value = false;
  // 只有"发布元数据自己说未签名"才允许在计划阶段提一次未签名（船长裁定）；
  // `sha256 === null` 那条仍然有效（拿不到官方校验值 → 换源 / 仍然继续）。
  decision.value = decideFor(plan);
}

function decideFor(plan: EnvNodePlan | null): 'unverified' | 'unsigned' | null {
  if (!plan || !plan.usable) return null;
  // 这次没有任何东西要下载（归属 = 版本管理器、机器上已经有它）：没有完整性要确认
  // （那次确认只由 `sha256 === null && installsManager` 触发，见冻结 §3.2.1 的 `installsManager`）
  if (!plan.installsManager) return null;
  if (plan.releaseSigning === 'unsigned') return 'unsigned';
  if (plan.sha256 === null) return 'unverified';
  return null;
}

/** 档位控件：稳定版 / 当前版两档之一（冻结 §1 R-10 不做任意版本选择器）。
 *  用户**动过**控件才把档位递回去 —— 那才是「换档」；不动就是"跟随设计默认" */
function pickChannel(channel: EnvNodeChannel): void {
  if (busy.value) return;
  if (channelPicked.value && nodeChannel.value === channel) return;
  nodeChannel.value = channel;
  channelPicked.value = true;
  if (nodeConfirmOpen.value) void loadPlan();
}

async function startNode(): Promise<void> {
  // 先取下来：收起确认区之后就按这份选择跑（地址与校验值仍由主进程现场重算，冻结 §3.8 第 18 条）
  const request = nodeInstallRequest();
  nodeConfirmOpen.value = false;
  planDetailsOpen.value = false;
  decision.value = null;
  outputOpen.value = false;
  activeFlow.value = 'node';
  await runNodeInstall(request);
}

/** 拒绝管理员权限之后的替代出路：用户**显式点名**走版本管理器（需求 §7.8 例外 2）——
 *  这是"会在机器上多出一份 Node"的选择，确认区会带上那句并存风险。 */
function switchToNvm(): void {
  nodeMethod.value = 'nvm';
  openNodeConfirm();
}

/** 提权态下 nvm 那条路不可用时的替代出路：用户**显式点名**走官方安装包（需求 §7.8 例外 3） */
function useDirectInstead(): void {
  nodeMethod.value = 'direct';
  void loadPlan();
}

/** 第三步的「换一个 Node」：同一条通道，方法同样**跟随这份 Node 的真实归属**
 *  （冻结 §1.2 R-09 的 t29 标注取代了原文那句"固定走 nvm"） */
function openNodeSwitch(): void {
  openNodeConfirm();
}

/** 「我确认安装已经结束」：再调一次 `envNodeStop()` —— 主进程把它实现成
 *  "解除等待 + 立刻复检"，结论与互斥锁都由事实说话（冻结 §1 R-06 的第三个解除条件）。 */
function confirmInstallFinished(): void {
  void stopNodeInstall();
}

function retryNode(): void {
  openNodeConfirm();
}

async function stop(): Promise<void> {
  if (fixRunning.value) {
    await cancelEnvFix();
    return;
  }
  await stopNodeInstall();
}

// ------------------------------------------------------------ 步骤 2 / 3：一键修复

function openFixConfirm(action: EnvFixAction): void {
  if (busy.value) return;
  rememberTrigger();
  fixConfirmAction.value = action;
  nodeConfirmOpen.value = false;
  skipConfirmOpen.value = false;
  activeFlow.value = null;
}

function closeFixConfirm(): void {
  fixConfirmAction.value = null;
  focusBack();
}

async function startFix(): Promise<void> {
  const action = fixConfirmAction.value;
  if (!action) return;
  fixConfirmAction.value = null;
  clearEnvFixOutput();
  outputOpen.value = true;
  activeFlow.value = 'fix';
  await runEnvFix(action);
}

function retryFix(): void {
  if (stepFixAction.value) openFixConfirm(stepFixAction.value);
}

function openSkipConfirm(): void {
  if (busy.value) return;
  rememberTrigger();
  skipConfirmOpen.value = true;
  fixConfirmAction.value = null;
  nodeConfirmOpen.value = false;
}

function closeSkipConfirm(): void {
  skipConfirmOpen.value = false;
  focusBack();
}

async function confirmSkip(): Promise<void> {
  skipConfirmOpen.value = false;
  // 跳过是持久化的设置写入，但渲染层只调这一条路，不碰 patchSettings（冻结 §1 R-16）
  await skipStep('pnpm', true);
}

// ------------------------------------------------------------ 详情 / 输出

function toggleDetails(id: EnvWizardStepId): void {
  detailsFor.value = detailsFor.value === id ? null : id;
}

function toggleOutput(): void {
  outputOpen.value = !outputOpen.value;
}

/** 字节说成人话（只在进度行里用；两个数缺一个就整行不出现） */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

const outputCommand = computed(() => {
  if (activeFlow.value === 'fix') return envFix.value.command || '（命令由主进程现算）';
  const plan = nodePlan.value;
  return plan ? plan.display : '（下载与安装由主进程执行）';
});

const outputText = computed(() =>
  activeFlow.value === 'fix' ? envFixOutput.value : installOutput.value,
);

const outputState = computed(() => {
  if (stepRunning.value) return 'running';
  return resultDot.value === 'ok' ? 'done' : 'error';
});

const outputSummary = computed(() => (stepSettled.value ? resultTitle.value : ''));

// ------------------------------------------------------------ 焦点、Esc 与背景不可交互

/**
 * 背景不可聚焦（交互 §2.10）：门禁层显示期间，左栏、页面、状态栏里的可聚焦元素
 * 必须**真的不可达** —— 只"看起来灰了"但还能 Tab 到，键盘用户按下一步就消失了。
 * `inert` 在 Chromium 里同时管焦点与命中测试，收起时立刻撤销。
 */
function setBackgroundInert(on: boolean): void {
  for (const element of document.querySelectorAll('.rail, main, .statusbar')) {
    if (on) element.setAttribute('inert', '');
    else element.removeAttribute('inert');
  }
}

/**
 * 门禁层显示期间，让**应用自己左栏的内容整列**退场（finding VM-08 品牌块 + VM-10 服务状态块）。
 *
 * 为什么会有两行「DSH Console」：应用品牌在**顶栏那一行的高度**上（左栏是贯穿全高的整列，
 * 顶栏只属于 workspace 那一列），而门禁覆盖层按视觉 §3.1 是 `top: var(--bar-h)`
 * ～ 盖不到顶栏那一行，于是它与门禁左轨自己的品牌同时可见。
 *
 * 选了**让应用左栏这一侧退场**（而不是让门禁不画自己的左轨）：设计里那一行就是向导的 —— 视觉 §4.1
 * 写着门禁左轨"沿用既有左栏的品牌块"，副标题给的是门禁的状态（「运行环境准备」）；
 * 门禁层这条构图原则本身就是"这台应用把中段让给向导"（§2）。反过来保留应用品牌，
 * 等于把让位方向弄反（向导的标题反而不见了）。
 *
 * 只写一个 body 开关（与 `data-immersive` / `data-locked` 同一套做法，CSS 里那条
 * `body[data-gate-visible='true'] .rail > * { visibility: hidden }` 认它）：左栏宽度、
 * 位置、门禁覆盖层的几何一律不动；层一收起开关立刻回到 'false'，左栏整列内容当帧恢复。
 *
 * 为什么藏**整列**而不是"逐个藏露出来的那个"：门禁覆盖层从 `top: var(--bar-h)`（36px）起，
 * 应用左栏却是贯穿全列的整列 —— 凡是纵向落在 `0..var(--bar-h)` 的子元素都会露出来、被那条边
 * 裁掉一半（VM-08 的品牌块、VM-10 的服务状态块都是这么显形的）。逐个藏**不收敛**：藏掉品牌
 * 块，服务状态块就上移进那一条带；再藏服务块，第一个导航项又会移进来。按容器处理才对，而且
 * 以后往左栏顶部加任何东西都不会复发（判断依据与替代方案见文件头那一段）。
 */
function setAppBrandConceded(on: boolean): void {
  document.body.dataset.gateVisible = on ? 'true' : 'false';
}

function focusMainContent(): void {
  const main = document.querySelector<HTMLElement>('main');
  main?.focus();
}

/**
 * `Esc` 只退、不前进（交互 §0.4）。用**捕获阶段**接管：app.ts 里那条
 * "门禁可见时 Esc = 逃生"是给没有更具体规则的情况用的兜底，这里更具体，先说话。
 */
function onKeydown(event: KeyboardEvent): void {
  if (!gateVisible.value || event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();

  if (nodeConfirmOpen.value) {
    closeNodeConfirm();
    return;
  }
  if (fixConfirmAction.value !== null) {
    closeFixConfirm();
    return;
  }
  if (skipConfirmOpen.value) {
    closeSkipConfirm();
    return;
  }
  // 下载 / 校验中 = 取消下载（系统零改动）；安装阶段**什么都不做**（不杀安装器）
  if (nodeRunning.value && install.value.cancellable) {
    void stop();
    return;
  }
  if (stepRunning.value || stepSettled.value) return;
  escape();
}

/** 门禁层是否真的显示过：收起时只有"原本在屏幕上"才去动焦点（否则会抢启动锁的焦点） */
let shownOnce = false;

watch(
  gateVisible,
  async (on) => {
    if (on) {
      shownOnce = true;
      // 应用品牌让位（VM-08）与背景不可交互都要**在层画出来之前**就位，避免闪一下
      setAppBrandConceded(true);
      document.addEventListener('keydown', onKeydown, true);
      setBackgroundInert(true);
      await focusDefault();
      return;
    }
    setAppBrandConceded(false);
    document.removeEventListener('keydown', onKeydown, true);
    setBackgroundInert(false);
    if (!shownOnce) return;
    shownOnce = false;
    focusMainContent();
  },
  { immediate: true },
);

onUnmounted(() => {
  setAppBrandConceded(false);
  document.removeEventListener('keydown', onKeydown, true);
  setBackgroundInert(false);
});

/** 「重新检测」返回后焦点留在原地；步骤前进一步时焦点跟着走到新步骤的主操作 */
watch(currentStepId, (id) => {
  detailsFor.value = null;
  if (id === 'node') nodeHost.value = 'node';
  void focusDefault();
});

/**
 * 方法与档位**不记住上次的选择**（交互 §4.2 最后一条）：换一步、重开门禁，都回到设计的默认
 * （方法跟随归属、档位 = 最新稳定版）—— 两条路 / 两档对系统的改动不同，不替用户记。
 */
watch([currentStepId, gateVisible], () => {
  nodeMethod.value = null;
  nodeChannel.value = 'lts';
  channelPicked.value = false;
});

// 「一份 Node 都没找到 + 归属判不出来」时才需要一次只读的计划探测（拿 `nvmPresent` 那件事实）
watch([wizard, busy], () => void loadDefaultPlan(), { immediate: true });

watch(nodeConfirmOpen, (open) => {
  if (open) void nextTick(() => startRef.value?.focus());
});

watch(fixConfirmAction, (action) => {
  if (action) void nextTick(() => startRef.value?.focus());
});

// 输出区跟着新片段往下滚（与自检页同一套做法：原文照贴，不假装进度条）
watch([installOutput, envFixOutput], () => {
  void nextTick(() => {
    const box = outputRef.value;
    if (box) box.scrollTop = box.scrollHeight;
  });
});
</script>

<template>
  <div v-if="gateVisible" class="gate">
    <!-- 左轨：队列的唯一住所。节点不可聚焦、不可点，纯读数（视觉 §4.2） -->
    <aside class="gate-rail">
      <div class="gate-brand">
        <span class="gate-logo">DSH</span>
        <span class="gate-logo-sub">Console</span>
      </div>
      <div class="gate-brand-sub">{{ railSubtitle }}</div>
      <ul v-if="showQueue" class="gate-queue">
        <li
          v-for="item in queue"
          :key="item.id"
          class="gate-node"
          :data-state="item.state"
          :data-viewable="item.viewable ? 'true' : 'false'"
        >
          <span class="gate-node-spine" aria-hidden="true"></span>
          <span class="gate-node-dot" aria-hidden="true"></span>
          <!-- 走过的步骤是个真按钮（t43 / R-28）：进 Tab 顺序、Enter / Space 同鼠标 —— 这是
               「返回上一步」唯一的入口。没走到的仍然是纯读数（不进 Tab 顺序，保持 R-01 ② 的原意）。 -->
          <button
            v-if="item.viewable"
            type="button"
            class="gate-node-body gate-node-button"
            :aria-current="item.viewed ? 'true' : undefined"
            @click="viewStepFromRail(item.id)"
          >
            <span class="gate-node-step">{{ item.step }}</span>
            <span class="gate-node-title">{{ item.title }}</span>
            <span class="gate-node-state">{{ item.word }}</span>
            <span class="gate-node-back">↩ 回看这一步</span>
          </button>
          <div v-else class="gate-node-body">
            <span class="gate-node-step">{{ item.step }}</span>
            <span class="gate-node-title">{{ item.title }}</span>
            <span class="gate-node-state">{{ item.word }}</span>
          </div>
        </li>
      </ul>
    </aside>

    <div class="gate-body">
      <div class="gate-col">
        <!-- 检查中：报告还没回来的第一轮。不许空白（交互 §2.3）；
             探测自己失败 / 超时时也要说一句，别让用户对着一颗转圈的环等（逃生口仍在底条上） -->
        <div v-if="screen === 'checking'" class="gate-check">
          <span class="boot-spinner" aria-hidden="true"></span>
          <h2 class="gate-title">正在检查这台电脑上的运行环境</h2>
          <p class="gate-lead">大约几秒钟，不会改动任何东西</p>
          <p v-if="wizardError" class="wizard-notice">
            <b>上一轮检查没能完成。</b> {{ wizardError }}
          </p>
        </div>

        <!-- 放行页：原地变成结果页，不自动跳走（交互 §2.11） -->
        <template v-else-if="screen === 'released'">
          <h2 class="gate-title">运行环境已经就绪</h2>
          <p class="gate-lead">三步都完成了（可跳过的项按你的选择处理），现在可以进入了。</p>
          <div class="gate-done-list">
            <div
              v-for="item in queue"
              :key="item.id"
              class="gate-done-row"
              :data-status="item.status"
            >
              <span class="lamp"></span>
              <span class="gate-done-title">{{ item.title }}</span>
              <span class="gate-done-state">{{ item.word }}</span>
            </div>
          </div>
          <div class="btn-row gate-actions">
            <button ref="enterRef" class="btn primary" @click="enter">进入 DSH Console</button>
            <button class="btn" @click="openEnvPane">再看看环境自检</button>
          </div>
          <div v-if="pnpmSkipped" class="wizard-notice">
            pnpm 这一步你选择了跳过：插件页的装 / 卸 / 升级还用不了，以后可以回来补上。
          </div>
        </template>

        <!-- 挡住页：唯一的「前进」是底条上的逃生口（交互 §2.4） -->
        <template v-else>
          <h2 class="gate-title">
            {{ wizard?.gate === 'open' ? '运行环境已经就绪' : '运行环境还没准备好' }}
          </h2>
          <p class="gate-lead">
            {{
              wizard?.gate === 'open'
                ? '三步都完成了（可跳过的项按你的选择处理），现在可以进入了。'
                : '下面几步装好之后，就可以进入 DSH Console 了'
            }}
          </p>

          <!-- 钉住期间判定前进了：不把用户推走，只出这一行（t43 / R-30）。点它 = 回到当前 / 看结果 -->
          <div v-if="notice" class="gate-advance">
            <span>{{ notice.text }}</span>
            <span class="spacer"></span>
            <button class="btn tiny" @click="backToCurrent">{{ notice.action }} →</button>
          </div>

          <!-- 只读回看卡（t43 / R-29）：走过的步骤只给结论与读数，卡里没有任何安装 / 跳过动作 -->
          <div v-if="reviewStep" class="gate-card">
            <h3 class="gate-card-title">{{ STEP_CARD_TITLES[reviewStep.id] }}（回看）</h3>
            <p class="gate-card-done" :data-status="reviewStep.status">
              {{
                reviewStep.status === 'skipped'
                  ? '这一步你选择了跳过，不用再做什么'
                  : '这一步已经完成，不用再做什么'
              }}
            </p>
            <p class="gate-card-fact">{{ reviewStep.detail }}</p>
            <div class="btn-row gate-actions">
              <button ref="primaryRef" class="btn primary" @click="backToCurrent">
                回到当前步骤{{ currentStep ? `（${STEP_TITLES[currentStep.id]}）` : '（看结果）' }}
              </button>
            </div>
          </div>

          <div v-else-if="currentStep" class="gate-card">
            <h3 class="gate-card-title">{{ STEP_CARD_TITLES[currentStep.id] }}</h3>
            <p class="gate-card-why">{{ STEP_WHY[currentStep.id] }}</p>

            <!-- 选择区：步骤 1 的两条安装路径。开始之前随时能改；安装阶段同时不可用 -->
            <div v-if="currentStep.id === 'node'" class="gate-choice">
              <!-- 档位：与"方法"**同级**的选择区控件（可聚焦的两选一）。它在未展开确认区时就看得到，
                   不再藏在确认区里当一行小字按钮 —— 那正是 VM-15 的现场 -->
              <fieldset class="gate-choice-group">
                <legend class="gate-choice-legend">版本档位</legend>
                <div class="gate-choice-row">
                  <label
                    v-for="option in CHANNEL_OPTIONS"
                    :key="option.id"
                    class="gate-option gate-option-half"
                    :class="{ selected: nodeChannel === option.id }"
                  >
                    <input
                      type="radio"
                      name="wizard-node-channel"
                      :value="option.id"
                      :checked="nodeChannel === option.id"
                      :disabled="stepRunning || busy"
                      @change="pickChannel(option.id)"
                    />
                    <span class="gate-option-body">
                      <span class="gate-option-title">{{ option.title }}</span>
                      <span class="gate-option-note">{{ option.note }}</span>
                    </span>
                  </label>
                </div>
                <p class="gate-option-hint">
                  现在选的是：{{ CHANNEL_TITLES[nodeChannel] }}。装的是哪一档，看这里 ——
                  安装之前随时能改。
                </p>
              </fieldset>

              <!-- 方法：判得出归属就只给一条路；判不出来 / 一份 Node 都没有时两条路都列出来让用户选（需求 §7.8） -->
              <p class="gate-method-fact">{{ methodFact }}</p>
              <div v-if="methodChoosable" class="gate-choice-row">
                <label
                  v-for="option in METHOD_OPTIONS"
                  :key="option.id"
                  class="gate-option"
                  :class="{ selected: effectiveMethod === option.id }"
                >
                  <input
                    type="radio"
                    name="wizard-node-method"
                    :value="option.id"
                    :checked="effectiveMethod === option.id"
                    :disabled="stepRunning || busy"
                    @change="pickMethod(option.id)"
                  />
                  <span class="gate-option-body">
                    <span class="gate-option-title">{{ option.title }}</span>
                    <span class="gate-option-note">{{ option.note }}</span>
                    <span v-if="methodRiskShown" class="gate-option-risk">{{ METHOD_RISK }}</span>
                  </span>
                </label>
              </div>
              <!-- 这条禁用态必须看得到原因（交互 §11.6）：两条路一条都不预选，是用户自己选 -->
              <p v-if="methodNeedsPick" class="gate-option-hint">
                两条路都没有替你预选：请先在上面选一条安装方式，再点「安装」。
              </p>
              <!-- 装到一半不能换路：禁用必须看得到原因（交互 §4.2） -->
              <p v-if="stepRunning" class="gate-option-hint">正在安装，请等它结束</p>
            </div>

            <!-- 事实行：进行中时由进度区占同一个槽位（视觉 §5.5） -->
            <template v-if="!stepRunning">
              <div class="gate-facts">
                <div
                  v-for="row in currentFacts"
                  :key="row.key"
                  class="gate-fact"
                  :data-status="row.status"
                >
                  <span class="lamp"></span>
                  <div class="gate-fact-main">
                    <div class="gate-fact-head">
                      <span class="gate-fact-title">{{ row.title }}</span>
                      <span class="gate-fact-state">{{ FACT_STATUS_WORDS[row.status] }}</span>
                    </div>
                    <p class="gate-fact-detail">{{ row.detail }}</p>
                  </div>
                </div>
              </div>
            </template>

            <!-- 进行中：状态行 + 进度（能算才画）+ 一个明确的按钮 -->
            <div v-if="stepRunning" class="wizard-progress">
              <div class="wizard-progress-line">
                <span class="wizard-progress-dot" aria-hidden="true"></span>
                <span class="wizard-progress-text">{{ progressText }}</span>
              </div>
              <div v-if="progressPercent !== null" class="wizard-progress-track">
                <div class="wizard-progress-bar" :style="{ width: `${progressPercent}%` }"></div>
              </div>
              <p v-if="progressBytes" class="wizard-progress-bytes">{{ progressBytes }}</p>
              <p v-if="progressNotice" class="wizard-notice">{{ progressNotice }}</p>
              <div class="btn-row">
                <button v-if="stopVisible" class="btn small" @click="stop">{{ stopLabel }}</button>
                <button class="btn small ghost" @click="toggleOutput">显示详细输出</button>
              </div>
            </div>

            <!-- 步骤 2：npm 还不能用时不给一个注定失败的门（交互 §5.3） -->
            <template v-if="currentStep.id === 'pnpm' && npmMissing && !stepRunning">
              <p class="gate-card-why">这台电脑上的 npm 还不能用，所以没法替你装 pnpm。</p>
              <div class="gate-fact-more">
                <code class="gate-detail-cmd">corepack enable pnpm</code>
                <button class="btn tiny" @click="copy('corepack enable pnpm')">复制</button>
              </div>
            </template>

            <!-- 操作行：一屏只有一处强调色实底 -->
            <div v-if="!stepRunning && !stepSettled" class="btn-row gate-actions">
              <template v-if="currentStep.id === 'node'">
                <button
                  ref="primaryRef"
                  class="btn primary"
                  :disabled="busy || methodNeedsPick"
                  :title="
                    methodNeedsPick
                      ? '请先在「版本档位」下面选一条：直接安装官方版本 / 用版本管理器安装'
                      : busy
                        ? BUSY_HINT
                        : undefined
                  "
                  @click="openNodeConfirm"
                >
                  安装
                </button>
                <button class="btn" @click="openDownloadPage">我想自己去官网下载安装</button>
              </template>
              <template v-else-if="currentStep.id === 'pnpm'">
                <button
                  v-if="!npmMissing"
                  ref="primaryRef"
                  class="btn primary"
                  :disabled="busy"
                  :title="busy ? BUSY_HINT : undefined"
                  @click="openFixConfirm('install-pnpm')"
                >
                  安装
                </button>
                <button
                  class="btn"
                  :disabled="busy"
                  :title="busy ? BUSY_HINT : undefined"
                  @click="openSkipConfirm"
                >
                  先跳过这一步
                </button>
              </template>
              <template v-else>
                <button
                  ref="primaryRef"
                  class="btn primary"
                  :disabled="busy"
                  :title="busy ? BUSY_HINT : undefined"
                  @click="openFixConfirm('install-dsh')"
                >
                  安装
                </button>
              </template>
            </div>

            <p
              v-if="currentStep.id === 'pnpm' && !stepRunning && !stepSettled"
              class="gate-option-hint"
            >
              跳过之后，插件页的装 / 卸 / 升级仍然用不了（以后随时可以回来补上）。
            </p>

            <!-- 「展开看详情」排在两个操作**之后**：交互 §11.1 / §11.4 的 Tab 顺序是
                 单选项 → 主操作 → 次操作 → 展开详情 → 重新检测 → 逃生口。
                 它原来是跟在事实行后面的（视觉 §5.0 A 把展开器画在事实行右端），那会让它排在
                 两个操作之前 —— 评审 T11-C 指出的正是这条冲突。两份规格在这里只能满足一个：
                 交互给的是**逐项枚举**、视觉那里只是一张排布示意，所以按交互定稿（Tab 与它一致），
                 视觉上的代价是展开器不再画在事实行右端。若要改判回原位置，回退动作就是把这一个
                 `div.gate-fact-more` 移回上方事实行之后，并在 `docs/env-wizard-interaction.md`
                 §11.1 显式记下这次偏离（冻结 §9 的留痕规则）—— 两处都可查。 -->
            <div v-if="!stepRunning && currentChecks.length" class="gate-fact-more">
              <button class="btn tiny ghost" @click="toggleDetails(currentStep.id)">
                {{ detailsFor === currentStep.id ? '收起详情' : '展开看详情' }}
              </button>
              <dl v-if="detailsFor === currentStep.id" class="gate-detail">
                <div v-for="check in currentChecks" :key="check.id" class="gate-detail-row">
                  <dt class="gate-detail-key">{{ CHECK_TITLES[check.id] }}</dt>
                  <dd class="gate-detail-val">
                    {{ check.detail }}
                    <code v-if="check.fixHint" class="gate-detail-cmd">{{ check.fixHint }}</code>
                  </dd>
                </div>
              </dl>
            </div>

            <!-- 确认区：原地展开，不弹原生对话框、不跳页（交互 §3.2） -->
            <div v-if="nodeConfirmOpen" class="gate-confirm">
              <div class="gate-confirm-title">将要执行</div>
              <!-- 只在"还没有计划"时用加载行占位：换档重算时留着上面那份计划，
                   免得整块内容闪一下 -->
              <p v-if="planLoading && !nodePlan" class="gate-confirm-loading">
                正在取这次的下载信息…
              </p>
              <template v-else-if="nodePlan">
                <p v-if="planLoading" class="gate-confirm-loading">正在按新的档位重算…</p>
                <!-- 归属 = 版本管理器、机器上已经有它：这次**没有任何东西要下载**（需求 §7.8） -->
                <code v-if="nodePlan.installsManager" class="gate-confirm-cmd">{{
                  nodePlan.display
                }}</code>
                <p v-else class="gate-confirm-loading">
                  这次不用下载安装包：让版本管理器自己装 Node.js {{ nodePlan.version }}。
                </p>

                <!-- 「当前版本（档位） → 目标版本（档位）」并排（需求 §8.2 / §8.5 第 1 条） -->
                <div v-if="nodePlan.currentVersion" class="wizard-versions">
                  <div class="wizard-version-line">
                    <span class="wizard-version-label">当前版本（档位）</span>
                    <span class="wizard-version-old">{{
                      versionWithChannel(nodePlan.currentVersion, nodePlan.currentChannel)
                    }}</span>
                    <span class="wizard-version-arrow" aria-hidden="true">→</span>
                    <span class="wizard-version-new">{{
                      nodePlan.needChoice === null
                        ? versionWithChannel(nodePlan.version, nodePlan.channel)
                        : '目标版本等你选完再算'
                    }}</span>
                  </div>
                </div>

                <div class="gate-confirm-table">
                  <div class="gate-confirm-row">
                    <span class="gate-confirm-key">版本档位</span>
                    <span class="gate-confirm-val">{{ channelRowText }}</span>
                  </div>
                  <div class="gate-confirm-row">
                    <span class="gate-confirm-key">这份 Node 是谁管的</span>
                    <span class="gate-confirm-val">{{ ownerRowText }}</span>
                  </div>
                  <div v-if="nodePlan.installsManager" class="gate-confirm-row">
                    <span class="gate-confirm-key">下载来源</span>
                    <span class="gate-confirm-val gate-confirm-mono">{{
                      nodePlan.sourceHost
                    }}</span>
                  </div>
                  <div class="gate-confirm-row">
                    <span class="gate-confirm-key">会装到哪里</span>
                    <span class="gate-confirm-val gate-confirm-mono">
                      {{ nodePlan.target || '（安装程序自己决定）' }}
                    </span>
                  </div>
                  <div class="gate-confirm-row">
                    <span class="gate-confirm-key">要不要联网</span>
                    <span class="gate-confirm-val">是</span>
                  </div>
                  <div class="gate-confirm-row">
                    <span class="gate-confirm-key">要不要管理员权限</span>
                    <span class="gate-confirm-val">{{ elevationText }}</span>
                  </div>
                  <div class="gate-confirm-row">
                    <span class="gate-confirm-key">会改什么</span>
                    <span class="gate-confirm-val">{{ nodePlan.note }}</span>
                  </div>
                  <!-- 计划阶段的中性陈述：签名要等下载后才读得到，这里不许对用户断言任何结论。
                       这次没有任何东西要下载时（nvm 那条路）整行不出现 -->
                  <div v-if="nodePlan.installsManager" class="gate-confirm-row">
                    <span class="gate-confirm-key">完整性</span>
                    <span class="gate-confirm-val">
                      下载后会核对官方清单里的校验值，并读取安装包的数字签名；对不上就不安装。
                    </span>
                  </div>
                </div>
                <div class="gate-fact-more">
                  <button class="btn tiny ghost" @click="planDetailsOpen = !planDetailsOpen">
                    {{ planDetailsOpen ? '收起详情' : '展开看完整地址' }}
                  </button>
                  <div v-if="planDetailsOpen" class="gate-detail">
                    <div class="gate-detail-row">
                      <span class="gate-detail-key">下载地址</span>
                      <span class="gate-detail-val">{{ nodePlan.url }}</span>
                    </div>
                    <div class="gate-detail-row">
                      <span class="gate-detail-key">校验依据</span>
                      <span class="gate-detail-val">{{ nodePlan.evidence }}</span>
                    </div>
                    <button class="btn tiny" @click="copy(nodePlan.url)">复制下载地址</button>
                  </div>
                </div>
                <!-- 跨档：明说这是换档；目标更低时写出「降到」（需求 §8.5 第 4 条） -->
                <p v-if="channelSwitchNotice" class="wizard-notice">{{ channelSwitchNotice }}</p>
                <!-- 归属判不出来：两条路一条都没预选，选之前不给「开始」（需求 §7.7 第 3 条）。
                     第一步上这个控件在选择区里（未展开确认区就看得见）；第三步的「换一个 Node」
                     没有选择区，所以在确认区里补同一组控件 -->
                <div
                  v-if="nodePlan.needChoice === 'choose-method' && currentStep.id !== 'node'"
                  class="gate-choice"
                >
                  <div class="gate-choice-row">
                    <label
                      v-for="option in METHOD_OPTIONS"
                      :key="option.id"
                      class="gate-option"
                      :class="{ selected: nodeMethod === option.id }"
                    >
                      <input
                        type="radio"
                        name="wizard-node-method-confirm"
                        :value="option.id"
                        :checked="nodeMethod === option.id"
                        :disabled="busy"
                        @change="pickMethod(option.id)"
                      />
                      <span class="gate-option-body">
                        <span class="gate-option-title">{{ option.title }}</span>
                        <span class="gate-option-note">{{ option.note }}</span>
                        <span class="gate-option-risk">{{ METHOD_RISK }}</span>
                      </span>
                    </label>
                  </div>
                </div>
                <p v-if="nodePlan.needChoice === 'choose-method'" class="wizard-notice">
                  我们不确定这份 Node 是哪种装的，所以两条路都列出来、一条都没有替你预选。
                </p>
                <!-- 用户显式点名的那条路与归属不一致：两份 Node 并存的后果要先说清（§7.9 第 4 条） -->
                <p v-if="showsMethodRisk" class="wizard-notice">{{ METHOD_RISK }}</p>
                <p v-if="nodePlan.installsManager && !nodePlan.sha256" class="wizard-notice">
                  <b>这次没能校验安装包的完整性。</b>
                </p>
                <!-- 发布元数据自己标注为未签名时才有这一条 + 一次明确确认（船长裁定） -->
                <p v-if="decision === 'unsigned'" class="wizard-notice">
                  <b>这个 nvm 构建没有数字签名。</b>确定要继续安装吗？
                </p>
                <!-- 诚实边界：能换的换、不能换的说清，不假装（冻结 §1 R-22） -->
                <p
                  v-if="nodePlan.method === 'nvm' && nodePlan.installsManager"
                  class="wizard-notice"
                >
                  版本管理器的安装包仍然从官方地址下载，不套用你设置的下载来源。
                </p>
                <p
                  v-if="nodePlan.owner === 'nvm' && !nodePlan.installsManager"
                  class="wizard-notice"
                >
                  这次只动版本管理器自己那份 Node，不会动系统里原来的那一份，也不会重装版本管理器。
                </p>
                <p v-if="!nodePlan.usable && nodePlan.refuseReason" class="wizard-notice">
                  {{ nodePlan.refuseReason }}
                </p>
                <div class="btn-row">
                  <template v-if="!nodePlan.usable">
                    <button class="btn small" @click="openDownloadPage">打开官方下载页</button>
                    <!-- 提权态下 nvm 那条路走不通：用户显式点名改走官方安装包（需求 §7.8 例外 3）。
                         归属判不出来时不给这条 —— 那时用户是在上面两条路里自己选（§7.7 第 3 条） -->
                    <button
                      v-if="nodePlan.owner === 'nvm' && nodePlan.method === 'nvm' && !busy"
                      class="btn small"
                      @click="useDirectInstead"
                    >
                      改用直接安装官方版本
                    </button>
                  </template>
                  <!-- 需要用户明确确认的场合不出现主按钮，安全的那一侧在左（视觉 §6.3 / R-12） -->
                  <template v-else-if="decision === 'unsigned'">
                    <button ref="startRef" class="btn small" @click="closeNodeConfirm">取消</button>
                    <button class="btn small" :disabled="busy" @click="startNode">仍然继续</button>
                  </template>
                  <template v-else-if="decision === 'unverified'">
                    <button ref="startRef" class="btn small" @click="openSourcePanel">
                      换一个下载源再试
                    </button>
                    <button class="btn small" :disabled="busy" @click="startNode">仍然继续</button>
                  </template>
                  <template v-else>
                    <button
                      ref="startRef"
                      class="btn small primary"
                      :disabled="busy"
                      :title="busy ? BUSY_HINT : undefined"
                      @click="startNode"
                    >
                      开始
                    </button>
                    <button class="btn small" @click="closeNodeConfirm">取消</button>
                  </template>
                </div>
              </template>
              <template v-else>
                <p class="gate-confirm-loading">这次没能取到下载信息（可能连不上官方地址）。</p>
                <div class="btn-row">
                  <button ref="startRef" class="btn small" @click="openDownloadPage">
                    打开官方下载页
                  </button>
                  <button class="btn small" @click="closeNodeConfirm">取消</button>
                </div>
              </template>
            </div>

            <!-- 一键修复（pnpm / dsh）的确认区：命令原文与目标目录都来自主进程的计划 -->
            <div v-if="fixConfirmPlan" class="gate-confirm">
              <div class="gate-confirm-title">将要执行</div>
              <code class="gate-confirm-cmd">{{ fixConfirmPlan.display }}</code>
              <div class="gate-confirm-table">
                <div class="gate-confirm-row">
                  <span class="gate-confirm-key">下载来源</span>
                  <span class="gate-confirm-val">{{ fixSourceText }}</span>
                </div>
                <div class="gate-confirm-row">
                  <span class="gate-confirm-key">会装到哪里</span>
                  <span class="gate-confirm-val gate-confirm-mono">
                    {{ fixConfirmPlan.target || '（全局 npm 目录）' }}
                  </span>
                </div>
                <div class="gate-confirm-row">
                  <span class="gate-confirm-key">要不要联网</span>
                  <span class="gate-confirm-val">是</span>
                </div>
                <div class="gate-confirm-row">
                  <span class="gate-confirm-key">要不要管理员权限</span>
                  <span class="gate-confirm-val">不需要</span>
                </div>
                <div class="gate-confirm-row">
                  <span class="gate-confirm-key">会改什么</span>
                  <span class="gate-confirm-val">{{ fixConfirmPlan.note }}</span>
                </div>
              </div>
              <div class="btn-row">
                <button
                  ref="startRef"
                  class="btn small primary"
                  :disabled="busy"
                  :title="busy ? BUSY_HINT : undefined"
                  @click="startFix"
                >
                  开始
                </button>
                <button class="btn small" @click="closeFixConfirm">取消</button>
              </div>
            </div>

            <!-- 跳过是一次确认，不是静默操作（交互 §5.4） -->
            <div v-if="skipConfirmOpen" class="wizard-decide">
              确定先跳过 pnpm 这一步吗？跳过之后，插件页的装 / 卸 /
              升级仍然用不了（以后随时可以回来补上）。
              <div class="btn-row">
                <button class="btn small" @click="confirmSkip">确定跳过</button>
                <button class="btn small" @click="closeSkipConfirm">取消</button>
              </div>
            </div>

            <!-- 结果行：与事实行同一个槽位，失败不换地方、不弹窗、不整屏红 -->
            <div v-if="stepSettled" class="gate-result">
              <div class="gate-result-line">
                <span class="gate-result-dot" :data-state="resultDot" aria-hidden="true"></span>
                <div class="gate-result-main">
                  <p class="gate-result-title">{{ resultTitle }}</p>
                  <p v-if="resultNote" class="gate-result-note">{{ resultNote }}</p>
                  <div class="btn-row">
                    <template v-if="activeFlow === 'node'">
                      <template v-if="nodeOutcome === 'detached'">
                        <button class="btn small" @click="refresh">重新检测</button>
                        <button class="btn small" @click="openDownloadPage">打开官方下载页</button>
                        <button class="btn small" @click="confirmInstallFinished">
                          我确认安装已经结束
                        </button>
                      </template>
                      <template v-else-if="nodeOutcome === 'refused'">
                        <button class="btn small" @click="switchToNvm">
                          改用不用管理员权限的方式安装
                        </button>
                        <button class="btn small" @click="refresh">重新检测</button>
                      </template>
                      <template v-else>
                        <button class="btn small" @click="refresh">重新检测</button>
                        <button class="btn small" @click="retryNode">再试一次</button>
                        <button class="btn small" @click="openDownloadPage">打开官方下载页</button>
                      </template>
                    </template>
                    <template v-else>
                      <button class="btn small" @click="refresh">重新检测</button>
                      <button v-if="fixOutcome !== 'done'" class="btn small" @click="retryFix">
                        再试一次
                      </button>
                      <button
                        v-if="currentStep.id === 'pnpm'"
                        class="btn small"
                        @click="openSkipConfirm"
                      >
                        先跳过这一步
                      </button>
                      <button
                        v-if="currentStep.id === 'dsh'"
                        class="btn small"
                        @click="openNodeSwitch"
                      >
                        换一个 Node
                      </button>
                      <button
                        v-if="currentStep.id === 'dsh'"
                        class="btn small"
                        @click="openSettings"
                      >
                        在设置里写死一条能跑的启动命令
                      </button>
                    </template>
                  </div>
                </div>
              </div>
            </div>

            <!-- 流式输出：默认收起，展开后与自检页的输出区同一套形态 -->
            <div v-if="outputOpen" class="env-op">
              <div class="env-op-head">
                <span class="env-op-cmd">{{ outputCommand }}</span>
                <span class="env-op-state" :data-state="outputState">
                  {{ stepRunning ? '进行中…' : '已结束' }}
                </span>
                <span class="spacer"></span>
                <button class="btn tiny" @click="toggleOutput">收起</button>
              </div>
              <pre ref="outputRef" class="env-op-out">{{ outputText || '（等待输出…）' }}</pre>
              <p v-if="outputSummary" class="env-op-summary" :data-state="outputState">
                {{ outputSummary }}
              </p>
            </div>
          </div>

          <!-- 卡片外的一行交代（它是说明，不是这一步的操作） -->
          <p
            v-if="!reviewStep && currentStep && currentStep.id === 'node' && !stepRunning"
            class="gate-card-note"
          >
            装好之后，其它已经打开的终端窗口需要重开一次，才会用上新装的 Node。
          </p>

          <div class="gate-metabar">
            <span v-if="warnCount > 0" class="gate-metabar-note">
              另外还有 {{ warnCount }} 项提醒（可稍后处理）
            </span>
            <button v-if="warnCount > 0" class="btn tiny ghost" @click="openEnvPane">
              去环境自检看详情
            </button>
            <span v-if="checking" class="gate-metabar-note">正在检查这台电脑上的运行环境…</span>
            <span class="spacer"></span>
            <button
              class="btn small"
              :disabled="busy || checking"
              :title="busy ? BUSY_HINT : undefined"
              @click="refresh"
            >
              重新检测
            </button>
          </div>
        </template>
      </div>
    </div>

    <!-- 底条：与状态栏同一个位置。逃生口是这一屏唯一的"前进"，永远可点、永远在 Tab 顺序里；
         放行页上它消失（没有东西要逃了）。 -->
    <footer class="gate-foot">
      <template v-if="screen !== 'released'">
        <button ref="escapeRef" class="btn small gate-escape" @click="escape">
          先进入界面（环境还没准备好，我稍后自己处理）
        </button>
        <span class="gate-foot-note">点了不改动这台电脑上的任何东西</span>
      </template>
    </footer>
  </div>
</template>
