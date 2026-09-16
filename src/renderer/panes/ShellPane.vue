<script setup>
/**
 * 本地 Shell 页：另开 pwsh/powershell/cmd（macOS 上是 zsh/bash）会话用来手工排查，
 * 和 dsh 进程互不干扰。
 *
 * 迁移前的会话管理是纯命令式的：创建时 `document.createElement` 造面板与标签、
 * 自己 classList.toggle 切 active、删除时 `.remove()`。现在标签（chips）与终端面板
 * 都由模板按 `sessions` 渲染，切换/关闭只改数据 —— xterm 实例本身仍然是命令式的
 * （框架管不了它），在面板元素出现之后再挂上去。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  applyTerminalSurface,
  attachTerminal,
  fitAndSync,
  passAppShortcutsThrough,
  TERM_THEMES
} from '../lib/xterm.js'
import { currentTab, snapshot, startStore } from '../lib/store.js'
import { isMac } from '../lib/platform.js'

const api = window.dshConsole

/** @type {import('vue').Ref<Array<{id:string, label:string}>>} */
const sessions = ref([])
const activeId = ref(null)
const busy = ref(false)

/** id → 终端实例（响应式引用会包装实例，所以放普通 Map） */
const terminals = new Map()
/** id → 面板元素（模板 ref 收集） */
const paneEls = new Map()
const host = ref(null)
let observer = null
let offOutput = null
let offExit = null

const activeSession = computed(
  () => sessions.value.find((item) => item.id === activeId.value) || null
)
const emptyVisible = computed(() => sessions.value.length === 0)
/** 空状态里给的人话要跟平台一致：macOS 上默认 shell 是 zsh，没有 cmd */
const emptyHint = computed(() =>
  isMac.value
    ? '开一个 zsh / bash 会话用来手工排查，它和 dsh 进程互不干扰。'
    : '开一个 pwsh 或 cmd 会话用来手工排查，它和 dsh 进程互不干扰。'
)

function resolvedTheme() {
  return snapshot.value?.theme?.resolved === 'light' ? 'light' : 'dark'
}

function setPaneEl(id, el) {
  if (el) paneEls.set(id, el)
  else paneEls.delete(id)
}

/**
 * 会话还没挂上终端时先攒着输出。
 * 时序：createShell 返回 → nextTick → 建终端，这中间 PTY 可能已经吐了提示符；
 * 没有这个缓冲，最先那一屏（往往就是提示符）会丢。
 */
const pendingOutput = new Map()

function writeToSession(id, chunk) {
  const entry = terminals.get(id)
  if (entry) {
    entry.term.write(chunk)
    return
  }
  pendingOutput.set(id, (pendingOutput.get(id) || '') + chunk)
}

function flushPending(id) {
  const buffered = pendingOutput.get(id)
  if (!buffered) return
  pendingOutput.delete(id)
  terminals.get(id)?.term.write(buffered)
}

function syncFit(id) {
  const entry = terminals.get(id)
  if (!entry) return
  fitAndSync(entry, (cols, rows) => api.sessionResize(id, cols, rows))
}

function activate(id) {
  activeId.value = id
  requestAnimationFrame(() => {
    syncFit(id)
    terminals.get(id)?.term.focus()
  })
}

/**
 * 把一个会话挂上终端。新建与"界面重载后接回"共用这一条路径。
 *
 * @param {{id:string,label:string,command?:string,cols?:number,rows?:number}} session
 */
async function attachSession(session) {
  await nextTick()
  const el = paneEls.get(session.id)
  if (!el) return
  const entry = attachTerminal(el, resolvedTheme())
  // 按存下的行列建终端：尺寸一致时第一次 fit 就是空操作，不会白白触发一次 PTY resize
  if (session.cols > 0 && session.rows > 0) entry.term.resize(session.cols, session.rows)
  // Ctrl+1~6 / ⌘1~6 交给应用；Ctrl+R 留给 shell —— 那是它的反向历史搜索
  passAppShortcutsThrough(entry.term)
  entry.term.onData((data) => api.sessionInput(session.id, data))
  entry.term.onResize(({ cols, rows }) => api.sessionResize(session.id, cols, rows))
  entry.term.writeln(`\u001b[90m[${session.label}] ${session.command || ''}\u001b[0m`)
  terminals.set(session.id, entry)
  flushPending(session.id)
}

async function createSession() {
  if (busy.value) return
  busy.value = true
  try {
    // 新会话的尺寸参考已有终端；都没有就用一个常见默认值
    const anyTerm = [...terminals.values()][0]?.term
    const result = await api.createShell(anyTerm?.cols || 110, anyTerm?.rows || 30)
    if (!result?.ok) {
      alert(`创建本地 Shell 失败：${result?.error || '未知错误'}`)
      return
    }
    // 标题由主进程给（它得跟着会话一起被持久化）
    const session = {
      id: result.id,
      label: result.label || `Shell ${result.id.replace('shell-', '')}`,
      command: result.command
    }
    sessions.value.push(session)
    await attachSession(session)
    activate(session.id)
  } finally {
    busy.value = false
  }
}

/**
 * 挂载时接回**还活着的**会话。
 *
 * 只处理一种情况：界面重载（开发时构建 / Ctrl+R）—— 那时 PTY 还活着，
 * 按快照里的 id 直接接上，终端从空白开始、新输出照常显示。
 *
 * 应用重启不在此列：本地 Shell **不做任何持久化**（用户的决定），
 * 每次启动都是全新的一页，个数、目录、标题、终端内容都不保留。
 */
async function restoreSessions() {
  await startStore()
  const listed = (snapshot.value?.sessions || []).filter((item) => item.meta?.kind === 'shell')
  if (listed.length === 0) return
  for (const item of listed) {
    sessions.value.push({
      id: item.id,
      label: item.meta?.label || `Shell ${String(item.id).replace('shell-', '')}`,
      command: item.meta?.command || '',
      // 尺寸带上：终端按同样的行列建立，第一次 fit 就不会白白触发一次 PTY resize
      cols: Number(item.meta?.cols) || 0,
      rows: Number(item.meta?.rows) || 0
    })
  }
  for (const session of sessions.value) await attachSession(session)
  activate(sessions.value[sessions.value.length - 1].id)
}

// ------------------------------------------------------------ 重命名

const editingId = ref(null)
const renameDraft = ref('')
/**
 * 重命名输入框的元素。用**函数式 ref**收集，不能在模板里给 ref 变量本身赋值：
 * `:ref="(el) => (renameInput = el)"` 会编译成给 const 赋值，运行时抛
 * "Assignment to constant variable"，补丁中断、输入框根本出不来（踩过）。
 */
const renameInput = ref(null)

function setRenameInput(el) {
  renameInput.value = el
}

/** 点已选中的标签就是改名（和文件管理器一致），双击任意标签也可以 */
function onChipClick(item) {
  if (item.id === activeId.value) startRename(item)
  else activate(item.id)
}

async function startRename(item) {
  editingId.value = item.id
  renameDraft.value = item.label
  await nextTick()
  renameInput.value?.focus()
  renameInput.value?.select()
}

function cancelRename() {
  editingId.value = null
}

async function commitRename() {
  const id = editingId.value
  if (!id) return
  const label = renameDraft.value.trim()
  editingId.value = null
  const item = sessions.value.find((session) => session.id === id)
  if (!item || !label || label === item.label) return
  const previous = item.label
  item.label = label
  // 同样用可选调用兜住版本错配（见 attachSession 里的说明）
  const result = await api.sessionRename?.(id, label)
  if (result && !result.ok) {
    item.label = previous
    window.dispatchEvent(
      new CustomEvent('dsh:status-message', {
        detail: `重命名失败：${result?.error || '未知错误'}`
      })
    )
  }
}

function killActive() {
  const id = activeId.value
  if (!id) return
  // 「关闭当前」是彻底的：主进程会同时把它从持久化文件里删掉，下次启动不再重开
  api.sessionKill(id)
  terminals.get(id)?.term.dispose()
  terminals.delete(id)
  paneEls.delete(id)
  sessions.value = sessions.value.filter((item) => item.id !== id)
  const next = sessions.value[sessions.value.length - 1]?.id || null
  if (next) activate(next)
  else activeId.value = null
}

// 切到本页时补一次 fit：容器刚变可见，尺寸才是最终的
watch(currentTab, (tab) => {
  if (tab !== 'shell' || !activeId.value) return
  requestAnimationFrame(() => syncFit(activeId.value))
})

// 主题变化：xterm 配色是 JS 选项；面板底色（内边距、空状态）也一起跟上
watch(
  () => snapshot.value?.theme?.resolved,
  () => {
    applyTerminalSurface(host.value, resolvedTheme())
    const theme = { ...TERM_THEMES[resolvedTheme()] }
    for (const entry of terminals.values()) entry.term.options.theme = { ...theme }
  }
)

// 窗口/容器尺寸变化时重新 fit 所有会话。
// 这条在迁移时漏过一次：旧代码里是一个全局的 window resize 处理器负责它，
// 我只把终端页那边搬成了 ResizeObserver，Shell 页就再也不会跟着窗口变了。
// 容器是 .term-host（各会话面板都是它的绝对定位子元素），所以观察它就够。
onMounted(() => {
  // 订阅所有会话的输出与退出。
  // 这条在迁移时漏掉过：本地 Shell 因此**完全没有回显** —— 输入送到了 PTY，
  // 但 PTY 返回的提示符与回显没人接，界面上就"打字没反应"（踩过）。
  offOutput = api.onSessionOutput(({ id, chunk }) => writeToSession(id, chunk))
  offExit = api.onSessionExit(({ id, exitCode }) => {
    writeToSession(id, `\r\n\u001b[2m── Shell 已退出（退出码 ${exitCode}）──\u001b[0m\r\n`)
  })

  if (!host.value || typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver(() => {
    for (const id of terminals.keys()) syncFit(id)
  })
  observer.observe(host.value)
  void restoreSessions()
})

onUnmounted(() => {
  if (observer) observer.disconnect()
  if (offOutput) offOutput()
  if (offExit) offExit()
  for (const entry of terminals.values()) entry.term.dispose()
  terminals.clear()
  paneEls.clear()
  pendingOutput.clear()
})
</script>

<template>
  <div class="bar">
    <button id="btn-new-shell" class="btn small primary" :disabled="busy" @click="createSession">
      <svg class="i"><use href="#i-plus" /></svg><span>新建本地 Shell</span>
    </button>
    <div id="shell-tabs" class="chips">
      <!-- v-if 与 v-for 不能写在同一个元素上（Vue 3 里 v-if 先求值，item 还不存在），
           所以用 template 包一层；重命名输入框的 ref 也不能用字符串写法 ——
           v-for 里的模板 ref 会收集成数组，这里用函数式 ref 取当前那个。 -->
      <template v-for="item in sessions" :key="item.id">
        <button
          v-if="editingId !== item.id"
          class="shell-tab"
          :class="{ active: item.id === activeId }"
          :title="`${item.label}（点选中的标签、或双击，可改名）`"
          @click="onChipClick(item)"
          @dblclick="startRename(item)"
        >
          {{ item.label }}
        </button>
        <input
          v-else
          :ref="setRenameInput"
          v-model="renameDraft"
          class="shell-tab shell-tab-editing"
          spellcheck="false"
          maxlength="40"
          @keydown.enter.prevent="commitRename"
          @keydown.esc.prevent="cancelRename"
          @blur="commitRename"
        />
      </template>
    </div>
    <div class="spacer"></div>
    <button
      id="btn-shell-kill"
      class="btn small danger"
      :disabled="!activeSession"
      @click="killActive"
    >
      <svg class="i"><use href="#i-x" /></svg><span>关闭当前</span>
    </button>
  </div>

  <div class="term-host" ref="host">
    <div
      v-for="item in sessions"
      :key="item.id"
      class="shell-pane"
      :class="{ active: item.id === activeId }"
      :data-shell-id="item.id"
    >
      <!-- xterm 挂在这一层：它里面没有 Vue 管理的子节点，两边不抢 DOM -->
      <div class="term-mount" :ref="(el) => setPaneEl(item.id, el)"></div>
    </div>
    <div id="shell-empty" class="empty" :class="{ hidden: !emptyVisible }">
      <svg class="i empty-i"><use href="#i-shell" /></svg>
      <h2>还没有本地 Shell</h2>
      <p>{{ emptyHint }}</p>
    </div>
  </div>
</template>
