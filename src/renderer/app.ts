/**
 * 渲染层剩下的"应用级胶水"：没有 DOM 归属、但需要一个地方待着的逻辑。
 *
 * 界面本身已经全部是 Vue 组件了（shell/ 是外壳，panes/ 是页面，lib/ 是共享状态与工具），
 * 这里只留四件事：
 *   1. 启动守卫（preload / xterm 没就绪时给一句能看懂的报错，而不是白屏）
 *   2. 启动锁：应用启动时自动拉起 dsh 的那几秒，锁住界面，就绪后解锁
 *   3. 自动打开：dsh 就绪后按设置切到 Harness 页并进全屏
 *   4. 键盘快捷键：Ctrl+R / ⌘R 重载、Ctrl+1~7 / ⌘1~7 切页、Esc 退出全屏/跳过启动锁
 *   5. 重启之后自动进 Harness：四个入口（插件页 / 控制台 / 环境自检 / 重启为受管实例）
 *      点了重启之后，等 dsh 就绪再切到 Harness 页 —— 见 `lib/restart-nav.ts` 与 docs/plugin-restart.md
 *
 * 它们都在"状态之上"而不是"界面之上"，所以不需要组件外壳；等启动锁也做成组件后，
 * 这里会只剩守卫与快捷键。
 */

import { computed, watch } from 'vue';

import { phaseText } from './lib/phase-text.js';
import { isAppModifier } from './lib/platform.js';
import { setBootLockVisible } from './lib/boot-lock.js';
import {
  arriveAtHarness,
  markRestartStarting,
  markRestartTeardown,
  readyMessage,
  restartArrived,
  restartNav,
  restartStalled,
  settleRestartNav,
} from './lib/restart-nav.js';
import { escapeGate, gateVisible, gatePhase, loadWizard, wireEnvWizard } from './lib/env-wizard.js';
import {
  currentTab,
  dsh,
  immersive,
  immersiveAutoEntered,
  uiLoadable,
  settings,
  snapshot,
  startStore,
  type TabId,
} from './lib/store.js';
import type { DshPhase } from '../shared/ipc';

const api = window.dshConsole;

function showBootError(message: string): void {
  const div = document.createElement('div');
  div.id = 'boot-error';
  div.textContent = `DSH Console 启动失败\n\n${message}`;
  document.body.appendChild(div);
}

if (!api) {
  showBootError(
    'preload 未注入：window.dshConsole 不存在。请检查 src/preload/preload.ts 是否被编译到 dist/preload/。',
  );
} else {
  void main();
}

async function main(): Promise<void> {
  await startStore();
  // 首启环境向导：先建订阅（幂等），再发起第一轮判定。
  // 第一轮在挂载后立刻发起，是为了"报告还没回来时也不许空白"（交互 §2.3）——
  // 门禁层自己读相位，这里只负责把这一轮推起来。
  wireEnvWizard();
  void loadWizard();
  wireBootLock();
  wireAutoOpen();
  wireRestartNav();
  wireImmersive();
  wirePaneVisibility();
  wireShortcuts();
  wireGateAutoStart();
  announceUpdate();
}

// ------------------------------------------------------------ 升级提示

/**
 * 覆盖升级后的第一次启动：NSIS 会用 `--updated` 拉起应用（见 electron-builder 的
 * NSIS 模板），主进程把它放进快照的 env，这里在状态栏说一句。
 *
 * 之所以延迟一下：启动锁盖着整个界面（含状态栏），立刻说会被盖掉。
 */
function announceUpdate(): void {
  if (!snapshot.value?.env?.updated) return;
  const version = snapshot.value.env.app || '';
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('dsh:status-message', { detail: `已更新到 ${version}` }));
  }, 2000);
}

// ------------------------------------------------------------ 应用内全屏

/**
 * 全屏状态住在 store 里（顶栏的「退出全屏」、Harness 页的「全屏」按钮、Esc 都改它），
 * 但**真正让界面变全屏的是 CSS** —— 它认的是 body[data-immersive]。
 * 所以这里必须把这个属性同步出去，否则按钮改了状态、界面毫无反应
 * （踩过：重写 app.ts 时漏了这一段，全屏整个失效）。
 */
function wireImmersive(): void {
  watch(
    immersive,
    (on) => {
      document.body.dataset.immersive = on ? 'true' : 'false';
    },
    { immediate: true },
  );
}

// ------------------------------------------------------------ 页面可见性

/**
 * 切页时把 active 类打到页面容器上（`.pane.active { visibility: visible }` 是
 * 这一页显示与否的唯一开关 —— 刻意不用 display:none，因为内嵌页需要常驻布局）。
 *
 * 页面容器目前还留在 index.html 里（七个 <section class="pane">），所以这段归属
 * "应用级胶水"。等它们也搬进一个根组件，这段就该由模板的 :class 直接表达。
 */
function wirePaneVisibility(): void {
  watch(
    currentTab,
    (name) => {
      for (const pane of document.querySelectorAll('.pane')) {
        pane.classList.toggle('active', pane.id === `pane-${name}`);
      }
    },
    { immediate: true },
  );
}

// ------------------------------------------------------------ 启动锁

/**
 * 应用启动时由本应用自动拉起 dsh 的那几秒，界面状态还在变、点哪儿都不作数，
 * 所以锁住整个窗口；等 dsh 就绪、Harness 页打开后解锁。
 * 失败 / 异常 / 超时 / 手动跳过，一律解锁 —— 锁只是免打扰，不是把人关在外面。
 *
 * 状态机只能单向推进：idle → waiting → done。
 * 早期版本用"布尔量 + 每次状态变化重新判定"，结果解锁后只要条件又变回不满足
 * （例如用户手动退出全屏），锁就会重新扣上来 —— done 之后直接返回，杜绝这类回归。
 */
const BOOT_LOCK_MAX_MS = 90000;
/**
 * 「向导结束 → 自动启动」那一回合等相位变成 `starting` 的窗口（冻结 §0.4 的 R-32）。
 * 过了这个窗口还没等到，就说明这一轮**没有等待可等**（dsh 已经在跑 / 只是接管了外部实例 /
 * 启动失败），回合收掉、锁不出现 —— 也绝不会把用户以后自己点的「启动」算进这一轮。
 */
const GATE_ARM_WINDOW_MS = 5000;
/**
 * 「重启 dsh」那一回合的窗口（t46）。比 R-32 那个长：重启要**先把旧实例停掉、等端口真正释放**
 * （`dshManager.restart()` 里最长等 10 秒）才轮到 `starting` —— 5 秒窗口会在"等端口"那一段过期，
 * 于是重启永远不上锁（真机实测踩到过：锁迟迟不出现）。**过期只由这个定时器管**，不看中间相位。
 */
const RESTART_ARM_WINDOW_MS = 20000;
type BootLockState = 'idle' | 'waiting' | 'done';
/**
 * 启动锁的"回合"：应用启动那一次 / 向导结束后自动启动那一次（R-32）/
 * 点了「重启 dsh」之后那一次（t46，docs/plugin-restart.md）。
 * 三个回合共用同一台单向状态机 —— 每一步都只是"显式开一个新回合"，不许改成可重入。
 */
type BootLockEpisode = 'startup' | 'afterGate' | 'afterRestart';
let bootLockState: BootLockState = 'idle';
let bootLockEpisode: BootLockEpisode = 'startup';
let bootLockDeadline = 0;
let bootLockStartedAt = 0;
/** 回合窗口的定时器（真的等到 `starting` 上锁之后就清掉） */
let gateArmTimer: ReturnType<typeof setTimeout> | null = null;

function setBootLock(on: boolean): void {
  document.body.dataset.locked = on ? 'true' : 'false';
  document.getElementById('boot-lock')?.classList.toggle('hidden', !on);
  // 门禁层与启动锁互斥（冻结 §1 R-08）：锁是否在显示中是一个**可读的共享状态**，
  // 不让两个覆盖层各自猜。`gateVisible` 读它，所以这一行是那条规则的唯一落点。
  setBootLockVisible(on);
}

/** 解锁是一次性的：走到 done 就再也不会重新上锁 */
function releaseBootLock(): void {
  bootLockState = 'done';
  setBootLock(false);
  // 把标题/说明还原成"启动"那一套：锁已经藏起来，但 DOM 里不该留着"正在重新启动"
  // （下一次上锁会按回合重新写一遍，还原只是不让静态文案与语义漂开）
  bootLockEpisode = 'startup';
  applyLockCopy();
}

/**
 * 给"向导结束后的自动启动"开一个**新的单向回合**（冻结 §0.4 的 R-32）。
 *
 * 这是让启动锁重新走一轮的**唯一**入口，只在放行页点「进入 DSH Console」那一条路上调用
 * （逃生口不调 —— 用户刚说了「不等了」）。之所以是"显式开一个回合"而不是把状态机改成
 * 可重入：早期那版用"布尔量 + 每次状态变化重新判定"，解锁之后只要条件又变回不满足
 * （例如手动退出全屏），锁就重新扣上来 —— 那是 AGENTS §7.9 修掉的 bug。
 *
 * 上锁本身仍然只有一处（`updateBootLock` 的 idle 分支看 `phase === 'starting'`），
 * 这里只是把回合位重置成 `idle` 并挂一个窗口定时器：窗口内没等到 `starting` 就把回合收成
 * `done`（没有等待就不上锁），于是"用户以后自己点启动"永远落不进这一轮。
 */
function armEpisode(episode: BootLockEpisode, windowMs: number = GATE_ARM_WINDOW_MS): void {
  bootLockEpisode = episode;
  bootLockState = 'idle';
  bootLockDeadline = 0;
  if (gateArmTimer !== null) clearTimeout(gateArmTimer);
  gateArmTimer = setTimeout(() => {
    gateArmTimer = null;
    if (bootLockState === 'idle') bootLockState = 'done';
  }, windowMs);
}

function armAfterGate(): void {
  if (bootLockEpisode === 'afterGate') return;
  armEpisode('afterGate');
}

/**
 * 第三回合：点了「重启 dsh」之后那一次（t46 / `docs/plugin-restart.md`）。
 *
 * 与第二回合逐字同构（同样的 5 秒窗口、"没有等待就不上锁"），只有两处不同：
 *   · 锁上的说明换成「就绪后自动打开 DeepSeek Harness」（那一轮不抢屏，见规格 §1 的 4A）；
 *   · 用户在锁上按「不等了 / Esc」时**取消这次跳转**（第二回合本来就没有跳转可取消）。
 * 与 `armAfterGate` 的区别：这里**每次都重新开**（用户可能重启第二次），所以不带幂等守卫。
 */
function armAfterRestart(): void {
  armEpisode('afterRestart', RESTART_ARM_WINDOW_MS);
}

/** 三个回合的锁文案（`index.html` 里那两句静态文案是"启动"语境的，重启要换掉） */
const LOCK_COPY: Record<BootLockEpisode, { title: string; desc: string; noteTail: string }> = {
  startup: {
    title: '正在启动 dsh 服务',
    desc: '正在拉起进程并等待健康检查',
    noteTail: '就绪后自动打开 DeepSeek Harness 并进入全屏',
  },
  afterGate: {
    title: '正在启动 dsh 服务',
    desc: '正在拉起进程并等待健康检查',
    noteTail: '就绪后自动打开 DeepSeek Harness 并进入全屏',
  },
  afterRestart: {
    title: '正在重新启动 dsh',
    desc: '正在拉起进程并等待健康检查',
    noteTail: '就绪后自动打开 DeepSeek Harness',
  },
};

function applyLockCopy(): void {
  const copy = LOCK_COPY[bootLockEpisode];
  const title = document.getElementById('boot-title');
  const desc = document.getElementById('boot-desc');
  if (title) title.textContent = copy.title;
  if (desc) desc.textContent = copy.desc;
}

/** 锁上的那几秒给个时间感：已等待几秒 + 接下来会自动发生什么 */
function updateBootLockNote(): void {
  if (bootLockState !== 'waiting') return;
  const waited = Math.max(1, Math.round((Date.now() - bootLockStartedAt) / 1000));
  const note = document.getElementById('boot-note');
  if (note) note.textContent = `已等待 ${waited} 秒 · ${LOCK_COPY[bootLockEpisode].noteTail}`;
}

function updateBootLock(phase: DshPhase): void {
  if (bootLockState === 'done') return;

  if (bootLockState === 'idle') {
    // 只有"这一轮是我们自己在拉起"才加锁：应用启动那一次、以及放行页进入之后自动启动那一次
    // （`armAfterGate()` 开的第二回合，R-32）。用户自己点「启动」不加锁（那时他要看日志）——
    // 第二回合的窗口已经把这种情形挡在外面了。
    if (phase !== 'starting') {
      // 别的回合：没等到 `starting` 就说明"没有等待可等"（dsh 已经在跑 / 只是接管外部实例），
      // 回合收掉。**但 afterRestart 例外**：它的相位序列必然先经过 `stopping` / `stopped`
      // （停旧实例、等端口释放），那不是"没有等待"—— 这一回合的过期只由窗口定时器管。
      if (bootLockEpisode !== 'afterRestart') bootLockState = 'done';
      return;
    }
    if (gateArmTimer !== null) {
      clearTimeout(gateArmTimer);
      gateArmTimer = null;
    }
    bootLockState = 'waiting';
    bootLockStartedAt = Date.now();
    bootLockDeadline = Date.now() + BOOT_LOCK_MAX_MS;
    applyLockCopy();
    setBootLock(true);
    updateBootLockNote();
  }

  // waiting：就绪 = dsh 跑起来了、该开的页面也开了
  // （自动全屏和"打开 Harness 页"是同一次流程里做的，所以不把全屏当解锁条件）
  const wantsUi = Boolean(settings.value.openUiOnStart);
  const ready = phase === 'running' && (!wantsUi || harnessAutoOpened);
  const abnormal = ['stopped', 'degraded', 'conflict', 'external'].includes(phase);
  const timedOut = Date.now() > bootLockDeadline;

  if (ready || abnormal || timedOut) {
    releaseBootLock();
    return;
  }
  const desc = document.getElementById('boot-desc');
  if (desc) desc.textContent = phaseText(phase).desc || '正在拉起进程并等待健康检查';
}

/**
 * 用户在锁上说了「不等了」/ 按了 Esc：这是**唯一会取消跳转**的路径 ——
 * 他表达的是"别替我做主"，那就只解除等待，不再抢页面（规格 §2.4）。
 * 其它回合（启动 / 向导之后）没有跳转可取消，这里是个空操作。
 */
function userSkipBootLock(): void {
  if (restartNav.value.outcome === 'pending') settleRestartNav('escaped');
  releaseBootLock();
}

function wireBootLock(): void {
  document.getElementById('btn-boot-skip')?.addEventListener('click', () => userSkipBootLock());
  setInterval(() => {
    updateBootLockNote();
    // 锁着的时候超时判定也得跑，否则状态不再变化就永远不解锁
    if (bootLockState === 'waiting' && dsh.value) updateBootLock(dsh.value.phase);
  }, 1000);
  watch(
    () => dsh.value?.phase || 'stopped',
    (phase) => updateBootLock(phase),
    { immediate: true },
  );
}

// ------------------------------------------------------------ 自动打开

/**
 * 启动时是否已经自动打开过 Harness 页。
 * （注意：store 里也有一个同名的 ref，那是给组件读的"是否已自动打开"；这里是本模块内部
 * 用来防重复触发的一次性开关，两者互不影响。）
 */
let harnessAutoOpened = false;

/**
 * dsh 就绪后按设置切到 Harness 页并进全屏 —— "打开应用直接开始用"。
 * 只在应用启动后发生一次（用户后来自己点「启动」不会把界面抢走）。
 */
function wireAutoOpen(): void {
  watch(
    () => dsh.value?.phase,
    (phase) => {
      if (harnessAutoOpened || phase !== 'running' || !settings.value.openUiOnStart) return;
      harnessAutoOpened = true;
      if (currentTab.value !== 'ui') currentTab.value = 'ui';
      // 切页时 UiPane 已按设置进过一次全屏，这里只是兜住"本来就在该页"的情况。
      // 这条只在 phase === 'running'（本应用启动的 dsh）时走得到；界面不可用时不该自动全屏
      // （规则与 store 的 uiLoadable 一致：外部实例没有令牌时那边也不会全屏）。
      if (!immersiveAutoEntered.value && settings.value.uiFullscreenOnStart && uiLoadable.value) {
        immersiveAutoEntered.value = true;
        immersive.value = true;
      }
    },
  );
}

// ------------------------------------------------------------ 重启之后自动进 Harness（t46）

/**
 * 「点了重启 → 等就绪 → 自动进 Harness」这一段的**唯一**执行者（规格 `docs/plugin-restart.md`）。
 *
 * 四个入口只负责两件事：先 `beginRestartNav(reason)` 立意图，再调重启流程。这里负责其余全部：
 *   1. 立意图那一刻**显式开第三个锁回合**（`afterRestart`）—— 锁只在相位变 `starting` 的那
 *      5 秒窗口内才会上锁，"没有等待就不上锁"这条老规矩照旧；
 *   2. 就绪（`running` 且拿到带令牌地址）→ 切到 Harness 页 + 留下到达提示 + 状态栏说一句；
 *   3. 起不来 / 被外部接管 / 超过 90 秒 → 不再等（锁那边由它自己的异常分支解锁）。
 *
 * 为什么"就绪判据"里必须有带令牌地址、为什么超时用 `BOOT_LOCK_MAX_MS`：见规格 §2.3 / §2.4。
 */
function wireRestartNav(): void {
  watch(
    () => [restartNav.value.outcome, dsh.value?.phase, dsh.value?.uiUrl] as const,
    () => {
      const nav = restartNav.value;
      if (nav.outcome !== 'pending') return;
      const now = dsh.value;
      if (!now) return;

      // 相位离开 running = 旧实例真的在停。**必须先记这一笔**，否则"点下去那一刻旧实例还是
      // running + 带着旧令牌"就会被判成已就绪，页面立刻切走、锁根本不出现（真机实测踩到过）。
      if (now.phase !== 'running') markRestartTeardown();
      if (now.phase === 'starting') markRestartStarting();

      if (restartArrived(restartNav.value, now.phase, now.uiUrl)) {
        if (currentTab.value !== 'ui') currentTab.value = 'ui';
        // 到达提示 + 收尾在 restart-nav（纯状态），状态栏那句由这里发 —— 它是 DOM 那一边的事
        arriveAtHarness(nav.reason);
        window.dispatchEvent(
          new CustomEvent('dsh:status-message', { detail: readyMessage(nav.reason) }),
        );
        return;
      }
      if (now.phase === 'external') {
        settleRestartNav('external');
        return;
      }
      // 注意是 `restartStalled`（要见过 starting）而不是 `isRestartStalled` ——
      // 重启必然经过 stopped，那一段不是"起不来"（见 lib/restart-nav.ts）
      if (restartStalled(restartNav.value, now.phase)) settleRestartNav('unready');
    },
    { immediate: true },
  );

  // 90 秒上限：与启动锁同一个数。锁自己会在超时那一刻解锁，这里只是"不再等"。
  setInterval(() => {
    const nav = restartNav.value;
    if (nav.outcome !== 'pending') return;
    if (Date.now() - nav.startedAt > BOOT_LOCK_MAX_MS) settleRestartNav('unready');
  }, 1000);

  // 意图一立就开回合。注意**不能**等到 `phase === 'starting'` 才开 —— 那正是锁要等的信号。
  watch(
    () => restartNav.value.outcome,
    (outcome) => {
      if (outcome === 'pending') armAfterRestart();
    },
  );
}

// ------------------------------------------------------------ 快捷键

/** 快捷键切页的顺序（1~7）——与左栏导航一致（终端合并、环境自检挪进设置之后是七项） */
const TAB_ORDER: TabId[] = [
  'dashboard',
  'terminal',
  'ui',
  'usage',
  'archive',
  'plugin',
  'settings',
];

/**
 * 「门禁层此刻接管着界面」——键盘捷径要失效的正是这一段（评审 T11-B）。
 *
 * **它不是 `gateVisible`，两者回答的不是同一个问题**：
 *   - `gateVisible`（`lib/env-wizard.ts`）回答的是「门禁层**该不该**显示」：相位 ∈
 *     {blocked / 本轮属于门禁层的 checking / 挡过人的 released} **且** 启动锁不在显示中。
 *     它是**渲染的输入**，是给组件用的判据。
 *   - 这里要回答的是「用户此刻是不是**被门禁层接管着**、背景里的捷径必须失效」。它是
 *     **用户能不能乱动**的判据。
 *
 * 两者在下面三种情况下**不相等**（所以不能拿一个当另一个用）：
 *   1. `escaped` / `entered` / `done`：用户已经进了主界面，`gateVisible` 恰好也是 false ——
 *      但那是「不该显示」，不是「正在显示」。靠巧合成立的东西会随一次无关改动失效：只要以后
 *      有人给某个收尾相位加一种显示（比如 done 之后再展示一次结果），捷径就会跟着又被吃掉，
 *      而交互 §2.5 写得很清楚 ——「逃生口点了之后恢复」。所以这里**按相位显式放行**，
 *      把语义写在代码里，而不是靠 `gateVisible` 顺带为 false。
 *   2. `unknown`：层收起、主界面 + 常驻黄条，用户同样在主界面里，捷径必须恢复。
 *   3. 启动锁正在显示：`gateVisible` 因为两层互斥而为 false，但那时用户**既不在主界面、
 *      也不在门禁层里** —— 那一段由上面启动锁自己那条分支接管（锁期间一切捷径都挡），
 *      不归门禁管。
 *
 * 判据本身仍然读 `gateVisible`：门禁层在「挡住页 / 检查中 / 挡过人的放行页」之外都收起，
 * 那三种之外的相位由上面那一组显式放行兜住，两件事各说各的。
 */
const gateDiversion = computed(() => {
  const phase = gatePhase.value;
  if (phase === 'escaped' || phase === 'entered' || phase === 'done' || phase === 'unknown') {
    return false;
  }
  return gateVisible.value;
});

function wireShortcuts(): void {
  window.addEventListener('keydown', (event) => {
    // 启动锁期间键盘捷径也一并挡住 —— 锁的意义就是"别乱动"
    if (bootLockState === 'waiting') {
      if (event.key === 'Escape') {
        userSkipBootLock();
        event.preventDefault();
      }
      return;
    }
    // 门禁层接管界面期间（交互 §2.5）：切页与重载捷径一律不生效 —— 背景里没有可达的地方。
    // 键盘用户的前进方向与鼠标用户同一个：逃生口（`Esc` 是它的键盘等价物，
    // 见交互 §0 的安全规则表；Tab / Enter 照旧由门禁层自己的控件处理，这里不拦）。
    //
    // 判据是 `gateDiversion`（「层接管着界面」）而**不是** `gateVisible`（「层该不该显示」）：
    // 逃生 / 放行 / 收尾之后必须立刻恢复 Ctrl+R 与 Ctrl+数字（交互 §2.5），理由见那个常量的注释。
    if (gateDiversion.value) {
      if (event.key === 'Escape') {
        escapeGate();
        event.preventDefault();
        return;
      }
      if (isAppModifier(event)) event.preventDefault();
      return;
    }
    // 全屏时 Esc 退出（这也是键盘用户的唯一出路）
    if (event.key === 'Escape' && immersive.value) {
      immersive.value = false;
      event.preventDefault();
      return;
    }
    // 默认菜单被移除了，Ctrl+R / ⌘R 的默认重载也随之消失；这里补回来
    if (isAppModifier(event) && !event.shiftKey && event.key.toLowerCase() === 'r') {
      location.reload();
      event.preventDefault();
      return;
    }
    // 1~7 对应左栏七项；8 / 9 不再放行（那两项已经合并 / 挪走）
    if (isAppModifier(event) && !event.shiftKey && /^[1-7]$/.test(event.key)) {
      currentTab.value = TAB_ORDER[Number(event.key) - 1];
      event.preventDefault();
    }
  });
}

// ------------------------------------------------------------ 门禁之后的自动启动

/** 本次运行是否已经为"门禁之后"试过自动启动（逃生 → 回向导 → 再逃生也只试一次） */
let gateAutoStartTried = false;

/**
 * 逃生 / 放行之后触发**一次**自动启动。
 *
 * 为什么需要它：被门禁挡住的那一轮**没有自动拉起 dsh**（那正是门禁的意义），
 * 用户逃生或点「进入 DSH Console」之后，"打开应用就能用"这条既有约定要接上（需求 §5.2）。
 *
 * 三条硬要求（冻结 §1 R-07 + §0.4 的 R-32）：
 *   - **放行页那条路要显示启动锁**：用户点「进入 DSH Console」之后界面按住等他看 dsh 起来
 *     （`armAfterGate()` 开一个显式的新回合，单向状态机本身不变）；**逃生口那条路不上锁** ——
 *     用户刚说了「环境还没准备好，我稍后自己处理」，再按住他等与他刚说的话相反；
 *   - 两条路都照旧自动启动，且**整个运行只触发一次**；
 *   - 开关仍归设置 `autoStart`，关着就什么都不做。
 */
function wireGateAutoStart(): void {
  watch(gatePhase, (phase) => {
    if (phase !== 'escaped' && phase !== 'entered') return;
    if (gateAutoStartTried) return;
    gateAutoStartTried = true;
    if (!settings.value.autoStart) return;
    // 只有"放行页点进入"这一条路开新回合（R-32 的 1A）：逃生口不上锁
    if (phase === 'entered') armAfterGate();
    void api.start().then(
      (result) => {
        if (!result.ok) console.warn('[gate] 自动启动失败:', result.error ?? '未知原因');
      },
      (error: unknown) => {
        console.warn(
          '[gate] 自动启动失败:',
          error instanceof Error ? error.message : String(error),
        );
      },
    );
  });
}
