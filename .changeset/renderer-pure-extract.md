---
'dsh-console': patch
---

渲染层拆模块第一步：门禁与详情层的共享纯逻辑进 `lib/`（顺带 dedupe 六处逐字重复）

`shell/EnvGate.vue` 2648 → 2515 行、`panes/EnvPane.vue` 1546 → 1501 行，新增：

- `lib/gate-copy.ts`（135 行）：门禁与「运行环境」详情层共用的**词表与现成句子** —— 官方下载页、
  忙提示、三步文案、五项状态词、方法事实、两条安装路、档位词、并存风险，以及 `versionWithChannel`。
- `lib/env-install-phase.ts`（34 行）：安装 / 修复的相位判据（`INSTALL_BUSY_PHASES` / `installRunning` /
  `installSettled` / `isFixSettled`）—— 两个组件原来各抄一份。
- `lib/format.ts` 多一个 `formatBytes`（两处各抄过一份）。

**这一步只搬零风险的纯逻辑**：`<template>` 与 `<style>` 一行没动（判据是 `git diff` 里以 `<` 开头的行
一个都没有），所以免像素对比；验收仍是 `vue-tsc` / `eslint` / `npm test` **输出逐行一致** / 沙箱门禁
（32/32、185/185）+ 渲染层构建成功。

三条铁律与后续计划（子组件、纯派生视图、样式跟着搬时要跑 §7.33 的三道验收）记在 **AGENTS §7.36**：
其中最重要的一条是「`lib/**` 不许有 DOM」——自检的编译图 `tsconfig.node.json` 没有 DOM 类型，
而且这条保证只覆盖被自检 import 的闭包。
