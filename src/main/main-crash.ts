/**
 * 主进程兜底：未捕获的异常与未处理的 Promise 拒绝都要**落盘**，而且要把日志路径一起给人。
 * t57 从 `main.ts` 拆出来。
 *
 * 为什么要有：Electron 默认只弹一句英文 "A JavaScript error occurred in the main process"，
 * 我们自己的日志里什么都没有 —— 真机上那次"启动不了"，用户拿不到任何能发出来的东西，只能靠猜。
 *
 * 三个选择写在代码里：
 *   1. 用 `dialog.showErrorBox` —— 官方文档写明它**可以在 ready 之前安全调用**，正是为
 *      "启动早期报错"准备的（见 https://www.electronjs.org/docs/latest/api/dialog）；
 *   2. 记录之后**不退出**：与 Electron 的默认行为一致。硬退会把"还能用一半"变成"完全不能
 *      用"，而原因已经摆在用户眼前了；
 *   3. 只加监听、不改 console 的接管方式 —— 日志走既有通道，不另造一份。
 */

import { dialog } from 'electron';

import { describeValue } from './logger';

export interface CrashGuardContext {
  /** 当前日志文件路径（还没建起来时是 null）；弹框里要把它给人 */
  logFile: () => string | null;
}

export function installCrashGuards(ctx: CrashGuardContext): void {
  const report = (kind: string, value: unknown): void => {
    console.error(`[main] ${kind}：`, value);
    const file = ctx.logFile();
    const where = file ? `\n\n日志文件（把下面这段内容发出来就能定位）：\n${file}` : '';
    try {
      dialog.showErrorBox(`DSH Console 出错了（${kind}）`, `${describeValue(value)}${where}`);
    } catch {
      /* 连对话框都弹不出来（比如没有图形会话）：日志里已经有了 */
    }
  };
  process.on('uncaughtException', (error) => report('未捕获的异常', error));
  process.on('unhandledRejection', (reason) => report('未处理的 Promise 拒绝', reason));
}
