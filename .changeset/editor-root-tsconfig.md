---
'dsh-console': patch
---

补根 `tsconfig.json`：编辑器里 `window.dshConsole` 不再报 TS2551

真机（Zed）编辑 `pages/usage/UsagePane.vue` 时报「属性"dshConsole"在类型"Window & typeof globalThis"
上不存在」——仓库里那三份配置叫 `tsconfig.{base,main,node,renderer}.json`，**没有一份叫
`tsconfig.json`**，而编辑器按"最近的 `tsconfig.json`"选项目：找不到就退化成"推断项目"，
只按当前文件与其 import 建图 —— `env.d.ts` 里的 `declare global` 于是看不见。

新增根配置（`extends: ./tsconfig.renderer.json` + `include: src/renderer, src/shared`）。**它只服务
编辑器**：所有命令都显式 `-p`，`npm run typecheck` / `vue-tsc -p tsconfig.renderer.json` / 打包
都不受影响；实测加与不加，`dist/renderer` 的产物**逐字节一致**（同一份 hash）。

验收：`npm test` **316/316**（新增一条钉子盯住这个根配置）、lint / format:check / typecheck /
build / 沙箱门禁全绿。
