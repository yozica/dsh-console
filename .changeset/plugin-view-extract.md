---
'dsh-console': patch
---

「插件」页的纯展示判据进 `pages/plugin/plugin-view.ts`（`PluginPane.vue` 2052 → 1915 行）

`pages/plugin/PluginPane.vue` 里那些**一条 DOM 都不碰**却和 `ref` / `computed` 混在一起的规则搬进
`pages/plugin/plugin-view.ts`（205 行）：层名（`home` 换 `~`）、算不算"你自己的层"、`kind` 的中文、
"没贡献"的三种情况（未创建 / 没匹配上 / 空 `[]`）、`include:` 前缀、运行中条目的索引与差额、
运行状态词、巡检分档与"能不能删 / 卸 / 放回"、以及生效配置视图的分组过滤。
组件里只剩一层薄包装（把 `data` / `problems` 这些响应式来源喂进去）与三个"点一下就走"的动作。

**只动 `<script setup>`**：`git diff` 里以 `<` 开头的增删行 **0 个**，所以免像素对比。
验收：`vue-tsc` 0、`eslint` 0、`npm test` 314/314 且**输出逐行一致**、沙箱门禁（32/32、185/185）、
`npm run build:renderer` 成功。

**一条钉子跟着换了口径**：「救援：「放回层里」不依赖救援条」钉的是判据本身（`canRestore` 的名字、
那一档的说法、"两种不形成层都能卸"），判据跨出 `.vue` 之后它从 `vueSource` 改成 `repo.rendererAll`
（`app.ts` + `lib/*.ts` + 全部 `.vue`）。读文本的断言要跟着"判据搬到哪一层"换口径，记在 AGENTS §7.36。
