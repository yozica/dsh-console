<script setup lang="ts">
/**
 * 环境自检页里**更新 Node / pnpm 的确认区**（t60 从 `EnvPane.vue` 拆出来）。
 *
 * 两张"将要执行"：一张给 pnpm（就是装最新版），一张给 Node（版本档位、归属、下载来源、装到哪、
 * 要不要管理员权限、会改什么，以及跨档时必须说清的那几句）。**它不持有状态**：计划、档位、
 * 忙位、报告里的归属都由父级拿着 —— 父级那边同一个计划还画在"这一行"上（读数态 / 更新按钮），
 * 拆开就会变成两个真源。这里只做"计划 → 人话"与"按钮 → 事件"。
 *
 * 搬过来时只改了三处：两段各自的 `updateOpen === … && check.id === …` 合成 `kind` 一个开关、
 * `planFor('install-pnpm')` 换成 `pnpmPlan` 这个 prop，其余连模板带文案逐字未动（`cancelUpdate`
 * 这些名字在子组件里是同名的本地转发函数，模板因此不用改）。
 */
import { computed } from 'vue';

import { CHANNEL_SHORT, versionWithChannel } from '../../shared/gate-copy.js';
import type {
  EnvCheck,
  EnvFixPlan,
  EnvNodeChannel,
  EnvNodeOwner,
  EnvNodePlan,
} from '../../../shared/ipc.js';

const props = defineProps<{
  /** 这一行是哪一项：`node` = 更新 Node（带档位控件），`pnpm` = 更新 pnpm（一句话 + 命令） */
  kind: 'node' | 'pnpm';
  /** 这一行的事实（pnpm 那张读出的是这一行的 detail） */
  check: EnvCheck;
  /** 全局忙位：安装 / 修复 / 后台还在装 */
  busy: boolean;
  /** 这次更新的计划（Node 那条路；null = 还没取到） */
  nodeUpdatePlan: EnvNodePlan | null;
  /** 计划正在取 / 正在按新档位重算 */
  nodeUpdateLoading: boolean;
  /** 用户显式点过的那一档；null = 跟随现在这一份 */
  nodeUpdateChannel: EnvNodeChannel | null;
  /** 计划取不到时那句话 */
  nodeUpdateError: string;
  /** pnpm 那张要用的修复计划（命令与目标目录都由主进程给） */
  pnpmPlan: EnvFixPlan | null;
  /** 报告里这份 Node 的归属（计划里没有时兜底） */
  reportOwner: EnvNodeOwner;
  /** 「会先停掉 dsh」那句话：跨档与同档说法不同，父级的进行中/结果区也要用同一句 */
  nodeAffectsDshText: string;
}>();

const emit = defineEmits<{
  cancel: [];
  'start-pnpm': [];
  'start-node': [];
  'pick-channel': [channel: EnvNodeChannel];
  refresh: [];
  'focus-source': [];
  'open-download': [];
}>();

/** 模板里那几个动作都只是把意图报给父级（判定与状态都在那里） */
function cancelUpdate(): void {
  emit('cancel');
}

function startPnpmUpdate(): void {
  emit('start-pnpm');
}

function startNodeUpdate(): void {
  emit('start-node');
}

function pickUpdateChannel(channel: EnvNodeChannel): void {
  emit('pick-channel', channel);
}

function refresh(): void {
  emit('refresh');
}

function focusSource(): void {
  emit('focus-source');
}

function openDownloadPage(): void {
  emit('open-download');
}

// ---------------------------------------------------------------- 更新确认区的事实
// （这一段整体从父级搬过来；只把 `nodeUpdatePlan` / `nodeUpdateChannel` / `nodeOwner` 换成 props）

/** 归属事实的人话。读的是主进程给的字段（报告里的 `nodeOwner`、计划里的 `owner`），
 *  这一页**不自己判路径** —— 判据只有主进程那一份纯函数（需求 §7.7 第 1 条）。 */
const OWNER_WORDS: Record<EnvNodeOwner, string> = {
  nvm: '版本管理器（nvm）管的',
  system: '官方安装包装的',
  unknown: '我们认不出这个 Node 是怎么装的。',
};

/** 更新前那一半：版本与档位都来自计划（动作开始前就定下的那一份） */
const nodeCurrentText = computed(() =>
  versionWithChannel(
    props.nodeUpdatePlan?.currentVersion ?? null,
    props.nodeUpdatePlan?.currentChannel ?? null,
  ),
);

/** 目标那一半：档位还没定下来时主进程给的目标版本是空的，**不许显示成"这次要装 X"** */
const nodeTargetText = computed(() => {
  const plan = props.nodeUpdatePlan;
  if (!plan) return '';
  if (plan.needChoice === 'choose-channel') return '目标版本等你选完档位';
  return versionWithChannel(plan.version, plan.channel);
});

/** 档位判不出来：让用户**显式选一档**（需求 §8.5 第 3 条）；选之前不给「开始」 */
const nodeChannelUnknown = computed(
  () => props.nodeUpdatePlan?.needChoice === 'choose-channel' && props.nodeUpdateChannel === null,
);

/** 档位控件现在选的是哪一档；没选 = 跟随现在这一份的档（默认，不是 VM-15 那种写死的 lts） */
const nodeChannelPickedText = computed(() => {
  const picked = props.nodeUpdateChannel;
  if (picked) return CHANNEL_SHORT[picked];
  const plan = props.nodeUpdatePlan;
  // 当前档位判不出来时不许说"跟随" —— 那会把"我们不知道"说成"我们跟着它走"
  if (plan?.needChoice === 'choose-channel') return '还没定（这一档我们判不出来）';
  const current = plan?.currentChannel ?? null;
  return current ? `跟随现在这一份（${CHANNEL_SHORT[current]}）` : '跟随现在这一份';
});

/** 归属事实行：读计划里的 `owner`（与报告里是同一个事实、同一个纯函数算出来的） */
const nodeUpdateOwnerText = computed(
  () => OWNER_WORDS[props.nodeUpdatePlan?.owner ?? props.reportOwner],
);

/**
 * 跨档必须明说这是**换档**，目标更低时把「降到」写出来（两个版本号都来自计划）。
 * 那个分支里不出现「更新」这个词 —— 它会让用户以为版本会变高（需求 §8.5 第 4 条）。
 */
const nodeSwitchNotice = computed(() => {
  const plan = props.nodeUpdatePlan;
  if (!plan || !plan.switchesChannel) return '';
  const target = CHANNEL_SHORT[plan.channel];
  const before = plan.currentVersion ?? '（没测到）';
  if (plan.direction === 'older') {
    return `这会把现在这份 Node 换成${target}，版本从 ${before} 降到 ${plan.version}。`;
  }
  const from = plan.currentChannel ? CHANNEL_SHORT[plan.currentChannel] : '判不出来';
  return `版本会从 ${before} 变成 ${plan.version}，档位从${from}换到${target}。`;
});

/** 目标 == 当前：不给「开始」、也不给一个点了什么都不会发生的按钮（交互 §10.5 第 5 条） */
const nodeUpdateNoop = computed(() => {
  const plan = props.nodeUpdatePlan;
  return plan !== null && !plan.switchesChannel && plan.direction === 'same';
});

/** 确认区主按钮的动作名：跨档叫「换成…」；同档才是「开始」（需求 §8.1 第 2 条） */
const nodeUpdateActionLabel = computed(() => {
  const plan = props.nodeUpdatePlan;
  if (plan?.switchesChannel) return plan.channel === 'current' ? '换成当前版' : '换成稳定版';
  return '开始';
});
</script>

<template>
  <div v-if="kind === 'pnpm'" class="env-confirm">
    <div class="env-confirm-title">将要执行</div>
    <code class="env-confirm-cmd">
      {{ pnpmPlan?.display || '（命令由主进程现算）' }}
    </code>
    <div class="wizard-versions">
      <div class="wizard-version-line">
        <span class="wizard-version-label">这一项现在</span>
        <span class="wizard-version-old">{{ check.detail }}</span>
      </div>
      <div class="wizard-version-line">
        <span class="wizard-version-label">这次要装</span>
        <span class="wizard-version-new">最新版（由你的安装源决定）</span>
      </div>
    </div>
    <p class="env-confirm-line">
      会装进：{{ pnpmPlan?.target || '（全局 npm 目录）' }}；不需要管理员权限；需要联网。
    </p>
    <p class="wizard-notice">就是给这台电脑上的 pnpm 装最新版，不改别的东西。</p>
    <div class="btn-row">
      <button class="btn small primary" :disabled="busy" @click="startPnpmUpdate">开始</button>
      <button class="btn small" @click="cancelUpdate">取消</button>
    </div>
  </div>

  <div v-else class="env-confirm">
    <div class="env-confirm-title">将要执行</div>
    <!-- 只在"还没有计划"时用加载行占位：换档重算时留着上面那份计划与控件，
       不让用户刚点的那个控件在眼前消失（焦点也会跟着丢） -->
    <p v-if="nodeUpdateLoading && !nodeUpdatePlan" class="env-confirm-line">
      正在取这次的下载信息…
    </p>
    <template v-else-if="nodeUpdatePlan">
      <p v-if="nodeUpdateLoading" class="env-confirm-line">正在按新的档位重算…</p>
      <!-- 归属 = 版本管理器、且机器上已经有它：这次**没有任何东西要下载**（需求 §7.8） -->
      <code v-if="nodeUpdatePlan.installsManager" class="env-confirm-cmd">{{
        nodeUpdatePlan.display
      }}</code>
      <p v-else class="env-confirm-line">
        这次不用下载安装包：让版本管理器自己装 Node.js {{ nodeUpdatePlan.version }}。
      </p>

      <!-- 当前（档位） → 目标（档位）并排（需求 §8.2 / §8.5 第 1 条） -->
      <div class="wizard-versions">
        <div class="wizard-version-line">
          <span class="wizard-version-label">当前版本（档位）</span>
          <span class="wizard-version-old">{{ nodeCurrentText }}</span>
          <span class="wizard-version-arrow" aria-hidden="true">→</span>
          <span class="wizard-version-new">{{ nodeTargetText }}</span>
        </div>
      </div>

      <!-- 档位控件：**默认跟随现在这一份**（不递档位）；用户选了另一档才是换档。
         形状与向导第一步那个控件一模一样（同一套样式类，§4.1 第 4-b 条） -->
      <fieldset class="gate-choice-group env-channel">
        <legend class="gate-choice-legend">版本档位</legend>
        <div class="gate-choice-row">
          <label
            class="gate-option gate-option-half"
            :class="{ selected: nodeUpdateChannel === 'lts' }"
          >
            <input
              type="radio"
              name="env-node-channel"
              value="lts"
              :checked="nodeUpdateChannel === 'lts'"
              :disabled="busy"
              @change="pickUpdateChannel('lts')"
            />
            <span class="gate-option-body">
              <span class="gate-option-title">最新稳定版</span>
              <span class="gate-option-note">发布更久、坑更少。</span>
            </span>
          </label>
          <label
            class="gate-option gate-option-half"
            :class="{ selected: nodeUpdateChannel === 'current' }"
          >
            <input
              type="radio"
              name="env-node-channel"
              value="current"
              :checked="nodeUpdateChannel === 'current'"
              :disabled="busy"
              @change="pickUpdateChannel('current')"
            />
            <span class="gate-option-body">
              <span class="gate-option-title">最新当前版</span>
              <span class="gate-option-note">追最新特性，可能还没进入稳定期。</span>
            </span>
          </label>
        </div>
        <p class="gate-option-hint">
          现在选的是：{{ nodeChannelPickedText }}。不选就是跟着现在这一份走 ——
          只有在这里点一档，才算一次「换档」。
        </p>
      </fieldset>

      <!-- 跨档：明说这是换档；目标更低时写出「降到」（需求 §8.5 第 4 条） -->
      <p v-if="nodeSwitchNotice" class="wizard-notice">{{ nodeSwitchNotice }}</p>
      <p v-if="nodeChannelUnknown" class="wizard-notice">
        我们判不出这份 Node 属于哪一档，所以不会替你选：在上面点一档，我们再算一次。
      </p>
      <p v-else-if="nodeUpdateNoop" class="wizard-notice">
        版本没有变化（还是 {{ nodeUpdatePlan.currentVersion || nodeUpdatePlan.version }}）。
      </p>

      <div class="gate-confirm-table">
        <div class="gate-confirm-row">
          <span class="gate-confirm-key">这份 Node 是谁管的</span>
          <span class="gate-confirm-val">{{ nodeUpdateOwnerText }}</span>
        </div>
        <div v-if="nodeUpdatePlan.installsManager" class="gate-confirm-row">
          <span class="gate-confirm-key">下载来源</span>
          <span class="gate-confirm-val gate-confirm-mono">{{ nodeUpdatePlan.sourceHost }}</span>
        </div>
        <div class="gate-confirm-row">
          <span class="gate-confirm-key">会装到哪里</span>
          <span class="gate-confirm-val gate-confirm-mono">{{
            nodeUpdatePlan.target || '（安装程序自己决定）'
          }}</span>
        </div>
        <div class="gate-confirm-row">
          <span class="gate-confirm-key">要不要管理员权限</span>
          <span class="gate-confirm-val">{{
            nodeUpdatePlan.needsElevation
              ? '需要 —— 接下来 Windows 会问你一次是否允许安装（管理员权限）'
              : '不需要'
          }}</span>
        </div>
        <div class="gate-confirm-row">
          <span class="gate-confirm-key">要不要联网</span>
          <span class="gate-confirm-val">是</span>
        </div>
        <div class="gate-confirm-row">
          <span class="gate-confirm-key">会改什么</span>
          <span class="gate-confirm-val">{{ nodeUpdatePlan.note }}</span>
        </div>
      </div>

      <!-- 归属 = 版本管理器：说明只有它自己那一份被动（需求 §10.5 第 7 条） -->
      <p v-if="nodeUpdatePlan.owner === 'nvm'" class="env-confirm-line">
        这次只动版本管理器自己那份 Node，不会动系统里原来的那一份。
      </p>
      <p
        v-if="!nodeUpdatePlan.usable && !nodeChannelUnknown && nodeUpdatePlan.refuseReason"
        class="wizard-notice"
      >
        {{ nodeUpdatePlan.refuseReason }}
      </p>
      <p v-if="nodeUpdatePlan.affectsRunningDsh" class="wizard-notice">
        {{ nodeAffectsDshText }}
      </p>
      <p class="wizard-notice">这台电脑上可能还有别的程序在用这个 Node。</p>
      <div class="btn-row">
        <!-- 档位没定下来：先让用户显式选一档，不给「开始」（需求 §8.5 第 3 条） -->
        <template v-if="nodeChannelUnknown">
          <button class="btn small" @click="cancelUpdate">取消</button>
        </template>
        <template v-else-if="nodeUpdateNoop">
          <button class="btn small" @click="refresh">重新检测</button>
          <button class="btn small" @click="cancelUpdate">取消</button>
        </template>
        <template v-else-if="nodeUpdatePlan.usable">
          <button class="btn small primary" :disabled="busy" @click="startNodeUpdate">
            {{ nodeUpdateActionLabel }}
          </button>
          <button class="btn small" @click="cancelUpdate">取消</button>
        </template>
        <template v-else>
          <button class="btn small" @click="focusSource">换一个下载源再试</button>
          <button class="btn small" @click="openDownloadPage">打开官方下载页</button>
          <button class="btn small" @click="refresh">重新检测</button>
          <button class="btn small" @click="cancelUpdate">取消</button>
        </template>
      </div>
    </template>
    <template v-else>
      <p class="env-confirm-line">{{ nodeUpdateError }}</p>
      <div class="btn-row">
        <button class="btn small" @click="openDownloadPage">打开官方下载页</button>
        <button class="btn small" @click="cancelUpdate">取消</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* t60：这条原来在 `EnvPane.vue` 的 <style scoped> 里 —— 档位控件只有这一块在用，跟着组件走。
   确认区那批 `.env-confirm*` 父组件的确认区也画，按 §7.33 收进全局表。 */

/* 自检页更新确认区里那组档位控件：与向导第一步的控件是**同一套样式类**（形状要一模一样，
   交互 §4.1 第 4-b 条），这里只负责与上面那块「当前 → 目标」拉开距离 */
.env-channel {
  margin-top: 10px;
}
</style>
