---
'dsh-console': patch
---

装插件时用「和这份 profile 对得上」的那份 pnpm，不再被 PATH 里另一档 pnpm 卡住

机器上装了两份不同大版本的 pnpm 时（例如 pnpm 官方脚本装的 10.x 与 nvm 里 corepack shim 的 9.x），
装插件会在 pnpm 那里直接失败，只留下一段看不懂的话：

> node_modules … currently linked from the store at …/store/v10 … pnpm now wants to use …/store/v3 …

现在：装/卸/升级之前先读 profile 的 `node_modules/.modules.yaml`（`packageManager`），挑一份**大版本
一致**的 pnpm 顶到子进程 PATH 最前；一个都对不上时先提示说清，失败时也把那段原文翻成人话 + 出路。
