# AGENTS.md — 开发说明（给人，也给 AI）

**改这个仓库之前先读这一份。** 它讲的是「怎么跑起来、代码在哪、有哪些约定与坑、怎么测、怎么发版」。面向使用者的介绍（这是什么、怎么装、怎么用、有哪些设置）在 [`README.md`](README.md) —— 那份里不要写只有开发时才关心的事，这份里不要重复产品介绍。

下面每一句都应该能在仓库里核对：命令与 `package.json` 一致，路径真实存在，结论能从源码 / 配置 / CI 读出来。拿不准的地方先查证再动，不要猜。

## 1. 快速开始

需要 **Node ≥ 20.19**（`vite` 的 `engines` 是 `^20.19.0 || >=22.12.0`；CI 与 release 都固定用 **Node 24**，理由见 §6）。
注意这是**构建期**要求，跟「dsh 能不能跑」是两句区间：后者是 `^22.19.0 || >=24.0.0`（而且判据要读**本机装的那一份**，见 §7.26）。

```bash
npm install
npm start          # = npm run build && electron .
```

`npm start` 会先全量构建再启动 Electron。开发时按你正在改哪一层，开对应的 watch：

| 命令                    | 作用                                                                                           | 什么时候用                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `npm run build`         | 全量构建：渲染层（`vite build`）+ 主进程 / preload / shared（`tsc -p tsconfig.main.json`）     | 改完想跑一次完整验证                          |
| `npm start`             | 先 `build` 再 `electron .`                                                                     | 启动应用                                      |
| `npm run watch`         | 只跑 `vite build --watch`；产物变化后应用里的监听会**自动重载窗口**                            | 改 `src/renderer/`                            |
| `npm run watch:main`    | 只跑 `tsc -p tsconfig.main.json --watch`；**要重启应用才生效**                                 | 改 `src/main/`、`src/preload/`、`src/shared/` |
| `npm run build:sandbox` | `tsx scripts/build.mts`：受限环境（禁止带管道 stdio 的子进程）下跑构建的包装，普通开发机不需要 | 在禁止 `spawn` 管道的沙箱里构建时             |

`app.requestSingleInstanceLock()` 让应用是**单实例**的：已经有一个实例在跑时，第二个进程会立刻退出并把旧窗口提到前面。所以在开发态验证界面时，用独立的 `DSH_CONSOLE_USER_DATA`（见第 8 节）避免与正在运行的实例互相干扰。

## 2. 目录结构与架构

两个进程：**Electron 主进程**（Node，管窗口、dsh 进程、PTY、文件与 IPC）与**渲染层**（Chromium 里的 Vue 3 应用，只通过 preload 暴露的 API 与主进程说话）。`src/` 下全部是 TypeScript。

```
src/
  main/                 Electron 主进程，tsc 编成 CJS 到 dist/main/
    main.ts             窗口、IPC、生命周期、退出清理、关闭窗口行为（询问 / 收起托盘 / 直接退出）、开发工具快捷键、内嵌页诊断
    dsh-manager.ts      dsh 进程状态机：启动 / 停止 / 接管 / 健康轮询 / 令牌 URL 捕获
    pty-sessions.ts     node-pty 会话注册表（dsh 终端 + 本地 Shell 共用）
    process-utils.ts    命令探测、端口占用、进程名、结束进程树、HTTP 探测、ANSI 清理，以及**启动 spec 的公共件**（LaunchSpec / launchSpec / dshLaunchSpec / isRunnablePath）
    settings.ts         settings.json 读写（含 v1→v2 一次性迁移）
    logger.ts           主进程日志：console 同时落盘到 <userData>/logs/console.log
    updater.ts          自动更新状态机（electron-updater）：检查 / 下载 / 安装
    env-doctor.ts       运行环境自检：只读探测 + 纯函数判定（含门禁判定 judgeWizard / 快速探测）+ 一键修复（装 pnpm / dsh，见 7.20、7.21）
    node-installer.ts   系统级安装与更新执行：Node 的两条路（官方 MSI / nvm-windows）、下载与校验、提权、复检（见 7.21）
    session-archive.ts  归档会话：读写 DSH 的 workspace.json 与投影缓存
    plugin-manager.ts   插件装配层：profile 的 bundle 层栈 + `dsh web --dump-config` 的解析（含 stderr 上的"没报错的错"）
    patch-layer.ts      改你自己的补丁层（cordis.patch.yml）：插入 / 禁用 / 启用 / 移除插入 / 删掉失效条目，按行改 + 先备份 + 原子写
    profile-bundles.ts  救援用：临时停用 / 恢复一个 bundle（改 dsh.profile.bundles，记住原位置）
    safe-file.ts        写用户文件的公共件：先备份（.bak-<时间戳>）再原子写（tmp + rename）
  preload/preload.ts    contextBridge，把受限 API 暴露成 window.dshConsole
  shared/ipc.ts         主进程 ↔ 渲染层的**契约类型**（单一来源）
  renderer/             Vue 3 + Vite，产物 dist/renderer/
    index.html          页面骨架：七个页面容器 + 挂载点 + 门禁层容器 + 环境自检详情层 + 启动锁 + 内联图标精灵
    main.ts             入口：样式导入顺序 → app.ts → 建立共享状态 → 挂载
    app.ts              应用级胶水：启动守卫、启动锁状态机、门禁改道（gateDiversion）、自动打开、快捷键
    mount.ts            挂载清单：外壳三块 + 全部页面 + 门禁层与横幅
    dev-diagnostics.ts  开发期诊断：把元素结构导出到日志
    lib/                共享状态与纯逻辑（store / platform / xterm / markdown / env-doctor / env-wizard / boot-lock / …）
    shell/              外壳组件：RailNav / TopBar / StatusBar / CloseDialog（自己 Teleport 到 body）+ EnvGate（门禁层）/ GateBanner（常驻横幅）
    panes/              七个页面组件（第二页 TerminalPane = 终端：一条会话条带 dsh 终端与各本地
                         Shell，dsh 那一路是它的子组件 DshTerminal；EnvPane = 环境自检，它不再是
                         页面，而是设置页「运行环境」卡的详情视图，见 7.30）
test/selftest.ts        313 项自检（`npm test`），不需要 Electron
tools/                  changelog-extract.mts / release-prepare.mts / release-notes.mts / make-icon.mts
scripts/build.mts       受限环境用的构建包装（`npm run build:sandbox`）
scripts/selftest-sandbox.mjs  受限环境用的自检门禁：编译 + 自检 + 清理，见第 5 节
scripts/env-doctor-cases.mjs  环境自检的独立反例脚本（纯函数夹具，32 条）—— 按约定放在这里、以 `-cases.mjs` 结尾，沙箱门禁与 CI 都会自动收录（第 5 节）
scripts/env-wizard-cases.mjs  环境向导的独立反例脚本（门禁判定 + 安装引擎纯函数 + 逃生口，185 条）—— 同上，沙箱门禁与 CI 都会自动收录
.changeset/             每条改动一个片段；config.json 里 changelog: false
vite.config.mts         渲染层构建配置（Vite + Vue，产物到 dist/renderer）
tsconfig.*.json         三份配置，见第 3 节
eslint.config.mjs       ESLint（只管正确性，见第 4 节）
.prettierrc.json        格式的唯一事实来源
.husky/pre-commit       提交前钩子（lint-staged）
.github/workflows/      ci.yml（PR / main）与 release.yml（打标签出包）
```

几条架构上的硬约定：

- **`src/shared/ipc.ts` 是跨进程形状的单一来源**：只放类型与纯常量，**禁止 import 任何运行时依赖**（渲染层要读这些类型，引入 `fs` / `path` 就会被拖进浏览器包）。加设置项要动两处：这里与 `main/settings.ts` 的 `DEFAULTS`；两边不一致时 `tsc` 直接报错，不会悄悄漂移。
- **主进程 / preload / shared 由 tsc 直出 CJS**（`tsconfig.main.json` 的 `rootDir=src`、`outDir=dist`）：产物与源码一一对应（`src/main/main.ts → dist/main/main.js`），`main.ts` 里的相对路径（preload、`dist/renderer`、`build/icon.png`）编译后依然成立，**不需要为了打包改写业务代码** —— 这也是选 tsc 而不是 bundler 的主要原因。
- **渲染层由 Vite 打包成单个自包含的普通脚本**（见下）。
- **共享状态只有一份**：`lib/store.ts` 做唯一的 `getSnapshot` + `onState` + `onTheme` + `onFullscreen` 订阅。`startStore()` 必须缓存 **Promise** 而不是 boolean：入口 `void startStore()` 先发起、组件挂载后再 `await startStore()`，只判断 boolean 的话第二次会立刻返回，组件在快照还是 `null` 时就去读（踩过：事件日志首个挂载是空的）。
- **门禁层是一个覆盖层，不是第 8 个页面**：它盖住左栏 / 页面 / 状态栏（顶栏留着好拖窗口），`--z-gate`（58）低于启动锁（60）。做成页面就能用 `Ctrl+2` 切走，硬门禁就没意义了。三层职责分得很清楚：`shared/ipc.ts` 定形状、`main/env-doctor.ts` 的 `judgeWizard` 是**纯判定**、`main/node-installer.ts` 只负责"把系统改对"，`renderer/lib/env-wizard.ts` 管相位与显示（见 7.21）。
- **模块边界（阶段二定下来的三条线，别越界）**：安装引擎 = `main/node-installer.ts` + `main/process-utils.ts`；契约与编排 = `shared/ipc.ts`、`preload/`、`main/{env-doctor,main,settings}.ts`、`renderer/{app.ts,lib/**}`、`test/selftest.ts`；渲染层 = `renderer/{panes/**,shell/**,mount.ts,index.html,styles.css}`。渲染层**不许** import `src/main/**`（Vite 会把它拖进那一个自包含产物）；安装引擎**不许** import `env-doctor` / `dsh-manager`（要复检、要停 dsh 就注入钩子，这样它能离线测）。

**一次启动的数据流**：主进程 `bootstrap()` 读 `Settings` → `DshManager.start()`（探测端口 → 解析启动命令 → 在 PTY 里拉起 dsh → 轮询健康检查 → 从输出里捕获带令牌的地址）→ 任何状态变化都 `emitState()` 推给渲染层；渲染层 `startStore()` 拉一次全量快照后靠 `onState` / `onTheme` / `onFullscreen` 接收增量，外壳与页面读同一份响应式状态。主进程到渲染层的**唯一**通道是 preload 暴露的 `window.dshConsole`（形状见 `shared/ipc.ts` 的 `DshConsoleApi`）。启动后 1.5 秒另有一轮**只读**的运行环境自检在后台跑（`main/env-doctor.ts`，见 7.20）：它不参与启动、不碰 dsh 进程，结果由渲染层 `envCheck()` 拉取。

### 渲染层产物为什么必须是「单个自包含的普通脚本」

Electron 用 `file://` 加载产物，而 ES module 在 `file://` 下会走 CORS 检查（origin 为 `null`）而加载失败。所以 `vite.config.mts` 里：

- `classicScriptPlugin()` 把产物里的 `<script type="module">` 改回 `<script defer>`，并去掉 `crossorigin`（`file://` 下带它的样式表同样会走 CORS）；
- `build.modulePreload: false`，避免注入 `<link rel="modulepreload">`；`rollupOptions.output.codeSplitting: false`，**不切分** —— 跨 chunk 就必须用模块语法；`base: './'`，产物要被以相对路径打开。

推论：**入口 `src/renderer/main.ts` 不能用动态 `import()`** —— 那会切出第二个 chunk，产物就不能是单文件普通脚本了。开发诊断因此写成「静态 import + 运行时判断」（`if (!snapshot.value?.env?.packaged) installDevDiagnostics()`）。自检「构建：产物走普通脚本（file:// 兼容）」与「构建：入口不用动态 import（否则产物跨 chunk 必须用模块语法）」守着这两条。

## 3. 命令一览

| 命令                            | 作用                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run build`                 | `build:renderer` + `build:main`                                                         |
| `npm run build:renderer`        | `vite build`                                                                            |
| `npm run build:main`            | `tsc -p tsconfig.main.json`                                                             |
| `npm test`                      | `tsx test/selftest.ts`（313 项，不需要 Electron、不启停任何进程）                       |
| `npm run lint`                  | ESLint 全量（含 Vue 单文件组件）                                                        |
| `npm run lint:fix`              | 同上，顺带修可自动修的问题                                                              |
| `npm run format`                | Prettier 全量格式化                                                                     |
| `npm run format:check`          | 只检查不改写                                                                            |
| `npm run typecheck`             | `typecheck:main` && `typecheck:renderer` && `typecheck:node`                            |
| `npm run changeset`             | = `changeset add`，加一个变更片段                                                       |
| `npm run release:check`         | `changeset status --since=origin/main`，本地复现 PR 上的闸门                            |
| `npm run release:prepare`       | 汇总片段成 CHANGELOG 条目（见第 6 节）；`--topic` 写 Release 标题、`--dry-run` 只看不改 |
| `npm run pack:win` / `dist:win` | 只产出目录版 / 产出 NSIS + 便携版 exe                                                   |
| `npm run pack:mac` / `dist:mac` | 只产出 .app / 产出 dmg + zip                                                            |

三份 tsconfig 各管什么：

| 配置                     | 覆盖                                                                        | 谁在跑                                         |
| ------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------- |
| `tsconfig.base.json`     | 共用编译选项：`target ES2023`、`module/moduleResolution NodeNext`、`strict` | 被下面三份 `extends`                           |
| `tsconfig.main.json`     | `src/main` + `src/preload` + `src/shared`，`rootDir=src`、`outDir=dist`     | `build:main` / `typecheck:main`（tsc，出 CJS） |
| `tsconfig.renderer.json` | `src/renderer` + `src/shared`，`moduleResolution: Bundler`、`noEmit`        | `vue-tsc`（它才看得懂 `.vue`）                 |
| `tsconfig.node.json`     | `test` + `tools` + `scripts` + `vite.config.mts`，`noEmit`                  | `tsc`（这些文件由 tsx / Vite 直接执行）        |

## 4. 代码约定

**TypeScript 迁移已完成**：`src/`、`test/`、`tools/` 全是 TypeScript，仓库里没有手写的 `.js` 源码。类型**不放宽**：`tsconfig.base.json` 开了 `strict`，且仓库里没有 `as any` / `: any` / 非空断言；需要兜 `JSON.parse` 的 `any` 时用最小 `interface`（例如 `test/selftest.ts` 里的 `PackageJson`）。

**`.mts` 与 `.ts` 的区别**：`package.json` 没有 `"type": "module"`，所以 NodeNext 下 `.ts` 会被编译成 CommonJS（这正是主进程需要的运行形态，源码仍写标准 ESM 语法）；而 `.mts` **按扩展名永远是 ESM**，用于「由 `tsx` / Vite 直接执行、不经过 tsc 产物」的文件 —— `tools/*.mts`、`scripts/*.mts`、`vite.config.mts` 都属于这一类。想加工具脚本时按这个规则选扩展名。

**格式：Prettier 是唯一事实来源**。`.prettierrc.json` 定义了全部规则，硬约定是：语句结尾要有分号（`semi: true`）、多行数组 / 对象 / 参数的最后一项后要有尾随逗号（`trailingComma: "all"`）、字符串用单引号（`singleQuote: true`）、换行一律 LF（`endOfLine: "lf"`，配合 `.gitattributes` 的 `* text=auto eol=lf`）。有意改掉默认值的只有 `printWidth: 100`（默认 80）与 `singleQuote: true`（默认双引号）；其余键写出来不是为改行为，而是把当前默认值钉死 —— `semi` / `trailingComma` 明写就不会被哪次「顺手关掉」而没人发现，`singleAttributePerLine` / `vueIndentScriptAndStyle` 一旦跟着默认值变化，单文件组件会被整体重排、diff 就没法 review。

**ESLint 只管正确性，不管格式**。`eslint.config.mjs` 的基础是 `js.configs.recommended` + `eslint-plugin-vue` 的 `flat/recommended`，**最后接 `eslint-config-prettier`** —— 它把所有与 Prettier 冲突的格式规则关掉。所以这里搜不到 `semi` / `comma-dangle` 是**故意的**：格式只由 Prettier 一家负责，两边都开会让两个 `--fix` 互相打架。有意关掉的两条规则及理由写在配置里：`no-control-regex`（本项目的领域就是 ANSI 控制序列与内部占位符，都是显式字面量）与 `vue/attributes-order`（模板里 `class` 写在最前是既定写法，Prettier 也不重排属性）。目前用的是**不带类型信息**的 TS 规则集（`recommended`）；要打开 `recommendedTypeChecked` 是独立的一步，不要顺手一起开。

**提交信息**用 Conventional Commits 风格，scope 可选，例如 `fix(ui): …`、`refactor(ts): …`、`ci:`、`docs:`、`style:`、`chore:`（看 `git log` 的实际用法）。

## 5. 改一处代码要跑什么

```bash
npm test
npm run lint && npm run format:check && npm run typecheck
```

- `husky` 的 `pre-commit` 只跑 **`lint-staged`**：仅处理**这次改到的文件**（先 `eslint --fix`、再 `prettier --write`），不碰没动过的文件。
- **全量检查在 PR 的 `ci.yml`**：`.github/workflows/ci.yml` 的 `check` job 跑 `npm ci`、`npm test`、`npm run lint && npm run format:check && npm run typecheck`，外加「本次改动要带 changeset 片段」的闸门。打标签出包时 `release.yml` 的两个 build job 会**再跑一遍**同一套（要发出去的东西自己证明合规）。
- 别用 `git commit --no-verify` 绕过钩子（它跳过的只是本地这次检查，CI 那一关照样在）。
- 改 `src/renderer/` 后要**构建才生效**；改 `src/main` / `src/preload` / `src/shared` 后要重新编译并**重启应用**（`npm run watch:main` 只编译，不会替你重启）。

**受限环境里的自检**（和 `npm run build:sandbox` 同构）：`npm test` 是 `tsx test/selftest.ts`，而 tsx 要经 esbuild 的**带管道子进程** —— 禁止 `spawn` 管道的沙箱里它根本起不来（这不是被测代码的问题）。等价路径是把「编译 → 自检 → 清理」三步交给一个可重复入口（它按 tsc 自己报的 `TSFILE:` 行拿产物清单，只删清单里的路径，**上一次被中断过也能接着跑**）：

```bash
node scripts/selftest-sandbox.mjs                                # 门禁：编译 + 自检 +（自动收录的反例脚本）+ 清理
node scripts/selftest-sandbox.mjs scripts/env-doctor-cases.mjs   # 也可以显式点名要跑的脚本（与自动收录的合并去重）
```

**额外检查脚本的约定**：门禁会**自动收录 `scripts/*-cases.mjs`**（按文件名排序、与显式参数合并去重），所以「不带参数」不等于「只跑自检」—— 放一个 `<模块>-cases.mjs` 到 `scripts/` 下就会被每一轮门禁跑到，不必再手写一次命令行。**约定为空**（`scripts/` 里一个都没有）**不是错误**，门禁照常通过。

它的原始输出与「上一轮产物清单」落在 `.verify/selftest-sandbox/`（该目录被 git / eslint / prettier 一起忽略）。普通开发机不需要它。

**⚠️ 两条环境性陷阱（不是代码问题，也别去改配置绕开）**：

- **沙箱门禁不能与 `npm run lint` 并发跑**。`node scripts/selftest-sandbox.mjs` 的第一步是**编译**，它跑的是
  `tsc -p tsconfig.node.json --noEmit false --listEmittedFiles` —— `noEmit` 被显式关掉、且这个配置**没有 `outDir`**，
  于是程序里被 import 到的 `src/**` 也会**就地**生成 `.js`（`.verify/selftest-sandbox/tsc.log` 里的 `TSFILE:` 行就是：
  `src/shared/ipc.js`、`src/main/dsh-manager.js`、`src/renderer/lib/{env-detail,wizard-view}.js`（selftest 也 import 它们）、…，共 44 个），编译完由清理段按清单删掉。而 eslint 的扫描面是
  「仓库根下它能解析的所有 `.js` / `.ts` / `.vue`」，**包含这些中途产物**：两者并发时 `no-undef`
  （`exports` / `require` / `process` / `console` / `__dirname`）会成片爆出来 —— **本轮实测 516 条；树安静之后串行重跑 = 0**。
  - **正确做法**：**串行跑** —— 沙箱门禁跑完（清理段把清单里的路径删干净）**之后**再 `npm run lint`；
    或者动手前先确认 `src` 下没有就地产物：`Get-ChildItem src -Recurse -Include *.js,*.js.map` 数出来应当是 **0**。
  - **不要去给 eslint 加 ignore 绕开**：`eslint.config.mjs` 的忽略清单里已经有 `dist/**`、`release/**`、`build/**`、
    `.verify/**`、`node_modules/**`、`.build-home/**`，而**故意没有 `src/**`** —— 加上它，一次「手写或误留的 `.js` 混进 `src/`」
    就永久不可见了，而那种文件正是 §4「`src/`、`test/`、`tools/` 全是 TypeScript，仓库里没有手写的 `.js` 源码」这条约定的反面。
    这批 `.js` 是**中途产物**，正确状态是「树安静时一个都不存在」，不是「让 linter 别看它」。
  - **另一种表现同源**：门禁被中断（或上一次跑了一半）时也会留下就地产物 —— 那正是它能「接着跑」的机制（按 `TSFILE:` 清单删）。
    所以看到 `no-undef` 成片时先按上面两条排查，**不要先怀疑代码**；也确实不需要任何"清理脚本"以外的动作。
- **测量 / 门禁期间不要并发改树**（本轮与前几轮都撞过同类竞态）：**结论必须绑在一个冻结的修订上**。
  一边跑门禁（或一边改源码、一边跑对照测量）一边改别的文件时，绿 / 红会落在**中间态**上 ——
  表现是「同一棵树两次跑出不同结论」「报错的行号与刚改的内容对不上」「断言数与上一条日志不一致」。
  **做法**：跑门禁 / 取数之前先停手（同一个工作区里的其它成员也一样），要留证据就先记下关键文件的**哈希与行数**
  （前几轮验证就是这么做的：定格前后各记一份，结论绑在那个哈希上），跑完再继续改；
  `git status` 里出现你不认识的新改动时，先查清是谁写的，**别把它算进这一次的结论**。

## 6. 变更记录与发版

`CHANGELOG.md` **不手写**：每条改动在 `.changeset/` 里放一个**片段**，发版前汇总成它的新条目。

```bash
# 1. 开发过程中：每处要发版的改动都带一个片段（PR 上的闸门会检查）
npx changeset add                 # 交互式：选 patch/minor/major + 写说明（= npm run changeset）
#    纯 CI / 纯文档这类不需要进 CHANGELOG 的改动：npx changeset add --empty

# 2. 发版：把片段汇总出来
npm run release:prepare -- --topic "一句话主题"   # --dry-run 只看不改；--topic 会成为 Release 标题
#    ↑ 算出版本号 → 写 CHANGELOG.md 条目 → 改 package.json → 删掉已汇总的片段

# 3. 提交 + 打标签 + 推（推标签即触发 CI 出包）
git add -A && git commit -m "chore: 发布 0.2.3"
git tag v0.2.3 && git push origin main --tags
```

片段就是 changesets 的标准形状（正文会**原样**成为 CHANGELOG 里那一条，所以可以自带 `### 小节`）：

```md
---
'dsh-console': patch
---

状态栏的快捷键提示还停在 1~6，实际已经有 7 个页面
```

**为什么不用现成的 `changeset version`**：它写出来的标题是 `## x.y.z`（既没方括号也没日期），而本仓库的契约是 `## [x.y.z] - YYYY-MM-DD` —— `tools/changelog-extract.mts` 按它取 Release 正文，自检里也有断言。所以只借 changesets 的两样东西：**片段约定**与 **`changeset status` 闸门**；汇总由 `tools/release-prepare.mts` 做，版本规则与 changesets 一致（取所有片段里最高的一级：0.2.2 + patch → 0.2.3、+ minor → 0.3.0、+ major → 1.0.0）。`.changeset/config.json` 里因此写着 `changelog: false`。

**Release 的标题与正文由 `tools/release-notes.mts` 生成**（模板不写在 CI 的 YAML 里，因为它要按版本号替换产物名）：

- **标题** = `v<版本>: <主题>`（例如 `v0.3.0: TypeScript 迁移与工具链整理`），主题来自 CHANGELOG 标题行末尾的 `: …`（`release:prepare --topic "…"` 写进去；早期条目写的 `—— …` 也认）。没写主题就退化成 `v<版本>`，不算错。
- **正文** = CHANGELOG 里这一版的条目（去掉标题行，H1 已经写了版本与主题）+ 一段按**真实产物清单**生成的「安装」表（publish job 把 `ls assets` 传给 `--assets`）—— 产物名不手写，改了 `productName` 或换 electron-builder 都不会让正文与实际文件对不上。
- **两道失败闸门**：条目缺失、或四类核心产物（Windows 安装包 + 便携版、macOS 的 arm64 / x64 dmg）不齐 → 非零退出。后一条是 v0.2.0 的教训：那次 Release 的说明里让用户下 Windows 包，页面上却没有。自检「发布正文：…」六条钉住标题格式、产物分类与这道闸门，「发布：CHANGELOG.md 有当前版本的条目」钉住条目本身。

### `release.yml` 的两个 job 与产物

- **`build-windows` / `build-macos`**：各在 `windows-latest` / `macos-latest` 上（**Node 24**，与 `ci.yml` 同一个版本）`npm ci` → `npm test` → `lint && format:check && typecheck` → `npm run build` → `electron-builder --win|--mac --publish never`，产物挂成 Artifacts。为什么钉 24：**应用自己的运行时就是 Node 24**（Electron 44 内置 Node 24.20，见快照里的 `env.versions`），用同一个大版本构建/打包，最不容易出现「CI 上好好的、用户机器上是另一回事」；`publish` 那个 job 只跑 `npx tsx`、不 `npm ci`，但也**显式钉了 Node 24**（不钉跑的就是 runner 的默认那个，说不清是哪个版本）。**不加 `--config.npmRebuild=false`**：runner 上有 C++ 工具链，让 electron-builder 对着打包用的 Electron 版本重编 node-pty 才对（node-pty 是 N-API，跨 Electron 大版本不用改代码）。
- **`publish`**（仅在标签构建时跑）：收齐两边产物 → `tools/release-notes.mts` 生成标题与正文（`--assets` 吃 `ls assets` 的输出）→ `gh release create --draft --title "$(cat .release/title.txt)" --notes-file .release/notes.md`（已存在就只补产物、正文不动）→ `gh release upload --clobber`。产物是 Windows 的 NSIS 安装包 + 便携版 exe、macOS 的 arm64 / x64 dmg 与 zip，外加 `latest.yml` / `latest-mac.yml` 与 `*.blockmap` —— 这些就是**自动更新（electron-updater）的更新源**：Windows 版按 `latest.yml` 检查与下载增量包，`*.blockmap` 是差分索引。手动触发 `release` 工作流则**只构建、不发版**，产物在 Artifacts 里。
- **Actions 的版本：一律取「声明 `runs.using: node24`」的那一档**（现在是 `actions/checkout@v7`、`actions/setup-node@v7`、`actions/upload-artifact@v7`、`actions/download-artifact@v8`）。老的 `@v4` 跑在 Node 20 上，GitHub 已经会打警告 —— 「Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24」（2026-09 手动跑一次 `release` 就能在 Annotations 里看到）。升级时**逐条核对两件事**（都能从 action 自己的 `action.yml` 里读出来，别猜）：`runs.using` 是 `node24`；我们用到的那几个 input 还在（checkout 的 `fetch-depth`、setup-node 的 `node-version` / `cache`、upload-artifact 的 `name` / `path` / `retention-days`、download-artifact 的 `path` / `merge-multiple`）。这几个大版本要求 runner ≥ 2.327.1（GitHub 托管的 runner 都满足）。
- **为什么打包与发布拆成不同 job**：v0.2.0 时两个 runner 各自 `electron-builder --publish always`，并发调 `getOrCreateRelease()` 都发现「没有 release」就各建一个，Windows 的安装包与 `latest.yml` 因此没传上去；更麻烦的是 electron-builder 默认 `releaseType=draft`，release 一旦被人点成「已发布」，后续上传会被**静默跳过**（步骤显示成功，只在日志里 warn）。现在草稿由 `gh release create` 自己建、产物用 `gh release upload --clobber` 传，重跑可以放心覆盖同名产物。**推论：不要改回 `--publish always`，也不要让两个平台各自建 Release。**

**`ci.yml` 的闸门**：PR 与合入 `main` 时跑同一个 `check` job —— `npm ci` → `npm test` → **反例脚本**（`scripts/*-cases.mjs` 按文件名自动收录，与沙箱门禁同一套约定；一个都没有也不算错）→ `lint && format:check && typecheck`；PR 上额外跑 `npx changeset status --since=origin/<base>`，**改了代码却没带片段就失败**。这也是 `npx changeset add --empty` 的用途 —— 放一个空片段当「通行证」，它不产生版本、也不进 CHANGELOG，汇总时自动清掉。

**依赖归属**：`dependencies` 里**只放主进程运行时要 `require` 的包**（现在只有 `node-pty` 与 `electron-updater`）；`vue` / `@xterm/*` / `@fontsource/*` 这类渲染层依赖一律放 `devDependencies` —— 它们已经被 Vite 打进 `dist/renderer`，留在生产依赖里只会被 electron-builder **再拷一份**进 `app.asar`（实测：asar 2.1 MB → 20.2 MB、未压缩 .app 289 MB → 306 MB）。自检「打包：每个生产依赖都真的被主进程 require」与「渲染层依赖在 devDependencies」钉着这条。

**打包相关的配置**（`package.json` 的 `build` 字段）：`asarUnpack: ["**/node_modules/node-pty/**"]`（node-pty 是原生模块，`.node` 与 conpty 的 `OpenConsole.exe` 不能塞进 asar）；`files` 必须包含 `dist/**/*`，`main` 指向编译后的 `dist/main/main.js`，源码不随包分发；两个平台的图标都指向 `build/icon.png`（512×512，由 `npx tsx tools/make-icon.mts` 生成，PNG 编解码是手写的，仓库因此不引图像库）。

**本地打包小贴士**：国内网络下打包会从 GitHub 下载 Electron 运行时与 electron-builder 附加资源，先设镜像（`ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR`，都指向 `https://npmmirror.com/mirrors/...`），否则容易卡在 `connect ETIMEDOUT ...:443`。想跳过原生模块重建（本机 node-pty 已对着同一个 Electron 版本编好时）可以加 `npx electron-builder --mac|--win --config.npmRebuild=false`；**升级 Electron 版本后别跳**，那时 ABI 变了必须重编。

## 7. 容易踩的坑 / 必须守住的契约

这一节按「现象 → 原因 → 现在的做法 → 哪条自检守着它」写。改动相关代码前先读对应小节。

### 7.1 渲染层模块求值顺序（踩过一次，白屏）

`src/renderer/main.ts` 的 import 顺序有语义，别调换：

1. `@xterm/xterm/css/xterm.css` 必须排在 `./styles.css` **之前**：两者对 `.xterm-viewport` 的规则同权重，靠顺序决定谁生效 —— 反了会让 xterm 写死的黑底盖住我们的覆盖（症状：亮色主题下终端底部一块黑）。
2. `./app.js` 要在建立共享状态与挂载之前求值：它一被求值就接上启动锁、快捷键、自动打开这些应用级逻辑；接着 `startStore()` 建立唯一的快照订阅，最后才 `mountAll()` —— 组件一挂上就要读数据。
3. 静态 import 会被提升：想在入口模块体里做赋值去抢在 import 之前是不可能的，那类初始化只能写成一个被 import 的模块。

现状：**没有**一条自检直接断言这份 import 顺序；相邻契约由「渲染层：入口被引入，样式与 xterm 都有来源」（核对入口导入了 `./styles.css`，且 xterm 的来源是 `lib/xterm.ts` 里对 `@xterm/xterm` / `@xterm/addon-fit` 的导入）与「渲染层：xterm 与 addon 用导入的类，不经过 window 全局」守着。

### 7.2 渲染层入口不能动态 import

见第 2 节「渲染层产物为什么必须是单个自包含的普通脚本」。自检「构建：入口不用动态 import（否则产物跨 chunk 必须用模块语法）」守着。

### 7.3 macOS 适配

**红绿灯在窗口左上角，留白要给左栏而不是顶栏**：布局是 `rail | workspace` 两列网格，贴窗口左边的是左栏（`.rail`），顶栏在它右侧 —— 红绿灯根本够不到顶栏。所以：

- `html[data-platform='darwin'] .rail { padding-top: calc(var(--bar-h) + 12px) }`，并把左栏整列设为可拖动区（按钮 `no-drag`）；
- **例外**是应用内全屏：左栏被藏掉后顶栏成了最左边的一列，这时才给顶栏 `padding-left: 84px`（选择器 `html[data-platform='darwin'] body[data-immersive='true'] .topbar`）；
- Windows 的顶栏右侧留白必须写成 `calc(100vw - env(titlebar-area-width))`，**不能用 `100%`** —— `100%` 是顶栏所在容器的宽度，非全屏时那个容器已被左栏切掉 188px，减出来是负数（症状：地址显示成 `http://127.`）；而 macOS 上 `env(titlebar-area-*)` 不生效，那条 calc 会退回兜底的 150px，所以顶栏右侧要用 `html[data-platform='darwin']` 覆盖成普通内边距。
- 平台属性由 `lib/platform.ts` 写入（先用 UA 同步判定，快照到了再用主进程的 `env.platform` 校准）；**首帧的留白不能等 IPC**。标题栏高度在两侧各写一次（CSS 的 `--bar-h` 与主进程的 `TITLEBAR_HEIGHT`，都是 36），**必须一致**，否则系统按钮会和顶栏错位。
- Windows / Linux 上 `Menu.setApplicationMenu(null)`（菜单留空），macOS 上保留最小原生菜单（应用 / 编辑 / 显示 / 窗口），否则 ⌘Q、⌘C/V 会失灵。

**门禁层的左轨是另一条左轨**（`.gate-rail`，`.gate` 从 `top: var(--bar-h)` 起）：窗口模式下它落在
36px 那条带下面（红绿灯就在那条带里），**系统全屏时同样要撤回** —— 让左轨顶到窗口上沿、高度补回那
36px（`margin-top: calc(-1 * var(--bar-h))` + `height: calc(100% + var(--bar-h))`），否则向导页的
左栏会比"没有门禁时"低整整 36px，看着就是左栏上面空一块（用户抓图指出过）。它盖住的应用左栏同底色
（`--rail`）、同一条右缘发丝线，所以接得上；顶栏不在这一列，仍然留在 36px 以下。

自检「渲染层：macOS 红绿灯留白给左栏（两条左轨的让位与撤回 + 应用内全屏让白、系统全屏撤回、非全屏顶栏不缩进）」守着这些状态。

**「系统全屏」与「应用内全屏」是两件事**：

|        | 系统全屏（macOS 绿灯 / ⌃⌘F，Windows F11） | 应用内全屏（Harness 页的「全屏」按钮 / `Esc`） |
| ------ | ----------------------------------------- | ---------------------------------------------- |
| 谁在管 | 操作系统                                  | 应用自己（CSS 认 `body[data-immersive]`）      |
| 效果   | 窗口铺满屏幕，Dock / 菜单栏按系统规则隐藏 | 藏掉左栏、状态栏与页面工具条，只留 36px 顶栏   |
| 红绿灯 | **自动隐藏**，鼠标移到屏幕顶端才出现      | 仍在原位；左栏被藏掉后顶栏要让位               |

系统全屏的状态由主进程用 `window.isFullScreen()` 与 `enter-full-screen` / `leave-full-screen` 事件取得，放进快照的 `env.nativeFullscreen`，并通过 `app:fullscreen` 事件实时推给渲染层；渲染层落到 `body[data-native-fullscreen]`，CSS 据此**撤回**所有为红绿灯预留的空白（系统全屏时红绿灯根本不显示，留着就是一块说不清用途的空白）。自检「渲染层：CSS 用到的 body[data-*] 开关都有人设置」守着这个属性有人写入。

**macOS 的签名：没证书也必须 ad-hoc 签**。`package.json` 里 `mac.identity` 写的是 `"-"`，这不是可选项：

- **不签名的 .app 在 Apple 芯片上根本起不来**。Electron 自带的二进制本来有签名，但 electron-builder 重新打包会改动 bundle 内容，那条签名的封条就失效了 —— 校验时报 `code has no resources but signature indicates they must be present`，系统对这种情况的说法是**「已损坏，无法打开。你应该将它移到废纸篓」**，而不是「未验证的开发者」。
- **别再设 `CSC_IDENTITY_AUTO_DISCOVERY=false`**：那会让 app-builder-lib 的 `isSignAllowed()` 在更早处返回 false，**连 ad-hoc 签名都一起跳过**，回到上面那个坏状态（`release.yml` 里也留了同样的提醒）。ad-hoc + 默认的 `hardenedRuntime` 需要 `com.apple.security.cs.disable-library-validation` entitlement —— electron-builder 的默认 entitlements 模板里已经有了。

自检「构建：macOS 走 ad-hoc 签名，且 CI 没有把签名整个关掉」只做静态检查；**签名本身是打包期行为**，改过打包配置后要本地手动验一次：

```bash
HOME=$PWD/.build-home npx electron-builder --mac --arm64 --dir --config.npmRebuild=false
codesign -dv --verbose=4 "release/mac-arm64/DSH Console.app"            # 期望 Signature=adhoc, flags=…adhoc,runtime
codesign --verify --deep --strict "release/mac-arm64/DSH Console.app"   # 期望 valid on disk / satisfies its Designated Requirement
```

（`HOME=$PWD/.build-home` 只是把 electron-builder 的缓存与临时 HOME 挪到仓库内的临时目录；这个目录在 `.gitignore` 里。）

### 7.4 解释器探测：为什么不信 PATH、要实测

- **dsh 的 CLI 对 Node 版本敏感，不兼容时的表现是静默退出**：退出码 0、零输出、端口上什么都没有。光看退出码永远发现不了，界面上只显示「已停止」，用户完全看不出是解释器的问题。
- 所以候选组合会跑一次 `<node> <bin.js> --version`，**有输出才算可用**（`process-utils.ts` 的 `canRunDsh`；结果按组合缓存，每个进程只测一次）。全部候选都测不过（例如受限环境不允许再起子进程）时退回第一个候选，把问题留给运行期。事件日志对「退出码 0 + 零输出 + 服务从未就绪」这种组合会专门给出提示。
- **为什么不只靠 PATH**：macOS 上从 Finder / Dock 启动的 GUI 应用拿到的 PATH 通常只有 `/usr/bin:/bin:/usr/sbin:/sbin`，nvm / homebrew 装的东西都不在里面，只按 PATH 找就会退到每次都要解析（必要时联网下载）的 `npx -y`。所以解析器会额外扫 nvm / fnm / nodenv 各版本目录、homebrew、`~/.npm-global`、pnpm 全局目录。
- 候选按「最可能可用」排序（`dshInterpreterCandidates`）：PATH 里的 node + shim 反推的 bin.js → 版本管理器里**配套的** `node` + dsh（同一版本目录，新版本优先）→ PATH node + 任意扫到的全局安装 → 其它常见位置的 node + 全局安装。`resolveDshInvocation` 的最终优先级是：**自定义命令 > node + bin.js（实测能跑的组合）> dsh shim > `npx -y`**。
- **自定义命令支持整条命令行**：`dshCommand` 的第一个 token 是可执行文件，其余作为前置参数，我们的 `web --no-open --port …` 追加在后面。这是「换一个能跑 dsh 的 Node」的出口。
- **POSIX 上不自动挑 pwsh**：本地 Shell 的解析是 Windows `pwsh > powershell > cmd`、macOS/Linux `$SHELL > zsh > bash > sh`。装了 PowerShell 的 mac 不少（GitHub 的 macOS runner 就自带），自动挑它会让「新建本地 Shell」开出 PowerShell 而不是用户自己的 zsh；想用 pwsh / fish 就在设置里显式填路径。本地 Shell 以**登录 shell**（`zsh -l`）启动，让 homebrew 之类的 PATH 与终端里一致。

自检：「命令解析：解析出的解释器实测能跑 dsh」「命令解析：PATH 里没有 dsh 也能从全局安装目录找到 bin.js」「命令解析：自定义命令带前置参数（node + 入口脚本）」「命令解析：POSIX 下 .cmd 明确报错而不是假装能跑」「本地 Shell 解析：POSIX 用用户自己的登录 shell（$SHELL 优先，不会是 pwsh）」。

### 7.5 PID 归属与结束进程树

- **不要缓存 `pty.spawn()` 返回时的 pid**：node-pty 在 Windows/ConPTY 下构造时 `pid` 是 `0`，要等 socket 的 `ready_datapipe` 才在同一个 `IPty` 对象上原地更新。也不要写 `if (pid)` 之类的真假值判断 —— `0` 会伪装成「没有进程」。
- 「是否本应用启动」一律用 **pty 会话是否存在**（`DshManager.ownProcess` → 快照里的 `dsh.owned`）判断，界面按钮状态只看这个字段。PID 按需读取；仍未就绪时用**端口占用查询**兜底（Windows 是 `netstat -ano`，macOS 是 `lsof -nP -iTCP:<port> -sTCP:LISTEN`）。
- 结束进程树：Windows 走 `taskkill /PID <pid> /T /F`；macOS/Linux 优先杀自己的进程组（PTY 子进程是组长，`pgid == pid` 时一次 `kill(-pgid, SIGKILL)`），否则按 `pgrep -P` 递归收集后代、按「子先父后」逐个终止 —— 不整组乱杀。

自检：「状态机：PID 尚未就绪（0）时仍认定为本应用启动」「状态机：PTY 就绪后能读到真实 PID」「状态机：会话结束后不再认定为本应用启动」「进程存活判定：不存在的 PID 视为已死」。

### 7.6 `<webview>` 两个「只看得到一小条」的坑

两个独立成因，症状相似：

1. **容器 `display:none`** → guest 以 0 尺寸挂载，切回来时视口还是旧的。修法：全部页面改为 `position:absolute + visibility:hidden` **常驻布局**（`.pane.active { visibility: visible }`），切换时再补一次视口重算。
2. **`<webview>` 自己没写尺寸** → 它是替换元素，漏写 CSS 就退化成浏览器默认的约 300×150，页面上只出现顶部一小条。修法：两个内嵌页共用 `.embedded-view`（`width/height:100%`），**以后新增 webview 必须带上这个 class**。

**推论（踩过）：页面里的元素不要自己写 `visibility: visible`。** `visibility` 是**继承**属性，
`.pane` 靠 `.pane { visibility: hidden }` / `.pane.active { visibility: visible }` 藏整页，而子元素一旦
显式写 `visible`，就会在别的 tab 上"穿"出来 —— 全仓库只该有 `.pane.active` 一处写 visible；要藏某个
分支就给它自己写 `hidden`（写成 `:not(.active)` 这类），别把"显示"写成一条规则（用户抓图：
切到 Harness 页，终端页的本地 Shell 还画在那一页顶上）。自检「渲染层：两路终端共用 .term-body」
里有一条钉子专门盯着这个写法。

自检：「样式：页面容器靠 visibility 隐藏，不用 display:none」与「样式：每个 webview 都有明确高度的样式」。另外 `vite.config.mts` 的 `compilerOptions.isCustomElement` 把 `<webview>` 声明为自定义元素，否则 Vue 编译器会试着把它当组件解析。两个内嵌页用**各自独立且持久**的分区（`persist:dsh-ui` 存令牌 / `persist:deepseek` 存登录态），且主进程在启动时统一抹掉 UA 里的 Electron 标识（`app.userAgentFallback`，不是等 webview 挂上来再改 —— 后者可能晚于该页的第一次请求）。

### 7.7 dsh 终端是**只读输出视图**（有意为之）

`dsh web` 是个服务端进程，**不读 stdin**。所以「dsh 终端」页是输出视图，不是交互式终端 —— 打字没反应是 dsh 的行为，不是界面坏了。这条设计决定带来几个具体做法：

- 页面上方常驻一句说明；没有进程时显示空状态并直接给「启动 dsh」按钮。唯一有意义的键盘输入是 **Ctrl+C**（往 PTY 写 `\x03`）。退出时终端里补一行灰字（`── dsh 已退出（退出码 0）──`），本地 Shell 同样。
- 两个按钮用用户语言：「清空显示」只清当前画面（输出仍在主进程缓冲里）；「重新显示历史」把缓冲（最近 512 KB）重画一遍。
- 尺寸自动跟随容器（`ResizeObserver` + 切页时 fit），没有「自适应」按钮；拖动窗口时会逐帧触发 `ResizeObserver`，所以加了道闸：**只在行列数真的变了才通知主进程**，避免刷爆 IPC。

### 7.8 共享状态、挂载与 xterm

- **每个组件都必须有人用**：要么挂在 `mount.ts` 的挂载清单里，要么被别的组件 `import`（t45 起「终端」页就有个子组件 `DshTerminal`，它不该出现在挂载清单里）。两种都不占的组件等于死代码。自检「渲染层：每个 .vue 组件都被用到（在挂载清单里，或被别的组件 import）」与「渲染层：外壳与页面的挂载点都在」守着。
- **挂载点必须是 `display: contents`**（见 `styles.css`）：漏一个就会把父级的 flex/grid 链断掉，`flex: 1` 全部失效 —— 症状是内嵌页只剩顶上一条。自检「渲染层：每个挂载点都是 display: contents」守着。
- **xterm 独占的元素里不能有 Vue 管理的子节点**：两边往同一块 DOM 里塞东西会打架。所以终端挂在 `.term-mount`（空元素）上，空状态覆盖层是它的**兄弟**而不是子节点。
- **xterm 与 addon 必须用导入的类，不能绕 window 全局**。曾经留过一层 `window.FitAddon = FitAddon` 的过渡，而 UMD 全局是**命名空间对象**（`window.FitAddon.FitAddon` 才是类），把 ESM 导入的类本身挂上去后 `new window.FitAddon.FitAddon()` 就变成 `undefined`，**fit addon 静默装不上、终端永远停在 80×24**。自检「渲染层：xterm 与 addon 用导入的类，不经过 window 全局」守着。
- **xterm 建完要立刻 fit 一次**（它默认 80×24），切页时再补一次。xterm 会为滚动条预留宽度，字符区宽度 = `列数 × 单元格宽`，除不尽的部分留在右侧 —— `div.xterm-screen` 看着「偏左」是字符网格的固有结果，不是布局错。
- **共享的纯逻辑放 `lib/`**（状态词、时长格式化、需要确认的操作、xterm 的建实例与 fit），不要在组件里各写一份。模板里别给「导入的 ref」直接赋值（`@click="immersive = false"`），改用一个小函数。
- **「数据晚到」要重试**：Harness 页切过去时快照可能还没到，`maybeLoad` 里 `!dsh` 会提前返回；若只在切页时尝试一次，页面就会永远停在空状态。所以 `watch(dsh)` 里也要再试一次。

### 7.9 启动锁是单向状态机

启动那几秒会锁住整个窗口（`inset: 0`，连顶栏一起盖）。**锁期间顶栏不能设 `z-index`**，否则左上角会孤零零剩一个页面标题。解锁条件（任一满足）：就绪、异常相位、超过 90 秒（`BOOT_LOCK_MAX_MS`）、点「不等了，先进入界面」或按 `Esc`。

第一版用「布尔量 + 每次状态变化重新判定」，而且解锁条件里带了「当前是否在应用内全屏」；结果是启动完成解锁后，**一手动退出全屏**条件又变回不满足，锁重新扣了上来。现在改成**只能单向推进的状态机** `idle → waiting → done`：`done` 之后 `updateBootLock` 直接返回，解锁判定也不再涉及全屏状态。自检有四条守着：「启动锁：只在一处上锁（idle → waiting）」「启动锁：解锁写入 done，不可逆」「启动锁：done 之后直接返回」「启动锁：解锁判定不看当前是否全屏」，以及两条布局检查「启动锁：盖满窗口（inset: 0）」「启动锁：顶栏也被盖住（没给它更高的 z-index）」。

**第二个回合：向导结束后的自动启动也上锁**（t44 / 冻结 §0.4 的 R-32）。单向状态机**不变**，另有一个
`armAfterGate()` 作为**唯一**入口开一轮新的：只在放行页点「进入 DSH Console」那一条路上、且设置里
`autoStart` 开着时调用（**逃生口不上锁** —— 用户刚说了「不等了」）。回合带 **5 秒窗口**：窗口内相位没变成
`starting` 就把回合收成 `done`（**没有等待就不上锁** —— dsh 已经在跑、或这一轮只是接管外部实例时，
锁不该只是闪一下）；窗口之外用户自己点的「启动」永远不算这一轮。别把它改成「每次状态变化重新判定」——
那正是这一节开头那个 bug（解锁之后条件又变回不满足，锁又扣上来）。

**第三个回合：点了「重启 dsh」之后也上锁**（t46 / [`docs/plugin-restart.md`](plugin-restart.md)）。
同一台单向状态机、同样**显式开回合**：`armEpisode('afterRestart')` 由 `wireRestartNav()` 在
"有人立了跳转意图"那一刻调用，带**同样的 5 秒窗口**（没有等待就不上锁 —— 例如重启调用当场失败）。
开回合这件事现在只收在 `armEpisode()` 一处，第二/第三回合都只委托给它（自检盯着三条不变式：
`idle` 只写一次、`armEpisode` 里不自己 `setBootLock`、窗口超时把回合收成 `done`）。
两处不同，都写在规格里：① 锁文案按回合分开 —— 重启那一轮是「正在重新启动 dsh」+
「就绪后自动打开 DeepSeek Harness」（**不提全屏**，那一轮不抢屏）；② 用户在锁上按「不等了 / Esc」
会**取消这一轮跳转**（`userSkipBootLock()` → `settleRestartNav('escaped')`；第二回合本来就没有跳转可取消）。

### 7.30 左栏只有七项：终端合并、环境自检在设置里

**现象 / 决定**（t45，用户裁定；摆法示例 `docs/rail-simplify-choices.html`、改判记在 `docs/env-doctor.md` 的 t45 段）：
左栏原来是九项，其中「dsh 终端」与「本地 Shell」是同一件事的两个入口、「环境自检」多数时候只看一眼结论。
现在：

- **一个「终端」页**（`panes/TerminalPane.vue`）：一条会话条，**第一项固定是 `dsh 终端`**（保留 id `'dsh'`，
  不能改名也不能关闭），后面是各本地 Shell，`＋ 新建本地 Shell` 在最右；`关闭当前` 只在本地 Shell
  那一路上出现。dsh 那一路是子组件 `panes/DshTerminal.vue`（= 原来那一页，带它自己的状态条与
  三个动作），所以**它不在挂载清单里** —— 这就是为什么那条自检要认「被别的组件 import」。
  顶栏标题也跟着从 `dsh 终端` 改成 `终端`（这一页不再只有 dsh 那一路）；`TopBar.vue` 的 `PAGE_TITLES`
  里 `shell` / `env` 两个键同时删掉 —— `currentTab` 已经是七项的联合类型，留着就是死键。
  会话条上的动作按钮用**镂空**（`.btn.outline`，与 `.btn.danger` 同形，只是换成 accent 色）：
  它原来是 `.btn.primary`（实心 accent），比选中的标签还抢眼，**看不出正在看哪一路** ——
  实心只留给选中态，那才是这条上唯一该"实"的东西。
- **两路终端都绝对定位铺满 `.term-body`**（会话条下面那一块，`flex: 1 1 auto` + `position: relative`）。
  它**必须**是两路的定位基准：`.term-view` / `.term-host` 都是 `inset: 0`，少了这一层，dsh 那一路的
  `inset: 0` 会去对**整个 `.pane`** 算，它的状态条（清空显示 / 重新显示历史 / 发送 Ctrl+C）就与
  会话条叠在同一行（真机上出现过：会话条上的标签与那排按钮糊成一片，而只看 `display` 值的检查
  全是绿的）。这类「绝对定位挂错了基准」用前后顺序是抓不到的，所以那条自检按 **div 标签配对取整段**
  来断言「`.term-view` 与 `.term-host` 真的套在 `.term-body` 里」。
  **但绝对定位只给本地 Shell 那一路**（`.term-body > .term-host`）：`.term-host` 的**基础**规则
  必须留着 `position: relative` + `flex: 1 1 auto` —— dsh 那一路的子组件 `DshTerminal` 自己也用这个类，
  那是它 `.bar` 下面的 flex 子项；基础规则一改成绝对定位，它会铺满整个 `.term-view`、把 dsh 的状态条
  整行盖掉（踩过：工具栏整行"消失"，而元素其实还在，rect 量出来一切正常）。这一条同样由那条自检
  钉着（基础规则 relative + 作用域规则 absolute，两个都要在）。
  两路之间用 `visibility` 互斥（`.term-body > .term-host:not(.active) { visibility: hidden }`）：
  xterm 实例保持尺寸、切回来不用重建。**但只能给"不在看的那一路"写 hidden，不能给"在看的那一路"
  写 visible** —— `visibility` 是继承属性，而 `.pane` 正是靠它藏整页的，子元素一旦显式写 visible
  就会从隐藏的页面里穿出来（用户抓图：切到 Harness 页，本地 Shell 的 zsh 提示符还画在上面）。
  写成 `:not(.active)` 之后，"在看的那一路"什么都不写，老老实实继承 `.pane` 的可见性。
- **环境自检不再是页面**：设置页多一张「运行环境」卡（一行结论 `N 项正常 · N 项不正常 · N 项需要注意`
  —— 与详情视图顶部那句**一字不差**，免得点进详情像换了个说法 + 要求的那句 Node 区间 +
  「查看详情」「重新检测」），点「查看详情」打开**工作区上的详情层**
  `#env-detail-layer`（`lib/env-layer.ts` 的 `envDetailOpen` / `openEnvDetail` / `closeEnvDetail`）。
  它是覆盖层不是页面：**不进 `TAB_ORDER`**，点左栏任何一项（`selectTab` → `closeEnvDetailOnTabChange`）
  都会收掉它；回程按钮只收层、**不改 `currentTab`**（这样从控制台横幅、插件页进来的用户回到原处），
  文案跟着来路走 —— 从设置卡进来是「← 设置」（摆法预览 2A 里就是这么画的），别的来路是「← 返回」。
  顶栏在它打开时显示面包屑 `<当前页> › 运行环境`，也是 2A 里的样子。
  原来那一页里的一切（灯 / 结论 / 一键修复 / 重新打开环境向导 / 安装下载来源 / 重新检测）都在。
- **这一层必须挂在 `<main>` 里**（`index.html`），不要挂到 `.app` 外面：`main` 是 `position: relative`，
  它的 `inset: 0` 正好等于"页面区"，所以左栏 / 顶栏 / 状态栏是**结构上**留在外面的，不靠 z-index 让位。
  挂到 body 下时同一条规则就成了整个窗口 —— 左栏被整条吃掉，`EnvPane` 自己的步骤栏占着左栏的位置，
  看着像"左栏变成了向导"（踩过：`open` 类、行数、结论全对，只有截图看得出来）。自检按 `<main>…</main>`
  取整段来钉它。
- **快捷键 9 → 7**：`TAB_ORDER`（`app.ts`）、状态栏那句 `⌘/Ctrl+1~7`、终端里放行 `Ctrl+数字` 的
  正则（`lib/xterm.ts` 的 `passAppShortcutsThrough` 是 `/^[1-7]$/`）、以及 `docs/` 里的页面数说法一起改。
- **`envFocus` 锚点机制没变**：控制台横幅、插件页的「一键装 pnpm」、门禁层的两条出路都改成
  `openEnvDetail()` + `requestEnvFocus(...)`；自检里有一条钉子盯着**全仓库不许再有 `currentTab.value = 'env'`**。

**哪条自检守着**：「渲染层：左栏七项（TabId 里没有 shell / env，页面容器也没有 pane-shell）」
「渲染层：环境自检是设置里的详情层（不是页面）」
「渲染层：环境自检详情层盖的是工作区（挂在 <main> 里，不吃掉左栏与顶栏）」
「渲染层：终端页的会话条第一项固定是 dsh 终端、新建按钮镂空（两路终端在一个页面里）」
「渲染层：两路终端共用 .term-body（dsh 那一路的定位基准不是整个页面）」
「首启门禁：顶栏的标题与"右侧控件收起"读同一个 gateVisible（R-03）」（标题多了面包屑那一段，
门禁分支仍然只认 `gateVisible`）
「设置页：「运行环境」卡是简化展示 + 「查看详情」打开详情层」、以及改了措辞的那条
「渲染层：每个 .vue 组件都被用到（在挂载清单里，或被别的组件 import）」。

### 7.31 重启 dsh 之后自动进 Harness（t46）

**现象**：插件页装 / 卸 / 升级之后，黄条写「已改到装配层，重启 dsh 后生效」，点「立即重启 dsh」
**只有状态栏一句「正在重启 dsh…」** —— 窗口不切、不上锁、没有结束语。用户在底栏最不起眼的位置
看到一句一闪而过的消息，自然会觉得"点了没用"（用户原话：「点击之后没有后续操作，会让用户感觉没有生效」）。

**现在的做法**（裁定 1A / 2A / 3B / 4A，逐字文案与状态机见 [`docs/plugin-restart.md`](plugin-restart.md)）：

- **先立意图，再动手**：四个入口都调 `lib/restart-flow.ts` 的 `restartThenOpenHarness(api, getDsh, reason)`
  —— 它先 `beginRestartNav(reason)` **再**调重启。顺序不能反：`dshManager.start()` 一 spawn 完就返回，
  相位很快 `running → stopping → stopped → starting`，等 IPC 回来再立意图就错过了 5 秒上锁窗口。
- **上锁**：`app.ts` 的 `wireRestartNav()` 在意图出现时开第三个回合（见 §7.9），锁上写
  「正在重新启动 dsh / 就绪后自动打开 DeepSeek Harness」。
- **就绪判据是纯函数**（`restartArrived`）：`running` **且**已经拿到带令牌地址，**且**先看见旧实例
  被停过（`leftRunning`）或令牌地址确实换了。只看 `running` 就切过去会切到「还没捕获到带令牌地址」
  那一屏；而少了"先看见停过"这一条，**立意图那一刻**旧实例还是 `running` 带旧令牌，就绪当场成立
  —— 页面瞬间切走、锁根本不出现（真机实测：点完 600ms 已经在 Harness 页上了，重启还在后头跑）。
- **"起不来"也一样要"先看见"**（`restartStalled` = 见过 `starting` + 落到 `stopped`/`degraded`/`conflict`）：
  重启的相位序列必然经过 `stopped` 那一段，不加这道闸会在"停旧实例"那一刻就判失败（真机实测：
  dsh 明明起来了，界面写「dsh 还没起来（当前状态：运行中）」）。
- **收尾六态**：`ready`（切页 + 到达提示 + 状态栏一句）/ `failed`（重启调用本身失败，黄条变红说实话）/
  `unready`（相位落到 `stopped`/`degraded`/`conflict`，或超过 90 秒 = `BOOT_LOCK_MAX_MS`）/
  `external`（拿不到令牌，不切页）/ `escaped`（用户在锁上说了"不等了"→ **取消**跳转）/ `idle`。
- **到达时给的是"轻提示"，而且落在顶栏右侧那格已有的信息位上**（`#topbar-note`，平时写着
  「<地址>，PID …」）：重启就绪后的 4 秒里它变成绿色小胶囊「✓ 装配层改动已加载」，然后自己换回。
  没有按钮、没有新表面、不遮内嵌界面的任何内容。
  - 为什么不用浮层：先做过"可关闭的常驻横条"（用户：「给个轻提示就可以了，不用给这种常驻提示」），
    又做过"浮在正文上的胶囊"（用户：「不好看，你学一下UI设计呗」——半透明底压着别人的正文、
    又没有层级，两行字还被圆角切碎）。四个方案与取舍见 [`docs/harness-arrival-design.html`](docs/harness-arrival-design.html)。
  - 为什么是**顶栏**那格而不是 Harness 页工具条右端那格：应用内全屏时
    `body[data-immersive='true'] #pane-ui .bar` 会把整条工具条藏掉，顶栏则两种模式下都在
    （真机上量出来的，别改成工具条那格）。
- **分层**：`lib/restart-nav.ts` 只有状态与纯判据（**不许有 DOM** —— 自检直接 import 它来钉就绪判据，
  而自检的编译图 `tsconfig.node.json` 没有 DOM 类型）；`lib/restart-flow.ts` 是编排（有 `alert`，谁也别
  import 它）；`app.ts` 负责等就绪 / 超时 / 切页 / 发状态栏消息。

**哪条自检守着**：「启动锁：重启 dsh 之后是第三个回合（afterRestart），锁文案按回合分开、重启那轮不提全屏」
「启动锁：锁上的「不等了」/ Esc 取消这一轮跳转（唯一会取消的路径）」
「重启后进 Harness：就绪判据是 running + 已拿到带令牌地址」
「重启后进 Harness：意图在调用重启之前立」「重启后进 Harness：四个入口都走同一条流程」
「重启后进 Harness：黄条有进行中 / 失败 / 未就绪 / 已生效四态，到达提示走顶栏那格已有的信息位（方案 A）」。

### 7.32 装插件用的 pnpm，必须和 profile 对得上（t47）

**现象**（用户真机）：插件页装 `dshmarket` 失败，输出区里是 pnpm 的一段话 ——
`… node_modules … currently linked from the store at …/store/v10 … pnpm now wants to use the store at
…/store/v3 … (This error may happen if the node_modules was installed with a different major version of pnpm)`。

**原因**：这台机器上两份 pnpm 各自认一个 store（实测）：`~/Library/pnpm/pnpm` = **10.15.0** → `store/v10`；
PATH 里第一个是 nvm 22 的 corepack shim = **9.6.0** → `store/v3`。而 `~/.dsh/profiles/web/node_modules`
是 **pnpm 10** 装的（`.modules.yaml` 的 `packageManager: pnpm@10.15.0` + `storeDir: …/store/v10`）。
装插件的链路是 console 起 `dsh plugin …`，dsh 在 profile 目录里**裸 `spawnSync('pnpm')`（只认 PATH）**
—— 它拿到 pnpm 9，pnpm 9 只肯用 store v3，于是拒绝动手。**store 布局按 pnpm 大版本走**，这是硬约束。

**现在的做法**（细节与现场记录见 [`docs/plugin-install-pnpm.md`](docs/plugin-install-pnpm.md)）：

- **装之前按 profile 挑**：`findPnpmForProfile(profileDir)` 读 `node_modules/.modules.yaml` 的
  `packageManager`，在「PATH 里那份 + 各已知安装位置」里挑**大版本一致**的那份；一个都对不上就交回最靠前
  那份 + `matched: false`（说实话，不静默用一个注定失败的版本）。判定拆成三个纯/薄函数：
  `parseProfilePnpmMajor`（纯）、`readProfilePnpmMajor`、`pnpmVersionOf`（实测 `-v`，进程内缓存）。
- **挑出来必须落成 PATH 前置**：dsh 只认 PATH，所以 `plugin-manager.ts` 把选中那份的目录顶到子进程
  PATH 最前（`envWithKnownBins` 补的是 `findPnpm()` 那份 = PATH 优先，光靠它不够）。
- **这种错误要给人话**：`summarizePluginFailure()` 新增一条，把上面那段原文翻成
  「这份 profile 的依赖是用 pnpm 10 装的，而这次用的是 pnpm 9.6.0 …… 换成一致的那一档再装」。
- 既有导出签名一个没改（`pathWithKnownBins` / `envWithKnownBins` / `findPnpm` 原样），
  「根本没 pnpm」那道闸也保留。

**哪条自检守着**：「插件安装：从 profile 的 .modules.yaml 读出"这份依赖是哪个大版本的 pnpm 装的"（纯函数）」
「插件安装：store 大版本不一致时给人话（不再是 pnpm 那段原文）」（夹具就是真机那段原文）
「插件安装：装之前按 profile 挑 pnpm，并把选中的那份顶到子进程 PATH 最前」。

### 7.10 本地 Shell 有意**不持久化**

本地 Shell 每次启动都是全新的一页 —— 个数、工作目录、标题、终端内容都不跨重启保留（界面重载时会按快照里的 id 接回原进程，所以开发时 `Ctrl+R` 不会丢掉 shell；应用重启则全部回收）。

**为什么不做内容恢复**：内容恢复那版用 `@xterm/addon-serialize` 把终端缓冲区序列化成自洽 VT 流，存档侧没问题，卡住的是**回放** —— 序列化流末尾带光标还原序列（`\e[35A\e[20C` 之类），写进一台刚起、正被 ConPTY 重绘的新终端时，光标落点、重绘时序、shell 启动输出三者互相干扰，反复出现内容被覆盖或丢失。会话持久化那版（记个数 + 目录 + 标题）也没能说服用户：既然内容不恢复，空壳会话与默认名字的价值有限。将来若要重做，方向不是「画快照」，而是**保留原始输出流**（追加式、按换行对齐截断），并在**新的 shell 起来之前**把流灌进终端 —— 让内容与进程启动没有时序交集。

### 7.11 令牌：为什么不去自签 cookie

（相关的界面规则：**应用内全屏只在内嵌界面可用或即将可用时自动开启** —— `store.ts` 的 `uiLoadable`
= 已有令牌地址 **或** dsh 由本应用启动（令牌可能还在路上）。外部实例拿不到令牌时，Harness 页
只有一段说明，为它藏掉左栏与底栏没有意义；设置项 `uiFullscreenOnStart` 不改变这条前提。
自检「自动全屏：…」三条守着它。）

`dsh web` 的访问令牌是**进程私有**的随机值，只在启动时打印一次，不落盘、没有接口能事后取回。因此 `UiPane` 分三种情形：本应用启动的 dsh（自动捕获令牌）、外部实例（拿不到令牌，顶部常驻提醒 + 「重启为受管实例」的出路 + 可粘贴地址）、没在跑（提示回控制台启动）。**没有令牌时不会退化成裸地址去载入**（那样只会拿到 401 并抛 `ERR_ABORTED`）。

有一个能让外部实例也用上内嵌界面的办法，本项目**有意没有采用**：cookie 的签名密钥明文存在 DSH 的 credentials 文件里，应用完全可以自己签一个合法 cookie 写进 webview 的 session。不做的原因是它依赖 dsh 的内部实现细节（cookie 名、载荷结构、HMAC 格式），属于 rc 版本的实现细节，上游一改就会静默失效；而且它是「代替用户登录」的伪造型能力。当前策略是明确提示用户用本应用重新启动 dsh（官方支持的路径）。

### 7.12 界面设计与主题

UI 按 `frontend-design` 技能走了两轮，要点：**圆角与阴影表达层级，不平摊**（四级表面 + 半透明发丝线，阴影全局只用一处）；交互强调色与状态语义色两套色相不撞车；字体随包分发 IBM Plex Sans / Mono（中文回落系统字体）。主题由**主进程解析**（`themeInfo()` → `{ mode, resolved }`），渲染层只把结果写到 `<html data-theme>`；**终端配色必须单独给**（xterm 的配色是 JS 配置，不走 CSS），在 `lib/xterm.ts` 的 `TERM_THEMES.dark / .light` 两套里。自检守着「主题：样式表除变量块外没有硬编码颜色」「主题：亮色覆盖了深色的全部颜色变量」「主题：终端两套配色都在（xterm 不走 CSS）」「字体：@font-face 引用的文件都存在」。

**界面设计的交付物必须是「能看的产物」，而且要在研发动手之前过一遍**（阶段二首启向导定下的规矩）。设计阶段交的不是一段文字描述，而是一个**双击就能打开的单文件 HTML 预览**：本轮是 `docs/env-wizard-preview.html`（155 KB、**零 `<script>`**、纯内联 CSS），用**真实尺寸**（顶栏 36px、左栏 `--rail-w` 188px、内容列最大 760px —— 与 `main.ts` / `styles.css` 里的值一致）与**既有 CSS 变量**摆出**全部界面与状态**（缺 Node / 安装中 / 失败 / 门禁层 / 逃生口 / 自检页的更新入口…），逐屏可看、可量、可标注。理由有两条：**"两栏布局、留白适中"这类描述没法 review**（读完描述都点头，做出来才发现间距不对，退回去改的代价是重做一屏）；而预览里的每个数与变量都能和实现**逐字对上** —— `docs/env-wizard-visual.md` 那些间距值（含自检 M15–M17 钉住的十个值）就是从它取的。推论：**改设计先改预览、再动实现**；预览里没有的界面状态不算设计过。

**交互逻辑上的分歧 / 规格没讲清的选择，不许由实现方自行拍板（用户定的规矩）**。判据：一处交互有**两种以上说得通的摆法**，而规格里没写死（或两份文档互相矛盾）时——**先把这几种摆法做成能看的 UI 示例**（同一份单文件 HTML 里并排 / 上下摆放，真实尺寸、既有 CSS 变量，就是你日常 review 的那份东西），**交用户看，用户选定之后再动代码**。不许用"我按默认判断收口"把选择吞掉，也不许只在提交信息或文档里事后追认。已落地的选择同样要能被复看：若某条在实现时已经按某一种摆法做进去了，**把另一种摆法也摆出来请他确认**（正面例子：`docs/env-interaction-choices.html` 那 7 条），而不是默认"就这么定了"。推论：**这类问题的产出顺序是「UI 示例 → 用户裁决 → 改规格 → 再改代码」**，四步里前两步不许跳过。

### 7.13 静态检查只看代码、不看注释

自检里的 id / class / api / webview 检查扫描 `index.html + panes/*.vue + shell/*.vue + lib/*.ts` 的合集，并**先剥掉注释**：注释里常拿 `getElementById('btn-xxx')`、`` `<webview>` ``、`#000` 这类示意写法举例，当真值去查会误报。class 检查要认得动态绑定（`:class="{ active: 条件 }"` 的键名算用到的 class）。新增页面时记得同步挂载清单、样式与（如需要）preload 暴露的 API —— 自检「样式：标记用到的 class 都有对应样式（HTML + .vue）」已经挡住过两次真问题。

### 7.14 设置页网格：`min-height: 0` 会吃掉溢出内容

看板侧栏需要 `.panel { min-height: 0 }` 才能在内部滚动，但它会让设置页那些「高度跟着内容走」的卡片被压到容器高度以内，多出来的部分被 `.panel` 的 `overflow: hidden` 裁掉 —— 而 `scrollHeight == clientHeight` 意味着**连滚动条都不会出现**（症状：设置页最后一项永远看不到）。修法是给设置页的网格加 `grid-auto-rows: max-content`（行高跟内容走）。改这类布局前先想清楚「这个容器的滚动由谁负责」。

**页面级内边距由各页自己给**：`.pane` 只负责定位（`position: absolute; inset: 0`），它**没有任何 padding** —— 所以新页面的根容器必须自己写左右与底部各 20px（`.archive-body` 是 `2px 20px 20px`、`.settings` 是 `4px 20px 20px`，工具条 `.bar` 自带 `10px 20px`）。漏了就会像插件页第一版那样整块面板贴到窗口边缘。冒烟里有一条「插件页与归档页的面板内边距必须一致」盯着（比的是两页**第一个面板的左边距 + 最后一个面板的右边距** —— 拿第一个去比右边距会把侧栏宽度当成边距）。

**设置：界面与主进程是两份产物，保存必须对答案。** 两者会各自更新（窗口热重载了、主进程还是旧构建），这时渲染层认得的新设置项在主进程眼里就是"不认识的键"。`Settings.patch` 因此**不静默丢**：patch 里一旦出现 `DEFAULTS` 之外的键就抛错、**一个字都不写**，设置页把这条错误显示出来而不是照旧说"已保存" —— 真机上就这么丢过一次「插件安装源」：填了、点了保存、显示"已保存"，重启后输入框空的，`settings.json` 里连这个键都没有。推论：**加设置项只改契约与 DEFAULTS 两处还不够**，改完要**重启应用**（`npm start`），只重载窗口会正好落进上面那个半新半旧的状态。

### 7.15 健康判据与令牌掩码

- **健康判据**是 `GET http://host:port/`：dsh 对无令牌请求返回 `401 dsh web authentication required`，这本身就是「服务活着」的强特征；带 `__DSH_BOOT__` 或 `DeepSeek Harness` 的 200 同样判定为 dsh（`process-utils.ts` 的 `isDshResponse`）。所以探测**不需要令牌**，也不会把「401」误判成「服务没起」。
- **日志里不出现明文令牌**：捕获到的地址进事件日志前一律经 `maskToken()`（`token=***`），完整 URL 只留给内嵌 webview 与「在浏览器打开」。

### 7.16 归档会话：直接读写 DSH 的磁盘目录

归档页的数据全在主进程 `session-archive.ts` 里直接读写 DSH 的数据目录（`$DSH_HOME`，没有则 `~/.dsh`）：归档 id 在 `storages/workspace.json`，标题 / 首句在投影缓存，对话全文在 zstd 压缩的 JSONL 会话日志里（按帧解压还原）。「取消归档 / 删除」只改 `workspace.json`（原子写），删除时连会话日志与投影缓存一起删，**附件不删**（可能被多个会话共享）。注意：正在运行的 dsh 把 `workspace.json` 读进了内存，直接改磁盘不会立刻反映到它的界面，所以操作后会提示「重启 dsh 才生效」。

### 7.17 自动更新：Windows 能自动，macOS 与开发态不能

**现象**：macOS 上若照 Windows 那一套接 electron-updater，应用会正常发现新版本、下载，然后**安装失败**（用户点了「重启并安装」什么也没发生）；开发态则连更新元数据都没有，检查必然报错，日志里是一串看不懂的路径错误。

**原因**：`package.json` 的 `mac.identity` 是 `"-"`（ad-hoc，见 7.3），而 macOS 的更新由 Squirrel.Mac 校验签名 —— 它要求更新包的签名与当前应用一致且被系统信任，ad-hoc 不满足，于是拒绝安装。开发态（`app.isPackaged === false`）的 resources 里没有 electron-builder 生成的 `app-update.yml`，electron-updater 没有可用的更新源。

**现在的做法**：`src/main/updater.ts` 只在 **`app.isPackaged && platform === 'win32'`** 时才**按需 `require('electron-updater')`**（用 `createRequire(__filename)`，**不是顶层 import** —— `require('electron-updater')` 一求值就会按平台构造 updater 单例，macOS 上就是 Squirrel.Mac）。macOS 上改成**自己能查、但不装**：直接取 `releases/latest/download/latest-mac.yml`（GitHub 的 latest 别名指向最新**已发布**的 Release，与 Windows 读的是同一份更新源），比一下 `version:` 就把结果推给界面 —— 所以 mac 用户照样能在底栏看到「发现新版本」，只是按钮是「打开下载页」；契约里 `canCheck`（能不能查）与 `canAutoUpdate`（能不能装）因此是**分开的两个字段**。开发态与其它平台回报 `unsupported` + 两个 false。另外 `autoDownload` 与 `autoInstallOnAppQuit` 都写死 `false`：发现新版本只推状态，下载与安装必须用户点 —— 升级会退出应用、连带停掉正在跑的 dsh，不能替用户决定。定时检查（启动后一次 + 每 6 小时）由设置项 `autoCheckUpdates` 控制，改设置后由 `main.ts` 调 `updater.syncSettings()` 立即生效。

**设置页的更新卡片**：状态行来自状态机的 `message`，下面那句说明**按平台分开写**（`updateNote` 计算属性）—— Windows 才说"下载与安装都不会自己做"，macOS 上根本装不了（ad-hoc 签名），说的是"点「打开下载页」下载新的 dmg 覆盖安装"；`canCheck` 为假（开发态）时整句不显示，因为状态行已经把原因说全了。版本号不在卡片里重复（上面「关于」已有 `DSH Console x.y.z`），按钮与「软件更新」标题同一行。

**哪条自检守着**：「自动更新：契约里有 7 个相位、UpdateState 字段与 4 个 API」「自动更新：`autoCheckUpdates` 在契约与 DEFAULTS 两处一致」「自动更新：不会偷偷下载 / 偷偷安装」「自动更新：macOS 分支存在（ad-hoc 签名 → canAutoUpdate=false + 打开下载页）」「自动更新：未打包时不加载 electron-updater（没有顶层 import，只按需 require）」。这五条**都是静态检查**：受限环境里跑不了打包后的应用，所以真机上装完新版后的行为仍要人工验一次。

### 7.18 插件装配层：两个层面，别混

dsh 的「插件」有两个层面，界面与代码都得分开看：

- **运行层**：已经挂载进配置树的条目、它们的启停与设置项。这一层由 dsh 自己的界面管（内嵌 Harness 的 **设置 → 插件**：`插件配置` 改插件暴露的 settings 命名空间，`插件列表` 是只读清单）。console **不重做**，只在插件页给一句跳转提示。
- **装配层**：装了什么 bundle、哪个版本、从哪来、层序如何、生效配置最后长什么样。没有任何界面管这个 —— 这就是 console 插件页（左栏第 7 项，快捷键 `7`）存在的理由，也是「dsh 因为插件起不来」时唯一的入口。

术语对应关系（改这块代码前先认清）：**bundle** 是可安装单位（npm 包，manifest 里声明 `dsh.bundle.patch`），**profile** 是 `$DSH_HOME/profiles/<name>` 那份「哪些 bundle、按什么顺序」的清单，**插件**是两者最终装出来的 `apply(ctx)` 模块。层序是：各 bundle 的 patch（按 `dsh.profile.bundles` 顺序）→ profile 自己的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖层；**后面的按 `id` 整条替换前面的条目（替换整个 `config`，不是深合并）**。

`src/main/plugin-manager.ts` 的几条硬约定：

- **只读，只碰 `web`**。console 启动的是 `dsh web`（= `--profile web`），所以 `PLUGIN_PROFILE = 'web'`；`desktop` 是 CLI 保留给 Electron 的（`bin.js` 直接报错），永远不要传。
- **空输出不是成功**。dsh 的 CLI 在跑不动的 Node 上是「退出码 0 + 零输出」（见 7.4），把它当成功就会静默显示成「没有插件」。`checkDumpResult()` 是这条判据的纯函数版本，自检直接钉它。
- **未匹配的 patch 行在 stderr 上，不在 dump 里**：`dsh: [<层文件>] patch: entry "<id>" not found`，**退出码是 0**。这类"没报错的错"是用户改动悄悄不生效的主因，必须单独收；解析失败（抛异常）时 stderr 前面是一坨 Node 堆栈，取原因要用 `firstMeaningfulLine()`（第一行是 `file:///…`，不是原因）。
- **`--dump-config` 会写 profile 根文件 `cordis.yml`**（实测：目录只读时报 EPERM）。它不是纯读操作，但那个文件本来就由 dsh 自己维护，不冲突。
- **层归因直接来自 dump 的注释标签**：`# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app`；profile 自己那一层的标签是**文件全路径**。
- **「被覆盖」要拆成两种**：真实数据里 `dsh-web-app` 覆盖 base 的 25 条有 23 条是把下层 `disabled: true`（不是改配置）。界面上必须分开标，否则用户以为配置被改了。

**两个口径不要混**（用户已经问过一次"为什么数量对不上"）：本页数的是 `--dump-config` **组合出来的行**（各 bundle 的 patch + 你的 patch 层），而内嵌 Harness 的「插件列表」数的是**运行中的非 group Loader 条目**（`dsh-host-plugin-inventory/lib/index.js` 里 `for (const entry of ctx.loader.entries()) if (entry.options.group) continue`）—— 后者多了启动时由 `mountRootInclude` 挂上去的根 `include` 行（`dsh-app-boot` 的 `id: "include"`，不是 group，所以计数）以及运行时新增的行，所以两个数**天然不相等**（本机实测 152 vs 156）。界面上因此写"组合条目"并且给出一句口径说明，不要写"个条目"。

### 装 / 卸 / 升级：几条必须守住的点

装（`add`）、卸（`remove`）、升级（`update`）全部走 `dsh plugin --profile web …` —— 它把参数转发给 profile 目录里的 pnpm，然后按"装出来的包有没有声明 `dsh.bundle`"**重算** `dsh.profile.bundles`。我们**不自己改 package.json、也不自己解析 pnpm 的输出语义**，那两件事都是 dsh 的职责。

1. **spec 永远是一个 argv，不经过 shell**（`spawn(file, args)` + 数组，没有 `shell: true`）。拼错一次就是命令注入；自检里有一条静态断言盯着（`spawn(file, args` + `stdio: ['ignore','pipe','pipe']` + 没有 `shell: true`）。
2. **子进程 PATH 必须补上 pnpm**（`envWithKnownBins` → `pathWithKnownBins`）：**Windows 上这个键叫 `Path`**，直接写 `{ ...process.env, PATH }` 会造出两个只差大小写的键、哪个生效看运行时 —— 所以 `envWithKnownBins` 先找已有的那个键原地改（没有才新写 `PATH`）；自检钉着键名原样保留、且只有一个 path 键。同理别在渲染层按 `'/'` 切路径（Windows 是 `\`）。`dsh plugin` 内部是裸 `spawnSync('pnpm', …)`，而 GUI 启动的应用 PATH 很窄。不补的话用户看到的是 `dsh: pnpm not found on PATH`（退出码 127）。`findPnpm()` 除了 PATH 还会扫已知目录 —— POSIX 是 `~/Library/pnpm`、homebrew、`~/.local/share/pnpm`、nvm 各版本目录；**Windows 上不要写死 `pnpm.cmd`**：`whichSync('pnpm')` 按 `PATHEXT` 展开（独立安装包装的是 `pnpm.exe`、`npm i -g` 装的是 `pnpm.cmd`，只找 `.cmd` 会漏掉前者），PATH 里没有时再扫 `PNPM_HOME` / `%APPDATA%\npm` / `%LOCALAPPDATA%\pnpm` / `%ProgramFiles%\nodejs` / `NVM_SYMLINK` / `~/.volta/bin`（Windows 上 GUI 应用拿到的是**启动那一刻**的环境块，刚装完 pnpm 还没重新登录时终端里能用、应用里找不到）。这条的纯函数版本是 `windowsBinCandidates`：按小写索引变量名（`LocalAppData` / `LOCALAPPDATA` 两种写法都见过）、用 `path.win32` 拼路径，所以在 macOS 上也能测。**机器上压根没装 pnpm 时干脆不起子进程**：`findPnpm()` 查的就是我们要塞给子进程的那份 PATH（再加那几个已知目录），它说没有、子进程一定找不到 —— 所以 `run()` 里提前返回一句"装一个再来"（实测 `dsh plugin add` 会**先把 profile 初始化出来**再以 127 失败，等于白改一遍磁盘）。只读的层栈 / 清单不经过 pnpm，没装也能看。
3. **`-w` 只在 pnpm 自己要求时加**。这是个上游模板的坑：dsh 写的 `pnpm-workspace.yaml` 是 `packages: [.]` + `nodeLinker: hoisted`，**没有** `ignore-workspace-root-check`，于是 pnpm 9 把 profile 当 workspace root，`add` 直接报 `ERR_PNPM_ADDING_TO_ROOT`（实测：`dsh plugin --profile web add ./x` 必失败）。现在第一次照朴素参数跑，一旦输出里出现 `ADDING_TO_ROOT|workspace root` 就**加 `-w` 重试一次**，并在输出区写一句"pnpm 说这是 workspace root，加 -w 重试"。**不要无条件加 `-w`**：不在 workspace 里的时候那个 flag 是多余的。

4. **内置包直接拦下，而且要分清「还没启用」与「你已经启用了」**。`@deepseek-ai/dsh-*` 这些是随 dsh 装好的（在 dsh 安装目录里），分发不经过 registry，所以「从 registry 再装一遍」没有意义；用户真正想做的是**启用**它 —— 那是 patch 层 `insert` 的事。所以 `add` 之前先解析包名（`packageNameOf`，带版本/标签也要取对）并在 dsh 安装目录里找一下，找到就直接拒绝。话要分两种说：`profilePatchEnables()` 看一眼他自己的 `cordis.patch.yml`（只认 `name:` 的值，注释里提到不算），已经插过就说「它已经启用了，这里不用装任何东西」，没插过才指路「插件页左边『你的层』那一栏」。两句话都来自真机：第一次是「想装内置包」撞墙，第二次是用户拿着**已经启用**的插件来问「我这个不是装过了吗」。
5. **404 要说清"缺的是哪个包、哪个 registry 说的"**。先看 pnpm 单独打的那行 `<包名> is not in the npm registry`：**缺的常常不是用户写的那个包，而是它依赖链上的某个包** —— 这时按"包不存在"去解释会让人反复怀疑自己写的包名（实测：装 `@deepseek-ai/dsh-time-context`，真正缺的是它 peer 链上的 `@deepseek-ai/dsh-type-meta`，而那个包在 npmjs / npmmirror / 内网源上**都不存在**，换源根本救不了）。所以归纳成「缺的不是你写的 A，而是它依赖的 B」并明说换源未必有用。其次才是源的问题：`registry.npm.taobao.org` 是 2022 年就停服的旧镜像，单独提示换 `https://registry.npmmirror.com`；其它 404 把主机名带出来（`GET https://<host>/…`）。夹具 `test/fixtures/pnpm-missing-dep.stderr.txt` 是这次真实失败的原样输出。

6. **安装源可以单独指定，而且只注入子进程**。设置里的 `pluginRegistry` 填了才生效（只认 http(s) URL，末尾斜杠去掉；写错就退回系统配置）：它变成 `npm_config_registry` 加在那一次 `dsh plugin` 子进程的环境里 —— **不写用户的 `.npmrc`、不改全局配置**，别的项目不受影响。之所以走环境变量而不是 argv：上游 `runPlugin` 是 `spawnSync("pnpm", args, { cwd: dir })`，**没有传 env**，父进程环境原样穿透（实测：设成 `http://127.0.0.1:9` 后 pnpm 就去连那个地址）；argv 其实也能透传（`bin.js` 的 plugin 子命令 `allowUnknownOption` + 逐字转发），但 `add / remove / update` 与"要不要加 `-w`"都得保持一致，环境变量更省心。当前生效的源会随 `pluginInspect` 回给界面，显示在安装框旁边。

7. **改你自己的补丁层是另一条路，它不是 pnpm 的事**。内置包（随 dsh 装好、registry 上没有）要"启用"，靠的是往 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里 insert 一行；反过来"禁用"就是往那一层写一条 `- id: <x>` + `disabled: true`（覆盖类条目）或给已有的 insert 加 `disabled: true`。`patch-layer.ts` 负责这件事，四条硬约定（**写的是用户文件**）：
   - **按行改，不引 YAML 库**：patch 文件里 `!!js`、注释、空行都合法，拿解析器 round-trip 一遍就把用户的注释与格式吃掉了 —— 那比"改不动"更糟；而且这个仓库运行期只依赖 node-pty 与 electron-updater。
   - **只改匹配到的那一段**：找不到那条 id 就什么都不写、把原因说出来（界面照实显示）；`enable` 只去掉 `disabled` 那一行，只有那条本来就只为禁用而存在（除 id 与 disabled 没别的 key）时才整条删掉；条目是被**下面某一层**关掉的（比如 base 把 hmr 关了，你的层里根本没有它）时，`enable` 写一条 `disabled: false` 盖住它（实测能盖住），`disable` 则反过来把那条 `false` 改成 `true`，绝不重复插第二条 —— 自检用真实夹具钉了"改完再改回来与原文一字不差"。
   - **先备份再原子写**：`cordis.patch.yml.bak-<时间戳>`，然后 tmp + rename。
   - **这个文件必须是"顶层数组"**：只剩注释（或空文件）会被 YAML 解析成 null，dsh 直接报 `overlay … must be a top-level YAML array of loader patch entries`，整个插件页读不出来 —— 真机上移除最后一条 insert 之后就撞上过，所以 `joinLines` 在没有条目时会补一个 `[]`（dsh 自己的模板注释里也写着这一点）。
   - **写完要回读验证，坏了自己回滚**：这一层是 `patchReload: live`，界面不写成"要重启"（跟 pnpm 那条路正好相反，两条路的生效时机必须分开说）；同时 `editLayer` 改完立刻跑一次 `dump`，只有当失败指向**这份 overlay**（`top-level YAML array` / `overlay`）时才把备份还原、并把原因回给界面 —— dsh 因为别的原因跑不起来（解释器不对等）不回滚，免得把一次正确的改动撤掉。
     界面上四个入口：生效配置每条右边的「禁用 / 启用」，自己层插入条目的「移除我的插入」，以及内置包被拦下时输出区里的「插进我的层」（主进程用 `needsEnable` 把 id 与包名告诉界面，不让界面去解析那句话）。第五个动作 `drop` 只在「需要注意的 N 处」那块里出现（见下）。

另外两条界面约定：同一时刻只允许一个操作（同一个 profile 目录不能被两个 pnpm 同时改，按钮据此禁用，并给「中断」）；装/卸/升级改的是 `package.json` 与 `node_modules` → **必须重启 dsh**，所以做完挂一条黄条 + 「立即重启 dsh」，而 patch 层是即时生效 —— 这两种"生效时机"在界面上必须分开写清。

自检守着：「插件安装：spec 分得清 npm / 本地 / tarball / git」「插件安装：常见失败各归纳成一句人话，认不出来返回 null」「插件安装：从 spec 里取得出包名（带版本/标签也要取对）」「插件安装：链到已停服的淘宝镜像要单独说，别笼统说"包不存在"（并把失败的主机名带出来）」「插件安装：404 缺的是依赖、不是你要的那个包时，要指名道姓（夹具是真实输出）」「插件安装：缺的正是你要的那个包时，仍按"包不存在"说（并把主机名带出来）」「插件安装：安装源留空 / 写错都退回系统配置，填了才覆盖」「插件安装：安装源走子进程环境变量，不写用户的 .npmrc」「插件安装：补 PATH 时保留系统原有的键名（Windows 上叫 `Path`）」「插件安装：Windows 上找 pnpm / node 不写死 .cmd（独立安装包是 pnpm.exe），并有已知目录兜底」「插件安装：没装 pnpm 时在起子进程之前拦下」「插件安装：patch 层里『已经插入了某个包』看得出来（注释里提到的不算）」「插件安装：内置包要分清『还没启用』与『你已经启用了』」「补丁层：禁用 / 启用只动匹配到的那一段（往返之后与原文一字不差）」「补丁层：层里没有那条时，禁用 = 加一条覆盖，启用 = 整条删掉」「补丁层：插入不重复；移除只对自己插入的条目开放」「补丁层：写盘前先备份、原子写；id 不合法就一个字节都不写」「插件页：条目上有禁用 / 启用，内置包被拦下时给『插进我的层』」「补丁层：删完最后一条要留下一个顶层数组（只剩注释 dsh 会直接报错）」「补丁层：写完回读验证，只有失败点名到这份 overlay 时才回滚」「插件安装：spec 是一个 argv（不拼 shell）、PATH 补过 pnpm、输出双向都收」「插件安装：pnpm 说"这是 workspace root"时用 -w 重试一次」「插件安装：契约里有 3 个 API 与操作结果类型」。失败归纳（`summarizePluginFailure`）只认它认得的几类（pnpm 缺失 / git 构建脚本被拦 / 缺的是依赖还是它自己 / 淘宝旧镜像 / 网络与权限），认不出来就返回 null —— 界面显示原文，不编原因。

### 「悄悄不生效」的那些，现在能就地修

dsh 对**没生效的改动**基本不吭声：patch 里指向一个不存在的 id 时它只在 stderr 上打一行 `entry "…" not found`、**退出码还是 0**；装进来却没声明 `dsh.bundle` 的包只是"不形成层"；列在 `dsh.profile.bundles` 里却在生效配置里一条都没有的，要到启动时才炸。这三类都由 `plugin-manager.ts` 收成 `PluginProblem[]`（`parseProblems` / `plainDependencies` / `missingLayers`），界面在插件页顶部一条「需要注意的 N 处」里列出来。**这块以前只能看，现在两类有出路**：

- **指向了不存在的 id → 「删掉这一行」**（`patchLayer.dropEntry`，动作名 `drop`）。与前四个动作的分工容易混：`remove-insert` 只管"你自己插入的"（`- insert:` 块里的），语义是"撤销我刚才做的事"；`drop` 要删的是**任何形状**的条目（覆盖、禁用、insert 块里的都算），因为这个条目本来就没生效，留着只会让人以为配置生效了。删完照样走 `joinLines`：只剩注释时补 `[]`（见上面那条真机事故）。
  - **只对本页能改的那份层开放**：dsh 打出来的层文件可能是 profile 的 `cordis.patch.yml`，也可能是机器级的 `$DSH_HOME/cordis.patch.yml`，而 console 只写前者。这个判断在**主进程**做完（`parseProblems(stderr, ownPatchFile)` 算出 `editable`），界面只看这个字段 —— 路径比较要过 realpath（macOS 上 `/var` → `/private/var`），不能让渲染层自己去比字符串。不是本页那一层时不给按钮，只把文件路径写出来（`.plugin-problem-where`）。
  - **不传 `ownPatchFile` 时一律 `editable: false`**：老调用方忘了给路径，结论必须是"不给动作"，绝不能默认成能改。
- **装成了普通依赖 → 「卸掉它」**。走的就是已有的 `pluginRun({ action: 'remove' })`，所以**要起 pnpm、要改 profile 的 package.json/node_modules、做完必须重启 dsh**（即时生效那条路是 patch 层，别混）。包名单独放在 `PluginProblem.packageName` 里，界面不解析那句人话。
- **声明过 `dsh.bundle` 却不在 `dsh.profile.bundles` 里 → 「放回层里」**（`suspended-bundle`）。这一档是「临时停用之后回不去」的根因：停用把它从 bundles 里摘掉之后，它**既不是层**（层栈详情里点不到它）、**也不在 bundles 里**（列表里没有它），而旧界面把它归进"不形成层"、只给「卸掉它」—— 于是"临时"变成了单向门。分档的唯一依据是**包自己有没有声明 `dsh.bundle`**：`bundleDeclared(raw)` 是纯函数，`declaresBundle(profileDir, name)` 读 profile 的 `node_modules`（`link:` 是软链，也读得到）。**读不到包目录时按"本来就不是 bundle"处理** —— 宁可只给「卸掉它」，也不能把真依赖说成"能放回"。
  - **位置不需要界面记着**：`applyBundleEdit` 在 `index < 0` 时调 `recoverBundleIndex`，从这份 profile 目录里**最近的** `package.json.bak-*` 里找回它当时在第几位（找不到就追加到末尾，并在 `detail` 里说明是末尾）。层序就是覆盖顺序，插错位置等于悄悄改配置；而"刚停用"那条内存记录关掉页面就没了，所以恢复不能依赖它。
- **列在 bundles 里却没贡献**没有通用修法（可能是包坏了、也可能是 patch 冲突），所以**不给动作**，只把话说清楚。

自检守着：「补丁层：巡检给的『删掉这一行』只删那一条（覆盖条目 / insert 块里的都认，删完仍留顶层数组）」「插件：巡检里『指向了不存在的 id』只有本页能改的那份层才给动作（机器级那层不给）」「插件：装进来却没形成层的依赖、以及什么都没贡献的 bundle 都会被列出来（普通依赖带包名）」「救援：基线视图里不给作用于真实配置的动作（条目上的、以及巡检那块的两个按钮）」。

### 救援：dsh 起不来 / 配置被改坏（P2）

插件页最大的性格是 **dsh 挂掉时它还能用**（层栈、生效配置都是读磁盘 + 另起一个进程跑 dump）。所以配置被改坏时它不能只变成一句红字 —— 真机上就发生过：`cordis.patch.yml` 只剩注释（不是顶层数组），`--dump-config` 直接失败、整页读不出来，用户只能去手工改文件。这里的出路是：

- **什么时候算"起不来"**：`degraded`（进程活着但超时没就绪）或 `stopped` + `lastExit.code !== 0`（起来又退出）；`pluginInspect` 失败（配置读不出来）同样弹救援条。原因那一行从快照的 `dsh 输出：…` 日志里取（主进程在非正常退出时记的），**不重新解析终端缓冲**。
- **出口一：只看内置层**（`--dump-default-config`）——**配置坏掉时它照样能成**：实测 overlay 是非法 YAML 时 `--dump-config` 退出码 1，而 `--dump-default-config` 退出码 0、152 条。界面切到「基线」视图并写明"这不是你真正生效的配置"；基线视图里**不给**「禁用 / 启用」「移除我的插入」，也不显示运行状态 —— 那些动作都作用于真实配置。
- **出口二：临时停用某个 bundle**（`profile-bundles.ts`）——改 `dsh.profile.bundles`，备份 + 原子写（`safe-file.ts`），**并记住它原来的位置**：层序就是覆盖顺序，恢复时追加到末尾会把"恢复"变成"挪到最后"。界面在救援条与层栈详情两个地方都给这个动作。
  - **「恢复」不能只长在救援条里**：救援条只在 dsh 起不来时出现，而在层栈详情里点「临时停用」的人 dsh 明明是好的 —— 恢复按钮必须有一个**跟 dsh 状态无关**的入口：巡检那行的「掉出了层列表 / 放回层里」（见上一节），以及停用后那条黄条上的「放回 `<包名>`」（带这次记住的原位置）。这条是踩出来的：用户真机上停用了 `@yozica/dsh-plugin-paths` 之后，界面上再也找不到放回去的地方。
- **不硬猜是哪一层**：只有失败那一行里**真的出现了**某个 bundle 的名字才给它「临时停用」按钮，认不出来就只给「只看内置层」+"到层栈里挑一个"。两条路找这个名字：层栈还在就用层栈（能顺带知道它解析到哪、什么版本）；**dump 读不出来时层栈是空的**，退到 `PluginInspectResult.bundles`（`inspect` 失败时也返回它）—— 而且**只认 `inBox === false` 的**：停用 `@deepseek-ai/dsh-base` 等于把 dsh 拆了。这条是"某个 bundle 解析不到 → dsh 起不来"那个场景唯一的出路。
- **出口三：修**（两条，都只认能认出来的坏法，且改之前先备份）：「修成空配置」（`repairEmptyArray`，只对"只剩注释 / 空文件"生效，别的一律不动并说明原因）、「从备份恢复…」（列出 `cordis.patch.yml.bak-*`，最近的在前；恢复时当前内容也会先备份，所以这一步同样可逆）。**渲染层递来的路径不可信**：`restorePatchBackup` 只接受这份 profile 目录里的 `.bak-`。
- **失败那一行要滤掉 Node 堆栈**：`lastOutputLine()` 先剔掉 `file:///…`、`at …`、含 `throw new` 与 `^` 的行，再优先取 `Error: …` / `dsh: …` / `ERR_PNPM_*`。不滤的话救援条会把源码行当原因显示（真机截图里就是 `if (!Array.isArray(parsed)) throw new Error(...)`）。
- **生效时机两条路要分开写**：临时停用改的是 bundle 列表 → **必须重启 dsh**；patch 层的改动是即时生效的。

自检守着：「救援：临时停用 / 恢复 bundle 记住原位置（恢复之后与原文一字不差）」「救援：配置坏掉时『只看内置层』这条路还在（`--dump-default-config`，不解析你的层）」「救援：基线视图不会被『读不出来』的空态挡住（否则点了按钮什么也看不到）」「救援：只剩注释的补丁层能补成空数组；有内容的文件它不动」「救援：备份按时间倒序列出；恢复只认这份 profile 里的 .bak-」「救援：dump 读不出来时也带上 bundle 清单，且只有非内置的才给『临时停用』」「救援：界面上有『修成空配置』与『从备份恢复』，契约里有 pluginRescue」「救援：界面有救援条与两个出口，而不是只显示一句错误」。

### 运行中的清单：另一条通道（`pluginInventory/list`）

静态 dump 永远看不到这几行：根 `include` 行、以及**启动时用生成的 id 挂上去**的原生目录选择器（host + client 各一）与 HMR。所以两个数字天然差 4（实测静态 153 / 运行中 157）。要拿运行中的事实，只能问 dsh 自己：

```
GET  <origin>/?token=<令牌>            → 303 + Set-Cookie: dsh-auth-<hash>=…（30 天）
POST <origin>/api/pluginInventory/list → cookie 鉴权
     body {"type":"client-request","rpcId":"…","method":"pluginInventory/list","payload":{"args":{}}}
     → { entries:[{entryId,moduleName,enabled,fiberPhase}], agentPresets:[{id,rows:[…]}] }
```

几条硬约定：

- **令牌只在 dsh 由本应用启动时才有**（`DshManager.uiUrl`）；外部实例拿不到 → `live` 为 null，页面显示「运行中清单不可用」，`liveError` 放原因（挂在 title 上）。绝不因此报错或空白。
- 这是 rc 版本内部协议（cookie 名、`/api/<service>/<method>`、信封字段），**整条路都必须"尽力而为"**：失败只记 `liveError`，页面退回纯静态视图。同类依赖（DSH 的磁盘格式）在 7.16 已经有先例。
- 端点 id 在 URL 里是 **`<service>/<method>`**（`pluginInventory/list`），不是生成的完整 descriptor id —— 完整 id 含 `@` 与 `#`，而 URL 段只允许 `[A-Za-z0-9_$.-]`，直接 POST 完整 id 只会拿到 404。
- 运行中的 id 带 **`include:` 前缀**（它们经根 include 加载），跟配置里的 id 对照要先剥掉；三条哈希 id 是启动时生成的，**每次启动都不一样**，断言不许钉具体值。
- `fiberPhase: null` 表示没有存活的根 fiber（多半被上层禁用了），**不是"正常"**，界面上要跟 `active` 分开标；`failed` 才是真的加载失败。
- 夹具 `test/fixtures/plugin-inventory.json` 是**真实应答**（157 条 / standard 28 行等 4 个预设），自检钉住形状；cookie 缓存在实例里，401 时自动重换一次（dsh 重启后旧 cookie 失效）。

自检守着：「插件：真实 dump 解析出层归因与全部条目」「插件：未匹配的 patch 行只在 stderr 上」「插件：空输出不算成功；失败时给的是诊断行而不是 Node 的堆栈首行」「插件：只碰 web profile」「插件：真实应答能解出运行中的条目与预设行数」「插件：运行中的 id 带 include: 前缀，剥掉才和配置里的 id 对得上」「插件：令牌地址解析（没有令牌、地址不是 URL、空值都要老实返回 null）」「插件：调用信封与应答解包（ok:false / 非 JSON / 不是 server-response 都算失败）」。夹具都是**真实输出**（`test/fixtures/`：一份 539 行的真 dump + 一份真接口应答），上游改格式或改协议时这里第一时间变红。

### 7.19 关闭窗口：问一次 / 收起托盘 / 直接退出

**现象**：Windows 上点 X 就是退出，而默认设置 `killOnExit` 还会**连带停掉本应用启动的 dsh** —— 用户点一下关闭，正在用的 dsh 就没了，且应用一句话都没说（这个应用的价值恰恰是"在后台看着 dsh"）。

**现在的做法**（`main.ts` 的 `wireCloseBehavior` / `askCloseAction` / `hideToTray` / `ensureTray`）：

- 设置项 `closeAction` 三态：`ask`（默认，问一次）/ `tray`（直接收起）/ `quit`（直接退出）。设置页那一行**只在 Windows / Linux 显示**（`v-if="!isMac"`）—— macOS 上这个二选一根本不存在，摆一个不生效的开关比不摆更糟（早先的写法是留着它、只在说明里写一句"macOS 不适用"）。
- `ask` 时问「收起到托盘 / 退出应用 / 取消」，带「记住我的选择，以后不再询问」；勾了就写回 `closeAction`。**问的那张卡片是渲染层自己画的**（`shell/CloseDialog.vue` + `CloseDialog` 挂载点），不是原生弹窗：原生 `dialog.showMessageBox` 的长相改不了（字体、配色、间距、动画全归系统），是全应用唯一一个不像这个应用的面孔；自己画还顺带能把真实状态写进去（哪个 dsh 会被停掉、PID 多少、是不是外部实例）。
- 主进程与渲染层之间是**一问一答**：`app:close-request`（带 `CloseRequest` 那几项事实）→ `app:close-ack`（"卡片已经显示了"）→ `app:close-answer`（`{ action, remember }`，动作只认 tray/quit/cancel，认不出来当取消）。原生弹窗没有被删掉，`askCloseActionNative` 是兜底。
- 「收起」= `win.hide()` + 托盘图标；托盘菜单是「显示主界面 / 退出 DSH Console」，单击图标也叫回窗口。
- 托盘图标**随应用一起建**（`bootstrap()` 里调 `ensureTray()`，仅 Windows / Linux）—— 它不只是"收起的落点"，也是**叫回窗口与退出的入口**；等第一次收起才建的话，用户在那之前根本不知道有这东西。`ensureTray()` 幂等，收起时再调一次只是兜底。
- 「已收起到托盘」的气泡**一台机器上只弹一次**：标记是设置里的 `trayHintShown`（内部标记，设置页没有对应控件），不是内存变量 —— 只记内存的话每次开应用收起都要被提示一遍。弹失败时不记，下次再试。
- **macOS 完全不参与**：那边关窗不退出、Dock 常驻是系统惯例（7.3），`wireCloseBehavior` 第一行就 return。
- 托盘图标读的是 `build/icon.png`，运行期缩到 **32**（100% DPI 的托盘是 16px、150~~200% 是 24~~32px；给 32 让系统往下缩，比钉死 16 在高分屏上被拉大好）。因此 **`build/icon.png` 现在必须打进 asar**（`package.json` 的 `build.files` 里那一行）—— 打包后 exe 的图标可以取自可执行文件，托盘没有这条路径。自检里没有钉这一行，但删了它打包版的托盘图标就是空白。

**三条必须守住的时序/边界**：

1. **`before-quit` 里先置 `isQuitting`，close 处理器据此放行**。不置位的话，「收起」会把托盘菜单的退出、`updater.quitAndInstall()`、乃至系统关机一起拦下来 —— 界面再也退不掉了。托盘对象的销毁也放在这里（放在别处会留下一个幽灵图标）。
2. **只给握手设时限，不给用户思考设时限**（`CLOSE_ACK_TIMEOUT_MS = 2000`）。主进程发完请求等一个 `app:close-ack`，确认一到就 `clearTimeout`，然后**一直等**用户选 —— 第一版把"多久没回答"当判据，结果卡片明明已经显示出来、用户还在看，两三秒后系统弹窗自己冒出来了。确认迟迟不来（渲染层没连上、卡住、崩了）才退回 `askCloseActionNative`，并 `sendToRenderer('app:close-request', null)` 让卡片收起来；`render-process-gone` 也会把挂着的询问答成"问不到"，免得渲染层崩了之后窗口再也关不掉。自检「关闭询问：只给"卡片显示出来"设时限（用户想多久都行），且真正退出不被拦」钉着这一条与下一条。
3. **托盘建不起来就退化成最小化**（`ensureTray()` 返回 false，例如读不到图标）：藏起来而没有任何入口叫回来，比最小化糟得多。

**主进程改设置要推给渲染层**：`ask` 对话框里勾「记住我的选择」是**主进程直接写盘**的，走 `sendToRenderer('settings:changed', next)`（契约 `DshConsoleApi.onSettings`，store 里订阅）。不推的话设置页那份表单还留着旧值，用户下次一按保存就把它写回去了。设置页只跟 `closeAction` 这一个键，不整份 `fill` —— 那会顺手盖掉用户没保存的其它改动。

**底栏「发现新版本」点进来要落到更新卡片上，而且要有"被带过去"的过程**：只切页不够（设置页好几屏，卡片在「关于」里）。这条流程分三步，顺序不能换（`SettingsPane.spotlightUpdateCard`）：

1. **切页并落定**：`StatusBar` 改 `currentTab`，设置页等一次 `nextTick`（页面靠 visibility 切换）**再停 300ms**（`SETTLE_MS`）。这一停不能省：切页与滚动同时发生的话，界面换了、滚动也开始了，眼睛还没认出新页面就已经滚到位（用户反馈"怪"）；
2. **缓动滚动**：`lib/scroll.ts` 的 `scrollIntoViewEased(el, 620)`。**不用原生 `scrollIntoView({ behavior: 'smooth' })`** —— 它的时长与曲线由浏览器定、偏快（用户反馈"还没看清就到了"）；自写的曲线是缓入缓出三次方，时长在调用处给，系统开了「减弱动效」就直接跳过去；
3. **聚焦蒙层**：必须**等滚动结束**再量 `getBoundingClientRect()`（滚动途中量会把洞画到半路），然后在整张「关于」卡片处开洞。`.spotlight` 是 `position: fixed; inset: 0` 的全窗口蒙层，靠 `box-shadow: 0 0 0 9999px var(--scrim)` 铺满、只留卡片那个洞；另一个元素「环」做强调色呼吸（环要动扩散，而洞那层带着 9999px 的巨大阴影，拿它做动画既贵又难看）。蒙层 `pointer-events: none`：不挡用户点卡片上的按钮；点一下 / 按一下键 / 滚一下滚轮 / 2.6 秒到点都会收掉。它用 `Teleport` 挂到 `body` —— 挂在页面里会被 `.settings` 的滚动容器与各级层叠上下文限制住，盖不到左栏、顶栏和底栏。

信号放在 `lib/update-anchor.ts`：**递增的请求号**而不是布尔量（第二次没有变化，watch 不触发，看起来就像"点了没反应"）；每次请求带一个 token，中途又点一次时旧流程在 `await` 处自行退出。

### 7.20 运行环境自检：探测是只读的，修复只有两个动作

**为什么有这一页**：dsh 起不来时界面上只有一句「已停止」，而最常见的原因恰恰是说不出口的那种 —— 本机 Node 版本不兼容时 dsh **静默退出**（退出码 0、零输出，见 7.4），光看退出码永远发现不了；插件的装 / 卸 / 升级又会因为 GUI 应用的 PATH 很窄而缺 pnpm（7.18 第 2 条）。所以把「这台机器上到底有什么、能不能用」逐条摆出来（t45 之前它是左栏第 8 页，现在是设置页「运行环境」卡的详情视图，见 7.30）。

**探测与判定分家**：`main/env-doctor.ts` 的 `collectEnvProbe()` 只负责收集事实（跑 `--version`、查 PATH 与已知目录、读 `process.versions`），`judgeEnvironment(raw)` 是**纯函数** —— 入参只有已经收集好的结果，不碰磁盘、不起子进程、不读 `process.*`、也不看时钟（`checkedAt` 由调用方塞进 `raw`）。所以那 8 项的所有分支在自检里都能用**手工构造的对象字面量**跑完，不需要装 pnpm、不需要起任何进程（与 `parseNetstatForPort` / `checkDumpResult` / `windowsBinCandidates` 是同一套路）。加一项判定时改 `EnvCheckId` 联合类型，渲染层那张 `Record<EnvCheckId, string>` 的标题映射会跟着报错，漏不掉。

**两个动作的边界**：一键修复只有 `install-pnpm` 与 `install-dsh`，都只改**全局 npm 包**；不装 Node、不改 PATH、不写 `.npmrc`、不提权、不动 `$DSH_HOME`。几条必须守住的：

- 渲染层只递 `action`，命令原文由主进程用 `fixPlan()` 现场重算（与 7.18「救援时渲染层递来的路径不可信」同一条原则）；
- 每次都先在**页内**点一次确认（不弹原生对话框，理由同 7.19），跑的过程中输出实时可见、可中断；
- 同一时刻只允许一个动作：互斥位是**同步**置位的（在第一个 `await` 之前），终态才释放 —— 异步置位会让两次点击都通过检查；
- `FIX_TIMEOUT_MS` 到点自动 kill，而且**超时是独立终态**：判定要放在「子进程报错」「退出码 != 0」**之前**，否则那句「超过 N 分钟没跑完」会被通用的失败分支吃掉，退化成「退出码未知，认不出具体原因」；
- 跑完自动复检一次，结论随 `EnvFixState.report` 与 `env:fix-state` 回来。

**Windows 上两条坑，一起收口在 `process-utils.ts` 的 `launchSpec()` / `dshLaunchSpec()` 里**：一键装包、插件的三个启动点（装 / 卸 / 升级、`--dump-config`）与 `dsh web` 都从这一处取，探测侧与执行侧用的也是**同一个**它 —— 分开各写一遍就会出现「修复起不来、探测却说正常」这种自相矛盾的结论。把这两个公共件放在 `process-utils.ts`（而不是 `env-doctor.ts`）是为了让 env-doctor 与 plugin-manager 都只是**取用**它，谁都不必 import 谁。

1. Node 安装目录里 `npm`（POSIX sh 脚本）与 `npm.cmd` 是并存的，只按 PATH 找「叫 npm 的那个文件」会拿到前者 —— 它既不是能直接 spawn 的 PE，也不是 cmd 能跑的批处理（直接 spawn 报 `EINVAL`）。所以解析侧只认带可执行扩展名（`PATHEXT`）的那个，`whichSync()` 在 Windows 上不再返回无扩展名的同名文件。
2. `.cmd` / `.bat` / 无扩展名，以及**已经是 `cmd.exe` 的调用**，都要经 `cmd.exe`：把 `/d /s /c` 之后拼成**一个**参数、整条再套一层引号，并给 `spawn` 传 `windowsVerbatimArguments: true`。少了这个，Node 自己的引号规则会把 `"C:\…\npm.cmd"` 再转义一次，cmd 报 `\"…npm.cmd\" is not recognized`（`/s` 会剥掉最外层那对引号，剥完才是真命令行）。

**一键装 pnpm：「装完当场能用」是判据，不是口号（VM-06 / VM-07 / VM-09 的教训）**：

- **现象 A（npm 的 install-scripts 门禁）**：`npm i -g pnpm` 退出码 0、文件也落到了盘上，`pnpm -v` 却起不来；npm 自己在输出里写着 `1 package has install scripts not yet covered by allowScripts: pnpm@… (preinstall/postinstall: node install.js)`，并给出放行的写法。**这里的口径是「已知的坑 + 我们加了放行与诊断」，不是我们认定的根因**：本机对照实验（`.verify/npm-allow-scripts-experiment.log`）里**带不带那个开关都能装出能跑的 pnpm**，所以任何地方都不许写成「因为它所以坏」。`env-doctor.ts` 里那段注释把话说明了 —— 开关是「按 npm 原文补上的一手（无害且官方）」，真正的交付是把「文件在、跑不起来」做成**可诊断的失败态**。
- **现象 B（纯净 Windows 缺 VC++ 运行库，VM-09）**：`npm ls -g` 显示 pnpm 装上了，`pnpm -v` 却**零输出**、并弹出「由于找不到 VCRUNTIME140.dll，无法继续执行代码」。实测事实是 pnpm 11 起在 Windows 上发原生程序（10.x 的 `bin/pnpm.cjs` 是纯 JS，能跑）。所以 `pnpmInstallSpec(vcRuntime)` 按运行库在不在选线：缺 → `pnpm@10`（纯 JS 那条），有 → 最新。**只跟 pnpm 有关**：同一台真机上 `node -v` / `npm -v` 都正常，不要因此要求用户去装运行库。
- **判据**：装完必须**真的跑一次** `<pnpm> -v`，有输出才算成功（与 7.4「有输出才算能跑」同一条口径）。只看「文件在不在」会把这一屏判成成功 —— 用户看到的是「装完了还是红的」。
- **三条做法**：① 放行开关只作为**这一次 argv 的一个元素**（`ALLOW_INSTALL_SCRIPTS_FLAG`），绝不 `npm config set` / 写 `.npmrc` / 动用户全局配置（自检用正则盯着 `config set` / `--location=user` / `.npmrc` 不许在 `env-doctor.ts` 里出现）；② 没通过就把**那一次实际执行的命令、退出码、stdout、stderr** 落进日志，功能实测那条命令（`<pnpm> -v`）的原文也落一份，空的那一路写「（空）」—— VM 那一屏的症状正是「两路都空」，写出来才看得见；③ 同一次运行内**先刷新查找路径再复检**：重读注册表 PATH（用户级 + 机器级，展开 `%NVM_HOME%` 这类引用）+ 重扫已知 bin 目录，并把 `npm prefix -g` 那个目录**排在最前** —— 排后面会被 PATH 里旧的那一份先选中，刷新等于白刷。
- **对外形状与三条口径**（细节留日志 / 一次性开关不改全局配置 / 装完同一次运行内刷新）写在 **`docs/env-doctor.md` §3.4**：`ALLOW_INSTALL_SCRIPTS_FLAG`、`PNPM_PURE_JS_SPEC` / `pnpmInstallSpec`、`refreshLookupPath`、`probeFixTarget`、`fixDoneMessage`、`EnvFixHooks.logFile?`、`parseRegQueryVars` / `expandEnvRefs` / `mergePathText`。**签名与逐条口径放设计文档**（它跟模块一起改、能写清「为什么」），AGENTS 只留「现象 → 判据 → 做法」加指针 —— 签名抄进这一份，第二天就会过期。
- **哪条自检守着**（`test/selftest.ts` 的 17a 组 + `scripts/env-doctor-cases.mjs`）：「装 pnpm 带一次性 install-scripts 开关，且绝不改用户的全局 npm 配置」「`mergePathText` 合并去重保序；`refreshLookupPath` 把新目录真的写进本进程 PATH（键名保持 `Path`、第二次不重复注入）」「收尾那句话分得清四种情形，『重开应用』只在刷新后仍找不到时出现」「没有装出可用结果时命令 / 退出码 / stdout / stderr 全落进日志」「`describePnpmRunFailure` 认出缺运行库：给人话 + 两条出路」；case G 逐字钉住 `… i -g pnpm --allow-scripts=pnpm`。**真机装一次、看一次「文件在但跑不起来」的日志，仍然要人工验。**

**报告是「拉」的，没有 `onEnvReport`**：契约里只有 `envCheck()`、`envFix()`、`envFixCancel()` 与 `onEnvFixState` / `onEnvFixOutput` 五个成员。主进程按需探测并把结果缓存住（`{ refresh: true }` 才清缓存重跑），修复后的复检结果随修复状态回来；渲染层 `lib/env-doctor.ts` 是唯一的镜像。启动后 1.5 秒主进程会自己跑一轮（不 `await`、不阻塞启动），**每轮在事件日志里留一行**（`环境自检：N 项正常 · N 项需要注意 · N 项不正常（先看 x）`）—— 留一行是为了报障时先看到事实，不是为了刷屏。

**自检页常驻挂载**（所有页面都靠 visibility 隐藏，见 7.6），所以它在**挂载时**就 `loadEnvReport()`，而不是等「首次进入这一页」：控制台顶部那条横幅与插件页的「没找到 pnpm」读的是同一份报告，等切页才拉会和它们抢第一次数据。

**设置项**：阶段一那一版自检本身**没加设置项**（探测是只读、修复永远要用户点）；阶段二加了两个（`envSkips` 跳过的步骤、`envNodeSource` 安装包下载源，见 7.21），这两个要按 7.14 的规矩**同时**改契约与 `DEFAULTS` 两处、改完**重启应用**。

**哪条自检守着**（都在 `test/selftest.ts` 的「环境自检」一组里）：「judgeEnvironment 是纯函数」「八项都在、id 不重复、顺序固定」「不满足必有出路（每项非 ok 都有 fixHint）」「找不到 dsh 与跑不动 dsh 分开判」「Windows 上的启动 spec 真的起得来」「解析出的 npm / pnpm / node 一定是能执行的那个（不许拿 POSIX sh shim 充数）」「PATHEXT 优先于裸名，首行 `#!` 的无扩展名 shim 不算可执行文件」「探测与修复走同一个包装器」「超时是独立终态」「单动作互斥是同步置位」「契约里有 8 个 id、2 个动作、5 个 API」「渲染层的标题映射覆盖全部八个 id」。真机上一次 `npm i -g pnpm` 这类**改机器状态**的动作不进自检，靠人工验。

### 7.21 首启环境门禁与 Node 安装：硬门禁 + 永远可用的逃生口

**为什么有这一层**：在一台什么都没有的 Windows 11 上，进了主界面也只能看着 dsh 起不来（见 7.4）。所以启动后先跑一轮**只读**探测，缺东西就盖一张**覆盖层**（不是第 10 个页面 —— 做成页面就能用 `Ctrl+2` 切走），逐步把 Node → pnpm → dsh 装好，环境 OK 才放行。判定与"动手"分家：`main/env-doctor.ts` 的 `judgeWizard(report, skips)` 是**纯函数**（入参只有阶段一的报告 + 用户跳过的步骤），`main/node-installer.ts` 只负责把系统改对，`renderer/lib/env-wizard.ts` 管相位与显示。

**几条必须守住的**：

- **逃生口是这一层的底线，而且必须与安装动作解耦**：底部常驻「先进入界面（环境还没准备好，我稍后自己处理）」，它只调 `escapeGate()` —— **两行纯内存赋值**：不写盘、不发 IPC、不看安装状态、不受互斥位影响（自检有一条记账探针盯着「探测卡死时逃生仍能放行」「逃生期间触碰 preload 出口 0 次」）。逃生不是一次性豁免：下次启动重新判定（它不落盘）；跳过某一步才写设置（`envSkips`），并且能在环境自检页加回来。
- **`gateVisible` 与 `gateDiversion` 不是一个量**：前者是"门禁层**该不该显示**"（渲染的输入）= 启动锁不在显示中 **且**（`blocked` ｜ `checking` 且这一轮属于门禁层 ｜ `released` 且本轮显示过挡住页）；后者是"用户是不是**被门禁层接管着**"（键盘要不要改道）= `escaped` / `entered` / `done` / `unknown` 四个相位显式放行、其余才读 `gateVisible`。**三种不相等的情形**（收尾相位 / `unknown` / 启动锁期间）都写在注释里：逃生之后 `Ctrl+R` 必须恢复，而健康机器第一次就是 `open` 时压根不该显示任何全屏层。
- **`blocked` 时不自动拉起 dsh**：启动决策用一次**快速探测**（`collectBootProbe`：只读文件系统、不起子进程），把"要起子进程才知道的项"标成 `skipped` —— 判定把 `skipped` 当 `warn`（测不出来，不挡人），只有**有证据的缺失**才 `blocked`。于是健康机器不为判定多等一次，干净机器也不会先看一遍失败的启动。
- **Node 的存在性以官方校验清单为准**：`index.json` 只用来列版本，**它的 `files` 数组从来不列 `win-arm64-msi`**，拿它判架构会让 arm64 机器永远拿不到这个功能；权威证据是同一版本目录下的 `SHASUMS256.txt`（本来就要取它校验哈希）。取不到清单 = **网络失败**，如实说，**不许**降级成"这台机器不支持"。
- **nvm 那条路的发布事实**：发布 API 用 `https://api.github.com/repos/nvm-windows/nvm/releases`（旧的 `coreybutler/nvm-windows` 会 **301** 到同一个仓库）；**node 的 `https.get` 不跟 301**，仓库名写错就是一次静默的网络失败。资产按模式挑（新线 `nvm-<版本>-amd64-setup.exe` / `-arm64-setup.exe`、旧线 `nvm-setup.exe`；跳过 `*-sync.exe` 与预发布），**`x64` 要映射成 `amd64`**；新线资产带 `digest: sha256:…`、**旧线没有**（那是正常情形，走"这次没能校验安装包的完整性"，**不许**用 `nvm-setup.zip.checksum.txt` 去猜 exe 的哈希）。
- **签名的语义分两段，别把两件事塞进一个可空字段**：计划阶段 `signer === null` 只表示"**还没读**"（Authenticode 要读文件才有），不得据此说"没有数字签名"、也不得因此多一次确认；计划阶段唯一能依据的是 `releaseSigning`（**发布元数据的自述**，官方直装恒 `'unknown'`）。`parseReleaseSigning` 的**判定顺序**是要紧的：先判 `Unsigned community build` 再判 `Authenticode-signed community build` —— "Unsigned" 里也含 "signed"，顺序反了会把未签名认成已签名、**静默跳过**那次确认（最新稳定版 v2.0.0 就是 `Unsigned`，所以这不是边缘情况）。下载后才读真实签名：明确未签名/无效且计划阶段没确认过 → **不安装**；读不到 → 继续并在结果里如实写「这次没能读到安装包签名」。
- **安装器静默参数按形态识别，不是 NSIS**：实测 nvm-windows v2.0.0 是 **Inno Setup**，用 `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-`；**`/S` 是 NSIS 的写法，对它无效**（会给用户弹一个没人管的窗口）。识别不出来时把「正在等待安装程序：它有一个窗口需要你点选」作为 `EnvInstallState.message` 推给界面 —— 契约**有意不**新增 `needsUserInteraction` 这类字段。
- **安装一旦开始就不杀**：`stop()` 按相位分两种语义（下载 / 校验 = 真取消并删临时文件；安装 / 等待 = 只置 `detached`），`detachOnQuit()` 在退出时也**不杀不 wait**；互斥锁在 `detached` 期间**仍然持有**，直到复检证明落地 / 用户点「我确认安装已经结束」/ 应用重启。**阶段一那条 5 分钟超时 `kill` 的规则不适用于安装器**（杀在半路会留下一个半装的 Node）。
- **面向用户的结论不许出现内部记号**：`detail` 里不写 `EPERM` / `EACCES`（同一个含义说成人话："这个运行环境不允许起子进程 —— 不代表没装"），原始错误经 `EnvDoctorHooks.log` 落 `<userData>/logs/console.log`。判定口径也随之收紧：**只有真的跑不起来（有路径但零输出 / 退出码非 0）才 `missing`**，"测不出来"仍是 `warn`（不挡人，与门禁判据 `pnpm.status !== 'missing'` 对齐）。
- **版本管理器的模型按 v2 的真相推，不按 v1 的变量推**（VM-11 / VM-12 的客机实测）：nvm-windows **v2** 用 **shim 模式 + PATH**（用户 PATH 里是 `<root>` 与 `<root>\.nodejs`），各版本在 `<root>\installs`，**不设 `NVM_HOME` / `NVM_SYMLINK`**，另有 `nvm on/off`（注册表 `Enabled` 里读得到）；`NVM_HOME` / `NVM_SYMLINK` 只作 v1 风格机器的兜底。所以 `deriveNvmModel()` 的证据优先级是「`nvm.exe` 的真实路径 → `nvm env` / 注册表偏好 → 用户 PATH 里那条 `…\nvm` → `NVM_HOME`」，`activeDir` 先认 PATH 里真实存在的 `.nodejs`；**模型不许写死成 v1 的形状**。配套那条更硬的规矩：**「版本管理器装好了但没有可用版本」不是让用户回终端 `nvm use` 的理由 —— 装版本是应用自己的事**（`nvm install` → `nvm use` → 实测 `<node> --version` 与 `<npm> --version` 都有输出才算完成）。模型、证据与这条状态的出路写在 **`docs/env-wizard.md` §7.6**。
- **「更新 Node」不许把方法写死 —— 判据跟着那份 Node 的真实归属走**（VM-14 的真实现场）：**现象** —— 这台电脑上的 Node 由版本管理器管着，点「更新 Node.js」却下载了官方安装包装到 `C:\Program Files\nodejs`，装完机器上**有两份 Node**，之后 `node` 用哪一份只看系统查找路径里谁在前（终端 / 插件 / 我们自己可能各拿一份）。**原因** —— 渲染层把方法写死成直装（历史现场是 `panes/EnvPane.vue` 里两处调用的 `method: 'direct'`），而"这份 Node 归谁管"这件事**在契约里根本没有字段可读**，于是界面只能替用户猜一个。**现在的做法** —— 归属判定 `detectNodeOwner()`（纯函数，判据见 `docs/env-wizard.md` §7.7）→ 进 `EnvDoctorReport.nodeOwner` → 计划里 `EnvNodePlan.owner`：`nvm` 只走版本管理器、`system` 只走官方安装包、`unknown` **不预选**（更新不做自动更新；安装两条路都列出来让用户显式选 + 先说清两份并存的后果）。**两种 `unknown` 必须分开（VM-16）**：**已经有一份 Node** 时两条路都列、**一条都不预选**（必须显式选）；**一份 Node 都没有**时**两条路也都要在**（默认**预选**一条：机器上已有可辨认的版本管理器就用它，否则官方安装包），预选**只是预选**、随时能改 —— 把这一支做成"只给一句事实行、另一条点不了"，就是用户重置虚拟机后第一次装 Node 时**找不到「用版本管理器安装」**的那个回归。**渲染层只递选择、不递事实**：更新入口的请求是 `{ mode: 'update' }`（方法省略 = 跟随归属），归属判不出来时那一行**不给「更新」**，只给官方下载页 + 重新检测。配套两条同样要守：**机器上已经有可辨认的版本管理器时不许再装它一遍**（`EnvNodePlan.installsManager === false` → 跳过下载与校验两段，直接 `nvm install` → `nvm use`），以及**归属纯函数只有一份**（`env-doctor` 采集侧与安装计划共用，渲染层零路径判断）。
- **档位是事实，不是偏好：`switchesChannel` 按构造保证，别改回去**（VM-15 的另一半）：**现象** —— 用户在向导里选了「当前版」装出 `v26.9.0`，之后点「更新」，目标却按默认的稳定版算成 `v24.21.0`，**比已装的更低**，而界面没说这是换档。**原因** —— 目标档位的默认值写死成 `'lts'`；"这一次是不是换档"只在显式选档那一支上算，于是另两条可达路径（`install` 的设计默认正好跨档、目标版本比现在低）拿不到"这是换档"的事实，界面就把它当"更新"显示。**现在的做法** —— ① `update` 省略档位 = **跟随当前档位**（当前档 = 已装版本在官方清单里那一条的 `lts` 字段，判不出来就 `null`、不许猜），只有 `install` 才用设计默认的"最新稳定版"；② `decideNodePlan()` 在**所有**分支上算 `switchesChannel = direction === 'older' || (currentChannel !== null && channel !== currentChannel)` —— 即"**档位变了 或 目标更低**"这个**超集**语义，于是约定 ②「`direction === 'older'` ⟹ `switchesChannel === true`」**按构造无条件成立**（不是靠"跟随时现实中不会出现更低的目标"这种概率性理由）。⚠️ **`src/shared/ipc.ts` 里那句注释只写了充分条件**（"目标档位与当前档位不同 = 这是「换档」"），照它把这一行改回"只比档位"就会让 `older` 重新变成一次没有解释的静默降级（t9 的变异实验正是这么把它还原红的）—— **以后者（代码里的构造）为准，别照注释改**；③ 跨档的**两个来源**都要认：用户显式选档，以及 `install` 的设计默认正好跨档（向导第三步「换一个 Node」那条可达路径）。
- **「先停 dsh」这类承诺必须与引擎的实际动作同位**（同一类坑的第二个实例）：**现象** —— 确认区上写着「更新会先停掉正在运行的 dsh」，但真机上 `dsh` 没被停。**原因** —— 那句承诺对应的 `hooks.stopDsh()` 原先住在 `installPhase()` 里，而"机器上已经有版本管理器"（`installsManager === false`）那条路**整个跳过安装阶段**，于是那句承诺**悄悄落空**（界面说着会停、实际没停）。**现在的做法** —— 停 dsh 是 `execute()` 里 `mode === 'update'` 的**唯一一处**调用（`stopDshForUpdate()`，排在 `installsManager` 分支**之前**）：不管走哪条路、要不要下载，先停一次，结构上不可能漏、也不可能停两次。**代价与时序**（船长裁定，记下来免得后人当 bug 修）：直装那条路因此从「下载 → 校验 → 停 → 装」变成「**停 → 下载 → 校验 → 装**」—— 好处是与需求 §8.3 的"先停、再更新"逐字一致、两条路共用同一处；代价是**下载失败 / 取消时 dsh 已经被停了**。这个代价**可以接受**：终态仍是 `error`（界面照旧给「重新启动 dsh」这个一键恢复的出口），不为它新增"dsh 已经停掉了"的额外文案。

- **向导正文画的是「正在看哪一步」，不是「判定给的当前步骤」**（t43，冻结 §0.3 的 R-28 ~ R-31）：判定仍在主进程（`currentStepId`，界面不自己判），但正文多了一层**视图相位** —— 默认跟着判定；用户在**左轨**点了走过的节点（`已完成` / `已跳过`，做成真按钮、按阅读顺序进 `Tab` 顺序）之后**钉住**，正文改画**只读回看卡**（结论 + `step.detail` 的原文 + 一个「回到当前步骤」，**卡里没有任何安装 / 跳过动作**）；判定再前进也**不把用户推走**，只出一行「下一步（…）也已经就绪了」/「三步都完成了」的提示，点了才过去。纯规则在 `renderer/lib/wizard-view.ts`（能直接测，所以别把它塞回读 `window` 的那个模块），`lib/env-wizard.ts` 只存"钉住了哪一步"。两个最容易踩的点：**`screen` 里回看优先于放行页**（只看 `gate === 'open'` 会在最后一步完成时把正在回看的用户直接推到结果页）；**`gateVisible` 的 `released` 分支是 `blocking || reopened`** —— 用户从自检页 / 横幅显式重开的那一轮，判成 `open` 也要停在放行页，否则就是"点了一下、一闪就没了"（R-31）。
  **哪条自检守着**（`test/selftest.ts` 的「环境向导」一组 + `scripts/env-wizard-cases.mjs`）：「skipped 项判 warn 不是 missing」「快速探测把要起子进程才知道的项标成 skipped」、门禁判定的 I 系列（全 `warn` → 三步 `done` → 放行；`report.error` 非空且无 `missing` → `unknown` 不挡人；**有 `missing` 证据就挡**）、「首启门禁：逃生口不写盘、不依赖任何安装动作」、「首启门禁：跳过 / 恢复只走 `envWizardSkip`」、安装引擎的 M 段（两条路、退出码分类、等太久的"未确定"、复检失败不说 done）。**t43 的一组（18a 节）**：左轨只有走过的步骤可点（当前 / 没轮到的都不行）、正文画钉住的那一步（它不再成立时静默回当前）、判定前进的两种文案、左轨是按钮且带 `aria-current`、回看卡里没有安装 / 跳过动作、`screen` 回看优先、`reopened` 在重开 / 逃生 / 进入三处的一置两清。**这一轮（t29）新增的几条**：归属纯函数与计划形状（「环境向导（VM-14）：归属 → 方法」「档位跟随当前、跨档才叫换档」）、`switchesChannel` 的三条不变量（跟随时**不许**被误报成换档 / `older` 必须伴随换档 / `install` 设计默认跨档也必须为真）、实例断言（「安装引擎（VM-14）：nvm 那条路的机器上不再装管理器」「环境自检页（VM-14 / VM-15）：更新入口不写死方法，档位不写死字面量（默认跟随、显式才换档）」），以及 `scripts/env-wizard-cases.mjs` 的 O 段（648 组合穷举：`direction === 'older'` ⟹ `switchesChannel === true`，反例 0 条）。**变异守则**（评审时照这两条做，t9 / t12 各做过一次）：把 `await this.stopDshForUpdate();` 拿掉 → 停 dsh 那组断言变红；把 `switchesChannel` 还原成"只比档位" → 跨档那组断言变红。真机上装一次 Node、看一次 UAC、断一次网仍要人工验。

### 7.22 改源码不能整文件往返写：编码与换行会被毁掉（同类事故已两次）

**现象**：用 shell 的文本管道对源码做**整文件往返写** —— PowerShell 的 `Get-Content -Raw` 之后 `Set-Content` / `[IO.File]::WriteAllText()`，或 `cat` / `sed` 一类管道重定向 —— 改完之后文件**变成了乱码**：满篇 `瀹宸鐨` 这种「UTF-8 中文被当 GBK 读、又按另一种编码写回去」的字，或者换行（CRLF / LF）与注释被破坏。

**原因**：读进来时走了**非 UTF-8 的代码页**（Windows PowerShell 5.1 的默认编码是 ANSI / 系统代码页，不是 UTF-8），写回去时又按另一种编码 —— 两侧不一致，字节就不再是原来那串。这不是"文件坏了"，是**工具链把整个文件改写了一遍**。

**发生过两次**（所以这条不是理论风险）：

- `src/main/main.ts`：丢过注释（3 句整句丢失 + 若干排版差异）—— 当时靠**事故前的编译产物**逐字对齐恢复（t16/t20 的 F-04 复核：注释逐字回来、其余差异全部可归因）。
- `test/selftest.ts`（4593 行）：为了让一个标识符改名做了整文件往返写，**整篇变成乱码**，随后用「出错前那一份编译产物」当 oracle 重建了全文（t39/t40）。

**现在的做法**：

- **改源码只用带字节级语义的工具化编辑**：`edit` / `write`（以及任何"按字节读写、不经过文本代码页"的编辑器或脚本）。**不要**用 shell 的文本管道做「读全文 → 替换 → 写全文」。
- 确实需要批量替换时，用**能明确控制编码与换行**的手段：写文件时显式 **UTF-8 无 BOM**、换行 **LF**（Node 侧 `fs.writeFileSync(path, text, 'utf8')` 且文本里只留 `\n`；PowerShell 侧至少要 `-Encoding utf8NoBOM` / `new UTF8Encoding(false)`），并且**先备份**。
- 改完立刻对账：`git diff --stat`（行数暴涨 / 暴跌就是出事了）、`git diff` 看自己是不是改到了预期之外的行。

**编译产物能当 oracle，但不是备份**：真出事时它救得了**语义**（逐行比对能把"改了什么"还原出来），**救不了注释与排版** —— 上面两次恢复都得靠人再对一遍注释，这就是代价。要按"随时能回到上一版"的心智改源码，别把 `dist/` 当成 git。

**发现损坏时，检测手段本身也要验证**：这类损坏**可能仍是合法 UTF-8、`U+FFFD` 为 0** —— 只数「替换字符」的尺子会让你以为文件是好的。工作区根（**在仓库外**）那份真坏文件 `.tmp/selftest-corrupted-backup.ts` 就是活证据：`合法 UTF-8 = true`、`U+FFFD = 0`、无 BOM、无 CRLF，可换一把「乱码字母表」的尺（把 CJK 按 UTF-8 编码、再用 CP936 解码得到的字符集合）去量，它命中 **171 个不同字符 / 共 8434 次**，而恢复后的现树是 **0 次 / 0 个字符**。可用的判据按力度排：

1. **乱码字母表扫描**（本轮那把尺的可用实现：`.verify/t40/enc-scan.mjs`，可对任意文件跑）—— 命中数不为 0 就是有残留；
2. **与编译产物逐行比对**（Myers diff，语义层面唯一硬的证据；`.verify/t40/myers-diff.mjs`）；
3. **与上一轮门禁日志对断言名**（`scripts/selftest-sandbox.mjs` 的输出是逐条断言名，丢没丢一列就知道；`.verify/t40/name-diff.mjs`）。

**哪条自检守着**：**没有一条自检盯着"源码有没有被写坏"** —— 乱码落在注释或字符串里时 `typecheck` 与 `lint` 可能照样绿，所以这条只能靠纪律挡（别用那条路）+ 出事时用上面三条判据。**顺带一条反例**：`format:check` 不是编码检查 —— 乱码文本照样是合法 UTF-8、照样能被格式化，别拿它当保险。

### 7.23 Windows 专用逻辑一律 `path.win32`（否则 Linux CI 假红）

**现象**：改动前 `main` 的 CI 是绿的；这一轮推上去之后，`check` 的**自检**步骤红三条，而**本地（Windows）269/269 全绿** —— 同一个提交在两个平台上结论相反。

**原因**：那些逻辑是**Windows 专用**的（VC++ 运行库的两个 DLL、Windows 上的 pnpm / node 查找），但拼路径时用了**跟着"跑测试这台机器"走**的 API：

- `path.join(...)` 而不是 `path.win32.join(...)` → 在 Linux 上拼出 `D:\Windows/System32/vcruntime140.dll` 这种**混合分隔符**；
- `path.delimiter` 而不是 `path.win32.delimiter`（`';'`）→ 在 Linux 上 `';'` 切不开，整条 Windows `PATH` 被当成一个目录，候选目录全丢。

而**候选目录本身是按 `path.win32` 拼的**（`windowsBinCandidates` 一直这么写，注释也写着"不受跑测试的这台机器的影响"）——两边分隔符不一致 → 存在性判断查不到那个文件 → 断言假红。

**现在的做法**：凡是描述 Windows 路径的代码（`%SystemRoot%\System32`、`%ProgramFiles%\nodejs`、`%LOCALAPPDATA%\pnpm`、PATH 里的 Windows 目录……）**一律用 `path.win32.*`**；`env.Path` 这种 Windows `PATH` 按字面量 `';'` 或 `path.win32.delimiter` 切。本轮的落点：`vcRuntimePaths`、`findPnpmWindows`、`windowsSearchDirsFor`、`whichWindowsExe` / `whichWindowsExeWith`（`windowsBinCandidates` 本来就是对的）。**这不改变生产行为**（这些函数只在 Windows 上被调用，而 Windows 上 `path.win32.join === path.join`），换来的是**在任意平台都能测**。

**另一类同源假红**：断言里写死了"这台机器必然有 / 必然没有"的事实 —— 例如 `hasVcRuntime` 在**非 Windows 上恒为 `true`**（源码里就是这条语义），断言若写成"缺一个 DLL 就是 false"，在 Linux CI 上必红。这类要**按平台分支**（`IS_WINDOWS ? … : …`）；确实只对 Windows 成立的整条断言，用既有的 `if (!IS_WINDOWS) { skip(名字, 原因) }` 写法跳掉。

**这一轮又补了三处同类**（门禁里 `M launchSpec` 在 macOS 上就是这么判红的）：`isCmdExe` / `isPeImage` / `isRunnablePath` 里的 `path.basename` / `path.extname` 全部换成 `path.win32.*` —— 在 POSIX 上 `basename('C:\\Windows\\system32\\cmd.exe')` 返回**整串**，于是 `cmd.exe` 被判成"不是 cmd.exe"，`launchSpec` 走进 `.exe` 直连分支（`verbatim=false`、不再包引号），而用例脚本期望的是 `""…" web"`。Windows 上两种写法等价，所以生产行为不变、只有非 Windows 的测试看得见差别。

**哪条自检守着**：没有一条能直接钉住"路径拼对了几个平台"，这一条靠纪律 + CI 跨平台跑（`check` 在 `ubuntu-latest`）。**推论：不要在本地绿了就认为 CI 会绿** —— 涉及路径 / 分隔符 / 平台事实的改动，推上去看 `check` 才算完。

**顺带一条**：`scripts/*-cases.mjs` 只被**沙箱门禁**（`node scripts/selftest-sandbox.mjs`）跑，CI 里没有这一步 —— 所以这类脚本红着不会有人知道（上面那条 `isCmdExe` 的红就是这么攒下来的）。改到它们覆盖的模块时，**跑一遍门禁**，别只看 `npm test`。

### 7.24 启动早期必须留痕：日志、兜底与单实例锁

**现象**：真机上"双击新版本没反应、过一会系统报崩溃"，而 `<userData>/logs/console.log` 里**一行都没有** —— 于是分不清"进程根本没起来"和"起来了但没到 ready"，只能靠猜。同一时期还发现：已经在跑一个实例时再启动，会留下一个**没窗口、没日志**的进程（macOS 上最后表现成系统那句"应用没有响应"）。

**三个原因**（都在启动路径上）：

1. `[main] 日志文件: …` 原来打在 `app.whenReady()` **里面** —— ready 之前挂掉就什么都不会写；而且 `installFileLogging` 之后走的是**缓冲流**，`app.exit()` 不等 flush，最需要留下的那几行反而会丢。
2. `if (!gotLock) { app.quit(); }`：`quit` 的语义是"先关所有窗口、再走 `before-quit` / `will-quit`"，而第二个实例**一个窗口都没有**；ready 之前调它不保证真的退。官方文档里 `app.exit([exitCode])` 才是"立刻退出、不发那两个事件"。
3. 主进程抛异常时 Electron 默认只弹一句英文 `A JavaScript error occurred in the main process` —— 用户拿不到任何能发出来的东西。

**现在的做法**（`src/main/main.ts` + `src/main/logger.ts`，三处都很小）：

- `FileLog.writeLine()`：**同步** `appendFileSync`（同时打给终端）。`console.log` 那条缓冲通道留着不动，两者分工写在 `logger.ts` 的接口注释里。日志文件没建成时它退化成 `console.log` —— 不能静默。
- **ready 之前**落一行启动记录：版本 / 平台 / Electron / 开发态还是打包版 / userData。于是"到没到 ready"一眼可辨。
- `!gotLock` → 先 `writeLine` 记一行，再 `app.exit(0)`。
- `process.on('uncaughtException' / 'unhandledRejection')` → 落盘 + `dialog.showErrorBox(标题, 错误 + 日志路径)`；**记录之后不退出**（与 Electron 默认行为一致：硬退会把"还能用一半"变成"完全不能用"，而原因已经摆在眼前）。选 `showErrorBox` 是因为官方文档明确写着它**可以在 ready 之前安全调用**（Linux 上那时只写 stderr），正是为启动早期报错准备的。

**哪条自检守着**：四条**静态检查**（启动记录出现在 `app.whenReady()` 之前、`!gotLock` 分支走 `app.exit` 且不出现 `app.quit()`、两个 `process.on` + `showErrorBox` + 日志路径、`writeLine` 是同步的且没有文件时仍打终端）。**这些分支只在真机上才会真正跑到**，所以改完要手工验一次：起两个实例（第二个应当立刻干净退出，日志里多一行说明）、临时在主进程里 `throw new Error('probe')` 看对话框是否带日志路径（验完删掉）。

### 7.26 「能不能跑 dsh」的 Node 要求：先看**本机装的那一份 dsh**，兜底才是 `^22.19.0 || >=24.0.0`

**现象**：自检原来把 Node `20.19` / `22.12` 的机器判成「符合要求」，而 dsh 在那种 Node 上是**静默退出**（退出码 0、零输出，§7.4）—— 用户看到的是「已停止」，看不出是解释器的问题。

**分界线是 22.18，不是 24**（用户观察到"24 以下的 Node 上 dsh 会静默退出"，2026-09-20 逐个实测纠正）：同一个 dsh `0.1.5-rc.1`，`dsh --version` 与 `dsh web` 一起测：

| Node                        | `typeof import.meta.main` | `dsh --version`                                   | `dsh web --no-open`                           |
| --------------------------- | ------------------------- | ------------------------------------------------- | --------------------------------------------- |
| 16.20 / 18.20 / 20.10       | `undefined`               | exit 1，**有报错**（`node:util` 没有 `parseEnv`） | —                                             |
| 20.19.2 / 22.1.0 / 22.17.1  | `undefined`               | **exit 0、零输出**                                | **exit 0、0 字节输出，端口不开**              |
| 22.18.0 / 22.19.0 / 22.22.1 | `boolean`                 | `0.1.5-rc.1`                                      | 22.22.1 实测**服务真的起来**（`GET /` → 401） |
| 24.14.0 / 24.14.1           | `boolean`                 | `0.1.5-rc.1`                                      | —                                             |

**机制**（这条最值得记）：`dsh` 的入口最后一行是 `if (import.meta.main) await runCli();`。`import.meta.main` 在 22 线是 **22.18.0** 才进的（24 线是 24.2.0），没有它的 Node 上这个属性求值是 `undefined` → `runCli()` 根本不执行 → 事件循环空转结束 → **退出码 0、零输出**。它是**入口那一层**的门，所以 `--version` / `web` / `plugin` 一视同仁；而 ≤20.10 倒在更早的 `parseEnv` 导入上，所以"静默"只出现在 20.19–22.17 这个窗口里。外部旁证：[es-main#161](https://github.com/tschaub/es-main/issues/161)、[nodejs/node#58693](https://github.com/nodejs/node/pull/58693)（v22.x backport）。

**上游那句从哪来**：**仓库根**的 `package.json`（<https://github.com/deepseek-ai/deepseek-harness/blob/master/package.json>）写着 `"engines": { "node": "^22.19.0 || >=24.0.0" }` —— 比真下限保守一格（22.18 就能跑），`>=24.0.0` 又比 24 线的真下限（24.2.0）松两格。两个容易看走眼的地方：**发布出去的 `@deepseek-ai/dsh` 的 manifest 里没有 `engines`**（在 `node_modules` 里翻不到、npm 也不警告 —— 本机 0.1.5-rc.1 实测），而**一致的下限**能从依赖链看出来：undici 8 写着 `engines: { node: '>=22.19.0' }`。

**现在的做法（用户裁决：不是所有人装的是同一份 dsh，别只信抄来的常量）**：

- **运行期读本机那一份**（`readLocalDshRequirement`，完整探测才跑、~20ms）：从启动方式反推安装根（入口脚本路径 → shim 的符号链接 → npm 的两种全局布局，**最后读 package.json 验名字**），再递归收 `node_modules` 里的 `engines.node`（`collectNodeEngines`，层数/包数都有上限、按名字排序保证可复现），取**下限最高**的那条（`highestNodeRequirement`，并数出"同一条下限还有几个包也在要"）。本机实测：524 个包里 3 个要 `>=22.19.0`（`@earendil-works/pi-ai` / `pi-telemetry` / `undici`）。
- **判据是两句都要满足**（`judgeNodeVersion`）：本机那句（`localNodeRange`：依赖链 > 它自己声明的 `engines`）+ 兜底那句 `NODE_RANGE`。**为什么不是二选一**：依赖链那句是数学区间，**它不知道 dsh 的入口用了哪个 Node API** —— `>=22.19.0` 数学上包含奇数版 23，而 23 早于 `import.meta.main`。上游那句正是靠 `^22.19.0` 的**上界**把 23 挡在外面的。两句都满足 = 本机证据能在它更严时抬高门槛（将来 dsh 要 `>=26` 就按 26 判），兜底那句负责挡住依赖链看不见的那些线。
- **区间解析只有一个实现**（`satisfiesSimpleRange`）：`>=` `>` `<=` `<` `=`、`^`、`~`、x-range（`22` / `22.19` / `22.x`）、`*`、空格分隔的"与"、`||` 的"或"。`satisfiesNodeRange` / `satisfiesBuildRange` 都改成调它 —— 本机读出来的区间是**任意一句**，没法写死。**认不出来给 `null` 而不是 `false`**（"不猜"），而且**顺序无关**：`>=22.19.0 || 乱写` 与 `乱写 || >=22.19.0` 都是 `true`（有一段说得清且满足就够），只有"没有任何一段满足、且有段认不出来"才是 `null`。故意不实现预发布序（依赖链里没有一条用它，猜错预发布比说"不知道"更糟）。
- **界面点名来源**：满足时是「`v24.14.1` 满足本机这份 dsh 的要求 `>=22.19.0`（来自依赖 `undici 8.10.2` 等 3 个包）」；不满足时说清"这种 Node 上 dsh 会静默空跑"；**读不到本机那一份**（npx 那条路 / 读不到包目录）时退回兜底那句、文案与从前一致。上面那句常量仍然用于「应用自带运行时」（`bundled-runtime`，构建期那句）与契约快照里的 `nodeRange`。

**哪条自检守着**：「环境自检：通用的区间判据是唯一的实现（两句老常量与它逐档一致；认不出来给 null）」「环境自检：「Node 版本」= 本机那份 dsh 说的 + 兜底那句，两句都要满足（23 靠兜底那句挡住）」「环境自检：本机那句的优先序与文案」「环境自检：从本机安装树读得出"这一份 dsh 要哪个 Node"」（真实文件系统建临时目录 + 符号链接）「环境自检：完整探测才读安装树」；`scripts/env-doctor-cases.mjs` 的 C 段钉边界、T 段钉本机证据那 12 条。

### 7.25 环境自检的探测不许阻塞主进程，也不许去调"转发器"

**现象**（真机）：双击新版本"没反应"，过一会儿系统弹崩溃提示。日志里两行 `环境自检：node --version 起不来：spawnSync … ETIMEDOUT`；`README`/用户肉眼可见的副作用是 `~/.vite-plus/js_runtime/` 里多出一个 **100+MB 的 Node 运行时**（当天新建）与 5 个 `.tmp*` 残留。

**原因**：完整探测（`collectEnvProbe`）跑在**主进程**上，而且是 **5 个 `spawnSync` × 每个 8 秒超时、串行**（node / npm / pnpm / dsh / dsh-run）—— 最坏把事件循环占住约 40 秒。而它第一个就去敲了 `~/.vite-plus/bin/node`：那是个**转发器**（symlink → `current/bin/vp`，配置 `shimMode: system_first`），在 GUI 应用的窄 PATH 下找不到系统 node，于是**开始下载自己的运行时**；8 秒到点被 `spawnSync` 杀掉（每次杀都留下一个 `.tmp*`），下一个探测再起一个…… 界面在这几十秒里完全没响应，macOS 最后给的就是"没有响应 / 意外退出"。

三个连带发现（都已修）：

1. **超时被说成"起不来"**：`exitCode: null` 落进了"退出码 0 + 零输出 = 静默退出"那条判据（§7.4 的签名），界面于是引导用户去**重装一个好好的 dsh**。现在 `VersionProbe.timedOut` / `DshProbe.timedOut` 与那个签名分开，归"测不出来"（warn）。
2. **候选表把一个转发器排在真 node 之前**：`findNodeExe` 的硬编码列表里 `~/.vite-plus/bin/node` 在 nvm / fnm 目录**之前**，于是同一台机器上「dsh 用哪个 Node」（`dshInterpreterCandidates`，配套安装优先 → nvm 的真 node）与「外部 Node 这一行」（通用搜索 → 转发器）给出**两个版本**，用户拿终端 `node -v` 对账必然对不上。
3. **`kill` 只杀壳**：转发器往往只是个 `sh`，真正的活儿（下载器）在它的子进程里、还继承了 stdout / stderr —— 只 `kill` 壳的话 `close` 永不触发、管道一直开着（实测：探针进程因此退不出来）。

**现在的做法**：

- **异步 + 并发**：`runVersion` / `readNpmPrefix` 改成 `spawn` + 定时器（超时就 `killTreeSync` + `destroy()` 三根管道 + `unref()`），`collectEnvProbe` 里四项探测 `Promise.all` 并发跑。`EnvDoctor.report()` 本来就是 `async`，调用方一个字没改。
- **转发器认出来、不执行**：`isNodeShim(file)` = 跟着符号链接走到最终目标、看名字还是不是 `node`（homebrew 那种 `…/Cellar/node/x/bin/node` 算真 node，vite-plus 那种 `…/current/bin/vp` 算转发器）。`findNodeExe` 改成**两趟**扫描：先真 node、实在没有才退转发器。
- **「外部 Node」这一行的语义**（用户裁决）：报**真正会被用来跑 dsh 的那一份**（`resolveDshLauncher` 给 `node-bin` 时就是它），并注明"dsh 就用这一份跑"；机器上还有一份被跳过的转发器时，把它**报出来但不执行**（"它的版本随启动环境而变，别拿它跟终端里的 `node -v` 对账"）。

**哪条自检守着**：「环境自检：探测不再走同步子进程（runVersion 里没有 spawnSync），四项并发跑」「环境自检：探测超时是黄灯（"它在忙"），不冒充"退出码 0 + 零输出"的静默退出」「环境自检：node 那一行报"dsh 要用的那份"，并报出被跳过的转发器（不执行它）」「环境自检：认得出"转发器"（最终目标不是 node），真实 node 的符号链接不算」（最后一条用真实文件系统建符号链接，不是纯静态检查）。

**推论**：反例脚本**必须由 CI 一起跑**（`ci.yml` 的 `check` 里有那一步，按文件名自动收录）—— 上面第 1 条那个"超时冒充静默退出"的误判就是这么攒下来的：当时 `npm test` 是绿的，红的是只在本地沙箱门禁里跑的那个脚本，而没人天天跑门禁。

### 7.27 自检页的圆点与内容必须永远左右并排（`.env-main` 的 flex 基宽是 0）

**现象**（用户报过两次，第一次我绕开了）：窗口一窄，`外部 Node` / `dsh 本体` / `dsh 能不能跑` 这几行的**圆点一个人留在上一行**、内容整块掉到下面 —— 看上去就是"某几行的标题换行了"。窗口越窄，掉下去的行越多。

**原因**：`.env-row` 是 `flex-wrap: wrap` 的一行（**必须** wrap：后两个子块 `.env-confirm` / `.env-owner-note` 是 `flex: 1 1 100%`，要靠它自成一行），而 `.env-main` 写的是 `flex: 1 1 auto` —— **`flex-basis: auto` 用的是内容自己的宽度**。那几行的说明是两条长路径拼的（约 150 字），基宽超过这一行剩下的空间，flex 换行算法就把整块挪到下一行，圆点（`flex: 0 0 auto`，8px）独自留在上面。

**做法**：`.env-main { flex: 1 1 0 }`（基宽 0）。它不再会被"内容太宽"挤走，永远和圆点并排，并且靠 `flex-grow` 填满剩余宽度 —— 所以是**自适应**的：实测视口 1440 / 1220 / 900 / 760 / 640 时正文宽 1150 / 930 / 610 / 470 / 350。

**判据与实测**（CDP 连真机实例量渲染结果；"内容左边缘 − 圆点左边缘 < 12px"即判为被挤下去）：

| 视口 | `flex: 1 1 auto`（改前）     | `flex: 1 1 0`（现在） |
| ---- | ---------------------------- | --------------------- |
| 1440 | 1 行（node）                 | 0                     |
| 1220 | 3 行（node / dsh / dsh-run） | 0                     |
| 900  | 4 行                         | 0                     |
| 760  | 5 行                         | 0                     |
| 640  | 7 行                         | 0                     |

**别用 `width: calc(100% - 18px)` 走这条路**（用户先试过它）：它确实能让圆点留下，但把"圆点 + gap = 18px"这个尺寸抄进了内容规则，而且会**把「更新 pnpm」按钮挤到第二行**（实测 pnpm 那行 70 → 107px，按钮的 top 从 13 变 68）。`flex-basis: 0` 没有这两个副作用（按钮始终在第一行）。

**同一轮试过又撤掉的两件事**（别再往回走）：给正文加 `max-width: 820px` 的行长上限（它顺手让长路径的折行落在两条路径之间的空格上，但**窗口一窄就挡不住圆点被挤下去** —— 那是治标；用户要的是自适应）；以及用户提的 `width: calc(100% - 18px)`（见上）。长路径从中间断开那件事**同轮没做、下一轮单独做了** —— 见 §7.29（不是只插一个 `<wbr>` 就够：片段本身也得 `nowrap`，否则 `@deepseek-ai` 里的连字符又会先断）。

**哪条自检守着**：「环境自检页：圆点与内容永远左右并排（`.env-main` 的 flex 基宽是 0，不是内容宽度）」。

### 7.28 整块内容区不画焦点环（`main:focus-visible`）

**现象**（用户报的"每次启动时这里都有一个多余的框，不知道是什么"）：控制台页在紧贴顶栏下方、横跨整块内容区的位置，启动后总有一条淡蓝色的细带（左边 / 下边也各有一条，右边贴着窗口边缘看不见）—— 看着像一个空盒子。

**是什么**：**不是元素，是 `<main>` 的焦点环**。门禁层（首启环境门禁）在启动瞬间显示过一次（"检查中"），收起时 `EnvGate.vue` 的 `focusMainContent()` 把焦点交给主内容区（交互 §11.5）；Chrome 把这种程序化交接当成了键盘驱动的焦点，于是命中全局那条

```css
:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
```

`--focus` 是 35% 的蓝（`rgba(14, 116, 144, 0.35)`），2px + 2px 偏移正好落在 `main` 的上/左/下三条边上。**怎么确认的**：用 CDP 的 `CSS.forcePseudoState` 给 `main` 强制 `:focus-visible`，顶部 CSS y=32..33 立刻变成 `#a8c6d2`、左边与下边各一条 —— 与用户抓图的位置、颜色一致；DOM 里没有任何元素或伪元素在那儿有背景 / 边框 / 阴影（那一带的另一种更淡的痕迹是 `.focus-card` 的 `--shadow-focus` 上方洇出的 1~2 个色阶，属于设计里"全局唯一一处阴影"的固有软边，不是这个框）。

**做法**：只给 `main` 加一条例外（`main:focus-visible { outline: none }`），**控件（按钮 / 输入框 / 列表项）的焦点环一个字不动** —— 容器是程序化接管焦点用的、Tab 不到它，画一圈框没有任何可达性收益，只有"界面坏了"的观感。

**验证**（改完当场测的，CDP 强制伪类）：`main` 的 `outline=none`、那条带消失；`#btn-env-refresh` 与 `.rail-item` 仍是 `solid 2px rgba(14, 116, 144, 0.35)` ✓。

**哪条自检守着**：「渲染层：整块内容区不画焦点环（main 的焦点是程序化交过去的，不是 Tab 来的）」。

### 7.29 自检页说明里的长路径：折行必须落在路径分隔符上

**现象**：`dsh 本体` / `dsh 能不能跑` 那两行的说明是**两条长路径**拼起来的（node 的入口 + dsh 的 bin.js）。它是一整串没有空格的字符，浏览器只认空格 / 连字符那类断点，于是折行从路径**中间**切：实测断成 `…/lib/node_modules/@deepseek-` + `ai/dsh/lib/bin.js`，第二行只剩一小截，看着像排版坏了。

**做法**（两步，缺一不可）：

1. **按分隔符切段 + 片段之间插 `<wbr>`**：`renderer/lib/env-detail.ts` 的 `detailSegments()`（`/` 与 `\` 都认）。它**只切分、不产生 HTML** —— 那段文字里有用户机器上的真实路径，走 `v-html` 就是一条注入面，自检钉着不许。
2. **片段本身包在 `.env-seg`（`white-space: nowrap`）里**。只做第 1 步不够：`@deepseek-ai` 里那个连字符**本身就是一个断点**（UAX#14 的 HY），窗口一窄浏览器就优先断在它上面 —— 实测视口 760 又变回 `…/@deepseek-` + `ai/dsh/lib/bin.js`，正是要修的那个样子。

**实测**（CDP 量渲染结果，窗口 1220×820、DPR 2）：

| 视口 | `dsh 本体` 的折行                                          | 横向溢出 |
| ---- | ---------------------------------------------------------- | -------- |
| 1220 | `…/@deepseek-ai/` ＋ `dsh/lib/bin.js`                      | 无       |
| 900  | `…/.nvm/versions/` ＋ `…@deepseek-ai/dsh/lib/bin.js`       | 无       |
| 760  | `…/node_modules/` ＋ `@deepseek-ai/dsh/lib/bin.js`（3 行） | 无       |
| 640  | `…/node_modules/` ＋ `…/lib/bin.js`（3 行）                | 无       |

**两条不变量**（一条自检 + 真机都比对过）：

- **往返一字不差**：`<wbr>` 是元素、`.env-seg` 是 `<span>`，都不引入字符 —— 行里显示的文本与主进程给的 `detail` **完全相同**，复制 / 日志 / 排查都对得上；
- **不溢出**：片段 `nowrap` 之后，单个片段比一行还长时会顶出容器（`.panel` 是 `overflow: hidden`，会被裁掉）。现在的路径片段最长十几个字符，四个宽度实测都没溢出；真出现超长片段（例如 Windows 上某个超长目录名），要么收窄这个策略、要么给 `.env-seg` 留一条"整段挪到下一行"的兜底。

**哪条自检守着**：「环境自检页：长路径的折行落在路径分隔符上（说明切段 + 片段之间插 `<wbr>`）」—— 五组切段夹具（POSIX / Windows 反斜杠 / 中文前缀 / 无分隔符 / 空串）、往返断言、模板接线、`.env-seg` 的 `nowrap`、以及**不许 `v-html`**。

## 8. 调试手段

### 自检

```bash
npm test     # tsx test/selftest.ts，313 项，不需要 Electron、不启停任何进程
```

受限环境里 `npm test` 起不来（tsx 要经 esbuild 的带管道子进程，见第 5 节），用等价入口：

```bash
node scripts/selftest-sandbox.mjs
```

`test/selftest.ts` 覆盖：命令解析三级回退与解释器实测、ANSI 清理与令牌提取、健康判据、端口占用解析（Windows `netstat` / POSIX `lsof` 两套夹具，所以在一个平台上开发也不会把另一个平台的解析改坏）、`DshManager` 状态机与 PID 归属、渲染层静态检查（含 macOS 适配契约、构建产物形状、样式与主题、启动锁、设置默认值，以及设置页表单字段与契约对齐 —— 键名写错只会静默不生效、保存被主进程拒了必须说出来）、自动更新契约（不自动下载 / 安装、macOS 与开发态不加载 electron-updater）、发布流程（CHANGELOG 条目、片段汇总规则、Release 标题与正文的生成与产物闸门）、插件装配层（dump 的层归因、stderr 上的未匹配 patch、空输出不算成功），以及**运行环境自检与首启门禁**（判定是纯函数、八项结论与阈值边界、静默退出与缺失的区别、Windows 上的启动 spec 真的起得来、超时是独立终态、一键修复的契约与接线、`skipped` 判 warn、门禁三态与 `currentStepId`、逃生口不写盘也不依赖安装动作、安装引擎两条路与失败分类）。

**为什么这些检查放在自检里**：它们要么是纯函数 / 静态文本检查，要么只需要一个子进程 —— 不需要起 Electron，所以在 CI 的 Ubuntu runner 上也能跑。

**什么样的东西该写成断言（判据）**：

| 放哪                                              | 放什么                                                               | 例子                                                                                                            |
| ------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `test/selftest.ts`（进 CI）                       | **回退了会静默坏掉**的机制与契约：坏了没人看得出，只有用户撞上才发现 | 每个生产依赖必须被主进程 `require`；更新源文件名与资产一致；入口不能用动态 import（白屏）；自动全屏要求界面可用 |
| 本地冒烟脚本（`.build-home/harness.cjs`，不入库） | **界面外观**：布局尺寸、各状态渲染出来的文案                         | 粘贴行按钮与输入框同高且居中；更新卡片按钮在标题行内；七个相位各自的状态行                                      |
| 什么都不钉                                        | 一次性细节、纯措辞                                                   | 某句话怎么断句                                                                                                  |

两条补充规矩：

- **钉结构，别钉字面量**。断言写成"说明行必须由 `canAutoUpdate` 分支决定"（结构），而不是"必须包含某句中文" —— 后者会在下次润色文案时无谓地变红，让维护变成负担。
- 加之前问一句：**这条回退了，会不会有人看得出来？** 看得出来（变歪、变丑、措辞差）→ 放冒烟或靠 review；看不出来（白屏、404、包变胖、承诺了不存在的行为）→ 进自检。

### 开发期诊断（非打包运行时才装）

| 快捷键                                 | 作用                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `F12` / `Ctrl+Shift+I`（macOS：`⌘⌥I`） | 打开开发者工具（主进程处理，内嵌页也能单独开）。**detach 模式**，因为贴边停靠会改变布局                               |
| `Ctrl+Shift+D`（macOS：`⌘⇧D`）         | 把当前界面的元素结构导出到日志：尺寸 / 位置 / 背景 / display / overflow / z-index + 当前状态                          |
| `Ctrl+Shift+U`（macOS：`⌘⇧U`）         | 循环伪造更新相位（`available` → `downloaded` → `downloading` → 回到真实状态），用来体验底栏的更新提示与设置页更新卡片 |

**为什么要有 `Ctrl+Shift+U`**：底栏那句「发现新版本 x.y.z，点此查看」只在 `available` / `downloaded` 两个相位出现，而更新状态机只在**打包后的 Windows** 上才可能进入这两个相位（7.17）—— 开发态一律 `unsupported`，于是这条提示、以及它点下去的「滚到更新卡片 + 高亮一次」（7.19），在开发时根本看不见、也点不到。伪造的是渲染层那份镜像，消息里带「（开发态演示）」；点设置页的「下载 / 重启并安装」会去问主进程，那次往返会把状态换回真实的 unsupported，想接着看再按一次即可。走完一圈会把按下之前的真实状态原样放回。

`npx electron . --dev`（需先 `npm run build`）会在启动时直接打开开发者工具。焦点在内嵌页里时这些键也要能用：主进程在 guest 的 `before-input-event` 里把应用快捷键**重新注入宿主窗口**（`sendInputEvent`），复用渲染层原有的处理器，不复制一份逻辑。

诊断输出走渲染层 `console.log` → 主进程转发 → 落进日志文件（`<userData>/logs/console.log`），所以排查的一方可以直接读那个文件，不必反复要截图。实现在 `src/renderer/dev-diagnostics.ts`，只在 `env.packaged === false` 时安装。看到 `[main] 渲染层已连接` 说明页面加载成功，只有 `[renderer:error] ...` 说明是脚本报错。

### 隔离/无头地验证界面

- **独立 userData**：`DSH_CONSOLE_USER_DATA=<临时目录>` 可以改配置目录，配上单实例锁就能与正在运行的实例互不打扰（`.verify/`、`.verify-userdata/`、`.build-home/` 都在 `.gitignore` 里，可以拿来当临时目录）。
- **量内边距要量文字，不要量块的 `rect`**：块级元素自己的 `padding` **不改变它 border box 的左边缘**，所以 `el.getBoundingClientRect().left - parentLeft` 永远是 0（+ 边框），看不出"顶头"。要判断文字有没有贴边，得用 `document.createRange()` + `selectNodeContents(el)` 量文字盒 —— 插件页那句说明句第一次就是这么量错的，白跑一轮。
- **读计算样式而不是截图**：加载构建产物后用 `executeJavaScript` 取 `document.documentElement.dataset.platform`、`getComputedStyle(document.querySelector('.topbar')).paddingLeft` 这类确定值 —— macOS 适配就是这么做静态校对的（元素位置 / 内边距比截图更可信，也更容易在自动化里断言）。
- **stub preload 的思路**：渲染层启动时只依赖 `window.dshConsole`（`app.ts` 里检查它，缺失就显示一句可读的启动错误），所以可以用一个假的 `window.dshConsole` 把构建产物单独载入，验证布局与样式，不启动真正的 dsh 或 PTY。注意这样做只能验界面，验不了主进程行为。
- **抓屏**：想真正看到渲染结果，Windows 用 Win32/GDI 抓屏脚本，macOS 用系统自带的 `screencapture`（首次需在「系统设置 → 隐私与安全性 → 屏幕录制」里授权）。**不要试图让 Chromium 截自己的图**：受限环境里 Chromium 系进程可能起不来（Mojo platform channel 被拒），`capturePage()`、headless 浏览器、Playwright / Puppeteer 都可能走不通；而抓屏不需要浏览器。写 PowerShell 脚本时注意 `.ps1` 必须是**纯 ASCII**（PowerShell 5.1 读没有 BOM 的脚本时按 GBK 解码，中文会把引号和大括号解析搞崩）。

## 9. 给 AI agent 的约定

- **不要擅自升级依赖或改构建配置**（`package.json` 的依赖与 `build` 字段、`vite.config.mts`、`tsconfig.*.json`、`eslint.config.mjs`、`.prettierrc.json`、CI 工作流）。这些地方的每一处改动都有对应契约与自检；确有必要时先说明理由，并同步更新受影响的文档与自检。
- **改动要带 changeset 片段**：会进 CHANGELOG 的改动用 `npx changeset add`；纯 CI / 纯文档这类不需要发版说明的用 `npx changeset add --empty`（见第 6 节）。不要手改 `CHANGELOG.md`。
- **不要用 `--no-verify` 绕过提交钩子**，也不要绕过 PR 上的 changeset 闸门。提交信息用 Conventional Commits（`fix(ui): …` / `docs: …` / `ci: …` / `refactor(ts): …` / `chore: …`）。
- **改动一律走 PR，不要直接推 `main`**：`main` 上有分支保护 —— **必须经 PR**，且 **`check` 必须通过**。用带 bypass 权限的凭证直推时 Git 会显示推送成功，但远端会回一行 **`Bypassed rule violations for refs/heads/main`**：那是"推上去了但**违规**"，等于把这两道门一起绕过（v0.5.3 之后这一轮就发生过两次：一次直推、一次为了撤销直推而 force-push）。正确流程：
  `git switch -c <feat|fix>/<短名>` → 提交（钩子会跑 lint-staged）→ `git push -u origin <branch>` → 在网页上开 PR（本机**没有 `gh`**，只能手开：`https://github.com/yozica/dsh-console/pull/new/<branch>`）→ 等 `check`（含 PR 上的 changeset 闸门）绿 → 合并。
  两条推论：**推之前先确认目标分支有没有保护**；第 6 节那串 `git push origin main --tags` 的**前提是改动已经通过 PR 合进 `main`**（推标签只触发 `release.yml`，不是绕过手段）。
  **GitHub 直连不通时**，按用户当次给的代理地址**只在这一次命令里用**（`git -c http.proxy=http://… push …`），用完即弃 —— 不要写进仓库 `.git/config`、`.npmrc` 或全局 npm 配置（第 6 节的"本地打包小贴士"同理）。
- **发版提交：要么补空片段走 PR，要么按第 6 节直推 `main`**（二选一，别混）：
  `release:prepare` 产生的发版提交会**删光** `.changeset/` 里的片段，而 PR 上的 changeset 闸门要求「改动的包必须带片段」——
  所以**发版 PR 天然会红**（v0.6.0 才暴露：以前的发版都是直推 main，没见过这个冲突）。两种做法：
  ① **走 PR**：在发版提交里**再补一个空片段**（`npx changeset add --empty`，不产生版本、汇总时自动清掉），它就能照常过闸门；
  ② **直推**：按第 6 节把发版当作**既定例外**直接推 `main`（历史版本就是这么发的）。
  **这条只适用于发版提交本身** —— 它不是"可以随手绕过保护"的口子；其它任何改动仍然一律走 PR。
- **改完按第 5 节跑检查**：`npm test` 加 `npm run lint && npm run format:check && npm run typecheck`；交付前用 `npx prettier --write <改到的文件>` 收尾。
- **遇到不确定的领域先查证再动，别猜**：macOS 签名与 Gatekeeper、Electron 版本行为、node-pty 的 ConPTY 细节、dsh 的鉴权与内部文件格式，都属于「猜错会静默失效」的类型。能在仓库里读到的以代码 / 配置 / CI 为准；读不到的（上游行为）去查上游源码或文档，并在改动说明里写清依据。
- **改文档时保持两份的边界**：用户视角的写进 `README.md`，开发 / 架构 / 发版的写进本文件；不要在本文件里写「某台机器上如何如何」的实测记录 —— 结论留下，过程与本机路径不要留。
