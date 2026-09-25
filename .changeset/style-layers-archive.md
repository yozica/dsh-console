---
'dsh-console': patch
---

样式分层第二批：归档会话页的规则搬进 `panes/ArchivePane.vue` 的 `<style scoped>`

- `.archive*` 一整节 415 行搬走（全局表 4329 → 3914 行），全局表里留一句指针说明搬到哪了。
- 两个坑写进 AGENTS §7.33：① `v-html` 渲染出来的正文（`renderMarkdown` 塞进 `.archive-turn-body` 的 `h1 / p / code / table …`）**必须写成 `:deep(...)`**，否则编译成 `.archive-turn-body h1[data-v-*]` 一条都匹配不上；② **多行选择器列表**逐行加 `:deep()` 会漏掉前几行 —— 这一版漏了 `h2..h5 / ul / th` 共 7 条，靠查构建产物里的选择器才抓到。自检因此多了一条钉子：`.archive-turn-body` 后面跟元素的行不许缺 `:deep()`。
- 验收：机械等价 577 条 → 577 条（不丢不重）；headless Chrome 三段夹具（设置页 + 聚焦蒙层 + 归档页，含 v-html 那部分排版）逐像素一致；`npm test` 314/314。
