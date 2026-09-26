# 运行环境自检 + 一键配置（设计文档）

> **状态**：这份文档描述的是**阶段一**落地的那一页（八项只读探测 + 两个 npm 一键动作），内容仍然有效。
> **阶段二在它上面加了三件事**，都以 [`docs/env-wizard-freeze.md`](env-wizard-freeze.md) 为准：
> ① 首启环境向导与入口门禁（`judgeWizard` / 逃生口 / 快速探测）；
> ② Node 的一键安装与更新（两条路：官方安装包 / nvm-windows；只在 Windows 上）；
> ③ 判定口径的一处收紧（npm / pnpm 的「有输出才算可用」，见 1.3）。
> 本文里被阶段二取代的两处结论已在原位标注（1.1 末尾、3.1、第 9 节）。

这份文档解决一件事：**把「为什么起不来 / 为什么装不了插件」从用户的猜测变成界面上的一行行结论，并且能给的一步就替用户做掉。**

面向的对象是**实现者**（人或者 AI）。它不是产品介绍（那部分写进 `README.md`），也不是操作手册；代码约定一律以 [`AGENTS.md`](../AGENTS.md) 为准，本文只补它没写的那部分设计决定与理由。写完之后按 AGENTS 第 5 节跑四道门禁。

一句话概括要做的东西：

```
打开应用
  └─ 后台跑一轮探测（不阻塞启动、不碰 dsh 进程）
       └─ 左栏多一页「环境自检」：8 项逐条给结论
            ├─ 正常   → 只说事实（找到哪个 node、版本多少、按哪种方式调用 dsh）
            ├─ 需要注意 → 能用但有隐患，给一句为什么
            └─ 不正常 → 给「你能自己执行的命令」+ 能替你做的那一步
                 └─ 一键修复：确认 → 流式输出 → 可中断 → 自动复检
```

## 0. 要解决的问题

现在的失败方式都是**沉默**的，用户手上没有任何线索：

| 现象                                                | 真实原因                                                                | 用户看到的                 |
| --------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------- |
| dsh 起不来，界面上就是「已停止」                    | 本机 Node 版本不兼容：dsh 的 CLI **退出码 0、零输出**                   | 什么都看不到（AGENTS 7.4） |
| 插件页装插件报 `dsh: pnpm not found on PATH`（127） | `dsh plugin` 内部是裸 `spawnSync('pnpm')`，而 GUI 应用的 PATH 很窄      | 一句英文，不知道要装什么   |
| 「我没装 dsh 啊」                                   | 其实装了，但在另一个 Node 版本目录里（`nvm use` 换过版本）              | 找不到就是找不到           |
| dsh 走了 `npx -y`                                   | 没有全局安装，每次都要联网解析/下载                                     | 慢、且偶发失败             |
| 改动不生效                                          | 已经由插件页的「需要注意的 N 处」收掉（7.18），**这一页不重复管那件事** | —                          |

所以这一页的定位与插件页（装配层）不同：**这一页说的是「这台机器上到底有什么、能不能用」，以及不能用的时候怎么办。** 它不读 DSH 的配置，也不改 DSH 的配置。

一条贯穿全文的边界：**探测是只读的，修复只做最小动作。** 探测不写任何文件、不改设置；修复只有两个动作（都只改全局 npm 包），每次都要用户点确认。

## 1. 探测项清单

八项，顺序就是界面上的顺序：先把「能不能跑起来」说清（第 1 到 6 项），再说「外围」（第 7、8 项）。每一项写清三件事：**怎么测 / 判定规则与阈值 / 不满足时用户可执行的修复**。

| #   | id                | 一行标题         | 怎么测                                                                         | 判定（阈值）                                                                                                                                                                   | 不满足时                                                                              |
| --- | ----------------- | ---------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 1   | `node`            | 外部 Node        | `findNodeExe()`（PATH → 已知目录 → nvm/fnm/nodenv 各版本）                     | 拿到路径 = `ok`；拿不到 = `missing`                                                                                                                                            | 装 Node（给官方下载页 + `nvm install` 两条路）                                        |
| 2   | `node-version`    | Node 版本        | 跑一次 `node --version`（8 秒超时，结果缓存）                                  | 落在 `^20.19.0 \|\| >=22.12.0` 内 = `ok`；在外 = `warn`；跑不出输出 = `warn`                                                                                                   | 升到 22.12+ / 20.19+，或 24（本机实测能跑 dsh 的那档）                                |
| 3   | `npm`             | npm              | `whichSync('npm')` + Windows 已知目录兜底，再跑 `npm -v`                       | 有路径且有输出 = `ok`；有路径但**跑不出结果**（零输出 / 退出码非 0）= `missing`；**这个运行环境不允许起子进程**（`EPERM` / `EACCES` / 沙箱）= `warn`；连路径都没有 = `missing` | 重装官方 Node（npm 随它来）；只要 pnpm 时可 `corepack enable pnpm`                    |
| 4   | `pnpm`            | pnpm             | `findPnpm()`（PATH → 已知目录 → 各版本管理器），再跑 `pnpm -v`                 | 有路径且有输出 = `ok`；有路径但**跑不出结果**（零输出 / 退出码非 0）= `missing`；**这个运行环境不允许起子进程** = `warn`；无路径 = `missing`                                   | **一键**`npm i -g pnpm`（`fixAction: 'install-pnpm'`）；不行再 `corepack enable pnpm` |
| 5   | `dsh`             | dsh 本体         | `resolveDshLauncher(settings)`（自定义命令 → node+bin.js → shim → npx）        | 解析出 `node-bin` / `shim` / `custom*` = `ok`；只有 `npx` = `warn`；抛错 = `missing`                                                                                           | 一键 `npm i -g @deepseek-ai/dsh`；或按提示在设置里写死 `node + bin.js`                |
| 6   | `dsh-run`         | 实测能不能跑 dsh | `dshArgsFor(launcher, ['--version'])` 跑一次，**有输出才算能跑**（AGENTS 7.4） | 有输出 = `ok`；无输出但独立跑得起来 = `missing`；被环境拦下（EPERM） = `warn`                                                                                                  | 换一个 Node（写进设置 →「启动方式 → dsh 命令」）                                      |
| 7   | `bundled-runtime` | 应用自带运行时   | 主进程的 `process.versions`（electron / node / chrome），不跑子进程            | 内嵌 Node 落在同一句区间内 = `ok`；在外 = `missing`；开发态 = `ok` + 说明                                                                                                      | 升级 DSH Console（打包态）/ 升 Electron 依赖（开发态）；给 Releases 链接              |
| 8   | `shell`           | 本地 Shell       | `resolveShell(settings)`，再确认那个文件真的存在                               | 存在 = `ok`；不存在 = `missing`（设置里写死的路径已失效时）                                                                                                                    | 清空或改「设置 → 本地 Shell」；页内给「去设置」                                       |

下面逐项补充「为什么这么判」。

### 1.1 `node`：外部 Node 可执行文件

**怎么测**：直接用现成的 `process-utils.ts` 的 `findNodeExe()`。**不要自己再写一份 PATH 查找**——它已经处理了 macOS 上 GUI 启动时 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin` 这件事，也扫了 nvm / fnm / nodenv / homebrew / volta（见 7.4）。

**判定**：拿到路径就是 `ok`（`detail` 里写出完整路径），拿不到是 `missing`。

**修复**（`fixAction: null` —— 这一页不给按钮，但**首启向导里有应用内的一键安装**）：
`installNodeHint()` 现在**先说应用内那条路**：「点上面的『安装 Node.js』：直接安装官方稳定版、或通过 nvm 安装，都由我们装好并切过去」；命令行只作「想自己来也可以」的备选（`nvm install 24 && nvm use 24`（nvm-windows）、或到 nodejs.org 装 22.12+ 的 LTS）。企业 / 内网机器给内部源，别写死。

> **口径（t43 / VM-13，与 VM-04 并列的第二条文案红线）**：界面文案**不许把应用自己就能做的事推给用户**。
> 这条下面所有 hint 都按它改过：`node` / `node-version` 先说应用内的「安装 Node.js」；快速探测那些 `skipped` 项
> 统一成「不用做什么：这一轮完整检测马上就会给出这一项的结论」（原来写的是「在终端里手工跑一次 `xxx -v` 确认」）；
> npm / pnpm 的「找到了但零输出」也改成应用内那两条。**只有一种情形保留"你自己动手"**——`EPERM`
> 那类「我们的进程在这个环境里起不了子进程」，而且要先让用户点「重新检测」（`BLOCKED_HINT_PREFIX`）。
> 自检逐条钉住：「环境自检（VM-13）：门禁事实行不再把用户打发去终端，且『管理器在、零版本』说的是那一种状态」。

> **这一条已经被阶段二取代**：阶段二做了「一键装 Node」（两条路：官方安装包 / nvm-windows），
> 见 [`docs/env-wizard.md`](env-wizard.md) 与 [`docs/env-wizard-freeze.md`](env-wizard-freeze.md) 的 7.2 / 7.3 节与 R-23 / R-25 / R-27。
> 当时不做这个判断的理由（系统级安装、可能要管理员权限、失败面大）今天仍然成立，所以阶段二的做法是：
> **只在 Windows 上做、每次都要用户确认、提权由安装器自己触发、装完重读系统环境**，而不是把这一页变成安装器。

### 1.2 `node-version`：版本是否满足要求

**怎么测**：对第 1 项找到的那个 node 跑一次 `--version`，8 秒超时，输出用 `parseNodeVersion()` 解析成 `{ major, minor, patch }`。同时把这次子进程的结果（stdout / 退出码 / 抛出的错误）一起收进原始探测结果——判定要用它区分「版本不满足」与「这个环境不允许起子进程」。探测结果在主进程内缓存，`refresh` 时清掉。

**阈值**：`NODE_RANGE = '^20.19.0 || >=22.12.0'`，与 `vite` 的 `engines.node` 是**同一句**（AGENTS 第 1 节：`npm install` 的门槛）。自检里有一条把它俩钉在一起，免得哪天升级 vite 时这句话悄悄过期。

实现上不引 semver 库，`satisfiesNodeRange()` 只认这一句区间：

```ts
const major = version.major;
if (major === 20) return version.minor >= 19;
if (major === 21) return false; // 不在区间里（vite 那句也不含它）
if (major === 22) return version.minor >= 12;
return major > 22;
```

单测覆盖边界：`20.18.0` → 不满足、`20.19.0` → 满足、`22.11.9` → 不满足、`22.12.0` → 满足、`23.0.0` / `24.19.0` → 满足。

**判定**：

- **第 1 项就没找到外部 Node → `missing`**（`detail` 写「外部 Node 都没找到，版本无从判断」）：没有可执行文件时版本不是「能用但有隐患」，而是**根本没有判据**；出路与第 1 项共用（去装 Node），所以这两项会一起亮红灯；
- 在区间内 → `ok`（`detail` 写 `v24.19.0，要求 ^20.19.0 || >=22.12.0`）；
- 在区间外 → **`warn`，不是 `missing`**。理由：这句区间是**构建期**的要求（vite 的 `engines`），不是 dsh 运行时的硬判据——dsh 到底能不能跑由第 6 项**实测**决定（7.4：dsh 对 Node 版本敏感，但它不报错，所以只能实测）。把「能不能跑」的红灯职责单独交给第 6 项，界面上就不会出现「版本红灯但实测绿灯」这种自相矛盾的两行。
- 子进程跑不起来（抛错、超时、被沙箱拒绝）→ `warn`，`detail` 里写明「没能跑起来测版本（这个运行环境可能不允许起子进程）」。**不要因为沙箱拒绝就说用户没装 Node**——7.4 末尾那条「全部候选都测不过时退回第一个候选」是同一个道理。
- **找到了 Node、但它跑不出任何输出**（「有输出才算可用」这条口径的落点，与 npm / pnpm 一样）：三支要分清 ——
  ① 「这个运行环境不允许起子进程」→ `warn`（我们测不出来，**先让用户点「重新检测」**，再补一句只有他能做的确认）；
  ② **这份 Node 落在版本管理器管的目录里**（`looksVersionManagerNode`：nvm / fnm / volta / nodenv 的目录形状与它们写的环境变量）→ `missing`，`detail` **说中这一种状态**：「版本管理器已经装好了：这份 Node（…）就在它管的目录里，但它还没有装任何 Node 版本（或者没有选中一个），所以这个 node.exe 现在跑起来没有任何输出」——出路是应用内那条（由我们装一个并切过去），**不是让用户去终端 `nvm use`**；
  ③ 其它（真的坏了的 Node）→ `missing`，`detail` 带路径与退出码，出路同样是应用内那条。
  只读事实来自 `EnvProbeRaw.nodeFromVersionManager`（两个采集器都填，只看路径与环境变量，不额外起子进程）。

**修复**：`fixAction: null`；`fixHint`（`nodeInstallHint` / `upgradeNodeHint`）**先说应用内那条路**「点上面的『安装 Node.js』…都由我们装好并切过去」，命令行（`nvm install 24 && nvm use 24`、或 nodejs.org 的 22.12+ LTS）只作「想自己来也可以」的备选。

### 1.3 `npm`：能不能用

**怎么测**：`whichSync('npm')`（Windows 上按 `PATHEXT` 展开，所以 `npm.cmd` 认得出来），PATH 里没有时用 `windowsBinCandidates(process.env, homeDir())` 扫 `%APPDATA%\npm`、`%ProgramFiles%\nodejs`、`NVM_SYMLINK` 等已知目录。拿到路径后再跑一次 `npm -v`（8 秒超时）确认**真的有输出**。

**为什么必须有这一项**：下面两个一键修复动作都靠它。它不可用时，`pnpm` / `dsh` 那两行的按钮根本不该出现——起了子进程也只会失败，还白改一遍磁盘（7.18 第 2 条对 pnpm 就是这么处理的）。

**判定**（阶段二把这一档收严了，理由见下面的「为什么改」）：

- 有路径 + 有输出 → `ok`；
- 有路径 + **跑不出结果**（零输出，或退出码非 0）→ `missing`：**它真的用不了**，两个一键动作也就都用不了；
- 有路径，但失败原因是**这个运行环境不允许起子进程**（`EPERM` / `EACCES` / 沙箱）→ `warn`：**我们测不出来，不代表没装**，不挡人；
- 没有路径 → `missing`，`fixHint` 指向「重装官方 Node（npm 随它一起装）」。

**为什么改**（VM-03 的真机反馈）：原来的口径是「有路径但无输出 = warn」，于是**一份真的坏掉的 npm 只会亮黄灯**，
而它恰好是另外两个一键动作的前提 —— 用户看到黄灯就以为还能用。现在是「**有输出才算可用**」（与 `dsh-run`
那一项同一条判据），只有**我们自己的运行环境**不允许起子进程时才留黄灯。

**面向用户的文案里不出现内部记号**：`detail` 写人话（「这个运行环境不允许起子进程 —— 不代表没装 npm」），
`EPERM` / `EACCES` 这类原始错误经 `EnvDoctorHooks.log` 落 `<userData>/logs/console.log`（「细节留日志、结论给人话」）。

**修复**：`fixAction: null`（这一版**不替用户装 Node** —— 阶段二把「装 Node」放进了独立的首启通道，见 1.1 末尾）。要在没有 npm 的机器上拿到 pnpm，出路是 `corepack enable pnpm`（写进 `fixHint`）。

### 1.4 `pnpm`：一键安装

**怎么测**：`findPnpm()`（PATH → `~/Library/pnpm`、homebrew、`~/.local/share/pnpm`、各版本管理器目录；Windows 上不写死 `.cmd`，独立安装包是 `pnpm.exe`），拿到路径后跑 `pnpm -v` 确认有输出。

**判定**：同 npm 那三档（**有输出才算可用**：跑不出结果 = `missing`；只有"这个运行环境不允许起子进程"才是 `warn`，见 1.3 的「为什么改」）。`missing` 的后果写在 `detail` 里：**插件页的装 / 卸 / 升级全都不可用**（`dsh plugin` 内部是裸 `spawnSync('pnpm')`）。

**修复**：`fixAction: 'install-pnpm'`，命令是 `<npmPath> i -g <pnpm 规格> --allow-scripts=pnpm` ——
规格按 VC++ 运行库在不在选（缺 → 纯 JS 的 `pnpm@10`，有 → 最新，见 3.4 的 `pnpmInstallSpec`），
末尾那个是**一次性的 install-scripts 放行开关**（不改用户全局 npm 配置）。npm 也缺失时降级成
`fixAction: null` + `fixHint: 'corepack enable pnpm'`。

> **装完之后应用认不认得出来**（这条决定「一键」是不是真的有用）：`findPnpm()` 每次调用都重新查 PATH 与那几个已知目录，不缓存，所以只要 pnpm 落在 PATH 或已知目录里，**复检立刻能看到**；而且收尾那条链现在是「**先刷新查找路径**（重读注册表两段 PATH + 重扫已知目录 + 把 `npm prefix -g` 那个目录排在最前）→ 复检 → **功能实测 `<pnpm> -v`（有输出才算成功）**」，形状见 3.4。所以**正常的装完路径不需要重启应用**；只有「刷新过之后仍然找不到」那一种情形，`message` 里才会说「重开应用再检测一次」——Windows 上 GUI 应用拿到的是**启动那一刻**的环境块（7.18 第 2 条的原话），那句话不是托词。

### 1.5 `dsh`：本体能不能定位

**怎么测**：`resolveDshLauncher(settings)`。它已经实现了四级优先级（自定义命令 → node + bin.js → dsh shim → `npx -y`），并且会扫 nvm / homebrew / `~/.npm-global` 这些 PATH 之外的位置。**不要另写一套解析**——界面上的「命令解析方式」、状态栏、快照里的 `launch.kind` 都来自它，两份解析一旦漂移，用户就会看到两个互相矛盾的结论。

**判定**：

| `launcher.kind`          | 结论      | 为什么                                                 |
| ------------------------ | --------- | ------------------------------------------------------ |
| `node-bin`               | `ok`      | 最可靠的一条路，进程 PID 就是 dsh 自己                 |
| `custom` / `custom-shim` | `ok`      | 用户在设置里写死的，尊重他的选择                       |
| `shim`                   | `ok`      | 平台自带的 `dsh` / `dsh.cmd`，能用                     |
| `npx`                    | `warn`    | 能用，但每次启动都要联网解析、必要时下载，慢且可能失败 |
| 抛错（四种都没有）       | `missing` | 真的没有 dsh                                           |

**修复**：`missing` 时 `fixAction: 'install-dsh'`（`<npmPath> i -g @deepseek-ai/dsh`，npm 不可用则降级为 null），`fixHint` 另给 `nvm use` 用户那句话：「装在当前 Node 版本目录下，换版本后 dsh 会『不见了』—— 要么在当前版本重装，要么在设置里写死 `node + bin.js`」。

`npx` 的 `warn` 给 `fixHint: 'npm i -g @deepseek-ai/dsh'`（装了就不再走 npx）。

### 1.6 `dsh-run`：实测能不能跑

**怎么测**：用 `dshArgsFor(launcher, ['--version'])` 拼出 argv（**复用这个函数**：Windows 上经 `cmd.exe` 的那条路要按 cmd 规则加引号，只有它会拼），8 秒超时跑一次，**有输出才算能跑**。

**为什么必须有这一项**：dsh 的 CLI 在版本不兼容的 Node 上是**退出码 0 + 零输出**（7.4）。只看退出码永远发现不了，界面上只显示「已停止」。第 5 项说「dsh 在哪」，这一项说「它到底跑不跑得动」，两件事分开，用户才知道该修哪一个。

**判定**：

- **第 5 项没定位到 dsh → `warn`**（`detail` 写「dsh 本体还没定位到，没法实测能不能跑」）：这一项报的是「**实测**结论」，连入口都没有时压根没有可实测的东西，给红灯会把「找不到」与「跑不动」混成一件；红灯由第 5 项出（那里带着一键装 dsh 的出路）；
- 有输出 → `ok`（`detail` 里带第一行输出，插件页同款做法）；
- 退出码正常但没有输出 → **`missing`**，`detail` 里写清「dsh 在跑不动的 Node 上是静默退出（退出码 0、零输出）」，`fixHint` 指向「设置 → 启动方式 → dsh 命令」写一条能跑的 node + bin.js；
- 子进程根本起不来（`EPERM` / 沙箱拒绝）→ `warn`，`detail` 说明「这个运行环境不允许起子进程，没法实测」；
- 其它错误（`ENOENT` 等）→ `missing`，`detail` 放错误原文的一句话。

`node-bin` 那条路不需要额外起子进程：`pickDshInterpreter()` 挑出来的组合本来就是**实测过**的（AGENTS 7.4），探测直接复用 `canRunDsh` 的缓存结果。**不要试图去清 `canRunDsh` 的缓存**：它按「解释器 + bin.js」这个组合缓存，换了 Node 或装了新的 dsh 就是新的组合，自然会重测；同一组合反复测没有意义。

### 1.7 `bundled-runtime`：应用自带的 Electron / Node

**怎么测**：主进程的 `process.versions.electron / node / chrome`（与快照 `env.versions` 同源，不跑子进程）。

**判定**：**用同一句 `NODE_RANGE` 判内嵌 Node**。理由很直接：主进程代码就是跑在这个 Node 上的，标准库与语法受同一套约束；再硬编码一张「Electron 版本 → Node 版本」的对照表只会随每次升级过期。

- 打包态：满足 → `ok`（`detail` 写「Electron `<版本>`，内置 Node `<版本>`」，两个数都来自 `process.versions`）；不满足 → `missing`，`fixHint` 必须写清「**这不是你机器上的 Node**，它由我们打包时用的 Electron 决定」，出路是升级 DSH Console（给 Releases 链接，`openExternal`）；
- 开发态（`app.isPackaged === false`）：一律 `ok`，但 `detail` 里补一句「开发态：这份运行时来自 `electron` 依赖，应用跑在你的系统 Node 上」——开发时看到别人机器上的红灯没有意义。

这一项存在的主要价值是**记录事实**：用户报障时，「你的 Electron 是多少、内置 Node 是多少」是最常被问的第一个问题，底栏那行 `Electron x，Node y` 已经有了，这里把它变成一条有判定的行。

### 1.8 `shell`：本地 Shell

**怎么测**：`resolveShell(settings)`，再确认解析出来的那个文件真的存在（`fs.existsSync`）。

**判定**：存在 → `ok`；不存在 → `missing`。**只有两种走法**：用户没填（自动挑 pwsh/powershell/cmd 或 `$SHELL`/zsh/bash/sh），一般不会失败；或用户在设置里写死了一个路径、那个路径后来被删了（换了 shell、换了机器、卸载了 PowerShell）。后者才是这一项真正的价值——那时「本地 Shell」页点新建会直接失败，而这行会告诉他原因。

**修复**：`fixAction: null`，`fixHint` 指向「设置 → 本地 Shell」清空或改成正确路径；页内给一个「去设置」的按钮（只切页 + 滚到那一行，不做修复）。POSIX 上**不要**因为发现 pwsh 就自动改（7.4 最后一条的理由同样成立）。

## 2. 判定：必须是一个纯函数

**可离线验证的硬约束**：

> `judgeEnvironment(raw: EnvProbeRaw): EnvDoctorReport` **只读入参**：不碰磁盘、不起子进程、不读 `process.env` / `process.platform` / `process.versions`、不看时间（`checkedAt` 由调用方塞进 `raw`）。

所有 IO 都在采集侧：`collectEnvProbe(settings)` 负责调 `findNodeExe()`、跑 `--version`、读 `settings`。这样 `test/selftest.ts` 只要喂一个**手工构造的对象字面量**就能把八项的所有分支测完，不需要装 pnpm、不需要起任何进程——与仓库里 `parseNetstatForPort` / `checkDumpResult` / `windowsBinCandidates` 的做法一致。

### 2.1 采集结果的形状（`src/main/env-doctor.ts`，**不上线缆**）

```ts
/** 探测到的一条事实（子进程的结果都在这里，判定不看别的） */
export interface VersionProbe {
  path: string | null;
  /** --version 的第一行；没跑起来时为 null */
  version: string | null;
  /** 子进程的退出码；没跑起来时为 null（退出码 0 + 零输出是「静默退出」的关键特征） */
  exitCode: number | null;
  /** 子进程抛出的错误（EPERM = 这个环境不允许起子进程，和「没装」是两件事） */
  error: string | null;
}

export interface DshProbe {
  /** 解析结果：custom / custom-shim / node-bin / shim / npx；解析不出来时为 null */
  kind: string | null;
  /** 命令原文（界面直接显示，不重新拼） */
  display: string | null;
  /** 实测是否有输出 */
  runs: boolean;
  version: string | null;
  exitCode: number | null;
  error: string | null;
  /** 四种方式都没解析出来时的原因（`resolveDshLauncher` 抛出的那句话） */
  resolveError: string | null;
}

export interface ShellProbe {
  file: string | null;
  exists: boolean;
}

/** 一轮探测的原始事实：判定的唯一入参 */
export interface EnvProbeRaw {
  checkedAt: number;
  /** 直接用主进程的 process.platform / app.isPackaged，判定函数不自己读 */
  platform: string;
  packaged: boolean;
  bundled: { electron: string; node: string; chrome: string };
  node: VersionProbe;
  npm: VersionProbe;
  pnpm: VersionProbe;
  dsh: DshProbe;
  shell: ShellProbe;
  /** 采集本身有没有意外（例如读设置失败），有值时整份报告要带出来 */
  error: string | null;
}
```

**为什么不放进 `shared/ipc.ts`**：契约那份文件管的是「跨进程线缆上的形状」（文件头就写着这句话）。`EnvProbeRaw` 是判定的入参、永远不上线缆，放进 `main/env-doctor.ts` 才不会把主进程的实现细节写进渲染层的类型面。

### 2.2 判定函数与常量

```ts
/** 与 vite 的 engines.node 同一句；自检把两处钉在一起 */
export const NODE_RANGE = '^20.19.0 || >=22.12.0';

/** 子进程超时：探测 8 秒（与 canRunDsh 一致），一键修复 5 分钟 */
export const PROBE_TIMEOUT_MS = 8000;
export const FIX_TIMEOUT_MS = 5 * 60 * 1000;
/** 修复输出只保留尾部这些字符（与插件操作同款做法） */
export const FIX_TAIL_CHARS = 64 * 1024;

/** 一条可执行的启动描述：`file` / `args` 就是最终交给 spawn 的东西。
 *  **它住在 process-utils.ts**（与 COMSPEC / quoteForCmd / dshArgsFor 同处），见下。 */
export interface LaunchSpec {
  file: string;
  args: string[];
  /**
   * true = `args` 已经是按 cmd.exe 规则拼好的**一整条命令行**，Node 不要再加引号。
   * Windows 上必须声明它（执行侧与探测侧都传），否则 Node 会把 `"C:\…\npm.cmd"` 再转义一次。
   */
  windowsVerbatimArguments: boolean;
}

/** 单项结论 → 报告（纯函数，见上） */
export function judgeEnvironment(raw: EnvProbeRaw): EnvDoctorReport;

/** 以下这些都必须是纯函数（自检直接喂夹具，任何平台都能测） */
export function parseNodeVersion(text: string): NodeVersion | null;
export function satisfiesNodeRange(version: NodeVersion): boolean;
export function envFixPlan(action: EnvFixAction, npmPath: string | null): EnvFixPlan | null;
/** npm 的启动 spec：**只是 process-utils 那个 launchSpec 的别名**（调用处一眼认得出是给 npm 用的） */
export function npmLaunchSpec(npmPath: string, args: string[], platform: string): LaunchSpec;
/** 超时终态的那句话（不让它退化成「退出码未知」） */
export function fixTimeoutMessage(timeoutMs?: number): string;
export function summarizeEnvFixFailure(output: string): string | null;

// ---- src/main/process-utils.ts：公共件（env-doctor 与 plugin-manager 都从这里取）----
/** 这份路径在自己的平台上能不能被起起来（Windows 上只看扩展名，`npm` 那种 sh 脚本不算） */
export function isRunnablePath(file: string, platform: string): boolean;
/** 统一包装器：一键装包、插件的三个启动点、`--dump-config` 全都经它 */
export function launchSpec(file: string, args: string[], platform: string): LaunchSpec;
/** 「启动 dsh」的统一入口：解析出来的 launcher 经它变成能真的 spawn 的 spec */
export function dshLaunchSpec(launcher: DshLauncher, args: string[], platform: string): LaunchSpec;
```

下面这几条**形状上的约定**是踩过坑之后定下来的，改代码时别顺手改回去：

- `launchSpec()` 是**唯一**的包装器：非 Windows 原样返回 argv 数组；Windows + PE（`.exe` / `.com`）直连；其它（`.cmd` / `.bat` / 无扩展名）以及**已经是 `cmd.exe` 的调用**走 `{ file: COMSPEC, args: ['/d', '/s', '/c', '"<拼好的一整条命令行>"'], windowsVerbatimArguments: true }`。探测与执行分开各写一遍，就会出现「修复起不来、探测却说正常」这种自相矛盾的结论。
- **它住在 `process-utils.ts`**（`COMSPEC` / `quoteForCmd` / `dshArgsFor` 的邻居），不在 `env-doctor.ts` 里：这样 env-doctor（一键装 npm 包）与 plugin-manager（装/卸/升级、`--dump-config`）都只是**取用**它，谁都不必 import 谁。`npmLaunchSpec()` 只是它的别名，留着是为了调用处一眼认得出「这是给 npm 的那条 spec」，**不是**第二套实现、也没有被删掉。
- 超时是**独立终态**：`fixTimeoutMessage()` 有自己的那句话，判定要放在「子进程报错」「退出码 != 0」**之前**；判晚了就会被通用失败分支吃掉，用户看到的是「退出码未知，认不出具体原因」。

### 2.3 报告的聚合规则（同样在纯函数里）

- `counts`：按 `checks` 里三种状态的个数算出来（界面不再数一遍）。
- `firstProblemId`：`missing` 优先于 `warn`，同级按 `checks` 的固定顺序（先「能不能跑」、后「外围」），全 `ok` 时为 `null`。
- **不满足必有出路**：`status !== 'ok'` 的每一项，`fixHint` 必须非空（能做就再加 `fixAction`）。这条是这一页的卖点，值得写成自检。
- 每一项的 `detail` 必须非空，且**尽量带事实**（路径、版本号、判定依据的那句话），不要只写「异常」。

## 3. 一键修复：动作、安全模型、交互

### 3.1 只有两个动作

| 动作           | argv（完整路径，数组）                                      | 改了什么                        |
| -------------- | ----------------------------------------------------------- | ------------------------------- |
| `install-pnpm` | `<npmPath> i -g <pnpm 规格> --allow-scripts=pnpm`（见 3.4） | 全局 npm 包（pnpm）             |
| `install-dsh`  | `<npmPath> i -g @deepseek-ai/dsh`                           | 全局 npm 包（DeepSeek Harness） |

**没有第三个动作。** 明确不做的：改 PATH、写 `.npmrc`、动 `$DSH_HOME`、改任何设置项、改 DSH 的配置文件（那是插件页的事）。**「装 Node」不是第三个动作，而是另一条独立通道**（`envNodeInstall`，只在 Windows 上、每次都要用户确认、提权由安装器自己触发）—— 见 `docs/env-wizard-freeze.md` §3.2；这两个 npm 动作的语义与安全模型一个字没变。

### 3.2 安全模型

1. **渲染层只递 `action`，不递命令。** `envFix({ action })` 里只有一个联合类型成员；`file` / `args` 由主进程用 `envFixPlan()` 现场重新算。这与 7.18「救援时渲染层递来的路径不可信」是同一条原则——契约里给 `EnvFixPlan.file/args` 只是为了**显示**，绝不用作执行依据。
2. **spec 是一个 argv，不拼 shell。** `spawn(file, args)` + 数组，没有 `shell: true`。Windows 上的坑不止一个，全都收口在 **`process-utils.ts` 的纯函数 `launchSpec()`**（以及 `dshLaunchSpec()`）里 —— 一键装包、插件的三个启动点（装/卸/升级、`--dump-config`）、`dsh web` 都从这一处取，探测侧与执行侧也共用同一个它：
   - **解析侧**：Node 安装目录里 `npm`（POSIX sh 脚本）与 `npm.cmd` 是并存的，只按 PATH 找「叫 npm 的那个文件」会拿到前者 —— 它既不是能直接 spawn 的 PE，也不是 cmd 能跑的批处理（直接 spawn 报 `EINVAL`）。所以只认带可执行扩展名（`PATHEXT`）的那个，`whichSync()` 在 Windows 上也不再返回无扩展名的同名文件。
   - **执行侧**：`.cmd` / `.bat` / 无扩展名，以及**已经是 `cmd.exe` 的调用**（`resolveDshLauncher()` 给的 shim / npx 那条路），都要经 `cmd.exe`：把 `/d /s /c` 之后拼成**一个**参数、整条再套一层引号，即
     `{ file: COMSPEC, args: ['/d', '/s', '/c', '"<拼好的一整条命令行>"'], windowsVerbatimArguments: true }`；`.exe` / `.com` 直连，POSIX 原样透传。
   - **少了 `windowsVerbatimArguments: true` 就是第二个坑**：Node 自己的引号规则会把 `"C:\…\npm.cmd"` 再转义一次，cmd 报 `\"…npm.cmd\" is not recognized`（`/s` 会剥掉最外层那对引号，剥完才是真命令行 —— cmd 的既定行为，`cross-spawn` 一类库也是这么拼的）。
3. **npm 必须用完整路径**（探测拿到的那个），不能写裸 `npm`：GUI 启动的应用 PATH 很窄（7.18 第 2 条）。
4. **子进程环境按既有规矩补**：`envWithKnownBins(process.env)`（Windows 上保留系统原有的 `Path` 键名）叠加 `pluginRegistryEnv(settings.pluginRegistry)`。**复用安装源设置**：它本来就是「装 npm 包走哪个源」的意思，用户在国内/内网填过就让它生效；界面上写明「本次使用你设置的插件安装源」。不写用户的 `.npmrc`、不改全局配置。
5. **每次都要用户点确认**：修复前渲染层在**页内**展开确认区（不是在跑之前偷偷开始）。确认区必须显示 `plan.display`（命令原文）、`plan.target`（会装进哪个目录，来自一次 `npm prefix -g`，取不到就显示 null 与一句「目录待 npm 自己决定」）、`plan.note`（会修改系统的全局 npm 包、需要联网）。
6. **同一时刻只允许一个动作**：与插件操作同款（`busy` 时按钮禁用、再点返回一句「已经有一个修复在进行中」）。理由是同一条：两个 npm 同时改全局目录，结果不可预期。
7. **可中断，而且超时是独立终态**：`envFixCancel()` → `child.kill()`，相位转 `cancelled`，输出区补一行「（已中断）」；`FIX_TIMEOUT_MS` 到点自动 kill 并用 `fixTimeoutMessage()` 的那句话收尾（「超过 N 分钟没跑完，已自动中断（npm 可能已经写了一部分）」）。**这句判定要放在「子进程报错」「退出码 != 0」之前** —— 放后面就会被通用失败分支吃掉，用户看到的是「退出码未知，认不出具体原因」，等于把唯一能说明白的线索丢掉了。
8. **不静默**：动作与结果都写进事件日志（`dshManager.log`），比如「环境修复：`npm i -g pnpm` → 退出码 0，复检后 pnpm 已可用」。

### 3.3 收尾与失败

跑完自动**复检一次**（清缓存 + 重新采集 + `judgeEnvironment`），结果同时放进 `EnvFixState.report`、随 `env:fix-state` 推给渲染层，所以自检页会自己刷新那一行，不需要用户再点「重新检测」。

失败归因只认三类（`summarizeEnvFixFailure`，认不出来返回 `null`，界面显示原文，**不编原因**——与 `summarizePluginFailure` 同一条原则）：

| 认得出的                                | 怎么说                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `EACCES` / `EPERM` / 权限拒绝           | 全局目录不可写：给「用官方安装包装 Node」与「`corepack enable pnpm`」两条路 |
| `ETIMEDOUT` / `ENOTFOUND` / `EAI_AGAIN` | 网络不通：提示可以在设置里填插件安装源，或检查代理                          |
| `404` / `not in the npm registry`       | 带出主机名：注意 `registry.npm.taobao.org` 是 2022 年就停服的旧镜像         |

其它情况：输出区保留尾部原文（`FIX_TAIL_CHARS`），`message` 里只写「退出码 N，认不出具体原因，下面是 npm 的原文」。

### 3.4 「装完当场能用」：收尾那条链、三条口径、对外形状

这一节是 VM-06 / VM-07 / VM-09 三个真机缺陷收口后定下来的：**装完 pnpm 必须当场可用，失败要能一眼诊断**。
AGENTS 7.20 只留「现象 → 判据 → 做法」，**签名与逐条口径写在这里**（它们跟模块一起改，放手册里第二天就过期）。

**收尾那条链（顺序本身就是判据）**：

1. **先刷新查找路径**（`refreshLookupPath`）：重读注册表里的两段 PATH（`parseRegQueryVars` 取变量、
   `expandEnvRefs` 展开 `%NVM_HOME%` 这类引用）、重扫已知 bin 目录，用 `mergePathText` **合并去重保序**，
   并把这一次的安装目标（`plan.target`，来自 `npm prefix -g`）**排在最前** —— 排后面会被 PATH 里旧的那
   一份先选中，刷新就等于白刷；写回时沿用**已有的那个键名**（Windows 上通常是 `Path`，再造一个 `PATH`
   就会出现两个只差大小写的键）。这一步**只读系统里已有的，不写系统里的任何东西**。
2. **再复检**（`doctor.recheck()`）：清缓存 + 重新采集 + `judgeEnvironment`，结论进 `EnvFixState.report`。
3. **功能实测**（`probeFixTarget`）：真的跑一次 `<pnpm> -v`，**有输出才算成功**。只看「文件在不在」会把
   「文件在盘上但跑不起来」判成成功 —— 用户看到的是「装完了还是红的」。
4. **收尾文案**（`fixDoneMessage`）分四种情形（现在可用了 / 这个运行环境不允许起子进程 / 找到了但跑不起来 /
   刷新后仍找不到），而且只有**最后一种**才允许出现「重开应用再检测一次」（自检直接数这句话在函数体里
   出现的次数 = 1）。

**三条口径**（与阶段一的老规矩一脉相承）：

| 口径                       | 具体做法                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 细节留日志、结论给人话     | 界面只说「现在可用了 / 找不到 / 找到了但跑不起来」，原始事实落 `<userData>/logs/console.log`；日志位置由主进程经 `EnvFixHooks.logFile?` 注入，界面把那句话写进结论。没通过时把**那一次实际执行的命令 + 退出码 + stdout + stderr** 落进日志，功能实测那条命令（`<pnpm> -v`）的原文另落一份，**空的那一路也写「（空）」** —— 真机那一屏正是「两路都空」，写出来才看得见。 |
| 一次性开关不改用户全局配置 | `install-pnpm` 的 argv 里带 `ALLOW_INSTALL_SCRIPTS_FLAG`（`--allow-scripts=pnpm`）：这是 npm 自己在那句警告里给的**一次性**写法。`npm config set … --location=user` / 写 `.npmrc` 一律不做（自检用正则盯着这两类字样不许出现在 `env-doctor.ts` 里），确认区那句话也照实写给用户看。                                                                                     |
| 装完同一次运行内刷新       | 就是上面第 1 步。Windows 上 GUI 应用拿到的是**启动那一刻**的环境块（7.18 第 2 条），所以「让人重开应用」曾经是唯一的出路；把重读注册表 + 重扫目录 + 目标目录排最前做完之后，正常路径根本不需要重启。                                                                                                                                                                    |

**pnpm 的两条线**（VM-09）：`pnpmInstallSpec(vcRuntime)` —— 缺 VC++ 运行库 → `PNPM_PURE_JS_SPEC`（`pnpm@10`，
它的 `bin/pnpm.cjs` 是纯 JS，能跑）；有 → `PNPM_LATEST_SPEC`（`pnpm`，装最新）。**缺省当「有」**，避免没探测过的
调用方被无声降级。**只跟 pnpm 有关**：同一台真机上 `node -v` / `npm -v` 都正常，不要因此要求用户去装运行库。

**对外形状一览**（都在 `src/main/env-doctor.ts`）：

| 名字                                                                                | 形状                                                                      | 干什么                                                                                 |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `ALLOW_INSTALL_SCRIPTS_FLAG`                                                        | `const`（`'--allow-scripts=pnpm'`）                                       | 装 pnpm 时那一次性的 argv 元素                                                         |
| `PNPM_PURE_JS_SPEC` / `PNPM_LATEST_SPEC` / `pnpmInstallSpec(vcRuntime)`             | `const` / `(vcRuntime: boolean) => string`                                | 按运行库选 pnpm 哪条线（纯函数，自检钉两支分支）                                       |
| `EnvFixHooks.logFile?`                                                              | `() => string 或 null`                                                    | 主进程把日志文件位置注入进来（模块自己不 import electron、不知道 userData）            |
| `refreshLookupPath(extraDirs, env?)`                                                | `(string[], NodeJS.ProcessEnv) => string[]`                               | 重读系统 PATH + 重扫已知目录，返回这次**新注入**的目录（幂等：第二次不再报同一个）     |
| `probeFixTarget(action, platform)`                                                  | `(EnvFixAction, string) => FixProbe`                                      | 装完真的跑一次目标命令，产出 `{ file, version, exitCode, stderr, blocked, vcRuntime }` |
| `fixDoneMessage(facts)`                                                             | `({ label, ok, found, blocked, refreshed, logFile, verdict? }) => string` | 收尾那句话（四种情形 + 认出来的结论 + 日志位置）                                       |
| `parseRegQueryVars(text)` / `expandEnvRefs(text, vars)` / `mergePathText(...parts)` | 纯字符串函数                                                              | 注册表 PATH 的解析 / `%VAR%` 展开 / 合并去重保序（所以都能在 macOS 上测）              |

**为什么这些写在这里、而 AGENTS 7.20 只留指针**：AGENTS 是「改之前先读」的手册，写的是**现象 → 判据 → 做法**
（谁都能对着源码核对）；而**签名与逐条口径是跟着模块改的**，写在手册里会立刻过期。要查「这东西叫什么、
返回什么」看这一节；要查「为什么会有这条规矩」看 AGENTS 7.20。

**哪条自检守着**：`test/selftest.ts` 的 17a 组（开关与「绝不改全局配置」、`mergePathText` / `refreshLookupPath`、
四种收尾文案、原始输出落日志、缺运行库的结论与两条出路）、`scripts/env-doctor-cases.mjs` 的 case G（逐字钉住
`… i -g pnpm --allow-scripts=pnpm`），以及 `.verify/t32-vm07-drive.mjs` / `.verify/t32-failure-log.mjs`
（第四轮验证用的真输入驱动脚本，不在门禁里）。

## 4. UI 落点：新增一页

**落点结论（唯一）：新增第九个页面「环境自检」，不复用设置页。**

| 项       | 值                                                                                        |
| -------- | ----------------------------------------------------------------------------------------- |
| `TabId`  | `'env'`（加进 `lib/store.ts` 的联合类型）                                                 |
| 左栏位置 | 第 8 项：… `archive`（6）→ `plugin`（7）→ **`env`（8）** → `settings`（9）                |
| 快捷键   | `Ctrl+8` / `⌘8`；**「设置」从 8 变成 9**（用户可见的变化，写进 changeset）                |
| 页面容器 | `index.html` 里 `<section class="pane" id="pane-env"><div id="env-root"></div></section>` |
| 组件     | `src/renderer/pages/env/EnvPane.vue`，在 `mount.ts` 的清单里加 `['env-root', EnvPane]`    |

> **t45 改判（用户裁定，摆法示例 `docs/rail-simplify-choices.html`）：上面这张表是当时的落点，现在被推翻一条。**
>
> 左栏九项里「环境自检」多数时候只看一眼结论，所以：**左栏不再有「环境自检」这一项**（`env` 从
> `TabId` 里去掉，`Ctrl/⌘+8` 不再存在），改成 **设置页里一张「运行环境」卡**：平时只显示一行结论
> （几项正常 / 需要注意 / 不可用 + 要求的那句 Node 区间），点「查看详情」打开**整屏详情视图** ——
> 内容就是原来那一页（灯 / 结论 / 依据 / 一键修复 / 重新打开环境向导 / 安装下载来源 / 重新检测），
> 左上角多一个「← 设置」。`envFocus` 锚点机制不变：两个入口（控制台横幅、插件页的「一键装 pnpm」）
> 改成"打开详情视图 + 滚到那一行"。
>
> 同一次改动里「dsh 终端」与「本地 Shell」也合成了一个 **「终端」页**（一条统一会话条：第一项固定是
> `dsh 终端`，后面是各本地 Shell，`＋ 新建本地 Shell` 在最右），所以左栏 **9 → 7** 项、
> 快捷键 `1~9` → **`1~7`**（状态栏提示、设置页里那句「快捷键 9」、终端里放行 `Ctrl+数字` 的正则
> 一起改）。页面清单与挂载点的权威说法见 `AGENTS.md` §7.30。
> | 图标 | 复用 `#i-warn`（已有）即可；不新画图标，避免为一次改动增加精灵维护面 |
> | 样式 | `.env` 系列；`#env-root` 必须在 `styles.css` 里声明 `display: contents`（自检会红） |

### 4.1 为什么不是「在设置页加一张卡片」

- **内容体量**：八项 × （标题 + 判定说明 + 解决方案/按钮）+ 顶部统计 + 一个流式输出区（还要能中断）。设置页现在已经有八张卡片，塞进去会让它长一倍。
- **7.14 的坑正撞在这里**：设置页那张网格有 `grid-auto-rows: max-content` 的既有约定，再加一块「内部会滚动、会实时追加文本」的输出区，很容易落进「`scrollHeight == clientHeight`、连滚动条都不出现」那一类事故里。这个容器的滚动由谁负责，不该为了省一次页面注册去赌。
- **语义不同**：设置页的定位是「改配置」（点保存 → 写盘 → 有的要重启），这一页是「看现状 + 跑一次动作」，没有一个设置项被它写。把只读诊断和可写配置混在一页，用户每点一次按钮都要先判断「这个要不要保存」。
- **先例**：插件页（装配层）就是「一类诊断单独一页」，而且它最需要的时刻恰是 dsh 起不来的时刻。自检页同理——用户最需要它的时候，别让他去设置页里翻。
- **多一个入口的成本很低**：外壳已经支持九页（`TAB_ORDER`、挂载清单、`PAGE_TITLES`、`*.pane` 各加一行），自检里已有的三条断言（每个组件都在挂载清单里 / 每个挂载点都是 `display: contents` / 简短键 `TAB_ORDER` 与左栏顺序一致）会自动守住这次的接线。

### 4.2 触发时机

| 时机                                                         | 做什么                                                | 为什么                                                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 应用启动后 1.5 秒（后台）                                    | 主进程跑一轮并把报告缓存住                            | 不 `await`、不阻塞启动；1.5 秒是为了避开启动那几秒的端口探测与健康轮询                            |
| 自检页**挂载**时（页面常驻挂载，所以这发生在应用启动那一刻） | 渲染层 `envCheck()`：有缓存立刻给，没有就现跑一轮     | 控制台横幅与插件页的「没找到 pnpm」读的是同一份报告；等「首次进入这一页」才拉会与它们抢第一次数据 |
| 点「重新检测」                                               | `envCheck({ refresh: true })`：清掉本模块的缓存后重跑 | 用户在机器上装了东西，要能立刻看到结果                                                            |
| 一键修复完成后                                               | 主进程自动复检一次（内含 refresh）                    | 用户跑这个动作就是为了看到「变绿」，不该再让他点一次                                              |
| 改 `dshCommand` / `cwd` / `shell`                            | 主进程让本模块缓存失效；**不主动重跑**                | 用户此刻在设置页，切到自检页时自然会拿到新的结论                                                  |
| 窗口重载（`Ctrl+R`）                                         | 渲染层重新 `envCheck()` → 命中主进程缓存              | 重载界面不该重跑一堆子进程                                                                        |

**不放进 `AppSnapshot`**：快照是同步返回的，而探测要起子进程，塞进去会把 `app:snapshot` 拖成秒级。所以报告是**「拉」的**：契约里只有 `envCheck()`（拉一份，有缓存立刻给）与 `onEnvFixState` / `onEnvFixOutput` 两条订阅，**没有 `onEnvReport` 这条事件** —— 修复完成后的复检结果随 `EnvFixState.report` 一起回来，不需要再加一条广播通道。

**开发态也跑**（与自动检查更新不同，那个开发态没有更新源）：这一页在开发态最有用——「我这台机器上的 node / pnpm / dsh 到底怎么样」是每天都在问的问题。

### 4.3 三种状态怎么呈现

| 状态      | 语义色    | 左侧       | 右侧                    | 例子                                                   |
| --------- | --------- | ---------- | ----------------------- | ------------------------------------------------------ |
| `ok`      | 中性/成功 | 实心状态点 | 无按钮                  | 外部 Node：`C:\nvm\v24.19.0\node.exe`，v24.19.0 ≥ 要求 |
| `warn`    | 警示黄    | 空心状态点 | 有 `fixAction` 才给按钮 | dsh：走的是 `npx -y`，每次启动都要联网解析             |
| `missing` | 危险红    | 实心状态点 | 有 `fixAction` 才给按钮 | pnpm：没找到 —— 插件页的装/卸/升级都用不了             |

- 状态点复用外壳已有的 `.lamp` 语义（`data-status` 属性 + CSS 变量），**不要在组件里写死颜色**（自检「样式：样式表除变量块外没有硬编码颜色」管着这件事）。
- 一行的排版：`标题` + `detail`（一句话，含路径与版本）+ 第三行小字 `fixHint`（等宽字体 + 「复制」按钮，直接 `navigator.clipboard.writeText`）。**detail 不做富文本**：它是一句人话，路径不单独抽出来高亮——那会让主进程不得不传结构化字段，而这一页不需要。
- 顶部工具条（`.bar`，与插件页/归档页同款）：左边「重新检测」（busy 时 `disabled` + `aria-busy`）、右边统计「`6` 项正常 · `1` 项不正常 · `1` 项需要注意」+「上次检查：x 分钟前」（时长复用 `lib/format.ts`）。
- 页面内边距**由这一页自己给**（`.env` 根容器 `4px 20px 20px` 一类，与 `.settings` / `.archive-body` 对齐）——`.pane` 自己没有任何 padding（7.14）。
- 空/半途状态：`report.error` 非空时顶部给一条黄条说明「这一轮没测全」+ 原因，**下面的行照常显示**（不要变成一张空白页——那是插件页救援条的同一条原则）。

### 4.4 交互细节：确认、流式输出、中断、失败

一键修复的交互**就在页内**，不开新窗口：

```
[一行：pnpm 不正常]  …  [一键安装 pnpm]
        ↓ 点按钮（还没跑，先展开确认）
┌ 将要执行 ──────────────────────────────────┐
│ <npmPath> i -g pnpm                        │   ← plan.display，等宽
│ 会装进：C:\Users\me\AppData\Roaming\npm    │   ← plan.target
│ 这会修改你系统上的全局 npm 包，需要联网。   │   ← plan.note
│                            [开始] [取消]   │
└────────────────────────────────────────────┘
        ↓ 点「开始」
┌ 正在安装 pnpm ────────────  [中断]  ────────┐
│ (流式输出，<pre>，尾部 64 KB)               │
└────────────────────────────────────────────┘
        ↓ 跑完（主进程已自动复检）
✔ pnpm 现在可用了 —— 那一行已经变成「正常」
```

几条细节：

- **确认区为什么不是原生弹窗**：7.19 已经定过一次调子——`dialog.showMessageBox` 的长相改不了，是全应用唯一一个不像这个应用的面孔。而这里要显示的内容（命令原文、目标目录、随后立刻要看的输出）本来就属于这一页，页内确认更省事也更清楚。**也不新做一个 Teleport 卡片**：那张卡片的用处是「拿底栏一句话把用户带过来」（7.19 的蒙层流程），这里是用户自己点的按钮。
- **输出区与插件页同款**：`<pre>` + 等宽字体 + 铺满宽度 + 只保留尾部（`FIX_TAIL_CHARS`），由 `onEnvFixOutput` 推 chunk。
- **中断**：运行中右上角是「中断」；跑完变成「收起」。
- **收尾三句话（`EnvFixState.phase` → 文案）**：`done` → 成功色一行 + 「复检结果：pnpm 已可用」或「复检仍不正常，点上面的『重新检测』或重开应用再试」；`cancelled` → 中性灰「已中断（npm 可能已经写了一部分）」；`error` → 危险色 + `message`。
- **失败不编原因**：认得出就给归纳过的一句，认不出就把 npm 原文的尾部留在输出区，`message` 只说「退出码 N，认不出具体原因」。
- **控制台页的入口**：`counts.missing > 0` 时在控制台页顶部显示一条横幅（图标 + 「有 N 项环境问题，可能影响 dsh 启动」+「去自检」按钮）；全 `ok` 时不显示。**不做成弹窗、不做成可关闭的**（它是唯一入口，关了用户就找不回来了）。
- **插件页的入口**：`pluginInspect` 的 `pnpm.found === false` 时，那条已经存在的「没找到 pnpm」标签**旁边**加一个「一键安装 pnpm」按钮。点击后：`currentTab = 'env'` → 用一个新的锚点信号（`lib/env-anchor.ts`，**递增请求号**，与 `lib/update-anchor.ts` 同款，不要用布尔量——第二次点击没有变化，watch 不触发，看起来就像「点了没反应」）让自检页滚到 `pnpm` 那一行并展开确认区。这里**不做蒙层**：蒙层是给「底栏一句话把人带过去」用的强引导，而用户此刻正在看那张卡片。
- **装完要刷新插件页**：从插件页出发的这次修复完成后，渲染层重新 `pluginInspect()` 一次（`findPnpm()` 不缓存，所以能立刻认出来）；插件页那行 `pnpm.found` 随之变真。

## 5. 契约（可直接粘贴进 `src/shared/ipc.ts`）

`src/shared/ipc.ts` 是跨进程形状的单一来源，只放类型与纯常量、禁止 import 任何运行时依赖。下面这段**整块**贴进该文件（建议放在插件那一段之后、`DshConsoleApi` 之前）：

```ts
// ---------------------------------------------------------------- 运行环境自检

/**
 * 单项自检的结论。
 *
 * - `ok`：满足，不需要用户做任何事；
 * - `warn`：能用，但有隐患或者这一轮没法确定（例如运行环境不允许起子进程）；
 * - `missing`：不满足，且某项功能因此不可用（没 pnpm → 插件装卸用不了）。
 *
 * 红黄两色由界面按这个字段决定，**不要**让界面去解析 detail 那串人话。
 */
export type EnvCheckStatus = 'ok' | 'warn' | 'missing';

/**
 * 自检项 id。这个联合类型同时也是**界面顺序**：判定函数按它产出 checks，
 * 界面按数组顺序渲染。渲染层的标题映射写成 `Record<EnvCheckId, string>`，
 * 于是漏一个 id 就是 tsc 报错，不会出现"多了一项没人认识"。
 *
 * - `node`            外部 Node 可执行文件找不找得到
 * - `node-version`    它的版本满不满足我们声明的下限（`^20.19.0 || >=22.12.0`）
 * - `npm`             npm 能不能用（下面两个一键修复都要它）
 * - `pnpm`            pnpm 能不能用（插件装/卸/升级要它）
 * - `dsh`             dsh 本体（自定义命令 / node+bin.js / shim / npx）能不能定位
 * - `dsh-run`         实测 `dsh --version` 有没有输出（版本不兼容时它是静默退出）
 * - `bundled-runtime` 应用自带的 Electron / Node
 * - `shell`           本地 Shell 可执行文件
 */
export type EnvCheckId =
  'node' | 'node-version' | 'npm' | 'pnpm' | 'dsh' | 'dsh-run' | 'bundled-runtime' | 'shell';

/**
 * 一键修复能做的事。**只有这两个**，而且都只改全局 npm 包：
 * - `install-pnpm`：`npm i -g pnpm`（插件页缺 pnpm 时也走这一条）
 * - `install-dsh`：`npm i -g @deepseek-ai/dsh`
 *
 * 装 Node、改 PATH、写 .npmrc、提权都不做（见 docs/env-doctor.md）。
 */
export type EnvFixAction = 'install-pnpm' | 'install-dsh';

/** 一项自检的结论（界面一行） */
export interface EnvCheck {
  id: EnvCheckId;
  status: EnvCheckStatus;
  /** 判定依据的一句人话，带事实（路径 / 版本 / 阈值 / 为什么），界面直接显示 */
  detail: string;
  /** 用户能自己执行的命令或步骤；没有可执行建议时为 null */
  fixHint: string | null;
  /** 能替用户做的一键修复动作；null = 只能照 fixHint 自己来 */
  fixAction: EnvFixAction | null;
}

/**
 * 一键修复的**计划**：命令原文 + 会改到哪里。
 * 界面拿它做确认区的文案（不自己拼命令——渲染层不编命令，见 AGENTS 7.18 同款原则）。
 *
 * `file` / `args` 是**给人看的**：`envFix` 只接受 action，真正 spawn 的 argv
 * 由主进程用 `envFixPlan()` 现场重算，绝不使用渲染层递回来的这两个字段。
 */
export interface EnvFixPlan {
  action: EnvFixAction;
  /** 命令原文，例如 `C:\Program Files\nodejs\npm.cmd i -g pnpm` */
  display: string;
  file: string;
  args: string[];
  /** 会装进哪个全局目录（`npm prefix -g` 的结果）；取不到时为 null */
  target: string | null;
  /** 确认区里那句风险说明（会修改系统上的全局 npm 包、需要联网） */
  note: string;
}

/** 一轮自检的报告（`envCheck` 的返回值、`EnvFixState.report`、修复后的复检结果共用） */
export interface EnvDoctorReport {
  /** 检查时刻（毫秒）：界面显示"上次检查 x 分钟前"，判定函数不自己看时钟 */
  checkedAt: number;
  /** 固定八项，数组顺序就是界面顺序 */
  checks: EnvCheck[];
  /** 三种状态的个数（界面顶部的统计直接用它，不再数一遍） */
  counts: { ok: number; warn: number; missing: number };
  /** 最值得先处理的那一项：missing 优先于 warn，同级按 checks 顺序；全 ok 时为 null */
  firstProblemId: EnvCheckId | null;
  /** 这次探测用的版本区间原文（写清"要求是怎么来的"） */
  nodeRange: string;
  /** 一键修复可用的动作；npm 找不到时为空数组（起不了子进程就别给按钮） */
  plans: EnvFixPlan[];
  /** 探测本身出了意外（不是"某项不满足"，而是这一轮没测全）时的原因 */
  error: string | null;
}

/** 一键修复的相位。一次只跑一个动作，与插件操作同构（可中断）。 */
export type EnvFixPhase = 'idle' | 'running' | 'done' | 'cancelled' | 'error';

/** 一键修复的当前状态（envFix 的返回值、env:fix-state 事件共用） */
export interface EnvFixState {
  phase: EnvFixPhase;
  /** 正在跑的（或刚跑完的）动作；idle 时为 null */
  action: EnvFixAction | null;
  /** 将要执行 / 已执行的命令原文（确认前就显示它） */
  command: string | null;
  /** 收尾的一句人话（成功 / 被中断 / 失败原因） */
  message: string | null;
  /** 退出码；没跑起来时为 null */
  code: number | null;
  /** 跑完自动复检的结论；还没复检时为 null */
  report: EnvDoctorReport | null;
}

/** 一键修复边跑边推的输出片段（界面原样贴进输出区，与 plugin:output 同一套做法） */
export interface EnvFixOutputEvent {
  chunk: string;
}
```

再把这五个成员加进 `DshConsoleApi`（放在插件那一段之后；下面只列新增的部分，既有成员照旧）：

```ts
export interface DshConsoleApi {
  // …既有成员不动，这里只写新增的五个…

  // 运行环境自检 + 一键修复（见 docs/env-doctor.md）
  /** 拉一份自检报告；refresh = true 时清掉缓存重跑一轮 */
  envCheck: (options?: { refresh?: boolean }) => Promise<EnvDoctorReport>;
  /** 跑一个一键修复动作：只递 action，命令由主进程自己构造 */
  envFix: (request: { action: EnvFixAction }) => Promise<EnvFixState>;
  /** 中断正在跑的修复（没有在跑的返回 false） */
  envFixCancel: () => Promise<boolean>;
  onEnvFixState: (handler: (state: EnvFixState) => void) => () => void;
  onEnvFixOutput: (handler: (payload: EnvFixOutputEvent) => void) => () => void;
}
```

### 5.1 设置项：**不需要新增**

结论：**这一版不加任何设置项**，所以 `SettingsValues` 与 `main/settings.ts` 的 `DEFAULTS` 都不用动。

理由：

- 自检是**只读探测 + 用户点了才跑的修复**。启动后那次探测是后台的，代价是两三个子进程（各 8 秒超时、正常几百毫秒），不阻塞启动、不碰 dsh 进程，不需要一个开关来关掉它。
- 修复动作永远要用户点确认，所以也不需要 `envAutoFix` 这种开关。
- 加开关的成本在 AGENTS 7.14 里写得很清楚：契约与 `DEFAULTS` 两处、改完还要**重启应用**，而且窗口热重载时正好落进「半新半旧」的状态。为了省几个后台子进程而多一处会漂移的契约不划算。

**如果将来真要加**（例如 `envCheckOnStart: boolean`）：必须**同时**改 `src/shared/ipc.ts` 的 `SettingsValues` 与 `src/main/settings.ts` 的 `DEFAULTS`（两边不一致时 `tsc` 直接报错），并在设置页给出控件；改完要**重启应用**才好验证。

### 5.2 不放进契约的东西

- `EnvProbeRaw` / `VersionProbe` / `DshProbe`（判定的入参，见 2.1）：留在 `src/main/env-doctor.ts`。
- 采集与运行的实现（`collectEnvProbe` / `EnvFixRunner`）：同上。
- 中间态的缓存：不需要额外的东西——主进程里那份 `EnvDoctorReport` 本身就是缓存。

## 6. 建议的自检断言清单（给 `test/selftest.ts`）

放在 selftest 的最后一节，命名沿用「模块：判据」的风格。**全部都是纯函数或静态文本检查**，不装 pnpm、不起 Electron、不联网。

**判定纯函数（进 CI 的核心）**

1. `环境自检：judgeEnvironment 是纯函数（函数体里没有 fs / 子进程 / process.*）` —— 用正则切出 `export function judgeEnvironment` 到下一个 `export` 之间的文本，断言不含 `fs.`、`spawn(`、`execFile`、`execSync`、`process.env`、`process.platform`、`process.versions`。
2. `环境自检：版本区间只认这一句（20.19 / 22.12 的边界都对）` —— 五个边界值逐个断言（见 1.2）。
3. `环境自检：阈值与 vite 的 engines 同一句` —— 读 `node_modules/vite/package.json` 的 `engines.node` 与 `NODE_RANGE` 比。
4. `环境自检：八项都在，id 不重复，顺序固定` —— 对最小夹具断言 `checks.length === 8`、id 集合与 `EnvCheckId` 的八个成员一一对应、顺序即数组顺序。
5. `环境自检：不满足必有出路（每项非 ok 都有 fixHint）` —— 对每一份「有毛病」的夹具，断言 `status !== 'ok'` 的行 `fixHint` 是非空字符串；`detail` 全部非空。
6. `环境自检：找不到 dsh 与跑不动 dsh 分开判` —— `kind: null` → `dsh: missing`；`kind: 'node-bin'` + `runs: false`（退出码 0、零输出）→ `dsh: ok` 且 `dsh-run: missing`。
7. `环境自检：npx 只给黄灯（能用但每次都要联网解析）` —— `kind: 'npx'` → `dsh: warn` 且 `fixHint` 非空。
8. `环境自检：pnpm 缺失时给出 install-pnpm；npm 也缺失时不给按钮` —— 前者 `fixAction === 'install-pnpm'`，后者 `null`（起不了子进程就别给）。
9. `环境自检：起不了子进程（EPERM）是黄灯，不当成没装` —— `error` 含 `EPERM` → `warn`。
10. `环境自检：内嵌 Node 用同一句区间判；开发态说明不同` —— `bundled.node = '20.9.0'` + `packaged: true` → `missing`；`packaged: false` → `ok`。
11. `环境自检：counts 与 firstProblemId 的算法` —— 全 ok → `null`；有 missing 时 `firstProblemId` 是第一个 missing，没有 missing 时是第一个 warn。
12. `环境自检：Windows 上的启动 spec 真的起得来（.cmd → cmd.exe + verbatim，PE 直连）` —— 断言 spec 的形状（`/d` / `/s` / `/c` + **单个**已加外层引号的命令行 + `windowsVerbatimArguments: true`）**并且真的 spawn 一次**（跑 `cmd.exe /c echo` 这类无副作用的东西）确认它起得来；`.exe` 直连、POSIX 原样透传。
13. `环境自检：解析出的 npm / pnpm / node 一定是能执行的那个（不许拿 POSIX sh shim 充数）` —— 用临时目录造一个带 `#!` 的 `npm` 与一个真的 `npm.cmd`，断言解析结果是后者；`isRunnablePath()` 对 `.cmd` / `.exe` / 无扩展名的判定。
14. `环境自检：PATHEXT 优先于裸名，首行 `#!` 的无扩展名 shim 不算可执行文件` —— 这条钉的是 `whichSync()` 在 Windows 上的新规则（`process-utils.ts`），也是 F1 的回归护栏。
15. `环境自检：探测与修复走同一个包装器（不是直 spawn .cmd / 无扩展名路径，且都带 verbatim）` —— 静态检查执行侧、探测侧、`readNpmPrefix` 三个 spawn 点都用了 `launchSpec()` / `dshLaunchSpec()` 的产物。
16. `环境自检：超时是独立终态（有自己那句话，且判在「退出码 != 0」之前）` —— 断言 `fixTimeoutMessage()` 的文案结构，并静态检查超时分支在通用失败分支**之前**。
17. `环境自检：单动作互斥是同步置位（在第一个 await 之前，终态释放）` —— 静态检查互斥位的读写位置。
18. `环境自检：修复计划只认 npm 存在时的两个动作` —— `envFixPlan('install-pnpm', null) === null`；`envFixPlan('install-dsh', '/usr/bin/npm')?.args` 深等于 `['i','-g','@deepseek-ai/dsh']`。
19. `环境自检：失败归纳只认认得出的三类，认不出来返回 null（不编原因）` —— 权限 / 网络 / 404 各一条夹具 + 一句无关输出。
20. `环境自检：契约里有 8 个 id、2 个动作、5 个 API` —— 读 `src/shared/ipc.ts`，断言 `EnvCheckId` 的八个成员、`EnvFixAction` 的两个成员、`envCheck` / `envFix` / `envFixCancel` / `onEnvFixState` / `onEnvFixOutput` 都在（写法照抄「自动更新：契约里有 7 个相位…」那条：压平空白再正则）。
21. `环境自检：没有新增设置项（DEFAULTS 里没有 env* 键）` —— `Object.keys(DEFAULTS).every((key) => !key.startsWith('env'))`。这条是 5.1 那个决定的护栏：将来真要加开关，就把这条换成「契约与 DEFAULTS 两处一致」。
22. `环境自检：子进程不拼 shell、补过 PATH、输出双向都收、cwd 固定` —— 对 `env-doctor.ts` 做静态检查：`spawn(file, args`、`envWithKnownBins(process.env)`、`pluginRegistryEnv(`、`stdio: ['ignore', 'pipe', 'pipe']`、`cwd: homeDir()`、没有 `shell: true`。
23. `环境自检：渲染层只递 action（执行的是主进程自己算的 argv）` —— 静态检查 `main.ts` 的 `env:fix` 处理器里只用 `action` 去调 runner、`env-doctor.ts` 里 `spawn` 的第一个参数来自 `plan.file` 而不是请求对象。
24. `环境自检：env-doctor 不 import electron` —— 静态检查（这样自检 import 它是安全的，运行时要的事实靠注入）。

> 收口时实测：`test/selftest.ts` 里「环境自检」这一组共 **27 条**断言，自检总数 **180 项**（`node test/selftest.js` → `180/180 项通过`，其中 4 条 SKIP 是沙箱限制）。上面 1~24 是设计意图与实现断言的一一对应；条数以后者为准。

**接线（复用已有的那些断言，别重复造）**

25. `渲染层：每个 .vue 组件都在挂载清单里`、`渲染层：每个挂载点都是 display: contents`、`快捷键：TAB_ORDER 与左栏顺序一致` —— 这三条已经存在，把 `EnvPane.vue` / `env-root` / `env` 接进去就自动被守住（它们也是这次「多一个页面」必须过的关）。
26. `环境自检：渲染层的标题映射覆盖全部八个 id` —— 静态检查 `EnvPane.vue` 里八个 id 都出现在那张 `Record<EnvCheckId, string>` 标题映射表里；类型本身由 `vue-tsc` 保证，这条是给「映射表写成 `Record<string, string>` 就漏了」这种情况兜底。
27. `环境自检：一键修复只在有 fixAction 时给按钮，且必须经过一次页内确认` —— 静态检查模板里按钮受 `fixActionOf` 门控、`api.envFix` 的唯一调用点在确认之后的 `startFix` 里（不是渲染时直接调用）。

**不给自检的（归冒烟与 review）**：具体中文措辞、状态点的颜色、输出区的高度、「上次检查 3 分钟前」这类文案——按 AGENTS 第 8 节那张表的规矩，「回退了看得出来」的不进自检。

## 7. 需要同步的文件清单

| 文件                                             | 改什么                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/env-doctor.md`                             | 本文件（新增）                                                                                                                                                                                                                                                                                                                                                                  |
| `src/shared/ipc.ts`                              | 第 5 节那两段：类型 + `DshConsoleApi` 的五个成员（只加类型与联合类型，不引运行时依赖）                                                                                                                                                                                                                                                                                          |
| `src/main/env-doctor.ts`                         | 新增：`collectEnvProbe`（采集）+ `judgeEnvironment`（纯判定）+ `envFixPlan` / `npmLaunchSpec`（别名）/ `fixTimeoutMessage` / `summarizeEnvFixFailure`（纯函数）+ `EnvDoctor`（缓存与复检）+ `EnvFixRunner`（子进程、流式、可中断、同步互斥位、超时独立终态）                                                                                                                    |
| `src/main/process-utils.ts`                      | ① `whichSync()` 在 Windows 上只按 `PATHEXT` 找带扩展名的、并不再返回无扩展名的同名文件（Node 目录里的 `npm` 是 POSIX sh 脚本，拿来当可执行文件会让自检误报、一键安装也起不来）；② **收下 `LaunchSpec` / `isRunnablePath` / `launchSpec` / `dshLaunchSpec` 这几个公共件**（与 `COMSPEC` / `quoteForCmd` / `dshArgsFor` 同处），一键装包、插件的三个启动点与 `dsh web` 都从这里取 |
| `src/main/main.ts`                               | 注册 `env:check` / `env:fix` / `env:fix-cancel` 三个 handler；把 `env:fix-state` / `env:fix-output` 推给渲染层；启动后 1.5 秒后台跑一轮，并按轮次在事件日志里写一行；设置变化时让缓存失效                                                                                                                                                                                       |
| `src/preload/preload.ts`                         | 暴露五个成员（`invoke` ×3 + `subscribe` ×2，与 `pluginRun` / `onPluginOutput` 同款）                                                                                                                                                                                                                                                                                            |
| `src/renderer/pages/env/EnvPane.vue`             | 新增页面（`CHECK_TITLES: Record<EnvCheckId, string>`、统计条、八行、确认区、输出区、中断）                                                                                                                                                                                                                                                                                      |
| `src/renderer/lib/env-doctor.ts`                 | 新增：报告与修复状态的唯一镜像（`envCheck()` 拉取 + `onEnvFixState` / `onEnvFixOutput` 订阅；**没有 `onEnvReport`**），`runEnvFix` 是渲染层调用 `api.envFix` 的唯一一处                                                                                                                                                                                                         |
| `src/renderer/lib/store.ts`                      | `TabId` 加 `'env'`（报告本身不放快照里）                                                                                                                                                                                                                                                                                                                                        |
| `src/renderer/mount.ts`                          | 挂载清单加 `['env-root', EnvPane]`（否则自检直接红）                                                                                                                                                                                                                                                                                                                            |
| `src/renderer/index.html`                        | `pane-env` 容器 + `env-root` 挂载点                                                                                                                                                                                                                                                                                                                                             |
| `src/renderer/styles.css`                        | `#env-root { display: contents }` + `.env` 系列样式（状态点用变量，不写死颜色）                                                                                                                                                                                                                                                                                                 |
| `src/renderer/shell/RailNav.vue`                 | `TABS` 加 `{ id: 'env', icon: 'i-warn', label: '环境自检' }`，插在 `plugin` 与 `settings` 之间                                                                                                                                                                                                                                                                                  |
| `src/renderer/shell/TopBar.vue`                  | `PAGE_TITLES` 加 `env: '环境自检'`                                                                                                                                                                                                                                                                                                                                              |
| `src/renderer/app.ts`                            | `TAB_ORDER` 加 `'env'`、快捷键正则 `/^[1-8]$/` → `/^[1-9]$/`、文件头注释里的 `Ctrl+1~8` 一并改                                                                                                                                                                                                                                                                                  |
| `src/renderer/shell/StatusBar.vue`               | `shortcutLabel('1~8')` → `'1~9'`（不改就会和实际页面数对不上——历史上正好被用户抓到过一次）                                                                                                                                                                                                                                                                                      |
| `src/renderer/lib/env-anchor.ts`                 | 新增：递增请求号的锚点信号（照抄 `lib/update-anchor.ts` 的做法，别用布尔量）                                                                                                                                                                                                                                                                                                    |
| `src/renderer/pages/dashboard/DashboardPane.vue` | `counts.missing > 0` 时顶部横幅 + 「去自检」                                                                                                                                                                                                                                                                                                                                    |
| `src/renderer/pages/plugin/PluginPane.vue`       | 「没找到 pnpm」标签旁加「一键安装 pnpm」（切到自检页 + 锚点）；装完重新 `pluginInspect()`                                                                                                                                                                                                                                                                                       |
| `test/selftest.ts`                               | 第 6 节那份清单（收口时实测 **180 项**）；文件头那段「覆盖：1~8」的清单加一条「运行环境自检」                                                                                                                                                                                                                                                                                   |
| `scripts/selftest-sandbox.mjs`                   | 新增：受限环境里的自检门禁（编译 + 自检 + 清理，产物清单走 `.verify/selftest-sandbox/`），与 `build:sandbox` 同构；AGENTS 第 2 / 5 / 8 节已登记                                                                                                                                                                                                                                 |
| `scripts/env-doctor-cases.mjs`                   | 新增：环境自检的独立反例脚本（**19 条**纯函数夹具），按 `-cases.mjs` 约定放在 `scripts/` 下即被门禁自动收录                                                                                                                                                                                                                                                                     |
| `.changeset/<随机的名字>.md`                     | 新增片段：`'dsh-console': minor`。正文写清：新增「环境自检」页（左栏第 8 项，`Ctrl+8` / `⌘8`；**设置页的快捷键从 8 变成 9**、底栏提示 `1~8` → `1~9`）、能一键装 pnpm / dsh、缺 pnpm 时插件页也知道怎么装，另起一节写 Windows 上把 `npm` / `pnpm` 认成 POSIX sh 脚本的修复                                                                                                       |
| `AGENTS.md`                                      | 第 2 节目录结构加 `main/env-doctor.ts`、`lib/env-doctor.ts`、`pages/env/EnvPane.vue`、两个 `scripts/*.mjs`（并改「八个页面」的说法）、**三处自检项数改成收口时的实测值（176）**、第 5 节受限环境入口、第 7 节新增一条 `7.20 运行环境自检：探测是只读的，修复只有两个动作`                                                                                                       |
| `README.md`                                      | 第 28 行「八个页面 / `Ctrl+1` 到 `Ctrl+8`」改成九个 / `Ctrl+1` 到 `Ctrl+9`（macOS 那几个 `⌘` 同样）；「它能做什么」加一节「环境自检」；「使用前提」那节补一句「缺什么可以在应用里一键补齐（pnpm / dsh），Node 需要自己装」                                                                                                                                                      |

**不改**：`package.json`（不加依赖、不加设置项）、`src/main/plugin-manager.ts`（插件那条路一行不动，插件页只是多一个按钮去调 `envFix`）。`process-utils.ts` 只改了 `whichSync()` 在 Windows 上的解析规则（见上），命令解析的优先级与缓存语义一个字没动。

## 8. 与 `AGENTS.md` 第 2 / 4 / 7 节的关系

- **第 2 节（架构硬约定）**：契约只加在 `shared/ipc.ts`，且只有类型（不引运行时依赖，渲染层不会把 `fs` 拖进包）；判定与采集都在 `main/env-doctor.ts`，由 tsc 直出 CJS，产物路径一一对应，打包配置不用改；渲染层不出新产物形态（不新增动态 `import()`）；新页面照 7.8 的三条接线：挂载清单、`display: contents` 挂载点、样式。
- **第 4 节（代码约定）**：`strict` 下不加 `any`、不用非空断言；`EnvProbeRaw` 这类 JSON 边界用最小 `interface`；Prettier 说了算（单引号、分号、尾随逗号、LF）；ESLint 只管正确性，不为格式加规则。
- **第 7 节（踩过的坑）**：7.4（实测而非看退出码、不信 PATH、静默退出的特征）→ 第 1、6 项；7.8（数据晚到要重试、每个组件都在挂载清单）→ 4.2 与接线清单；7.13（静态检查先剥注释、class 要有样式）→ 新增断言照这个规矩写；7.14（`min-height: 0` 吃溢出、页面自己给内边距、加设置项要重启应用）→ 4.1 与 5.1；7.18（子进程 PATH 补 pnpm、没装 pnpm 提前拦下、spec 是一个 argv、渲染层不解析人话）→ 第 3 节整节；7.19（提示不做成原生弹窗）→ 4.4。
- **没有引入新的外部依赖**，也没有新增设置项，所以第 9 节「不要擅自升级依赖或改构建配置」这条不受影响。

## 9. 明确不做的事

- ~~不做「一键装 Node」（见 1.1）、不做提权、不改 PATH。~~ **这一条已被阶段二取代**：Node 有了一键安装（Windows、两条路、每次确认、提权由安装器自己触发），见 `docs/env-wizard.md`。**仍然不做**的是：我们主动提权（`runas` 一类）、改系统 PATH、以及在没有用户确认的情况下动系统。这一页的两个 npm 动作与探测仍然是只读 + 最小动作。
- 不做定时轮询（自检不是监控：环境不会自己变，bootstrap 后一次 + 用户点一次就够）。
- 不做自动修复（任何动作都要用户点确认）。
- 不把自检结论写进事件日志刷屏（只在修复动作与设置变化时记两行）。
- 不接管 `/api/`、不读 DSH 的配置文件、不碰 `$DSH_HOME`（那是归档页与插件页的事）。
- 不在诊断里输出任何凭据：探测只跑 `--version`，不读令牌、不打印环境变量的值（路径可以打，值不行）。
