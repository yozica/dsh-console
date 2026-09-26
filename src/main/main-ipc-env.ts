/**
 * IPC 注册层：运行环境自检 + 一键修复、首启门禁、Node 安装 / 更新通道（`env:*`）。t57 从 `main.ts` 拆出来。
 *
 * 三组通道共用一把忙锁（冻结 §4.4 / R-06）：`anyoneBusy()` 一忙就一个字都不写，
 * 把当前状态与原因回给界面（判定与执行在 `env-doctor` / `node-installer` 里）。
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import {
  BUSY_MESSAGE,
  anyoneBusy,
  messageOf,
  parseNodeRequest,
  refusedInstallState,
  wizardSkips,
  type IpcContext,
} from './main-ipc-shared';
import {
  judgeWizard,
  WIZARD_STEP_IDS,
  WIZARD_STEP_LABEL,
  WIZARD_STEP_SKIPPABLE,
} from './env-doctor';
import type {
  EnvFixAction,
  EnvFixState,
  EnvInstallState,
  EnvNodePlan,
  EnvWizardState,
  EnvWizardStepId,
} from '../shared/ipc';

export function registerEnvIpc(ctx: IpcContext): void {
  const { settings, dshManager, envDoctor, envFixRunner, nodeInstaller, send } = ctx;
  // ---------------------------------------------------------------- 运行环境自检 + 一键修复
  // 报告不进快照：探测要起子进程（各 8 秒超时），塞进 app:snapshot 会把它拖成秒级。
  // 渲染层走 envCheck() 拉一份（有缓存立刻给），修复过程中的复检结果随 env:fix-state 回来。
  ipcMain.handle(
    'env:check',
    async (_event: IpcMainInvokeEvent, options?: { refresh?: boolean }) => {
      return await envDoctor.report(Boolean(options?.refresh));
    },
  );

  // 只接受 action：命令（file / args）由主进程用 fixPlan() 现场重算，
  // 渲染层递回来的路径一概不采信（与 7.18「救援时渲染层递来的路径不可信」同一条原则）。
  ipcMain.handle(
    'env:fix',
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<EnvFixState> => {
      const { action } = (request ?? {}) as { action?: EnvFixAction };
      if (action !== 'install-pnpm' && action !== 'install-dsh') {
        return { ...envFixRunner.state(), phase: 'error', message: '不认识的修复动作' };
      }
      // 与安装通道共用一把锁（冻结 §4.4）：忙则一个字都不写，把当前状态与原因回给界面
      if (anyoneBusy(ctx)) {
        return { ...envFixRunner.state(), phase: 'error', message: BUSY_MESSAGE };
      }
      try {
        return await envFixRunner.run(action);
      } catch (error) {
        const message = `修复没能开始：${messageOf(error)}`;
        dshManager.log('error', `环境修复失败：${message}`);
        return { ...envFixRunner.state(), phase: 'error', message };
      }
    },
  );

  ipcMain.handle('env:fix-cancel', (): boolean => envFixRunner.cancel());

  // ---------------------------------------------------------------- 首启环境向导（门禁）
  // 门禁结论靠 `envWizard` 拉取，**复用既有的报告缓存**（不新增探测路径、不新增报告事件）；
  // 安装过程照 `env:fix-*` 的做法用事件推（`env:install-state` / `env:install-output`）。
  ipcMain.handle(
    'env:wizard',
    async (
      _event: IpcMainInvokeEvent,
      options?: { refresh?: boolean },
    ): Promise<EnvWizardState> => {
      const report = await envDoctor.report(Boolean(options?.refresh));
      return judgeWizard(report, wizardSkips(settings));
    },
  );

  ipcMain.handle(
    'env:wizard-skip',
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<EnvWizardState> => {
      const { step, skip } = (request ?? {}) as { step?: EnvWizardStepId; skip?: boolean };
      if (step !== undefined && WIZARD_STEP_IDS.includes(step) && WIZARD_STEP_SKIPPABLE[step]) {
        // 未知 step 与不可跳过的 step（node / dsh）都是**幂等忽略**：一个字都不写，返回当前状态。
        // 反绕过：设置里塞了 node / dsh 也一样不生效（判定函数那边同样忽略）。
        const next = new Set(wizardSkips(settings));
        if (skip) next.add(step);
        else next.delete(step);
        settings.patch({ envSkips: WIZARD_STEP_IDS.filter((id) => next.has(id)) });
        dshManager.log(
          'info',
          `环境向导：${skip ? '跳过' : '恢复'}「${WIZARD_STEP_LABEL[step]}」（设置项 envSkips）`,
        );
        // 设置是主进程写的，渲染层那份快照要跟着刷新（"已跳过"标记在向导、自检页、放行页三处都要一致）
        send('settings:changed', settings.all());
      }
      const report = await envDoctor.report();
      return judgeWizard(report, wizardSkips(settings));
    },
  );

  // ---------------------------------------------------------------- Node 安装 / 更新通道
  ipcMain.handle(
    'env:node-plan',
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<EnvNodePlan | null> => {
      const parsed = parseNodeRequest(request);
      if (!parsed) {
        dshManager.log(
          'warn',
          '安装计划：不认识的选择（install|update 必需；method 可省略 = 跟随归属，给值只认 direct|nvm）',
        );
        return null;
      }
      try {
        return await nodeInstaller.plan(parsed);
      } catch (error) {
        dshManager.log('error', `安装计划没能取到：${messageOf(error)}`);
        return null;
      }
    },
  );

  ipcMain.handle(
    'env:node-install',
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<EnvInstallState> => {
      const parsed = parseNodeRequest(request);
      if (!parsed)
        return refusedInstallState(
          ctx,
          '不认识的操作：安装只接受 install|update（method 可省略 = 跟随归属）',
        );
      if (anyoneBusy(ctx)) return refusedInstallState(ctx, BUSY_MESSAGE);
      try {
        return await nodeInstaller.run(parsed);
      } catch (error) {
        // 引擎的业务失败不抛（终态是 phase: 'error'），走到这里说明是意外
        const message = `安装没能开始：${messageOf(error)}`;
        dshManager.log('error', `Node 安装失败：${message}`);
        return refusedInstallState(ctx, message);
      }
    },
  );

  ipcMain.handle('env:node-stop', (): EnvInstallState => nodeInstaller.stop());
  // 停止：下载 / 校验 = 真取消并删临时文件；安装 / 等待 = 只停止等待（**不杀安装器**）。
  // 这个语义完全由引擎的 EnvInstallState 表达（cancellable / detached），主进程不重复判断。
}
