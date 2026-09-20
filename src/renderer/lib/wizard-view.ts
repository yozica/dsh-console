/**
 * 向导正文「正在看哪一步」的纯逻辑（t43 / 冻结 §0.3 的 R-29 / R-30）。
 *
 * 为什么单独一个文件：这几条规则是**能测的**（左轨哪些节点可点、正文画哪一步、判定前进时提示什么），
 * 而 `lib/env-wizard.ts` 在模块求值时就摸 `window.dshConsole` —— 自检/反例脚本 import 不了它。
 * 所以判定放这里（纯函数，只吃契约类型），状态与订阅留在 `env-wizard.ts`，界面只管画。
 *
 * 三条规则（交互 §2.4「左轨节点能点什么」那三张表是它们的文案版）：
 *   1. **只有走过的步骤能点开看**（已完成 / 已跳过）。当前这一步点了等于「回到当前」；
 *      还没轮到的步骤不可点（保持 R-01 ② 的原意）。
 *   2. 正文画的是**钉住的那一步**（如果它还看得动），否则跟着判定给出的当前步骤。
 *   3. 钉住期间判定前进了 → **不把用户推走**，只在卡片上方出一行提示。
 */

import type { EnvWizardStep, EnvWizardStepId } from '../../shared/ipc';

/**
 * 这一步能不能被点开来看。
 *
 * `done` / `skipped` 都可以（跳过也是"走过的"：用户想回看自己跳过了什么）。
 * 当前步骤返回 false —— 点了它的意思是「回到当前」，由调用方把钉住清掉，而不是钉住它。
 * `unknown` / `todo` / 正在跑的当前步骤都不给点：前者是"我们没测出来"，后两者是"还没轮到"。
 */
export function canViewStep(step: EnvWizardStep, currentStepId: EnvWizardStepId | null): boolean {
  if (step.id === currentStepId) return false;
  return step.status === 'done' || step.status === 'skipped';
}

/**
 * 正文该画哪一步：钉住的那一步优先（且**必须仍然看得动** —— 报告换了之后它可能已经不是 `done` 了，
 * 那就静默回到判定给的当前步骤，不要停在一条不再成立的回看上），否则跟着判定。
 */
export function resolveViewedStep(
  currentStepId: EnvWizardStepId | null,
  pinnedStepId: EnvWizardStepId | null,
  steps: EnvWizardStep[],
): EnvWizardStepId | null {
  if (pinnedStepId) {
    const pinned = steps.find((step) => step.id === pinnedStepId);
    if (pinned && canViewStep(pinned, currentStepId)) return pinned.id;
  }
  return currentStepId;
}

/** 「判定前进」那行提示的形状（文案在下面拼，`action` 是按钮上的字） */
export interface AdvanceNotice {
  text: string;
  action: string;
}

/**
 * 一次「钉住回看」的完整事实：钉的是哪一步 + **钉住那一刻判定给的当前步骤**。
 *
 * 为什么是一个对象而不是两个可空 id：从**放行页**（三步都完成、`currentStepId` 本来是 null）
 * 点开回看时，"钉住时本来就没有当前步骤"与"压根没钉住"如果都表示成 `null` 就分不开了 ——
 * 于是那种回看下判定后来变成"已放行"时出不了「三步都完成了」那行提示（真机验证抓到的第二处）。
 */
export interface ViewPin {
  stepId: EnvWizardStepId;
  currentAtPin: EnvWizardStepId | null;
}

/**
 * 钉住之后判定前进了 → 提示什么（没钉住、或判定没动时返回 null）。
 *
 * 第二个参数是**钉住那一刻判定给的当前步骤**（不是"正在看的那一步"）：比较它才回答得了
 * "判定前进了没有"。只比"正在看的 ≠ 当前"会把"用户往回翻看、当前步骤原地没动"也当成前进，
 * 于是回看第一步时会冒出一句错的「下一步（安装 dsh）也已经就绪了」—— dsh 那时候还没好。
 *
 * 两种前进：① 当前步骤往后挪了 → 「下一步（<标题>）也已经就绪了」+「继续」；
 * ② 三步全部完成（判定给的当前步骤变成 null）→ 「三步都完成了」+「看看结果」。
 * 标题由调用方给（界面的 `STEP_TITLES` 是渲染层常量，不进契约）。
 */
export function advanceNotice(
  currentStepId: EnvWizardStepId | null,
  pin: ViewPin | null,
  titleOf: (id: EnvWizardStepId) => string,
): AdvanceNotice | null {
  // 没钉住（正文跟着判定）/ 钉住状态已经不成立 → 没有"前进"可言
  if (!pin) return null;
  // 钉住之后判定没动 → 用户只是在回看，不出提示（回看卡上的「回到当前步骤」已经说清了去处）
  if (currentStepId === pin.currentAtPin) return null;
  if (!currentStepId) return { text: '三步都完成了', action: '看看结果' };
  return { text: `下一步（${titleOf(currentStepId)}）也已经就绪了`, action: '继续' };
}
