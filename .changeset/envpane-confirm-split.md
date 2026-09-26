---
'dsh-console': patch
---

环境自检页拆出更新确认区：`EnvPane.vue` 1501 → 1205 行，新增 `pages/env/EnvUpdateConfirm.vue`（362 行）

确认区那一整块（更新 Node / pnpm 的"将要执行"：版本档位控件、归属与下载来源的事实表、跨档说明、
以及"开始 / 取消 / 换档 / 换源"）搬进子组件。**它不持有状态**：计划、档位、忙位、报告里的归属都由
父级拿着 —— 父级那一行本身也在读同一份计划画读数态与更新按钮，拆开就会变成两个真源。

**这一步的模板几乎是逐字搬的**：两段各自的 `updateOpen === … && check.id === …` 合成 `kind` 一个
开关、`planFor('install-pnpm')` 换成 `pnpmPlan` 这个 prop，其余连文案带 `cancelUpdate` 这些名字都没动
（子组件里是同名的本地转发函数）。八个只给确认区用的派生值（`nodeCurrentText` / `nodeTargetText` /
`nodeChannelUnknown` / `nodeChannelPickedText` / `nodeUpdateOwnerText` / `nodeSwitchNotice` /
`nodeUpdateNoop` / `nodeUpdateActionLabel`）跟着组件走；`nodeAffectsDshText` 例外 —— 父级的进行中 /
结果区也要用同一句，所以留在父级按 prop 传下去。

样式：`.env-channel` 只有这一块在用 → 进子组件的 `<style scoped>`；`.env-confirm*` 与
`.env-confirm .btn-row`（父组件的"一键修复"确认区也画）→ 收进全局表；自检的 `styleLayers` 表改成两行。

验收：机械等价 **577 → 577 零丢失零多出**、逐像素**完全一致**（`.verify/envpane-split/`）、
`npm test` 314/314（4 行计数口径变化：`.vue` 覆盖 19 → 20、组件数 19 → 20、全局表花括号 197 → 202、
`styleLayers` 17 个页面 → 18 个页面、私有规则条数 86 不变）、沙箱门禁 32/32 + 185/185、
`lint` / `format:check` / `typecheck` / `build` 全绿。

⚠️ 请真机 `npm start` 复核：设置 →「运行环境」→ 查看详情，点 Node 那一行的「更新」（确认区里的档位
单选、跨档说明、事实表、开始 / 取消）与 pnpm 那一行的「更新」；以及未校验那一档的「换一个下载源再试」。
