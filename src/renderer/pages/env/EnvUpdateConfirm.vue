<script setup lang="ts">
/**
 * 环境自检页里**更新 Node / pnpm / dsh 的确认区**（t60 从 `EnvPane.vue` 拆出来）。
 *
 * 三张"将要执行"：一张给 pnpm（就是装最新版），一张给 dsh（装最新版，但要重启 dsh 才生效），
 * 一张给 Node（版本档位、归属、下载来源、装到哪、要不要管理员权限、会改什么，以及跨档时
 * 必须说清的那几句）。**它不持有状态**：计划、档位、忙位、报告里的归属、版本读数都由父级
 * 拿着 —— 父级那边同一份计划还画在"这一行"上（读数态 / 更新按钮），拆开就会变成两个真源。
 * 这里只做"计划 → 人话"与"按钮 → 事件"。
 *
 * 搬过来时只改了三处：两段各自的 `updateOpen === … && check.id === …` 合成 `kind` 一个开关、
 * `planFor('install-pnpm')` 换成 `pnpmPlan` 这个 prop，其余连模板带文案逐字未动（`cancelUpdate`
 * 这些名字在子组件里是同名的本地转发函数，模板因此不用改）。
 *
 * dsh 那一张是后加的（t79）：`pnpm` 与 `dsh` 的**命令形状相同**（`npm i -g <包>`），所以两张
 * 卡长得一样，差别只在两句话 —— 目标那一栏（pnpm 写"最新版（由你的安装源决定）"，dsh 写主进程
 * 查来的具体版本号）与收尾那句（dsh 要重启才生效）。
 */
import { computed } from 'vue';

import VersionPick from './VersionPick.vue';
import { CHANNEL_SHORT, versionWithChannel } from '../../shared/gate-copy.js';
import type {
  EnvCheck,
  EnvFixPlan,
  EnvNodeChannel,
  EnvNodeOwner,
  EnvNodePlan,
  EnvPnpmBinding,
} from '../../../shared/ipc.js';

const props = defineProps<{
  /** 这一行是哪一项：`node` = 更新 Node（带档位控件），`pnpm` / `dsh` = 一句话 + 命令 */
  kind: 'node' | 'pnpm' | 'dsh';
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
  /** pnpm 的归属事实（按归属给文案；界面只读结论） */
  pnpmBinding: EnvPnpmBinding | null;
  /**
   * 确认区这一份**定向计划**：dsh 按选中的版本、pnpm 按归属，由父级现场取回。
   * `null` = 还没取到 / 取不到 → **不给「开始」**（不拿报告里那份旧计划糊上去）。
   */
  openFixPlan: EnvFixPlan | null;
  openFixPlanLoading: boolean;
  /** dsh 那张要用的修复计划（与 pnpm 同一份东西，只是 action 是 install-dsh） */
  dshPlan: EnvFixPlan | null;
  /**
   * 版本下拉的数据源与状态（t83 起**两档共用这一套**）：dsh 是安装源上全部发行版；pnpm 是**主进程
   * 按 profile 的大版本线过滤后**的那些。界面只画它拿到的东西，**不自己判规则**（过滤在主进程）。
   */
  versionOptions: string[];
  versionTags: Record<string, string>;
  /** 钉住的大版本线（pnpm 才有）：用来写"只在这条线内挑"那句说明；dsh 为 null */
  versionMajor: string | null;
  /** 这一项现在跑着的那一版（「当前」节点与「→」左边那一半） */
  versionCurrent: string | null;
  /** 主进程算出来的目标版本（「→」右边那一半；拿不到时界面写"最新版…"，不编版本号） */
  versionTarget: string | null;
  /** 用户在下拉里显式选的那一版；null = 没选（用目标版本） */
  versionPicked: string | null;
  /** 下拉当前落在哪一版（用户选过就是它，否则是目标版本） */
  versionSelected: string | null;
  /** 选中的这一版比当前低 → 明确说是**降级** */
  versionDowngrade: boolean;
  /** 报告里这份 Node 的归属（计划里没有时兜底） */
  reportOwner: EnvNodeOwner;
  /** 「会先停掉 dsh」那句话：跨档与同档说法不同，父级的进行中/结果区也要用同一句 */
  nodeAffectsDshText: string;
}>();

const emit = defineEmits<{
  cancel: [];
  'start-pnpm': [];
  'start-dsh': [];
  'start-node': [];
  'pick-channel': [channel: EnvNodeChannel];
  'pick-version': [version: string];
  refresh: [];
  'focus-source': [];
  'open-download': [];
}>();

/** 用户在下拉里选了一版：**只把版本字符串报给父级**（校验、取计划都在那里） */
function emitPickedVersion(version: string): void {
  if (version) emit('pick-version', version);
}

/** 模板里那几个动作都只是把意图报给父级（判定与状态都在那里） */
function cancelUpdate(): void {
  emit('cancel');
}

function startPnpmUpdate(): void {
  emit('start-pnpm');
}

function startDshUpdate(): void {
  emit('start-dsh');
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

/**
 * 降级说明里那个主语。t84 起**只有 dsh 能选版本**，所以这里实际只会走到 `dsh` 那一支；
 * pnpm 那一支留着是因为 `kind` 仍是联合类型，真出现时不必再回来改这一处。
 */
const versionDowngradeWhat = computed<string>(() => (props.kind === 'pnpm' ? '这份 pnpm' : 'dsh'));

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

// ---------------------------------------------------------------- dsh 那张（t79）

/** dsh 现在这一份的版本（主进程的探测事实；查不到时为 null，那一行就不写"现在"） */
const currentText = computed(() => props.versionCurrent ?? '');

/**
 * 这次要装的目标版本。
 *
 * 查得到就写具体版本号 —— 那正是"带版本比对"这个需求的意思；查不到（离线 / 源不可达）就退回
 * 一句"最新版"，**不编版本号**（与不编命令同一条原则）。
 */
const targetText = computed(() => props.versionTarget || '最新版（由你的安装源决定）');
</script>

<template>
  <div v-if="kind === 'pnpm'" class="env-confirm">
    <div class="env-confirm-title">将要执行</div>
    <p v-if="openFixPlanLoading && !openFixPlan" class="env-confirm-line">
      正在按这份 pnpm 的安装方式算命令…
    </p>
    <code v-else class="env-confirm-cmd">{{ openFixPlan?.display || '（这一轮没取到命令）' }}</code>
    <div class="wizard-versions">
      <div class="wizard-version-line">
        <span class="wizard-version-label">更新对象</span>
        <span class="wizard-version-old">{{ pnpmBinding?.file || '（没找到 pnpm）' }}</span>
      </div>
      <div class="wizard-version-line">
        <span class="wizard-version-label">这一项现在</span>
        <span class="wizard-version-old">{{ currentText || '（版本没测到）' }}</span>
        <span class="wizard-version-arrow" aria-hidden="true">→</span>
        <span class="wizard-version-new">{{ targetText }}</span>
      </div>
    </div>
    <p v-if="openFixPlan?.target" class="env-confirm-line">
      会改到：{{ openFixPlan.target }}；需要联网。
    </p>
    <!-- 这条约束在界面上要说清（也是"pnpm 为什么不能选版本"的答案）：目标只在这条大版本线内取最新 -->
    <p v-if="versionMajor" class="env-confirm-line">
      目标钉在 <b>{{ versionMajor }}.x</b> 这条大版本线内：pnpm 的 store
      布局按大版本走，跨大版本要连同 profile 的依赖一起迁移 —— 那是一次单独的迁移动作，不在这里做。
    </p>
    <p class="wizard-notice">
      {{ openFixPlan?.note || '命令由主进程按这份 pnpm 的安装方式现算。' }}
    </p>
    <div class="btn-row">
      <button class="btn small primary" :disabled="busy || !openFixPlan" @click="startPnpmUpdate">
        开始
      </button>
      <button class="btn small" @click="cancelUpdate">取消</button>
    </div>
  </div>

  <div v-else-if="kind === 'dsh'" class="env-confirm">
    <div class="env-confirm-title">将要执行</div>
    <p v-if="openFixPlanLoading && !openFixPlan" class="env-confirm-line">
      正在按选中的版本算命令…
    </p>
    <code v-else class="env-confirm-cmd">{{ openFixPlan?.display || '（这一轮没取到命令）' }}</code>
    <div class="wizard-versions">
      <div class="wizard-version-line">
        <span class="wizard-version-label">这一项现在</span>
        <span class="wizard-version-old">{{ currentText || check.detail }}</span>
        <span class="wizard-version-arrow" aria-hidden="true">→</span>
        <span class="wizard-version-new">{{ targetText }}</span>
      </div>
    </div>

    <!-- 版本下拉：**只有 dsh 这一档有**（t84 回退 —— pnpm 不做选版本，它的目标固定在线内最新）。
         能挑哪些版本由**主进程**决定（dsh = 安装源上全部发行版），这里只负责画；
         `VersionPick` 自己管键盘 / 点外 / Esc / a11y / Teleport 定位。 -->
    <VersionPick
      v-if="versionOptions.length > 0"
      :options="versionOptions"
      :tags="versionTags"
      :current="versionCurrent"
      :selected="versionSelected"
      :busy="busy"
      @pick="emitPickedVersion"
    />
    <!-- 列表为空（这一轮没查到）时**不编东西**：读数那行已经写了"最新版（由你的安装源决定）"，
         而且行上那个入口本来就不会出现 —— 这里静默是对的，不是少了一个控件。 -->
    <!-- 选到比当前低的版本：**明确说是降级**（照 Node 换档那套说辞，用户一眼能看出后果） -->
    <p v-if="versionDowngrade" class="wizard-notice">
      这是一次<b>降级</b>：会把{{ versionDowngradeWhat }}从 {{ versionCurrent }} 换到
      {{ versionPicked }}，版本从高到低。
    </p>
    <p class="env-confirm-line">
      会装进：{{
        openFixPlan?.target || dshPlan?.target || '（全局 npm 目录）'
      }}；不需要管理员权限；需要联网。
    </p>
    <p class="wizard-notice">
      {{ openFixPlan?.note || '就是给这台电脑上的 dsh 装一份，不改别的东西。' }}装完会自动复检一次；
      <b>正在运行的 dsh 不受影响，但要重新启动之后新版本才会生效。</b>
    </p>
    <div class="btn-row">
      <button class="btn small primary" :disabled="busy || !openFixPlan" @click="startDshUpdate">
        开始
      </button>
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
