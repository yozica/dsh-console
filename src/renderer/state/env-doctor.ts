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

import type { EnvDoctorReport, EnvFixAction, EnvFixState } from '../../shared/ipc';

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

let inflight: Promise<EnvDoctorReport | null> | null = null;
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
  envFix.value = state;
  if (state.report) envReport.value = state.report;
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
