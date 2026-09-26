---
'dsh-console': patch
---

插件页拆出生效配置视图（`PluginPane.vue` 1462 → 1152 行，新增 `pages/plugin/PluginConfigView.vue` 423 行）

拆出去的是：组合出来的条目按层分组 + 搜索 / 两个过滤开关 + 基线那句"这是 dsh 自带的组合结果" +
"运行中但配置里没有"的那几行 + 会话插件行数，以及每个条目行内的三个动作（禁用 / 启用 / 移除我的插入）。

**它不持有状态**：搜索词、两个开关、分组、运行中索引、基线与忙位都由父级拿着 —— 同一份数据父级的
层栈视图与操作输出也在读（`activeData` / `opBusy`），拆开就会变成两个真源。父级只多了一条
`@update:query="query = $event"` 与两个开关的翻转；模板只有四处小改（`v-model` → `:value` + `@input`、
两个 `x = !x` → 事件、根元素的 `v-else` 交给调用方）。

**样式整块搬**：那 26 条（`.plugin-config*` / `.plugin-search*` / `.plugin-filter*` / `.plugin-group*` /
`.plugin-raw*` / `.plugin-scope` / `.plugin-presets` / `.plugin-entry-actions` / `.plugin-state*` /
`.plugin-baseline-note*`）与父级没有共用，全部跟着组件走 —— 这次没有一条进全局表。

验收：机械等价 **577 → 577 零丢失零多出**、逐像素**完全一致**（`.verify/plugin2-split/`）、
`npm test` 314/314（**3** 行计数口径变化：`.vue` 覆盖与组件数 25 → 26、`styleLayers` 22 个页面 96 条 →
23 个页面 99 条）、沙箱门禁 32/32 + 185/185、`lint` / `format:check` / `typecheck` / `build` 全绿。

⚠️ 请真机 `npm start` 复核插件页的生效配置视图：搜索框、两个过滤开关（含选中态的实心底）、
「只看某一层」那枚标签与「清除筛选」、条目行内的禁用 / 启用 / 移除我的插入、运行状态那枚小标、
以及"没能解析成结构"时的原始 dump 分支。
