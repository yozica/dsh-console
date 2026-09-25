---
'dsh-console': patch
---

`process-utils.ts` 拆成 barrel + 八个叶子模块（1347 行 → 9 个文件，导出面一个不差）

主进程那个 1347 行的"进程 / 网络工具"按主题拆开，调用方一行没改：

| 文件                  | 行数 | 职责                                                                                  |
| --------------------- | ---- | ------------------------------------------------------------------------------------- |
| `process-utils.ts`    | 68   | **barrel**：逐条再导出公开面（**不用 `export *`**，叶子模块里还有只给兄弟用的内部件） |
| `process-types.ts`    | 75   | 平台判断 / `COMSPEC` / 跨模块共用的形状                                               |
| `process-shell.ts`    | 267  | 命令查找、PATH 展开、转发器识别                                                       |
| `process-pnpm.ts`     | 260  | pnpm 定位 + VC++ 运行库（`pnpmVersionCache` 跟着 `pnpmVersionOf` 走）                 |
| `process-path-env.ts` | 85   | 给子进程补 PATH                                                                       |
| `process-dsh.ts`      | 256  | 解释器候选与 dsh 启动命令（`dshProbeCache` 跟着 `canRunDsh` 走）                      |
| `process-launch.ts`   | 159  | 启动 spec 的公共件                                                                    |
| `process-probe.ts`    | 165  | HTTP 健康探测 + 端口占用                                                              |
| `process-proc.ts`     | 172  | 进程名 / 结束进程树 / 存活判定 / `homeDir`                                            |

**判据是导出面机械比对**：`npm run build:main` 后比对
`Object.keys(require('./dist/main/process-utils.js')).sort()` —— 改前改后**零差异（43 个）**；
类型导出另核（漏一个 `export type {}` 会让别处 `tsc` 报 TS2724）。自检输出与改动前逐行一致
（314 条同名同值同顺序）—— 其中四条"读源码文本"的断言改成读 `test/repo.ts` 新增的
`processUtilsSource`（barrel + 八个叶子模块的拼接），因为 barrel 里只剩 re-export。

套路与四条做法（显式清单 / 导出面判据 / 缓存跟着读者走 / 读文本的断言改成读整份）记在 **AGENTS §7.35**。

验收：`npm test` 314/314 且输出逐行一致；沙箱门禁通过（32/32、185/185）；
`lint` / `format:check` / `typecheck` 全绿。
