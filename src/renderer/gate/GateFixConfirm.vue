<script setup lang="ts">
/**
 * 门禁里**一键修复（pnpm / dsh）的确认区**（t62 从 `EnvGate.vue` 拆出来）：命令原文与目标目录
 * 都来自主进程的计划，这一层只摆事实 + 两个按钮。
 *
 * 与 Node 那条路的确认区（`GateNodeConfirm.vue`）分开：那一条要选方法 / 档位、要读计划里的归属，
 * 这一条只有"将要执行什么"；两份计划也是两种形状（`EnvFixPlan` / `EnvNodePlan`）。
 */
import { ref } from 'vue';

import { BUSY_HINT } from '../shared/gate-copy.js';
import type { EnvFixPlan } from '../../shared/ipc.js';

defineProps<{
  /** 主进程给的那份修复计划（命令 / 目标目录 / 说明） */
  plan: EnvFixPlan;
  /** 「下载来源」那一行：用户设置过安装源时说出 host */
  sourceText: string;
  /** 全局忙位 */
  busy: boolean;
}>();

const emit = defineEmits<{ start: []; close: [] }>();

/** 父级打开确认区（或换了动作）时把焦点交给主按钮 */
const startRef = ref<HTMLButtonElement | null>(null);

function focusStart(): void {
  startRef.value?.focus();
}

defineExpose({ focusStart });
</script>

<template>
  <!-- 一键修复（pnpm / dsh）的确认区：命令原文与目标目录都来自主进程的计划 -->
  <div class="gate-confirm">
    <div class="gate-confirm-title">将要执行</div>
    <code class="gate-confirm-cmd">{{ plan.display }}</code>
    <div class="gate-confirm-table">
      <div class="gate-confirm-row">
        <span class="gate-confirm-key">下载来源</span>
        <span class="gate-confirm-val">{{ sourceText }}</span>
      </div>
      <div class="gate-confirm-row">
        <span class="gate-confirm-key">会装到哪里</span>
        <span class="gate-confirm-val gate-confirm-mono">
          {{ plan.target || '（全局 npm 目录）' }}
        </span>
      </div>
      <div class="gate-confirm-row">
        <span class="gate-confirm-key">要不要联网</span>
        <span class="gate-confirm-val">是</span>
      </div>
      <div class="gate-confirm-row">
        <span class="gate-confirm-key">要不要管理员权限</span>
        <span class="gate-confirm-val">不需要</span>
      </div>
      <div class="gate-confirm-row">
        <span class="gate-confirm-key">会改什么</span>
        <span class="gate-confirm-val">{{ plan.note }}</span>
      </div>
    </div>
    <div class="btn-row">
      <button
        ref="startRef"
        class="btn small primary"
        :disabled="busy"
        :title="busy ? BUSY_HINT : undefined"
        @click="emit('start')"
      >
        开始
      </button>
      <button class="btn small" @click="emit('close')">取消</button>
    </div>
  </div>
</template>
