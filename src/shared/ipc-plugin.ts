/**
 * 插件装配层：层栈、条目、巡检问题与操作结果
 *
 * 主进程 ↔ 渲染层契约的一部分（t55 从 `shared/ipc.ts` 拆出来的；那个文件现在只是 barrel）。
 * 约定不变：**只放类型与纯常量，禁止 import 任何运行时依赖**（渲染层要读这些类型，
 * 拖进 fs/path 就会被卷进包里）—— 叶子模块之间只允许 `import type`。
 */

/**
 * 插件页：**装配层**的只读视图（装了什么 bundle、层序如何、生效配置长什么样）。
 *
 * 与 dsh 自己界面里的「设置 → 插件」分工不同，别混：
 *   - 那边管**运行层**：已挂载条目的清单与它们的设置项（需要插件注册 settings 命名空间）。
 *   - 这边管**装配层**：profile 的 bundle 层栈、每个 bundle 的版本与来源、
 *     你的 patch 层、以及"没报错的错"（未匹配的 patch 行等）。
 * 这里全部来自磁盘上的 profile + `dsh web --dump-config`，不依赖 dsh 是否在跑
 * ——插件把启动打挂时，恰恰只有这份数据还能看。
 */

/** 层栈里的一层：内置 bundle / 树外 bundle / profile patch / 机器级 patch */
export interface PluginLayer {
  /** in-box=随 dsh 安装目录解析 | out-of-tree=pnpm 装进 profile 的 | profile-patch / home-patch=你自己的 tweak 层 */
  kind: 'in-box' | 'out-of-tree' | 'profile-patch' | 'home-patch';
  /** 包名或文件路径（原样，界面按 kind 决定怎么显示） */
  name: string;
  version: string | null;
  /** 从磁盘上解析到的位置；解析不到为 null（不看真假值，看它是不是 null） */
  resolvedPath: string | null;
  /** pnpm 的 spec（`link:../x`、`github:you/x#sha`…）；内置层为 null */
  spec: string | null;
  /** 在 `dsh.profile.bundles` 里的序号（从 1 开始）；patch 层没有序号 */
  order: number | null;
  /** 有没有在生效配置里出现（false = 它在层栈里但什么都没贡献） */
  present: boolean;
  /** 这一层干了什么：插入多少条、覆盖多少条、其中多少条是把下层关掉 */
  contributions: {
    inserted: number;
    insertedDisabled: number;
    patched: number;
    patchedDisabled: number;
  };
}

/** 生效配置里的一条 */
export interface PluginEntry {
  id: string;
  name: string;
  disabled: boolean;
  hasConfig: boolean;
}

/** 生效配置按源层分组后的一段（dump 本身就是这么标注的） */
export interface PluginTreeLayer {
  /** dump 里的原始标签（含 `patched by`），用于展示真实来源 */
  label: string;
  source: string;
  patchedBy: string | null;
  entries: PluginEntry[];
}

/** "没报错的错"：这些不会让命令失败，但会让用户的改动悄悄不生效 */
export interface PluginProblem {
  kind:
    | 'unmatched-patch'
    | 'parse-error'
    | 'plain-dependency'
    /** 声明了 `dsh.bundle` 却不在 `dsh.profile.bundles` 里：被摘掉的那一种，能放回层里 */
    | 'suspended-bundle'
    | 'missing-layer'
    | 'other';
  /** 人类可读的一句话（已经是我们归纳过的说法） */
  detail: string;
  /** 涉及的文件（patch 层文件） */
  file?: string;
  /** unmatched-patch：指向了哪个不存在的 id */
  entryId?: string;
  /** parse-error：dsh 报的层标签（overlay / bundle 名） */
  layer?: string;
  /**
   * plain-dependency / suspended-bundle：装进来却不形成层的那个包名。
   * 界面据此给「卸掉它」；`suspended-bundle` 还多给一个「放回层里」。
   */
  packageName?: string;
  /**
   * unmatched-patch：这一条所在的文件**是不是本页能改的那份**（profile 的
   * `cordis.patch.yml`）。机器级的 `$DSH_HOME/cordis.patch.yml` 不在本页的能力范围里 ——
   * 界面据此决定给不给「删掉这一行」，不给时要说明文件在哪。
   */
  editable?: boolean;
}

/** 运行中的 Loader 条目的 fiber 阶段（null = 没有存活的根 fiber，多半是被禁用/被覆盖了） */
export type PluginFiberPhase = 'pending' | 'active' | 'loading' | 'failed' | 'unloading' | null;

/**
 * 运行中的一条（来自 dsh 的 pluginInventory/list 接口，不是配置文件）。
 * entryId 带 `include:` 前缀（根 include 加载进来的），与配置里的 id 对照时要去掉。
 */
export interface PluginLiveEntry {
  entryId: string;
  moduleName: string;
  enabled: boolean;
  fiberPhase: PluginFiberPhase;
}

/** 每个 Agent 预设会给会话挂多少行（Harness 里那个「会话插件 N 个」就是这个） */
export interface PluginLivePreset {
  id: string;
  name: string | null;
  isDefault: boolean;
  broken: string | null;
  rows: number;
}

/** 装 / 卸 / 升级：add = 安装，remove = 卸载，update = 升级 */
export type PluginOpAction = 'add' | 'remove' | 'update';

/**
 * 一次插件操作的结果。
 * code 是 dsh 的退出码；summary 是我们把 pnpm 输出归纳成的一句人话（认不出来就没有，
 * 界面显示原始输出），error 是连命令都没跑起来时（例如已经有一个操作在跑）的原因。
 */
export interface PluginOpResult {
  ok: boolean;
  code?: number | null;
  error?: string;
  summary?: string | null;
  /**
   * 这个包是随 dsh 装好的内置包、**而且你还没启用它**时给出来：界面据此在现场给一个
   * 「插进我的层」按钮（而不是让用户自己去翻 cordis.patch.yml）。
   */
  needsEnable?: { id: string; name: string };
}

/** 改「你自己的补丁层」的四个动作：插入 / 禁用 / 启用 / 移除自己的插入 */
/** 涉及 patch 层的改动动作。`drop` = 删掉一条指向了不存在 id 的条目（巡检给的出路） */
export type PluginLayerEditAction = 'disable' | 'enable' | 'insert' | 'remove-insert' | 'drop';

/** 改完的结果：是否落盘、改了哪个文件、备份到哪、改完的原文 */
export interface PluginLayerEditResult {
  ok: boolean;
  error?: string;
  changed?: boolean;
  /** 一句人话：做了什么 / 为什么没做（界面直接显示） */
  detail?: string;
  file?: string;
  backup?: string | null;
  content?: string;
}

/** 装/卸/升级时边跑边推的输出片段（界面把它们原样贴进输出区） */
export interface PluginOutputEvent {
  chunk: string;
}

/** 运行中的清单。只有 dsh 由本应用启动（手上有令牌）时才拿得到；拿不到就是 null + 一句原因。 */
export interface PluginLiveSnapshot {
  entries: PluginLiveEntry[];
  presets: PluginLivePreset[];
  counts: { total: number; active: number; failed: number; idle: number };
}

export interface PluginInspectResult {
  ok: boolean;
  error?: string;
  /** 恒为 'web'：console 启动的就是 `dsh web`（= `--profile web`） */
  profile?: string;
  home?: string;
  profileDir?: string;
  /** profile 的 package.json 里的 name，例如 dsh-profile-web */
  profileName?: string | null;
  /** live = 改 patch 即时生效；startup = 只在启动时应用；null = 老 profile 的历史默认 */
  patchReload?: string | null;
  /** 按**应用顺序**排列：先应用的在前，所以越靠后越优先 */
  layers?: PluginLayer[];
  treeLayers?: PluginTreeLayer[];
  problems?: PluginProblem[];
  entryCount?: number;
  /** 页面会跑的命令（给人看"这些数字是怎么来的"） */
  commands?: string[];
  /** 解析不出结构时的原文（界面降级为纯文本，而不是显示空白） */
  rawDump?: string | null;
  /** 运行中的清单；拿不到时是 null（看 liveError 的原因），页面退回纯静态视图 */
  live?: PluginLiveSnapshot | null;
  liveError?: string;
  /** 装/卸/升级要 pnpm；`dsh plugin` 内部是裸 spawn('pnpm')，所以这里先把结论告诉界面 */
  pnpm?: { found: boolean; path: string | null };
  /** 本次装/卸/升级实际走的源（设置里留空时为 null，含义是"跟随系统 npm 配置"） */
  registry?: string | null;
  /**
   * profile 的 bundle 列表（带"是不是内置"）。**`ok: false` 时也给** —— dump 读不出来
   * （比如某个 bundle 解析不到、dsh 因此起不来）时，救援条只能靠它点名"可以停用哪个"。
   * 内置包不能停用（那是 dsh 自己的骨架），所以这里就把 `inBox` 标出来。
   */
  bundles?: { name: string; inBox: boolean }[];
  /**
   * true = 这份结果来自 `--dump-default-config`（dsh 自带的组合，**不含你的层**）。
   * 配置被改坏时的救援视图，界面上必须写明"这不是你现在真正生效的配置"。
   */
  baseline?: boolean;
}

/** 补丁层的备份（救援时可以从这里恢复） */
export interface PluginPatchBackup {
  name: string;
  path: string;
  /** 修改时间（毫秒） */
  at: number;
  bytes: number;
}

/** 救援结果：修成空配置 / 列备份 / 从备份恢复，三种动作共用 */
export interface PluginRescueResult {
  ok: boolean;
  error?: string;
  changed?: boolean;
  detail?: string;
  file?: string;
  backup?: string | null;
  content?: string;
  /** 只有 list-backups 会带 */
  backups?: PluginPatchBackup[];
}

/** 救援动作：把一个 bundle 从 `dsh.profile.bundles` 里摘掉 / 放回原位 */
export interface PluginBundleEditResult {
  ok: boolean;
  error?: string;
  changed?: boolean;
  detail?: string;
  file?: string;
  backup?: string | null;
  /** 它原来的位置（0 起）：恢复时要带回来，否则层序会被改掉 */
  index?: number;
}
