'use strict'

/**
 * PTY 会话注册表：用 node-pty 打开真正的伪终端（Windows 上走 ConPTY，
 * macOS/Linux 走 forkpty）。一个会话 = 一个终端标签页（dsh 进程本身，或用户临时开的本地 Shell）。
 */

const { EventEmitter } = require('node:events')
const os = require('node:os')
const pty = require('node-pty')
const processUtils = require('./process-utils')

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
      cwd: cwd && cwd.length > 0 ? cwd : os.homedir(),
      env: env || process.env,
      // ConPTY 是 Windows 专属选项；macOS/Linux 上 node-pty 走 forkpty，不需要它
      useConpty: process.platform === 'win32'
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
      // Windows：node-pty 的 kill() 忽略信号并结束整个 ConPTY（连同子进程树）。
      // macOS/Linux：node-pty 只把信号发给 shell 本身，所以强杀时先用进程组/后代清一遍，
      // 免得 shell 里跑着的子进程变成孤儿；非强杀仍走 SIGTERM 让 shell 自己收尾。
      if (force && process.platform !== 'win32') {
        processUtils.killTreeSync(session.proc.pid)
      }
      session.proc.kill(force ? 'SIGKILL' : 'SIGTERM')
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
