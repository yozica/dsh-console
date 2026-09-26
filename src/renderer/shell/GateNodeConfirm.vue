<script setup lang="ts">
/**
 * 首启向导里 Node 安装 / 更新那条路的**确认区**（t58 从 `EnvGate.vue` 拆出来）。
 *
 * 它是一张只读的"将要执行"：把主进程算出来的计划摆成人话（版本档位、归属、下载来源、装到哪、
 * 要不要管理员权限、会改什么），并在计划本身要求确认时（未签名 / 拿不到校验值）换成
 * 「取消 + 继续」两个按钮。
 *
 * **它不持有任何选择**：计划、方法、档位、忙位都由父级 `EnvGate.vue` 拿着 —— 因为同一批选择
 * 在那张卡片的**选择区**里也画着（确认区展开之前就看得见，t43 / VM-15），两边必须是同一份状态。
 * 这一层只做"计划 → 人话"与"按钮 → 事件"。
 *
 * 搬过来时只改了三处：`v-if` 交给调用方（父级按 `nodeConfirmOpen` 决定挂不挂）、第三步那处
 * `currentStep.id !== 'node'` 换成 `host !== 'node'`（父级打开时就定好了 host）、`copy()`
 * 换成 `lib/clipboard` 那一份。其余连模板带文案逐字未动。
 */
import { computed, ref } from 'vue';

import { copyToClipboard } from '../lib/clipboard.js';
import {
  BUSY_HINT,
  CHANNEL_SHORT,
  CHANNEL_TITLES,
  METHOD_OPTIONS,
  METHOD_RISK,
  versionWithChannel,
} from '../lib/gate-copy.js';
import type { EnvNodeChannel, EnvNodeMethod, EnvNodeOwner, EnvNodePlan } from '../../shared/ipc.js';

const props = defineProps<{
  /** 确认区挂在第一步的卡里还是第三步（"换一个 Node"）的卡里 */
  host: 'node' | 'dsh';
  /** 计划还在取 / 正在按新档位重算 */
  planLoading: boolean;
  /** 这一次的计划；null = 还没取到（或取不到） */
  nodePlan: EnvNodePlan | null;
  /** 用户**显式点名**的那条路；null = 跟随归属 */
  nodeMethod: EnvNodeMethod | null;
  /** 选择区里当前那一档（"版本档位"那一行读它） */
  nodeChannel: EnvNodeChannel;
  /** 全局忙位（安装 / 修复 / 后台还在装） */
  busy: boolean;
  /** 报告里这份 Node 的归属（计划里没有时兜底） */
  reportOwner: EnvNodeOwner;
  /** 这台机器上找到了一份 Node 吗（归属那一行的措辞分两支） */
  nodeFound: boolean;
}>();

const emit = defineEmits<{
  close: [];
  start: [];
  'pick-method': [method: EnvNodeMethod];
  'use-direct': [];
  'open-source': [];
  'open-download': [];
}>();

/** 模板里的五个动作都只是把意图报给父级（判定与状态都在那里） */
function closeNodeConfirm(): void {
  emit('close');
}

function startNode(): void {
  emit('start');
}

function pickMethod(method: EnvNodeMethod): void {
  emit('pick-method', method);
}

function useDirectInstead(): void {
  emit('use-direct');
}

function openSourcePanel(): void {
  emit('open-source');
}

function openDownloadPage(): void {
  emit('open-download');
}

/** 复制下载地址：与父级那条「corepack enable pnpm」共用一份实现（`lib/clipboard`） */
const copy = copyToClipboard;

/** 父级在"确认区刚打开"时把焦点交给主按钮（原先是父级盯着 `nodeConfirmOpen` 那个 watch） */
const startRef = ref<HTMLButtonElement | null>(null);

function focusStart(): void {
  startRef.value?.focus();
}

defineExpose({ focusStart });

/** 「展开看完整地址」的开关：只在这个组件活着的时候有意义（父级用 `v-if` 挂它） */
const planDetailsOpen = ref(false);

/** 「版本（档位）」的人话：档位判不出来时写**档位未知**，不许省略、不许猜 */
const ownerRowText = computed(() => {
  const owner: EnvNodeOwner = props.nodePlan?.owner ?? props.reportOwner;
  if (owner === 'nvm') return '版本管理器（nvm）管的';
  if (owner === 'system') return '官方安装包装的';
  return props.nodeFound ? '我们认不出这个 Node 是怎么装的。' : '这台电脑上还没有 Node。';
});

/** 「版本档位」那一行：值与选择区那个控件是同一个。档位没定下来时**不许**写出目标版本号 */
const channelRowText = computed(() => {
  const word = CHANNEL_TITLES[props.nodeChannel];
  const plan = props.nodePlan;
  if (!plan || plan.needChoice !== null) return word;
  return `${word}（${plan.version}）`;
});

/** 换档说明：目标档与当前档不同就得说成换档；目标更低时写出「降到」（需求 §8.5 第 4 条） */
const channelSwitchNotice = computed(() => {
  const plan = props.nodePlan;
  if (!plan || !plan.switchesChannel) return '';
  const target = CHANNEL_SHORT[plan.channel];
  const before = plan.currentVersion ?? '（没测到）';
  if (plan.direction === 'older') {
    return `这会把现在这份 Node 换成${target}，版本从 ${before} 降到 ${plan.version}。`;
  }
  const from = plan.currentChannel ? CHANNEL_SHORT[plan.currentChannel] : '判不出来';
  return `版本会从 ${before} 变成 ${plan.version}，档位从${from}换到${target}。`;
});

/** 用户显式点名的方法与这份 Node 的归属不一致 = 会多出一份 Node：确认区必须写清后果 */
const showsMethodRisk = computed(() => {
  const plan = props.nodePlan;
  const method = props.nodeMethod;
  if (!plan || method === null) return false;
  if (plan.owner === 'system') return method === 'nvm';
  if (plan.owner === 'nvm') return method === 'direct';
  return false;
});

const elevationText = computed(() => {
  const plan = props.nodePlan;
  if (plan && plan.needsElevation) {
    return '需要 —— 接下来 Windows 会问你一次是否允许安装（管理员权限）';
  }
  return '不需要';
});

/**
 * 计划本身有没有要求"确认一次"。
 *
 * 只有"发布元数据自己说未签名"才允许在计划阶段提一次未签名（船长裁定）；
 * `sha256 === null` 那条仍然有效（拿不到官方校验值 → 换源 / 仍然继续）。
 */
const decision = computed<'unverified' | 'unsigned' | null>(() => decideFor(props.nodePlan));

function decideFor(plan: EnvNodePlan | null): 'unverified' | 'unsigned' | null {
  if (!plan || !plan.usable) return null;
  // 这次没有任何东西要下载（归属 = 版本管理器、机器上已经有它）：没有完整性要确认
  // （那次确认只由 `sha256 === null && installsManager` 触发，见冻结 §3.2.1 的 `installsManager`）
  if (!plan.installsManager) return null;
  if (plan.releaseSigning === 'unsigned') return 'unsigned';
  if (plan.sha256 === null) return 'unverified';
  return null;
}
</script>

<template>
  <div class="gate-confirm">
    <div class="gate-confirm-title">将要执行</div>
    <!-- 只在"还没有计划"时用加载行占位：换档重算时留着上面那份计划，
                   免得整块内容闪一下 -->
    <p v-if="planLoading && !nodePlan" class="gate-confirm-loading">正在取这次的下载信息…</p>
    <template v-else-if="nodePlan">
      <p v-if="planLoading" class="gate-confirm-loading">正在按新的档位重算…</p>
      <!-- 归属 = 版本管理器、机器上已经有它：这次**没有任何东西要下载**（需求 §7.8） -->
      <code v-if="nodePlan.installsManager" class="gate-confirm-cmd">{{ nodePlan.display }}</code>
      <p v-else class="gate-confirm-loading">
        这次不用下载安装包：让版本管理器自己装 Node.js {{ nodePlan.version }}。
      </p>

      <!-- 「当前版本（档位） → 目标版本（档位）」并排（需求 §8.2 / §8.5 第 1 条） -->
      <div v-if="nodePlan.currentVersion" class="wizard-versions">
        <div class="wizard-version-line">
          <span class="wizard-version-label">当前版本（档位）</span>
          <span class="wizard-version-old">{{
            versionWithChannel(nodePlan.currentVersion, nodePlan.currentChannel)
          }}</span>
          <span class="wizard-version-arrow" aria-hidden="true">→</span>
          <span class="wizard-version-new">{{
            nodePlan.needChoice === null
              ? versionWithChannel(nodePlan.version, nodePlan.channel)
              : '目标版本等你选完再算'
          }}</span>
        </div>
      </div>

      <div class="gate-confirm-table">
        <div class="gate-confirm-row">
          <span class="gate-confirm-key">版本档位</span>
          <span class="gate-confirm-val">{{ channelRowText }}</span>
        </div>
        <div class="gate-confirm-row">
          <span class="gate-confirm-key">这份 Node 是谁管的</span>
          <span class="gate-confirm-val">{{ ownerRowText }}</span>
        </div>
        <div v-if="nodePlan.installsManager" class="gate-confirm-row">
          <span class="gate-confirm-key">下载来源</span>
          <span class="gate-confirm-val gate-confirm-mono">{{ nodePlan.sourceHost }}</span>
        </div>
        <div class="gate-confirm-row">
          <span class="gate-confirm-key">会装到哪里</span>
          <span class="gate-confirm-val gate-confirm-mono">
            {{ nodePlan.target || '（安装程序自己决定）' }}
          </span>
        </div>
        <div class="gate-confirm-row">
          <span class="gate-confirm-key">要不要联网</span>
          <span class="gate-confirm-val">是</span>
        </div>
        <div class="gate-confirm-row">
          <span class="gate-confirm-key">要不要管理员权限</span>
          <span class="gate-confirm-val">{{ elevationText }}</span>
        </div>
        <div class="gate-confirm-row">
          <span class="gate-confirm-key">会改什么</span>
          <span class="gate-confirm-val">{{ nodePlan.note }}</span>
        </div>
        <!-- 计划阶段的中性陈述：签名要等下载后才读得到，这里不许对用户断言任何结论。
                       这次没有任何东西要下载时（nvm 那条路）整行不出现 -->
        <div v-if="nodePlan.installsManager" class="gate-confirm-row">
          <span class="gate-confirm-key">完整性</span>
          <span class="gate-confirm-val">
            下载后会核对官方清单里的校验值，并读取安装包的数字签名；对不上就不安装。
          </span>
        </div>
      </div>
      <div class="gate-fact-more">
        <button class="btn tiny ghost" @click="planDetailsOpen = !planDetailsOpen">
          {{ planDetailsOpen ? '收起详情' : '展开看完整地址' }}
        </button>
        <div v-if="planDetailsOpen" class="gate-detail">
          <div class="gate-detail-row">
            <span class="gate-detail-key">下载地址</span>
            <span class="gate-detail-val">{{ nodePlan.url }}</span>
          </div>
          <div class="gate-detail-row">
            <span class="gate-detail-key">校验依据</span>
            <span class="gate-detail-val">{{ nodePlan.evidence }}</span>
          </div>
          <button class="btn tiny" @click="copy(nodePlan.url)">复制下载地址</button>
        </div>
      </div>
      <!-- 跨档：明说这是换档；目标更低时写出「降到」（需求 §8.5 第 4 条） -->
      <p v-if="channelSwitchNotice" class="wizard-notice">{{ channelSwitchNotice }}</p>
      <!-- 归属判不出来：两条路一条都没预选，选之前不给「开始」（需求 §7.7 第 3 条）。
                     第一步上这个控件在选择区里（未展开确认区就看得见）；第三步的「换一个 Node」
                     没有选择区，所以在确认区里补同一组控件 -->
      <div v-if="nodePlan.needChoice === 'choose-method' && host !== 'node'" class="gate-choice">
        <div class="gate-choice-row">
          <label
            v-for="option in METHOD_OPTIONS"
            :key="option.id"
            class="gate-option"
            :class="{ selected: nodeMethod === option.id }"
          >
            <input
              type="radio"
              name="wizard-node-method-confirm"
              :value="option.id"
              :checked="nodeMethod === option.id"
              :disabled="busy"
              @change="pickMethod(option.id)"
            />
            <span class="gate-option-body">
              <span class="gate-option-title">{{ option.title }}</span>
              <span class="gate-option-note">{{ option.note }}</span>
              <span class="gate-option-risk">{{ METHOD_RISK }}</span>
            </span>
          </label>
        </div>
      </div>
      <p v-if="nodePlan.needChoice === 'choose-method'" class="wizard-notice">
        我们不确定这份 Node 是哪种装的，所以两条路都列出来、一条都没有替你预选。
      </p>
      <!-- 用户显式点名的那条路与归属不一致：两份 Node 并存的后果要先说清（§7.9 第 4 条） -->
      <p v-if="showsMethodRisk" class="wizard-notice">{{ METHOD_RISK }}</p>
      <p v-if="nodePlan.installsManager && !nodePlan.sha256" class="wizard-notice">
        <b>这次没能校验安装包的完整性。</b>
      </p>
      <!-- 发布元数据自己标注为未签名时才有这一条 + 一次明确确认（船长裁定） -->
      <p v-if="decision === 'unsigned'" class="wizard-notice">
        <b>这个 nvm 构建没有数字签名。</b>确定要继续安装吗？
      </p>
      <!-- 诚实边界：能换的换、不能换的说清，不假装（冻结 §1 R-22） -->
      <p v-if="nodePlan.method === 'nvm' && nodePlan.installsManager" class="wizard-notice">
        版本管理器的安装包仍然从官方地址下载，不套用你设置的下载来源。
      </p>
      <p v-if="nodePlan.owner === 'nvm' && !nodePlan.installsManager" class="wizard-notice">
        这次只动版本管理器自己那份 Node，不会动系统里原来的那一份，也不会重装版本管理器。
      </p>
      <p v-if="!nodePlan.usable && nodePlan.refuseReason" class="wizard-notice">
        {{ nodePlan.refuseReason }}
      </p>
      <div class="btn-row">
        <template v-if="!nodePlan.usable">
          <button class="btn small" @click="openDownloadPage">打开官方下载页</button>
          <!-- 提权态下 nvm 那条路走不通：用户显式点名改走官方安装包（需求 §7.8 例外 3）。
                         归属判不出来时不给这条 —— 那时用户是在上面两条路里自己选（§7.7 第 3 条） -->
          <button
            v-if="nodePlan.owner === 'nvm' && nodePlan.method === 'nvm' && !busy"
            class="btn small"
            @click="useDirectInstead"
          >
            改用直接安装官方版本
          </button>
        </template>
        <!-- 需要用户明确确认的场合不出现主按钮，安全的那一侧在左（视觉 §6.3 / R-12） -->
        <template v-else-if="decision === 'unsigned'">
          <button ref="startRef" class="btn small" @click="closeNodeConfirm">取消</button>
          <button class="btn small" :disabled="busy" @click="startNode">仍然继续</button>
        </template>
        <template v-else-if="decision === 'unverified'">
          <button ref="startRef" class="btn small" @click="openSourcePanel">
            换一个下载源再试
          </button>
          <button class="btn small" :disabled="busy" @click="startNode">仍然继续</button>
        </template>
        <template v-else>
          <button
            ref="startRef"
            class="btn small primary"
            :disabled="busy"
            :title="busy ? BUSY_HINT : undefined"
            @click="startNode"
          >
            开始
          </button>
          <button class="btn small" @click="closeNodeConfirm">取消</button>
        </template>
      </div>
    </template>
    <template v-else>
      <p class="gate-confirm-loading">这次没能取到下载信息（可能连不上官方地址）。</p>
      <div class="btn-row">
        <button ref="startRef" class="btn small" @click="openDownloadPage">打开官方下载页</button>
        <button class="btn small" @click="closeNodeConfirm">取消</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 全局表里那批 `.gate-confirm*` 是向导与自检页共用的零件；只有这条"加载中"的说明行是
   确认区自己的，跟着组件走（§7.33：只有这一处在用的规则进组件的 scoped 块）。 */
.gate-confirm-loading {
  margin-top: 8px;
  color: var(--ink-dim);
  font-size: var(--t-sm);
}
</style>
