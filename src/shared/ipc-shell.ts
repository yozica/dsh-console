/**
 * 窗口外壳：主题、关闭询问与确认框
 *
 * 主进程 ↔ 渲染层契约的一部分（t55 从 `shared/ipc.ts` 拆出来的；那个文件现在只是 barrel）。
 * 约定不变：**只放类型与纯常量，禁止 import 任何运行时依赖**（渲染层要读这些类型，
 * 拖进 fs/path 就会被卷进包里）—— 叶子模块之间只允许 `import type`。
 */
import type { DshPhase } from './ipc-runtime';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/**
 * 点窗口关闭（X）时的行为（macOS 不适用：那边关窗就是关窗，Dock 常驻）。
 *
 * - `ask`：问一次「收起到托盘 / 退出应用」，对话框里带「记住我的选择」—— 默认值；
 * - `tray`：直接收起到系统托盘，应用与本应用启动的 dsh 继续在后台运行；
 * - `quit`：直接退出应用，按 `killOnExit` 决定要不要一并停掉 dsh。
 */
export type CloseAction = 'ask' | 'tray' | 'quit';

/** 用户在关闭确认卡片上选了什么（`cancel` = 什么都不做，窗口留着） */
export type CloseAnswerAction = 'tray' | 'quit' | 'cancel';

/**
 * 关闭确认卡片要展示的**事实**（主进程给）。
 *
 * 界面只负责把这几项写成人话，不自己判断"哪个 dsh 会被停掉" —— 那要看进程归属，
 * 只有主进程知道（`owned` 一看 pty 会话是否存在，见 7.5）。
 */
export interface CloseRequest {
  /** 退出时会不会一并停掉本应用启动的 dsh（设置 `killOnExit`） */
  killOnExit: boolean;
  /** dsh 是不是本应用启动的：只有它会被 `killOnExit` 停掉 */
  owned: boolean;
  /** dsh 的 PID；可能还没就绪（PTY 异步） */
  pid: number | null;
  /** dsh 当前相位：界面据此写"没在运行"那句话 */
  phase: DshPhase;
}

/** 渲染层对关闭询问的回答 */
export interface CloseAnswer {
  action: CloseAnswerAction;
  /** 勾了「记住我的选择」：主进程把它写回 `closeAction`，以后不再问 */
  remember: boolean;
}

export interface ThemeInfo {
  mode: ThemeMode;
  resolved: ResolvedTheme;
}

/** dsh 状态机的取值（与 main/dsh-manager.ts 的 PHASE 一一对应） */
