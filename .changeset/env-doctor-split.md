---
'dsh-console': patch
---

`env-doctor.ts` 拆成 barrel + 六个叶子模块（2907 行 → 605 行的 barrel/类 + 六个叶子，导出面一个不差）

主进程那个 2907 行的"运行环境自检"按主题拆开，调用方与两个反例脚本一行没改：

| 文件                 | 行数 | 职责                                                                |
| -------------------- | ---- | ------------------------------------------------------------------- |
| `env-doctor.ts`      | 605  | **barrel + 两个有状态的类**（`EnvDoctor` / `EnvFixRunner`）         |
| `env-probe-types.ts` | 148  | 探测的形状与超时（`EnvProbeRaw` / `VersionProbe` / `EnvRuntime` …） |
| `env-node-range.ts`  | 354  | Node 版本区间的纯函数（解析 / 比较 / `judgeNodeVersion`）           |
| `env-fix-plan.ts`    | 464  | 修复计划 / argv / 注册表查找路径 / 人话文案                         |
| `env-judge.ts`       | 560  | 纯判定 `judgeEnvironment` 与 `probeTroubleLines`                    |
| `env-probe.ts`       | 670  | 只读探测与二进制定位（含本机 dsh 安装树）                           |
| `env-wizard.ts`      | 306  | 门禁判定（三步表 / `collectBootProbe` / `judgeWizard`）             |

**两个有状态的类刻意留在 barrel 里**：`EnvDoctor` 的实例字段跨"探测 → 判定 → 修复 → 复检"几个阶段，
拆散只是把"一个类里的顺序"换成"几个类之间的时序"。

**判据不变**：导出面机械比对 **55 个 key 零差异**；`npm test` **314/314 且输出与改动前逐行一致**；
沙箱门禁通过（32/32、185/185）；`lint` / `format:check` / `typecheck` 全绿。

**跟着搬的三处**（见 AGENTS §7.35 的第二段）：`test/env-fixtures.ts` 的 `envSource` 改成
"barrel + 六个叶子的拼接"；`scripts/env-doctor-cases.mjs` 那条读 `env-doctor.ts` 的超时顺序断言仍成立
（`EnvFixRunner.execute` 留在原文件）；一条按"全仓库唯一 owner"找 `['i','-g', …]` 的断言，owner 从
`env-doctor.ts` 变成 `env-fix-plan.ts`。
