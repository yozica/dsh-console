---
'dsh-console': patch
---

应用内全屏时也看得到「有新版本」（提示从底栏补一份到顶栏那格）

更新提示原来只在**底栏**（`layout/StatusBar.vue` 的 `.update-hint`），而应用内全屏时
`body[data-immersive='true'] .statusbar { display: none }` 把整条底栏藏掉了 —— 全屏下更新提示
等于不存在。

- 「有更新」那句进 `state/store.ts`（`updateHint` computed），点它之后做什么进
  `state/update-anchor.ts`（`openUpdateSettings()`）—— 底栏与顶栏读同一份；
- 顶栏那格旁边补一个 `#btn-topbar-update`（只在 `immersive && updateHint` 时出现）。点它**先退出
  应用内全屏**，再切到设置页并把更新卡片滚进视野、高亮一次（全屏时左栏是藏着的，直接切页会让人
  找不到北）—— 与 §7.31 的到达提示同一个落点（顶栏那格在两种模式下都在）；
- `.update-hint` 从组件的 `<style scoped>` 升到全局表：t72 起两个组件都在用，正是 §7.33 的判据
  （`styleLayers` 里 StatusBar 那行同步改成 `staysGlobal`）。
