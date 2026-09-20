---
'dsh-console': patch
---

「Node 版本」那一行改用 dsh 自己的要求，与构建期那句分开

自检原来拿 **vite 的 engines**（`^20.19.0 || >=22.12.0`）当判据 —— 那是**构建期**要求，
跟「dsh 能不能跑」无关。后果是偏松：Node 20.19 与 22.12–22.18 会被判成「符合要求」，
而 dsh 在那种 Node 上是**静默退出**（退出码 0、零输出），界面上只显示「已停止」，
用户完全看不出是解释器的问题。

出处是 dsh 上游**仓库根**的 `package.json`
（<https://github.com/deepseek-ai/deepseek-harness/blob/master/package.json>）：
`"engines": { "node": "^22.19.0 || >=24.0.0" }`。两个容易看走眼的地方：**发布出去的
`@deepseek-ai/dsh` 的 manifest 里没有 `engines`**（在 `node_modules` 里翻不到、npm 也不警告），
而一致的下限还能从依赖链看出来 —— undici 8 写着 `engines: { node: '>=22.19.0' }`
（上游那句比它多排除奇数版 23）。

现在两个区间各归各行：`NODE_RANGE`（dsh 那句）判「Node 版本」与界面顶部那句，
`NODE_RANGE_BUILD`（vite 那句）只判「应用自带运行时」—— 后者说的是打包进来的那个 Node，
按构建期要求判仍然是对的。出路文案里的「22.12+ 的 LTS」也跟着改成「22.19+ 或 24 的 LTS」。
