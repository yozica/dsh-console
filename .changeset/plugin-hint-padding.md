---
'dsh-console': patch
---

插件页「你的层」那句说明的 16px 内边距回来了（规则写在了另一个组件的 scoped 里）

现象（用户抓图"这里的间距怎么没了"）：插件页「你的层」详情里那句"这一层还没有生效的内容…"
贴着卡片的左右边缘，而同一张卡上面的 meta 行（`6px 16px 14px`）、下面的条目行（`6px 16px`）
都缩进 16px。

原因不是"忘了写"，而是**写在了够不着的地方**：那条规则（`.plugin-entries > .hint` /
`.plugin-detail-body > .hint` / `.plugin-config-body > .hint` 的 `padding: 0 16px`）本来在
`PluginConfigView.vue` 的 `<style scoped>` 里，而前两个容器是 `PluginStackView.vue` 画的 ——
Vue 把 scoped 规则编译成 `选择器[data-v-<本组件hash>]`，一条都匹配不上。既有自检没红是因为
`test/checks/styles.ts` 的 t66 只查**自成一条规则**的类选择器，复合选择器被有意排除在外
（那类通常是"只在本组件内生效"的覆盖）—— 缺陷正好落在盲区里。

现在三条选择器搬进全局表（`styles.css` 里 `.hint` 那一段，带完整解释），两个组件的 scoped 块里
各留一句指路注释，`styleLayers` 的 `staysGlobal` 各钉一条（"没留在全局表 / 被搬进组件了"两半都会红）。
用一次变异验过牙齿：把全局表里那条改名成 `.plugin-detail-body > .hint-MUTATED` → 立刻红。
