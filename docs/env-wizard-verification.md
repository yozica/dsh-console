# 收口记录（第九轮 / t7 —— 最新）

| 项       | 值                                                                                                                                                                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 执行者   | product（t7 集成收口：changeset / AGENTS / README / docs 同步 + 最终树上现测四道门禁）                                                                                                                                                                                                         |
| 被验产物 | **只改文档的那一轮**：`.changeset/env-wizard-gate.md`（措辞同步）、`.changeset/env-wizard-node-owner-channel.md`（新增）、`AGENTS.md` 7.21、`README.md`、`docs/env-wizard.md` / `env-wizard-interaction.md` / `env-wizard-freeze.md`；`src/`、`test/`、`scripts/` **一个字节没动**             |
| 时间     | 2026-09-19（本轮现测）                                                                                                                                                                                                                                                                         |
| 结论     | 收口完成；四道门禁在**最终树**上现测全绿（数字见下）。**这不是一次独立验证** —— 收口者不审自己的实现：本轮的"通过"指的是"第八轮（t12）的结论在本轮树上继续成立 + 文档已与实现对齐"，验证结论仍以第八轮为准                                                                                     |
| 四道门禁 | typecheck（main / renderer / node）**0/0/0** / lint **0** / format:check **0**（`All matched files use Prettier code style!`）/ 沙箱自检 **exit 0**（`265/265` + `20/20` + `185/185`，自动收录 2 个脚本；`清理：清单 40 个路径 → 删掉 40 个`、`清理后仍多出来的文件：0 个`、`自检门禁：通过`） |

复现命令（都在 `dsh-console/` 下）：

```bash
npm run typecheck
npm run lint
npm run format:check
node scripts/selftest-sandbox.mjs
git status --porcelain          # 收口轮：改动应只落在 .changeset / AGENTS.md / README.md / docs/，没有就地 tsc 产物
```

## 1. 这一轮改了什么（逐条对验收）

| 验收项                                                       | 落在哪                                                                                                                                                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 用户可见修复进 changeset                                     | 新增 `.changeset/env-wizard-node-owner-channel.md`（`patch`：用版本管理器装的 Node 不再装第二份；「更新」不会悄悄换档、目标更低时明说）                                                                                              |
| 旧片段里被本轮取代的措辞                                     | `.changeset/env-wizard-gate.md` 的"第一步：装 Node.js"与"更新 Node 与 pnpm"两段就地改掉（"两条路自己挑"、"两条路都默认直装"不再成立）                                                                                                |
| `AGENTS.md` 坑清单（两条 + 船长补的 `switchesChannel` 一条） | `AGENTS.md` 7.21：① 更新路径不许写死方法（VM-14 的历史现场 `EnvPane` 两处 `method: 'direct'`）；② `switchesChannel` 是超集语义、**按构造保证**、别照 `ipc.ts` 的注释改回去；③ 「先停 dsh」必须与引擎动作同位（+ 时序代价与船长裁定） |
| 两条船长裁定落进文档                                         | 冻结 §3.2.1 的 **t7 标注 A/B/C**；需求 §11.2.1 第 4 条（行为式）；需求 §12 第 32 条（静态断言改行为式）；交互 §6.4 与 §10.5 第 5 条（跨档两个来源）                                                                                  |
| 需求 / 交互与实现对齐（五处）                                | 归属→方法（需求 §7.7/§7.8）、档位跟随（§8.5 第 2 条）、**`older ⟹ switchesChannel` 无条件**（§8.5 第 3 条的 t7 更正）、换档语义（§8.5 第 3/4 条 + 交互 §10.5 第 5 条）、档位选择可见（交互 §4.1 4-b / §4.3 第 9 条）                 |
| 过期数字改成现测值                                           | `AGENTS.md` 三处：自检 `252 → 265`（§2 目录结构 / §3 命令一览 / §8 调试手段）、环境向导反例 `168 → 185`；环境自检反例 `20` 不变。README 不含这类数字                                                                                 |
| 被推翻的旧结论**标注而非删除**                               | 需求 §8.5 第 3 条（两处 `~~删除线~~` + ⚠️ 更正）、需求 §11.2.1 第 4 条、需求 §7.9 第 4 条、交互 §6.4 的出路①、"两条路自己挑"那类措辞在 changeset 里直接改写（片段是用户可见文本，不做标注）                                          |

## 2. 本轮现测的数字与原始输出

```text
npm run typecheck        → exit 0（typecheck:main / typecheck:renderer / typecheck:node 三段都过）
npm run lint             → exit 0（eslint . 无输出）
npm run format:check     → exit 0（All matched files use Prettier code style!）
node scripts/selftest-sandbox.mjs
  → 265/265 项通过
  → 环境自检独立反例：20/20 通过（NODE_RANGE=^20.19.0 || >=22.12.0）
  → 环境向导独立反例（安装引擎 + 门禁判定 + 门禁/逃生口）：185/185 通过（失败 0 条）
  → 清理：清单 40 个路径 → 删掉 40 个（另有 0 个本来就不在盘上）；清理后仍多出来的文件：0 个
  → 自检门禁：通过（编译 + 自检 + 清理都干净；额外检查 2 个）
```

**这四道门禁是"最终树"上的值**：收口轮在 `docs/` / `AGENTS.md` / `README.md` / `.changeset/` 落地之后重跑，
跑之前与跑之后 `src/`、`test/`、`scripts/` 都未再被写（`git status` 里这三个目录下的修改仍是实现轮留下的那些文件，
没有新增、也没有就地 `.js` 产物）。
**`docs/` 的改动不会被自检当作"被验产物"** —— 唯一会读文档的自检是「契约（F-03）：`ipc.ts` 与冻结 §3.1~§3.4 的逐字块完全一致」，
所以本轮确实核对过：**冻结 §3.2.1 的 t7 标注写在代码块之外**（逐字块一个字符没改），
需求 §11.2.1 的字段注释也保持与 `ipc.ts` 一致、只在块外加 ⚠️ 说明 —— 那条断言本轮复测为 PASS。

## 3. 本轮**没有**做的事（诚实边界）

1. **没有改任何代码**：`findings` 里提到的"`ipc.ts` 的 `switchesChannel` 注释只写了充分条件"是一条**文档侧记录**（写进 `AGENTS.md` 7.21），
   改那句注释是 `src/` 的改动，不在 t7 范围；同理 `EnvGate.vue` 的选项标签与引擎常量的措辞差异按船长裁定**不改代码**。
2. **没有重跑独立验证**：本轮的绿是"文档轮的门禁 + t12 结论继续成立"，不是一次新的行为验证。真机项（真装一次 Node、看一次 UAC、断一次网、
   界面观感）仍照第八轮的"不可验"清单由人工在真机确认。
3. **没有发布**：片段留在 `.changeset/`，发版仍按 `AGENTS.md` §6 的流程走。

---

# 阶段二独立验证报告（第八轮 / t12）

| 项       | 值                                                                                                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 验证者   | verifier（t12，第八轮：t9 那两条 high 的**再验证** —— F1「更新先停 dsh」/ F2「older ⟹ switchesChannel」）                                                                                          |
| 被验产物 | t9 的修复：`src/main/node-installer.ts`（`stopDshForUpdate()` 提到 `execute()`、`switchesChannel` 改为全分支统一算）与 `test/selftest.ts` 的 2 条新断言；以及整棵树                                |
| 时间     | 2026-09-19 16:39–16:46（**本轮现测，没有继承实现者或上一轮审查的任何输出**）                                                                                                                       |
| 结论     | **verdict = pass**：F1 / F2 **都关闭**，0 条 finding；四道门禁在最终树上全绿                                                                                                                       |
| 四道门禁 | typecheck（main / renderer / node）**0/0/0** / lint **0** / format:check **0** / 沙箱自检 **exit 0**（`265/265` + `20/20` + `185/185`，自动收录 2 个脚本；`清理 40 删 40`、`清理后仍多出来 0 个`） |

复现命令（都在 `dsh-console/` 下）：

```bash
node node_modules/typescript/bin/tsc -p tsconfig.main.json --noEmit
node node_modules/vue-tsc/bin/vue-tsc.js -p tsconfig.renderer.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.node.json
node node_modules/eslint/bin/eslint.js .
node node_modules/prettier/bin/prettier.cjs --check .
node scripts/selftest-sandbox.mjs                 # 第四道门禁
node .verify/t12-stop-dsh.mjs                     # 真跑 run() 数 stopDsh + 648 组合穷举（12 条）
node .verify/t12-mutation.mjs                     # 两条变异：switchesChannel 还原 / 不再停 dsh
node .verify/t4-assert-diff.mjs .verify/t4-final-gate.log .verify/t12-final-gate.log
node .verify/t4-freeze.mjs .verify/t12-freeze-B.txt        # 93 个路径
```

## 1. 结论

| finding（t5/t6 判出的 high）                                                                                   | 本轮现测的关闭证据                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1**：nvm 管的机器上更新没先停 dsh（`installsManager === false` 整段跳过 `installPhase`）                    | §3：**真跑 `run()`** —— nvm v2 管着 `v26.9.0`(current) 的现场形状上，**省略档位**的更新（用户那条路）`stopDsh` **恰好 1 次**；显式选档的更新也是 1 次；官方直装那条路同样 1 次；`install` 两条路 0 次；归属 unknown（不给「开始」）0 次                                                             |
| **F2**：`switchesChannel` 漏了「install 的设计默认档 ≠ 已装档」那一支（上一轮审查在 648 组合里数出 36 个反例） | §4：**穷举 648 组合**，`direction === 'older' ⟹ switchesChannel === true` **反例 0 条**（108 条 `older` 全部 `switchesChannel=true`）；`EnvGate` 第三步「换一个 Node」那条可达输入：`install` + 省略档位 + 已装 current → `channel=lts`、目标 `v24.21.0`、`direction=older`、`switchesChannel=true` |

**本轮 0 条 finding。** 仍只能真机验的部分见 §8（与上一轮同一份清单）。

---

## 2. 树定格与并发归属

- **定格清单**：`.verify/t12-freeze-A.txt`（动手前，92 个路径）、`.verify/t12-freeze-mid.txt`（改完 `scripts/` 之后，93 个路径）、`.verify/t12-freeze-B.txt`（收尾，93 个路径）。
  本次按验收口径把 `CHANGELOG.md` 也纳入扫描，所以是 **93 个路径**（`src` / `test` / `scripts` / `tools` / `docs` / `.changeset` + 12 个顶层文件）。
  逐路径比对：**除 `scripts/env-wizard-cases.mjs` 与 `docs/env-wizard-verification.md` 这两个我改的文件之外，其余 91 个路径在 A→mid→B 三段里逐字节相同**（`CHANGELOG.md` 出现在 mid/B 只是因为它后来才进扫描范围，不是有人改过它）。
- **就地产物**：`src` / `test` / `tools` / `scripts` 下 **0 个 `*.js` / `*.js.map`**（定格脚本顺带扫的）。
- **并发归属**：t9 的最后一版落在 16:37:31（`test/selftest.ts`）与 16:38:13（`src/main/node-installer.ts`）；我 16:39:40 取 A，**之后 src / test 没有再被动过**（A→B 逐路径相同）。
- **契约文件没被碰**：`src/shared/ipc.ts` 在上一轮定格（`.verify/t4-freeze-B.txt`）与本轮定格里的 SHA256 **完全相同**（`12c84e84ebbace9b…`）—— 本轮没有任何人改契约。

---

## 3. F1 关闭：更新先停 dsh（**真跑 `run()`**，数调用次数）

驱动 `.verify/t12-stop-dsh.mjs`（原始输出 `.verify/t12-drive.log`）。注入两条，写在明面上：`hooks.fetchText`（t2 的正式注入口，喂我自己写的清单夹具）+ `child_process.spawn` 边界的**只读探测**注入（沙箱禁止带管道 stdio 的子进程，`node… --version` 恒失败；为了让"省略档位的更新"这条用户路径真的走通，只拦这一种探测按夹具返回，其余原样转发）。

| 用例                                                               | `stopDsh` 调用 | `affectsRunningDsh` | `method` | `installsManager` | 终态                                       |
| ------------------------------------------------------------------ | -------------- | ------------------- | -------- | ----------------- | ------------------------------------------ |
| A1 nvm v2 管着 `v26.9.0`(current) + 更新（**省略档位**，用户现场） | **1**          | true                | nvm      | false             | error（沙箱里起不了 `nvm` 子进程，属预期） |
| A2 同上 + 更新（显式选一档 lts）                                   | **1**          | true                | nvm      | false             | error                                      |
| A3 官方直装（system）+ 更新                                        | **1**          | true                | direct   | true              | error（校验夹具对不上，属预期）            |
| A4 install + nvm 管的机器                                          | 0              | false               | nvm      | false             | error                                      |
| A5 install + 直装                                                  | 0              | false               | direct   | true              | error                                      |
| A6 归属 unknown + 更新（不给「开始」）                             | 0              | —（计划没被发布）   | —        | —                 | error                                      |

补两条对照：**A7** 静态数一遍源码 —— `this.stopDshForUpdate()` **1 处**、`this.hooks.stopDsh()` **1 处**，且那一行排在 `if (!plan.installsManager)` **之前**（两条路都经过它、结构上不可能停两次）；
**A8** A6 为什么"一次都不停"：同一夹具的 `plan()` 给出 `usable=false` + `needChoice=choose-method`（不给「开始」，`execute()` 在停 dsh 那一行之前就收场）。
**变异 T**（把编译副本里那句 `await this.stopDshForUpdate();` 拿掉）→ A1 / A2 / A3 **变红**（`stopDsh=0 ≠ 1`），即这条驱动不是空转。

---

## 4. F2 关闭：`older ⟹ switchesChannel`（穷举 + 可达路径）

驱动同一支脚本的 B 段（纯函数，**零注入**）：

```
B1 穷举 648 组合（mode×owner×nvmPresent×nodeFound×currentVersion×requestChannel×requestMethod
   = 2×3×2×2×3×3×3）：older 108 条、switchesChannel 180 条、**反例 0 条**
B2 可达路径（EnvGate 第三步「换一个 Node」：install + 省略档位 + 已装 current）：
   channel=lts 目标=v24.21.0 direction=older switchesChannel=true
B3 回归：当前档位判不出来（currentVersion=null）→ needChoice=choose-channel、release=null、
   direction=null、switchesChannel=**false**（不把"不知道"说成换档）
B4 回归：显式换档仍可判定 —— current 机器显式要 lts → older + true；显式同档 → same + false
```

"上一轮 648 组合里 36 个反例"这件事，我不是引用审查者的数字，而是**自己把同一张网穷举了一遍**：`older` 的每一行都要求 `switchesChannel === true`，现在 0 条不满足。
**变异 S**（把编译副本里的 `switchesChannel` 还原成旧写法「只有请求显式带档位、且与当前档不同时才算换档」）→ 门禁脚本里我新加的 **O13 / O14 变红**。

---

## 5. 我这一轮补的独立反例（`scripts/env-wizard-cases.mjs` 的 O13–O15，`182 → 185`）

按船长裁决，这条反例由**验证者**写（被验方自己写等于自证）：

- **O13**：穷举 648 组合，`direction === "older" ⟹ switchesChannel === true` **零反例**（这条是无条件断言，不挑输入）；
- **O14**：把**可达路径**单拎出来 —— `EnvGate` 第三步「换一个 Node」（`install` + 省略档位）在装了 current 的机器上 → `channel=lts`、目标 `v24.21.0`、`older`、`switchesChannel=true`；
- **O15**：回归 —— `currentVersion=null` 时 `choose-channel` + `release=null` + `switchesChannel=false`；显式换档仍可判定。

**变异实验**（`.verify/t12-mutation.mjs`，改的是 `.verify/` 下的编译副本）：S → `O13`/`O14` 红；T → `A1`/`A2`/`A3` 红。两条变异都被抓住，退出码都是 1。

---

## 6. 断言完整性（本轮 0 丢失 / 0 状态变化；上一轮那条改名已核实是**加强**）

`.verify/t4-assert-diff.mjs`（按 BOM 解码 PowerShell 的 UTF-16LE 日志）：

| 对比                                                   | 上一轮 | 这一轮 | 丢失（含"只改了名字"） | 同名状态变化 | 新增  |
| ------------------------------------------------------ | ------ | ------ | ---------------------- | ------------ | ----- |
| 第七轮门禁（`.verify/t4-final-gate.log`）vs 本轮最终树 | 469    | 474    | **1（只改了名字）**    | **0**        | **6** |
| t9 交付树（`.verify/t12-pre-gate.log`）vs 本轮最终树   | 471    | 474    | **0**                  | **0**        | **3** |

**那 1 条"丢失"是改名，不是删除**（t9 把它的名字与断言体一起同步到新规则）：

```
旧（第七轮日志里）：安装引擎（VM-15）：主进程不再把 lts 当默认档位（省略档位 = 跟随当前档，只有显式才换档）
新（本轮最终树）：  安装引擎（VM-15）：主进程不再把 lts 当默认档位（省略档位 = 跟随当前档，只有跨档才算换档）
```

我读了改名后的断言体（`test/selftest.ts:5040`–`:5051`）：旧的四条义务**一条没少** ——
旧实现那一行 `request.channel === 'current' ? 'current' : 'lts'` 必须已经消失、`decideNodePlan({` 在、
`else if (input.mode === 'update')` 在、`channel = currentChannel;` 在；并且**新增**了一条对 r2 新表达式的精确正则
`direction === 'older' || (currentChannel !== null && channel !== currentChannel)` —— 所以它是**加强**，不是放宽。

新增 6 条逐条列出（全部 PASS；第 1 条就是上面那条改名的后继）：

1. `安装引擎（VM-15）：主进程不再把 lts 当默认档位（省略档位 = 跟随当前档，只有跨档才算换档）`（改名 + 加强）
2. `安装引擎（VM-15，r2）：install + 已装 current → switchesChannel=true 且 direction=older（界面据此说得出「降到」）`
3. `安装引擎（r2）：更新前停 dsh 恰好一次（两条路都在 execute 里停，installPhase 不再停）`
4. `O13 VM-15（r2 / §12#32②）：穷举 648 组合… older ⟹ switchesChannel… 零反例`
5. `O14 VM-15（r2 的可达路径）：EnvGate 第三步「换一个 Node」…`
6. `O15 r2 没带坏：当前档位判不出来… 显式换档仍可判定…`

（第一张表的"这一轮 474 条"是**唯一名字数**；diff 脚本内部打印的 475 = 474 + 1 个已消失的旧名字。
**本轮自己的增量**以第二张表为准：**0 丢失 / 0 同名状态变化 / 只新增我写的 3 条**。）

---

## 7. 没带坏别的行为（本轮现测）

- **显式换档仍可判定**：`current` 机器显式要 `lts` → `older` + `switchesChannel=true`（B4 / O15）。
- **`currentChannel === null` 仍走 choose-channel 且不说成换档**：`needChoice=choose-channel`、`release=null`、`direction=null`、`switchesChannel=false`（B3 / O15 / A0）。
- **`install` 的既有行为没变**：`stopDsh` 0 次（A4 / A5）；设计默认仍是「最新稳定版」（O8）；安装 + 已装 current 那条**本来就该说是换档**（O14，这正是 t9 修的那一支）。
- **契约未变**：`src/shared/ipc.ts` 的 SHA256 与上一轮定格**完全相同**（见 §2）；本轮没有任何人的 inScope 含它。

---

## 8. 沙箱里无法执行的（「不可验」清单，与上一轮同一份）

1. **客机上真实的 `nvm install/use`**（含"更新 nvm 管的 Node"整条真链路）：沙箱禁止带管道 stdio 的子进程，`nvm` / `node --version` 都起不来，所以 §3 的更新是"注入清单 + 注入只读探测"下跑通的；期望证据（VM）：日志里 `nvm install <目标> → 退出码 0`、`nvm list` 里 `* <目标>`、`<NVM_SYMLINK>\node.exe --version` 与 `npm.cmd --version` 有输出，且**更新前**有"已停掉本应用启动的 dsh"那条日志。
2. **真实 MSI 安装与 UAC 三态**：期望证据同上一轮（UAC 出现 / 用户点否 / 等太久三种都各自收场，装完 `C:\Program Files\nodejs\node.exe --version` = 目标版本）。
3. **界面观感**：换档提示与「当前（档位）→ 目标（档位）」并排的真观感需要 VM 截图（`older` 那一支不出现「更新」这一点，本轮由 §4 的计划事实 + 上一轮 §5 的分支清单共同支撑）。
4. **注入边界（如实披露）**：§3 的"当前 Node 版本"是 `child_process` 边界按夹具返回的只读探测，不是真机事实；被测模块自己的判定与编排逻辑一行没改。

---

## 9. 我这一轮实际跑了什么

| 步骤               | 命令 / 产物                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| 定格               | `node .verify/t4-freeze.mjs .verify/t12-freeze-{A,mid,B}.txt`（92 / 93 / 93 个路径 + 就地产物扫描）          |
| 四道门禁（t9 树）  | `.verify/t12-pre-{typecheck-main,typecheck-renderer,typecheck-node,lint,format,gate}.log`（全 0，`265/265`） |
| 四道门禁（最终树） | `.verify/t12-final-{typecheck-main,typecheck-renderer,typecheck-node,lint,format,gate}.log`（全 0）          |
| F1 / F2 驱动       | `node .verify/t12-stop-dsh.mjs` → `.verify/t12-drive.log`（**12/12**；648 组合反例 0）                       |
| 新反例             | `node scripts/env-wizard-cases.mjs` → `.verify/t12-cases-O.log`（**185/185**，O13–O15）                      |
| 变异               | `node .verify/t12-mutation.mjs` → `.verify/t12-mutation-{channel,stop}.log`（两条都抓住）                    |
| 断言对名           | `node .verify/t4-assert-diff.mjs …` → `.verify/t12-diff-vs-t4.txt`、`.verify/t12-diff-vs-t9.txt`             |

---

# 历史：第七轮及更早

## 第七轮（t4）报告（原文保留；VM-14 / VM-15 已关闭，本轮 t12 只动了验证侧资产，没有推翻它任何一条结论）

| 项       | 值                                                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 验证者   | verifier（t4，第七轮：t29 的 **VM-14 / VM-15** 独立验证）                                                                                                                                                     |
| 被验产物 | t2：`src/main/node-installer.ts`（方法跟随归属 / 档位跟随当前档 / 换档显式化 + 契约增量）；t3：`EnvPane.vue` / `EnvGate.vue`（更新入口不再硬编码直装、「当前→目标」与换档说清、档位选择可见）；以及整棵树     |
| 时间     | 2026-09-19 16:18–16:25（**本轮现测，没有引用任何成员时期的旧输出**）                                                                                                                                          |
| 结论     | **verdict = pass**：VM-14 / VM-15 **都关闭**，0 条 finding；四道门禁在最终树上全绿                                                                                                                            |
| 四道门禁 | typecheck（main / renderer / node 三段）**0** / lint **0** / format:check **0** / 沙箱自检 **exit 0**（`263/263` + `20/20` + `182/182`，自动收录 2 个脚本；`清理：清单 40 → 删掉 40`、`清理后仍多出来 0 个`） |

> **本轮有一条要请审查者知情**：`t8` 里**我自己改写过的 F3 静态钉子**在本轮被重新推导了一遍（§7），
> 这里写清 6 条计划路径的逐条事实、新旧等式的强弱对比与灵敏度。**F3 的改写请 `t5` / `t6` 复核**——
> 它是本轮改动过的门禁断言，不是历史遗留。

复现命令（都在 `dsh-console/` 下；沙箱里 `npm run <script>` 会经 npm 起带管道的子进程，所以直接点 node 入口）：

```bash
node node_modules/typescript/bin/tsc -p tsconfig.main.json --noEmit
node node_modules/vue-tsc/bin/vue-tsc.js -p tsconfig.renderer.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.node.json
node node_modules/eslint/bin/eslint.js .
node node_modules/prettier/bin/prettier.cjs --check .
node scripts/selftest-sandbox.mjs                      # 第四道门禁（自动收录 scripts/*-cases.mjs）
node .verify/t4-plan-drive.mjs                         # VM-14 / VM-15：**真调 plan()** 的驱动（24 条）
node .verify/t4-mutation.mjs                           # 两条变异：归属兜底 / 档位写死
node .verify/t4-assert-diff.mjs .verify/t8-gate.log .verify/t4-final-gate.log
node .verify/t4-freeze.mjs .verify/t4-freeze-B.txt
```

## 1. 结论

| VM        | 一句话                                                 | 关闭证据（本轮现测）                                                                                                                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **VM-14** | nvm 管的 Node 被硬编码成直装 → 机器上多一份官方 MSI    | §3：**真调 `plan()`** 的三种形状 —— nvm 管的机器（`display = nvm install 26.9.0`、`target = D:\Nvm\nvm…`、`installsManager = false`、`url` 指发布页、**三处都没有 msiexec / `Program Files\nodejs` / `.msi`**）；系统直装形状才 `msiexec /i node-v24.21.0-x64.msi`；**归属 unknown 一律 `usable = false` + `needChoice = choose-method`（不预选、不给「开始」）** |
| **VM-15** | 更新固定走 lts → 在 current 的机器上"更新"看起来像降级 | §4：**真调 `plan()`** —— `v26.5.0(current) → v26.9.0(current)`、`v24.19.0(lts) → v24.21.0(lts)`；显式要 lts 才是 `switchesChannel = true` + `direction = 'older'`（换档**在计划里可判定**，界面不用自己比版本号）；`install` 才用设计默认 lts                                                                                                                     |

**本轮 0 条 finding。** 仍只能真机验的部分见 §9。

---

## 2. 树定格与并发归属（**基线以本轮为准，不引用 t8 的旧哈希**）

- **定格**：`.verify/t4-freeze.mjs` 逐文件 SHA256 → `.verify/t4-freeze-A.txt`（92 个文件：`src` / `test` / `scripts` / `tools` / `docs` / `.changeset` + 顶层配置）与收尾的 `.verify/t4-freeze-B.txt`。
  除我这一轮改的两个文件（`scripts/env-wizard-cases.mjs`、`docs/env-wizard-verification.md`）之外，**其余 90 个文件的聚合 = `ee785d4910aff6c51b7297e85abd2ec97247af3610a072162255a3046c1be42b`**，测量窗口前后一致（A / B 逐个文件相同）。
  我这一轮改的 `scripts/env-wizard-cases.mjs` 最终 = `e476fb5479f2e34b52ef3f230397be6e4487701719959ab60f095ce54425ae77`（128284 字节）。
- **树是干净的**：`src` / `test` / `tools` / `scripts` 下 **0 个就地 `*.js` / `*.js.map`**（定格脚本顺带扫的；门禁只清自己那一轮，被中断留下的产物会留在这里）。
- **并发归属**：`src/main/node-installer.ts` 的最后一版是 **t2 在 16:13:56 落的**（sha256 `5ebeb0ef13bbd314742d461879b4a579d1e4572c9b9ebba498b4d024C7A949DB`，4155 行 / 185065 字节）；
  `t8` 那一轮量到的 `EB755ADA…`（143652 字节）是更早的修订，**不再作为本轮基线**（船长要求）。冻结之后 `src` / `test` 再无写入，`t2` / `t3` 现为 completed 且 idle。
- **产物新鲜度**：`.verify/env-wizard-build/main/node-installer.js` 的 mtime 是 16:14:04，晚于源码最后写入 16:13:56 —— 驱动脚本的日志里**没有**"（编译产物过期 → 现场 tsc…）"那一行，所以 §3 / §4 的 `plan()` 结论就是定格这棵树的结论。
- **一次自我更正（留档，避免以后被当成证据）**：我一度用 `Get-Content <file>.Count` 量出 `node-installer.ts` 是 3838 / 3841 行，与 read 工具的 4155 行不一致，当时误以为有人在并发改。逐字节复核（node 读原文 + SHA256 + `split('\n').length`）后确认：文件自 16:13:56 未动、就是 4155 行，**是那次数行方式的误报**。

---

## 3. VM-14 关闭：方法跟随归属（**真调 `plan()`**，不读代码下结论）

夹具形状仿用户那台客机（`…\Author Software\nvm` 那种 v2 shim 机器），驱动力在 `.verify/t4-plan-drive.mjs`
（我自己写的），原始输出 `.verify/t4-plan-drive.log`。**两处注入我写在脚本头部**：

1. `hooks.fetchText` —— t2 为本轮提供的**正式注入口**（`NodeInstallHooks.fetchText`，与既有 `download` / `elevate` 同一条纪律），我只用它喂**我自己写的** `index.json` / `SHASUMS256.txt` / 发布信息夹具；
2. `child_process` 边界上的 **只读探测注入**：这个沙箱禁止任何带管道 stdio 的子进程（实测 `spawnSync(process.execPath, ['--version'])` → `EPERM`），于是"读当前 Node 版本号"与"读提权态"在沙箱里恒失败。我只拦住 `node… --version` 与 `whoami /groups` 这两种**只读探测**、按夹具事实返回，其余原样转发。**被测模块的判定逻辑一行没改**；A0 那条**不开**这层注入，如实给出沙箱里的真实行为。

| 用例 | 夹具（真实输入）                                           | 实测（原文值）                                                                                                                                                                                                          |
| ---- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A0   | nvm v2 shim + 更新 + **不开注入**（沙箱真实边界）          | `owner=nvm method=nvm currentVersion=null currentChannel=null needChoice=choose-channel usable=false display="" target=null url=https://nodejs.org/en/download`                                                         |
| A1   | **用户的现场**：nvm v2 管着 `v26.9.0`(current) + 更新      | `method=nvm version=v26.9.0 channel=current direction=same installsManager=false display="nvm install 26.9.0" target="D:\Nvm\nvm（…已经装好的版本管理器）" url=https://github.com/nvm-windows/nvm/releases sha256=null` |
| A2   | 同一台机器 + 用户**显式点名 direct**（非提权）             | `usable=false`；`refuseReason="这台电脑上的 Node 是版本管理器管的，所以这次不能再用官方安装包装一份。"`；`display="Node.js v26.9.0"`、`target=null` → **没有 MSI**                                                      |
| A3   | 同一台机器 + **提权态** + 显式点名 direct                  | `method=direct`、`usable=true`、`display="msiexec /i …"`、`note` 含 `§7.9 第 4 条`原句（"…会有两份 Node…"）→ R-23 的例外**真的可达**，但必须显式点名                                                                    |
| B1   | `%ProgramFiles%\nodejs\node.exe` + `v24.19.0`(lts) + 更新  | `owner=system method=direct version=v24.21.0 channel=lts`、`display="msiexec /i node-v24.21.0-x64.msi /qb /norestart"`、`target="…ProgramFiles\nodejs（官方安装包的默认位置）"` → **只有这条走 MSI**                    |
| C1   | `…\volta\bin\node.exe`（认不出）+ 找到 Node + 更新         | `owner=unknown needChoice=choose-method usable=false refuseReason="我们认不出这个 Node 是怎么装的，所以不会替它做自动更新。" url=官方下载页 target=null` → **不默默直装**                                               |
| C2   | 同上 + 安装                                                | `needChoice=choose-method usable=false refuseReason="…所以不替你选路。"` → 要用户显式选一条                                                                                                                             |
| C3   | 同上 + 用户显式点名 direct + 安装                          | `usable=true note` 含"会有两份 Node"、`display="msiexec…"` → §7.8 例外①的落点                                                                                                                                           |
| C4   | 认不出 + **一份 Node 都没找到** + 机器上有管理器（零版本） | `owner=unknown nvmPresent=true method=nvm needChoice=null installsManager=false`，事实行 `…目标方法=nvm；目标档位=lts` → "有默认 ≠ 默默"（`needChoice=null` 本身就是"它没找到 Node"的证据：找到了就必须问）             |

**「没有 MSI」这条不是看代码得出的**：三处判据同时成立 —— `display` 不含 `msiexec`、`target` 不含 `Program Files\nodejs`（且 A1 是 `null`/版本管理器目录）、`url` 不是 `.msi` 结尾。
另：A1 里 `installsManager=false` 且 `sha256=null`、`url` 只指发布页 —— 这就是"机器上已有管理器时**不再装它一遍**、也没有下载与校验两段"的计划侧证据。

---

## 4. VM-15 关闭：档位跟随当前档 + 换档可判定（同一批真调 `plan()`）

| 用例 | 输入                                               | 实测                                                                            | 说明                             |
| ---- | -------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------- |
| D1   | 当前 `v26.5.0`(current) + 更新（省略档位）         | 目标 `v26.9.0`/**current**、`direction=newer`、`switchesChannel=false`          | **current → current**            |
| D2   | 当前 `v24.19.0`(Krypton) + 更新（省略档位）        | 目标 `v24.21.0`/**lts**、`direction=newer`、`switchesChannel=false`             | **lts → lts**                    |
| D3   | 当前 `v26.9.0`(current) + **显式** `channel:'lts'` | 目标 `v24.21.0`、`switchesChannel=true`、**`direction='older'`**、`usable=true` | 换档可判定（界面据此说「换档」） |
| D4   | 同 D3 的机器但**省略**档位                         | 目标仍是 `v26.9.0`/current、`direction=same`、`switchesChannel=false`           | 省略档位**永远不会**换档         |
| D5   | 同上的机器 + `mode:'install'`（省略档位）          | 目标 `v24.21.0`/**lts**                                                         | 设计默认只留给 install           |

`decideNodePlan()` 纯函数矩阵（**零注入、零夹具**，与上表互为参照；10 行全对）：current 跟随 / lts 跟随 / 显式换档 lts（older+switches）/ 显式同档 current（same）/ 当前版本读不到 → `choose-channel` 且 `release=null` / 归属 unknown+找到 Node → `choose-method`（目标版本照样算得出来但不给「开始」）/ 归属 unknown+没找到 Node+有模型 → 默认 nvm / system → direct / nvm+有模型 → `installsManager=false` / nvm+没模型 → `true`。

**"目标低于当前"是可判定的**：`plan.direction === 'older'` 与 `plan.switchesChannel === true` 都由主进程算好（`nodePlanDirection`），界面拿到的就是结论；
`O7b`（§6）再补一条：**四个当前版本逐一驱动，省略档位时 `direction` 永远不是 `older`** —— "看起来像降级"只可能来自显式换档。

---

## 5. 界面侧复核（`EnvPane.vue` / `EnvGate.vue`）

- **不再有默认硬编码的 `method: 'direct'`**：`EnvPane.vue` 里 `method` 只出现在 `:173` 的**读数**比较（`install.value.method !== null`），**没有 `method:` 这个请求键**；唯一的更新请求构造点是 `:423` 的
  `function nodeUpdateRequest(): { mode: 'update'; channel?: EnvNodeChannel }` → `{ mode: 'update' }`（`:426` 只在 `nodeUpdateChannel` 非空时补 `channel`）。
  取值路径：**方法省略** → 主进程按归属决定（§3 的 A1/B1 就是真跑出来的那两条）；两处调用点是 `:434`（取计划）与 `:475`（真正开始）。
- **换档文案确实是「换档」**：`:609`–`:619` 的 `nodeSwitchNotice` 以 `plan.switchesChannel` 为门、`direction === 'older'` 时输出
  「这会把现在这份 Node 换成稳定版，版本从 `v26.9.0` 降到 `v24.21.0`。」——该分支里**没有**「更新」二字；同类分支还有
  `:628`–`:632`（动作名「换成稳定版」）、`:635`–`:639`（停 dsh 那句改成"换档会先停掉…"）、`:642`–`:645`（进行中「正在换成…」）、`:648`–`:657`（收尾「Node.js：… → … —— 换档完成。」）、`:534`–`:541`（结果标题），
  `EnvGate.vue` 侧是 `:543`–`:553` 的 `channelSwitchNotice`。
- **档位选择显示当前选中值（安装与更新两处）**：安装侧 `EnvGate.vue` 的选择区控件 `:1257`–`:1274`（`:checked="nodeChannel === option.id"` + 「现在选的是：{{ CHANNEL_TITLES[nodeChannel] }}」），确认区固定一行「版本档位」（`:1477`–`:1478` 的 `channelRowText`，`:535`–`:541` 算的）；更新侧 `EnvPane.vue` 确认区的「当前版本（档位）→ 目标版本（档位）」并排（`:936` 起，`versionWithChannel` 在 `:563`）。
- **行为式判据（船长本轮改判，不按"字符串里有 `channel:`"判）**：默认不传档位 —— `EnvPane.vue:425–427`（`picked` 为空就不带）与 `EnvGate.vue:517`（`if (channelPicked.value) request.channel = …`），
  而 `channelPicked` 只在用户真的点控件时（`EnvGate.vue:893–898`）被置 true、每次重开门禁/换步回到 `false`（`:1154`）；`EnvPane` 侧同理：`pickUpdateChannel()`（`:441`）是唯一写 `nodeUpdateChannel` 的地方，`cancelUpdate()`（`:448`）把它清回 `null`。
  引擎侧的行为由 §4 的 D3 / D4 真跑证明（省略 → 跟随 current；显式 → `switchesChannel`/`older`）。
- **本轮没验的**：确认区展开后的真实排布、控件可聚焦、并排显示与换档提示的**观感** —— 见 §9 的期望证据形式（真机截图）。

---

## 6. 我这一轮加的断言（`scripts/env-wizard-cases.mjs` 的 O 段，`168 → 182`）与变异实验

14 条新断言（`O0`–`O12`，逐条列入 §8 的新增清单）：`O1`–`O4` 是**归属四类输入**（nvm v2 shim / v1 link / 系统直装 / 未知，带 `model` 与 `msiInstallPath` 驱动，比 C1–C8 那几条多喂了两个入参），
`O5`–`O12` 是 `decideNodePlan` 的方法跟随归属、档位跟随当前档、换档只在显式选档时发生、`installsManager`、不猜档位与"三个例外都要显式点名 + 并存风险句"。

**变异实验**（`.verify/t4-mutation.mjs`，改的是 `.verify/` 下的**编译副本**，不动 `src/`）：

| 变异 | 改法                                                                                    | 结果                                                                                                      |
| ---- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A    | `detectNodeOwner` 最后那条兜底 `unknown → system`（模拟被删掉的"剩下的一律当系统装的"） | 退出码 1，**恰好 `O4` 变红**（`D:\nvm-tools\node.exe` 与自定义目录被误判）；其余 181 条仍绿               |
| B    | `decideNodePlan` 的 `channel = currentChannel` → `channel = 'lts'`（模拟 VM-15 的成因） | 退出码 1，**`O6` / `O7b` / `O8` 变红**（跟随失效、`older` 不再被限制在显式换档、install/update 规则混掉） |

即：**把这两处改回旧写法，O 段的断言会红** —— 它们不是空转（不是"只看代码很对"）。

---

## 7. F3 的改写：重新推导一遍（**请 `t5` / `t6` 复核**）

`t8` 解死锁时（TypeError 修好之后）F3 立刻红：静态计数 `signer: null=6`、`releaseSigning: 'unknown'=5`，而期望还是 `4 / 3 / 1`。
我没有照失败信息改数字，而是把 `buildPlan` 切片里的**六个计划字面量逐个读出来**、再写成结构等式。逐条事实（行号是定格那一版）：

| #   | 计划路径（是谁的那一份）                                                              | 位置                                       | `signer` | `releaseSigning`               | 为什么这样是对的                                                                    |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------ | -------- | ------------------------------ | ----------------------------------------------------------------------------------- |
| 1   | `buildRefusalPlan()`：要用户显式选 / 归属已知时点了不该走的那条路                     | `node-installer.ts:2151`（字面量 `:2163`） | `null`   | 写死 `'unknown'`               | 这一轮连下载都不会发生，没有"发布自述"可读                                          |
| 2   | `buildDirectPlan()` 的 `refuse()`：架构认不出 / 没取到校验清单 / 清单里没有           | `:2227`（字面量 `:2229`）                  | `null`   | 写死 `'unknown'`               | nodejs.org 那侧没有"签没签名"的发布自述                                             |
| 3   | `buildDirectPlan()` 的正常计划（`msiexec …`）                                         | `:2293`                                    | `null`   | 写死 `'unknown'`               | 同上；计划阶段读不到文件的 Authenticode                                             |
| 4   | `buildNvmPlan()` 的 `refuse()`：管理员身份 / 没取到发布信息 / 没有适配架构            | `:2340`（字面量 `:2342`）                  | `null`   | 写死 `'unknown'`               | 没有挑中发布资产 → 没有正文可解析                                                   |
| 5   | `buildNvmPlan()` 的 `installsManager === false`：机器上已有管理器（这次什么都不下载） | `:2385`（字面量 `:2385`）                  | `null`   | 写死 `'unknown'`               | 不下载管理器 → 也没读它的发布正文（VM-14 那条"不再装一遍"）                         |
| 6   | `buildNvmPlan()` 的正常计划（真去装管理器）                                           | `:2453`（字面量 `:2453`）                  | `null`   | `releaseSigning`（变量，简写） | 全文件唯一一处 `const releaseSigning = parseReleaseSigning(chosen.body)`（`:2437`） |

**新等式**（`planLiteralCount = countOf(planSlice, 'plan: {') = 6`）：

```js
planLiteralCount === 6 &&
  countOf(planSlice, 'signer: null') === planLiteralCount && // 每条路径各一个
  countOf(planSlice, "releaseSigning: 'unknown'") === planLiteralCount - 1 && // 正好一条不写死
  countOf(planSlice, 'releaseSigning') === planLiteralCount + 1 && // 6 处 + 那一次赋值
  countOf(planSlice, 'const releaseSigning = parseReleaseSigning(') === 1 &&
  countOf(installerSource, 'const releaseSigning = parseReleaseSigning(') === 1;
```

**为什么等价或更强**：旧的 `4 / 3 / 1` 把"计划路径恰好 4 条"当成了隐式前提，而且三个数**彼此独立** —— 一条路径漏写 `signer`、另一处多写一个，总数照样对得上。
新等式把"**每一条**计划路径都钉住 `signer` + `releaseSigning`"写成显式约束：`signer: null` 数、`unknown` 数、`releaseSigning` 总数三者的**差集**恰好刻画"6 条路径、其中 1 条取值、其余 5 条写死 unknown"，
再加上"赋值恰好 1 处（切片内与全文件各一次检查）"。在 6 条路径的现实上，它比旧的三个独立数字强；在 4 条路径的旧世界上二者等价（旧数字就是它的解）。
**灵敏度（哪几种改动会让它变红）**：(a) 增删一条计划路径（字面量数 ≠ 6）；(b) 任何一条路径漏写 `signer` 或 `releaseSigning`；(c) 多出一条路径也写死 `unknown` 而取值路径不再唯一；(d) 新增第二处 `parseReleaseSigning` 赋值或把它挪出/挪进切片；
(e) 把第 6 条的简写改成内联 `parseReleaseSigning(chosen.body)`（`releaseSigning` 总出现次数不再是 7）—— (e) 是**有意保守**的一处：换写法要人来确认一次，而不是静默通过。

**两条推导分开列（都指向同一组 6 条路径，但来源不同）**：

- **我（verifier）的**：先跑失败信息 → 直接读 `src/main/node-installer.ts` 的 `buildPlan` 切片（`private async buildPlan(` → `private async transferPhase(`）、逐条读上面那 6 个字面量的 `signer` / `releaseSigning` → 用我自己的探针 `.verify/f3-probe.mjs`（跑完已删）数出 `6 / 5 / 6 / 1 / 7` → 写成结构等式。散列证据在 `.verify/t8-gate.log`（F3 由红转绿那一次）。
- **installer-dev（t2）的**：在 t8 收尾时主动发来、作为**对照**（不是依据）：按需求 t29 的两条新路径解释 `4 → 6`（`buildRefusalPlan()` + `installsManager === false` 分支），并建议"把 F3 写成每条路径各一条 `signer: null` + `releaseSigning` 断言、6/5 作为当前期望值"。
- 两者的结论相同（同样 6 条路径、同样是"5 处写死 unknown + 1 处取值"）；**我的复核在前**（探针输出早于它的消息落在我这边），它的推导我按对照记录，不当作我的依据。

---

## 8. 断言完整性（0 丢失 / 0 状态变化 / 新增逐条列出）

用 `.verify/t4-assert-diff.mjs`（认两种行形状：`PASS/SKIP/FAIL` 与 `[通过]/[失败]`；PowerShell `*>` 落盘是 UTF-16LE，脚本按 BOM 解码）对**上一轮** `t8` 的门禁日志与**本轮**日志逐名对：

| 对比                                | 上一轮 | 这一轮 | 丢失  | 同名状态变化 | 新增   |
| ----------------------------------- | ------ | ------ | ----- | ------------ | ------ |
| t8 门禁 vs 本轮（我改文件**之前**） | 455    | 455    | **0** | **0**        | 0      |
| 本轮（改文件之前）vs **最终树**     | 455    | 469    | **0** | **0**        | **14** |

新增 14 条逐条列出（全部 PASS，名字即断言）：

1. `O0 t29：这一段要用的导出都在（被改名 / 挪走时这里先红，而不是后面一个 TypeError）`
2. `O1 VM-14 第①类（nvm v2 shim）：模型给出的版本目录 / 当前版本目录都判 nvm …`
3. `O2 VM-14 第②类（nvm v1 link）：NVM_SYMLINK 那份与版本管理器根目录下那份都判 nvm …`
4. `O3 VM-14 第③类（系统直装）：官方默认安装位与 InstallPath 都判 system …`
5. `O4 VM-14 第④类（未知）：D:\nvm-tools\node.exe / 别的管理器 / 任何没有正面证据的自定义目录一律 unknown …`
6. `O5 VM-14（方法跟随归属）：nvm → nvm；system → direct；归属未知且找到了一份 Node → needChoice=choose-method …`
7. `O6 VM-15（档位跟随当前档）：current → current、lts → lts，省略档位时 switchesChannel 恒 false`
8. `O7 VM-15（换档只由显式选档产生）：显式要 lts → switchesChannel=true、direction=older …`
9. `O7b VM-15：省略档位（跟随）永不产生 direction=older —— 四个当前版本逐一驱动`
10. `O8 设计默认只留给 install：install 且省略档位 = 最新稳定版（lts）；update 且省略档位 = 当前档`
11. `O9 VM-14（不重装管理器）：installsManager 只在"走 nvm 且机器上已经有可辨认的管理器"时为 false`
12. `O10 VM-15（不猜档位）：当前版本读不到 → needChoice=choose-channel 且 release=null`
13. `O11 判据自己也不猜：官方清单里没有这个已装版本 → 档位 null；当前版本认不出 → direction=null`
14. `O12 三个例外都要用户显式点名 + 并存风险句：… 同一句话是常量（§7.9 第 4 条原样）`

**没有既有断言被删除或放宽**：0 丢失、0 同名状态变化（这条覆盖 `test/selftest.ts` 的 `PASS/SKIP` 与两个 `*-cases.mjs` 的全部 `[通过]` 名字）；新增只有上面 14 条，全部是**新增**而不是把旧名字改宽。

---

## 9. 沙箱里无法执行的（「不可验」清单，逐条给期望的真机证据形式）

1. **客机上真实的 `nvm install <档> → nvm use` 换档**：需要真的 `nvm.exe` 与网络；这个沙箱**禁止带管道 stdio 的子进程**（连 `node --version` 都 `EPERM`），所以 §3/§4 的"当前版本"只能靠边界注入给出来。
   期望证据（VM 上）：日志里
   `nvm env：… 退出码 0`、`nvm install 26.9.0 → 退出码 0`、`nvm list` 里 `* 26.9.0`、`<NVM_SYMLINK>\node.exe --version = v26.9.0`、`npm.cmd --version` 有输出这五件事同屏。
2. **真实 MSI 安装与 UAC 三态**（成功 / 用户点否 / 等太久）：需要真的提权与写 `C:\Program Files`。期望证据：VM 上点「开始」后 UAC 出现、装完 `"C:\Program Files\nodejs\node.exe" --version` 等于计划里的目标版本，且 `node-installer` 日志里 `msiexec /i … /qb /norestart` 那一行与退出码 0。
3. **界面观感**：确认区展开后的「当前版本（档位） → 目标版本（档位）」并排、档位控件可聚焦、`older` 时那句「…版本从 vX 降到 vY」的视觉层级。期望证据：VM 上更新确认区一张截图（当前/目标/档位/换档提示四处同屏），以及安装选择区未展开时就看得见档位控件的那一屏。
4. **注入的边界（本轮要写清的诚实边界）**：§3/§4 里"当前 Node 版本"与"提权态"是**在 `child_process` 边界按夹具事实返回**的，不是真机事实；被测模块自己的判定逻辑没被改，A0 那条不开注入、给出沙箱真实行为（读不到版本 → `choose-channel`，不猜档位）。

---

## 10. 我这一轮实际跑了什么

| 步骤               | 命令 / 产物                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| 定格               | `node .verify/t4-freeze.mjs .verify/t4-freeze-A.txt`（92 个文件 + 就地 `.js` 扫描）；收尾 `…-B.txt`           |
| 四道门禁（冻结树） | `.verify/t4-pre-{typecheck-main,typecheck-renderer,typecheck-node,lint,format,gate}.log`（全 0）              |
| 四道门禁（最终树） | `.verify/t4-final-{typecheck-main,typecheck-renderer,typecheck-node,lint,format,gate}.log`（全 0）            |
| VM-14 / VM-15      | `node .verify/t4-plan-drive.mjs` → `.verify/t4-plan-drive.log`（**24/24**）                                   |
| 新反例（O 段）     | `node scripts/env-wizard-cases.mjs` → `.verify/t4-cases-O.log`（**182/182**，O 段 14 条）                     |
| 变异               | `node .verify/t4-mutation.mjs` → `.verify/t4-mutation-{owner,channel}.log`（两条变异都被抓住）                |
| 断言对名           | `node .verify/t4-assert-diff.mjs .verify/t8-gate.log .verify/t4-final-gate.log` → `.verify/t4-diff-final.txt` |

---

# 历史：第六轮及更早

## 第六轮（t44）报告（原文保留；F-05 已关闭，本轮 t4 没有动它修过的任何东西）

| 项       | 值                                                                                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 验证者   | verifier（t44，第六轮收口）                                                                                                                                                |
| 被验产物 | t43 对 **F-05** 的修复（`src/main/env-doctor.ts` 的 `node-version` 三支 + 覆盖面清扫，`test/selftest.ts` 的 VM-13 断言）；以及"t39 的 nvm v2 实现有没有被带坏"；最终整棵树 |
| 时间     | 2026-09-19（本轮现测；**没有引用任何成员时期的旧输出**）                                                                                                                   |
| 结论     | **verdict = pass**：第五轮判出的 **F-05 已关闭**，0 条 finding；四道门禁全绿                                                                                               |
| 四道门禁 | typecheck **0** / lint **0** / format:check **0** / 沙箱自检 **exit 0**（`252/252` + `20/20` + `168/168`，自动收录 2 个脚本，清理 40 删 40、0 残留）                       |

> **t42 集成收口补记（最终树现测）**：这份文档**每一轮的报告都保留原文**，各轮头部的项数都是**那一轮**的值
> （第四轮 / 第五轮 / 第六轮各自写着各自的）。t42 在**冻结后的最终树**上现测四道门禁：**252/252 + 20/20 + 168/168**，
> typecheck / lint / format:check 全 **0**，清理 40 删 40、0 残留，`自检门禁：通过`（原始日志 `.verify/t42-gates/`）。
> 与第六轮（t44）一致：本轮 t42 **没有动 `src/` / `test/` / `scripts/`**（只补 changeset / `AGENTS.md` / docs ——
> nvm v2 的真实模型、「管理器在、零版本」的状态与出路、「整文件往返写毁编码」那条坑），所以项数不变。

复现命令（都在 `dsh-console/` 下）：

```bash
npm run typecheck && npm run lint && npm run format:check
node scripts/selftest-sandbox.mjs                    # 第四道门禁（自动收录 scripts/*-cases.mjs）
node .verify/t44/f05-close.mjs                       # F-05 关闭的驱动复核（真链路 + 全文案扫描 + 两条安装路）
node .verify/t44/n-mutation-prep.mjs                 # 四个变异实验（含"把那句改回去 → 断言变红"）
node .verify/t40/name-diff.mjs .verify/t34-gates/selftest-sandbox.log .verify/t44-gates/selftest-sandbox.log
node .verify/t40/myers-diff.mjs .verify/t40-build/test/selftest.js .verify/t44-build/test/selftest.js
```

---

## 1. 结论：**F-05 已关闭**（第五轮那条 needs_revision 的唯一一条）

| 第五轮的 finding                                                    | 本轮现测的关闭证据                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F-05 / VM-13**：门禁事实行把用户打发去终端（`env-doctor.ts:739`） | §3：用客机真实状态驱动我自己编的产物，门禁事实行（`EnvGate.vue` 渲染的 `step.detail`）现在是「版本管理器已经装好了：这份 Node（…\\.nodejs\\node.exe）就在它管的目录里，但它还没有装任何 Node 版本（或者没有选中一个）…」—— **13 条用户可见文案 0 条命中"打发用户"**，出路第一句是应用内的「安装 Node.js」；两条一键安装路仍都在 |
| 覆盖面（第五轮指出"断言只扫了 `installerCode`"）                    | §4：`env-doctor` 的 `detail` / `fixHint` / 计划 `note` / `display` 全都进了自检的 VM-13 断言（动态 + 静态两扫），**由我在 N 段补的行为断言**（N7b–N7e）也守住了同一件事；四个变异实验里的 mutC 就是"把旧句改回去 → N7c 变红"                                                                                                    |

**本轮 0 条 finding。** 仍只能真机验的部分见 §7。

---

## 2. 四道门禁（最终树现测，原始输出）

| 门禁         | 命令                                | 退出码 | 关键输出                                                                                                                                                                                        |
| ------------ | ----------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typecheck    | `npm run typecheck`                 | **0**  | 三段（main / renderer / node）无输出                                                                                                                                                            |
| lint         | `npm run lint`                      | **0**  | `eslint .` 无告警                                                                                                                                                                               |
| format:check | `npm run format:check`              | **0**  | `All matched files use Prettier code style!`                                                                                                                                                    |
| 沙箱自检     | `node scripts/selftest-sandbox.mjs` | **0**  | `252/252 项通过` + 自动收录 2 个脚本（`env-doctor-cases.mjs` **20/20**、`env-wizard-cases.mjs` **168/168**，退出码都 0）+ `清理：清单 40 → 删掉 40` + `清理后仍多出来：0 个` + `自检门禁：通过` |

原始日志：`.verify/t44-gates/{typecheck,lint,format,selftest-sandbox}.log`（`cmd /c … 1> file` 写**原始字节**；
我自己的反例脚本改完之后又在同一棵树上复跑过一轮，数字相同）。

树定格：**64 个源文件逐个 SHA256 的聚合 = `8fd5f89fde0153c4da7ecfd9ba538e317322a4e17a00fd14f767d29c1428b880`**
（这是 **t43 那棵树**的值：测量窗口前后两次一致、`git status --porcelain` 前后 diff 0；
测前确认 `src/`、`test/` 下 0 个就地 `*.js`/`*.map`）。
**我自己那两个文件改完（N 段换成真断言）之后的最终定格 = `47a973e2649ca15e9deba635eaa27cd556288d41d576aadde4280268ec4fd316`**
（二者只差 `scripts/env-wizard-cases.mjs` 一个文件；最终值与"先测 t43 的树、再改我自己的文件、最后复跑四道门禁"
的顺序一致，两份清单在 `.verify/t44-freeze-{A,C,D}.txt`）。
**顺带一个比聚合更硬的对照**：与第五轮那份逐个文件的 SHA256 清单比，本轮**只有 2 个文件变了**
（`src/main/env-doctor.ts`、`test/selftest.ts` —— 正是 t43 的 changedPaths），
`src/main/node-installer.ts`（`4fab29bc…`）、`src/main/process-utils.ts`（`9aeda8d4…`）、
`src/shared/ipc.ts`（`14f19524…`）**逐字节没动**。

---

## 3. F-05 关闭的驱动复核（`.verify/t44/f05-close.mjs`，驱动我自己编的 `.verify/t44-build-main`）

**① 真实链路**（不是手写那个事实位）：`looksVersionManagerNode(客机路径)` → `nodeFromVersionManager` → `judgeEnvironment`：

```
looksVersionManagerNode(…\Author Software\nvm\.nodejs\node.exe) = true
looksVersionManagerNode(D:\nvm-tools\node.exe)                  = false（只是名字像的不误判）
looksVersionManagerNode(C:\Program Files\nodejs\node.exe)       = false
```

**② 全文案扫描**：`checks[].detail` + `checks[].fixHint` + `plans[].note` + `plans[].display` 共 13 条，
按「先在终端 / 到终端里去 / 自己打开终端 / 自己去终端 / 自己到终端 / 自行在终端 / 手动到终端 / 你自己去敲 / 自己回终端…」这套词表扫：
**命中 0 条**。

**③ 客机状态那两行**（门禁第一步的事实行与出路，原文）：

```
node-version.status = missing
detail  : 版本管理器已经装好了：这份 Node（C:\Users\tester\AppData\Local\Author Software\nvm\.nodejs\node.exe）
          就在它管的目录里，但它还没有装任何 Node 版本（或者没有选中一个），所以这个 node.exe 现在跑起来没有任何输出
fixHint : 点上面的「安装 Node.js」：直接安装官方稳定版、或通过 nvm 安装，都由我们装好并切过去。
          想自己来也可以：`nvm install 24 && nvm use 24`（nvm-windows），或到 nodejs.org 装 22.12+ 的 LTS。
```

**④ 门禁**：`gate=blocked`、`currentStepId=node`、`node.status=todo`，
`step.detail`（= `EnvGate.vue:1122` 渲染的那一行）与上面 `detail` 一致、**命中"打发用户"= false、含「版本管理器」= true**。

**⑤ 两条一键安装路仍在**（8/8 静态核对通过）：门禁模板里有 `value="direct"` 与 `value="nvm"`、两个选项都挂在
`currentStep.id === 'node'` 的 `.gate-choice` 上、`loadNodePlan(`/`runNodeInstall(` 入口都在、
渲染层胶水两个函数都在、引擎里 `buildNvmPlan(` 与直装（msi）分支都在、
`execute()` 里 `if (plan.method === 'nvm')` 仍走 `installNodeWithNvm`。

**⑥ 探针**：把第五轮判出 F-05 时那句原文喂给同一套词表 → 命中 `["先在终端"]`
（证明这次"0 条命中"不是扫描空转）。

**⑦ 顺带复核 t39 的链路**：`findNodePathWindows(客机)` 仍然只返回 `.nodejs\node.exe`；
`windowsBinCandidates` 仍含 `<root>\.nodejs`；`deriveNvmModel`（env 里没有 `NVM_HOME` / `NVM_SYMLINK`）
仍然得到 `root=…\Author Software\nvm` / `mode=shim` / `activeDir=…\.nodejs`；
`classifyInstallFailure(shim 那句).kind = nvm-inactive`。

---

## 4. 断言覆盖面与变异实验

**t43 加进自检的覆盖面**（我逐行读过，`test/selftest.ts` 的 `17e. VM-13` 段）：把
`report.checks[].detail`、`report.checks[].fixHint`、`report.plans[].note`、`report.plans[].display`
全收进"动态扫描"，外加 `env-doctor.ts` 的所有字符串字面量的"静态扫描"，用 10 条"打发用户"词表；
还内建了一条自证（同一套词表对修之前那句必须命中）。**这正是第五轮指出缺的那一块。**

**我把 `scripts/env-wizard-cases.mjs` 里那条 `observe()` 附注换成了真断言**（150 → 164 → **168** 条）：

| 断言 | 断什么                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| N7b  | `looksVersionManagerNode` 的真实链路：客机那份算、`D:\nvm-tools\node.exe` 不算、系统 Node 不算、`NVM_SYMLINK` 目录算                                                                                         |
| N7c  | 客机状态下 **13 条用户可见文案 0 条命中**"打发用户"；`node-version` detail 说中「版本管理器」且带真实路径；fixHint 指向应用内「安装 Node.js」；门禁事实行（`step.detail`）与它一致、也是 `blocked/node/todo` |
| N7d  | 自证：同一套词表对第五轮那句旧文案必须命中                                                                                                                                                                   |
| N7e  | 真该由用户做的例外（起不了子进程）：应用内那条路（点「重新检测」）必须排在"自己到终端确认"之前                                                                                                               |

**变异实验**（`.verify/t44/n-mutation-prep.mjs`，复制我这一轮编的产物、各改一处实现，再用
`ENV_WIZARD_BUILD_DIR` 指过去跑；日志 `.verify/t44/cases-mut*.log`）：

| 变异     | 改了什么                                                    | 结果                                 |
| -------- | ----------------------------------------------------------- | ------------------------------------ |
| mutA     | `deriveNvmModel` 没证据时也造一个根目录                     | **N4c 红**（167/168）                |
| mutB     | `findNodePathWindows` 直接返回那条推测路径                  | **N6 红**（167/168）                 |
| **mutC** | **把应用内那句换回第五轮的旧文案「先在终端里选一个版本…」** | **N7c 红**（167/168）—— 验收要的那条 |
| mutD     | `looksVersionManagerNode` 恒 `false`                        | **N7b + N7c 红**（166/168）          |

---

## 5. t39 的实现没被带坏 + 断言完整性

- **逐文件哈希**：与第五轮清单比，只有 `env-doctor.ts` 与 `test/selftest.ts` 变了（t43 的 changedPaths），
  `node-installer.ts` / `process-utils.ts` / `ipc.ts` 逐字节相同（§2）。
- **逐行 compile-diff**（`.verify/t40/myers-diff.mjs`，我自己的 Myers + 400 组自校验）：
  第五轮那份编译产物（3275 行）→ 本轮（3358 行）：**相同 3275 行、被删 0 行、新增 83 行、1 个 hunk**。
  83 行新增全部落在 `17e. VM-13` 段（含 `PUNTING_PHRASES`、两条新检查），头一行就是那段注释。
  **⇒ 上一轮的全部内容（含 t39 那 8 条 nvm 断言与"`installerCode` 那条不把用户打发去终端"的断言）一行没动。**
- **断言名字集合差**（`.verify/t44/name-diff.log`，对**出错前**那份日志）：
  `242/4/0 → 252/4/0`，**丢失 0、同名状态变化 0、新增 10**（= t39 的 8 条 + t43 的 2 条 VM-13，逐条见日志）。
- **nvm 那段的行为断言仍全绿**：`env-wizard-cases.mjs` 的 N1–N6 / N7 / N8 / N9（模型推导、清单解析、
  注册表、只报真路径、证据日志、shim 不提权）在 168/168 里。
- **SKIP 仍是同 4 条**（与 t34 那份同名同数）。

---

## 6. 一条更正：`.tmp/` 在**工作区根**，我上一轮说"不存在"是错的

第五轮报告里写的"实现者留在 `.tmp/` 的两个脚本**根本不存在**（`.tmp/` 整个目录都没有）"**是错的** ——
我当时只在**仓库根**（`dsh-console/`）找，而 `.tmp/` 在它的**上一层**（工作区根 `C:\Users\yozica\Desktop\dsh\.tmp\`）。
本轮核实（`Get-ChildItem ..\.tmp`）：那里有 **71 个文件**，包括

- `audit-log-diff.cjs`（1612 B，15:01:44）与 `diff-build.cjs`（2268 B，15:03:34）—— 就是那两个自证脚本；
- 13 个 `recover-selftest*.cjs`、`traces.json`(242 KB) / `unresolved.json` / `fills.json` / `review-fills*.txt`
  （恢复过程中"只能人判"的那批位置的现场）、`selftest-final.ts` / `selftest-before-prettier.ts`（14:59:53）；
- **`selftest-corrupted-backup.ts`（249620 B，14:43:44）** —— 那次事故的**真坏文件**；
  `selftest-cp936.bin`（221173 B，14:46:07）。

**更正后的说法**：它们**存在**，在仓库外的工作区根；**我（第五轮与这一轮）都没有采用它们的任何输出**，
我上面的所有结论都来自我自己写的脚本 —— 这一点不受影响，但"不存在"与"存在、我不用"的可信度含义不同，
必须改过来。

**顺手把真坏文件当阳性对照**（比第五轮那个合成样本硬得多）：用第五轮那把尺扫

| 文件                                                | 合法 UTF-8 | U+FFFD | 乱码字母表命中               |
| --------------------------------------------------- | ---------- | ------ | ---------------------------- |
| `.tmp/selftest-corrupted-backup.ts`（事故真坏文件） | **true**   | 0      | **171 个不同字符 / 8434 次** |
| `.tmp/selftest-cp936.bin`                           | **false**  | 1400   | 0                            |
| 现树 `test/selftest.ts`（恢复后）                   | true       | 0      | **0**                        |

也就是说：这次事故的坏文件是**合法 UTF-8 的乱码**（U+FFFD 一个都没有）—— 只数 U+FFFD 会漏掉它；
第五轮我用的"乱码字母表"那把尺在真坏文件上命中 8434 次、在恢复后的文件上是 0。
**第五轮"4 个文件 0 残留"的结论因此更硬了，不是更弱。**

---

## 7. 仍只能真机验的部分（与第五轮一致，F-05 修的是文案，不改这份清单）

1. 客机上 `nvm install <版本>` 真的下载并装好 —— 期望 `<userData>/logs/console.log` 里
   `nvm install：nvm install 24.x.y → 退出码 0；stdout：…Installed Node.js v24.x.y…` 且 `<root>\installs` 下真出现版本目录；
2. `nvm use` 真的切过去 —— `Now using Node.js v24.x.y by default.` + `<root>\.nodejs\node.exe --version` 有输出；
3. 端到端放行（门禁从挡住页变放行页，且只报真实路径那条 node）；
4. v1 链接模式的 UAC 真弹一次（`ok` / `declined` 各一次）；
5. v2 非管理员账户下走完链路而不弹 UAC；
6. `nvm env` 整段文本的逐字形态（我这份夹具是重建的）；
7. **F-05 修完之后的界面观感**：真机上门禁卡片的事实行与两条安装选项并列时读起来是否顺（观感只能人看）。

---

## 8. 我这一轮实际跑了什么

1. 树干净性 + 定格（64 文件 SHA256 聚合，窗口前后一致；另与第五轮逐文件哈希对账）。
2. 四道门禁（原始退出码 + `cmd /c … 1>` 写的原始字节日志）。
3. `f05-close.mjs` 驱动复核（真实链路 + 13 条文案扫描 + 两条安装路 + 探针 + t39 链路复查）。
4. 读 t43 的实现（`looksVersionManagerNode`、`node-version` 三支、`nodeInstallHint` / `NOT_MEASURED_HINT` /
   `BLOCKED_HINT_PREFIX`）与自检的新 VM-13 段（逐行读）。
5. 我自己的反例脚本：N 段 164 → 168 条（N7 附注换成 N7b–N7e 四条真断言）。
6. 四个变异实验（mutC 就是验收要的"把旧句改回去 → 红"）。
7. 交叉核对：第五轮 vs 本轮的逐行 compile-diff、断言名字集合差、`.tmp/` 现场核实与真坏文件对照扫描。

---

# 历史：第五轮及更早

## 第五轮（t40）报告（原文保留；其中的 F-05 已由 t43 修掉、本轮 t44 判为关闭）

> **本文里出现的自检项数一律是"那一轮"的值** —— 最新的在本文最上面那份第六轮报告里。

| 项       | 值                                                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 验证者   | verifier（t40，第五轮）                                                                                                                                                            |
| 被验产物 | t39（nvm 那条路按 v2 的 shim 模型重做 + 应用自己装版本 + 界面只报真路径），以及**本轮的重点**：`test/selftest.ts`（4593 行）在同一次 PowerShell 编码往返事故之后的重建；最终整棵树 |
| 时间     | 2026-09-19（本轮现测；**没有引用任何成员时期的旧输出**）                                                                                                                           |
| 结论     | **verdict = needs_revision** —— 1 条 finding（**F-05 / VM-13**：门禁事实行仍写着「先在终端里选一个版本」）。nvm 链路本身与事故重建的复核**都通过**；四道门禁全绿                   |
| 四道门禁 | typecheck **0** / lint **0** / format:check **0** / 沙箱自检 **exit 0**（`250/250` + `20/20` + `164/164`，自动收录 2 个脚本，清理 40 删 40、0 残留）                               |

复现命令（都在 `dsh-console/` 下；`--` 之后是我这一轮自己写的脚本，不是实现者留下的）：

```bash
npm run typecheck && npm run lint && npm run format:check
node scripts/selftest-sandbox.mjs                              # 第四道门禁（自动收录 scripts/*-cases.mjs）
node .verify/t40/name-diff.mjs .verify/t34-gates/selftest-sandbox.log .verify/t40-gates/selftest-sandbox5.log
npx tsc -p tsconfig.node.json --noEmit false --outDir .verify/t40-build   # 只为拿"现在的编译产物"
node .verify/t40/myers-diff.mjs .verify/cases-build/test/selftest.js .verify/t40-build/test/selftest.js
node .verify/t40/map-align.mjs .verify/cases-build/test/selftest.js.map .verify/t40-build/test/selftest.js.map \
     .verify/cases-build/test/selftest.js .verify/t40-build/test/selftest.js
node .verify/t40/enc-scan.mjs test/selftest.ts src/main/node-installer.ts src/main/env-doctor.ts src/main/process-utils.ts
node .verify/t40/vm11-drive.mjs                                # 把客机状态喂给判定函数，打印界面会显示的那一行
node .verify/t40/n-mutation-prep.mjs                           # 变异实验：N 段断言真的会红
```

---

## 1. 结论

| 项                                      | 本轮现测的结论                                                                                                                | 证据 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---- |
| **`test/selftest.ts` 重建**（本轮重点） | **没有丢失、也没有削弱任何断言**（事故前那一份的 3077/3082 行逐字节相同；缺的 5 行全部指向 t39 有意改的两处）                 | §3   |
| 编码体检（4 个被 t39 动过的文件）       | 合法 UTF-8 / 无 BOM / 无 CRLF / **0 个 U+FFFD** / **0 个乱码字符**（同一把尺在 t15 的坏文件与合成乱码上都真的会命中）         | §3.3 |
| nvm v2 的模型                           | 从**真实证据**推得出来（客机没有 `NVM_HOME` / `NVM_SYMLINK` 也算得对），v1 机器照旧认                                         | §4.1 |
| 「应用自己装版本」                      | **真执行**：`nvm install` / `nvm use` 都 spawn 真进程、按退出码分类、回清单核对、再用 `node --version` + `npm --version` 复检 | §4.2 |
| 每一步的证据                            | 命令 / 退出码 / stdout / stderr（空的那路写「（空）」）真的进日志通道（我用真 `NodeInstaller` 驱动过一条）                    | §4.2 |
| 界面只报真实路径（VM-12）               | 客机上只认 `.nodejs\node.exe`；那条不存在的推测路径不会被返回（全都不存在时返回 `null`）                                      | §4.3 |
| 断言项数                                | 自检 `242 → 250`（**0 条丢失、0 条同名变化、8 条新增**）；我的反例脚本 `150 → 164`                                            | §6   |
| `SKIP 4`                                | **阶段一就有的环境条件分支**，不是本轮新增的"放宽机制"（t8/t16/t20/t32/t34 每一轮都是同名 4 条）                              | §6.3 |
| `.changeset/` 与 `docs/`                | t39 没有碰（全部 mtime ≤ 14:10:15，t39 的改写窗口是 14:40–15:06）                                                             | §7   |
| **F-05 / VM-13**                        | **needs_revision**：门禁事实行（`env-doctor.ts:739` 的 node-version detail）仍然写着「先在终端里选一个版本」                  | §5   |

---

## 2. 四道门禁（最终树现测，原始输出）

| 门禁         | 命令                                | 退出码 | 关键输出                                                                                                                                                                                                        |
| ------------ | ----------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typecheck    | `npm run typecheck`                 | **0**  | 三段（main / renderer / node）无输出                                                                                                                                                                            |
| lint         | `npm run lint`                      | **0**  | `eslint .` 无告警                                                                                                                                                                                               |
| format:check | `npm run format:check`              | **0**  | `All matched files use Prettier code style!`                                                                                                                                                                    |
| 沙箱自检     | `node scripts/selftest-sandbox.mjs` | **0**  | `250/250 项通过` + 自动收录 2 个脚本（`env-doctor-cases.mjs` **20/20**、`env-wizard-cases.mjs` **164/164**，退出码都 0）+ `清理：清单 40 个路径 → 删掉 40 个` + `清理后仍多出来的文件：0 个` + `自检门禁：通过` |

原始日志：`.verify/t40-gates/{typecheck5,lint5,format5,selftest-sandbox5}.log`（写入时走 `cmd /c … 1> file`，
**原始字节**，没有经过 PowerShell 的编码往返；本文里所有含中文的断言名都是从这些日志里按 UTF-8 读出来的）。

树定格：**64 个源文件逐个 SHA256 的聚合 = `f8f4df65042bf7cd5c0a096cbb8776f461812915a355397eefb0c8ccbd315f84`**
（测量窗口前后两次一致；`git status --porcelain` 前后 diff = 0；`scripts/env-wizard-cases.mjs` 在本轮被我改过，
所以它与 t32 那轮的 `e7d79ab2…`、本轮开头的 `0acbb07a…` 不是一个值 —— 口径是"同一窗口内前后一致"）。
清单与口径见 `.verify/t40/freeze-{I,J}.txt`（`src/**` 的 `.ts/.vue/.html/.css` + `test/**/*.ts` + `scripts/**` +
`tools/**` + 三份根配置；t32 那轮是 56 个文件、不含 `tools/` 与根配置）。

**口径声明**：上面那次四道门禁跑在"`scripts/` 与 `docs/` 的改动都已完成"的树上；此后我又改了**这份文档自己的文字**
（只补了一段证据说明与两处措辞）。`docs/` 不参与编译与自检 —— 自检只读 `docs/env-wizard-freeze.md` 一处
（`test/selftest.ts:3728`），**不读本文件** —— 而 `format:check`（Prettier 覆盖 `docs/`）在最后这次改动之后
又跑了一遍、exit 0；编码体检（§3.3 那把尺）也在这份文档上跑过：合法 UTF-8、0 个 U+FFFD。

---

## 3. `test/selftest.ts`（4593 行）乱码事故后的重建 —— 独立复核（本轮重点）

实现者报告：它用 PowerShell（`Get-Content -Raw` + `WriteAllText`，非 UTF-8 代码页）
把整份 `test/selftest.ts` 写成了乱码，随后用**出错前的编译产物** `.verify/cases-build/test/selftest.js`
当 oracle 重建了全文，并给了三条自证。**我这一轮不采信那三条自证**：它留在 `.tmp/` 的两个脚本
（`audit-log-diff.cjs` / `diff-build.cjs`）现在**根本不存在**（`.tmp/` 整个目录都没有）—— ⚠️ **第六轮更正**：它们**存在**，在**仓库外的工作区根** `../.tmp/`（本轮核实有 71 个文件；我当时只按仓库根找，所以找不到）。**我没有采用它们的任何输出**，这一个事实不受影响，详见第六轮 §6。所以下面四条
证据链全部是我这一轮自己写、自己跑的。

### 3.1 我用的是哪两条独立证据链

1. **编译产物逐行比对**（我自己的 Myers diff，`.verify/t40/myers-diff.mjs`；先做 400 组随机小样本自校验：
   把 diff 结果重放回去必须还原出新文件，才允许拿去比真文件）。
   - oracle：`.verify/cases-build/test/selftest.js`（**mtime 14:03:33**，t37 收尾时的编译产物 —— 早于事故）
   - 待验：我这一轮用 `tsc -p tsconfig.node.json --outDir .verify/t40-build` 现编的产物（mtime 15:13 之后）
   - **工具链可比性先证明过**：5 个"14:03 之后没改过"的源文件，新鲜编译的产物与 oracle **逐字节相同**
     （`session-archive` / `plugin-manager` / `ipc` / `release-notes` / `settings`）—— 否则这个比对没有意义。
2. **source map 的原始行号比对**（`.verify/t40/map-align.mjs`）：tsc 的 `mappings` 为每条生成代码记下它在
   原始 TS 里的行列。把两份 map 解码、按同一批生成语句对齐，看 `(新源行号 − 旧源行号)` 有没有在**非改动处**
   出现台阶 —— 这一条专门用来抓"注释/空行被悄悄删掉"（编译产物能证明注释文本，但证明不了行结构）。

**一个关键前提（决定了这条证据链有多强）**：`tsconfig.base.json` 里 `removeComments: false`，
所以编译产物**带着注释**（oracle 里就有 `/** … */` 与 `// …`）。也就是说，"注释文本有没有丢"
同样能用证据链 ① 证明，不需要"只能相信"。

### 3.2 证据链 ① 的结果：只有 5 行不同，且全部对得上 t39 有意改的两处

| 指标                                 | 值                                                        |
| ------------------------------------ | --------------------------------------------------------- |
| oracle 编译产物                      | 3082 行                                                   |
| 现树编译产物                         | 3275 行                                                   |
| 逐字节相同的行（Myers 的 `eq`）      | **3077**（3077 / 3082 = **99.84%** 的 oracle 行原样还在） |
| 只在 oracle 里出现（**可能被删的**） | **5 行**（逐条列在下面）                                  |
| 只在现树里出现（新增）               | **198 行**（= 14 + 3 + 181，逐条列在下面）                |
| hunk 数                              | **3**                                                     |

**那 5 行是什么**（我把它们全列出来，不做概括）：

```
- 2998  const recheckBody = methodSlice(installerCode, 'private recheckSymlinkLanded(): boolean');
- 3003  settleBody.indexOf("publish('waiting'") < settleBody.indexOf('recheckSymlinkLanded()') &&
- 3006  /recheckSymlinkLanded\(\)[\s\S]{0,400}kind: 'ok'/.test(settleBody) &&
- 3022  // VM 实测那句是在"没有 active version"时出现的 —— 它**不许**被当成可用
- 3023  !nodeInstaller.hasNodeVersionOutput('No active Node.js version is configured. Run `nvm install <version>` then `nvm use <version>`.'));
```

前三条是 **t39 明说的改名**（`recheckSymlinkLanded` → `recheckActiveNodeLanded`，新名在现树里、
`test/selftest.ts:4251/4257/4260`）；后两条是我逐个读过现树对应位置（`test/selftest.ts:4275–4289`）
之后确认的**同一个断言被加长**：那句字面量还在（现树 4281–4283 行），只是后面又加了
`isInactiveNodeShimOutput` 的正反两条（4284–4288）。**两条都是"变强"，不是"变弱"。**

**那 198 行新增**：14 行 = 新助手 `methodSliceOf`（注释 + 函数，`test/selftest.ts:2179–2191`）；
3 行 = 改名后的三条新行；181 行 = 新增的 `18c. nvm v2 的真实模型（VM-11 / VM-12）` 段
（`test/selftest.ts:4290–4518`，含 8 条新检查）。**没有任何一行新增落在别的区域。**

**证据链 ② 的结果**：原始行号差只有 **6 段**（Δ = 0 → 13 → 14 → 15 → 16 → 250），台阶位置与我读到的
三处改动**一一对应**：

| 台阶       | 从哪个生成行起 | 对应的事                                                                           |
| ---------- | -------------- | ---------------------------------------------------------------------------------- |
| Δ=0        | 生成行 1       | 文件开头到 `methodSliceOf` 之前：**行结构完全一致**                                |
| Δ=13       | 1476           | 新增 `methodSliceOf`（13 行）                                                      |
| Δ=14/15/16 | 2120/2308/2648 | 三处各多 **1 个空行**（新源 3044 / 3285 / 3752，都在 `// …` 注释之后、表达式之前） |
| Δ=250      | 3217           | 新增 18c 段（234 源行）                                                            |

oracle 的最后一条映射落在它那份 TS 的第 4343 行，现树是 4593 行 —— 差 250 行，与 Δ=250 自洽。
**多出来的只有 3 个空行**（生成代码一致、源行号只 +1），既不是"少注释"也不是"少语句"。

### 3.3 编码体检（4 个被 t39 动过的文件，用我自己写的尺）

`.verify/t40/enc-scan.mjs`：① 文件字节是否合法 UTF-8（重新编码必须逐字节相同）、有无 BOM / CRLF；
② `U+FFFD` / 孤立代理 / 非法控制字符；③ "乱码字母表"检测 —— 把正文里的 CJK 字符按 UTF-8 编码、
再用 CP936 解码，得到的就是"UTF-8 中文被当 GBK 读"会产生的那批字符，正文里若残留乱码就会命中。

| 文件                         | 合法 UTF-8 | BOM | U+FFFD | 乱码字母表命中 |
| ---------------------------- | ---------- | --- | ------ | -------------- |
| `test/selftest.ts`           | ✅         | 无  | **0**  | **0**          |
| `src/main/node-installer.ts` | ✅         | 无  | **0**  | **0**          |
| `src/main/env-doctor.ts`     | ✅         | 无  | **0**  | **0**          |
| `src/main/process-utils.ts`  | ✅         | 无  | **0**  | **0**          |

**阳性对照（证明这把尺不是恒绿）**：

- `.verify/main.ts.broken`（t15 那次事故的坏文件，一直在 `.verify/` 里）：合法 UTF-8 = **false**、`U+FFFD = 475`；
- 合成的乱码文件（`.verify/t40/synthetic-mojibake.ts`，由同一份脚本生成）：`U+FFFD = 3`、乱码字母表命中 2 个（瀹 / 宸）。

> **本文档自己也有 2 个乱码字母表命中**（`瀹` / `宸`，各出现 2 次、共 4 次 —— 第六轮的最终稿）—— 就是上一行这两个**被引用的例子字符**本身，
> 不是文档被写坏；同一把尺扫 `scripts/env-wizard-cases.mjs` 是 0 命中。写在这里，免得下一轮的人
> 看到这 2 个命中先怀疑文档本身。

> **顺带记一条方法论**：我这一轮自己踩了一次同一类坑的**轻量版** —— 用 PowerShell 的 `>` 重定向
> 写日志（`node … 1> x.log`）会写成 UTF-16LE，中文断言名全变问号 + 每个字符间插一个空格。
> 同一件事用 `cmd /c "… 1> x.log"` 就是原始字节。**这就是 t39 事故的同一个根因**：
> 含中文的源文件不该经过 PowerShell 的文本读写，只走 read/edit/write 工具或 `cmd` 的字节重定向。

### 3.4 结论：**哪些能证明、哪些只能相信**

**能证明（我这一轮自己跑出来的）**：

1. 事故前（14:03:33）那份 `test/selftest.ts` 的**每一行代码与每一段注释文本**都还在现树里 ——
   3077 行逐字节相同，5 行不同全部指向 t39 有意改的两处（改名 3 行 + 同一断言加长 2 行）。
   这一条之所以能覆盖注释，是因为 `removeComments: false`。
2. 行结构：从文件开头到 2178 行**完全一致**；后面只有 3 个多出来的空行 + 两处有意新增。
3. 4 个被 t39 动过的文件没有编码残留（0 个 U+FFFD、0 个乱码字符），且这把尺对 t15 那次事故的真坏文件
   （`.verify/main.ts.broken`）与合成乱码都会命中。
4. 断言项数只增不减：0 条名字丢失、0 条同名状态变化、8 条新增（8 条名字我逐条列在 §6.2）。

**只能相信（现存产物里没有任何 oracle 能证明）**：

1. **t39 在 14:03:33 之后、事故之前对 `test/selftest.ts` 做的改动本身**（18c 段 234 源行 +
   `methodSliceOf` 13 行 + 3 处改名 + 3 个空行）**没有事故前的产物可比**。
   我能证明的是：它们确实在现树里、8 条新检查真的在跑、逻辑不是恒真（我逐行读过 4290–4518）、
   与 t39 自述的三处改动一致、**除此之外没有任何东西被删**；
   我**不能**证明"恢复稿与事故前那一份逐字相同" —— 例如某条注释的措辞、某个夹具里数值的写法，
   理论上可能被恢复成"等价但不同"的文本（尤其在"只能人判"的那 92 处）。
2. 这 3 个空行：能证明"多出来的只有空行"，不能证明"事故前那三个位置当时是不是空行"。
3. 事故窗口里是否还短暂写坏过**别的**文件又改回来：没有任何历史产物，无法证明。

归根结底：**"没丢东西"是证明，"逐字还原"是相信。** 前者的风险面已被压到"18c 段 + 一处助手 + 3 处改名"
这一块；后者只影响措辞与排版，不影响任何断言的存在与强度。

---

## 4. nvm v2 的 shim 模型（VM-11 / VM-12）

### 4.1 模型从真实证据推（不看 `NVM_HOME` / `NVM_SYMLINK`）

我把客机状态喂给**我自己编的**产物（`.verify/t40-build-main`，`tsc -p tsconfig.main.json`），
`.verify/t40/vm11-drive.mjs` 的输出（原文）：

```
model = { exe: …\Author Software\nvm\nvm.exe,
          root: …\AppData\Local\Author Software\nvm,
          mode: "shim",
          installsDir: …\nvm\installs,
          activeDir: …\nvm\.nodejs,
          evidence: [ "nvm 命令：…\nvm\nvm.exe", "模式：shim（nvm env 说的）",
                      "版本目录：…\nvm\installs", "当前 Node 的目录：…\nvm\.nodejs（node.exe 在）" ] }
env 里有 NVM_HOME/NVM_SYMLINK 吗 = false
nvm list（客机原文）= {"versions":[],"active":null}
```

`detectNodeOwner('…\Author Software\nvm\.nodejs\node.exe', {})`（**空环境**）也返回 `nvm` ——
判据是路径里的 `nvm` 段，不是那两个变量；`volta` 那类仍然返回 `unknown`，系统 Node 返回 `system`。

> **t4（第七轮）就地标注 —— 上面那两行里的调用形状已经过期，结论仍然成立（原文保留）**：
> t29 把 `detectNodeOwner` 改成了**对象入参** `{ nodePath, env, model, msiInstallPath }`、返回 `{ owner, evidence }`（冻结 §4.2），
> 所以那行裸调用写法是历史记录，**不要再照抄**。同样这几组输入我在第七轮用新形状重跑过
> （`scripts/env-wizard-cases.mjs` 的 C1–C8 / N4e / O1–O4，以及真调 `plan()` 的 A0–C4）：
> 空环境的 `.nodejs` 那份仍是 `nvm`、`volta` / `fnm` 仍是 `unknown`、系统 Node 仍是 `system` ——
> **结论没变，只有调用形状与判据的入参变多了**（新形状还接 `model` 与 MSI 的 `InstallPath` 两条正面证据）。

### 4.2 「应用自己装版本」是真执行（读代码 + 行为两半）

- `installNodeWithNvm()`（`node-installer.ts:2264`）：先 `refreshProcessPathFromSystem()` → `probeNvmModel()`
  （`nvm.exe` 真路径 + `nvm env` + 注册表偏好 + 用户级 PATH）→ `readNvmList()` 盘点 →
  没装就 `runNvmCommand(exe, ['install', 版本])` → **再问一次** `nvm list` 核对版本真的在清单里 →
  active 不是它就 `useNvmVersion()`（`['use', 版本]`）→ 再刷一次环境 → `verifyActiveNode()`。
- `runNvmCommand()`：`spawnSpec(launchSpec(nvm, args, 'win32'), extra)` —— 数组 argv、不经 shell；
  **stdout / stderr 分开收**；`outcome.code !== 0` 就按退出码分类失败；每条命令都调 `logNvmStep()`。
- 复检判据是**真的能跑**：`probeCommand(node, ['--version'])` 有版本号输出、且不是 shim 那句
  `No active Node.js version is configured…`（`isInactiveNodeShimOutput` 专门认它），npm 同样要
  `--version` 有输出；`nvm list` 的 active 只记日志、不当判据。
- 「每一步留证据」**行为验证**（不是读代码）：我用真 `NodeInstaller`（hooks 是桩）调了一次
  `logNvmStep('nvm install', ['install','24.21.0'], 1, 'Downloading Node.js 24.21.0…', '')`，
  落进日志的那一行是：
  `nvm install：nvm install 24.21.0 → 退出码 1；stdout：Downloading Node.js 24.21.0…；stderr：（空）`
  —— 命令 / 退出码 / stdout / stderr 四项都在，空的那路是「（空）」。

### 4.3 VM-12：界面只报真实路径

```
findNodePathWindows(客机) = …\Author Software\nvm\.nodejs\node.exe
那条推测路径             = …\Local\Software\nvm\nodejs\node.exe   ← 绝不能上屏
windowsBinCandidates 里有 .nodejs 吗 = true
只有不存在的 PATH 目录时 = null
```

计划侧的 `target` 同样只从真实证据来：`whichSync('nvm')` 的真目录 → 或 `NVM_HOME` → 都没有就
**不报路径**（只说"安装程序会让你选目录"，`node-installer.ts:1936–1941`）。

### 4.4 我补进 `scripts/env-wizard-cases.mjs` 的 N 段（14 条）

`150 → 164` 条（`N0` 是"导出缺失就早红"的守门条，`N1–N9` + `N4b–N4e` 是行为/静态断言）：

- **N1/N2**：分节（客机）与扁平（官方样例）两种 `nvm env` 排版都认，**两个 `Path` 不混**
  （`Installation→程序根`、`Installed Versions→版本目录`）；扁平样例没有版本目录时 `installsDir` 必须是 `null`。
- **N3**：`nvm list` 的 v2 单行（`* 24.1.0 (default) 22.14.0 20.19.1`）、v1 逐行、
  `No versions installed.` / `No installations recognized.` 两种空清单。
- **N4 / N4b / N4c / N4d / N4e**：模型从真实证据推（客机 `env` 里根本没有那两个变量）；
  只有 PATH 两条时也推得出根与 `.nodejs`；**没有任何证据时必须是 `null`**（不许凭空造根目录）；
  只有 `NVM_SYMLINK` 时也是 `null`（软链目录不是管理器的根）；真有 `NVM_HOME`/`NVM_SYMLINK` 的 v1 机器照旧认
  （`link` 模式、当前版本取软链目录）；`detectNodeOwner` 按路径判。
- **N5**：注册表偏好键名从**真根目录**推（`…\Author Software\nvm` → `HKCU\Software\Author Software\Preferences\nvm`）。
- **N6**：VM-12（见 §4.3）。**注意口径**：冻结文档允许"推测的候选留在候选表里"，所以我不断言
  "候选表里没有那条推测路径"，只断言**"它不存在时不许被返回"** —— 断的是行为，不是实现选择。
- **N7**：shim 那句被判成 `nvm-inactive`，**引擎侧**给出的 message / hint 里一个字都没有"终端"，
  安装引擎源码里也没有"自己打开终端"。
- **N8**：§4.2 那条日志行为。
- **N9（静态）**：shim 分支排在 `runElevated` 之前且写明不请求提权。

**变异实验**（`.verify/t40/n-mutation-prep.mjs`，把我的编译产物复制两份各改一处实现，用
`ENV_WIZARD_BUILD_DIR` 指过去跑）：`mutA`（`deriveNvmModel` 没证据时也造根目录）→ **N4c 红**；
`mutB`（`findNodePathWindows` 直接返回推测路径）→ **N6 红**；基准 164/164 绿。
日志：`.verify/t40/cases-{mutA,mutB}-final.log`。

**这些断言覆盖不到的地方（必须说明）**：真机上的 `nvm install` 真的下载与切换、v1 链接模式的 UAC ——
见 §8。N 段证明的是"模型推得对、命令序列与判据对、日志有证据"，不是"客机上真的装成功"。

---

## 5. F-05 / VM-13：门禁事实行仍然把人打发去终端（needs_revision 的那一条）

**现象**（我用客机状态驱动判定函数打印出来的原文，`.verify/t40/vm11-drive.mjs` 输出）：

```
gate=blocked  currentStepId=node
[node] status=todo  fixAction=null
  detail: 找到了 Node（C:\Users\tester\AppData\Local\Author Software\nvm\.nodejs\node.exe），
          但它跑起来没有任何输出（退出码 1）—— 这份 Node 现在用不了；版本管理器还没选中一个版本时
          也是这个样子（先在终端里选一个版本，或重装官方 Node）
含「终端」= true   含「重新检测/一键」= false
```

这一行不是日志，是**门禁卡片上的事实行**：`env-doctor.ts:739` 拼出这句 →
`judgeWizard()` 取三步里最重的那一行的 `detail`（node 步骤的 `rowOf('node-version')`）→
`EnvGate.vue` 的 `currentFacts` 直接把它渲染成 `.gate-fact-detail`（`EnvGate.vue:1122`），
而路由到这里的正是客机那个状态（`node` 有文件、`node-version` 是 `missing`）。
也就是说：门禁一边给出「直接安装官方版本 / 用版本管理器安装」两条一键路，一边在事实行里说
「先在终端里选一个版本」——**这正是 VM-11 里用户问的那句话**。

**为什么算 t39 的缺口**：t39 的验收第 2 条明写「**不许再把用户打发去终端**——这正是用户在虚拟机里问的那句话」，
而 `src/main/env-doctor.ts` 就在 t39 的 inScope 里。t39 改掉的是**引擎侧**的 `FAILURE_HINTS['nvm-inactive']`
（现在写的是"我们会自己挑一个稳定版装好并切过去"，我验过，干净），**漏掉了 env-doctor 这句事实文案**；
t39 新加的断言也只看 `installerCode`（安装引擎源码），没有覆盖 env-doctor 的用户可见文案。

**为什么仍判 needs_revision（而不是 pass + 备注）**：这是一条用户可见的、与实现能力**互相矛盾**的文案，
且踩在验收条目的原文上。功能链路（§4）没有问题，属于**一句话 + 一条断言的修**：

- 必需修：把 `env-doctor.ts:739` 的括号那句改成指向应用自己的动作（例如"这一步可以由我们自己装一个版本，
  点下面的按钮就行"），或者在能推出"版本管理器在但零版本"时**换一句** detail；
- 必需加的可回归断言：把"界面可见文案里不出现'先在终端'"的覆盖面从安装引擎扩到 env-doctor 的用户可见文案
  （现有断言只扫 `installerCode`）。

**我为什么没有把它写成一条会红的断言**：`scripts/env-wizard-cases.mjs` 会被门禁自动收录，
写红会让四道门禁在修好之前一直红着（其他成员的收尾也会被挡住），而这条缺陷的修复面很小。
所以我在 N 段用 `observe()` 留了一条**显式附注**（门禁输出里会打印），把"已知缺口 + 证据位置"钉在那里；
修好之后那条附注应当被换成一条真断言。

---

## 6. 断言完整性（0 条删除、0 条放宽）

### 6.1 自检（`test/selftest.ts`）

`.verify/t40/name-diff.mjs` 把**出错前**那次门禁日志（`.verify/t34-gates/selftest-sandbox.log`，14:10:53）
与**我这一轮**的日志（`.verify/t40-gates/selftest-sandbox5.log`）逐条对名字：

```
OLD: PASS 242 / SKIP 4 / FAIL 0
NEW: PASS 250 / SKIP 4 / FAIL 0
丢失（旧有、新无）: 0        新增（新有、旧无）: 8        同名但状态变化: 0
```

**"同名但状态变化 0"很关键**：`PASS → SKIP` 这种"把跑不动的检查降级成跳过"是最典型的放宽手法，
这一轮一条都没有。另外 §3.2 的逐行比对保证了这个区间里**没有一条既有断言的判据被改弱**
（改了就会变成 `-`/`+` 行对）。

### 6.2 那 8 条新增（逐条列出，全部 PASS）

1. ``安装引擎：`nvm env` 的两种真实排版都认（分节的客机报告 + 官方样例），两个 Path 不混``
2. ``安装引擎：`nvm list` 的 v2 单行形状也认（星号是 active + 空格分开的一串）``
3. `安装引擎：v2 的模型从**真实证据**推（不依赖 NVM_HOME / NVM_SYMLINK）`
4. ``安装引擎：v2 的注册表偏好（`HKCU\Software\<发布商>\Preferences\nvm`）按真根目录推键名并解析``
5. `安装引擎：nvm 的每一步都留证据（命令 / 退出码 / stdout / stderr，空的那路写「（空）」）`
6. `安装引擎：应用**自己装版本**（选版本 → nvm install → nvm use → 实测），不把用户打发去终端`
7. `安装引擎：shim 模式（v2）不请求提权（官方说明：shim 无符号链接、不需要管理员）`
8. `首启门禁：界面上报的 node 路径一定是探测到的真路径（VM-12）`

第 6 条只扫了 `installerSource` —— 这就是 F-05 逃过去的缝隙（见 §5）。8 条我都读过实现，
没有一条是恒真（例如第 3 条要求 `model !== null` 且 `root/mode/installsDir/activeDir` 四项逐一相等，
第 8 条要求"那条不存在的推测路径不被返回"且"只有不存在的目录时返回 null"）。

### 6.3 `SKIP 4` 到底是什么（不是新增的放宽机制）

| 日志（轮次）                                        | PASS    | SKIP  |
| --------------------------------------------------- | ------- | ----- |
| t8（`.verify/t8-gates/selftest-sandbox-final.log`） | 208     | 4     |
| t16                                                 | 212     | 4     |
| t20                                                 | 224     | 4     |
| t32                                                 | 242     | 4     |
| t34                                                 | 242     | 4     |
| **t40（本轮）**                                     | **250** | **4** |

四条的**名字逐条相同**，自 t8（阶段一首次门禁）起就在：它们跳过的是
①「PATH 里没有 dsh 也能从全局安装目录找到 bin.js」（本机没有可用的 node/dsh 时会抛）、
②「解析出的解释器实测能跑 dsh」（本机没有能跑 dsh 的 node）、
③「端口占用查询（真实系统命令）」、④「状态机：外部 PID」——
后两条是"沙箱不允许起子进程"。机制本身在 `test/selftest.ts:58` 的 `skip()`：每条 skip 都有 `else` 分支
**真的跑那条检查**（例如第 ②条的 `else` 就是 `canRunDsh(launch.file, launch.args[0])`），
在没有这些环境限制的机器上就是 PASS。**所以：SKIP 是环境分支，不是"把检查关掉"**；
而且 6 轮下来 0 条 `PASS → SKIP` 的降级。

> 一个边界提醒：`250` 与 t34 那轮的 `242` 之间多出来的**正好是 t39 的 8 条**（§6.2），
> 再往前 `236 → 242` 的 6 条属于 t37（VM-09）与更早几轮，不在本轮范围。

---

## 7. `.changeset/` 与 `docs/` 没有被 t39 影响

| 目录                | 最新 mtime                                        | t39 的改写窗口 | 结论   |
| ------------------- | ------------------------------------------------- | -------------- | ------ |
| `.changeset/`       | `env-wizard-gate.md` **14:08:05**                 | 14:40–15:06    | 未触碰 |
| `docs/`             | `env-wizard.md` / `env-doctor.md` **14:10:15**    | 同上           | 未触碰 |
| `src/shared/ipc.ts` | **12:04:38**（不在"14:03 之后改过"的 4 个文件里） | 同上           | 未触碰 |

对照：t39 动过的 4 个文件里，`process-utils.ts` 14:40:49、`env-doctor.ts` 14:43:28、
`node-installer.ts` 14:43:33、`test/selftest.ts` 15:05:22。
**契约与冻结文档的逐字一致性**这一轮因此没有新增风险：`src/shared/ipc.ts` 与
`docs/env-wizard-freeze.md`（13:22:28）都早于这个窗口，而自检里那条
「契约（F-03）：ipc.ts 与冻结 §3.1~§3.4 的逐字块完全一致」在本轮现测里是 PASS（§2 的 250 条之内）。
**我另外又跑了一遍阶段一那份逐字比对脚本**（`.verify/t8-contract-compare.mjs`，exit 0，
日志 `.verify/t40/contract-compare.log`）：冻结文档 §3.1 / §3.2 / §3.3 / §3.4 / §3.7 五个代码块
**整体逐字匹配 = 是、归一化后找不到的行 = 0**，成员级 13 项全部一致，7 个新通道在
`main.ts` 与 `preload.ts` 两侧都在，两个新设置项在文档块 / `ipc.ts` / `DEFAULTS` 三处都在，
`ipc.ts` 的 import 语句 = 0 条，**差异条目合计 0**。

---

## 8. 沙箱里无法执行的（「不可验」清单，逐条给期望的真机证据形式）

| #   | 不可验的事                                       | 为什么不可验                                       | 期望的真机证据形式                                                                                                                                                 |
| --- | ------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 客机上 `nvm install <版本>` 真的下载并装好       | 沙箱禁止"带管道 stdio 的子进程"；本机也没有 nvm    | 客机 `<userData>/logs/console.log` 里出现 `nvm install：nvm install 24.x.y → 退出码 0；stdout：…Installed Node.js v24.x.y…`，且 `<root>\installs` 下真出现版本目录 |
| 2   | `nvm use` 真的切过去并让 `.nodejs\node.exe` 能跑 | 同上                                               | 同一份日志里 `nvm use … → 退出码 0；stdout：Now using Node.js v24.x.y by default.`，随后 `实测：…\.nodejs\node.exe --version → v24.x.y`                            |
| 3   | 复检通过之后门禁真的放行（客机端到端）           | 需要真机 + 真 nvm                                  | 门禁卡片从"挡住页"变成"放行页"，且 `.nodejs\node.exe` 那条路径是唯一被报出来的 node 路径                                                                           |
| 4   | v1 链接模式那一次 UAC 真的弹出来                 | 沙箱里没有真 UAC；只验了分类与文案                 | 一次真实 UAC 弹窗 + `runElevated` 的四种结果里至少 `ok` / `declined` 各一次，日志里有对应那一行                                                                    |
| 5   | v2 的 shim 模式确实"不需要管理员"                | 需要非管理员账户 + 真 nvm v2                       | 非管理员账户下走完 ①②③ 而不出现 UAC（这一点官方说明与客机日志都支持，但本轮没有亲自跑过）                                                                          |
| 6   | `nvm env` 整段文本的逐字形态                     | 客机那份是分节版、我们只拿到结构；夹具是**重建**的 | 客机 `nvm env` 的逐字输出（`>nvm env 2>&1`），用来核对我这份重建的排版与键名                                                                                       |
| 7   | 界面观感（F-05 修完之后的文案是否不再误导）      | 观感只能人看                                       | 真机上打开应用进入门禁卡片，确认事实行不再出现"终端"字样、且与两条安装路并列时读起来一致                                                                           |

---

## 9. 我这一轮实际跑了什么（清单）

1. 树干净性：`git status --porcelain`（无就地 `.js` 产物；`src/`、`test/` 下 0 个 `*.js`/`*.map`）、
   关键文件 mtime、`.verify/` 与 `.tmp/` 的内容核对（⚠️ **第六轮更正**：仓库根的 `.tmp/` 确实不存在，但工作区根的 `../.tmp/` 存在且有 71 个文件 → 实现者的自证脚本**跑得起来，我没跑**）。
2. 定格：`.verify/t40/freeze.mjs`（64 文件 SHA256 聚合，测量窗口前后两次一致 + `git status` 前后 diff 0）。
3. 四道门禁：`npm run typecheck` / `npm run lint` / `npm run format:check` / `node scripts/selftest-sandbox.mjs`
   （全部原始退出码 + 原始日志，日志用 `cmd /c … 1>` 写字节）。
4. 事故重建复核：`myers-diff.mjs`（含 400 组自校验）、`map-align.mjs`、`step-locate.mjs`、`enc-scan.mjs`
   （+ 两个阳性对照：t15 的坏文件、合成乱码文件）。
5. nvm 链路：读 `node-installer.ts` 的 `deriveNvmModel` / `probeNvmModel` / `installNodeWithNvm` /
   `runNvmCommand` / `useNvmVersion` / `verifyActiveNode` / `buildNvmPlan`；`vm11-drive.mjs` 用客机状态
   驱动我自己编的产物并打印门禁那几行；`enc-scan` 顺带确认这几个文件没有编码残留。
6. 我自己的反例脚本：给 `scripts/env-wizard-cases.mjs` 增加 N 段（150 → 164 条）+ 两次变异实验。
7. 交叉核对：`name-diff.mjs`（断言名字集合差）、`git log --oneline -- test/selftest.ts`、
   git 对象库里 150–300 KB 的 blob 检查（**没有**任何一份 selftest 的旧 blob 可当 oracle）、
   VS Code / Cursor 的 local history（**没有**这个仓库的记录 → 注释没有第三方 oracle，见 §3.4）。

**没有采用的东西（明说）**：实现者留在 `.tmp/` 的 `audit-log-diff.cjs` / `diff-build.cjs`（⚠️ **第六轮更正**：它们存在，在仓库外的工作区根，我没有采用）、
它自证里的 99.8% / 0 丢失 / U+FFFD 为 0（我用**自己的方法**重算成了 99.84% / 0 / 0，数字相近但来源独立）、
以及任何成员时期的旧门禁输出（除了"出错前那份日志"作为**对照输入**）。

---

## 第四轮及更早

## 第四轮（t32）报告（原文保留）

> **状态（t34 集成收口补记 —— 那棵树上的现测）**：这份报告是**第四轮（t32）**的记录，结论（verdict = pass、
> 0 条 finding、VM-06 / VM-07 关闭）在当时有效。正文里的项数是**那一刻**的值（`236/236`）：同一棵树上
> t37 随后改了「装出来的 pnpm 跑不起来」的判定（VM-09：缺 VC++ 运行库 → 换纯 JS 那条线）与安装规格，
> 自检与反例脚本因此增长。t34 在**冻结后的最终树**上复测四道门禁：**242/242 + 20/20 + 150/150、
> typecheck / lint / format:check 全 0、清理 40 删 40 且 0 残留**（原始日志 `.verify/t34-gates/`）。
> **本文里出现的自检项数一律是"那一轮"的值** —— 最新的在本文最上面那份第五轮报告里。

| 项       | 值                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| 验证者   | verifier（t32，第四轮）                                                                                              |
| 被验产物 | t31 的「一键装 pnpm 装出来能不能真的跑」+「同一次运行内刷新」、最终树、以及 `scripts/env-doctor-cases.mjs` 的 G 同步 |
| 时间     | 2026-09-19（本轮现测；**没有引用任何成员时期的旧输出**）                                                             |
| 结论     | **verdict = pass**（0 条 finding；VM-06 / VM-07 关闭，四道门禁全绿）                                                 |
| 四道门禁 | typecheck 0 / lint 0 / format:check 0 / 沙箱自检 **exit 0**（236/236 + 20/20 + 150/150，自动收录 2 个脚本）          |

复现命令（都在 `dsh-console/` 下）：

```bash
npm run typecheck && npm run lint && npm run format:check
node scripts/selftest-sandbox.mjs                      # 第四道门禁（含自动收录的两个反例脚本）
node .verify/t32-vm07-drive.mjs                        # VM-07：同轮刷新后当场翻面的独立驱动
node .verify/t32-failure-log.mjs                       # 失败路径日志里有 npm 原文 + 界面文案干净
node scripts/env-doctor-cases.mjs                      # 阶段一 20/20（case G 已同步到新 argv）
```

---

## 1. 结论

| 缺陷                                    | 来源     | 本轮现测的关闭证据                                                                                                                                                                                 |
| --------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **VM-06** 一键装出来的 pnpm 是坏的      | 用户真机 | §3：我在隔离 prefix 里真装了两份做对照 —— 跑过安装脚本的那份 `pnpm --version` = **12.4.2**，没跑的那份报 `not recognized`（占位脚本 2051 字节 vs 真二进制 44285952 字节）                          |
| **VM-07** 同一次运行内刷新不彻底        | 用户真机 | §4：受控 PATH 的子进程里，`refreshLookupPath([新装那份])` 之后 `findPnpmPath()` **当场改指**新那份，判定同一进程从 `blocked/todo` 翻成 `open/done`；「重开应用再检测一次」只在刷新后仍找不到时出现 |
| **case G 断言同步**（我负责的那条协同） | 船长裁定 | §6：`… i -g pnpm --allow-scripts=pnpm` 已逐字钉住（t36 做完，本轮复核仍在且 20/20）                                                                                                                |
| 断言未被放宽 / 删除                     | —        | §6：我那份脚本 148 → **150** 条，新增 2 条（K12 / K12b），唯一"改名"的 M9 是**由静态正则升级成行为驱动**（更强），0 条删除                                                                         |

---

## 2. 四道门禁（最终树现测，原始输出）

| 门禁         | 命令                                | 退出码 | 关键输出                                                                                                                                                                                      |
| ------------ | ----------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typecheck    | `npm run typecheck`                 | **0**  | main / renderer / node 三步无输出                                                                                                                                                             |
| lint         | `npm run lint`                      | **0**  | `eslint .` 无告警                                                                                                                                                                             |
| format:check | `npm run format:check`              | **0**  | `All matched files use Prettier code style!`                                                                                                                                                  |
| 沙箱自检     | `node scripts/selftest-sandbox.mjs` | **0**  | `236/236 项通过` + 自动收录 2 个脚本（`env-doctor-cases.mjs` **20/20** 退出码 0、`env-wizard-cases.mjs` **150/150** 退出码 0）+ `清理：40 删 40 / 0 残留` + `自检门禁：通过`，`[失败]` 行数 0 |

原始日志：`.verify/t32/{typecheck,lint,format,selftest-sandbox}.log`。

---

## 3. VM-06（装出来的 pnpm 是坏的）—— 关闭（**我自己的真机对照实验**）

**方法**：在**隔离 prefix** 里用真实 npm 装两份 pnpm，唯一差别是"pnpm 自己的安装脚本跑没跑"：

| 那一份                         | 装法                                                                          | `node_modules\pnpm\pnpm`（shim 指向的东西） | `pnpm.cmd --version`                                          |
| ------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------- |
| **脚本没跑**（= VM 的坏状态）  | `npm i -g --prefix <隔离目录> --ignore-scripts pnpm`                          | **2051 字节的占位脚本**                     | `'…\node_modules\pnpm\pnpm' is not recognized…`，**退出码 1** |
| **脚本跑了**（= 带开关的修复） | `npm i -g --prefix <隔离目录> --foreground-scripts pnpm --allow-scripts=pnpm` | **44,285,952 字节的 `pnpm.exe`**            | **`12.4.2`，退出码 0**                                        |

也就是说：**VM 里那句 `npm warn install-scripts … to allow these scripts once` 正好把状态钉在左列**（安装脚本被跳过 → shim 指向一个跑不起来的占位文件），而 npm 自己给出的放行方式（`--allow-scripts=pnpm`）把它翻到右列。`--allow-scripts` 是 **npm 自己**在输出里给的开关，**不是**为了让断言变绿才加的。

**宿主机不变量（这是"不改用户全局配置"那条老规矩的复核）**：

```
npm config get allow-scripts = ''（前后一致）
npm prefix -g              = D:\Node\nodejs（前后一致）
npm ls -g --depth=0        = 同一份清单（dsh / corepack / npm / pnpm@12.4.2，前后逐字一致）
```

`D:\Node\nodejs\node_modules\pnpm` 与 `pnpm.cmd` 的创建时间是 **2026-09-18 23:22**（昨天，早于本轮实验），所以它在清单里出现**不是我这次装出来的**；我的两次安装都落在 `.verify/t32/vm06/` 下（`--cache` 也指到仓库内），宿主机一份文件都没动。前后两份记录逐字相同：`.verify/t32/host-before.txt` / `host-after.txt`。

**沙箱边界（如实标注）**：`npm i -g pnpm --allow-scripts=pnpm`（实现产出的那条 argv）在本沙箱里**不能端到端跑完** —— npm 默认用**带管道 stdio** 的子进程跑安装脚本，而本沙箱禁止这种子进程（`spawn EPERM`，与 `scripts/build.mts` 记录的是同一个边界；原始 npm 调试日志在 `.verify/t32/npm-cache/_logs/`）。所以我用 `--ignore-scripts` / `--foreground-scripts` 这两种**显式**方式分别造出"脚本没跑"和"脚本跑了"两个状态，专门对照 **脚本执行这一步**；argv 里那条 `--allow-scripts=pnpm` 与 case G 钉住的形状逐字一致（`.verify/t32-failure-log.mjs` 的 L0 也把计划里那条 argv 打了出来）。

---

## 4. VM-07（同一次运行内刷新）—— 关闭（真输入驱动，`.verify/t32-vm07-drive.mjs`）

受控 PATH 的子进程里（PATH 只放"坏的那份" + 系统目录），跑实现自己的那条链：

```
[通过] S0 前置：坏的那份与好那份都真的存在
[通过] S1 受控 PATH 下：`findPnpmPath()` 先选中**坏的那一份**（= VM 里那一屏的起点）
[通过] S2 同一个进程里调 `refreshLookupPath([真能跑的那一份])`：新目录被排在最前（npm prefix 那份优先）
[通过] S3 刷新之后（**没有重开应用**）`findPnpmPath()` 改指新装的那一份
[通过] S4 判定当场翻面（同一进程、同一份 judgeWizard）：before = pnpm todo + 门禁 blocked → after = pnpm done + 门禁 open
[通过] S5 fixDoneMessage「实测通过」：不得出现「重开应用再检测一次」
[通过] S5 fixDoneMessage「没能实测（沙箱）」：不得出现「重开应用再检测一次」
[通过] S5 fixDoneMessage「找到了但跑不起来（VM-06 那一屏）」：不得出现「重开应用再检测一次」
[通过] S5 fixDoneMessage「刷新后仍找不到」：应当出现「重开应用再检测一次」
```

- **"当场翻面"是真的**：同一个进程、没有重启，`findPnpmPath()` 从坏的那份改指新那份（S2 的"新目录排最前"就是关键 —— 排后面会被 PATH 里旧的那份先选中，等于白刷），`judgeWizard` 从 `blocked/todo` 翻成 `open/done`。
- **"重开应用再检测一次"只在最后一种情形**：四种收尾文案逐个跑过，前三种（通过 / 沙箱测不了 / 找到了但跑不起来）都不出现那句。
- **沙箱边界**：`probeFixTarget` 要起子进程（本沙箱 EPERM → 它会报 `blocked`）。所以我**不拿它的 `blocked` 当"坏"的证据**；S4 用的版本号 `12.4.2` 是我在隔离 prefix 里**真跑**出来的那一份。

---

## 5. 失败路径的日志与界面文案（`.verify/t32-failure-log.mjs`）

用真实的 `EnvFixRunner`（导出类）起一次 stub 环境，直接调它的日志落盘方法，把 `hooks.log` 收到的行抓下来：

```
[通过] L0 计划本身带着一次性开关：C:\Program Files\nodejs\npm.cmd i -g pnpm --allow-scripts=pnpm
[通过] L1 实现自带的 install-scripts 警告正则认得出 VM 那句话
[通过] L2 日志里有「命令：<那一条 argv>」（含 --allow-scripts=pnpm）
[通过] L3 日志里有「退出码」与空的那一路写成「（空）」
[通过] L4 日志里有 npm 原文（install-scripts 那条警告逐字在里面，含 "to allow these scripts once"）
[通过] L5 界面那句「装出来是坏的」把**日志的完整路径**给了用户
[通过] L6 界面文案「失败归纳（install-scripts 原文）」不含内部术语（0 处命中）
[通过] L6 界面文案「收尾：找到了但跑不起来」不含内部术语
[通过] L6 界面文案「收尾：刷新后仍找不到」不含内部术语
```

日志里那一段的原文形如：

```
环境修复：这一轮没有装出可用的结果（下面是那一次的原文）
命令：C:\Program Files\nodejs\npm.cmd i -g pnpm --allow-scripts=pnpm
退出码：1
stdout：（空）
stderr：
npm warn install-scripts Ignored build scripts: pnpm@12.4.2.
npm warn install-scripts Run `npm install -g --allow-scripts=pnpm` to allow these scripts once, or
npm warn install-scripts `npm config set allow-scripts=pnpm --location=user` to allow them for all global installs.
```

VM-04 的口径（**细节留日志、结论给人话**）成立：原文在日志里，界面文案里 `PATH` / `dsh.cmd` / `npx` / `EPERM` / `install-scripts` 这类内部记号 0 处命中。

（一个**观察**、不是 finding：收尾那句为了说清"哪一路没话说"用了 `stdout` / `stderr` 两个词。它们不在冻结 §3.8 #22 的词表里，也不是用户机器上的路径 / 命令名，所以按 VM-04 的口径不算内部术语 —— 但如果船长认为"面向用户的文案连 `stdout` 都不该出现"，换成中文（"标准输出 / 错误输出"）是一处很小的改动，归属契约与编排。）

**实验产物的清理**：两份隔离安装合计 455.7 MB，我把其中 8 个重复的 42.2 MB 二进制删掉了（保留 shim、占位脚本、日志与前后记录 —— 清理后 49.8 MB，VM-07 驱动重跑仍然 exit 0）。§3 表里那句 `12.4.2` 是**清理之前**真跑出来的原文；要重现整份对照，按 §8 的两条 `npm i -g --prefix …` 重装即可（`.verify/t32/` 里留下了 `install-*.log`、`host-before/after.txt`、`vm07-probe.log`）。

---

## 6. 断言完整性（含我负责的 case G 同步）

- **case G（`scripts/env-doctor-cases.mjs`）**：两条断言已是新形状 —— `planG.display === '/usr/local/bin/npm i -g pnpm --allow-scripts=pnpm'`、`planG.args.join(' ') === 'i -g pnpm --allow-scripts=pnpm'`（**全等**，不是模糊匹配），标题保留「计划用完整 npm 路径且不经 shell」，断言旁写明 `--allow-scripts=pnpm` 是 VM-06 的修复本体、只挂在那一条 argv 上、不改用户全局配置；另多钉一条 `planG.note.includes('一次性')`。现测 **20/20 退出码 0**（本轮现跑，不是引用旧输出）。
- **我那份脚本（`scripts/env-wizard-cases.mjs`）本轮不是我先改的**：t20 我留下的是 92184 字节 / 148 条，现在文件是 97199 字节 / **150 条**（mtime 13:06:54）。按断言**名字**做集合对照（t20 的门禁日志 vs 本轮门禁日志）：
  - **上一轮有、现在没有的：0 条**（唯一"名字变了"的是 `M9 VM-01：…（-Verb RunAs）+ 用户拒绝（declined）分支都在` → `M9 VM-01 / F-02：… + 四种结果各自收场（**行为**，不只源码正则）`；我读了新块：原来那几条静态判据（`readDeveloperMode(` / `-Verb RunAs`）都还在，另外**新增**了 `classifyElevationOutcome` 四种结果与 `elevationFailure('timeout')` 的行为断言 —— 是升级，不是放宽）；
  - **新增 2 条**：`K12 inflight 兜底…`、`K12b 兜底之后新那一轮的结果照常并进相位机…`。
  - 结论：**没有任何既有断言被删除或放宽，条目只增不减**（148 → 150）。

---

## 7. 沙箱里无法执行的（「不可验」清单）

| 项                                               | 期望的真机证据形式                                                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 真实 `npm i -g pnpm --allow-scripts=pnpm` 端到端 | 在用户那台 VM 上点「一键装 pnpm」：日志里 `命令：… --allow-scripts=pnpm`、无 `Ignored build scripts` 警告；装完当场 `pnpm --version` 有输出、自检页 pnpm 变「正常」 |
| npm 的 install-scripts 门禁在真实 npm 上的行为   | 同一台 VM 上先跑一次不带开关的（对照）：期望出现 `npm warn install-scripts …`，且界面说"装出来是坏的"并给出日志路径                                                 |
| 真实 MSI 安装 / UAC 三态 / nvm 真机执行          | 同前几轮：干净 Win11 上 UAC 弹一次 → 进度可见 → 复检「正常」；三态各一次；`nvm install/use` 后注册表出现 `NVM_HOME` / `NVM_SYMLINK`                                 |
| 装完后本进程 PATH 与 `NVM_*` 刷新                | 装完**不重开应用**自检页就变「正常」（这轮用 S1–S4 在受控环境里验了机制，真机仍要看一次）                                                                           |
| 系统代理 / GitHub 匿名限流 / 安装器可见性        | 同前几轮（开代理仍能下载；限流给网络类 + 出路句；安装器窗口前台可见）                                                                                               |
| **界面观感与键盘可达性**                         | **只能由人在真机上看**（静态断言只能保证数值 / 文案没被改回去，不冒充"看起来对"）                                                                                   |

---

## 8. 树定格与并发归属（船长要求：56 个源文件的逐个 SHA256 汇总）

**定格集合**（56 个文件）：`src/**` 下的 `.ts/.vue/.css/.html`（52 个）+ `scripts/*.mjs`（3 个）+ `test/selftest.ts`（1 个）；
聚合方式 = 按路径排序后逐行 `相对路径  SHA256`，再对整串取 SHA256。清单落在 `.verify/t32/manifest-before.txt` / `manifest-after.txt`。

| 时点                               | 聚合 SHA256（56 文件）                                                          | 门禁                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **我 t32 那批测量**（13:57–13:58） | （当时未记录；那批日志在 `.verify/t32/selftest-sandbox.log`、`t32-vm07-drive`） | typecheck/lint/format 0 + 沙箱自检 **exit 0**（**236/236** + 20/20 + 150/150） |
| 船长插话后复测前                   | `a91f647e6b30a530e74a6d64e821967772131f5b2351b3c9b4f004d8d5b04941`              | 沙箱自检 **exit 1**：`235/236`（唯一红见下），20/20 与 150/150 仍绿            |
| 复测后                             | `fb4c711ae5dac2ee8316d1044728bc51a3c54b278cda0a1d1a6116d69ebfb6aa`              | —（我那两条驱动在同一次里都 exit 0）                                           |

**没有拿到"完全冻结的窗口"**：两份清单差 **1 个文件** —— `src/main/env-doctor.ts`（mtime **14:01:12**，复测过程中被 t37 又写了一次）。
也就是说 t37/t38 正在改这棵树；**我 t32 的原始测量（13:57）在 t37 这批改动落地（14:00）之前**，所以那批结论是"属于 t31 的冻结树"上的结论。

**唯一那条红（235/236）与归属**：

```
FAIL  环境向导：「更新 pnpm」就是既有的 install-pnpm（全局 npm 安装 argv 全仓库只有一处）
```

这条断言扫 `src/**/*.ts` 里有没有 `'i', '-g', 'pnpm'` 这个字面量、并期望**恰好一个**文件命中。
t37（VM-09：缺 VC++ 运行库时改走纯 JS 那条线）把构造点换成了变量：

```ts
? ['i', '-g', pnpmInstallSpec(vcRuntime), ALLOW_INSTALL_SCRIPTS_FLAG]   // env-doctor.ts:256
```

`'pnpm'` 现在是 `pnpmInstallSpec(vcRuntime)`（→ `PNPM_LATEST_SPEC` / `PNPM_PURE_JS_SPEC`），
于是那个字面量正则**一处都匹配不到**（实测 `false`）→ 断言红。**归属：t37（`wiring-dev`，落点 `src/main/env-doctor.ts` + `test/selftest.ts`）的在飞产物**，不是 t31 的问题。

**t31 的那部分在移动窗口两侧都稳**（复测时现跑，不是引用旧输出）：

- `.verify/t32-vm07-drive.mjs` → **exit 0**（同轮刷新当场翻面、四种收尾文案）；
- `.verify/t32-failure-log.mjs` → **exit 0**（日志里有 npm 原文、界面文案干净）；
- `scripts/env-doctor-cases.mjs` **20/20**（case G 的新 argv 形状照旧成立 —— `envFixPlan` 仍然给出 `i -g pnpm --allow-scripts=pnpm`）；
- `scripts/env-wizard-cases.mjs` **150/150**（**含 VM-05 的十个间距值** —— 说明 t38 改 `styles.css` 左栏那几行没有动到红框那三处的值）。

**给下一轮的建议**：t37 把那条断言同步成"按变量形状找（`pnpmInstallSpec(` 或 `ALLOW_INSTALL_SCRIPTS_FLAG`）且仍然只有一处"即可（归 `test/selftest.ts` 的归属人）；改完门禁回到 236/236 我再现测一次确认。

**最终定格（本轮结论就落在这里）**：t37 在 **14:02** 又写了 `env-doctor.ts` + `test/selftest.ts`（后者把那条断言同步成新形状，并把自检从 236 加到 **242** 项），之后树静下来了。我在聚合

```
56 个源文件 → e7d79ab2191ad1926e535712c7718bbbe3177dab2b35d969f495f735ecdd6d84
```

上做了一整批现测，**前后聚合一致（这就是"冻结窗口"）**：

```
npm run typecheck       → exit 0
npm run lint            → exit 0
npm run format:check    → exit 0（All matched files use Prettier code style!）
node scripts/selftest-sandbox.mjs → exit 0：242/242 项通过 + env-doctor-cases 20/20 + env-wizard-cases 150/150 + 清理干净 + 自检门禁：通过
node .verify/t32-vm07-drive.mjs   → exit 0（同轮刷新当场翻面 + 四种收尾文案）
node .verify/t32-failure-log.mjs  → exit 0（日志里有 npm 原文 + 界面文案干净）
node scripts/env-doctor-cases.mjs → exit 0（20/20，case G 新 argv）
```

因此本轮的时间线是：**t31 的冻结树（13:57，聚合未记）四道门禁全绿（236/236 + 20/20 + 150/150）→ t37 的在飞改动让那条 argv 断言过时（a91f647e 上 235/236，已归属 t37）→ t37 14:02 修好并扩到 242 项 → 定格树 e7d79ab2 四道门禁全绿**。t31 自己的两条（VM-06 / VM-07）在这个窗口的两侧都是 exit 0。

---

## 9. 我这一轮实际跑了什么

| 命令 / 脚本                                                                         | 用途                                                                                    |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run typecheck` / `lint` / `format:check`                                       | 三道门禁现测（0 / 0 / 0）                                                               |
| `node scripts/selftest-sandbox.mjs`                                                 | 第四道门禁：236/236 + 20/20 + 150/150 + 清理干净，exit 0                                |
| `npm i -g --prefix … --ignore-scripts pnpm`（隔离 prefix）                          | 造出"脚本没跑"的坏 pnpm（VM-06 的坏状态）                                               |
| `npm i -g --prefix … --foreground-scripts pnpm --allow-scripts=pnpm`（隔离 prefix） | 造出"脚本跑了"的好 pnpm（真跑 `pnpm --version` = 12.4.2）                               |
| `.verify/t32-vm07-drive.mjs`                                                        | VM-07：受控 PATH 下的同轮刷新 + 判定翻面 + 四种收尾文案                                 |
| `.verify/t32-failure-log.mjs`                                                       | 失败路径日志里有 npm 原文（含 install-scripts 警告）+ 界面文案无内部术语                |
| `npm config get allow-scripts` / `npm prefix -g` / `npm ls -g --depth=0`（前后）    | 宿主机不变量：两份记录逐字相同                                                          |
| 56 个源文件的逐文件 SHA256 → 聚合（定格）                                           | 复测前 `a91f647e…`、复测后 `fb4c711a…`；期间只动了 `env-doctor.ts` 一个文件（t37 在飞） |

原始日志与产物在 `.verify/t32/`（与 `.verify/` 一起被 git / eslint / prettier / 门禁忽略）。

---

## 第三轮及更早

> **第三轮的收口补记（t12 集成收口时写，不改那一轮的验证结论）**：第三轮报告的项数与冻结树都是**它那一轮**的实测值；
> 它之后 t27（`lib/env-wizard.ts` 的 inflight 兜底）与 t29（渲染层三条修复：lint 那一行、`gateDiversion`、
> 挡住页 Tab 顺序）又动了三个文件（`src/renderer/lib/env-wizard.ts`、`scripts/env-wizard-cases.mjs`、`test/selftest.ts`），
> 并已分别由 t28 / t30 两轮独立审查**判 pass、0 条 finding**。收口时在最终树上现测的四道门禁是：
> `test/selftest.ts` **229/229**、`scripts/env-doctor-cases.mjs` **20/20**、`scripts/env-wizard-cases.mjs` **150/150**。
> 也就是说：报告里的「224/224 + 20/20 + 148/148」是那一轮的数，**今天的数见这里**。

## 第三轮（t20）报告（原文保留）

| 项       | 值                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| 验证者   | verifier（t20，第三轮）                                                                                     |
| 被验产物 | F-04 的恢复、VM-01~VM-05 五项真机反馈的修复、最终树、以及**船长 12:49 的真实构建产物**                      |
| 时间     | 2026-09-19（本轮现测；**没有引用任何成员时期的旧输出**）                                                    |
| 结论     | **verdict = pass**（0 条 finding；五项缺陷全部关闭）                                                        |
| 四道门禁 | typecheck 0 / lint 0 / format:check 0 / 沙箱自检 **exit 0**（224/224 + 20/20 + 148/148，自动收录 2 个脚本） |

复现命令（都在 `dsh-console/` 下）：

```bash
npm run typecheck && npm run lint && npm run format:check
node scripts/selftest-sandbox.mjs                      # 第四道门禁（含自动收录的两个反例脚本）
node scripts/env-wizard-cases.mjs                      # 148 条（本轮新增 M 段：VM-01~05）
node scripts/env-doctor-cases.mjs                      # 20/20（阶段一，A/F 已按裁定改语义）
node .verify/t20-f04-check.mjs                         # F-04：以事故前参考产物为准的独立复核
node .verify/t20-mutation-experiment.mjs               # 变异实验：两个变异必须被断言抓住
node .verify/t18-precheck.mjs                          # nvm 路径 15 条（含真资产下载核 sha256 + 形态）
node .verify/t16-renderer-artifact.mjs                 # 渲染层真实产物结构 + 指纹
```

---

## 1. 结论：五项缺陷全部关闭，0 条 finding

| 缺陷                                    | 来源         | 关闭证据（本轮现测）                                                               |
| --------------------------------------- | ------------ | ---------------------------------------------------------------------------------- |
| **F-04** `main.ts` 事故恢复不忠实       | 我上一轮提出 | §2：三条整句逐字回来、编码卫生、注释/代码差异全部可归因（零意外差异）              |
| **VM-01** nvm 装完 Node 不可用          | 用户真机     | §3：15 条夹具 + 10 条钉子；判据回到「真的能跑」（`node` 与 `npm` 各实测一次）      |
| **VM-02** 安装器 GUI 静默阻塞没提示     | 用户真机     | §3：按**真实资产**形态给静默参数（Inno `/VERYSILENT …`，不是 NSIS `/S`）+ 兜底文案 |
| **VM-03** 完成判据与真实可用性不一致    | 用户真机     | §4：真输入驱动 —— 文件在但跑不出结果 → `missing`、第一步 `todo`、门禁 `blocked`    |
| **VM-04** 界面内部术语 + 断言覆盖面盲区 | 用户真机     | §5：主进程文案 0 命中 + 原始错误落日志 + **变异实验证明断言会红**                  |
| **VM-05** UI 间距                       | 用户真机     | §6：十个值钉成断言（含红框三处的七个）+ **变异实验**；观感仍只能人看               |

---

## 2. F-04（main.ts 注释恢复）—— 关闭

**参考物**：`.verify/t16-main-reference.js`（事故前 11:22:45 的 tsc 产物，68885 字节 / sha256 `D48F234238057C5F8E5FC52B92652DE5C4199823BCE70EA7FFAEA946BAFB10CC`）。本轮开头另存了一份 `.verify/t20-main-reference.js` 保底。
**为什么用它**：`dist/main/main.js` 已被 12:14 与 12:49 两次构建覆盖 —— 拿它当参考就是「自己的构建比自己」，会假绿（t17 也提过同一点）。我**用的是自己写的检查**（`.verify/t20-f04-check.mjs`），不是实现者提供的脚本。

```
[通过] AN 编码卫生：无 BOM、无 U+FFFD、纯 LF（无 CRLF、无单独 CR）
[通过] S 逐字回来：用 detach 而不是贴边停靠：停靠会改变窗口布局，而我们要看的恰恰是布局。
[通过] S 逐字回来：但**托盘图标必须能在运行期读到这张源图**（Windows 上托盘没有"取自 exe"这条路径），
[通过] S 逐字回来：给 32 让系统往下缩，比钉死 16 在高分屏上被拉大好得多（放大一定比缩小糊）。
[通过] B 块注释：52 → 53，除新增的 wizardSkips 说明块外零差异
[通过] L 行注释：125 → 129，差异全部能归到「原始错误进日志」那个钩子
[通过] C 代码：除 wizardSkips 与其调用点、以及「原始错误进日志」的 log 钩子之外零差异
F-04 复核（以事故前参考产物 .verify\t16-main-reference.js 为准）：**恢复忠实：注释逐字回来、其余差异全部可归因**
```

**差异逐条摊开（供审计）**：块注释只多出新增的 `wizardSkips` 说明那一块（参考独有 0、现树独有 0）；
行注释多出 4 条，全部是「原始错误进日志」那段说明（`// 被界面撤下去的那些原始错误（PATH / dsh.cmd / npx / EPERM 这类内部记号）**只落日志**。` 等）；
代码差异 = `wizardSkips()` 与其 4 个调用点（4 行旧读被换）+ **1 行新代码** ``log: (line) => console.log(`[env] ${line}`),``
—— 后者是事故**之后**才加的功能（这条正好是验收第 7 条要求的"原始错误必须落进日志"的落点），不是恢复损坏。
对比 t16 那轮（当时有 10 处注释差异、3 句整句丢失、2 处空 `catch` 排版被改、行注释少 2 条）：**全部消失**。

---

## 3. VM-01 / VM-02（nvm 路径与安装器阻塞）—— 关闭

### 3.1 nvm 路径：判据回到「真的能跑」

我用**自己的夹具**钉了 15 条（`.verify/t18-precheck.mjs`，本轮现跑）并把这批钉子**固化成门禁里的一部分**（`scripts/env-wizard-cases.mjs` 的 M 段 M5–M14），
核心是「每一步都要事实，不看命令跑过没有」：

- `nvm install <版本>` 真的执行、看退出码、输出尾部进分类器（M5）；
- install 之后再问一次 `nvm list` 并**逐个版本比对**（`compareNodeVersions`）——退出码说不清"装进来没有"（M6）；
- 成败判据是 `<NVM_SYMLINK>\node.exe --version` **与** `npm.cmd --version` **都**拿到版本号（M7）；
- 两步之前先 `refreshProcessPathFromSystem()`，且注入白名单是 `NVM_HOME` / `NVM_SYMLINK` / `NVM_DIR`（不只 PATH）（M8）；
- 符号链接权限：开发者模式判定（`0x1` / `1`，其它值不算开启）+ 一次性提权（`-Verb RunAs`）+ 用户拒绝的 `declined` 分支都在（M9 / M13）；
- 拒绝提权后的文案给**两条出路**（开发者模式 / 管理员），实测分类为 `symlink` 且 hint 同时含这两个词（M10）；
- 「不再等待」之后安装器若退出，会补做 nvm 两步（`detachedNvmResume` → `installNodeWithNvm`），不再停在"管理器装好但没有 active Node"（M14）。

**用户报的那句 npm 原文**（`No active Node.js version is configured. Run \`nvm install <version>\` then \`nvm use <version>\`.`）现在是 `classifyInstallFailure`的一个**独立类别**`nvm-inactive`（B1），每一步失败都回到它自己的出路句。

### 3.2 安装器形态：按真实资产给参数（`/S` 的假设被推翻）

**本轮重新下载真资产核过**（只下载、不执行，`.verify/t18-precheck.mjs` 的 C1）：

```
[通过] C1 真实 nvm 资产：sha256 与发布页一致、形态是 inno、静默参数是 /VERYSILENT 那一组（不是 /S）
       10837938 字节 / sha256 afaee67d…6ac11 / 形态 inno / ["/VERYSILENT","/SUPPRESSMSGBOXES","/NORESTART","/SP-"]
```

配套断言：Inno → `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-`；NSIS → `/S`；**认不出 → 空数组**（不许猜），
并把「请到那个窗口里把向导点完」作为状态行推给界面（M11）。`nvm list` 的四种输出由 `parseNvmListOutput` 认（M12）。

---

## 4. VM-03（完成判据）—— 关闭（真输入驱动）

拿**真输入**驱动判定（不是读代码）：Node 文件在、`node --version` 跑不出结果（`version: null, exitCode: 0, error: null`）：

```
[通过] M1 VM-03：… → node-version=missing（不是黄灯），向导第一步是 todo、门禁 blocked、当前步骤 node
       实际：node=ok / node-version=missing / missing≥1 / 第一步=todo / gate=blocked / current=node
[通过] M2 VM-03 的文案：那两句必须是「找到了却跑不出结果」，不能笼统说「没装」
```

即：**「文件在、跑不出结果」不再算完成**，而「这个运行环境不允许起子进程」（`EPERM` / `EACCES`）仍然是 `warn`、仍然不挡人（阶段一 A 对照组 + 我的 M 段都钉着这半边）。

---

## 5. VM-04（内部术语与断言覆盖面）—— 关闭 + 一条方法论教训

### 5.1 界面文案

夹具里**刻意带着用户那台机器的原始报错**（含 `PATH` / `dsh.cmd` / `npx`）：

```
[通过] M3 VM-04：主进程产出的用户可见文案（每一项的 detail 与 fixHint，共 16 个字段）不含内部术语 —— 0 处命中
[通过] M4 VM-04 的另一半：同一份夹具里，原始错误落进了日志行（dsh 定位原文含 PATH / dsh.cmd / npx、
       子进程错误串、零输出原因都在），而界面文案里一处都没有
```

我的词表是**独立列的**（`PATH` / `dsh.cmd` / `npx` / `COMSPEC` / `verbatim` / `SHA256` / `SHASUMS256` / `NVM_SYMLINK` / `NVM_HOME` / `EPERM` / `spawnSync` / `ECONNRESET` / `ETIMEDOUT`，带词边界正则）。
「细节留日志、结论给人话」这条是成对的：M4 断言同一个输入下**日志里有原文**。

### 5.2 覆盖面（**变异实验**，不是只读断言代码）

`.verify/t20-mutation-experiment.mjs` —— 在 `.verify/` 里操作副本，**不碰 src / test**：

```
[通过] 0 对照组（无变异）：反例脚本 148/148 exit 0
[通过] 1a 变异生效：编译产物里 dsh 那句被整条换成旧写法（运行时拼装 resolveError）
[通过] 1b 探针：变异后的模块真跑一遍，dsh 的 detail 里确实出现了 dsh.cmd / PATH / npx（违规句真的进了界面文案）
[通过] 1c 变异被抓住：M3（主进程产出的文案里不出现内部术语）变红、脚本 exit 非 0
[通过] 2a 变异生效：.wizard-progress > .btn-row { gap } 由 12px 改回 8px
[通过] 2b 变异被抓住：那条 gap: 12px 的间距断言变红、脚本 exit 非 0
变异实验：**两个变异都被对应的断言抓住了**（断言不是空转）
```

（第一版实验踩了两个坑并都修掉了，写在这里供后来者少走：① `spawnSync` 默认 `stdio:'pipe'` 在这个沙箱里 **EPERM**，必须把子进程输出重定向到**文件 fd** 再读回来 —— 这就是"对照组 exit 1"的原因；② 只把引号里的人话换成模板串会变成一段**字面量**，得整条 `push(...)` 语句一起换，并用探针证明违规句真的进了 detail。）

### 5.3 方法论教训（写进报告，供以后所有文案类断言用）

**静态断言的覆盖面必须跟着「文案的产生位置」走。** 上一轮我在「不可验」清单里写了「门禁真实观感与键盘可达性」未验证，但**界面里出现 `PATH` / `dsh.cmd` / `npx` 这类内部术语本该被冻结 §3.8 #22 拦住** —— 那条旧断言只扫渲染层自己的模板与 `lib/`，而违规文本是**主进程拼出来的**（`没能定位 dsh：${resolveError}`），扫源码字面量永远扫不到。这就是它「通过了检查却仍然难看」的成因。

**这一轮我如何验证它已经补上**：

1. 我读了现在那条断言的判据（`test/selftest.ts` 的 17c/17d）：它**换成行为驱动** —— 拿带 VM 原始报错的夹具真跑 `judgeEnvironment`，再扫全部 `detail` / `fixHint`（`selftest.ts:3449-3477`），外加一条纯静态源码扫描（3478 起）与一条灵敏度自证（3517：`vmForbiddenIn('…dsh.cmd…').length === 3`）。
2. 我自己**独立复刻了同一机制**并做了变异实验（上面 1a/1b/1c）：把违规句按旧写法注回编译产物 → 夹具驱动的扫描**变红**。也就是说：**这类"运行时拼装"的违规只能靠"真跑一遍再扫产出"来抓**；静态那条是补充，不是主力。
3. 我的 148 条里 M3/M4 也把这条规则长期钉住（门禁每一轮都会跑）。

---

## 6. VM-05（UI 间距）—— 关闭（数值已钉），但**观感只能人看**

### 6.1 十个值钉进我自己的反例脚本（`scripts/env-wizard-cases.mjs` 的 M15–M17）

```
[通过] M15 .wizard-progress > .btn-row { gap: 12px }        （红框①：两按钮之间，原继承 8px）
[通过] M15 .wizard-progress > .btn-row { margin-top: 12px } （红框①：按钮行与上方进度行，原贴死）
[通过] M15 .gate-card .env-op { margin-top: 12px }          （红框②：输出面板与上方按钮行/结果行）
[通过] M15 .gate-result .btn-row { margin-top: 12px }       （卡片里"块 → 按钮行"统一 12px，原 10px）
[通过] M15 .env-op-head { padding: 0 16px }                 （红框②：与 .panel-head / .env-row 同一条竖线）
[通过] M15 .env-op-out { padding: 14px 16px }               （红框③：正文与井边不贴，原 12px 14px）
[通过] M15 .env-op-out { font-size: var(--t-sm) }           （红框③：正文一档字号，原 --t-xs）
[通过] M15 .env-op-out { line-height: 1.8 }                 （红框③：行盒 20.1 → 22.5px）
[通过] M15 .env-op-summary { padding: 11px 16px }           （结论行同一条竖线，原 10px 14px）
[通过] M15 .env-op-cmd { padding: 3px 9px }                 （文件名的砖不贴边，原 3px 7px）
[通过] M16 门禁卡片"块与块"的间距与既有页面节奏一致（.env{gap}=12px、.gate-metabar{margin-top}=12px）
[通过] M17 规格值没被顺手改掉：输出区标题行 38px、正文上限 220px（视觉 §5.5）
```

**与规格的关系**：38px 标题行 / `--well` 正文 / 220px 上限与五档字号是**照视觉规格**；`.env-op-out` 的 `line-height: 1.8` 是对规格 1.75 的微调，依据是视觉 §0 自己写的"所有尺寸都是设计值，可在实现时按同一比例微调"；规格没写到的块间距一律取既有页面节奏 12px / 16px 竖线（M16 把这两个出处也钉住）。**我核了这一批改动只动间距与行高、没有动配色与全局变量**（十条规则都是同一选择器同一属性）。

### 6.2 变异实验（数值没被改回去的证明）

见 §5.2 的 `2a/2b`：把 `gap: 12px` 改回 `8px` → 那条断言**变红**、脚本 exit 非 0。

### 6.3 必须明写的一句

**观感类问题静态断言抓不住。** 上面这些断言只能保证「值没被改回去」，**保证不了「在真机上看着舒服」** ——
间距是否真的"不挤"、按钮是否真的"不粘"、长文件名与「进行中…/收起」在窄窗口下是否还打架，最终**只能由人在真机上复看**。真机复看清单（建议照这个顺序看）：

1. 门禁「正在进行」态：两颗按钮之间、按钮行与下方输出面板之间是否透气；
2. 输出面板：头行（文件名 + 状态词 + 收起）在长文件名下是否仍然分得开、右控件没被顶掉；
3. 刷出来的四行（校验通过 / 没有数字签名 / 没能读到签名 / 命令）行距是否舒服；
4. 门禁卡片与自检页里同一个输出面板的内边距是否一致；
5. 顺带确认窄窗口（约 900px）与 150% DPI 下没有新的挤压。

---

## 7. 渲染层产物：以船长 12:49 的真实构建为准 —— 通过

我读到的指纹与船长给的一字不差（**产物就是他那一份**，`.verify/t16-renderer-artifact.mjs`）：

```
产物目录：dist\renderer
[通过] index.html：<script> 共 1 个（type=module 0、crossorigin 0、defer 1、相对 src 1）、modulepreload 0 个、样式表 1 个（crossorigin 0 个）
        <script defer src="./assets/index-B0TEbb1a.js">
[通过] assets：.js 1 个（期望 1）、.mjs 0 个、.css 1 个
       index-B0TEbb1a.js  550836 字节  sha256 dab45d33…05b5  mtime 2026-09-19 12:49:12
       包内动态 import 计数 0（入口不用动态 import 才可能只有一个 chunk）
       [通过] gate-root、gate-banner-actions、运行环境准备、先进入界面、重新打开环境向导、envWizard、envNodePlan、安装下载来源、inert 全部存在
```

**顺带核了 t21 的修复真的进了产物**（在 `dist/renderer/assets/index-CH5m4Bli.css` 里读到）：`.wizard-progress>.btn-row{gap:12px;margin-top:12px}`、`.gate-card .env-op{margin-top:12px}`、`.env-op-out{…font-size:var(--t-sm)…}` ✓（不是只在源码里）。

---

## 8. 阶段一旧断言的两条语义同步（我在 t22 做的）—— 确认「改成语义，不是删掉」

`scripts/env-doctor-cases.mjs` 现在 **20/20**、门禁里退出码 0。两条断言名与判据都在：

- `A 反例：pnpm 有路径却跑不出输出 → missing（不是 warn），但出路与「没装」一模一样（fixHint + fixAction + 计划都在）`
  —— 判据 8 项：`missing` + detail 说「找到了 pnpm」「跑起来没有任何输出」且不含「没找到」+ `fixHint` + `fixAction=install-pnpm` + 一键计划在 + `counts.missing === 1`。**旧版是 3 项**（warn + fixHint + 0 missing）。
- `F 反例：起不了子进程 → node 仍 ok、node-version 是 warn（不得当成没装），文案只说人话、不出现 EPERM`
  —— 判据 5 项：`node=ok` / `warn` / detail 含那两句人话 / **不含** `EPERM` / `0 项 missing`。**旧版是 3 项**（含要求 detail 带字面 `EPERM`）。
- 另按船长裁定保留了我加的 **A 对照组**：环境受限（`EPERM`）的 pnpm 仍然是 `warn` + 0 项 missing —— 把「测不出来 ≠ 不可用」那半也钉住（正是最容易被后人一刀切回去的地方）。

断言名集合对照（两轮门禁日志）：改前 97 条 → 改后 98 条，「改前有、改后没有」的**只有 A、F 两个旧名字**，**没有删除任何断言**。
「原始错误必须落进日志」那半边由 `probeTroubleLines` 承担，本轮用 M4 独立钉住（日志里有原文、界面里没有）。

---

## 9. 沙箱里无法执行的（「不可验」清单，逐条给期望的真机证据形式）

| 项                                             | 期望的真机证据形式                                                                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 真实 MSI 安装（`msiexec /i … /qb /norestart`） | 干净 Win11 点「直接安装官方稳定版」：UAC 弹一次 → 进度可见 → 复检后 Node 变「正常」；`node -v` 与安装目录留下                                                     |
| UAC 三态（同意 / 拒绝 / 关掉窗口）             | 三态各做一次，期望分别是"装好 / 什么都没改（拒绝权限）/ 什么都没改（取消）"，文案类别与 `classifyInstallFailure` 一致                                             |
| `nvm install` / `nvm use` 真机执行             | 装完 → `nvm install <版本>` → `nvm use <版本>` → 复检 Node「正常」；注册表出现 `NVM_HOME` / `NVM_SYMLINK`；用户报的那句 `No active Node.js version…` **不再出现** |
| Inno 静默参数的实际效果                        | 点 nvm 路径：期望**没有许可协议窗口**、安装自己跑完；若真弹了窗口，界面应显示"请到那个窗口里把向导点完"（兜底文案生效）                                           |
| 符号链接权限（普通权限下的 `nvm use`）         | 期望：未开开发者模式时给一次性 UAC；拒绝后界面说清并给两条出路（开发者模式 / 管理员）；开启开发者模式后不再弹                                                     |
| 装完后本进程 PATH / `NVM_*` 刷新               | 装完**不重开应用**，自检页 Node 变「正常」；其它已开终端需重开（界面已提示）                                                                                      |
| 安装器可见性 / 退出应用后安装器继续跑          | 安装窗口前台可见；应用退出后继续跑完且生效；重启后复检「正常」                                                                                                    |
| 下载走系统代理（Electron `net` 栈）            | 开代理断直连仍能下载；关代理给 network 类失败（我用的是 `node:https`，**不等于** Electron net）                                                                   |
| GitHub 匿名限流                                | 限流时给「网络类」+ 出路句（不是"这台机器不支持"），不缓存、不重试                                                                                                |
| **界面观感与键盘可达性**                       | **只能由人在真机上看**（§6.3 的五步清单）——静态断言只能保证数值没被改回去，不冒充"看起来对"                                                                       |

---

## 10. 我这一轮实际跑了什么

| 命令 / 脚本                                   | 用途                                                      |
| --------------------------------------------- | --------------------------------------------------------- |
| `npm run typecheck` / `lint` / `format:check` | 三道门禁现测（0 / 0 / 0）                                 |
| `node scripts/selftest-sandbox.mjs`           | 第四道门禁：224/224 + 20/20 + 148/148 + 清理干净，exit 0  |
| `node scripts/env-wizard-cases.mjs`           | 我这份 148 条（上一轮 121 条 + 本轮 M 段 27 条）          |
| `.verify/t20-f04-check.mjs`                   | F-04 独立复核（编码 / 三条整句 / 注释 / 代码差异归因）    |
| `.verify/t20-mutation-experiment.mjs`         | 变异实验（VM-04 词表 + VM-05 间距，各含生效与"被抓"两步） |
| `.verify/t18-precheck.mjs`                    | nvm 路径 15 条 + 真资产下载核 sha256 与安装器形态         |
| `.verify/t16-renderer-artifact.mjs`           | 渲染层真实产物结构 + 指纹（与船长给的一致）               |
| `.verify/t16-main-recovery.mjs`               | 上一轮那份检查（已把参考改指向保底副本）—— 交叉确认       |

原始日志在 `.verify/t20-gates/`（与 `.verify/` 一起被 git / eslint / prettier / 门禁忽略）。

---

## 附录：第一、二轮的结论与收敛过程

- **第一轮（t8）**：verdict = needs_revision，三条 finding —— F-01 `judgeWizard` 不满足「任何输入都不抛」、F-02 横幅触发的 checking 显示了全屏门禁层、F-03 冻结 §3.2 与 `ipc.ts` 不一致。**第二轮（t16）复核：三条全部关闭**（F-01 用真实 `settings.json` 驱动、F-02 用可控 Promise 桩在等待期间取样、F-03 五个代码块逐字命中）。
- **第二轮（t16）**：新发现 F-04 —— 事故恢复不忠实（10 处注释差异、3 句整句丢失、注释空段落行 12→3、2 处空 `catch` 排版被改）；t17 修完；**本轮以事故前参考产物复核：关闭**（§2）。
- **用户真机实测**（最高等级证据）带来 VM-01~VM-05，t18 / t19 / t21 分别修完 nvm 路径与安装器阻塞、完成判据与界面术语（含断言覆盖面）、UI 间距；**本轮全部关闭**（§3–§6）。
- **一条流程教训**（第二轮留下的）：`dist/` 是构建产物、会被 `npm run build` 覆盖 —— 事故前的参考必须**另存到 `.verify/`**（我 t16 时存的那份 `t16-main-reference.js` 是后来两次构建覆盖后唯一幸存的参考）。实现者的脚本不能当唯一证据；这次我用的是自己写的那份检查。
