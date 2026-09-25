---
'dsh-console': patch
---

样式分层第六批：首启环境向导与入口门禁搬进 `shell/EnvGate.vue` 的 `<style scoped>`

- 「首启环境向导与入口门禁」一节里 EnvGate 私有的 **98 个条目**搬走（`.gate*` 外壳与节点时间线、卡片、确认表等），全局表 **2649 → 1944 行（−705，比最初的 4502 少了 57%）**。
- 与环境自检详情层**共用**的 42 个条目（`.gate-option*` / `.gate-choice*` / `.gate-confirm*` / `.wizard-*` —— EnvPane 复用向导同一套选项 / 选择 / 确认 / 进度行）留在全局表；顺手把误放在这一节里的 `.wizard-readout` 收进 `EnvPane.vue`。
- 两条自检教训写进 AGENTS §7.33：① 查「私有规则有没有搬干净」**也要行首锚定** —— `.gate-rail` 在全局表里仍以 `html[…] body[…] .gate-rail` 的形式存在（macOS 全屏撤回留白），用 contains 会误判；② 表的 `readScoped()` 要先 `panes/` 再 `shell/` 找文件。
- 顺手把 `scripts/env-wizard-cases.mjs` 的 CSS 断言改成读**两层**（它只读 `styles.css`，`.gate-result .btn-row` / `.gate-metabar` 搬走之后那两条间距断言直接红、沙箱门禁 `exit=1`）；`ENV_WIZARD_CSS_FILE` 那个变异实验后门保持"只读指定文件"。
- 验收：机械等价 577 条 → 577 条；headless Chrome **八段**夹具（设置页 + 聚焦蒙层 + 归档页 + 控制台宽/窄 + 环境自检页 + 插件页 + **首启门禁**，含共享的选项 / 确认表 / 进度行）逐像素一致；`npm test` 314/314。
