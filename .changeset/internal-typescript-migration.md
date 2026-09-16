---
'dsh-console': minor
---

内部：整个代码库迁移到 TypeScript。主进程、preload、渲染层、自检与工具脚本全部是 TS，
跨进程的形状集中在 `src/shared/ipc.ts` —— 加设置项、改 IPC 字段时两边对不上会直接编译报错，
而不是等到运行时才发现。`npm run typecheck` 现在覆盖三份配置（主进程 tsc、渲染层 vue-tsc、
测试与工具 tsc）并接进 CI。界面行为不变，改的是"改错了编译器会不会拦住你"。
