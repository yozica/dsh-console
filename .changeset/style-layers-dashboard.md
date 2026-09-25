---
'dsh-console': patch
---

样式分层第三批：控制台的规则搬进 `panes/DashboardPane.vue` 的 `<style scoped>`

- 37 个条目搬走（`.dash*` / `.focus-*` / `.stats` / `.meta-*` / `.event-log*` / `.chart` / `.spark*` / `.command`，含两条媒体查询），全局表 3914 → 3647 行（−267）；留在全局表的是卡片零件（`.panel` / `.panel-head` / `.panel-block` / `.hint`）与 `.block-head` / `.block-note`（插件页也在用）。
- 顺手把误放在「控制台」一节里的 `.settings-status` 收进 `panes/SettingsPane.vue` —— 它只有设置页用。
- 两个新教训写进 AGENTS §7.33：① 查"共享件还在不在全局表"必须用**行首锚定**（`.log-panel .panel-head` 里含 `.panel-head`，用 contains 会误判成被搬走）；② 产物里的媒体查询会被压成 `@media (width<=900px)`，按 `max-width` grep 产物会以为规则丢了。
- 验收：机械等价 577 条 → 577 条；headless Chrome **五段**夹具（设置页 + 聚焦蒙层 + 归档页 + 控制台宽/窄两档，窄档覆盖两条媒体查询）逐像素一致；`npm test` 314/314。
