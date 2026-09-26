/**
 * 「启动锁此刻是否在显示」的可读共享状态（冻结文档 §1 R-08）。
 *
 * 为什么要有这么一个只有一行状态的小模块：启动锁与首启门禁是**两套整屏覆盖层**，
 * 同时显示会互相压。顺序应当是「先让启动锁说完那句『正在启动』，解锁后再看环境结论」，
 * 所以门禁层的显示条件里必须能读到"锁在不在显示中"。
 *
 * 谁写：`src/renderer/app.ts` 的 `setBootLock()`（它才是启动锁状态机的持有者）；
 * 谁读：`state/env-wizard.ts` 的 `gateVisible`。两个组件各自猜"锁显示没有"一定会漂。
 */

import { ref, type Ref } from 'vue';

/** 启动锁是否正在显示（`#boot-lock` 那一层）。默认 false —— 锁只在自动启动的等待期出现 */
export const bootLockVisible: Ref<boolean> = ref(false);

/** 由 `app.ts` 的 `setBootLock()` 同步写入（上锁 / 解锁都要写，解锁也必须写 false） */
export function setBootLockVisible(on: boolean): void {
  bootLockVisible.value = Boolean(on);
}
