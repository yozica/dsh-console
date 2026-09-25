/**
 * Node 安装 / 更新通道：归属、计划、请求与状态（含 t29 增量）
 *
 * 主进程 ↔ 渲染层契约的一部分（t55 从 `shared/ipc.ts` 拆出来的；那个文件现在只是 barrel）。
 * 约定不变：**只放类型与纯常量，禁止 import 任何运行时依赖**（渲染层要读这些类型，
 * 拖进 fs/path 就会被卷进包里）—— 叶子模块之间只允许 `import type`。
 */
import type { EnvDoctorReport } from './ipc-env';

// ---------------------------------------------------------------- Node 安装 / 更新通道

/** 装 / 更新 Node 的两条路 */
export type EnvNodeMethod = 'direct' | 'nvm';

/** 第一次装还是更新：只影响前置（更新会先停掉本应用启动的 dsh）与文案 */
export type EnvNodeMode = 'install' | 'update';

/** 版本档：默认 `lts`（最新稳定版），可切到 `current`（最新当前版） */
export type EnvNodeChannel = 'lts' | 'current';

/**
 * **发布元数据的**签名自述（不是读文件得到的结论，见 R-27）：
 * - `signed` / `unsigned`：发布说明或资产元数据**明确自述**了这个构建的签名状态；
 * - `unknown`：没有这种自述 / 认不出来 —— **官方直装恒为 `unknown`**，nvm 认不出来也是它。
 * 计划阶段的未签名确认**只**由 `unsigned` 触发；`unknown` 一律不出现任何签名断言。
 */
export type EnvReleaseSigning = 'signed' | 'unsigned' | 'unknown';

/**
 * 安装通道的相位。与 `EnvFixPhase` 分开：多了下载与校验，
 * 而且 `installing` 之后的"停止"语义相反（只停止等待，不杀安装器）。
 */
export type EnvInstallPhase =
  | 'idle'
  | 'preparing'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'waiting'
  | 'rechecking'
  | 'done'
  | 'cancelled'
  | 'error';

/** 一次安装 / 更新的计划：确认区要显示的全部事实（渲染层不自己拼、不自己猜） */
export interface EnvNodePlan {
  method: EnvNodeMethod;
  mode: EnvNodeMode;
  channel: EnvNodeChannel;
  /** 目标 Node 版本（来自官方版本清单的**具体**版本号） */
  version: string;
  /** 这次要下载的东西的完整地址（direct = Node 安装包；nvm = 版本管理器的安装包） */
  url: string;
  /** 下载来源的主机名（正文显示主机名，完整地址放详情） */
  sourceHost: string;
  /** 期望的 sha256（Node 来自同版本 SHASUMS256.txt；nvm 来自发布资产的 digest）。
   *  取不到时为 null，**行为按路径分**（R-25 / R-27 第 4 条）：
   *  - 官方直装：拿不到清单 = 判不了架构存在性也校验不了 → 不给「开始」（**没有**"仍然继续"）；
   *  - nvm 旧发布线（1.2.x 的资产 digest 是 none）：**正常情形** → 走「这次没能校验安装包的完整性」
   *    确认（换一个下载源再试是默认焦点 / 仍然继续）。**不许**用 `.checksum.txt` 去猜 exe 的哈希 */
  sha256: string | null;
  /** 校验依据的人话（例如"官方发布的校验清单"） */
  evidence: string;
  /** **发布元数据的**签名自述（R-27）。官方直装恒为 `'unknown'`；
   *  计划阶段的未签名确认**只**由 `'unsigned'` 触发，`'signed'` / `'unknown'` 一律不出现签名断言 */
  releaseSigning: EnvReleaseSigning;
  /** 安装包签名者。**计划阶段恒为 null，语义是"尚未读取"**（Authenticode 要读文件才拿得到，见 R-26）：
   *  计划阶段不许据此说"没有数字签名"、也不许因此多一次确认；下载后读到有效签名才填发行方名字。
   *  「发布元数据自述未签名」不走这个字段 —— 它是 `releaseSigning`（R-27） */
  signer: string | null;
  /** 这条路径现在能不能走。`false` 的六种情形（完整清单见 `plan()` 的注释）：
   *  官方直装 —— 认不出架构 / 版本号、**校验清单取不到（网络类）**、清单里没有这台机器架构的 msi；
   *  版本管理器 —— 提权态（R-23）、**发布信息取不到（网络类，含匿名限流）**、发布里没有适合的架构。
   *  网络类**不许**被说成"这台机器不支持"；`usable: false` 时 `url` 的语义见 `plan()` 的注释 */
  usable: boolean;
  /** 不能走的原因（给用户看的一句人话）；`usable` 为 true 时为 null */
  refuseReason: string | null;
  needsElevation: boolean;
  /** 会不会动到正在运行的 dsh（`mode === 'update'` 时为 true） */
  affectsRunningDsh: boolean;
  /** 命令原文或安装包名（确认区显示） */
  display: string;
  /** 会装到哪里（人话）；取不到时 null */
  target: string | null;
  /** 确认区里的风险说明（会改什么、要联网、会弹一次提权询问） */
  note: string;
}

/** 一次安装 / 更新的当前状态（`envNodeInstall` 的返回值、`env:install-state` 事件共用） */
export interface EnvInstallState {
  phase: EnvInstallPhase;
  /** 正在跑（或刚跑完）的是哪条路 / 哪个模式；idle 时为 null */
  method: EnvNodeMethod | null;
  mode: EnvNodeMode | null;
  /** 下载进度 0~100；算不出来时 null（界面不画进度条） */
  percent: number | null;
  /** 已下载 / 总字节；任一未知时 null（界面整行不出现） */
  bytes: { downloaded: number; total: number } | null;
  /** 现在还能不能"停止"：下载 / 校验为 true；安装 / 等待之后为 false */
  cancellable: boolean;
  /**
   * 我们已经不再等待，但安装可能还在后台进行。
   * true 时：界面给"未确定"结论、互斥锁**仍然持有**，直到复检证明落地 /
   * 用户点「我确认安装已经结束」/ 应用重启。
   */
  detached: boolean;
  /** 一句人话（进行中 / 收尾结论 / 失败原因） */
  message: string | null;
  /** 安装器或子进程的退出码；没跑起来时 null */
  code: number | null;
  /** 跑完自动复检的结论；还没复检时 null */
  report: EnvDoctorReport | null;
}

/** 安装过程的输出片段（界面原样贴进输出区，与 `env:fix-output` 同一套做法） */
export interface EnvInstallOutputEvent {
  chunk: string;
}

// ---------------------------------------------------------------- t29 增量：归属（VM-14）与档位（VM-15）

/**
 * 冻结文档 §3.2.1 是这一段 t29 增量的权威文本（需求 §11.2.1 与它逐字对齐）。
 *
 * **为什么写成"同名接口再声明一次"而不是改上面那些接口**：自检「契约（F-03）」把冻结 §3.1~§3.4
 * 的逐字 ts 块与本文逐字比对（`includes`），上面那几段必须原样保留 —— t29 的增量在冻结里也是
 * 写成"既有字段一个不动 + 这一段"。同一模块里同名 `interface` 是**合并声明**：消费方
 * （主进程 / preload / 渲染层）看到的是合并后的完整形状，运行期只是多两个字段。
 */

/**
 * 「当前这份 Node 是谁管的」。判据与证据见 `docs/env-wizard.md` §7.7 —— 判据只有一份、是纯函数、可离线测。
 * - `nvm`：落在版本管理器（nvm-windows）的目录下 —— v2 的 `<root>\installs\<版本>` 与 `<root>\.nodejs`（shim）、
 *   v1 的 `NVM_SYMLINK` / `NVM_HOME`，或路径里那条**独立**的 `nvm` / `nvm4w` 目录名（`D:\nvm-tools\node.exe` 不算）；
 * - `system`：**有正面证据**说明它是官方安装包装的那一份 —— 落在官方默认安装位
 *   （`%ProgramFiles%\nodejs`、`%ProgramFiles(x86)%\nodejs`，变量读不到时 `C:\Program Files\nodejs`），
 *   或落在官方安装包自己写下的安装目录里（`HKLM\SOFTWARE\Node.js` 的 `InstallPath`，读得到时才算）；
 * - `unknown`：**其余全部** —— 没找到 Node / 找到但认不出归谁 / 归别的版本管理器（volta / fnm / nvs / nodist / scoop）。
 *   **故意不是"剩下的一律当系统装的"**：那正是 VM-14（在版本管理器管的机器上按"系统装的"去装一份官方 MSI）。
 */
export type EnvNodeOwner = 'nvm' | 'system' | 'unknown';

/** `EnvNodePlan` 增量（既有字段一个不动） */
export interface EnvNodePlan {
  /** 这份 Node 是谁管的（与报告里是同一个事实、由同一个函数算出来） */
  owner: EnvNodeOwner;
  /** 这台机器上有没有一个**可辨认的版本管理器**（`deriveNvmModel` 推出了根）。
   *  **只在"一份 Node 都没找到"时**参与决策：有 → 默认用它（需求 §7.5 那条默认现在有事实支撑）；
   *  没有 → 默认官方直装（既有设计默认，事实行必须写出方法）。
   *  **归属判不出来、但找到了一份 Node 时它不参与决策** —— 那时是不预选 + `needChoice: 'choose-method'`（需求 §7.7 第 3 条） */
  nvmPresent: boolean;
  /** 动作开始前那份 Node 的版本（自检报告 `node-version` 那一行的事实）；取不到时 null */
  currentVersion: string | null;
  /** **当前档位**：`currentVersion` 在官方版本清单里那一条的档（`lts === false` → `'current'`，否则 `'lts'`）。
   *  清单里没有这个版本 / 拿不到清单 → **null，不许猜**（需求 §8.5 第 1 条） */
  currentChannel: EnvNodeChannel | null;
  /** 目标档位与当前档位不同 = **这是「换档」，不是「更新」**（需求 §8.5 第 3 条） */
  switchesChannel: boolean;
  /** 目标版本相对当前的方向（`compareNodeVersions` 的结论）；`currentVersion` 取不到时 null。
   *  **`'older'` 只可能来自显式换档**（跟随档位时目标一定是那一档最新的，不可能更低）；
   *  `'older'` 时界面必须用「换档」这个词，并写出"版本比现在低"（需求 §8.5 第 4 条） */
  direction: 'newer' | 'same' | 'older' | null;
  /** 这次为什么给不出「开始」：`null` = 给得出。
   *  - `'choose-method'`：**找到了一份 Node，但归属判不出来**（需求 §7.7 第 3 条）→ 界面给两条路让用户**显式选**；
   *  - `'choose-channel'`：**更新时判不出当前档位**（需求 §8.5 第 3 条）→ 界面让用户**显式选**一档。
   *  约定（要写成断言）：`needChoice !== null` ⟹ `usable === false`；
   *  只有 `needChoice === null && usable === false` 时才走既有的三条出路（换源 / 官方下载页 / 重新检测） */
  needChoice: 'choose-method' | 'choose-channel' | null;
  /** 这条路要不要先装 / 升级**版本管理器本身**。`method === 'nvm'` 且机器上已经有可辨认的版本管理器时为 `false` ——
   *  那时这次**没有任何东西要下载**：`url` 指向发布页（给人看 / 当出路，不是我们要下的东西）、`sha256` 为 `null` 是正常的、
   *  下载与校验两段**直接跳过**（界面不出现下载进度，也不出现"这次没能校验安装包的完整性"那次确认），
   *  流程就是 §4.2 那四步：`nvm install <目标版本>` → `nvm list` 核对 → `nvm use <目标版本>` → 实测复检。
   *  直装恒为 `true`（官方安装包必须下载） */
  installsManager: boolean;
}

/** `EnvInstallState` 增量（既有字段一个不动） */
export interface EnvInstallState {
  /** 这一次跑的计划（确认区那份）。**状态要能跨页面重挂载**：界面不许靠"我这次会话里记着计划"来渲染进度与收尾
   *  （与既有 `report` 同一个理由：结论由主进程推）。idle 时为 null */
  plan: EnvNodePlan | null;
  /** 收尾**实测**到的版本（复检那一刻 `node --version` 的输出，形如 `v26.9.0`）。
   *  「更新前 → 更新后」的前一半取自 `plan.currentVersion`，后一半取自这里；
   *  还没到收尾 / 没测到时为 null —— 界面照实说"没测到"，**不许拿目标版本冒充实测版本** */
  observedVersion: string | null;
}

/**
 * 一次安装 / 更新的请求形状（`envNodePlan` 与 `envNodeInstall` 共用；冻结 §3.2.1，VM-14 / VM-15 的根治点）
 */
export interface EnvNodeRequest {
  mode: EnvNodeMode;
  /** 省略 = **跟随归属**（需求 §7.8）。给具体值 = **用户显式点名的那条路**
   *  （只有"归属判不出来"与"拒绝管理员权限之后的替代出路"这两处由界面给） */
  method?: EnvNodeMethod;
  /** 省略 = **跟随档位**：`mode === 'install'` → 最新稳定版（设计默认）；`mode === 'update'` → **当前档位**（需求 §8.5 第 2 条）。
   *  给具体值 = **用户显式换档** —— 「换档」只可能由这个字段产生，**不可能由省略或默认值产生**（需求 §8.5 第 3 条） */
  channel?: EnvNodeChannel;
}

/**
 * preload 暴露给渲染层的 API（window.dshConsole）。
 * 渲染层写 `api.xxx()` 时能看到签名与返回类型，这是这次 TS 迁移最直接的收益。
 */
