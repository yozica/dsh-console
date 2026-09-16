/**
 * PTY 会话注册表：用 node-pty 打开真正的伪终端（Windows 上走 ConPTY，
 * macOS/Linux 走 forkpty）。一个会话 = 一个终端标签页（dsh 进程本身，或用户临时开的本地 Shell）。
 */

import { EventEmitter } from 'node:events'
import os from 'node:os'
import * as pty from 'node-pty'

import { killTreeSync } from './process-utils'
import type { SessionInfo, SessionMeta, SessionOutputEvent, SessionExitEvent } from '../shared/ipc'

/** node-pty 要求正数尺寸，窗口最小化时可能传 0 */
function safeSize(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export interface CreateSessionOptions {
  id: string
  file: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  meta?: SessionMeta
}

/** 注册表内部持有的会话记录 */
export interface PtySession {
  id: string
  proc: pty.IPty
  exited: boolean
  exitCode: number | null
  createdAt: number
  meta: SessionMeta
}

/** PtySessions 对外发出的事件（自检与会话页都依赖这些形状） */
export interface PtySessionsEvents {
  data: [SessionOutputEvent]
  exit: [SessionExitEvent]
}

export class PtySessions extends EventEmitter {
  private readonly sessions = new Map<string, PtySession>()

  /** 新建（或替换）一个 PTY 会话。 */
  create(options: CreateSessionOptions): PtySession {
    const { id, file, args = [], cwd, env, cols = 120, rows = 30, meta = {} } = options
    if (this.sessions.has(id)) this.kill(id, true)

    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: safeSize(cols, 120),
      rows: safeSize(rows, 30),
      cwd: cwd && cwd.length > 0 ? cwd : os.homedir(),
      env: env || process.env,
      // ConPTY 是 Windows 专属选项；macOS/Linux 上 node-pty 走 forkpty，不需要它
      useConpty: process.platform === 'win32'
    })

    const session: PtySession = {
      id,
      proc,
      exited: false,
      exitCode: null,
      createdAt: Date.now(),
      meta
    }
    this.sessions.set(id, session)

    proc.onData((chunk) => {
      const event: SessionOutputEvent = { id, chunk }
      this.emit('data', event)
    })

    proc.onExit(({ exitCode, signal }) => {
      session.exited = true
      session.exitCode = exitCode
      this.sessions.delete(id)
      const event: SessionExitEvent = { id, exitCode, signal, meta }
      this.emit('exit', event)
    })

    return session
  }

  get(id: string): PtySession | null {
    return this.sessions.get(id) || null
  }

  has(id: string): boolean {
    return this.sessions.has(id)
  }

  pid(id: string): number | null {
    const session = this.sessions.get(id)
    return session ? session.proc.pid : null
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      pid: session.proc.pid,
      createdAt: session.createdAt,
      meta: session.meta
    }))
  }

  /** 改会话的显示名（meta.label）：本地 Shell 的标题可以重命名 */
  rename(id: string, label: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.meta = { ...session.meta, label }
    return true
  }

  write(id: string, data: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    try {
      session.proc.write(data)
      return true
    } catch {
      return false
    }
  }

  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    try {
      session.proc.resize(safeSize(cols, 120), safeSize(rows, 30))
      return true
    } catch {
      return false
    }
  }

  kill(id: string, force = false): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    this.sessions.delete(id)
    try {
      // Windows：node-pty 的 kill() 忽略信号并结束整个 ConPTY（连同子进程树）。
      // macOS/Linux：node-pty 只把信号发给 shell 本身，所以强杀时先用进程组/后代清一遍，
      // 免得 shell 里跑着的子进程变成孤儿；非强杀仍走 SIGTERM 让 shell 自己收尾。
      if (force && process.platform !== 'win32') {
        killTreeSync(session.proc.pid)
      }
      session.proc.kill(force ? 'SIGKILL' : 'SIGTERM')
      return true
    } catch {
      return false
    }
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id, true)
  }
}
