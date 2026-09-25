---
'dsh-console': patch
---

自检拆模块第二步：渲染层静态检查与主题/样式两组各自成文件（`selftest.ts` 6172 → 5200 行）

接着上一步往下搬，仍然只搬不改，判据仍是**自检输出逐行一致**（314 条同名、同值、同顺序）。

- `test/repo.ts` 从 35 行长到 151 行：那些被反复读到的源码文本集中到一处 —— `html` / `vueFiles` /
  `vueSource` / `libSource` / `rendererJs` / `markup` / `rendererAll` / `rendererCode` / `mountJs` /
  `css` / `vueStyles` / `allCss` / `uiPaneSource`，外加两个处理文本的小工具 `escaped(text)` 与
  `cssBlock(selector)`，还有 `PackageJson` 形状。原来它们散在 §6/§7 里，后面几千行的断言又在用。
- `test/checks/renderer.ts`（281 行）：第 6 组渲染层静态检查（17 条）。
- `test/checks/styles.ts`（703 行）：第 7 组主题、样式与视觉契约（29 条，含启动锁的盖满/层级与
  `:focus-visible` 那几条）。
- `test/selftest.ts` 只剩入口 + 其余各组（仍算 5200 行，后面几步继续搬）。

**这一步踩到的唯一一个坑**：`test/checks/` 比 `test/` 深一层，搬过去的代码里任何
`path.join(__dirname, '..', …)` 都会指到 `test/` 底下（`Cannot find module … test/src/preload/preload.ts`）。
所以搬到子目录的代码一律改用 `repo` 提供的路径（`repo.root` / `repo.srcDir` / `repo.rendererDir`），
不再自己拼 `__dirname`。

验收：`npm test` **314/314** 且输出与改动前逐行一致；`node scripts/selftest-sandbox.mjs` 通过
（反例脚本 32/32、185/185 照旧）；`lint` / `format:check` / `typecheck` 全绿。
