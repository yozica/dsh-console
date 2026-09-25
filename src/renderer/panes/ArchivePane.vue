<script setup lang="ts">
/**
 * 归档会话页：补上 DSH 官方缺的「查看 / 搜索 / 恢复 / 删除归档会话」。
 *
 * 数据全在主进程（session-archive.js）里直接读写 DSH 磁盘目录：
 * 归档 id 在 workspace.json，标题/首句在投影缓存，对话全文在 zstd 日志里。
 *
 * 版式：左边是「索引」，右边是「转录稿」——不是聊天气泡。
 * 理由：这一页的实质是翻阅一份历史日志，所以用左侧角色栏 + 单列阅读宽度
 * 呈现，用户发言用一条强调色竖线标出，助手内容作为连续正文流动
 * （一次回答跨多个 step 时会拆成多条 assistant/message，气泡会碎成一墙卡片）。
 */
import { computed, onMounted, ref } from 'vue';
import { renderMarkdown } from '../lib/markdown.js';
import type { ArchivedSessionSummary, ConversationReadResult } from '../../shared/ipc.js';

const api = window.dshConsole;

const sessions = ref<ArchivedSessionSummary[]>([]);
const query = ref('');
const dshRunning = ref(false);
const home = ref('');
const loading = ref(false);
const error = ref('');

const selectedId = ref<string | null>(null);
const conversation = ref<ConversationReadResult | null>(null);
const reading = ref(false);
const readError = ref('');

const busy = ref<'' | 'restore' | 'remove'>('');

/** 搜索：标题 / 首句 / 每轮问答摘要，不区分大小写 */
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return sessions.value;
  return sessions.value.filter((s) => s.searchBlob.toLowerCase().includes(q));
});

const selected = computed(() => sessions.value.find((s) => s.id === selectedId.value) || null);

function say(message: string): void {
  window.dispatchEvent(new CustomEvent('dsh:status-message', { detail: message }));
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 索引里的时间：今年省掉年份，给标题让地方 */
function fmtListTime(ms: number | null | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}-${md}`;
}

/** 详情里的时间：完整日期时间 */
function fmtFullTime(ms: number | null | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtSize(bytes: number | null | undefined): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 角色栏文字：只在角色切换时给一次。同角色的连续消息（一次回答被工具调用
 * 拆成多个 step）不再重复写「助手」，靠留白连成一段。
 */
function roleLabel(index: number): string {
  const list = conversation.value?.messages || [];
  const message = list[index];
  if (!message) return '';
  if (index > 0 && list[index - 1]?.role === message.role) return '';
  return message.role === 'user' ? '你' : '助手';
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await api.archiveList();
    if (!result.ok) {
      error.value = result.error || '读取归档会话失败';
      return;
    }
    home.value = result.home || '';
    dshRunning.value = Boolean(result.dshRunning);
    sessions.value = result.sessions || [];
    // 当前选中的会话被删掉后，自动清空选中
    if (selectedId.value && !sessions.value.some((s) => s.id === selectedId.value)) {
      selectedId.value = null;
      conversation.value = null;
    }
  } finally {
    loading.value = false;
  }
}

function select(session: ArchivedSessionSummary): void {
  if (selectedId.value === session.id) return;
  selectedId.value = session.id;
  void readConversation(session.id);
}

async function readConversation(id: string): Promise<void> {
  reading.value = true;
  readError.value = '';
  conversation.value = null;
  try {
    const result = await api.archiveRead(id);
    if (!result.ok) {
      readError.value = result.error || '读取对话失败';
      return;
    }
    conversation.value = result.session || null;
  } finally {
    reading.value = false;
  }
}

async function restore(): Promise<void> {
  const s = selected.value;
  if (!s || busy.value) return;
  const ok = await api.confirm({
    type: 'question',
    title: '取消归档',
    message: `把「${s.title}」恢复到侧边栏？`,
    detail:
      '取消归档只把它从归档列表移回侧边栏，会话与日志原样保留。正在运行的 dsh 需要重启后侧边栏才会出现它。',
  });
  if (!ok) return;
  busy.value = 'restore';
  try {
    const result = await api.archiveUnarchive(s.id);
    if (!result.ok) {
      say(`恢复失败：${result.error}`);
      return;
    }
    await load();
    say(
      result.dshRunning
        ? '已恢复。dsh 正在运行，重启 dsh 后侧边栏会出现该会话。'
        : '已恢复到侧边栏。',
    );
  } finally {
    busy.value = '';
  }
}

async function remove(): Promise<void> {
  const s = selected.value;
  if (!s || busy.value) return;
  const ok = await api.confirm({
    type: 'warning',
    title: '删除归档会话',
    message: `确定要删除「${s.title}」吗？`,
    detail:
      '这会删除该会话的日志与投影缓存，并从工作区注册表里移除，无法撤销。附件不会被删除（可能被其它会话共享）。',
  });
  if (!ok) return;
  busy.value = 'remove';
  try {
    const result = await api.archiveRemove(s.id);
    if (!result.ok) {
      say(`删除失败：${result.error}`);
      return;
    }
    selectedId.value = null;
    conversation.value = null;
    await load();
    const size = result.removedLogBytes ? `，释放 ${fmtSize(result.removedLogBytes)}` : '';
    say(
      result.dshRunning ? `已删除${size}。dsh 正在运行，重启后注册表会同步。` : `已删除${size}。`,
    );
  } finally {
    busy.value = '';
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="archive">
    <div class="bar">
      <button
        class="btn small primary"
        :disabled="loading"
        :aria-busy="loading ? 'true' : undefined"
        @click="load"
      >
        <svg class="i"><use href="#i-replay" /></svg><span>刷新</span>
      </button>
      <div class="spacer"></div>
      <span v-if="error" class="bar-note">{{ error }}</span>
      <template v-else>
        <span class="bar-note">{{ sessions.length }} 个归档会话</span>
        <span class="bar-hint">{{ home }}</span>
      </template>
    </div>

    <div class="archive-body">
      <!-- ============================ 索引 ============================ -->
      <aside class="panel archive-side">
        <header class="panel-head">
          <h3>归档会话</h3>
          <span class="archive-count">{{ filtered.length }}</span>
          <div class="spacer"></div>
        </header>

        <div class="archive-search">
          <svg class="i"><use href="#i-search" /></svg>
          <input
            v-model="query"
            class="archive-search-input"
            type="text"
            spellcheck="false"
            placeholder="搜索标题或对话内容…"
          />
        </div>

        <ul v-if="filtered.length" class="archive-list">
          <li
            v-for="s in filtered"
            :key="s.id"
            class="archive-item"
            :class="{ active: selectedId === s.id }"
            @click="select(s)"
          >
            <div class="archive-item-head">
              <span class="archive-item-title">{{ s.title }}</span>
              <span class="archive-item-time">{{
                fmtListTime(s.lastPromptAt || s.createdAt)
              }}</span>
            </div>
            <div class="archive-item-meta">{{ s.firstPrompt || '（无首句）' }}</div>
            <div class="archive-item-sub">
              <span>{{ s.turnCount }} 轮</span>
              <span v-if="s.logSize != null">{{ fmtSize(s.logSize) }}</span>
            </div>
          </li>
        </ul>

        <div v-else class="archive-empty">
          <svg class="i empty-i"><use href="#i-archive" /></svg>
          <h2>{{ sessions.length ? '没有匹配的会话' : '没有归档的会话' }}</h2>
          <p v-if="sessions.length">换个关键词试试。</p>
          <p v-else>在 DeepSeek Harness 里归档过的会话会出现在这里。</p>
        </div>
      </aside>

      <!-- ============================ 转录稿 ============================ -->
      <section class="panel archive-detail">
        <header class="panel-head">
          <h3 class="archive-detail-title">{{ selected ? selected.title : '选择左侧会话' }}</h3>
          <div class="spacer"></div>
          <button
            class="btn small"
            :disabled="!selected || busy === 'remove'"
            :aria-busy="busy === 'restore' ? 'true' : undefined"
            title="从归档列表移回侧边栏（不改动任何数据）"
            @click="restore"
          >
            <svg class="i"><use href="#i-restart" /></svg><span>恢复</span>
          </button>
          <button
            class="btn small danger"
            :disabled="!selected || busy === 'restore'"
            :aria-busy="busy === 'remove' ? 'true' : undefined"
            title="删除该会话的日志与缓存，不可撤销"
            @click="remove"
          >
            <svg class="i"><use href="#i-trash" /></svg><span>删除</span>
          </button>
        </header>

        <div v-if="selected" class="archive-meta">
          <span>{{ fmtFullTime(selected.lastPromptAt || selected.createdAt) }}</span>
          <span>{{ selected.turnCount }} 轮</span>
          <span v-if="selected.logSize != null">{{ fmtSize(selected.logSize) }}</span>
          <div class="spacer"></div>
          <span class="archive-meta-id" :title="selected.id">{{ selected.id }}</span>
        </div>

        <div class="archive-detail-body">
          <div v-if="!selected" class="archive-empty">
            <svg class="i empty-i"><use href="#i-archive" /></svg>
            <h2>没有选中会话</h2>
            <p>点左侧索引里的会话，在这里读它的对话全文。</p>
          </div>

          <div v-else-if="reading" class="archive-empty">
            <h2>正在读取…</h2>
          </div>

          <div v-else-if="readError" class="archive-empty">
            <svg class="i empty-i"><use href="#i-warn" /></svg>
            <h2>读取失败</h2>
            <p>{{ readError }}</p>
          </div>

          <div v-else-if="conversation && !conversation.hasLog" class="archive-empty">
            <svg class="i empty-i"><use href="#i-warn" /></svg>
            <h2>没有可读取的日志</h2>
            <p>这个会话在磁盘上没有日志文件（可能从未落盘，或已被移除）。</p>
          </div>

          <div v-else-if="conversation && !conversation.messages.length" class="archive-empty">
            <svg class="i empty-i"><use href="#i-archive" /></svg>
            <h2>对话内容为空</h2>
            <p>日志里没有可展示的用户提问与助手回复。</p>
          </div>

          <div v-else-if="conversation" class="archive-thread">
            <article
              v-for="(m, index) in conversation.messages"
              :key="index"
              class="archive-turn"
              :class="m.role === 'user' ? 'archive-turn-user' : 'archive-turn-assistant'"
            >
              <div v-if="roleLabel(index)" class="archive-turn-role">{{ roleLabel(index) }}</div>
              <!-- renderMarkdown 先整段转义 HTML 再生成标签，输出里只剩它自己造的安全标签 -->
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div class="archive-turn-body" v-html="renderMarkdown(m.text)"></div>
            </article>
            <div v-if="conversation.truncated" class="archive-thread-note">
              内容过长，已截断到最近的对话。
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* 归档会话页自己的样式（t48 样式分层）：原来在 styles.css 的「归档会话页」一节。
   注意 `.archive-turn-body` 里那些 `h1 / p / code / table …` 是 **v-html 渲染出来的**
   （见模板里的 renderMarkdown），它们没有本组件的 scope 属性，所以那些规则必须写成
   `:deep(...)`，否则编译成 `.archive-turn-body h1[data-v-*]` 之后一条都匹配不上。 */

/* ============================================================ 归档会话页 */

.archive {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
}

.archive-body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  gap: 14px;
  padding: 2px 20px 20px;
}

.archive-side {
  width: 320px;
  flex: 0 0 320px;
}

.archive-detail {
  flex: 1 1 auto;
  min-width: 0;
}

.archive-detail-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 标题下的一条「档案记录」：时间 / 轮数 / 体积 / 会话 id。
   它们都是机器数据，走等宽字体（与应用里 IBM Plex Mono 的定位一致）；
   阅读区的表头由标题 + 这条记录组成，下面那条发丝线由它收尾。 */
.archive-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 18px 10px;
  flex: 0 0 auto;
  border-bottom: 1px solid var(--hairline);
  color: var(--ink-faint);
  font-family: var(--mono);
  font-size: var(--t-xs);
  font-variant-numeric: tabular-nums;
}

.archive-meta-id {
  overflow: hidden;
  max-width: 42%;
  opacity: 0.75;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.archive-count {
  min-width: 20px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--t-xs);
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.archive-search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  margin: 0 12px 10px;
  padding: 0 10px;
  flex: 0 0 auto;
  background: var(--well);
  border: 1px solid var(--hairline);
  border-radius: var(--r-control);
}

.archive-search .i {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  opacity: 0.6;
}

.archive-search-input {
  flex: 1 1 auto;
  min-width: 0;
  background: transparent;
  border: 0;
  outline: 0;
  color: var(--ink);
  font: inherit;
  font-size: var(--t-sm);
}

.archive-search-input::placeholder {
  color: var(--ink-faint);
}

.archive-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 0 8px 8px;
  list-style: none;
}

.archive-item {
  position: relative;
  padding: 9px 12px 9px 13px;
  border-radius: 0 var(--r-control) var(--r-control) 0;
  cursor: pointer;
}

/* 选中态只给一条强调色竖线 + 极浅底色：比整块填充安静，也标出了"正在读哪一条"。
   竖线用伪元素而不是 border，这样它不会因为 hover/active 切换而让文字左右抖动。 */
.archive-item::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 999px;
  background: transparent;
}

.archive-item:hover {
  background: var(--surface-2);
}

.archive-item.active {
  background: var(--accent-soft);
}

.archive-item.active::before {
  background: var(--accent);
}

.archive-item-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.archive-item-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--ink);
  font-size: var(--t-sm);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.archive-item-time {
  flex: 0 0 auto;
  color: var(--ink-faint);
  font-family: var(--mono);
  font-size: var(--t-xs);
  font-variant-numeric: tabular-nums;
}

.archive-item-meta {
  margin-top: 2px;
  overflow: hidden;
  color: var(--ink-dim);
  font-size: var(--t-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.archive-item-sub {
  display: flex;
  gap: 10px;
  margin-top: 4px;
  color: var(--ink-faint);
  font-family: var(--mono);
  font-size: var(--t-xs);
  font-variant-numeric: tabular-nums;
}

.archive-detail-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

/* 转录稿，不是气泡墙：左侧固定角色栏 + 右侧正文，整列限宽 860px 保证可读行长。
   理由见 ArchivePane.vue 顶部注释 —— 一次回答会跨多个 step 拆成多条
   assistant/message，用气泡会把一段连续的回答碎成一墙卡片。 */
.archive-thread {
  max-width: 820px;
  padding: 6px 0 28px;
}

/* 转录稿的一轮：不做气泡，也不预留空的角色栏。
   角色名只在角色切换时出现一次、贴在内容上方，正文因此拿到整幅宽度
   —— 详情面板常常只有 600 来 px，固定 66px 的空栏会白白吃掉一成多宽度。 */
.archive-turn {
  padding: 12px 20px;
}

.archive-turn-role {
  margin-bottom: 5px;
  color: var(--ink-faint);
  font-size: var(--t-xs);
  font-weight: 600;
}

/* 用户发言：整条浅底 + 一条强调色竖线，像日志里被标出的"输入"那几行 */
.archive-turn-user {
  padding-left: 17px;
  background: var(--accent-soft);
  border-left: 3px solid var(--accent);
  border-radius: 0 var(--r-control) var(--r-control) 0;
}

.archive-turn-user .archive-turn-role {
  color: var(--accent);
}

/* 同角色的连续消息靠留白连成一段（角色名不重复写）；角色切换时才加一道分隔 */
.archive-turn-assistant + .archive-turn-assistant {
  padding-top: 2px;
}

.archive-turn-user + .archive-turn-assistant,
.archive-turn-assistant + .archive-turn-user {
  border-top: 1px solid var(--hairline);
}

.archive-thread-note {
  padding: 6px 20px 0;
  color: var(--ink-faint);
  font-size: var(--t-xs);
}

/* 正文里的 Markdown 渲染结果（元素由 lib/markdown.js 生成，只出安全标签） */
.archive-turn-body {
  min-width: 0;
  color: var(--ink);
  font-size: var(--t-md);
  line-height: 1.72;
  word-break: break-word;
}

.archive-turn-body :deep(> :first-child) {
  margin-top: 0;
}

.archive-turn-body :deep(> :last-child) {
  margin-bottom: 0;
}

.archive-turn-body :deep(h1),
.archive-turn-body :deep(h2),
.archive-turn-body :deep(h3),
.archive-turn-body :deep(h4),
.archive-turn-body :deep(h5),
.archive-turn-body :deep(h6) {
  margin: 1.1em 0 0.4em;
  font-weight: 600;
  line-height: 1.4;
}

.archive-turn-body :deep(h1) {
  font-size: var(--t-lg);
}

.archive-turn-body :deep(h2),
.archive-turn-body :deep(h3),
.archive-turn-body :deep(h4),
.archive-turn-body :deep(h5),
.archive-turn-body :deep(h6) {
  font-size: var(--t-md);
}

.archive-turn-body :deep(p) {
  margin: 0.5em 0;
}

.archive-turn-body :deep(ul),
.archive-turn-body :deep(ol) {
  margin: 0.5em 0;
  padding-left: 22px;
}

.archive-turn-body :deep(li) {
  margin: 0.18em 0;
}

.archive-turn-body :deep(li::marker) {
  color: var(--ink-faint);
}

.archive-turn-body :deep(code) {
  padding: 1px 5px;
  background: var(--well);
  border: 1px solid var(--hairline);
  border-radius: 5px;
  color: var(--code-ink);
  font-family: var(--mono);
  font-size: 0.92em;
}

.archive-turn-body :deep(pre) {
  margin: 0.7em 0;
  padding: 11px 13px;
  overflow-x: auto;
  background: var(--well);
  border: 1px solid var(--hairline);
  border-radius: var(--r-control);
}

.archive-turn-body :deep(pre code) {
  padding: 0;
  background: transparent;
  border: 0;
  color: var(--ink);
  font-family: var(--mono);
  font-size: var(--t-xs);
  line-height: 1.65;
}

.archive-turn-body :deep(blockquote) {
  margin: 0.7em 0;
  padding: 2px 13px;
  border-left: 3px solid var(--hairline-strong);
  color: var(--ink-dim);
}

.archive-turn-body :deep(blockquote p) {
  margin: 0.25em 0;
}

.archive-turn-body :deep(hr) {
  margin: 0.9em 0;
  border: 0;
  border-top: 1px solid var(--hairline);
}

.archive-turn-body :deep(a) {
  color: var(--accent);
  text-decoration: none;
}

.archive-turn-body :deep(a:hover) {
  text-decoration: underline;
}

.archive-turn-body :deep(strong) {
  font-weight: 600;
}

.archive-turn-body :deep(del) {
  color: var(--ink-faint);
}

.archive-turn-body :deep(table) {
  margin: 0.7em 0;
  border-collapse: collapse;
  font-size: var(--t-xs);
}

.archive-turn-body :deep(th),
.archive-turn-body :deep(td) {
  padding: 5px 10px;
  border: 1px solid var(--hairline-strong);
  text-align: left;
  vertical-align: top;
}

.archive-turn-body :deep(th) {
  background: var(--well);
  font-weight: 600;
}

.archive-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 100%;
  min-height: 120px;
  padding: 30px;
  color: var(--ink-faint);
  text-align: center;
}

.archive-empty h2 {
  font-size: var(--t-lg);
  font-weight: 600;
  color: var(--ink-dim);
}

.archive-empty p {
  max-width: 460px;
  font-size: var(--t-sm);
  line-height: 1.8;
}

.archive-empty code {
  padding: 1px 6px;
  background: var(--well);
  border: 1px solid var(--hairline);
  border-radius: 5px;
  color: var(--code-ink);
  font-family: var(--mono);
}
</style>
