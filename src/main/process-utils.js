'use strict'

/**
 * 进程/网络相关工具：dsh 命令探测、端口占用查询、进程树终止、HTTP 健康探测。
 *
 * Windows 依赖自带的 netstat/tasklist/taskkill；
 * macOS/Linux 用 lsof（端口占用）、ps（进程名）、POSIX 信号（终止）。
 * 除这两组系统命令外不需要任何额外组件。
 */

const { execFile, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const COMSPEC = process.env.ComSpec || 'cmd.exe'

/** 去掉 ANSI 转义序列，便于从终端输出里提取 URL。 */
function stripAnsi(input) {
  return String(input)
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B[@-Z\\-_]/g, '')
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/** 是普通文件（bin.js 这种交给 node 执行的脚本不需要可执行位） */
function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * 是文件且（POSIX 下）有可执行位。Windows 只看是不是文件。
 * @param {string} file
 */
function isExecutableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false
    if (!isWindows) fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 在 PATH 中查找可执行文件（Windows 下自动尝试 PATHEXT）。
 * POSIX 下额外确认可执行位 —— PATH 里躺着同名不可执行文件时不能当真。
 * @param {string} name 例如 dsh.cmd / dsh / node.exe
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
      if (isExecutableFile(full)) return full
    }
  }
  return null
}

/**
 * 各版本管理器（nvm / fnm / nodenv）下每个 Node 版本的 bin 与全局 node_modules 目录。
 *
 * 为什么需要：macOS 上从 Finder / Dock 启动的 GUI 应用拿到的 PATH 通常只有
 * `/usr/bin:/bin:/usr/sbin:/sbin`，homebrew、nvm、fnm 装的东西**都不在**里面 ——
 * 只靠 PATH 找 node/dsh 会直接失败，于是退到又慢又脆的 `npx -y`（要联网解析/安装包）。
 */
function versionManagerInstalls() {
  const home = homeDir()
  const installs = []
  const scan = (base, toInstall) => {
    let names = []
    try {
      names = fs.readdirSync(base)
    } catch {
      return // 没装这个版本管理器
    }
    // 版本号倒序（数值比较，别让 v9 排到 v24 前面）：装多个 Node 时优先较新的那个
    const key = (name) =>
      name
        .replace(/^v/i, '')
        .split('.')
        .map((part) => Number(part) || 0)
    names.sort((a, b) => {
      const ka = key(a)
      const kb = key(b)
      for (let i = 0; i < Math.max(ka.length, kb.length); i += 1) {
        const diff = (kb[i] || 0) - (ka[i] || 0)
        if (diff !== 0) return diff
      }
      return 0
    })
    for (const name of names) installs.push(toInstall(path.join(base, name)))
  }
  scan(path.join(home, '.nvm', 'versions', 'node'), (dir) => ({
    bin: path.join(dir, 'bin'),
    modules: path.join(dir, 'lib', 'node_modules')
  }))
  scan(path.join(home, '.local', 'share', 'fnm', 'node-versions'), (dir) => ({
    bin: path.join(dir, 'installation', 'bin'),
    modules: path.join(dir, 'installation', 'lib', 'node_modules')
  }))
  scan(path.join(home, '.nodenv', 'versions'), (dir) => ({
    bin: path.join(dir, 'bin'),
    modules: path.join(dir, 'lib', 'node_modules')
  }))
  return installs
}

/** 找 node 可执行文件：PATH 优先，其次常见安装位置（GUI 启动时 PATH 很窄） */
function findNodeExe() {
  const fromPath = whichSync(isWindows ? 'node.exe' : 'node')
  if (fromPath) return fromPath
  if (isWindows) return null
  const home = homeDir()
  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    path.join(home, '.volta', 'bin', 'node'),
    path.join(home, '.vite-plus', 'bin', 'node'),
    path.join(home, 'Library', 'pnpm', 'node')
  ]
  for (const install of versionManagerInstalls()) candidates.push(path.join(install.bin, 'node'))
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

/** 全局 node_modules 的候选目录（PATH 里没有 shim 时直接来这里找包） */
function globalNodeModulesRoots() {
  const home = homeDir()
  const roots = []
  const push = (dir) => {
    if (dir && !roots.includes(dir)) roots.push(dir)
  }
  // 1. 从 node 自己所在的位置反推 npm 前缀，**排最前**：
  //    这样选到的包和将要执行它的 node 是同一份安装，不会出现版本错配
  const nodeExe = findNodeExe()
  if (nodeExe) {
    let real = nodeExe
    try {
      real = fs.realpathSync(nodeExe)
    } catch {
      /* 用原始路径 */
    }
    const prefix = path.dirname(path.dirname(real))
    push(path.join(prefix, 'lib', 'node_modules'))
    push(path.join(prefix, 'node_modules'))
  }
  // 2. 常见的系统级全局目录
  push('/usr/local/lib/node_modules')
  push('/opt/homebrew/lib/node_modules')
  push(path.join(home, '.npm-global', 'lib', 'node_modules'))
  push(path.join(home, 'Library', 'pnpm', 'global', '5', 'node_modules'))
  // 3. 版本管理器里其它 Node 版本的全局目录（兜底）
  for (const install of versionManagerInstalls()) push(install.modules)
  return roots
}

/** 从全局安装目录里找 @deepseek-ai/dsh 的 bin.js（不依赖 PATH 里的 shim） */
function findGlobalDshBinJs() {
  for (const root of globalNodeModulesRoots()) {
    const candidate = path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (isFile(candidate)) return candidate
  }
  return null
}

/**
 * 「解释器 + dsh 入口脚本」的候选组合，按"最可能可用"排序。
 *
 * 为什么要成对而不是各自独立挑：dsh 的 CLI 对 Node 版本敏感 —— 实测同一份
 * bin.js，`node 22` 上会**静默什么都不做就退出（无输出、退出码 0）**，
 * `node 24` 上正常打印版本号并起服务。而 macOS 上 PATH 里的 node 未必是能跑它的那个
 * （这台机器 PATH 里是 vite-plus 包装的 v22，nvm 下另有 v24）。
 * 所以优先给出"同一个安装目录里的 node + dsh"这种天然匹配的组合，
 * 再由 canRunDsh 实测确认。
 *
 * @returns {Array<{ node: string, binJs: string, source: string }>}
 */
function dshInterpreterCandidates() {
  const out = []
  const seen = new Set()
  const push = (node, binJs, source) => {
    if (!node || !binJs) return
    const key = `${node}\u0000${binJs}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ node, binJs, source })
  }

  // 1. PATH 里的 node + PATH shim 反推出的 bin.js（最贴近用户当前环境，Windows 常态）
  const pathNode = whichSync(isWindows ? 'node.exe' : 'node')
  const shim = findDshShim()
  const shimBinJs = shim ? binJsCandidates(shim).find(isFile) : null
  push(pathNode, shimBinJs, 'PATH shim')

  // 2. 版本管理器里"配套"的 node + dsh（同一个版本目录，最新版本优先）
  if (!isWindows) {
    for (const install of versionManagerInstalls()) {
      push(
        path.join(install.bin, 'node'),
        path.join(install.modules, '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
        'nvm/fnm 配套安装'
      )
    }
  }

  // 3. PATH 里的 node + 任意扫到的全局安装
  push(pathNode, findGlobalDshBinJs(), 'PATH node + 全局安装')

  // 4. 其它常见位置找到的 node + 全局安装
  const foundNode = isWindows ? pathNode : findNodeExe()
  push(foundNode, findGlobalDshBinJs(), '已知位置 node + 全局安装')

  return out.filter((candidate) => isExecutableFile(candidate.node) && isFile(candidate.binJs))
}

/** 探针结果缓存：键是"解释器 + 入口脚本"，取值是否可用 */
const dshProbeCache = new Map()

/**
 * 实测「这个 node 能不能跑这份 dsh」——跑一次 `--version`，有输出才算能用。
 *
 * 比硬编码"要求 Node ≥ x"稳：dsh 的版本要求会变，而且它不满足要求时**不报错**，
 * 只安静地退出（退出码 0、零输出），光看退出码根本发现不了。
 * 结果缓存，所以同一组合每个进程只测一次。
 * @param {string} nodeExe
 * @param {string} binJs
 */
function canRunDsh(nodeExe, binJs) {
  const key = `${nodeExe}\u0000${binJs}`
  const cached = dshProbeCache.get(key)
  if (cached !== undefined) return cached
  let ok = false
  try {
    const stdout = execFileSync(nodeExe, [binJs, '--version'], {
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    ok = String(stdout || '').trim().length > 0
  } catch {
    // 起不来 / 超时 / 没有输出：都当作"这个组合不可用"
    ok = false
  }
  dshProbeCache.set(key, ok)
  return ok
}

/**
 * 挑一个真能跑 dsh 的解释器组合。
 * 所有候选都测不过（例如受限环境不允许再起子进程）时，退回第一个候选 ——
 * 宁可把问题留给运行期，也不要在这里直接失败。
 * @returns {{ node: string, binJs: string, source: string } | null}
 */
function pickDshInterpreter() {
  const candidates = dshInterpreterCandidates()
  if (candidates.length === 0) return null
  for (const candidate of candidates) {
    if (canRunDsh(candidate.node, candidate.binJs)) return candidate
  }
  return candidates[0]
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

/** 把字符串参数包成 cmd.exe 可安全执行的形式（仅 Windows 用） */
function quoteForCmd(value) {
  return /[\s&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** 平台感应的 dsh shim 文件（Windows 的 dsh.cmd / POSIX 的 dsh） */
function findDshShim() {
  if (isWindows) return whichSync('dsh.cmd') || whichSync('dsh.exe')
  return whichSync('dsh')
}

/**
 * npm 全局安装的 dsh 包根目录里那条 bin.js 的候选位置。
 * 布局因平台而异：Windows 的 %APPDATA%\npm 把 shim 与 node_modules 放同一层，
 * POSIX 的全局 bin（如 /opt/homebrew/bin）的 shim 是指向 ../lib/node_modules 的符号链接。
 */
function binJsCandidates(shimPath) {
  const prefix = path.dirname(shimPath)
  const candidates = [path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')]
  if (!isWindows) {
    const real = (() => {
      try {
        return fs.realpathSync(shimPath)
      } catch {
        return shimPath
      }
    })()
    const realDir = path.dirname(real)
    candidates.push(
      path.join(realDir, '..', 'lib', 'bin.js'),
      path.join(prefix, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      path.join(realDir, '..', '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    )
  }
  return candidates
}

/**
 * 解析要启动的 dsh 命令。
 * 优先级：自定义命令 > node + dsh 入口脚本（实测能跑的组合）> dsh shim > npx
 *
 * 两道保险都是为了"明明装了 dsh 却起不来"这类问题：
 *  1. 不依赖 PATH：shim 不在 PATH 里时直接扫 nvm/fnm、homebrew、pnpm 的全局安装目录
 *     （macOS 上 GUI 启动的 PATH 很窄，只有 /usr/bin:/bin:/usr/sbin:/sbin）。
 *  2. 解释器要实测：dsh 的 CLI 在旧 Node 上会**静默退出**（无输出、退出码 0），
 *     所以候选组合会跑一次 `--version` 验证，只挑真能跑的那个（见 pickDshInterpreter）。
 *
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
    // 支持写整条命令行，例如「/path/to/node /path/to/@deepseek-ai/dsh/lib/bin.js」——
    // 这样"换一个能跑 dsh 的 Node"才表达得出来（第一个 token 是可执行文件，其余是我们的前置参数）
    const parts = splitArgs(override)
    const file = parts[0]
    const prefixArgs = parts.slice(1)
    if (/\.(cmd|bat)$/i.test(file) && !isWindows) {
      throw new Error(
        `自定义命令 ${file} 是 Windows 批处理脚本，macOS 上无法执行。可以改成「node 的绝对路径 + dsh 入口脚本」，例如 /path/to/bin/node /path/to/@deepseek-ai/dsh/lib/bin.js。`
      )
    }
    if (/\.(cmd|bat)$/i.test(file)) {
      return {
        file: COMSPEC,
        args: ['/d', '/s', '/c', `"${file}"`, ...prefixArgs, ...args.map(quoteForCmd)],
        display: [override, ...args].join(' '),
        kind: 'custom-shim'
      }
    }
    return {
      file,
      args: [...prefixArgs, ...args],
      display: [override, ...args].join(' '),
      kind: 'custom'
    }
  }

  const picked = pickDshInterpreter()
  if (picked) {
    return {
      file: picked.node,
      args: [picked.binJs, ...args],
      display: [picked.node, picked.binJs, ...args].join(' '),
      kind: 'node-bin'
    }
  }
  const dshShim = findDshShim()
  if (dshShim) {
    if (isWindows) {
      return {
        file: COMSPEC,
        args: ['/d', '/s', '/c', `"${dshShim}"`, ...args.map(quoteForCmd)],
        display: [dshShim, ...args].join(' '),
        kind: 'shim'
      }
    }
    return { file: dshShim, args, display: [dshShim, ...args].join(' '), kind: 'shim' }
  }
  const npx = whichSync(isWindows ? 'npx.cmd' : 'npx')
  if (npx) {
    if (isWindows) {
      return {
        file: COMSPEC,
        args: ['/d', '/s', '/c', `"${npx}"`, '-y', '@deepseek-ai/dsh', ...args.map(quoteForCmd)],
        display: [npx, '-y', '@deepseek-ai/dsh', ...args].join(' '),
        kind: 'npx'
      }
    }
    return {
      file: npx,
      args: ['-y', '@deepseek-ai/dsh', ...args],
      display: [npx, '-y', '@deepseek-ai/dsh', ...args].join(' '),
      kind: 'npx'
    }
  }
  throw new Error(
    isWindows
      ? '找不到 dsh：PATH 里既没有 dsh.cmd，也没有 node/npx。请在设置里指定启动命令。'
      : '找不到 dsh：既没有全局安装的 @deepseek-ai/dsh，PATH 里也没有 node/npx。请在设置里指定启动命令。'
  )
}

/**
 * 选择本地 Shell（用于"新建本地 Shell"标签）。
 * Windows：pwsh > powershell > cmd；macOS/Linux：$SHELL > zsh > bash > sh。
 */
function resolveShell(settings) {
  const override = String(settings.shell || '').trim()
  if (override) return { file: override, args: [], display: override }

  if (isWindows) {
    const pwsh = whichSync('pwsh.exe')
    if (pwsh) return { file: pwsh, args: ['-NoLogo'], display: pwsh }
    const powershell = whichSync('powershell.exe')
    if (powershell) return { file: powershell, args: ['-NoLogo'], display: powershell }
    return { file: COMSPEC, args: [], display: COMSPEC }
  }

  // macOS/Linux：优先用户当前交互 shell（登录模式，PATH 与终端里一致），
  // 依次回退 zsh / bash / sh。GUI 启动的应用 PATH 很窄，不加 -l 会找不到 homebrew 装的东西。
  //
  // 注意：POSIX 上**不要**自动优先 pwsh。装了 PowerShell 的 mac 不少（GitHub 的 macOS
  // runner 就自带），自动挑它会让"新建本地 Shell"意外开出 PowerShell，而不是用户自己的 zsh；
  // 自检也因此在 CI 上红过一条。想用 pwsh / fish 之类，就在设置里显式填路径。
  const fromEnv = String(process.env.SHELL || '').trim()
  if (fromEnv && fs.existsSync(fromEnv)) return { file: fromEnv, args: ['-l'], display: fromEnv }
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (fs.existsSync(candidate)) return { file: candidate, args: ['-l'], display: candidate }
  }
  return { file: '/bin/sh', args: ['-l'], display: '/bin/sh' }
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

/**
 * 从 `lsof -nP -iTCP:<port> -sTCP:LISTEN` 输出里解析监听者 PID（纯函数，便于单测）。
 * 行形如：COMMAND   PID USER   FD  TYPE DEVICE SIZE/OFF NODE NAME
 *          node   42112  abc   20u IPv4 0x...      0t0  TCP 127.0.0.1:3080 (LISTEN)
 * NAME 列在协议名（TCP）之后：可能是 *:3080、127.0.0.1:3080 或 [::1]:3080。
 * @param {string} stdout
 * @param {number} port
 * @returns {{pid:number, local:string, port:number}|null}
 */
function parseLsofForPort(stdout, port) {
  const wanted = `:${Number(port)}`
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!/\(LISTEN\)/i.test(line)) continue
    const cols = line.trim().split(/\s+/)
    if (cols.length < 3) continue
    const pid = Number(cols[1])
    if (!Number.isInteger(pid) || pid <= 0) continue
    const tcpAt = cols.indexOf('TCP')
    const name = tcpAt >= 0 ? cols[tcpAt + 1] || '' : ''
    const local = name.split('->')[0] // 只看本地地址，别把 ESTABLISHED 的对端算进来
    if (!local || !local.endsWith(wanted)) continue
    return { pid, local, port: Number(port) }
  }
  return null
}

/** 用平台自带命令找出监听指定端口的进程 PID。 */
function portOwnerSync(port) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0) {
      resolve(null)
      return
    }
    const finish = (stdout) => {
      if (!stdout) {
        resolve(null)
        return
      }
      resolve(isWindows ? parseNetstatForPort(stdout, port) : parseLsofForPort(stdout, port))
    }
    try {
      if (isWindows) {
        execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 8000 }, (error, stdout) => {
          if (error) {
            resolve(null)
            return
          }
          finish(stdout)
        })
      } else {
        // lsof 查询端口时经常要 sudo 才全（别的用户的进程看不见）；
        // 本应用场景只关心自己启动的 dsh，无权限时返回 null 由状态机兜底。
        execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeout: 8000 }, (error, stdout) => {
          if (error) {
            resolve(null)
            return
          }
          finish(stdout)
        })
      }
    } catch {
      // 系统命令起不来（受限环境）：当作未知，不影响状态机
      resolve(null)
    }
  })
}

/** 查询 PID 对应的进程名（尽力而为）。 */
function processNameSync(pid) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      resolve('')
      return
    }
    try {
      if (isWindows) {
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
      } else {
        execFile('ps', ['-o', 'comm=', '-p', String(pid)], { timeout: 8000 }, (error, stdout) => {
          if (error || !stdout) {
            resolve('')
            return
          }
          const name = String(stdout).trim().split(/\s+/)[0] || ''
          resolve(name)
        })
      }
    } catch {
      resolve('')
    }
  })
}

/** POSIX：递归收集 pid 的所有后代（pgrep -P 一层层展开，子先父后） */
function collectDescendants(pid, exec) {
  const out = []
  const queue = [pid]
  let guard = 0
  while (queue.length > 0 && guard < 64) {
    guard += 1
    const parent = queue.shift()
    let children = []
    try {
      const stdout = exec('pgrep', ['-P', String(parent)])
      children = String(stdout || '')
        .split(/\s+/)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0)
    } catch {
      children = []
    }
    out.unshift(...children)
    queue.push(...children)
  }
  return out
}

/** POSIX：优先杀"自己的进程组"（pgid==pid 时整组一起清），否则按后代顺序逐个终止。 */
function killPosixTree(pid, signal) {
  try {
    const pgid = Number(String(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] })).trim())
    if (Number.isInteger(pgid) && pgid > 0 && pgid === pid) {
      process.kill(-pgid, signal)
      return
    }
  } catch {
    /* ps 不可用：退回逐个终止 */
  }
  try {
    const targets = [...collectDescendants(pid, execFileSync), pid]
    for (const target of targets) {
      try {
        process.kill(target, signal)
      } catch {
        /* 进程可能已退出 */
      }
    }
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      /* 进程可能已退出 */
    }
  }
}

/** 终止进程树（Windows 用 taskkill /T /F，POSIX 用信号按组/按后代清）。 */
function killTree(pid, force = true) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      resolve(false)
      return
    }
    if (isWindows) {
      const args = ['/PID', String(pid), '/T']
      if (force) args.push('/F')
      try {
        execFile('taskkill', args, { windowsHide: true, timeout: 8000 }, (error) => resolve(!error))
      } catch {
        resolve(false)
      }
      return
    }
    try {
      killPosixTree(pid, force ? 'SIGKILL' : 'SIGTERM')
      resolve(true)
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
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 8000
      })
    } else {
      killPosixTree(pid, 'SIGKILL')
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
  canRunDsh,
  dshInterpreterCandidates,
  findGlobalDshBinJs,
  findNodeExe,
  homeDir,
  isAlive,
  isDshResponse,
  isMac,
  isWindows,
  killTree,
  killTreeSync,
  parseLsofForPort,
  parseNetstatForPort,
  pickDshInterpreter,
  portOwnerSync,
  probeHttp,
  processNameSync,
  resolveDshInvocation,
  resolveShell,
  splitArgs,
  stripAnsi,
  whichSync
}
