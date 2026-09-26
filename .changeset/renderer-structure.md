---
'dsh-console': patch
---

渲染层目录整理：一处一目录（`pages/<一处>/` + `gate/` + `layout/` + `components/`），并把自检与目录结构解耦

原来 `layout/` 里外壳的 6 件与门禁的 10 件平铺在一起、`panes/` 里 8 个页面与 5 个页面私有的子件平铺
在一起，看目录看不出"哪几个文件是一处的"。现在：

| 目录            | 装什么                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pages/<一处>/` | 一个页面 / 一个特性一个目录，页面本体与它自己的子件同目录（dashboard / terminal / ui / usage / archive / plugin / env / settings） |
| `gate/`         | 首启门禁那一层（覆盖层）：EnvGate + 9 个子件 + 常驻横幅 GateBanner                                                                 |
| `layout/`       | 应用外壳：RailNav / TopBar / StatusBar / CloseDialog                                                                               |
| `components/`   | 通用组件：**被两处以上真的 import** 的才放这里（今天一个都没有，规则写在它的 README 里）                                           |
| `lib/`          | 纯逻辑（不动）                                                                                                                     |

判据、为什么单文件目录也建、以及"`panes/` 改名 `pages/` 只动源码目录、不动 DOM 的 `.pane` 与
`id="pane-*"`"都写在 AGENTS §7.37。

**顺带把自检与目录结构解耦**（比搬文件本身重要）：`test/repo.ts` 原来把目录名写死
（`vueDirs = ['panes','shell']`）、`test/checks/*` 里散着约 20 处
`path.join(rendererDir, 'panes', 'X.vue')` —— 等于"每搬一次目录都要改自检"。现在 `repo.vueFiles`
**递归扫** `.vue`、`repo.vuePath('EnvGate.vue')` 按**文件名**取路径（重名或拼错当场抛错并列出候选），
「每个 .vue 都被用到」改成**解析 import**（按每个文件的目录规范化相对说明符），另有两条"看挂载清单
里的 import"的断言不再被注释骗到。

验收：`npm test` **315/315**，且输出与改动前**逐行只差 2 行**（一条断言标题里的"panes 清单"→
"页面清单"、一条提示里的路径）；机械等价 577 → 577；`build` / `lint` / `format:check` / `typecheck` /
沙箱门禁全绿。
