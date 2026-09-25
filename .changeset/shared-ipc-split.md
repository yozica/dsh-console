---
'dsh-console': patch
---

`shared/ipc.ts`（跨进程契约）拆成 barrel + 八个主题模块（1143 → 22 行的 barrel + 八个叶子）

| 文件             | 行数 | 职责                                                 |
| ---------------- | ---- | ---------------------------------------------------- |
| `shared/ipc.ts`  | 22   | **barrel**：`export *` 八个模块（消费方一行没改）    |
| `ipc-shell.ts`   | 54   | 主题、关闭询问与确认框                               |
| `ipc-update.ts`  | 59   | 自动更新：相位、状态与更新源地址（两个纯常量在这里） |
| `ipc-runtime.ts` | 233  | dsh 运行时快照、事件、会话与设置                     |
| `ipc-archive.ts` | 88   | 归档会话页                                           |
| `ipc-plugin.ts`  | 235  | 插件装配层                                           |
| `ipc-env.ts`     | 175  | 运行环境自检与首启门禁                               |
| `ipc-node.ts`    | 204  | Node 安装 / 更新通道（含 t29 增量）                  |
| `ipc-api.ts`     | 200  | `DshConsoleApi`（preload 照它实现）                  |

**判据**：运行时导出面零差异（只有 `RELEASES_URL` / `UPDATE_MAC_FEED_URL` 两个常量）；
`npm test` **314/314**；沙箱门禁通过（32/32、185/185）；`lint` / `format:check` / `typecheck` /
渲染层构建全绿。

**两处刻意改了口径**（这是唯一两行输出变化，其余 312 行逐字不变）：

- **"契约零 import" → "零*运行时* import"**：叶子之间必须 `import type`，判据从 `/^\s*import\s/m`
  收紧成 `/^\s*import\s+(?!type\b)/m`，两处自检标题与 `scripts/env-doctor-cases.mjs` 的 P 检查一起改。
- **同文件里"再声明一次同名 interface"是隐式合并**：t29 给 `EnvDoctorReport` 加字段就是那么写的，
  拆到两个模块后它们是两个不同的 interface（`tsc` 立刻报缺字段）—— 已把字段并回同一份声明。
  这条与"读源码文本的断言要读整份"（`repo.ipcSource` / `plugin.ts` / `env-doctor-cases.mjs`）
  一起写进 AGENTS §7.35。
