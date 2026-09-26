/**
 * IPC 注册层的公共件：`IpcContext`、`CloseAsk`，以及从 `main.ts` 搬过来的几个小工具（t57）。
 *
 * 这一层**不持有状态**：窗口、设置、各个 manager 都归 `main.ts`，这里只描述它递进来的形状 ——
 * 所以"IPC 层能碰到什么"读这一份就够，不必再翻 `main.ts`。
 *
 * 与其它拆出去的簇同一条规矩：**会变的都走 getter**（窗口关掉会新建、关闭询问每回合换一个对象、
 * 渲染层连接位是个布尔量、Shell 计数器是个数字），只有稳定的引用（Settings 与各 manager、
 * 那一个 Set）按值传。
 */

import type { BrowserWindow } from 'electron';

import type { Settings } from './settings';
import type { PtySessions } from './pty-sessions';
import type { DshManager } from './dsh-manager';
import type { SessionArchiveManager } from './session-archive';
import type { PluginManager } from './plugin-manager';
import type { EnvDoctor, EnvFixRunner } from './env-doctor';
import type { NodeInstaller } from './node-installer';
import type { Updater } from './updater';
import type { ThemeTools } from './main-theme';
import type { createExternalOpener } from './main-url';
import type { CloseAnswer, EnvInstallState, EnvNodeRequest, EnvWizardStepId } from '../shared/ipc';

/**
 * 一次"问渲染层要怎么关闭"的进行中状态。
 * `ack` = 卡片已经显示了（撤掉握手时限）；`answer` = 用户选完了（传 null 表示问不到）。
 */
export interface CloseAsk {
  ack: () => void;
  answer: (answer: CloseAnswer | null) => void;
}

/** `main.ts` 递给 IPC 层的一切（稳定引用或 getter，没有可变的单例值） */
export interface IpcContext {
  settings: Settings;
  ptySessions: PtySessions;
  dshManager: DshManager;
  archiveManager: SessionArchiveManager;
  pluginManager: PluginManager;
  envDoctor: EnvDoctor;
  envFixRunner: EnvFixRunner;
  nodeInstaller: NodeInstaller;
  updater: Updater;
  theme: ThemeTools;
  /** 外链的唯一入口（白名单 + 接住失败），见 main-url.ts */
  external: ReturnType<typeof createExternalOpener>;
  /** 推给渲染层（`theme:changed` / `settings:changed` / …） */
  send: (channel: string, payload: unknown) => void;
  /** 当前主窗口（可能是 null / 已销毁）：窗口关掉会新建，所以取的是函数而不是那一扇窗 */
  getWindow: () => BrowserWindow | null;
  /** 正在等渲染层回答的那次关闭询问；null = 没人在等 */
  pendingCloseAsk: () => CloseAsk | null;
  /** 渲染层连上来的那一刻要在快照里报一次（`app:snapshot` 只报第一次） */
  renderer: { isConnected: () => boolean; markConnected: () => void };
  /** 本地 Shell 的会话 id 集合：与 `main.ts` 的会话退出清理共用同一个 Set */
  extraSessions: Set<string>;
  /** 本地 Shell 的编号：id 与标题用同一个数（`shell-N` / `Shell N`） */
  shells: { next: () => number };
}

/**
 * 应用自带的运行时版本（快照的 `env.versions`，也是自检里「应用自带运行时」那一项的事实来源）。
 * 刻意只有这一处：两处各读一遍 `process.versions` 迟早会漂移，而这一项的价值就是"记录事实"。
 */
export function bundledVersions(): { electron: string; node: string; chrome: string } {
  return {
    electron: String(process.versions.electron ?? ''),
    node: String(process.versions.node ?? ''),
    chrome: String(process.versions.chrome ?? ''),
  };
}

// ---------------------------------------------------------------- 首启环境向导（门禁）的编排件

/**
 * 全局忙位：两个会动系统的入口共用**一把**锁（冻结 §4.4 / R-06）。
 * 既有的一键修复（改全局 npm 包）与安装通道（装 / 更新 Node）同时只能有一个在跑 ——
 * 两个动作一起改一台机器，结果不可预期。`detached`（我们不等了、但安装可能还在后台跑）
 * 仍然算忙：那是 `nodeInstaller.busy()` 自己的语义（R-06）。
 */
export function anyoneBusy(ctx: IpcContext): boolean {
  return ctx.envFixRunner.busy || ctx.nodeInstaller.busy();
}

/** 忙的时候那句统一的回话（与交互 §2.9 里按钮 `title` 的那句**同一句**） */
export const BUSY_MESSAGE = '正在执行上一步的操作，完成后按钮会自动恢复';

/**
 * 安装 / 更新的请求解析：**只认这三个字段**（冻结 §3.2.1 的形状 `{ mode, method?, channel? }`）。
 *
 * 渲染层只递选择，地址、版本、sha256 全部由主进程现场重算（与 `env:fix` 只收 action 同一条原则）——
 * 线缆上多出来的字段一概不看，写在这里就不会有人"顺手"采信渲染层递回来的 URL。
 *
 * `method` / `channel` **省略是合法的**：省略 = 跟随归属 / 跟随档位（VM-14 与 VM-15 的根治点）。
 * 只有显式给值才是"用户点名的那条路 / 那次换档"。
 */
export function parseNodeRequest(request: unknown): EnvNodeRequest | null {
  const { method, mode, channel } = (request ?? {}) as {
    method?: unknown;
    mode?: unknown;
    channel?: unknown;
  };
  if (mode !== 'install' && mode !== 'update') return null;
  if (method !== undefined && method !== 'direct' && method !== 'nvm') return null;
  if (channel !== undefined && channel !== 'lts' && channel !== 'current') return null;
  const parsed: EnvNodeRequest = { mode };
  if (method !== undefined) parsed.method = method;
  if (channel !== undefined) parsed.channel = channel;
  return parsed;
}

/** 被拒的回话：业务失败是状态里的 `phase: 'error'` + 一句中文，不抛（照阶段一 `env:fix`） */
export function refusedInstallState(ctx: IpcContext, message: string): EnvInstallState {
  return { ...ctx.nodeInstaller.state(), phase: 'error', message };
}

/**
 * 读设置里的「已跳过的步骤」。
 *
 * 设置文件是**用户手改得动**的：`"envSkips": null`（或写成字符串 / 数字）真的会出现，
 * 而 TS 的类型并不成立在运行期。这里在过线缆之前先把形状收回来 —— 判定函数自己也守着一层
 *（`judgeWizard` 对任何输入都不抛），两层都留着：一层不让坏形状往外走，一层保证结论一定有。
 */
export function wizardSkips(settings: Settings): EnvWizardStepId[] {
  const value: unknown = settings.get('envSkips');
  return Array.isArray(value) ? (value as EnvWizardStepId[]) : [];
}

/** 统一的"把 unknown 错误取成消息" */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
