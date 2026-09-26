# Changelog

本文件是本项目**每一个发布版本的内容记录**，也是 GitHub Release 正文的**单一事实来源**：
打 `v*` 标签时，CI 会用 `tools/changelog-extract.mts` 取出对应版本的条目，直接当作 Release 正文
（末尾再附一段固定的下载指引）。所以**发版前必须先有内容** —— 没有条目时 CI 会直接失败，
宁可不发，也不要发出一个空说明的 Release。

**这个文件不手写。** 每条改动写成一个 `.changeset/*.md` 片段（`npx changeset add`），
发版前跑 `npm run release:prepare`：它算出新版本号、把片段正文**原样**汇总成下面的新条目、
改掉 `package.json` 的版本、删掉已汇总的片段。细节见 README 的「发布新版本」与 `.changeset/README.md`。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
每节的标题必须是 `## [x.y.z] - YYYY-MM-DD`（方括号与日期都要有，提取脚本按这个找）。
标题行末尾可以跟一句主题 —— `## [0.3.0] - 2026-09-17: TypeScript 迁移与工具链整理`，
它会成为 GitHub Release 的**标题**；用 `npm run release:prepare -- --topic "一句话主题"` 写进去。
（分隔符 `: ` 与 `—— ` 都认，早期条目就是这么写的。）

条目写**用户能看到的变化**（新增 / 改进 / 修复）；纯内部改动（CI、重构、测试）不必单独详述，
但**每一版都必须有条目** —— 全是内部改动的版本就用一句「内部：…」带过即可，
因为 Release 正文就是这一节，空章节会让发版直接失败。

## [Unreleased]

## [0.6.5] - 2026-09-26: 拆分与整理：源码模块化、一批界面小修

黄条的竖直居中改成统一规则：之前按"单行 / 两行"分两个变体（`.banner.line` 挂在 `line: !!navLine` 上），可是**同一条黄条在宽窗口是一行、窄窗口才是两行** —— 行数由宽度决定，JS 判不出来。于是插件页「已改到装配层，重启 dsh 后生效」那条（宽窗口下一行）永远拿不到覆写，一直偏上：真机截图量出来上方留白 20px、下方 34px（用户第二次抓图指出）。

现在 `.banner` 统一 `align-items: center`，图标也不再自己往下挪（`.banner.line` 与那个类一起删掉）。两行那态不会因此变差：**两行时最高的那一项本来就是文本块**，居中与顶对齐对它的位置没有影响，受影响的只有图标与按钮 —— 它们居中才是常态。用 headless Chrome 加载构建出的真 CSS 量过：改之前偏上 3.0 CSS px，改之后单行 +0.0、两行 +0.0。

插件页「临时停用」之后回得去了：原来「恢复」只长在救援条里，而救援条只在 dsh 起不来时出现 —— 在层栈详情里点「临时停用」的人，dsh 明明好好的，界面上就再也找不到放回去的地方（用户真机：停用 `@yozica/dsh-plugin-paths` 之后无法启用）。现在

- 巡检多一档「掉出了层列表」：**包自己声明过 `dsh.bundle`、却不在 `dsh.profile.bundles` 里**（旧界面把它错报成"装成了普通依赖，但它没有声明 dsh.bundle"），这行给「放回层里」；真·普通依赖照旧只给「卸掉它」；
- 停用后那条黄条上直接给「放回 `<包名>`」；
- 位置不需要界面记着（关掉页面 / 重开应用之后仍然插回**原来的位置**）：`index` 缺失时从这份 profile 目录里最近的 `package.json.bak-*` 里找回来，找不到就追加到末尾并说明是末尾

新建 `composables/` 层：把两个内嵌页的宿主逻辑与"切到本页时做事"收成 composable

这一层一直空着（这个仓库是从手写 DOM 的 `app.js` 逐页迁到 Vue 的，胶水当时是逐页搬进组件的）。
先按"**两处一字不差**或骨架相同、差异能用 2~3 个回调表达"这条判据数了一遍重复，**只有一处站得住**：

| 新增                    | 收的是什么                                                                                                                   | 谁在用                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `use-tab-activation.ts` | 「切到本页时才做事」：`watch(currentTab)` + id 过滤 + `immediate`                                                            | 插件页 / 终端页 / dsh 终端 / 两个内嵌页（5 处，原来每处手写一遍 `if (tab !== 'x') return`） |
| `use-webview.ts`        | 内嵌页宿主：`view` / `note` / 载入记账 / 四个事件 / `-3` 过滤 / `load()` 里"`loadURL` 吞 promise、失败退到 `src`" / 重算视口 | `pages/ui/UiPane.vue`、`pages/usage/UsagePane.vue`                                          |

**另外两处我上次的判断被代码否掉了，如实记下**：① 锚点滚动**不是** 4 处同构（只有 2 处，而且
一个用原生 `scrollIntoView`、一个用 `utils/scroll.ts` 的缓动），不抽；② 终端那处只有
`resolvedTheme()` 与主题 watch 两小块重复，而"一路终端"与"一个 Map 管多路"结构不同，
硬抽会变成一堆回调 —— 比重复更难读，也不抽。

验收：`npm test` **315/315**，输出与改动前**逐行完全一致**（零差异）；`lint` / `format:check` /
`typecheck` / `build` / 沙箱门禁全绿。**需要真机看一眼**：两个内嵌页（Harness / 用量页）的
载入、失败提示与切页回来重算视口，以及终端页的两路。

开发态可以「假装」出更新相位了：设置页「关于」卡里多了一排只在开发模式出现的按钮（假装有新版本 / 假装已下载 / 假装正在下载 / 还原真实相位），用来验证底栏与应用内全屏时顶栏那一格「发现新版本」的提示 —— 打包版里看不到这排按钮，真实更新状态也不受影响

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

`env-doctor.ts` 拆成 barrel + 六个叶子模块（2907 行 → 605 行的 barrel/类 + 六个叶子，导出面一个不差）

主进程那个 2907 行的"运行环境自检"按主题拆开，调用方与两个反例脚本一行没改：

| 文件                 | 行数 | 职责                                                                |
| -------------------- | ---- | ------------------------------------------------------------------- |
| `env-doctor.ts`      | 605  | **barrel + 两个有状态的类**（`EnvDoctor` / `EnvFixRunner`）         |
| `env-probe-types.ts` | 148  | 探测的形状与超时（`EnvProbeRaw` / `VersionProbe` / `EnvRuntime` …） |
| `env-node-range.ts`  | 354  | Node 版本区间的纯函数（解析 / 比较 / `judgeNodeVersion`）           |
| `env-fix-plan.ts`    | 464  | 修复计划 / argv / 注册表查找路径 / 人话文案                         |
| `env-judge.ts`       | 560  | 纯判定 `judgeEnvironment` 与 `probeTroubleLines`                    |
| `env-probe.ts`       | 670  | 只读探测与二进制定位（含本机 dsh 安装树）                           |
| `env-wizard.ts`      | 306  | 门禁判定（三步表 / `collectBootProbe` / `judgeWizard`）             |

**两个有状态的类刻意留在 barrel 里**：`EnvDoctor` 的实例字段跨"探测 → 判定 → 修复 → 复检"几个阶段，
拆散只是把"一个类里的顺序"换成"几个类之间的时序"。

**判据不变**：导出面机械比对 **55 个 key 零差异**；`npm test` **314/314 且输出与改动前逐行一致**；
沙箱门禁通过（32/32、185/185）；`lint` / `format:check` / `typecheck` 全绿。

**跟着搬的三处**（见 AGENTS §7.35 的第二段）：`test/env-fixtures.ts` 的 `envSource` 改成
"barrel + 六个叶子的拼接"；`scripts/env-doctor-cases.mjs` 那条读 `env-doctor.ts` 的超时顺序断言仍成立
（`EnvFixRunner.execute` 留在原文件）；一条按"全仓库唯一 owner"找 `['i','-g', …]` 的断言，owner 从
`env-doctor.ts` 变成 `env-fix-plan.ts`。

首启门禁的模板级拆分：`EnvGate.vue` 2515 → 2153 行，确认区与输出面板各成组件

| 新文件                     | 行数 | 装什么                                                                 |
| -------------------------- | ---- | ---------------------------------------------------------------------- |
| `gate/GateNodeConfirm.vue` | 357  | Node 安装 / 更新那条路的确认区（"将要执行" + 未签名 / 未校验两档确认） |
| `gate/GateOutput.vue`      | 57   | 流式输出面板（原文照贴 + 跟着新片段滚 + 收起）                         |
| `utils/status-message.ts`  | 9    | 状态栏那句话的唯一出口（`say`）                                        |
| `utils/clipboard.ts`       | 17   | 复制到剪贴板 + 那句话（父子共用一个实现）                              |

两个子组件都是**哑的**：计划、方法、档位、忙位仍由 `EnvGate.vue` 持有（同一批选择在那张卡片的
**选择区**里也画着，只能有一个真源），子组件只负责"计划 → 人话"与"按钮 → 事件"。搬过去的模板
**逐字复制**（props 按原来的标识符命名），只改三处：`v-if` 交给父级、`currentStep.id !== 'node'`
→ `host !== 'node'`、`copy()` 换成 `lib/clipboard` 那一份。

**样式跟着搬**（scoped 不跨组件，但子组件的根元素带父级的 `data-v`）：与父组件 / 自检页共用的
12 条收进全局表（`.gate-confirm-title` / `.gate-detail*` / `.gate-fact-more` / `.gate-option-risk` /
`.gate-choice` / `.gate-confirm .btn-row` …），只有确认区自己用的 `.gate-confirm-loading` 进子组件的
`<style scoped>`，并在自检的 `styleLayers` 表里为它加一行。

验收（§7.33 的三道 + 老四样）：

- **机械等价**：`styles.css` + 全部 `.vue` 的 `<style>` 并成"选择器 → 声明"的多重集，改动前后
  **577 → 577，零丢失零多出**。
- **逐像素**：同一段夹具标记（把这次动到的 class 全画一遍）用改动前后的样式各渲染一次 2x 截图，
  **完全一致**。
- `npm test` 314/314；其中 **4 行是"计数"口径变化**（组件数 15 → 17、`.vue` 覆盖数 15 → 17、
  全局表花括号 176 → 187、`styleLayers` 14 个页面 76 条 → 15 个页面 77 条），断言名与结论一条没变。
- 沙箱门禁通过（32/32、185/185）、`lint` / `format:check` / `typecheck` / `build` 全绿。

⚠️ 请真机 `npm start` 复核一次门禁层：第一步点「安装」展开的确认区（含"展开看完整地址"、
两条路都没预选时那组控件、未签名 / 未校验两档的按钮排布）与安装中的「详细输出」面板。

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

首启门禁再拆两块：操作行与一键修复确认区（`EnvGate.vue` 1989 → 1916 行）

| 新文件                    | 行数 | 装什么                                                                               |
| ------------------------- | ---- | ------------------------------------------------------------------------------------ |
| `gate/GateActions.vue`    | 126  | 操作行：一屏唯一一处强调色实底 + 一条次操作（三步各一套）+ pnpm 那句"跳过之后会怎样" |
| `gate/GateFixConfirm.vue` | 77   | 一键修复（pnpm / dsh）的确认区：命令原文 + 目标目录 + 两个按钮                       |

**焦点也要跟着搬**：这两块里原来各有一个 `ref`（`primaryRef` / `startRef`）被父级的 `focusDefault()`
与 `watch(fixConfirmAction)` 直接 `.focus()`。搬走之后父级够不到子组件的元素，做法与
`GateNodeConfirm` 那次一致：子组件 `defineExpose({ focusStart })`，父级持模板 ref 调它；
**"哪个按钮是这一屏的落点"留在父级**（它知道有没有确认区打开、是不是在看回看卡）。

模板逐字搬（`stepId` 取代 3 处 `currentStep.id`、`plan` 取代 `fixConfirmPlan`）；`.gate-actions`
进 `GateActions` 的 scoped 块（`.gate-confirm*` 那批早已在全局表，这次没有规则进全局表）。

验收：机械等价 **577 → 577 零丢失零多出**、逐像素**完全一致**（`.verify/gate3-split/`）、
`npm test` 314/314（**3** 行计数口径变化：`.vue` 覆盖与组件数 22 → 24、`styleLayers` 20 个页面 91 条 →
21 个页面 92 条）、沙箱门禁 32/32 + 185/185、`lint` / `format:check` / `typecheck` / `build` 全绿。

⚠️ 请真机 `npm start` 复核首启门禁：三步的操作行（第一步两条路都没选时「安装」禁用 + 那句 title、
第二步的「先跳过这一步」与其下方说明、第三步只有「安装」）、以及点「安装」展开的一键修复确认区
（命令原文 / 目标目录 / 开始·取消，以及**打开后焦点是否落在「开始」**）。

首启门禁放行页的按钮行少了 16px 间距（`.gate-actions` 被搬进子组件的 scoped 块，父组件够不着）

真机翻看发现的：放行页那排「进入 DSH Console / 再看看环境自检」贴着上面的完成清单。t62 把
`.gate-actions { margin-top: 16px }` 写进了 `gate/GateActions.vue` 的 `<style scoped>`，而
`gate/EnvGate.vue` 的**放行页**与**回看卡**也在用同一个 class —— `<style scoped>` 只作用于本组件
的模板（加上"被当子组件用时那个根元素"），所以那两处收到的是死规则。

- `.gate-actions` 回到 `styles.css` 全局表；`GateActions.vue` 不再有 `<style scoped>`，
  `styleLayers` 那一行改成 `staysGlobal`。
- **新增一条机械自检**：「样式分层：自成一条规则的私有类不会被别的组件用到（scoped 够不着别的
  模板）」—— 扫全部 `.vue` 的模板 class 与 scoped 块。注入回这个 bug 验过：新旧两条检查同时变红。
- 两个读样式块的助手改成**行首锚定**（组件注释里会引用那个标签的字面量，不锚定会从注释处开始吞）。

实测：`.verify/gate-actions-scope/measure.py` 把 Vue 的 scoped 编译结果照抄成 `[data-v-*]`，
清单下缘与按钮行上缘的间距 **0px → 16px**，清单一动没动。`npm test` 315/315、机械等价 577 → 577、
沙箱门禁 32/32 + 185/185、`lint` / `format:check` / `typecheck` / `build` 全绿。

首启门禁再拆两块：选择区与结果行（`EnvGate.vue` 2153 → 1989 行）

| 新文件                    | 行数 | 装什么                                                                      |
| ------------------------- | ---- | --------------------------------------------------------------------------- |
| `gate/GateNodeChoice.vue` | 123  | 选择区：版本档位 + 安装方法两组单选（含"两条路都没预选""正在安装"两句提示） |
| `gate/GateResult.vue`     | 184  | 结果行：状态点 + 结论句 + 说明 + 那排出路（三种结局各一套按钮）             |

两块都是**哑的**：方法与档位仍由父级持有（确认区 `GateNodeConfirm.vue` 读的是同一份状态），
点色 / 结论 / 说明也是父级算的（父级的进行中与输出区读同一份：`outputState` / `outputSummary`）。
**模板逐字搬**：`GateResult` 的 props 特意按原来的标识符命名（`resultDot` / `resultTitle` /
`resultNote`），模板里只把 `currentStep.id` 换成 `currentStepId`（3 处）；`GateNodeChoice` 只在根元素
去掉 `v-if`（交给调用方）。

样式：`.gate-result*` 11 条进 `GateResult`、`.gate-method-fact` 1 条进 `GateNodeChoice` —— 这次**没有任何
规则进全局表**（两块用的都是自己私有的规则 + 全局零件），所以自检里"全局表花括号"那一行数字不变。

验收：机械等价 **577 → 577 零丢失零多出**、逐像素**完全一致**（`.verify/gate2-split/`，夹具画了两组
单选 / 方法事实行 / 并存风险 / 两句提示 + 三种结局的结果行）、`npm test` 314/314（**3** 行计数口径变化：
`.vue` 覆盖与组件数 20 → 22、`styleLayers` 18 个页面 86 条 → 20 个页面 91 条）、沙箱门禁 32/32 + 185/185、
`lint` / `format:check` / `typecheck` / `build` 全绿。

⚠️ 请真机 `npm start` 复核首启门禁：第一步的档位 / 方法单选（选完再点「安装」）、以及安装结束后
那三种结局的结果行与它们各自的出路按钮。

首启门禁的最后两个小件：展开看详情与"先跳过 pnpm"的二次确认（`EnvGate.vue` 1781 → 1768 行）

| 新文件                     | 行数 | 装什么                                        |
| -------------------------- | ---- | --------------------------------------------- |
| `gate/GateDetails.vue`     | 54   | 「展开看详情」：把这一屏那几项检查的原文摊开  |
| `gate/GateSkipConfirm.vue` | 26   | 「先跳过 pnpm 这一步」的二次确认（交互 §5.4） |

两块用的都是**全局零件**（`.gate-fact-more` / `.gate-detail*` / `.wizard-decide`），所以这一步
**一条样式都没搬** —— 自检里"全局表花括号"与 `styleLayers` 那两行数字不动，也因此没做像素夹具
（没有可比的样式改动）。模板逐字搬：`currentStep.id` → `stepId`（3 处）、`currentChecks` → `checks`、
两处根元素的 `v-if` 交给调用方。

**顺带把这一阶段的账结了**：17 个 PR（#47 ~ #70）把 10 个大文件拆成 60 多个模块的汇总写进
`docs/backlog.md` 第 2 条与 AGENTS §7.36（含"哪些有意不拆"与"还欠一次真机翻看"）。

验收：机械等价 **577 → 577 零丢失零多出**、`npm test` 314/314（**2** 行计数口径变化：`.vue` 覆盖与
组件数 26 → 28，样式那两行数字不变）、沙箱门禁 32/32 + 185/185、`lint` / `format:check` / `typecheck` /
`build` 全绿。

⚠️ 请真机 `npm start` 复核首启门禁：某一步的「展开看详情 / 收起详情」（内容与 Tab 顺序），
以及第二步点「先跳过这一步」弹出的那条二次确认（确定跳过 / 取消）。

首启门禁拆出事实行 / 进行中进度（`EnvGate.vue` 1989 → 1781 行，新增 `gate/GateFacts.vue` 181 行）

这一块是"三块共用一个槽位"（视觉 §5.5）：不在跑时摆事实行，在跑时摆状态行 + 进度 + 一个明确的按钮，
底下还挂着第二步特有的那条 —— npm 都不能用时不给一个注定失败的「安装」，而是给 `corepack enable pnpm`。

它**一个判据都不持有**：事实行、进度文案、百分比、「停止」的文案与可见性都由父级算好递下来
（那些判据父级的结果行与输出面板也在用：`outputState` / `outputSummary`）。

样式分两处落：事实行与进度区那 16 条进子组件的 scoped 块；`.gate-card-why`（父级的步骤卡也画）
与 `.gate-detail-cmd`（父级的"展开看详情"也画）这 2 条收进全局表。

验收：机械等价 **577 → 577 零丢失零多出**、逐像素**完全一致**（`.verify/gate4-split/`，夹具画了五种
状态的事实行 + 进度区 + `corepack` 那条交代）、`npm test` 314/314（**4** 行计数口径变化：`.vue` 覆盖
与组件数 24 → 25、全局表花括号 202 → 204、`styleLayers` 21 个页面 92 条 → 22 个页面 96 条）、
沙箱门禁 32/32 + 185/185、`lint` / `format:check` / `typecheck` / `build` 全绿。

⚠️ 请真机 `npm start` 复核首启门禁：事实行五种状态的灯与文案、安装进行中的进度行（百分比 / 字节 /
那句管理员权限交代 / 「取消下载」与「显示详细输出」）、以及 npm 不可用时第二步那条 `corepack` 交代。

渲染层的外壳目录改名：`shell/` → `layout/`（跟终端页的「本地 Shell」不再撞名）

仓库里 "shell" 有两个意思：**窗口外壳**（目录名）与**本地 shell 进程**（终端页那一路 zsh / pwsh，
在 `pages/terminal/`、逻辑在 `pages/terminal/xterm.ts`）。看目录树时容易混，所以按通用的叫法把外壳这一层
改名成 `layout/`：

| 旧                                   | 新                                    |
| ------------------------------------ | ------------------------------------- |
| `src/renderer/shell/RailNav.vue`     | `src/renderer/layout/RailNav.vue`     |
| `src/renderer/shell/TopBar.vue`      | `src/renderer/layout/TopBar.vue`      |
| `src/renderer/shell/StatusBar.vue`   | `src/renderer/layout/StatusBar.vue`   |
| `src/renderer/shell/CloseDialog.vue` | `src/renderer/layout/CloseDialog.vue` |

纯改名：只动 `mount.ts` 的 import、注释与文档里的路径指针；模板与样式一行没动
（机械等价 577 → 577 零丢失零多出）。判据记在 AGENTS §7.37。

验收：`npm test` **315/315**，输出与改动前**逐行只差 1 行**（一条提示里的路径
`shell/RailNav.vue` → `layout/RailNav.vue`）；`build` / `lint` / `format:check` / `typecheck` /
沙箱门禁（32/32 + 185/185）全绿。

`main.ts` 拆出三个自成一体的簇（1798 → 1554 行）

`main.ts` 是 Electron 入口，模块级可变单例多，所以先把**不依赖别的簇**的三块搬出去，每个只拿一个
小的 context（可变单例用 getter，稳定的才传函数）：

| 文件               | 行数 | 装什么                                                                                                    |
| ------------------ | ---- | --------------------------------------------------------------------------------------------------------- |
| `main-theme.ts`    | 109  | 主题、窗口底色、标题栏浮层、`broadcastTheme`（context：`isMac` / `getWindow()` / `send()` / `getMode()`） |
| `main-embedded.ts` | 183  | 内嵌页诊断（guest console / 加载失败 / 请求失败）与开发期产物变化自动重载                                 |
| `main-menu.ts`     | 71   | 应用图标与菜单（Windows/Linux 留空、macOS 最小原生菜单）                                                  |

**一次真实的机械替换事故（已修，记进 AGENTS §7.35）**：把 `mainWindow` 批量换成 `ctx.getWindow()`
时，`if (!mainWindow || mainWindow.isDestroyed()) return;` 被改成了
`if (!ctx.getWindow().isDestroyed()) return;` —— **判空和取反一起丢了**。`npm test` 抓不到这个
（main.ts 不在自检的运行时图里），只有搬完逐字读一遍才发现。教训：搬 `if (x && !x.y)` 这类判断
别信 sed，写完必须读。

验收：`npm test` **314/314**（仅上一轮改名的两行不同）、沙箱门禁通过（32/32、185/185）、
`lint` / `format:check` / `typecheck` / `build:main` 全绿。**Electron 在沙箱里起不来**，所以这一步
还需要你真机 `npm start` 翻一眼（窗口底色 / 标题栏配色 / 内嵌页诊断日志 / 菜单）。

`main.ts` 再拆两块：崩溃兜底与外链（1507 → 1507 行的等价搬迁 + 两条钉子改成读整份）

| 文件            | 行数 | 装什么                                                       | context     |
| --------------- | ---- | ------------------------------------------------------------ | ----------- |
| `main-crash.ts` | 38   | 未捕获异常 / 未处理拒绝的兜底（落盘 + 弹带日志路径的框）     | `logFile()` |
| `main-url.ts`   | 52   | 外链的唯一入口（scheme 白名单 + 接住 `openExternal` 的失败） | `log()`     |

`main.ts` 现在 1507 行（上一轮 1554）。

**两条钉子跟着换成读整份**：`test/repo.ts` 多了 `mainSource`（`main.ts` + `main-*.ts`），
release 那组"启动早期 / 关窗 / 外链"的断言改读它。顺手把"外链"那条从"数 `openExternalSafely(`
出现 4 次"改成"**裸的 `shell.openExternal(` 全组只剩 1 处、3 处调用都走 helper**" —— 前者会因为
类型注解里也出现函数名而假红，后者才是它真正想钉的不变量。

验收：`npm test` **314/314**（仅上一轮改名的两行不同）、沙箱门禁通过（32/32、185/185）、
`lint` / `format:check` / `typecheck` / `build:main` 全绿。

⚠️ 这一步与前两轮一样改了主进程启动路径，而 **Electron 在沙箱里起不来** —— 请真机 `npm start`
确认一次（重点：能正常启动、菜单/主题正常、关窗行为不变）。

`main.ts` 的 IPC 注册层拆成六个模块（1507 → 865 行；`registerIpc()` 那 558 行不再挤在一个函数里）

| 文件                  | 行数 | 装什么                                                                         |
| --------------------- | ---- | ------------------------------------------------------------------------------ |
| `main-ipc.ts`         | 25   | **barrel**：`registerIpc(ctx)` 按原顺序调四个叶子，另转发三个公共件            |
| `main-ipc-shared.ts`  | 134  | `IpcContext` / `CloseAsk` + `bundledVersions` / `messageOf` / 忙位等小编排函数 |
| `main-ipc-app.ts`     | 302  | `app:*` / `theme:set` / `settings:patch` / `dsh:*` / `session:*` / `shell:*`   |
| `main-ipc-archive.ts` | 70   | `archive:*`                                                                    |
| `main-ipc-plugin.ts`  | 152  | `plugin:*`                                                                     |
| `main-ipc-env.ts`     | 153  | `env:check` / `env:fix*` / `env:wizard*` / `env:node-*`                        |

`main.ts` 只剩"造一个 `IpcContext`、调一次 `registerIpc(ctx)`"。

**搬动的 557 行逐字复制**，只改四类**可变量**与三个 helper 的签名：`mainWindow` → `ctx.getWindow()`、
`pendingCloseAsk` → `ctx.pendingCloseAsk()`（取一次存下来，getter 之间 TS 不再收窄）、
`rendererConnected` → `ctx.renderer.{isConnected,markConnected}`、`shellCounter` → `ctx.shells.next()`；
`anyoneBusy` / `refusedInstallState` / `wizardSkips` 现在显式吃参数。稳定的引用（`Settings`、各 manager、
那个 `Set`）按值传。

**读源码文本的钉子跟着读整份**：`test/repo.ts` 的 `mainSource` 与 `test/env-fixtures.ts` 的
`envMainCode` 都加上了 `main-ipc*.ts`；三条断言的签名跟着改（`anyoneBusy(ctx)` /
`refusedInstallState(ctx, …)` / `wizardSkips(settings)`），其中两条一开始假红是因为 Prettier 把长调用
折成了多行 —— "参数紧跟在左括号后"的写法要留 `\s*`。

验收：`npm test` **314/314，输出与拆分前逐行相同**（这次零差异）、沙箱门禁通过（32/32、185/185）、
`lint` / `format:check` / `typecheck` / `build:main` 全绿。

⚠️ 这一步动了主进程的启动路径（`bootstrap()` 里造 `IpcContext` 那一处），而 **Electron 在沙箱里起不来** ——
请真机 `npm start` 复核一次：能正常启动、菜单/主题正常、关窗行为不变、跑一次环境自检 + 首启门禁的
两个入口（`env:*` 那组通道现在住在 `main-ipc-env.ts`）。

`node-installer.ts` 拆成 barrel + 八个叶子模块（4169 行 → 2509 行的 barrel/类 + 八个叶子，导出面一个不差）

主进程最大的那个文件（系统级 Node 安装与更新）按主题拆开，调用方与两个反例脚本一行没改：

| 文件                | 行数 | 职责                                                 |
| ------------------- | ---- | ---------------------------------------------------- |
| `node-installer.ts` | 2509 | **barrel + `NodeInstallHooks` + `NodeInstaller` 类** |
| `node-shared.ts`    | 58   | 共用的常量（超时 / 下载地址 / 输出上限 / 常驻文案）  |
| `node-release.ts`   | 230  | 版本清单、校验清单、发布资产（纯函数）               |
| `node-owner.ts`     | 180  | 归属判定 + 注册表 PATH 合并                          |
| `node-failure.ts`   | 194  | 失败分类与人话文案                                   |
| `node-flavor.ts`    | 36   | 安装包形态识别与静默参数                             |
| `node-nvm.ts`       | 412  | nvm 输出解析、模型推导、注册表偏好                   |
| `node-plan.ts`      | 334  | "装还是更新、走哪条路"纯判定 + 提权结果分类          |
| `node-io.ts`        | 455  | IO 底层：探测 / 注册表 / 网络 / 临时目录             |

**类刻意不拆**，而且有一条硬约束：`buildPlan` 与 `transferPhase` 必须留在同一个文件里 ——
`scripts/env-wizard-cases.mjs` 的 F 段按这对锚点切源码。

**判据不变**：导出面机械比对 **39 个 key 零差异**；`npm test` **314/314 且输出与改动前逐行一致**；
沙箱门禁通过（32/32、**185/185**）；`lint` / `format:check` / `typecheck` 全绿。

**跟着搬的两处**：`test/env-fixtures.ts` 的 `installerCode` 与 `scripts/env-wizard-cases.mjs` 的
`installerSource` 都从"只读 `node-installer.ts`"改成"barrel + 八个叶子的拼接"——后者不改会让 M8 那条
（`INJECTED_ENV_NAMES` 白名单）变成 184/185。经验与那条"按文本块删东西先留原文"的教训记在 AGENTS §7.35。

插件页那条「重启之后」的结局提示单行时竖直居中：`.banner` 原来的 `align-items: flex-start` 与图标 `margin-top` 是为「标题 + 说明」两行准备的，单行套上去文字会明显偏上（用户真机截图指出）

插件页拆出生效配置视图（`PluginPane.vue` 1462 → 1152 行，新增 `pages/plugin/PluginConfigView.vue` 423 行）

拆出去的是：组合出来的条目按层分组 + 搜索 / 两个过滤开关 + 基线那句"这是 dsh 自带的组合结果" +
"运行中但配置里没有"的那几行 + 会话插件行数，以及每个条目行内的三个动作（禁用 / 启用 / 移除我的插入）。

**它不持有状态**：搜索词、两个开关、分组、运行中索引、基线与忙位都由父级拿着 —— 同一份数据父级的
层栈视图与操作输出也在读（`activeData` / `opBusy`），拆开就会变成两个真源。父级只多了一条
`@update:query="query = $event"` 与两个开关的翻转；模板只有四处小改（`v-model` → `:value` + `@input`、
两个 `x = !x` → 事件、根元素的 `v-else` 交给调用方）。

**样式整块搬**：那 26 条（`.plugin-config*` / `.plugin-search*` / `.plugin-filter*` / `.plugin-group*` /
`.plugin-raw*` / `.plugin-scope` / `.plugin-presets` / `.plugin-entry-actions` / `.plugin-state*` /
`.plugin-baseline-note*`）与父级没有共用，全部跟着组件走 —— 这次没有一条进全局表。

验收：机械等价 **577 → 577 零丢失零多出**、逐像素**完全一致**（`.verify/plugin2-split/`）、
`npm test` 314/314（**3** 行计数口径变化：`.vue` 覆盖与组件数 25 → 26、`styleLayers` 22 个页面 96 条 →
23 个页面 99 条）、沙箱门禁 32/32 + 185/185、`lint` / `format:check` / `typecheck` / `build` 全绿。

⚠️ 请真机 `npm start` 复核插件页的生效配置视图：搜索框、两个过滤开关（含选中态的实心底）、
「只看某一层」那枚标签与「清除筛选」、条目行内的禁用 / 启用 / 移除我的插入、运行状态那枚小标、
以及"没能解析成结构"时的原始 dump 分支。

插件页层栈视图末尾那句「还有 N 条…」的左内边距（真机翻看发现，比上面所有内容左移 16px）

它用的是全局零件 `.hint`（本身没有左右内边距），而同一块里的小标题是
`.plugin-entries .block-head { padding: 0 16px }`、条目行是 `.plugin-entry { padding: 6px 16px }`
—— 于是那行注释贴到了卡片的左边缘。补一条 `.plugin-entries .hint { padding: 0 16px }`。

实测（headless Chrome，2 倍缩放）：条目文字左缘 32~~33 设备像素，这句**原来在 0~~1、现在 33**。
机械等价因此从 577 变成 **578（+1，就是这一条修复）**；`npm test` 315/315、lint / format:check /
typecheck / build 全绿。

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

插件页拆出两个子组件：层栈视图与操作输出面板（`PluginPane.vue` 1916 → 1462 行）

| 新文件                             | 行数 | 装什么                                                                          |
| ---------------------------------- | ---- | ------------------------------------------------------------------------------- |
| `pages/plugin/PluginStackView.vue` | 367  | 层栈视图：左边层列表 + 右边选中那一层的详情与三个动作（升级 / 临时停用 / 移除） |
| `pages/plugin/PluginOpPanel.vue`   | 163  | 操作输出面板：pnpm 与补丁层操作的原文照贴 + 中断 / 收起 / 插进我的层            |

两个子组件都是**哑的**：选中哪一层、操作忙不忙、数据是哪一份仍由 `PluginPane.vue` 持有（同一份选择
在"生效配置"视图与增删改操作里也要用），子组件只把点击报回来。模板**逐字复制**（props 按原来的标识符
命名），只改三处：根元素的 `v-if` 交给父级、`selectedIndex = i` → `select(i)`、面板内的
`opOpen = false` / `editLayer('insert', …)` 换成事件。

**样式按 §7.33 的判据分三处落**：只有这一块在用的 23 条进 `PluginStackView`、10 条进 `PluginOpPanel`；
父子两边都在用的 10 条（`.plugin-tag*` 与 `.plugin-entry*`）收进全局表；剩下 53 条留在父级。
自检的 `styleLayers` 表跟着改成三行。

验收：机械等价 **577 → 577 零丢失零多出**、逐像素**完全一致**（`.verify/plugin-split/`，夹具把这次动到的
class 全画了一遍）、`npm test` 314/314（4 行计数口径变化：`.vue` 覆盖 17 → 19、组件数 17 → 19、
全局表花括号 187 → 197、`styleLayers` 15 个页面 77 条 → 17 个页面 86 条）、沙箱门禁 32/32 + 185/185、
`lint` / `format:check` / `typecheck` / `build` 全绿。

⚠️ 请真机 `npm start` 复核插件页：层栈（点某一层换详情 / "在生效配置里看这 N 条"跳转 / 树外插件的
升级·临时停用·移除）、以及装 / 卸 / 升级时的输出面板（中断 / 收起 / 内置包被拦下时的「插进我的层」）。

「插件」页的纯展示判据进 `pages/plugin/plugin-view.ts`（`PluginPane.vue` 2052 → 1915 行）

`pages/plugin/PluginPane.vue` 里那些**一条 DOM 都不碰**却和 `ref` / `computed` 混在一起的规则搬进
`pages/plugin/plugin-view.ts`（205 行）：层名（`home` 换 `~`）、算不算"你自己的层"、`kind` 的中文、
"没贡献"的三种情况（未创建 / 没匹配上 / 空 `[]`）、`include:` 前缀、运行中条目的索引与差额、
运行状态词、巡检分档与"能不能删 / 卸 / 放回"、以及生效配置视图的分组过滤。
组件里只剩一层薄包装（把 `data` / `problems` 这些响应式来源喂进去）与三个"点一下就走"的动作。

**只动 `<script setup>`**：`git diff` 里以 `<` 开头的增删行 **0 个**，所以免像素对比。
验收：`vue-tsc` 0、`eslint` 0、`npm test` 314/314 且**输出逐行一致**、沙箱门禁（32/32、185/185）、
`npm run build:renderer` 成功。

**一条钉子跟着换了口径**：「救援：「放回层里」不依赖救援条」钉的是判据本身（`canRestore` 的名字、
那一档的说法、"两种不形成层都能卸"），判据跨出 `.vue` 之后它从 `vueSource` 改成 `repo.rendererAll`
（`app.ts` + `lib/*.ts` + 全部 `.vue`）。读文本的断言要跟着"判据搬到哪一层"换口径，记在 AGENTS §7.36。

`process-utils.ts` 拆成 barrel + 八个叶子模块（1347 行 → 9 个文件，导出面一个不差）

主进程那个 1347 行的"进程 / 网络工具"按主题拆开，调用方一行没改：

| 文件                  | 行数 | 职责                                                                                  |
| --------------------- | ---- | ------------------------------------------------------------------------------------- |
| `process-utils.ts`    | 68   | **barrel**：逐条再导出公开面（**不用 `export *`**，叶子模块里还有只给兄弟用的内部件） |
| `process-types.ts`    | 75   | 平台判断 / `COMSPEC` / 跨模块共用的形状                                               |
| `process-shell.ts`    | 267  | 命令查找、PATH 展开、转发器识别                                                       |
| `process-pnpm.ts`     | 260  | pnpm 定位 + VC++ 运行库（`pnpmVersionCache` 跟着 `pnpmVersionOf` 走）                 |
| `process-path-env.ts` | 85   | 给子进程补 PATH                                                                       |
| `process-dsh.ts`      | 256  | 解释器候选与 dsh 启动命令（`dshProbeCache` 跟着 `canRunDsh` 走）                      |
| `process-launch.ts`   | 159  | 启动 spec 的公共件                                                                    |
| `process-probe.ts`    | 165  | HTTP 健康探测 + 端口占用                                                              |
| `process-proc.ts`     | 172  | 进程名 / 结束进程树 / 存活判定 / `homeDir`                                            |

**判据是导出面机械比对**：`npm run build:main` 后比对
`Object.keys(require('./dist/main/process-utils.js')).sort()` —— 改前改后**零差异（43 个）**；
类型导出另核（漏一个 `export type {}` 会让别处 `tsc` 报 TS2724）。自检输出与改动前逐行一致
（314 条同名同值同顺序）—— 其中四条"读源码文本"的断言改成读 `test/repo.ts` 新增的
`processUtilsSource`（barrel + 八个叶子模块的拼接），因为 barrel 里只剩 re-export。

套路与四条做法（显式清单 / 导出面判据 / 缓存跟着读者走 / 读文本的断言改成读整份）记在 **AGENTS §7.35**。

验收：`npm test` 314/314 且输出逐行一致；沙箱门禁通过（32/32、185/185）；
`lint` / `format:check` / `typecheck` 全绿。

渲染层的 `lib/` 拆成 `utils/` / `state/` / `shared/` 三层，只有一处用的逻辑跟回那一处

原来那个 `lib/`（24 个模块）混着三种东西：通用工具、跨页共享状态、以及"其实只有一处用"的逻辑。
现在按可机械检查的判据分开：

| 目录      | 判据                                                          | 装什么                                                                                                            |
| --------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `utils/`  | 纯工具：与 dsh 领域无关、不持有状态、不 import 渲染层别的目录 | format / platform / markdown / scroll / clipboard / status-message / webview（类型）                              |
| `state/`  | 跨页共享状态与相位机：持有 `ref` / 订阅 IPC                   | store / boot-lock / env-doctor / env-wizard / env-layer / env-anchor / update-anchor / restart-nav / restart-flow |
| `shared/` | ≥2 处用的领域逻辑，不持有状态、也不是通用工具                 | gate-copy / env-install-phase / phase-text                                                                        |
| 跟回特性  | 只有一处用（哪怕它是纯逻辑）                                  | `gate/wizard-view.ts`、`pages/{dashboard/dsh-actions,env/env-detail,plugin/plugin-view,terminal/xterm}.ts`        |

**自检也跟着与目录结构解耦**：`test/repo.ts` 递归扫全部 `.vue` 与 `.ts`，新增 `tsPath()`
（与 t67 的 `vuePath()` 同款：重名或拼错当场抛错）；「渲染层脚本」的合集从「`app.ts` + `lib/*`」
改成「全部 `.ts`」。顺手把两处**写死 import 路径**的断言改成只看文件名 ——
`test/checks/styles.ts` 那条（`from '../lib/restart-nav.js'`）在搬完之后立刻红了，正是它的功劳。

验收：`npm test` **315/315**，且输出与改动前**逐行完全一致**（零差异）；机械等价 **577 → 577**
零丢失零多出（`test/repo.ts` 读样式的路径也跟着换了，夹具不受影响）；
`build` / `lint` / `format:check` / `typecheck` / 沙箱门禁（32/32 + 185/185）全绿。

渲染层拆模块第一步：门禁与详情层的共享纯逻辑进 `lib/`（顺带 dedupe 六处逐字重复）

`gate/EnvGate.vue` 2648 → 2515 行、`pages/env/EnvPane.vue` 1546 → 1501 行，新增：

- `shared/gate-copy.ts`（135 行）：门禁与「运行环境」详情层共用的**词表与现成句子** —— 官方下载页、
  忙提示、三步文案、五项状态词、方法事实、两条安装路、档位词、并存风险，以及 `versionWithChannel`。
- `shared/env-install-phase.ts`（34 行）：安装 / 修复的相位判据（`INSTALL_BUSY_PHASES` / `installRunning` /
  `installSettled` / `isFixSettled`）—— 两个组件原来各抄一份。
- `utils/format.ts` 多一个 `formatBytes`（两处各抄过一份）。

**这一步只搬零风险的纯逻辑**：`<template>` 与 `<style>` 一行没动（判据是 `git diff` 里以 `<` 开头的行
一个都没有），所以免像素对比；验收仍是 `vue-tsc` / `eslint` / `npm test` **输出逐行一致** / 沙箱门禁
（32/32、185/185）+ 渲染层构建成功。

三条铁律与后续计划（子组件、纯派生视图、样式跟着搬时要跑 §7.33 的三道验收）记在 **AGENTS §7.36**：
其中最重要的一条是「`lib/**` 不许有 DOM」——自检的编译图 `tsconfig.node.json` 没有 DOM 类型，
而且这条保证只覆盖被自检 import 的闭包。

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

主题配色只判一次：`resolvedTheme` 收进 `state/store.ts`（原来在终端两个组件里各写一遍）

xterm 的配色是 JS 选项（不走 CSS 变量），所以终端页那两路各自把"该用哪套配色"算了一遍：
`snapshot.value?.theme?.resolved === 'light' ? 'light' : 'dark'`。两处一字不差，但哪天
"跟随系统"的判定口径变了，只改一处就会出现两路终端一个亮一个暗。

现在 `state/store.ts` 导出 `resolvedTheme`（computed），两个终端读同一个来源。

验收：`npm test` **315/315** 且输出与改动前**逐行完全一致**；`lint` / `format:check` /
`typecheck` / `build` / 沙箱门禁全绿；机械等价不受影响（模板与样式没动）。

自检拆模块第五步：环境自检那几组成文件，夹具提成共享模块（`selftest.ts` 3640 → 2250 行）

- `test/checks/env-doctor.ts`（1348 行）：运行环境自检（判定 + 探测 + 一键修复）与 VM-09 那批。
- `test/env-fixtures.ts`（129 行）：**共享夹具** —— 一份"什么都好"的原始事实、各检查按需覆盖一两项，
  以及 `envSource` / `envCode` / `envMainCode` / `envPaneCode` 四份源码文本。这些原来定义在
  自检的第 16 组里，但后面的环境向导与安装引擎组隔着上千行还在引用，所以提成一份（谁要谁取，
  不再出现"检查 A 从检查 B 的文件里 import 一个夹具"）。
- `test/text.ts`（62 行）：从源码文本里切片段的小工具（`blockOf` 按大括号配平、`functionBodyOf`、
  `methodSliceOf` 按下一个类成员为界、`stripComments`、`stripStrings`）—— 环境自检、环境向导、
  安装引擎三组共用。

验收：`npm test` **314/314** 且输出与改动前逐行一致；沙箱门禁通过（32/32、185/185）；
`lint` / `format:check` / `typecheck` 全绿。

自检拆模块收尾：入口只剩 55 行（`selftest.ts` 2250 → 55，全程 6591 → 55）

`test/selftest.ts` 原来是一个 6591 行的文件、314 条断言全挤在一个 `main()` 里。六批纯搬迁之后它
只剩入口：`createRepo()` → 依次 `run*` → `report()`。**每批的判据都是自检输出逐行一致**
（314 行 `PASS 名字 — 实际值` 同名、同值、同顺序，只归一化「健康探测（真实）」那行的 `Nms`）。

- `test/checks/env-wizard.ts`（1371 行）：首启环境向导、门禁界面、18a 的视图相位。
- `test/checks/install-engine.ts`（874 行）：18b~18d —— 提权、nvm 的真实模型、归属与档位。
- `test/env-fixtures.ts` 多收两份文本（`installerCode` / `gateRaw` / `gateCode`）—— 门禁界面那组
  也要读 node-installer，不能各读一份。

六批合计：`selftest.ts` 6591 → 55、新增 `harness` 80 / `repo` 174 / `text` 62 / `env-fixtures` 143，
`test/checks/` 八个主题模块共 6579 行。布局、怎么加一条断言、以及踩过的三个子目录搬迁坑
（`__dirname` 会变、相对 import 多退一层、跨段派生值先提成模块）记在 **AGENTS §7.34**。

验收：`npm test` **314/314** 且输出与拆分前逐行一致；沙箱门禁通过（反例脚本 32/32、185/185）；
`lint` / `format:check` / `typecheck` 全绿。

自检开始拆模块：`test/selftest.ts` 的公共件与第 1~5 组先出去（6591 → 6172 行）

`test/selftest.ts` 原本是一个 6591 行的文件、314 条断言全挤在一个 `main()` 里（最多的几条一次要看
六千行）。这一步只做搬迁，判据是**自检输出逐行一致**（314 条同名、同值、同顺序；只有「健康探测（真实）」
那行的 `Nms` 计时会抖，比对时归一化掉）。

- `test/harness.ts`：断言登记（`check` / `skip`）、统计与 GitHub Actions 失败注解（`report`）、
  「这台机器能不能起子进程」的两个探测，以及 `IS_WINDOWS`。各主题模块共用这一份，别各打一份汇总。
- `test/repo.ts`：自检共用的仓库事实 —— 仓库根、`.verify/` 临时目录，以及那个跨几千行还在用的
  `Settings` 实例（原来 `main()` 开头建好、§17d 还在用）。
- `test/checks/launch.ts`：第 1~5 组（启动命令解析 / ANSI 与横幅 / 健康探测判据 / 端口占用解析 /
  DshManager 状态机）整段搬过来，47 条断言，行为一字未改。
- `test/selftest.ts` 只剩入口：建 `repo` → `await runLaunch(repo)` → …（其余各组仍在原地）→ `report()`。

验收：`npm test` **314/314** 且输出与改动前逐行一致；`node scripts/selftest-sandbox.mjs` 通过
（两个反例脚本 32/32、185/185 照旧）；`lint` / `format:check` / `typecheck` 全绿。

自检拆模块第四步：插件装配层 / 补丁层 / 救援成文件（`selftest.ts` 4746 → 3640 行）

- `test/checks/plugin.ts`（1146 行）：插件装配层（只读）、你自己的补丁层、救援（P2）三块 ——
  这一层全靠"别人写的文件 + 别人打印的文本"，夹具是**真实输出**（本机 web profile），
  上游改格式时这里第一时间变红。
- `test/repo.ts` 补 `pluginSource` 与 `fixture(name)`（读 `test/fixtures/`），并明确暴露
  `testDir` —— 搬到 `test/checks/` 的代码不能再拿 `__dirname` 拼夹具路径（这次又踩了一次：
  `readProfileManifest` 收到了 `test/checks/fixtures/profile`）。这条与相对 import 多退一层
  是同一类问题的两个面。

验收：`npm test` **314/314** 且输出与改动前逐行一致；沙箱门禁通过（32/32、185/185）；
`lint` / `format:check` / `typecheck` 全绿。

自检拆模块第三步：发布链路与打包约定成文件（`selftest.ts` 5200 → 4746 行）

- `test/checks/release.ts`（476 行）：第 8~15 组 —— CHANGELOG 与版本号对齐、changeset 片段规则、
  Release 标题与正文、自动更新契约（不偷偷下载 / 不偷偷安装 / macOS 分支）、外链 helper、
  启动早期的日志与兜底、产物命名与更新源、自动全屏前提、macOS 版本检查、依赖归属与包体积、
  更新卡片的分平台文案。
- `test/repo.ts` 再加三份共享事实：`pkg`（package.json）、`ipcSource` / `flatIpc`（`shared/ipc.ts`
  原文与压平版）—— 环境自检与安装引擎那几组还要用同一份。
- 搬到子目录后相对路径要多退一层（`../tools/…` → `../../tools/…`，动态 `import(…)` 与
  `require(…)` 同样），这条与 `__dirname` 一样是子目录搬迁的固定成本。

验收：`npm test` **314/314** 且输出与改动前逐行一致；沙箱门禁通过（32/32、185/185）；
`lint` / `format:check` / `typecheck` 全绿。

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

`shared/ipc.ts`（跨进程契约）拆成 barrel + 八个主题模块（1143 → 22 行的 barrel + 八个叶子）

| 文件             | 行数 | 职责                                                 |
| ---------------- | ---- | ---------------------------------------------------- |
| `shared/ipc.ts`  | 22   | **barrel**：`export *` 八个模块（消费方一行没改）    |
| `ipc-shell.ts`   | 54   | 主题、关闭询问与确认框                               |
| `ipc-update.ts`  | 59   | 自动更新：相位、状态与更新源地址（两个纯常量在这里） |
| `ipc-runtime.ts` | 233  | dsh 运行时快照、事件、会话与设置                     |
| `ipc-archive.ts` | 88   | 归档会话页                                           |
| `ipc-plugin.ts`  | 235  | 插件装配层                                           |
| `ipc-env.ts`     | 175  | 运行环境自检与首启门禁                               |
| `ipc-node.ts`    | 204  | Node 安装 / 更新通道（含 t29 增量）                  |
| `ipc-api.ts`     | 200  | `DshConsoleApi`（preload 照它实现）                  |

**判据**：运行时导出面零差异（只有 `RELEASES_URL` / `UPDATE_MAC_FEED_URL` 两个常量）；
`npm test` **314/314**；沙箱门禁通过（32/32、185/185）；`lint` / `format:check` / `typecheck` /
渲染层构建全绿。

**两处刻意改了口径**（这是唯一两行输出变化，其余 312 行逐字不变）：

- **"契约零 import" → "零*运行时* import"**：叶子之间必须 `import type`，判据从 `/^\s*import\s/m`
  收紧成 `/^\s*import\s+(?!type\b)/m`，两处自检标题与 `scripts/env-doctor-cases.mjs` 的 P 检查一起改。
- **同文件里"再声明一次同名 interface"是隐式合并**：t29 给 `EnvDoctorReport` 加字段就是那么写的，
  拆到两个模块后它们是两个不同的 interface（`tsc` 立刻报缺字段）—— 已把字段并回同一份声明。
  这条与"读源码文本的断言要读整份"（`repo.ipcSource` / `plugin.ts` / `env-doctor-cases.mjs`）
  一起写进 AGENTS §7.35。

样式分层第二批：归档会话页的规则搬进 `pages/archive/ArchivePane.vue` 的 `<style scoped>`

- `.archive*` 一整节 415 行搬走（全局表 4329 → 3914 行），全局表里留一句指针说明搬到哪了。
- 两个坑写进 AGENTS §7.33：① `v-html` 渲染出来的正文（`renderMarkdown` 塞进 `.archive-turn-body` 的 `h1 / p / code / table …`）**必须写成 `:deep(...)`**，否则编译成 `.archive-turn-body h1[data-v-*]` 一条都匹配不上；② **多行选择器列表**逐行加 `:deep()` 会漏掉前几行 —— 这一版漏了 `h2..h5 / ul / th` 共 7 条，靠查构建产物里的选择器才抓到。自检因此多了一条钉子：`.archive-turn-body` 后面跟元素的行不许缺 `:deep()`。
- 验收：机械等价 577 条 → 577 条（不丢不重）；headless Chrome 三段夹具（设置页 + 聚焦蒙层 + 归档页，含 v-html 那部分排版）逐像素一致；`npm test` 314/314。

样式分层第三批：控制台的规则搬进 `pages/dashboard/DashboardPane.vue` 的 `<style scoped>`

- 37 个条目搬走（`.dash*` / `.focus-*` / `.stats` / `.meta-*` / `.event-log*` / `.chart` / `.spark*` / `.command`，含两条媒体查询），全局表 3914 → 3647 行（−267）；留在全局表的是卡片零件（`.panel` / `.panel-head` / `.panel-block` / `.hint`）与 `.block-head` / `.block-note`（插件页也在用）。
- 顺手把误放在「控制台」一节里的 `.settings-status` 收进 `pages/settings/SettingsPane.vue` —— 它只有设置页用。
- 两个新教训写进 AGENTS §7.33：① 查"共享件还在不在全局表"必须用**行首锚定**（`.log-panel .panel-head` 里含 `.panel-head`，用 contains 会误判成被搬走）；② 产物里的媒体查询会被压成 `@media (width<=900px)`，按 `max-width` grep 产物会以为规则丢了。
- 验收：机械等价 577 条 → 577 条；headless Chrome **五段**夹具（设置页 + 聚焦蒙层 + 归档页 + 控制台宽/窄两档，窄档覆盖两条媒体查询）逐像素一致；`npm test` 314/314。

样式分层第六批：首启环境向导与入口门禁搬进 `gate/EnvGate.vue` 的 `<style scoped>`

- 「首启环境向导与入口门禁」一节里 EnvGate 私有的 **98 个条目**搬走（`.gate*` 外壳与节点时间线、卡片、确认表等），全局表 **2649 → 1944 行（−705，比最初的 4502 少了 57%）**。
- 与环境自检详情层**共用**的 42 个条目（`.gate-option*` / `.gate-choice*` / `.gate-confirm*` / `.wizard-*` —— EnvPane 复用向导同一套选项 / 选择 / 确认 / 进度行）留在全局表；顺手把误放在这一节里的 `.wizard-readout` 收进 `EnvPane.vue`。
- 两条自检教训写进 AGENTS §7.33：① 查「私有规则有没有搬干净」**也要行首锚定** —— `.gate-rail` 在全局表里仍以 `html[…] body[…] .gate-rail` 的形式存在（macOS 全屏撤回留白），用 contains 会误判；② 表的 `readScoped()` 要先 `panes/` 再 `layout/` 找文件。
- 顺手把 `scripts/env-wizard-cases.mjs` 的 CSS 断言改成读**两层**（它只读 `styles.css`，`.gate-result .btn-row` / `.gate-metabar` 搬走之后那两条间距断言直接红、沙箱门禁 `exit=1`）；`ENV_WIZARD_CSS_FILE` 那个变异实验后门保持"只读指定文件"。
- 验收：机械等价 577 条 → 577 条；headless Chrome **八段**夹具（设置页 + 聚焦蒙层 + 归档页 + 控制台宽/窄 + 环境自检页 + 插件页 + **首启门禁**，含共享的选项 / 确认表 / 进度行）逐像素一致；`npm test` 314/314。

样式分层第四批：环境自检页的规则搬进 `pages/env/EnvPane.vue` 的 `<style scoped>`

- 「环境自检」与「更新入口与下载来源」两节里**只有 EnvPane 用**的 37 个条目搬走（`.env-row*` / `.env-scope` / `.env-confirm*` / `.env-source*` / `.env-skip` …），全局表 3647 → 3376 行（−271）。
- 留在全局表的是与别处共用的：`.env` 外层、`.env-actions`（设置页「运行环境」卡也画）、`.env-op*`（环境向导的执行输出面板与这一页同形）。**这一节 42 条里只有 28 条是私有的** —— 再次说明"能搬多少"要按规则逐条数，不能按段落整体判断。
- 自检新增一条改造：到处在用的 `cssBlock(selector)` 助手也改成读**两层**样式表（`allCss`）—— 只看全局表时 `.env-main` / `.env-seg` 那两条断言直接假红。
- 验收：机械等价 577 条 → 577 条；headless Chrome **六段**夹具（设置页 + 聚焦蒙层 + 归档页 + 控制台宽/窄 + 环境自检页）逐像素一致；`npm test` 314/314。

样式分层最后一批：终端页 / 内嵌界面 / 零散几条各自归位（全局表 1651 → 1497 行，−154）

- `pages/terminal/TerminalPane.vue` 12 条（`.term-body` / `.term-view*` / `.shell-tab*` / `.shell-pane*` / `.chips` / `.btn.outline`）、`pages/terminal/DshTerminal.vue` 1 条（`.bar-title`）、`pages/ui/UiPane.vue` 4 条（`.ui-paste*`）、`layout/TopBar.vue` 2 条（`.immersive-only` / `.topbar-note.lit`）、`gate/GateBanner.vue` 1 条、`pages/env/EnvPane.vue` 2 条（`.env` / `.env > .bar`）。
- **`.term-host` 的"基础规则"（relative + flex: 1 1 auto）仍留在全局表** —— 两路终端共用它（§7.30）；只作用于本地 Shell 那一路的 `.term-body > .term-host` 跟着 `TerminalPane` 走。
- 三处直接读 `stylesCode` 的自检改成读两层：`.btn.outline` / `.shell-tab.active`、`.term-body` 与 `.term-host` 的四条、`.topbar-note.lit` 与三条"已经删掉的那套"；"每行至少有个非空 `<style scoped>`"的粗门槛从 `> 200` 字符降到 `> 0`。
- 顺手修掉 12 处段落标记与 `}` 粘行（几轮搬运脚本攒下的），并加了一条钉子：段落标记必须自成一行。
- 验收：机械等价 577 条 → 577 条；headless Chrome **十三段**夹具逐像素一致；`npm test` 314/314。

样式分层第五批：插件页（装配层）整节搬进 `pages/plugin/PluginPane.vue` 的 `<style scoped>`

- 「插件页（装配层）」一整节 **96 个条目**搬走（`.plugin*` / `.layer*` / `.plugin-op*` …），全局表 **3376 → 2649 行（−727，比最初的 4502 少了 41%）**。这一页没有 `v-html`，不需要 `:deep()`。
- 留在全局表的是跨页面共用的零件（`.btn` / `.panel*` / `.banner` / `.hint` / `.empty` / `.spacer` / `.block-head`）。
- 判归属时踩了个假阳性，写进 AGENTS §7.33 与 backlog：按「文件里出现过这个词」判会把 `RailNav.vue` 里的 `{ id: 'plugin' }` 字符串、别处注释里的 `.plugin-tag` 算成使用者 —— **要按标记里的 class 核**（`grep 'class="[^"]*\b类名\b'`）。
- 验收：机械等价 577 条 → 577 条；headless Chrome **七段**夹具（设置页 + 聚焦蒙层 + 归档页 + 控制台宽/窄 + 环境自检页 + 插件页）逐像素一致；`npm test` 314/314。

样式分层试点（backlog #1）：设置页自己的规则从 `styles.css` 搬进 `pages/settings/SettingsPane.vue` 的 `<style scoped>`

- 搬走这一页私有的规则（`.settings` / `.form-row` / `.input-suffix` / `.update-*` 与「聚焦蒙层」的 `.spotlight`），全局表 4502 → 4329 行（−173）；跨组件的共享件（`.check`、`.panel-block > .hint`）留在全局表 —— 判据只有一条：**这个 class 是不是只有这一页在用**。
- 三道验收都跑了：① 机械等价（「全局表 + 组件块」按 `选择器 → 声明` 抽成多重集，和改动前的快照比：577 条 → 577 条，不丢不重）；② headless Chrome 用改动前后的样式各渲染同一段夹具，**逐像素一致**（设置页 + 聚焦蒙层两段）；③ 自检改成跨两层看（「标记用到的 class 都有对应样式」与「除变量块外没有硬编码颜色」都查两层），并新增「样式分层：页面私有的规则搬进组件的 `<style scoped>`，共享件留在全局表」。
- 这一层的坑（scoped 会给选择器 +1 个属性选择器，覆盖关系从"谁在后"变成"谁更具体"）记在 AGENTS §7.33。

样式分层第七批：外壳四件（左栏 / 顶栏 / 底栏 / 关闭确认卡片）搬进各自的 `<style scoped>`

- 「骨架」里三个外壳组件自己的 29 个条目 + 「指示灯」里按状态着色的 5 条 + 「关闭确认卡片」整节 7 条搬走，全局表 **1944 → 1651 行（−293，比最初的 4502 少了 63%）**。
- **跨组件的布局契约留在全局表**：`.app` / `.workspace` / `.pane`（两列网格、页面用 `visibility` 互斥、挂载点 `display: contents`）与 `html`/`body` 上的状态开关（macOS 红绿灯留白、系统全屏撤回、应用内全屏）—— 判据要先排除 `html` / `body` / `:root` 开头的规则。
- 自检里"私有规则有没有搬干净"的判据收紧为**选择器自成一条规则**（后面只能跟 `,` 或 `{`）：`.close-card .check`（`.check` 是共享件）与 `.topbar-note.lit`（顶栏那格"亮一下"的变体）都以私有选择器开头，只写行首锚定会误判成"没搬干净"。
- 验收：机械等价 577 条 → 577 条；headless Chrome **十段**夹具（设置页 + 聚焦蒙层 + 归档页 + 控制台宽/窄 + 环境自检页 + 插件页 + 首启门禁 + **应用外壳** + **关闭确认卡片**）逐像素一致；`npm test` 314/314。

应用内全屏时顶栏那句「发现新版本 …」的摆法：挪到地址（`地址，PID …`）的左边 —— 原来夹在地址与「退出全屏」之间，读起来像地址的尾巴

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

## [0.6.4] - 2026-09-24: 重启后自动进 Harness，装插件挑对 pnpm

测试夹具里不再带真实的家目录路径

`test/fixtures/broken-patch.stderr.txt` 与 `unmatched-patch.stderr.txt` 是抓下来的真实 dsh 报错，
里面带着当时那台机器的绝对路径（用户名、nvm 版本目录、`.build-home` 结构）。现在统一换成中性的
`/Users/someone/...`：报错形状（堆栈、`YAMLException`、`cordis.patch.yml`、条目 id）一字未改，
自检的断言照旧。

内嵌页里点非 http(s) 链接（例如 DSH 自己的文件引用 `dsh-resource://…`）不再弹「DSH Console 出错了（未处理的 Promise 拒绝）」：外链统一走一个 helper，只把 http/https/mailto 交给系统程序，并接住 `shell.openExternal` 的失败（写进日志）

装插件时用「和这份 profile 对得上」的那份 pnpm，不再被 PATH 里另一档 pnpm 卡住

机器上装了两份不同大版本的 pnpm 时（例如 pnpm 官方脚本装的 10.x 与 nvm 里 corepack shim 的 9.x），
装插件会在 pnpm 那里直接失败，只留下一段看不懂的话：

> node_modules … currently linked from the store at …/store/v10 … pnpm now wants to use …/store/v3 …

现在：装/卸/升级之前先读 profile 的 `node_modules/.modules.yaml`（`packageManager`），挑一份**大版本
一致**的 pnpm 顶到子进程 PATH 最前；一个都对不上时先提示说清，失败时也把那段原文翻成人话 + 出路。

插件装完之后点「立即重启 dsh」，会等重启完成并自动进入 DeepSeek Harness

以前点完只有状态栏一句「正在重启 dsh…」：窗口不切、不上锁、没有结束语，用户会觉得"点了没生效"。
现在四个入口（插件页「立即重启 dsh」、控制台「重启」、环境自检「重新启动 dsh」、
Harness 页「重启为受管实例」）共用同一条流程：

- 点下去先上**启动锁**（第三回合，单向上锁状态机不变）：标题「正在重新启动 dsh」，
  下面写「已等待 N 秒 · 就绪后自动打开 DeepSeek Harness」—— 不抢全屏；
- 就绪的判据是 **dsh 跑起来且已拿到带令牌地址**（只看"跑起来了"会切到"还没捕获到令牌"那一屏）；
- 就绪后**自动切到 DeepSeek Harness 页**，状态栏说一句「插件已生效，已打开 DeepSeek Harness」，
  顶栏右侧那格**轻轻亮一下**「✓ 装配层改动已加载」（平时那里写着地址与 PID，4 秒后自己换回；
  没有按钮、没有新表面、不遮内嵌界面的内容，应用内全屏时也看得见）；
- 插件页那条黄条变成这一轮的进度与结局：进行中 / 重启失败 / dsh 还没起来 / 已生效 —— 都是实话；
- 用户在锁上按「不等了」或 `Esc` 会**取消这次跳转**（只解除等待，不抢页面）。

## [0.6.3] - 2026-09-21: 左栏精简：终端合并、环境自检进设置

左栏从九项减到七项：终端合并成一个页面、环境自检挪进设置

- **「dsh 终端」与「本地 Shell」合并成一个「终端」页**：一条会话条，第一项固定是 `dsh 终端`
  （只读输出），后面是各本地 Shell，`＋ 新建本地 Shell` 在最右；「关闭当前」只在本地 Shell 那一路上
  出现。以前这两件事各有左栏一项，等于同一件事给两个入口。顶栏标题也从 `dsh 终端` 变成 `终端`。
  会话条上的「＋ 新建本地 Shell」改成**镂空**（原来是实心强调按钮）：实心只留给「当前在看的那一路」，
  否则那颗按钮比选中的标签还抢眼，看不出正在看哪个会话。
- **「环境自检」不再是左栏一项**：设置页多了一张「运行环境」卡，平时只显示一行结论
  （N 项正常 · N 项不正常 · N 项需要注意 + 要求的那句 Node 区间，与详情视图顶部那句一字不差），
  点「查看详情」打开完整的详情视图
  —— 原来的灯 / 结论 / 依据 / 一键修复 / 重新打开环境向导 / 安装下载来源 / 重新检测一个不少，
  左上角多一个「← 返回」。控制台横幅、插件页的「一键装 pnpm」、门禁层的两条出路都改成打开这个详情视图。
- macOS 系统全屏时，**向导 / 门禁页的左轨也跟着撤回红绿灯留白**（原来只有左栏撤回了，
  向导页的左栏因此比平时低 36px，看着像上面空了一块）。
- 两路终端之间改用 `visibility` 互斥时只给"不在看的那一路"写 `hidden`：
  `visibility` 会继承，「在看的那一路」若显式写 `visible` 会连 `.pane` 的隐藏一起穿掉
  （切到别的 tab，本地 Shell 的终端还画在那一页上）。
- 快捷键跟着变成 **`Ctrl/⌘+1~7`**（状态栏提示、设置页里那句、终端里放行快捷键的判据一起改）。

## [0.6.2] - 2026-09-21: 环境向导：能回上一步、重开不再自己收起、进入后显示启动锁

### 能回上一步了；重开时不再自己收起

向导原来只画「判定给出的当前步骤」：每完成一步就被推到下一步，想回头看上一步没有任何入口
（左轨那三个节点在规格里写的是纯读数）。现在：

- **左轨走过的节点变成可点的按钮**（已完成 / 已跳过都可以，按阅读顺序进 `Tab` 顺序，
  `Enter` / `Space` 同鼠标）：点它就把正文切回那一步，看一张**只读回看卡** ——
  一句「这一步已经完成，不用再做什么」+ 当时的关键读数 + 一个「回到当前步骤」。
  卡里没有任何安装 / 跳过动作，回看时屏上仍然只有一件事可做；没走到的步骤照旧不可点。
- **判定前进不会把你推走**：你正看着上一步、判定往后走了，只在卡片上方出一行
  「下一步（…）也已经就绪了」，点了才过去；三步都完成时是「三步都完成了」+「看看结果」。
- **从环境自检页（或常驻横幅）点「重新打开环境向导」不再一闪就没了**：以前那一轮判定回来看是
  「已经就绪」就立刻自己收起（你只看到「检查中」闪一下）；现在判成已就绪也停在放行页，
  要你自己点「进入 DSH Console」或按 `Esc` 才收起。健康机器**第一次启动**依旧什么都不显示。

### 进入之后的自动启动也显示启动锁

第一次打开应用、环境没配好时会先走向导。放行页点「进入 DSH Console」之后应用会自己拉起 dsh，
但那一刻屏幕上什么都不说 —— 只有状态栏一句「启动中」。现在那一段也显示启动锁：写的就是启动时
那套（「正在启动 dsh 服务」/「已等待 N 秒 · 就绪后自动打开 DeepSeek Harness 并进入全屏」/
「不等了，先进入界面」），就绪或异常时自动解锁。

逃生口那条路**不上锁**：它的原话是「先进入界面（环境还没准备好，我稍后自己处理）」，用户已经
说了不等，再按住他等与他刚说的话相反（自动启动照旧）。

**没有等待就不上锁**：dsh 已经在跑、或这一轮只是接管了外部实例时，自动启动是空操作 ——
这时不显示锁（否则只是闪一下）。

## [0.6.1] - 2026-09-20: 环境自检不再卡住主进程；自检页排版修正

### 环境自检不再把主进程冻住

真机上「双击没反应、过一会被系统弹崩溃」的元凶就是自检自己：完整探测原来在主进程上串行跑 5 个
同步子进程（各 8 秒超时），而它第一个就去敲 `~/.vite-plus/bin/node` —— 那是个**转发器**，在 GUI
应用拿到的窄 PATH 下找不到系统 Node，于是开始下载自己的运行时（100+MB）；8 秒到点被杀、留下一个
临时文件，下一个探测再起一个…… 界面在这几十秒里完全没响应。

- 探测改成**异步并发**：超时就把整棵子进程树收掉、并释放管道，主进程不会再被任何慢东西拖住。
- **认得出转发器**：跟着符号链接看最终目标的名字还是不是 `node`（homebrew 那种指向真 node 的不算）。
  找 Node 时真 node 优先、转发器垫底，而且**不去执行**它 —— 探测是只读的，不该替你往磁盘上装东西。
- **超时不再被说成「起不来」**：那是「它还在忙」，现在归到「测不出来」（黄灯）说人话，不再冒充
  「退出码 0 + 零输出」那条签名，把你引去重装一个好好的 dsh。
- **「外部 Node」报的是真正会被用来跑 dsh 的那一份**，并注明「dsh 就用这一份跑」；机器上还有一份
  被跳过的转发器时也会说明（「它的版本随启动环境而变，所以别拿它跟终端里的 `node -v` 对账」）——
  这就是「自检显示 v24、终端里显示 v22」那个困惑的答案。

### 「Node 版本」改看这台机器上那份 dsh 的要求

自检原来拿 **vite 的 engines**（`^20.19.0 || >=22.12.0`）当判据 —— 那是**构建期**要求，跟
「dsh 能不能跑」无关，而且偏松：Node 20.19 与 22.12–22.18 会被判成「符合要求」，而 dsh 在那种
Node 上是**静默退出**（退出码 0、零输出），界面上只留一句「已停止」，用户完全看不出是解释器的
问题。

**分界线是 Node 22.18，不是 24**（逐个实测过）：dsh 入口最后一行是
`if (import.meta.main) await runCli();`，而 `import.meta.main` 在 22 线是 22.18.0 才进的（24 线是
24.2.0）—— 没有它的 Node 上 `runCli()` 根本不执行，事件循环空转结束，于是「退出码 0 + 零输出」，
端口也不开。22.18 及以上、24 及以上实测都正常（22.22 上 `dsh web` 是真的把服务起来了的）。

**判据不再只有我们抄来的一句常量**（不是所有人装的是同一份 dsh）：现在运行期离线读本机那份 dsh
的安装树，取依赖链里**要得最狠**的那条 `engines.node` 下限（本机 0.1.5-rc.1 / 524 个包：3 个包要
`>=22.19.0`），它和兜底那句**两句都要满足** —— 本机那句更严时会抬高门槛（将来 dsh 要 `>=26` 就按
26 判），更松时靠兜底那句 `^22.19.0` 的上界挡住奇数版 23。界面上点名来源（「v24.14.1 满足本机这份
dsh 的要求 `>=22.19.0`（来自依赖 `undici 8.10.2` 等 3 个包）」）；低于它时说清「这种 Node 上 dsh
会静默空跑」；读不到本机那份（走 `npx` 那条路）时退回原来那句常量，文案不变。

### 环境自检页的排版两处修正

**圆点与内容不再被拆成两行。** 窗口一窄，`外部 Node` / `dsh 本体` / `dsh 能不能跑` 那几行的圆点会
一个人留在上一行、内容整块掉到下面（窗口越窄掉得越多）。原因是内容块的 `flex-basis` 用的是
**内容自己的宽度**，说明一长就被换行算法挪走；改成基宽 0 之后它永远和圆点并排，宽度照旧自适应。
真机实测视口 1440 / 1220 / 900 / 760 / 640：改前分别有 1 / 3 / 4 / 5 / 7 行被挤下去，改后全是 0，
「更新 pnpm」按钮也始终留在第一行。

**说明里的长路径不再从中间切断。** `dsh 本体` / `dsh 能不能跑` 那两行是两条长路径拼起来的，折行
原来落在路径中间（`…/@deepseek-` + `ai/dsh/lib/bin.js`，第二行只剩一小截，看着像排版坏了）。现在
按路径分隔符切开、片段之间插 `<wbr>`，片段本身用 `white-space: nowrap` 包住 —— 只插 `<wbr>` 不够：
`@deepseek-ai` 里那个连字符本身就是一个断点，窗口一窄浏览器会优先断在它上面。四个宽度实测折行都
落在分隔符上、且不横向溢出；显示出来的文字与原文一字不差（`<wbr>` 与 `<span>` 都是元素，不引入字符）。

### 去掉启动后围着内容区的那圈焦点环

门禁层在启动瞬间显示过一次（「检查中」），收起时会把焦点程序化交给主内容区；Chrome 把这种交接
当成键盘驱动的焦点，于是命中全局的 `:focus-visible` 描边 —— 35% 的蓝、2px 线 + 2px 偏移，正好在
内容区的上 / 左 / 下三条边上各画一条淡蓝细带（右边贴着窗口边缘看不见）。在控制台页它就是顶栏正
下方横着的一条，看着像一个空盒子。

现在只给 `<main>` 加一条例外（`outline: none`）：容器是程序化交接焦点用的、Tab 到不了它，画一圈
框没有可达性收益；按钮 / 输入框 / 列表项的焦点环原样保留。

### 「启动不了」现在会留下能查的痕迹

以前主进程在启动早期出问题时，日志里**一行都没有** —— 分不清「进程根本没起来」和「起来了但没到
ready」（真机上就被这个判断拖住过）。现在：

- **ready 之前**先落一行启动记录（版本 / 平台 / Electron / 开发态还是打包版 / userData），
  「到没到 ready」一眼可辨；这一行同步落盘，`app.exit()` 不会把它丢在缓冲里。
- 主进程**未捕获的异常**与**未处理的 Promise 拒绝**会写进日志，并弹一个带**日志路径**的对话框 ——
  以前只有 Electron 那句英文提示，用户拿不到任何能发出来的东西。
- 日志流自己的 `error` 也有人接了：磁盘满 / 日志目录被删 / 外置卷弹出时，`WriteStream` 的 `error`
  没人接就是一次未捕获异常（实测：删掉日志目录，进程当场退出）。现在只把这一路关掉、往终端说一句，
  应用照常跑。
- **已经在跑一个实例时再启动**：记一行，然后立刻干净退出。以前走的是 `app.quit()`，而它在 ready
  之前不保证真的退 —— 会留下一个没窗口、没日志的进程，macOS 上最后表现成系统那句「应用没有响应」。

### 内部

- Windows 路径判据（`isCmdExe` / `isPeImage` / `isRunnablePath`）改用 `path.win32`：它们拼的是
  **Windows** 路径，却用了跟着「跑测试这台机器」走的 `path.basename` —— 在 macOS / Linux 上
  `basename('C:\Windows\system32\cmd.exe')` 返回整串，于是 `cmd.exe` 被判成「不是 cmd.exe」，
  `launchSpec` 走进 `.exe` 直连分支。Windows 上两种写法等价，**生产行为不变**，换来的是这类判据
  在任意平台都能被测到。
- CI 与打包：`ci.yml` 的 `check` 里也会跑 `scripts/*-cases.mjs` 反例脚本（按文件名自动收录，与
  本地沙箱门禁同一套约定）；四个 job 的 Node 从 22 升到 **24**（与应用自带的运行时同一个大版本）；
  动作升到声明 `runs.using: node24` 的那一档（`checkout@v7` / `setup-node@v7` /
  `upload-artifact@v7` / `download-artifact@v8`）。

## [0.6.0] - 2026-09-19: 运行环境自检与首启环境向导

### 运行环境自检

左栏新增第 8 页「环境自检」（`Ctrl+8` / `⌘8`）。打开应用后它会看一眼这台机器上到底有什么：外部 Node 找不找得到、
版本满不满足要求、npm / pnpm / dsh 能不能用、应用自带的 Electron 与 Node 是多少。每一项都是一行结论
（正常 / 需要注意 / 不可用），并写清判定依据与出路 —— 比如 dsh 在版本不兼容的 Node 上是「退出码 0、零输出」
地**静默退出**，现在这一行会直接点出来，而不是让界面停在一句「已停止」。

不满足的两项可以直接一键修：缺 pnpm → `npm i -g pnpm`，缺 dsh → `npm i -g @deepseek-ai/dsh`。
动手之前会先把命令原文与「会装进哪个目录」显示出来让你确认，跑的过程中输出实时可见、随时可以中断，
跑完自动复检那一行。插件页的「没找到 pnpm」旁边也有同一个按钮，不用自己开终端敲（同一条能力，不重复实现）。

底部状态栏的快捷键提示跟着变成 `1~9`；因为新页插在「插件」与「设置」之间，**设置页的快捷键从 `8` 变成 `9`**
（左栏顺序与 `Ctrl+数字` 一一对应）。终端里 `Ctrl+9` 也能换页了。

### 修复

Windows 上 Node 的安装目录里同时躺着 `npm`（POSIX sh 脚本）与 `npm.cmd`，此前自检会拿前者：它既不是能直接执行的
PE，也不是 cmd 能跑的批处理，于是「npm / pnpm」这两项被误报成不可用、一键安装也起不来。现在只认带可执行扩展名的那个
（按 `PATHEXT` 找），启动统一经 `cmd.exe`、按 cmd 的引号规则拼成一整条命令行；Node 自己那套引号规则会把
`"C:\…\npm.cmd"` 再转义一次、让 cmd 报「不是内部或外部命令」，两个坑一起收口在同一个包装器里（探测与执行共用它）。

### 首次启动：环境向导与入口门禁

在一台**什么都没装的 Windows 11** 上打开应用，会先看一眼这台机器缺什么，缺什么就一步一步带你装好 ——
在这之前主界面进不去。这是有意的硬门禁：缺 Node 的时候进去也只能看着 dsh 起不来。

**第一步：装 Node.js** —— 先看这台电脑上那份 Node 是**谁管的**，再决定用哪种方式装它（不再让你自己挑一条）：

- **是版本管理器（nvm）管的** → 就用它来装 / 更新（`nvm install` 装好再切过去），**不会**再往系统默认位置放第二份 Node；
- **是官方安装包装的** → 用官方安装包装回它自己的位置（会问一次管理员权限）；
- **认不出来（含别的版本管理器）** → 我们**不替你猜**：更新这条路不做自动更新；安装这条路把两种方式都列出来、**一条都不预选**，由你显式选，并先说清两份 Node 并存的后果（之后哪一份生效只看系统查找路径里谁在前）。

要装哪一档也由你定：**最新稳定版**（默认）或**最新当前版**；**「更新」跟着现在这份的档位走**
（当前版就更新到更新的当前版、稳定版就更新到更新的稳定版）。**换成另一档是一个要你显式选的动作**，
不是「更新」的副作用 —— 目标版本比现在低时，界面会直说「这会把现在这份 Node 换成稳定版，版本从 vX 降到 vY。」，
不会拿「更新」两个字盖过去。

装之前都会把**具体版本号、下载来源、装到哪、要不要管理员权限、会不会覆盖现有的 Node** 摆给你看，
点确认才开始。下载过程有进度、随时可取消（取消不碰系统）；安装包会核对官方校验清单里的 SHA-256，
并对不上就不安装。`index.json` 里从来不列 arm64 的 msi，所以「这个版本有没有适合这台机器的安装包」
以**同版本的 `SHASUMS256.txt`** 为准。**版本管理器已经装好的机器上，更新不会再重装一遍版本管理器** ——
这次只让它多一个版本并切过去，没有多的下载。

**第二步装 pnpm、第三步装 dsh**，都是既有的「一键装」（`npm i -g …`）。pnpm 这一步可以跳过。

三步都过了（或按你的选择跳过了）会出现「进入 DSH Console」。**逃生口一直都在**：屏幕底部随时可以
点「先进入界面（环境还没准备好，我稍后自己处理）」，进去之后控制台页与环境自检页都有回到向导的入口 ——
门禁是硬要求，但不是把人关在外面。**探测自己失灵时（比如受限环境不允许起子进程）不会挡人**：
那种情况照常放行，只在界面顶部说明「这一轮没测全」。

### 进界面之后：更新 Node 与 pnpm

环境自检页的 Node / pnpm 行上多了更新入口：pnpm 走既有的 `npm i -g pnpm`；Node 走上面同一条安装通道
（会先停掉正在运行的 dsh，装完再问你要不要重新启动它）。**更新的目标档位跟着现在这份 Node 的档位走**
（当前版就更新到更新的当前版、稳定版就更新到更新的稳定版），已经是最新时按钮变成读数。
**换成另一档是一个要你显式选的动作**：目标版本比现在低时，界面会明说这是换档、并写出「版本从 vX 降到 vY」，
不会拿「更新」两个字盖过去。
如果认不出这台机器上的 Node 是怎么装的，就**不替你做自动更新**，只给官方下载页 —— 不猜。

### 修好了：装完 pnpm 当场就能用，不需要重开应用

真机上撞到过一种情况：点了「一键安装 pnpm」，命令退出码 0、文件也确实落到了盘上，**pnpm 却跑不起来** ——
界面（正确地）把它判成「不可用」，用户看到的是「装完了还是红的」。这一版按「装完当场就要能用」重做：

- 安装时**放行 pnpm 自己的安装步骤**；这个放行**只在这一次命令里生效**，不改你电脑上的 npm 全局配置（也不写 `.npmrc`）；
- 装完**真的跑一次** `pnpm --version` —— **有输出才算装成功**，不是「文件在盘上」就算；
- 装完在**同一次运行里**重新读一遍系统里的查找路径、重扫已知位置，并把你 npm 的全局目录排在**最前**，再自动复检；
- 万一还是没成，日志文件里留着**这一次实际执行的完整命令、退出码、stdout 与 stderr**（哪一路是空的也照写），
  界面会直接告诉你日志在哪；只有「刷新过仍然找不到」才会建议你重开应用再检测一次。

### 修好了：版本管理器那一步不再让你自己去终端里选版本

走「用版本管理器装 Node」那条路时，如果这台电脑上的版本管理器**已经装好了、但还没有可用的 Node 版本**
（它的 `node` 只是个占位，跑起来什么都不打印），以前界面会把这句话原样转给你、让你自己去终端里
`nvm install` / `nvm use`。现在**安装这一步由应用自己做完**：挑一个稳定版 → 装进版本管理器 → 切到它 →
再实测 `node --version` 与 `npm --version` 都有输出，才算这一步完成。

另外，新版 nvm-windows（v2）换了工作方式（版本管理器用「shim 模式」把当前版本放在自己的 `.nodejs` 目录、
各个版本放在 `installs` 目录，并且**不再设置** `NVM_HOME` / `NVM_SYMLINK`）。这一版改成**按真实证据**判断
版本管理器在哪、版本装在哪，老版本（v1 风格）的机器也不再被排斥。

### 两条与"证据"有关的边界

- **发布元数据说未签名 ≠ 我们读不到签名**：nvm 那条路会先看发布说明里的自述（最新稳定版 v2.0.0 就是
  `Unsigned` 构建），自述未签名才多问一句；官方安装包则**下载后**才读数字签名，读到明确未签名/无效
  就不安装，读不到就继续装并如实说「这次没能读到安装包签名」。
- **环境自检的判定口径收紧**（与上面的门禁判据对齐）：只有「真的跑不起来」（有路径但跑出来零输出）
  才算「不可用」；「这个运行环境不允许起子进程」这种**测不出来**仍然只给「需要注意」，不挡人。
  面向用户的说明里不再出现 `EPERM` 这类内部记号 —— 细节留在日志里。

### 内部

新增 `main/node-installer.ts`（系统级安装与更新执行）、`renderer/lib/env-wizard.ts` 与
`renderer/lib/boot-lock.ts`（门禁编排与启动锁可见性）、`renderer/shell/EnvGate.vue` 与 `GateBanner.vue`
（门禁层与常驻横幅）；契约新增门禁与安装通道两组类型（`envWizard` / `envWizardSkip` / `envNodePlan` /
`envNodeInstall` / `envNodeStop` 等 7 个成员）。设置项新增 `envSkips`（跳过的步骤）与 `envNodeSource`
（安装包下载源，留空走官方）。

一键装 pnpm 的计划多了**一个一次性开关**（argv 里的一个元素，不写全局配置），收尾改成「刷新查找路径 →
复检 → 功能实测（`<pnpm> -v` 有输出才通过）」，失败时把那次实际执行的命令与两路输出落进日志 ——
形状与三条口径见 `docs/env-doctor.md` §3.4。

### 修好了：用版本管理器装的 Node，更新时不会再装出第二份

真机上撞到过：这台电脑上的 Node 是**版本管理器（nvm）管的**，点「更新 Node.js」却下载了官方安装包装到
`C:\Program Files\nodejs` —— 装完这台机器上就有**两份 Node**，之后 `node` 用哪一份只看系统查找路径里谁在前，
终端、插件与这个应用自己都可能拿到不同的一份。

现在更新与安装的**方式跟着那份 Node 的真实归属走**：

- **版本管理器管的** → 用版本管理器更新（装好新版本再切过去），不动系统里原来那份、也不再装第二份；
  机器上已经装好版本管理器时，**不会再重装一遍版本管理器**（这次只是让它多一个版本并切过去，没有多的下载）；
- **官方安装包装的** → 用官方安装包装回它自己的位置；
- **认不出来**（不在官方默认位置、也不在任何版本管理器下）→ **不替你做自动更新**，只给官方下载页；
  安装那一步会把两种方式都列出来、**一条都不预选**，由你显式选，并先说清「两份 Node 并存」的后果
  （之后哪一份生效只看系统查找路径里谁在前）。

### 修好了：「更新」不会悄悄换档，换档会明说

另一个现场：门禁里的档位切换是一个不显眼的小按钮，用户没意识到自己选了「当前版」，装出来就是当前版；
之后点「更新」，目标却按默认的稳定版去算 —— 目标版本**比已经装的那个更低**，看起来像降级，而界面上没说这是**换档**。

现在：

- **「更新」的目标档位跟着现在这份的档位走**：当前版就更新到更新的当前版，稳定版就更新到更新的稳定版；
- **换成另一档（稳定版 ⇄ 当前版）是一个要你显式选的动作**，不是「更新」的副作用；
- **目标版本低于当前版本时，界面直说这是换档**：动作名写成「换成稳定版 / 换成当前版」，并写出
  「这会把现在这份 Node 换成稳定版，版本从 vX 降到 vY。」—— 这一支里不会出现「更新」两个字；
- 确认区里**并排显示「当前版本（档位）→ 目标版本（档位）」**；档位判不出来时那一半写「档位未知」，不猜；
- 安装时的档位选择挪到**选择区**里（与「用哪种方式装」同级、进这一步就能看到），不再是确认区里的一行小字。

### 修好了：一份 Node 都没有时，「用版本管理器安装」又回来了

上一版把"默认"做成了"没得选"：在**一份 Node 都没有**的机器上（也就是第一次装的那台），第一步只显示一句事实行，
**「用版本管理器安装」这条路看不见也点不到** —— 只能走官方安装包，还要一次管理员权限。

现在这一支**两条路都列出来**，只是**默认预选**一条（机器上已经有可辨认的版本管理器就预选用它，否则预选官方安装包），
**随时能改成另一条**；事实行也会把**这次会用哪种方式**说明白，而不是只说版本档位。首次安装该有的选择权还给你。

## [0.5.3] - 2026-09-19: 关窗可收起托盘，更新提示聚焦到更新卡片

Windows / Linux 上关闭窗口不再等于退出：默认**问一次**，也可以固定成「收起到系统托盘」或「直接退出」

以前点右上角的 X 就是退出应用，而默认设置还会**连带停掉本应用启动的 dsh** —— 点一下关闭，正在用的 dsh 就没了，应用一句话都没说。现在：

- **第一次关闭会问一次**：「收起到托盘 / 退出应用 / 取消」，勾上「记住我的选择，以后不再询问」就把结果记下来，之后不再打扰。这张确认卡是应用自己画的（不再是系统弹窗），并且会**把实际会发生什么写清楚**：哪个 dsh 会被停掉、PID 是多少、外部启动的那个不受影响。
- **收起到系统托盘**：托盘图标**随应用启动就出现**（叫回窗口、退出都从它走），窗口藏起来后应用与本应用启动的 dsh 继续在后台运行；右键是「显示主界面 / 退出 DSH Console」，单击图标也能叫回窗口。**这台机器上第一次收起**时（Windows）会有一个气泡提示，免得以为应用被自己关掉了 —— 之后不再打扰。
- **设置页新增「关闭窗口时」**（监控与生命周期）：询问一次 / 收起到系统托盘 / 直接退出应用，随时可改。这一行只在 Windows / Linux 显示 —— macOS 上关窗本来就不退出，这个二选一在那边不存在。
- 直接退出时要不要停掉 dsh，仍由「关闭应用时停止本应用启动的 dsh」那条决定。

macOS 不变：那边关窗不退出、Dock 常驻是系统惯例。

底栏的「发现新版本」点进去会**被带到**更新卡片上：缓动滚动 + 聚焦蒙层

以前只是切到设置页；更新卡片在「关于」的最后一块，页面长了还得自己滚下去找。现在：

- 先切到设置页，**停一下**再**缓动**把「关于」卡片带到视野中间 —— 时长与曲线由我们自己给（原生 `scrollIntoView` 的速度由浏览器定，偏快），系统开了「减弱动效」时直接跳过去；
- 到位后铺一层全窗口的蒙层，只在整张「关于」卡片处开一个洞，配一圈强调色描边呼吸两下，把「就是这里」说清楚；
- 蒙层不挡操作：想直接点卡片上的「下载 / 重启并安装」随时可以；点一下、按一下键、滚一下滚轮、或 2.6 秒到点，蒙层自己收掉。

## [0.5.2] - 2026-09-18: 插件页：dsh 起不来时给得出路，悄悄不生效的能就地修

插件把 dsh 弄挂、或你自己的层被改坏时，插件页现在给得出出路（不用再去手工改文件）

这一页最大的性格是"dsh 挂掉时它还能用"，但以前配置一坏，它就只剩一句红字。现在：

- **救援条**：dsh 起来又退出（或超时没就绪）、或装配信息读不出来时，顶部直接把原因那一行
  （dsh 自己打印的诊断）和两个出口摆出来。
- **只看内置层**：跑一遍 `dsh web --dump-default-config`（不解析你的层）。实测你的层是非法
  YAML 时 `--dump-config` 会整条失败，而这条照样能成 —— 界面切到「基线」视图，并写明
  "这不是你真正生效的配置"。
- **临时停用某个插件**：把它从 dsh 的 bundle 列表里摘掉（写之前备份原文件），重启 dsh 就能
  起来；想放回来点「恢复」，它会插回**原来的位置** —— 层序就是覆盖顺序，挪到末尾等于改了配置。

还有两个"修"的动作（都只认能认出来的坏法，动手前先备份）：

- **修成空配置**：补丁层变成"只有注释"时（dsh 报 `must be a top-level YAML array`）补一个 `[]`；
  文件里还有别的内容时它不动手，只说原因。
- **从备份恢复…**：列出 `cordis.patch.yml.bak-<时间戳>`（最近的在前），挑一个覆盖回去；当前内容
  也会先备份，所以恢复错了还能再回去。

认不出是哪一层时不硬猜：只给「只看内置层」，并指到层栈里自己挑。找那个"罪魁"有两条路：
层栈还在就用层栈；**dump 都读不出来时**（比如某个 bundle 解析不到、dsh 因此起不来）退到
profile 的 bundle 清单 —— 而且只认**非内置**的，停用 `@deepseek-ai/dsh-base` 等于把 dsh 拆了。

顺带修了救援条上的原因那一行：Node 抛异常时它原来显示成源码行（`if (!Array.isArray(parsed)) throw …`），
现在会滤掉 `file:///…` / `at …` / `throw new` / `^`，优先取 `Error: …` 那一行。

还有一类是"悄悄不生效"：patch 里指向了不存在的条目、装进来的包没声明 `dsh.bundle`
所以不形成层、列在 bundle 列表里却在生效配置里一条都没有。这三类本来就在插件页顶部
列着，但只能看。现在前两类有出路：

- **指向了不存在的条目 → 「删掉这一行」**：按行删掉那一条（覆盖、禁用、insert 块里的
  都认），删完仍然保证文件是合法的顶层数组。只有**本页能改的那一份** profile 层才给这个
  按钮 —— 机器级的 `~/.dsh/cordis.patch.yml` 不在这一页的能力范围里，那种情况只把文件
  指出来。
- **装成了普通依赖 → 「卸掉它」**：走正常的卸载路径（要 pnpm，做完要重启 dsh），比让人
  自己去终端敲一遍省事。

第三类（列在 bundles 里却什么都没贡献）没有通用修法，所以不给按钮，只把话说清楚。

## [0.5.1] - 2026-09-18: 插件页：装 / 卸 / 升级，以及改你自己的补丁层

插件页能直接装 / 卸 / 升级了（不用再开终端）

上一版只能"看"，这一版能改：

- 页头「+ 安装插件」→ 填包名、`./本地目录`、`.tgz` 或 `github:owner/repo#sha`，
  pnpm 的输出边跑边贴在页面上；装完提示「重启 dsh 后生效」并给「立即重启 dsh」。
- 树外插件的详情里多了「升级到最新」与「移除」。
- 同一时刻只允许一个操作（同一个 profile 目录不能被两个 pnpm 同时改），进行中给「中断」。
- 确认框里写明"代码从网络取、git 源安装时可能执行它的构建脚本"——装插件等于让第三方
  代码跑在你的机器上，这件事不能默默发生。

装/卸/升级改的是 package.json 与 node_modules，所以要重启 dsh；你自己的 patch 层仍然是
即时生效的，界面上把这两种时机分开写。

顺带修了两个只有真机才暴露的问题：`dsh plugin add` 在 pnpm 9 下会被
`ERR_PNPM_ADDING_TO_ROOT` 拒掉（dsh 模板的 pnpm-workspace.yaml 缺少
ignore-workspace-root-check），现在被拒时自动加 `-w` 重试一次；以及子进程的 PATH 补上了
pnpm 所在目录（GUI 启动的应用 PATH 很窄）。

还能单独指定安装源：「设置 → 插件安装源」填一个 registry（比如
`https://registry.npmmirror.com`），它只作为环境变量传给那一次 pnpm —— **不改你电脑上的
npm 配置，也不影响别的项目**；留空就跟随系统。当前生效的源显示在插件页的安装框旁边。
另外 404 的提示不再笼统说"包不存在"：缺的是依赖而不是你写的那个包时会直接指名道姓，
内置包也会在调用 pnpm 之前就被拦下并指路 patch 层 —— 如果你自己的 patch 层里已经插过它，页面会直接说「它已经启用了，这里不用装任何东西」，而不是让你再去 insert 一遍。

机器上没装 pnpm 时，装 / 卸 / 升级会**在动你的 profile 之前**就停住并说清装什么
（原来会让 `dsh plugin` 先把 profile 初始化出来、再以退出码 127 失败）。只需看一眼的
层栈 / 清单不经过 pnpm，没装也照常可用。

另外修了一个"保存看起来成功、其实什么都没写"的坑：界面与主进程是两份产物，会各自更新
（窗口热重载、主进程还是旧构建）。这时设置页认得的新设置项在主进程眼里是"不认识的键"，
原来会被静默丢掉 —— 真机上就这么丢过一次「插件安装源」。现在主进程遇到不认识的键会直接
拒绝整份保存，设置页把原因显示出来，而不是照旧说"已保存"。

插件页现在也能改**你自己的补丁层**了，不用开编辑器：生效配置里每条条目的右边有「禁用 / 启用」，
你自己插进来的条目还能「移除我的插入」；填一个内置包被拦下时，输出区里会直接给一个
「插进我的层」。写之前先把 `cordis.patch.yml` 备份成 `.bak-时间戳`，只改匹配到的那一段，
改完再改回来与原文一字不差（自检用真实文件钉着）；这一层是即时生效的，不用重启 dsh。

补丁层那条路补了一个真机事故：移除最后一条 insert 之后文件只剩注释，而 dsh 要求这个文件是
**顶层数组**，于是整个插件页读不出来（`overlay … must be a top-level YAML array`）。现在没
条目时会自动留一个 `[]`；而且写完会立刻回读验证一次，一旦发现是这份 overlay 读不了，就把备份
原样还原并告诉你原因，不会让你的补丁层停在坏状态。

## [0.5.0] - 2026-09-18: 插件页：装配层栈与运行中清单

新增「插件」页：看清 dsh 的插件是怎么装起来的（只读）

左栏新增第 7 项（快捷键 `7`；页面总数因此变成 8）。它管的是插件的**装配层**（装了什么、哪个版本、层序如何、
生效配置长什么样），跟内嵌界面里 **设置 → 插件** 那个管运行时配置的分区是两件事，
页面上也写清了分工。

页面上有两块：

- **装配层栈**：按应用顺序列出每一层 —— 内置 bundle、你装的树外 bundle、你自己的
  `cordis.patch.yml`、机器级 patch 层；选中一层能看到它的版本、来源
  （`link:` / `github:` 之类）、解析位置，以及"它插入了多少条、覆盖了下面多少条"。
- **生效配置**：`dsh web --dump-config` 的组合结果，按**来源层**分组（包括"某一层被谁
  覆盖了"），可搜索、可按"被覆盖 / 禁用"筛选。真实数据里 `dsh-web-app` 覆盖 base 的
  25 条有 23 条是把下层关掉而不是改配置，所以这两种情况分开标。

另外会把**没报错的错**单列出来：patch 里指向了不存在的条目（dsh 只在 stderr 说一句、
退出码还是 0）、装进来的包没声明 `dsh.bundle` 所以没形成层、列在层栈里却什么都没贡献的
bundle。这些都不会让命令失败，但会让改动悄悄不生效。

**运行中的清单**（dsh 由本应用启动时）：页头直接给「运行中 N 条（X 已挂载 · Y 未挂载 · Z 加载失败）」，
生效配置里每条带运行状态，并单列一组「运行时挂载」—— 根 `include` 与启动时生成 id 的原生目录选择器 / HMR，
它们在配置文件里根本没有，也正是"静态组合"与"运行中"两个数字对不上的那几行；顺带显示各 Agent 预设
给会话挂多少行（Harness 里那个"会话插件 28 个"）。读不到令牌（外部实例）或调用失败时只显示一句原因，
页面退回纯静态。

只读：这一版不改磁盘、不装插件。静态部分来自 profile 目录与 `dsh web --dump-config`，
所以 **dsh 没在跑也能用** —— 插件把 dsh 启动打挂时，这一页是唯一还能给出层栈与失败原因的入口。

自检 103 → 116 项，新增的都用**真实夹具**钉住：一份 539 行的真 dump、真 stderr 样本、真接口应答。
钉的是"坏了没人看得出来"的那些：层归因（`patched by` 要拆开）、未匹配的 patch 行只在 stderr 上、
空输出不算成功（旧 Node 上 dsh 的 CLI 是退出码 0 + 零输出，当成成功就会显示成"没有插件"）、
运行中清单的解析与失败判定、以及快捷键顺序必须与左栏一致。

## [0.4.4] - 2026-09-17: 粘贴地址行对齐与更新卡片文案

修复：Harness 页「粘贴令牌地址」那一行的按钮比输入框矮一截、还没对齐

`.ui-paste` 是弹性布局但没写 `align-items`（默认 stretch，而按钮有自己的固定高就贴顶），
按钮又是 `.btn.small` 的 27px，挨着 30px 的输入框就显得矮一截。现在这一行居中对齐、按钮与输入框
同高（30px）。冒烟脚本会量真实 DOM 的这两个高度，不一致就失败。

修复：设置页「关于」里的更新卡片文案与排版

三处不对：**「下载与安装都不会自己做」在 macOS 上是错的**（那台机器上是 ad-hoc 签名，根本没有下载与安装这回事）、**「当前版本 x.y.z」与上面那行重复**、**「点『打开下载页』下载」和按钮说了两遍**；排版上标题与状态挤在一行、按钮孤零零落在左下角。

现在：说明行按平台分开（Windows 说下载与安装的规则，macOS 说去下载页覆盖安装）、不再重复版本号与按钮文案、按钮挪到「软件更新」标题右侧、状态与说明各占一行。

## [0.4.3] - 2026-09-17: 安装包瘦身

内部：把渲染层依赖从生产依赖里摘出来，安装包小了一圈

`vue` / `@xterm/*` / `@fontsource/*` 只被渲染层用到，而渲染层是由 Vite 打包成 `dist/renderer` 的
单文件产物；它们挂在 `dependencies` 里时，electron-builder 会**再拷一份**进 `app.asar`。
现在归到 `devDependencies`，生产依赖只剩主进程运行时要 require 的 `node-pty` 与 `electron-updater`。

实测（本地 `--dir` 包）：`app.asar` 20.2 MB → **2.1 MB**，未压缩的 `.app` 306 MB → **289 MB**，
下载的安装包相应小几 MB。功能没有任何变化，自检加了两条把这条规则钉住（每个生产依赖都必须真被
主进程 require、渲染层依赖不许留在 dependencies）。

## [0.4.2] - 2026-09-17: macOS 也会提示新版本

macOS 也会提示有没有新版本了（虽然仍然不能自动安装）

之前 macOS 只在设置页写一句"ad-hoc 签名装不了自动更新"，用户只能自己去 Releases 页面看有没有新版。
现在应用**照样会检查**：启动几秒后一次、之后每 6 小时一次，发现新版本会在底栏提示「发现新版本 x.y.z」，
设置页的更新卡片也会写明，按钮是「打开下载页」—— 点它去下载新的 `.dmg` 覆盖安装即可。

实现上没有引入 Squirrel：macOS 上直接取那份不到 1 KB 的 `latest-mac.yml` 比版本号（与 Windows
走 electron-updater 时读的是同一个文件）。契约里的 `canCheck`（能不能查）与 `canAutoUpdate`
（能不能装）因此分成了两个字段。

## [0.4.1] - 2026-09-17: 修复 Harness 页莫名全屏

修复：外部 dsh 实例下点开「DeepSeek Harness」页会莫名其妙进全屏

那一页在拿不到访问令牌时只有一段"不可用"的说明，却仍然按设置自动收起了左栏与底栏 ——
现在**只有内嵌界面真的可用（或即将可用）时才自动全屏**：已经拿到带令牌地址，或者 dsh 是本应用
启动的（令牌可能还在打印的路上）。外部实例下点这一页就老老实实停在普通布局，方便看清提醒、
顺手点「重启为受管实例」。

## [0.4.0] - 2026-09-17: 自动更新

自动更新：Windows 上会自动检查新版本，下载与安装都由你确认

### 自动更新

- 启动后自动检查一次，之后每 6 小时一次；在「设置 → 监控与生命周期」里可以关掉自动检查；
- 发现新版本只在设置页与底栏提示，点「下载」才开始下载（显示进度百分比），下载完再点「重启并安装」——
  下载与安装都不会自己做；
- **macOS 因为是 ad-hoc 签名（Squirrel.Mac 会拒绝安装），自动更新不可用**，请在 Releases
  页面手动下载新版本；设置页会如实说明并给「打开下载页」；
- 开发态不检查更新，也不会加载 electron-updater。

## [0.3.0] - 2026-09-17: TypeScript 迁移与工具链整理

内部：整个代码库迁移到 TypeScript。主进程、preload、渲染层、自检与工具脚本全部是 TS，
跨进程的形状集中在 `src/shared/ipc.ts` —— 加设置项、改 IPC 字段时两边对不上会直接编译报错，
而不是等到运行时才发现。`npm run typecheck` 现在覆盖三份配置（主进程 tsc、渲染层 vue-tsc、
测试与工具 tsc）并接进 CI。界面行为不变，改的是"改错了编译器会不会拦住你"。

修复：状态栏的快捷键提示写着 `⌘+1~6 切换页面`，而左栏其实已经有七个页面 ——
第 7 个「归档会话」的快捷键一直能用，只是没人知道。现在提示与页面数一致。

内部：接入 changesets —— 每条改动写一个 `.changeset/*.md` 片段，发版前用 `npm run release:prepare`
汇总成 CHANGELOG 条目，PR 上会检查"改了代码就要带一个片段"；代码风格显式化（语句结尾要有分号、
多行列表的最后一项要有尾随逗号），并加了一个登记"纯格式化提交"的 `.git-blame-ignore-revs`；
README 收敛为面向使用者的项目介绍，开发说明独立成 `AGENTS.md`。

## [0.2.2] - 2026-09-16

修掉 macOS 版**装完打不开**的问题：0.2.1 及以前的 mac 包在 Finder 里双击只会说
**「DSH Console 已损坏，无法打开。你应该将它移到废纸篓。」**

### 修复：macOS 包在 Apple 芯片上无法启动

- **原因**：macOS 的 .app 打包时**没有签名**。Electron 自带的二进制本来是有签名的，但
  electron-builder 重新打包会改动 bundle 内容，那条签名的封条随之失效 —— 校验时报
  `code has no resources but signature indicates they must be present`（签名存在但无效）。
  Apple 芯片上签名无效的 app 会被系统直接拒绝，给出的说法就是"已损坏"，而不是"未验证的开发者"。
- **改法**：`mac.identity` 设为 `"-"`，也就是 **ad-hoc 签名**（没有开发者证书时唯一可行的签名方式），
  并去掉 CI 里的 `CSC_IDENTITY_AUTO_DISCOVERY=false` —— 那个变量会让 electron-builder
  连 ad-hoc 签名都跳过。
- 现在打包出来的 `.app` 通过 `codesign --verify --deep --strict`（`valid on disk` /
  `satisfies its Designated Requirement`），装了能正常启动。
- **首次打开仍会被 Gatekeeper 拦一下**（ad-hoc 签名不被信任，这是没有开发者证书时的正常表现）：
  **右键 →「打开」**，或到「系统设置 → 隐私与安全性」点「仍要打开」，也可以执行
  `xattr -dr com.apple.quarantine "/Applications/DSH Console.app"` 去掉下载隔离标记。

## [0.2.1] - 2026-09-15

补上 DSH 官方缺的一块：**翻看、恢复、删除归档过的会话**。

### 新增：归档会话页

DSH 的「归档」原本只是把会话 id 写进 `storages/workspace.json` 的 `archivedSessionIds`
—— 纯隐藏、不删数据，而且**没有任何入口能把它找回来**。现在控制台左栏多了一页
（「归档会话」，快捷键 `Ctrl+6` / `⌘6`）：

- **索引列表**：标题、首句、时间、轮数与日志体积；搜索框同时匹配标题与对话内容
- **读全文**：点开即读该会话的完整对话。会话日志是 zstd 压缩的 JSONL，这里按帧解压还原；
  标题、列表、代码块、表格、引用、链接都按 Markdown 正常渲染
- **恢复**：从归档列表移回侧边栏，不改动任何数据
- **删除**：删掉会话日志与投影缓存，并从工作区注册表里移除（会先弹确认框；**附件不删** ——
  它们可能被多个会话共享）

读的是 DSH 自己的数据目录（`$DSH_HOME`，没有则 `~/.dsh`），不经过网络、不上传任何东西。

> 「恢复」与「删除」改的是磁盘上的 `workspace.json`，而正在运行的 dsh 把这份文件读进了内存，
> 所以要**重启 dsh** 后侧边栏才会同步（Harness 页的「重启为受管实例」也可以）。

### 改进

- 归档页按「**转录稿**」而不是聊天气泡来做版式：助手一次回答会跨多个 step 拆成多条消息，
  用气泡会把一段连续回答碎成一墙卡片。现在用户发言用一条强调色竖线标出、助手内容作为连续
  正文流动，整列限宽保证可读行长
- Markdown 渲染器**自包含、不引入第三方依赖**，而且**先整段转义 HTML 再渲染** ——
  模型输出里即使夹带 `<script>` 也只会被显示成文本
- 应用快捷键扩到 `Ctrl+1~7` / `⌘1~7`（多了第 7 个页签）

### 修复

- **发版时 Windows 产物会丢**：v0.2.0 的 Release 里 Windows 的安装包、便携版与 `latest.yml`
  都没传上去（说明里却让用户去下）。根因是两个 runner 各自跑
  `electron-builder --publish always`，并发走到 `getOrCreateRelease()` 时都发现"没有 release"
  就各建一个；更麻烦的是 electron-builder 默认 `releaseType=draft`，release 一旦从草稿变成
  「已发布」，后续上传会被**静默跳过**（步骤显示成功，只在日志里 warn 一句），
  所以"重跑一次 CI 把缺的补上"这条路走不通。
  现在把**打包与发布分开**：两个 `build-*` job 只打包（`--publish never`），产物无条件挂成
  Artifacts；标签构建时由单独的 `publish` job 收齐两边产物、一次建草稿、一次上传。
  没有并发建 release 的窗口，重跑也能覆盖同名产物；**任一平台构建失败就不会建 release**。

## [0.2.0] - 2026-09-15

同一套控制台，Windows 和 macOS 都能用了。macOS 上是原生窗口与 ⌘ 快捷键；Windows 侧行为不变。

### 新增：macOS 支持

- 提供 `dmg`（安装镜像）与 `zip`（免安装），**arm64 与 x64 各一份**
- **原生窗口**：改用 `hiddenInset`，红绿灯在左上角；左栏为它让出位置，**系统全屏时自动撤回**
- **⌘ 快捷键**：`⌘1~6` 切页、`⌘R` 重载、`⌘⇧D` 导出界面结构、`⌘⌥I` 开发者工具；
  状态栏提示也按平台显示 `⌘` 或 `Ctrl`
- **原生菜单**：给了最小菜单（应用/编辑/显示/窗口），否则 `⌘Q`、`⌘C/V` 会失灵；
  关掉窗口不再退出应用（Dock 常驻，点图标重建窗口）
- **本地 Shell** 用你自己的 `$SHELL`（zsh/bash），终端字体与中文兜底按平台换栈
- 主进程跨平台：端口占用改用 `lsof`、进程名用 `ps`、结束进程树按进程组而不是 `taskkill`

### 修复

- **macOS 上「启动不了」**：
  - 不再依赖 PATH 找 dsh —— 从 Finder / Dock 启动的 GUI 应用 PATH 很窄（不含 nvm / homebrew），
    现在会直接扫 nvm / fnm / nodenv、homebrew、pnpm 的全局安装目录找 `bin.js`
  - 自动挑一个**真能跑的 Node**：`dsh` 的 CLI 在旧 Node 上不报错、只静默退出
    （实测 Node 22.17.1 什么都不做、Node 24.14.1 正常），现在选解释器时会实测一次 `--version`
  - 「设置 → dsh 命令」支持**整条命令行**，可以直接指定用哪个 node 跑
  - 启动失败时事件日志会直接给出原因（`dsh 输出：…`），不必去终端页里翻
- macOS 上装了 PowerShell 时，「新建本地 Shell」会开出 `pwsh` 而不是用户自己的 zsh

## [0.1.0] - 2026-09-13

初版发布，仅支持 Windows。

### 新增

- Windows 桌面控制台：在 PTY 里启停 `dsh web`、轮询健康状态、接管已在运行的外部实例
- 内嵌 DeepSeek Harness 界面（自动捕获启动时打印的带令牌地址）
- 事件日志、延迟趋势、端口占用者识别；强杀进程树作为兜底
- 本地 Shell 标签页（pwsh / powershell / cmd）
- DeepSeek 用量页（独立浏览器分区保存登录态）
- 启动行为可配置：自动拉起 dsh、自动进 Harness 页、自动全屏；退出时是否一并停止 dsh

### 已知限制

- `dsh web` 不读取键盘输入，所以 dsh 终端里打字不会有反应；要停它请用「停止」或「发送 Ctrl+C」
- 本地 Shell 不跨应用重启保留 —— 每次启动是全新的一页
