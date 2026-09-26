---
'dsh-console': patch
---

渲染层的 `lib/` 拆成 `utils/` / `state/` / `shared/` 三层，只有一处用的逻辑跟回那一处

原来那个 `lib/`（24 个模块）混着三种东西：通用工具、跨页共享状态、以及"其实只有一处用"的逻辑。
现在按可机械检查的判据分开：

| 目录      | 判据                                                          | 装什么                                                                                                            |
| --------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `utils/`  | 纯工具：与 dsh 领域无关、不持有状态、不 import 渲染层别的目录 | format / platform / markdown / scroll / clipboard / status-message / webview（类型）                              |
| `state/`  | 跨页共享状态与相位机：持有 `ref` / 订阅 IPC                   | store / boot-lock / env-doctor / env-wizard / env-layer / env-anchor / update-anchor / restart-nav / restart-flow |
| `shared/` | ≥2 处用的领域逻辑，不持有状态、也不是通用工具                 | gate-copy / env-install-phase / phase-text                                                                        |
| 跟回特性  | 只有一处用（哪怕它是纯逻辑）                                  | `gate/wizard-view.ts`、`pages/{dashboard/dsh-actions,env/env-detail,plugin/plugin-view,terminal/xterm}.ts`        |

**自检也跟着与目录结构解耦**：`test/repo.ts` 递归扫全部 `.vue` 与 `.ts`，新增 `tsPath()`
（与 t67 的 `vuePath()` 同款：重名或拼错当场抛错）；「渲染层脚本」的合集从「`app.ts` + `lib/*`」
改成「全部 `.ts`」。顺手把两处**写死 import 路径**的断言改成只看文件名 ——
`test/checks/styles.ts` 那条（`from '../lib/restart-nav.js'`）在搬完之后立刻红了，正是它的功劳。

验收：`npm test` **315/315**，且输出与改动前**逐行完全一致**（零差异）；机械等价 **577 → 577**
零丢失零多出（`test/repo.ts` 读样式的路径也跟着换了，夹具不受影响）；
`build` / `lint` / `format:check` / `typecheck` / 沙箱门禁（32/32 + 185/185）全绿。
