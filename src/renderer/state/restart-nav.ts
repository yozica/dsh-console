/**
 * 「重启 dsh 之后自动进 Harness」这一段的共享状态（t46，规格 `docs/plugin-restart.md`）。
 *
 * 为什么要有这么一个模块：这条流程有**四个入口**（插件页「立即重启 dsh」、控制台「重启」、
 * 环境自检「重新启动 dsh」、Harness 页「重启为受管实例」），而"等就绪 → 自动切页 → 说一句"
 * 这一段必须**只有一份**：
 *
 *   - 谁写：四个入口都先 `beginRestartNav(reason)` 立意图，再调 `restartThenOpenHarness()`；
 *     真正干活的是 `renderer/app.ts`（它持有启动锁那台单向状态机，也就只有它能开新回合）；
 *   - 谁读：插件页拿它渲染黄条的四种状态；Harness 页读 `harnessArrivalNotice` 显示到达提示。
 *
 * **顺序很要紧：意图必须在调 `restart()` 之前立。** `dshManager.start()` 一 spawn 完就返回
 * （不等健康检查），相位很快会从 `running` 跳到 `stopping` / `stopped` / `starting`；等 IPC
 * 回来再立意图，那 5 秒上锁窗口早就过去了 —— 锁永远不会出现。
 *
 * **这一份只管状态，不碰 DOM、也不碰重启动作**（那两个在 `state/restart-flow.ts`）：自检要
 * 直接 import 它来钉"就绪判据"这个纯函数，而自检的编译图（`tsconfig.node.json`）里没有
 * DOM 类型 —— 一旦这里出现 `window` / `alert`，`npm test` 就先红在类型上。分层是：
 *
 *   state/restart-nav.ts    状态 + 纯判据 + 文案（无 DOM，可被自检直接 import）
 *   state/restart-flow.ts   编排：立意图 → 重启 → 失败说实话（有 alert，谁也别 import 它）
 *   app.ts                等就绪 / 超时 / 收尾，并在就绪那一刻切页 + 发状态栏消息
 */

import { ref, type Ref } from 'vue';

import type { DshPhase } from '../../shared/ipc';

/** 谁发起的那一轮重启（决定状态栏与到达提示怎么说） */
export type RestartReason = 'plugin' | 'dashboard' | 'env' | 'ui';

/**
 * 这一轮的结局：
 *   idle     没有在等（默认）
 *   pending  正在等 dsh 就绪
 *   ready    就绪了，页面已经切过去
 *   failed   重启这件事本身失败（IPC 报错 / 端口被占）
 *   unready  重启动作发出去了，但相位落到起不来的状态、或超过 90 秒还没就绪
 *   external 端口上的 dsh 变成了外部实例（拿不到令牌，切过去也只会看到 401 说明）
 *   escaped  用户在锁上说了「不等了」/ 按了 Esc —— 取消这次跳转（唯一会取消的路径）
 */
export type RestartOutcome =
  'idle' | 'pending' | 'ready' | 'failed' | 'unready' | 'external' | 'escaped';

export interface RestartNavState {
  reason: RestartReason;
  outcome: RestartOutcome;
  /** 这一轮开始的时刻（面板上算「已等待 N 秒」与超时） */
  startedAt: number;
  /** 失败原因（只有 `failed` 有） */
  error: string | null;
  /**
   * 有没有**看见这一轮真的把旧实例停掉过**（相位离开 `running`）。
   *
   * 为什么需要它：立意图那一刻旧实例还是 `running` 且带着旧令牌 —— 只按"现在 running + 有令牌"
   * 判就绪，会在点下去的那一瞬间就判成"已完成"，页面立刻切走、锁根本不出现（真机实测踩到过：
   * 点完 600ms 就已经在 Harness 页了，而重启其实还在后头跑）。
   */
  leftRunning: boolean;
  /**
   * 有没有看见它**真的开始起**了（相位到过 `starting`）。
   *
   * 为什么需要它：重启的相位序列是 `running → stopping → stopped → starting → running`，
   * 中间那个 `stopped` 是**过程**不是结果 —— 不加这道闸，"起不来"的判据会在停旧实例那一刻
   * 就判定失败（真机实测踩到过：dsh 明明起来了，结局却是「dsh 还没起来」）。
   */
  sawStarting: boolean;
  /** 立意图那一刻的带令牌地址（用来兜住"没看见中间相位"的极端情况：令牌是每进程随机的） */
  uiUrlAtBegin: string | null;
}

export const restartNav: Ref<RestartNavState> = ref({
  reason: 'plugin',
  outcome: 'idle',
  startedAt: 0,
  error: null,
  leftRunning: false,
  sawStarting: false,
  uiUrlAtBegin: null,
});

/** Harness 页顶上那条「刚刚重启过」的到达提示；`null` = 不显示（可关闭，关掉就清空） */
export const harnessArrivalNotice: Ref<string | null> = ref(null);

/**
 * 「轻提示」自己待多久（t46 修正）。
 *
 * 用户裁定：**不要常驻提示**（原来那条带「知道了」的横条太吵），"确认一下"就够了 ——
 * 所以它只是**借工具栏右端已有的状态槽**（`#ui-note`）亮一下：4 秒后自己换回「已载入 …」。
 * 不新增任何表面，也不遮内嵌界面的内容（原来那条浮在正文上的胶囊被用户否了：
 * "不好看，你学一下UI设计呗" —— 摆法与取舍见 docs/harness-arrival-design.html）。
 */
export const ARRIVAL_TOAST_MS = 4000;
let arrivalTimer: ReturnType<typeof setTimeout> | null = null;
function clearArrivalTimer(): void {
  if (arrivalTimer !== null) clearTimeout(arrivalTimer);
  arrivalTimer = null;
}

/**
 * 就绪判据（纯函数，自检直接钉）。
 *
 * **必须带 `uiUrl`**：只看 `running` 就切过去，Harness 页会停在「还没捕获到带令牌的地址」
 * 那一屏 —— 令牌是 dsh 启动时打印的，健康检查通过之后还要再等它出现在输出里。
 * 切过去看见 401 说明，比不切更让人糊涂（`docs/plugin-restart.md` §2.3）。
 */
export function isRestartReady(phase: DshPhase, uiUrl: string | null | undefined): boolean {
  return phase === 'running' && Boolean(uiUrl);
}

/** 相位落到了"起不来"的终态（`stopping` / `starting` 还在路上，不算） */
export function isRestartStalled(phase: DshPhase): boolean {
  return phase === 'stopped' || phase === 'degraded' || phase === 'conflict';
}

/**
 * **这一轮判定"起不来"了**：必须先是见它 `starting` 过（真的尝试起过），再落到终态。
 *
 * 只看 `isRestartStalled` 会把"停旧实例"那一刻当成失败 —— 重启必然经过 `stopped` 那一段
 * （真机实测踩到过：dsh 已经起来了，界面上却写「dsh 还没起来」）。
 */
export function restartStalled(nav: RestartNavState, phase: DshPhase): boolean {
  return nav.sawStarting && isRestartStalled(phase);
}

/**
 * **这一轮真的到了**：先看见它把旧实例停过（或者令牌地址确实换了），并且现在是 `running` + 有令牌。
 *
 * 这是编排与 `app.ts` 真正用的判据；`isRestartReady` 只是它的后半句（单看那一句会误判，
 * 见上面 `leftRunning` 的说明）。两个都是纯函数，自检直接喂值试。
 */
export function restartArrived(
  nav: RestartNavState,
  phase: DshPhase,
  uiUrl: string | null | undefined,
): boolean {
  if (!isRestartReady(phase, uiUrl)) return false;
  return nav.leftRunning || nav.uiUrlAtBegin !== (uiUrl ?? null);
}

/**
 * 到了 Harness 页之后那句**轻提示**的正文。
 *
 * 短到一眼看完（用户："给个轻提示就可以了"）—— 它显示在工具栏右端那条已有的状态槽里
 * （`#ui-note`，平时写着「已载入 …」），所以**必须短**：那一格宽度有限，长了会被省略号截掉。
 * 长解释留在插件页那条黄条里（它已经写着「dsh 已重启，装配层的改动已加载。」）。
 */
const ARRIVAL: Record<RestartReason, string> = {
  plugin: '✓ 装配层改动已加载',
  dashboard: '✓ dsh 已重启',
  env: '✓ Node 改动已生效',
  ui: '✓ 已接管为受管实例',
};

const READY_MESSAGE: Record<RestartReason, string> = {
  plugin: '插件已生效，已打开 DeepSeek Harness',
  dashboard: 'dsh 已重启，已打开 DeepSeek Harness',
  env: 'Node 更新已生效，已打开 DeepSeek Harness',
  ui: '已接管为受管实例，内嵌界面已可用',
};

/** 到了 Harness 页之后那条提示的正文 */
export function arrivalNotice(reason: RestartReason): string {
  return ARRIVAL[reason];
}

/** 就绪时状态栏那句（走既有的 `dsh:status-message` 通道） */
export function readyMessage(reason: RestartReason): string {
  return READY_MESSAGE[reason];
}

/** 立意图：这一轮开始等（**调 `restart()` 之前**调用） */
export function beginRestartNav(reason: RestartReason, uiUrlAtBegin: string | null = null): void {
  // 新一轮开始时把上一条到达提示收掉：它说的是"上一轮已经生效"，而这一刻 dsh 正在重启，
  // 挂在那儿就是过期信息（用户可能正开着 Harness 页看着它）。
  clearArrivalTimer();
  harnessArrivalNotice.value = null;
  restartNav.value = {
    reason,
    outcome: 'pending',
    startedAt: Date.now(),
    error: null,
    leftRunning: false,
    sawStarting: false,
    uiUrlAtBegin,
  };
}

/** 看见相位离开 `running` 了：旧实例正在停 —— 从这一刻起"就绪"才有意义 */
export function markRestartTeardown(): void {
  if (restartNav.value.leftRunning) return;
  restartNav.value = { ...restartNav.value, leftRunning: true };
}

/** 看见它到 `starting` 了：从这一刻起"起不来"才判得准（见 `restartStalled`） */
export function markRestartStarting(): void {
  if (restartNav.value.sawStarting) return;
  restartNav.value = { ...restartNav.value, sawStarting: true };
}

/** 收尾：把结局写上（`app.ts` 的监视器与四个入口都走这里） */
export function settleRestartNav(outcome: RestartOutcome, error: string | null = null): void {
  restartNav.value = { ...restartNav.value, outcome, error };
}

/** 回到"没在等"（新一轮安装 / 用户关掉黄条 / 外部实例的确认框被取消） */
export function clearRestartNav(): void {
  restartNav.value = { ...restartNav.value, outcome: 'idle', error: null };
}

/** 关掉 Harness 页上那条到达提示 */
/** 手动收掉（目前只有"新一轮重启开始"这条内部路径用得到；界面上没有关闭按钮） */
export function dismissHarnessArrival(): void {
  clearArrivalTimer();
  harnessArrivalNotice.value = null;
}

/**
 * 就绪那一刻：留下到达提示 + 收尾（`app.ts` 调，它随后自己往状态栏发一句
 * `readyMessage()`）。这里**不碰 DOM**，见文件头的分层说明。
 */
export function arriveAtHarness(reason: RestartReason): void {
  // 轻提示：亮一下、自己消失 —— 不需要用户做任何事（见 ARRIVAL_TOAST_MS）
  clearArrivalTimer();
  harnessArrivalNotice.value = arrivalNotice(reason);
  arrivalTimer = setTimeout(() => {
    arrivalTimer = null;
    harnessArrivalNotice.value = null;
  }, ARRIVAL_TOAST_MS);
  settleRestartNav('ready');
}
