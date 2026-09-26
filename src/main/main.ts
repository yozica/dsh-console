/**
 * Electron 主进程：窗口、IPC、生命周期。
 *
 * 关于路径：源码在 src/，编译产物在 dist/（tsconfig.main.json 的 rootDir=src / outDir=dist），
 * 目录结构一一对应，所以下面的 `__dirname/../preload/preload.js`、`../../dist/renderer`
 * 这些相对路径在编译后依然成立（dist/main/main.js → dist/preload、dist/renderer）。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  nativeTheme,
  type BrowserWindowConstructorOptions,
  type MessageBoxOptions,
  type WebContents,
} from 'electron';

import { Settings } from './settings';
import { PtySessions } from './pty-sessions';
import { DshManager } from './dsh-manager';
import { SessionArchiveManager } from './session-archive';
import { PluginManager } from './plugin-manager';
import {
  EnvDoctor,
  EnvFixRunner,
  collectBootProbe,
  judgeEnvironment,
  judgeWizard,
} from './env-doctor';
import { NodeInstaller } from './node-installer';
import { createUpdater, type Updater } from './updater';
import { installFileLogging } from './logger';
import {
  createEmbeddedTools,
  cleanedUserAgent,
  readConsoleMessage,
  suppressElectronDevNoise,
} from './main-embedded';
import { applyDockIcon, installApplicationMenu, makeIcon } from './main-menu';
import { installCrashGuards } from './main-crash';
import { createExternalOpener } from './main-url';
import { createThemeTools } from './main-theme';
import { registerIpc, messageOf, bundledVersions, wizardSkips, type CloseAsk } from './main-ipc';
import * as processUtils from './process-utils';
import type {
  CloseAction,
  CloseAnswer,
  CloseRequest,
  DshExitEvent,
  DshLogEntry,
  DshOutputEvent,
  EnvFixState,
  EnvInstallState,
  SessionExitEvent,
  SessionOutputEvent,
  UpdateState,
} from '../shared/ipc';

const isDev = process.argv.includes('--dev');
const isMac = process.platform === 'darwin';

// 允许把配置/缓存目录挪到别处（便携部署，或本机验证时不污染 %APPDATA%）
const userDataOverride = process.env.DSH_CONSOLE_USER_DATA;
if (userDataOverride) {
  try {
    app.setPath('userData', path.resolve(userDataOverride));
  } catch (error) {
    console.error(
      '[main] 无法设置 userData 目录:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

// 主进程日志同时落盘：<userData>/logs/console.log
const fileLog = installFileLogging(path.join(app.getPath('userData'), 'logs'));

/**
 * 启动记录：**在 ready 之前**就要落一行。
 *
 * 为什么必须在 ready 之前：真机上遇到过一次"双击没反应、过一会系统报崩溃"，而日志里一行都
 * 没有 —— 那时分不清"进程根本没起来"和"起来了但没到 ready"（`[main] 日志文件:` 原来打在
 * whenReady 里）。这一行把版本 / 平台 / 是否打包 / userData 先钉下来，于是"到没到 ready"
 * 一眼可辨。用 `writeLine` 而不是 `console.log`：后面可能立刻 `app.exit()`，缓冲流里那份会丢。
 */
fileLog.writeLine(
  `[main] 启动：${[
    `v${app.getVersion()}`,
    `${process.platform} ${process.arch}`,
    `Electron ${process.versions.electron ?? '?'}`,
    isDev ? '开发态' : '打包版',
    `userData ${app.getPath('userData')}`,
  ].join(' · ')}`,
);

/**
 * 主进程兜底：未捕获的异常与未处理的 Promise 拒绝都要**落盘**，而且要把日志路径一起给人。
 *
 * 为什么要有：Electron 默认只弹一句英文 "A JavaScript error occurred in the main process"，
 * 我们自己的日志里什么都没有 —— 真机上那次"启动不了"，用户拿不到任何能发出来的东西，
 * 只能靠猜。
 *
 * 三个选择写在代码里：
 *   1. 用 `dialog.showErrorBox` —— 官方文档写明它**可以在 ready 之前安全调用**，正是为
 *      "启动早期报错"准备的（见 https://www.electronjs.org/docs/latest/api/dialog）；
 *   2. 记录之后**不退出**：与 Electron 的默认行为一致。硬退会把"还能用一半"变成"完全不能
 *      用"，而原因已经摆在用户眼前了；
 *   3. 只加监听、不改 console 的接管方式 —— 日志走既有通道，不另造一份。
 */
let mainWindow: BrowserWindow | null = null;
// 下面这几个都在 bootstrap() 里赋值；用 `!` 明确"这里不重复判空"——
// 所有 IPC handler 与事件回调都只在 bootstrap 之后才可能被触发。
/** 系统托盘：只在真的要"收起"时才建（选了直接退出的用户不该看到一个托盘图标） */
let tray: Tray | null = null;
/** 是不是"真的要退出"。before-quit 之后置位，窗口的 close 处理器据此放行 */
let isQuitting = false;
/** 关闭询问框是不是已经在显示：连点 X 不该叠出第二个对话框 */
let closeDialogOpen = false;
/** 正在等渲染层的那次关闭询问；null = 没人在等 */
let pendingCloseAsk: CloseAsk | null = null;
/**
 * **握手**时限（毫秒）：只限制"渲染层有没有把卡片显示出来"，不限制用户思考多久。
 * 确认之后计时器就撤了；确认不来才退回原生弹窗 —— 渲染层卡住时不能让窗口关不掉。
 */
const CLOSE_ACK_TIMEOUT_MS = 2000;
let settings!: Settings;
let ptySessions!: PtySessions;
let dshManager!: DshManager;
let archiveManager!: SessionArchiveManager;
let pluginManager!: PluginManager;
/** 运行环境自检（只读探测 + 缓存）与一键修复的执行者；见 main/env-doctor.ts */
let envDoctor!: EnvDoctor;
let envFixRunner!: EnvFixRunner;
/** Node 安装 / 更新通道（系统级动作，见 main/node-installer.ts） */
let nodeInstaller!: NodeInstaller;
let updater!: Updater;

let shellCounter = 0;
/** 应用自己开的终端会话 id（除 dsh 之外） */
const extraSessions = new Set<string>();
/** 渲染层是否已经连上（用于日志确认页面没被 CSP 之类的东西拦死） */
let rendererConnected = false;

installCrashGuards({ logFile: () => fileLog.file });

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// t56 起主题 / 内嵌页诊断 / 菜单各有一层自己的模块；窗口、日志器与设置都是这里的单例，
// 用 getter 传进去（窗口是可变的：关掉就新建一个）。
const theme = createThemeTools({
  isMac,
  getWindow: () => mainWindow,
  send: sendToRenderer,
  getMode: () => settings?.get('themeMode'),
});

const menuCtx = { isMac };

const external = createExternalOpener({ log: (level, text) => dshManager.log(level, text) });

// ---------------------------------------------------------------- 主题

const RENDERER_DIST = path.join(__dirname, '..', '..', 'dist', 'renderer');
const embedded = createEmbeddedTools({
  isPackaged: () => app.isPackaged,
  rendererDist: RENDERER_DIST,
  getWindow: () => mainWindow,
  log: (level, text) => dshManager.log(level, text),
});
function createWindow(): void {
  const resolved = theme.themeInfo().resolved;
  // 标题栏策略按平台走：
  //  - Windows/Linux：hidden + titleBarOverlay，最小化/最大化/关闭由系统画在右上角浮层
  //  - macOS：hiddenInset + 红绿灯（trafficLightPosition 把红绿灯对准 36px 顶栏的中心）
  const titleBarOptions: BrowserWindowConstructorOptions = isMac
    ? {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 14, y: Math.round((theme.TITLEBAR_HEIGHT - 14) / 2) },
      }
    : {
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          ...(theme.TITLEBAR_COLORS[resolved] || theme.TITLEBAR_COLORS.dark),
          height: theme.TITLEBAR_HEIGHT,
        },
      };
  const win = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: theme.WINDOW_BG[resolved],
    title: 'DSH Console',
    icon: makeIcon(),
    ...titleBarOptions,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false,
    },
  });
  mainWindow = win;

  win.once('ready-to-show', () => {
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  // 关闭窗口的行为（问一次 / 收起托盘 / 直接退出）：见 wireCloseBehavior
  wireCloseBehavior(win);

  win.webContents.on('console-message', (...args: unknown[]) => {
    // 把渲染层的 console 转发到主进程 stdout，方便无 GUI 场景排查（CSP 拦截、脚本报错等）
    const info = readConsoleMessage(args);
    if (suppressElectronDevNoise(info.message)) return;
    const text = `[renderer:${info.level}] ${info.message}${info.source ? ` (${info.source}:${info.line})` : ''}`;
    if (info.level === 'error' || info.level === 'warning') console.error(text);
    else console.log(text);
  });

  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[renderer] 页面加载失败 ${code} ${description} ${url}`);
  });

  // 外链一律交给系统浏览器，不在应用内导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    void external.openExternalSafely(url, '主窗口');
    return { action: 'deny' };
  });

  // 系统全屏（macOS 绿灯 / ⌃⌘F，Windows 上是 F11 或 setFullScreen）：状态要告诉渲染层。
  // 为什么渲染层需要知道：macOS 全屏时红绿灯**平时是隐藏的**，只有鼠标移到屏幕顶端才出现，
  // 所以那时不该再为它留位置（留了就是一块说不清用途的空白，用户抓图指出过）。
  // 注意与「应用内全屏」区分：那个只是藏掉左栏与状态栏，不动系统窗口状态。
  win.on('enter-full-screen', () => {
    dshManager.log('info', '窗口进入系统全屏');
    sendToRenderer('app:fullscreen', true);
  });
  win.on('leave-full-screen', () => {
    dshManager.log('info', '窗口退出系统全屏');
    sendToRenderer('app:fullscreen', false);
  });

  // 内嵌页（DSH 界面 / DeepSeek 用量）：禁止它们自己弹原生窗口，弹窗一律交给系统浏览器
  win.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      void external.openExternalSafely(url, '内嵌页');
      return { action: 'deny' };
    });
    // 内嵌页也要能单独开开发者工具：半渲染、空白这类问题都在它自己那一侧
    wireDevTools(guest);
    wireGuestShortcuts(guest);
    embedded.wireGuestDiagnostics(guest);
  });

  const entry = path.join(RENDERER_DIST, 'index.html');
  // 渲染层是 Vite 的产物：缺了它页面会白屏，所以在日志里说清楚，别让人猜
  if (!fs.existsSync(entry)) {
    dshManager.log(
      'error',
      `渲染层产物缺失：${entry} —— 先跑 npm run build（npm start 会自动构建）`,
    );
  }
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (code === -3) return;
    dshManager.log(
      'error',
      `界面加载失败 ${code} ${description} ${url}${isMainFrame === false ? '（子框架）' : ''}`,
    );
  });
  wireDevTools(win.webContents);
  void win.loadFile(entry);
}

/**
 * 开发期（非打包）用 F12 / Ctrl+Shift+I（macOS 上 Cmd+Alt+I）打开开发者工具。
 * 现在默认菜单被移除了，没有这条通路就只能靠猜样式为什么不对 ——
 * 有了它，可以直接看真实元素结构（探针也能少写几次）。
 *
 * 用 detach 而不是贴边停靠：停靠会改变窗口布局，而我们要看的恰恰是布局。
 */
function wireDevTools(contents: WebContents): void {
  if (app.isPackaged) return;
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    const isF12 = input.key === 'F12';
    // Windows/Linux 是 Ctrl+Shift+I，macOS 习惯是 Cmd+Alt+I
    const isInspect =
      (input.control && input.shift && key === 'i') ||
      (isMac && input.meta && input.alt && key === 'i');
    if (!isF12 && !isInspect) return;
    event.preventDefault();
    if (contents.isDevToolsOpened()) contents.closeDevTools();
    else contents.openDevTools({ mode: 'detach' });
  });
}

/**
 * 把内嵌页里的应用级快捷键转交给宿主窗口。
 *
 * 为什么需要：键盘焦点在 <webview> 里时，键盘事件只到 guest，渲染层那个
 * window 级 keydown 处理器收不到 —— 于是人在 Harness 页里时，
 * Ctrl+1~8 切页、Esc 退全屏、Ctrl+R 重载、Ctrl+Shift+D 导出结构、Ctrl+Shift+U 演示更新相位
 * 全部失灵（macOS 上对应 Cmd+1~8 / Cmd+R / Cmd+Shift+D / Cmd+Shift+U）。
 *
 * 做法是把同一个按键事件重新注入宿主 webContents，让渲染层原有的处理器照常处理
 * （不在这里复制一份快捷键逻辑，免得两处慢慢走样）。
 */
function wireGuestShortcuts(guest: WebContents): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  guest.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    const key = String(input.key || '');
    const lower = key.toLowerCase();
    // 应用快捷键的修饰键按平台取：macOS 认 Cmd，其它平台认 Ctrl（与渲染层一致）
    const primary = isMac ? Boolean(input.meta) : Boolean(input.control);
    const plain = primary && !input.shift && !input.alt;
    const isAppKey =
      (plain && /^[1-8]$/.test(key)) ||
      (plain && lower === 'r') ||
      (primary && input.shift && !input.alt && (lower === 'd' || lower === 'u'));
    const isEscape = key === 'Escape';
    if (!isAppKey && !isEscape) return;

    const modifiers: NonNullable<Electron.InputEvent['modifiers']> = [];
    if (input.control) modifiers.push('control');
    if (input.meta) modifiers.push('meta');
    if (input.shift) modifiers.push('shift');
    if (input.alt) modifiers.push('alt');
    win.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: key.length === 1 ? key.toUpperCase() : key,
      modifiers,
    });
    if (isAppKey) event.preventDefault();
    // 应用快捷键由我们消费掉；Esc 不拦 —— 内嵌页自己也常用它关弹层，
    // 两边各做各的（我们的处理器只在全屏时才响应 Esc）。
  });
}

/**
 * 窗口 / 托盘图标。
 *
 * 打包后 exe 自己的图标不用管：electron-builder 会把 `build/icon.png` 转成多尺寸
 * .ico / .icns 并嵌进 exe / app bundle，系统直接取自可执行文件。
 * 但**托盘图标必须能在运行期读到这张源图**（Windows 上托盘没有"取自 exe"这条路径），
 * 所以 `build/icon.png` 现在也打进 asar（见 package.json 的 build.files）——
 * 那 31 KB 换的是"打包后托盘图标不是空白"。
 */
// ---------------------------------------------------------------- 关闭窗口的行为
/**
 * 点关闭（X）时做什么：问一次、收起到系统托盘，还是直接退出。
 *
 * 为什么要有这一块：这个应用的价值是"在后台看着 dsh"。以前 Windows/Linux 上关窗
 * 就是退出，而默认还会**连带停掉本应用启动的 dsh** —— 点一下 X，正在用的 dsh 就没了，
 * 且没有任何提示。现在默认**问一次**（其它桌面应用的惯例），勾了「记住我的选择」就把
 * 结果落到设置项 `closeAction` 上。macOS 不参与：那边关窗不退出、Dock 常驻是系统惯例。
 *
 * 时序上有一条必须守住：真正退出时 `before-quit` 会先把 `isQuitting` 置位，这里才放行。
 * 否则「收起到托盘」会把托盘菜单的退出、更新器的 quitAndInstall()、乃至系统关机
 * 一起拦下来 —— 界面再也退不掉了。
 */

/** 把窗口叫回来：最小化的还原、藏起来的显示、已经关掉的就新建 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * 托盘图标（Windows/Linux）。macOS 用 Dock，不建。
 * 源图是 512 的，这里缩到 32：100% DPI 的托盘是 16px、150~200% 是 24~32px ——
 * 给 32 让系统往下缩，比钉死 16 在高分屏上被拉大好得多（放大一定比缩小糊）。
 */
function ensureTray(): boolean {
  if (tray) return true;
  if (isMac) return false;
  const icon = makeIcon();
  if (!icon) {
    dshManager.log('warn', '找不到 build/icon.png，建不了托盘：「收起到托盘」退化为最小化');
    return false;
  }
  try {
    tray = new Tray(icon.resize({ width: 32, height: 32, quality: 'best' }));
    tray.setToolTip('DSH Console');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主界面', click: () => showMainWindow() },
        { type: 'separator' },
        { label: '退出 DSH Console', click: () => app.quit() },
      ]),
    );
    // 单击托盘图标叫回窗口。托盘菜单里另有一个「退出」，所以这里不承担退出语义
    tray.on('click', () => showMainWindow());
    return true;
  } catch (error) {
    tray = null;
    dshManager.log('warn', `托盘图标建立失败：${messageOf(error)}`);
    return false;
  }
}

/**
 * 收起：窗口藏起来，应用（以及本应用启动的 dsh）继续在后台跑。
 * 托盘建不起来时退化成最小化 —— 那种情况下藏起来就再也叫不回来了。
 */
function hideToTray(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!ensureTray()) {
    mainWindow.minimize();
    dshManager.log('warn', '没有托盘图标：改为最小化窗口（应用继续运行）');
    return;
  }
  mainWindow.hide();
  /**
   * Windows 的气泡提示（这个平台才有）。
   * **一台机器上只弹一次**，所以标记写进设置而不是只记在内存里 —— 只记内存的话每次开应用
   * 收起时都要被提示一遍。弹失败了不记：下次收起再试，别白白吃掉这个提示。
   */
  if (tray && process.platform === 'win32' && !settings.get('trayHintShown')) {
    try {
      tray.displayBalloon({
        title: 'DSH Console 仍在运行',
        content: '窗口已收到托盘，dsh 继续跑着。点托盘图标可以叫回窗口。',
      });
      settings.patch({ trayHintShown: true });
    } catch {
      // 气泡只是提示，弹不出来不影响收起
    }
  }
  dshManager.log('info', '窗口已收起到托盘：应用与 dsh 继续在后台运行');
}

/** 「记住我的选择」：写进设置，并推给渲染层（设置页那份表单不能留着旧值，否则下次保存又写回去） */
function rememberCloseAction(action: CloseAction): void {
  try {
    const next = settings.patch({ closeAction: action });
    sendToRenderer('settings:changed', next);
    dshManager.log('info', `关闭窗口的行为已记住：${action}`);
  } catch (error) {
    dshManager.log('warn', `记住关闭行为失败：${messageOf(error)}`);
  }
}

/**
 * 等渲染层回答"这次关闭怎么办"。
 *
 * **只给握手设时限，不给用户思考设时限**：发完请求后等一个"卡片已经显示了"的确认，
 * 确认一到就撤掉计时器，然后一直等用户选。少了这个区分会踩同一个坑两次 ——
 * 卡片明明已经显示出来了、用户还在看，两三秒后系统弹窗自己冒出来（第一版就是这样）。
 * 反过来，确认迟迟不来（渲染层没连上、卡住、已经没了）就返回 null，走原生兜底弹窗，
 * 免得 X 变成一个关不掉的窗口。
 */
function askRendererForCloseAction(): Promise<CloseAnswer | null> {
  const win = mainWindow;
  if (!win || win.isDestroyed() || !rendererConnected) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer: CloseAnswer | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(handshake);
      pendingCloseAsk = null;
      resolve(answer);
    };
    const handshake = setTimeout(() => {
      sendToRenderer('app:close-request', null);
      dshManager.log('warn', '关闭询问：渲染层没有确认显示卡片，改用原生弹窗');
      finish(null);
    }, CLOSE_ACK_TIMEOUT_MS);
    pendingCloseAsk = {
      ack: () => clearTimeout(handshake),
      answer: finish,
    };
    const request: CloseRequest = {
      killOnExit: settings.get('killOnExit'),
      owned: dshManager.ownProcess,
      pid: dshManager.ownedPid,
      phase: dshManager.snapshot().phase,
    };
    sendToRenderer('app:close-request', request);
  });
}

/**
 * 询问一次：优先用渲染层自己的确认卡片（跟应用一个样子，还能把"哪个 dsh 会受影响"写清楚），
 * 问不到才退回原生弹窗。
 */
async function askCloseAction(): Promise<void> {
  if (closeDialogOpen) return;
  closeDialogOpen = true;
  try {
    const answer = await askRendererForCloseAction();
    if (!answer) {
      await askCloseActionNative();
      return;
    }
    if (answer.action === 'cancel') return;
    if (answer.remember) rememberCloseAction(answer.action);
    if (answer.action === 'tray') hideToTray();
    else app.quit();
  } finally {
    closeDialogOpen = false;
  }
}

/** 原生兜底：收起到托盘 / 退出应用 / 取消（可勾「记住我的选择」） */
async function askCloseActionNative(): Promise<void> {
  const killOnExit = settings.get('killOnExit');
  const options: MessageBoxOptions = {
    type: 'question',
    buttons: ['收起到托盘', '退出应用', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: '关闭 DSH Console',
    message: '要收起 DSH Console，还是直接退出？',
    detail:
      '收起到托盘：应用继续在后台运行，本应用启动的 dsh 不会被停掉，可以从托盘图标再叫回来。\n' +
      `退出应用：结束 DSH Console${killOnExit ? '，并按当前设置停止本应用启动的 dsh' : '（当前设置不停止 dsh）'}。`,
    checkboxLabel: '记住我的选择，以后不再询问',
    checkboxChecked: false,
  };
  // 窗口可能已经在关了：退化成不带父窗口的对话框（与 app:confirm 同样的兜法）
  const result =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
  if (result.response === 0) {
    if (result.checkboxChecked) rememberCloseAction('tray');
    hideToTray();
  } else if (result.response === 1) {
    if (result.checkboxChecked) rememberCloseAction('quit');
    app.quit();
  }
}
// response === 2（取消）：什么都不做，窗口留在原地

/**
 * 关窗拦截。
 * `quit` 直接放行（窗口关掉 → window-all-closed → app.quit()）；
 * 另外两种都先把这次关闭拦下来，再决定是藏起来还是问。
 */
function wireCloseBehavior(win: BrowserWindow): void {
  win.on('close', (event) => {
    if (isQuitting || isMac) return;
    const action = settings.get('closeAction');
    if (action === 'quit') return;
    event.preventDefault();
    if (action === 'tray') {
      hideToTray();
      return;
    }
    void askCloseAction();
  });

  /**
   * 渲染层崩了的时候，已经确认过的那次询问不能一直等下去 —— 用户已经没有界面可点，
   * 窗口就再也关不掉了。当作"问不到"，退回原生弹窗。
   */
  win.webContents.on('render-process-gone', () => {
    pendingCloseAsk?.answer(null);
  });
}

function wireManagerEvents(): void {
  dshManager.on('state', (snapshot) => sendToRenderer('dsh:state', snapshot));
  dshManager.on('output', (payload: DshOutputEvent) => sendToRenderer('dsh:output', payload));
  dshManager.on('log', (entry: DshLogEntry) => sendToRenderer('dsh:log', entry));
  dshManager.on('ui-url', (url: string) => sendToRenderer('dsh:ui-url', url));

  ptySessions.on('data', (event: SessionOutputEvent) => {
    if (event.id === dshManager.sessionId) return; // dsh 输出走 dsh:output
    sendToRenderer('session:output', event);
  });
  ptySessions.on('exit', (event: SessionExitEvent) => {
    if (event.id === dshManager.sessionId) {
      const payload: DshExitEvent = { exitCode: event.exitCode, signal: event.signal };
      // dsh 自己的退出也要告诉渲染层，否则终端里看不到任何收尾信息
      sendToRenderer('dsh:exit', payload);
      return;
    }
    extraSessions.delete(event.id);
    sendToRenderer('session:exit', event);
  });
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
function dropLegacySessionFile(): void {
  try {
    fs.rmSync(path.join(app.getPath('userData'), 'shell-sessions.json'), { force: true });
  } catch {
    // 删不掉也无所谓：没人再读它
  }
}

async function bootstrap(): Promise<void> {
  settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
  // UA 要在任何请求发出之前定好：内嵌页首次导航也吃这个默认值
  // （以前是在 did-attach-webview 里改，可能晚于第一次请求）
  app.userAgentFallback = cleanedUserAgent(app.userAgentFallback);
  // 主题要在建窗口之前生效，否则会先按旧主题渲染一帧
  theme.applyThemeSource(settings.get('themeMode'));
  nativeTheme.on('updated', () => {
    // system 模式下系统切换明暗时，把新结果推给渲染层
    const info = theme.broadcastTheme();
    if (dshManager)
      dshManager.log('info', `系统主题变化 → ${info.resolved === 'dark' ? '深色' : '亮色'}`);
  });

  ptySessions = new PtySessions();
  dshManager = new DshManager({ settings, ptySessions });
  archiveManager = new SessionArchiveManager();
  // 插件装配层：只读地看 profile 的 bundle 层栈与生效配置（dsh 是否在跑都能看）
  pluginManager = new PluginManager(settings, () => dshManager.uiUrl);
  // 运行中的清单要拿 dsh 的访问令牌（只有本应用启动的 dsh 才有），所以注入一个取地址的函数
  // 运行环境自检：只读探测 + 缓存（判定是纯函数，见 main/env-doctor.ts）。
  // 运行时事实由这里注入 —— env-doctor 刻意不 import electron，自检才能直接 import 它。
  const envRuntime = () => ({
    platform: process.platform,
    packaged: app.isPackaged,
    bundled: bundledVersions(),
  });
  envDoctor = new EnvDoctor(settings, {
    runtime: envRuntime,
    // 每轮自检在事件日志里留一句（用户报障时最先被问的就是这些事实）。
    // 报告本身走 envCheck() 拉取 + 修复状态里的复检结果，不走事件（契约里没有这条订阅）。
    onReport: (report) =>
      dshManager.log(
        'info',
        `环境自检：${report.counts.ok} 项正常 · ${report.counts.warn} 项需要注意 · ${report.counts.missing} 项不正常${
          report.firstProblemId ? `（先看 ${report.firstProblemId}）` : ''
        }`,
      ),
    // 被界面撤下去的那些原始错误（`PATH` / `dsh.cmd` / `npx` / `EPERM` 这类内部记号）**只落日志**。
    // console 已经被 logger.ts 接进 <userData>/logs/console.log（本文件顶部那次 installFileLogging），
    // 所以这里不另造通道；也**不走 dshManager.log** —— 事件日志是用户看得见的界面，
    // 那正是这些原文不该出现的地方（冻结 §3.8 #22 的判据是成对的：日志里找得到、界面里找不到）。
    log: (line) => console.log(`[env] ${line}`),
  });
  envFixRunner = new EnvFixRunner(settings, envDoctor, {
    output: (chunk) => sendToRenderer('env:fix-output', { chunk }),
    state: (state: EnvFixState) => sendToRenderer('env:fix-state', state),
    log: (text) => dshManager.log('info', text),
    // 装出来的东西跑不起来时，界面要能告诉用户"细节在哪"（细节留日志、结论给人话）。
    // 日志文件就是本文件顶部那次 installFileLogging 的产物；写盘失败时它是空串，界面文案会退化。
    logFile: () => fileLog.file || null,
  });
  // Node 安装 / 更新通道（系统级动作，见 main/node-installer.ts）。
  // 复检与"更新前先停本应用启动的 dsh"都由这里注入，引擎自己不 import env-doctor / dsh-manager
  nodeInstaller = new NodeInstaller(settings, {
    // —— 它能被普通 Node 直接 import 做离线测（纯函数夹具），这条边界是冻结 §4.1 的方向规则 2。
    output: (chunk) => sendToRenderer('env:install-output', { chunk }),
    state: (state: EnvInstallState) => sendToRenderer('env:install-state', state),
    log: (text) => dshManager.log('info', text),
    recheck: () => envDoctor.recheck(),
    stopDsh: async () => {
      if (!dshManager.ownProcess) return;
      // 只停**本应用启动的**那个：外部实例不属于我们（需求 §14：不把别的进程停下来）
      await dshManager.stop({ force: false, killExternal: false });
    },
  });
  // 自动更新：状态变化统一走 app:update 事件（渲染层底栏与设置页读同一份）
  updater = createUpdater({
    settings,
    sendState: (state: UpdateState) => sendToRenderer('app:update', state),
    getWindow: () => mainWindow,
  });
  wireManagerEvents();
  dropLegacySessionFile();

  createWindow();
  // 托盘随应用一起出现（Windows / Linux）：它不只是"收起的落点"，也是**叫回窗口与退出的入口** ——
  // 等第一次收起才建的话，用户在那之前根本不知道有这个东西。macOS 上不建（Dock 承担这个角色）。
  ensureTray();
  // IPC 层只拿"稳定的引用或 getter"：窗口关掉会新建、关闭询问每回合换一个对象、
  // 渲染层连接位与 Shell 计数器都是可变量（形状见 main-ipc-shared.ts 的 IpcContext）。
  registerIpc({
    settings,
    ptySessions,
    dshManager,
    archiveManager,
    pluginManager,
    envDoctor,
    envFixRunner,
    nodeInstaller,
    updater,
    theme,
    external,
    send: sendToRenderer,
    getWindow: () => mainWindow,
    pendingCloseAsk: () => pendingCloseAsk,
    renderer: {
      isConnected: () => rendererConnected,
      markConnected: () => {
        rendererConnected = true;
      },
    },
    extraSessions,
    shells: { next: () => ++shellCounter },
  });
  embedded.wireEmbeddedRequestDiagnostics();
  embedded.watchRendererForDevReload();
  // updater.start() 放在窗口与 IPC 都就绪之后：它可能立刻广播一次 unsupported 状态
  updater.start();
  // 启动后 1.5 秒在后台跑一轮环境自检：不 await、不阻塞启动，也不碰 dsh 进程本身。
  // 挑 1.5 秒是为了避开启动那几秒的端口探测与健康轮询（那一会儿子进程已经够多了）。
  const envProbeTimer = setTimeout(() => {
    void envDoctor.report().catch((error: unknown) => {
      dshManager.log('warn', `环境自检没能完成：${messageOf(error)}`);
    });
  }, 1500);
  envProbeTimer.unref?.();

  const info = theme.themeInfo();
  dshManager.startPolling();
  dshManager.log(
    'info',
    `DSH Console 已启动（Electron ${process.versions.electron} / Node ${process.versions.node}）`,
  );
  dshManager.log('info', `内嵌页 UA：${app.userAgentFallback}`);
  dshManager.log(
    'info',
    `界面主题：${info.mode}（当前为${info.resolved === 'dark' ? '深色' : '亮色'}）`,
  );
  if (settings.migration) {
    dshManager.log(
      'info',
      `设置已从 v${settings.migration.from} 迁移到 v${settings.migration.to}：启动行为改为「自动拉起 dsh + 自动进 DeepSeek Harness + 自动全屏」`,
    );
  }

  const launch = dshManager.describeLaunch();
  if (launch.kind === 'error') {
    dshManager.log('error', `未找到可用的 dsh 命令：${launch.error}`);
  } else {
    dshManager.log('info', `dsh 启动命令: ${launch.display}`);
  }

  // 首启门禁的启动决策（冻结 §2.3 / R-14）：**先探测再决定要不要自动拉起 dsh**。
  //
  // 用的是"快速探测"（只读文件系统、不起子进程、毫秒级）：在健康机器上不该为了判定多等
  // 几百毫秒到几秒；而"纯净机器"的判据（找不到 node）本来就是文件系统事实。
  // 判定仍然走**同一个** judgeEnvironment + judgeWizard —— 判据只有一处。
  //
  // 规则：只有 `blocked`（**有证据的**缺失）才不自动启动；其余（含"测不出来"的 unknown）
  // 照阶段一立即启动。1.5 秒后的完整探测照旧跑，它负责门禁层的步骤状态与横幅。
  let gateBlocked = false;
  try {
    const quickReport = judgeEnvironment(collectBootProbe(settings.all(), envRuntime()));
    gateBlocked = judgeWizard(quickReport, wizardSkips(settings)).gate === 'blocked';
  } catch (error) {
    // 判定自己出意外时照旧启动：不能因为我们的探测坏了就不给用（逃生口之外的第二道保险）
    dshManager.log('warn', `启动前的快速探测没能完成（照旧自动启动）：${messageOf(error)}`);
  }
  if (gateBlocked) {
    dshManager.log(
      'info',
      '启动前快速探测：环境还没准备好（缺少外部 Node 一类**有证据**的缺失），本次不自动启动 dsh —— 交给首启环境向导。',
    );
  }

  if (settings.get('autoStart') && !gateBlocked) {
    try {
      await dshManager.start({ allowAdopt: true });
    } catch (error) {
      dshManager.log('error', `自动启动失败：${messageOf(error)}`);
    }
  }
}

// 单实例：第二次启动只聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 先同步落一行。真机上"新版本双击没反应、过一会系统报崩溃"那次，日志里一行都没有 ——
  // 分不清是"没起来"还是"起来了但没到 ready"，就是被这一点拖住的（见 §7.24）。
  fileLog.writeLine(
    '[main] 已经有一个实例在跑（没拿到单实例锁）：本次启动直接退出，只把已有窗口叫到前面',
  );
  // 用 `exit` 而不是 `quit`：`quit` 的语义是"先关所有窗口、再走 before-quit / will-quit"，
  // 而这里**一个窗口都没有**；ready 之前调它不保证真的退，会留下一个"没窗口、没日志"的
  // 进程，在 macOS 上最后表现成系统那句"应用没有响应"。
  // `app.exit(0)` 是立刻退出、不发那两个事件（官方文档），正是这里要的语义。
  app.exit(0);
} else {
  app.on('second-instance', () => {
    // 第二次启动只是"把已经开着的那个叫到前面"：藏在托盘里的要先 show 回来
    showMainWindow();
  });

  installApplicationMenu(menuCtx);

  app.whenReady().then(() => {
    console.log(`[main] 日志文件: ${fileLog.file}`);
    applyDockIcon(menuCtx);
    void bootstrap();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
    // macOS 惯例：关掉窗口后应用留在 Dock 里，点图标由 activate 重建窗口；
    // 其它平台保持"窗口全关即退出"。
    // 注意「收起到托盘」走不到这里：那条路是把窗口 hide 起来，不是 close。
  });

  // 退出前收尾：按设置决定是否连带停掉 dsh
  app.on('before-quit', () => {
    // 先置位：close 处理器据此放行。托盘菜单的退出、更新器的 quitAndInstall()、
    // 系统关机都从 app.quit() 走，全都要能真的退掉
    isQuitting = true;
    tray?.destroy();
    tray = null;
    if (!settings || !dshManager) return;
    if (nodeInstaller) nodeInstaller.detachOnQuit();
    // 安装通道的退出收尾（冻结 §1 R-13）：下载 / 校验 → 取消并删临时文件；
    // 安装 / 等待 → 放弃引用、**不杀、不等**（安装器是独立进程，父进程退出后继续跑完）。
    // 必须在停 dsh 之前调用：它不看 dsh，也不该被下面的清理影响到。
    const killOnExit = settings.get('killOnExit');
    if (killOnExit && dshManager.ownProcess) {
      const pid = dshManager.ownedPid;
      dshManager.log('info', `应用退出：停止本应用启动的 dsh${pid ? ` (PID ${pid})` : ''}`);
      if (pid) processUtils.killTreeSync(pid);
      // PID 可能还没就绪（PTY 异步）：那时至少把 pty 子进程杀掉
      else if (ptySessions) ptySessions.kill(dshManager.sessionId, true);
    }
    if (ptySessions) ptySessions.killAll();
    dshManager.stopPolling();
    fileLog.close();
  });
}
