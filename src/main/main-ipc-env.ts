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
import {
  DSH_PACKAGE,
  fetchPackageMetadata,
  normalizeRegistryBase,
  packageNameOfSpec,
  pickPackageUpdate,
} from './npm-registry';
import { hasVcRuntime } from './process-utils';
import type {
  EnvFixAction,
  EnvFixState,
  EnvInstallState,
  EnvNodePlan,
  EnvPkgUpdates,
  EnvWizardState,
  EnvWizardStepId,
} from '../shared/ipc';

/**
 * 版本比对的缓存时长：5 分钟。与模型目录缓存同量级 —— 这一轮查不到时不许把人长期锁在
 * "查不到"上（用户装完再点一次「重新检测」就该重新问一遍）。
 */
const PKG_UPDATE_TTL_MS = 5 * 60 * 1000;

/** 单次查询的超时：几秒。超时不是"已是最新"，是"这一轮查不到"（见 npm-registry.ts 的文件头） */
const PKG_QUERY_TIMEOUT_MS = 8000;

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

  // ---------------------------------------------------------------- 版本比对（只读查询）
  //
  // 「更新 dsh / 更新 pnpm」那两个入口要在按钮上写出目标版本，而**目标必须是那条命令真的会
  // 装到的版本** —— 否则会出现"提示有新版本、点了却装不到"，或者更糟：装完仍然提示有新版本
  // （永远不收敛）。判据见 `npm-registry.ts` 的 `pickPackageUpdate`。
  //
  // 它**不进 `envDoctor.report()`**：那条路首启门禁也在读，往里塞网络请求会把门禁变成
  // "断网就进不去"。所以是一条按需的只读通道 + 5 分钟内存缓存，只在详情层打开 / 重新检测 /
  // 修复完成之后被调一次（渲染层 `state/env-doctor.ts` 的 `loadPkgUpdates`）。
  //
  // 失败一律降级：拿不到就当作"查不到"，界面退回不带版本号的更新入口，**不把错误当结论展示**。
  let pkgUpdatesCache: { at: number; value: EnvPkgUpdates } | null = null;

  ipcMain.handle(
    'env:pkg-updates',
    async (_event: IpcMainInvokeEvent, options?: { refresh?: boolean }): Promise<EnvPkgUpdates> => {
      const now = Date.now();
      if (!options?.refresh && pkgUpdatesCache && now - pkgUpdatesCache.at < PKG_UPDATE_TTL_MS) {
        return pkgUpdatesCache.value;
      }
      const value = await collectPkgUpdates();
      pkgUpdatesCache = { at: Date.now(), value };
      return value;
    },
  );

  /** 两项一起查（一次查询两个包，并行）。**只读**：不改用户的 .npmrc、不写任何配置文件。 */
  async function collectPkgUpdates(): Promise<EnvPkgUpdates> {
    const installed = await envDoctor.installedVersions();
    const base = normalizeRegistryBase(settings.all().pluginRegistry);
    // pnpm 装哪一档由 VC++ 运行库决定（VM-09）：缺运行库时那条线装的是 `pnpm@10`。
    // 目标版本必须跟着**同一条线**取，否则会出现"提示有新版本、点了却装不到"。
    const pnpmSpec = pnpmInstallSpec(hasVcRuntime());
    const [dshMeta, pnpmMeta] = await Promise.all([
      fetchPackageMetadata(DSH_PACKAGE, { base, timeoutMs: PKG_QUERY_TIMEOUT_MS }),
      fetchPackageMetadata(packageNameOfSpec(pnpmSpec), { base, timeoutMs: PKG_QUERY_TIMEOUT_MS }),
    ]);
    const value: EnvPkgUpdates = {
      checkedAt: Date.now(),
      // 不带版本的 spec（`@deepseek-ai/dsh`）装的就是 registry 的 latest 标签，所以 allowMajor 不给
      dsh: pickPackageUpdate({ current: installed.dsh, metadata: dshMeta }),
      // `pnpm@10` 那条线装的是"10.x 里最高的已发布版本"，所以把主版本号递下去
      pnpm: pickPackageUpdate({
        current: installed.pnpm,
        metadata: pnpmMeta,
        allowMajor: pnpmSpec === PNPM_PURE_JS_SPEC ? '10' : null,
      }),
    };
    // 一行证据落日志：排查"为什么行上没有版本读数"时，这条比问用户快
    dshManager.log(
      'info',
      `版本比对：安装源 ${base} → dsh 本机 ${value.dsh.current ?? '（没测到）'} / 目标 ${
        value.dsh.target ?? '（没查到）'
      }；pnpm（${pnpmSpec}）本机 ${value.pnpm.current ?? '（没测到）'} / 目标 ${
        value.pnpm.target ?? '（没查到）'
      }`,
    );
    return value;
  }

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
