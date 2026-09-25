---
'dsh-console': patch
---

样式分层第四批：环境自检页的规则搬进 `panes/EnvPane.vue` 的 `<style scoped>`

- 「环境自检」与「更新入口与下载来源」两节里**只有 EnvPane 用**的 37 个条目搬走（`.env-row*` / `.env-scope` / `.env-confirm*` / `.env-source*` / `.env-skip` …），全局表 3647 → 3376 行（−271）。
- 留在全局表的是与别处共用的：`.env` 外层、`.env-actions`（设置页「运行环境」卡也画）、`.env-op*`（环境向导的执行输出面板与这一页同形）。**这一节 42 条里只有 28 条是私有的** —— 再次说明"能搬多少"要按规则逐条数，不能按段落整体判断。
- 自检新增一条改造：到处在用的 `cssBlock(selector)` 助手也改成读**两层**样式表（`allCss`）—— 只看全局表时 `.env-main` / `.env-seg` 那两条断言直接假红。
- 验收：机械等价 577 条 → 577 条；headless Chrome **六段**夹具（设置页 + 聚焦蒙层 + 归档页 + 控制台宽/窄 + 环境自检页）逐像素一致；`npm test` 314/314。
