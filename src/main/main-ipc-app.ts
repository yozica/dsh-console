/**
 * IPC 注册层：`app` / `theme` / `settings` / `dsh` / `session` / `shell` 这几组通道（t57 从 `main.ts` 拆出来）。
 *
 * 这里只有"把请求接到谁身上"这一件事：判定与状态都在各自的模块里（`dsh-manager` / `pty-sessions` /
 * `updater` / `settings`），这一层不重复它们的规则。
 */

import {
  app,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
} from 'electron';

import { bundledVersions, messageOf, type IpcContext } from './main-ipc-shared';
import * as processUtils from './process-utils';
import type { SettingsPatch, SettingsValues } from './settings';
import type {
  AppSnapshot,
  CloseAnswer,
  CloseAnswerAction,
  ConfirmRequest,
  CreateShellResult,
  DshActionResult,
  EnvInfo,
  RenameSessionResult,
  ThemeInfo,
  UpdateState,
} from '../shared/ipc';

export function registerAppIpc(ctx: IpcContext): void {
  const {
    settings,
    ptySessions,
    dshManager,
    envDoctor,
    updater,
    theme,
    external,
    send,
    pendingCloseAsk,
    extraSessions,
  } = ctx;
  ipcMain.handle('app:snapshot', (): AppSnapshot => {
    if (!ctx.renderer.isConnected()) {
      ctx.renderer.markConnected();
      console.log('[main] 渲染层已连接');
    }
    // 窗口可能是 null / 已销毁（关窗那几秒）：快照里的全屏状态只表达"有没有"
    const win = ctx.getWindow();
    const env: EnvInfo = {
      platform: process.platform,
      /** 是否打包运行：渲染层据此决定装不装开发期诊断快捷键 */
      packaged: app.isPackaged,
      /** 应用自身版本（设置页显示用） */
      app: app.getVersion(),
      /**
       * 本次是不是"覆盖升级后第一次启动"。
       * NSIS 在升级时会用 `--updated` 启动应用（见 electron-builder 的 NSIS 模板），
       * 渲染层据此在状态栏说一句"已更新到 x.y.z"。
       */
      updated: process.argv.includes('--updated'),
      /**
       * 系统窗口是否处于全屏（macOS 绿灯 / Windows F11）。
       * 渲染层据此决定要不要给红绿灯留位置 —— 全屏时它会自动隐藏。
       */
      nativeFullscreen: Boolean(win && !win.isDestroyed() && win.isFullScreen()),
      versions: bundledVersions(),
    };
    return {
      dsh: dshManager.snapshot(),
      settings: settings.all(),
      sessions: ptySessions.list(),
      launch: dshManager.describeLaunch(),
      env,
      update: updater.snapshot(),
      userData: app.getPath('userData'),
      theme: theme.themeInfo(),
    };
  });

  ipcMain.handle('theme:set', (_event: IpcMainInvokeEvent, mode: unknown): ThemeInfo => {
    const next = theme.applyThemeSource(mode);
    settings.patch({ themeMode: next });
    dshManager.log(
      'info',
      `界面主题：${next}${next === 'system' ? `（当前为${nativeTheme.shouldUseDarkColors ? '深色' : '亮色'}）` : ''}`,
    );
    return theme.broadcastTheme();
  });

  ipcMain.handle(
    'settings:patch',
    (_event: IpcMainInvokeEvent, patch: SettingsPatch): SettingsValues => {
      const next = settings.patch(patch);
      if (patch && 'themeMode' in patch) theme.applyThemeSource(next.themeMode);
      // 设置页里也能改主题，保持与工具栏开关一致
      dshManager.syncSettings();
      // 自动检查更新是开关式的：改完要立刻生效（开 → 排定时器，关 → 停）
      updater.syncSettings();
      dshManager.log('info', '设置已保存');
      theme.broadcastTheme();
      // 渲染层那份快照是共享状态的唯一真源：主进程写完必须推一次，否则"另一个组件读到旧值"。
      // 实例：环境自检页改「Node 下载来源」，首启门禁的确认区读的是同一份快照 ——
      // 不推的话那次保存只有发起方自己知道，门禁区会拿旧源拼计划说明。
      send('settings:changed', next);
      // 自检报告缓存要根据这几项失效：它们决定"怎么调 dsh / 在哪跑 / 用哪个 Shell"。
      // 这里**不主动重跑**（用户此刻在设置页，切到自检页时自然会拿到新结论）。
      if (patch && ('dshCommand' in patch || 'cwd' in patch || 'shell' in patch)) {
        envDoctor.invalidate();
      }
      return next;
    },
  );

  ipcMain.handle('dsh:start', async (): Promise<DshActionResult> => {
    try {
      return { ok: true, state: await dshManager.start({ allowAdopt: true }) };
    } catch (error) {
      return { ok: false, error: messageOf(error), state: dshManager.snapshot() };
    }
  });

  ipcMain.handle(
    'dsh:stop',
    async (_event: IpcMainInvokeEvent, options?: { force?: boolean; killExternal?: boolean }) => {
      try {
        return {
          ok: true,
          state: await dshManager.stop({
            force: Boolean(options?.force),
            killExternal: Boolean(options?.killExternal),
          }),
        };
      } catch (error) {
        return { ok: false, error: messageOf(error), state: dshManager.snapshot() };
      }
    },
  );

  ipcMain.handle('dsh:restart', async (): Promise<DshActionResult> => {
    try {
      return { ok: true, state: await dshManager.restart() };
    } catch (error) {
      return { ok: false, error: messageOf(error), state: dshManager.snapshot() };
    }
  });

  ipcMain.handle('dsh:input', (_event: IpcMainInvokeEvent, data: unknown): boolean => {
    dshManager.write(String(data ?? ''));
    return true;
  });

  ipcMain.handle(
    'dsh:resize',
    (_event: IpcMainInvokeEvent, size?: { cols?: number; rows?: number }): boolean => {
      dshManager.resize(Number(size?.cols), Number(size?.rows));
      return true;
    },
  );

  ipcMain.handle('dsh:replay', (): string => dshManager.replay());

  ipcMain.handle(
    'shell:create',
    (_event: IpcMainInvokeEvent, size?: { cols?: number; rows?: number }): CreateShellResult => {
      const counter = ctx.shells.next();
      const id = `shell-${counter}`;
      const target = processUtils.resolveShell(settings.all());
      const cwd = String(settings.get('cwd') || '') || processUtils.homeDir();
      // 标题由主进程持有（渲染层只显示），可以重命名；它只活在本次运行里 ——
      // 本地 Shell 不做任何持久化，下次启动就是全新的一页。
      const label = `Shell ${counter}`;
      const cols = Number(size?.cols) || 120;
      const rows = Number(size?.rows) || 30;
      try {
        ptySessions.create({
          id,
          file: target.file,
          args: target.args,
          cwd,
          cols,
          rows,
          // 行列也带给渲染层：界面重载后重新接上时按同样尺寸建立，
          // 第一次 fit 就是空操作，不会白触发一次 PTY resize
          meta: { kind: 'shell', label, command: target.display, cwd, cols, rows },
        });
        extraSessions.add(id);
        return { ok: true, id, label, command: target.display };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
  );

  ipcMain.handle(
    'session:input',
    (_event: IpcMainInvokeEvent, payload?: { id?: string; data?: string }): boolean => {
      ptySessions.write(String(payload?.id), String(payload?.data ?? ''));
      return true;
    },
  );

  ipcMain.handle(
    'session:resize',
    (
      _event: IpcMainInvokeEvent,
      payload?: { id?: string; cols?: number; rows?: number },
    ): boolean => {
      ptySessions.resize(String(payload?.id), Number(payload?.cols), Number(payload?.rows));
      return true;
    },
  );

  ipcMain.handle('session:kill', (_event: IpcMainInvokeEvent, id: unknown): boolean => {
    const killed = ptySessions.kill(String(id), true);
    extraSessions.delete(String(id));
    return killed;
  });

  /** 重命名本地 Shell 的标题：只活在本次运行里（终端标题由主进程持有，渲染层只显示） */
  ipcMain.handle(
    'session:rename',
    (
      _event: IpcMainInvokeEvent,
      payload?: { id?: string; label?: string },
    ): RenameSessionResult => {
      const id = String(payload?.id || '');
      const label = String(payload?.label || '')
        .trim()
        .slice(0, 40);
      if (!id || !label) return { ok: false, error: '名字不能为空' };
      ptySessions.rename(id, label);
      return { ok: true, id, label };
    },
  );

  ipcMain.handle('app:openExternal', async (_event: IpcMainInvokeEvent, url?: string) => {
    const target = url || dshManager.uiUrl || dshManager.origin;
    await external.openExternalSafely(target, '渲染层');
    return target;
  });

  ipcMain.handle('app:revealUserData', () => shell.openPath(app.getPath('userData')));

  ipcMain.handle('app:confirm', async (_event: IpcMainInvokeEvent, payload?: ConfirmRequest) => {
    const options: MessageBoxOptions = {
      type: payload?.type || 'question',
      buttons: payload?.buttons || ['取消', '确定'],
      defaultId: 1,
      cancelId: 0,
      title: payload?.title || '确认',
      message: payload?.message || '',
      detail: payload?.detail || '',
    };
    // 窗口可能已经关了：那时退化成不带父窗口的对话框（原来的写法也是这么兜的）
    const win = ctx.getWindow();
    const result =
      win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
    return result.response === 1;
  });

  // ---------------------------------------------------------------- 自动更新
  // 状态机在 main/updater.ts；这里只转发三个动作，状态变化由 updater 广播 app:update。
  ipcMain.handle('app:update-check', (): Promise<UpdateState> => updater.checkNow());

  ipcMain.handle('app:update-download', (): Promise<UpdateState> => updater.download());

  ipcMain.handle('app:update-install', (): boolean => updater.install());

  // ---------------------------------------------------------------- 关闭确认
  // 询问卡片在渲染层（layout/CloseDialog.vue）：主进程把"哪个 dsh 会受影响"这几项事实给它，
  // 它先回一条"卡片显示了"（撤掉握手时限），再把用户的选择答回来。
  // 没有进行中的询问时（例如已经被兜底或已回答过）两个 handler 都返回 false。
  ipcMain.handle('app:close-ack', (): boolean => {
    const ask = pendingCloseAsk();
    if (!ask) return false;
    ask.ack();
    return true;
  });

  ipcMain.handle(
    'app:close-answer',
    (_event: IpcMainInvokeEvent, answer?: CloseAnswer): boolean => {
      const ask = pendingCloseAsk();
      if (!ask) return false;
      // 渲染层传来的形状不可信：只认这三个动作，认不出来的当"取消"
      const action: CloseAnswerAction =
        answer &&
        (answer.action === 'tray' || answer.action === 'quit' || answer.action === 'cancel')
          ? answer.action
          : 'cancel';
      ask.answer({ action, remember: Boolean(answer?.remember) });
      return true;
    },
  );
}
