/**
 * IPC 注册层：`ipcMain.handle` 的全部入口（t57 从 `main.ts` 拆出来 —— 原来是它里面 558 行的 `registerIpc()`）。
 *
 * 按通道前缀分成四组叶子模块：`main-ipc-app`（app / theme / settings / dsh / session / shell）、
 * `main-ipc-archive`（archive）、`main-ipc-plugin`（plugin）、`main-ipc-env`（env 自检 / 首启向导 /
 * Node 通道）。注册顺序与拆分前一致 —— 通道名本来就唯一，顺序不影响行为，保持原样只为了让 diff 好读。
 *
 * `main.ts` 只做两件事：造一个 `IpcContext`、调这一个函数。想找"渲染层能调什么"，看这一层就够。
 */

import { registerAppIpc } from './main-ipc-app';
import { registerArchiveIpc } from './main-ipc-archive';
import { registerEnvIpc } from './main-ipc-env';
import { registerPluginIpc } from './main-ipc-plugin';
import type { IpcContext } from './main-ipc-shared';

export { bundledVersions, messageOf, wizardSkips } from './main-ipc-shared';
export type { CloseAsk, IpcContext } from './main-ipc-shared';

export function registerIpc(ctx: IpcContext): void {
  registerAppIpc(ctx);
  registerArchiveIpc(ctx);
  registerPluginIpc(ctx);
  registerEnvIpc(ctx);
}
