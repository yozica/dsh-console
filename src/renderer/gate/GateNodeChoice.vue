<script setup lang="ts">
/**
 * 门禁第一步的**选择区**（t61 从 `EnvGate.vue` 拆出来）：版本档位那一组单选 + 安装方法那一组。
 *
 * 它**不持有选择**：方法 / 档位由父级拿着 —— 确认区（`GateNodeConfirm.vue`）读的是同一份状态，
 * 而且"两条路都没预选时不给开始"那条禁用判据也落在父级的操作行上。这里只把点击报回去，
 * 方法事实行与"要不要列两条路"由父级算好递下来（判据在 `shared/gate-copy.ts` 与父级的计划读取里）。
 */
import {
  CHANNEL_OPTIONS,
  CHANNEL_TITLES,
  METHOD_OPTIONS,
  METHOD_RISK,
} from '../shared/gate-copy.js';
import type { EnvNodeChannel, EnvNodeMethod, EnvWizardStepId } from '../../shared/ipc.js';

defineProps<{
  /** 这一屏画的是哪一步（只有第一步有选择区） */
  stepId: EnvWizardStepId;
  /** 全局忙位：安装 / 修复 / 后台还在装 */
  busy: boolean;
  /** 这一步正在装：两组控件同时禁用 */
  stepRunning: boolean;
  /** 当前那一档（用户没点过时是设计默认） */
  nodeChannel: EnvNodeChannel;
  /** 方法事实行那句话（判得出归属就说出来，否则给两条路） */
  methodFact: string;
  /** 要不要把两条路都列出来让用户选 */
  methodChoosable: boolean;
  /** 显示为"选中"的那一条（没点过时只有全新安装那一支给默认） */
  effectiveMethod: EnvNodeMethod | null;
  /** 一条都没选中：要先选一条（禁用态的原因写在界面上） */
  methodNeedsPick: boolean;
  /** 并存风险那句要不要出现 */
  methodRiskShown: boolean;
}>();

const emit = defineEmits<{
  'pick-method': [method: EnvNodeMethod];
  'pick-channel': [channel: EnvNodeChannel];
}>();

function pickMethod(method: EnvNodeMethod): void {
  emit('pick-method', method);
}

function pickChannel(channel: EnvNodeChannel): void {
  emit('pick-channel', channel);
}
</script>

<template>
  <div class="gate-choice">
    <!-- 档位：与"方法"**同级**的选择区控件（可聚焦的两选一）。它在未展开确认区时就看得到，
       不再藏在确认区里当一行小字按钮 —— 那正是 VM-15 的现场 -->
    <fieldset class="gate-choice-group">
      <legend class="gate-choice-legend">版本档位</legend>
      <div class="gate-choice-row">
        <label
          v-for="option in CHANNEL_OPTIONS"
          :key="option.id"
          class="gate-option gate-option-half"
          :class="{ selected: nodeChannel === option.id }"
        >
          <input
            type="radio"
            name="wizard-node-channel"
            :value="option.id"
            :checked="nodeChannel === option.id"
            :disabled="stepRunning || busy"
            @change="pickChannel(option.id)"
          />
          <span class="gate-option-body">
            <span class="gate-option-title">{{ option.title }}</span>
            <span class="gate-option-note">{{ option.note }}</span>
          </span>
        </label>
      </div>
      <p class="gate-option-hint">
        现在选的是：{{ CHANNEL_TITLES[nodeChannel] }}。装的是哪一档，看这里 —— 安装之前随时能改。
      </p>
    </fieldset>

    <!-- 方法：判得出归属就只给一条路；判不出来 / 一份 Node 都没有时两条路都列出来让用户选（需求 §7.8） -->
    <p class="gate-method-fact">{{ methodFact }}</p>
    <div v-if="methodChoosable" class="gate-choice-row">
      <label
        v-for="option in METHOD_OPTIONS"
        :key="option.id"
        class="gate-option"
        :class="{ selected: effectiveMethod === option.id }"
      >
        <input
          type="radio"
          name="wizard-node-method"
          :value="option.id"
          :checked="effectiveMethod === option.id"
          :disabled="stepRunning || busy"
          @change="pickMethod(option.id)"
        />
        <span class="gate-option-body">
          <span class="gate-option-title">{{ option.title }}</span>
          <span class="gate-option-note">{{ option.note }}</span>
          <span v-if="methodRiskShown" class="gate-option-risk">{{ METHOD_RISK }}</span>
        </span>
      </label>
    </div>
    <!-- 这条禁用态必须看得到原因（交互 §11.6）：两条路一条都不预选，是用户自己选 -->
    <p v-if="methodNeedsPick" class="gate-option-hint">
      两条路都没有替你预选：请先在上面选一条安装方式，再点「安装」。
    </p>
    <!-- 装到一半不能换路：禁用必须看得到原因（交互 §4.2） -->
    <p v-if="stepRunning" class="gate-option-hint">正在安装，请等它结束</p>
  </div>
</template>

<style scoped>
/* t61：这一条原来在 `EnvGate.vue` 的 <style scoped> 里，只有选择区在用；档位与方法那两张
   单选卡本身是全局零件（`.gate-option*` / `.gate-choice*`）。 */

/* 方法事实行：归属判得出来时**不给单选**，只把方法说出来（交互 §4.1 的 t29 修订 4-a） */
.gate-method-fact {
  margin: 12px 0 0;
  color: var(--ink-dim);
  font-size: var(--t-sm);
  line-height: 1.7;
}
</style>
