<script setup lang="ts">
/**
 * 主界面常驻横幅：逃生之后（环境仍然缺东西）与"这一轮没测全"两种。
 *
 * 交互依据 docs/env-wizard-interaction.md §2.6 / §2.8，视觉依据 §5.8。四条硬要求：
 *   1. **不可关闭**：没有 ✕、不浮起、不动画、不随内容滚走 —— 它不是"刚刚发生了什么"，
 *      是"现在仍然成立的事实"；
 *   2. **出现条件来自报告与相位，不来自"向导走过没有"**：环境自己变好了它就自己消失；
 *   3. 它只**指路**（一个按钮），不重复讲步骤、不显示进度 —— 否则用户会以为横幅自己会动；
 *   4. 弹出条件里必须排除"门禁层正在显示"（那时横幅没有意义，而且会被覆盖层压住）。
 *
 * 两种横幅都是既有 `.banner` 的形状（`--amber-soft` + 发丝线圆角块），不另画一套。
 */
import { computed } from 'vue';

import {
  gatePhase,
  gateVisible,
  loadWizard,
  reopenGate,
  wizard,
  wizardError,
} from '../lib/env-wizard.js';

/** 环境明确缺东西（有证据） */
const blocked = computed(() => wizard.value !== null && wizard.value.gate === 'blocked');
/** 没有明确缺失，但有测不出来的（不挡人） */
const notFull = computed(() => wizard.value !== null && wizard.value.gate === 'unknown');

/**
 * 逃生之后：用户从挡住页离开，环境仍然缺东西 → 「继续配置」。
 * `escaped` 是用户点的，`done` 是逃生之后某一轮判定的收敛相位 —— 两种都要显示。
 */
const showEscape = computed(
  () =>
    !gateVisible.value &&
    blocked.value &&
    (gatePhase.value === 'escaped' || gatePhase.value === 'done'),
);

/**
 * 没测全：一条黄条 + 两个按钮，直到报告里不再有测不出来的步骤。
 * 探测**自己失败**（连第一份报告都没拿到）时也走这一条 —— 否则界面上什么都没有，
 * 用户会以为"环境没问题"（那是我们最不该给的一种错觉）。
 */
const showNotFull = computed(
  () =>
    !gateVisible.value && (notFull.value || (wizard.value === null && Boolean(wizardError.value))),
);

/** 当前（或第一个）没完成的步骤那句"为什么它还是缺的"：结论由判定给出，界面不自己写 */
const stepDetail = computed(() => {
  const state = wizard.value;
  if (!state) return '';
  const step =
    state.steps.find((item) => item.id === state.currentStepId) ??
    state.steps.find((item) => item.status === 'todo');
  return step ? step.detail : '';
});

/** 没测全的原因：判定给的原因优先，其次是探测自己报的错 */
const reason = computed(() => {
  const state = wizard.value;
  if (!state) return wizardError.value || '这一轮没测全';
  return state.gateReason || state.report.error || wizardError.value || '这一轮没测全';
});

function refresh(): void {
  void loadWizard({ refresh: true });
}

function openWizard(): void {
  // 用户显式发起的新一轮：允许把门禁层重新显示出来（第三次逃生也仍然有效）
  reopenGate();
}
</script>

<template>
  <div v-if="showNotFull" class="banner">
    <svg class="i"><use href="#i-warn" /></svg>
    <span><b>这一轮没测全</b>（原因：{{ reason }}），下面的结论可能不准。</span>
    <div class="gate-banner-actions">
      <button class="btn small" @click="refresh">重新检测</button>
      <button class="btn small" @click="openWizard">打开环境向导</button>
    </div>
  </div>
  <div v-else-if="showEscape" class="banner">
    <svg class="i"><use href="#i-warn" /></svg>
    <span><b>运行环境还没准备好：</b>{{ stepDetail }}</span>
    <div class="gate-banner-actions">
      <button class="btn small primary" @click="openWizard">继续配置</button>
    </div>
  </div>
</template>
