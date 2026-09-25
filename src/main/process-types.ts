/**
 * 平台判断、COMSPEC 与跨模块共用的形状（InvocationSpec / DshLauncher / ProbeResult / PortOwner / ShellSpec）
 *
 * 返回进程探测与命令解析的公共形状（从 `process-utils.ts` 拆出来的；那个文件现在只做 barrel 再导出，
 * 6 个消费者与两个反例脚本的 import 路径不用改）。
 */

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const COMSPEC = process.env.ComSpec || 'cmd.exe';

/** 要执行的命令：file + args 交给 PTY，display 只用于界面与日志 */
export interface InvocationSpec {
  file: string;
  args: string[];
  display: string;
  kind: string;
}

/** 「解释器 + dsh 入口脚本」的一个候选组合 */
export interface InterpreterCandidate {
  node: string;
  binJs: string;
  source: string;
}

/**
 * 「怎么调用 dsh」——把解释器与入口脚本的解析从"启动 web 应用"里拆出来。
 *
 * 拆的理由：同一个 dsh 还有别的子命令要调（`plugin` 管插件、`web --dump-config`
 * 看生效配置），它们必须用**同一个解释器**。dsh 的 CLI 在旧 Node 上会静默退出
 * （退出码 0、零输出），所以这里挑出来的组合是实测能跑的，不能各自再猜一遍。
 */
export interface DshLauncher {
  /** 真正要 spawn 的可执行文件（node / dsh shim / npx，Windows 上可能是 cmd.exe） */
  file: string;
  /** 位于 dsh 子命令之前的固定参数（入口脚本路径、npx 的 -y 等） */
  prefixArgs: string[];
  /** true 表示 file 是 cmd.exe、prefixArgs 开头是 /d /s /c + 脚本，后续参数要按 cmd 的规则转义 */
  viaCmd: boolean;
  /** 给人看的调用前缀（不含子命令），用于 display 与日志 */
  display: string;
  kind: string;
}

/** HTTP 探测结果 */
export interface ProbeResult {
  reachable: boolean;
  isDsh: boolean;
  latencyMs: number;
  statusCode?: number;
  body?: string;
  location?: string;
  error?: string;
}

/** 监听某个端口的进程 */
export interface PortOwner {
  pid: number;
  local: string;
  port: number;
}

/** 本地 Shell 的启动描述 */
export interface ShellSpec {
  file: string;
  args: string[];
  display: string;
}

/** 一个 Node 版本的安装目录（bin 与全局 node_modules） */
export interface VersionManagerInstall {
  bin: string;
  modules: string;
}
