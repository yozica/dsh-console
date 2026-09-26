---
'dsh-console': patch
---

首启门禁放行页的按钮行少了 16px 间距（`.gate-actions` 被搬进子组件的 scoped 块，父组件够不着）

真机翻看发现的：放行页那排「进入 DSH Console / 再看看环境自检」贴着上面的完成清单。t62 把
`.gate-actions { margin-top: 16px }` 写进了 `shell/GateActions.vue` 的 `<style scoped>`，而
`shell/EnvGate.vue` 的**放行页**与**回看卡**也在用同一个 class —— `<style scoped>` 只作用于本组件
的模板（加上"被当子组件用时那个根元素"），所以那两处收到的是死规则。

- `.gate-actions` 回到 `styles.css` 全局表；`GateActions.vue` 不再有 `<style scoped>`，
  `styleLayers` 那一行改成 `staysGlobal`。
- **新增一条机械自检**：「样式分层：自成一条规则的私有类不会被别的组件用到（scoped 够不着别的
  模板）」—— 扫全部 `.vue` 的模板 class 与 scoped 块。注入回这个 bug 验过：新旧两条检查同时变红。
- 两个读样式块的助手改成**行首锚定**（组件注释里会引用那个标签的字面量，不锚定会从注释处开始吞）。

实测：`.verify/gate-actions-scope/measure.py` 把 Vue 的 scoped 编译结果照抄成 `[data-v-*]`，
清单下缘与按钮行上缘的间距 **0px → 16px**，清单一动没动。`npm test` 315/315、机械等价 577 → 577、
沙箱门禁 32/32 + 185/185、`lint` / `format:check` / `typecheck` / `build` 全绿。
