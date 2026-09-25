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

**前置**：插件这边（`dsh-plugins` 的 `paths` 包）先做完 —— 用户 2026-09-25 定的顺序。

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
