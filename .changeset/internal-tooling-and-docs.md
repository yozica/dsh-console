---
'dsh-console': patch
---

内部：接入 changesets —— 每条改动写一个 `.changeset/*.md` 片段，发版前用 `npm run release:prepare`
汇总成 CHANGELOG 条目，PR 上会检查"改了代码就要带一个片段"；代码风格显式化（语句结尾要有分号、
多行列表的最后一项要有尾随逗号），并加了一个登记"纯格式化提交"的 `.git-blame-ignore-revs`；
README 收敛为面向使用者的项目介绍，开发说明独立成 `AGENTS.md`。
