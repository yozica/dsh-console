<script setup lang="ts">
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
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { snapshot, update } from '../lib/store.js';
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
});

onUnmounted(() => {
  if (statusTimer) clearTimeout(statusTimer);
  if (stopThemeWatch) stopThemeWatch();
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

    <section class="panel">
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
  </div>
</template>
