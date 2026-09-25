/**
 * 内嵌页诊断：guest 的 console / 加载失败 / 请求失败都收进事件日志，以及开发期的产物变化自动重载。
 * t56 从 `main.ts` 拆出来。
 *
 * 内嵌第三方页面出问题时最爱"半渲染"：外壳画出来、内容一片空，页面上什么错都不说 ——
 * 所以这些"本来没人看"的信号要主动记下来。这一层不持有窗口与日志器，都通过 context 取。
 */

import fs from 'node:fs';

import { session, type BrowserWindow, type WebContents } from 'electron';

import type { LogLevel } from '../shared/ipc';

/** 内嵌页的分区 → 日志里的人话名字 */
export const EMBEDDED_LABELS: Record<string, string> = {
  'persist:dsh-ui': '内嵌 DSH 界面',
  'persist:deepseek': 'DeepSeek 用量页',
};

export function embeddedLabel(partition: string): string {
  return EMBEDDED_LABELS[partition] || '内嵌页';
}

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
export function readConsoleMessage(args: unknown[]): ConsoleMessageInfo {
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
export function cleanedUserAgent(ua: string): string {
  return String(ua)
    .replace(/\s*(dsh-console|Electron)\/[\d.]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Electron 自身的开发期安全提示（allowpopups / CSP 那几条）内容很长，会把事件日志刷屏，
 * 而且打包后就不会再出现。所以不进日志，只在终端里提一次。
 */
const seenDevWarnings = new Set<string>();
export function suppressElectronDevNoise(message: string): boolean {
  if (!/Electron Security Warning/i.test(message)) return false;
  const key = String(message).slice(0, 60);
  if (!seenDevWarnings.has(key)) {
    seenDevWarnings.add(key);
    console.log('[renderer] 已忽略 Electron 开发期安全提示（打包后不再出现）');
  }
  return true;
}

export interface EmbeddedContext {
  isPackaged: () => boolean;
  /** 渲染层产物目录（开发期监听它做自动重载） */
  rendererDist: string;
  getWindow: () => BrowserWindow | null;
  log: (level: LogLevel, text: string) => void;
}

export interface EmbeddedTools {
  wireGuestDiagnostics(guest: WebContents): void;
  wireEmbeddedRequestDiagnostics(): void;
  watchRendererForDevReload(): void;
}

export function createEmbeddedTools(ctx: EmbeddedContext): EmbeddedTools {
  /**
   * Electron 自身的开发期安全提示（allowpopups / CSP 那几条）内容很长，会把事件日志刷屏，
   * 而且打包后就不会再出现。所以不进日志，只在终端里提一次。
   */
  /** 把 guest 的 console 与加载失败都收进应用的事件日志里 */
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
      if (info.level === 'error') ctx.log('error', `${label} 控制台报错：${info.message}`);
      else if (info.level === 'warning') ctx.log('warn', `${label} 控制台警告：${info.message}`);
    });

    guest.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (code === -3) return; // 被新导航取代，属正常
      ctx.log(
        'error',
        `${label} ${isMainFrame === false ? '子框架' : '页面'}加载失败 ${code} ${description} ${url}`,
      );
    });

    guest.on('render-process-gone', (_event, details) => {
      ctx.log('error', `${label} 渲染进程退出：${details?.reason || '未知原因'}`);
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
            ctx.log('warn', `${embeddedLabel(partition)} 请求失败 ${details.error} ${short}`);
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
    if (ctx.isPackaged()) return;
    const rendererDir = ctx.rendererDist;
    if (!fs.existsSync(rendererDir)) return;
    let timer: NodeJS.Timeout | null = null;
    try {
      fs.watch(rendererDir, { recursive: true }, (_event, filename) => {
        const name = String(filename || '');
        if (!/\.(js|css|html)$/i.test(name)) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const win = ctx.getWindow();
          if (!win || win.isDestroyed()) return;
          ctx.log('info', `渲染层产物变化（${name}），自动重载窗口`);
          win.webContents.reload();
        }, 250);
      });
    } catch (error) {
      console.error(
        '[main] 无法监听渲染层目录:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return { wireGuestDiagnostics, wireEmbeddedRequestDiagnostics, watchRendererForDevReload };
}
