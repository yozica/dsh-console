---
'dsh-console': patch
---

自检开始拆模块：`test/selftest.ts` 的公共件与第 1~5 组先出去（6591 → 6172 行）

`test/selftest.ts` 原本是一个 6591 行的文件、314 条断言全挤在一个 `main()` 里（最多的几条一次要看
六千行）。这一步只做搬迁，判据是**自检输出逐行一致**（314 条同名、同值、同顺序；只有「健康探测（真实）」
那行的 `Nms` 计时会抖，比对时归一化掉）。

- `test/harness.ts`：断言登记（`check` / `skip`）、统计与 GitHub Actions 失败注解（`report`）、
  「这台机器能不能起子进程」的两个探测，以及 `IS_WINDOWS`。各主题模块共用这一份，别各打一份汇总。
- `test/repo.ts`：自检共用的仓库事实 —— 仓库根、`.verify/` 临时目录，以及那个跨几千行还在用的
  `Settings` 实例（原来 `main()` 开头建好、§17d 还在用）。
- `test/checks/launch.ts`：第 1~5 组（启动命令解析 / ANSI 与横幅 / 健康探测判据 / 端口占用解析 /
  DshManager 状态机）整段搬过来，47 条断言，行为一字未改。
- `test/selftest.ts` 只剩入口：建 `repo` → `await runLaunch(repo)` → …（其余各组仍在原地）→ `report()`。

验收：`npm test` **314/314** 且输出与改动前逐行一致；`node scripts/selftest-sandbox.mjs` 通过
（两个反例脚本 32/32、185/185 照旧）；`lint` / `format:check` / `typecheck` 全绿。
