<script setup>
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
import { computed, onMounted, ref } from 'vue'
import { renderMarkdown } from '../lib/markdown.js'

const api = window.dshConsole

const sessions = ref([])
const query = ref('')
const dshRunning = ref(false)
const home = ref('')
const loading = ref(false)
const error = ref('')

const selectedId = ref(null)
const conversation = ref(null)
const reading = ref(false)
const readError = ref('')

const busy = ref('') // 'restore' | 'remove'

/** 搜索：标题 / 首句 / 每轮问答摘要，不区分大小写 */
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return sessions.value
  return sessions.value.filter((s) => s.searchBlob.toLowerCase().includes(q))
})

const selected = computed(() => sessions.value.find((s) => s.id === selectedId.value) || null)

function say(message) {
  window.dispatchEvent(new CustomEvent('dsh:status-message', { detail: message }))
}

function pad(n) {
  return String(n).padStart(2, '0')
}

/** 索引里的时间：今年省掉年份，给标题让地方 */
function fmtListTime(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.getFullYear() === new Date().getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}-${md}`
}

/** 详情里的时间：完整日期时间 */
function fmtFullTime(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtSize(bytes) {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 角色栏文字：只在角色切换时给一次。同角色的连续消息（一次回答被工具调用
 * 拆成多个 step）不再重复写「助手」，靠留白连成一段。
 */
function roleLabel(index) {
  const list = conversation.value?.messages || []
  const message = list[index]
  if (!message) return ''
  if (index > 0 && list[index - 1].role === message.role) return ''
  return message.role === 'user' ? '你' : '助手'
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const result = await api.archiveList()
    if (!result.ok) {
      error.value = result.error || '读取归档会话失败'
      return
    }
    home.value = result.home || ''
    dshRunning.value = Boolean(result.dshRunning)
    sessions.value = result.sessions || []
    // 当前选中的会话被删掉后，自动清空选中
    if (selectedId.value && !sessions.value.some((s) => s.id === selectedId.value)) {
      selectedId.value = null
      conversation.value = null
    }
  } finally {
    loading.value = false
  }
}

function select(session) {
  if (selectedId.value === session.id) return
  selectedId.value = session.id
  void readConversation(session.id)
}

async function readConversation(id) {
  reading.value = true
  readError.value = ''
  conversation.value = null
  try {
    const result = await api.archiveRead(id)
    if (!result.ok) {
      readError.value = result.error || '读取对话失败'
      return
    }
    conversation.value = result.session || null
  } finally {
    reading.value = false
  }
}

async function restore() {
  const s = selected.value
  if (!s || busy.value) return
  const ok = await api.confirm({
    type: 'question',
    title: '取消归档',
    message: `把「${s.title}」恢复到侧边栏？`,
    detail: '取消归档只把它从归档列表移回侧边栏，会话与日志原样保留。正在运行的 dsh 需要重启后侧边栏才会出现它。'
  })
  if (!ok) return
  busy.value = 'restore'
  try {
    const result = await api.archiveUnarchive(s.id)
    if (!result.ok) {
      say(`恢复失败：${result.error}`)
      return
    }
    await load()
    say(result.dshRunning ? '已恢复。dsh 正在运行，重启 dsh 后侧边栏会出现该会话。' : '已恢复到侧边栏。')
  } finally {
    busy.value = ''
  }
}

async function remove() {
  const s = selected.value
  if (!s || busy.value) return
  const ok = await api.confirm({
    type: 'warning',
    title: '删除归档会话',
    message: `确定要删除「${s.title}」吗？`,
    detail: '这会删除该会话的日志与投影缓存，并从工作区注册表里移除，无法撤销。附件不会被删除（可能被其它会话共享）。'
  })
  if (!ok) return
  busy.value = 'remove'
  try {
    const result = await api.archiveRemove(s.id)
    if (!result.ok) {
      say(`删除失败：${result.error}`)
      return
    }
    selectedId.value = null
    conversation.value = null
    await load()
    const size = result.removedLogBytes ? `，释放 ${fmtSize(result.removedLogBytes)}` : ''
    say(result.dshRunning ? `已删除${size}。dsh 正在运行，重启后注册表会同步。` : `已删除${size}。`)
  } finally {
    busy.value = ''
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="archive">
    <div class="bar">
      <button class="btn small primary" :disabled="loading" :aria-busy="loading ? 'true' : null" @click="load">
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
              <span class="archive-item-time">{{ fmtListTime(s.lastPromptAt || s.createdAt) }}</span>
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
            :aria-busy="busy === 'restore' ? 'true' : null"
            title="从归档列表移回侧边栏（不改动任何数据）"
            @click="restore"
          >
            <svg class="i"><use href="#i-restart" /></svg><span>恢复</span>
          </button>
          <button
            class="btn small danger"
            :disabled="!selected || busy === 'restore'"
            :aria-busy="busy === 'remove' ? 'true' : null"
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
            <div v-if="conversation.truncated" class="archive-thread-note">内容过长，已截断到最近的对话。</div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
