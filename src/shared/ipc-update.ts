/**
 * 自动更新：相位、状态与更新源地址
 *
 * 主进程 ↔ 渲染层契约的一部分（t55 从 `shared/ipc.ts` 拆出来的；那个文件现在只是 barrel）。
 * 约定不变：**只放类型与纯常量，禁止 import 任何运行时依赖**（渲染层要读这些类型，
 * 拖进 fs/path 就会被卷进包里）—— 叶子模块之间只允许 `import type`。
 */

// ---------------------------------------------------------------- 自动更新

/**
 * 自动更新的相位（主进程 updater.ts 是唯一写入方）。
 *
 * - `idle`：没有正在进行的动作（还没检查过，或已是最新版本）
 * - `checking`：正在请求更新元数据（latest.yml）
 * - `available`：发现了新版本，**等用户点「下载」**（我们不会自动下载）
 * - `downloading`：正在下载，percent 从 0 到 100
 * - `downloaded`：下载完成，**等用户点「重启并安装」**（退出时也不会偷偷装）
 * - `error`：任意一步失败，原因摘成一句中文放在 message 里
 * - `unsupported`：这个平台/运行形态用不了自动更新（macOS 的 ad-hoc 签名、开发态）
 */
export type UpdatePhase =
  'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | 'unsupported';

/** 自动更新的当前状态（app:update 事件、快照的 update 字段、设置页的更新卡片共用） */
export interface UpdateState {
  phase: UpdatePhase;
  /** 当前安装的版本（app.getVersion()） */
  currentVersion: string;
  /** 发现 / 已下载的新版本号；没有就是 null */
  version: string | null;
  /** 下载进度 0~100；只有 downloading 相位有意义 */
  percent: number | null;
  /** 给用户看的一句中文（错误原因也在这里，不是只写 console） */
  message: string | null;
  /** 这个运行形态能不能自动更新（macOS 与开发态为 false） */
  canAutoUpdate: boolean;
  /** 能不能检查有没有新版本：macOS 不能自动装、但**照样能查**（开发态为 false） */
  canCheck: boolean;
  /** 不能自动更新时的出路：Releases 页面 */
  releasesUrl: string;
}

/**
 * GitHub Releases 页面。与 package.json 的 build.publish（owner: yozica / repo: dsh-console）
 * 是同一处；主进程用它填 UpdateState.releasesUrl，渲染层用它做「打开下载页」的兜底。
 */
export const RELEASES_URL = 'https://github.com/yozica/dsh-console/releases';

/**
 * 版本检查用的更新源（GitHub 的 "latest" 别名指向最新一个**已发布**的 Release，
 * 草稿不算 —— 与 Windows 走 electron-updater 时读的是同一份 `latest-mac.yml`）。
 *
 * macOS 上装不了自动更新（ad-hoc 签名），但我们仍然想知道"有没有新版本"：
 * 主进程直接取这个小文件、比一下版本号就行，不引入 Squirrel 那套。
 * 与 `build.publish` 的 owner/repo 是同一处，自检会核对它们一致。
 */
export const UPDATE_MAC_FEED_URL =
  'https://github.com/yozica/dsh-console/releases/latest/download/latest-mac.yml';
