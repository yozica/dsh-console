# changeset 片段

这个目录里的每个 `*.md` 是一个**变更片段**：改完一处就往这里放一个文件，说明"这处改动的性质"。
`CHANGELOG.md` 不再手写 —— 发布前由 `npm run release:prepare` 把所有片段汇总成它的新条目。

## 加一个片段

- 交互式（推荐）：`npx changeset add` —— 选级别、写说明；
- 手写：按下面的形状写一个文件即可，文件名随意（想固定汇总顺序就用 `01-xxx.md`、`02-xxx.md` 这样的数字前缀）：

```md
---
'dsh-console': patch
---

状态栏的快捷键提示还停在 1~6，实际已经有 7 个页面
```

级别：`patch`（修 bug、内部改动）、`minor`（向下兼容的新功能）、`major`（不兼容的改动）。
正文会**原样**变成 CHANGELOG 里那一条，所以可以像写 CHANGELOG 一样写它：先一句结论，
需要的话再写 `### 小节` 和列表 —— 汇总脚本不会改动你的措辞与结构。

## 这次改动不需要出现在 CHANGELOG 里？

`npx changeset add --empty` 放一个空片段：它不产生版本、也不进 CHANGELOG，只是让
"每个 PR 都要带一个片段"这条闸门能过（发版汇总时会自动清掉）。

## 闸门与汇总

- **闸门**（PR 上跑，见 `.github/workflows/ci.yml`）：`npx changeset status --since=origin/main`
  —— 改了代码却没带片段就失败；
- **汇总**（发版前跑）：`npm run release:prepare`
  —— 算出版本号、写进 `CHANGELOG.md`、改 `package.json` 的版本、删掉已汇总的片段；
  加 `--dry-run` 可以只看不改。

> 不要用 `changeset version`：它写出来的标题是 `## x.y.z`（既没有方括号也没有日期），
> 与本仓库 `tools/changelog-extract.mts` 的契约（`## [x.y.z] - YYYY-MM-DD`）不一致 ——
> `.changeset/config.json` 里因此设了 `changelog: false`，汇总这一步由
> `tools/release-prepare.mts` 自己做。

## 汇总之后片段就没了（这是有意为之）

汇总会把已消费的片段**删掉** —— 仓库里不留"历史片段"目录，**存档就是 git 历史本身**：

```bash
git log --diff-filter=A --name-only -- .changeset/   # 每个片段是哪个提交加进来的
git show <那次发布的提交>:.changeset/xxx.md          # 片段原文，一行不差
```

PR 的 diff 里也留着一份（片段本来就是随着那次改动一起提交的）。这么选是因为
`CHANGELOG.md` 已经是对外的那份记录 —— 再在仓库里养一份目录，只会让"哪份才是事实来源"变模糊；
真要翻原始描述，git 与 PR 都能翻到。
