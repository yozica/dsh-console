/**
 * 自动更新（electron-updater）。
 *
 * 它只做三件事：把 electron-updater 的事件翻译成 shared/ipc.ts 的 UpdateState、
 * 按设置安排定时检查、把动作（检查 / 下载 / 安装）暴露给主进程的 IPC。
 *
 * 两条刻意的边界：
 *
 * 1. **不自动下载、不自动安装**：`autoDownload` / `autoInstallOnAppQuit` 都写死 false。
 *    升级会退出应用、连带停掉正在跑的 dsh，这种事不能替用户决定 —— 发现新版本只推状态，
 *    下载与安装都由用户在设置页点。
 *
 * 2. **macOS 与开发态根本不加载 electron-updater**：`require('electron-updater')` 一执行
 *    就会按平台构造 updater 单例（macOS 上是 Squirrel.Mac），而 macOS 包是 ad-hoc 签名
 *    （package.json 的 `mac.identity: "-"`），Squirrel.Mac 会拒绝安装；开发态则没有
 *    `app-update.yml`，检查必然失败。所以这两种形态连加载都不做，只回报 unsupported + 下载页
 *    （也是"不要 import 完就调用它的 API"这条要求的落地方式）。
 */

import { app, type BrowserWindow } from 'electron';
import { createRequire } from 'node:module';

import { RELEASES_URL, UPDATE_MAC_FEED_URL, type UpdateState } from '../shared/ipc';
import type { Settings } from './settings';
import type { AppUpdater, UpdateDownloadedEvent, UpdateInfo, ProgressInfo } from 'electron-updater';

/** 启动后先等几秒：那几秒在拉起 dsh，检查更新没必要跟着抢网络 */
const FIRST_CHECK_DELAY_MS = 8_000;
/** 之后每 6 小时一次（与需求一致；用户也可以在设置里关掉自动检查） */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 错误文案只留一句，太长的堆栈放进日志而不是状态里 */
const ERROR_TEXT_LIMIT = 180;
/** 轻量版本检查的超时：拿一个不到 1 KB 的 yml，慢到 15 秒就没必要再等了 */
const FEED_TIMEOUT_MS = 15_000;

export interface UpdaterOptions {
  settings: Settings;
  /** 状态变化时推给渲染层（主进程侧唯一出口，main.ts 里接 sendToRenderer） */
  sendState: (state: UpdateState) => void;
  /** 安装前确认窗口状态：quitAndInstall() 会先关掉所有窗口 */
  getWindow: () => BrowserWindow | null;
}

// ---------------------------------------------------------------- 懒加载 + 日志

/** electron-updater 的模块形状（只用于给懒加载结果一个确定的类型） */
type UpdaterModule = typeof import('electron-updater');

/**
 * 为什么用 createRequire 而不是顶层 `import { autoUpdater } from 'electron-updater'`：
 * 顶层 import 会在 macOS / 开发态也被求值，等于把 Squirrel.Mac 单例点亮（见文件头说明）。
 * createRequire 拿到的是按需 require，只在真正支持的形态里调用。
 */
const loadModule = createRequire(__filename);
let cachedModule: UpdaterModule | null = null;

function loadUpdaterModule(): UpdaterModule {
  cachedModule ??= loadModule('electron-updater') as UpdaterModule;
  return cachedModule;
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  const line = `[updater] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** 把 electron-updater 的日志参数（字符串 / Error / 对象）变成一行文本 */
function describe(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** electron-updater 的 Logger 接口：接到主进程的 console 上，落盘由 logger.ts 负责 */
const updaterLogger = {
  info: (message?: unknown) => log('info', describe(message)),
  warn: (message?: unknown) => log('warn', describe(message)),
  error: (message?: unknown) => log('error', describe(message)),
  debug: (message: string) => log('info', `debug: ${message}`),
};

// ---------------------------------------------------------------- 状态机

/** 把底层错误摘成一句中文（给用户看的那句），原始内容进日志 */
export function summarizeUpdateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const brief = raw.replace(/\s+/g, ' ').trim().slice(0, ERROR_TEXT_LIMIT);
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|net::/i.test(raw)) {
    return `网络异常，连不上更新源：${brief}`;
  }
  if (/404|latest(-mac)?\.yml|Cannot find|no published versions/i.test(raw)) {
    return `更新源上没有找到更新元数据（latest.yml）：${brief}`;
  }
  if (/signature|签名/i.test(raw)) {
    return `更新包校验失败：${brief}`;
  }
  return `检查更新失败：${brief}`;
}

/**
 * 比较两个 `x.y.z` 版本号：a > b 返回正数、相等 0、a < b 负数。
 * 只认数字段（我们发的就是这种）；预发布后缀（`-beta.1`）按"同版本"处理 —— 宁可少提示，
 * 不要因为后缀比较写错而天天提示有新版本。
 */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string): number[] =>
    String(value)
      .trim()
      .replace(/^v/i, '')
      // 预发布后缀（`0.4.1-beta.1`）按"同版本"处理：先砍掉 `-…` / `+…` 再比数字段
      .replace(/[-+].*$/, '')
      .split('.')
      .map((piece) => Number.parseInt(piece, 10))
      .map((piece) => (Number.isFinite(piece) ? piece : 0));
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** 从 `latest-mac.yml` 里取 `version:`（文件很小，不值得为它引一个 YAML 解析器） */
export function parseFeedVersion(text: string): string | null {
  const matched = /^version:\s*(\S+)\s*$/m.exec(String(text || ''));
  return matched ? matched[1] : null;
}

export class Updater {
  private readonly settings: Settings;
  private readonly sendState: (state: UpdateState) => void;
  private readonly getWindow: () => BrowserWindow | null;
  /** 只有"打包的非 macOS"上才非空；两种不支持形态下它保持 null，等于没初始化 */
  private updater: AppUpdater | null = null;
  private firstCheck: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  /** 同一时刻只允许一个动作（electron-updater 也拒绝并发检查） */
  private busy: 'check' | 'download' | null = null;
  private state: UpdateState;

  constructor(options: UpdaterOptions) {
    this.settings = options.settings;
    this.sendState = options.sendState;
    this.getWindow = options.getWindow;
    this.state = {
      phase: 'idle',
      currentVersion: app.getVersion(),
      version: null,
      percent: null,
      message: null,
      canAutoUpdate: false,
      canCheck: false,
      releasesUrl: RELEASES_URL,
    };
  }

  /** 当前状态（app:snapshot 与 IPC 的返回值都用它） */
  snapshot(): UpdateState {
    return { ...this.state };
  }

  /**
   * 启动 updater。**只在这里决定要不要加载 electron-updater**：
   * 不支持的形态直接返回 unsupported，不碰 electron-updater。
   */
  start(): UpdateState {
    const currentVersion = app.getVersion();
    if (!app.isPackaged) {
      return this.publish({
        phase: 'unsupported',
        currentVersion,
        version: null,
        percent: null,
        message: '开发态不检查更新（仅安装版可用）',
        canAutoUpdate: false,
        canCheck: false,
      });
    }
    if (process.platform === 'darwin') {
      // macOS 装不了（ad-hoc 签名），但**照样能查** —— 直接取那个不到 1 KB 的 latest-mac.yml
      // 比版本号，不碰 electron-updater / Squirrel。用户至少能在底栏看到"有新版本"。
      const state = this.publish({
        phase: 'idle',
        currentVersion,
        version: null,
        percent: null,
        message: '当前是 ad-hoc 签名，无法自动安装；有新版本会在底栏提示，点「打开下载页」手动下载',
        canAutoUpdate: false,
        canCheck: true,
      });
      this.applyAutoCheck();
      return state;
    }
    if (process.platform !== 'win32') {
      return this.publish({
        phase: 'unsupported',
        currentVersion,
        version: null,
        percent: null,
        message: '这个平台上没有可用的更新源（本项目只发 Windows 与 macOS）',
        canAutoUpdate: false,
        canCheck: false,
      });
    }

    const { autoUpdater } = loadUpdaterModule();
    // 发现新版本只提示；下载完也不在退出时偷偷装（都等用户点）
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = updaterLogger;
    this.wireEvents(autoUpdater);
    this.updater = autoUpdater;
    log('info', `自动更新已就绪，当前版本 ${currentVersion}`);

    const state = this.publish({
      phase: 'idle',
      currentVersion,
      version: null,
      percent: null,
      message: null,
      canAutoUpdate: true,
      canCheck: true,
    });
    this.applyAutoCheck();
    return state;
  }

  /** 设置里改了 autoCheckUpdates 后由 main.ts 调用：只动定时器，不动已下载的更新状态 */
  syncSettings(): void {
    this.applyAutoCheck();
  }

  /**
   * 手动检查（设置页的「检查更新」/「重试」按钮）—— 不受 autoCheckUpdates 影响。
   * Windows 交给 electron-updater；macOS 走下面那个轻量检查（装不了，但查得了）。
   */
  async checkNow(): Promise<UpdateState> {
    if (!this.state.canCheck) return this.snapshot();
    if (this.busy) return this.snapshot();
    this.busy = 'check';
    try {
      this.publish({ phase: 'checking', percent: null, message: '正在检查更新…' });
      if (this.updater) await this.updater.checkForUpdates();
      else await this.checkFeedVersion();
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy = null;
    }
    return this.snapshot();
  }

  /**
   * 轻量版本检查（macOS）：取 `latest-mac.yml`（GitHub 的 latest 别名指向最新**已发布**的
   * Release）→ 比 `version:` 与当前版本。不下载、不安装，只把结果推给界面。
   */
  private async checkFeedVersion(): Promise<void> {
    const response = await fetch(UPDATE_MAC_FEED_URL, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`取不到更新源（HTTP ${response.status}）：${UPDATE_MAC_FEED_URL}`);
    }
    const latest = parseFeedVersion(await response.text());
    if (!latest) throw new Error('更新源里没有 version 字段（latest-mac.yml 格式变了？）');
    const current = app.getVersion();
    if (compareVersions(latest, current) > 0) {
      log('info', `发现新版本 ${latest}（当前 ${current}）—— macOS 只能手动下载`);
      this.publish({
        phase: 'available',
        version: latest,
        percent: null,
        message: `发现新版本 ${latest}，点「打开下载页」下载`,
      });
      return;
    }
    this.publish({
      phase: 'idle',
      version: null,
      percent: null,
      message: `已是最新版本（${current}）`,
    });
  }

  /** 用户点了「下载」才开始下载（autoDownload 已关） */
  async download(): Promise<UpdateState> {
    if (!this.updater || this.state.phase !== 'available') return this.snapshot();
    if (this.busy) return this.snapshot();
    this.busy = 'download';
    try {
      this.publish({
        phase: 'downloading',
        percent: 0,
        message: `正在下载 ${this.state.version || '新版本'}…`,
      });
      await this.updater.downloadUpdate();
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy = null;
    }
    return this.snapshot();
  }

  /**
   * 用户点了「重启并安装」。quitAndInstall() 会关掉窗口并退出应用 ——
   * 退出清理（before-quit 里停掉本应用启动的 dsh）照常发生，这里不做别的事。
   */
  install(): boolean {
    const updater = this.updater;
    if (!updater || this.state.phase !== 'downloaded') return false;
    log('info', `退出并安装 ${this.state.version || '新版本'}`);
    const win = this.getWindow();
    if (win && !win.isDestroyed() && win.isMinimized()) win.restore();
    updater.quitAndInstall();
    return true;
  }

  // ------------------------------------------------------------ 内部

  private wireEvents(autoUpdater: AppUpdater): void {
    autoUpdater.on('checking-for-update', () => {
      this.publish({ phase: 'checking', percent: null, message: '正在检查更新…' });
    });
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      log('info', `发现新版本 ${info.version}（当前 ${app.getVersion()}）`);
      this.publish({
        phase: 'available',
        version: String(info.version),
        percent: null,
        message: `发现新版本 ${info.version}`,
      });
    });
    autoUpdater.on('update-not-available', () => {
      this.publish({ phase: 'idle', percent: null, message: '已是最新版本' });
    });
    autoUpdater.on('download-progress', (info: ProgressInfo) => {
      const percent = Math.max(0, Math.min(100, Math.round(info.percent)));
      this.publish({ phase: 'downloading', percent, message: `正在下载… ${percent}%` });
    });
    autoUpdater.on('update-downloaded', (info: UpdateDownloadedEvent) => {
      log('info', `更新已下载：${info.version}`);
      this.publish({
        phase: 'downloaded',
        version: String(info.version),
        percent: 100,
        message: '已下载，重启后安装',
      });
    });
    autoUpdater.on('error', (error: Error) => {
      this.fail(error);
    });
  }

  /** 定时检查：启动后延迟一次，之后每 6 小时一次；设置关掉就停 */
  private applyAutoCheck(): void {
    const wanted = this.state.canCheck && Boolean(this.settings.get('autoCheckUpdates'));
    if (!wanted) {
      this.clearTimers();
      return;
    }
    if (this.interval) return;
    // unref：这是"后台节拍"，不该成为进程退出的阻碍
    this.firstCheck = setTimeout(() => {
      this.firstCheck = null;
      void this.checkNow();
    }, FIRST_CHECK_DELAY_MS);
    this.firstCheck.unref?.();
    this.interval = setInterval(() => void this.checkNow(), CHECK_INTERVAL_MS);
    this.interval.unref?.();
  }

  private clearTimers(): void {
    if (this.firstCheck) clearTimeout(this.firstCheck);
    if (this.interval) clearInterval(this.interval);
    this.firstCheck = null;
    this.interval = null;
  }

  /** 把错误摘成一句中文放进状态（同时把原始错误写进日志） */
  private fail(error: unknown): void {
    const raw = error instanceof Error ? error.stack || error.message : String(error);
    log('error', `更新失败：${raw}`);
    this.publish({ phase: 'error', message: summarizeUpdateError(error), percent: null });
  }

  private publish(patch: Partial<UpdateState>): UpdateState {
    this.state = { ...this.state, ...patch };
    this.sendState(this.snapshot());
    return this.snapshot();
  }
}

export function createUpdater(options: UpdaterOptions): Updater {
  return new Updater(options);
}
