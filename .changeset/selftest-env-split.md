---
'dsh-console': patch
---

自检拆模块第五步：环境自检那几组成文件，夹具提成共享模块（`selftest.ts` 3640 → 2250 行）

- `test/checks/env-doctor.ts`（1348 行）：运行环境自检（判定 + 探测 + 一键修复）与 VM-09 那批。
- `test/env-fixtures.ts`（129 行）：**共享夹具** —— 一份"什么都好"的原始事实、各检查按需覆盖一两项，
  以及 `envSource` / `envCode` / `envMainCode` / `envPaneCode` 四份源码文本。这些原来定义在
  自检的第 16 组里，但后面的环境向导与安装引擎组隔着上千行还在引用，所以提成一份（谁要谁取，
  不再出现"检查 A 从检查 B 的文件里 import 一个夹具"）。
- `test/text.ts`（62 行）：从源码文本里切片段的小工具（`blockOf` 按大括号配平、`functionBodyOf`、
  `methodSliceOf` 按下一个类成员为界、`stripComments`、`stripStrings`）—— 环境自检、环境向导、
  安装引擎三组共用。

验收：`npm test` **314/314** 且输出与改动前逐行一致；沙箱门禁通过（32/32、185/185）；
`lint` / `format:check` / `typecheck` 全绿。
