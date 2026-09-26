<script setup lang="ts">
/**
 * 执行输出面板：门禁的「详细输出」（t58 从 `EnvGate.vue` 拆出来）。
 *
 * 与自检页的输出区同一套形态，所以 `.env-op*` 的样式留在**全局表**里（两个页面共用，见 §7.33）——
 * 这个组件因此没有自己的样式。
 *
 * 它只负责三件事：把主进程给的原文照贴、跟着新片段往下滚、把"收起"报给调用方。
 * 折叠开关与三行读数（命令 / 状态 / 结论）都归调用方：那一份状态在"开始安装 / 修复"的动作里
 * 就被写过，放在这里只会变成两个真源。
 */
import { nextTick, ref, watch } from 'vue';

const props = defineProps<{
  /** 命令原文（主进程给的计划 / 执行记录，界面不拼） */
  command: string;
  /** 流式原文（没有时显示「（等待输出…）」） */
  text: string;
  /** 顶部那枚状态词的颜色档（与结果行同一档） */
  state: 'running' | 'done' | 'error';
  /** 已结束时的结论句；进行中是空串 */
  summary: string;
  /** 这一步还在跑吗（决定右上角写「进行中…」还是「已结束」） */
  running: boolean;
}>();

const emit = defineEmits<{ collapse: [] }>();

const box = ref<HTMLElement | null>(null);

// 输出区跟着新片段往下滚（与自检页同一套做法：原文照贴，不假装进度条）
watch(
  () => props.text,
  () => {
    void nextTick(() => {
      if (box.value) box.value.scrollTop = box.value.scrollHeight;
    });
  },
);
</script>

<template>
  <div class="env-op">
    <div class="env-op-head">
      <span class="env-op-cmd">{{ command }}</span>
      <span class="env-op-state" :data-state="state">
        {{ running ? '进行中…' : '已结束' }}
      </span>
      <span class="spacer"></span>
      <button class="btn tiny" @click="emit('collapse')">收起</button>
    </div>
    <pre ref="box" class="env-op-out">{{ text || '（等待输出…）' }}</pre>
    <p v-if="summary" class="env-op-summary" :data-state="state">
      {{ summary }}
    </p>
  </div>
</template>
