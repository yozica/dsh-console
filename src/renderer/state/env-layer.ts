/**
 * 环境自检的**详情视图**开关（t45 / `docs/env-doctor.md` 的改判）。
 *
 * 左栏不再有「环境自检」这一项：它在设置页里是一张卡（一行结论 + 「查看详情」），点开才铺开
 * 原来那一页的完整内容。这一层是**工作区上的覆盖层**（不盖左栏与顶栏、也不盖状态栏），
 * 所以它既不是第 8 个页面、也不进 `TAB_ORDER`；点左栏任何一项（`selectTab`）都会把它收掉。
 *
 * 为什么是一个共享 ref 而不是设置页里的局部状态：三个外部入口都要能打开它 ——
 * 控制台页的横幅（`DashboardPane`）、插件页的「一键装 pnpm」、以及门禁层里的两条出路
 * （`EnvGate`），它们都先 `openEnvDetail()` 再 `requestEnvFocus(...)`。
 *
 * 文件名别叫 `env-detail.ts`：那个名字已经被「自检页说明里的长路径折行」（`detailSegments`）占了。
 */

import { ref, type Ref } from 'vue';

/** 详情视图是否打开 */
export const envDetailOpen: Ref<boolean> = ref(false);

const LAYER_ID = 'env-detail-layer';

/** 打开详情视图（幂等：已经打开时只保证层是显出来的） */
export function openEnvDetail(): void {
  envDetailOpen.value = true;
  document.getElementById(LAYER_ID)?.classList.add('open');
}

/** 收起详情视图（「← 返回」与切页都走这里） */
export function closeEnvDetail(): void {
  envDetailOpen.value = false;
  document.getElementById(LAYER_ID)?.classList.remove('open');
}

/** 切页时收掉：它盖着的正是页面区，留着会挡住用户刚点的那个页面 */
export function closeEnvDetailOnTabChange(): void {
  if (envDetailOpen.value) closeEnvDetail();
}
