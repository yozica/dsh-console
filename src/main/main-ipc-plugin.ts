/**
 * IPC 注册层：插件装配层（`plugin:*`）。t57 从 `main.ts` 拆出来。
 *
 * 这一组最要紧的一条（与渲染层同源）：**渲染层递来的路径不可信** —— 名单 / 层栈由主进程现场重算。
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import { messageOf, type IpcContext } from './main-ipc-shared';
import type {
  PluginBundleEditResult,
  PluginInspectResult,
  PluginLayerEditAction,
  PluginLayerEditResult,
  PluginOpAction,
  PluginOpResult,
  PluginRescueResult,
} from '../shared/ipc';

export function registerPluginIpc(ctx: IpcContext): void {
  const { pluginManager, dshManager, send } = ctx;
  ipcMain.handle('plugin:inspect', async (): Promise<PluginInspectResult> => {
    // ---------------------------------------------------------------- 插件装配层
    // 只读：读 profile 的 package.json + 跑一次 `dsh web --dump-config`。
    // dsh 没在跑也要能用 —— 插件把启动打挂时，这一页恰恰是唯一的入口。
    try {
      return await pluginManager.inspect();
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  });

  // 装 / 卸 / 升级：走 `dsh plugin --profile web …`，输出边跑边推给渲染层。
  // 这三个都改 package.json 与 node_modules，所以做完要重启 dsh 才生效（界面负责提示）。
  ipcMain.handle(
    'plugin:run',
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<PluginOpResult> => {
      try {
        const { action, spec } = (request ?? {}) as { action?: PluginOpAction; spec?: string };
        if (action !== 'add' && action !== 'remove' && action !== 'update') {
          return { ok: false, error: '不认识的操作' };
        }
        return await pluginManager.runOperation(action, String(spec ?? ''), (chunk) =>
          send('plugin:output', { chunk }),
        );
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
  );

  ipcMain.handle('plugin:cancel', (): boolean => pluginManager.cancelOperation());

  // 救援：只看 dsh 自带的组合结果。配置被改坏时 --dump-config 会整条失败，这条通常还能成，
  ipcMain.handle('plugin:default-config', async (): Promise<PluginInspectResult> => {
    // 所以它是"插件页在配置坏掉时仍然可用"的兜底（见 §救援流程）。
    try {
      return await pluginManager.baseline();
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  });

  // 救援：把你的补丁层修回可用状态（补空数组 / 列备份 / 从备份恢复）。
  // 这些是"修"不是"编辑"：能不动就不动，真要动也先备份。
  ipcMain.handle(
    'plugin:rescue',
    (_event: IpcMainInvokeEvent, request: unknown): PluginRescueResult => {
      try {
        const { action, backup } = (request ?? {}) as {
          action?: 'repair-empty' | 'list-backups' | 'restore-backup';
          backup?: string;
        };
        if (action !== 'repair-empty' && action !== 'list-backups' && action !== 'restore-backup') {
          return { ok: false, error: '不认识的操作' };
        }
        const result = pluginManager.rescue(action, backup ? String(backup) : undefined);
        if (action !== 'list-backups') {
          dshManager.log(
            'info',
            result.changed
              ? `补丁层已修复：${result.detail ?? action}`
              : `补丁层未改动：${result.detail ?? action}`,
          );
        }
        return result;
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
  );

  // 救援：临时停用 / 恢复一个 bundle。改的是 profile 的 package.json（备份 + 原子写），
  // 而且**要重启 dsh 才生效**（bundle 列表是启动时读的），界面负责说清这一点。
  ipcMain.handle(
    'plugin:bundle-edit',
    (_event: IpcMainInvokeEvent, request: unknown): PluginBundleEditResult => {
      try {
        const { action, name, index } = (request ?? {}) as {
          action?: 'suspend' | 'restore';
          name?: string;
          index?: number;
        };
        if (action !== 'suspend' && action !== 'restore')
          return { ok: false, error: '不认识的操作' };
        const result = pluginManager.editBundle(action, String(name ?? ''), Number(index ?? -1));
        dshManager.log(
          'info',
          result.changed
            ? `bundle ${action === 'suspend' ? '已临时停用' : '已恢复'}：${result.detail ?? name}`
            : `bundle 未改动：${result.detail ?? name}`,
        );
        return result;
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
  );

  // 改你自己的补丁层（插入 / 禁用 / 启用 / 移除插入）：只动 profile 的 cordis.patch.yml，
  // 写之前备份。这一层是 patchReload: live —— 改完即时生效，不用重启 dsh。
  ipcMain.handle(
    'plugin:edit-layer',
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<PluginLayerEditResult> => {
      try {
        const { action, id, name } = (request ?? {}) as {
          action?: PluginLayerEditAction;
          id?: string;
          name?: string;
        };
        if (
          action !== 'disable' &&
          action !== 'enable' &&
          action !== 'insert' &&
          action !== 'remove-insert'
        ) {
          return { ok: false, error: '不认识的操作' };
        }
        const result = await pluginManager.editLayer({ action, id: String(id ?? ''), name });
        dshManager.log(
          'info',
          result.changed
            ? `补丁层已更新：${result.detail ?? action}（${result.file ?? ''}）`
            : `补丁层未改动：${result.detail ?? action}`,
        );
        return result;
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
  );
}
