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

import { collectEnvProbe, readNpmPrefix } from './env-probe';

import type {
  EnvCheckId,
  EnvCheckStatus,
  EnvDoctorReport,
  EnvFixAction,
  EnvFixPlan,
  EnvFixState,
} from '../shared/ipc';
import { pluginRegistryEnv } from './plugin-manager';
import { Settings } from './settings';
import {
  INSTALL_SCRIPTS_WARNING,
  RAW_LOG_CHARS,
  describePnpmRunFailure,
  envFixPlan,
  fixDoneMessage,
  fixTimeoutMessage,
  npmLaunchSpec,
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
import { envWithKnownBins, hasVcRuntime, homeDir } from './process-utils';

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
  /** `npm prefix -g` 的结果；undefined = 这一轮还没问过 */
  private prefix: string | null | undefined;

  constructor(
    private readonly settings: Settings,
    private readonly hooks: EnvDoctorHooks,
  ) {}

  get platform(): string {
    return this.hooks.runtime().platform;
  }

  invalidate(): void {
    this.cached = null;
    this.prefix = undefined;
  }

  async report(refresh = false): Promise<EnvDoctorReport> {
    if (!refresh && this.cached) return this.cached;
    this.prefix = undefined;
    const { report: judged, raw } = await this.judge();
    // 界面撤下去的那些原始错误在这里落日志（**只落日志**：界面文案仍是人话）。
    // 放在最前面：哪怕后面问 `npm prefix -g` 出了意外，这一轮的原文也已经记下来了。
    this.logTrouble(raw, judged);
    // plans 里的 target 要问一次 npm（判定是纯函数，不问）；
    // 没有可用的计划时连问都不问。
    const target = judged.plans.length > 0 ? await this.npmPrefix() : null;
    const report: EnvDoctorReport = {
      ...judged,
      plans: judged.plans.map((plan) => ({ ...plan, target })),
    };
    this.cached = report;
    this.hooks.onReport?.(report);
    return report;
  }

  /** 一键修复跑完后的复检（设计 3.3）：清缓存重跑一轮并把结果交给调用方 */
  async recheck(): Promise<EnvDoctorReport> {
    return await this.report(true);
  }

  /** 现场重算一个动作的计划 —— `envFix` 只递 action，命令这边现算（安全模型第 1 条） */
  async fixPlan(action: EnvFixAction): Promise<EnvFixPlan | null> {
    // VC++ 运行库这条事实**现场再认一次**（用户可能在两次点击之间装上了运行库）
    const plan = envFixPlan(action, findNpm(), hasVcRuntime());
    if (!plan) return null;
    return { ...plan, target: await this.npmPrefix() };
  }

  private async npmPrefix(): Promise<string | null> {
    if (this.prefix !== undefined) return this.prefix;
    const npmPath = findNpm();
    this.prefix = npmPath ? await readNpmPrefix(npmPath, this.platform) : null;
    return this.prefix;
  }

  private async judge(): Promise<{ report: EnvDoctorReport; raw: EnvProbeRaw }> {
    const runtime = this.hooks.runtime();
    try {
      const raw = await collectEnvProbe(this.settings.all(), runtime);
      return { report: judgeEnvironment(raw), raw };
    } catch (error) {
      // 采集炸了也要给出一份能显示的报告：八行照常显示，error 非空由界面顶部说明
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
 *   - PATH 用 `envWithKnownBins` 补齐（Windows 上保留系统原有的 `Path` 键名），
 *     安装源用 `pluginRegistryEnv` 注入（只影响这一次子进程）；
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
  private current: EnvFixState = {
    phase: 'idle',
    action: null,
    command: null,
    message: null,
    code: null,
    report: null,
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

  async run(action: EnvFixAction): Promise<EnvFixState> {
    if (this.busy) {
      return { ...this.current, message: '已经有一个修复在进行中' };
    }
    // 同步占位，且必须在第一个 `await` 之前（见 running 的说明）。
    // 写在 `try` 外面是有意的：`try` 里第一句就是 `await`，这样后来往里加代码也不会把它挤到 await 后面。
    this.running = true;
    try {
      // 真正的流程在 execute 里（中间那一串 await 都不碰互斥位）
      return await this.execute(action);
    } finally {
      // 兜住所有路径（包括抛异常）：互斥位绝不能留着自己不放
      this.running = false;
    }
  }

  private async execute(action: EnvFixAction): Promise<EnvFixState> {
    const plan = await this.doctor.fixPlan(action);
    if (!plan) {
      return this.publish({
        phase: 'error',
        action,
        command: null,
        message:
          '没找到可用的 npm —— 装 pnpm / dsh 都要靠它。可以先重装官方 Node，或用 `corepack enable pnpm`。',
        code: null,
        report: null,
      });
    }

    // Windows 上 npm.cmd 不能直接 spawn、也不能让 Node 自己加引号：包装器统一处理
    const spec = npmLaunchSpec(plan.file, plan.args, this.doctor.platform);
    const env: NodeJS.ProcessEnv = {
      ...envWithKnownBins(process.env),
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

  private publish(state: EnvFixState): EnvFixState {
    this.current = state;
    // 终态立刻腾出互斥位（只有 running 相位要保持它）
    if (state.phase !== 'running') this.running = false;
    this.hooks.state({ ...state });
    return state;
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
