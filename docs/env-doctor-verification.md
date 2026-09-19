> **状态（t12 / t34 集成收口补记）**：这份报告是**阶段一**那一轮的记录，结论仍然有效。阶段二在它之上加了首启环境门禁与
> Node 安装（见 [`docs/env-wizard.md`](env-wizard.md)），并把 npm / pnpm 的判定口径收严了一处
> （「有输出才算可用」，见 `docs/env-doctor.md` 1.3）；收口阶段又补了「**装完当场能用**」那条链
> （刷新查找路径 → 复检 → `<pnpm> -v` 功能实测，含一次性的 install-scripts 开关与缺 VC++ 运行库时换纯 JS 那条线，
> 见 `docs/env-doctor.md` 3.4）。**本文里出现的自检项数一律是"那一轮"的值**（本报告写的是 169、收口复测 180）；
> 最新的项数与结论看 [`docs/env-wizard-verification.md`](env-wizard-verification.md)（阶段二第四轮）开头的 t34 补记
> （**最终树现测 242/242 + 20/20 + 150/150**）与 [`docs/env-wizard-freeze.md`](env-wizard-freeze.md)（设计冻结）。

# 运行环境自检 + 一键配置：独立验证报告

**验证者**：verifier（独立验证者，不是实现者）
**验证对象**：t4（契约 + 主进程探测与一键修复）、t5（渲染层界面与交互）
**判定基准**：`src/shared/ipc.ts` 冻结的契约 + `docs/env-doctor.md` 的探测项清单与交互约定；两者冲突时以契约为准。
**验证环境**：Windows 11 + Node v24.19.0，Electron 主进程不可在此环境启动（见第 6 节）。
**本文所有结论都带原始输出或可复现命令；实现者的自述不作为证据。**

结论一句话：**四道门禁全绿、自检 169/169（收口时复测 180/180，见 1.2）、契约与设计文档的探测项/修复动作逐条对得上；当时有 4 处低严重度的偏差/文档缺口，收口阶段已逐条处理（见第 7 节末尾的「收口后的状态」），没有阻塞项。**

## 1. 四道门禁（原始结果）

命令与 `package.json` / AGENTS 第 5 节一致；在 `C:\Users\yozica\Desktop\dsh\dsh-console` 下执行。

| 门禁             | 命令                                                             | 退出码 | 原始输出（关键行）                                                                                 |
| ---------------- | ---------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| typecheck        | `npm run typecheck`                                              | **0**  | `typecheck:main` / `typecheck:renderer` / `typecheck:node` 三段都无输出（tsc 与 vue-tsc 均无报错） |
| lint             | `npm run lint`                                                   | **0**  | `> eslint .` 无任何输出                                                                            |
| format:check     | `npm run format:check`                                           | **0**  | `Checking formatting...` / `All matched files use Prettier code style!`                            |
| 自检（沙箱替代） | 见 1.1                                                           | **0**  | `169/169 项通过`（**当时**的项数；收口时现测 180/180，见 1.2）                                     |
| 契约 verify 命令 | `node scripts/selftest-sandbox.mjs scripts/env-doctor-cases.mjs` | **0**  | `自检门禁：通过（编译 + 自检 + 清理都干净）`（收口时已简化为不带参数，自动收录反例脚本）           |

> `npm test`（`tsx test/selftest.ts`）在该沙箱里起不来：tsx 要经 esbuild 的**带管道子进程**，
> 而受限沙箱禁止 `spawn` + 管道 stdio（EPERM）。**这不是被测代码的问题** —— 判定与自检都不依赖它。
> 等价路径（AGENTS 第 5 节「改一处代码要跑什么」加沙箱说明）就是下面这条。

### 1.1 自检在沙箱里的运行方式与清理结果

原来要手工三步，现在固化成一个可重复入口（本次新增，用法见第 8 节）：

```bash
node scripts/selftest-sandbox.mjs scripts/env-doctor-cases.mjs
```

它做的事与原始三步等价，且**用「运行前 / 运行后的文件快照差」精确删除本轮的 tsc 产物**
（不猜路径、不用 git、不会误删本来就存在的文件）：

```text
$ node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit false --listEmittedFiles
[tsc 编译] 退出码 0
tsc 本轮新产出 38 个文件（供第 3 步清理）：
  src/main/dsh-manager.js … src/shared/ipc.js.map tools/make-icon.mjs … vite.config.mjs.map test/selftest.js test/selftest.js.map
$ node test/selftest.js
…（169 行 PASS／SKIP）
169/169 项通过
[自检] 退出码 0
清理：删掉 38/38 个 tsc 产物
清理后仍多出来的文件：0 个
```

> 上面那段是**这一轮当时**的输出。其中的 `tsc 本轮新产出 …（供第 3 步清理）` 是旧版包装的措辞，
> 它按「运行前后差集」判断要清理什么 —— **重跑之前的产物会落在差集之外**，于是被判成「没有东西要清理」，
> 下一轮接着失败。t8 把它改成了「以 tsc 自己报的 `TSFILE:` 行为权威清单」：清单里那些「本轮运行前就已经存在」
> 的产物会被诊断成**上一次被中断留下的**、一并清掉，不判失败；当前输出形如
> `tsc 权威产物清单：38 个文件（来自 --listEmittedFiles 的 TSFILE 行）`。另外 t17 之后，门禁会
> **自动收录 `scripts/*-cases.mjs`**（与显式参数合并去重），所以不带参数也不再只是「自检 + 清理」。

- **38 个产物**与实现者自述的数字一致（`TSFILE:` 行逐条列出，与快照差集互为佐证）。
- 清理后**没有残留**：`清理后仍多出来的文件：0 个`。
- 自检里 3 条 `SKIP`（本机不允许起子进程 / 没有能跑 dsh 的 node）是**沙箱限制**，不是失败；
  `169/169` 的分子里不含 SKIP。
- **「+19 项且无回归」是独立验过的**（不靠自述）：`git diff --numstat -- test/selftest.ts` → `393 0`
  （只加不删）；把 diff 里的删除行过滤一遍，**含 `check(` 的删除行 0 条**（既有断言一条都没被改动）；
  `git show HEAD:test/selftest.ts` 里 `环境自检` 出现 **0** 次（19 条自检断言全是新增）。
  因此 169 = 基线 + 19，且**结构上不可能**出现「把既有断言改绿」这件事 —— 改动前的基线数（150）来自实现者自述，
  验证者没有用旧版本源码另跑一遍去复现那个绝对数。

### 1.2 收口时的复测（t9 / t16 / t17 之后）

这一小节是**收口阶段补测的**，不是当时那一轮的原始记录；数字都在当前树上现测。

| 项                    | 当时（t2 验证轮）  | 收口时（现测）                                                                                   |
| --------------------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| 自检项数              | 169/169            | **180/180**（`node test/selftest.js` → `180/180 项通过`，0 FAIL、4 SKIP）                        |
| tsc 产物              | 38 个              | 38 个（`TSFILE:` 行数不变）                                                                      |
| 独立反例脚本          | 17 条              | **19 条**（`node scripts/env-doctor-cases.mjs` → `环境自检独立反例：19/19 通过`）                |
| 沙箱门禁              | 需显式点名反例脚本 | `node scripts/selftest-sandbox.mjs` 即可（自动收录 `scripts/*-cases.mjs`），**exit 0**           |
| `launchSpec` 等公共件 | 在 `env-doctor.ts` | 迁到 **`process-utils.ts`**（t16；env-doctor 只留 `npmLaunchSpec()` 别名，反例脚本照旧从它进来） |

自检项数增加的三处来源：t9 为修 F1 / F2 / F3 新增的「Windows 启动 spec 真的起得来」「PATHEXT 优先于裸名」
「探测与修复走同一个包装器」「超时是独立终态」「单动作互斥是同步置位」等断言，以及 t17 对反例脚本的收录。

## 2. 逐条对照设计文档

判定用的纯函数入参是**手工构造的对象字面量**，不需要装 pnpm、不需要起任何进程
（这正是设计文档第 2 节把判定做成纯函数的理由）。逐条的期望值来自设计文档，不是抄实现的。
可复现命令：`node scripts/selftest-sandbox.mjs scripts/env-doctor-cases.mjs`（**当时** 17 条独立反例，
`环境自检独立反例：17/17 通过`；收口时已扩到 19 条、且不带参数也会被门禁自动收录，见 1.2）。

### 2.1 八个探测项

| #   | id                | 结论       | 证据（原始输出 / 检查方式）                                                                                                                                                                                                                                     |
| --- | ----------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `node`            | **已验证** | 入参 `path` 有值 → `ok`（detail 带完整路径）；`null` → `missing` + `fixHint` 指向 nodejs.org / `nvm install`。静态确认 `collectEnvProbe` 调的是现成的 `findNodeExe()`，没有另写一份 PATH 查找                                                                   |
| 2   | `node-version`    | **已验证** | 边界值实测：`v20.18.0=false/v20.19.0=true/v22.11.9=false/v22.12.0=true/v23.0.0=true/v24.19.0=true`（与文档 1.2 完全一致，且与 vite 那句关系正确）；`v20.9.0` → `warn`，detail 明写「这是构建期要求…由下面『实测 dsh』那一项决定」；EPERM → `warn`（不当成没装） |
| 3   | `npm`             | **已验证** | `null` → `missing` + 指向「重装官方 Node」；有路径无输出 → `warn`（自检第 5 组夹具覆盖）；自检「没有新增设置项」等无回归                                                                                                                                        |
| 4   | `pnpm`            | **已验证** | 缺失 → `fixAction='install-pnpm'`；npm 也缺失 → `fixAction=null`、`plans=[]`（不给起不了子进程的按钮）；「存在但不可执行」→ `warn` + 出路（反例 A）                                                                                                             |
| 5   | `dsh`             | **已验证** | `kind=null` → `missing`（带 `resolveError` 原文）；`kind='npx'` → `warn` 且 detail 点名 npx 每次要联网；`kind='node-bin'/'shim'/'custom*'` → `ok`                                                                                                               |
| 6   | `dsh-run`         | **已验证** | 退出码 0 + 零输出 → `missing`，detail 原样写出「静默退出的：退出码 0、零输出」；`dsh` 本体那一行同时仍是 `ok`（两件事分开判）；EPERM → `warn`                                                                                                                   |
| 7   | `bundled-runtime` | **已验证** | 内嵌 Node `20.9.0` + `packaged:true` → `missing` + 「注意这不是你机器上的 Node，它由打包时用的 Electron 决定」+ 「升级 DSH Console」；`packaged:false` → 一律 `ok` + 开发态说明                                                                                 |
| 8   | `shell`           | **已验证** | 写死的路径不存在 → `missing` + `fixHint` 指回「设置 → 本地 Shell」；`file=null` → `missing`（自检夹具覆盖）                                                                                                                                                     |

### 2.2 两个修复动作

| 动作           | 结论         | 证据                                                                                                                                                                                                                                                                                                                 |
| -------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install-pnpm` | **部分验证** | 计划与 argv：`display=/usr/local/bin/npm i -g pnpm`、`args=["i","-g","pnpm"]`、`file` 是探测到的**完整路径**、`target` 由主进程补（纯函数里为 `null`）；Windows 上 `.cmd` → `COMSPEC /d /s /c "C:\Program Files\nodejs\npm.cmd" i -g pnpm`。**真机执行未验证**：跑一次会改这台机器的全局 npm 目录并联网（见第 6 节） |
| `install-dsh`  | **部分验证** | `envFixPlan('install-dsh','/usr/bin/npm').args → i -g @deepseek-ai/dsh`；npm 缺失时 `null`（不给按钮）。**真机执行未验证**：同上                                                                                                                                                                                     |

两个动作的**执行路径**（静态审查 `src/main/env-doctor.ts` 的 `EnvFixRunner`，不采信自述）：

- `spawn(spec.file, spec.args, …)` + 数组，`env-doctor.ts` 里**没有** `shell: true`（自检也钉了这条）；
- 环境 = `envWithKnownBins(process.env)` + `pluginRegistryEnv(settings.pluginRegistry)`（只影响这一次子进程，不写用户 `.npmrc`）；
- `cwd: homeDir()`、`stdio: ['ignore','pipe','pipe']`、stdout/stderr 双向都收（`collect` 同时挂 `data`）；
- 超时 `FIX_TIMEOUT_MS` 自动 kill 并写明原因；`cancel()` → `child.kill()` → 相位 `cancelled`；
- 同一时刻只允许一个动作（`busy` → 返回「已经有一个修复在进行中」）；跑完 `doctor.recheck()` 并写进 `EnvFixState.report`；
- 渲染层只递 `action`：`api.envFix` **全仓库只有一处调用点**（`lib/env-doctor.ts` 的 `runEnvFix`，参数 `{ action }`），
  `main.ts` 的 `env:fix` 先用白名单校验 `action`，再用主进程现算的 `plan.file/plan.args` spawn（反例 Q 实测 `其它渲染层文件里的调用点 0 个`）。

### 2.3 契约（`src/shared/ipc.ts`）

| 项                                                                                                  | 结论       | 证据                                                                                                                              |
| --------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `ipc.ts` 不 import 任何运行时依赖（硬约定）                                                         | **已验证** | 静态统计：`imports=0`（全文件 0 行 import，只有类型与常量）                                                                       |
| `EnvCheckStatus` / `EnvCheckId`(8) / `EnvFixAction`(2)                                              | **已验证** | `ids=node,node-version,npm,pnpm,dsh,dsh-run,bundled-runtime,shell`（顺序即界面顺序）；动作恰为 `'install-pnpm' \| 'install-dsh'`  |
| `EnvCheck` / `EnvFixPlan` / `EnvDoctorReport` / `EnvFixPhase` / `EnvFixState` / `EnvFixOutputEvent` | **已验证** | 自检第 15 组（`契约里有 8 个 id、2 个动作、5 个 API`）通过；字段与文档第 5 节整块一致                                             |
| 5 个 API：`envCheck` / `envFix` / `envFixCancel` / `onEnvFixState` / `onEnvFixOutput`               | **已验证** | `api=envCheck,envFix,envFixCancel,onEnvFixState,onEnvFixOutput`；preload 五个成员都在（`ipcRenderer.invoke` ×3 + `subscribe` ×2） |

**已知契约 ↔ 文档冲突（文档缺陷，不计为实现缺陷，按任务约定）**：文档 3.3 / 4.2 说主进程会「推 `env:report` 事件」，
但契约里没有 `onEnvReport`，实测 `src/` 里出现 `env:report` 的文件 **0 个**；报告的取数路径是
`envCheck()` 拉取 + `EnvFixState.report`（复检）+ 两条订阅。收口阶段需要把文档这两处改掉。

## 3. 独立反例场景（要求至少两个，当时实际 17 条；收口时 19 条）

期望值直接来自设计文档的规则；两个「必考」场景的原始输出如下（完整 17 条见脚本输出）。

**反例 1：pnpm 存在但不可执行**（文档 1.4 三档里的第二档 —— 有路径、跑不出输出，不能当成没装）

```
入参：pnpm = { path: '/opt/pnpm/pnpm', version: null, exitCode: 0, error: null }
实际：status=warn counts={"ok":7,"warn":1,"missing":0}
      detail=找到了 /opt/pnpm/pnpm，但跑 `pnpm -v` 没有输出
      fixHint=在终端里手工跑一次 `/opt/pnpm/pnpm -v` 确认；不行就重装 pnpm。
```

**反例 2：node 版本不满足要求**

```
入参：node = { path: '/usr/local/bin/node', version: 'v20.9.0', exitCode: 0, error: null }
实际：status=warn counts={"ok":7,"warn":1,"missing":0} firstProblemId=node-version
      detail=v20.9.0 不在要求区间内（要求 ^20.19.0 || >=22.12.0）—— 这是构建期要求，
             dsh 到底能不能跑由下面「实测 dsh」那一项决定
```

两个反例都验到了关键设计决定：**「版本不满足」是黄灯不是红灯**（否则会出现「版本红灯 + 实测绿灯」两行自相矛盾），
而「pnpm 跑不动」也不是「没装」。

其余 15 条反例（都通过）：区间边界六值 + 非版本串 → `null`；`dsh` 静默退出 → `dsh-run=missing` 且点名「静默退出」；
npm+pnpm 都缺失 → `plans=[]`、不给按钮；EPERM → `node=ok` / `node-version=warn`；
pnpm 缺失 → 计划用完整路径、不经 shell、`target=null`（判定不碰子进程）；
内嵌运行时打包态/开发态；Shell 路径失效；counts 与 firstProblemId（全 ok→null、只 warn→该 warn、有 missing→第一个 missing）；
「每行 detail 非空 / 非 ok 必有 fixHint」不变量；失败归纳六条（含**真机夹具** `test/fixtures/pnpm-missing-dep.stderr.txt`
→ `registry 上没有「@deepseek-ai/dsh-type-meta」。`，指名依赖而不是笼统说"包不存在"）；
Windows `.cmd` 经 `cmd.exe` 包装、POSIX 原样透传；纯函数确定性与**不改写入参**；`envFixPlan` 的空/空白 npm 路径 → `null`；
契约静态检查；渲染层只递 action。

## 4. 接线与渲染层（静态验证）

GUI 交互无法在本环境实测（见第 6 节），但**「缺一次接线就整页空白」这类硬约定**都能静态核对，
而且仓库既有的三条断言已经把它们钉住（自检输出）：

```
PASS  渲染层：每个 .vue 组件都在挂载清单里  — 13 个组件
PASS  渲染层：每个挂载点都是 display: contents  — 13 个挂载点
PASS  渲染层：外壳与页面的挂载点都在  — 13 个挂载点
PASS  快捷键：TAB_ORDER 与左栏顺序一致（不一致就会"按 7 打开别的页"）
PASS  渲染层：调用的 api.* 都在 preload 里暴露  — 50 个方法
PASS  渲染层：JS 引用的元素 id 都存在于标记里（HTML + .vue）  — 4 个 id（覆盖 13 个 .vue）
PASS  样式：标记用到的 class 都有对应样式（HTML + .vue）  — 223 个 class
```

逐点核对的接线（`index.html` → `mount.ts` → `store.ts` → `app.ts` → `RailNav` → `TopBar` → `StatusBar`）：

| 约定                                         | 实际                                                                                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 页面容器 + 挂载点                            | `index.html`：`<section class="pane" id="pane-env"><div id="env-root"></div></section>`，排在 plugin 与 settings 之间                                                                                                           |
| 挂载清单                                     | `mount.ts`：`import EnvPane from './panes/EnvPane.vue'` + `['env-root', EnvPane]`（在 plugin-root 与 settings-root 之间）                                                                                                       |
| `TabId` / 顺序 / 快捷键                      | `store.ts`：`'plugin' \| 'env' \| 'settings'`；`app.ts` 的 `TAB_ORDER` 同序，`/^[1-9]$/` 绑 `TAB_ORDER[n-1]`                                                                                                                    |
| 左栏                                         | `RailNav.vue` 第 8 项 `{ id: 'env', icon: 'i-warn', label: '环境自检' }`（设置从 8 变 9）                                                                                                                                       |
| 顶栏标题                                     | `TopBar.vue`：`env: '环境自检'`                                                                                                                                                                                                 |
| 状态栏提示                                   | `StatusBar.vue`：`shortcutLabel('1~9')`；`lib/platform.ts` 的注释同步为 `1~9`                                                                                                                                                   |
| 挂载点样式                                   | `styles.css`：`#plugin-root, #env-root, #settings-root { display: contents }`                                                                                                                                                   |
| 页面级内边距（7.14）                         | `.env { padding: 0 20px 20px }`（左右与底部各 20px；顶部由自带 20px 左右内边距的 `.bar` 撑开）                                                                                                                                  |
| 终端里 `Ctrl+9` 要能穿过去（顺手修的真缺陷） | `lib/xterm.ts` 的 `passAppShortcutsThrough` 已从 `[1-8]` 改成 `/^[1-9]$/`                                                                                                                                                       |
| 插件页「缺 pnpm → 一键安装」                 | `PluginPane.vue`：按钮 `id="btn-plugin-install-pnpm"`，点击只 `requestEnvFocus('pnpm','install-pnpm')` + 切到 self-check 页；**不重复实现安装逻辑**；`install-pnpm` 收尾后 `load()` 重读 `pluginInspect`（`findPnpm()` 不缓存） |
| 控制台横幅入口                               | `DashboardPane.vue`：`counts.missing > 0` 时显示不可关闭的 `.banner`，「去自检」带 `firstProblemId` 锚点                                                                                                                        |
| 页内确认区（不弹原生对话框）                 | `EnvPane.vue`：`v-if="confirming && confirming === check.fixAction && confirmPlan"`，展示 `plan.display` / `target` / `note` + 开始/取消                                                                                        |
| 状态点三档                                   | `EnvPane.vue` 的 `li` 带 `data-status`，`styles.css` 用 `.env-row[data-status='ok'/'warn'/'missing'] .lamp` 上色（不写死颜色）                                                                                                  |

锚点用**递增请求号**（`lib/env-anchor.ts`）而不是布尔量，与 `lib/update-anchor.ts` 同款 —— 连点两次各走一遍，
不会出现「点了没反应」；`EnvPane.vue` 用 `watch(() => envFocus.value.seq, …, { immediate: true })` 消费它。

## 5. 工作树与范围

跑完自检、删掉 38 个产物之后：

```
$ git status --porcelain
 M src/main/main.ts                       M src/preload/preload.ts
 M src/renderer/app.ts                    M src/renderer/index.html
 M src/renderer/lib/format.ts             M src/renderer/lib/platform.ts
 M src/renderer/lib/store.ts              M src/renderer/lib/xterm.ts
 M src/renderer/mount.ts                  M src/renderer/panes/DashboardPane.vue
 M src/renderer/panes/PluginPane.vue      M src/renderer/panes/ShellPane.vue
 M src/renderer/panes/TerminalPane.vue    M src/renderer/shell/RailNav.vue
 M src/renderer/shell/StatusBar.vue       M src/renderer/shell/TopBar.vue
 M src/renderer/styles.css                M src/shared/ipc.ts
 M test/selftest.ts
?? docs/env-doctor-verification.md   ?? docs/env-doctor.md
?? scripts/env-doctor-cases.mjs      ?? scripts/selftest-sandbox.mjs
?? src/main/env-doctor.ts            ?? src/renderer/lib/env-anchor.ts
?? src/renderer/lib/env-doctor.ts    ?? src/renderer/panes/EnvPane.vue
```

- 只剩本次功能相关的源文件改动 + **本次验证新增的三个文件**（`scripts/selftest-sandbox.mjs`、`scripts/env-doctor-cases.mjs`、
  `docs/env-doctor-verification.md` 即本报告），**没有残留的 js / js.map 产物**（`清理后仍多出来的文件：0 个`）。
- 验证者**没有改 `src/`**：`git status` 里 `src/` 下的每个文件都能归到 t4（`main.ts` / `preload.ts` / `ipc.ts` / `env-doctor.ts`）
  或 t5（其余 15 个 `src/renderer/**`）。
- 与 t5 自述的对照：t5 说「18 个文件，全部在 `src/renderer/`」。实测渲染层改动 15 个已跟踪文件 + 3 个新增 = 18，
  一致；`lib/format.ts`（新增纯函数 `formatAgo`）与 `lib/platform.ts`（注释 `1~8` → `1~9`）也在其中，t5 的正文没点名但数量对得上。

## 6. 未能验证的部分（明确列出，不含糊）

1. **真实执行一次 `npm i -g pnpm` / `npm i -g @deepseek-ai/dsh`**：会改这台机器的全局 npm 目录、需要联网，
   验证者不做这种破坏性动作。因此「跑完自动复检 → report 里那一行变绿」「`message` 的两种收尾」
   「插件页重读 `pluginInspect()` 后 `pnpm.found` 变真」只有静态证据（代码路径 + 反例入参），**没有真机证据**。
2. **需要真实 Electron + GUI 的交互，全部未实测**：应用启动 1.5 秒后那轮后台探测；`env:check` / `env:fix` /
   `env:fix-cancel` 三个 handler 与 `env:fix-state` / `env:fix-output` 两条事件的**实际推送**；
   确认区的展开与二次确认、流式输出的尾部 64 KB 与自动滚动、运行中「中断」、`navigator.clipboard` 复制、
   统计与新文案、「上次检查 x 分钟前」的走字、控制台横幅点击后的切页 + 锚点滚动、插件页按钮点击后的切页与展开、
   终端里按 `Ctrl+9` 是否真的换页（静态已确认 `passAppShortcutsThrough` 放行）。
   沙箱里跑不了 Electron（`app.requestSingleInstanceLock` / 单实例 / 原生窗口），无法替代。
3. **渲染层构建产物**：`npm run build:renderer` / `npx tsx scripts/build.mts` 都因 esbuild 的
   `spawn EPERM` 起不来（平台限制，与本次改动无关）。所以「单文件普通脚本产物」这条只由仓库既有自检的静态断言覆盖，
   验证者没有真正产出过 `dist/renderer`。`vue-tsc --noEmit` 与 13 个 SFC 的类型检查是**替代证据**，不等于构建通过。
4. **非 Windows 运行时**：`platform: 'darwin'` 的分支用纯函数入参验证了（`npmLaunchSpec` 直传、`installNodeHint` /
   `upgradeNodeHint` 的平台文案），但真实 macOS 上的 `findNodeExe` / `findPnpm` / `COMSPEC` 路径未验证。
5. **`npm test` 本体**：沙箱里不可用，用 `node test/selftest.js`（同一份编译产物）等价替代；
   两者唯一差别是 tsx 的即时转译，不影响断言结果。
6. **设计文档第 6 节建议断言的第 21、22 条当时没有实现** —— **收口时已补齐**（见第 7 节 V-4 与「收口后的状态」），
   现在 `test/selftest.ts` 里有「渲染层的标题映射覆盖全部八个 id」与「一键修复只在有 fixAction 时给按钮，
   且必须经过一次页内确认」两条；#21 的类型面另由 `Record<EnvCheckId, string>` + `vue-tsc` 保证。

## 7. 发现的偏差与缺口（都不阻塞）

| id  | 严重度 | 问题                                                                                                                                                                                       | 建议（收口阶段）                                                                                                                                                                                                     |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V-1 | 低     | **文档缺陷（任务已认定的那一处）**：`docs/env-doctor.md` 3.3 / 4.2 写「主进程推 `env:report` 事件」，契约里没有 `onEnvReport`、实现也没有推（实测 `src/` 里出现该事件名的文件 0 个）       | 把两处改成「`envCheck()` 拉取 + `EnvFixState.report` 复检」，与 `lib/env-doctor.ts` 的注释保持一致                                                                                                                   |
| V-2 | 低     | 文档 1.2 只写了 `node-version` 的 `ok` / `warn` 两档；实现里「外部 Node 都没找到」时判 `missing`（自检第 11 组断言 `counts.missing === 2` 已把这个选择钉住）                               | 在文档 1.2 补一句这个分支（现在是「文档未定义、实现自定」）                                                                                                                                                          |
| V-3 | 低     | 文档 1.6 只写了 `ok` / `missing` / `warn` 的四个分支；实现里「dsh 本体还没定位到」时判 `warn`（自检也覆盖）                                                                                | 同上，补一句                                                                                                                                                                                                         |
| V-4 | 低     | 设计文档第 6 节建议的第 21、22 条自检断言（渲染层八个 id 的标题映射覆盖、一键修复按钮必须在确认后才调用 `envFix(`）**当时没有实现**；本节的 1–19 条（19 条）与第 20 条（复用既有三条）都在 | **已实现**：见 `test/selftest.ts` 的「环境自检」小节 —— 「渲染层的标题映射覆盖全部八个 id（写成 `Record<string, string>` 就会漏）」「一键修复只在有 `fixAction` 时给按钮，且必须经过一次页内确认」两条例外都已进自检 |

### 收口后的状态（t9 / t16 / t17 之后，现测）

上面四条是**当时那一轮**发现的缺口；收口阶段逐条处理，现在的状态是：

| id  | 状态         | 收口时的处置                                                                                                                                                            |
| --- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V-1 | **已改文档** | `docs/env-doctor.md` 里 5 处「推 `env:report`」全部改成「`envCheck()` 拉取 + `EnvFixState.report`」，并明确写「契约里没有 `onEnvReport`」；`onEnvReport` 的提法一并删掉 |
| V-2 | **已改文档** | 文档 1.2 补上「第 1 项就没找到外部 Node → `missing`」这个分支与理由                                                                                                     |
| V-3 | **已改文档** | 文档 1.6 补上「第 5 项没定位到 dsh → `warn`」这个分支与理由                                                                                                             |
| V-4 | **已实现**   | 两条断言进 `test/selftest.ts`（见上），设计文档第 6 节也同步成与实现一一对应                                                                                            |

另外几处**这一轮之后才出现的事实**也一并记在这里，免得后人拿旧数字对不上：

- **F1（Windows 把 `npm` 认成不可执行的 sh 脚本）已修**：`whichSync()` 在 win32 上只按 `PATHEXT` 找带扩展名的；
  启动统一经 `process-utils.ts` 的 `launchSpec()` / `dshLaunchSpec()` 包装（`.cmd` → `cmd.exe` + 单条已加引号命令行 +
  `windowsVerbatimArguments: true`）。自检加了 5 条回归断言，另有 19 条独立反例脚本兜底。
- **`scripts/*-cases.mjs` 被门禁自动收录**（t17）：`node scripts/selftest-sandbox.mjs` 即包含全部反例脚本，
  显式参数仍可作为补充（合并去重、按名排序）；约定为空不是错误。
- **`install-pnpm` 的 argv 与收尾链在阶段二收口时变了**（t31 / t37）：现在带一次性的 install-scripts 开关
  （`--allow-scripts=pnpm`，不写用户全局配置）并按 VC++ 运行库在不在选 pnpm 那条线（缺 → 纯 JS 的 `pnpm@10`）；
  收尾是「刷新查找路径（重读注册表 PATH + 重扫已知目录 + `npm prefix -g` 排最前）→ 复检 → `<pnpm> -v`
  功能实测（有输出才算成功）」，没通过就把那次实际执行的命令 / 退出码 / stdout / stderr 落日志。
  **本文 1.5 与 3.1 里「`<npmPath> i -g pnpm`」那类旧写法以 `docs/env-doctor.md` 3.1 / 3.4 为准**（那一节是现测的）。
- **反例脚本现在是 20 条**（收口时 19 条）：第四轮为 **case G** 加了一条 —— 逐字钉住
  `… i -g pnpm --allow-scripts=pnpm` 与「计划里的 `target` 由调用方补、纯函数不跑 `npm prefix`」。
- **第四轮在最终树上复测**（t34）：**242/242 + 20/20 + 150/150**、四道门禁全 0、清理 40 删 40 且 0 残留；
  细节与原始日志见 `docs/env-wizard-verification.md` 开头的 t34 补记。

## 8. 复现步骤（从零到本文结论）

```bash
cd <repo>
node scripts/selftest-sandbox.mjs            # 编译 + 自检 + 自动收录的反例脚本 + 清理 + git status（本文那一轮：180/180、19/19、exit 0；最终树现测 242/242、20/20，见文首补记）
npm run typecheck && npm run lint && npm run format:check        # 另外三道门禁
git status --porcelain                       # 确认只剩本次功能相关改动
```

`scripts/env-doctor-cases.mjs` 也可以单独跑（树里没有编译产物时它自己编一份到 `.verify/cases-build`，不碰 `src/`）：

```bash
node scripts/env-doctor-cases.mjs        # 打印 19 条反例的实际输出与观察项（本文那一轮 19/19；最终树 20 条、现测 20/20）
```
