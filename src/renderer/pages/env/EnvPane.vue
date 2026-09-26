<script setup lang="ts">
/**
 * 环境自检的**详情视图**（t45 起：它不是左栏的一项，而是设置页「运行环境」卡的详情，
 * 由 `lib/env-layer.ts` 的 `openEnvDetail()` 打开，见 AGENTS 7.30）。
 *
 * 回答的是"打开 DSH 时这台机器到底行不行"：外部 node 在不在、版本够不够、npm / pnpm /
 * dsh 本体能不能用、应用自带的运行时是什么、本地 Shell 能不能起。八项都由主进程实测
 * （`main/env-doctor.ts`），这一页只负责**显示结论 + 给可执行的修法**。
 *
 * 三条刻意的设计：
 *   1. **状态用颜色区分三档**，不让人去读 detail 那串人话判断严重程度：
 *      `ok` 绿实心 / `warn` 黄空心 / `missing` 红实心（复用外壳的 `.lamp` 语义）。
 *   2. **确认区在页内**，而且显示命令原文与目标目录 —— 命令由主进程的 plan 给，这一页不拼命令
 *      （与插件页同一条原则：渲染层递回去的路径一概不采信）。装什么、装到哪，用户点之前就看得见。
 *   3. **页面级内边距由这一页自己给**（`.pane` 没有任何 padding，见 AGENTS 7.14）。
 *
 * 阶段二在这一页上**只加不改造**（冻结 §4.5，视觉 §5.9），加的是四样：
 *   - 「重新打开环境向导」：把首启门禁层重新显示出来（逃生之后回得来的三条路之一）；
 *   - 行内的版本更新入口（Node / pnpm）：只在对应项**可用**时出现，缺失时给的是既有的"一键安装"；
 *   - 被跳过的步骤上「把这一步加回来？」：恢复只改那一个设置项，不做别的任何事；
 *   - 「安装下载来源」小面板：**全应用只有这一处控件**，改完要保存才生效，不静默换源。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

import { envFocus } from '../../lib/env-anchor.js';
import { detailSegments } from '../../lib/env-detail.js';
import { closeEnvDetail } from '../../lib/env-layer.js';
import { restartThenOpenHarness } from '../../lib/restart-flow.js';
import EnvUpdateConfirm from './EnvUpdateConfirm.vue';
import {
  cancelEnvFix,
  clearEnvFixOutput,
  envFix,
  envFixOutput,
  envReport,
  envReportError,
  envReportLoading,
  loadEnvReport,
  runEnvFix,
  wireEnvDoctor,
} from '../../lib/env-doctor.js';
import {
  anyoneBusy,
  install,
  loadNodePlan,
  reopenGate,
  runNodeInstall,
  skipStep,
  stopNodeInstall,
  wizard,
} from '../../lib/env-wizard.js';
import { installRunning, installSettled } from '../../lib/env-install-phase.js';
import { formatAgo, formatBytes } from '../../lib/format.js';
import {
  BUSY_HINT,
  CHANNEL_SHORT,
  NODE_DOWNLOAD_URL,
  versionWithChannel,
} from '../../lib/gate-copy.js';
import { platform } from '../../lib/platform.js';
import { currentTab, dsh, phase, settings } from '../../lib/store.js';
import type {
  EnvCheck,
  EnvCheckId,
  EnvCheckStatus,
  EnvFixAction,
  EnvFixPlan,
  EnvInstallState,
  EnvNodeChannel,
  EnvNodeOwner,
  EnvNodePlan,
  EnvWizardStepId,
} from '../../../shared/ipc.js';

const api = window.dshConsole;

/** 归属判不出来时那句话（需求 §7.7 第 3 条 / 交互 §10.2） */
const UNKNOWN_OWNER_NOTE = '我们认不出这个 Node 是怎么装的，所以不会替它做自动更新。';

/** 八项的标题。写成 Record 是为了漏一个 id 就 tsc 报错（与契约里的联合类型对齐） */
const TITLES: Record<EnvCheckId, string> = {
  node: '外部 Node',
  'node-version': 'Node 版本',
  npm: 'npm',
  pnpm: 'pnpm',
  dsh: 'dsh 本体',
  'dsh-run': 'dsh 能不能跑',
  'bundled-runtime': '应用自带运行时',
  shell: '本地 Shell',
};

const STATUS_TEXT: Record<EnvCheckStatus, string> = {
  ok: '正常',
  warn: '需要注意',
  missing: '不可用',
};

const confirming = ref<EnvFixAction | null>(null);
const outputOpen = ref(false);
const listRef = ref<HTMLElement | null>(null);
const outRef = ref<HTMLElement | null>(null);
/** 「安装下载来源」那个输入框：确认区里的「换一个下载源再试」把焦点交给它 */
const sourceRef = ref<HTMLInputElement | null>(null);
/** 每 30 秒自增一次，让「x 分钟前」自己走字（判定的时刻由主进程给，界面只负责说人话） */
const tick = ref(0);

/** 正在展开确认区的是哪一项的更新入口（Node / pnpm） */
const updateOpen = ref<'node' | 'pnpm' | null>(null);
const nodeUpdatePlan = ref<EnvNodePlan | null>(null);
/** 这次更新用户**显式指名**的档位；null = 跟随当前档位（默认，也是 VM-15 的修法） */
const nodeUpdateChannel = ref<EnvNodeChannel | null>(null);
const nodeUpdateLoading = ref(false);
const nodeUpdateError = ref('');
const restartDismissed = ref(false);

/** 「安装下载来源」的草稿与已保存值：有未保存的改动时明说，不改显示中的来源 */
const sourceDraft = ref('');
const sourceSaved = ref('');
const sourceStatus = ref('');

let tickTimer: ReturnType<typeof setInterval> | null = null;

const checks = computed<EnvCheck[]>(() => envReport.value?.checks ?? []);
const counts = computed(() => envReport.value?.counts ?? { ok: 0, warn: 0, missing: 0 });
const running = computed(() => envFix.value.phase === 'running');
/** 全局忙位：既有的一键修复 + 安装通道（含"我们不等了但机器上可能还在装"） */
const busy = computed(() => anyoneBusy.value || running.value);

/** Node 的更新进行中 / 有结论了（`mode === 'update'` 才是更新，装第一次不算） */
const nodeUpdateRunning = computed(
  () => install.value.mode === 'update' && installRunning(install.value),
);
const nodeUpdateSettled = computed(
  () =>
    install.value.mode === 'update' &&
    install.value.method !== null &&
    install.value.phase !== 'idle' &&
    installSettled(install.value),
);
/** 更新完该不该问一句"要不要重新启动 dsh"（只有本应用启动的 dsh 才轮得到我们管） */
const asksRestartDsh = computed(() => {
  if (!nodeUpdateSettled.value || restartDismissed.value) return false;
  const current = dsh.value;
  return Boolean(current && current.owned) && phase.value !== 'running';
});

const lastChecked = computed(() => {
  void tick.value;
  return envReport.value ? formatAgo(envReport.value.checkedAt) : '—';
});

const fixPhaseLabel = computed(() => {
  const state = envFix.value;
  if (state.phase === 'running') return '进行中…';
  if (state.phase === 'done') return '完成';
  if (state.phase === 'cancelled') return '已中断';
  if (state.phase === 'error') return '失败';
  return '';
});

/** 确认区的内容：动作 → 主进程给的那份计划（拿不到计划就不给按钮） */
const confirmPlan = computed<EnvFixPlan | null>(() =>
  confirming.value ? planFor(confirming.value) : null,
);

function planFor(action: EnvFixAction): EnvFixPlan | null {
  return envReport.value?.plans.find((plan) => plan.action === action) ?? null;
}

/** 这一项有没有"替你做"的出路：既要有动作，也要有可用的计划（npm 都找不到时没有计划） */
function fixActionOf(check: EnvCheck): EnvFixAction | null {
  return check.fixAction !== null && planFor(check.fixAction) ? check.fixAction : null;
}

function fixLabel(check: EnvCheck): string {
  return check.fixAction === 'install-pnpm' ? '一键安装 pnpm' : '一键安装 dsh';
}

/** 行内的版本更新入口：只在对应项**可用**时出现（缺失时给的是"一键安装"）。
 *  Node 的更新只在 Windows 出现（冻结 §1 R-20：自动安装只在 win32 生效）。 */
function updateKindOf(check: EnvCheck): 'node' | 'pnpm' | null {
  if (check.status === 'missing') return null;
  if (check.id === 'node') {
    if (platform.value !== 'win32') return null;
    // 归属判不出来时**不给「更新」**：我们不知道该动哪一份 Node，就不该替它做自动动作
    // （VM-14 的直接成因就是这里没看归属）
    return nodeOwner.value === 'unknown' ? null : 'node';
  }
  if (check.id === 'pnpm') return 'pnpm';
  return null;
}

/** 这一页的 Node 那一行（报告里的事实行） */
const nodeCheck = computed<EnvCheck | null>(
  () => checks.value.find((check) => check.id === 'node') ?? null,
);

/** 这份 Node 是谁管的（报告给的事实）。报告还没到 / 字段缺失时按"认不出来"处理 ——
 *  "认不出来就不做自动更新"是诚实边界，不能因为字段没到就退回一个默认动作（那正是 VM-14）。 */
const nodeOwner = computed<EnvNodeOwner>(() => envReport.value?.nodeOwner ?? 'unknown');

/** 归属判不出来、却找到了一份 Node 的那一行：给两条不用我们的自动动作的出路（需求 §7.7 第 3 条） */
function nodeUpdateRefused(check: EnvCheck): boolean {
  return (
    check.id === 'node' &&
    check.status !== 'missing' &&
    platform.value === 'win32' &&
    nodeOwner.value === 'unknown'
  );
}

/**
 * 行上的读数（交互 §10.5 第 5 条：目标 == 当前时按钮位置直接是读数态，不给一个点了什么都不会
 * 发生的按钮）。"目标版本"只有计划算得出来，所以报告一到就取一次更新计划；取不到（离线 /
 * 主进程给不出）就退回按钮 —— 不让这一行消失。
 *
 * 为什么等 `wizard.value` 到了才取：`lib/env-wizard.ts` 的 `loadNodePlan` 失败时会写
 * `wizardError`，而那条错误显示在门禁的"检查中"那一屏上 —— 一次后台读数不该把它误报成
 * "上一轮检查没能完成"。
 */
const nodeRowPlan = ref<EnvNodePlan | null>(null);
let nodeRowPlanSeq = 0;

const nodeUpdateRowVisible = computed(() => {
  const check = nodeCheck.value;
  return check !== null && updateKindOf(check) === 'node';
});

async function loadNodeRowPlan(): Promise<void> {
  const seq = (nodeRowPlanSeq += 1);
  if (!nodeUpdateRowVisible.value || busy.value || wizard.value === null) {
    nodeRowPlan.value = null;
    return;
  }
  const plan = await loadNodePlan({ mode: 'update' });
  // 期间报告 / 忙位又变了：这一次的结果作废（下一次 watch 会再取）
  if (seq !== nodeRowPlanSeq) return;
  nodeRowPlan.value = plan;
}

/** 已经是最新版：目标与当前一致（同档、没有跨档）—— 那是读数，不是一个按钮 */
const nodeUpToDate = computed(() => {
  const plan = nodeRowPlan.value;
  return plan !== null && plan.direction === 'same' && !plan.switchesChannel;
});

const nodeUpToDateText = computed(() => {
  const plan = nodeRowPlan.value;
  const version = plan?.currentVersion ?? plan?.version ?? '';
  return version ? `已经是最新版（${version}）` : '已经是最新版';
});

/** 行上按钮的动作名：跨档叫「换成…」，同档才是「更新」（需求 §8.1 第 2 条） */
const nodeUpdateLabel = computed(() => {
  const plan = nodeRowPlan.value;
  if (plan?.switchesChannel) return plan.channel === 'current' ? '换成当前版' : '换成稳定版';
  return '更新 Node.js';
});

/** "已经是最新版"时唯一还有意义的动作：显式换到**另一档**（换档不是"更新"，所以按钮不叫更新） */
const nodeOtherChannelLabel = computed(() =>
  nodeRowPlan.value?.channel === 'current' ? '换成稳定版' : '换成当前版',
);

// 报告 / 忙位 / 门禁状态一变就重取一次行上的读数（只取一次，取不到就退回按钮）
watch([() => envReport.value, () => busy.value, () => wizard.value], () => void loadNodeRowPlan(), {
  immediate: true,
});

/** 被跳过的那一步（只有可跳过的步骤会出现在这里）：恢复入口就在这一行上（交互 §5.4） */
function skippedStepOf(check: EnvCheck): EnvWizardStepId | null {
  const state = wizard.value;
  if (!state) return null;
  const step =
    state.steps.find((item) => item.skippable && item.checkIds.includes(check.id)) ?? null;
  return step && step.status === 'skipped' ? step.id : null;
}

const sourceDirty = computed(
  () => sourceDraft.value.trim().replace(/\/+$/, '') !== sourceSaved.value,
);

function say(message: string): void {
  window.dispatchEvent(new CustomEvent('dsh:status-message', { detail: message }));
}

// ------------------------------------------------------------ 既有的"一键修复"

/** 点「一键安装…」：先展开确认区，不偷偷开始 */
function openConfirmFor(check: EnvCheck): void {
  const action = fixActionOf(check);
  if (!action) return;
  if (running.value) {
    say('已经有一个修复在进行中');
    return;
  }
  updateOpen.value = null;
  confirming.value = action;
  outputOpen.value = false;
}

function cancelConfirm(): void {
  confirming.value = null;
}

async function startFix(action: EnvFixAction): Promise<void> {
  if (running.value) return;
  confirming.value = null;
  clearEnvFixOutput();
  outputOpen.value = true;
  const state = await runEnvFix(action);
  if (state.message) say(state.message);
}

function startConfirmed(): void {
  const action = confirming.value;
  if (action) void startFix(action);
}

async function interrupt(): Promise<void> {
  const stopped = await cancelEnvFix();
  if (!stopped) say('没有正在运行的修复');
}

function dismissOutput(): void {
  outputOpen.value = false;
}

async function copyHint(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    say('修复指引已复制到剪贴板');
  } catch {
    say('复制失败，请手动选中这一行');
  }
}

function refresh(): void {
  if (busy.value) return;
  void loadEnvReport(true);
}

/** 逃生之后回到向导的那条明路（交互 §2.8 第 2 条）：不写盘、不改判定，只是把覆盖层再显示出来 */
function openWizard(): void {
  reopenGate();
}

/**
 * 详情视图的回程按钮：它是工作区上的覆盖层，收掉就回到打开它的那一页
 * （设置、控制台横幅、插件页都可能打开它）—— 所以这里**不改** `currentTab`。
 *
 * 文案跟着来路走：从设置卡进来的写「设置」（与摆法预览 2A 一致），
 * 从控制台横幅 / 插件页 / 门禁层进来的写「返回」更诚实 —— 它们回的是原处，不是设置页。
 */
const backLabel = computed(() => (currentTab.value === 'settings' ? '设置' : '返回'));

function backFromDetail(): void {
  closeEnvDetail();
}

async function openDownloadPage(): Promise<void> {
  await api.openExternal(NODE_DOWNLOAD_URL);
}

// ------------------------------------------------------------ 版本更新入口

function openUpdateRow(check: EnvCheck, otherChannel = false): void {
  const kind = updateKindOf(check);
  if (!kind) return;
  // 「已经是最新版」那一行上还有一个显式的换档入口：换到另一档（不是"更新"，所以不叫更新）
  if (kind === 'node' && otherChannel) {
    const other: EnvNodeChannel = nodeRowPlan.value?.channel === 'current' ? 'lts' : 'current';
    void openUpdate(kind, other);
    return;
  }
  void openUpdate(kind);
}

async function openUpdate(
  kind: 'node' | 'pnpm',
  channel: EnvNodeChannel | null = null,
): Promise<void> {
  if (busy.value) return;
  confirming.value = null;
  restartDismissed.value = false;
  updateOpen.value = kind;
  if (kind === 'pnpm') return;
  // 不记住上次选了哪一档：每次打开都回到"跟随现在这一份"（只有显式换档才带值进来）
  nodeUpdateChannel.value = channel;
  await loadNodeUpdatePlan();
}

/**
 * 更新请求：**默认不递档位**（`mode === 'update'` 省略 `channel` = 目标档位**跟随当前档位**，
 * 这是 VM-15 的修法）；方法也永远省略（`省略 = 跟随归属` —— nvm 管的走 nvm、系统的走直装，
 * 这是 VM-14 的修法）。**只有用户在档位控件上显式选了一档才把档位递回去**，那才是「换档」：
 * 它只可能由这个字段产生，不可能由默认值产生（需求 §8.5 第 3 条）。
 */
function nodeUpdateRequest(): { mode: 'update'; channel?: EnvNodeChannel } {
  const request: { mode: 'update'; channel?: EnvNodeChannel } = { mode: 'update' };
  const picked = nodeUpdateChannel.value;
  if (picked) request.channel = picked;
  return request;
}

/** 取一次更新计划：拿不到就不给「开始」（界面不自己拼版本、不自己猜来源） */
async function loadNodeUpdatePlan(): Promise<void> {
  nodeUpdateLoading.value = true;
  nodeUpdateError.value = '';
  const plan = await loadNodePlan(nodeUpdateRequest());
  nodeUpdatePlan.value = plan;
  nodeUpdateLoading.value = false;
  if (!plan) nodeUpdateError.value = '这次没能取到下载信息（可能连不上官方地址）。';
}

/** 用户在档位控件上选了另一档：这是一次**显式的换档**，重新取一份计划（不动系统） */
function pickUpdateChannel(channel: EnvNodeChannel): void {
  if (busy.value) return;
  if (nodeUpdateChannel.value === channel) return;
  nodeUpdateChannel.value = channel;
  void loadNodeUpdatePlan();
}

function cancelUpdate(): void {
  updateOpen.value = null;
  nodeUpdateError.value = '';
  nodeUpdateChannel.value = null;
}

/** 「换一个下载源再试」：把人带到本页那张来源控件（不静默换源 —— 只能由用户改） */
function focusSource(): void {
  updateOpen.value = null;
  void nextTick(() => {
    sourceRef.value?.focus();
    sourceRef.value?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  say('在「安装下载来源」里填一个新的地址，保存之后回来重新检测');
}

/** 「更新 pnpm」就是既有的 install-pnpm（冻结 §3.5：不许第二条路）。
 *  所以它走的是同一个"确认之后才动手"的入口，渲染层只递 action（自检钉着这一点）。 */
async function startPnpmUpdate(): Promise<void> {
  updateOpen.value = null;
  confirming.value = null;
  await startFix('install-pnpm');
}

/** 「更新 Node.js」/「换成…」：只递选择，地址与校验值由主进程现场重算 */
async function startNodeUpdate(): Promise<void> {
  updateOpen.value = null;
  await runNodeInstall(nodeUpdateRequest());
}

async function stopUpdate(): Promise<void> {
  await stopNodeInstall();
}

function updateStopLabel(state: EnvInstallState): string {
  if (state.phase === 'installing' || state.phase === 'waiting') {
    return '不再等待（安装可能还在后台进行）';
  }
  return state.phase === 'verifying' ? '取消' : '取消下载';
}

/** 复检中**没有按钮**（交互 §7.1）；其余进行中的相位都有一个明确的按钮 */
const updateCanStop = computed(() => {
  const state = install.value;
  return state.cancellable || state.phase === 'installing' || state.phase === 'waiting';
});

const updateProgressText = computed(() => {
  const state = install.value;
  // 主进程给的 `message` 就是一句自足的状态行；百分比只来自 `percent`，不往文案里再补一个
  if (state.message) return state.message;
  switch (state.phase) {
    case 'preparing':
      return '正在准备…';
    case 'downloading':
      return `${nodeRunVerb.value}…`;
    case 'verifying':
      return '正在校验安装包完整性';
    case 'installing':
      return nodeRunVerb.value;
    case 'waiting':
      return '正在等待安装程序';
    case 'rechecking':
      return '正在重新检测';
    default:
      return '';
  }
});

const updateProgressPercent = computed<number | null>(() =>
  install.value.phase === 'downloading' ? install.value.percent : null,
);

const updateBytes = computed(() => {
  if (install.value.phase !== 'downloading') return '';
  const bytes = install.value.bytes;
  if (!bytes) return '';
  return `${formatBytes(bytes.downloaded)} / ${formatBytes(bytes.total)}`;
});

/** 更新完成的结论：主进程的 message 优先；「版本没有变化 / 没成」时把「重新检测」摆旁边 */
const updateResultTitle = computed(() => {
  const message = install.value.message;
  if (message) return message;
  const outcome = installOutcome.value;
  if (outcome === 'done') {
    // 跨档时那个分支不出现「更新」：它是换档（需求 §8.5 第 4 条）
    return install.value.plan?.switchesChannel ? '换档完成。' : 'Node.js 更新完成。';
  }
  if (outcome === 'detached') return '我们不等了：安装可能还在后台进行，做完点「重新检测」。';
  if (outcome === 'refused') return '你拒绝了管理员权限，这台电脑上什么都没改。';
  return install.value.plan?.switchesChannel
    ? '换档没有完成，这台电脑上什么都没改。'
    : '更新没有完成，这台电脑上什么都没改。';
});

const installOutcome = computed<'done' | 'detached' | 'refused' | 'failed'>(() => {
  const state = install.value;
  if (state.detached) return 'detached';
  if (state.phase === 'done') return 'done';
  if (state.code === 1223 || state.code === 5) return 'refused';
  return 'failed';
});

/** 更新完的复检事实：这一项现在是什么样，照贴主进程给的那一行 */
const updateResultFact = computed(() => {
  const report = install.value.report;
  if (!report) return '';
  const row = report.checks.find((check) => check.id === 'node');
  return row ? `这一轮检查：${row.detail}` : '';
});

/** 「会先停掉 dsh」那句话：跨档时换一种说法，那个分支里不出现「更新」（需求 §8.5 第 4 条） */
const nodeAffectsDshText = computed(() =>
  install.value.plan?.switchesChannel
    ? '换档会先停掉正在运行的 dsh，换完再问你要不要重新启动它。'
    : '更新会先停掉正在运行的 dsh，更新完再问你要不要重新启动它。',
);

/** 进行中那句话：跨档时用「换成…」的说法，那个分支里不出现「更新」 */
const nodeRunVerb = computed(() => {
  const plan = install.value.plan;
  return plan?.switchesChannel ? `正在换成${CHANNEL_SHORT[plan.channel]}` : '正在更新 Node.js';
});

/** 收尾的三个事实：更新前（计划里的版本 + 档位）、更新后（**实测**的版本）、结论（需求 §8.2） */
const updateResultChannels = computed(() => {
  const plan = install.value.plan;
  if (!plan) return '';
  const before = versionWithChannel(plan.currentVersion, plan.currentChannel);
  const after = install.value.observedVersion
    ? versionWithChannel(install.value.observedVersion, plan.channel)
    : '没测到版本';
  const tail = plan.switchesChannel ? ' —— 换档完成。' : '。';
  return `Node.js：${before} → ${after}${tail}`;
});

/**
 * 更新 Node 之后把本应用启动的 dsh 重新拉起来（停它的是更新前置，不是我们偷偷停的）。
 * 走共享流程（t46）：锁上那几秒 + 就绪后自动进 Harness —— 这里用 `mode: 'start'`，
 * 因为 dsh 已经被前置步骤停掉了，不必再走一遍"停 → 等端口释放"。
 */
async function restartDsh(): Promise<void> {
  restartDismissed.value = true;
  await restartThenOpenHarness(api, () => dsh.value, 'env', 'start');
}

function dismissRestart(): void {
  restartDismissed.value = true;
}

// ------------------------------------------------------------ 被跳过步骤的恢复

async function restoreStep(step: EnvWizardStepId): Promise<void> {
  await skipStep(step, false);
  say('已经加回来了：下次进向导会停在这一步');
}

/** 行上的「把这一步加回来？」：只对真的被跳过的那些行有效 */
function restoreRow(check: EnvCheck): void {
  const step = skippedStepOf(check);
  if (step) void restoreStep(step);
}

// ------------------------------------------------------------ 安装下载来源

function saveSource(): void {
  const raw = sourceDraft.value.trim();
  const next = raw.replace(/\/+$/, '');
  if (next !== '' && !/^https?:\/\/\S+$/i.test(next)) {
    sourceStatus.value = '这个地址看起来不对：只认 http 或 https 开头的地址。';
    return;
  }
  void patchSource(next);
}

/** 只注入这一次进程（主进程的做法），不写用户的任何配置文件；写错当没填 */
async function patchSource(value: string): Promise<void> {
  try {
    const next = await api.patchSettings({ envNodeSource: value });
    sourceSaved.value = next.envNodeSource;
    sourceDraft.value = next.envNodeSource;
    sourceStatus.value = next.envNodeSource ? '已保存' : '已保存（留空 = 官方地址）';
    say('安装下载来源已保存');
  } catch (cause) {
    sourceStatus.value = `没能保存：${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

// ------------------------------------------------------------ 报告与输出

// 输出区跟着新片段往下滚（与事件日志同一套做法：不假装进度条，原文照贴）
watch(envFixOutput, () => {
  void nextTick(() => {
    if (outRef.value) outRef.value.scrollTop = outRef.value.scrollHeight;
  });
});

/**
 * 锚点：插件页 / 控制台页把人带过来时，滚到那一行；带 action 时连确认区一起展开。
 * 请求号是递增的（见 lib/env-anchor.ts）：连点两次各走一遍，不会"点了没反应"。
 */
watch(
  () => envFocus.value.seq,
  async () => {
    const request = envFocus.value;
    if (request.seq === 0) return;
    if (!envReport.value) await loadEnvReport();
    // 正在跑的时候不碰确认区与输出面板（别把用户正在看的流式输出收起来）
    if (!running.value) {
      if (request.action && planFor(request.action)) confirming.value = request.action;
      outputOpen.value = false;
    }
    await nextTick();
    const row = listRef.value?.querySelector(`[data-check="${request.checkId}"]`);
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  },
  { immediate: true },
);

onMounted(() => {
  wireEnvDoctor();
  // 这一页常驻挂载（所有页面都靠 visibility 隐藏），所以顺手拉一份：
  // 控制台顶部那条横幅与插件页的「没找到 pnpm」读的是同一份报告。
  // 主进程有缓存就立刻给（启动 1.5 秒后它会自己跑一轮），没有就现跑一轮，不阻塞挂载。
  void loadEnvReport();
  sourceDraft.value = settings.value.envNodeSource || '';
  sourceSaved.value = sourceDraft.value;
  tickTimer = setInterval(() => (tick.value += 1), 30_000);
});

// 主进程改了设置（例如向导里跳过 / 恢复）时跟着更新草稿，免得用户把旧值又写回去
watch(
  () => settings.value.envNodeSource,
  (next) => {
    if (sourceDirty.value) return;
    sourceDraft.value = next || '';
    sourceSaved.value = sourceDraft.value;
  },
);

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer);
});
</script>

<template>
  <div class="env">
    <div class="bar">
      <!-- 它是设置页「运行环境」卡的详情视图（t45）：左栏没有这一项，所以给一个显式的回程 -->
      <button id="btn-env-back" class="btn small" @click="backFromDetail">
        <svg class="i"><use href="#i-back" /></svg><span>{{ backLabel }}</span>
      </button>
      <button
        id="btn-env-refresh"
        class="btn small primary"
        :disabled="envReportLoading || busy"
        :title="busy ? BUSY_HINT : undefined"
        :aria-busy="envReportLoading ? 'true' : undefined"
        @click="refresh"
      >
        <svg class="i"><use href="#i-replay" /></svg><span>重新检测</span>
      </button>
      <button id="btn-env-wizard" class="btn small" @click="openWizard">重新打开环境向导</button>
      <div class="spacer"></div>
      <span class="bar-note">
        {{ counts.ok }} 项正常 · {{ counts.missing }} 项不正常 · {{ counts.warn }} 项需要注意
      </span>
      <span class="bar-hint">上次检查：{{ lastChecked }}</span>
    </div>

    <!-- 探测本身出了意外（不是"某项不满足"）：说明一句，下面的行照常显示 -->
    <div v-if="envReport?.error" class="banner">
      <svg class="i"><use href="#i-warn" /></svg>
      <span>
        <b>这一轮没测全。</b>
        {{ envReport.error }} 下面的结论照常显示，可以先按「重新检测」再试一次。
      </span>
    </div>

    <div v-if="!envReport" class="empty">
      <h2>{{ envReportLoading ? '正在检测这台机器的基础环境…' : '还没有检测结果' }}</h2>
      <p v-if="envReportError" class="hint">{{ envReportError }}</p>
      <button v-else-if="!envReportLoading" class="btn small" @click="refresh">开始检测</button>
    </div>

    <template v-else>
      <p class="env-scope">
        要求 Node <code>{{ envReport.nodeRange }}</code
        >（dsh 与它依赖链的要求）。版本不合适时 dsh 可能「退出码 0、零输出」地静默退出 ——
        界面上只会看到「已停止」，看不出是解释器的问题。
      </p>

      <ul ref="listRef" class="env-list panel">
        <li
          v-for="check in checks"
          :key="check.id"
          class="env-row"
          :data-check="check.id"
          :data-status="check.status"
        >
          <span class="lamp"></span>
          <div class="env-main">
            <div class="env-head">
              <span class="env-title">{{ TITLES[check.id] }}</span>
              <span class="env-state">{{ STATUS_TEXT[check.status] }}</span>
            </div>
            <!-- 说明里常有两条长路径（node 的入口 + dsh 的 bin.js）：按路径分隔符切开、片段之间
                 插一个 <wbr>，折行才会落在分隔符上而不是路径中间（见 lib/env-detail.ts）。
                 不用 v-html —— 这段文字里有用户机器上的真实路径，当标记解析就是一条注入面。
                 <wbr> 与插值之间不能留空格，所以它们写在同一行（片段本身不许再断：见 .env-seg）。 -->
            <p class="env-detail">
              <template v-for="(segment, index) in detailSegments(check.detail)" :key="index"
                ><wbr v-if="index > 0" /><span class="env-seg">{{ segment }}</span></template
              >
            </p>
            <p v-if="check.fixHint" class="env-hint">
              <code>{{ check.fixHint }}</code>
              <button class="btn tiny" @click="copyHint(check.fixHint)">复制</button>
            </p>
          </div>

          <!-- 行右侧的操作槽：缺失给"一键安装"、可用给"更新"、已跳过给"加回来"（视觉 §5.9）。
               没有动作的行不渲染这个容器 —— 空容器也会占掉一个 gap，把行挤窄。 -->
          <div
            v-if="fixActionOf(check) || updateKindOf(check) || skippedStepOf(check)"
            class="env-actions"
          >
            <button
              v-if="fixActionOf(check)"
              class="btn small"
              :disabled="running || envReportLoading || busy"
              :title="busy ? BUSY_HINT : undefined"
              @click="openConfirmFor(check)"
            >
              {{ fixLabel(check) }}
            </button>
            <!-- 目标 == 当前：按钮位改成读数态（不给一个点了什么都不会发生的按钮），
                 旁边留一个**显式换档**的入口 —— 换到另一档不是「更新」 -->
            <template v-else-if="updateKindOf(check) === 'node' && nodeUpToDate">
              <span class="wizard-readout">{{ nodeUpToDateText }}</span>
              <button
                class="btn tiny ghost"
                :disabled="busy"
                :title="busy ? BUSY_HINT : undefined"
                @click="openUpdateRow(check, true)"
              >
                {{ nodeOtherChannelLabel }}
              </button>
            </template>
            <button
              v-else-if="updateKindOf(check)"
              class="btn small"
              :disabled="busy"
              :title="busy ? BUSY_HINT : undefined"
              @click="openUpdateRow(check)"
            >
              {{ updateKindOf(check) === 'node' ? nodeUpdateLabel : '更新 pnpm' }}
            </button>
            <template v-if="skippedStepOf(check)">
              <span class="env-skip">已跳过</span>
              <button class="btn tiny ghost" @click="restoreRow(check)">把这一步加回来？</button>
            </template>
          </div>

          <!-- 归属认不出来：不给「更新」，把那条诚实边界与两条出路写在这一行上（需求 §7.7 第 3 条） -->
          <div v-if="nodeUpdateRefused(check)" class="env-owner-note">
            <span class="env-owner-note-text">{{ UNKNOWN_OWNER_NOTE }}</span>
            <div class="btn-row">
              <button class="btn tiny" @click="openDownloadPage">打开官方下载页</button>
              <button class="btn tiny ghost" @click="refresh">重新检测</button>
            </div>
          </div>

          <!-- 更新确认区：原地展开，不弹原生对话框。两条风险说明是需求 §8.3 的硬要求。
               t60 起它是 pages/env/EnvUpdateConfirm.vue：这一层只把计划与档位递下去、把
               "开始 / 取消 / 换档 / 换源"接回来 —— 同一份计划父级那一行也在读，所以留在父级。 -->
          <EnvUpdateConfirm
            v-if="(check.id === 'node' || check.id === 'pnpm') && updateOpen === check.id"
            :kind="check.id"
            :check="check"
            :busy="busy"
            :node-update-plan="nodeUpdatePlan"
            :node-update-loading="nodeUpdateLoading"
            :node-update-channel="nodeUpdateChannel"
            :node-update-error="nodeUpdateError"
            :pnpm-plan="planFor('install-pnpm')"
            :report-owner="nodeOwner"
            :node-affects-dsh-text="nodeAffectsDshText"
            @cancel="cancelUpdate"
            @start-pnpm="startPnpmUpdate"
            @start-node="startNodeUpdate"
            @pick-channel="pickUpdateChannel"
            @refresh="refresh"
            @focus-source="focusSource"
            @open-download="openDownloadPage"
          />

          <!-- 更新进行中 / 更新结果：与安装共用同一套进度与结论（视觉 §5.9） -->
          <div
            v-if="check.id === 'node' && (nodeUpdateRunning || nodeUpdateSettled)"
            class="wizard-progress"
          >
            <div class="wizard-progress-line">
              <span class="wizard-progress-dot" aria-hidden="true"></span>
              <span class="wizard-progress-text">
                {{ nodeUpdateRunning ? updateProgressText : updateResultTitle }}
              </span>
            </div>
            <div v-if="updateProgressPercent !== null" class="wizard-progress-track">
              <div
                class="wizard-progress-bar"
                :style="{ width: `${updateProgressPercent}%` }"
              ></div>
            </div>
            <p v-if="updateBytes" class="wizard-progress-bytes">{{ updateBytes }}</p>
            <!-- 收尾三个事实：更新前（版本 + 档位）、更新后（**实测**的版本）、结论（需求 §8.2） -->
            <p v-if="nodeUpdateSettled && updateResultChannels" class="wizard-progress-bytes">
              {{ updateResultChannels }}
            </p>
            <p v-if="nodeUpdateSettled && updateResultFact" class="wizard-progress-bytes">
              {{ updateResultFact }}
            </p>
            <div v-if="nodeUpdateRunning && updateCanStop" class="btn-row">
              <button class="btn small" @click="stopUpdate">
                {{ updateStopLabel(install) }}
              </button>
            </div>
            <div v-else-if="!nodeUpdateRunning" class="btn-row">
              <button class="btn small" @click="refresh">重新检测</button>
              <button
                v-if="installOutcome === 'refused'"
                class="btn small"
                @click="openDownloadPage"
              >
                打开官方下载页
              </button>
            </div>
            <div v-if="asksRestartDsh" class="wizard-decide">
              {{ nodeAffectsDshText }}
              <div class="btn-row">
                <button class="btn small" @click="restartDsh">重新启动 dsh</button>
                <button class="btn small" @click="dismissRestart">先不用</button>
              </div>
            </div>
          </div>

          <!-- 确认区：就在这一行下面展开。命令原文与目标目录都来自主进程的 plan，不弹原生对话框 -->
          <div
            v-if="confirming && confirming === check.fixAction && confirmPlan"
            class="env-confirm"
          >
            <div class="env-confirm-title">将要执行</div>
            <code class="env-confirm-cmd">{{ confirmPlan.display }}</code>
            <p class="env-confirm-line">
              会装进：{{ confirmPlan.target || '（目录由 npm 自己决定）' }}
            </p>
            <p class="env-confirm-line">{{ confirmPlan.note }}</p>
            <div class="btn-row">
              <button class="btn small primary" :disabled="running || busy" @click="startConfirmed">
                开始
              </button>
              <button class="btn small" @click="cancelConfirm">取消</button>
            </div>
          </div>
        </li>
      </ul>

      <!-- 流式输出：npm 的原文照贴，不假装进度条（与插件页、dsh 终端同族） -->
      <div v-if="outputOpen && fixPhaseLabel" class="env-op">
        <div class="env-op-head">
          <span class="env-op-cmd">{{ envFix.command || '（命令由主进程现算）' }}</span>
          <span class="env-op-state" :data-state="envFix.phase">{{ fixPhaseLabel }}</span>
          <span class="spacer"></span>
          <button v-if="running" class="btn tiny" @click="interrupt">中断</button>
          <button v-else class="btn tiny" @click="dismissOutput">收起</button>
        </div>
        <pre ref="outRef" class="env-op-out">{{ envFixOutput || '（等待输出…）' }}</pre>
        <p v-if="envFix.message" class="env-op-summary" :data-state="envFix.phase">
          {{ envFix.message }}
        </p>
      </div>
    </template>

    <!-- 安装下载来源：全应用只有这一处控件（交互 §9.1）。改完要保存才生效，不静默换源。
         它不依赖自检报告，所以放在报告之外 —— 探测失败时用户仍然能改来源再试。 -->
    <section class="panel env-source">
      <div class="env-source-row">
        <label class="env-source-label" for="env-node-source">安装下载来源</label>
        <input
          id="env-node-source"
          ref="sourceRef"
          v-model="sourceDraft"
          class="env-source-input"
          type="text"
          placeholder="留空 = 官方地址"
          spellcheck="false"
        />
        <button class="btn small" :disabled="!sourceDirty" @click="saveSource">保存</button>
        <span class="env-source-note">{{ sourceDirty ? '改了还没保存' : sourceStatus }}</span>
      </div>
      <p class="env-source-hint">
        留空 =
        从官方地址直接下载。填了就用你填的那个地址下载，只影响我们自己发起的下载，不改这台电脑上的任何配置。
      </p>
    </section>
  </div>
</template>

<style scoped>
/* 环境自检页自己的样式（t48 样式分层）：原来在 styles.css 的「环境自检」与
   「环境自检页：更新入口与下载来源」两节。留在全局表的是与别处共用的：
   `.env` 外层 / `.env-actions`（设置页的「运行环境」卡）与 `.env-op*`
   （环境向导的执行输出面板，两处同形）。 */

/* 版本区间的出处：dsh 与它依赖链的要求（构建期那句是另一个区间，只judge「应用自带运行时」），
   所以写在这一屏里，不藏在 tooltip */
.env-scope {
  margin: 0;
  color: var(--ink-faint);
  font-size: var(--t-xs);
  line-height: 1.8;
}

.env-scope code {
  padding: 1px 5px;
  border: 1px solid var(--hairline);
  border-radius: 4px;
  background: var(--well);
  color: var(--code-ink);
  font-family: var(--mono);
}

.env-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  list-style: none;
  margin: 0;
  padding: 0;
}

.env-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  flex-wrap: wrap;
  padding: 12px 16px;
  border-top: 1px solid var(--hairline);
}

.env-row:first-child {
  border-top: 0;
}

.env-row .lamp {
  margin-top: 5px;
}

.env-row[data-status='ok'] .lamp {
  background: var(--run);
  box-shadow: 0 0 0 3px var(--run-soft);
}

/* 能用但有隐患：空心点表达"还没到不能用的地步" */
.env-row[data-status='warn'] .lamp {
  background: transparent;
  border: 1.5px solid var(--amber);
}

.env-row[data-status='missing'] .lamp {
  background: var(--rose);
  box-shadow: 0 0 0 3px var(--rose-soft);
}

/* 基宽必须是 **0**，不能是 `auto`（§7.27）。
   `.env-row` 是 `flex-wrap: wrap` 的一行（后两个 100% 宽的子块要靠它换行），而
   `flex-basis: auto` 用的是**内容自己的宽度** —— 说明一长（node / dsh / dsh-run 那几行是两条
   长路径），它就可能放不进这一行，于是整块被挪到下一行、圆点一个人留在上面。实测（窗口
   1220 / 900 / 760 / 640）：`auto` 时被挤下去的行数是 0 / 4 / 5 / 7，`0` 时全是 0。
   基宽 0 的代价是这一列不再有"内容宽度"这个参考 —— 但它本来就要 flex-grow 填满剩余空间。 */
.env-main {
  flex: 1 1 0;
  min-width: 0;
}

.env-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.env-title {
  font-size: var(--t-md);
  font-weight: 600;
  color: var(--ink);
}

.env-state {
  font-size: var(--t-xs);
  color: var(--ink-faint);
}

.env-row[data-status='ok'] .env-state {
  color: var(--run);
}

.env-row[data-status='warn'] .env-state {
  color: var(--amber);
}

.env-row[data-status='missing'] .env-state {
  color: var(--rose);
}

.env-detail {
  margin: 3px 0 0;
  color: var(--ink-dim);
  font-size: var(--t-sm);
  line-height: 1.7;
  overflow-wrap: anywhere;
  user-select: text;
}

/* 说明按路径分隔符切出来的片段：**片段内部不许再断**。
   不这么写的话，`@deepseek-ai` 里那个连字符本身就是一个断点（UAX#14 的 HY），
   于是窄窗口下又会断成 `…/@deepseek-` + `ai/dsh/lib/bin.js` —— 正是要修的那个样子
   （实测视口 760：加这条之前断在连字符上、之后断在 `/` 上）。 */
.env-seg {
  white-space: nowrap;
}

.env-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0 0;
}

.env-hint code {
  padding: 2px 7px;
  border: 1px solid var(--hairline);
  border-radius: 5px;
  background: var(--well);
  color: var(--code-ink);
  font-family: var(--mono);
  font-size: var(--t-xs);
  overflow-wrap: anywhere;
  user-select: text;
}

/* 归属认不出来那一行：不给「更新」，把那条诚实边界与两条出路整行铺开在这一行里
   （需求 §7.7 第 3 条 / 交互 §10.2） */
.env-owner-note {
  flex: 1 1 100%;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 2px;
  padding: 8px 10px;
  border: 1px solid var(--hairline);
  border-left: 3px solid var(--amber);
  border-radius: var(--r-control);
  background: var(--amber-soft);
}

.env-owner-note-text {
  flex: 1 1 240px;
  min-width: 0;
  color: var(--ink-dim);
  font-size: var(--t-xs);
  line-height: 1.7;
} /* ============================================================ 环境自检页：更新入口与下载来源
   这一页是既有页面，只加不改造（docs/env-wizard-visual.md §5.9）。 */

.env-skip {
  display: inline-flex;
  align-items: center;
  height: 23px;
  padding: 0 9px;
  background: var(--surface-2);
  border-radius: 999px;
  color: var(--ink-dim);
  font-size: var(--t-xs);
}

.env-source {
  flex: 0 0 auto;
  padding: 14px 16px;
}

.env-source-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.env-source-label {
  color: var(--ink);
  font-size: var(--t-md);
  font-weight: 600;
}

.env-source-input {
  flex: 1 1 260px;
  min-width: 0;
  height: 30px;
  padding: 0 10px;
  background: var(--well);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--r-control);
  color: var(--ink);
  font-size: var(--t-sm);
  transition:
    border-color var(--dur) ease,
    box-shadow var(--dur) ease;
}

.env-source-input::placeholder {
  color: var(--ink-faint);
}

.env-source-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--focus);
}

.env-source-note {
  color: var(--ink-faint);
  font-size: var(--t-xs);
}

.env-source-hint {
  margin-top: 8px;
  color: var(--ink-dim);
  font-size: var(--t-sm);
  line-height: 1.7;
}

/* 这条原来放在「首启环境向导」一节里，但只有环境自检详情页用（向导不画它） */

/* 读数态：占着同一槽位，但它是信息不是按钮 —— 不降透明度、不带主色 */
.wizard-readout {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 27px;
  padding: 0 10px;
  background: var(--surface-2);
  border: 1px solid var(--hairline);
  border-radius: var(--r-control);
  color: var(--ink-faint);
  font-size: var(--t-xs);
  font-variant-numeric: tabular-nums;
}

/* 环境自检页的外层（t48 样式分层）：`.env` 与它的条，只有这一页用 */

/* ============================================================ 环境自检

   一页回答"这台机器行不行"：八项一行的清单 + 一键修复。三种状态只靠左侧状态点的
   形状与颜色区分（绿实心 / 黄空心 / 红实心），文字侧另给一个词（正常 / 需要注意 /
   不可用）—— 不让用户去读 detail 那句人话判断严重程度。颜色一律走变量。 */

.env {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  /* 页面级内边距由这一页自己给（.pane 没有任何 padding，见 AGENTS 7.14） */
  padding: 0 20px 20px;
}

/* 工具条自己有左右 20px 内边距，而根容器已经让出了这一份，别再叠一次 */
.env > .bar {
  padding: 10px 0;
}
</style>
