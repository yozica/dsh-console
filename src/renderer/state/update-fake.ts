/**
 * **开发态**"假装更新相位"：把 `available` / `downloaded` 这两个平时看不见的相位伪造出来。
 *
 * 为什么需要它：底栏那句「发现新版本 x.y.z，点此查看」、顶栏那格（应用内全屏时底栏被藏起来，
 * 见 §7.17）都只在 `available` / `downloaded` 两个相位出现，而更新状态机只在**打包后的
 * Windows** 上才可能进入这两个相位（见 src/main/updater.ts：未打包一律 `unsupported`）——
 * 于是提示本身、以及它点下去的「滚到更新卡片 + 高亮一次」，在开发时根本看不见、也点不到。
 *
 * **两个入口、一份实现**：设置页「关于」卡里那排按钮（`v-if="!packaged"`，打包版连渲染都
 * 不渲染）与 `dev-diagnostics.ts` 的 Ctrl+Shift+U 快捷键都调这里的函数 —— 能伪装哪几个相位、
 * 伪装出来长什么样只有这一份。
 *
 * **它不动真实状态**：这里只写 `fakeUpdate`，而界面读的 `update` 是
 * `fakeUpdate ?? realUpdate` 的派生值（见 store.ts）。所以主进程随时推来的真实状态
 * （`onUpdateState`）不会把"假装"顶掉，还原也就是把 `fakeUpdate` 清空 ——
 * 不需要"先存下真实状态、走完一圈再放回"那套记账（以前那种写法下，在伪装状态里点一次
 * 「下载」就会去问主进程，那次往返会把伪装换成真实的 `unsupported`）。
 *
 * 文案里都带「（开发态演示）」，免得截图被误当成真的发现了新版本。
 */

import { computed, ref } from 'vue';

import { RELEASES_URL } from '../../shared/ipc';
import type { UpdateState } from '../../shared/ipc';

/** 能伪装的相位（`unsupported` / `idle` 这些开发态本来就看得见，不用装） */
export const FAKE_PHASES = ['available', 'downloaded', 'downloading'] as const;
export type FakePhase = (typeof FAKE_PHASES)[number];

const FAKE_VERSION = '9.9.9';

/** 伪装出来的更新状态；`null` = 没伪装，界面看真实那份 */
export const fakeUpdate = ref<UpdateState | null>(null);

/** 现在伪装成哪个相位（没伪装就是 `null`）—— 设置页那排按钮靠它标出"哪一个是按下的" */
export const fakePhase = computed<FakePhase | null>(() => {
  const phase = fakeUpdate.value?.phase;
  return phase === 'available' || phase === 'downloaded' || phase === 'downloading' ? phase : null;
});

/**
 * 伪装出来的那一份状态。字段口径与主进程真给的保持一致（`canCheck` / `canAutoUpdate` 都为真，
 * 这样「下载」「重启并安装」这类按钮会照常出现）；只有 `currentVersion` 留空 —— 界面不显示它
 * （它是主进程拼 message 用的）。
 */
function fakeState(phase: FakePhase): UpdateState {
  const message =
    phase === 'available'
      ? `发现新版本 ${FAKE_VERSION}（开发态演示）`
      : phase === 'downloaded'
        ? `新版本 ${FAKE_VERSION} 已下载（开发态演示）`
        : `正在下载… 45%（开发态演示）`;
  return {
    phase,
    currentVersion: '',
    version: FAKE_VERSION,
    percent: phase === 'downloading' ? 45 : null,
    message,
    releasesUrl: RELEASES_URL,
    canCheck: true,
    canAutoUpdate: true,
  };
}

/** 伪装成某个相位（`null` = 还原成真实状态），返回伪装后界面会显示的相位（给日志用） */
export function setFakeUpdatePhase(phase: FakePhase | null): FakePhase | null {
  fakeUpdate.value = phase ? fakeState(phase) : null;
  return phase;
}

/**
 * 在几个相位之间循环（快捷键 Ctrl+Shift+U / ⌘⇧U）：
 * `available → downloaded → downloading → 还原真实状态`。
 */
export function cycleFakeUpdate(): FakePhase | null {
  const index = fakePhase.value ? FAKE_PHASES.indexOf(fakePhase.value) : -1;
  return setFakeUpdatePhase(index + 1 >= FAKE_PHASES.length ? null : FAKE_PHASES[index + 1]);
}
