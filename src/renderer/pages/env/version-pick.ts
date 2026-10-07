/**
 * dsh 版本下拉（自绘浮层）的**纯逻辑**：只算"下一个高亮是哪一项"。
 *
 * 为什么单独抽一份、还放在能被 `test/checks/*` import 到的地方：键盘导航是这类控件最容易写错、
 * 又最难用肉眼验的一小块（到边界、空列表、"当前没有高亮"时按上下键的落点）。抽成纯函数之后
 * `scripts/env-doctor-cases.mjs` 能直接喂字面量把它钉住，不必起浏览器才敢说它对 ——
 * 与 `pages/env/env-detail.ts`、`gate/wizard-view.ts` 走的是同一条路（test 侧直接 import，
 * 反例脚本从 `.verify/cases-build` 里 require 同一份产物）。
 *
 * 这个文件**不许 import Vue、不许碰 DOM**：它是纯的，所以才能在普通 Node 里被加载。
 */

/** 会改变高亮的导航键；其余键（含 Enter / Escape）不在这里处理 */
export type VersionNavKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

/**
 * 把高亮夹进合法范围。`length <= 0`（空列表）恒为 `-1` = "没有高亮"；
 * `-1` 也**保持**为 `-1`（它是有意义的"还没高亮"，不是"第 0 项"）。
 */
export function clampActive(index: number, length: number): number {
  if (length <= 0) return -1;
  if (!Number.isFinite(index)) return 0;
  const at = Math.trunc(index);
  if (at < 0) return -1;
  if (at > length - 1) return length - 1;
  return at;
}

/**
 * 时间轴上的方向：目标比当前**新** = `'up'`，比当前**旧** = `'down'`，同一个 = `'same'`。
 *
 * 列表是**倒序**的（最新在最上面），所以"下标更小 = 版本更新" —— 这一条只在这里写一次，
 * 界面与粘性摘要行都读它的结论，别各自去比版本号字符串（字符串比较对 `rc.9 / rc.10` 会错）。
 *
 * 任一侧不在列表里（`< 0`，例如"当前版本没测到"或"还没选"）→ `'unknown'`：
 * 那是不编方向的意思，界面上退化成只显示目标版本。
 */
export type PickDirection = 'up' | 'down' | 'same' | 'unknown';

export function pickDirection(currentIndex: number, targetIndex: number): PickDirection {
  if (currentIndex < 0 || targetIndex < 0) return 'unknown';
  if (currentIndex === targetIndex) return 'same';
  return targetIndex < currentIndex ? 'up' : 'down';
}

/**
 * "从当前到目标之间那几行"的下标 —— 时间轴上要画成强调色实线的那一段（C 摆法的核心）。
 *
 * 取**开闭区间**：从两个下标里较小的那个的**下一行**开始，一直到较大的那一行**含在内**。
 * 这样每一行自己那段竖线接起来，正好把"当前"的节点连到"目标"的节点上（与
 * `docs/env-version-pick-choices.html` 的 C 预览一致：降级时 `is-down` 挂在当前行的下一行
 * 到目标行，当前行自己不带）。
 *
 * 相等 / 任一侧不在列表里 → 空数组（没有"区间"可画）。返回的是**升序下标**，
 * 调用方拿去做集合查（`new Set(...)`），别在模板里用 `:nth-child` 猜区间。
 */
export function betweenIndexes(currentIndex: number, targetIndex: number): number[] {
  if (currentIndex < 0 || targetIndex < 0) return [];
  if (currentIndex === targetIndex) return [];
  const from = Math.min(currentIndex, targetIndex);
  const to = Math.max(currentIndex, targetIndex);
  const out: number[] = [];
  for (let index = from + 1; index <= to; index += 1) out.push(index);
  return out;
}

/**
 * 从"当前高亮 + 按下的键"算出下一个高亮。
 *
 * - `ArrowDown` / `ArrowUp` 各走一格，**到边界就停住**（不回绕：三十个版本的列表里，
 *   回绕会让"按住往下"从末尾突然跳回最上面，一眼看不出发生了什么）；
 * - `Home` / `End` 到首尾；
 * - 当前没有高亮（`-1`）时：向下落到第一项、向上落到最后一项（与原生 `<select>` 的手感一致 ——
 *   用户按 ↓ 的期待是"从头上开始看"）；
 * - 空列表恒为 `-1`。
 */
export function nextActiveIndex(current: number, key: VersionNavKey, length: number): number {
  if (length <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  const at = clampActive(current, length);
  if (at < 0) return key === 'ArrowUp' ? length - 1 : 0;
  const moved = key === 'ArrowDown' ? at + 1 : at - 1;
  // 边界停住：这里**不能**再过 `clampActive` —— 它会把 -1 解释成"没有高亮"，
  // 于是"在第一项按 ↑"会变成"取消高亮"，与"到边界停住"正好相反。
  if (moved < 0) return 0;
  if (moved > length - 1) return length - 1;
  return moved;
}
