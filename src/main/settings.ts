/**
 * 应用设置：持久化到 <userData>/settings.json。
 * 主进程持有唯一实例，渲染层通过 IPC 读写。
 *
 * 类型说明：设置项的形状由 DEFAULTS 反推（`typeof DEFAULTS`），
 * 所以"加一个设置项"只需要动 DEFAULTS 一处，get/patch 的键名与取值类型会自动跟上。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { SettingsValues } from '../shared/ipc';

/** 设置结构版本；用于一次性迁移（见 Settings.migrate） */
const SETTINGS_VERSION = 2;

// 设置项的形状定义在 src/shared/ipc.ts（渲染层要用同一份契约）；
// 这里只负责给出默认值，形状对不上时 tsc 会报错。
export const DEFAULTS: SettingsValues = {
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
  /** 自动检查更新：启动后检查一次，之后每 6 小时一次（只提示，下载与安装都要用户点） */
  autoCheckUpdates: true,
  /** 状态轮询间隔（毫秒） */
  pollIntervalMs: 1500,
  /** 启动后多少毫秒仍未通过健康检查就判定为异常 */
  startTimeoutMs: 60000,
  /** 停机优雅等待（毫秒），超时后强杀进程树 */
  stopGraceMs: 3000,
};

/** 全部设置项（也是渲染层看到的形状）——再导出一次，主进程内部从 './settings' 拿就行 */
export type { SettingsValues };
/** 允许写入的设置项子集 */
export type SettingsPatch = Partial<SettingsValues>;
/** 迁移信息，供启动日志说明 */
export interface SettingsMigration {
  from: number;
  to: number;
}

export class Settings {
  readonly file: string;
  values: SettingsValues;
  /** 本次启动是否发生了设置结构迁移；没发生就是 null */
  migration: SettingsMigration | null = null;

  constructor(file: string) {
    this.file = file;
    this.values = { ...DEFAULTS };
    this.load();
  }

  load(): SettingsValues {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.values = { ...DEFAULTS, ...(parsed as SettingsPatch) };
        this.migration = this.migrate(parsed as Record<string, unknown>);
      }
    } catch {
      // 首次运行或文件损坏：使用默认值
    }
    return this.values;
  }

  /**
   * 一次性迁移：v1 → v2 把「启动行为」的三个开关对齐到新默认
   * （自动拉起 dsh、自动进 DeepSeek Harness、自动全屏）。
   * 只在文件里记录的版本更旧时执行一次，之后用户自己怎么改都不会被覆盖。
   */
  migrate(parsed: Record<string, unknown>): SettingsMigration | null {
    const from = Number(parsed.settingsVersion || 1);
    if (!Number.isFinite(from) || from >= SETTINGS_VERSION) return null;
    this.values.autoStart = true;
    this.values.openUiOnStart = true;
    this.values.uiFullscreenOnStart = true;
    this.values.settingsVersion = SETTINGS_VERSION;
    this.save();
    return { from, to: SETTINGS_VERSION };
  }

  all(): SettingsValues {
    return { ...this.values };
  }

  get<K extends keyof SettingsValues>(key: K): SettingsValues[K] {
    return this.values[key];
  }

  /**
   * 合并写入。**只认识 DEFAULTS 里有的键**，其余一律忽略 —— 渲染层传来的对象
   * 形状不可信，这里是唯一的守门处。
   */
  patch(partial: SettingsPatch | null | undefined): SettingsValues {
    if (!partial || typeof partial !== 'object') return this.all();
    for (const [key, value] of Object.entries(partial)) {
      if (key in DEFAULTS) {
        // 保持原有语义：传进来什么就写什么（渲染层那边已经把数字规整过了）。
        // SettingsValues 是具名接口、没有索引签名，所以这里显式经 unknown 转换。
        (this.values as unknown as Record<string, unknown>)[key] = value;
      }
    }
    this.save();
    return this.all();
  }

  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2), 'utf8');
    } catch (error) {
      console.error('[settings] 写入失败:', error instanceof Error ? error.message : String(error));
    }
  }
}
