# AGENTS.md — 开发说明（给人，也给 AI）

**改这个仓库之前先读这一份。** 它讲的是「怎么跑起来、代码在哪、有哪些约定与坑、怎么测、怎么发版」。面向使用者的介绍（这是什么、怎么装、怎么用、有哪些设置）在 [`README.md`](README.md) —— 那份里不要写只有开发时才关心的事，这份里不要重复产品介绍。

下面每一句都应该能在仓库里核对：命令与 `package.json` 一致，路径真实存在，结论能从源码 / 配置 / CI 读出来。拿不准的地方先查证再动，不要猜。

## 1. 快速开始

需要 **Node ≥ 20.19**（`vite` 的 `engines` 是 `^20.19.0 || >=22.12.0`；CI 固定用 Node 22）。

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
    main.ts             窗口、IPC、生命周期、退出清理、开发工具快捷键、内嵌页诊断
    dsh-manager.ts      dsh 进程状态机：启动 / 停止 / 接管 / 健康轮询 / 令牌 URL 捕获
    pty-sessions.ts     node-pty 会话注册表（dsh 终端 + 本地 Shell 共用）
    process-utils.ts    命令探测、端口占用、进程名、结束进程树、HTTP 探测、ANSI 清理
    settings.ts         settings.json 读写（含 v1→v2 一次性迁移）
    logger.ts           主进程日志：console 同时落盘到 <userData>/logs/console.log
    updater.ts          自动更新状态机（electron-updater）：检查 / 下载 / 安装
    session-archive.ts  归档会话：读写 DSH 的 workspace.json 与投影缓存
    plugin-manager.ts   插件装配层：profile 的 bundle 层栈 + `dsh web --dump-config` 的解析（含 stderr 上的"没报错的错"）
  preload/preload.ts    contextBridge，把受限 API 暴露成 window.dshConsole
  shared/ipc.ts         主进程 ↔ 渲染层的**契约类型**（单一来源）
  renderer/             Vue 3 + Vite，产物 dist/renderer/
    index.html          页面骨架：八个页面容器 + 挂载点 + 内联图标精灵 + 启动锁
    main.ts             入口：样式导入顺序 → app.ts → 建立共享状态 → 挂载
    app.ts              应用级胶水：启动守卫、启动锁状态机、自动打开、快捷键
    mount.ts            挂载清单：外壳三块 + 全部页面
    dev-diagnostics.ts  开发期诊断：把元素结构导出到日志
    lib/                共享状态与纯逻辑（store / platform / xterm / markdown / …）
    shell/              外壳组件：RailNav / TopBar / StatusBar
    panes/              八个页面组件
test/selftest.ts        123 项自检（`npm test`），不需要 Electron
tools/                  changelog-extract.mts / release-prepare.mts / release-notes.mts / make-icon.mts
scripts/build.mts       受限环境用的构建包装
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

**一次启动的数据流**：主进程 `bootstrap()` 读 `Settings` → `DshManager.start()`（探测端口 → 解析启动命令 → 在 PTY 里拉起 dsh → 轮询健康检查 → 从输出里捕获带令牌的地址）→ 任何状态变化都 `emitState()` 推给渲染层；渲染层 `startStore()` 拉一次全量快照后靠 `onState` / `onTheme` / `onFullscreen` 接收增量，外壳与页面读同一份响应式状态。主进程到渲染层的**唯一**通道是 preload 暴露的 `window.dshConsole`（形状见 `shared/ipc.ts` 的 `DshConsoleApi`）。

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
| `npm test`                      | `tsx test/selftest.ts`（123 项，不需要 Electron、不启停任何进程）                       |
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

- **`build-windows` / `build-macos`**：各在 `windows-latest` / `macos-latest` 上 `npm ci` → `npm test` → `lint && format:check && typecheck` → `npm run build` → `electron-builder --win|--mac --publish never`，产物挂成 Artifacts。**不加 `--config.npmRebuild=false`**：runner 上有 C++ 工具链，让 electron-builder 对着打包用的 Electron 版本重编 node-pty 才对（node-pty 是 N-API，跨 Electron 大版本不用改代码）。
- **`publish`**（仅在标签构建时跑）：收齐两边产物 → `tools/release-notes.mts` 生成标题与正文（`--assets` 吃 `ls assets` 的输出）→ `gh release create --draft --title "$(cat .release/title.txt)" --notes-file .release/notes.md`（已存在就只补产物、正文不动）→ `gh release upload --clobber`。产物是 Windows 的 NSIS 安装包 + 便携版 exe、macOS 的 arm64 / x64 dmg 与 zip，外加 `latest.yml` / `latest-mac.yml` 与 `*.blockmap` —— 这些就是**自动更新（electron-updater）的更新源**：Windows 版按 `latest.yml` 检查与下载增量包，`*.blockmap` 是差分索引。手动触发 `release` 工作流则**只构建、不发版**，产物在 Artifacts 里。
- **为什么打包与发布拆成不同 job**：v0.2.0 时两个 runner 各自 `electron-builder --publish always`，并发调 `getOrCreateRelease()` 都发现「没有 release」就各建一个，Windows 的安装包与 `latest.yml` 因此没传上去；更麻烦的是 electron-builder 默认 `releaseType=draft`，release 一旦被人点成「已发布」，后续上传会被**静默跳过**（步骤显示成功，只在日志里 warn）。现在草稿由 `gh release create` 自己建、产物用 `gh release upload --clobber` 传，重跑可以放心覆盖同名产物。**推论：不要改回 `--publish always`，也不要让两个平台各自建 Release。**

**`ci.yml` 的闸门**：PR 与合入 `main` 时跑同一个 `check` job；PR 上额外跑 `npx changeset status --since=origin/<base>`，**改了代码却没带片段就失败**。这也是 `npx changeset add --empty` 的用途 —— 放一个空片段当「通行证」，它不产生版本、也不进 CHANGELOG，汇总时自动清掉。

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

自检「渲染层：macOS 红绿灯留白给左栏（应用内全屏让白、系统全屏撤回、非全屏顶栏不缩进）」守着这四种状态。

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

自检：「样式：页面容器靠 visibility 隐藏，不用 display:none」与「样式：每个 webview 都有明确高度的样式」。另外 `vite.config.mts` 的 `compilerOptions.isCustomElement` 把 `<webview>` 声明为自定义元素，否则 Vue 编译器会试着把它当组件解析。两个内嵌页用**各自独立且持久**的分区（`persist:dsh-ui` 存令牌 / `persist:deepseek` 存登录态），且主进程在启动时统一抹掉 UA 里的 Electron 标识（`app.userAgentFallback`，不是等 webview 挂上来再改 —— 后者可能晚于该页的第一次请求）。

### 7.7 dsh 终端是**只读输出视图**（有意为之）

`dsh web` 是个服务端进程，**不读 stdin**。所以「dsh 终端」页是输出视图，不是交互式终端 —— 打字没反应是 dsh 的行为，不是界面坏了。这条设计决定带来几个具体做法：

- 页面上方常驻一句说明；没有进程时显示空状态并直接给「启动 dsh」按钮。唯一有意义的键盘输入是 **Ctrl+C**（往 PTY 写 `\x03`）。退出时终端里补一行灰字（`── dsh 已退出（退出码 0）──`），本地 Shell 同样。
- 两个按钮用用户语言：「清空显示」只清当前画面（输出仍在主进程缓冲里）；「重新显示历史」把缓冲（最近 512 KB）重画一遍。
- 尺寸自动跟随容器（`ResizeObserver` + 切页时 fit），没有「自适应」按钮；拖动窗口时会逐帧触发 `ResizeObserver`，所以加了道闸：**只在行列数真的变了才通知主进程**，避免刷爆 IPC。

### 7.8 共享状态、挂载与 xterm

- **每个组件都必须在 `mount.ts` 的挂载清单里**，否则界面上那块永远是空的。自检「渲染层：每个 .vue 组件都在挂载清单里」与「渲染层：外壳与页面的挂载点都在」守着。
- **挂载点必须是 `display: contents`**（见 `styles.css`）：漏一个就会把父级的 flex/grid 链断掉，`flex: 1` 全部失效 —— 症状是内嵌页只剩顶上一条。自检「渲染层：每个挂载点都是 display: contents」守着。
- **xterm 独占的元素里不能有 Vue 管理的子节点**：两边往同一块 DOM 里塞东西会打架。所以终端挂在 `.term-mount`（空元素）上，空状态覆盖层是它的**兄弟**而不是子节点。
- **xterm 与 addon 必须用导入的类，不能绕 window 全局**。曾经留过一层 `window.FitAddon = FitAddon` 的过渡，而 UMD 全局是**命名空间对象**（`window.FitAddon.FitAddon` 才是类），把 ESM 导入的类本身挂上去后 `new window.FitAddon.FitAddon()` 就变成 `undefined`，**fit addon 静默装不上、终端永远停在 80×24**。自检「渲染层：xterm 与 addon 用导入的类，不经过 window 全局」守着。
- **xterm 建完要立刻 fit 一次**（它默认 80×24），切页时再补一次。xterm 会为滚动条预留宽度，字符区宽度 = `列数 × 单元格宽`，除不尽的部分留在右侧 —— `div.xterm-screen` 看着「偏左」是字符网格的固有结果，不是布局错。
- **共享的纯逻辑放 `lib/`**（状态词、时长格式化、需要确认的操作、xterm 的建实例与 fit），不要在组件里各写一份。模板里别给「导入的 ref」直接赋值（`@click="immersive = false"`），改用一个小函数。
- **「数据晚到」要重试**：Harness 页切过去时快照可能还没到，`maybeLoad` 里 `!dsh` 会提前返回；若只在切页时尝试一次，页面就会永远停在空状态。所以 `watch(dsh)` 里也要再试一次。

### 7.9 启动锁是单向状态机

启动那几秒会锁住整个窗口（`inset: 0`，连顶栏一起盖）。**锁期间顶栏不能设 `z-index`**，否则左上角会孤零零剩一个页面标题。解锁条件（任一满足）：就绪、异常相位、超过 90 秒（`BOOT_LOCK_MAX_MS`）、点「不等了，先进入界面」或按 `Esc`。

第一版用「布尔量 + 每次状态变化重新判定」，而且解锁条件里带了「当前是否在应用内全屏」；结果是启动完成解锁后，**一手动退出全屏**条件又变回不满足，锁重新扣了上来。现在改成**只能单向推进的状态机** `idle → waiting → done`：`done` 之后 `updateBootLock` 直接返回，解锁判定也不再涉及全屏状态。自检有四条守着：「启动锁：只在一处上锁（idle → waiting）」「启动锁：解锁写入 done，不可逆」「启动锁：done 之后直接返回」「启动锁：解锁判定不看当前是否全屏」，以及两条布局检查「启动锁：盖满窗口（inset: 0）」「启动锁：顶栏也被盖住（没给它更高的 z-index）」。

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

### 7.13 静态检查只看代码、不看注释

自检里的 id / class / api / webview 检查扫描 `index.html + panes/*.vue + shell/*.vue + lib/*.ts` 的合集，并**先剥掉注释**：注释里常拿 `getElementById('btn-xxx')`、`` `<webview>` ``、`#000` 这类示意写法举例，当真值去查会误报。class 检查要认得动态绑定（`:class="{ active: 条件 }"` 的键名算用到的 class）。新增页面时记得同步挂载清单、样式与（如需要）preload 暴露的 API —— 自检「样式：标记用到的 class 都有对应样式（HTML + .vue）」已经挡住过两次真问题。

### 7.14 设置页网格：`min-height: 0` 会吃掉溢出内容

看板侧栏需要 `.panel { min-height: 0 }` 才能在内部滚动，但它会让设置页那些「高度跟着内容走」的卡片被压到容器高度以内，多出来的部分被 `.panel` 的 `overflow: hidden` 裁掉 —— 而 `scrollHeight == clientHeight` 意味着**连滚动条都不会出现**（症状：设置页最后一项永远看不到）。修法是给设置页的网格加 `grid-auto-rows: max-content`（行高跟内容走）。改这类布局前先想清楚「这个容器的滚动由谁负责」。

**页面级内边距由各页自己给**：`.pane` 只负责定位（`position: absolute; inset: 0`），它**没有任何 padding** —— 所以新页面的根容器必须自己写左右与底部各 20px（`.archive-body` 是 `2px 20px 20px`、`.settings` 是 `4px 20px 20px`，工具条 `.bar` 自带 `10px 20px`）。漏了就会像插件页第一版那样整块面板贴到窗口边缘。冒烟里有一条「插件页与归档页的面板内边距必须一致」盯着（比的是两页**第一个面板的左边距 + 最后一个面板的右边距** —— 拿第一个去比右边距会把侧栏宽度当成边距）。

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

### 装 / 卸 / 升级：三个必须守住的点

装（`add`）、卸（`remove`）、升级（`update`）全部走 `dsh plugin --profile web …` —— 它把参数转发给 profile 目录里的 pnpm，然后按"装出来的包有没有声明 `dsh.bundle`"**重算** `dsh.profile.bundles`。我们**不自己改 package.json、也不自己解析 pnpm 的输出语义**，那两件事都是 dsh 的职责。

1. **spec 永远是一个 argv，不经过 shell**（`spawn(file, args)` + 数组，没有 `shell: true`）。拼错一次就是命令注入；自检里有一条静态断言盯着（`spawn(file, args` + `stdio: ['ignore','pipe','pipe']` + 没有 `shell: true`）。
2. **子进程 PATH 必须补上 pnpm**（`pathWithKnownBins`）：`dsh plugin` 内部是裸 `spawnSync('pnpm', …)`，而 GUI 启动的应用 PATH 很窄。不补的话用户看到的是 `dsh: pnpm not found on PATH`（退出码 127）。`findPnpm()` 除了 PATH 还会扫 `~/Library/pnpm`、homebrew、`~/.local/share/pnpm`、nvm 各版本目录。
3. **`-w` 只在 pnpm 自己要求时加**。这是个上游模板的坑：dsh 写的 `pnpm-workspace.yaml` 是 `packages: [.]` + `nodeLinker: hoisted`，**没有** `ignore-workspace-root-check`，于是 pnpm 9 把 profile 当 workspace root，`add` 直接报 `ERR_PNPM_ADDING_TO_ROOT`（实测：`dsh plugin --profile web add ./x` 必失败）。现在第一次照朴素参数跑，一旦输出里出现 `ADDING_TO_ROOT|workspace root` 就**加 `-w` 重试一次**，并在输出区写一句"pnpm 说这是 workspace root，加 -w 重试"。**不要无条件加 `-w`**：不在 workspace 里的时候那个 flag 是多余的。

4. **内置包直接拦下，并指出正确做法**。`@deepseek-ai/dsh-*` 这些是随 dsh 装好的（在 dsh 安装目录里），从 registry 再装一遍没有意义；而用户真正想做的通常是**启用**它 —— 那是 patch 层 `insert` 的事。所以 `add` 之前先解析包名（`packageNameOf`，带版本/标签也要取对）并在 dsh 安装目录里找一下，找到就直接拒绝 + 指路「插件页左边『你的层』那一栏」。这是真机测试时用户第一次尝试就撞上的死胡同。
5. **404 要说清是哪个 registry 说的**。归纳里把失败的主机名带出来（`GET https://<host>/…`），并且**先认 `registry.npm.taobao.org`**（2022 年就停服的旧镜像，很多内网源会回落到它）单独提示换成 `https://registry.npmmirror.com` —— 否则用户看到的是笼统的"包不存在"，会去怀疑包名。实测那台机器全局配的是内网 `registry.npm.baidu-int.com`，解析 `@deepseek-ai/*` 时回落到淘宝旧镜像。

另外两条界面约定：同一时刻只允许一个操作（同一个 profile 目录不能被两个 pnpm 同时改，按钮据此禁用，并给「中断」）；装/卸/升级改的是 `package.json` 与 `node_modules` → **必须重启 dsh**，所以做完挂一条黄条 + 「立即重启 dsh」，而 patch 层是即时生效 —— 这两种"生效时机"在界面上必须分开写清。

自检守着：「插件安装：spec 分得清 npm / 本地 / tarball / git」「插件安装：常见失败各归纳成一句人话，认不出来返回 null」「插件安装：从 spec 里取得出包名（带版本/标签也要取对）」「插件安装：链到已停服的淘宝镜像要单独说，别笼统说"包不存在"（并把失败的主机名带出来）」「插件安装：spec 是一个 argv（不拼 shell）、PATH 补过 pnpm、输出双向都收」「插件安装：pnpm 说"这是 workspace root"时用 -w 重试一次」「插件安装：契约里有 3 个 API 与操作结果类型」。失败归纳（`summarizePluginFailure`）只认它认得的四类（pnpm 缺失 / git 构建脚本被拦 / 404 / 网络与权限），认不出来就返回 null —— 界面显示原文，不编原因。

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

## 8. 调试手段

### 自检

```bash
npm test     # tsx test/selftest.ts，123 项，不需要 Electron、不启停任何进程
```

`test/selftest.ts` 覆盖：命令解析三级回退与解释器实测、ANSI 清理与令牌提取、健康判据、端口占用解析（Windows `netstat` / POSIX `lsof` 两套夹具，所以在一个平台上开发也不会把另一个平台的解析改坏）、`DshManager` 状态机与 PID 归属、渲染层静态检查（含 macOS 适配契约、构建产物形状、样式与主题、启动锁、设置默认值）、自动更新契约（不自动下载 / 安装、macOS 与开发态不加载 electron-updater），发布流程（CHANGELOG 条目、片段汇总规则、Release 标题与正文的生成与产物闸门），以及插件装配层（dump 的层归因、stderr 上的未匹配 patch、空输出不算成功）。

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

| 快捷键                                 | 作用                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `F12` / `Ctrl+Shift+I`（macOS：`⌘⌥I`） | 打开开发者工具（主进程处理，内嵌页也能单独开）。**detach 模式**，因为贴边停靠会改变布局      |
| `Ctrl+Shift+D`（macOS：`⌘⇧D`）         | 把当前界面的元素结构导出到日志：尺寸 / 位置 / 背景 / display / overflow / z-index + 当前状态 |

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
- **改完按第 5 节跑检查**：`npm test` 加 `npm run lint && npm run format:check && npm run typecheck`；交付前用 `npx prettier --write <改到的文件>` 收尾。
- **遇到不确定的领域先查证再动，别猜**：macOS 签名与 Gatekeeper、Electron 版本行为、node-pty 的 ConPTY 细节、dsh 的鉴权与内部文件格式，都属于「猜错会静默失效」的类型。能在仓库里读到的以代码 / 配置 / CI 为准；读不到的（上游行为）去查上游源码或文档，并在改动说明里写清依据。
- **改文档时保持两份的边界**：用户视角的写进 `README.md`，开发 / 架构 / 发版的写进本文件；不要在本文件里写「某台机器上如何如何」的实测记录 —— 结论留下，过程与本机路径不要留。
