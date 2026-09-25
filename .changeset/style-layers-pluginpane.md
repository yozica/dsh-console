---
'dsh-console': patch
---

样式分层第五批：插件页（装配层）整节搬进 `panes/PluginPane.vue` 的 `<style scoped>`

- 「插件页（装配层）」一整节 **96 个条目**搬走（`.plugin*` / `.layer*` / `.plugin-op*` …），全局表 **3376 → 2649 行（−727，比最初的 4502 少了 41%）**。这一页没有 `v-html`，不需要 `:deep()`。
- 留在全局表的是跨页面共用的零件（`.btn` / `.panel*` / `.banner` / `.hint` / `.empty` / `.spacer` / `.block-head`）。
- 判归属时踩了个假阳性，写进 AGENTS §7.33 与 backlog：按「文件里出现过这个词」判会把 `RailNav.vue` 里的 `{ id: 'plugin' }` 字符串、别处注释里的 `.plugin-tag` 算成使用者 —— **要按标记里的 class 核**（`grep 'class="[^"]*\b类名\b'`）。
- 验收：机械等价 577 条 → 577 条；headless Chrome **七段**夹具（设置页 + 聚焦蒙层 + 归档页 + 控制台宽/窄 + 环境自检页 + 插件页）逐像素一致；`npm test` 314/314。
