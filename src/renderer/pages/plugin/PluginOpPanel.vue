<script setup lang="ts">
/**
 * 插件页的**操作输出面板**（t59 从 `PluginPane.vue` 拆出来）：pnpm / 补丁层操作的原文照贴，
 * 不假装进度条（与 dsh 终端、环境自检的输出区同族）。
 *
 * 与门禁的 `GateOutput.vue` 同一套做法：折叠开关、四行读数、那一颗「插进我的层」的意图
 * 都归父级 —— 它们与"谁发起的这次操作"绑在一起，放在这里只会变成两个真源。
 */
import type { PluginLayerEditAction } from '../../../shared/ipc.js';

defineProps<{
  /** 有操作在跑：中断按钮与「插进我的层」都要看它 */
  opBusy: boolean;
  /** 命令原文（由父级按这次操作拼好） */
  opTitle: string;
  /** 顶部那枚状态词的样式档（决定它是灰、绿还是红） */
  opStatus: '' | 'running' | 'ok' | 'failed';
  /** 顶部那枚状态词 */
  opStateLabel: string;
  /** 流式原文（没有时显示「（等待输出…）」） */
  opText: string;
  /** 结论句（没有就不画那一行） */
  opSummary: string;
  /** 内置包被拦下时那一条：主进程给的 id + 包名（没有就不给那个按钮） */
  opNeedsEnable: { id: string; name: string } | null;
}>();

const emit = defineEmits<{
  cancel: [];
  collapse: [];
  'insert-layer': [action: PluginLayerEditAction, id: string, name: string];
}>();

function cancelOp(): void {
  emit('cancel');
}

function collapse(): void {
  emit('collapse');
}

function insertLayer(id: string, name: string): void {
  emit('insert-layer', 'insert', id, name);
}
</script>

<template>
  <div class="plugin-op">
    <div class="plugin-op-head">
      <span class="plugin-op-cmd">{{ opTitle }}</span>
      <span class="plugin-op-state" :data-state="opStatus">{{ opStateLabel }}</span>
      <span class="spacer"></span>
      <button v-if="opBusy" class="btn tiny" @click="cancelOp()">中断</button>
      <button v-else class="btn tiny" @click="collapse()">收起</button>
    </div>
    <pre class="plugin-op-out">{{ opText || '（等待输出…）' }}</pre>
    <p v-if="opSummary" class="plugin-op-summary">{{ opSummary }}</p>
    <!-- 内置包被拦下、而且还没启用：就地给一个按钮，不用自己去翻 cordis.patch.yml -->
    <div v-if="opNeedsEnable" class="plugin-op-actions">
      <button
        class="btn small primary"
        :disabled="opBusy"
        @click="insertLayer(opNeedsEnable.id, opNeedsEnable.name)"
      >
        插进我的层
      </button>
      <span class="bar-hint">
        往你的补丁层加一条 insert（id:
        {{ opNeedsEnable.id }}），写之前备份原文件；这一层即时生效
      </span>
    </div>
  </div>
</template>

<style scoped>
/* t59：这些规则原来在 `PluginPane.vue` 的 <style scoped> 里 —— 只有这一块在用，跟着组件走
   （§7.33：只有这一处在用的规则进组件的 scoped 块；两边都在用的 `.plugin-tag` / `.plugin-entry*`
   已经收进全局表）。 */

/* 操作输出：下沉井 + 等宽，和 dsh 终端同族 */
.plugin-op {
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  margin: 0 20px 20px;
  border: 1px solid var(--hairline);
  border-radius: var(--r-card);
  background: var(--surface);
  overflow: hidden;
}

.plugin-op-head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 14px;
  font-size: var(--t-sm);
}

.plugin-op-cmd {
  font-family: var(--mono);
  font-size: var(--t-xs);
  color: var(--ink-dim);
  background: var(--well);
  border: 1px solid var(--hairline);
  border-radius: 5px;
  padding: 3px 7px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 62%;
}

.plugin-op-state {
  font-size: var(--t-xs);
  color: var(--ink-faint);
}

.plugin-op-state[data-state='running'] {
  color: var(--amber);
}

.plugin-op-state[data-state='ok'] {
  color: var(--run);
}

.plugin-op-state[data-state='failed'] {
  color: var(--rose);
}

.plugin-op-out {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  padding: 12px 14px;
  border-top: 1px solid var(--hairline);
  background: var(--well);
  color: var(--ink-dim);
  font-family: var(--mono);
  font-size: var(--t-xs);
  line-height: 1.75;
  white-space: pre-wrap;
}

.plugin-op-summary {
  margin: 0;
  padding: 10px 14px;
  border-top: 1px solid var(--hairline);
  color: var(--rose);
  font-size: var(--t-sm);
  line-height: 1.7;
}

/* 输出区里的动作（内置包被拦下时的「插进我的层」） */
.plugin-op-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-top: 1px solid var(--hairline);
}
</style>
