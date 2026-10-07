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
import { PNPM_PURE_JS_SPEC, pnpmInstallSpec } from './env-fix-plan';
import { loadPkgUpdates } from './pkg-updates';
import { hasVcRuntime } from './process-utils';
import type {
  EnvFixAction,
  EnvFixPlan,
  EnvFixState,
  EnvInstallState,
  EnvNodePlan,
  EnvPkgUpdates,
  EnvWizardState,
  EnvWizardStepId,
} from '../shared/ipc';

export function registerEnvIpc(ctx: IpcContext): void {
  const { settings, dshManager, envDoctor, envFixRunner, nodeInstaller, send } = ctx;

  /**
   * 取一份版本读数。缓存与查询都在 `pkg-updates.ts`（**执行侧要用同一份** ——
   * `EnvDoctor.fixPlan('update-pnpm')` 把目标版本钉进 argv，两边不一致就会"显示装到 A、实际装 B"）。
   *
   * 只在详情层打开 / 重新检测 / 修复完成之后被调（渲染层 `state/env-doctor.ts`），
   * **不进 `EnvDoctorReport`**（那条路首启门禁也在读，塞网络请求会把门禁变成"断网就进不去"）。
   */
  async function pkgUpdates(refresh = false): Promise<EnvPkgUpdates> {
    const report = await envDoctor.report();
    return await loadPkgUpdates({
      settings: settings.all(),
      installed: await envDoctor.installedVersions(),
      // pnpm 那一项的目标：有 pnpm 时按"同一大版本内最新"（更新路径），
      // 没有 pnpm 时按**安装线**（缺 VC++ 运行库那就是纯 JS 的 10.x）—— 后者由这里算好传进去
      pnpmBinding: report.pnpmBinding,
      pnpmInstallMajor: pnpmInstallSpec(hasVcRuntime()) === PNPM_PURE_JS_SPEC ? '10' : null,
      refresh,
    });
  }

  /**
   * 校验渲染层递回来的**版本号**（安全模型：递回来的字符串一概不采信，与"不采信它递回来的路径"同一条）。
   *
   * 四道闸门，缺一不可：
   *   ① **只有 `install-dsh` 接受它**（版本下拉只存在于 dsh 那一档）；`update-pnpm` / `install-pnpm`
   *      一律拒绝 —— 收下再悄悄忽略就是"显示 A、执行 B"，与方案 A 立下的不变量相反；
   *   ② 形状必须严格是 semver（`x.y.z` 可带预发布后缀）；
   *   ③ **必须落在这一轮从安装源取到的版本列表里**；
   *   ④ 列表拿不到（离线）时**拒绝**。绝不放一个没校验过的字符串进 argv。
   *
   * 为什么 pnpm 那一档不选版本（t84 用户裁定）：它的目标固定在 profile 那条**大版本线内的最新**，
   * 而跨大版本要连同 profile 的依赖一起迁移（store 布局按大版本走，见 `parseProfilePnpmMajor`），
   * 那是一次**单独的迁移动作**，不属于"更新 pnpm"。
   */
  async function resolveFixVersion(request: {
    action?: EnvFixAction;
    version?: unknown;
  }): Promise<{ ok: true; version: string | null } | { ok: false; message: string }> {
    const raw = request.version;
    if (raw === undefined || raw === null || raw === '') return { ok: true, version: null };
    if (typeof raw !== 'string') return { ok: false, message: '版本号必须是字符串。' };
    const wanted = raw.trim();
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(wanted)) {
      return { ok: false, message: `版本号的形状不对：${wanted}（要像 0.2.0-rc.2 这样）` };
    }
    if (request.action !== 'install-dsh') {
      return {
        ok: false,
        message:
          request.action === 'update-pnpm'
            ? 'pnpm 那一档不选版本：它的目标固定在 profile 那条大版本线内的最新版（跨大版本要连同 profile 的依赖一起迁移，那是一次单独的迁移动作）。'
            : '这个动作不接受版本参数。',
      };
    }
    const updates = await pkgUpdates(false);
    const list = updates.dsh.versions;
    if (list.length === 0) {
      return {
        ok: false,
        message: '这一轮没能从安装源取到版本列表，没法校验这个版本号；点「重新检测」再试一次。',
      };
    }
    if (!list.includes(wanted)) {
      return {
        ok: false,
        message: `安装源上没有这个版本：${wanted}（以这一轮取到的版本列表为准）`,
      };
    }
    return { ok: true, version: wanted };
  }
  // ---------------------------------------------------------------- 运行环境自检 + 一键修复
  // 报告不进快照：探测要起子进程（各 8 秒超时），塞进 app:snapshot 会把它拖成秒级。
  // 渲染层走 envCheck() 拉一份（有缓存立刻给），修复过程中的复检结果随 env:fix-state 回来。
  ipcMain.handle(
    'env:check',
    async (_event: IpcMainInvokeEvent, options?: { refresh?: boolean }) => {
      return await envDoctor.report(Boolean(options?.refresh));
    },
  );

  // 只接受 action（+ 可选的、**已校验**的版本号）：命令（file / args）由主进程用 fixPlan() 现场重算，
  // 渲染层递回来的路径与版本号一概不采信（与 7.18「救援时渲染层递来的路径不可信」同一条原则）。
  ipcMain.handle(
    'env:fix',
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<EnvFixState> => {
      const parsed = (request ?? {}) as { action?: EnvFixAction; version?: unknown };
      const action = parsed.action;
      if (action !== 'install-pnpm' && action !== 'install-dsh' && action !== 'update-pnpm') {
        return { ...envFixRunner.state(), phase: 'error', message: '不认识的修复动作' };
      }
      const checked = await resolveFixVersion({ action, version: parsed.version });
      if (!checked.ok) {
        dshManager.log('warn', `环境修复的版本号被拒绝：${checked.message}`);
        return { ...envFixRunner.state(), phase: 'error', message: checked.message };
      }
      // 与安装通道共用一把锁（冻结 §4.4）：忙则一个字都不写，把当前状态与原因回给界面
      if (anyoneBusy(ctx)) {
        return { ...envFixRunner.state(), phase: 'error', message: BUSY_MESSAGE };
      }
      try {
        return await envFixRunner.run(action, checked.version);
      } catch (error) {
        const message = `修复没能开始：${messageOf(error)}`;
        dshManager.log('error', `环境修复失败：${message}`);
        return { ...envFixRunner.state(), phase: 'error', message };
      }
    },
  );

  ipcMain.handle('env:fix-cancel', (): boolean => envFixRunner.cancel());

  // ---------------------------------------------------------------- 版本比对（只读查询）
  //
  // 「更新 dsh / 更新 pnpm」那两个入口要在按钮上写出目标版本，而**目标必须是那条命令真的会
  // 装到的版本** —— 否则会出现"提示有新版本、点了却装不到"，或者更糟：装完仍然提示有新版本
  // （永远不收敛）。判据见 `npm-registry.ts` 的 `pickPackageUpdate`，缓存与查询在 `pkg-updates.ts`。
  //
  // 失败一律降级：拿不到就当作"查不到"，界面不给按钮、也不编结论，**不把错误当结论展示**。
  ipcMain.handle(
    'env:pkg-updates',
    async (_event: IpcMainInvokeEvent, options?: { refresh?: boolean }): Promise<EnvPkgUpdates> => {
      return await pkgUpdates(Boolean(options?.refresh));
    },
  );

  // 确认区**按用户选的版本**再取一次计划 —— 与执行侧同一个 builder、同一份校验，
  // 所以"确认区里显示的那条命令"与"真正跑的那条"必然一致（显示 == 执行，方案 A 立下的不变量）。
  // 与 `envNodePlan` 同一套做法：计划类的走 invoke，过程类的走事件。
  ipcMain.handle(
    'env:fix-plan',
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<EnvFixPlan | null> => {
      const parsed = (request ?? {}) as { action?: EnvFixAction; version?: unknown };
      const action = parsed.action;
      if (action !== 'install-pnpm' && action !== 'install-dsh' && action !== 'update-pnpm') {
        return null;
      }
      const checked = await resolveFixVersion({ action, version: parsed.version });
      if (!checked.ok) return null;
      return await envDoctor.fixPlan(action, checked.version);
    },
  );

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
