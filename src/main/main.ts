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
  ipcMain,
  shell,
  dialog,
  nativeImage,
  nativeTheme,
  session,
  type BrowserWindowConstructorOptions,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type NativeImage,
  type WebContents,
} from 'electron';

import { Settings, type SettingsPatch, type SettingsValues } from './settings';
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
  WIZARD_STEP_IDS,
  WIZARD_STEP_LABEL,
  WIZARD_STEP_SKIPPABLE,
} from './env-doctor';
import { NodeInstaller } from './node-installer';
import { createUpdater, type Updater } from './updater';
import { describeValue, installFileLogging } from './logger';
import * as processUtils from './process-utils';
import type {
  AppSnapshot,
  ArchiveListResult,
  ArchiveReadResult,
  ArchiveRemoveResult,
  ArchiveUnarchiveResult,
  CloseAction,
  CloseAnswer,
  CloseAnswerAction,
  CloseRequest,
  ConfirmRequest,
  CreateShellResult,
  DshActionResult,
  DshExitEvent,
  DshLogEntry,
  DshOutputEvent,
  EnvFixAction,
  EnvFixState,
  EnvInfo,
  EnvInstallState,
  EnvNodePlan,
  EnvNodeRequest,
  EnvWizardState,
  EnvWizardStepId,
  PluginBundleEditResult,
  PluginInspectResult,
  PluginLayerEditAction,
  PluginLayerEditResult,
  PluginRescueResult,
  PluginOpAction,
  PluginOpResult,
  RenameSessionResult,
  ResolvedTheme,
  SessionExitEvent,
  SessionOutputEvent,
  ThemeInfo,
  ThemeMode,
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
function installCrashGuards(): void {
  const report = (kind: string, value: unknown): void => {
    console.error(`[main] ${kind}：`, value);
    const where = fileLog.file
      ? `\n\n日志文件（把下面这段内容发出来就能定位）：\n${fileLog.file}`
      : '';
    try {
      dialog.showErrorBox(`DSH Console 出错了（${kind}）`, `${describeValue(value)}${where}`);
    } catch {
      /* 连对话框都弹不出来（比如没有图形会话）：日志里已经有了 */
    }
  };
  process.on('uncaughtException', (error) => report('未捕获的异常', error));
  process.on('unhandledRejection', (reason) => report('未处理的 Promise 拒绝', reason));
}

installCrashGuards();

let mainWindow: BrowserWindow | null = null;
// 下面这几个都在 bootstrap() 里赋值；用 `!` 明确"这里不重复判空"——
// 所有 IPC handler 与事件回调都只在 bootstrap 之后才可能被触发。
/** 系统托盘：只在真的要"收起"时才建（选了直接退出的用户不该看到一个托盘图标） */
let tray: Tray | null = null;
/** 是不是"真的要退出"。before-quit 之后置位，窗口的 close 处理器据此放行 */
let isQuitting = false;
/** 关闭询问框是不是已经在显示：连点 X 不该叠出第二个对话框 */
let closeDialogOpen = false;
/**
 * 一次"问渲染层要怎么关闭"的进行中状态。
 * `ack` = 卡片已经显示了（撤掉握手时限）；`answer` = 用户选完了（传 null 表示问不到）。
 */
interface CloseAsk {
  ack: () => void;
  answer: (answer: CloseAnswer | null) => void;
}
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

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------- 主题

const THEME_MODES = ['system', 'light', 'dark'] as const;

function isThemeMode(value: string): value is ThemeMode {
  return (THEME_MODES as readonly string[]).includes(value);
}

/**
 * 窗口底色与标题栏配色：与渲染层 CSS 的 --bg / --ink 保持一致。
 * （这是主进程侧唯一的颜色重复处 —— 窗口底色和系统控件浮层只能由主进程设置。）
 */
const WINDOW_BG: Record<ResolvedTheme, string> = { dark: '#0a0c10', light: '#eef1f5' };
const TITLEBAR_COLORS: Record<ResolvedTheme, { color: string; symbolColor: string }> = {
  dark: { color: '#0a0c10', symbolColor: '#e8eaf0' },
  light: { color: '#eef1f5', symbolColor: '#131a26' },
};
/** 标题栏高度：和渲染层的 --bar-h 对齐，否则系统控件会和顶栏错位 */
const TITLEBAR_HEIGHT = 36;

/** 渲染层产物目录：Vite 构建输出（npm start 会先构建），主进程从这里加载页面 */
const RENDERER_DIST = path.join(__dirname, '..', '..', 'dist', 'renderer');

/** 当前主题：mode 是用户选择，resolved 是实际生效的明暗 */
function themeInfo(): ThemeInfo {
  const mode = String(settings?.get('themeMode') || 'system');
  return {
    mode: isThemeMode(mode) ? mode : 'system',
    resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
  };
}

/** 把设置里的 mode 应用到 Electron（system 时交给系统决定） */
function applyThemeSource(mode: unknown): ThemeMode {
  const text = String(mode);
  const next: ThemeMode = isThemeMode(text) ? text : 'system';
  if (nativeTheme.themeSource !== next) nativeTheme.themeSource = next;
  return next;
}

/**
 * 系统控件浮层的配色（最小化/最大化/关闭由 Windows 画在右上角，颜色得由我们给）。
 * 窗口不是用 titleBarOverlay 建的、或平台不支持时（macOS 用红绿灯，没有浮层），
 * 这里会抛异常，直接吞掉即可。
 */
function applyTitleBarOverlay(resolved: ResolvedTheme): void {
  if (isMac) return; // macOS 的红绿灯由系统绘制在左上角，没有 titleBarOverlay
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const colors = TITLEBAR_COLORS[resolved] || TITLEBAR_COLORS.dark;
  try {
    mainWindow.setTitleBarOverlay({ ...colors, height: TITLEBAR_HEIGHT });
  } catch {
    /* 没有启用 titleBarOverlay 时忽略 */
  }
}

function broadcastTheme(): ThemeInfo {
  const info = themeInfo();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(WINDOW_BG[info.resolved]);
    applyTitleBarOverlay(info.resolved);
  }
  sendToRenderer('theme:changed', info);
  return info;
}

// ---------------------------------------------------------------- 内嵌页诊
interface ConsoleMessageInfo {
  level: string;
  message: string;
  source: string;
  line: number;
}

/**
 * Electron 新旧版本的 console-message 参数形状不同（新版第一个参数是 details 对象，
 * 旧版是 level/message/line/sourceId 五个位置参数），这里统一取出来。
 */
function readConsoleMessage(args: unknown[]): ConsoleMessageInfo {
  const details = args[0] as
    { level?: unknown; message?: unknown; sourceId?: unknown; lineNumber?: unknown } | undefined;
  if (details && typeof details === 'object' && 'message' in details) {
    return {
      level: String(details.level ?? 'info'),
      message: String(details.message ?? ''),
      source: String(details.sourceId ?? ''),
      line: Number(details.lineNumber ?? 0),
    };
  }
  const legacy = args as [unknown, unknown, unknown, unknown, unknown];
  return {
    level: ['debug', 'info', 'warning', 'error'][Number(legacy[1])] || 'info',
    message: String(legacy[2] ?? ''),
    source: String(legacy[4] ?? ''),
    line: Number(legacy[3] ?? 0),
  };
}

/** 抹掉 UA 里的 Electron 与包名 —— 不少第三方站点据此判定"不是正经浏览器" */
function cleanedUserAgent(ua: string): string {
  return String(ua)
    .replace(/\s*(dsh-console|Electron)\/[\d.]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const EMBEDDED_LABELS: Record<string, string> = {
  'persist:dsh-ui': '内嵌 DSH 界面',
  'persist:deepseek': 'DeepSeek 用量页',
};

function embeddedLabel(partition: string): string {
  return EMBEDDED_LABELS[partition] || '内嵌页';
}

/**
 * Electron 自身的开发期安全提示（allowpopups / CSP 那几条）内容很长，会把事件日志刷屏，
 * 而且打包后就不会再出现。所以不进日志，只在终端里提一次。
 */
const seenDevWarnings = new Set<string>();
function suppressElectronDevNoise(message: string): boolean {
  if (!/Electron Security Warning/i.test(message)) return false;
  const key = String(message).slice(0, 60);
  if (!seenDevWarnings.has(key)) {
    seenDevWarnings.add(key);
    console.log('[renderer] 已忽略 Electron 开发期安全提示（打包后不再出现）');
  }
  return true;
}

/**
 * 内嵌第三方页面出问题时最爱"半渲染"：外壳画出来、内容一片空，页面上什么错都不说。
 * 所以把 guest 的 console 与加载失败都收进应用的事件日志里。
 */
function wireGuestDiagnostics(guest: WebContents): void {
  let partition: string;
  try {
    // getPartition 没进 Electron 的类型声明（运行时存在），按可选方法取
    const sessionLike = guest.session as unknown as { getPartition?: () => string };
    partition = sessionLike.getPartition?.() || '';
  } catch {
    partition = '';
  }
  const label = embeddedLabel(partition);

  guest.on('console-message', (...args: unknown[]) => {
    const info = readConsoleMessage(args);
    if (suppressElectronDevNoise(info.message)) return;
    if (info.level === 'error') dshManager.log('error', `${label} 控制台报错：${info.message}`);
    else if (info.level === 'warning')
      dshManager.log('warn', `${label} 控制台警告：${info.message}`);
  });

  guest.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (code === -3) return; // 被新导航取代，属正常
    dshManager.log(
      'error',
      `${label} ${isMainFrame === false ? '子框架' : '页面'}加载失败 ${code} ${description} ${url}`,
    );
  });

  guest.on('render-process-gone', (_event, details) => {
    dshManager.log('error', `${label} 渲染进程退出：${details?.reason || '未知原因'}`);
  });
}

/** 内嵌页发出的请求失败时也记一笔（CSP 拦截、DNS、连接被重置都会走这里） */
function wireEmbeddedRequestDiagnostics(): void {
  for (const partition of Object.keys(EMBEDDED_LABELS)) {
    try {
      session
        .fromPartition(partition)
        .webRequest.onErrorOccurred({ urls: ['*://*/*'] }, (details) => {
          if (/ERR_ABORTED/.test(details.error)) return; // 导航被取代 / 主动取消
          const short = details.url.length > 120 ? `${details.url.slice(0, 117)}…` : details.url;
          dshManager.log('warn', `${embeddedLabel(partition)} 请求失败 ${details.error} ${short}`);
        });
    } catch (error) {
      console.error(
        `[main] 无法为 ${partition} 安装请求诊断:`,
        error instanceof Error ? error.message : String(error),
      );
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
function watchRendererForDevReload(): void {
  if (app.isPackaged) return;
  const rendererDir = RENDERER_DIST;
  if (!fs.existsSync(rendererDir)) return;
  let timer: NodeJS.Timeout | null = null;
  try {
    fs.watch(rendererDir, { recursive: true }, (_event, filename) => {
      const name = String(filename || '');
      if (!/\.(js|css|html)$/i.test(name)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        dshManager.log('info', `渲染层产物变化（${name}），自动重载窗口`);
        mainWindow.webContents.reload();
      }, 250);
    });
  } catch (error) {
    console.error(
      '[main] 无法监听渲染层目录:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function createWindow(): void {
  const resolved = themeInfo().resolved;
  // 标题栏策略按平台走：
  //  - Windows/Linux：hidden + titleBarOverlay，最小化/最大化/关闭由系统画在右上角浮层
  //  - macOS：hiddenInset + 红绿灯（trafficLightPosition 把红绿灯对准 36px 顶栏的中心）
  const titleBarOptions: BrowserWindowConstructorOptions = isMac
    ? {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 14, y: Math.round((TITLEBAR_HEIGHT - 14) / 2) },
      }
    : {
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          ...(TITLEBAR_COLORS[resolved] || TITLEBAR_COLORS.dark),
          height: TITLEBAR_HEIGHT,
        },
      };
  const win = new BrowserWindow({
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
    void shell.openExternal(url);
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
      void shell.openExternal(url);
      return { action: 'deny' };
    });
    // 内嵌页也要能单独开开发者工具：半渲染、空白这类问题都在它自己那一侧
    wireDevTools(guest);
    wireGuestShortcuts(guest);
    wireGuestDiagnostics(guest);
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
function makeIcon(): NativeImage | undefined {
  try {
    const file = path.join(__dirname, '..', '..', 'build', 'icon.png');
    if (fs.existsSync(file)) {
      const image = nativeImage.createFromPath(file);
      if (!image.isEmpty()) return image;
    }
  } catch {
    // 读不到就用系统默认图标，不影响运行
  }
  return undefined;
}

/** macOS 开发态：Dock 图标取自同一张源图（打包后由 .icns 提供，不必覆盖） */
function applyDockIcon(): void {
  if (!isMac || app.isPackaged || !app.dock) return;
  const icon = makeIcon();
  if (icon) {
    try {
      app.dock.setIcon(icon);
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
function installApplicationMenu(): void {
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

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

/**
 * 应用自带的运行时版本（快照的 `env.versions`，也是自检里「应用自带运行时」那一项的事实来源）。
 * 刻意只有这一处：两处各读一遍 `process.versions` 迟早会漂移，而这一项的价值就是"记录事实"。
 */
function bundledVersions(): { electron: string; node: string; chrome: string } {
  return {
    electron: String(process.versions.electron ?? ''),
    node: String(process.versions.node ?? ''),
    chrome: String(process.versions.chrome ?? ''),
  };
}

// ---------------------------------------------------------------- 首启环境向导（门禁）的编排件

/**
 * 全局忙位：两个会动系统的入口共用**一把**锁（冻结 §4.4 / R-06）。
 * 既有的一键修复（改全局 npm 包）与安装通道（装 / 更新 Node）同时只能有一个在跑 ——
 * 两个动作一起改一台机器，结果不可预期。`detached`（我们不等了、但安装可能还在后台跑）
 * 仍然算忙：那是 `nodeInstaller.busy()` 自己的语义（R-06）。
 */
function anyoneBusy(): boolean {
  return envFixRunner.busy || nodeInstaller.busy();
}

/** 忙的时候那句统一的回话（与交互 §2.9 里按钮 `title` 的那句**同一句**） */
const BUSY_MESSAGE = '正在执行上一步的操作，完成后按钮会自动恢复';

/**
 * 安装 / 更新的请求解析：**只认这三个字段**（冻结 §3.2.1 的形状 `{ mode, method?, channel? }`）。
 *
 * 渲染层只递选择，地址、版本、sha256 全部由主进程现场重算（与 `env:fix` 只收 action 同一条原则）——
 * 线缆上多出来的字段一概不看，写在这里就不会有人"顺手"采信渲染层递回来的 URL。
 *
 * `method` / `channel` **省略是合法的**：省略 = 跟随归属 / 跟随档位（VM-14 与 VM-15 的根治点）。
 * 只有显式给值才是"用户点名的那条路 / 那次换档"。
 */
function parseNodeRequest(request: unknown): EnvNodeRequest | null {
  const { method, mode, channel } = (request ?? {}) as {
    method?: unknown;
    mode?: unknown;
    channel?: unknown;
  };
  if (mode !== 'install' && mode !== 'update') return null;
  if (method !== undefined && method !== 'direct' && method !== 'nvm') return null;
  if (channel !== undefined && channel !== 'lts' && channel !== 'current') return null;
  const parsed: EnvNodeRequest = { mode };
  if (method !== undefined) parsed.method = method;
  if (channel !== undefined) parsed.channel = channel;
  return parsed;
}

/** 被拒的回话：业务失败是状态里的 `phase: 'error'` + 一句中文，不抛（照阶段一 `env:fix`） */
function refusedInstallState(message: string): EnvInstallState {
  return { ...nodeInstaller.state(), phase: 'error', message };
}

/**
 * 读设置里的「已跳过的步骤」。
 *
 * 设置文件是**用户手改得动**的：`"envSkips": null`（或写成字符串 / 数字）真的会出现，
 * 而 TS 的类型并不成立在运行期。这里在过线缆之前先把形状收回来 —— 判定函数自己也守着一层
 *（`judgeWizard` 对任何输入都不抛），两层都留着：一层不让坏形状往外走，一层保证结论一定有。
 */
function wizardSkips(): EnvWizardStepId[] {
  const value: unknown = settings.get('envSkips');
  return Array.isArray(value) ? (value as EnvWizardStepId[]) : [];
}

function registerIpc(): void {
  ipcMain.handle('app:snapshot', (): AppSnapshot => {
    if (!rendererConnected) {
      rendererConnected = true;
      console.log('[main] 渲染层已连接');
    }
    const env: EnvInfo = {
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
      nativeFullscreen: Boolean(
        mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen(),
      ),
      versions: bundledVersions(),
    };
    return {
      dsh: dshManager.snapshot(),
      settings: settings.all(),
      sessions: ptySessions.list(),
      launch: dshManager.describeLaunch(),
      env,
      update: updater.snapshot(),
      userData: app.getPath('userData'),
      theme: themeInfo(),
    };
  });

  ipcMain.handle('theme:set', (_event: IpcMainInvokeEvent, mode: unknown): ThemeInfo => {
    const next = applyThemeSource(mode);
    settings.patch({ themeMode: next });
    dshManager.log(
      'info',
      `界面主题：${next}${next === 'system' ? `（当前为${nativeTheme.shouldUseDarkColors ? '深色' : '亮色'}）` : ''}`,
    );
    return broadcastTheme();
  });

  ipcMain.handle(
    'settings:patch',
    (_event: IpcMainInvokeEvent, patch: SettingsPatch): SettingsValues => {
      const next = settings.patch(patch);
      if (patch && 'themeMode' in patch) applyThemeSource(next.themeMode);
      // 设置页里也能改主题，保持与工具栏开关一致
      dshManager.syncSettings();
      // 自动检查更新是开关式的：改完要立刻生效（开 → 排定时器，关 → 停）
      updater.syncSettings();
      dshManager.log('info', '设置已保存');
      broadcastTheme();
      // 渲染层那份快照是共享状态的唯一真源：主进程写完必须推一次，否则"另一个组件读到旧值"。
      // 实例：环境自检页改「Node 下载来源」，首启门禁的确认区读的是同一份快照 ——
      // 不推的话那次保存只有发起方自己知道，门禁区会拿旧源拼计划说明。
      sendToRenderer('settings:changed', next);
      // 自检报告缓存要根据这几项失效：它们决定"怎么调 dsh / 在哪跑 / 用哪个 Shell"。
      // 这里**不主动重跑**（用户此刻在设置页，切到自检页时自然会拿到新结论）。
      if (patch && ('dshCommand' in patch || 'cwd' in patch || 'shell' in patch)) {
        envDoctor.invalidate();
      }
      return next;
    },
  );

  ipcMain.handle('dsh:start', async (): Promise<DshActionResult> => {
    try {
      return { ok: true, state: await dshManager.start({ allowAdopt: true }) };
    } catch (error) {
      return { ok: false, error: messageOf(error), state: dshManager.snapshot() };
    }
  });

  ipcMain.handle(
    'dsh:stop',
    async (_event: IpcMainInvokeEvent, options?: { force?: boolean; killExternal?: boolean }) => {
      try {
        return {
          ok: true,
          state: await dshManager.stop({
            force: Boolean(options?.force),
            killExternal: Boolean(options?.killExternal),
          }),
        };
      } catch (error) {
        return { ok: false, error: messageOf(error), state: dshManager.snapshot() };
      }
    },
  );

  ipcMain.handle('dsh:restart', async (): Promise<DshActionResult> => {
    try {
      return { ok: true, state: await dshManager.restart() };
    } catch (error) {
      return { ok: false, error: messageOf(error), state: dshManager.snapshot() };
    }
  });

  ipcMain.handle('dsh:input', (_event: IpcMainInvokeEvent, data: unknown): boolean => {
    dshManager.write(String(data ?? ''));
    return true;
  });

  ipcMain.handle(
    'dsh:resize',
    (_event: IpcMainInvokeEvent, size?: { cols?: number; rows?: number }): boolean => {
      dshManager.resize(Number(size?.cols), Number(size?.rows));
      return true;
    },
  );

  ipcMain.handle('dsh:replay', (): string => dshManager.replay());

  ipcMain.handle(
    'shell:create',
    (_event: IpcMainInvokeEvent, size?: { cols?: number; rows?: number }): CreateShellResult => {
      const id = `shell-${++shellCounter}`;
      const target = processUtils.resolveShell(settings.all());
      const cwd = String(settings.get('cwd') || '') || processUtils.homeDir();
      // 标题由主进程持有（渲染层只显示），可以重命名；它只活在本次运行里 ——
      // 本地 Shell 不做任何持久化，下次启动就是全新的一页。
      const label = `Shell ${shellCounter}`;
      const cols = Number(size?.cols) || 120;
      const rows = Number(size?.rows) || 30;
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
          meta: { kind: 'shell', label, command: target.display, cwd, cols, rows },
        });
        extraSessions.add(id);
        return { ok: true, id, label, command: target.display };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
  );

  ipcMain.handle(
    'session:input',
    (_event: IpcMainInvokeEvent, payload?: { id?: string; data?: string }): boolean => {
      ptySessions.write(String(payload?.id), String(payload?.data ?? ''));
      return true;
    },
  );

  ipcMain.handle(
    'session:resize',
    (
      _event: IpcMainInvokeEvent,
      payload?: { id?: string; cols?: number; rows?: number },
    ): boolean => {
      ptySessions.resize(String(payload?.id), Number(payload?.cols), Number(payload?.rows));
      return true;
    },
  );

  ipcMain.handle('session:kill', (_event: IpcMainInvokeEvent, id: unknown): boolean => {
    const killed = ptySessions.kill(String(id), true);
    extraSessions.delete(String(id));
    return killed;
  });

  /** 重命名本地 Shell 的标题：只活在本次运行里（终端标题由主进程持有，渲染层只显示） */
  ipcMain.handle(
    'session:rename',
    (
      _event: IpcMainInvokeEvent,
      payload?: { id?: string; label?: string },
    ): RenameSessionResult => {
      const id = String(payload?.id || '');
      const label = String(payload?.label || '')
        .trim()
        .slice(0, 40);
      if (!id || !label) return { ok: false, error: '名字不能为空' };
      ptySessions.rename(id, label);
      return { ok: true, id, label };
    },
  );

  ipcMain.handle('app:openExternal', async (_event: IpcMainInvokeEvent, url?: string) => {
    const target = url || dshManager.uiUrl || dshManager.origin;
    await shell.openExternal(target);
    return target;
  });

  ipcMain.handle('app:revealUserData', () => shell.openPath(app.getPath('userData')));

  ipcMain.handle('app:confirm', async (_event: IpcMainInvokeEvent, payload?: ConfirmRequest) => {
    const options: MessageBoxOptions = {
      type: payload?.type || 'question',
      buttons: payload?.buttons || ['取消', '确定'],
      defaultId: 1,
      cancelId: 0,
      title: payload?.title || '确认',
      message: payload?.message || '',
      detail: payload?.detail || '',
    };
    // 窗口可能已经关了：那时退化成不带父窗口的对话框（原来的写法也是这么兜的）
    const result =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
    return result.response === 1;
  });

  // ---------------------------------------------------------------- 自动更新
  // 状态机在 main/updater.ts；这里只转发三个动作，状态变化由 updater 广播 app:update。
  ipcMain.handle('app:update-check', (): Promise<UpdateState> => updater.checkNow());

  ipcMain.handle('app:update-download', (): Promise<UpdateState> => updater.download());

  ipcMain.handle('app:update-install', (): boolean => updater.install());

  // ---------------------------------------------------------------- 关闭确认
  // 询问卡片在渲染层（shell/CloseDialog.vue）：主进程把"哪个 dsh 会受影响"这几项事实给它，
  // 它先回一条"卡片显示了"（撤掉握手时限），再把用户的选择答回来。
  // 没有进行中的询问时（例如已经被兜底或已回答过）两个 handler 都返回 false。
  ipcMain.handle('app:close-ack', (): boolean => {
    if (!pendingCloseAsk) return false;
    pendingCloseAsk.ack();
    return true;
  });

  ipcMain.handle(
    'app:close-answer',
    (_event: IpcMainInvokeEvent, answer?: CloseAnswer): boolean => {
      const ask = pendingCloseAsk;
      if (!ask) return false;
      // 渲染层传来的形状不可信：只认这三个动作，认不出来的当"取消"
      const action: CloseAnswerAction =
        answer &&
        (answer.action === 'tray' || answer.action === 'quit' || answer.action === 'cancel')
          ? answer.action
          : 'cancel';
      ask.answer({ action, remember: Boolean(answer?.remember) });
      return true;
    },
  );

  // ---------------------------------------------------------------- 归档会话
  // 这些操作直接读写 DSH 磁盘数据；正在运行的 dsh 会把 workspace.json 读进内存，
  // 所以改动要等 dsh 重启后才同步到界面里 —— 返回里的 dshRunning 让渲染层据此提示。
  ipcMain.handle('archive:list', (): ArchiveListResult => {
    try {
      return {
        ok: true,
        ...archiveManager.homeInfo(),
        dshRunning: dshManager.sessionAlive,
        sessions: archiveManager.list(),
      };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  });

  ipcMain.handle('archive:read', (_event: IpcMainInvokeEvent, id: unknown): ArchiveReadResult => {
    try {
      return { ok: true, session: archiveManager.read(String(id)) };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  });

  ipcMain.handle(
    'archive:unarchive',
    (_event: IpcMainInvokeEvent, id: unknown): ArchiveUnarchiveResult => {
      try {
        return {
          ok: true,
          dshRunning: dshManager.sessionAlive,
          ...archiveManager.unarchive(String(id)),
        };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
  );

  ipcMain.handle(
    'archive:remove',
    (_event: IpcMainInvokeEvent, id: unknown): ArchiveRemoveResult => {
      try {
        return {
          ok: true,
          dshRunning: dshManager.sessionAlive,
          ...archiveManager.remove(String(id)),
        };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
  );

  ipcMain.handle('plugin:inspect', async (): Promise<PluginInspectResult> => {
    // ---------------------------------------------------------------- 插件装配层
    // 只读：读 profile 的 package.json + 跑一次 `dsh web --dump-config`。
    // dsh 没在跑也要能用 —— 插件把启动打挂时，这一页恰恰是唯一的入口。
    try {
      return await pluginManager.inspect();
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  });

  // 装 / 卸 / 升级：走 `dsh plugin --profile web …`，输出边跑边推给渲染层。
  // 这三个都改 package.json 与 node_modules，所以做完要重启 dsh 才生效（界面负责提示）。
  ipcMain.handle(
    'plugin:run',
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<PluginOpResult> => {
      try {
        const { action, spec } = (request ?? {}) as { action?: PluginOpAction; spec?: string };
        if (action !== 'add' && action !== 'remove' && action !== 'update') {
          return { ok: false, error: '不认识的操作' };
        }
        return await pluginManager.runOperation(action, String(spec ?? ''), (chunk) =>
          sendToRenderer('plugin:output', { chunk }),
        );
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
  );

  ipcMain.handle('plugin:cancel', (): boolean => pluginManager.cancelOperation());

  // 救援：只看 dsh 自带的组合结果。配置被改坏时 --dump-config 会整条失败，这条通常还能成，
  ipcMain.handle('plugin:default-config', async (): Promise<PluginInspectResult> => {
    // 所以它是"插件页在配置坏掉时仍然可用"的兜底（见 §救援流程）。
    try {
      return await pluginManager.baseline();
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  });

  // 救援：把你的补丁层修回可用状态（补空数组 / 列备份 / 从备份恢复）。
  // 这些是"修"不是"编辑"：能不动就不动，真要动也先备份。
  ipcMain.handle(
    'plugin:rescue',
    (_event: IpcMainInvokeEvent, request: unknown): PluginRescueResult => {
      try {
        const { action, backup } = (request ?? {}) as {
          action?: 'repair-empty' | 'list-backups' | 'restore-backup';
          backup?: string;
        };
        if (action !== 'repair-empty' && action !== 'list-backups' && action !== 'restore-backup') {
          return { ok: false, error: '不认识的操作' };
        }
        const result = pluginManager.rescue(action, backup ? String(backup) : undefined);
        if (action !== 'list-backups') {
          dshManager.log(
            'info',
            result.changed
              ? `补丁层已修复：${result.detail ?? action}`
              : `补丁层未改动：${result.detail ?? action}`,
          );
        }
        return result;
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
  );

  // 救援：临时停用 / 恢复一个 bundle。改的是 profile 的 package.json（备份 + 原子写），
  // 而且**要重启 dsh 才生效**（bundle 列表是启动时读的），界面负责说清这一点。
  ipcMain.handle(
    'plugin:bundle-edit',
    (_event: IpcMainInvokeEvent, request: unknown): PluginBundleEditResult => {
      try {
        const { action, name, index } = (request ?? {}) as {
          action?: 'suspend' | 'restore';
          name?: string;
          index?: number;
        };
        if (action !== 'suspend' && action !== 'restore')
          return { ok: false, error: '不认识的操作' };
        const result = pluginManager.editBundle(action, String(name ?? ''), Number(index ?? -1));
        dshManager.log(
          'info',
          result.changed
            ? `bundle ${action === 'suspend' ? '已临时停用' : '已恢复'}：${result.detail ?? name}`
            : `bundle 未改动：${result.detail ?? name}`,
        );
        return result;
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
  );

  // 改你自己的补丁层（插入 / 禁用 / 启用 / 移除插入）：只动 profile 的 cordis.patch.yml，
  // 写之前备份。这一层是 patchReload: live —— 改完即时生效，不用重启 dsh。
  ipcMain.handle(
    'plugin:edit-layer',
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<PluginLayerEditResult> => {
      try {
        const { action, id, name } = (request ?? {}) as {
          action?: PluginLayerEditAction;
          id?: string;
          name?: string;
        };
        if (
          action !== 'disable' &&
          action !== 'enable' &&
          action !== 'insert' &&
          action !== 'remove-insert'
        ) {
          return { ok: false, error: '不认识的操作' };
        }
        const result = await pluginManager.editLayer({ action, id: String(id ?? ''), name });
        dshManager.log(
          'info',
          result.changed
            ? `补丁层已更新：${result.detail ?? action}（${result.file ?? ''}）`
            : `补丁层未改动：${result.detail ?? action}`,
        );
        return result;
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
  );

  // ---------------------------------------------------------------- 运行环境自检 + 一键修复
  // 报告不进快照：探测要起子进程（各 8 秒超时），塞进 app:snapshot 会把它拖成秒级。
  // 渲染层走 envCheck() 拉一份（有缓存立刻给），修复过程中的复检结果随 env:fix-state 回来。
  ipcMain.handle(
    'env:check',
    async (_event: IpcMainInvokeEvent, options?: { refresh?: boolean }) => {
      return await envDoctor.report(Boolean(options?.refresh));
    },
  );

  // 只接受 action：命令（file / args）由主进程用 fixPlan() 现场重算，
  // 渲染层递回来的路径一概不采信（与 7.18「救援时渲染层递来的路径不可信」同一条原则）。
  ipcMain.handle(
    'env:fix',
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<EnvFixState> => {
      const { action } = (request ?? {}) as { action?: EnvFixAction };
      if (action !== 'install-pnpm' && action !== 'install-dsh') {
        return { ...envFixRunner.state(), phase: 'error', message: '不认识的修复动作' };
      }
      // 与安装通道共用一把锁（冻结 §4.4）：忙则一个字都不写，把当前状态与原因回给界面
      if (anyoneBusy()) {
        return { ...envFixRunner.state(), phase: 'error', message: BUSY_MESSAGE };
      }
      try {
        return await envFixRunner.run(action);
      } catch (error) {
        const message = `修复没能开始：${messageOf(error)}`;
        dshManager.log('error', `环境修复失败：${message}`);
        return { ...envFixRunner.state(), phase: 'error', message };
      }
    },
  );

  ipcMain.handle('env:fix-cancel', (): boolean => envFixRunner.cancel());

  // ---------------------------------------------------------------- 首启环境向导（门禁）
  // 门禁结论靠 `envWizard` 拉取，**复用既有的报告缓存**（不新增探测路径、不新增报告事件）；
  // 安装过程照 `env:fix-*` 的做法用事件推（`env:install-state` / `env:install-output`）。
  ipcMain.handle(
    'env:wizard',
    async (
      _event: IpcMainInvokeEvent,
      options?: { refresh?: boolean },
    ): Promise<EnvWizardState> => {
      const report = await envDoctor.report(Boolean(options?.refresh));
      return judgeWizard(report, wizardSkips());
    },
  );

  ipcMain.handle(
    'env:wizard-skip',
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<EnvWizardState> => {
      const { step, skip } = (request ?? {}) as { step?: EnvWizardStepId; skip?: boolean };
      if (step !== undefined && WIZARD_STEP_IDS.includes(step) && WIZARD_STEP_SKIPPABLE[step]) {
        // 未知 step 与不可跳过的 step（node / dsh）都是**幂等忽略**：一个字都不写，返回当前状态。
        // 反绕过：设置里塞了 node / dsh 也一样不生效（判定函数那边同样忽略）。
        const next = new Set(wizardSkips());
        if (skip) next.add(step);
        else next.delete(step);
        settings.patch({ envSkips: WIZARD_STEP_IDS.filter((id) => next.has(id)) });
        dshManager.log(
          'info',
          `环境向导：${skip ? '跳过' : '恢复'}「${WIZARD_STEP_LABEL[step]}」（设置项 envSkips）`,
        );
        // 设置是主进程写的，渲染层那份快照要跟着刷新（"已跳过"标记在向导、自检页、放行页三处都要一致）
        sendToRenderer('settings:changed', settings.all());
      }
      const report = await envDoctor.report();
      return judgeWizard(report, wizardSkips());
    },
  );

  // ---------------------------------------------------------------- Node 安装 / 更新通道
  ipcMain.handle(
    'env:node-plan',
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<EnvNodePlan | null> => {
      const parsed = parseNodeRequest(request);
      if (!parsed) {
        dshManager.log(
          'warn',
          '安装计划：不认识的选择（install|update 必需；method 可省略 = 跟随归属，给值只认 direct|nvm）',
        );
        return null;
      }
      try {
        return await nodeInstaller.plan(parsed);
      } catch (error) {
        dshManager.log('error', `安装计划没能取到：${messageOf(error)}`);
        return null;
      }
    },
  );

  ipcMain.handle(
    'env:node-install',
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<EnvInstallState> => {
      const parsed = parseNodeRequest(request);
      if (!parsed)
        return refusedInstallState(
          '不认识的操作：安装只接受 install|update（method 可省略 = 跟随归属）',
        );
      if (anyoneBusy()) return refusedInstallState(BUSY_MESSAGE);
      try {
        return await nodeInstaller.run(parsed);
      } catch (error) {
        // 引擎的业务失败不抛（终态是 phase: 'error'），走到这里说明是意外
        const message = `安装没能开始：${messageOf(error)}`;
        dshManager.log('error', `Node 安装失败：${message}`);
        return refusedInstallState(message);
      }
    },
  );

  ipcMain.handle('env:node-stop', (): EnvInstallState => nodeInstaller.stop());
  // 停止：下载 / 校验 = 真取消并删临时文件；安装 / 等待 = 只停止等待（**不杀安装器**）。
  // 这个语义完全由引擎的 EnvInstallState 表达（cancellable / detached），主进程不重复判断。
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

/** 统一的"把 unknown 错误取成消息" */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function bootstrap(): Promise<void> {
  settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
  // UA 要在任何请求发出之前定好：内嵌页首次导航也吃这个默认值
  // （以前是在 did-attach-webview 里改，可能晚于第一次请求）
  app.userAgentFallback = cleanedUserAgent(app.userAgentFallback);
  // 主题要在建窗口之前生效，否则会先按旧主题渲染一帧
  applyThemeSource(settings.get('themeMode'));
  nativeTheme.on('updated', () => {
    // system 模式下系统切换明暗时，把新结果推给渲染层
    const info = broadcastTheme();
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
  registerIpc();
  wireEmbeddedRequestDiagnostics();
  watchRendererForDevReload();
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

  const theme = themeInfo();
  dshManager.startPolling();
  dshManager.log(
    'info',
    `DSH Console 已启动（Electron ${process.versions.electron} / Node ${process.versions.node}）`,
  );
  dshManager.log('info', `内嵌页 UA：${app.userAgentFallback}`);
  dshManager.log(
    'info',
    `界面主题：${theme.mode}（当前为${theme.resolved === 'dark' ? '深色' : '亮色'}）`,
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
    gateBlocked = judgeWizard(quickReport, wizardSkips()).gate === 'blocked';
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

  installApplicationMenu();

  app.whenReady().then(() => {
    console.log(`[main] 日志文件: ${fileLog.file}`);
    applyDockIcon();
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
