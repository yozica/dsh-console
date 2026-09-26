<script setup lang="ts">
/**
 * 「先跳过 pnpm 这一步」的二次确认（t65 从 `EnvGate.vue` 拆出来，交互 §5.4）：
 * 跳过是**一次确认**，不是静默操作 —— 它是持久化的设置写入（`envSkips`），所以先说清后果。
 */
const emit = defineEmits<{ confirm: []; close: [] }>();

function confirmSkip(): void {
  emit('confirm');
}

function closeSkipConfirm(): void {
  emit('close');
}
</script>

<template>
  <!-- 跳过是一次确认，不是静默操作（交互 §5.4） -->
  <div class="wizard-decide">
    确定先跳过 pnpm 这一步吗？跳过之后，插件页的装 / 卸 / 升级仍然用不了（以后随时可以回来补上）。
    <div class="btn-row">
      <button class="btn small" @click="confirmSkip">确定跳过</button>
      <button class="btn small" @click="closeSkipConfirm">取消</button>
    </div>
  </div>
</template>
