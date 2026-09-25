---
'dsh-console': patch
---

自检拆模块第四步：插件装配层 / 补丁层 / 救援成文件（`selftest.ts` 4746 → 3640 行）

- `test/checks/plugin.ts`（1146 行）：插件装配层（只读）、你自己的补丁层、救援（P2）三块 ——
  这一层全靠"别人写的文件 + 别人打印的文本"，夹具是**真实输出**（本机 web profile），
  上游改格式时这里第一时间变红。
- `test/repo.ts` 补 `pluginSource` 与 `fixture(name)`（读 `test/fixtures/`），并明确暴露
  `testDir` —— 搬到 `test/checks/` 的代码不能再拿 `__dirname` 拼夹具路径（这次又踩了一次：
  `readProfileManifest` 收到了 `test/checks/fixtures/profile`）。这条与相对 import 多退一层
  是同一类问题的两个面。

验收：`npm test` **314/314** 且输出与改动前逐行一致；沙箱门禁通过（32/32、185/185）；
`lint` / `format:check` / `typecheck` 全绿。
