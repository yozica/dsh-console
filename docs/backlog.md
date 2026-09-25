# 待办（以后再做）

不是路线图，只是一份"说好了以后做"的清单，免得只留在对话里。每条都写清**为什么**、**从哪开始**。

## 1. 样式分层：单表 → 「全局骨架 + 组件 scoped」

**现状**：`src/renderer/styles.css` 一份 4506 行，**0 个 `.vue` 带 `<style>`**；20 条规则挂在
`html`/`body` 的状态上；`test/selftest.ts` 有 6 处直接读这张表。

**为什么现在是一份表**（当年有意，不是疏忽）：

- **状态开关本来就是全局的**：`data-theme` / `data-platform='darwin'` / `body[data-immersive]` /
  `data-native-fullscreen` / 门禁 —— 20 条规则挂在 html/body 上，跨页面跨组件生效，不属于任何组件。
- **布局契约是"组件之间"的**：`rail | workspace` 两列网格、`.pane` 用 `visibility` 继承藏整页
  （子元素不许写 visible）、`.term-body` 是两路终端的定位基准、挂载点必须 `display: contents`、
  启动锁/门禁的 z-index 预算 —— 见 AGENTS §7.6 / §7.30 那些真机踩坑记录。
- **顺序有语义**：`@xterm/xterm/css/xterm.css` 必须排在 `styles.css` 之前（同权重靠顺序决定覆盖）。
  scoped 选择器特异性更高，覆盖关系会从"谁在后"变成"谁更具体"，更难推理。
- **验收架在这张表上**：视觉规格的间距值取自设计预览 HTML（与实现共用同一批 CSS 变量），
  自检有 6 处读 `stylesCode`，还有一条补偿断言「标记（HTML + .vue）里用到的 class 都有对应样式」
  —— 它就是为了在**没有 scoped 隔离**时兜底。

**代价（要认）**：类名靠约定、改一个组件要在模板与全局表之间来回、组件删了 CSS 可能残留。

**目标分层**：

| 层   | 放哪                             | 内容                                                                                   |
| ---- | -------------------------------- | -------------------------------------------------------------------------------------- |
| 全局 | `styles.css`（或拆成 `styles/`） | CSS 变量/主题、html/body 状态、跨组件布局骨架（rail / panes / overlay / z-index 预算） |
| 局部 | 组件 `<style scoped>`            | 表单行、卡片内部排版、只在组件内成立的微调                                             |

**从哪开始**：先挑一个"自成一体的页面组件"试点（例如 `panes/SettingsPane.vue` 的表单行 ——
它样式多、跨组件依赖少），把它的局部规则搬进 `<style scoped>`，**同时**把自检拆成两类：
读全局表的留在原处、局部样式改成读 `.vue` 的 style 块；那条"class 都有样式"的断言要跨两层继续成立。
试点跑通后再按页面推。

**进展（t48，设置页试点已合并）**：`panes/SettingsPane.vue` 的 `<style scoped>` 收了 198 行
（`.settings` / `.form-row` / `.input-suffix` / `.update-*` + 「聚焦蒙层」的 `.spotlight`），
全局表 4502 → 4329 行；`.check` 与 `.panel-block > .hint` 是共享件，留在全局表。
判据、两个后果（scoped 会让特异性 +1；自检必须跨两层看）与三道验收（`选择器 → 声明` 多重集的
机械等价、headless Chrome 逐像素比对、自检钉子）都写在 AGENTS §7.33 —— 照着做下一页即可。

**第二批（归档会话页，已合并）**：`.archive*` 一整节 415 行全搬进 `ArchivePane.vue`（全局表
4329 → 3914）。这一页带来两个新的坑，都记在 AGENTS §7.33：① `v-html` 渲染出来的正文（`renderMarkdown`
塞进 `.archive-turn-body` 的那些 `h1 / p / code / table …`）**必须写成 `:deep(...)`**，否则编译成
`.archive-turn-body h1[data-v-*]` 一条都匹配不上；② 多行选择器列表逐行加 `:deep()` 会漏掉前几行
（这版漏了 `h2..h5 / ul / th` 共 7 条，靠查构建产物才抓到）。

**第三批（控制台，已合并）**：37 个条目 263 行搬进 `DashboardPane.vue`（全局表 3914 → 3649），
并把误放在「控制台」一节里的 `.settings-status` 收进 `SettingsPane.vue`。两个新教训记在 §7.33：
① 「共享件还在不在全局表」要用**行首锚定**查（`.log-panel .panel-head` 里含 `.panel-head`，
contains 会误判）；② 产物里的媒体查询被压成现代区间语法（`@media (width<=900px)`），
按 `max-width` 去 grep 产物会以为"规则丢了"——核对产物时按属性/值 grep 更稳。

**第四批（环境自检页，已合并）**：两节里 EnvPane 私有的 37 个条目 276 行搬进 `EnvPane.vue`
（全局表 3649 → 3377）；`.env` / `.env-actions` / `.env-op*` 与别处共用，留在全局表。
这一轮补上一条自检改造：到处在用的 `cssBlock(selector)` 助手也改成读**两层**样式表
（只看全局表时 `.env-main` / `.env-seg` 那两条断言直接假红）。

**第五批（插件页，已合并）**：整节 96 个条目 728 行搬进 `PluginPane.vue`（全局表 3377 → 2649，
已经比最初的 4502 少了 41%）。判归属时踩了个假阳性：自动判据按"文件里出现过这个词"算，把
`RailNav.vue` 里的 `{ id: 'plugin' }` 字符串、别处注释里的 `.plugin-tag` 也算成了使用者 ——
**要按标记里的 class 核**（`grep 'class="[^"]*\b类名\b'`）。

**第六批（首启环境向导与入口门禁，已合并）**：98 个条目 695 行搬进 `shell/EnvGate.vue`（全局表
2649 → 1945）；与环境自检详情层共用的 42 条（`.gate-option*` / `.gate-choice*` / `.gate-confirm*` /
`.wizard-*`）留在全局表。这一轮抓到一个搬运脚本的坑：**注释里的 `{` / `}` 会把朴素的花括号计数带偏**，
切出"半条注释 + 半条规则"，机械等价立刻报账（丢 1 / 多 3）—— 改成先掩码注释再数括号。

**第七批（外壳四件，已合并）**：左栏 / 顶栏 / 底栏自己的 29 条（`骨架` 一节）＋ 按状态着色的 5 条
（`指示灯`）＋ 关闭确认卡片整节 7 条，分别搬进 `shell/{RailNav,TopBar,StatusBar,CloseDialog}.vue`
（全局表 1944 → 1653）。跨组件布局契约（`.app` / `.workspace` / `.pane`）与 `html`/`body` 状态规则
留在全局表；判据要先排除 `html`/`body`/`:root` 开头的规则。

**第八批（最后一批，已合并）**：终端页 12 条 + dsh 终端 1 条 + 内嵌界面 4 条 + 顶栏 2 条 +
常驻横幅 1 条 + 环境自检外层 2 条（全局表 1651 → 1500）。`.term-host` 的基础规则按 §7.30 留在全局表。
三处直接读 `stylesCode` 的自检改成读两层；顺带修掉 12 处"段落标记被粘到 `}` 后面"（攒了几轮）。

**下一批顺序**按"这一页真正私有的规则条数"排（不是段落行数 —— 很多段落里大部分是共享件）：
插件页（PluginPane，83 条，
最大的一块）→ 骨架里的 shell 私有
（RailNav 18 / TopBar 7 / StatusBar 4，要拆到三个组件）→ 内嵌界面（UiPane 4）与终端类页面
（TerminalPane 7 + DshTerminal 1，两个组件共用一个 `.term-body` 契约，搬之前先想清楚哪条归谁）。
启动锁（5 条）、`.banner` / `.embedded-view` / `body[data-immersive]` 这些共享件与状态规则、
以及 `index.html` 里那几条**留在全局表**（markup 是静态的，没有组件可挂）。

**前置**：插件这边（`dsh-plugins` 的 `paths` 包）先做完 —— 用户 2026-09-25 定的顺序。**已满足**。

## 2. macOS 自动更新（先放着）

macOS 因为签名（ad-hoc，无证书）只能手动下载更新；`README` 与 `release.yml` 里都写了。
**先不做**（用户裁定）。要做时从 `main/updater.ts` 的平台分支与 `docs/` 里的签名说明入手。

## 3. 环境向导的"没验收路径"（不预先补）

`docs/env-wizard-freeze.md` 有 32 条裁决，其中平台矩阵把"门禁三态 / 逐步引导 / Node 安装更新 /
快速探测"限定在 win32；R-26/R-27 的 nvm 路径、R-23 的提权检测也都是 Windows 语义；
冻结文自己还标了 `/qb` 这类安装器参数**未在真机验证**。

**处理方式（用户裁定）**：不预先补 —— **真机撞上时按同样的方式收口**（改判 + 加自检钉子 +
在上游三份原稿里留指针）。不要为了"覆盖所有分支"提前重写这段。

## 4. 侧栏 HTML 预览里的外链点不动（已知限制，不改）

官方 `dsh-client-ui-sidebar-documentpreview` 把 HTML 放进 `sandbox="allow-scripts"` 的 iframe
（无 `allow-popups`），点击在 iframe 内就被丢掉，外壳收不到、也注入不了脚本。
**我们不改上游、也不去动沙箱**；要让侧栏内容可点，走 `dsh-plugins` 的 `paths` 包
（接管 md / html 的 body，自己渲染）。见 `dsh-plugins/docs/panel-path-links.md`。
