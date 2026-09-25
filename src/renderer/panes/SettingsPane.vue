<script setup lang="ts">
// 这一页里「运行环境」那张卡（t45）：平时只显示一行结论，点「查看详情」才打开完整那套
//（左栏不再有「环境自检」这一项，改动理由与落点见 docs/env-doctor.md 的 t45 改判）。
const envCounts = computed(() => envReport.value?.counts ?? null);
const envSummary = computed(() => {
  const counts = envCounts.value;
  if (!counts) {
    return envReportLoading.value ? '正在检查这台电脑上的运行环境…' : '还没查过';
  }
  // 措辞与顺序跟详情视图顶部那一行完全一致（EnvPane 的那句结论），点进详情不该像换了个说法
  return `${counts.ok} 项正常 · ${counts.missing} 项不正常 · ${counts.warn} 项需要注意`;
});
const envRequirement = computed(() =>
  envReport.value ? `要求 Node ${envReport.value.nodeRange}（dsh 与它依赖链的要求）` : '',
);

/** 「重新检测」：请主进程清缓存重跑一轮（真结论由它给，界面不自己判） */
function recheckEnv(): void {
  if (envReportLoading.value) return;
  void loadEnvReport(true);
}
/**
 * 设置页（第一个迁到 Vue 的页面）。
 *
 * 迁移前这里是三段靠 id 字符串对暗号的代码：index.html 里的 15 个 input、
 * app.js 里的 SETTING_FIELDS 映射表 + fillSettings() + readSettings()。
 * 现在字段名直接写在模板的 v-model 上，"界面长什么样"和"读写了哪个设置项"
 * 在同一处，改一个字段只需要动这一个文件。
 *
 * 与外壳（app.ts）之间只通过一个 CustomEvent 通信（保存/重载后通知它刷新快照），
 * 不共享可变全局。
 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { envReport, envReportLoading, loadEnvReport } from '../lib/env-doctor.js';
import { openEnvDetail } from '../lib/env-layer.js';
import { settings, snapshot, update } from '../lib/store.js';
import { isMac } from '../lib/platform.js';
import { scrollIntoViewEased } from '../lib/scroll.js';
import { updateCardFocus } from '../lib/update-anchor.js';
import type { EnvInfo, SettingsValues, UpdatePhase } from '../../shared/ipc';

const api = window.dshConsole;

/** 表单状态：键名与主进程的设置项一一对应 */
const form = reactive({
  themeMode: 'system',
  deepseekUrl: '',
  host: '127.0.0.1',
  port: 3080,
  dshCommand: '',
  pluginRegistry: '',
  extraArgs: '',
  cwd: '',
  shell: '',
  pollIntervalMs: 1500,
  startTimeoutMs: 60000,
  stopGraceMs: 3000,
  autoStart: true,
  openUiOnStart: true,
  uiFullscreenOnStart: true,
  killOnExit: true,
  closeAction: 'ask',
  autoCheckUpdates: true,
});

const userData = ref('');
const status = ref('');
const busy = ref(false);
/** 版本信息来自快照的 env（主进程给），开发态与打包态都在这里如实显示 */
const appVersion = ref('—');
const packaged = ref(false);
const runtime = reactive({ electron: '—', node: '—', chrome: '—' });
let statusTimer: ReturnType<typeof setTimeout> | null = null;
let stopThemeWatch: (() => void) | null = null;
let stopCloseActionWatch: (() => void) | null = null;

function fill(values: Partial<SettingsValues>): void {
  for (const key of Object.keys(form)) {
    const next = values[key as keyof SettingsValues];
    if (next !== undefined) (form as Record<string, unknown>)[key] = next;
  }
}

/** 数字输入留空会变成 ''/NaN，这时保留原值，别把配置写成 NaN */
function normalize(
  patch: Record<string, unknown>,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of ['port', 'pollIntervalMs', 'startTimeoutMs', 'stopGraceMs']) {
    const value = Number(patch[key]);
    patch[key] = Number.isFinite(value) ? value : fallback[key];
  }
  return patch;
}

function flash(message: string): void {
  status.value = message;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (status.value = ''), 4000);
}

/** 告诉外壳（app.ts）：设置变了，请刷新快照并重绘 */
function announce(next: SettingsValues): void {
  window.dispatchEvent(new CustomEvent('dsh:settings-changed', { detail: next }));
}

async function load(): Promise<SettingsValues> {
  // 首屏读共享 store（外壳与其它页面读的是同一份）；「重新载入」按钮要的是最新值，
  // 所以这里照旧问主进程要一次完整快照。
  const fresh = await api.getSnapshot();
  fill(fresh.settings);
  userData.value = fresh.userData || '';
  applyEnv(fresh.env);
  return fresh.settings;
}

/** 版本信息：应用自身版本 + 运行时不变量 */
function applyEnv(env?: EnvInfo): void {
  if (!env) return;
  appVersion.value = env.app || '—';
  packaged.value = Boolean(env.packaged);
  Object.assign(runtime, env.versions || {});
}

async function save() {
  busy.value = true;
  try {
    const patch = normalize({ ...form }, { ...form });
    const next = await api.patchSettings(patch);
    fill(next);
    announce(next);
    flash('已保存');
  } catch (cause) {
    // 主进程拒绝整份 patch（例如它不认识某个键 —— 界面比主进程新的时候）。
    // 这时**一个字都没写**，绝不能说"已保存"。
    flash(`没保存上：${errorText(cause)}`);
  } finally {
    busy.value = false;
  }
}

/** invoke 抛回来的错误带一层 "Error invoking remote method 'x': Error: " 前缀，去掉它 */
function errorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
}

async function reload() {
  busy.value = true;
  try {
    const settings = await load();
    announce(settings);
    flash('已重新载入');
  } finally {
    busy.value = false;
  }
}

// ---------------------------------------------------------------- 自动更新

/** 相位兜底文案：主进程一般会给 message，这里只兜"还没检查过"这类空档 */
const PHASE_FALLBACK: Record<UpdatePhase, string> = {
  idle: '尚未检查更新',
  checking: '正在检查更新…',
  available: '发现新版本',
  downloading: '正在下载更新…',
  downloaded: '已下载，重启后安装',
  error: '检查更新失败',
  unsupported: '自动更新不可用',
};

const updateText = computed(() => update.value.message || PHASE_FALLBACK[update.value.phase]);

/**
 * 卡片底部那句说明 —— **按平台分开写**。
 *
 * 之前这里是一句写死的话（"发现新版本会先问你，下载与安装都不会自己做"），那是 Windows 的行为；
 * macOS 上是 ad-hoc 签名、根本没有下载与安装，照样说这句就是错的（用户看过截图指出来的）。
 * 版本号也不在这里重复：上面「关于」里已经有 `DSH Console x.y.z`。
 */
const updateNote = computed(() => {
  // 既不能查也不能装（开发态）：状态行已经把原因说全了，不再补一句
  if (!update.value.canCheck) return '';
  const actionable = update.value.phase === 'available' || update.value.phase === 'downloaded';
  if (update.value.canAutoUpdate) {
    return actionable
      ? '下载与安装都要你确认；安装时应用会退出并重新打开。'
      : '发现新版本会先问你，下载与安装都不会自己做。';
  }
  return actionable
    ? 'macOS 当前是 ad-hoc 签名，系统会拒绝安装更新；点「打开下载页」下载新的 dmg 覆盖安装。'
    : 'macOS 当前是 ad-hoc 签名，无法自动安装；有新版本会在这里提示。';
});
const updatePercent = computed(() => Math.max(0, Math.min(100, update.value.percent ?? 0)));

type UpdateAction = 'check' | 'download' | 'install' | 'releases';

/** 按钮语义只看"能不能自动更新 + 当前相位"（macOS / 开发态永远只有「打开下载页」） */
const updateAction = computed<UpdateAction>(() => {
  // 既不能查也不能装（开发态、其它平台）→ 只剩"去下载页"
  if (!update.value.canCheck) return 'releases';
  if (update.value.phase === 'available') {
    // macOS：查得到新版本，但装不了（ad-hoc 签名）→ 引导去下载页
    return update.value.canAutoUpdate ? 'download' : 'releases';
  }
  if (update.value.phase === 'downloaded') return 'install';
  return 'check';
});

const updateBusy = computed(
  () => update.value.phase === 'checking' || update.value.phase === 'downloading',
);

const updateLabel = computed(() => {
  switch (update.value.phase) {
    case 'checking':
      return '检查中…';
    case 'downloading':
      return '下载中…';
    case 'error':
      return '重试';
    case 'available':
      return update.value.canAutoUpdate ? '下载' : '打开下载页';
    case 'downloaded':
      return '重启并安装';
    default:
      return update.value.canCheck ? '检查更新' : '打开下载页';
  }
});

/** 一个按钮承载四种动作；模板里不给导入的 ref 直接赋值，统一走这个函数 */
async function runUpdate(): Promise<void> {
  if (updateBusy.value) return;
  const action = updateAction.value;
  if (action === 'download') update.value = await api.downloadUpdate();
  else if (action === 'install') await api.installUpdate();
  else if (action === 'releases') void api.openExternal(update.value.releasesUrl);
  else update.value = await api.checkForUpdates();
}

// ---------------------------------------------------------------- 底栏点进来的锚点

/** 缓动滚动时长。原生 `behavior: 'smooth'` 的速度由浏览器定、偏快（用户反馈"还没看清就到了"） */
const SCROLL_MS = 620;
/**
 * 切页之后、滚动之前的停顿。
 *
 * 这一下是必须的：切页与滚动同时发生的话，界面换了、滚动也开始了，眼睛还没认出新页面
 * 就已经滚到位 —— 用户的原话是"怪"。停 300ms 让"我到了设置页"先成立，再开始"带你去那儿"。
 */
const SETTLE_MS = 300;
/** 蒙层停留多久后自动收（点一下、按一下键、滚一下滚轮都会提前收） */
const SPOTLIGHT_HOLD_MS = 2600;
/** 蒙层淡出时长：与 styles.css 里 .spotlight 的 transition 对齐 */
const SPOTLIGHT_FADE_MS = 240;
/** 高亮框比卡片外扩一点：贴着卡片边缘看像描错了框 */
const SPOTLIGHT_PAD = 6;

/** 等若干毫秒。只用于上面那个停顿；中途重来时由 runToken 兜住，不需要可取消 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const aboutCard = ref<HTMLElement | null>(null);
const spotlightOn = ref(false);
const spotlightClosing = ref(false);
const spotlightRect = ref<{ top: number; left: number; width: number; height: number } | null>(
  null,
);
/** 每次请求一个号：中途又点了一次底栏提示时，旧的流程在 await 处自行退出 */
let runToken = 0;
let spotlightTimer: ReturnType<typeof setTimeout> | null = null;

/** 内联样式：没量到位置时给 undefined（Vue 会忽略），别给一个空对象去表达"没有" */
const spotlightStyle = computed<Record<string, string> | undefined>(() => {
  const rect = spotlightRect.value;
  if (!rect) return undefined;
  return {
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
});

/** 点一下、按一下键、滚一下滚轮都算"我看过了" —— 这层蒙层不该拦着人 */
function unwireSpotlightDismiss(): void {
  window.removeEventListener('pointerdown', dismissSpotlight);
  window.removeEventListener('keydown', dismissSpotlight);
  window.removeEventListener('wheel', dismissSpotlight);
}

function dismissSpotlight(): void {
  if (!spotlightOn.value || spotlightClosing.value) return;
  unwireSpotlightDismiss();
  if (spotlightTimer) clearTimeout(spotlightTimer);
  spotlightClosing.value = true;
  spotlightTimer = setTimeout(() => {
    spotlightOn.value = false;
    spotlightClosing.value = false;
    spotlightTimer = null;
  }, SPOTLIGHT_FADE_MS);
}

/**
 * 底栏的「发现新版本」点进来：**先切页并落定，再缓动带到卡片，最后才开蒙层**。
 *
 * 三步的先后不能换：蒙层量的是 `getBoundingClientRect()`，滚动途中量会画到半路，
 * 所以必须等滚动结束再量。切页那一步由 StatusBar 改 currentTab，这里只等一次渲染
 * （页面是靠 visibility 切换的），再停 SETTLE_MS —— 停顿的理由见那个常量的说明。
 *
 * 蒙层本身 `pointer-events: none`：它只是把"看这里"说清楚，用户想直接点卡片上的按钮
 * 不该被挡住（那一下点击同时也会把蒙层收掉）。
 */
async function spotlightUpdateCard(): Promise<void> {
  const token = ++runToken;
  const target = aboutCard.value;
  if (!target) return;
  await nextTick();
  if (token !== runToken) return;

  // 停一下再滚：见 SETTLE_MS 的说明
  await wait(SETTLE_MS);
  if (token !== runToken) return;

  await scrollIntoViewEased(target, SCROLL_MS);
  if (token !== runToken) return;

  const rect = target.getBoundingClientRect();
  spotlightRect.value = {
    top: rect.top - SPOTLIGHT_PAD,
    left: rect.left - SPOTLIGHT_PAD,
    width: rect.width + SPOTLIGHT_PAD * 2,
    height: rect.height + SPOTLIGHT_PAD * 2,
  };
  spotlightOn.value = true;
  spotlightClosing.value = false;
  if (spotlightTimer) clearTimeout(spotlightTimer);
  spotlightTimer = setTimeout(dismissSpotlight, SPOTLIGHT_HOLD_MS);
  // 监听在蒙层出现的下一拍才可能被同一次点击触发（这里已经 await 过滚动，安全）
  window.addEventListener('pointerdown', dismissSpotlight);
  window.addEventListener('keydown', dismissSpotlight);
  window.addEventListener('wheel', dismissSpotlight, { passive: true });
}

watch(updateCardFocus, (request) => {
  if (!request) return;
  void spotlightUpdateCard();
});

onMounted(async () => {
  await load();
  // 左下角的主题开关改的是同一个设置：store 已经订阅了 theme:changed，这里跟着同步
  stopThemeWatch = watch(
    () => snapshot.value?.theme?.mode,
    (mode) => {
      if (mode) form.themeMode = mode;
    },
    { immediate: true },
  );
  // 关闭询问框里勾了「记住我的选择」时是**主进程**直接写盘的：只跟这一个键，
  // 不整份 fill —— 否则会把用户还没保存的其它改动一起盖掉
  stopCloseActionWatch = watch(
    () => settings.value.closeAction,
    (action) => {
      if (action) form.closeAction = action;
    },
  );
});

onUnmounted(() => {
  if (statusTimer) clearTimeout(statusTimer);
  if (spotlightTimer) clearTimeout(spotlightTimer);
  unwireSpotlightDismiss();
  if (stopThemeWatch) stopThemeWatch();
  if (stopCloseActionWatch) stopCloseActionWatch();
});
</script>

<template>
  <div class="settings">
    <section class="panel">
      <header class="panel-head"><h3>外观</h3></header>
      <div class="panel-block">
        <div class="form-row">
          <label for="s-themeMode">界面主题</label>
          <select id="s-themeMode" v-model="form.themeMode">
            <option value="system">跟随系统</option>
            <option value="light">亮色</option>
            <option value="dark">深色</option>
          </select>
        </div>
        <p class="hint">
          左下角「自动 / 亮 / 深」是同一个设置。内嵌的 DSH 界面有自己的主题，不跟着改。
        </p>
      </div>
    </section>

    <section class="panel">
      <header class="panel-head"><h3>DeepSeek 用量页</h3></header>
      <div class="panel-block">
        <div class="form-row">
          <label for="s-deepseekUrl">页面地址</label>
          <input
            id="s-deepseekUrl"
            type="text"
            placeholder="https://platform.deepseek.com/usage"
            v-model.trim="form.deepseekUrl"
          />
        </div>
        <p class="hint">
          默认是开放平台的用量页。改成 <code>https://www.deepseek.com</code> 就是官网主页，
          改成别的地址也可以 —— 这一页只是个浏览器视图。
        </p>
      </div>
    </section>

    <section class="panel">
      <header class="panel-head"><h3>服务端点</h3></header>
      <div class="panel-block">
        <div class="form-row">
          <label for="s-host">监听地址</label>
          <select id="s-host" v-model="form.host">
            <option value="127.0.0.1">127.0.0.1（仅本机）</option>
            <option value="0.0.0.0">0.0.0.0（局域网可访问）</option>
          </select>
        </div>
        <div class="form-row">
          <label for="s-port">端口</label>
          <input id="s-port" type="number" min="0" max="65535" v-model.number="form.port" />
        </div>
        <p class="hint">端口填 0 让系统挑一个空闲端口，实际端口从 dsh 打印的地址里读回来。</p>
      </div>
    </section>

    <section class="panel">
      <header class="panel-head"><h3>启动方式</h3></header>
      <div class="panel-block">
        <div class="form-row">
          <label for="s-dshCommand">dsh 命令</label>
          <input
            id="s-dshCommand"
            type="text"
            placeholder="留空则自动探测"
            v-model.trim="form.dshCommand"
          />
        </div>
        <div class="form-row">
          <label for="s-extraArgs">附加参数</label>
          <input
            id="s-extraArgs"
            type="text"
            placeholder="拼在 web --no-open 之后"
            v-model.trim="form.extraArgs"
          />
        </div>
        <div class="form-row">
          <label for="s-cwd">工作目录</label>
          <input id="s-cwd" type="text" placeholder="留空使用用户主目录" v-model.trim="form.cwd" />
        </div>
        <div class="form-row">
          <label for="s-shell">本地 Shell</label>
          <input id="s-shell" type="text" placeholder="留空则自动选择" v-model.trim="form.shell" />
        </div>
      </div>
    </section>

    <section class="panel">
      <header class="panel-head"><h3>插件安装源</h3></header>
      <div class="panel-block">
        <div class="form-row">
          <label for="s-pluginRegistry">registry</label>
          <input
            id="s-pluginRegistry"
            type="text"
            placeholder="留空则跟随系统 npm 配置"
            v-model.trim="form.pluginRegistry"
          />
        </div>
        <p class="hint">
          只作用于插件页的装 / 卸 / 升级：作为子进程环境变量传给那一次 pnpm，<b
            >不改电脑上的 npm 配置</b
          >，也不影响别的项目。例如
          <code>https://registry.npmmirror.com</code>
        </p>
      </div>
    </section>

    <section class="panel">
      <header class="panel-head"><h3>监控与生命周期</h3></header>
      <div class="panel-block">
        <div class="form-row">
          <label for="s-pollIntervalMs">状态轮询间隔</label>
          <div class="input-suffix">
            <input
              id="s-pollIntervalMs"
              type="number"
              min="500"
              step="100"
              v-model.number="form.pollIntervalMs"
            />
            <span>毫秒</span>
          </div>
        </div>
        <div class="form-row">
          <label for="s-startTimeoutMs">启动超时</label>
          <div class="input-suffix">
            <input
              id="s-startTimeoutMs"
              type="number"
              min="5000"
              step="1000"
              v-model.number="form.startTimeoutMs"
            />
            <span>毫秒</span>
          </div>
        </div>
        <div class="form-row">
          <label for="s-stopGraceMs">优雅停机等待</label>
          <div class="input-suffix">
            <input
              id="s-stopGraceMs"
              type="number"
              min="500"
              step="500"
              v-model.number="form.stopGraceMs"
            />
            <span>毫秒</span>
          </div>
        </div>
        <label class="check">
          <input id="s-autoStart" type="checkbox" v-model="form.autoStart" />
          <span>启动应用时自动拉起 dsh（已在跑就接管，不重复启动）</span>
        </label>
        <label class="check">
          <input id="s-openUiOnStart" type="checkbox" v-model="form.openUiOnStart" />
          <span>就绪后自动切到 DeepSeek Harness 页</span>
        </label>
        <label class="check">
          <input id="s-uiFullscreenOnStart" type="checkbox" v-model="form.uiFullscreenOnStart" />
          <span>进入该页时自动开启应用内全屏（Esc 退出；拿不到令牌、页面不可用时不会全屏）</span>
        </label>
        <label class="check">
          <input id="s-killOnExit" type="checkbox" v-model="form.killOnExit" />
          <span>关闭应用时停止本应用启动的 dsh</span>
        </label>
        <label class="check">
          <input id="s-autoCheckUpdates" type="checkbox" v-model="form.autoCheckUpdates" />
          <span>自动检查更新（启动后检查一次，之后每 6 小时一次）</span>
        </label>
        <!-- 「关闭窗口时」只在 Windows / Linux 有意义：macOS 上关窗本来就不退出（Dock 常驻、
             点图标重建窗口），"收起还是退出"这个二选一在那边不存在 —— 摆一个不生效的开关
             比不摆更糟，所以整行藏掉而不是加一句"macOS 不适用"。 -->
        <template v-if="!isMac">
          <div class="form-row">
            <label for="s-closeAction">关闭窗口时</label>
            <select id="s-closeAction" v-model="form.closeAction">
              <option value="ask">询问一次（可记住选择）</option>
              <option value="tray">收起到系统托盘</option>
              <option value="quit">直接退出应用</option>
            </select>
          </div>
          <p class="hint">
            「收起」只隐藏窗口：应用与本应用启动的 dsh 继续在后台跑，点托盘图标能叫回来。
            「退出」时是否停掉 dsh 由上面那条决定。
          </p>
        </template>
      </div>
    </section>

    <section class="panel">
      <header class="panel-head"><h3>运行环境</h3></header>
      <div class="panel-block">
        <p class="hint" id="settings-env-summary">{{ envSummary }}</p>
        <p v-if="envRequirement" class="hint" id="settings-env-requirement">
          {{ envRequirement }}
        </p>
        <div class="env-actions">
          <button id="btn-env-detail" class="btn small" @click="openEnvDetail">查看详情</button>
          <button
            id="btn-env-recheck"
            class="btn small"
            :disabled="envReportLoading"
            @click="recheckEnv"
          >
            重新检测
          </button>
        </div>
      </div>
    </section>
    <section class="panel">
      <header class="panel-head"><h3>保存</h3></header>
      <div class="panel-block">
        <div class="btn-row">
          <button id="btn-save-settings" class="btn primary" :disabled="busy" @click="save">
            保存设置
          </button>
          <button id="btn-reload-settings" class="btn" :disabled="busy" @click="reload">
            重新载入
          </button>
          <button id="btn-open-userdata" class="btn ghost" @click="api.revealUserData()">
            打开配置目录
          </button>
        </div>
        <p class="hint" id="settings-path">配置目录：{{ userData }}</p>
        <p class="hint settings-status" id="settings-status">{{ status }}</p>
      </div>
    </section>

    <section ref="aboutCard" class="panel">
      <header class="panel-head"><h3>关于</h3></header>
      <div class="panel-block">
        <p class="hint" id="settings-version">
          DSH Console {{ appVersion }}<template v-if="!packaged">（开发模式）</template>
        </p>
        <p class="hint" id="settings-runtime">
          Electron {{ runtime.electron }} · Node {{ runtime.node }} · Chromium {{ runtime.chrome }}
        </p>
      </div>
      <div class="panel-block">
        <!-- 标题与按钮同一行：按钮出现在它该在的位置（右侧、与标题对齐），
             状态与说明各占一行 —— 版本号不在这里重复（上面那行已经写了） -->
        <div class="update-head">
          <span class="update-title">软件更新</span>
          <div class="spacer"></div>
          <button class="btn small" :disabled="updateBusy" @click="runUpdate">
            {{ updateLabel }}
          </button>
        </div>
        <p class="update-phase" :data-phase="update.phase">{{ updateText }}</p>
        <div
          v-if="update.phase === 'downloading'"
          class="update-progress"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="updatePercent"
        >
          <div class="update-bar" :style="{ width: `${updatePercent}%` }"></div>
        </div>
        <p v-if="updateNote" id="update-note" class="hint">{{ updateNote }}</p>
      </div>
    </section>

    <!-- 聚焦蒙层：铺满窗口、在「关于」卡片处开一个洞。
         用 Teleport 挂到 body 上 —— 挂在页面里的话，它会被 .settings 的滚动容器与
         各级层叠上下文限制住，盖不到左栏、顶栏和底栏。 -->
    <Teleport to="body">
      <div v-if="spotlightOn" class="spotlight" :class="{ 'is-closing': spotlightClosing }">
        <div class="spotlight-hole" :style="spotlightStyle"></div>
        <div class="spotlight-ring" :style="spotlightStyle"></div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 设置页自己的样式（t48 样式分层试点，规则见 AGENTS §7.33）。
   以前它们堆在 styles.css 的「设置」一节里；搬进来之后全局表只留**跨组件**的东西：
   `.check`（多个页面都在画的复选框行）与 `.panel-block > .hint` 仍然留在那张表里 ——
   同一个元素会同时吃到两层，所以搬走的必须是"只有这一页在用"的那些（判据见 §7.33）。 */

.settings {
  display: grid;
  flex: 1 1 auto;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  /* 行高必须跟着内容走。默认 auto 行 + 卡片上的 min-height:0（看板侧栏需要它才能内部滚动）
     会让这些卡片被压扁到容器高度以内，多出来的内容被 .panel 的 overflow:hidden 裁掉，
     而且 scrollHeight == clientHeight → 连滚动条都没有（踩过：设置页最后一项永远看不到）。 */
  grid-auto-rows: max-content;
  gap: 16px;
  padding: 4px 20px 20px;
  align-content: start;
  overflow: auto;
  min-height: 0;
}

.form-row {
  display: grid;
  grid-template-columns: 118px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  padding: 7px 0;
}

.form-row > label {
  color: var(--ink-dim);
  font-size: var(--t-sm);
}

.form-row input[type='text'],
.form-row input[type='number'],
.form-row select {
  width: 100%;
  height: 30px;
  padding: 0 10px;
  background: var(--surface-2);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--r-control);
  color: var(--ink);
  font-size: var(--t-sm);
  transition:
    border-color var(--dur) ease,
    box-shadow var(--dur) ease;
}

.form-row input::placeholder {
  color: var(--ink-faint);
}

.form-row input:focus,
.form-row select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--focus);
}

.input-suffix {
  display: flex;
  align-items: center;
  gap: 8px;
}

.input-suffix > span {
  color: var(--ink-faint);
  font-size: var(--t-xs);
  white-space: nowrap;
}

/* 「关于」里的更新卡片：标题与状态一行，进度条只在下载时出现 */
.update-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.update-title {
  color: var(--ink-dim);
  font-size: var(--t-sm);
}

.update-phase {
  margin-top: 8px;
  color: var(--ink-faint);
  font-size: var(--t-xs);
}

.update-phase[data-phase='available'],
.update-phase[data-phase='downloaded'] {
  color: var(--accent);
}

.update-phase[data-phase='error'] {
  color: var(--rose);
}

/* 进度条：下沉井当轨道、强调色当填充（不引第三方进度条，也不新增颜色令牌） */
.update-progress {
  height: 6px;
  margin-top: 10px;
  background: var(--well);
  border: 1px solid var(--hairline);
  border-radius: 999px;
  overflow: hidden;
}

.update-bar {
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
  transition: width var(--dur) ease;
}

/* 聚焦蒙层（底栏点「发现新版本」进来的最后一步）：铺一层盖满窗口的蒙层，在「关于」卡片处
   开一个洞，把这一张卡片单独亮出来（见本文件的 spotlightUpdateCard）。

   两个元素分工：「洞」画那一圈铺满全屏的阴影（box-shadow 的 9999px 展开），「环」负责
   强调色描边与呼吸。分开是因为环要动阴影扩散，而洞那层带着 9999px 的巨大阴影，
   拿它做动画既贵又难看。
   位置与尺寸由 JS 按 getBoundingClientRect 写在内联样式上 —— 蒙层是 fixed，
   与 rect 正好同一个坐标系。 */

.spotlight {
  position: fixed;
  inset: 0;
  z-index: 95;
  /* 不吃鼠标事件：它只是把"看这里"说清楚，用户想直接点卡片上的按钮不该被挡住
     （那一下点击同时也会把蒙层收掉，见本文件的 dismissSpotlight） */
  pointer-events: none;
  animation: spotlight-in 220ms ease-out 1;
  transition: opacity 240ms ease;
}

/* 淡出：加上这个类，等 transition 走完再由 JS 摘掉节点 */
.spotlight.is-closing {
  opacity: 0;
}

@keyframes spotlight-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

.spotlight-hole {
  position: absolute;
  border-radius: var(--r-card);
  box-shadow: 0 0 0 9999px var(--scrim);
}

.spotlight-ring {
  position: absolute;
  border-radius: var(--r-card);
  animation: spotlight-ring 1.3s ease-in-out 2;
}

@keyframes spotlight-ring {
  0%,
  100% {
    box-shadow:
      0 0 0 1px var(--accent),
      0 0 0 6px var(--accent-soft);
  }

  50% {
    box-shadow:
      0 0 0 1px var(--accent),
      0 0 0 13px var(--accent-soft);
  }
}

/* 设置页「已保存 / 已重新载入」的即时反馈，就在按钮正下方（原来误放在「控制台」一节里） */
/* 设置页「已保存 / 已重新载入」的即时反馈，就在按钮正下方 */
.settings-status {
  min-height: 1.2em;
  color: var(--run);
}
</style>
