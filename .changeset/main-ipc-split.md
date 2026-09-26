---
'dsh-console': patch
---

`main.ts` 的 IPC 注册层拆成六个模块（1507 → 895 行；`registerIpc()` 那 558 行不再挤在一个函数里）

| 文件                  | 行数 | 装什么                                                                         |
| --------------------- | ---- | ------------------------------------------------------------------------------ |
| `main-ipc.ts`         | 25   | **barrel**：`registerIpc(ctx)` 按原顺序调四个叶子，另转发三个公共件            |
| `main-ipc-shared.ts`  | 134  | `IpcContext` / `CloseAsk` + `bundledVersions` / `messageOf` / 忙位等小编排函数 |
| `main-ipc-app.ts`     | 302  | `app:*` / `theme:set` / `settings:patch` / `dsh:*` / `session:*` / `shell:*`   |
| `main-ipc-archive.ts` | 70   | `archive:*`                                                                    |
| `main-ipc-plugin.ts`  | 152  | `plugin:*`                                                                     |
| `main-ipc-env.ts`     | 153  | `env:check` / `env:fix*` / `env:wizard*` / `env:node-*`                        |

`main.ts` 只剩"造一个 `IpcContext`、调一次 `registerIpc(ctx)`"。

**搬动的 557 行逐字复制**，只改四类**可变量**与三个 helper 的签名：`mainWindow` → `ctx.getWindow()`、
`pendingCloseAsk` → `ctx.pendingCloseAsk()`（取一次存下来，getter 之间 TS 不再收窄）、
`rendererConnected` → `ctx.renderer.{isConnected,markConnected}`、`shellCounter` → `ctx.shells.next()`；
`anyoneBusy` / `refusedInstallState` / `wizardSkips` 现在显式吃参数。稳定的引用（`Settings`、各 manager、
那个 `Set`）按值传。

**读源码文本的钉子跟着读整份**：`test/repo.ts` 的 `mainSource` 与 `test/env-fixtures.ts` 的
`envMainCode` 都加上了 `main-ipc*.ts`；三条断言的签名跟着改（`anyoneBusy(ctx)` /
`refusedInstallState(ctx, …)` / `wizardSkips(settings)`），其中两条一开始假红是因为 Prettier 把长调用
折成了多行 —— "参数紧跟在左括号后"的写法要留 `\s*`。

验收：`npm test` **314/314，输出与拆分前逐行相同**（这次零差异）、沙箱门禁通过（32/32、185/185）、
`lint` / `format:check` / `typecheck` / `build:main` 全绿。

⚠️ 这一步动了主进程的启动路径（`bootstrap()` 里造 `IpcContext` 那一处），而 **Electron 在沙箱里起不来** ——
请真机 `npm start` 复核一次：能正常启动、菜单/主题正常、关窗行为不变、跑一次环境自检 + 首启门禁的
两个入口（`env:*` 那组通道现在住在 `main-ipc-env.ts`）。
