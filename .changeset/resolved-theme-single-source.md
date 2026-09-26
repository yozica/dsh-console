---
'dsh-console': patch
---

主题配色只判一次：`resolvedTheme` 收进 `state/store.ts`（原来在终端两个组件里各写一遍）

xterm 的配色是 JS 选项（不走 CSS 变量），所以终端页那两路各自把"该用哪套配色"算了一遍：
`snapshot.value?.theme?.resolved === 'light' ? 'light' : 'dark'`。两处一字不差，但哪天
"跟随系统"的判定口径变了，只改一处就会出现两路终端一个亮一个暗。

现在 `state/store.ts` 导出 `resolvedTheme`（computed），两个终端读同一个来源。

验收：`npm test` **315/315** 且输出与改动前**逐行完全一致**；`lint` / `format:check` /
`typecheck` / `build` / 沙箱门禁全绿；机械等价不受影响（模板与样式没动）。
