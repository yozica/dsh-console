---
'dsh-console': patch
---

样式分层试点（backlog #1）：设置页自己的规则从 `styles.css` 搬进 `panes/SettingsPane.vue` 的 `<style scoped>`

- 搬走这一页私有的规则（`.settings` / `.form-row` / `.input-suffix` / `.update-*` 与「聚焦蒙层」的 `.spotlight`），全局表 4502 → 4329 行（−173）；跨组件的共享件（`.check`、`.panel-block > .hint`）留在全局表 —— 判据只有一条：**这个 class 是不是只有这一页在用**。
- 三道验收都跑了：① 机械等价（「全局表 + 组件块」按 `选择器 → 声明` 抽成多重集，和改动前的快照比：577 条 → 577 条，不丢不重）；② headless Chrome 用改动前后的样式各渲染同一段夹具，**逐像素一致**（设置页 + 聚焦蒙层两段）；③ 自检改成跨两层看（「标记用到的 class 都有对应样式」与「除变量块外没有硬编码颜色」都查两层），并新增「样式分层：页面私有的规则搬进组件的 `<style scoped>`，共享件留在全局表」。
- 这一层的坑（scoped 会给选择器 +1 个属性选择器，覆盖关系从"谁在后"变成"谁更具体"）记在 AGENTS §7.33。
