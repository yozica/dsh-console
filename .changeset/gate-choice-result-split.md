---
'dsh-console': patch
---

首启门禁再拆两块：选择区与结果行（`EnvGate.vue` 2153 → 1989 行）

| 新文件                     | 行数 | 装什么                                                                      |
| -------------------------- | ---- | --------------------------------------------------------------------------- |
| `shell/GateNodeChoice.vue` | 123  | 选择区：版本档位 + 安装方法两组单选（含"两条路都没预选""正在安装"两句提示） |
| `shell/GateResult.vue`     | 184  | 结果行：状态点 + 结论句 + 说明 + 那排出路（三种结局各一套按钮）             |

两块都是**哑的**：方法与档位仍由父级持有（确认区 `GateNodeConfirm.vue` 读的是同一份状态），
点色 / 结论 / 说明也是父级算的（父级的进行中与输出区读同一份：`outputState` / `outputSummary`）。
**模板逐字搬**：`GateResult` 的 props 特意按原来的标识符命名（`resultDot` / `resultTitle` /
`resultNote`），模板里只把 `currentStep.id` 换成 `currentStepId`（3 处）；`GateNodeChoice` 只在根元素
去掉 `v-if`（交给调用方）。

样式：`.gate-result*` 11 条进 `GateResult`、`.gate-method-fact` 1 条进 `GateNodeChoice` —— 这次**没有任何
规则进全局表**（两块用的都是自己私有的规则 + 全局零件），所以自检里"全局表花括号"那一行数字不变。

验收：机械等价 **577 → 577 零丢失零多出**、逐像素**完全一致**（`.verify/gate2-split/`，夹具画了两组
单选 / 方法事实行 / 并存风险 / 两句提示 + 三种结局的结果行）、`npm test` 314/314（**3** 行计数口径变化：
`.vue` 覆盖与组件数 20 → 22、`styleLayers` 18 个页面 86 条 → 20 个页面 91 条）、沙箱门禁 32/32 + 185/185、
`lint` / `format:check` / `typecheck` / `build` 全绿。

⚠️ 请真机 `npm start` 复核首启门禁：第一步的档位 / 方法单选（选完再点「安装」）、以及安装结束后
那三种结局的结果行与它们各自的出路按钮。
