---
'dsh-console': patch
---

样式分层最后一批：终端页 / 内嵌界面 / 零散几条各自归位（全局表 1651 → 1497 行，−154）

- `pages/terminal/TerminalPane.vue` 12 条（`.term-body` / `.term-view*` / `.shell-tab*` / `.shell-pane*` / `.chips` / `.btn.outline`）、`pages/terminal/DshTerminal.vue` 1 条（`.bar-title`）、`pages/ui/UiPane.vue` 4 条（`.ui-paste*`）、`shell/TopBar.vue` 2 条（`.immersive-only` / `.topbar-note.lit`）、`gate/GateBanner.vue` 1 条、`pages/env/EnvPane.vue` 2 条（`.env` / `.env > .bar`）。
- **`.term-host` 的"基础规则"（relative + flex: 1 1 auto）仍留在全局表** —— 两路终端共用它（§7.30）；只作用于本地 Shell 那一路的 `.term-body > .term-host` 跟着 `TerminalPane` 走。
- 三处直接读 `stylesCode` 的自检改成读两层：`.btn.outline` / `.shell-tab.active`、`.term-body` 与 `.term-host` 的四条、`.topbar-note.lit` 与三条"已经删掉的那套"；"每行至少有个非空 `<style scoped>`"的粗门槛从 `> 200` 字符降到 `> 0`。
- 顺手修掉 12 处段落标记与 `}` 粘行（几轮搬运脚本攒下的），并加了一条钉子：段落标记必须自成一行。
- 验收：机械等价 577 条 → 577 条；headless Chrome **十三段**夹具逐像素一致；`npm test` 314/314。
