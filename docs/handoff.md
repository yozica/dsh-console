# DSH Console 当前进度（交接）

> **给谁看**：换一个环境接着做的人，以及那个环境里的 agent。这份文档**自带背景** —— 你不需要看到此前的对话。
> **先读顺序**：[`../AGENTS.md`](../AGENTS.md)（怎么跑、目录在哪、有哪些硬约定）→ 这一份（现在到哪了）→
> [`backlog.md`](backlog.md)（说好了以后做的）→ [`../CHANGELOG.md`](../CHANGELOG.md)（每一版发了什么）。
> **这份会过期**：durable 的是 CHANGELOG / AGENTS / backlog。下面的数字都绑在 §6 那个快照上。

## 1. 一句话现状

- 最新发布 **v0.6.6**（2026-09-27，GitHub Release 已发布）。
- `main` = `9fe9032`（`Merge pull request #88`）；远端只有 `main`（PR 合入自动删分支）。
- 自 v0.6.5 起合入 **5 个 PR（#84–#88）**：内嵌页 console 日志修复 → 终端选中复制（本地 Shell 与 macOS 键位）→ 插件页内边距，最后发布 v0.6.6。
- **有一个待合并的 PR**：`feat/env-pkg-update-entry` —— 环境自检里给 dsh / pnpm 加**带版本比对**的更新入口。**用户已在真机上验过**：自检页点「更新 dsh」把 dsh 从 `0.1.5-rc.1` 升到 `0.2.0-rc.2`，而且落在 **console 实际使用的那棵 Node 树**下（见 §5 那条环境变量的坑）。
- **下一件要做什么由人指定**（目前还没有定）。

## 2. 这条线上最近做了什么（时间倒序，都能在 `git log` 与 CHANGELOG 里核到）

| PR      | 做了什么                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------- |
| #88     | 本地 Shell（自建终端）也能复制：有选中时 `Ctrl+C` 就是复制，没选中照旧是中断                        |
| #87     | 插件页「你的层」说明句的 16px 内边距（规则写在了另一个组件的 scoped 里）                            |
| #86     | 终端工具条提示只留「dsh web 不读键盘输入」（复制那句用户裁定删掉）                                  |
| #85     | 终端页支持选中后 `Ctrl+C` 复制（macOS 一条都不拦，判据收在 `xterm.ts` 的纯函数里）                  |
| #84     | 内嵌页 console 日志全丢 —— `readConsoleMessage` 读错了参数位置                                      |
| #82     | 应用内全屏时顶栏那句「发现新版本…」挪到地址**左边**（用户真机抓图指出；有自检钉住三者的位置关系）   |
| #81     | 开发态「假装更新相位」：设置页「关于」卡一排按钮 + `⌘+Shift+U`，两条入口共用 `state/update-fake.ts` |
| #80     | 应用内全屏时更新提示补一份到顶栏（底栏被 `display:none` 藏起来了）                                  |
| #79     | 补根 `tsconfig.json`（编辑器里 `window.dshConsole` 不再报 TS2551）+ 给现场编译加 `--ignoreConfig`   |
| #78     | `resolvedTheme` 单一来源（xterm 配色与首帧兜底判一次）                                              |
| #77     | 插件页「还有 N 条…」提示的左内边距                                                                  |
| #76     | 新建 `composables/` 层：`use-tab-activation` / `use-webview`                                        |
| #75     | 渲染层 `lib/` 拆成 `utils/`（纯工具）/ `state/`（跨页状态）/ `shared/`（跨特性逻辑）                |
| #74     | 外壳目录 `shell/` → `layout/`（不跟终端页的「本地 Shell」撞词）                                     |
| #73     | 渲染层「一处一目录」：`pages/<feature>/` + `components/` + `gate/` + `layout/`                      |
| #72     | `.gate-actions` 的 16px 间距（scoped 够不着别的模板；自检 t66 就是为它加的）                        |
| #47–#71 | 大文件拆模块（主进程 barrel / 渲染层 / 自检三层），判据写在 AGENTS §7.34–§7.36                      |

**用户已经真机验过**：#81 + #82 那条路径 —— 设置页假装「发现新版本」→ 底栏与全屏顶栏都出现提示 → 点它退出全屏并聚焦更新卡片 → 「还原」回到真实相位。

## 3. 说好了但还没做

[`backlog.md`](backlog.md) 里四条，加一条**待定**：

- §2 **macOS 自动更新** —— ad-hoc 签名装不了，先放着（Windows 那条路已经在跑）。
- §3 **环境向导的"没验收路径"** —— 不预先补，等真撞上再说。
- §4 **侧栏 HTML 预览里的外链点不动** —— 已知限制，不改。
- §0 末尾 **状态层要不要换 Pinia** —— **待定**，当时的结论是"先不引"（理由：14 处 `createApp()` 挂载 + 4 处模块级状态让 `useStore()` 别扭，`store.ts` 本来就是主进程推送的镜像，且有 6 条自检在断言那些文件的文本）。要引的话：`npm i -D pinia`（需要先跟用户说一声）+ 保留模块级 API 作薄再导出，15 处组件 import 就不用动。

## 4. 在这里干活的最短路径

1. **三条闸门**（AGENTS §5）：`npm test` → `node scripts/selftest-sandbox.mjs` → `npm run lint && npm run format:check && npm run typecheck`（**门禁与 lint 必须串行**，否则一屏 `no-undef`）；改 `src/renderer/` 之后还要 `npm run build`。
2. **改动走 PR**：分支 → 提交（**要带一个 `.changeset/*.md` 片段**，纯文档用 `npx changeset add --empty`）→ 推 → 开 PR → 等 CI 绿 → 合并（合入后远端分支自动删）。发布是另一条线：`npm run release:prepare -- --topic "…"` → 提交 → 打标签推送（见 AGENTS §6）。
3. **证据放 `.verify/`**（已 gitignore）：像素夹具、量出来的像素/行数、改前改后的截图。**不要只写"看起来对"** —— 用户认的是数字与截图。
4. **用户偏好**：中文说明；**先给选项再定方案**；报实测数字（含偏差与计数行的变化，例如"`npm test` 316 → 317"）；界面缺陷常常是用户先发现的，所以动位置之前**先量**。
5. 界面类改动合入后，用户会**自己在真机上过一遍** —— PR 描述里写清"请他看哪一眼"（哪个页面、点什么、期望看到什么）。

## 5. 上一个环境踩过的坑（换环境后可能还会撞）

- **别信本地 `origin/*`**：受限沙箱里 `git fetch` 可能拿不到钥匙串（`unable to get credential storage lock`），远端跟踪引用会停在旧位置。判断远端状态用 GitHub API（token 可以从 `git credential fill` 取）。
- **headless Chrome**：这台机器上截图后它**不会自己退出**、`--dump-dom` 会挂住。用 `--headless --disable-gpu --no-sandbox --no-first-run --hide-scrollbars --force-device-scale-factor=2 --user-data-dir=<仓内临时目录> --screenshot=<png>`，轮询到 PNG 落盘就 kill；量像素用 PIL。
- `node scripts/selftest-sandbox.mjs` 会**就地**生成 `.js`（编译产物），跑完它自己按清单清掉；这就是它不能与 `npm run lint` 并发的理由。
- 换环境后 `node_modules/`、`dist/`、`.verify/` 都不在：先 `npm ci`，证据要重新生成。
- **这台机器的 Node / dsh 分布很绕，升级 dsh 时踩过一个大坑**：PATH 上排第一的 npm 来自 `~/.vite-plus/bin`（是指向 `vp` 的符号链接），而 nvm 下有 v16–v24 七个版本、**dsh 分别装在各自版本目录里**。解析器按"版本号倒序"挑，所以 console 用的是 **v24.14.1** 那份 dsh。而 `npm i -g` 装到哪棵树**并不由 npm 自己的位置决定** —— 从父进程继承来的 `npm_config_prefix`（一个键就够）就能把它翻到 v22.17.1。修法是 `cleanNpmEnv()`：起修复子进程前丢掉**整套** `npm_config_*` / `NPM_CONFIG_*`（只清 `prefix` 那两个不够，实测过），再注入我们自己的 registry 覆盖。同类风险在插件装卸那条 pnpm 链上**仍在**（见 `docs/env-doctor.md` 的已知问题）。

## 6. 快照

写于 **2026-10-07**，对应 `main` = `9fe9032`、发布 **v0.6.6**。之后再有人动过，以 `git log` 与 CHANGELOG 为准。
