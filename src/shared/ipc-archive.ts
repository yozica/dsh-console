/**
 * 归档会话页：列表、会话正文、恢复与删除的结果
 *
 * 主进程 ↔ 渲染层契约的一部分（t55 从 `shared/ipc.ts` 拆出来的；那个文件现在只是 barrel）。
 * 约定不变：**只放类型与纯常量，禁止 import 任何运行时依赖**（渲染层要读这些类型，
 * 拖进 fs/path 就会被卷进包里）—— 叶子模块之间只允许 `import type`。
 */

// ---------------------------------------------------------------- 归档会话页

/** DSH 数据目录的位置与可用性 */
export interface DshHomeInfo {
  home: string;
  exists: boolean;
}

/** 归档列表里的一条（标题/首句来自投影缓存，logSize 来自日志文件） */
export interface ArchivedSessionSummary {
  id: string;
  title: string;
  firstPrompt: string;
  lastPromptAt: number | null;
  createdAt: number | null;
  cwd: string | null;
  turnCount: number;
  logSize: number | null;
  logFile: string | null;
  /** 标题 + 首句 + 每轮问答拼成的检索文本（页面内搜索用） */
  searchBlob: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
  time: number | null;
}

/** 读取某个归档会话的对话全文 */
export interface ConversationReadResult {
  id: string;
  title: string;
  hasLog: boolean;
  messages: ConversationMessage[];
  truncated: boolean;
  eventCount?: number;
}

/** 取消归档：只改 workspace.json 的 archivedSessionIds */
export interface UnarchiveResult {
  id: string;
  /** dsh 在跑时磁盘改动要重启才反映到它的界面里，由调用方补上这个标记 */
  dshRunning?: boolean;
}

/** 删除归档会话（日志目录 + 投影缓存一起删） */
export interface RemoveArchivedResult {
  id: string;
  removedLogBytes: number;
  removedCache: boolean;
  dshRunning?: boolean;
}

/**
 * 归档这几个 IPC 统一用 `{ ok }` 包一层（失败时带上 error），
 * 于是渲染层不必区分"抛异常"和"业务失败"。
 */
export interface ArchiveListResult extends Partial<DshHomeInfo> {
  ok: boolean;
  error?: string;
  dshRunning?: boolean;
  sessions?: ArchivedSessionSummary[];
}

export interface ArchiveReadResult {
  ok: boolean;
  error?: string;
  session?: ConversationReadResult;
}

export interface ArchiveUnarchiveResult extends Partial<UnarchiveResult> {
  ok: boolean;
  error?: string;
}

export interface ArchiveRemoveResult extends Partial<RemoveArchivedResult> {
  ok: boolean;
  error?: string;
}
