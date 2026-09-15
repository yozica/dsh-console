'use strict'

/**
 * 应用设置：持久化到 <userData>/settings.json。
 * 主进程持有唯一实例，渲染层通过 IPC 读写。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 设置结构版本；用于一次性迁移（见 Settings.migrate） */
const SETTINGS_VERSION = 2

const DEFAULTS = {
  /** 设置结构版本 */
  settingsVersion: SETTINGS_VERSION,
  /** dsh web 监听地址 */
  host: '127.0.0.1',
  /** dsh web 监听端口（0 = 由系统分配） */
  port: 3080,
  /** 自定义启动命令；留空则自动探测 dsh */
  dshCommand: '',
  /** dsh 进程的工作目录；留空使用用户主目录 */
  cwd: '',
  /** 传给 dsh 的附加参数（空格分隔，支持引号） */
  extraArgs: '',
  /** 本地面板里"新建本地 Shell"使用的 shell；留空自动选择：Windows 是 pwsh > powershell > cmd，macOS/Linux 是 $SHELL > zsh > bash > sh */
  shell: '',
  /** 界面主题：system（跟随系统）/ light / dark */
  themeMode: 'system',
  /** 「DeepSeek 用量」页加载的地址（默认开放平台的用量页；也可以换成主页） */
  deepseekUrl: 'https://platform.deepseek.com/usage',
  /** 启动应用时自动拉起 dsh（已在跑就接管，不重复启动） */
  autoStart: true,
  /** dsh 就绪后自动切到 DeepSeek Harness 页 */
  openUiOnStart: true,
  /** 进 DeepSeek Harness 页时自动开启应用内全屏 */
  uiFullscreenOnStart: true,
  /** 关闭应用时是否一并停止本应用启动的 dsh */
  killOnExit: true,
  /** 状态轮询间隔（毫秒） */
  pollIntervalMs: 1500,
  /** 启动后多少毫秒仍未通过健康检查就判定为异常 */
  startTimeoutMs: 60000,
  /** 停机优雅等待（毫秒），超时后强杀进程树 */
  stopGraceMs: 3000
}

class Settings {
  /** @param {string} file */
  constructor(file) {
    this.file = file
    this.values = { ...DEFAULTS }
    this.load()
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        this.values = { ...DEFAULTS, ...parsed }
        this.migration = this.migrate(parsed)
      }
    } catch {
      // 首次运行或文件损坏：使用默认值
    }
    return this.values
  }

  /**
   * 一次性迁移：v1 → v2 把「启动行为」的三个开关对齐到新默认
   * （自动拉起 dsh、自动进 DeepSeek Harness、自动全屏）。
   * 只在文件里记录的版本更旧时执行一次，之后用户自己怎么改都不会被覆盖。
   * @returns {{from:number,to:number}|null} 迁移信息，供启动日志说明
   */
  migrate(parsed) {
    const from = Number(parsed.settingsVersion || 1)
    if (!Number.isFinite(from) || from >= SETTINGS_VERSION) return null
    this.values.autoStart = true
    this.values.openUiOnStart = true
    this.values.uiFullscreenOnStart = true
    this.values.settingsVersion = SETTINGS_VERSION
    this.save()
    return { from, to: SETTINGS_VERSION }
  }

  all() {
    return { ...this.values }
  }

  get(key) {
    return this.values[key]
  }

  patch(partial) {
    if (!partial || typeof partial !== 'object') return this.all()
    for (const [key, value] of Object.entries(partial)) {
      if (key in DEFAULTS) this.values[key] = value
    }
    this.save()
    return this.all()
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2), 'utf8')
    } catch (error) {
      console.error('[settings] 写入失败:', error.message)
    }
  }
}

module.exports = { Settings, DEFAULTS }
