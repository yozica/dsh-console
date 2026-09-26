/**
 * IPC 注册层：归档会话（`archive:*`）。t57 从 `main.ts` 拆出来。
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import { messageOf, type IpcContext } from './main-ipc-shared';
import type {
  ArchiveListResult,
  ArchiveReadResult,
  ArchiveRemoveResult,
  ArchiveUnarchiveResult,
} from '../shared/ipc';

export function registerArchiveIpc(ctx: IpcContext): void {
  const { archiveManager, dshManager } = ctx;
  // ---------------------------------------------------------------- 归档会话
  // 这些操作直接读写 DSH 磁盘数据；正在运行的 dsh 会把 workspace.json 读进内存，
  // 所以改动要等 dsh 重启后才同步到界面里 —— 返回里的 dshRunning 让渲染层据此提示。
  ipcMain.handle('archive:list', (): ArchiveListResult => {
    try {
      return {
        ok: true,
        ...archiveManager.homeInfo(),
        dshRunning: dshManager.sessionAlive,
        sessions: archiveManager.list(),
      };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  });

  ipcMain.handle('archive:read', (_event: IpcMainInvokeEvent, id: unknown): ArchiveReadResult => {
    try {
      return { ok: true, session: archiveManager.read(String(id)) };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  });

  ipcMain.handle(
    'archive:unarchive',
    (_event: IpcMainInvokeEvent, id: unknown): ArchiveUnarchiveResult => {
      try {
        return {
          ok: true,
          dshRunning: dshManager.sessionAlive,
          ...archiveManager.unarchive(String(id)),
        };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
  );

  ipcMain.handle(
    'archive:remove',
    (_event: IpcMainInvokeEvent, id: unknown): ArchiveRemoveResult => {
      try {
        return {
          ok: true,
          dshRunning: dshManager.sessionAlive,
          ...archiveManager.remove(String(id)),
        };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
  );
}
