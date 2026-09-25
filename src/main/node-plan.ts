/**
 * "装还是更新、走哪条路"的纯判定 + 提权结果分类
 *
 * t52 从 `node-installer.ts` 拆出来的（那个文件现在只剩 `NodeInstaller` 类 + `NodeInstallHooks`
 * 接口 + barrel；`buildPlan` 与 `transferPhase` 必须留在同一个文件里 —— 反例脚本按这对锚点
 * 切源码，见 AGENTS §7.35）。
 */
import { compareNodeVersions, pickNodeRelease } from './node-release';

import type { NodeReleaseEntry } from './node-release';

import type { InstallFailureReason } from './node-failure';

import type { EnvNodeChannel, EnvNodeMethod, EnvNodeMode, EnvNodeOwner } from '../shared/ipc';

import { ELEVATION_TIMEOUT_MESSAGE, FAILURE_HINTS, FAILURE_MESSAGES } from './node-failure';

/**
 * 计划里那条「事实 → 方法 / 档位」的判定（**纯函数**：只读入参、没有 IO、不抛）。
 *
 * 需求 §7.8 的方法表与 §8.5 的档位规则都落在这一处，`buildPlan()` 只负责把网络与磁盘事实凑齐：
 *   - **方法跟随归属**：`nvm` → `'nvm'`、`system` → `'direct'`；归属**未知**时默认值不能替用户做决定
 *     （找到了一份 Node → 不预选 + `needChoice: 'choose-method'`；一份都没找到 → 有版本管理器用它、否则官方直装）；
 *   - **档位跟随当前**：`update` 省略档位 = 跟随当前档位，`install` 省略档位 = 设计默认（最新稳定版）；
 *     **跨档只可能由"目标档 ≠ 当前档"产生**（显式换档，或 `install` 的设计默认正好跨档）；
 *   - `direction === 'older'` ⟹ `switchesChannel === true`（**按构造**：目标更低本身就是一次换档动作）；
 *   - `needChoice !== null` ⟹ 一定有 `refuse`（界面这次不给「开始」）。
 */
export interface NodePlanDecision {
  method: EnvNodeMethod;
  channel: EnvNodeChannel;
  /** 跟档挑出来的那一条（目标版本）；`needChoice === 'choose-channel'` 时为 null（还没有目标） */
  release: NodeReleaseEntry | null;
  currentVersion: string | null;
  currentChannel: EnvNodeChannel | null;
  switchesChannel: boolean;
  direction: 'newer' | 'same' | 'older' | null;
  needChoice: 'choose-method' | 'choose-channel' | null;
  installsManager: boolean;
  /** 非 null = 这次不给「开始」（`needChoice !== null` 时一定有它） */
  refuse: InstallFailureReason | null;
  /** 用户显式点名了与归属不一致的那条路（§7.8 的三个例外）时，确认区必须带上的并存风险句（§7.9 第 4 条） */
  coexistWarning: string | null;
}

/** §7.9 第 4 条原样那一句：三个例外的确认区都用它（不许改写） */
export const NODE_COEXIST_WARNING =
  '这样这台电脑上会有两份 Node：一份是原来的（不会被删掉），一份是这次装的。之后 `node` 用哪一份，看系统查找路径里谁在前。';

/** 已装版本在官方清单里那一条的档（`lts === false` → `current`，否则 `lts`）；清单里没有它 → null（不许猜） */
export function nodeChannelOfVersion(
  list: NodeReleaseEntry[],
  version: string,
): EnvNodeChannel | null {
  const found = list.find((entry) => compareNodeVersions(entry.version, version) === 0);
  if (!found) return null;
  return found.lts === false ? 'current' : 'lts';
}

/** 目标版本相对当前的方向；当前版本取不到时 null（`compareNodeVersions` 的结论） */
export function nodePlanDirection(
  target: string,
  current: string | null,
): 'newer' | 'same' | 'older' | null {
  if (!current) return null;
  const diff = compareNodeVersions(target, current);
  return diff > 0 ? 'newer' : diff < 0 ? 'older' : 'same';
}

export function decideNodePlan(input: {
  mode: EnvNodeMode;
  /** 请求里显式点名的方法；省略 = 跟随归属 */
  requestMethod?: EnvNodeMethod;
  /** 请求里显式点名的档位；省略 = 跟随（`install` → 最新稳定版、`update` → 当前档位） */
  requestChannel?: EnvNodeChannel;
  owner: EnvNodeOwner;
  /** 这台机器上有没有一个可辨认的版本管理器（`deriveNvmModel` 推出了根） */
  nvmPresent: boolean;
  /** 有没有找到一份 Node（路径）—— 与 `owner === 'unknown'` 合起来决定"要不要问用户" */
  nodeFound: boolean;
  /** 找到的那份 Node 的版本号（`vX.Y.Z`）；取不到 null */
  currentVersion: string | null;
  /** 官方版本清单（判当前档位与挑目标版本都用它；空数组 = 清单里什么都没有） */
  releases: NodeReleaseEntry[];
  /** 当前进程是不是提权态（R-23：nvm 那条路在提权态下不可用，替代出路是官方直装） */
  elevated: boolean;
}): NodePlanDecision {
  const currentChannel = input.currentVersion
    ? nodeChannelOfVersion(input.releases, input.currentVersion)
    : null;
  /** 事实能定的方法：`nvm` / `system`；归属未知时**没有**事实方法 */
  const factMethod: EnvNodeMethod | null =
    input.owner === 'nvm' ? 'nvm' : input.owner === 'system' ? 'direct' : null;

  let needChoice: NodePlanDecision['needChoice'] = null;
  let refuse: InstallFailureReason | null = null;
  let coexist = false;
  let method: EnvNodeMethod;

  if (input.requestMethod === undefined) {
    if (factMethod !== null) {
      // 归属已知：方法由事实定，不由默认值定
      method = factMethod;
    } else if (input.nodeFound) {
      // 归属判不出来 + 找到了一份 Node：**一条都不预选**（VM-14 的核心裁定）
      needChoice = 'choose-method';
      // 契约要求计划带一个方法（`EnvNodePlan.method` 是必填）。这里给**最不可能造出第二份 Node** 的那条：
      // 有可辨认的版本管理器就用它（它只管自己那份），没有才落到直装。
      // 这个值**不是预选** —— `needChoice === 'choose-method'` 时界面必须两条路都列、一条都不选中。
      method = input.nvmPresent ? 'nvm' : 'direct';
      refuse =
        input.mode === 'update'
          ? {
              kind: 'unsupported',
              message: '我们认不出这个 Node 是怎么装的，所以不会替它做自动更新。',
              hint: '可以用「打开官方下载页」自己装，或者点「重新检测」再确认一次。',
            }
          : {
              kind: 'unsupported',
              message: '我们认不出这台电脑上这份 Node 是怎么装的，所以不替你选路。',
              hint: '请显式选一条：用版本管理器安装，或直接安装官方版本（两条路都会在这台电脑上放两份 Node）。',
            };
    } else {
      // 一份 Node 都没找到：给一条**有事实支撑**的默认（有默认 ≠ 默默 —— 事实行必须把方法说出来）
      method = input.nvmPresent ? 'nvm' : 'direct';
    }
  } else {
    method = input.requestMethod;
    if (factMethod !== null && method !== factMethod) {
      // 归属已知时另一条路只有两个例外（§7.8），且都必须用户**显式点名**：
      //   ① 归属 = system，用户拒绝了管理员权限 → 改走版本管理器；
      //   ② 归属 = nvm，但当前进程是提权态（R-23）→ nvm 那条路走不了 → 改走官方直装。
      const allowed =
        (input.owner === 'system' && method === 'nvm') ||
        (input.owner === 'nvm' && method === 'direct' && input.elevated);
      if (allowed) {
        coexist = true;
      } else {
        refuse = {
          kind: 'unsupported',
          message:
            input.owner === 'nvm'
              ? '这台电脑上的 Node 是版本管理器管的，所以这次不能再用官方安装包装一份。'
              : '这台电脑上的 Node 是官方安装包装的，所以这次不能用版本管理器再装一份。',
          hint:
            input.owner === 'nvm'
              ? '点「重新检测」再确认一次；确实想要两份并存时，用官方下载页自己装。'
              : '点「重新检测」再确认一次，或者用官方安装包更新它。',
        };
      }
    } else if (factMethod === null) {
      // 归属未知 + 用户显式点名 = §7.8 的例外 1：允许走，但确认区要带上那句并存风险
      coexist = true;
    }
  }

  // ---- 档位：跟随（默认）还是显式换档 ----
  let channel: EnvNodeChannel;
  if (input.requestChannel !== undefined) {
    channel = input.requestChannel;
  } else if (input.mode === 'update') {
    if (currentChannel !== null) {
      channel = currentChannel;
    } else {
      // 判不出当前档位 → 不替用户选（需求 §8.5 第 3 条）。
      // `channel` 在这里只是**占位**（设计默认档）；`needChoice === 'choose-channel'` 时界面必须
      // 让用户显式选一档，**不许**把这个占位显示成目标档位，也不许据此算目标版本。
      //
      // 已经因为别的原因被拒（例如归属已知、用户却点名了另一条路）时**不再**改 `needChoice`：
      // 界面一次只该被问一件事，那个字段回答的是"为什么现在给不出开始"。
      if (refuse === null) {
        needChoice = 'choose-channel';
        refuse = {
          kind: 'unsupported',
          message: '我们判不出这份 Node 属于哪一档，所以这次不能自动更新。',
          hint: '请显式选一档（当前版 / 稳定版）；选完这一次就是一次显式的换档。',
        };
      }
      channel = 'lts';
    }
  } else {
    // 第一次装 / 给这台机器装一个能用的：设计默认 = 最新稳定版（§7.2）
    channel = 'lts';
  }

  const release = needChoice === 'choose-channel' ? null : pickNodeRelease(input.releases, channel);
  const direction = release ? nodePlanDirection(release.version, input.currentVersion) : null;
  /**
   * **这一次是不是「换档」**：在**所有**分支上都算（含 `install` 的设计默认），所以
   * `direction === 'older' ⟹ switchesChannel` **无条件成立** —— 是按构造保证的，不是靠
   * "跟随时现实中不会出现更低的目标"。两个来源：
   *   1. 目标档位与**当前档位**不同（显式换档，或 `install` 的设计默认正好跨了她当时的档 ——
   *      装了当前版的机器上点"安装"同样是一次换档，界面必须说得出「换成稳定版」）；
   *   2. 目标版本比现在低（同一档里退回旧版本同样是换档动作）。
   * 判不出当前档位时（`currentChannel === null`）没得比，一律 `false`。
   */
  const switchesChannel =
    direction === 'older' || (currentChannel !== null && channel !== currentChannel);
  return {
    method,
    channel,
    release,
    currentVersion: input.currentVersion,
    currentChannel,
    switchesChannel,
    direction,
    needChoice,
    // 直装恒为 true（官方安装包必须下载）；nvm 且机器上已经有可辨认的版本管理器 → false
    installsManager: method === 'nvm' ? !input.nvmPresent : true,
    refuse,
    coexistWarning: coexist ? NODE_COEXIST_WARNING : null,
  };
}

/** 判定 + 归属事实 → 计划里的那些 t29 字段（**只有这一处映射**：界面读到的就是判定本身） */
export interface NodePlanFacts {
  owner: EnvNodeOwner;
  nvmPresent: boolean;
  currentVersion: string | null;
  currentChannel: EnvNodeChannel | null;
  switchesChannel: boolean;
  direction: 'newer' | 'same' | 'older' | null;
  needChoice: 'choose-method' | 'choose-channel' | null;
  installsManager: boolean;
}

export function nodePlanFacts(
  owner: EnvNodeOwner,
  nvmPresent: boolean,
  decision: NodePlanDecision,
): NodePlanFacts {
  return {
    owner,
    nvmPresent,
    currentVersion: decision.currentVersion,
    currentChannel: decision.currentChannel,
    switchesChannel: decision.switchesChannel,
    direction: decision.direction,
    needChoice: decision.needChoice,
    installsManager: decision.installsManager,
  };
}

/**
 * 「开发者模式」的注册表值是不是开着（纯函数，喂 `reg query` 里那一段文本）。
 *
 * 认得出 `0x1` / `1` 才算 true；`0x0` / 没有这一项 / 读不出来都是 false
 * —— 这条只用来**决定要不要提醒用户去开它**，不用来拦人（没证据就不拦，与提权探测同款纪律）。
 */
export function isDeveloperModeEnabled(value: string | null): boolean {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  return text === '0x1' || text === '1';
}

// ---------------------------------------------------------------- 提权那一次的结果（纯函数，F-02）

/** 提权那一次的结果：成功 / 用户没允许 / **等太久** / 没跑通 */
export type ElevationOutcome = 'ok' | 'declined' | 'timeout' | 'failed';

/** 提权探测的原始事实（喂给下面的纯函数；夹具直接构造这四件事） */
export interface ElevationProbe {
  /** PowerShell 的退出码（没跑起来时 null） */
  code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  /** 我们自己的等待上限到了（UAC 对话框等了太久）—— **不是**"用户没允许" */
  timedOut: boolean;
}

/**
 * 一次提权尝试 → 四种结果之一（纯函数，离线可测）。
 *
 * 判定顺序即优先级，关键是**超时最先判**：它是"我们不等了"，与"用户点了否"是两件事，
 * 混在一起会把用户引到错误的下一步（F-02 第 1 条）。
 */
export function classifyElevationOutcome(probe: ElevationProbe): ElevationOutcome {
  if (probe.timedOut) return 'timeout';
  const text = `${probe.stdout}\n${probe.stderr}\n${probe.error ?? ''}`;
  if (/cancel|取消/i.test(text) && /operation|操作|request/i.test(text)) return 'declined';
  if (probe.error) return 'failed';
  const lines = probe.stdout.trim().split(/\r?\n/);
  const line = lines.length > 0 ? lines[lines.length - 1] : '';
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === 'object') {
      const record: Record<string, unknown> = { ...parsed };
      const exitCode = typeof record.ExitCode === 'number' ? record.ExitCode : null;
      if (exitCode === 0) return 'ok';
      return 'failed';
    }
  } catch {
    // 读不出 JSON：下面按退出码兜底
  }
  return probe.code === 0 ? 'ok' : 'failed';
}

/** 三种"没成功"的提权结果 → 各自的类别 / 文案 / 出路（纯函数；超时**不许**归成"没权限"） */
export function elevationFailure(outcome: Exclude<ElevationOutcome, 'ok'>): InstallFailureReason {
  if (outcome === 'timeout') {
    return {
      kind: 'elevation-timeout',
      message: ELEVATION_TIMEOUT_MESSAGE,
      hint: FAILURE_HINTS['elevation-timeout'],
    };
  }
  if (outcome === 'declined') {
    return {
      kind: 'elevation-declined',
      message: FAILURE_MESSAGES['elevation-declined'],
      hint: FAILURE_HINTS['elevation-declined'],
    };
  }
  return {
    kind: 'elevation-failed',
    message: FAILURE_MESSAGES['elevation-failed'],
    hint: FAILURE_HINTS['elevation-failed'],
  };
}

/**
 * 一段输出里有没有「Node 的版本号」（纯函数）。
 *
 * 「装完必须实测可用」这条判据（`<node> --version` 有输出）就落在它身上；
 * 提权超时之后那次事实复检用的是同一把尺 —— 链接建好了就该看到版本号，
 * 而没有 active version 时看到的是那句 `No active Node.js version is configured…`（VM 实测原文）。
 */
export function hasNodeVersionOutput(text: string): boolean {
  return /(?:^|\s)v?\d+\.\d+\.\d+(?:\s|$)/m.test(String(text ?? ''));
}

// ---------------------------------------------------------------- 有状态部分
