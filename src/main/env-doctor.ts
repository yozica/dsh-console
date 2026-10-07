/**
 * 运行环境自检 + 一键修复（设计见 `docs/env-doctor.md`）。
 *
 * 这个模块解决的是「打开应用之后，这台机器上到底有什么、能不能用」：
 *   - **探测是只读的**：找外部 node / npm / pnpm / dsh 本体、实测 dsh 能不能跑、
 *     看应用自带运行时与本地 Shell。不写任何文件、不改设置。
 *   - **判定是纯函数**（`judgeEnvironment`）：只读入参，不碰磁盘、不起子进程、
 *     不读 `process.*`、不看时钟 —— 所以自检喂一个对象字面量就能把八项的所有分支测完。
 *   - **修复只有两个动作**（`install-pnpm` / `install-dsh`）：都用探测到的完整路径
 *     npm、argv 数组、不经 shell，每次都要用户点确认，跑完自动复检。
 *
 * 为什么判定必须纯：这一页的全部价值是"说清事实"。一旦判定里混进 IO，它就只能在真机上验证 ——
 * 而真机上恰好是最难复现"没装 pnpm / node 版本不对"的地方。
 *
 * 为什么这里不 import electron：自检要直接 import 这个模块（静态检查 + 纯函数夹具），
 * 而 electron 在普通 Node 里加载不了。运行时事实由主进程通过 `EnvDoctorHooks.runtime` 注入。
 *
 * t51 起这个文件是 **barrel + 两个有状态的类**：纯函数与探测按主题住在 `env-*.ts` 里
 * （probe-types / node-range / fix-plan / judge / probe / wizard），这里把公开面逐条再导出，
 * 并留下 `EnvDoctor` / `EnvFixRunner`（它们的实例状态跨好几个阶段，拆散只会更容易坏）。
 * **不要在这里加新的纯函数** —— 放对应的叶子模块。
 */
import { probeFixTarget } from './env-fix-plan';
import { resolveDshNpmBinding, resolveNpmForDsh } from './dsh-npm';

import { collectEnvProbe, readNpmPrefix } from './env-probe';

import type {
  EnvCheckId,
  EnvCheckStatus,
  EnvDoctorReport,
  EnvFixAction,
  EnvFixDraft,
  EnvFixPlan,
  EnvFixState,
  EnvPnpmBinding,
} from '../shared/ipc';
import { pluginRegistryEnv } from './plugin-manager';
import { Settings } from './settings';
import {
  INSTALL_SCRIPTS_WARNING,
  PNPM_PURE_JS_SPEC,
  RAW_LOG_CHARS,
  describePnpmRunFailure,
  envFixPlan,
  fixDoneMessage,
  fixPlanMissingMessage,
  fixTimeoutMessage,
  npmLaunchSpec,
  pnpmInstallSpec,
  refreshLookupPath,
  summarizeEnvFixFailure,
} from './env-fix-plan';
import type { FixProbe } from './env-fix-plan';
import { judgeEnvironment, probeTroubleLines } from './env-judge';
import { FIX_TAIL_CHARS, FIX_TIMEOUT_MS } from './env-probe-types';
import type { EnvProbeRaw, EnvRuntime } from './env-probe-types';
import { emptyProbe, findNpm, messageOf } from './env-probe';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { cleanNpmEnv, envWithKnownBins, hasVcRuntime, homeDir } from './process-utils';
import { pnpmBindingForProfile, pnpmHelpersFor, readPnpmOwnerFacts } from './process-pnpm';
import type { PnpmHelpers } from './process-pnpm';
import { loadPkgUpdates } from './pkg-updates';
import { pluginProfileDir } from './plugin-parse';

export interface EnvDoctorHooks {
  /** 主进程注入的运行时事实（platform / isPackaged / process.versions） */
  runtime: () => EnvRuntime;
  /** 每完成一轮（含一键修复后的复检）时的回调 */
  onReport?: (report: EnvDoctorReport) => void;
  /**
   * 日志行（**可选**：不传就一个字都不记，既有调用方不受影响）。
   *
   * 为什么需要它：界面上只说人话（冻结 §3.8 #22 —— `PATH` / `dsh.cmd` / `npx` / `EPERM`
   * 这类内部记号一律不上界面），但**原始错误不能跟着消失**。真机上"这台机器的 node / dsh
   * 为什么用不了"唯一的凭据就是子进程给的那句原文（`VersionProbe.error`、
   * `DshProbe.resolveError`），它现在哪儿都不落，下次排查只能靠猜 —— VM 实测里撞到的
   * 正是这个场景。
   *
   * 判据因此是成对的：**日志里找得到原文，界面文案里找不到**。两条断言都在
   * `test/selftest.ts` 的 17c / 17d 两节里（词表规则不因此放松）。
   */
  log?: (line: string) => void;
}
/**
 * 本机这一份 dsh / pnpm 的版本（**复用已有探测事实，不新增探测路径**）。
 *
 * dsh 有两处来源，必须都看：
 *   - `raw.localDsh.version`：离线读它安装树里的 `package.json`。**最常见的那条路（node + bin.js）
 *     只有这个有值** —— `collectDshProbe` 对 `node-bin` 是复用 `canRunDsh` 的缓存结论，那里
 *     只记"跑得动"、不记版本号（真机实测：`raw.dsh.version` 在这一路是 null）。
 *   - `raw.dsh.version`：实测 `dsh --version` 的输出，覆盖 `npx` / shim 那几条路（那时候解析不出安装根）。
 *
 * pnpm 只有一处（`raw.pnpm.version`，就是 `pnpm -v` 的输出）。
 */
function installedVersionsOf(raw: EnvProbeRaw): InstalledVersions {
  return {
    dsh: raw.localDsh?.version ?? raw.dsh.version ?? null,
    pnpm: raw.pnpm.version ?? null,
  };
}

/** 本机这一份的版本（界面上那两个更新入口做比对用） */
export interface InstalledVersions {
  dsh: string | null;
  pnpm: string | null;
}

/**
 * 自检的报告持有者：**缓存 + 采集 + 复检**。
 *
 * 缓存的就是那份 `EnvDoctorReport`，不额外找地方存：
 *   - `report()`：有缓存直接给（窗口重载 / 切页时不必重跑一堆子进程）；
 *   - `report(true)` / `recheck()`：清缓存重跑；
 *   - `invalidate()`：改过 `dshCommand` / `cwd` / `shell` 时让缓存失效，**不主动重跑**
 *     （用户此刻在设置页，切到自检页时自然会拿到新结论）。
 *
 * 真跑一轮（缓存命中不算）还会把"因跑出错而没通过"的**原始错误**交给可选的 `hooks.log`：
 * 界面上那些句子是给人看的（不许出现内部术语），原文只在日志里 —— 见 `probeTroubleLines`。
 */
export class EnvDoctor {
  private cached: EnvDoctorReport | null = null;
  /**
   * `npm prefix -g` 的结果，**按 npm 路径**缓存（键 = npm 可执行文件）。
   * 见 `npmPrefixFor` 的说明：dsh 与 pnpm 可能用两份不同的 npm，不能只缓存一份。
   */
  private prefixByNpm = new Map<string, string | null>();
  /** 上一轮探测到的版本（`installedVersions()` 读它；跟着 `report()` 一起更新） */
  private installed: InstalledVersions = { dsh: null, pnpm: null };

  constructor(
    private readonly settings: Settings,
    private readonly hooks: EnvDoctorHooks,
  ) {}

  get platform(): string {
    return this.hooks.runtime().platform;
  }

  invalidate(): void {
    this.cached = null;
    this.prefixByNpm.clear();
  }

  async report(refresh = false): Promise<EnvDoctorReport> {
    if (!refresh && this.cached) return this.cached;
    this.prefixByNpm.clear();
    const { report: judged, raw } = await this.judge(refresh);
    // 顺手接住本机版本：版本比对（`env:pkg-updates`）要用，但它**不该**再起一轮探测
    this.installed = installedVersionsOf(raw);
    // 界面撤下去的那些原始错误在这里落日志（**只落日志**：界面文案仍是人话）。
    // 放在最前面：哪怕后面问 `npm prefix -g` 出了意外，这一轮的原文也已经记下来了。
    this.logTrouble(raw, judged);
    // plans 里的 target 要问一次 npm（判定是纯函数，不问）；没有可用的计划时连问都不问。
    //
    // **按计划里那一条 npm 分别问**（方案 A）：install-dsh 用的 npm 现在可能与 install-pnpm
    // 那份不是同一个，用一份 prefix 糊弄两个计划会把"会装进 …"写错。
    const plans = await Promise.all(
      judged.plans.map(async (plan) => ({ ...plan, target: await this.npmPrefixFor(plan.file) })),
    );
    const report: EnvDoctorReport = { ...judged, plans };
    this.cached = report;
    this.hooks.onReport?.(report);
    return report;
  }

  /**
   * 本机这一份的版本（只读）。没有缓存时先跑一轮 `report()` —— 调用它的
   * `env:pkg-updates` 本来就只在详情层打开/重新检测时被调，那时报告通常已经在手上；
   * 兜这一下是为了"先开详情层再查版本"这种顺序也不会拿到空读数。
   *
   * 已知的小代价：`report()` 自己不去重并发调用，所以"应用刚起来就有人打开详情层"时，
   * 这一下可能与启动后的那一轮探测并跑（两轮探测，事实相同、结果一致）。窗口只有启动后那几秒，
   * 而且 `canRunDsh` 这类子进程结论是按进程缓存的；真要收口得动 `report()`（门禁那条路也在用），
   * 不划算。
   */
  async installedVersions(): Promise<InstalledVersions> {
    if (!this.cached) await this.report();
    return { ...this.installed };
  }

  /** 一键修复跑完后的复检（设计 3.3）：清缓存重跑一轮并把结果交给调用方 */
  async recheck(): Promise<EnvDoctorReport> {
    return await this.report(true);
  }

  /**
   * 现场重算一个动作的计划 —— `envFix` 只递 action，命令这边现算（安全模型第 1 条：
   * 渲染层递回来的路径一概不采信）。
   *
   * **用哪份 npm 与报告侧同一个来源**（方案 A）：`install-dsh` 读 `dsh-npm.ts` 的绑定缓存
   * （所以界面上显示的那条命令与这里真正要跑的**必然是同一条**），`install-pnpm` 保持
   * `findNpm()` 不变。绑定是 `unbound`（推不出该装进哪个 Node）时给 null → 没有计划 → 不给入口。
   */
  async fixPlan(action: EnvFixAction, version: string | null = null): Promise<EnvFixPlan | null> {
    // 「更新 pnpm」不吃 npm：命令由**归属**决定，目标版本与界面读数同一个来源（同一份缓存）。
    // 它的 `target` 也由计划自己给（被更新那份 pnpm 所在的目录），所以**不再问 `npm prefix -g`**
    // —— 对 `brew` / `corepack` 问 npm 前缀本来就没有意义。
    if (action === 'update-pnpm') {
      return envFixPlan(action, null, hasVcRuntime(), {
        // 用户在下拉里挑的那一版（**已校验**：形状 + 落在这一条大版本线的列表里）。
        // 不递的话 `envFixPlan` 用算出来的目标（同一条线内最新）。Homebrew 那一档在 IPC 层就被拒了。
        version,
        pnpm: await this.pnpmUpdateInput(),
      });
    }
    // VC++ 运行库这条事实**现场再认一次**（用户可能在两次点击之间装上了运行库）
    const npmPath = action === 'install-dsh' ? resolveNpmForDsh(this.settings.all()) : findNpm();
    const plan = envFixPlan(action, npmPath, hasVcRuntime(), { version });
    if (!plan) return null;
    return { ...plan, target: await this.npmPrefixFor(plan.file) };
  }

  /**
   * 「更新 pnpm」现场要的三件东西：**归属**（现认一次，用户可能在两次点击之间换了 pnpm）、
   * 归属对应的**工具**（corepack / npm / brew）、以及**目标版本**。
   *
   * 目标版本走 `loadPkgUpdates`（与界面读数同一份缓存）：同一个大版本线内的最新 ——
   * 所以"确认区里显示要装到哪一版"与"真正执行的 argv"必然一致。
   */
  private async pnpmUpdateInput(): Promise<{
    binding: EnvPnpmBinding;
    helpers: PnpmHelpers;
    target: string | null;
  }> {
    const binding = pnpmBindingForProfile(pluginProfileDir());
    if (!binding.file) {
      return {
        binding,
        helpers: { corepackFile: null, npmFile: null, brewFile: null },
        target: null,
      };
    }
    const facts = readPnpmOwnerFacts(binding.file);
    const helpers = pnpmHelpersFor(
      { owner: binding.owner, file: binding.file },
      facts,
      this.platform,
    );
    const updates = await loadPkgUpdates({
      settings: this.settings.all(),
      installed: await this.installedVersions(),
      pnpmBinding: binding,
      // 没有 pnpm 时才用得上这条安装线（这里必有 file，所以它不影响结果；给上是为了类型完整）
      pnpmInstallMajor: pnpmInstallSpec(hasVcRuntime()) === PNPM_PURE_JS_SPEC ? '10' : null,
    });
    return { binding, helpers, target: updates.pnpm.target };
  }

  /**
   * `npm prefix -g`，**按 npm 路径**缓存。
   *
   * 为什么按路径而不是缓存一份：一份 npm 对应一个全局目录，而 install-dsh 与 install-pnpm
   * 现在可能用的是两份不同的 npm —— 缓存成一份就会把其中一条计划的"会装进 …"写成另一条的。
   */
  private async npmPrefixFor(npmPath: string | null): Promise<string | null> {
    const key = String(npmPath ?? '').trim();
    if (!key) return null;
    if (this.prefixByNpm.has(key)) return this.prefixByNpm.get(key) ?? null;
    const value = await readNpmPrefix(key, this.platform);
    this.prefixByNpm.set(key, value);
    return value;
  }

  private async judge(refresh = false): Promise<{ report: EnvDoctorReport; raw: EnvProbeRaw }> {
    const runtime = this.hooks.runtime();
    try {
      const raw = await collectEnvProbe(this.settings.all(), runtime);
      // 「更新 dsh」要用的那份 npm 在这里解析**一次**（`dsh-npm.ts`，按进程缓存）。
      // 执行侧（`fixPlan`）读同一份缓存 —— 这就是"显示 == 执行"的机械保证，不靠"但愿 PATH 没变"。
      raw.dshNpm = resolveDshNpmBinding(this.settings.all(), { refresh });
      return { report: judgeEnvironment(raw), raw };
    } catch (error) {
      // 采集炸了也要给出一份能显示的报告：八行照常显示，error 非空由界面顶部说明。
      // 这一路不解析绑定：`dshNpm` 缺省（判定按"沿用 npm 那一份"处理），也就不写那条诚实边界。
      const raw = emptyProbe(runtime, `这一轮没测全：${messageOf(error)}`);
      return { report: judgeEnvironment(raw), raw };
    }
  }

  /**
   * 把这一轮"因跑出错而没通过"的原始错误写进日志（`log` 钩子不传就什么都不做）。
   *
   * 记日志这件事**绝不拖垮自检**：与 `logger.ts` 写盘失败时的原则一致，这里也兜住异常。
   */
  private logTrouble(raw: EnvProbeRaw, report: EnvDoctorReport): void {
    const log = this.hooks.log;
    if (!log) return;
    try {
      for (const line of probeTroubleLines(raw, report)) log(`环境自检：${line}`);
    } catch {
      // 日志是排查的辅助，不是自检的一部分；它失败不该让这一页拿不到结果
    }
  }
}

export interface EnvFixHooks {
  /** 边跑边推的输出片段 */
  output: (chunk: string) => void;
  /** 相位 / 收尾消息 / 复检报告的变化 */
  state: (state: EnvFixState) => void;
  /** 事件日志（不静默：动作与结果都记一条） */
  log: (text: string) => void;
  /**
   * 日志文件的位置（**可选**：主进程传 `<userData>/logs/console.log`）。
   *
   * 为什么要它：装出来的东西跑不起来时，界面必须能告诉用户"细节在哪"（t23 那条口径：
   * 细节留日志、结论给人话）。模块自己不 import electron、也不知道 userData，所以由主进程给。
   * 拿不到（写盘失败）时给 null，界面文案退化成"用户数据目录下的 logs/console.log"。
   */
  logFile?: () => string | null;
}

/**
 * 一键修复的执行者。
 *
 * 安全模型（见 docs/env-doctor.md 第 3 节）：
 *   - 渲染层只递 `action`，argv 由这边用 `fixPlan()` + `npmLaunchSpec()` 现算；
 *   - `spawn(file, args)` + 数组，**没有 `shell: true`**；
 *   - PATH 用 `envWithKnownBins` 补齐（Windows 上保留系统原有的 `Path` 键名）；再用
 *     `cleanNpmEnv` 丢掉**继承来的** `npm_config_*`（否则 `i -g` 的全局目录由父进程那套变量
 *     决定、而不是由这份 npm 的位置决定，见 docs/env-doctor.md 的「根因」一节）；
 *     最后才用 `pluginRegistryEnv` 注入安装源（只影响这一次子进程）；
 *   - 同一时刻只允许一个动作（两个 npm 同时改全局目录，结果不可预期）；
 *   - 可中断（`cancel()` → kill），到点自动中断（FIX_TIMEOUT_MS）。
 */
export class EnvFixRunner {
  private child: ChildProcess | null = null;
  /**
   * 同步的互斥位（**不要**用 `child` 代替它）：`child` 要到 spawn 之后才为真，
   * 而 `run()` 里从入口到 spawn 之间隔着 `fixPlan()`（一次子进程）。两次连点会都在
   * `this.busy` 那一行通过，于是两个 npm 同时改全局目录 —— 这一位必须在第一个 `await`
   * 之前同步置上，终态 publish 时释放（另有一层 finally 兜住异常路径）。
   */
  private running = false;
  private cancelled = false;
  private timedOut = false;
  /**
   * 这一轮跑完的时刻。**按轮次只打一次戳**：`run()` 开头清掉、第一个终态补上。
   *
   * 为什么不用"每次终态都 `Date.now()`"：终态在将来若有第二条发布路径（例如复检报告晚到再发一次
   * `done`），时间戳会往**后**漂；而界面拿它跟"那份 dsh 是什么时候起来的"比，漂晚一点就会把
   * **已经生效**的更新又提示一遍 —— 那正是这次要修的 bug 的另一副面孔。
   */
  private finishedAt: number | null = null;
  private current: EnvFixState = {
    phase: 'idle',
    action: null,
    command: null,
    message: null,
    code: null,
    report: null,
    finishedAt: null,
  };

  constructor(
    private readonly settings: Settings,
    private readonly doctor: EnvDoctor,
    private readonly hooks: EnvFixHooks,
  ) {}

  get busy(): boolean {
    return this.running || this.child !== null;
  }

  state(): EnvFixState {
    return { ...this.current };
  }

  cancel(): boolean {
    if (!this.child) return false;
    this.cancelled = true;
    this.child.kill();
    return true;
  }

  async run(action: EnvFixAction, version: string | null = null): Promise<EnvFixState> {
    if (this.busy) {
      return { ...this.current, message: '已经有一个修复在进行中' };
    }
    // 同步占位，且必须在第一个 `await` 之前（见 running 的说明）。
    // 写在 `try` 外面是有意的：`try` 里第一句就是 `await`，这样后来往里加代码也不会把它挤到 await 后面。
    this.running = true;
    // 新的一轮：这一轮还没跑完，所以"跑完的时刻"必须先清掉（否则界面会拿上一轮的时间戳去比）
    this.finishedAt = null;
    try {
      // 真正的流程在 execute 里（中间那一串 await 都不碰互斥位）
      return await this.execute(action, version);
    } finally {
      // 兜住所有路径（包括抛异常）：互斥位绝不能留着自己不放
      this.running = false;
    }
  }

  private async execute(action: EnvFixAction, version: string | null): Promise<EnvFixState> {
    const plan = await this.doctor.fixPlan(action, version);
    if (!plan) {
      return this.publish({
        phase: 'error',
        action,
        command: null,
        message: fixPlanMissingMessage(action),
        code: null,
        report: null,
      });
    }

    // Windows 上 npm.cmd 不能直接 spawn、也不能让 Node 自己加引号：包装器统一处理
    const spec = npmLaunchSpec(plan.file, plan.args, this.doctor.platform);
    // 顺序是有意的：**先清干净继承来的 npm 配置，再注入我们刻意给的那一项**。
    //   - `cleanNpmEnv` 丢掉父进程漏进来的那套 `npm_config_*`（不清的话，`i -g` 的全局目录由
    //     那些变量决定、而不是由这份 npm 的位置决定 —— 于是"装到别的 Node 那棵树上去"，
    //     真机实测与根因见 docs/env-doctor.md 的「根因：继承的 npm_config_*」）；
    //   - `pluginRegistryEnv` 必须排在后面，否则设置里填的安装源会被一起清掉。
    const env: NodeJS.ProcessEnv = {
      ...cleanNpmEnv(envWithKnownBins(process.env)),
      ...pluginRegistryEnv(this.settings.all().pluginRegistry),
    };

    this.cancelled = false;
    this.timedOut = false;
    this.publish({
      phase: 'running',
      action,
      command: plan.display,
      message: null,
      code: null,
      report: null,
    });
    this.hooks.log(`环境修复：${plan.display}（本次使用设置里的插件安装源，如有）`);

    // 两路分开收：合并的 `tail` 给归纳器与输出区，**分开的两份进日志**（VM-06 的教训：
    // "文件在、跑起来零输出"必须能一眼看出是 stdout 空、stderr 空还是哪一路有话说）
    let tail = '';
    let outText = '';
    let errText = '';
    const collect = (chunk: Buffer | string): void => {
      const text = String(chunk);
      tail = (tail + text).slice(-FIX_TAIL_CHARS);
      this.hooks.output(text);
    };
    const collectOut = (chunk: Buffer | string): void => {
      outText = (outText + String(chunk)).slice(-RAW_LOG_CHARS);
      collect(chunk);
    };
    const collectErr = (chunk: Buffer | string): void => {
      errText = (errText + String(chunk)).slice(-RAW_LOG_CHARS);
      collect(chunk);
    };

    const outcome = await new Promise<{ code: number | null; error: string | null }>((resolve) => {
      let settled = false;
      const finish = (value: { code: number | null; error: string | null }): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let child: ChildProcess;
      try {
        child = spawn(spec.file, spec.args, {
          env,
          // cwd 固定成主目录：继承来的 cwd 是 Electron 的启动目录（从 Finder 起可能是 /），
          // 那里若有一份 .npmrc 会意外生效。
          cwd: homeDir(),
          windowsHide: true,
          // 命令行是我们按 cmd 规则拼好的，Node 不要再加引号（见 LaunchSpec 的说明）
          windowsVerbatimArguments: spec.windowsVerbatimArguments,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        finish({ code: null, error: messageOf(error) });
        return;
      }
      this.child = child;

      const timer = setTimeout(() => {
        this.timedOut = true;
        collect(`\n（超过 ${Math.round(FIX_TIMEOUT_MS / 60000)} 分钟，已中断）\n`);
        child.kill();
      }, FIX_TIMEOUT_MS);
      timer.unref?.();

      child.stdout?.on('data', collectOut);
      child.stderr?.on('data', collectErr);
      child.on('error', (error: Error) => {
        clearTimeout(timer);
        this.child = null;
        collect(`\n${error.message}\n`);
        finish({ code: null, error: error.message });
      });
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        this.child = null;
        finish({ code, error: null });
      });
    });

    if (this.cancelled) {
      const message = this.timedOut
        ? '已中断（超时自动中断，npm 可能已经写了一部分）'
        : '已中断（npm 可能已经写了一部分）';
      return this.publish({
        phase: 'cancelled',
        action,
        command: plan.display,
        message,
        code: outcome.code,
        report: null,
      });
    }
    // 超时是**独立终态**：到点是我们主动 kill 的，退出码会是 null / 非 0，不能落进下面
    // 「退出码 N，认不出具体原因」那条 —— 那条是给 npm 自己失败用的，会把真正的原因说错。
    if (this.timedOut) {
      const message = fixTimeoutMessage();
      this.logFixRaw(plan, outcome.code, outText, errText, '超时中断');
      this.hooks.log(`环境修复失败：${plan.display} → ${message}`);
      return this.publish({
        phase: 'error',
        action,
        command: plan.display,
        message,
        code: outcome.code,
        report: null,
      });
    }
    if (outcome.error) {
      const message = `没能启动 npm：${outcome.error}`;
      this.logFixRaw(plan, null, outText, errText, 'npm 没能起来');
      this.hooks.log(`环境修复失败：${plan.display} → ${message}`);
      return this.publish({
        phase: 'error',
        action,
        command: plan.display,
        message,
        code: null,
        report: null,
      });
    }
    if (outcome.code !== 0) {
      // 认得出就归纳成人话，认不出就只报退出码（原文留在输出区与日志，不编原因）
      const message =
        summarizeEnvFixFailure(tail) ??
        `退出码 ${outcome.code ?? '未知'}，认不出具体原因，下面是 npm 的原文`;
      this.logFixRaw(plan, outcome.code, outText, errText, '安装没有成功');
      this.hooks.log(`环境修复失败：${plan.display} → ${message}`);
      return this.publish({
        phase: 'error',
        action,
        command: plan.display,
        message,
        code: outcome.code,
        report: null,
      });
    }

    // 第一步：**先刷新查找路径**（重读注册表 PATH + 重扫已知 bin 目录 + 这次装到哪儿了），再复检。
    // 不刷新的话，刚装好的东西在这一轮里根本看不见 —— 用户只能重开应用（VM-07 那一屏）。
    const added = refreshLookupPath(this.lookupDirs(plan));
    if (added.length > 0) {
      this.hooks.log(`环境修复：刷新查找路径，新注入 ${added.length} 个目录：${added.join('；')}`);
    }
    // 第二步：复检 + **功能实测**（`<pnpm> -v` 真的打出东西才算成功，只看"文件在"不算 —— VM-06）
    const report = await this.doctor.recheck();
    const probe = await probeFixTarget(action, this.doctor.platform);
    const statusOf = (id: EnvCheckId): EnvCheckStatus =>
      report.checks.find((item) => item.id === id)?.status ?? 'missing';
    // dsh 的"能用"要两步都过：定位得到（dsh）**且**实测跑得动（dsh-run）—— 与门禁那条判据同一份口径
    const ok =
      action === 'install-pnpm'
        ? statusOf('pnpm') === 'ok' && probe.version !== null
        : statusOf('dsh') === 'ok' && statusOf('dsh-run') === 'ok';
    const found = action === 'install-pnpm' ? probe.file !== null : statusOf('dsh') === 'ok';
    const label = action === 'install-pnpm' ? 'pnpm' : 'dsh';
    // 「找到了但跑不起来」先认原因（VM-09：原生 exe 缺 VC++ 运行库 / 静默失败），
    // 认得出就把人话结论与两条出路放进界面文案，认不出就不硬编原因
    const verdict =
      !ok && found && probe.file
        ? describePnpmRunFailure({
            file: probe.file,
            exitCode: probe.exitCode,
            stdout: probe.version ?? '',
            stderr: probe.stderr ?? '',
            vcRuntime: probe.vcRuntime,
          })
        : null;
    const message = fixDoneMessage({
      label,
      ok,
      found,
      blocked: probe.blocked,
      refreshed: added.length,
      logFile: this.hooks.logFile?.() ?? null,
      verdict,
    });
    // 没通过（或 npm 自己在说安装脚本没被允许）→ 把**实际执行的命令 / 退出码 / stdout / stderr**
    // 全落进日志：下一轮真机一次就能看清原因，而不是靠猜（VM-06 的教训）。
    if (!ok) {
      if (verdict) {
        this.hooks.log(
          `环境修复：认出来了 —— ${verdict.message}；出路：${verdict.hints.join('；')}`,
        );
      }
      this.logFixRaw(plan, outcome.code, outText, errText, '这一轮没有装出可用的结果');
      this.logProbeRaw(action, probe);
    } else if (INSTALL_SCRIPTS_WARNING.test(tail)) {
      this.logFixRaw(plan, outcome.code, outText, errText, 'npm 提示安装脚本没有被允许');
    }
    this.hooks.log(`环境修复完成：${plan.display} → 退出码 0，${message}`);
    return this.publish({
      phase: 'done',
      action,
      command: plan.display,
      message,
      code: outcome.code,
      report,
    });
  }

  /** 这一次装到哪儿了：npm 的全局 prefix 就是全局 bin 目录（POSIX 上再补一个 bin） */
  private lookupDirs(plan: EnvFixPlan): string[] {
    const target = plan.target;
    if (!target) return [];
    return this.doctor.platform === 'win32' ? [target] : [target, path.join(target, 'bin')];
  }

  /**
   * 把**那一次实际执行**的原文落进日志：命令 + 退出码 + stdout + stderr（两路分开写）。
   *
   * 细节留日志、结论给人话（t23 那条口径）：界面只说"装出来是坏的 / 没能装成"，
   * 而"到底哪一路说了什么"是排查用的，落在 `<userData>/logs/console.log` 里。
   * 空的那一路也照写 `（空）` —— VM 那一屏的症状正是"stdout 空、stderr 空"，写出来才看得见。
   */
  private logFixRaw(
    plan: EnvFixPlan,
    code: number | null,
    stdout: string,
    stderr: string,
    why: string,
  ): void {
    const part = (text: string): string =>
      text.trim() ? `\n${text.trim().slice(-RAW_LOG_CHARS)}` : '（空）';
    this.hooks.log(
      `环境修复：${why}（下面是那一次的原文）\n命令：${plan.display}\n退出码：${
        code === null ? '未知（没能起来 / 被中断）' : code
      }\nstdout：${part(stdout)}\nstderr：${part(stderr)}`,
    );
  }

  /** 功能实测没通过时，把**实测那一条命令**的原文也落进日志（`<pnpm> -v` 的退出码 / 两路输出） */
  private logProbeRaw(action: EnvFixAction, probe: FixProbe): void {
    if (action !== 'install-pnpm' || !probe.file) return;
    this.hooks.log(
      `环境修复：功能实测没通过（下面是那一次的原文）\n命令：${probe.file} -v\n退出码：${
        probe.exitCode === null ? '未知' : probe.exitCode
      }\nstdout：${probe.version ?? '（空）'}\nstderr：${probe.stderr?.trim() ? `\n${probe.stderr.trim()}` : '（空）'}`,
    );
  }

  private publish(state: EnvFixDraft): EnvFixState {
    // 终态补上"跑完的时刻"（一轮只打一次，见 finishedAt 的说明）；`running` / `idle` 一律 null。
    // 入参**不含** `finishedAt`：它是这里派生的事实，不是调用方给的东西 —— 调用方各自 `Date.now()`
    // 迟早会不一致，而界面的判据全靠它准。
    const terminal = state.phase !== 'running' && state.phase !== 'idle';
    if (terminal && this.finishedAt === null) this.finishedAt = Date.now();
    if (!terminal) this.finishedAt = null;
    const next: EnvFixState = { ...state, finishedAt: terminal ? this.finishedAt : null };
    this.current = next;
    // 终态立刻腾出互斥位（只有 running 相位要保持它）
    if (state.phase !== 'running') this.running = false;
    this.hooks.state({ ...next });
    return next;
  }
}

export {
  FIX_TAIL_CHARS,
  FIX_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  STDERR_TAIL_CHARS,
} from './env-probe-types';
export {
  NODE_RANGE,
  NODE_RANGE_BUILD,
  compareNodeVersion,
  highestNodeRequirement,
  judgeNodeVersion,
  localNodeRange,
  minNodeOfRange,
  parseNodeVersion,
  requirementPhrase,
  satisfiesBuildRange,
  satisfiesNodeRange,
  satisfiesSimpleRange,
} from './env-node-range';
export {
  ALLOW_INSTALL_SCRIPTS_FLAG,
  INSTALL_SCRIPTS_WARNING,
  PNPM_LATEST_SPEC,
  PNPM_PURE_JS_SPEC,
  RAW_LOG_CHARS,
  describePnpmRunFailure,
  envFixPlan,
  expandEnvRefs,
  fixDoneMessage,
  fixTimeoutMessage,
  mergePathText,
  npmLaunchSpec,
  parseRegQueryVars,
  pnpmInstallSpec,
  probeFixTarget,
  refreshLookupPath,
  summarizeEnvFixFailure,
} from './env-fix-plan';
export { judgeEnvironment, looksVersionManagerNode, probeTroubleLines } from './env-judge';
export {
  collectEnvProbe,
  dshRootFromLauncher,
  findNodePath,
  findNodePathWindows,
  findNpm,
  findNpmWindows,
  findPnpmPath,
  readLocalDshRequirement,
  whichWindowsExeWith,
} from './env-probe';
export {
  WIZARD_STEP_CHECK_IDS,
  WIZARD_STEP_FIX_ACTION,
  WIZARD_STEP_IDS,
  WIZARD_STEP_JUDGE,
  WIZARD_STEP_LABEL,
  WIZARD_STEP_SKIPPABLE,
  collectBootProbe,
  judgeWizard,
} from './env-wizard';
export type {
  DshProbe,
  EnvProbeRaw,
  EnvRuntime,
  NodeVersion,
  ShellProbe,
  VersionProbe,
} from './env-probe-types';
export type {
  LocalDshRequirement,
  LocalNodeRange,
  NodeEngineDeclaration,
  NodeRequirement,
  NodeVersionVerdict,
} from './env-node-range';
export type { FixProbe, PnpmRunVerdict } from './env-fix-plan';
