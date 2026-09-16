---
'dsh-console': patch
---

内部：接入 changesets —— 每条改动写一个 `.changeset/*.md` 片段，发版前用 `npm run release:prepare`
汇总成 CHANGELOG 条目；PR 上会检查"改了代码就要带一个片段"。
