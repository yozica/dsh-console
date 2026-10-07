---
'dsh-console': minor
---

环境自检里 **dsh 能挑版本了，pnpm 也能按它自己的安装方式更新**。

需求原话：「还需要支持选择 dsh 的更新版本，支持 pnpm 的更新，pnpm 要能识别原来是怎么安装的，并且用对应的更新方法进行更新」。

## dsh：版本下拉

确认区里多一个**版本下拉**：列出安装源上**全部发行版**（倒序）、带上 dist-tags 标注（`0.2.0-rc.2 · latest`）、默认落在主进程算出的目标。选到比当前低的版本时**明确说是降级**（照 Node 换档那套说辞）。

行上的按钮规则不变（**只有真有新版本才给主按钮**，上一轮用户裁定），但在读数旁边多了一个 **「选择版本…」**（ghost）——与 Node 那一行「已是最新 + 换一档」完全同形。**这一条是我（agent）替你定的，可能被否决**。它和前几轮不同的一点：与主按钮**同尺寸**（`.btn.small`，不是 `tiny`），层级只由 ghost 的配色表达 —— 用户真机截图抓到过两个按钮差 4px（`.env-actions` 只写了 `display: flex` 而没写 `align-items`，而 `.btn.small` 27px / `.btn.tiny` 23px 都是固定高，于是按顶边对齐）。

确认区显示的那条命令改成走**新通道 `env:fix-plan`**：用户改下拉 → 按选中的版本现场取一次定向计划。执行侧用同一个 builder、同一份校验，所以显示的就是真要跑的（`@deepseek-ai/dsh@0.1.7` 与不带版本那条不是一回事）。

**列表的画法是把 A 与 C 合起来的**（用户先选了 A 的浮层形态，再要求"ac 的能力不能结合吗"）：A 的机制一个字没动，只换成 **C 的时间轴** —— 每行一条轴 + 一个节点（当前 = 实心绿点 +「当前」、目标 = 空心 accent 环 +「目标」），当前到目标之间那几行的轴换成强调色实线（两个端点行再各补"朝目标的那半行"，线段因此连到两个节点上）；区间算下标（`betweenIndexes()`）、首尾收口；浮层顶上钉一条**粘性摘要行**（`0.1.5-rc.1 → 0.2.0-rc.2 · 升级` / `… · ↓ 降级` / `…（当前就是这一版）`），限高仍是 232px，方向信息不跟着滚走。

方向与区间都是纯函数（`pickDirection()` / `betweenIndexes()`，反例脚本里离线喂字面量）：**升 accent、降 amber** —— amber 在本仓库只表示"在往下降"，所以它不能同时用来画升的那一段（否则顶上写「升级」、轴却是琥珀色）。键盘高亮与「当前/目标」是**两套独立状态**，同一行两件事都占时都看得见。

## pnpm：认四种来源，各用对应方法更新

新增动作 **`update-pnpm`**（不新增第二条执行路径，仍然是 `envFix` 那一条）：

| 来源         | 判据（`realpath` 是决定性的那条）                                                     | 更新命令                                                       |
| ------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `standalone` | `~/Library/pnpm/pnpm`（macOS）/ `~/.local/share/pnpm/pnpm`（Linux），且是**普通文件** | `<那份 pnpm> self-update <版本>`                               |
| `corepack`   | `realpath` 落在 `…/node_modules/corepack/…`                                           | `<同目录的 corepack> prepare pnpm@<版本> --activate`           |
| `npm-global` | `realpath` 落在 `…/node_modules/pnpm/…`                                               | `<那份 pnpm 所属 Node 的 npm> i -g pnpm@<版本>`                |
| `homebrew`   | 路径在 `/opt/homebrew/…`，或 `realpath` 落在 `/usr/local/Cellar/…`                    | `brew upgrade pnpm`（**不能钉版本**）                          |
| `unknown`    | 其余一切                                                                              | **不给自动动作**，只给手工步骤（与 Node 归属那套诚实边界同构） |

三条硬约定（与上一轮 dsh 那个 bug 同源）：

- **更新对象 = 插件页实际会用的那一份**（`findPnpmForProfile`，按 profile 的 store 大版本挑），**不是** PATH 上随便一份 `findPnpm()`。拿别的 pnpm 去更新，用户看到"成功"而实际用的那份一个字没变。
- **目标版本钉在 profile 记的那个大版本线上**（`packageManager: pnpm@10.x` 里那个 10），是"同一大版本内的最新"而**不是 `latest`** —— store 布局按大版本走，跨大版本会被 pnpm 直接拒绝。跨大版本本轮不做，界面上说清了为什么。
- **`unknown` / 缺工具 / 拿不到目标版本 → 一个入口都不给**（`canAutoUpdate` + 手工步骤 + 「重新检测」），且**绝不裸跑** `self-update` / `prepare` / `i -g`（不带版本会跳到最新，可能跨大版本）。

界面按归属给按钮文案（「用 Corepack 更新 pnpm」/「用 Homebrew 更新 pnpm」/「更新 pnpm（自更新）」/「用 npm 更新 pnpm」）。

## 只有 dsh 能选版本；pnpm 固定在线内最新（t84，用户裁定）

用户先提过"pnpm没有支持选择版本"，做出来之后又问了"为什么 pnpm 不支持跨版本切换"；听完理由（下面是第 1 条）**裁定 pnpm 不做选版本**，于是这一档回退：

- **为什么 pnpm 不跨大版本**：pnpm 的 **store 布局按大版本走**（9 → `store/v3`、10 → `store/v10`、11 → SQLite 的 store v11），profile 的 `node_modules` 是某一个版本装的、`.modules.yaml` 记着 `packageManager: pnpm@10.x`，换一代之后 pnpm 会**直接拒绝动手**（真机报错 `… currently linked from the store at … store/v10 … pnpm now wants … store/v3`）。跨代还连带 pnpm 11 那些破坏性变更（`.npmrc` 只留 auth/registry、**不再读 `npm_config_*`** 改读 `pnpm_config_*`、全局安装被隔离且可执行文件挪到 `PNPM_HOME/bin`、`allowBuilds` 取代旧构建设置）—— 官方给的是**迁移指南 + codemod**。
- **所以"更新 pnpm"只在 profile 那条大版本线内取最新**（`allowMajor` 仍然生效：这台机器上是 `10.34.6`，**不是** `12.9.1`）。主进程给 pnpm 的 `versions` 恒为 `[]`（判据 `allowMajor !== null`），界面那一档因此**不渲染 `VersionPick`**、行上也不给「选择版本…」（`canPickVersionOf` 只认 dsh）；`VersionPick.vue` 仍然被 dsh 用着。
- **带版本的 `update-pnpm` 请求在主进程直接拒绝**，并给明确说法 —— 收下再悄悄忽略就是"显示 A、执行 B"。
- **界面保留那句解释**（它正是上面那条理由）："目标钉在 **10.x** 这条大版本线内：pnpm 的 store 布局按大版本走，跨大版本要连同 profile 的依赖一起迁移 —— 那是一次单独的迁移动作，不在这里做。"`EnvPkgUpdate.major` 也保留，就是给它用的。
- **Homebrew 那条"同一条大版本线才允许"的守卫保留**：它防的是 `brew upgrade pnpm` 把大版本换掉，与"选版本"无关。
- **跨大版本是另一次动作**（本轮不做）：备份 → 更新二进制 → `pnpm install` 重链 → 校验 → 失败回滚，并且要同时把安装源注入从 `npm_config_registry` 扩成 `pnpm_config_registry`。

另外时间轴上的「当前」对 pnpm 取的是**被更新那一份**（`pnpmBinding.version`）而不是 PATH 上探测到的那一份 —— 拿错就会把「当前」标在错的版本上。

## 版本号必须校验

`env:fix` 只接受 action（+ 可选版本），主进程 `resolveFixVersion()` 四道闸门：**只有 `install-dsh` 接受版本**（版本下拉只存在于 dsh 那一档）、形状必须严格 semver、**必须落在这一轮从安装源拿到的版本列表里**（列表拿不到就拒绝）、拒绝时给明确说法。渲染层递回来的字符串一概不采信 —— 与"不采信它递回来的路径"同一条安全模型。

## 顺手修掉一个**会改用户文件**的副作用

探 pnpm 版本时原来既不给 `cwd`、也不给 `env`，于是**继承应用的 cwd**；而 Corepack 的 shim 一被调用就会看那个目录有没有 `packageManager` 字段，没有就**替它钉一个**。结果：跑一次自检，用户项目的 `package.json` 就多出一行 `"packageManager": "pnpm@9.6.0+sha512.…"`（在仓库根实测复现，跑两次加两次）。

修法：给探测子进程**中立 cwd**（`os.tmpdir()`）+ **`COREPACK_ENABLE_PROJECT_SPEC=0`**（Corepack 官方的关法）。两者都在 `pnpmVersionOf` 的 `spawnSync` 上，纯函数有反例、这两个选项有静态断言钉着。

## 版本下拉：原生 `<select>` → 自绘浮层（用户裁定 A）

原生 `<select>` 的弹出列表由操作系统绘制，样式插不进去，和确认区那张卡片不搭。用户从三个自绘摆法里选了 **A（触发器 + 浮层列表）**，规格与预览见 `docs/env-version-pick-choices.html`。

- **不被裁剪**：浮层 **Teleport 到 body + `position: fixed`**，打开时按触发器的 `getBoundingClientRect()` 定位（先例：`layout/CloseDialog.vue` 也是 Teleport 到 body）。新增层号 **`--z-pop`（45）**：**高于 `--z-env`（30）**、**低于 `--z-gate`（58）与启动锁（60）**。
- **键盘与鼠标共用一套高亮**（`@pointermove` 与 `↑`/`↓`/`Home`/`End` 都写 `versionActive`，模板里只有一条 `.is-on` 规则）；`Esc` 关闭并把焦点**还给触发器**；点面板外用 **`pointerdown`**（用 `click` 会先落在选项上、先选中再关）；视口滚动 / 缩放**关闭**而不是重算，但**放过面板自己内部的滚动**（否则列表一滚就关）。
- **a11y**：触发器 `aria-haspopup="listbox"` + `aria-expanded`；面板 `role="listbox"`；每项 `role="option"` + `aria-selected`；`aria-activedescendant` 指向高亮项，**id 前缀每个实例一份**（页面上可能同时有多个确认区）。
- **契约不变**：选中仍然只 `emit('pick-version', <版本字符串>)`，命令与校验都在主进程（`resolveFixVersion()`），渲染层不编命令、不校验版本。
- 键盘导航抽成纯函数 `pages/env/version-pick.ts`（`nextActiveIndex` / `clampActive`）：test 侧直接 import 做单测，反例脚本的 O6 组离线喂字面量。

## 「重启 dsh 才生效」那条提示：判据从布尔换成事实（t85）

真机反馈：「重启（dsh）后还是会展示这个」—— 更新完 dsh、**自己重启过 dsh**，之后再点任何更新入口，那句「新版本的 dsh 要重新启动之后才会生效」又冒出来了。

根因不在那句提示本身：它的判据里带着一个**会话内的布尔** `restartDismissed`（用户点「先不用」记成"别再问"），而 `openUpdate()` 每次打开更新入口都把它**复位**（`restartDismissed.value = false`）—— 一次早已生效的更新因此被反复提示。

- **重新问事实**：`EnvFixState` 多一个 `finishedAt`（这一轮跑完的时刻，只有终态有值），界面用纯函数 `shouldAskRestartDsh({ startedAt, finishedAt })` 与 `dsh.startedAt` 比 —— **`startedAt >= finishedAt` 就不再提示**（现在跑的这份就是更新之后起来的）；**任一为 null 时保守地提示**（缺事实不装作知道）。
- **`publish()` 里一轮只打一次戳**（新一轮开头清掉）：若将来某条路重复发布同一条终态、每次都取 `Date.now()`，时间戳会往后漂，而漂晚一点就会把已生效的更新又提示一遍 —— 那是同一个 bug 的另一副面孔。因此 `publish()` 的入参类型是 `EnvFixDraft`（= 不含 `finishedAt` 的状态），调用方想给也给不了。
- **删掉 `openUpdate()` 里那句复位**：提示由事实决定。「先不用」仍然是明确的"别再问我"（会话内有效）。
- **Node 那一条（`asksRestartDsh`）不共用这个判据**，理由写在 `EnvPane.vue` 里：Node 更新会**先停 dsh**，所以它的条件是 `phase !== 'running'` —— 那个条件本身就保证"把 dsh 重新起起来之后提示自己消失"，不存在复活问题；且 `EnvInstallState` 里没有"跑完的时刻"这个事实，为一条当前恒为真的判断去加契约字段不划算。

自检：t85 三条（`finishedAt` 在契约与 `publish()` 里都在、判据比的是事实、`openUpdate` 里**不许**再出现那个复位 —— 原文里连一处都不许有）；反例脚本 O9 组四条（晚于 / 早于 / 相等 / 任一为 null）。视觉核对见 `.verify/restart-ask-{shown,hidden}.png`（两张图里的数字取自编译产物的真函数）。

## 自检

`npm test` **340 → 360**（t81 / t82 组；**t84** 是"pnpm 不做选版本"那一条回退的断言 —— t83 随回退一起删掉了，其中 `!/versionsOfMajor/` 是**否定**断言，防那个只为喂列表而生的函数再回来；**t85** 三条盯着"重启提示由事实决定"）；`env-doctor` 独立反例 **49 → 77**（O5 组：四种归属 + unknown + 前缀反推 + 四条 argv + 版本白名单；O6：版本下拉的键盘导航；O7：时间轴的方向与区间；O9：重启提示的事实判据。原 O8 组"版本列表按大版本线过滤"随 pnpm 选版本一起删掉了；全部离线、不碰磁盘、不碰 DOM）。
