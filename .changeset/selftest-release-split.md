---
'dsh-console': patch
---

自检拆模块第三步：发布链路与打包约定成文件（`selftest.ts` 5200 → 4746 行）

- `test/checks/release.ts`（476 行）：第 8~15 组 —— CHANGELOG 与版本号对齐、changeset 片段规则、
  Release 标题与正文、自动更新契约（不偷偷下载 / 不偷偷安装 / macOS 分支）、外链 helper、
  启动早期的日志与兜底、产物命名与更新源、自动全屏前提、macOS 版本检查、依赖归属与包体积、
  更新卡片的分平台文案。
- `test/repo.ts` 再加三份共享事实：`pkg`（package.json）、`ipcSource` / `flatIpc`（`shared/ipc.ts`
  原文与压平版）—— 环境自检与安装引擎那几组还要用同一份。
- 搬到子目录后相对路径要多退一层（`../tools/…` → `../../tools/…`，动态 `import(…)` 与
  `require(…)` 同样），这条与 `__dirname` 一样是子目录搬迁的固定成本。

验收：`npm test` **314/314** 且输出与改动前逐行一致；沙箱门禁通过（32/32、185/185）；
`lint` / `format:check` / `typecheck` 全绿。
