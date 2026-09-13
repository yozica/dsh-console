'use strict'

/**
 * 进程/网络相关工具：dsh 命令探测、端口占用查询、进程树终止、HTTP 健康探测。
 * 全部依赖 Windows 自带的 netstat/tasklist/taskkill，无需额外组件。
 */

const { execFile } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const isWindows = process.platform === 'win32'
const COMSPEC = process.env.ComSpec || 'cmd.exe'

/** 去掉 ANSI 转义序列，便于从终端输出里提取 URL。 */
function stripAnsi(input) {
  return String(input)
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B[@-Z\\-_]/g, '')
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/**
 * 在 PATH 中查找可执行文件（Windows 下自动尝试 PATHEXT）。
 * @param {string} name 例如 dsh.cmd / node.exe
 * @returns {string | null} 绝对路径
 */
function whichSync(name) {
  const exts = isWindows
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  const hasExt = path.extname(name) !== ''
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidates = hasExt ? [name] : [name, ...exts.map((ext) => name + ext.toLowerCase())]
    for (const candidate of candidates) {
      const full = path.join(dir, candidate)
      try {
        if (fs.statSync(full).isFile()) return full
      } catch {
        /* 继续找 */
      }
    }
  }
  return null
}

/** 拆分带引号的参数串，例如 --flag "a b" -> ['--flag', 'a b'] */
function splitArgs(text) {
  const out = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match
  while ((match = pattern.exec(String(text || ''))) !== null) {
    out.push(match[1] ?? match[2] ?? match[3])
  }
  return out
}

/** 把字符串参数包成 cmd.exe 可安全执行的形式 */
function quoteForCmd(value) {
  return /[\s&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * 解析要启动的 dsh 命令。
 * 优先级：自定义命令 > node + 全局 bin.js > dsh.cmd > npx -y @deepseek-ai/dsh
 * @returns {{ file: string, args: string[], display: string, kind: string }}
 */
function resolveDshInvocation(settings) {
  const args = ['web', '--no-open']
  const host = String(settings.host || '127.0.0.1').trim()
  const port = Number(settings.port)
  if (host && host !== '127.0.0.1') args.push('--host', host)
  if (Number.isInteger(port) && port > 0) args.push('--port', String(port))
  args.push(...splitArgs(settings.extraArgs))

  const override = String(settings.dshCommand || '').trim()
  if (override) {
    if (/\.(cmd|bat)$/i.test(override)) {
      return {
        file: COMSPEC,
        args: ['/d', '/s', '/c', `"${override}"`, ...args.map(quoteForCmd)],
        display: [override, ...args].join(' '),
        kind: 'custom-shim'
      }
    }
    return { file: override, args, display: [override, ...args].join(' '), kind: 'custom' }
  }

  const nodeExe = whichSync('node.exe') || whichSync('node')
  const dshCmd = whichSync('dsh.cmd') || whichSync('dsh.exe')
  if (nodeExe && dshCmd) {
    const prefix = path.dirname(dshCmd)
    const binJs = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    try {
      if (fs.statSync(binJs).isFile()) {
        return {
          file: nodeExe,
          args: [binJs, ...args],
          display: [nodeExe, binJs, ...args].join(' '),
          kind: 'node-bin'
        }
      }
    } catch {
      /* 退回到 shim 方式 */
    }
  }
  if (dshCmd) {
    return {
      file: COMSPEC,
      args: ['/d', '/s', '/c', `"${dshCmd}"`, ...args.map(quoteForCmd)],
      display: [dshCmd, ...args].join(' '),
      kind: 'shim'
    }
  }
  const npx = whichSync('npx.cmd') || whichSync('npx')
  if (npx) {
    return {
      file: COMSPEC,
      args: ['/d', '/s', '/c', `"${npx}"`, '-y', '@deepseek-ai/dsh', ...args.map(quoteForCmd)],
      display: [npx, '-y', '@deepseek-ai/dsh', ...args].join(' '),
      kind: 'npx'
    }
  }
  throw new Error('找不到 dsh：PATH 里既没有 dsh.cmd，也没有 node/npx。请在设置里指定启动命令。')
}

/** 选择本地 Shell（用于"新建本地 Shell"标签） */
function resolveShell(settings) {
  const override = String(settings.shell || '').trim()
  if (override) return { file: override, args: [], display: override }
  const pwsh = whichSync('pwsh.exe')
  if (pwsh) return { file: pwsh, args: ['-NoLogo'], display: pwsh }
  const powershell = whichSync('powershell.exe')
  if (powershell) return { file: powershell, args: ['-NoLogo'], display: powershell }
  return { file: COMSPEC, args: [], display: COMSPEC }
}

/** 判断 HTTP 响应是否来自 dsh web。 */
function isDshResponse(statusCode, body) {
  const text = String(body || '')
  if (/dsh web authentication required/.test(text)) return true
  if (statusCode === 200 && /__DSH_BOOT__|DeepSeek Harness/i.test(text)) return true
  return false
}

/**
 * 探测一个 HTTP 地址。
 * @returns {Promise<{reachable:boolean,statusCode?:number,latencyMs:number,isDsh:boolean,body?:string,error?:string}>}
 */
function probeHttp(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve({ latencyMs: Date.now() - started, ...value })
    }
    let request
    try {
      request = http.get(url, { timeout: timeoutMs, headers: { 'user-agent': 'dsh-console' } }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          if (body.length < 65536) body += chunk
        })
        res.on('end', () => {
          finish({
            reachable: true,
            statusCode: res.statusCode,
            isDsh: isDshResponse(res.statusCode, body),
            body: body.slice(0, 300),
            location: res.headers.location
          })
        })
        res.on('error', (error) => finish({ reachable: false, error: error.message, isDsh: false }))
      })
    } catch (error) {
      finish({ reachable: false, error: error.message, isDsh: false })
      return
    }
    request.on('timeout', () => {
      request.destroy()
      finish({ reachable: false, error: 'timeout', isDsh: false })
    })
    request.on('error', (error) => finish({ reachable: false, error: error.message, isDsh: false }))
  })
}

/**
 * 从 netstat -ano 输出里解析监听指定端口的 PID（纯函数，便于单测）。
 * @param {string} stdout
 * @param {number} port
 * @returns {{pid:number, local:string, port:number}|null}
 */
function parseNetstatForPort(stdout, port) {
  const wanted = `:${port}`
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5) continue
    const [proto, local, , state, pidText] = cols
    if (proto.toUpperCase() !== 'TCP') continue
    if (state.toUpperCase() !== 'LISTENING') continue
    if (!local.endsWith(wanted)) continue
    const pid = Number(pidText)
    if (!Number.isInteger(pid) || pid <= 0) continue
    return { pid, local, port: Number(port) }
  }
  return null
}

/** 用 netstat 找出监听指定端口的进程 PID。 */
function portOwnerSync(port) {
  return new Promise((resolve) => {
    if (!isWindows) {
      resolve(null)
      return
    }
    try {
      execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 8000 }, (error, stdout) => {
        if (error || !stdout) {
          resolve(null)
          return
        }
        resolve(parseNetstatForPort(stdout, port))
      })
    } catch {
      // netstat 起不来（受限环境）：当作未知，不影响状态机
      resolve(null)
    }
  })
}

/** 查询 PID 对应的进程名（尽力而为）。 */
function processNameSync(pid) {
  return new Promise((resolve) => {
    if (!isWindows) {
      resolve('')
      return
    }
    try {
      execFile(
        'tasklist',
        ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { windowsHide: true, timeout: 8000 },
        (error, stdout) => {
          if (error || !stdout) {
            resolve('')
            return
          }
          const match = stdout.match(/^"([^"]+)","(\d+)"/m)
          resolve(match ? match[1] : '')
        }
      )
    } catch {
      resolve('')
    }
  })
}

/** 终止进程树（Windows 用 taskkill /T /F）。 */
function killTree(pid, force = true) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      resolve(false)
      return
    }
    if (!isWindows) {
      try {
        process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
        resolve(true)
      } catch {
        resolve(false)
      }
      return
    }
    const args = ['/PID', String(pid), '/T']
    if (force) args.push('/F')
    try {
      execFile('taskkill', args, { windowsHide: true, timeout: 8000 }, (error) => resolve(!error))
    } catch {
      resolve(false)
    }
  })
}

/** 同步终止，用于退出应用前的兜底清理。 */
function killTreeSync(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    if (isWindows) {
      require('node:child_process').execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 8000
      })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    /* 进程可能已退出 */
  }
}

/** 判断 PID 是否存活。 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function homeDir() {
  try {
    return os.homedir()
  } catch {
    return process.cwd()
  }
}

module.exports = {
  COMSPEC,
  homeDir,
  isAlive,
  isDshResponse,
  killTree,
  killTreeSync,
  parseNetstatForPort,
  portOwnerSync,
  probeHttp,
  processNameSync,
  resolveDshInvocation,
  resolveShell,
  splitArgs,
  stripAnsi,
  whichSync
}
