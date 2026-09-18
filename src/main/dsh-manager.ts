/**
 * dsh web 进程管理器：
 *  - 在 PTY 里启动 `dsh web --no-open`，于是"终端"看到的就是 dsh 本身
 *  - 轮询 HTTP 健康状态 + 端口占用，维护状态机
 *  - 支持"接管"已经在外运行的实例（不重复启动）
 *  - 停止时先 Ctrl+C 优雅退出，超时再强制结束整棵进程树
 *    （Windows 走 taskkill /T /F，macOS/Linux 走信号 —— 都在 process-utils 里）
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';

import {
  homeDir,
  isAlive,
  killTree,
  portOwnerSync,
  probeHttp,
  processNameSync,
  resolveDshInvocation,
  stripAnsi,
} from './process-utils';
import type { Settings } from './settings';
import type { PtySessions } from './pty-sessions';
import type {
  DshExitEvent,
  DshLogEntry,
  DshOutputEvent,
  DshPhase,
  DshProbeInfo,
  DshSnapshot,
  LaunchInfo,
  LogLevel,
  PortOwnerInfo,
  SessionExitEvent,
  SessionOutputEvent,
} from '../shared/ipc';

/** 状态机取值 */
export const PHASE = {
  stopped: 'stopped',
  starting: 'starting',
  running: 'running',
  degraded: 'degraded',
  stopping: 'stopping',
  external: 'external',
  conflict: 'conflict',
} as const satisfies Record<DshPhase, DshPhase>;

const MAX_LOG_ENTRIES = 300;
const MAX_BUFFER_CHUNKS = 600;
const MAX_BUFFER_BYTES = 512 * 1024;

export interface DshManagerOptions {
  settings: Settings;
  ptySessions: PtySessions;
  sessionId?: string;
}

export interface StopOptions {
  force?: boolean;
  killExternal?: boolean;
}

export class DshManager extends EventEmitter {
  private readonly settings: Settings;
  private readonly pty: PtySessions;
  readonly sessionId: string;

  phase: DshPhase = PHASE.stopped;
  // 注意：不要在这里缓存 PID。node-pty 在 Windows/ConPTY 下构造时 _pid 是 0，
  // 要等 socket 的 ready_datapipe 之后才会在同一个 IPty 对象上原地更新成真实 PID。
  // 因此"是否本应用启动"由 pty 会话是否存在决定，PID 一律按需读取（见 ownedPid getter）。
  // （macOS/Linux 的 forkpty 下 PID 是同步就绪的，同一套写法照样成立。）
  portPid: number | null = null;
  startedAt: number | null = null;
  stopping = false;
  lastExit: { code: number; signal: number | null; at: number } | null = null;
  lastError: string | null = null;
  probe: DshProbeInfo = {
    reachable: false,
    isDsh: false,
    statusCode: null,
    latencyMs: null,
    checkedAt: null,
    error: null,
  };
  portOwner: PortOwnerInfo | null = null;
  externalPid: number | null = null;
  externalName = '';
  uiUrl: string | null = null;
  effectivePort: number;
  effectiveHost: string;
  launch: LaunchInfo | null = null;
  logs: DshLogEntry[] = [];
  buffer: string[] = [];
  bufferBytes = 0;
  timer: NodeJS.Timeout | null = null;
  polling = false;
  latencyHistory: number[] = [];

  constructor(options: DshManagerOptions) {
    super();
    this.settings = options.settings;
    this.pty = options.ptySessions;
    this.sessionId = options.sessionId || 'dsh';

    this.effectivePort = Number(this.settings.get('port')) || 3080;
    this.effectiveHost = String(this.settings.get('host') || '127.0.0.1');

    this.pty.on('data', (event: SessionOutputEvent) => {
      if (event.id !== this.sessionId) return;
      this.handleOutput(event.chunk);
    });
    this.pty.on('exit', (event: SessionExitEvent) => {
      if (event.id !== this.sessionId) return;
      this.handleExit(event.exitCode, event.signal ?? null);
    });

    // 启动命令只在不启动进程时缓存一次，避免每次轮询都去遍历 PATH
    this.launch = this.describeLaunch();
  }

  // ---------------------------------------------------------------- 基础信息

  get origin(): string {
    return `http://${this.effectiveHost}:${this.effectivePort}`;
  }

  /** 本应用是否有自己拉起的 dsh 会话（唯一可信的归属判据） */
  get ownProcess(): boolean {
    if (this.pty.has(this.sessionId)) return true;
    // pty 记录已丢但进程还在（例如异常路径）：退回到已知 PID 判断
    const pid = this.ownedPid;
    return pid !== null && isAlive(pid);
  }

  /**
   * 本应用启动的 dsh 的 PID。
   * 优先读 pty 对象上的实时值（PTY 就绪后才有值），读不到时用端口占用者兜底。
   * 未知时为 null —— 调用方不要用真假值判断，要用 ownProcess。
   */
  get ownedPid(): number | null {
    const live = this.pty.pid(this.sessionId);
    if (Number.isInteger(live) && (live as number) > 0) return live;
    return this.portPid && this.portPid > 0 ? this.portPid : null;
  }

  get sessionAlive(): boolean {
    return this.ownProcess;
  }

  isRunning(): boolean {
    return (
      this.sessionAlive &&
      (this.phase === PHASE.running ||
        this.phase === PHASE.starting ||
        this.phase === PHASE.degraded)
    );
  }

  /** 启动时解析一次，界面里显示"将要执行的命令" */
  describeLaunch(): LaunchInfo {
    try {
      return resolveDshInvocation(this.settings.all());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        file: '',
        args: [],
        display: `无法解析：${message}`,
        kind: 'error',
        error: message,
      };
    }
  }

  log(level: LogLevel, text: string): void {
    const entry: DshLogEntry = { at: Date.now(), level, text };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG_ENTRIES) this.logs.splice(0, this.logs.length - MAX_LOG_ENTRIES);
    this.emit('log', entry);
  }

  snapshot(): DshSnapshot {
    return {
      phase: this.phase,
      /** 本应用自己拉起的 dsh 是否在运行（界面一律用这个判断归属，别看 pid 的真假值） */
      owned: this.ownProcess,
      sessionAlive: this.sessionAlive,
      /** 可能为 null：PTY 刚拉起、PID 还没就绪 */
      pid: this.ownedPid,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt && this.sessionAlive ? Date.now() - this.startedAt : null,
      lastExit: this.lastExit,
      lastError: this.lastError,
      host: this.effectiveHost,
      port: this.effectivePort,
      origin: this.origin,
      uiUrl: this.uiUrl,
      probe: this.probe,
      portOwner: this.portOwner,
      externalPid: this.externalPid,
      externalName: this.externalName,
      launch: this.launch || this.describeLaunch(),
      latencyHistory: this.latencyHistory.slice(-60),
      logs: this.logs.slice(-120),
    };
  }

  emitState(): void {
    this.emit('state', this.snapshot());
  }

  /** 设置变化后重新计算端点与启动命令 */
  syncSettings(): void {
    const host = String(this.settings.get('host') || '127.0.0.1');
    const port = Number(this.settings.get('port'));
    if (host !== this.effectiveHost || (Number.isInteger(port) && port !== this.effectivePort)) {
      this.effectiveHost = host;
      this.effectivePort = Number.isInteger(port) ? port : this.effectivePort;
      this.uiUrl = null;
      this.log('info', `监听端点已更新为 ${this.origin}`);
    }
    this.launch = this.describeLaunch();
    if (this.timer) this.startPolling();
    this.emitState();
  }

  // ---------------------------------------------------------------- 输出处理

  handleOutput(chunk: string): void {
    this.buffer.push(chunk);
    this.bufferBytes += chunk.length;
    while (this.buffer.length > MAX_BUFFER_CHUNKS || this.bufferBytes > MAX_BUFFER_BYTES) {
      const dropped = this.buffer.shift();
      if (dropped === undefined) break;
      this.bufferBytes -= dropped.length;
    }

    const plain = stripAnsi(chunk);
    if (plain.includes('dsh web:')) {
      const match = plain.match(/dsh web:\s+(https?:\/\/[^\s)]+)/);
      if (match && match[1] !== this.uiUrl) {
        this.uiUrl = match[1];
        this.applyUrlPort(match[1]);
        this.log('info', `捕获到 dsh Web 地址（含访问令牌）: ${maskToken(this.uiUrl)}`);
        this.emit('ui-url', this.uiUrl);
      }
    }
    const output: DshOutputEvent = { id: this.sessionId, chunk };
    this.emit('output', output);
  }

  /** 从打印的 URL 里同步真实端口（--port 0 时由系统分配） */
  applyUrlPort(url: string): void {
    try {
      const parsed = new URL(url);
      const port = Number(parsed.port);
      if (Number.isInteger(port) && port > 0 && port !== this.effectivePort) {
        this.effectivePort = port;
        this.log('info', `实际监听端口: ${port}`);
        this.emitState();
      }
    } catch {
      /* 忽略解析失败 */
    }
  }

  /**
   * 从终端缓冲里摘出"dsh 为什么退出"的那句话。
   *
   * 启动失败时 dsh 的原因只印在它自己的输出里（端口占用、npx/npm 报错、找不到配置……），
   * 而事件日志只有一句「退出码 1」—— 用户看到的就只是"启动不了"，得自己去终端页翻。
   * 这里在失败时把它带进事件日志：优先挑像报错的那一行，否则退回最后一行。
   */
  lastOutputLine(): string {
    const text = stripAnsi(this.buffer.join(''));
    const raw = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-20);
    if (raw.length === 0) return '';
    // Node 抛异常时先打「file:///… 源码行 + ^」，真正的信息在后面的 `Error: …` 里。
    // 不滤掉这几类的话，界面拿到的"原因"是一行源码（真机截图里就是
    // `if (!Array.isArray(parsed)) throw new Error(...)`，谁也看不懂）。
    const noise = (line: string) =>
      /^file:\/\//.test(line) ||
      /^at\s/.test(line) ||
      /throw new /.test(line) ||
      /\^$/.test(line) ||
      line === '';
    const lines = raw.filter((line) => !noise(line));
    if (lines.length === 0) return raw[raw.length - 1].slice(0, 300);
    // 先找"一看就是原因"的那一行（`Error: …` / `dsh: …` / `ERR_PNPM_…`），
    // 再退回关键词，最后才用最后一行 —— 三层都不中时至少不编。
    const head = lines.find(
      (line) => /^(?:\w*Error|dsh)\b.*?:/.test(line) || /^ERR_[A-Z_]+/.test(line),
    );
    const errorish = lines.find((line) =>
      /error|错误|EADDRINUSE|EPERM|EACCES|ENOENT|failed|refused|denied|cannot|未找到|占用/i.test(
        line,
      ),
    );
    return (head || errorish || lines[lines.length - 1]).slice(0, 300);
  }

  handleExit(exitCode: number, signal: number | null = null): void {
    const wasStopping = this.stopping;
    const hadToken = Boolean(this.uiUrl);
    this.portPid = null;
    this.startedAt = null;
    // 访问令牌随进程消亡，界面层不该再拿旧地址去试
    this.uiUrl = null;
    this.lastExit = { code: exitCode, signal: signal || null, at: Date.now() };
    if (wasStopping) {
      this.log('info', `dsh 已停止（退出码 ${exitCode}）`);
    } else {
      this.log(
        exitCode === 0 ? 'info' : 'error',
        `dsh 进程退出（退出码 ${exitCode}${signal ? `, 信号 ${signal}` : ''}）`,
      );
      const said = this.lastOutputLine();
      // 非正常退出：把 dsh 自己说的原因也放进事件日志，别让人只看到"退出码 1"
      if (exitCode !== 0) {
        if (said) this.log('error', `dsh 输出：${said}`);
      } else if (!hadToken && said === '') {
        // 退出码 0 + 零输出 + 服务从未就绪：dsh 的 CLI 在不兼容的 Node 上正是这个表现
        // （实测：同一份 bin.js，Node 22 静默退出，Node 24 正常）。不说清楚的话，
        // 界面只会显示"已停止"，用户完全看不出是解释器的问题。
        this.log(
          'warn',
          'dsh 没有任何输出就退出了（退出码 0）。常见原因是启动用的 Node 版本跑不了 dsh —— ' +
            '可在「设置 → 启动方式 → dsh 命令」里写「能跑 dsh 的 node 绝对路径 + dsh 入口脚本路径」。',
        );
      }
    }
    this.emitState();
    void this.pollOnce();
  }

  // ---------------------------------------------------------------- 启停

  /** 启动。端口上已有 dsh 时自动改为接管，不重复拉起。 */
  async start({ allowAdopt = true }: { allowAdopt?: boolean } = {}): Promise<DshSnapshot> {
    if (this.sessionAlive) {
      this.log('warn', 'dsh 已经在运行了');
      return this.snapshot();
    }
    this.syncSettings();
    this.lastError = null;

    const preflight = await probeHttp(this.origin, 1500);
    if (preflight.isDsh) {
      if (allowAdopt) {
        this.log('warn', `端口 ${this.effectivePort} 上已有 dsh 实例，切换为接管模式`);
        await this.pollOnce();
        return this.snapshot();
      }
      throw new Error(`端口 ${this.effectivePort} 上已有 dsh 实例在运行`);
    }
    if (preflight.reachable && !preflight.isDsh) {
      throw new Error(
        `端口 ${this.effectivePort} 已被其它进程占用（HTTP ${preflight.statusCode}），请换端口`,
      );
    }

    let launch: LaunchInfo;
    try {
      launch = resolveDshInvocation(this.settings.all());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.log('error', message);
      this.emitState();
      throw error;
    }
    this.launch = launch;

    const cwdSetting = String(this.settings.get('cwd') || '').trim();
    let cwd = cwdSetting;
    if (!cwd) cwd = homeDir();
    try {
      if (!fs.statSync(cwd).isDirectory()) cwd = homeDir();
    } catch {
      cwd = homeDir();
    }

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    // 让 dsh 输出稳定的纯文本横幅，便于解析带令牌的 URL
    env.FORCE_COLOR = env.FORCE_COLOR || '1';

    this.log('info', `启动命令: ${launch.display}`);
    this.log('info', `工作目录: ${cwd}`);
    this.uiUrl = null;
    this.buffer = [];
    this.bufferBytes = 0;
    this.lastExit = null;

    try {
      const session = this.pty.create({
        id: this.sessionId,
        file: launch.file,
        args: launch.args,
        cwd,
        env,
        cols: 120,
        rows: 30,
        meta: { kind: 'dsh' },
      });
      this.portPid = null;
      this.startedAt = Date.now();
      this.phase = PHASE.starting;
      // Windows/ConPTY 的 PID 要等就绪事件之后才有值，这里只报告"已拉起"，PID 随后按需读取
      const pidNow = Number(session.proc && session.proc.pid);
      this.log(
        'info',
        pidNow > 0 ? `dsh 已拉起，PID ${pidNow}` : 'dsh 已拉起，等待 PTY 就绪后确认 PID…',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = `启动失败: ${message}`;
      this.phase = PHASE.stopped;
      this.log('error', this.lastError);
      this.emitState();
      throw error;
    }

    this.emitState();
    this.startPolling();
    return this.snapshot();
  }

  /** 停止。 */
  async stop(options: StopOptions = {}): Promise<DshSnapshot> {
    const { force = false, killExternal = false } = options;
    const grace = Number(this.settings.get('stopGraceMs')) || 3000;
    this.stopping = true;
    this.phase = PHASE.stopping;
    this.emitState();

    if (this.pty.has(this.sessionId)) {
      if (!force) {
        this.log('info', '发送 Ctrl+C，等待优雅退出…');
        this.pty.write(this.sessionId, '\u0003');
        const deadline = Date.now() + grace;
        while (Date.now() < deadline && this.sessionAlive) {
          await sleep(150);
        }
      }
      if (this.sessionAlive) {
        // 强杀前再解析一次 PID：PTY 刚就绪时 pty 上还没有值，端口占用者兜底
        let pid = this.ownedPid;
        if (!pid) pid = await this.resolveOwnedPidFromPort();
        this.log('warn', `优雅退出超时，强制结束进程树${pid ? ` (PID ${pid})` : ''}`);
        if (pid) await killTree(pid, true);
        this.pty.kill(this.sessionId, true);
      }
    } else {
      const pid = this.ownedPid;
      if (pid && isAlive(pid)) await killTree(pid, true);
    }

    if (killExternal && this.externalPid) {
      this.log(
        'warn',
        `结束外部实例 PID ${this.externalPid}${this.externalName ? ` (${this.externalName})` : ''}`,
      );
      await killTree(this.externalPid, true);
      this.externalPid = null;
      this.externalName = '';
    }

    this.portPid = null;
    this.startedAt = null;
    this.uiUrl = null;
    this.stopping = false;
    await sleep(200);
    await this.pollOnce();
    this.log('info', '已停止');
    return this.snapshot();
  }

  /** 端口上监听者的 PID 就是本应用拉起的 dsh（PTY 未就绪时用它兜底） */
  async resolveOwnedPidFromPort(): Promise<number | null> {
    const owner = await portOwnerSync(this.effectivePort);
    if (owner && owner.pid > 0) {
      this.portPid = owner.pid;
      return owner.pid;
    }
    return null;
  }

  async restart(): Promise<DshSnapshot> {
    await this.stop({});
    // 等端口真正释放
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const probe = await probeHttp(this.origin, 800);
      if (!probe.reachable) break;
      await sleep(250);
    }
    return this.start({ allowAdopt: false });
  }

  // ---------------------------------------------------------------- 终端交互

  write(data: string): boolean {
    return this.pty.write(this.sessionId, data);
  }

  resize(cols: number, rows: number): boolean {
    return this.pty.resize(this.sessionId, cols, rows);
  }

  /** 重放缓冲区，用于终端标签重新挂载时恢复历史输出 */
  replay(): string {
    return this.buffer.join('');
  }

  // ---------------------------------------------------------------- 状态轮询

  startPolling(): void {
    const interval = Math.max(500, Number(this.settings.get('pollIntervalMs')) || 1500);
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, interval);
    if (this.timer.unref) this.timer.unref();
    void this.pollOnce();
  }

  stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const probe = await probeHttp(this.origin, 1200);
      this.probe = {
        reachable: probe.reachable,
        isDsh: Boolean(probe.isDsh),
        statusCode: probe.statusCode ?? null,
        latencyMs: probe.reachable ? probe.latencyMs : null,
        checkedAt: Date.now(),
        error: probe.error || null,
      };
      if (probe.reachable && typeof probe.latencyMs === 'number') {
        this.latencyHistory.push(probe.latencyMs);
        if (this.latencyHistory.length > 60) this.latencyHistory.shift();
      }

      const alive = this.sessionAlive;
      const startTimeout = Number(this.settings.get('startTimeoutMs')) || 60000;

      let phase: DshPhase;
      if (this.stopping) {
        phase = PHASE.stopping;
      } else if (alive) {
        if (this.probe.isDsh) phase = PHASE.running;
        else if (this.startedAt && Date.now() - this.startedAt < startTimeout)
          phase = PHASE.starting;
        else phase = PHASE.degraded;
      } else if (this.probe.isDsh) {
        phase = PHASE.external;
      } else if (this.probe.reachable) {
        phase = PHASE.conflict;
      } else {
        phase = PHASE.stopped;
      }

      // 不是自己起的进程时，查一下端口占用者，便于界面显示"接管对象"
      const wantsOwner = !alive && (phase === PHASE.external || phase === PHASE.conflict);
      if (wantsOwner) {
        const owner = await portOwnerSync(this.effectivePort);
        if (owner) {
          const name = await processNameSync(owner.pid);
          this.portOwner = { ...owner, name };
          if (phase === PHASE.external) {
            this.externalPid = owner.pid;
            this.externalName = name;
          }
        } else {
          this.portOwner = null;
        }
      } else if (alive) {
        // 自己的进程：PID 未知时（PTY 尚未就绪）用端口占用者补上，界面和强杀都要用
        if (this.ownedPid === null && this.probe.isDsh) await this.resolveOwnedPidFromPort();
        this.portOwner = {
          pid: this.ownedPid,
          name: 'dsh（本应用启动）',
          port: this.effectivePort,
        };
        this.externalPid = null;
        this.externalName = '';
      } else {
        this.portOwner = null;
        this.externalPid = null;
        this.externalName = '';
      }

      const changed = phase !== this.phase;
      if (changed) {
        const previous = this.phase;
        this.phase = phase;
        this.log('info', `状态: ${previous} → ${phase}`);
        if (phase === PHASE.running)
          this.log('info', `服务健康：${this.origin}（${this.probe.latencyMs} ms）`);
        if (phase === PHASE.external)
          this.log('warn', `检测到外部 dsh 实例（PID ${this.externalPid ?? '未知'}），未重复启动`);
        if (phase === PHASE.conflict)
          this.log('error', `端口 ${this.effectivePort} 被其它进程占用`);
      }
      this.emitState();
    } finally {
      this.polling = false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 日志里不打印真实的访问令牌 */
export function maskToken(url: string | null): string {
  return String(url || '').replace(/(token=)[^&\s]+/i, '$1***');
}

// dsh:exit 事件用的载荷类型在 shared/ipc.ts 里（渲染层也读它）
export type { DshExitEvent };
