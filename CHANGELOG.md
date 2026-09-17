# Changelog

本文件是本项目**每一个发布版本的内容记录**，也是 GitHub Release 正文的**单一事实来源**：
打 `v*` 标签时，CI 会用 `tools/changelog-extract.mts` 取出对应版本的条目，直接当作 Release 正文
（末尾再附一段固定的下载指引）。所以**发版前必须先有内容** —— 没有条目时 CI 会直接失败，
宁可不发，也不要发出一个空说明的 Release。

**这个文件不手写。** 每条改动写成一个 `.changeset/*.md` 片段（`npx changeset add`），
发版前跑 `npm run release:prepare`：它算出新版本号、把片段正文**原样**汇总成下面的新条目、
改掉 `package.json` 的版本、删掉已汇总的片段。细节见 README 的「发布新版本」与 `.changeset/README.md`。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
每节的标题必须是 `## [x.y.z] - YYYY-MM-DD`（方括号与日期都要有，提取脚本按这个找）。
标题行末尾可以跟一句主题 —— `## [0.3.0] - 2026-09-17: TypeScript 迁移与工具链整理`，
它会成为 GitHub Release 的**标题**；用 `npm run release:prepare -- --topic "一句话主题"` 写进去。
（分隔符 `: ` 与 `—— ` 都认，早期条目就是这么写的。）

条目写**用户能看到的变化**（新增 / 改进 / 修复）；纯内部改动（CI、重构、测试）不必单独详述，
但**每一版都必须有条目** —— 全是内部改动的版本就用一句「内部：…」带过即可，
因为 Release 正文就是这一节，空章节会让发版直接失败。

## [Unreleased]

## [0.4.0] - 2026-09-17: 自动更新

自动更新：Windows 上会自动检查新版本，下载与安装都由你确认

### 自动更新

- 启动后自动检查一次，之后每 6 小时一次；在「设置 → 监控与生命周期」里可以关掉自动检查；
- 发现新版本只在设置页与底栏提示，点「下载」才开始下载（显示进度百分比），下载完再点「重启并安装」——
  下载与安装都不会自己做；
- **macOS 因为是 ad-hoc 签名（Squirrel.Mac 会拒绝安装），自动更新不可用**，请在 Releases
  页面手动下载新版本；设置页会如实说明并给「打开下载页」；
- 开发态不检查更新，也不会加载 electron-updater。

## [0.3.0] - 2026-09-17: TypeScript 迁移与工具链整理

内部：整个代码库迁移到 TypeScript。主进程、preload、渲染层、自检与工具脚本全部是 TS，
跨进程的形状集中在 `src/shared/ipc.ts` —— 加设置项、改 IPC 字段时两边对不上会直接编译报错，
而不是等到运行时才发现。`npm run typecheck` 现在覆盖三份配置（主进程 tsc、渲染层 vue-tsc、
测试与工具 tsc）并接进 CI。界面行为不变，改的是"改错了编译器会不会拦住你"。

修复：状态栏的快捷键提示写着 `⌘+1~6 切换页面`，而左栏其实已经有七个页面 ——
第 7 个「归档会话」的快捷键一直能用，只是没人知道。现在提示与页面数一致。

内部：接入 changesets —— 每条改动写一个 `.changeset/*.md` 片段，发版前用 `npm run release:prepare`
汇总成 CHANGELOG 条目，PR 上会检查"改了代码就要带一个片段"；代码风格显式化（语句结尾要有分号、
多行列表的最后一项要有尾随逗号），并加了一个登记"纯格式化提交"的 `.git-blame-ignore-revs`；
README 收敛为面向使用者的项目介绍，开发说明独立成 `AGENTS.md`。

## [0.2.2] - 2026-09-16

修掉 macOS 版**装完打不开**的问题：0.2.1 及以前的 mac 包在 Finder 里双击只会说
**「DSH Console 已损坏，无法打开。你应该将它移到废纸篓。」**

### 修复：macOS 包在 Apple 芯片上无法启动

- **原因**：macOS 的 .app 打包时**没有签名**。Electron 自带的二进制本来是有签名的，但
  electron-builder 重新打包会改动 bundle 内容，那条签名的封条随之失效 —— 校验时报
  `code has no resources but signature indicates they must be present`（签名存在但无效）。
  Apple 芯片上签名无效的 app 会被系统直接拒绝，给出的说法就是"已损坏"，而不是"未验证的开发者"。
- **改法**：`mac.identity` 设为 `"-"`，也就是 **ad-hoc 签名**（没有开发者证书时唯一可行的签名方式），
  并去掉 CI 里的 `CSC_IDENTITY_AUTO_DISCOVERY=false` —— 那个变量会让 electron-builder
  连 ad-hoc 签名都跳过。
- 现在打包出来的 `.app` 通过 `codesign --verify --deep --strict`（`valid on disk` /
  `satisfies its Designated Requirement`），装了能正常启动。
- **首次打开仍会被 Gatekeeper 拦一下**（ad-hoc 签名不被信任，这是没有开发者证书时的正常表现）：
  **右键 →「打开」**，或到「系统设置 → 隐私与安全性」点「仍要打开」，也可以执行
  `xattr -dr com.apple.quarantine "/Applications/DSH Console.app"` 去掉下载隔离标记。

## [0.2.1] - 2026-09-15

补上 DSH 官方缺的一块：**翻看、恢复、删除归档过的会话**。

### 新增：归档会话页

DSH 的「归档」原本只是把会话 id 写进 `storages/workspace.json` 的 `archivedSessionIds`
—— 纯隐藏、不删数据，而且**没有任何入口能把它找回来**。现在控制台左栏多了一页
（「归档会话」，快捷键 `Ctrl+6` / `⌘6`）：

- **索引列表**：标题、首句、时间、轮数与日志体积；搜索框同时匹配标题与对话内容
- **读全文**：点开即读该会话的完整对话。会话日志是 zstd 压缩的 JSONL，这里按帧解压还原；
  标题、列表、代码块、表格、引用、链接都按 Markdown 正常渲染
- **恢复**：从归档列表移回侧边栏，不改动任何数据
- **删除**：删掉会话日志与投影缓存，并从工作区注册表里移除（会先弹确认框；**附件不删** ——
  它们可能被多个会话共享）

读的是 DSH 自己的数据目录（`$DSH_HOME`，没有则 `~/.dsh`），不经过网络、不上传任何东西。

> 「恢复」与「删除」改的是磁盘上的 `workspace.json`，而正在运行的 dsh 把这份文件读进了内存，
> 所以要**重启 dsh** 后侧边栏才会同步（Harness 页的「重启为受管实例」也可以）。

### 改进

- 归档页按「**转录稿**」而不是聊天气泡来做版式：助手一次回答会跨多个 step 拆成多条消息，
  用气泡会把一段连续回答碎成一墙卡片。现在用户发言用一条强调色竖线标出、助手内容作为连续
  正文流动，整列限宽保证可读行长
- Markdown 渲染器**自包含、不引入第三方依赖**，而且**先整段转义 HTML 再渲染** ——
  模型输出里即使夹带 `<script>` 也只会被显示成文本
- 应用快捷键扩到 `Ctrl+1~7` / `⌘1~7`（多了第 7 个页签）

### 修复

- **发版时 Windows 产物会丢**：v0.2.0 的 Release 里 Windows 的安装包、便携版与 `latest.yml`
  都没传上去（说明里却让用户去下）。根因是两个 runner 各自跑
  `electron-builder --publish always`，并发走到 `getOrCreateRelease()` 时都发现"没有 release"
  就各建一个；更麻烦的是 electron-builder 默认 `releaseType=draft`，release 一旦从草稿变成
  「已发布」，后续上传会被**静默跳过**（步骤显示成功，只在日志里 warn 一句），
  所以"重跑一次 CI 把缺的补上"这条路走不通。
  现在把**打包与发布分开**：两个 `build-*` job 只打包（`--publish never`），产物无条件挂成
  Artifacts；标签构建时由单独的 `publish` job 收齐两边产物、一次建草稿、一次上传。
  没有并发建 release 的窗口，重跑也能覆盖同名产物；**任一平台构建失败就不会建 release**。

## [0.2.0] - 2026-09-15

同一套控制台，Windows 和 macOS 都能用了。macOS 上是原生窗口与 ⌘ 快捷键；Windows 侧行为不变。

### 新增：macOS 支持

- 提供 `dmg`（安装镜像）与 `zip`（免安装），**arm64 与 x64 各一份**
- **原生窗口**：改用 `hiddenInset`，红绿灯在左上角；左栏为它让出位置，**系统全屏时自动撤回**
- **⌘ 快捷键**：`⌘1~6` 切页、`⌘R` 重载、`⌘⇧D` 导出界面结构、`⌘⌥I` 开发者工具；
  状态栏提示也按平台显示 `⌘` 或 `Ctrl`
- **原生菜单**：给了最小菜单（应用/编辑/显示/窗口），否则 `⌘Q`、`⌘C/V` 会失灵；
  关掉窗口不再退出应用（Dock 常驻，点图标重建窗口）
- **本地 Shell** 用你自己的 `$SHELL`（zsh/bash），终端字体与中文兜底按平台换栈
- 主进程跨平台：端口占用改用 `lsof`、进程名用 `ps`、结束进程树按进程组而不是 `taskkill`

### 修复

- **macOS 上「启动不了」**：
  - 不再依赖 PATH 找 dsh —— 从 Finder / Dock 启动的 GUI 应用 PATH 很窄（不含 nvm / homebrew），
    现在会直接扫 nvm / fnm / nodenv、homebrew、pnpm 的全局安装目录找 `bin.js`
  - 自动挑一个**真能跑的 Node**：`dsh` 的 CLI 在旧 Node 上不报错、只静默退出
    （实测 Node 22.17.1 什么都不做、Node 24.14.1 正常），现在选解释器时会实测一次 `--version`
  - 「设置 → dsh 命令」支持**整条命令行**，可以直接指定用哪个 node 跑
  - 启动失败时事件日志会直接给出原因（`dsh 输出：…`），不必去终端页里翻
- macOS 上装了 PowerShell 时，「新建本地 Shell」会开出 `pwsh` 而不是用户自己的 zsh

## [0.1.0] - 2026-09-13

初版发布，仅支持 Windows。

### 新增

- Windows 桌面控制台：在 PTY 里启停 `dsh web`、轮询健康状态、接管已在运行的外部实例
- 内嵌 DeepSeek Harness 界面（自动捕获启动时打印的带令牌地址）
- 事件日志、延迟趋势、端口占用者识别；强杀进程树作为兜底
- 本地 Shell 标签页（pwsh / powershell / cmd）
- DeepSeek 用量页（独立浏览器分区保存登录态）
- 启动行为可配置：自动拉起 dsh、自动进 Harness 页、自动全屏；退出时是否一并停止 dsh

### 已知限制

- `dsh web` 不读取键盘输入，所以 dsh 终端里打字不会有反应；要停它请用「停止」或「发送 Ctrl+C」
- 本地 Shell 不跨应用重启保留 —— 每次启动是全新的一页
