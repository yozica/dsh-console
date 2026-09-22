<script setup lang="ts">
/**
 * 控制台页（第二个迁到 Vue 的页面）。
 *
 * 迁移前这一页的状态散在 app.js 的 render() 里 —— 那里有 40 多处
 * `setText('m-xxx', ...)` / `document.getElementById('btn-xxx').disabled = ...`，
 * 想弄清楚"这一屏是怎么算出来的"得在 render() 的几百行里找。
 * 现在它是 computed：每个显示值都能一眼看出依赖什么。
 *
 * 与外壳（app.js）的接缝只有两条：
 *   - 数据：自己订阅 getSnapshot / onState / onLog（外壳自己也订阅，各画各的，
 *     等外壳也迁完就合并成一份）
 *   - 输出：操作结果用 `dsh:status-message` 事件交给底栏显示
 */
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { phaseText } from '../lib/phase-text.js';
import { formatDurationMs, formatUptime } from '../lib/format.js';
import { forceStopFlow, openUiExternally, stopFlow } from '../lib/dsh-actions.js';
import { restartThenOpenHarness } from '../lib/restart-flow.js';
import { requestEnvFocus } from '../lib/env-anchor.js';
import { envReport } from '../lib/env-doctor.js';
import { openEnvDetail } from '../lib/env-layer.js';
import { dsh, snapshot, startStore } from '../lib/store.js';
import type { DshLogEntry } from '../../shared/ipc.js';

const api = window.dshConsole;

const logs = ref<DshLogEntry[]>([]);
const logList = ref<HTMLElement | null>(null);
/** 正在进行的操作名（按钮的 aria-busy / 互斥用） */
const busy = ref('');
/** 每秒自增，让「已运行」自己走字（其余字段等状态轮询刷新） */
const tick = ref(0);

let offLog: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const phase = computed(() => dsh.value?.phase || 'stopped');
const info = computed(() => phaseText(phase.value));
/** 归属判断只看 dsh.owned；PID 可能是 null（PTY 刚拉起、还没就绪） */
const own = computed(() => Boolean(dsh.value?.owned));
const switching = computed(() => phase.value === 'starting' || phase.value === 'stopping');

const pidText = computed(() => {
  const d = dsh.value;
  if (!d) return '—';
  if (own.value) return d.pid ? String(d.pid) : '识别中…';
  return d.externalPid ? `外部 PID ${d.externalPid}` : '—';
});

const uptimeText = computed(() => {
  void tick.value;
  const d = dsh.value;
  if (!d) return '—';
  return formatUptime(d.startedAt ? Date.now() - d.startedAt : d.uptimeMs);
});

const latencyText = computed(() => {
  const probe = dsh.value?.probe;
  if (!probe?.reachable) return probe?.error || '不可达';
  return `${probe.latencyMs} ms`;
});

const httpText = computed(() => {
  const probe = dsh.value?.probe;
  if (!probe?.reachable) return '无响应';
  return probe.isDsh ? String(probe.statusCode) : `${probe.statusCode}，非 dsh`;
});

// 光秃秃一个 401 会被当成报错，说清它是 dsh 的正常健康响应
const httpTitle = computed(() =>
  dsh.value?.probe?.reachable && dsh.value?.probe?.isDsh
    ? 'dsh 对没有令牌的请求一律返回 401，这是它在正常响应健康检查'
    : '',
);

const ownerText = computed(() => {
  const owner = dsh.value?.portOwner;
  if (!owner) return '—';
  return `${owner.name || '未知进程'}，PID ${owner.pid || '识别中'}`;
});

const graceText = computed(() => formatDurationMs(snapshot.value?.settings?.stopGraceMs));
const launchCommand = computed(() => dsh.value?.launch?.display || '—');
const launchCwd = computed(() => String(snapshot.value?.settings?.cwd || '（用户主目录）'));

/**
 * 有「不可用」项时在顶部挂一条横幅（`warn` 不算：那只是隐患，不该天天吓人）。
 * 它是这一页到自检页的唯一入口，所以不做成弹窗、也不做成可关闭的 —— 关了用户就找不回来了。
 */
const envProblems = computed(() => envReport.value?.counts.missing ?? 0);

const firstProblemText = computed(() => {
  const report = envReport.value;
  if (!report?.firstProblemId) return '';
  return report.checks.find((check) => check.id === report.firstProblemId)?.detail ?? '';
});

function goEnvDoctor(): void {
  const id = envReport.value?.firstProblemId;
  // 带锚点过去：自检页会滚到那一行（没有首选项时只是切页）
  if (id) requestEnvFocus(id);
  // 环境自检不再是左栏一项（t45）：打开设置页那张卡的详情视图，再滚到这一行
  openEnvDetail();
}

// 延迟趋势：复用主进程已经采集的 latencyHistory
const spark = computed(() => {
  const samples = (dsh.value?.latencyHistory || []).filter((value) => Number.isFinite(value));
  if (samples.length < 2) {
    return { area: '', line: '', stats: samples.length === 1 ? `${samples[0]} ms` : '样本不足' };
  }
  const max = Math.max(...samples);
  const min = Math.min(...samples);
  const avg = Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length);
  const span = Math.max(1, max - min);
  const step = 100 / (samples.length - 1);
  const line = samples
    .map(
      (value, index) =>
        `${(index * step).toFixed(2)},${(26 - ((value - min) / span) * 22).toFixed(2)}`,
    )
    .join(' ');
  return { area: `0, 28 ${line} 100, 28`, line, stats: `平均 ${avg} ms，峰值 ${max} ms` };
});

/** 操作结果交给外壳的底栏显示（底栏是外壳的一部分） */
function say(message: string): void {
  window.dispatchEvent(new CustomEvent('dsh:status-message', { detail: message }));
}

async function run(name: string, task: () => Promise<void> | void): Promise<void> {
  if (busy.value) return;
  busy.value = name;
  try {
    await task();
  } finally {
    busy.value = '';
  }
}

const start = () =>
  run('start', async () => {
    const result = await api.start();
    if (!result.ok) alert(`启动失败：${result.error}`);
  });
const stop = () => run('stop', () => stopFlow(api, () => dsh.value));
// 重启之后自动进 Harness（t46）：控制台这一处与插件页、环境自检共用同一条流程
const restart = () =>
  run('restart', () => restartThenOpenHarness(api, () => dsh.value, 'dashboard'));
const forceStop = () => run('force', () => forceStopFlow(api));
const sendCtrlC = () => api.dshInput('\u0003');
const openInBrowser = () => openUiExternally(api, () => dsh.value);

async function copyUrl() {
  const url = dsh.value?.uiUrl;
  if (!url) {
    say('没有带令牌的地址可复制（该实例不是本应用启动的）');
    return;
  }
  await navigator.clipboard.writeText(url);
  say('地址已复制到剪贴板（含访问令牌，请勿外传）');
}

function appendLog(entry: DshLogEntry): void {
  logs.value.push(entry);
  if (logs.value.length > 250) logs.value.splice(0, logs.value.length - 250);
  void nextTick(() => {
    if (logList.value) logList.value.scrollTop = logList.value.scrollHeight;
  });
}

onMounted(async () => {
  // 快照走共享 store（外壳、设置页、这里读的是同一份，不再各订阅一遍）
  await startStore();
  for (const entry of snapshot.value?.dsh?.logs || []) appendLog(entry);
  offLog = api.onLog((entry) => appendLog(entry));
  timer = setInterval(() => (tick.value += 1), 1000);
});

onUnmounted(() => {
  if (offLog) offLog();
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="dash">
    <!-- 焦点卡：全局唯一一处带阴影的抬升表面 -->
    <section class="focus-card" id="status-strip" :data-phase="phase">
      <div class="focus-top">
        <span class="lamp lamp-lg" id="hero-dot" :data-phase="phase"></span>
        <div class="focus-text">
          <h2 class="focus-title" id="hero-title">{{ info.title }}</h2>
          <p class="focus-desc" id="hero-desc">{{ info.desc }}</p>
        </div>
        <div class="spacer"></div>
        <div class="focus-actions">
          <button
            id="btn-start"
            class="btn primary"
            :disabled="Boolean(busy) || switching || own || phase === 'external'"
            :aria-busy="busy === 'start' ? 'true' : undefined"
            :title="
              own
                ? 'dsh 正在运行，无需重复启动'
                : phase === 'external'
                  ? '该实例不是本应用启动的；要接管它请用「重启为受管实例」'
                  : switching
                    ? '正在切换状态，稍候'
                    : '用本应用启动 dsh web'
            "
            @click="start"
          >
            <svg class="i i-fill"><use href="#i-play" /></svg><span>启动</span>
          </button>
          <button
            id="btn-stop"
            class="btn"
            :disabled="Boolean(busy) || switching || (!own && !dsh?.externalPid)"
            :aria-busy="busy === 'stop' ? 'true' : undefined"
            :title="
              switching
                ? '正在切换状态，稍候'
                : own
                  ? '先发 Ctrl+C 优雅退出，超时才强杀'
                  : dsh?.externalPid
                    ? `结束外部实例 PID ${dsh.externalPid}（会先确认）`
                    : '当前没有可停止的进程'
            "
            @click="stop"
          >
            <svg class="i i-fill"><use href="#i-stop" /></svg><span>停止</span>
          </button>
          <button
            id="btn-restart"
            class="btn ghost"
            :disabled="Boolean(busy) || switching"
            :aria-busy="busy === 'restart' ? 'true' : undefined"
            @click="restart"
          >
            <svg class="i"><use href="#i-restart" /></svg><span>重启</span>
          </button>
          <span class="rule"></span>
          <button
            id="btn-open-ui"
            class="btn ghost"
            :disabled="!dsh?.probe?.reachable"
            @click="openInBrowser"
          >
            <svg class="i"><use href="#i-external" /></svg><span>在浏览器打开</span>
          </button>
          <button id="btn-copy-url" class="btn ghost" :disabled="!dsh?.uiUrl" @click="copyUrl">
            <svg class="i"><use href="#i-copy" /></svg><span>复制地址</span>
          </button>
        </div>
      </div>

      <dl class="stats">
        <div class="stat">
          <dt>PID</dt>
          <dd id="m-pid">{{ pidText }}</dd>
        </div>
        <div class="stat">
          <dt>已运行</dt>
          <dd id="m-uptime">{{ uptimeText }}</dd>
        </div>
        <div class="stat">
          <dt>延迟</dt>
          <dd id="m-latency">{{ latencyText }}</dd>
        </div>
        <div class="stat">
          <dt>HTTP</dt>
          <dd id="m-http" :title="httpTitle">{{ httpText }}</dd>
        </div>
      </dl>

      <div class="meta-line">
        <span class="meta-item">
          <span class="meta-key">地址</span>
          <span class="meta-val" id="m-origin">{{ dsh?.origin || '—' }}</span>
        </span>
        <span class="meta-item">
          <span class="meta-key">占用进程</span>
          <span class="meta-val" id="m-owner">{{ ownerText }}</span>
        </span>
      </div>
    </section>

    <!-- 环境缺项的出口：点它去自检页，并落到最该先处理的那一行 -->
    <div v-if="envProblems > 0" class="banner">
      <svg class="i"><use href="#i-warn" /></svg>
      <span>
        <b>有 {{ envProblems }} 项环境问题，可能影响 dsh 启动。</b>
        {{ firstProblemText }}
      </span>
      <span class="spacer"></span>
      <button class="btn small" @click="goEnvDoctor">去自检</button>
    </div>

    <div class="dash-body">
      <section class="panel log-panel">
        <header class="panel-head">
          <h3>事件日志</h3>
          <div class="spacer"></div>
          <button
            id="btn-log-clear"
            class="btn tiny ghost"
            title="只清空当前列表，日志文件不受影响"
            @click="logs = []"
          >
            清空
          </button>
        </header>
        <ul id="event-log" ref="logList" class="event-log">
          <li v-for="(entry, index) in logs" :key="index" :data-level="entry.level">
            <span class="ts">{{
              new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })
            }}</span
            ><span class="lv">{{ entry.level }}</span
            ><span class="msg">{{ entry.text }}</span>
          </li>
        </ul>
      </section>

      <section class="panel side-panel">
        <header class="panel-head">
          <h3>进程操作</h3>
        </header>

        <div class="panel-block">
          <div class="btn-row">
            <button
              id="btn-ctrl-c"
              class="btn small"
              :disabled="!own"
              :aria-busy="busy === 'ctrlc' ? 'true' : undefined"
              @click="sendCtrlC"
            >
              <svg class="i"><use href="#i-terminal" /></svg><span>发送 Ctrl+C</span>
            </button>
            <button
              id="btn-force-stop"
              class="btn small danger"
              :disabled="(!own && !dsh?.externalPid) || Boolean(busy)"
              :aria-busy="busy === 'force' ? 'true' : undefined"
              @click="forceStop"
            >
              <svg class="i"><use href="#i-warn" /></svg><span>强制结束进程树</span>
            </button>
          </div>
          <p class="hint">
            「停止」先发 Ctrl+C 让 dsh 自己退出，超过
            <span id="hint-grace">{{ graceText }}</span> 才强杀。
            当前实例不是本应用启动时，停止前会先问一次。
          </p>
        </div>

        <div class="panel-block">
          <div class="block-head">
            <span>延迟趋势</span>
            <span class="block-note" id="spark-stats">{{ spark.stats }}</span>
          </div>
          <div class="chart">
            <svg
              class="spark"
              id="spark-line"
              viewBox="0 0 100 28"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <polygon v-if="spark.area" class="spark-area" :points="spark.area" />
              <polyline v-if="spark.line" class="spark-line" :points="spark.line" />
            </svg>
          </div>
        </div>

        <div class="panel-block">
          <div class="block-head">
            <span>启动命令</span>
            <span class="block-note"
              >工作目录 <span id="launch-cwd">{{ launchCwd }}</span></span
            >
          </div>
          <code id="launch-command" class="command">{{ launchCommand }}</code>
        </div>
      </section>
    </div>
  </div>
</template>
