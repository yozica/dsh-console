<script setup lang="ts">
/**
 * 门禁这一步的**事实行与进行中进度**（t63 从 `EnvGate.vue` 拆出来）：两者占同一个槽位
 * （视觉 §5.5）—— 不在跑的时候摆事实行，在跑的时候摆状态行 + 进度 + 一个明确的按钮。
 * 底下还挂着第二步特有的一条：npm 都不能用时不给一个注定失败的「安装」，而是给 `corepack` 那条命令。
 *
 * **它不判定任何东西**：事实行、进度文案、百分比、停止按钮的文案与可见性都由父级算好递下来
 * （那些判据父级的结果行与输出面板也在用）。这里只画。
 */
import { copyToClipboard } from '../lib/clipboard.js';
import { FACT_STATUS_WORDS, type FactStatus } from '../lib/gate-copy.js';
import type { EnvWizardStepId } from '../../shared/ipc.js';

defineProps<{
  /** 这一屏画的是哪一步（只有第二步有 npm 那条交代） */
  stepId: EnvWizardStepId;
  /** 这一步正在跑：事实行换成进度区 */
  stepRunning: boolean;
  /** 事实行（这一步在生效配置里的读数） */
  currentFacts: { key: string; title: string; detail: string; status: FactStatus }[];
  /** 进行中那句状态（主进程给的 `message` 优先） */
  progressText: string;
  /** 进度百分比；算不出来时 null（那时不画进度条） */
  progressPercent: number | null;
  /** 「已下载 / 总共」（两个数缺一个就整行不出现） */
  progressBytes: string;
  /** 安装 / 等待阶段额外那句交代 */
  progressNotice: string;
  /** 停止按钮的文案 */
  stopLabel: string;
  /** 要不要给停止按钮（复检中不给） */
  stopVisible: boolean;
  /** npm 还不能用：第二步给 `corepack enable pnpm` 那条命令 */
  npmMissing: boolean;
}>();

const emit = defineEmits<{ stop: []; 'toggle-output': [] }>();

function stop(): void {
  emit('stop');
}

function toggleOutput(): void {
  emit('toggle-output');
}
</script>

<template>
  <!-- 事实行：进行中时由进度区占同一个槽位（视觉 §5.5） -->
  <template v-if="!stepRunning">
    <div class="gate-facts">
      <div v-for="row in currentFacts" :key="row.key" class="gate-fact" :data-status="row.status">
        <span class="lamp"></span>
        <div class="gate-fact-main">
          <div class="gate-fact-head">
            <span class="gate-fact-title">{{ row.title }}</span>
            <span class="gate-fact-state">{{ FACT_STATUS_WORDS[row.status] }}</span>
          </div>
          <p class="gate-fact-detail">{{ row.detail }}</p>
        </div>
      </div>
    </div>
  </template>

  <!-- 进行中：状态行 + 进度（能算才画）+ 一个明确的按钮 -->
  <div v-if="stepRunning" class="wizard-progress">
    <div class="wizard-progress-line">
      <span class="wizard-progress-dot" aria-hidden="true"></span>
      <span class="wizard-progress-text">{{ progressText }}</span>
    </div>
    <div v-if="progressPercent !== null" class="wizard-progress-track">
      <div class="wizard-progress-bar" :style="{ width: `${progressPercent}%` }"></div>
    </div>
    <p v-if="progressBytes" class="wizard-progress-bytes">{{ progressBytes }}</p>
    <p v-if="progressNotice" class="wizard-notice">{{ progressNotice }}</p>
    <div class="btn-row">
      <button v-if="stopVisible" class="btn small" @click="stop">{{ stopLabel }}</button>
      <button class="btn small ghost" @click="toggleOutput">显示详细输出</button>
    </div>
  </div>

  <!-- 步骤 2：npm 还不能用时不给一个注定失败的门（交互 §5.3） -->
  <template v-if="stepId === 'pnpm' && npmMissing && !stepRunning">
    <p class="gate-card-why">这台电脑上的 npm 还不能用，所以没法替你装 pnpm。</p>
    <div class="gate-fact-more">
      <code class="gate-detail-cmd">corepack enable pnpm</code>
      <button class="btn tiny" @click="copyToClipboard('corepack enable pnpm')">复制</button>
    </div>
  </template>
</template>

<style scoped>
/* t63：这些规则原来在 `EnvGate.vue` 的 <style scoped> 里 —— 事实行与进度区只有这一块在用，
   跟着组件走（`.wizard-progress*` / `.gate-fact-more` / `.lamp` 是全局零件）。 */

.gate-facts {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
}

.gate-fact {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.gate-fact .lamp {
  margin-top: 5px;
}

.gate-fact[data-status='ok'] .lamp {
  background: var(--run);
  box-shadow: 0 0 0 3px var(--run-soft);
}

.gate-fact[data-status='warn'] .lamp {
  background: transparent;
  border: 1.5px solid var(--amber);
}

.gate-fact[data-status='missing'] .lamp {
  background: var(--rose);
  box-shadow: 0 0 0 3px var(--rose-soft);
}

/* 已跳过与测不出来都不是"这台电脑的事实"：只有墨色，不借 amber / rose */
.gate-fact[data-status='skipped'] .lamp {
  background: transparent;
  border: 1.5px solid var(--ink-dim);
}

.gate-fact[data-status='unknown'] .lamp {
  background: transparent;
  border: 1.5px dashed var(--ink-faint);
}

.gate-fact-main {
  flex: 1 1 auto;
  min-width: 0;
}

.gate-fact-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.gate-fact-title {
  color: var(--ink);
  font-size: var(--t-md);
  font-weight: 600;
}

.gate-fact-state {
  color: var(--ink-faint);
  font-size: var(--t-xs);
}

.gate-fact[data-status='ok'] .gate-fact-state {
  color: var(--run);
}

.gate-fact[data-status='warn'] .gate-fact-state {
  color: var(--amber);
}

.gate-fact[data-status='missing'] .gate-fact-state {
  color: var(--rose);
}

.gate-fact-detail {
  margin-top: 3px;
  color: var(--ink-dim);
  font-size: var(--t-sm);
  line-height: 1.7;
  overflow-wrap: anywhere;
  user-select: text;
}
</style>
