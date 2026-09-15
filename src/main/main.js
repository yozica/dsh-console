'use strict'

/**
 * Electron 主进程：窗口、IPC、生命周期。
 */

const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, Menu, ipcMain, shell, dialog, nativeImage, nativeTheme, session } = require('electron')

const { Settings } = require('./settings')
const { PtySessions } = require('./pty-sessions')
const { DshManager } = require('./dsh-manager')
const { installFileLogging } = require('./logger')
const processUtils = require('./process-utils')

const isDev = process.argv.includes('--dev')
const isMac = process.platform === 'darwin'

// 允许把配置/缓存目录挪到别处（便携部署，或本机验证时不污染 %APPDATA%）
const userDataOverride = process.env.DSH_CONSOLE_USER_DATA
if (userDataOverride) {
  try {
    app.setPath('userData', path.resolve(userDataOverride))
  } catch (error) {
    console.error('[main] 无法设置 userData 目录:', error.message)
  }
}

// 主进程日志同时落盘：<userData>/logs/console.log
const fileLog = installFileLogging(path.join(app.getPath('userData'), 'logs'))

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null
/** @type {Settings} */
let settings
/** @type {PtySessions} */
let ptySessions
/** @type {DshManager} */
let dshManager

let shellCounter = 0
/** 应用自己开的终端会话 id（除 dsh 之外） */
const extraSessions = new Set()
/** 渲染层是否已经连上（用于日志确认页面没被 CSP 之类的东西拦死） */
let rendererConnected = false

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

// ---------------------------------------------------------------- 主题

const THEME_MODES = ['system', 'light', 'dark']
/**
 * 窗口底色与标题栏配色：与渲染层 CSS 的 --bg / --ink 保持一致。
 * （这是主进程侧唯一的颜色重复处 —— 窗口底色和系统控件浮层只能由主进程设置。）
 */
const WINDOW_BG = { dark: '#0a0c10', light: '#eef1f5' }
const TITLEBAR_COLORS = {
  dark: { color: '#0a0c10', symbolColor: '#e8eaf0' },
  light: { color: '#eef1f5', symbolColor: '#131a26' }
}
/** 标题栏高度：和渲染层的 --bar-h 对齐，否则系统控件会和顶栏错位 */
const TITLEBAR_HEIGHT = 36

/** 渲染层产物目录：Vite 构建输出（npm start 会先构建），主进程从这里加载页面 */
const RENDERER_DIST = path.join(__dirname, '..', '..', 'dist', 'renderer')

/** 当前主题：mode 是用户选择，resolved 是实际生效的明暗 */
function themeInfo() {
  const mode = String((settings && settings.get('themeMode')) || 'system')
  return {
    mode: THEME_MODES.includes(mode) ? mode : 'system',
    resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  }
}

/** 把设置里的 mode 应用到 Electron（system 时交给系统决定） */
function applyThemeSource(mode) {
  const next = THEME_MODES.includes(String(mode)) ? String(mode) : 'system'
  if (nativeTheme.themeSource !== next) nativeTheme.themeSource = next
  return next
}

/**
 * 系统控件浮层的配色（最小化/最大化/关闭由 Windows 画在右上角，颜色得由我们给）。
 * 窗口不是用 titleBarOverlay 建的、或平台不支持时（macOS 用红绿灯，没有浮层），
 * 这里会抛异常，直接吞掉即可。
 */
function applyTitleBarOverlay(resolved) {
  if (isMac) return // macOS 的红绿灯由系统绘制在左上角，没有 titleBarOverlay
  if (!mainWindow || mainWindow.isDestroyed()) return
  const colors = TITLEBAR_COLORS[resolved] || TITLEBAR_COLORS.dark
  try {
    mainWindow.setTitleBarOverlay({ ...colors, height: TITLEBAR_HEIGHT })
  } catch {
    /* 没有启用 titleBarOverlay 时忽略 */
  }
}

function broadcastTheme() {
  const info = themeInfo()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(WINDOW_BG[info.resolved])
    applyTitleBarOverlay(info.resolved)
  }
  sendToRenderer('theme:changed', info)
  return info
}

// ---------------------------------------------------------------- 内嵌页诊断

/** Electron 新旧版本的 console-message 参数形状不同，这里统一取出来 */
function readConsoleMessage(args) {
  const details = args[0]
  if (details && typeof details === 'object' && 'message' in details) {
    return {
      level: String(details.level ?? 'info'),
      message: String(details.message ?? ''),
      source: String(details.sourceId ?? ''),
      line: Number(details.lineNumber ?? 0)
    }
  }
  return {
    level: ['debug', 'info', 'warning', 'error'][Number(args[1])] || 'info',
    message: String(args[2] ?? ''),
    source: String(args[4] ?? ''),
    line: Number(args[3] ?? 0)
  }
}

/** 抹掉 UA 里的 Electron 与包名 —— 不少第三方站点据此判定"不是正经浏览器" */
function cleanedUserAgent(ua) {
  return String(ua)
    .replace(/\s*(dsh-console|Electron)\/[\d.]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const EMBEDDED_LABELS = {
  'persist:dsh-ui': '内嵌 DSH 界面',
  'persist:deepseek': 'DeepSeek 用量页'
}

function embeddedLabel(partition) {
  return EMBEDDED_LABELS[partition] || '内嵌页'
}

/**
 * Electron 自身的开发期安全提示（allowpopups / CSP 那几条）内容很长，会把事件日志刷屏，
 * 而且打包后就不会再出现。所以不进日志，只在终端里提一次。
 */
const seenDevWarnings = new Set()
function suppressElectronDevNoise(message) {
  if (!/Electron Security Warning/i.test(message)) return false
  const key = String(message).slice(0, 60)
  if (!seenDevWarnings.has(key)) {
    seenDevWarnings.add(key)
    console.log('[renderer] 已忽略 Electron 开发期安全提示（打包后不再出现）')
  }
  return true
}

/**
 * 内嵌第三方页面出问题时最爱"半渲染"：外壳画出来、内容一片空，页面上什么错都不说。
 * 所以把 guest 的 console 与加载失败都收进应用的事件日志里。
 */
function wireGuestDiagnostics(guest) {
  let partition = ''
  try {
    partition = guest.session?.getPartition?.() || ''
  } catch {
    partition = ''
  }
  const label = embeddedLabel(partition)

  guest.on('console-message', (...args) => {
    const info = readConsoleMessage(args)
    if (suppressElectronDevNoise(info.message)) return
    if (info.level === 'error') dshManager.log('error', `${label} 控制台报错：${info.message}`)
    else if (info.level === 'warning') dshManager.log('warn', `${label} 控制台警告：${info.message}`)
  })

  guest.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (code === -3) return // 被新导航取代，属正常
    dshManager.log('error', `${label} ${isMainFrame === false ? '子框架' : '页面'}加载失败 ${code} ${description} ${url}`)
  })

  guest.on('render-process-gone', (_event, details) => {
    dshManager.log('error', `${label} 渲染进程退出：${details?.reason || '未知原因'}`)
  })
}

/** 内嵌页发出的请求失败时也记一笔（CSP 拦截、DNS、连接被重置都会走这里） */function wireEmbeddedRequestDiagnostics() {
  for (const partition of Object.keys(EMBEDDED_LABELS)) {
    try {
      session.fromPartition(partition).webRequest.onErrorOccurred({ urls: ['*://*/*'] }, (details) => {
        if (/ERR_ABORTED/.test(details.error)) return // 导航被取代 / 主动取消
        const short = details.url.length > 120 ? `${details.url.slice(0, 117)}…` : details.url
        dshManager.log('warn', `${embeddedLabel(partition)} 请求失败 ${details.error} ${short}`)
      })
    } catch (error) {
      console.error(`[main] 无法为 ${partition} 安装请求诊断:`, error.message)
    }
  }
}

/**
 * 开发期便利：渲染层产物变了就自动重载窗口。
 * 注意监听的是 Vite 的**产物目录**（dist/renderer），不是源码目录 —— 源码要经过
 * `npm run watch`（vite build --watch）重建之后窗口才有意义地重载。
 * 打包后不启用。默认菜单已被移除，Ctrl+R 之类的重载快捷键也就没有了，
 * 没有这条通路时改样式必须手动重启应用才能看到效果。
 */
function watchRendererForDevReload() {
  if (app.isPackaged) return
  const rendererDir = RENDERER_DIST
  if (!fs.existsSync(rendererDir)) return
  let timer = null
  try {
    fs.watch(rendererDir, { recursive: true }, (_event, filename) => {
      const name = String(filename || '')
      if (!/\.(js|css|html)$/i.test(name)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        dshManager.log('info', `渲染层产物变化（${name}），自动重载窗口`)
        mainWindow.webContents.reload()
      }, 250)
    })
  } catch (error) {
    console.error('[main] 无法监听渲染层目录:', error.message)
  }
}

function createWindow() {
  const resolved = themeInfo().resolved
  // 标题栏策略按平台走：
  //  - Windows/Linux：hidden + titleBarOverlay，最小化/最大化/关闭由系统画在右上角浮层
  //  - macOS：hiddenInset + 红绿灯（trafficLightPosition 把红绿灯对准 36px 顶栏的中心）
  const titleBarOptions = isMac
    ? {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 14, y: Math.round((TITLEBAR_HEIGHT - 14) / 2) }
      }
    : {
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          ...(TITLEBAR_COLORS[resolved] || TITLEBAR_COLORS.dark),
          height: TITLEBAR_HEIGHT
        }
      }
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: WINDOW_BG[resolved],
    title: 'DSH Console',
    icon: makeIcon(),
    ...titleBarOptions,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' })
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 把渲染层的 console 转发到主进程 stdout，方便无 GUI 场景排查（CSP 拦截、脚本报错等）
  mainWindow.webContents.on('console-message', (...args) => {
    const info = readConsoleMessage(args)
    if (suppressElectronDevNoise(info.message)) return
    const text = `[renderer:${info.level}] ${info.message}${info.source ? ` (${info.source}:${info.line})` : ''}`
    if (info.level === 'error' || info.level === 'warning') console.error(text)
    else console.log(text)
  })

  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[renderer] 页面加载失败 ${code} ${description} ${url}`)
  })

  // 外链一律交给系统浏览器，不在应用内导航
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 系统全屏（macOS 绿灯 / ⌃⌘F，Windows 上是 F11 或 setFullScreen）：状态要告诉渲染层。
  // 为什么渲染层需要知道：macOS 全屏时红绿灯**平时是隐藏的**，只有鼠标移到屏幕顶端才出现，
  // 所以那时不该再为它留位置（留了就是一块说不清用途的空白，用户抓图指出过）。
  // 注意与「应用内全屏」区分：那个只是藏掉左栏与状态栏，不动系统窗口状态。
  mainWindow.on('enter-full-screen', () => {
    dshManager.log('info', '窗口进入系统全屏')
    sendToRenderer('app:fullscreen', true)
  })
  mainWindow.on('leave-full-screen', () => {
    dshManager.log('info', '窗口退出系统全屏')
    sendToRenderer('app:fullscreen', false)
  })

  // 内嵌页（DSH 界面 / DeepSeek 用量）：禁止它们自己弹原生窗口，弹窗一律交给系统浏览器
  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })
    // 内嵌页也要能单独开开发者工具：半渲染、空白这类问题都在它自己那一侧
    wireDevTools(guest)
    wireGuestShortcuts(guest)
    wireGuestDiagnostics(guest)
  })

  // 渲染层是 Vite 的产物：缺了它页面会白屏，所以在日志里说清楚，别让人猜
  const entry = path.join(RENDERER_DIST, 'index.html')
  if (!fs.existsSync(entry)) {
    dshManager.log('error', `渲染层产物缺失：${entry} —— 先跑 npm run build（npm start 会自动构建）`)
  }
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (code === -3) return
    dshManager.log(
      'error',
      `界面加载失败 ${code} ${description} ${url}${isMainFrame === false ? '（子框架）' : ''}`
    )
  })
  wireDevTools(mainWindow.webContents)
  void mainWindow.loadFile(entry)
}

/**
 * 开发期（非打包）用 F12 / Ctrl+Shift+I（macOS 上 Cmd+Alt+I）打开开发者工具。
 * 现在默认菜单被移除了，没有这条通路就只能靠猜样式为什么不对 ——
 * 有了它，可以直接看真实元素结构（探针也能少写几次）。
 *
 * 用 detach 而不是贴边停靠：停靠会改变窗口布局，而我们要看的恰恰是布局。
 */
function wireDevTools(contents) {
  if (app.isPackaged) return
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = String(input.key || '').toLowerCase()
    const isF12 = input.key === 'F12'
    // Windows/Linux 是 Ctrl+Shift+I，macOS 习惯是 Cmd+Alt+I
    const isInspect =
      (input.control && input.shift && key === 'i') || (isMac && input.meta && input.alt && key === 'i')
    if (!isF12 && !isInspect) return
    event.preventDefault()
    if (contents.isDevToolsOpened()) contents.closeDevTools()
    else contents.openDevTools({ mode: 'detach' })
  })
}

/**
 * 把内嵌页里的应用级快捷键转交给宿主窗口。
 *
 * 为什么需要：键盘焦点在 <webview> 里时，键盘事件只到 guest，渲染层那个
 * window 级 keydown 处理器收不到 —— 于是人在 Harness 页里时，
 * Ctrl+1~6 切页、Esc 退全屏、Ctrl+R 重载、Ctrl+Shift+D 导出结构全部失灵
 * （macOS 上对应 Cmd+1~6 / Cmd+R / Cmd+Shift+D）。
 *
 * 做法是把同一个按键事件重新注入宿主 webContents，让渲染层原有的处理器照常处理
 * （不在这里复制一份快捷键逻辑，免得两处慢慢走样）。
 */
function wireGuestShortcuts(guest) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  guest.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return
    const key = String(input.key || '')
    const lower = key.toLowerCase()
    // 应用快捷键的修饰键按平台取：macOS 认 Cmd，其它平台认 Ctrl（与渲染层一致）
    const primary = isMac ? Boolean(input.meta) : Boolean(input.control)
    const plain = primary && !input.shift && !input.alt
    const isAppKey =
      (plain && /^[1-6]$/.test(key)) ||
      (plain && lower === 'r') ||
      (primary && input.shift && !input.alt && lower === 'd')
    const isEscape = key === 'Escape'
    if (!isAppKey && !isEscape) return

    const modifiers = []
    if (input.control) modifiers.push('control')
    if (input.meta) modifiers.push('meta')
    if (input.shift) modifiers.push('shift')
    if (input.alt) modifiers.push('alt')
    mainWindow.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: key.length === 1 ? key.toUpperCase() : key,
      modifiers
    })
    // 应用快捷键由我们消费掉；Esc 不拦 —— 内嵌页自己也常用它关弹层，
    // 两边各做各的（我们的处理器只在全屏时才响应 Esc）。
    if (isAppKey) event.preventDefault()
  })
}

/**
 * 窗口图标。
 *
 * 打包后不用管：electron-builder 会把 `build/icon.png` 转成多尺寸 .ico / .icns
 * 并嵌进 exe / app bundle，系统直接取自可执行文件（所以 `build/` 不需要打进 asar）。
 * 这里只是为了**开发时**也有正确的图标 —— 从仓库里那张源图读。
 */
function makeIcon() {
  try {
    const file = path.join(__dirname, '..', '..', 'build', 'icon.png')
    if (fs.existsSync(file)) {
      const image = nativeImage.createFromPath(file)
      if (!image.isEmpty()) return image
    }
  } catch {
    // 读不到就用系统默认图标，不影响运行
  }
  return undefined
}

/** macOS 开发态：Dock 图标取自同一张源图（打包后由 .icns 提供，不必覆盖） */
function applyDockIcon() {
  if (!isMac || app.isPackaged || !app.dock) return
  const icon = makeIcon()
  if (icon) {
    try {
      app.dock.setIcon(icon)
    } catch {
      /* 设置失败不影响运行 */
    }
  }
}

/**
 * 应用菜单。
 *
 * Windows/Linux 上刻意留空（原来的行为）：界面自带全部操作入口，系统菜单栏只是干扰。
 *
 * macOS 不能留空 —— 系统级快捷键（Cmd+Q 退出、Cmd+W 关窗、Cmd+C/V 复制粘贴、
 * Cmd+M 最小化）都由菜单提供，菜单为空时这些键在文本框里都会失灵。
 * 所以给一个最小原生菜单：应用 / 编辑 / 显示 / 窗口。
 */
function installApplicationMenu() {
  if (!isMac) {
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' }
    ])
  )
}

function registerIpc() {
  ipcMain.handle('app:snapshot', () => {
    if (!rendererConnected) {
      rendererConnected = true
      console.log('[main] 渲染层已连接')
    }
    return {
      dsh: dshManager.snapshot(),
      settings: settings.all(),
      sessions: ptySessions.list(),
      launch: dshManager.describeLaunch(),
      env: {
        platform: process.platform,
        /** 是否打包运行：渲染层据此决定装不装开发期诊断快捷键 */
        packaged: app.isPackaged,
        /** 应用自身版本（设置页显示用） */
        app: app.getVersion(),
        /**
         * 本次是不是"覆盖升级后第一次启动"。
         * NSIS 在升级时会用 `--updated` 启动应用（见 electron-builder 的 NSIS 模板），
         * 渲染层据此在状态栏说一句"已更新到 x.y.z"。
         */
        updated: process.argv.includes('--updated'),
        /**
         * 系统窗口是否处于全屏（macOS 绿灯 / Windows F11）。
         * 渲染层据此决定要不要给红绿灯留位置 —— 全屏时它会自动隐藏。
         */
        nativeFullscreen: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()),
        versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome }
      },
      userData: app.getPath('userData'),
      theme: themeInfo()
    }
  })

  ipcMain.handle('theme:set', (_event, mode) => {
    const next = applyThemeSource(mode)
    settings.patch({ themeMode: next })
    dshManager.log('info', `界面主题：${next}${next === 'system' ? `（当前为${nativeTheme.shouldUseDarkColors ? '深色' : '亮色'}）` : ''}`)
    return broadcastTheme()
  })

  ipcMain.handle('settings:patch', (_event, patch) => {
    const next = settings.patch(patch)
    // 设置页里也能改主题，保持与工具栏开关一致
    if (patch && 'themeMode' in patch) applyThemeSource(next.themeMode)
    dshManager.syncSettings()
    dshManager.log('info', '设置已保存')
    broadcastTheme()
    return next
  })

  ipcMain.handle('dsh:start', async () => {
    try {
      return { ok: true, state: await dshManager.start({ allowAdopt: true }) }
    } catch (error) {
      return { ok: false, error: error.message, state: dshManager.snapshot() }
    }
  })

  ipcMain.handle('dsh:stop', async (_event, options) => {
    try {
      return { ok: true, state: await dshManager.stop({ force: Boolean(options?.force), killExternal: Boolean(options?.killExternal) }) }
    } catch (error) {
      return { ok: false, error: error.message, state: dshManager.snapshot() }
    }
  })

  ipcMain.handle('dsh:restart', async () => {
    try {
      return { ok: true, state: await dshManager.restart() }
    } catch (error) {
      return { ok: false, error: error.message, state: dshManager.snapshot() }
    }
  })

  ipcMain.handle('dsh:input', (_event, data) => {
    dshManager.write(String(data ?? ''))
    return true
  })

  ipcMain.handle('dsh:resize', (_event, size) => {
    dshManager.resize(Number(size?.cols), Number(size?.rows))
    return true
  })

  ipcMain.handle('dsh:replay', () => dshManager.replay())

  ipcMain.handle('shell:create', (_event, size) => {
    const id = `shell-${++shellCounter}`
    const target = processUtils.resolveShell(settings.all())
    const cwd = String(settings.get('cwd') || '') || processUtils.homeDir()
    // 标题由主进程持有（渲染层只显示），可以重命名；它只活在本次运行里 ——
    // 本地 Shell 不做任何持久化，下次启动就是全新的一页。
    const label = `Shell ${shellCounter}`
    const cols = Number(size?.cols) || 120
    const rows = Number(size?.rows) || 30
    try {
      ptySessions.create({
        id,
        file: target.file,
        args: target.args,
        cwd,
        cols,
        rows,
        // 行列也带给渲染层：界面重载后重新接上时按同样尺寸建立，
        // 第一次 fit 就是空操作，不会白触发一次 PTY resize
        meta: { kind: 'shell', label, command: target.display, cwd, cols, rows }
      })
      extraSessions.add(id)
      return { ok: true, id, label, command: target.display }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })

  ipcMain.handle('session:input', (_event, payload) => {
    ptySessions.write(String(payload?.id), String(payload?.data ?? ''))
    return true
  })

  ipcMain.handle('session:resize', (_event, payload) => {
    ptySessions.resize(String(payload?.id), Number(payload?.cols), Number(payload?.rows))
    return true
  })

  ipcMain.handle('session:kill', (_event, id) => {
    const killed = ptySessions.kill(String(id), true)
    extraSessions.delete(String(id))
    return killed
  })

  /** 重命名本地 Shell 的标题：只活在本次运行里（终端标题由主进程持有，渲染层只显示） */
  ipcMain.handle('session:rename', (_event, payload) => {
    const id = String(payload?.id || '')
    const label = String(payload?.label || '').trim().slice(0, 40)
    if (!id || !label) return { ok: false, error: '名字不能为空' }
    ptySessions.rename(id, label)
    return { ok: true, id, label }
  })

  ipcMain.handle('app:openExternal', async (_event, url) => {
    const target = url || dshManager.uiUrl || dshManager.origin
    await shell.openExternal(target)
    return target
  })

  ipcMain.handle('app:revealUserData', () => shell.openPath(app.getPath('userData')))

  ipcMain.handle('app:confirm', async (_event, payload) => {
    const result = await dialog.showMessageBox(mainWindow, {
      type: payload?.type || 'question',
      buttons: payload?.buttons || ['取消', '确定'],
      defaultId: 1,
      cancelId: 0,
      title: payload?.title || '确认',
      message: payload?.message || '',
      detail: payload?.detail || ''
    })
    return result.response === 1
  })
}

function wireManagerEvents() {
  dshManager.on('state', (snapshot) => sendToRenderer('dsh:state', snapshot))
  dshManager.on('output', (payload) => sendToRenderer('dsh:output', payload))
  dshManager.on('log', (entry) => sendToRenderer('dsh:log', entry))
  dshManager.on('ui-url', (url) => sendToRenderer('dsh:ui-url', url))

  ptySessions.on('data', (event) => {
    if (event.id === dshManager.sessionId) return // dsh 输出走 dsh:output
    sendToRenderer('session:output', event)
  })
  ptySessions.on('exit', (event) => {
    if (event.id === dshManager.sessionId) {
      // dsh 自己的退出也要告诉渲染层，否则终端里看不到任何收尾信息
      sendToRenderer('dsh:exit', { exitCode: event.exitCode, signal: event.signal })
      return
    }
    extraSessions.delete(event.id)
    sendToRenderer('session:exit', event)
  })
}

/**
 * 本地 Shell **不做任何持久化**（用户的决定）：会话个数、工作目录、标题、终端内容
 * 都不跨应用重启保留 —— 每次启动就是全新的一页，点「新建本地 Shell」从头开。
 *
 * 应用退出时 PTY 一律被杀（见 before-quit）。界面重载（开发时构建 / Ctrl+R）是另一回事：
 * 那时 PTY 还活着，渲染层按快照里的 id 直接接上，终端从空白开始、新输出照常显示。
 *
 * 顺带清理早期版本留下的会话文件：它已经不读也不写了。
 */
function dropLegacySessionFile() {
  try {
    fs.rmSync(path.join(app.getPath('userData'), 'shell-sessions.json'), { force: true })
  } catch {
    // 删不掉也无所谓：没人再读它
  }
}

async function bootstrap() {
  settings = new Settings(path.join(app.getPath('userData'), 'settings.json'))
  // UA 要在任何请求发出之前定好：内嵌页首次导航也吃这个默认值
  // （以前是在 did-attach-webview 里改，可能晚于第一次请求）
  app.userAgentFallback = cleanedUserAgent(app.userAgentFallback)
  // 主题要在建窗口之前生效，否则会先按旧主题渲染一帧
  applyThemeSource(settings.get('themeMode'))
  nativeTheme.on('updated', () => {
    // system 模式下系统切换明暗时，把新结果推给渲染层
    const info = broadcastTheme()
    if (dshManager) dshManager.log('info', `系统主题变化 → ${info.resolved === 'dark' ? '深色' : '亮色'}`)
  })

  ptySessions = new PtySessions()
  dshManager = new DshManager({ settings, ptySessions })
  wireManagerEvents()
  dropLegacySessionFile()

  createWindow()
  registerIpc()
  wireEmbeddedRequestDiagnostics()
  watchRendererForDevReload()

  const theme = themeInfo()
  dshManager.startPolling()
  dshManager.log('info', `DSH Console 已启动（Electron ${process.versions.electron} / Node ${process.versions.node}）`)
  dshManager.log('info', `内嵌页 UA：${app.userAgentFallback}`)
  dshManager.log('info', `界面主题：${theme.mode}（当前为${theme.resolved === 'dark' ? '深色' : '亮色'}）`)
  if (settings.migration) {
    dshManager.log(
      'info',
      `设置已从 v${settings.migration.from} 迁移到 v${settings.migration.to}：启动行为改为「自动拉起 dsh + 自动进 DeepSeek Harness + 自动全屏」`
    )
  }

  const launch = dshManager.describeLaunch()
  if (launch.kind === 'error') {
    dshManager.log('error', `未找到可用的 dsh 命令：${launch.error}`)
  } else {
    dshManager.log('info', `dsh 启动命令: ${launch.display}`)
  }

  if (settings.get('autoStart')) {
    try {
      await dshManager.start({ allowAdopt: true })
    } catch (error) {
      dshManager.log('error', `自动启动失败：${error.message}`)
    }
  }
}

// 单实例：第二次启动只聚焦已有窗口
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  installApplicationMenu()

  app.whenReady().then(() => {
    console.log(`[main] 日志文件: ${fileLog.file}`)
    applyDockIcon()
    void bootstrap()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    // macOS 惯例：关掉窗口后应用留在 Dock 里，点图标由 activate 重建窗口；
    // 其它平台保持"窗口全关即退出"。
    if (!isMac) app.quit()
  })

  // 退出前收尾：按设置决定是否连带停掉 dsh
  app.on('before-quit', () => {
    if (!settings || !dshManager) return
    const killOnExit = settings.get('killOnExit')
    if (killOnExit && dshManager.ownProcess) {
      const pid = dshManager.ownedPid
      dshManager.log('info', `应用退出：停止本应用启动的 dsh${pid ? ` (PID ${pid})` : ''}`)
      // PID 可能还没就绪（PTY 异步）：那时至少把 pty 子进程杀掉
      if (pid) processUtils.killTreeSync(pid)
      else if (ptySessions) ptySessions.kill(dshManager.sessionId, true)
    }
    if (ptySessions) ptySessions.killAll()
    dshManager.stopPolling()
    fileLog.close()
  })
}
