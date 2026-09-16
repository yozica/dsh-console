'use strict'

/**
 * 归档会话管理：直接读写 DeepSeek Harness 的磁盘数据。
 *
 * 背景：DSH 的「归档」只是把会话 id 记进 `storages/workspace.json` 的
 * `global.archivedSessionIds`（纯隐藏，不删数据），而且官方没有提供
 * 「查看 / 取消归档 / 删除会话」的入口或接口。本模块补上这三件事：
 *
 *   - 列出归档会话：读 workspace.json 拿 id，再读投影缓存拿标题 / 首句 / 时间
 *   - 读取对话全文：解压会话的 zstd JSONL 日志，抽出用户提问与助手回复
 *   - 取消归档 / 删除：改 workspace.json（原子写），删除时连会话日志与投影缓存一起删
 *
 * 数据位置（DSH home 由 $DSH_HOME 或 ~/.dsh 决定）：
 *   <home>/storages/workspace.json                 归档 id、Workspace 注册表
 *   <home>/storages/session_projcache/sessions/    会话投影缓存（标题/首句/摘要）
 *   <home>/sessions/<项目目录>/<会话id>/           会话日志 session.vN.jsonl(.zstd)
 *
 * 注意：DSH 进程把 workspace.json 读进内存，直接改磁盘文件不会立刻反映到正在
 * 运行的界面里，需要重启 dsh 才会同步。所以取消归档/删除的返回里带上
 * `dshRunning`，由调用方（main.js 的 IPC handler）按 dsh 状态补上。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

/** 单条消息最多保留的字符数，防止异常大的日志把 IPC 撑爆 */
const MAX_MESSAGE_CHARS = 8000
/** 对话全文最多保留的总字符数，超出则截断（保留靠后的新消息） */
const MAX_CONVERSATION_CHARS = 1000000

// ---------------------------------------------------------------- 路径解析

/** 与 dsh-home-paths 一致的解析：$DSH_HOME（非空白）优先，否则 ~/.dsh */
function resolveDshHome() {
  const env = String(process.env.DSH_HOME || '').trim()
  if (env) return expandTilde(env)
  return path.join(os.homedir(), '.dsh')
}

function expandTilde(p) {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

function workspaceFile(home) {
  return path.join(home, 'storages', 'workspace.json')
}

function projectionDir(home) {
  return path.join(home, 'storages', 'session_projcache', 'sessions')
}

function sessionsRoot(home) {
  return path.join(home, 'sessions')
}

// ---------------------------------------------------------------- 基础读写

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 原子写：先写同目录临时文件，再 rename 覆盖，避免读写中途崩坏 */
function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

// ---------------------------------------------------------------- 会话定位

/** 在 <home>/sessions/<项目目录>/ 下找某个会话目录（目录名即会话 id） */
function findSessionDir(home, id) {
  let projects
  try {
    projects = fs.readdirSync(sessionsRoot(home))
  } catch {
    return null
  }
  for (const project of projects) {
    const dir = path.join(sessionsRoot(home), project, id)
    try {
      if (fs.statSync(dir).isDirectory()) return dir
    } catch {
      /* 继续找 */
    }
  }
  return null
}

/** 挑出会话目录里最高 generation 的日志文件（session.jsonl 视为 v0） */
function pickLogFile(dir) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  let best = null
  let bestVersion = -1
  for (const name of names) {
    const match = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(name)
    if (!match) continue
    const version = match[1] === undefined ? 0 : Number(match[1])
    if (version > bestVersion) {
      bestVersion = version
      best = name
    }
  }
  return best ? path.join(dir, best) : null
}

// ---------------------------------------------------------------- 日志解码

/**
 * 解压 zstd JSONL 日志。DSH 把日志存成「多个独立 zstd 帧拼接」，
 * Node 内置的 zstdDecompressSync 只解第一个帧，所以按帧魔数切开逐帧解。
 */
function decompressZstdFrames(buffer) {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('当前 Electron/Node 不支持内置 zstd 解压（需要 Node ≥ 22.15）')
  }
  const starts = []
  for (let i = 0; i <= buffer.length - 4; i++) {
    if (
      buffer[i] === 0x28 &&
      buffer[i + 1] === 0xb5 &&
      buffer[i + 2] === 0x2f &&
      buffer[i + 3] === 0xfd
    ) {
      starts.push(i)
    }
  }
  if (starts.length === 0) throw new Error('会话日志不是有效的 zstd 帧序列')
  const parts = []
  for (let k = 0; k < starts.length; k++) {
    const begin = starts[k]
    const end = k + 1 < starts.length ? starts[k + 1] : buffer.length
    parts.push(zlib.zstdDecompressSync(buffer.subarray(begin, end)))
  }
  return Buffer.concat(parts).toString('utf8')
}

function decodeSessionLog(file) {
  const buffer = fs.readFileSync(file)
  const text = file.endsWith('.zstd') ? decompressZstdFrames(buffer) : buffer.toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      /* 撕裂的尾部行：跳过 */
    }
  }
  return events
}

// ---------------------------------------------------------------- 会话提取

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

function truncateText(text) {
  const value = String(text)
  if (value.length <= MAX_MESSAGE_CHARS) return value
  return `${value.slice(0, MAX_MESSAGE_CHARS)}…`
}

/**
 * 从事件流里抽出一段干净的对话：真实用户提问（source.kind === 'user'）与
 * 助手回复（assistant/message 的 text 块）。跳过运行时注入的上下文快照、
 * system-reminder、reasoning 与 tool-call。
 */
function extractConversation(events) {
  const messages = []
  let total = 0
  let truncated = false
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const data = event.data
    if (event.type === 'user/message' && data && data.source && data.source.kind === 'user') {
      const text = contentText(data.content).trim()
      if (text) {
        const value = truncateText(text)
        total += value.length
        if (total > MAX_CONVERSATION_CHARS) {
          truncated = true
          break
        }
        messages.push({
          role: 'user',
          text: value,
          time: typeof event.time === 'number' ? event.time : null
        })
      }
    } else if (event.type === 'assistant/message' && data && data.message) {
      const text = contentText(data.message.content).trim()
      if (text) {
        const value = truncateText(text)
        total += value.length
        if (total > MAX_CONVERSATION_CHARS) {
          truncated = true
          break
        }
        messages.push({
          role: 'assistant',
          text: value,
          time: typeof event.time === 'number' ? event.time : null
        })
      }
    }
  }
  return { messages, truncated }
}

// ---------------------------------------------------------------- 投影缓存

function readProjection(home, id) {
  const raw = readJson(path.join(projectionDir(home), `${id}.json`))
  if (!raw) return null
  const record = raw.record || {}
  const rows = record.rows || {}
  const identity = record.identity || {}

  const title = rows.title && rows.title.val ? String(rows.title.val) : ''
  const first =
    rows.titleInput && rows.titleInput.val && rows.titleInput.val.first
      ? String(rows.titleInput.val.first.text || '')
      : ''
  const lastPromptAt =
    rows.sessionListMetadata && rows.sessionListMetadata.val
      ? rows.sessionListMetadata.val.lastPromptAt
      : null
  const turns =
    rows.turnOutline && rows.turnOutline.val && Array.isArray(rows.turnOutline.val.turns)
      ? rows.turnOutline.val.turns
      : []

  return {
    title,
    first,
    lastPromptAt: typeof lastPromptAt === 'number' ? lastPromptAt : null,
    createdAt: typeof identity.createdAt === 'number' ? identity.createdAt : null,
    cwd: typeof identity.cwd === 'string' ? identity.cwd : null,
    turns
  }
}

// ---------------------------------------------------------------- 公开方法

class SessionArchiveManager {
  constructor() {
    this.home = resolveDshHome()
  }

  homeInfo() {
    return { home: this.home, exists: fs.existsSync(this.home) }
  }

  list() {
    const ws = readJson(workspaceFile(this.home))
    const archived =
      ws && ws.global && Array.isArray(ws.global.archivedSessionIds)
        ? ws.global.archivedSessionIds
        : []

    const sessions = []
    for (const id of archived) {
      const proj = readProjection(this.home, id)
      const dir = findSessionDir(this.home, id)
      let logFile = null
      let logSize = null
      if (dir) {
        logFile = pickLogFile(dir)
        if (logFile) {
          try {
            logSize = fs.statSync(logFile).size
          } catch {
            /* 读取大小失败不影响列表 */
          }
        }
      }

      const turns = (proj && proj.turns) || []
      const searchBlob = [
        proj && proj.title,
        proj && proj.first,
        ...turns.flatMap((turn) => [turn.prompt, turn.response])
      ]
        .filter(Boolean)
        .join('\n')

      sessions.push({
        id,
        title: (proj && proj.title) || (proj && proj.first) || '未命名会话',
        firstPrompt: (proj && proj.first) || '',
        lastPromptAt: proj ? proj.lastPromptAt : null,
        createdAt: proj ? proj.createdAt : null,
        cwd: proj ? proj.cwd : null,
        turnCount: turns.length,
        logSize,
        logFile,
        searchBlob
      })
    }

    sessions.sort(
      (a, b) => (b.lastPromptAt || b.createdAt || 0) - (a.lastPromptAt || a.createdAt || 0)
    )
    return sessions
  }

  read(id) {
    const proj = readProjection(this.home, id)
    const dir = findSessionDir(this.home, id)
    const logFile = dir ? pickLogFile(dir) : null
    if (!logFile) {
      return {
        id,
        title: (proj && proj.title) || (proj && proj.first) || '',
        hasLog: false,
        messages: [],
        truncated: false
      }
    }
    const events = decodeSessionLog(logFile)
    const { messages, truncated } = extractConversation(events)
    return {
      id,
      title: (proj && proj.title) || (proj && proj.first) || '',
      hasLog: true,
      messages,
      truncated,
      eventCount: events.length
    }
  }

  /** 取消归档：只把它从 archivedSessionIds 里移除，会话与日志原样保留 */
  unarchive(id) {
    mutateWorkspace(this.home, (ws) => {
      ws.global = ws.global || {}
      ws.global.archivedSessionIds = (ws.global.archivedSessionIds || []).filter((x) => x !== id)
      return ws
    })
    return { id }
  }

  /** 删除：从归档集合 + 各 Workspace 的 sessionIds 移除，并删除日志目录与投影缓存 */
  remove(id) {
    mutateWorkspace(this.home, (ws) => {
      ws.global = ws.global || {}
      ws.global.archivedSessionIds = (ws.global.archivedSessionIds || []).filter((x) => x !== id)
      const tables = (ws.tables && ws.tables.workspaces) || {}
      for (const key of Object.keys(tables)) {
        const workspace = tables[key]
        if (workspace && Array.isArray(workspace.sessionIds)) {
          workspace.sessionIds = workspace.sessionIds.filter((x) => x !== id)
        }
      }
      return ws
    })

    let removedLogBytes = 0
    const dir = findSessionDir(this.home, id)
    if (dir) {
      try {
        for (const name of fs.readdirSync(dir)) {
          removedLogBytes += fs.statSync(path.join(dir, name)).size
        }
      } catch {
        /* 大小统计失败不影响删除 */
      }
      fs.rmSync(dir, { recursive: true, force: true })
    }
    let removedCache = false
    try {
      fs.rmSync(path.join(projectionDir(this.home), `${id}.json`), { force: true })
      removedCache = true
    } catch {
      /* 缓存删除失败不影响结果 */
    }
    return { id, removedLogBytes, removedCache }
  }
}

/** 读 → 改 → 原子写 workspace.json 的通用封装 */
function mutateWorkspace(home, mutate) {
  const file = workspaceFile(home)
  const ws = readJson(file)
  if (!ws) throw new Error('找不到 workspace.json：DSH 数据目录不存在或尚未初始化')
  const next = mutate(ws)
  atomicWriteJson(file, next)
  return next
}

module.exports = { SessionArchiveManager, resolveDshHome }
