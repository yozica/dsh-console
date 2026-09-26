---
'dsh-console': patch
---

首启门禁再拆两块：操作行与一键修复确认区（`EnvGate.vue` 1989 → 1916 行）

| 新文件                     | 行数 | 装什么                                                                               |
| -------------------------- | ---- | ------------------------------------------------------------------------------------ |
| `shell/GateActions.vue`    | 126  | 操作行：一屏唯一一处强调色实底 + 一条次操作（三步各一套）+ pnpm 那句"跳过之后会怎样" |
| `shell/GateFixConfirm.vue` | 77   | 一键修复（pnpm / dsh）的确认区：命令原文 + 目标目录 + 两个按钮                       |

**焦点也要跟着搬**：这两块里原来各有一个 `ref`（`primaryRef` / `startRef`）被父级的 `focusDefault()`
与 `watch(fixConfirmAction)` 直接 `.focus()`。搬走之后父级够不到子组件的元素，做法与
`GateNodeConfirm` 那次一致：子组件 `defineExpose({ focusStart })`，父级持模板 ref 调它；
**"哪个按钮是这一屏的落点"留在父级**（它知道有没有确认区打开、是不是在看回看卡）。

模板逐字搬（`stepId` 取代 3 处 `currentStep.id`、`plan` 取代 `fixConfirmPlan`）；`.gate-actions`
进 `GateActions` 的 scoped 块（`.gate-confirm*` 那批早已在全局表，这次没有规则进全局表）。

验收：机械等价 **577 → 577 零丢失零多出**、逐像素**完全一致**（`.verify/gate3-split/`）、
`npm test` 314/314（**3** 行计数口径变化：`.vue` 覆盖与组件数 22 → 24、`styleLayers` 20 个页面 91 条 →
21 个页面 92 条）、沙箱门禁 32/32 + 185/185、`lint` / `format:check` / `typecheck` / `build` 全绿。

⚠️ 请真机 `npm start` 复核首启门禁：三步的操作行（第一步两条路都没选时「安装」禁用 + 那句 title、
第二步的「先跳过这一步」与其下方说明、第三步只有「安装」）、以及点「安装」展开的一键修复确认区
（命令原文 / 目标目录 / 开始·取消，以及**打开后焦点是否落在「开始」**）。
