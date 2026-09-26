<script setup lang="ts">
/**
 * 门禁这一步的**结果行**（t61 从 `EnvGate.vue` 拆出来）：一个状态点 + 结论句 + 说明 + 那一排出路。
 *
 * 与事实行占同一个槽位（失败不换地方、不弹窗、不整屏红）。它**不判定任何东西**：点色、结论句、
 * 说明、走的是哪条通道、三种结局都由父级算好递下来 —— 那些判据父级的进行中 / 输出区也在用
 * （`outputState` / `outputSummary`），拆开就会变成两份。
 */
import type { EnvWizardStepId } from '../../shared/ipc.js';

defineProps<{
  /** 这一步画的是哪一步（决定"跳过 / 换一个 Node / 写死启动命令"那几条出路） */
  currentStepId: EnvWizardStepId;
  /** 状态点的颜色档：ok / failed / unknown */
  resultDot: string;
  /** 结论句（主进程给的 `message` 优先） */
  resultTitle: string;
  /** 结论之下那句说明（复检结论 / 复检事实） */
  resultNote: string;
  /** 这一次跑的是哪条通道：node 还是 fix */
  activeFlow: 'node' | 'fix' | null;
  /** Node 那条路的三种结局：装好了 / 我们不等了 / 被拒了 / 没成 */
  nodeOutcome: 'done' | 'detached' | 'refused' | 'failed';
  /** 一键修复那条路的相位（done 之外才给"再试一次"） */
  fixOutcome: string;
}>();

const emit = defineEmits<{
  refresh: [];
  'open-download': [];
  'confirm-install-finished': [];
  'switch-to-nvm': [];
  'retry-node': [];
  'retry-fix': [];
  'open-skip-confirm': [];
  'open-node-switch': [];
  'open-settings': [];
}>();
function refresh(): void {
  emit('refresh');
}
function openDownloadPage(): void {
  emit('open-download');
}
function confirmInstallFinished(): void {
  emit('confirm-install-finished');
}
function switchToNvm(): void {
  emit('switch-to-nvm');
}
function retryNode(): void {
  emit('retry-node');
}
function retryFix(): void {
  emit('retry-fix');
}
function openSkipConfirm(): void {
  emit('open-skip-confirm');
}
function openNodeSwitch(): void {
  emit('open-node-switch');
}
function openSettings(): void {
  emit('open-settings');
}
</script>

<template>
  <div class="gate-result">
    <div class="gate-result-line">
      <span class="gate-result-dot" :data-state="resultDot" aria-hidden="true"></span>
      <div class="gate-result-main">
        <p class="gate-result-title">{{ resultTitle }}</p>
        <p v-if="resultNote" class="gate-result-note">{{ resultNote }}</p>
        <div class="btn-row">
          <template v-if="activeFlow === 'node'">
            <template v-if="nodeOutcome === 'detached'">
              <button class="btn small" @click="refresh">重新检测</button>
              <button class="btn small" @click="openDownloadPage">打开官方下载页</button>
              <button class="btn small" @click="confirmInstallFinished">我确认安装已经结束</button>
            </template>
            <template v-else-if="nodeOutcome === 'refused'">
              <button class="btn small" @click="switchToNvm">改用不用管理员权限的方式安装</button>
              <button class="btn small" @click="refresh">重新检测</button>
            </template>
            <template v-else>
              <button class="btn small" @click="refresh">重新检测</button>
              <button class="btn small" @click="retryNode">再试一次</button>
              <button class="btn small" @click="openDownloadPage">打开官方下载页</button>
            </template>
          </template>
          <template v-else>
            <button class="btn small" @click="refresh">重新检测</button>
            <button v-if="fixOutcome !== 'done'" class="btn small" @click="retryFix">
              再试一次
            </button>
            <button v-if="currentStepId === 'pnpm'" class="btn small" @click="openSkipConfirm">
              先跳过这一步
            </button>
            <button v-if="currentStepId === 'dsh'" class="btn small" @click="openNodeSwitch">
              换一个 Node
            </button>
            <button v-if="currentStepId === 'dsh'" class="btn small" @click="openSettings">
              在设置里写死一条能跑的启动命令
            </button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* t61：这些规则原来在 `EnvGate.vue` 的 <style scoped> 里 —— 只有这一块在用，跟着组件走
   （§7.33：只有这一处在用的规则进组件的 scoped 块；`.btn` / `.btn-row` 是全局零件）。 */

/* 结果行：成功 / 失败 / 未确定共用同一个槽位（失败不换地方、不弹窗、不整屏红） */
.gate-result {
  margin-top: 12px;
}

.gate-result-line {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.gate-result-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--ink-dim);
}

.gate-result-dot[data-state='ok'] {
  background: var(--run);
  box-shadow: 0 0 0 3px var(--run-soft);
}

.gate-result-dot[data-state='failed'] {
  background: var(--rose);
  box-shadow: 0 0 0 3px var(--rose-soft);
}

.gate-result-dot[data-state='warn'] {
  background: transparent;
  border: 1.5px solid var(--amber);
}

/* 未标定：空心环 + 墨色。我们不知道的事不给绿也不给红 */
.gate-result-dot[data-state='unknown'] {
  background: transparent;
  border: 1.5px solid var(--ink-dim);
}

.gate-result-main {
  min-width: 0;
}

.gate-result-title {
  color: var(--ink);
  font-size: var(--t-lg);
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}

.gate-result-note {
  max-width: var(--wizard-read);
  margin-top: 4px;
  color: var(--ink-dim);
  font-size: var(--t-sm);
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.gate-result .btn-row {
  /* 10px → 12px：卡片里"块 → 按钮行"统一 12px（与 .wizard-progress > .btn-row 同一节奏） */
  margin-top: 12px;
}
</style>
