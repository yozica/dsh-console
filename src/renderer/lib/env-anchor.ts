/**
 * 自检页的锚点信号。
 *
 * 两个地方会把人带到自检页，而且都要"落到具体那一行"：
 *   - 控制台页顶部的横幅（缺项 > 0 时出现）→ 落到主进程给的那一项（`firstProblemId`）
 *   - 插件页「没找到 pnpm」旁边的「一键安装 pnpm」→ 落到 `pnpm` 那一行，并展开确认区
 *
 * 为什么是递增的请求号而不是布尔量（与 lib/update-anchor.ts 同款）：连点两次也该各走一遍。
 * 布尔量第二次没有变化，watch 不会触发 —— 看起来就像"点了没反应"。
 */

import { ref } from 'vue';

import type { EnvCheckId, EnvFixAction } from '../../shared/ipc';

export interface EnvFocusRequest {
  /** 请求号；0 = 还没有人请求过（所以自检页可以直接 watch，不必先判断初次） */
  seq: number;
  /** 要滚到哪一行 */
  checkId: EnvCheckId;
  /** 顺手展开这一行的确认区（只有它真的有一键修复动作时才会展开） */
  action: EnvFixAction | null;
}

export const envFocus = ref<EnvFocusRequest>({ seq: 0, checkId: 'node', action: null });

/** 请求聚焦自检页的某一行；`action` 非空时连确认区一起展开 */
export function requestEnvFocus(checkId: EnvCheckId, action: EnvFixAction | null = null): void {
  envFocus.value = { seq: envFocus.value.seq + 1, checkId, action };
}
