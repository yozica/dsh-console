'use strict'

/**
 * PTY 会话注册表：用 node-pty 打开真正的伪终端（Windows 上走 ConPTY）。
 * 一个会话 = 一个终端标签页（dsh 进程本身，或用户临时开的本地 Shell）。
 */

const { EventEmitter } = require('node:events')
const pty = require('node-pty')

/** node-pty 要求正数尺寸，窗口最小化时可能传 0 */
function safeSize(value, fallback) {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

class PtySessions extends EventEmitter {
  constructor() {
    super()
    /** @type {Map<string, {id:string, proc:import('node-pty').IPty, exited:boolean, exitCode:number|null, createdAt:number, meta:object}>} */
    this.sessions = new Map()
  }

  /**
   * 新建（或替换）一个 PTY 会话。
   * @param {{id:string,file:string,args?:string[],cwd?:string,env?:Record<string,string>,cols?:number,rows?:number,meta?:object}} options
   */
  create(options) {
    const { id, file, args = [], cwd, env, cols = 120, rows = 30, meta = {} } = options
    if (this.sessions.has(id)) this.kill(id, true)

    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: safeSize(cols, 120),
      rows: safeSize(rows, 30),
      cwd: cwd && cwd.length > 0 ? cwd : process.env.USERPROFILE || process.cwd(),
      env: env || process.env,
      useConpty: true
    })

    const session = {
      id,
      proc,
      exited: false,
      exitCode: null,
      createdAt: Date.now(),
      meta
    }
    this.sessions.set(id, session)

    proc.onData((chunk) => {
      this.emit('data', { id, chunk })
    })

    proc.onExit(({ exitCode, signal }) => {
      session.exited = true
      session.exitCode = exitCode
      this.sessions.delete(id)
      this.emit('exit', { id, exitCode, signal, meta })
    })

    return session
  }

  get(id) {
    return this.sessions.get(id) || null
  }

  has(id) {
    return this.sessions.has(id)
  }

  pid(id) {
    const session = this.sessions.get(id)
    return session ? session.proc.pid : null
  }

  list() {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      pid: session.proc.pid,
      createdAt: session.createdAt,
      meta: session.meta
    }))
  }

  /** 改会话的显示名（meta.label）：本地 Shell 的标题可以重命名 */
  rename(id, label) {
    const session = this.sessions.get(id)
    if (!session) return false
    session.meta = { ...session.meta, label }
    return true
  }

  write(id, data) {
    const session = this.sessions.get(id)
    if (!session) return false
    try {
      session.proc.write(data)
      return true
    } catch {
      return false
    }
  }

  resize(id, cols, rows) {
    const session = this.sessions.get(id)
    if (!session) return false
    try {
      session.proc.resize(safeSize(cols, 120), safeSize(rows, 30))
      return true
    } catch {
      return false
    }
  }

  kill(id, force = false) {
    const session = this.sessions.get(id)
    if (!session) return false
    this.sessions.delete(id)
    try {
      session.proc.kill(force ? undefined : 'SIGTERM')
      return true
    } catch {
      return false
    }
  }

  killAll() {
    for (const id of [...this.sessions.keys()]) this.kill(id, true)
  }
}

module.exports = { PtySessions }
