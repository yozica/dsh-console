---
'dsh-console': patch
---

`node-installer.ts` 拆成 barrel + 八个叶子模块（4169 行 → 2509 行的 barrel/类 + 八个叶子，导出面一个不差）

主进程最大的那个文件（系统级 Node 安装与更新）按主题拆开，调用方与两个反例脚本一行没改：

| 文件                | 行数 | 职责                                                 |
| ------------------- | ---- | ---------------------------------------------------- |
| `node-installer.ts` | 2509 | **barrel + `NodeInstallHooks` + `NodeInstaller` 类** |
| `node-shared.ts`    | 58   | 共用的常量（超时 / 下载地址 / 输出上限 / 常驻文案）  |
| `node-release.ts`   | 230  | 版本清单、校验清单、发布资产（纯函数）               |
| `node-owner.ts`     | 180  | 归属判定 + 注册表 PATH 合并                          |
| `node-failure.ts`   | 194  | 失败分类与人话文案                                   |
| `node-flavor.ts`    | 36   | 安装包形态识别与静默参数                             |
| `node-nvm.ts`       | 412  | nvm 输出解析、模型推导、注册表偏好                   |
| `node-plan.ts`      | 334  | "装还是更新、走哪条路"纯判定 + 提权结果分类          |
| `node-io.ts`        | 455  | IO 底层：探测 / 注册表 / 网络 / 临时目录             |

**类刻意不拆**，而且有一条硬约束：`buildPlan` 与 `transferPhase` 必须留在同一个文件里 ——
`scripts/env-wizard-cases.mjs` 的 F 段按这对锚点切源码。

**判据不变**：导出面机械比对 **39 个 key 零差异**；`npm test` **314/314 且输出与改动前逐行一致**；
沙箱门禁通过（32/32、**185/185**）；`lint` / `format:check` / `typecheck` 全绿。

**跟着搬的两处**：`test/env-fixtures.ts` 的 `installerCode` 与 `scripts/env-wizard-cases.mjs` 的
`installerSource` 都从"只读 `node-installer.ts`"改成"barrel + 八个叶子的拼接"——后者不改会让 M8 那条
（`INJECTED_ENV_NAMES` 白名单）变成 184/185。经验与那条"按文本块删东西先留原文"的教训记在 AGENTS §7.35。
