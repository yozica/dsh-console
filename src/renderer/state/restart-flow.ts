/**
 * 「重启 dsh 之后自动进 Harness」的**编排**（t46，规格 `docs/plugin-restart.md` §2.1）。
 *
 * 四个入口（插件页 / 控制台 / 环境自检 / Harness 页的「重启为受管实例」）都只调这里的
 * `restartThenOpenHarness()`，不各自写一遍"先立意图再重启"的顺序 —— 那个顺序是这套东西
 * 最容易写错的地方（见下）。
 *
 * **顺序很要紧：意图必须在调 `restart()` 之前立。** `dshManager.start()` 一 spawn 完就返回
 * （不等健康检查），相位很快会 `running → stopping → stopped → starting`；等 IPC 回来再立意图，
 * 那 5 秒上锁窗口早就过去了 —— 锁永远不会出现，用户又回到"点了没反应"。
 *
 * 为什么单独一个文件：这里会 `alert()`，也 import `dsh-actions`（那里有 `alert` / `confirm`），
 * 而 `state/restart-nav.ts` 要能被自检直接 import（自检的编译图没有 DOM 类型）。见那边的文件头。
 */

import type { DshConsoleApi, DshSnapshot } from '../../shared/ipc';
import { restartFlow } from '../pages/dashboard/dsh-actions.js';
import {
  beginRestartNav,
  clearRestartNav,
  settleRestartNav,
  type RestartReason,
} from './restart-nav.js';

/**
 * 四个入口共用的编排：**先立意图 → 再重启 → 失败当场说实话**。
 *
 * `mode: 'start'` 是留给环境自检的：那里 dsh 已经被"更新 Node"的前置步骤停掉了，
 * 所以只需要重新 `start()`，不必再走一遍"停 → 等端口释放"。
 */
export async function restartThenOpenHarness(
  api: DshConsoleApi,
  getDsh: () => DshSnapshot | null,
  reason: RestartReason,
  mode: 'restart' | 'start' = 'restart',
): Promise<void> {
  beginRestartNav(reason, getDsh()?.uiUrl ?? null);
  if (mode === 'start') {
    const result = await api.start();
    if (!result.ok) {
      settleRestartNav('failed', result.error || '未知错误');
      alert(`启动失败：${result.error ?? '未知错误'}`);
    }
    return;
  }
  const result = await restartFlow(api, getDsh);
  if (result.cancelled) clearRestartNav();
  else if (!result.ok) settleRestartNav('failed', result.error || '未知错误');
}
