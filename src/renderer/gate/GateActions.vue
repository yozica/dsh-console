<script setup lang="ts">
/**
 * 门禁这一步的**操作行**（t62 从 `EnvGate.vue` 拆出来）：一屏唯一一处强调色实底 + 一条次操作，
 * 以及 pnpm 那一步"跳过之后会怎样"的那句说明。
 *
 * 三条分支按步骤分：第一步是「安装」（两条路一条都没预选时禁用）+「我想自己去官网下载安装」；
 * 第二步是「安装」+「先跳过这一步」；第三步只有「安装」。**它不判定任何东西**：禁用与 title
 * 里的原因都由父级算好递下来（`methodNeedsPick` / `busy` / `npmMissing` 那些判据父级的别处也在用）。
 *
 * 它**没有**自己的 scoped 样式块：用到的两个 class（`.gate-actions` / `.gate-option-hint`）父组件
 * 那边也在用，按 §7.33 都在全局表 —— `.gate-actions` 曾经被放进这里，结果父组件那两处收不到它。
 * （读这两层样式的自检按**行首**锚定来切样式块，所以这段说明里不写那个标签的字面量，
 * 免得多出一处假的"开始标记"把整份文件都算进块里。）
 */
import { ref } from 'vue';

import { BUSY_HINT } from '../shared/gate-copy.js';
import type { EnvFixAction, EnvWizardStepId } from '../../shared/ipc.js';

defineProps<{
  /** 这一屏画的是哪一步 */
  stepId: EnvWizardStepId;
  /** 全局忙位（安装 / 修复 / 后台还在装） */
  busy: boolean;
  /** 两步都没预选：第一步的「安装」要禁用，并说明原因 */
  methodNeedsPick: boolean;
  /** npm 都不能用：第二步不给一个注定失败的「安装」 */
  npmMissing: boolean;
}>();

const emit = defineEmits<{
  'open-node-confirm': [];
  'open-download': [];
  'open-fix-confirm': [action: EnvFixAction];
  'open-skip-confirm': [];
}>();

/** 模板里的四个动作都只是把意图报给父级（判定与状态都在那里） */
function openNodeConfirm(): void {
  emit('open-node-confirm');
}

function openDownloadPage(): void {
  emit('open-download');
}

function openFixConfirm(action: EnvFixAction): void {
  emit('open-fix-confirm', action);
}

function openSkipConfirm(): void {
  emit('open-skip-confirm');
}

/** 父级在"这一步没有确认区"的时候把焦点交给这一行的主按钮（原来它直接盯着 `primaryRef`） */
const primaryRef = ref<HTMLButtonElement | null>(null);

function focusStart(): void {
  primaryRef.value?.focus();
}

defineExpose({ focusStart });
</script>

<template>
  <!-- 操作行：一屏只有一处强调色实底 -->
  <div class="btn-row gate-actions">
    <template v-if="stepId === 'node'">
      <button
        ref="primaryRef"
        class="btn primary"
        :disabled="busy || methodNeedsPick"
        :title="
          methodNeedsPick
            ? '请先在「版本档位」下面选一条：直接安装官方版本 / 用版本管理器安装'
            : busy
              ? BUSY_HINT
              : undefined
        "
        @click="openNodeConfirm"
      >
        安装
      </button>
      <button class="btn" @click="openDownloadPage">我想自己去官网下载安装</button>
    </template>
    <template v-else-if="stepId === 'pnpm'">
      <button
        v-if="!npmMissing"
        ref="primaryRef"
        class="btn primary"
        :disabled="busy"
        :title="busy ? BUSY_HINT : undefined"
        @click="openFixConfirm('install-pnpm')"
      >
        安装
      </button>
      <button
        class="btn"
        :disabled="busy"
        :title="busy ? BUSY_HINT : undefined"
        @click="openSkipConfirm"
      >
        先跳过这一步
      </button>
    </template>
    <template v-else>
      <button
        ref="primaryRef"
        class="btn primary"
        :disabled="busy"
        :title="busy ? BUSY_HINT : undefined"
        @click="openFixConfirm('install-dsh')"
      >
        安装
      </button>
    </template>
  </div>

  <p v-if="stepId === 'pnpm'" class="gate-option-hint">
    跳过之后，插件页的装 / 卸 / 升级仍然用不了（以后随时可以回来补上）。
  </p>
</template>
