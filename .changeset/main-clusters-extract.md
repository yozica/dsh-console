---
'dsh-console': patch
---

`main.ts` 拆出三个自成一体的簇（1798 → 1554 行）

`main.ts` 是 Electron 入口，模块级可变单例多，所以先把**不依赖别的簇**的三块搬出去，每个只拿一个
小的 context（可变单例用 getter，稳定的才传函数）：

| 文件               | 行数 | 装什么                                                                                                    |
| ------------------ | ---- | --------------------------------------------------------------------------------------------------------- |
| `main-theme.ts`    | 109  | 主题、窗口底色、标题栏浮层、`broadcastTheme`（context：`isMac` / `getWindow()` / `send()` / `getMode()`） |
| `main-embedded.ts` | 183  | 内嵌页诊断（guest console / 加载失败 / 请求失败）与开发期产物变化自动重载                                 |
| `main-menu.ts`     | 71   | 应用图标与菜单（Windows/Linux 留空、macOS 最小原生菜单）                                                  |

**一次真实的机械替换事故（已修，记进 AGENTS §7.35）**：把 `mainWindow` 批量换成 `ctx.getWindow()`
时，`if (!mainWindow || mainWindow.isDestroyed()) return;` 被改成了
`if (!ctx.getWindow().isDestroyed()) return;` —— **判空和取反一起丢了**。`npm test` 抓不到这个
（main.ts 不在自检的运行时图里），只有搬完逐字读一遍才发现。教训：搬 `if (x && !x.y)` 这类判断
别信 sed，写完必须读。

验收：`npm test` **314/314**（仅上一轮改名的两行不同）、沙箱门禁通过（32/32、185/185）、
`lint` / `format:check` / `typecheck` / `build:main` 全绿。**Electron 在沙箱里起不来**，所以这一步
还需要你真机 `npm start` 翻一眼（窗口底色 / 标题栏配色 / 内嵌页诊断日志 / 菜单）。
