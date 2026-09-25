---
'dsh-console': patch
---

自检拆模块收尾：入口只剩 55 行（`selftest.ts` 2250 → 55，全程 6591 → 55）

`test/selftest.ts` 原来是一个 6591 行的文件、314 条断言全挤在一个 `main()` 里。六批纯搬迁之后它
只剩入口：`createRepo()` → 依次 `run*` → `report()`。**每批的判据都是自检输出逐行一致**
（314 行 `PASS 名字 — 实际值` 同名、同值、同顺序，只归一化「健康探测（真实）」那行的 `Nms`）。

- `test/checks/env-wizard.ts`（1371 行）：首启环境向导、门禁界面、18a 的视图相位。
- `test/checks/install-engine.ts`（874 行）：18b~18d —— 提权、nvm 的真实模型、归属与档位。
- `test/env-fixtures.ts` 多收两份文本（`installerCode` / `gateRaw` / `gateCode`）—— 门禁界面那组
  也要读 node-installer，不能各读一份。

六批合计：`selftest.ts` 6591 → 55、新增 `harness` 80 / `repo` 174 / `text` 62 / `env-fixtures` 143，
`test/checks/` 八个主题模块共 6579 行。布局、怎么加一条断言、以及踩过的三个子目录搬迁坑
（`__dirname` 会变、相对 import 多退一层、跨段派生值先提成模块）记在 **AGENTS §7.34**。

验收：`npm test` **314/314** 且输出与拆分前逐行一致；沙箱门禁通过（反例脚本 32/32、185/185）；
`lint` / `format:check` / `typecheck` 全绿。
