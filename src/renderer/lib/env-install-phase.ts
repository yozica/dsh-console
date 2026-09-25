/**
 * 安装 / 修复通道的相位判据。门禁层（`shell/EnvGate.vue`）与设置页的运行环境详情层
 * （`panes/EnvPane.vue`）各画一份进度，判据必须只有一份 —— 两份就会漂移。
 */

import type { EnvFixPhase, EnvInstallPhase, EnvInstallState } from '../../shared/ipc.js';

/** 安装通道里"还在跑"的相位 */
export const INSTALL_BUSY_PHASES: EnvInstallPhase[] = [
  'preparing',
  'downloading',
  'verifying',
  'installing',
  'waiting',
  'rechecking',
];

export function installRunning(state: EnvInstallState): boolean {
  return !state.detached && INSTALL_BUSY_PHASES.includes(state.phase);
}

/** 有终态结论了：跑完 / 取消 / 失败，或用户"不再等待"（`detached` 时不给成功也不给失败） */
export function installSettled(state: EnvInstallState): boolean {
  return (
    state.detached ||
    state.phase === 'done' ||
    state.phase === 'cancelled' ||
    state.phase === 'error'
  );
}

export function isFixSettled(phase: EnvFixPhase): boolean {
  return phase === 'done' || phase === 'cancelled' || phase === 'error';
}
