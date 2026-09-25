/**
 * 探测的形状与超时：`EnvProbeRaw` 这些只给主进程内部用，不上线缆
 *
 * t51 从 `env-doctor.ts` 拆出来的；那个文件现在只做 barrel + 两个有状态的类（`EnvDoctor` /
 * `EnvFixRunner`），别的模块与两个反例脚本的 import 路径都不用改。
 */
import type { EnvNodeOwner } from '../shared/ipc';
import type { LocalDshRequirement } from './env-node-range';

/** 探测子进程超时：与 `canRunDsh` 的 8000 一致 */
export const PROBE_TIMEOUT_MS = 8000;
/** 一键修复的超时：装 npm 包可能要编译/下载，给足 5 分钟，到点自动中断 */
export const FIX_TIMEOUT_MS = 5 * 60 * 1000;
/** 修复输出只保留尾部这些字符（与插件操作同款做法，界面显示原文用） */
export const FIX_TAIL_CHARS = 64 * 1024;
/** 探测子进程的 stderr 只保留尾部这些字符（它是给日志的原文，别把几百 KB 堆栈整段带上） */
export const STDERR_TAIL_CHARS = 2000;

/** 版本号解析结果；不引 semver，只认 NODE_RANGE / NODE_RANGE_BUILD 这两句区间 */
export interface NodeVersion {
  major: number;
  minor: number;
  patch: number;
}

/** 探测到的一条事实（子进程的结果都在这里，判定不看别的） */
export interface VersionProbe {
  path: string | null;
  /** --version 的第一行；没跑起来时为 null */
  version: string | null;
  /** 子进程的退出码；没跑起来时为 null（退出码 0 + 零输出是"静默退出"的关键特征） */
  exitCode: number | null;
  /** 子进程没能跑起来时的原因（EPERM = 这个环境不允许起子进程，和"没装"是两件事） */
  error: string | null;
  /**
   * 子进程写到 stderr 的尾部内容（**判定不看它**：界面上不许出现原始术语，
   * 它的唯一去处是日志 —— 见 `probeTroubleLines`）；没有输出时为 null。
   */
  stderr?: string | null;
  /** true = 这一轮**故意没测**（启动瞬间的快速探测）；判定当"测不出来"（warn），不是"没装" */
  skipped?: boolean;
  /**
   * true = 超过 `PROBE_TIMEOUT_MS` 没回应（子进程已被结束）。
   *
   * **必须与"退出码 0 + 零输出"区分开**：后者是"这份二进制跑不动"的签名（§7.4），
   * 前者只是"它还在忙"（例如转发器正在准备自己的运行时）。混在一起会把用户引去重装一个
   * 好端端的 dsh —— 真机上就这么错过一次。
   */
  timedOut?: boolean;
}

/** dsh 本体的定位 + 实测结果 */
export interface DshProbe {
  /** 解析结果：custom / custom-shim / node-bin / shim / npx；解析不出来时为 null */
  kind: string | null;
  /** 命令原文（界面直接显示，不重新拼） */
  display: string | null;
  /** 实测是否有输出（`node-bin` 那条路复用 canRunDsh 的缓存结论） */
  runs: boolean;
  version: string | null;
  exitCode: number | null;
  error: string | null;
  /** 四种方式都没解析出来时的原因（`resolveDshLauncher` 抛出的那句话） */
  resolveError: string | null;
  /** 同上（`VersionProbe.stderr`）：只给日志，不上界面 */
  stderr?: string | null;
  /** 同上：true = 这一轮**故意没测**（快速探测不起子进程，也就不定位 launcher） */
  skipped?: boolean;
  /** 同 `VersionProbe.timedOut`：超过 8 秒没回应，**不是**"这份 dsh 跑不动" */
  timedOut?: boolean;
}

export interface ShellProbe {
  file: string | null;
  exists: boolean;
}

/** 一轮探测的原始事实：判定的唯一入参（**不上线缆**，所以留在本模块而不是 shared/ipc.ts） */
export interface EnvProbeRaw {
  checkedAt: number;
  /** 直接用主进程的 process.platform / app.isPackaged，判定函数不自己读 */
  platform: string;
  packaged: boolean;
  bundled: { electron: string; node: string; chrome: string };
  node: VersionProbe;
  /**
   * 通用搜索（`findNodePath()`）另找到的那份外部 Node —— **只在它与 `node` 不是同一个时**才有值。
   *
   * 为什么要有：`node` 这一行报的是"**真正会被用来跑 dsh 的那一份**"（用户裁决，见 §7.25）；
   * 而机器上往往还躺着别的 node（另一个版本管理器、或一个**转发器** shim）。用户拿终端里的
   * `node -v` 来对账时对不上就是因为它。把"另有一份、它是什么"写出来，这条对不上的疑惑才收口。
   */
  otherNode?: { path: string; version: string | null; shim: boolean };
  /** `node` 那一份是不是"真正会被用来跑 dsh 的"（见 `otherNode` 的说明） */
  nodeServesDsh?: boolean;
  /**
   * **本机装的那一份 dsh 对 Node 的要求**（离线读它的安装树，见 `readLocalDshRequirement`）。
   *
   * 只有完整探测会给（快速探测不解析启动命令，也就不定位安装根）；拿不到时为 undefined，
   * 判定退回 `NODE_RANGE` 那句常量。
   */
  localDsh?: LocalDshRequirement;
  npm: VersionProbe;
  pnpm: VersionProbe;
  dsh: DshProbe;
  shell: ShellProbe;
  /**
   * 这台机器有没有 VC++ 2015-2022 运行库（`process-utils.hasVcRuntime()` 的只读判断）。
   *
   * 为什么判定需要它：pnpm 11 起在 Windows 上发的是**原生 exe**，缺这个运行库时加载直接失败、
   * 没有任何输出（真机 VM-09）。于是"该装哪一档 pnpm"成了一件事先要认的事实。
   * `true` = 有（可以装最新）；`false` = 缺（走纯 JS 那条线 `pnpm@10`）；没探测过时缺省当"有"。
   */
  vcRuntime?: boolean;
  /**
   * 我们找到的那份 Node 是不是**版本管理器管的**（见 `looksVersionManagerNode`）。
   *
   * 采集时算一次（只读路径与环境变量），判定据此区分两种"跑不出结果"：版本管理器没装/没选中版本
   * （该点应用里的「安装」）与"这份 Node 本身坏了"（该重装）。
   */
  nodeFromVersionManager?: boolean;
  /**
   * 这份 Node 是谁管的（需求 §7.7 / 冻结 §3.2.1）。
   *
   * **判定不在这里做**：采集侧只把事实凑齐（真实路径 + 环境变量 + §7.6 的模型 + 注册表里那个
   * 安装目录），判据唯一的一份是安装引擎里的纯函数 `detectNodeOwner`；`judgeEnvironment` 只搬运。
   * 快速探测也判得出来（这条判据里没有一条依赖子进程）。
   */
  nodeOwner?: EnvNodeOwner;
  /** 归属判定的证据（人话，逐条；进日志与确认区的「详情」，评审能对账"为什么是这一条"） */
  nodeOwnerEvidence?: string[];
  /** 采集本身有没有意外（例如读设置失败），有值时整份报告要带出来 */
  error: string | null;
}

/** 采集需要的运行时事实（主进程给，模块自己不读 process.* —— 见文件头） */
export interface EnvRuntime {
  platform: string;
  packaged: boolean;
  bundled: { electron: string; node: string; chrome: string };
}

export const EMPTY_VERSION_PROBE: VersionProbe = {
  path: null,
  version: null,
  exitCode: null,
  error: null,
};
