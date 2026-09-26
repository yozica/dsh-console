/**
 * 渲染层的共享状态（外壳与各页面都从这里取，不再各订阅一份）。
 *
 * 为什么需要它：迁移是逐页做的，先是每个页面各自 `getSnapshot()` + `onState()`，
 * 于是同一份快照被订阅了好几遍。外壳开始迁移时把它收成一份 —— 一处订阅，
 * 大家读同一份响应式状态。
 */

import { computed, ref } from 'vue';

import { phaseText } from './phase-text.js';
import { applyPlatformAttribute, setPlatform } from './platform.js';
import { RELEASES_URL } from '../../shared/ipc';
import type {
  AppSnapshot,
  DshConsoleApi,
  DshPhase,
  DshSnapshot,
  SettingsValues,
  ThemeInfo,
  ThemeMode,
  UpdateState,
} from '../../shared/ipc';

const api: DshConsoleApi = window.dshConsole;

/** 页面标识：左栏导航、快捷键、各页可见性都用它 */
export type TabId = 'dashboard' | 'terminal' | 'ui' | 'usage' | 'archive' | 'plugin' | 'settings';

/** 最近一次完整快照（getSnapshot 的返回结构） */
export const snapshot = ref<AppSnapshot | null>(null);
/** 快照里的 dsh 状态（onState 只推这一部分） */
export const dsh = computed<DshSnapshot | null>(() => snapshot.value?.dsh || null);
/** 快照还没到时给空对象：读不到的设置项就是 undefined，各页按默认值兜 */
const EMPTY_SETTINGS = {} as SettingsValues;
export const settings = computed<SettingsValues>(() => snapshot.value?.settings || EMPTY_SETTINGS);
export const phase = computed<DshPhase>(() => dsh.value?.phase || 'stopped');
export const phaseInfo = computed(() => phaseText(phase.value));
/** 归属判断只看 dsh.owned */
export const owned = computed(() => Boolean(dsh.value?.owned));

/**
 * 内嵌 DSH 界面「可用或即将可用」—— 自动进全屏只该在它为真时发生。
 *
 * - 已经拿到带令牌地址（`uiUrl`）→ 可用；
 * - 本应用启动的 dsh（`owned`）**未必要马上有令牌**：先起服务、后打印地址，所以令牌在路上时
 *   也算"即将可用"，页面会在令牌到达后自动载入；
 * - **外部实例且没令牌时不算**：那时 Harness 页只有一段"拿不到令牌"的说明，为它收起整屏
 *   （藏掉左栏与底栏）没有意义 —— 用户点开这一页时莫名全屏，反馈过这一条。
 *
 * 用户手动粘贴的地址在 UiPane 自己的 ref 里、不在这份共享状态中，所以那边会额外 `|| pastedUrl`。
 */
export const uiLoadable = computed(() => Boolean(dsh.value?.uiUrl) || owned.value);

/**
 * 自动更新状态：主进程（main/updater.ts）是唯一状态机，这里只是镜像 ——
 * 底栏（layout/StatusBar.vue）与设置页读同一份。
 * 初始 idle 只是"快照还没到"的占位；startStore() 会用快照里的 update 覆盖它。
 */
export const update = ref<UpdateState>({
  phase: 'idle',
  currentVersion: '',
  version: null,
  percent: null,
  message: null,
  canAutoUpdate: false,
  canCheck: false,
  releasesUrl: RELEASES_URL,
});

/** 当前页面（外壳的导航与各页共用） */
export const currentTab = ref<TabId>('dashboard');
/** 应用内全屏（顶栏的退出按钮、Harness 页的全屏按钮、Esc 都改它） */
export const immersive = ref(false);
/** 自动进入过一次全屏后置位：手动退出后不再自动拉回去 */
export const immersiveAutoEntered = ref(false);
/** 启动时是否已经自动打开过 Harness 页 */
export const uiAutoOpened = ref(false);

let pending: Promise<void> | null = null;

/** 主题落地到 <html data-theme>：CSS 变量全挂在它上面（xterm 的配色不走 CSS，各自处理） */
function syncDocumentTheme(): void {
  const resolved = snapshot.value?.theme?.resolved === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = resolved;
}

/**
 * 系统窗口全屏状态落地到 <body data-native-fullscreen>。
 *
 * 跟"应用内全屏"（immersive）是两件事：那个只是藏掉左栏与状态栏，不动系统窗口状态。
 * 这里指的是 macOS 绿灯 / Windows F11 那种**系统级**全屏。
 * CSS 靠它决定要不要给红绿灯留位置 —— macOS 全屏时红绿灯平时是隐藏的（鼠标移到
 * 屏幕顶端才出现），继续留白就是一块说不清用途的空白。
 */
function syncDocumentFullscreen(on: boolean): void {
  document.body.dataset.nativeFullscreen = on ? 'true' : 'false';
}

/**
 * 建立唯一的订阅。幂等，而且**第二次调用会等第一次完成** ——
 * 这里必须缓存 Promise，不能只用一个 boolean：
 * main.ts 是 `void startStore()` 先发起，组件挂载后再 `await startStore()`，
 * 若第二次直接返回，组件会在快照还是 null 时就去读（踩过：事件日志首个挂载是空的）。
 */
export function startStore(): Promise<void> {
  if (!pending) {
    pending = (async () => {
      snapshot.value = await api.getSnapshot();
      // 更新状态也来自快照：它是"主进程先有、渲染层后连上"的（macOS / 开发态在窗口加载前
      // 就已经是 unsupported），只靠 onUpdateState 会丢掉那一次。
      update.value = snapshot.value.update;
      // 主进程的 platform 是权威值：拿它校准 UA 推断的结果，再落到 <html data-platform>
      setPlatform(snapshot.value?.env?.platform);
      applyPlatformAttribute();
      syncDocumentTheme();
      syncDocumentFullscreen(Boolean(snapshot.value?.env?.nativeFullscreen));
      api.onState((next) => {
        snapshot.value = { ...(snapshot.value as AppSnapshot), dsh: next };
      });
      api.onTheme((info) => {
        if (snapshot.value) snapshot.value.theme = info;
        syncDocumentTheme();
      });
      api.onFullscreen((on) => syncDocumentFullscreen(Boolean(on)));
      api.onUpdateState((next) => {
        update.value = next;
      });
      /**
       * 主进程自己改了设置时（目前只有关闭询问框的「记住我的选择」）要跟着更新：
       * 设置页的表单是拿快照填的，留着旧值的话用户下次一按保存就把旧值写回去了。
       */
      api.onSettings((next) => {
        if (snapshot.value) snapshot.value.settings = next;
      });
    })();
  }
  return pending;
}

/** 主题三态开关与设置页共用：改完把结果写回快照 */
export async function setThemeMode(mode: ThemeMode): Promise<ThemeInfo> {
  const info = await api.setTheme(mode);
  if (snapshot.value) snapshot.value.theme = info;
  return info;
}
