/**
 * 状态词：主进程给出的 phase → 界面上的人话。
 *
 * 外壳（左栏状态块、底栏、启动锁）和控制台页都要用，所以抽成模块，
 * 避免同一份文案在 app.js 和 Vue 组件里各写一遍、然后慢慢走样。
 */

import type { DshPhase } from '../../shared/ipc';

export interface PhaseText {
  title: string;
  desc: string;
}

/** 与 DshPhase 一一对应：新增状态时这里漏写会编译失败 */
export const PHASE_TEXT: Record<DshPhase, PhaseText> = {
  stopped: { title: '已停止', desc: 'dsh 没有在运行' },
  starting: { title: '启动中', desc: '进程已经建好，等端口开始响应' },
  running: { title: '运行中', desc: '健康检查通过，服务可用' },
  degraded: { title: '启动异常', desc: '进程还在，但端口一直没有响应' },
  stopping: { title: '停止中', desc: '等 dsh 自己退出' },
  external: {
    title: '运行中，外部实例',
    desc: '这个 dsh 不是本应用启动的，内嵌界面需要由本应用重新启动才能用',
  },
  conflict: { title: '端口被占用', desc: '这个端口上有别的进程在监听，dsh 拿不到它' },
};

/** 未知取值（比如主进程加了新状态而前端还没跟上）也要给得出话 */
export function phaseText(phase: string): PhaseText {
  if (phase in PHASE_TEXT) return PHASE_TEXT[phase as DshPhase];
  return { title: String(phase || ''), desc: '' };
}
