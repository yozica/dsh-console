---
'dsh-console': patch
---

`plugin-manager.ts` 拆成 barrel + 四个叶子模块（1322 行 → 318 行的 barrel/类 + 四个叶子，导出面一个不差）

| 文件                | 行数 | 职责                                                                                |
| ------------------- | ---- | ----------------------------------------------------------------------------------- |
| `plugin-manager.ts` | 318  | **barrel + 三个类**（`PluginRunner` / `LiveClient` / `PluginManager`）              |
| `plugin-shared.ts`  | 28   | 共用的常量（profile 名 / 各种超时 / 输出上限）                                      |
| `plugin-parse.ts`   | 685  | profile manifest、`--dump-config` 解析、层归因、巡检、spec 与失败归纳（纯函数为主） |
| `plugin-runner.ts`  | 245  | 装 / 卸 / 升级的子进程与输出归纳                                                    |
| `plugin-live.ts`    | 149  | 运行中清单的客户端、信封与应答解包                                                  |

**判据不变**：导出面机械比对 **23 个 key 零差异**；`npm test` **314/314 且输出与改动前逐行一致**；
沙箱门禁通过（32/32、185/185）；`lint` / `format:check` / `typecheck` 全绿。
读 `plugin-manager.ts` 文本的断言的读法改成"整份"（`test/repo.ts` 的 `pluginSource` 与
`test/checks/env-doctor.ts` 里那一条），否则装插件的 PATH 那两条会假红。

两个操作教训也记进了 AGENTS §7.35：① 机械扫导出时**正则要允许前导注释** —— `packageNameOf` 写成
`/** … */ export function packageNameOf(` 同一行，脚本漏了它，表现是别处 `Cannot find name`；
② 自动接线要**限制轮数**（每轮起一次 `tsc`，十几轮就撞执行器的 10 分钟上限）。
