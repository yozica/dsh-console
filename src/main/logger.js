'use strict'

/**
 * 把主进程的 console 输出同时写进 <userData>/logs/console.log。
 * 非 GUI 场景（或用户懒得看终端）时，这里是排查启动问题最直接的入口。
 */

const fs = require('node:fs')
const path = require('node:path')

const MAX_BYTES = 2 * 1024 * 1024

/**
 * @param {string} dir 日志目录
 * @returns {{file:string, close:() => void}}
 */
function installFileLogging(dir) {
  const file = path.join(dir, 'console.log')
  let stream = null
  try {
    fs.mkdirSync(dir, { recursive: true })
    // 超过上限就从头写，避免无限增长
    try {
      const stat = fs.statSync(file)
      if (stat.size > MAX_BYTES) fs.truncateSync(file, 0)
    } catch {
      /* 首次运行 */
    }
    stream = fs.createWriteStream(file, { flags: 'a' })
  } catch (error) {
    console.error('[logger] 无法创建日志文件:', error.message)
    return { file: '', close: () => {} }
  }

  const originals = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  }

  const stamp = () => new Date().toISOString()
  const emit = (level, args) => {
    const text = args
      .map((value) => {
        if (value instanceof Error) return value.stack || value.message
        if (typeof value === 'string') return value
        try {
          return JSON.stringify(value)
        } catch {
          return String(value)
        }
      })
      .join(' ')
    try {
      stream.write(`${stamp()} [${level}] ${text}\n`)
    } catch {
      /* 写失败就算了，不能因为日志把应用搞挂 */
    }
  }

  for (const level of ['log', 'warn', 'error']) {
    console[level] = (...args) => {
      originals[level](...args)
      emit(level, args)
    }
  }

  return {
    file,
    close: () => {
      console.log = originals.log
      console.warn = originals.warn
      console.error = originals.error
      try {
        stream.end()
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = { installFileLogging }
