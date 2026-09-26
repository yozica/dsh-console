---
'dsh-console': patch
---

渲染层的外壳目录改名：`shell/` → `layout/`（跟终端页的「本地 Shell」不再撞名）

仓库里 "shell" 有两个意思：**窗口外壳**（目录名）与**本地 shell 进程**（终端页那一路 zsh / pwsh，
在 `pages/terminal/`、逻辑在 `lib/xterm.ts`）。看目录树时容易混，所以按通用的叫法把外壳这一层
改名成 `layout/`：

| 旧                                   | 新                                    |
| ------------------------------------ | ------------------------------------- |
| `src/renderer/shell/RailNav.vue`     | `src/renderer/layout/RailNav.vue`     |
| `src/renderer/shell/TopBar.vue`      | `src/renderer/layout/TopBar.vue`      |
| `src/renderer/shell/StatusBar.vue`   | `src/renderer/layout/StatusBar.vue`   |
| `src/renderer/shell/CloseDialog.vue` | `src/renderer/layout/CloseDialog.vue` |

纯改名：只动 `mount.ts` 的 import、注释与文档里的路径指针；模板与样式一行没动
（机械等价 577 → 577 零丢失零多出）。判据记在 AGENTS §7.37。

验收：`npm test` **315/315**，输出与改动前**逐行只差 1 行**（一条提示里的路径
`shell/RailNav.vue` → `layout/RailNav.vue`）；`build` / `lint` / `format:check` / `typecheck` /
沙箱门禁（32/32 + 185/185）全绿。
