# 装插件用的那份 pnpm，必须和 profile 对得上（t47）

**现象**（用户真机截图）：插件页装 `dshmarket`，右侧输出区里躺着一段 pnpm 的话：

```
The dependencies at "/Users/…/.dsh/profiles/web/node_modules" are currently linked from the store at
"/Users/…/Library/pnpm/store/v10".
pnpm now wants to use the store at "/Users/…/Library/pnpm/store/v3" to link dependencies.
(This error may happen if the node_modules was installed with a different major version of pnpm)
dsh: pnpm failed in profile directory /Users/…/.dsh/profiles/web
```

**它不是界面坏了，是"两个 pnpm 打架"**。这台机器上实测：

| 机器上的 pnpm                              | 版本        | 它认的 store               |
| ------------------------------------------ | ----------- | -------------------------- |
| `~/Library/pnpm/pnpm`（pnpm 官方脚本装的） | **10.15.0** | `~/Library/pnpm/store/v10` |
| PATH 里第一个：nvm 22 的 corepack shim     | **9.6.0**   | `~/Library/pnpm/store/v3`  |

而 `~/.dsh/profiles/web/node_modules/.modules.yaml` 里记着：

```
packageManager: pnpm@10.15.0
storeDir: /Users/…/Library/pnpm/store/v10
```

也就是说**这份 profile 是 pnpm 10 装的**。装插件的链路是：console 起 `dsh plugin --profile web add <spec>`
→ dsh 在 profile 目录里**裸 `spawnSync('pnpm')`**（它只认 PATH；dsh 自己的提示就是
`pnpm not found on PATH`）→ PATH 里先命中的是那份 **pnpm 9** → pnpm 9 只肯用 store v3，看见
`node_modules` 链在 v10 上就**拒绝动手**。最后那段话是 pnpm 自己的诊断，但对用户毫无可操作性。

**为什么 console 原来帮不上忙**：它确实会把 `findPnpm()` 找到的那份 pnpm 目录前置进子进程 PATH
（`plugin-manager.ts` 的 `envWithKnownBins`，否则 GUI 启动必然 127），但 `findPnpm()` 就是
**PATH 里第一份**——它不问"当初装这份 node_modules 的是哪一档"。答案其实就写在 profile 里
（`.modules.yaml` 的 `packageManager`），没人读它。

## 现在的做法（两条）

### 1. 装之前先按 profile 挑 pnpm

`main/process-utils.ts` 新增（既有导出签名一个没改）：

- `parseProfilePnpmMajor(text)`：纯函数，从 `.modules.yaml` 原文里取 `packageManager: pnpm@X…` 的
  **大版本**（只认这一行，不把 `storeDir: …/v10` 里的数字当版本）。
- `readProfilePnpmMajor(profileDir)`：读 `node_modules/.modules.yaml`（读不到 → `null`）。
- `pnpmVersionOf(file)`：实测一份 pnpm 的版本（`spawnSync(pnpm, ['-v'])`，进程内缓存；拿不到版本
  的候选不参与"对得上"的判定）。
- `findPnpmForProfile(profileDir)`：候选 = PATH 里那份 + 各已知安装位置（含 `~/Library/pnpm/pnpm`），
  **挑第一个大版本与 profile 一致的**；一个都对不上时把最靠前那份交出去并 `matched: false`
  （让调用方说实话，而不是静默用一个注定失败的版本）。

`main/plugin-manager.ts` 的装/卸/升级路径：

- `const pick = findPnpmForProfile(pluginProfileDir())`；把 `pick.file` 的目录**顶到子进程 PATH 最前**
  （dsh 只认 PATH，所以"挑"必须落成 PATH 的前置，光算出来没用）；
- `!pick.matched && pick.expectedMajor` 时往操作输出里写一句提示（说清 profile 是哪一档、机器上是哪一档）；
- 原来那道「根本没装 pnpm」的闸（`findPnpm() === null`）保留不动。

### 2. 这种错误要给人话

`summarizePluginFailure()` 新增一条（第三个参数带上"这次用的 / profile 期望的"版本）：

> 这份 profile 的依赖是用 pnpm 10 装的，而这次用的是 pnpm 9.6.0 —— 两个大版本的 store 布局不一样
> （v3 / v10），pnpm 会拒绝动手。换成与 profile 一致的那一档 pnpm 再装（或按 pnpm 的提示把这份依赖重装一次）。

自检里那条钉子用的就是**真机那段原文**当夹具。

## 当时怎么把用户救出来的（t47 现场记录）

1. 让开那份旧 shim：`mv ~/.nvm/versions/node/v22.17.1/bin/pnpm{,.corepack-off}` —— 之后 shell 与 console
   的 `findPnpm()` 都落到 `~/Library/pnpm/pnpm`（10.15.0 / store v10，与 profile 一致）；
2. 真机装上：`dsh plugin --profile web add dshmarket` → `Done in 980ms using pnpm v10.15.0`（exit 0）。

这两步只是**当时的解法**；上面那两条代码改动之后，用户 PATH 里是哪一份都不再影响结果。

## 哪条自检守着

- 「插件安装：从 profile 的 .modules.yaml 读出"这份依赖是哪个大版本的 pnpm 装的"（纯函数）」
- 「插件安装：store 大版本不一致时给人话（不再是 pnpm 那段原文）」
- 「插件安装：装之前按 profile 挑 pnpm，并把选中的那份顶到子进程 PATH 最前」
