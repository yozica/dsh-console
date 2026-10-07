/**
 * 运行环境自检在渲染层的共享状态（自检页、控制台页的横幅、插件页的「缺 pnpm」都读这一份）。
 *
 * 三条与主进程的分工：
 *   1. **判定在主进程**（`main/env-doctor.ts` 的纯函数 `judgeEnvironment`）：这里只搬运结论，
 *      不在界面上重新判断"什么算不正常"——那会让同一件事有两套口径。
 *   2. **报告是"拉"的**：契约里没有 `onEnvReport` 事件，所以 `envCheck()` 是唯一的取报告路径，
 *      缓存也由主进程持有（有缓存立刻给，`{ refresh: true }` 才清缓存重跑）。
 *      修复完成后的复检结果随 `EnvFixState.report` 回来，这里顺手并进同一份报告。
 *   3. **一键修复只递 action**：命令原文（`EnvFixPlan.display`）由主进程现算，这边只显示。
 *
 * 订阅只建一次（`wireEnvDoctor()` 幂等）：自检页常驻挂载，但谁先跑都不会重复订阅。
 */

import { ref, type Ref } from 'vue';

import type { EnvDoctorReport, EnvFixAction, EnvFixState, EnvPkgUpdates } from '../../shared/ipc';

const api = window.dshConsole;

/** 输出片段只留尾部：一次全局安装的输出可能很长，DOM 与内存都不该跟着涨 */
const OUTPUT_TAIL = 64000;

/** 最近一次自检报告（主进程那份缓存的镜像） */
export const envReport = ref<EnvDoctorReport | null>(null);
/** 正在拉报告（「重新检测」的 busy 态） */
export const envReportLoading = ref(false);
/** 拉报告时 IPC 自己出的错（不是"某项不满足"） */
export const envReportError = ref('');

/** 一键修复的当前状态：主进程是唯一状态机，这里只是镜像 */
export const envFix: Ref<EnvFixState> = ref({
  phase: 'idle',
  action: null,
  command: null,
  message: null,
  code: null,
  report: null,
});

/** 一键修复的流式输出（尾部 64 KB） */
export const envFixOutput = ref('');

/**
 * dsh / pnpm 的版本读数（本机这一份 vs 安装源上的目标）。
 *
 * 与报告分开的理由：报告是**离线探测**（首启门禁也读它），而这一份要上网查 registry。
 * 所以它是**按需**拉的（详情层打开 / 重新检测 / 一键修复完成之后），启动时不查 ——
 * 用户没打开这一页就不该替他发这个请求。null = 还没查过。
 *
 * 没有单独的 loading 位：这一份只决定按钮上**写不写目标版本**，不决定按钮能不能点
 * （"装最新版"这件事本来就不依赖它）——给它一个 busy 态只会让按钮在开页那一两秒里闪一下。
 */
export const pkgUpdates = ref<EnvPkgUpdates | null>(null);

let inflight: Promise<EnvDoctorReport | null> | null = null;
let pkgInflight: Promise<EnvPkgUpdates | null> | null = null;
let wired = false;

/** 建立唯一的订阅。幂等：重复调用不做第二次 */
export function wireEnvDoctor(): void {
  if (wired) return;
  wired = true;
  api.onEnvFixState((state) => applyEnvFixState(state));
  api.onEnvFixOutput((payload) => {
    envFixOutput.value = (envFixOutput.value + payload.chunk).slice(-OUTPUT_TAIL);
  });
}

/** 把一份修复状态并进共享状态；带复检报告时顺手刷新报告 */
export function applyEnvFixState(state: EnvFixState): void {
  const before = envFix.value;
  envFix.value = state;
  if (state.report) envReport.value = state.report;
  // 刚装完的那一份是**新版本**：行上的目标读数必须重算，否则"更新 dsh"会一直挂着
  // 装之前那个目标版本（用户会以为没装上）。只在相位真的翻到 done 时拉，running 时不动。
  if (state.phase === 'done' && before.phase !== 'done') void loadPkgUpdates(true);
}

/**
 * 拉一份报告。`refresh` 为真时请主进程清缓存重跑一轮（用户自己装了东西之后要看新结论）。
 * 同一时刻只发一次（并发调用共用同一次往返），其它情况有报告就直接给。
 */
export function loadEnvReport(refresh = false): Promise<EnvDoctorReport | null> {
  if (!refresh && envReport.value) return Promise.resolve(envReport.value);
  if (inflight) return inflight;
  envReportLoading.value = true;
  envReportError.value = '';
  const task = (async (): Promise<EnvDoctorReport | null> => {
    try {
      const report = await api.envCheck(refresh ? { refresh: true } : undefined);
      envReport.value = report;
      return report;
    } catch (cause) {
      envReportError.value = cause instanceof Error ? cause.message : String(cause);
      return null;
    } finally {
      envReportLoading.value = false;
    }
  })();
  inflight = task;
  // 清在赋值之后（而不是写在 finally 里）：`api.envCheck` 不存在时（界面与主进程半新半旧）
  // 那个 async 体会**同步**走完 finally，若在 finally 里清，紧接着的赋值又会把已结算的
  // Promise 挂回去 —— 之后每一次"有报告就直接给"都会拿到那个失败的旧结果。
  void task.then(() => {
    if (inflight === task) inflight = null;
  });
  return task;
}

/** 开始一轮修复前清掉上一轮的输出（主进程每轮从头发，这边也跟着从头贴） */
export function clearEnvFixOutput(): void {
  envFixOutput.value = '';
}

/**
 * 查一次版本读数（主进程那边还有 5 分钟缓存）。
 *
 * `refresh` 为真时请主进程绕过缓存重查。同一时刻只发一次（并发调用共用同一次往返）；
 * 已经有读数且不是强制刷新时直接给 —— 详情层每次打开都会调它，这一层再挡一道是为了少发 IPC。
 *
 * 查询失败**不是"这一页坏了"**：这里吞掉异常（界面按"查不到"降级，入口照旧、只是不写目标版本），
 * 与主进程"失败返回 null"是同一条口径。
 */
export function loadPkgUpdates(refresh = false): Promise<EnvPkgUpdates | null> {
  if (!refresh && pkgUpdates.value) return Promise.resolve(pkgUpdates.value);
  if (pkgInflight) return pkgInflight;
  const task = (async (): Promise<EnvPkgUpdates | null> => {
    try {
      const next = await api.envPkgUpdates(refresh ? { refresh: true } : undefined);
      pkgUpdates.value = next;
      return next;
    } catch {
      // 界面与主进程半新半旧时（`envPkgUpdates` 还不存在）也是走这一条：按"查不到"降级
      return null;
    }
  })();
  pkgInflight = task;
  // 与 loadEnvReport 同一个理由：清在赋值之后，别写在 finally 里（否则失败过的那一轮会被
  // 重新挂回去，之后每次"有读数就直接给"都拿到那个旧结果）。
  void task.then(() => {
    if (pkgInflight === task) pkgInflight = null;
  });
  return task;
}

/** 跑一个动作：返回值就是最终状态，事件也会到，两条路都并进同一份状态 */
export async function runEnvFix(action: EnvFixAction): Promise<EnvFixState> {
  const state = await api.envFix({ action });
  applyEnvFixState(state);
  return state;
}

/** 中断正在跑的修复（没有在跑的返回 false） */
export async function cancelEnvFix(): Promise<boolean> {
  return await api.envFixCancel();
}
