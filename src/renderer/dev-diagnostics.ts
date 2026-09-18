/**
 * 开发期诊断：Ctrl+Shift+D（macOS 上 ⌘⇧D）把当前界面的元素结构导出到日志文件。
 *
 * 为什么需要它：界面出问题时（某块是黑的、某块不撑满、被谁挡住），
 * 只看截图容易靠猜 —— 而"每个元素的尺寸/位置/背景/display"是确定的。
 * 这条快捷键把整棵树打进 console，而渲染层的 console 会转发到主进程日志文件，
 * 于是**排查的一方（人或 agent）可以直接读那个文件**，不必反复要截图。
 *
 * 另外 F12 / Ctrl+Shift+I（macOS 上 ⌘⌥I）由主进程处理（见 src/main/main.ts 的 wireDevTools），
 * 那是真正的开发者工具；这里只是"一键导出结构"的轻量版。
 *
 * 只在开发态安装：打包后 index 入口不会调 installDevDiagnostics()。
 */

import { isAppModifier, shortcutLabel } from './lib/platform.js';
import { update } from './lib/store.js';
import type { UpdateState } from '../shared/ipc';

const MAX_DEPTH = 12;
const MAX_LINES = 600;

/**
 * 跳过对排查布局没用的子树：
 *   - 图标精灵（内联 SVG 的一堆 symbol，全 0x0）
 *   - 列表项（事件日志最多 250 条、形状完全一样，会把 600 行的预算吃光，
 *     结果还没走到要看的那一页就截断了）
 */
function skip(el: Element): boolean {
  return el.classList?.contains('sprite') || el.tagName === 'LI';
}

function describe(el: Element): string {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const id = el.id ? `#${el.id}` : '';
  const classes = el.classList.length ? `.${[...el.classList].slice(0, 3).join('.')}` : '';
  const size = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
  const pos = `@${Math.round(rect.left)},${Math.round(rect.top)}`;
  const flags = [
    `display=${style.display}`,
    style.visibility === 'hidden' ? 'visibility=hidden' : '',
    style.overflow !== 'visible' ? `overflow=${style.overflow}` : '',
    style.backgroundColor !== 'rgba(0, 0, 0, 0)' ? `bg=${style.backgroundColor}` : '',
    style.zIndex !== 'auto' ? `z=${style.zIndex}` : '',
  ].filter(Boolean);
  return `${el.tagName.toLowerCase()}${id}${classes} ${size}${pos} ${flags.join(' ')}`;
}

/** 当前可见的是哪一页：以 .pane.active 为准（body[data-page] 可能是陈旧值，会误导） */
function activePage(): string {
  const active = document.querySelector('.pane.active');
  return active ? active.id.replace(/^pane-/, '') : '?';
}

function dumpDom(): void {
  const lines: string[] = [];
  const walk = (el: Element, depth: number): void => {
    if (lines.length >= MAX_LINES || depth > MAX_DEPTH || skip(el)) return;
    lines.push(`${'  '.repeat(depth)}${describe(el)}`);
    for (const child of el.children) walk(child, depth + 1);
  };
  walk(document.body, 0);
  const truncated = lines.length >= MAX_LINES ? `（已截断到 ${MAX_LINES} 行）` : '';
  console.log(`[dom-dump] 当前页面：${activePage()} ${truncated}\n${lines.join('\n')}`);
}

/** 顺带把"当前状态"也打一行：界面不对时，往往先要确认状态对不对 */
function dumpState(): void {
  const panes = [...document.querySelectorAll('.pane')].map(
    (pane) => `${pane.id}${pane.classList.contains('active') ? '(active)' : ''}`,
  );
  console.log(
    `[dom-state] page=${activePage()} immersive=${document.body.dataset.immersive}` +
      ` locked=${document.body.dataset.locked} theme=${document.documentElement.dataset.theme}` +
      ` panes=${panes.join(' ')}`,
  );
}

// ---------------------------------------------------------------- 更新提示的演示

/**
 * 开发态"体验更新提示"：Ctrl+Shift+U（macOS ⌘⇧U）在几个更新相位之间循环。
 *
 * 为什么需要它：底栏那句「发现新版本 x.y.z，点此查看」只在 `available` / `downloaded`
 * 两个相位出现，而更新状态机只在**打包后的 Windows** 上才可能进入这两个相位
 * （见 src/main/updater.ts：未打包一律 `unsupported`）—— 于是这条提示、以及它点下去
 * 的「滚到更新卡片 + 高亮一次」，在开发时根本看不见、也点不到。
 *
 * 循环是 `available → downloaded → downloading → 回到真实状态`：第一次按下时先把真实
 * 状态存下来，走完一圈原样放回，所以它不会把开发态那个 `unsupported` 弄丢。
 * 消息里都带「（开发态演示）」，免得截图被误当成真的发现新版本。
 *
 * 注意：伪造的是**渲染层这份镜像**，点设置页里的「下载 / 重启并安装」会去问主进程，
 * 那次往返会把状态换回真实的 unsupported —— 想继续看再按一次快捷键即可。
 */
const FAKE_PHASES = ['available', 'downloaded', 'downloading'] as const;
const FAKE_VERSION = '9.9.9';
let fakeIndex = 0;
let realUpdate: UpdateState | null = null;

function fakeState(phase: (typeof FAKE_PHASES)[number], real: UpdateState): UpdateState {
  const common = {
    currentVersion: real.currentVersion,
    releasesUrl: real.releasesUrl,
    canCheck: true,
    canAutoUpdate: true,
  };
  if (phase === 'available') {
    return {
      ...common,
      phase,
      version: FAKE_VERSION,
      percent: null,
      message: `发现新版本 ${FAKE_VERSION}（开发态演示）`,
    };
  }
  if (phase === 'downloaded') {
    return {
      ...common,
      phase,
      version: FAKE_VERSION,
      percent: null,
      message: `新版本 ${FAKE_VERSION} 已下载（开发态演示）`,
    };
  }
  return {
    ...common,
    phase: 'downloading',
    version: FAKE_VERSION,
    percent: 45,
    message: '正在下载… 45%（开发态演示）',
  };
}

function cycleFakeUpdate(): void {
  if (!realUpdate) realUpdate = { ...update.value };
  fakeIndex += 1;
  if (fakeIndex > FAKE_PHASES.length) {
    fakeIndex = 0;
    update.value = { ...realUpdate };
    console.log('[dev] 更新相位已还原为真实状态');
    return;
  }
  const phase = FAKE_PHASES[fakeIndex - 1];
  update.value = fakeState(phase, realUpdate);
  const hint =
    phase === 'available' || phase === 'downloaded' ? '（底栏应出现可点的更新提示）' : '';
  console.log(`[dev] 更新相位伪造成 ${phase}${hint}`);
}

export function installDevDiagnostics(): void {
  window.addEventListener('keydown', (event) => {
    if (!isAppModifier(event) || !event.shiftKey) return;
    const key = String(event.key).toLowerCase();
    if (key === 'd') {
      event.preventDefault();
      dumpState();
      dumpDom();
    }
    if (key === 'u') {
      event.preventDefault();
      cycleFakeUpdate();
    }
  });
  console.log(
    `[dev] 诊断快捷键已就绪：F12 开发者工具，${shortcutLabel('Shift+D')} 导出界面结构到日志，` +
      `${shortcutLabel('Shift+U')} 循环伪造更新相位（体验底栏更新提示）`,
  );
}
