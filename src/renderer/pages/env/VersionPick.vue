<script setup lang="ts">
/**
 * 「选择版本」自绘浮层（t83 从 `EnvUpdateConfirm.vue` 抽出来）：**dsh 与 pnpm 共用这一份**。
 *
 * 为什么不用原生 `<select>`：它的弹出列表由操作系统绘制，样式插不进去，和这张卡片不搭
 * （用户从三个自绘摆法里选了 A，规格 `docs/env-version-pick-choices.html`）。
 *
 * 浮层**必须 Teleport 到 body 且用 `position: fixed`**：确认区自己处在门禁层的层叠上下文里
 * （`--z-env`），留在原地会被卡片裁掉。仓库已有先例：`layout/CloseDialog.vue` 同样 Teleport 到 body。
 *
 * 层号 `--z-pop`：**高于 `--z-env`（30，环境详情层）**，**低于 `--z-gate`（58，首启门禁）与启动锁（60）**
 * —— 它只在自己那一屏里浮在详情层之上，绝不能盖住门禁与启动锁。
 *
 * 抽成组件而不是在两个分支里各写一遍：这段有**一整套状态与监听**（键盘高亮、点外关闭、scroll/resize
 * 收口、ARIA、Teleport 定位），复制一份出来就等于把"以后要改两处"写进代码里。
 *
 * 它**不做任何规则判断**：能挑哪些版本由调用方（最终是主进程）给 —— pnpm 那份列表已经按 profile 的
 * 大版本线过滤好，这里只管画。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import {
  betweenIndexes,
  nextActiveIndex,
  pickDirection,
  type PickDirection,
  type VersionNavKey,
} from './version-pick.js';

const props = defineProps<{
  /** 可挑的版本，**倒序**（最新在前） */
  options: string[];
  /** dist-tags 原文（`latest` / `next` / `alpha` …）：只用来做标注 */
  tags: Record<string, string>;
  /** 这一项现在跑着的那一版（「当前」节点） */
  current: string | null;
  /** 当前落在哪一版（用户选过就是它，否则是主进程算出来的目标） */
  selected: string | null;
  busy: boolean;
}>();

const emit = defineEmits<{ pick: [version: string] }>();

const versionOpen = ref(false);
/** 键盘/鼠标**同一套**高亮（hover 直接写它）：两个真源一定会走散 */
const versionActive = ref(-1);
const versionTrigger = ref<HTMLButtonElement | null>(null);
const versionPanel = ref<HTMLElement | null>(null);
const versionPanelStyle = ref<Record<string, string>>({});
/**
 * 每个实例一份 id 前缀（随机后缀）：页面上可能同时有多个确认区，`aria-activedescendant` 的 id 不能撞。
 * 用随机后缀而不是模块级自增计数器：计数器得是可变的模块状态，而它的写入除了拼进 id 之外没有别的用
 * （eslint 的 no-useless-assignment 正盯着这种"只写不读"的赋值）。
 */
const versionListId = `env-version-list-${Math.random().toString(36).slice(2, 8)}`;
const versionOptionId = (index: number): string => `${versionListId}-opt-${index}`;

/** 打开时按触发器定位（fixed + 视口坐标）；宽度跟触发器走，与规格里"宽同卡片"一致 */
function placeVersionPanel(): void {
  const trigger = versionTrigger.value;
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  versionPanelStyle.value = {
    left: `${Math.round(rect.left)}px`,
    top: `${Math.round(rect.bottom + 6)}px`,
    width: `${Math.round(rect.width)}px`,
  };
}

function openVersionPanel(): void {
  if (props.busy || props.options.length === 0) return;
  placeVersionPanel();
  versionActive.value = props.options.indexOf(props.selected ?? '');
  versionOpen.value = true;
  // 焦点进面板：键盘事件与 aria-activedescendant 都挂在那儿（触发器只负责"开"）
  void nextTick(() => {
    versionPanel.value?.focus();
    scrollActiveIntoView();
  });
}

/** 关闭。`restoreFocus` 只在"键盘/选择退出"时为真 —— 鼠标点外面时不该把焦点抢回来 */
function closeVersionPanel(restoreFocus = false): void {
  if (!versionOpen.value) return;
  versionOpen.value = false;
  if (restoreFocus) versionTrigger.value?.focus();
}

function toggleVersionPanel(): void {
  if (versionOpen.value) closeVersionPanel(true);
  else openVersionPanel();
}

/** 选中第 index 项：先把面板收掉（焦点还给触发器），再只把版本字符串递上去 */
function pickVersionAt(index: number): void {
  const one = props.options[index];
  if (!one) return;
  closeVersionPanel(true);
  emit('pick', one);
}

/** 模板里按下标取项（`v-for="one in options"` 这个标记有断言钉着，不能换成带下标的写法） */
function versionIndexOf(version: string): number {
  return props.options.indexOf(version);
}

// ---- 时间轴（A 的形态 + C 的画法）：当前 / 目标 / 区间，三个独立状态 ------------------

/** 当前那一份在列表里的下标（`-1` = 不在列表里：版本没测到，或列表里没有它） */
const currentIndex = computed(() => props.options.indexOf(props.current ?? ''));

/** 目标在列表里的下标（`selected` = 用户选过就是它，否则是主进程算出来的目标） */
const targetIndex = computed(() => props.options.indexOf(props.selected ?? ''));

/**
 * 方向与区间都来自纯函数（`version-pick.ts`）—— 界面**不自己比版本号字符串**：
 * `rc.9` 与 `rc.10` 按字典序比会得出相反的方向，而这类错在界面上极难被肉眼发现。
 */
const direction = computed<PickDirection>(() =>
  pickDirection(currentIndex.value, targetIndex.value),
);

/** 要画成强调色实线的那几行（集合查；模板里不用 `:nth-child` 猜区间） */
const betweenIndexSet = computed<Set<number>>(
  () => new Set(betweenIndexes(currentIndex.value, targetIndex.value)),
);

/**
 * 「目标」标记只挂在**不是当前**的那一行上：目标就是当前这一版时，同一行既是当前又是目标，
 * 两个标签叠在一起读不出信息 —— 那时只留「当前」（节点的画法同理，实心绿点优先）。
 */
function isTargetRow(one: string): boolean {
  return one === (props.selected ?? '') && one !== (props.current ?? '');
}

/**
 * 浮层顶部那条**粘性摘要**：把"从哪到哪、是升是降"钉在顶边 —— 浮层限高 232px 会滚，
 * 「当前」那一行可能被滚出视野，方向信息不能跟着滚走。浮层没滚动时它也在（它是摘要，不是
 * "滚动才出现"的东西）。
 *
 * 三种文案：升 `0.1.5-rc.1 → 0.2.0-rc.2 · 升级`、降 `… · ↓ 降级`、相等 `…（当前就是这一版）`。
 * **缺当前版本就不编"从哪来"**：那时只写目标那一版（与"不编命令"同一条原则）。
 */
const headText = computed(() => {
  const current = props.current ?? '';
  const target = props.selected ?? '';
  if (!target) return '';
  if (!current) return target;
  if (current === target) return `${current}（当前就是这一版）`;
  return `${current} → ${target} · ${direction.value === 'down' ? '↓ 降级' : '升级'}`;
});

/** 摘要行的色调：升 accent、降 amber、相等/认不出走中性（amber 只表示"在往下降"） */
const headTone = computed<string>(() => `is-${direction.value}`);

/**
 * 某一版挂着哪些 dist-tags（`['latest', 'next']`，按名字排序）。
 *
 * dist-tags 是**主进程从安装源拿的原文**（`latest` / `next` / `alpha`），这里只做展示 ——
 * 一个版本可能同时挂着多个 tag，按 tag 名的字母序排，不去重也不猜。
 */
function tagsOf(version: string): string[] {
  return Object.entries(props.tags)
    .filter(([, value]) => value === version)
    .map(([name]) => name)
    .sort();
}

/** 下拉里每个版本后面的标签后缀（`0.2.0-rc.2 · latest`）：自绘控件里退到**无障碍名字/悬停提示**上 */
function tagSuffix(version: string): string {
  const names = tagsOf(version);
  return names.length > 0 ? ` · ${names.join(' / ')}` : '';
}

function scrollActiveIntoView(): void {
  const panel = versionPanel.value;
  if (!panel || versionActive.value < 0) return;
  panel
    .querySelector<HTMLElement>(`[data-version-index="${versionActive.value}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}

function onVersionKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (!versionOpen.value) return;
    event.preventDefault();
    closeVersionPanel(true);
    return;
  }
  if (!versionOpen.value) {
    // 折叠态：↓/↑/Enter/Space 都当"打开"（与原生 select 一致）
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      openVersionPanel();
    }
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (versionActive.value >= 0) pickVersionAt(versionActive.value);
    return;
  }
  const nav: VersionNavKey | null =
    event.key === 'ArrowDown'
      ? 'ArrowDown'
      : event.key === 'ArrowUp'
        ? 'ArrowUp'
        : event.key === 'Home'
          ? 'Home'
          : event.key === 'End'
            ? 'End'
            : null;
  if (!nav) return;
  event.preventDefault();
  versionActive.value = nextActiveIndex(versionActive.value, nav, props.options.length);
  void nextTick(scrollActiveIntoView);
}

/** 点面板外关闭（用 `pointerdown` 而不是 `click`：后者会先落在选项上、先选中再关） */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!versionOpen.value) return;
  const target = event.target as Node | null;
  if (!target) return;
  if (versionTrigger.value?.contains(target)) return; // 触发器自己走 click 的开关，别在这里抢先关
  if (versionPanel.value?.contains(target)) return;
  closeVersionPanel();
}

/**
 * 视口一动（scroll / resize）就**关闭**，不做重算。
 *
 * 选"关闭"而不是"重算"的理由：重算只是把位置追上去，但浮层与触发器之间的锚定关系已经不可靠
 * （触发器可能滚出可视区、或被别的层遮住），而**追踪**要挂在滚动容器链上、还得处理 fixed 与
 * 变换祖先的组合，代码量与出错面都大得多。原生 `<select>` 在滚动时也是直接收起来。
 * `scroll` 用 capture 收（scroll 不冒泡）：**但要放过面板自己内部的滚动**，否则列表一滚就关。
 */
function onViewportMove(event: Event): void {
  if (!versionOpen.value) return;
  const target = event.target as Node | null;
  if (target && versionPanel.value?.contains(target)) return;
  closeVersionPanel();
}

watch(versionOpen, (open) => {
  if (open) {
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    window.addEventListener('scroll', onViewportMove, true);
    window.addEventListener('resize', onViewportMove);
  } else {
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    window.removeEventListener('scroll', onViewportMove, true);
    window.removeEventListener('resize', onViewportMove);
  }
});

// 组件被拆掉时（切页 / 关掉详情层）一定要摘监听：不然它们会一直挂着一个已经消失的面板
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  window.removeEventListener('scroll', onViewportMove, true);
  window.removeEventListener('resize', onViewportMove);
});
</script>

<template>
  <div class="env-version-pick">
    <span class="wizard-version-label">选择版本</span>
    <button
      ref="versionTrigger"
      type="button"
      class="env-version-trigger"
      :class="{ 'is-open': versionOpen }"
      :disabled="busy"
      aria-haspopup="listbox"
      :aria-expanded="versionOpen ? 'true' : 'false'"
      :aria-controls="versionListId"
      :title="`${selected ?? ''}${tagSuffix(selected ?? '')}`"
      @click="toggleVersionPanel"
      @keydown="onVersionKeydown"
    >
      <span class="env-version-value">{{ selected || '（还没选）' }}</span>
      <span v-if="tagsOf(selected ?? '').length > 0" class="env-version-tags">
        <span
          v-for="tag in tagsOf(selected ?? '')"
          :key="tag"
          class="env-version-tag"
          :class="`is-${tag}`"
          >{{ tag }}</span
        >
      </span>
      <span class="env-version-caret" aria-hidden="true">▾</span>
    </button>
  </div>

  <!-- 浮层本体：**Teleport 到 body + fixed 定位**（留在卡片里会被裁，见脚本那段注释）。
       点外面关（pointerdown）、Esc 关并把焦点还给触发器、↑↓/Home/End/Enter 都能走。
       列表的画法是 C（版本时间轴）：每行一条轴 + 一个节点，当前实心绿点、目标空心 accent 环、
       当前到目标之间那段轴换强调色；顶上再钉一条**粘性摘要**（限高 232px 会滚，"当前"可能被滚出
       视野，方向信息不能跟着滚走）。 -->
  <Teleport to="body">
    <div
      v-if="versionOpen"
      :id="versionListId"
      ref="versionPanel"
      class="env-version-pop"
      :style="versionPanelStyle"
      role="listbox"
      tabindex="-1"
      :aria-activedescendant="versionActive >= 0 ? versionOptionId(versionActive) : undefined"
      @keydown="onVersionKeydown"
    >
      <!-- 摘要行 aria-hidden：listbox 的**暴露**子节点只许是 option，而这条只是把方向信息重复一遍
           （同样的方向还有行上的「当前/目标」与下面那条降级说明）—— 让它在无障碍树里消失，
           既保住 listbox 的语义，也不丢视觉信息 -->
      <div class="env-version-head" :class="headTone" aria-hidden="true" data-version-head>
        {{ headText }}
      </div>
      <div class="env-version-list">
        <div
          v-for="one in options"
          :id="versionOptionId(versionIndexOf(one))"
          :key="one"
          class="env-version-opt"
          :class="{
            'is-on': versionIndexOf(one) === versionActive,
            'is-current': one === (current ?? ''),
            'is-target': isTargetRow(one),
            'is-between': betweenIndexSet.has(versionIndexOf(one)),
            'is-down': direction === 'down',
            'is-up': direction === 'up',
          }"
          role="option"
          :aria-selected="one === selected ? 'true' : 'false'"
          :data-version-index="versionIndexOf(one)"
          :title="`${one}${tagSuffix(one)}`"
          @pointermove="versionActive = versionIndexOf(one)"
          @click="pickVersionAt(versionIndexOf(one))"
        >
          <!-- 轴与节点：每行自己画一段竖线（align-self: stretch + 伪元素），行高变化不会把线画歪；
               首尾两行由 CSS 收口（第一行从节点起、最后一行到节点止） -->
          <span class="env-version-axis" aria-hidden="true">
            <span class="env-version-node"></span>
          </span>
          <span class="env-version-opt-body">
            <span class="env-version-opt-ver">{{ one }}</span>
            <span v-if="tagsOf(one).length > 0" class="env-version-tags">
              <span
                v-for="tag in tagsOf(one)"
                :key="tag"
                class="env-version-tag"
                :class="`is-${tag}`"
                >{{ tag }}</span
              >
            </span>
            <span v-if="one === (current ?? '')" class="env-version-opt-right is-cur">当前</span>
            <span v-else-if="isTargetRow(one)" class="env-version-opt-right is-target">目标</span>
          </span>
        </div>
      </div>
    </div>
  </Teleport>
</template>
