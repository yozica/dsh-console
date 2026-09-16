<script setup lang="ts">
/**
 * DeepSeek 用量页：一个浏览器视图，加载设置里的地址（默认开放平台用量页），
 * 用独立分区 `persist:deepseek` 保存登录态。本应用不读取页面内容。
 *
 * 迁移前，这一页的每个提示都是 app.js 里的 `setText('usage-note', …)` /
 * `document.getElementById('usage-empty').classList.add('hidden')`；现在是模板 + ref。
 *
 * `<webview>` 的事件只能命令式挂（Vue 不代理自定义元素的事件），
 * 那部分留在 onMounted 里，用 onUnmounted 配平 —— 这正是用组件表达生命周期的好处。
 */
import { onMounted, ref, watch } from 'vue'
import { currentTab, settings } from '../lib/store.js'

const api = window.dshConsole

const USAGE_FALLBACK_URL = 'https://platform.deepseek.com/usage'

const view = ref(null)
const note = ref('还没有打开')
const hintTitle = ref('还没打开用量页')
/** 仅出错时替换为空状态正文；正常时用模板里的默认说明 */
const hintBody = ref('')
const hintVisible = ref(true)

let viewReady = false
let loadedUrl = ''

function targetUrl() {
  const raw = String(settings.value.deepseekUrl || '').trim()
  return /^https?:\/\//i.test(raw) ? raw : USAGE_FALLBACK_URL
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function showEmpty(title, bodyHtml) {
  hintTitle.value = title
  if (bodyHtml !== undefined) hintBody.value = bodyHtml
  hintVisible.value = true
}

/** 打开配置里的地址。「重新载入」按钮和切到本页时都走它。 */
function open() {
  const el = view.value
  if (!el) return
  const url = targetUrl()
  loadedUrl = url
  hintVisible.value = false
  note.value = `载入中：${url}`
  if (viewReady) {
    // 用 loadURL 并吞掉 promise：切换地址时上一笔导航会被中止而抛 ERR_ABORTED
    try {
      const pending = el.loadURL(url)
      if (pending && typeof pending.catch === 'function') pending.catch(() => {})
      return
    } catch {
      /* 落到 src 赋值 */
    }
  }
  el.src = url
}

function reload() {
  view.value?.reload()
}

function goBack() {
  const el = view.value
  if (el?.canGoBack()) el.goBack()
}

function openExternal() {
  void api.openExternal(loadedUrl || targetUrl())
}

/** 让 guest 重算视口：先压 1px 再放开（切换页面后仍按旧尺寸排版时靠这一下） */
function refreshViewport() {
  const el = view.value
  if (!el) return
  el.style.height = 'calc(100% - 1px)'
  void el.offsetHeight
  el.style.height = ''
}

onMounted(() => {
  const el = view.value
  if (!el) return

  el.addEventListener('dom-ready', () => {
    viewReady = true
  })
  el.addEventListener('did-start-loading', () => (note.value = '载入中…'))
  el.addEventListener('did-finish-load', () => {
    hintVisible.value = false
    note.value = `已载入 ${el.getURL()}`
  })
  el.addEventListener('did-fail-load', (event) => {
    if (event.errorCode === -3) return // 被新导航取代/主动取消，不算失败
    note.value = `载入失败 (${event.errorCode})`
    showEmpty(
      '用量页没能载入',
      `<p>错误码 <code>${event.errorCode}</code>：${escapeHtml(event.errorDescription)}</p>` +
        `<p>地址：<code>${escapeHtml(loadedUrl)}</code></p>` +
        '<p>先检查网络；也可以点右上角「在浏览器打开」。地址能在「设置 → DeepSeek 用量页」里改。</p>'
    )
  })

  // 切到本页：第一次进来才真正加载（等一帧，让刚变可见的页面先完成布局，
  // guest 才会拿到正确的视口尺寸）；之后只是重算视口
  watch(
    currentTab,
    (tab) => {
      if (tab !== 'usage') return
      if (!loadedUrl) {
        requestAnimationFrame(() => open())
      } else {
        refreshViewport()
      }
    },
    { immediate: true }
  )

  // 设置里改了地址：已经打开过就按新地址重新加载
  watch(
    () => settings.value.deepseekUrl,
    () => {
      if (loadedUrl) open()
    }
  )
})
</script>

<template>
  <div class="bar">
    <button
      id="btn-usage-open"
      class="btn small primary"
      title="重新加载配置里的地址"
      @click="open"
    >
      <svg class="i"><use href="#i-usage" /></svg><span>打开用量页</span>
    </button>
    <button id="btn-usage-reload" class="btn small ghost" @click="reload">
      <span>重新载入</span>
    </button>
    <button id="btn-usage-back" class="btn small ghost" @click="goBack">
      <svg class="i"><use href="#i-back" /></svg><span>后退</span>
    </button>
    <div class="spacer"></div>
    <button
      id="btn-usage-external"
      class="btn small ghost"
      title="在系统浏览器里打开（需要扫码或弹窗登录时用它）"
      @click="openExternal"
    >
      <svg class="i"><use href="#i-external" /></svg><span>在浏览器打开</span>
    </button>
    <span class="bar-note" id="usage-note">{{ note }}</span>
  </div>

  <div class="webview-wrap">
    <webview
      class="embedded-view"
      id="usage-view"
      ref="view"
      partition="persist:deepseek"
      allowpopups
    ></webview>
    <div id="usage-empty" class="empty empty-fill" :class="{ hidden: !hintVisible }">
      <svg class="i empty-i"><use href="#i-usage" /></svg>
      <h2 id="usage-hint-title">{{ hintTitle }}</h2>
      <!-- 内容是本组件用 escapeHtml 转义后拼出来的，不含外部输入的可执行标记 -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-if="hintBody" id="usage-hint-body" class="empty-body" v-html="hintBody"></div>
      <div v-else id="usage-hint-body" class="empty-body">
        <p>这一页用来查看 DeepSeek API 的 token 用量，加载的是开放平台的页面。</p>
        <p>
          第一次打开需要在那里登录一次。登录状态保存在本机这个应用自己的浏览器分区里，之后就是登录态；
          本应用不读取页面内容，也不会拿到你的账号数据。
        </p>
        <p>
          想换成别的页面（例如官网主页 <code>https://www.deepseek.com</code>），到「设置 → DeepSeek
          用量页」改地址即可。
        </p>
      </div>
    </div>
  </div>
</template>
