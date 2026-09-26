<script setup lang="ts">
/**
 * 门禁这一步的**「展开看详情」**（t65 从 `EnvGate.vue` 拆出来）：把这一屏那几项检查的原文摊开。
 *
 * 位置本身是定过的（视觉 §5.5 / 交互 §11.1）：它排在两个操作**之后**，Tab 顺序是
 * 单选项 → 主操作 → 次操作 → 展开详情 → 重新检测 → 逃生口。搬走时位置一个字没动。
 *
 * **它不持有状态**：展开的是哪一步（`detailsFor`）归父级 —— 同一份状态在"收起详情"与切步骤时都要用。
 */
import { CHECK_TITLES } from '../shared/gate-copy.js';
import type { EnvCheck, EnvWizardStepId } from '../../shared/ipc.js';

defineProps<{
  /** 这一屏画的是哪一步 */
  stepId: EnvWizardStepId;
  /** 这一步正在跑：跑的时候不给展开器（那时槽位归进度区） */
  stepRunning: boolean;
  /** 这一步的检查项 */
  checks: EnvCheck[];
  /** 现在展开着的是哪一步（null = 都收着） */
  detailsFor: EnvWizardStepId | null;
}>();

const emit = defineEmits<{ toggle: [stepId: EnvWizardStepId] }>();

function toggleDetails(id: EnvWizardStepId): void {
  emit('toggle', id);
}
</script>

<template>
  <!-- 「展开看详情」排在两个操作**之后**：交互 §11.1 / §11.4 的 Tab 顺序是
     单选项 → 主操作 → 次操作 → 展开详情 → 重新检测 → 逃生口。
     它原来是跟在事实行后面的（视觉 §5.0 A 把展开器画在事实行右端），那会让它排在
     两个操作之前 —— 评审 T11-C 指出的正是这条冲突。两份规格在这里只能满足一个：
     交互给的是**逐项枚举**、视觉那里只是一张排布示意，所以按交互定稿（Tab 与它一致），
     视觉上的代价是展开器不再画在事实行右端。若要改判回原位置，回退动作就是把这一个
     `div.gate-fact-more` 移回上方事实行之后，并在 `docs/env-wizard-interaction.md`
     §11.1 显式记下这次偏离（冻结 §9 的留痕规则）—— 两处都可查。 -->
  <div v-if="!stepRunning && checks.length" class="gate-fact-more">
    <button class="btn tiny ghost" @click="toggleDetails(stepId)">
      {{ detailsFor === stepId ? '收起详情' : '展开看详情' }}
    </button>
    <dl v-if="detailsFor === stepId" class="gate-detail">
      <div v-for="check in checks" :key="check.id" class="gate-detail-row">
        <dt class="gate-detail-key">{{ CHECK_TITLES[check.id] }}</dt>
        <dd class="gate-detail-val">
          {{ check.detail }}
          <code v-if="check.fixHint" class="gate-detail-cmd">{{ check.fixHint }}</code>
        </dd>
      </div>
    </dl>
  </div>
</template>
