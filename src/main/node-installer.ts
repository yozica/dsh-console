/**
 * 系统级安装与更新执行：把 Node 装对（官方 MSI / nvm-windows 两条路）、下载与校验、提权、复检。
 *
 * 这一层只负责"把系统改对"：**不 import `env-doctor` / `dsh-manager`** —— 复检与停 dsh 由编排
 * 通过 `NodeInstallHooks` 注入（AGENTS §2 的模块边界）。
 *
 * t52 起这个文件 = `NodeInstallHooks` + `NodeInstaller` + barrel：纯函数与 IO 底层按主题住在
 * `node-*.ts` 里（shared / release / owner / failure / flavor / nvm / plan / io）。**刻意不拆类** ——
 * `NodeInstaller` 的实例字段跨"计划 → 下载 → 安装 → 收尾"几个阶段；而且 `buildPlan` 与
 * `transferPhase` 必须留在同一个文件里（`scripts/env-wizard-cases.mjs` 按这对锚点切源码）。
 */
import path from 'node:path';

import { installerSilentArgs } from './node-flavor';

import fs from 'node:fs';

import { findNodeExe, isWindows, launchSpec, pathWithKnownBins, whichSync } from './process-utils';

import {
  detectNodeOwner,
  envValue,
  isElevatedProbeOutput,
  mergePathFromRegistry,
  normalizeNodeSource,
} from './node-owner';

import {
  deriveNvmModel,
  deriveNvmModelFromEnvironment,
  isInactiveNodeShimOutput,
  locateNvmExe,
  parseNvmEnvOutput,
  parseNvmInstallOutput,
  parseNvmListOutput,
  parseNvmUseOutput,
  readNvmRegistryPreferences,
} from './node-nvm';

import {
  contentLength,
  electronNet,
  findValue,
  hostOf,
  idleState,
  installTempDir,
  messageOf,
  parseGithubReleases,
  psQuote,
  readDeveloperMode,
  readInstallerFlavor,
  readNodeMsiInstallPath,
  readRegistryEnvironment,
  runProbe,
  runProbeAsync,
  sha256OfFile,
  spawnSpec,
  system32,
  visibleFailureText,
} from './node-io';

import {
  classifyElevationOutcome,
  decideNodePlan,
  elevationFailure,
  hasNodeVersionOutput,
  nodePlanFacts,
} from './node-plan';

import {
  assetSha256,
  compareNodeVersions,
  nodeInstallerFileName,
  nodeInstallerUrl,
  parseNodeReleaseIndex,
  parseReleaseSigning,
  parseShasums,
  pickNvmSetupAsset,
} from './node-release';

import { Settings } from './settings';

import type { NvmEnvReport, NvmListOutput, NvmModel } from './node-nvm';

import type { NodeReleaseEntry, ReleaseAsset } from './node-release';

import type { LaunchSpec } from './process-utils';

import type { InstallFailureReason } from './node-failure';

import type {
  EnvDoctorReport,
  EnvInstallState,
  EnvNodeMode,
  EnvNodeOwner,
  EnvNodePlan,
  EnvNodeRequest,
} from '../shared/ipc';

import type { ElevationOutcome, NodePlanDecision, NodePlanFacts } from './node-plan';

import {
  ELEVATION_TIMEOUT_MESSAGE,
  ELEVATION_WAITING_MESSAGE,
  FAILURE_HINTS,
  FAILURE_MESSAGES,
  classifyInstallFailure,
  unsignedFailure,
} from './node-failure';

import type {
  CloseOutcome,
  GithubRelease,
  NetRequest,
  NetResponse,
  PlanResult,
  SignatureInfo,
  TransferOutcome,
  TransferResult,
} from './node-io';

import type { ChildProcess } from 'node:child_process';

import {
  BUSY_MESSAGE,
  DETACHED_MESSAGE,
  ELEVATED_TIMEOUT_MS,
  INJECTED_ENV_NAMES,
  INSTALLER_TIMEOUT_MS,
  NODE_DIST_HOST,
  NODE_DOWNLOAD_PAGE,
  NODE_INDEX_PATH,
  NVM_INSTALL_TIMEOUT_MS,
  NVM_LIST_TIMEOUT_MS,
  NVM_RELEASES_API,
  NVM_RELEASES_PAGE,
  NVM_USE_TIMEOUT_MS,
  OUTPUT_TAIL_CHARS,
  PROBE_TIMEOUT_MS,
  STALE_TEMP_MS,
  STEP_EVIDENCE_CHARS,
  TRANSFER_TIMEOUT_MS,
} from './node-shared';

export interface NodeInstallHooks {
  /** 安装过程的原始输出（推给渲染层） */
  output: (chunk: string) => void;
  /** 状态变化（推给渲染层） */
  state: (state: EnvInstallState) => void;
  /** 事件日志 */
  log: (text: string) => void;
  /** 复检：由编排注入（引擎不 import env-doctor） */
  recheck: () => Promise<EnvDoctorReport>;
  /** 更新前先停掉本应用启动的 dsh：由编排注入（引擎不 import dsh-manager） */
  stopDsh: () => Promise<void>;
  /** 下载器：默认走 Electron 的网络栈（遵循系统代理）；测试可注入 */
  download?: (url: string) => Promise<{ file: string; bytes: number; total: number | null }>;
  /**
   * 提权执行器（F-02 第 3 条要的**可注入边界**）：默认走异步 PowerShell
   * （`Start-Process -Verb RunAs -Wait -PassThru`）。测试可以注入它，把
   * 「成功 / 用户拒绝 / 等太久 / 没跑通」四种结果真跑出来（不必真的有 UAC）。
   */
  elevate?: (request: { file: string; args: string[] }) => Promise<ElevationOutcome>;
  /**
   * **计划阶段的文本取回**（官方版本清单 `index.json` / 校验清单 `SHASUMS256.txt` / 版本管理器的
   * 发布信息）：默认走 Electron 的网络栈（遵循系统代理、跟随 301、有超时）。
   *
   * 为什么它也要能注入（t29）：VM-14 / VM-15 的核心判据是"**这一次计划**里方法是哪条、目标档位是哪个"，
   * 而 `plan()` 默认要经 Electron 的网络栈 —— 在没有 Electron 的进程里它连版本清单都拿不到，
   * 于是"归属 → 方法"这件事就只剩"读代码下结论"。注入它之后，独立反例可以喂一份真的清单
   * （客机那种 nvm 形状 + 系统直装形状 + 未知形状）**真调一次 `plan()`**，断言它没有规划出
   * 官方 MSI 到 `C:\Program Files\nodejs`。与 `download` / `elevate` 同一条纪律：只影响这一次实例。
   */
  fetchText?: (url: string) => Promise<string | null>;
}

/**
 * Node 的安装 / 更新执行者（一个实例，住在主进程）。
 *
 * 相位（契约 `EnvInstallPhase`）与「停止」的两种语义（冻结文档 §3.2 的 `cancellable`）：
 * `preparing` / `downloading` / `verifying` 停下 = **真取消**（断掉下载、删临时文件、系统零改动）；
 * `installing` / `waiting` 停下 = **只停止等待**（`detached: true`，安装器继续跑，互斥位继续持有）。
 *
 * 互斥位（`busy()`）在三种情况之一发生时释放（冻结文档 R-06）：复检事实显示这一步已经不再缺 /
 * 用户再点一次「我确认安装已经结束」 / 应用重启（互斥位只在内存里）。
 */
export class NodeInstaller {
  private child: ChildProcess | null = null;
  /**
   * 同步的互斥位（**不要**用 `child` 代替：`child` 要到 spawn 之后才为真，而 `run()` 从入口到
   * spawn 之间隔着好几次网络 IO，两次连点会都通过）。必须在第一个 `await` 之前同步置上。
   */
  private running = false;
  /** 已经「不再等待」但安装可能还在后台跑：互斥位**继续持有**（R-06） */
  private holding = false;
  private cancelled = false;
  private detachedFlag = false;
  private current: EnvInstallState = idleState();
  /** 断掉这一次下载（Electron 请求的 abort；注入的下载器没有可断的东西） */
  private downloadAbort: (() => void) | null = null;
  /** 让「取消下载」立刻从等待里放手（不等对方真的停：临时文件随后删） */
  private releaseTransfer: (() => void) | null = null;
  /** 让「不再等待」立刻从安装器等待里放手（不杀安装器） */
  private releaseWait: (() => void) | null = null;
  /** 提权探测只做一次（一次只读子进程） */
  private elevated: boolean | null = null;
  /** 已经「不再等待」，但安装器还在后台跑：它一退出就用复检事实收尾（R-06 第 ① 条） */
  private detachedWatch = false;
  /** 收尾只跑一次（`finishDetached` 与「我确认安装已经结束」可能撞在一起） */
  private detachedSettling = false;
  /**
   * 刚才「不再等待」的那一次是**版本管理器的安装程序**：它终于退出之后，我们还要把
   * `nvm install` / `nvm use` 补完（VM 实测那台机器上，用户晚点才点完向导，
   * 我们早就停止等待了 —— 不补的话就会停在"版本管理器装好但没有 active Node"）。
   */
  private detachedNvmResume = false;
  /** 这一次跑的计划（`finishDetached` 补做 nvm 两步时要用它） */
  private activePlan: EnvNodePlan | null = null;
  /** 本次下载 / 校验落过盘的东西（取消 / 失败 / 退出时按这个清单删） */
  private readonly tempFiles = new Set<string>();
  /** 上次推给界面的下载百分比：一样就不重复推（每 64KB 一个事件会把 IPC 刷满） */
  private lastPercent: number | null = null;
  /** 最近一次子进程退出码：复检与结果态都要带着它（界面能显示"退出码几"） */
  private lastCode: number | null = null;

  constructor(
    private readonly settings: Settings,
    private readonly hooks: NodeInstallHooks,
  ) {}

  /**
   * 计划（确认区用）。拿不到计划（版本清单取不到 / 解析失败 / 平台不支持）→ `null`，不抛。
   *
   * **请求形状是 t29 的那个**（冻结 §3.2.1）：`{ mode, method?, channel? }` ——
   * `method` 省略 = **跟随归属**（§7.8），`channel` 省略 = **跟随档位**（`install` → 最新稳定版、
   * `update` → 当前档位，§8.5）。只有显式给值才是"用户点名的那条路 / 那次换档"。
   */
  async plan(request: EnvNodeRequest): Promise<EnvNodePlan | null> {
    try {
      const built = await this.buildPlan(request);
      return built.ok ? built.plan : null;
    } catch (error) {
      this.hooks.log(`安装计划没能算出来：${messageOf(error)}`);
      return null;
    }
  }

  /** 跑一次安装 / 更新。业务失败**不抛**：终态是 `phase: 'error'` + 一句人话 */
  async run(request: EnvNodeRequest): Promise<EnvInstallState> {
    if (this.busy()) return { ...this.current, message: BUSY_MESSAGE };
    // 同步占位，且必须在第一个 `await` 之前（见 running 的说明）
    this.running = true;
    try {
      return await this.execute(request);
    } catch (error) {
      // 认得出就归纳，认不出就给一句带原文的兜底：绝不让界面拿到一个空结论
      const reason = classifyInstallFailure(messageOf(error), null);
      this.hooks.log(`环境安装异常：${messageOf(error)}`);
      return this.publish('error', { message: visibleFailureText(reason), report: null });
    } finally {
      this.running = false;
    }
  }

  /**
   * 停止。同步、不抛。
   *
   * - 下载 / 校验 / 准备：真取消（断网请求 + 删临时文件），终态由 `run()` 里的收尾写；
   * - 安装 / 等待：只置 `detached`（不杀安装器），`run()` 的 Promise 就地解析；
   * - **已经 `detached` 再点一次** = 界面上那句「我确认安装已经结束」：释放互斥位，
   *   并且仍然让复检事实给结论。
   */
  stop(): EnvInstallState {
    const phase = this.current.phase;
    if (phase === 'preparing' || phase === 'downloading' || phase === 'verifying') {
      this.cancelled = true;
      this.downloadAbort?.();
      this.releaseTransfer?.();
      return this.state();
    }
    if (phase === 'installing' || phase === 'waiting') {
      if (this.current.detached) {
        // 「我确认安装已经结束」：锁解除，但结论仍然由复检给（不许无复检断言）
        this.holding = false;
        this.confirmDetached().catch((error: unknown) => {
          this.hooks.log(`解除等待之后的复检没能跑完：${messageOf(error)}`);
        });
        return this.state();
      }
      this.releaseWait?.();
      this.releaseWait = null;
      return this.state();
    }
    return this.state();
  }

  /** 当前状态（IPC 初值 / 复检后的广播） */
  state(): EnvInstallState {
    const bytes = this.current.bytes;
    return { ...this.current, bytes: bytes ? { ...bytes } : null };
  }

  /** 自己有没有在跑（编排用它合成全局忙位）；`detached` 期间仍然算忙 */
  busy(): boolean {
    return this.running || this.child !== null || this.holding;
  }

  /**
   * 当前 Node 是哪条路管的（界面决定「更新」走哪条；也是「换一个 Node」的判据）。
   *
   * **判据只有一份**：`detectNodeOwner`（需求 §7.7 第 1 条），这里只把入参凑齐。
   * 同步、不起子进程（`nvm env` 不是判据的一部分），所以调用方不必等一轮探测。
   */
  currentNodeOwner(): EnvNodeOwner {
    return this.ownership(null).owner;
  }

  /** 归属事实 + 模型（入参凑齐之后交给唯一的判据 `detectNodeOwner`） */
  private ownership(msiInstallPath: string | null): {
    owner: EnvNodeOwner;
    evidence: string[];
    model: NvmModel | null;
  } {
    const model = deriveNvmModelFromEnvironment(process.env);
    const ownership = detectNodeOwner({
      nodePath: this.probeNodePath(),
      env: process.env,
      model,
      msiInstallPath,
    });
    return { ...ownership, model };
  }

  /**
   * 应用退出时调用：下载 / 校验 → 取消 + 删临时文件；安装 / 等待 → 放弃引用、
   * **不杀、不等**（安装器是独立进程，父进程退出后继续跑完；它在用的那个安装包也不能删）。
   */
  detachOnQuit(): void {
    const phase = this.current.phase;
    if (phase === 'preparing' || phase === 'downloading' || phase === 'verifying') {
      this.cancelled = true;
      this.abortTransfer();
      this.discardTempDir();
    }
    this.child = null;
    this.holding = false;
  }

  // -------------------------------------------------------------- run 的三个阶段

  private async execute(request: EnvNodeRequest): Promise<EnvInstallState> {
    const mode: EnvNodeMode = request.mode === 'update' ? 'update' : 'install';
    this.cancelled = false;
    this.detachedFlag = false;
    this.holding = false;
    this.lastCode = null;

    // `method` 这时候还不知道（省略 = 跟随归属，要等计划算出来）——契约里它本来就是 `| null`
    this.publish('preparing', {
      method: request.method ?? null,
      mode,
      plan: null,
      observedVersion: null,
      message: '正在准备安装…',
    });
    if (this.cancelled) return this.settleCancelledDownload();
    if (!isWindows) {
      return await this.settleFailure(
        {
          kind: 'unsupported',
          message: '自动安装只在 Windows 上提供。可以自己到官方下载页装。',
          hint: FAILURE_HINTS.unsupported,
        },
        false,
      );
    }

    const built = await this.buildPlan(request);
    if (this.cancelled) return this.settleCancelledDownload();
    if (!built.ok) return await this.settleFailure(built.reason, false);
    const installed = built.plan;
    if (!installed.usable) {
      // 「不能走」也有类别：网络取不到清单 / 架构没有安装包 / 提权态不许装版本管理器 /
      // 归属未知要用户显式选（`needChoice`）
      const reason = built.unusableReason ?? {
        kind: 'unsupported' as const,
        message: installed.refuseReason ?? FAILURE_MESSAGES.unsupported,
        hint: FAILURE_HINTS.unsupported,
      };
      return await this.settleFailure(reason, false);
    }
    // 存下来：`finishDetached` 在"不再等待"之后补做 nvm 两步时要重新算同一份计划的事实
    this.activePlan = installed;
    const plan = installed;
    this.publish('preparing', {
      method: plan.method,
      mode: plan.mode,
      plan,
      message: '正在准备安装…',
    });

    // 「更新会先停掉正在运行的 dsh」是确认区上写着的承诺（`docs/env-wizard.md` §8.3 / 交互 §10.5 第 7 条）：
    // **只要这一次是更新就先停一次，而且只在这一处停**（`installPhase()` 里那次已经移走）——
    // 不管走哪条路、要不要下载。原先它住在 `installPhase()` 里，而"机器上已经有版本管理器"
    // （`installsManager === false`）那条路**整个跳过**安装阶段，于是那句承诺会 quietly 落空
    // （用户点的是"更新 Node"，界面说会先停 dsh，实际没停）。
    // 钩子只停**本应用启动的**那个 dsh（外部实例不属于我们，需求 §14）。
    if (plan.mode === 'update') await this.stopDshForUpdate();

    // 1~3. 下载 → 校验 → 安装**要下载的东西**。
    // 机器上已经有可辨认的版本管理器时（`installsManager === false`）这一步**整个跳过**：
    // 用户点的是"更新 Node"，不是"重装版本管理器"（冻结 §3.2.1 的 `installsManager`）。
    if (!plan.installsManager) {
      this.hooks.log('这台电脑上已经有可辨认的版本管理器：这次不下载、不校验，直接用它装 Node');
      this.publish('installing', {
        message: `正在用这台电脑上已经装好的版本管理器装 Node.js ${plan.version}`,
      });
    } else {
      const transferred = await this.transferPhase(plan);
      if (transferred.kind === 'cancelled') return this.settleCancelledDownload();
      if (transferred.kind === 'failed') return await this.settleFailure(transferred.reason, false);

      // 校验（通不过就不安装）
      const verified = await this.verifyPhase(plan, transferred.file);
      if (verified.kind === 'cancelled') return this.settleCancelledDownload();
      if (verified.kind === 'failed') return await this.settleFailure(verified.reason, false);

      // 安装（这一步起，停止的语义只剩"不再等待"）
      const installer = await this.installPhase(plan, transferred.file);
      if (installer.kind === 'detached') return this.state();
      if (installer.kind === 'failed') return await this.settleFailure(installer.reason, true);
    }

    // 3b. 版本管理器那条路：用它把 Node 装上、切过去（`nvm install` → `nvm list` 核对 → `nvm use`）
    if (plan.method === 'nvm') {
      const nodeStep = await this.installNodeWithNvm(plan);
      if (nodeStep.kind === 'detached') return this.state();
      if (nodeStep.kind === 'failed') return await this.settleFailure(nodeStep.reason, true);
    }

    // 4. 复检（重读系统里的环境之后）
    return await this.settleSuccess(plan);
  }

  // -------------------------------------------------------------- 计划

  /**
   * 把网络与磁盘上的事实凑齐，然后交给**唯一的纯判定** `decideNodePlan()`（需求 §7.7 / §7.8 / §8.5）。
   *
   * 这里只做三件事：读归属事实（`detectNodeOwner`）、取官方版本清单、按判定结果装出计划
   * （能用 / 不能用 / 要用户显式选）。**没有一处"默认直装"的兜底** —— VM-14 就死在那条兜底上。
   */
  private async buildPlan(request: EnvNodeRequest): Promise<PlanResult> {
    const mode: EnvNodeMode = request.mode === 'update' ? 'update' : 'install';
    if (!isWindows) {
      // 非 Windows 上一律不给计划（冻结文档 R-20）：界面据此连「开始」都不给
      return {
        ok: false,
        reason: {
          kind: 'unsupported',
          message: '自动安装只在 Windows 上提供。可以自己到官方下载页装。',
          hint: FAILURE_HINTS.unsupported,
        },
      };
    }
    const arch = process.arch;
    // 下载源（留空 = 官方直连）只改**我们发起的下载**：版本清单与 Node 的安装包都按同一个
    // 相对路径拼（`v<版本>/<文件名>`）；版本管理器自己的安装包不套用它（GitHub 资产没有镜像语义）
    const source = normalizeNodeSource(this.settings.get('envNodeSource'));
    const indexBase = source ?? NODE_DIST_HOST;

    // —— t29 的事实：这份 Node 是谁管的（判据只有一份：`detectNodeOwner`）——
    // 安装计划这一侧读得到注册表，所以把 `InstallPath` 这条正面证据也带上（读不到不影响结论）。
    const ownership = this.ownership(readNodeMsiInstallPath());
    const nodePath = this.probeNodePath();
    const currentVersion = nodePath ? await this.readNodeVersion(nodePath) : null;

    // 版本清单：两条路都要知道"装哪个 Node 版本"（直装是下载它，版本管理器是用 nvm 装它）
    const indexText = await this.fetchText(`${indexBase}/${NODE_INDEX_PATH}`);
    if (indexText === null) {
      return {
        ok: false,
        reason: {
          kind: 'network',
          message: FAILURE_MESSAGES.network,
          hint: FAILURE_HINTS.network,
        },
      };
    }
    const list = parseNodeReleaseIndex(indexText);
    const decision = decideNodePlan({
      mode,
      requestMethod: request.method,
      requestChannel: request.channel,
      owner: ownership.owner,
      nvmPresent: ownership.model !== null,
      nodeFound: nodePath !== null,
      currentVersion,
      releases: list,
      // 提权探测只在这一条分支上才有意义（R-23 的例外：归属 = nvm + 提权态才允许改走官方直装），
      // 别为了它给每一次"打开确认区"都塞一次 `whoami` 子进程。
      elevated:
        request.method === 'direct' && ownership.owner === 'nvm' ? await this.isElevated() : false,
    });
    const facts = nodePlanFacts(ownership.owner, ownership.model !== null, decision);
    this.hooks.log(
      `安装计划的事实：归属=${ownership.owner}（${ownership.evidence.join('；')}）；` +
        `版本管理器=${ownership.model ? ownership.model.root : '没有'}；当前版本=${currentVersion ?? '没测到'}；` +
        `当前档位=${decision.currentChannel ?? '判不出来'}；目标方法=${decision.method}；目标档位=${decision.channel}` +
        `${decision.switchesChannel ? '（换档）' : ''}${decision.needChoice ? `；要用户显式选：${decision.needChoice}` : ''}`,
    );

    // 「这次给不出开始」的两种：要用户显式选（`needChoice`）与归属已知时点了不该走的那条路。
    // 两者都**不是** `null`（界面照常显示版本与来源，只是不给「开始」）。
    if (decision.needChoice !== null || decision.refuse !== null) {
      return this.buildRefusalPlan(decision, facts, mode);
    }
    const release = decision.release;
    if (!release) {
      return {
        ok: false,
        reason: {
          kind: 'unsupported',
          message: '没能从官方版本清单里挑出可以装的版本（清单可能变了）。',
          hint: `${FAILURE_HINTS.unsupported} 下载页：${NODE_DOWNLOAD_PAGE}`,
        },
      };
    }

    if (decision.method === 'nvm') {
      return await this.buildNvmPlan(release, mode, decision, facts, arch, ownership.model);
    }
    return await this.buildDirectPlan(release, mode, decision, facts, arch, source);
  }

  /**
   * 「这次不能自动走」的计划（需求 §7.7 第 3 条 / §7.8 的三个例外）。
   *
   * 为什么给计划而不是 `null`：`null` 只留给"连版本清单都算不出来"那四类；
   * 这里版本清单是好的、结论也明确（要用户显式选哪一条 / 为什么不给走），界面要照实显示。
   * `url` 指向官方下载页 —— 那是用户真有得去的地方，**不是**我们会去下载的地址。
   */
  private buildRefusalPlan(
    decision: NodePlanDecision,
    facts: NodePlanFacts,
    mode: EnvNodeMode,
  ): PlanResult {
    const reason: InstallFailureReason = decision.refuse ?? {
      kind: 'unsupported',
      message: '这次没有可以自动走的路。',
      hint: FAILURE_HINTS.unsupported,
    };
    return {
      ok: true,
      plan: {
        method: decision.method,
        mode,
        channel: decision.channel,
        version: decision.release?.version ?? '',
        url: NODE_DOWNLOAD_PAGE,
        sourceHost: hostOf(NODE_DOWNLOAD_PAGE),
        sha256: null,
        evidence: decision.release ? '官方版本清单' : '还没有可用的目标档位',
        // 计划阶段恒为 unknown（官方直装那侧没有发布自述）；这里连下载都不会发生
        releaseSigning: 'unknown',
        signer: null,
        usable: false,
        refuseReason: reason.message,
        needsElevation: decision.method === 'direct',
        affectsRunningDsh: false,
        display: decision.release ? `Node.js ${decision.release.version}` : '',
        target: null,
        note: `${reason.message}${reason.hint ? ` ${reason.hint}` : ''}${
          decision.coexistWarning ? ` ${decision.coexistWarning}` : ''
        }`,
        ...facts,
      },
      unusableReason: reason,
    };
  }

  /**
   * 发布里挑安装包：**逐个发布往前找**（列表是新发布在前），跳过预发布与草稿 ——
   * 「默认只选不是预发布的稳定版」是硬要求（需求 §7.3）。挑不到返回 null，不换源、不重试。
   *
   * 挑中的那个发布要一起带回去：它的说明正文里有"这一次签没签名"的自述，
   * 而确认区那句额外确认依赖它（`EnvNodePlan.releaseSigning`）。
   */
  private pickReleaseAsset(
    releases: GithubRelease[],
    arch: string,
  ): { asset: ReleaseAsset; release: GithubRelease } | null {
    for (const release of releases) {
      if (release.prerelease || release.draft) continue;
      const asset = pickNvmSetupAsset(release.assets, arch);
      if (asset) return { asset, release };
    }
    return null;
  }

  private async buildDirectPlan(
    release: NodeReleaseEntry,
    mode: EnvNodeMode,
    decision: NodePlanDecision,
    facts: NodePlanFacts,
    arch: string,
    source: string | null,
  ): Promise<PlanResult> {
    const channel = decision.channel;
    const base = source ?? NODE_DIST_HOST;
    const fileName = nodeInstallerFileName(release.version, arch);
    const canonical = nodeInstallerUrl(release, arch);
    const url = source ? `${base}/${release.version}/${fileName}` : canonical;
    const installPath = process.env.ProgramFiles
      ? path.win32.join(process.env.ProgramFiles, 'nodejs')
      : 'C:\\Program Files\\nodejs';
    /** 显式点名了与归属不同的那条路（§7.8 的例外）时，确认区必须带上那句并存风险 */
    const coexist = decision.coexistWarning ? ` ${decision.coexistWarning}` : '';
    const refuse = (reason: InstallFailureReason, evidence: string): PlanResult => ({
      ok: true,
      plan: {
        method: 'direct',
        mode,
        channel,
        version: release.version,
        url: `${base}/${release.version}/${fileName}`,
        sourceHost: hostOf(base),
        sha256: null,
        evidence,
        signer: null,
        // 官方直装：nodejs.org 那侧没有"签没签名"的发布自述，恒为 unknown
        releaseSigning: 'unknown',
        usable: false,
        refuseReason: reason.message,
        needsElevation: true,
        affectsRunningDsh: mode === 'update',
        display: fileName,
        target: installPath,
        note: `${reason.message}${reason.hint ? ` ${reason.hint}` : ''}${coexist}`,
        ...facts,
      },
      unusableReason: reason,
    });

    // 认不出的架构 / 版本号：连地址都拼不出来（这也不是"架构不支持"，是我们不认识这个输入）
    if (!canonical || !url) {
      return refuse(
        {
          kind: 'unsupported',
          message: '这个版本没有适合这台电脑的安装包。',
          hint: `${FAILURE_HINTS.unsupported} 下载页：${NODE_DOWNLOAD_PAGE}`,
        },
        '这一档没有这台电脑架构的官方安装包',
      );
    }

    // **权威证据是同一版本目录下的官方校验清单**（船长裁定：不再读 index.json 的 files 数组）：
    // 它里面有没有 `node-v<版本>-<arch>.msi` 这一行，就是"这个安装包存在不存在"。
    // 取不到清单 = 网络失败，**不许**降级成"这台电脑不支持"。
    const shasums = await this.fetchText(`${base}/${release.version}/SHASUMS256.txt`);
    if (shasums === null) {
      return refuse(
        {
          kind: 'network',
          message: '没能取到官方的校验清单（连不上或超时），所以这一次没法确认安装包是哪一个。',
          hint: FAILURE_HINTS.network,
        },
        '这一轮没取到官方校验清单 —— 连不上或超时',
      );
    }
    const sha256 = parseShasums(shasums, fileName);
    if (sha256 === null) {
      return refuse(
        {
          kind: 'unsupported',
          message: '这个版本没有适合这台电脑的安装包。',
          hint: `${FAILURE_HINTS.unsupported} 下载页：${NODE_DOWNLOAD_PAGE}`,
        },
        '官方校验清单里没有这台电脑架构的安装包',
      );
    }

    return {
      ok: true,
      plan: {
        method: 'direct',
        mode,
        channel,
        version: release.version,
        url,
        sourceHost: hostOf(url),
        sha256,
        evidence: '与安装包同一个目录下的官方校验清单',
        // Authenticode 只能读文件才有：计划阶段 `null` 只表示"还没读"，
        // **不是**"未签名"（界面因此不得加一次确认，见 docs 的裁定）。
        signer: null,
        // 官方直装：nodejs.org 那侧没有"签没签名"的发布自述
        releaseSigning: 'unknown',
        usable: true,
        refuseReason: null,
        needsElevation: true,
        affectsRunningDsh: mode === 'update',
        display: `msiexec /i ${fileName} /qb /norestart`,
        target: `${installPath}（官方安装包的默认位置）`,
        note: `${[
          `会用系统自带的安装程序装到 ${installPath}，需要一次管理员权限询问。`,
          '这台电脑上原来的 Node 会被换成这个版本。',
          '下载完成后会先核对完整性，再读一次安装包的数字签名；签名与内容对不上、或读到它确实没有签名，都不会安装。',
        ].join(' ')}${coexist}`,
        ...facts,
      },
    };
  }

  private async buildNvmPlan(
    release: NodeReleaseEntry,
    mode: EnvNodeMode,
    decision: NodePlanDecision,
    facts: NodePlanFacts,
    arch: string,
    model: NvmModel | null,
  ): Promise<PlanResult> {
    const channel = decision.channel;
    /** 显式点名了与归属不同的那条路（§7.8 的例外）时，确认区必须带上那句并存风险 */
    const coexist = decision.coexistWarning ? ` ${decision.coexistWarning}` : '';
    /**
     * 这条路不能走时的计划：**仍然给一份计划**（`usable: false`）而不是 `null` ——
     * 确认区要显示"版本是哪个、卡在哪、还有哪条出路"；`plan() === null` 只留给
     * "连版本清单都算不出来"（平台不对 / index 取不到 / 解析不出来）。
     * 不能走的时候 `url` 指向**发布页**（那才是用户真有得去的地方），不是我们会去下载的地址。
     */
    const refuse = (reason: InstallFailureReason, evidence: string): PlanResult => ({
      ok: true,
      plan: {
        method: 'nvm',
        mode,
        channel,
        version: release.version,
        url: NVM_RELEASES_PAGE,
        sourceHost: hostOf(NVM_RELEASES_PAGE),
        sha256: null,
        evidence,
        signer: null,
        releaseSigning: 'unknown',
        usable: false,
        refuseReason: reason.message,
        needsElevation: false,
        affectsRunningDsh: mode === 'update',
        display: '版本管理器的安装包',
        target: null,
        note: `${reason.message}${reason.hint ? ` ${reason.hint}` : ''}${coexist}`,
        ...facts,
      },
      unusableReason: reason,
    });

    if (await this.isElevated()) {
      return refuse(
        {
          kind: 'unsupported',
          message:
            '请不要用管理员身份运行 DSH Console 来安装版本管理器，否则它会被配置给管理员账户；可以用「直接安装官方版本」，或换一个普通权限的账户。',
          hint: '改用「直接安装官方版本」。',
        },
        '管理员身份下这条路不提供',
      );
    }

    const versionArg = release.version.replace(/^v/, '');
    // **机器上已经有一个可辨认的版本管理器时，不许再装它一遍**（冻结 §3.2.1 的 `installsManager`）：
    // 这次**没有任何东西要下载**，所以下载与校验两段整个跳过 —— 用户点的是"更新 Node"，
    // 不是"重装版本管理器"（那会多几十 MB 下载、重写它自己的偏好与 PATH 条目）。
    if (!decision.installsManager) {
      const root = model?.root ?? null;
      return {
        ok: true,
        plan: {
          method: 'nvm',
          mode,
          channel,
          version: release.version,
          // 我们**不会**去下载这个地址：它只是"这次没有任何东西要下载"时，用户真有得去的地方（发布页）
          url: NVM_RELEASES_PAGE,
          sourceHost: hostOf(NVM_RELEASES_PAGE),
          sha256: null,
          evidence: '用这台电脑上已经装好的版本管理器装 Node：不下载、不校验',
          signer: null,
          releaseSigning: 'unknown',
          usable: true,
          refuseReason: null,
          needsElevation: false,
          affectsRunningDsh: mode === 'update',
          display: `nvm install ${versionArg}`,
          target: root ? `${root}（这台电脑上已经装好的版本管理器）` : null,
          note: `${[
            `这台电脑上已经有版本管理器了，所以这次不再装它一遍、也没有任何东西要下载：直接让它装 Node.js ${release.version} 并切过去。`,
            '原来的那份 Node 不会被删掉，也不会往官方安装包的位置再放一份。',
            '装完会实测 `node --version` 与 `npm --version` 都有输出才算完成。',
          ].join(' ')}${coexist}`,
          ...facts,
        },
      };
    }

    const text = await this.fetchText(NVM_RELEASES_API);
    if (text === null) {
      return refuse(
        {
          kind: 'network',
          message: '没能取到版本管理器的发布信息（可能连不上，也可能这一会儿访问太频繁）。',
          hint: `可以稍后再试，或者用浏览器打开官方发布页自己装：${NVM_RELEASES_PAGE}`,
        },
        '这一轮没取到版本管理器的发布信息 —— 连不上或超时',
      );
    }
    const release0 = parseGithubReleases(text);
    const picked = this.pickReleaseAsset(release0, arch);
    if (!picked) {
      return refuse(
        {
          kind: 'unsupported',
          message: '版本管理器的发布里没有适合这台电脑的安装包。',
          hint: `可以用「直接安装官方版本」，或者自己到发布页装：${NVM_RELEASES_PAGE}`,
        },
        '发布里没有这台电脑架构的安装包',
      );
    }
    const { asset, release: chosen } = picked;
    const releaseSigning = parseReleaseSigning(chosen.body);

    const sha256 = assetSha256(asset);
    const nvmHome = envValue(process.env, 'NVM_HOME');
    // 界面上报的路径必须是**探测到的真路径**（VM-12 的教训：推测出来的路径会显示一条不存在的目录）：
    // 先看这台机器上真实存在的 `nvm.exe`（v2 装完 PATH 里就有它），再看 v1 的 `NVM_HOME`；
    // 都没有就**不报路径**，只说"安装程序会让你选目录"。
    const nvmExeNow = locateNvmExe({ env: process.env });
    const installTarget = nvmExeNow
      ? `${path.win32.dirname(nvmExeNow)}（这台电脑上已经装着的版本管理器目录）`
      : nvmHome
        ? `${nvmHome}（版本管理器自己的目录）`
        : '安装程序会让你选目录（默认在你的用户目录下）';

    return {
      ok: true,
      plan: {
        method: 'nvm',
        mode,
        channel,
        version: release.version,
        url: asset.browser_download_url,
        sourceHost: hostOf(asset.browser_download_url),
        sha256,
        evidence: sha256 ? '发布方在发布页给出的完整性摘要' : '这一轮没取到发布方给的完整性摘要',
        // 计划阶段的 `null` = "还没读"，不是"未签名"：界面不得据此加确认（船长裁定）
        signer: null,
        releaseSigning,
        usable: true,
        refuseReason: null,
        needsElevation: false,
        affectsRunningDsh: mode === 'update',
        display: asset.name,
        target: installTarget,
        note: `${[
          '先装一个版本管理器，再由它装 Node；不需要管理员权限。',
          '这台电脑上原来的 Node 不会被删掉，之后用哪个版本由版本管理器决定。',
          '版本管理器的安装包仍然从官方地址下载；会尽量用静默方式装到它的默认位置（不弹向导）；如果它仍然弹出了窗口，请在窗口里把向导点完，我们会等它。',
          '下载完成后会先核对完整性，再读一次安装包的数字签名；签名与内容对不上、或读到它确实没有签名，都不会安装。',
        ].join(' ')}${coexist}`,
        ...facts,
      },
    };
  }

  // -------------------------------------------------------------- 下载 / 校验

  private async transferPhase(
    plan: EnvNodePlan,
  ): Promise<
    | { kind: 'ok'; file: string }
    | { kind: 'cancelled' }
    | { kind: 'failed'; reason: InstallFailureReason }
  > {
    const dir = installTempDir();
    const fileName = this.fileNameOf(plan);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      return { kind: 'failed', reason: classifyInstallFailure(messageOf(error), null) };
    }
    this.cleanStaleTemp(dir);
    const dest = path.join(dir, fileName);
    this.tempFiles.add(dest);
    this.lastPercent = null;
    const label = plan.method === 'nvm' ? '版本管理器的安装包' : `Node.js ${plan.version}`;

    this.publish('downloading', {
      method: plan.method,
      mode: plan.mode,
      message: `正在下载 ${label}…`,
      percent: null,
      bytes: null,
      code: null,
      report: null,
    });
    this.hooks.log(
      `开始下载：${label}（来源 ${hostOf(plan.url)}${plan.sha256 ? '，有官方校验值' : '，这次没有校验值'}）`,
    );

    const outcome = await this.awaitTransfer(dest, () => this.download(plan.url, dest));
    if (outcome.kind === 'cancelled') return { kind: 'cancelled' };
    if (outcome.kind === 'failed') {
      this.removeQuietly(dest);
      return { kind: 'failed', reason: classifyInstallFailure(outcome.error, null) };
    }
    this.publish('downloading', {
      message: `正在下载 ${label}…100%`,
      percent: 100,
      bytes: { downloaded: outcome.bytes, total: outcome.total ?? outcome.bytes },
    });
    return { kind: 'ok', file: outcome.file };
  }

  private async verifyPhase(
    plan: EnvNodePlan,
    file: string,
  ): Promise<
    { kind: 'ok' } | { kind: 'cancelled' } | { kind: 'failed'; reason: InstallFailureReason }
  > {
    this.publish('verifying', {
      method: plan.method,
      mode: plan.mode,
      message: '正在校验安装包完整性',
      percent: null,
      bytes: null,
    });
    if (plan.sha256) {
      const actual = await sha256OfFile(file);
      if (actual === null) {
        this.hooks.log('校验：读不出安装包的校验值，跳过这一步（确认区里已经说明过）');
      } else if (actual.toLowerCase() !== plan.sha256.toLowerCase()) {
        this.removeQuietly(file);
        this.hooks.log('校验：与官方校验清单不一致，已删除，没有安装');
        return {
          kind: 'failed',
          reason: classifyInstallFailure('完整性校验没通过：校验值与官方清单不一致', null),
        };
      } else {
        this.hooks.log('校验：与官方校验清单一致');
        this.hooks.output(`校验通过：与官方校验清单一致\n`);
      }
    }
    if (this.cancelled) return { kind: 'cancelled' };

    // 数字签名（船长裁定：读到结果才说话，读不到 ≠ 未签名）
    //   Valid        → 记签名者，继续
    //   NotSigned    → **不安装**（读到它明确没有签名）
    //   NotTrusted   → **不安装**（签名链不被这台电脑信任 = 签名无效）
    //   HashMismatch → **不安装**（签名在，但与文件内容对不上 = 被改过）
    //   UnknownError / 其它 → 读取失败或结论不明确：继续装，但结果里如实写"这次没能读到签名"
    const signature = this.readSignature(file);
    const status = signature?.status ?? '';
    if (status === 'HashMismatch') {
      this.removeQuietly(file);
      this.hooks.log('校验：数字签名与安装包内容不一致，已删除，没有安装');
      return {
        kind: 'failed',
        reason: classifyInstallFailure('签名与安装包内容不一致，已删除', null),
      };
    }
    if (status === 'NotSigned' || status === 'NotTrusted') {
      // 发布元数据自己说是未签名构建 → 用户在确认区已经确认过这一次，可以继续
      if (plan.releaseSigning === 'unsigned') {
        this.hooks.log(
          `校验：安装包${status === 'NotSigned' ? '没有数字签名' : '的签名不被信任'}，但发布方的说明里已经声明是未签名构建（用户在确认区确认过），继续`,
        );
        this.hooks.output('安装包没有数字签名（发布方已经声明过这次是未签名构建）\n');
      } else {
        this.removeQuietly(file);
        this.hooks.log(
          `校验：安装包${status === 'NotSigned' ? '明确没有数字签名' : '的签名不被信任'}，计划里没有这一声明，已删除，没有安装`,
        );
        return {
          kind: 'failed',
          reason: unsignedFailure(
            status === 'NotSigned'
              ? '这个安装包没有数字签名，我们没有安装它。'
              : '这个安装包的签名没有被这台电脑信任，我们没有安装它。',
          ),
        };
      }
    }
    if (status === 'Valid') {
      this.hooks.log(`校验：安装包签名有效（${signature?.subject ?? '读不到签名者'}）`);
      this.hooks.output(`安装包签名：${signature?.subject ?? '有效'}\n`);
    } else {
      this.hooks.log(`校验：这次没能读到安装包的数字签名（${status || '读不到'}）`);
      this.hooks.output('这次没能读到安装包的数字签名\n');
    }
    if (this.cancelled) return { kind: 'cancelled' };
    return { kind: 'ok' };
  }

  // -------------------------------------------------------------- 安装

  private async installPhase(
    plan: EnvNodePlan,
    file: string,
  ): Promise<
    { kind: 'ok' } | { kind: 'detached' } | { kind: 'failed'; reason: InstallFailureReason }
  > {
    // 注意：「更新前先停 dsh」**不在这里**（它已经提到 `execute()` 里、任何系统改动之前，
    // 因为这条路在"管理器已经在机器上"时会被整个跳过）。搬回来就会变成停两次。
    this.publish('installing', {
      method: plan.method,
      mode: plan.mode,
      message: '正在等待安装程序',
      code: null,
      report: null,
    });
    this.hooks.log(`开始安装：${plan.display}`);

    const launched = this.launchInstaller(plan, file);
    if (!launched.ok) return { kind: 'failed', reason: launched.reason };
    // 版本管理器那条路：这次等的是它的安装程序，**如果不再等待，它退出之后还要补 nvm 两步**
    const nvmManager = plan.method === 'nvm';
    if (nvmManager) this.detachedNvmResume = true;
    const outcome = await this.waitForClose(launched.child, INSTALLER_TIMEOUT_MS);
    if (nvmManager && outcome.kind !== 'detached') this.detachedNvmResume = false;
    if (outcome.kind === 'detached') {
      this.hooks.log('安装：我们不再等待（安装器继续跑，不做结论）');
      return { kind: 'detached' };
    }
    if (outcome.kind === 'error') {
      return {
        kind: 'failed',
        reason: classifyInstallFailure(outcome.error, null),
      };
    }
    this.lastCode = outcome.code;
    // 安装器自己的原文（msiexec 把过程写进日志；设置类的安装包直接刷在 stdout 上）
    this.flushInstallerLog(launched.logFile);
    if (outcome.code === 0) return { kind: 'ok' };
    return {
      kind: 'failed',
      reason: classifyInstallFailure(launched.tail(), outcome.code),
    };
  }

  private launchInstaller(
    plan: EnvNodePlan,
    file: string,
  ):
    | { ok: true; child: ChildProcess; tail: () => string; logFile: string | null }
    | { ok: false; reason: InstallFailureReason } {
    const tailRef = { text: '' };
    const collect = (chunk: string): void => {
      tailRef.text = (tailRef.text + chunk).slice(-OUTPUT_TAIL_CHARS);
    };

    if (plan.method === 'direct') {
      const msiexec = system32('msiexec.exe');
      if (!fs.existsSync(msiexec)) {
        return {
          ok: false,
          reason: {
            kind: 'unsupported',
            message: '没找到系统自带的安装程序，这一次没法自动装。',
            hint: FAILURE_HINTS.unsupported,
          },
        };
      }
      const logFile = `${file}.install.log`;
      const args = ['/i', file, '/qb', '/norestart', '/l*v', logFile];
      const spec = launchSpec(msiexec, args, 'win32');
      this.tempFiles.add(logFile);
      this.hooks.output(`命令：${plan.display}\n`);
      return {
        ok: true,
        child: this.spawnInstaller(spec, collect),
        tail: () => tailRef.text,
        logFile,
      };
    }

    // 版本管理器的安装程序。VM-02 实测：**不带静默参数时它的许可协议窗口会一直等用户点选**，
    // 而界面只会说"安装已经在进行"，用户只能干等。所以先按安装包的真实形态给静默参数：
    // Inno Setup 用 `/VERYSILENT`（NSIS 的 `/S` 它不认），NSIS 用 `/S`；认不出来才退回可见向导，
    // 那时**必须**把"请到窗口里操作"说给用户听。
    const flavor = readInstallerFlavor(file);
    const silentArgs = installerSilentArgs(flavor);
    if (silentArgs.length > 0) {
      this.hooks.output(
        `安装器形态：${flavor === 'inno' ? 'Inno Setup' : 'NSIS'} → 用静默参数 ${silentArgs.join(' ')}（不需要你在窗口里点任何东西）\n`,
      );
      this.publish('installing', { message: '正在静默安装版本管理器（不会弹出向导）…' });
    } else {
      this.hooks.output(
        '没能认出这个安装包用的是哪家的安装器，所以不敢给静默参数：它会弹出自己的窗口，请到那个窗口里把向导点完（例如许可协议），我们会等它结束。\n',
      );
      this.publish('installing', {
        message:
          '正在等待安装程序：它有一个窗口需要你点选（例如许可协议），请到那个窗口里完成；点完之后我们会自动继续。',
      });
    }
    const spec = launchSpec(file, silentArgs, 'win32');
    this.hooks.output(
      `命令：${plan.display}${silentArgs.length ? ` ${silentArgs.join(' ')}` : ''}\n`,
    );
    return {
      ok: true,
      child: this.spawnInstaller(spec, collect),
      tail: () => tailRef.text,
      logFile: null,
    };
  }

  private spawnInstaller(spec: LaunchSpec, collect: (chunk: string) => void): ChildProcess {
    const child = spawnSpec(spec, {});
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = String(chunk);
      collect(text);
      this.hooks.output(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = String(chunk);
      collect(text);
      this.hooks.output(text);
    });
    return child;
  }

  /** msiexec 的过程写在日志里；把尾巴贴进输出区（退出码之外，用户与我们都靠它看原因） */
  private flushInstallerLog(logFile: string | null): void {
    if (!logFile) return;
    try {
      const size = fs.statSync(logFile).size;
      const start = Math.max(0, size - OUTPUT_TAIL_CHARS);
      const handle = fs.openSync(logFile, 'r');
      const buffer = Buffer.alloc(size - start);
      fs.readSync(handle, buffer, 0, buffer.length, start);
      fs.closeSync(handle);
      const text = buffer.toString('utf8');
      if (text.trim()) this.hooks.output(`${text}\n`);
      this.removeQuietly(logFile);
    } catch {
      // 日志没写出来（例如提权询问就被拒）：不影响结论，退出码已经说了
    }
  }

  /**
   * 版本管理器那条路的第二步：用它把 Node **装成真的可用**（VM-01 的修法；VM-11 按 v2 的模型重做）。
   *
   * VM-11 的客机（nvm **v2.0.0**，shim 模式）证明了两件事：
   *   1. v2 **不设** `NVM_HOME` / `NVM_SYMLINK`，PATH 里是 `<root>` 与 `<root>\.nodejs`，
   *      版本装在 `<root>\installs` —— 所以模型必须从**真实证据**推（`nvm env` / 注册表 / PATH），
   *      不能再假设 v1 的那两个变量与 `<root>\nodejs`；
   *   2. **装版本是应用自己的事**：客机 `nvm list` → `No versions installed.`，
   *      于是 `<root>\.nodejs\node.exe` 这个 shim 跑起来只说
   *      `No active Node.js version is configured. Run \`nvm install <version>\` then \`nvm use <version>\`.`
   *      —— 用户被这句话打发去终端，而我们要**自己去装**（选稳定版 → `nvm install` → `nvm use` → 复检）。
   */
  private async installNodeWithNvm(
    plan: EnvNodePlan,
  ): Promise<
    { kind: 'ok' } | { kind: 'detached' } | { kind: 'failed'; reason: InstallFailureReason }
  > {
    // 版本管理器刚装完：系统里的 **PATH 与它写的环境变量都要立刻进本进程**
    this.refreshProcessPathFromSystem();
    const probed = await this.probeNvmModel();
    if (probed === 'detached') return { kind: 'detached' };
    if (!probed) {
      return {
        kind: 'failed',
        reason: {
          kind: 'nvm-inactive',
          message: '版本管理器装完了，但我们没找到它的命令，所以没能让它装 Node。',
          hint: FAILURE_HINTS['nvm-inactive'],
        },
      };
    }
    const model = probed;
    this.hooks.log(
      `版本管理器模型：根=${model.root}；模式=${model.mode}；${model.evidence.join('；')}`,
    );
    const source = normalizeNodeSource(this.settings.get('envNodeSource'));
    const extra: NodeJS.ProcessEnv = source ? { NVM_NODEJS_ORG_MIRROR: source } : {};
    const versionArg = plan.version.replace(/^v/, '');

    // 1. 先问清现状：装了哪些、active 是谁（客机：`No versions installed.` → 空清单）
    const before = await this.readNvmList(model.exe, extra);
    if (before === 'detached') return { kind: 'detached' };
    const alreadyInstalled =
      before !== null &&
      before.versions.some((version) => compareNodeVersions(version, versionArg) === 0);
    this.hooks.log(
      `安装前盘点：装了 ${before?.versions.join(', ') || '（空）'}；active=${before?.active ?? '（没有）'}；目标 ${plan.version} ${alreadyInstalled ? '已在清单里' : '还没装'}`,
    );

    // 2. 没装就**真的装**（v2 的 `nvm install <版本>`；v1 也能跑同一条命令）
    if (!alreadyInstalled) {
      const installed = await this.runNvmCommand(
        model.exe,
        ['install', versionArg],
        NVM_INSTALL_TIMEOUT_MS,
        extra,
        `正在让它下载并安装 Node.js ${plan.version}`,
        'nvm install',
      );
      if (installed.kind !== 'ok') return installed;
      const marker = parseNvmInstallOutput(installed.tail);
      this.hooks.log(
        marker
          ? `nvm install 成功标记：Installed Node.js v${marker}`
          : 'nvm install 退出码 0，但没看到 `Installed Node.js …` 那行标记（继续用清单与实测判断）',
      );
      // 退出码之外还要**事实**：它自己的清单里有没有这个版本
      const afterInstall = await this.readNvmList(model.exe, extra);
      if (afterInstall === 'detached') return { kind: 'detached' };
      if (afterInstall === null) {
        this.hooks.log('`nvm list` 没读懂（拿不到清单）——继续走后面的实测，不在这里下结论');
      } else {
        this.hooks.log(
          `安装后盘点：装了 ${afterInstall.versions.join(', ') || '（空）'}；active=${afterInstall.active ?? '（没有）'}`,
        );
        if (
          !afterInstall.versions.some((version) => compareNodeVersions(version, versionArg) === 0)
        ) {
          return {
            kind: 'failed',
            reason: {
              kind: 'nvm-inactive',
              message: `版本管理器说装完了，但它的清单里没有 Node.js ${plan.version}。`,
              hint: FAILURE_HINTS['nvm-inactive'],
            },
          };
        }
      }
    }

    // 3. 切换：active 不是它就跑 `nvm use <版本>`
    const activeNow = before?.active ?? null;
    if (activeNow !== null && compareNodeVersions(activeNow, versionArg) === 0) {
      this.hooks.log(`当前 active 已经是 ${activeNow}，跳过 nvm use`);
    } else {
      const used = await this.useNvmVersion(model, versionArg, plan.version, extra);
      if (used.kind !== 'ok') return used;
    }

    // 4. 环境再刷新一次（v2 的 shim 目录 / v1 的软链都变了），然后实测 node 与 npm
    this.refreshProcessPathFromSystem();
    return await this.verifyActiveNode(plan, model);
  }

  /**
   * 把版本管理器的模型从真实证据里读出来：`nvm.exe` 的真路径 + `nvm env` 的报告 +
   * 注册表偏好 + 用户级 PATH 的条目。**不读 `NVM_HOME` / `NVM_SYMLINK` 当主证**（v2 不设它们）。
   *
   * 返回 `'detached'` 表示"用户点了不再等待"，`null` 表示"确实没找到版本管理器"。
   */
  private async probeNvmModel(): Promise<NvmModel | null | 'detached'> {
    const exe = this.findNvmExe();
    let report: NvmEnvReport | null = null;
    if (exe) {
      const probe = await this.runNvmCommand(
        exe,
        ['env'],
        NVM_LIST_TIMEOUT_MS,
        {},
        '正在读取版本管理器的环境报告',
        'nvm env',
      );
      if (probe.kind === 'detached') return 'detached';
      if (probe.kind === 'ok') {
        report = parseNvmEnvOutput(probe.tail);
        this.hooks.log(
          `nvm env：版本=${report.version ?? '（没给）'}；开关=${report.status ?? '（没给）'}；模式=${report.mode}；程序根=${report.programRoot ?? '（没给）'}；版本目录=${report.installsDir ?? '（没给）'}；版本数=${report.versionsTotal ?? '（没给）'}；默认=${report.defaultVersion ?? '（没设）'}`,
        );
      } else {
        this.hooks.log(
          `nvm env 没跑成（${probe.reason.kind}）——v1 没有这条命令，继续用注册表 / PATH 的证据`,
        );
      }
    }
    // v2 的安装器把偏好写在 `HKCU\Software\<发布方>\Preferences\nvm`（见 VM-11 的实测与官方安装脚本）
    const rootGuess = exe ? path.win32.dirname(exe) : envValue(process.env, 'NVM_HOME');
    if (rootGuess) {
      const registry = readNvmRegistryPreferences(rootGuess);
      if (registry) {
        report = {
          version: registry.version ?? report?.version ?? null,
          status: registry.status ?? report?.status ?? null,
          mode: registry.mode !== 'unknown' ? registry.mode : (report?.mode ?? 'unknown'),
          installsDir: registry.installsDir ?? report?.installsDir ?? null,
          versionsTotal: report?.versionsTotal ?? null,
          defaultVersion: registry.defaultVersion ?? report?.defaultVersion ?? null,
          programRoot: report?.programRoot ?? rootGuess,
          nodeMirror: report?.nodeMirror ?? null,
          npmMirror: report?.npmMirror ?? null,
        };
        this.hooks.log(
          `注册表偏好：InstallRoot=${registry.installsDir ?? '（没给）'}；OperatingMode=${registry.mode}；ActiveVersion=${registry.defaultVersion ?? '（没设）'}`,
        );
      }
    }
    const pathDirs = String(process.env.Path ?? process.env.PATH ?? '')
      .split(path.delimiter)
      .map((dir) => dir.trim())
      .filter(Boolean);
    return deriveNvmModel({ exe, env: process.env, report, pathDirs });
  }

  /** 每一条版本管理器命令的**可诊断证据**：命令 / 退出码 / stdout / stderr（空的那路写「（空）」） */
  private logNvmStep(
    label: string,
    args: string[],
    code: number | null,
    stdout: string,
    stderr: string,
  ): void {
    const show = (text: string): string => {
      const trimmed = String(text ?? '').trim();
      return trimmed ? trimmed.slice(-STEP_EVIDENCE_CHARS) : '（空）';
    };
    this.hooks.log(
      `${label}：nvm ${args.join(' ')} → 退出码 ${code ?? '未知'}；stdout：${show(stdout)}；stderr：${show(stderr)}`,
    );
  }

  /** 跑一条版本管理器命令：看退出码、收输出（`nvm install` / `nvm use` / `nvm list` / `nvm env` 共用） */
  private async runNvmCommand(
    nvm: string,
    args: string[],
    timeoutMs: number,
    extra: NodeJS.ProcessEnv,
    label: string,
    /** 写日志用的步骤名（默认取子命令名）；证据里要能认出是哪一步 */
    step?: string,
  ): Promise<
    | { kind: 'ok'; tail: string; code: number | null }
    | { kind: 'detached' }
    | { kind: 'failed'; reason: InstallFailureReason; tail: string }
  > {
    const name = step ?? args[0] ?? 'nvm';
    this.publish('installing', { message: label, code: null, report: null });
    this.hooks.output(`命令：${path.basename(nvm)} ${args.join(' ')}\n`);
    const spec = launchSpec(nvm, args, 'win32');
    const child = spawnSpec(spec, extra);
    this.child = child;
    // stdout / stderr **分开收**：验收要求每一步都能在 console.log 里看到
    // 「命令 / 退出码 / stdout / stderr（空的那路写（空））」，合并成一个尾巴就分不清了。
    const outRef = { text: '' };
    const errRef = { text: '' };
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = String(chunk);
      outRef.text = (outRef.text + text).slice(-OUTPUT_TAIL_CHARS);
      this.hooks.output(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = String(chunk);
      errRef.text = (errRef.text + text).slice(-OUTPUT_TAIL_CHARS);
      this.hooks.output(text);
    });
    const outcome = await this.waitForClose(child, timeoutMs);
    const tail = (outRef.text + errRef.text).slice(-OUTPUT_TAIL_CHARS);
    if (outcome.kind === 'detached') {
      this.logNvmStep(`${name}（不再等待）`, args, null, outRef.text, errRef.text);
      return { kind: 'detached' };
    }
    if (outcome.kind === 'error') {
      this.logNvmStep(name, args, null, outRef.text, errRef.text);
      return {
        kind: 'failed',
        reason: classifyInstallFailure(outcome.error, null),
        tail,
      };
    }
    this.lastCode = outcome.code;
    this.logNvmStep(name, args, outcome.code, outRef.text, errRef.text);
    if (outcome.code !== 0) {
      return {
        kind: 'failed',
        reason: classifyInstallFailure(`${args[0]}: ${tail}`, outcome.code),
        tail,
      };
    }
    return { kind: 'ok', tail, code: outcome.code };
  }

  /** 问一次版本管理器自己的清单（`nvm list`）；跑不动或读不懂都返回 null，由调用方决定怎么办 */
  private async readNvmList(
    nvm: string,
    extra: NodeJS.ProcessEnv,
  ): Promise<NvmListOutput | null | 'detached'> {
    const listing = await this.runNvmCommand(
      nvm,
      ['list'],
      NVM_LIST_TIMEOUT_MS,
      extra,
      '正在确认已安装的 Node 版本',
    );
    if (listing.kind === 'detached') return 'detached';
    if (listing.kind === 'failed') return null;
    return parseNvmListOutput(listing.tail);
  }

  /**
   * `nvm use <版本>`（v2 的 shim 模式 / v1 的 link 模式都走这一条）。
   *
   * **权限模型据实收窄（VM-11 第 5 条）**：v2 的官方说明是
   * 「Shim mode - no symlinks, fast (written in Zig)」「No mandatory administrator privileges」
   * —— 客机也是 `Developer Mode: Disabled` + 非管理员而链路照样走通。
   * 所以**只有 link/symlink 模式**（v1 那种要建 junction/symlink 的）才走一次性提权；
   * shim 模式失败时**不弹 UAC**，如实报错并说明模式（不再对 v2 做一次没必要的提权）。
   */
  private async useNvmVersion(
    model: NvmModel,
    versionArg: string,
    displayVersion: string,
    extra: NodeJS.ProcessEnv,
  ): Promise<
    { kind: 'ok' } | { kind: 'detached' } | { kind: 'failed'; reason: InstallFailureReason }
  > {
    const first = await this.runNvmCommand(
      model.exe,
      ['use', versionArg],
      NVM_USE_TIMEOUT_MS,
      extra,
      `正在切到 Node.js ${displayVersion}`,
      'nvm use',
    );
    if (first.kind === 'ok') {
      const marker = parseNvmUseOutput(first.tail);
      this.hooks.log(
        marker
          ? `nvm use 成功标记：Now using Node.js v${marker} by default.`
          : 'nvm use 退出码 0，但没看到 `Now using Node.js …` 那行标记（继续用实测判断）',
      );
      return { kind: 'ok' };
    }
    if (first.kind === 'detached') return { kind: 'detached' };
    const privilege =
      first.reason.kind === 'symlink' ||
      /sufficient privileges|symbolic link|symlink|junction|SeCreateSymbolicLinkPrivilege|拒绝访问/i.test(
        first.tail,
      );
    if (!privilege) return { kind: 'failed', reason: first.reason };

    // 权限类失败：先看模式。v2 的 shim 模式**不需要**提权建链接 —— 那时弹 UAC 是没必要的。
    if (model.mode === 'shim') {
      this.hooks.log(
        `nvm use 失败看起来是权限类，但模型是 shim 模式（v2 无符号链接、官方说明不需要管理员）——不请求提权，照实报`,
      );
      return { kind: 'failed', reason: first.reason };
    }

    const developerMode = readDeveloperMode();
    const elevatedNow = await this.isElevated();
    this.hooks.log(
      `nvm use 失败（${model.mode === 'link' ? 'link 模式要建链接' : '模式未知'}，需要权限）；开发者模式：${developerMode ? '已开启' : '未开启'}；当前进程${elevatedNow ? '是' : '不是'}管理员`,
    );
    if (elevatedNow || developerMode) {
      // 已经是管理员、或开发者模式本来就能建链接，仍然失败 → 如实报（再弹 UAC 也解决不了）
      return {
        kind: 'failed',
        reason: {
          kind: 'symlink',
          message: FAILURE_MESSAGES.symlink,
          hint: FAILURE_HINTS.symlink,
        },
      };
    }

    const elevated = await this.runElevated(model.exe, ['use', versionArg]);
    if (elevated.kind === 'ok') {
      this.hooks.log('一次性提权成功，链接已创建');
      return { kind: 'ok' };
    }
    if (elevated.kind === 'stopped') {
      // 用户点了「不再等待」、或提权进程还在跑：保持"未确定"，由事实/用户确认收尾
      this.hooks.log('提权那一步没有结论（停止等待或进程仍在跑）：保持"未确定"');
      return { kind: 'detached' };
    }
    this.hooks.log(`一次性提权没有完成（${elevated.kind}）：${elevated.text.trim().slice(0, 200)}`);
    // 三种"没成功"各自有自己的类别与文案（超时**不许**归成"没权限"：F-02 第 1 条）
    return { kind: 'failed', reason: elevationFailure(elevated.kind) };
  }

  /**
   * 一次性提权跑一条命令（`Start-Process -Verb RunAs -Wait -PassThru`）：只弹一次 UAC。
   *
   * **异步、先说后做**（F-03）：`publish` 那条"正在请求一次管理员权限、请在弹出的窗口里选择"
   * 排在 `spawn` **之前**，而且整段不阻塞事件循环 —— UAC 对话框出现时界面已经渲染出了这句话；
   * 以前用 `spawnSync` 时主进程会停住，用户看到的是"应用卡死"，连要不要点 UAC 都不知道。
   *
   * 四种结果（F-02）：`ok` / `declined`（用户没允许）/ **`timeout`**（我们等太久）/ `failed`。
   * 超时**不杀**这个 PowerShell（它 `-Wait` 的那个提权进程是独立的，可能还在把链接建好），
   * 也**不当成"没权限"**：先按"未确定"发布，再用事实复检决定结论（`settleElevationTimeout`）。
   */
  private async runElevated(
    file: string,
    args: string[],
  ): Promise<{ kind: ElevationOutcome | 'stopped'; text: string }> {
    // 可注入边界（F-02 第 3 条）：夹具可以把四种结果真跑出来，不必真的有 UAC
    const injected = this.hooks.elevate;
    if (injected) {
      const outcome = await injected({ file, args });
      return { kind: outcome, text: `（注入的提权执行器返回 ${outcome}）` };
    }
    const shell = this.powerShell();
    if (!shell) {
      return { kind: 'failed', text: '这台电脑上找不到 PowerShell，没法请求一次权限。' };
    }
    const script = [
      `$p = Start-Process -FilePath ${psQuote(file)} -ArgumentList ${args.map((arg) => psQuote(arg)).join(',')} -Verb RunAs -Wait -PassThru`,
      `[pscustomobject]@{ ExitCode = $p.ExitCode } | ConvertTo-Json -Compress`,
    ].join('; ');
    // 顺序是这条修复的一部分：状态先出去，再起进程
    this.publish('installing', { message: ELEVATION_WAITING_MESSAGE, code: null, report: null });
    this.hooks.output(
      '这一步要在系统里创建一个链接，普通权限做不到，所以会弹一次权限询问；允许之后我们会继续。\n',
    );
    const spec = launchSpec(shell, ['-NoProfile', '-NonInteractive', '-Command', script], 'win32');
    const child = spawnSpec(spec, {});
    this.child = child;
    let text = '';
    const collect = (chunk: Buffer): void => {
      const raw = String(chunk);
      text = (text + raw).slice(-OUTPUT_TAIL_CHARS);
      this.hooks.output(raw);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const outcome = await this.waitForClose(child, ELEVATED_TIMEOUT_MS, 'stop-waiting');
    if (outcome.kind === 'timeout') return await this.settleElevationTimeout(text);
    if (outcome.kind === 'detached') return { kind: 'stopped', text };
    return {
      kind: classifyElevationOutcome({
        code: outcome.kind === 'exit' ? outcome.code : null,
        stdout: text,
        stderr: '',
        error: outcome.kind === 'error' ? outcome.error : null,
        timedOut: false,
      }),
      text,
    };
  }

  /**
   * 提权**等太久**的收尾（F-02 第 2 条）：在事实复检之前**不下结论**。
   *
   * - 复检证明链接已经建好 → 改口说"已经落地"，继续往下走（这是"机器真的被改了、
   *   界面却说没完成"那条的唯一堵法）；
   * - 那个提权进程还在跑 → 保持**未确定**（锁继续持有；它退出时 `finishDetached` 会再复检一次）；
   * - 进程已经结束、链接也没建起来 → 现在才可以下结论：`elevation-timeout`
   *   （**不是** `symlink` —— 我们等超时了，不等于用户没权限）。
   */
  private async settleElevationTimeout(
    text: string,
  ): Promise<{ kind: ElevationOutcome | 'stopped'; text: string }> {
    this.holding = true;
    this.detachedFlag = true;
    this.publish('waiting', {
      message: ELEVATION_TIMEOUT_MESSAGE,
      percent: null,
      bytes: null,
      code: null,
      report: null,
      detached: true,
    });
    this.hooks.log('提权：等待权限询问超时（不杀那个进程）；先按"未确定"发布，再用事实复检');
    if (this.recheckActiveNodeLanded()) {
      this.holding = false;
      this.detachedFlag = false;
      this.hooks.log('提权超时之后复检发现链接已经建好 → 按"已经落地"继续');
      this.hooks.output('复检发现链接已经建好，继续。\n');
      return { kind: 'ok', text };
    }
    if (this.child !== null) {
      // 提权进程还在跑：不许下结论（它可能马上就建好了）
      this.detachedWatch = true;
      this.hooks.log('提权进程还在跑：保持"未确定"（锁继续持有，等它退出或用户确认）');
      return { kind: 'stopped', text };
    }
    this.holding = false;
    this.detachedFlag = false;
    this.hooks.log('提权进程已经结束、链接仍没建起来 → 按"等太久"下结论（不是"没权限"）');
    return { kind: 'timeout', text };
  }

  /**
   * 事实复检：**现在到底有没有一个能跑的 Node**。
   *
   * 判据不是"某个目录在不在"，而是**真的跑一次**（v2 的 shim 会自己派发；没有 active 版本时
   * 它会照实说 `No active Node.js version is configured…`，那句话**不算可用**）。
   * 先问 PATH 解析到的那个 node（用户机器上真在用的就是这个），再问模型给的目录。
   */
  private recheckActiveNodeLanded(): boolean {
    this.refreshProcessPathFromSystem();
    const fromPath = whichSync('node') ?? findNodeExe();
    if (fromPath && fs.existsSync(fromPath)) {
      const probe = this.probeCommand(fromPath, ['--version']);
      this.hooks.output(`复检：${fromPath} --version → ${probe.text.trim() || '（没有输出）'}\n`);
      if (hasNodeVersionOutput(probe.text) && !isInactiveNodeShimOutput(probe.text)) return true;
    }
    return false;
  }

  /**
   * 收尾实测：**`<node> --version` 与 `<npm> --version` 都要真的拿到输出**才算这一步完成。
   *
   * 这条就是 VM-01 / VM-11 的判据（不是"nvm.exe 存在"，也不是"某个目录存在"）：
   * 没有 active version 时 v2 的 shim 会照实说
   * `No active Node.js version is configured. Run \`nvm install <version>\` then \`nvm use <version>\`.`
   * —— **那句话不算可用**（这里有专门一条 `isInactiveNodeShimOutput` 认它）。
   *
   * 探谁：**优先 PATH 解析到的那个 node**（用户机器上真在用的就是它，v2 是 `<root>\.nodejs`、
   * v1 是软链目录；不再自己拼一个"应该是"的路径 —— VM-12 的教训），模型给的目录作为补充证据。
   */
  private async verifyActiveNode(
    plan: EnvNodePlan,
    model: NvmModel,
  ): Promise<{ kind: 'ok' } | { kind: 'failed'; reason: InstallFailureReason }> {
    const fromPath = whichSync('node') ?? findNodeExe();
    const fromModel =
      model.activeDir && fs.existsSync(path.win32.join(model.activeDir, 'node.exe'))
        ? path.win32.join(model.activeDir, 'node.exe')
        : null;
    // v1 风格的机器：真设了 `NVM_SYMLINK` 且那里真有 node.exe 时也探一下（**以真实存在的为准**，
    // 不是假设；v2 不设这个变量，所以这里通常不会加进来 —— VM-11 的教训）
    const symlinkDir = envValue(process.env, 'NVM_SYMLINK');
    const fromSymlink =
      symlinkDir && fs.existsSync(path.win32.join(symlinkDir, 'node.exe'))
        ? path.win32.join(symlinkDir, 'node.exe')
        : null;
    const targets: string[] = [];
    for (const candidate of [fromPath, fromModel, fromSymlink]) {
      if (candidate && !targets.includes(candidate)) targets.push(candidate);
    }
    if (targets.length === 0) targets.push(''); // 一个都没有 → 走下面那条"找不到 node"的失败

    let nodeText = '';
    let usedNode = '';
    for (const target of targets) {
      const probe = this.probeCommand(target || null, ['--version']);
      this.hooks.output(
        `实测：${target || '（没找到 node）'} --version → ${probe.text.trim() || '（没有输出）'}\n`,
      );
      nodeText = probe.text;
      usedNode = target;
      if (hasNodeVersionOutput(probe.text) && !isInactiveNodeShimOutput(probe.text)) break;
    }
    if (!hasNodeVersionOutput(nodeText) || isInactiveNodeShimOutput(nodeText)) {
      const evidence = nodeText.trim() || '零输出';
      this.hooks.log(
        `nvm 收尾实测失败：${usedNode || '（没找到 node）'} 跑不出可用版本 → ${evidence.slice(0, 200)}`,
      );
      return {
        kind: 'failed',
        reason: {
          kind: 'nvm-inactive',
          message: isInactiveNodeShimOutput(nodeText)
            ? '版本管理器的 shim 还在说"没有激活任何版本"，所以这一步没有完成。'
            : '装完了，但这一步没能让 Node 跑起来（node --version 没有输出）。',
          hint: FAILURE_HINTS['nvm-inactive'],
        },
      };
    }
    // npm 要找**和刚才那个 node 同一个目录**里的那份（v2 的 shim 就在旁边），否则退回 PATH
    const npmBeside = usedNode ? path.win32.join(path.win32.dirname(usedNode), 'npm.cmd') : null;
    const npmTarget = npmBeside && fs.existsSync(npmBeside) ? npmBeside : whichSync('npm');
    const npmProbe = this.probeCommand(npmTarget, ['--version']);
    this.hooks.output(
      `实测：${npmTarget ?? '（没找到 npm）'} --version → ${npmProbe.text.trim() || '（没有输出）'}\n`,
    );
    if (!hasNodeVersionOutput(npmProbe.text)) {
      const classified = classifyInstallFailure(npmProbe.text, npmProbe.code);
      this.hooks.log(
        `nvm 收尾实测失败：npm --version 没拿到版本号 → ${npmProbe.text.trim().slice(0, 200) || '零输出'}`,
      );
      return {
        kind: 'failed',
        reason:
          classified.kind === 'nvm-inactive'
            ? classified
            : {
                kind: 'nvm-inactive',
                message: '装完了，但这一步没能让 npm 跑起来（npm --version 没有输出）。',
                hint: FAILURE_HINTS['nvm-inactive'],
              },
      };
    }
    // `nvm list` 的 active 也记一行（证据：谁在生效），但它不是判据 —— 判据是上面两条实测
    if (model.exe) {
      const source = normalizeNodeSource(this.settings.get('envNodeSource'));
      const extra = source ? { NVM_NODEJS_ORG_MIRROR: source } : {};
      const listing = await this.readNvmList(model.exe, extra);
      if (listing !== 'detached' && listing !== null) {
        this.hooks.log(
          `nvm 收尾：active=${listing.active ?? '（没有）'}；装了 ${listing.versions.join(', ') || '（空）'}`,
        );
        if (listing.active && compareNodeVersions(listing.active, plan.version) !== 0) {
          this.hooks.output(
            `注意：版本管理器当前激活的是 ${listing.active}，这次装的是 ${plan.version}。\n`,
          );
        }
      }
    }
    return { kind: 'ok' };
  }

  /** 跑一次 `<file> --version` 这类实测：拿到退出码与（stdout+stderr 的）原文，失败不抛 */
  private probeCommand(file: string | null, args: string[]): { code: number | null; text: string } {
    if (!file) return { code: null, text: '' };
    const probe = runProbe(file, args, PROBE_TIMEOUT_MS);
    const text = `${probe.stdout}${probe.stderr}${probe.error ? `\n${probe.error}` : ''}`;
    return { code: probe.code, text };
  }

  /** 更新前停掉本应用启动的 dsh：失败只记一行（不让它挡住整条通道，安装器的退出码会说话） */
  private async stopDshForUpdate(): Promise<void> {
    try {
      await this.hooks.stopDsh();
      this.hooks.log('更新前已停止本应用启动的 dsh');
    } catch (error) {
      this.hooks.log(`更新前停 dsh 失败（继续安装，安装器自己会说结果）：${messageOf(error)}`);
    }
  }

  // -------------------------------------------------------------- 收尾

  private async settleSuccess(plan: EnvNodePlan): Promise<EnvInstallState> {
    this.refreshProcessPathFromSystem();
    // **实测**：装完必须真的跑一次 `<新 node> --version` 并拿到输出才算成功 ——
    // 安装器的退出码只说"它自己退出了"，说不了"这台电脑上现在有一个能跑的 Node"
    const observed = this.probeInstalledNode();
    this.publish('rechecking', { message: '正在重新检测' });
    const report = await this.safeRecheck();
    if (!report) {
      return this.publish('error', {
        message: '装完了，但这一轮没能重新检测。重开一次应用再检测一次。',
        report: null,
      });
    }
    const terminalNote = '其它已经打开的终端窗口需要重开一次，才会用上新装的 Node。';
    if (!observed || this.nodeMissing(report)) {
      // 装完了但没找到（或找不到能跑的）：**不算成功**，出路交给界面（交互规格 §4.5）
      this.hooks.log(
        `安装结束，但没能实测到可用的 Node（路径 ${observed?.path ?? '没找到'}，输出 ${observed?.version ?? '无'}）`,
      );
      this.discardTempDir();
      return this.publish('error', {
        message: `装完了，但我们还没找到 Node。${terminalNote}也可以重开一次应用。`,
        report,
        observedVersion: null,
      });
    }
    this.hooks.log(`安装完成并实测通过：${observed.path} → ${observed.version}`);
    // 装完了、复检也认了，我们落过的临时文件（安装包与安装日志）就没有用处了
    this.discardTempDir();
    const sameTarget = observed.version === plan.version;
    return this.publish('done', {
      message: sameTarget
        ? `Node.js ${observed.version} 装好了，这一项已经变成「正常」。${terminalNote}`
        : // 实测到的版本与这次装的目标不一样（例如系统查找路径里还排着一个旧的 Node）：
          // 照实说，别把"装好了"说成"你正在用的就是它"
          `装完了。现在这台电脑上找到的是 ${observed.version}（这次装的是 ${plan.version}）。${terminalNote}`,
      report,
      // 「更新后版本」必须是**实测**到的那个（冻结 §3.2.1）：目标版本不许冒充实测版本
      observedVersion: observed.version,
    });
  }

  /**
   * 读**当前这份 Node** 的版本号（`vX.Y.Z`）——`EnvNodePlan.currentVersion` 的事实来源。
   *
   * 异步（不阻塞主进程）、认不出就 `null`（**不猜**：档位跟着它走，猜错就是 VM-15 那种"看起来像降级"）。
   */
  private async readNodeVersion(nodePath: string): Promise<string | null> {
    const probe = await runProbeAsync(nodePath, ['--version'], PROBE_TIMEOUT_MS);
    const line = `${probe.stdout}${probe.stderr}`
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => hasNodeVersionOutput(item));
    if (!line) {
      if (probe.error) this.hooks.log(`没能读到当前这份 Node 的版本：${probe.error}`);
      return null;
    }
    const match = /v?\d+\.\d+(?:\.\d+)?/.exec(line);
    if (!match) return null;
    return match[0].startsWith('v') ? match[0] : `v${match[0]}`;
  }

  /**
   * 实测一次：找到的 node 跑 `--version` 有没有输出（有输出才算可用，与阶段一
   * `canRunDsh` 的判据同一条：dsh 在跑不动的 Node 上是"退出码 0 + 零输出"）。
   */
  private probeInstalledNode(): { path: string; version: string } | null {
    const nodePath = this.probeNodePath();
    if (!nodePath) return null;
    const probe = runProbe(nodePath, ['--version'], PROBE_TIMEOUT_MS);
    if (probe.error) {
      this.hooks.log(`实测新装的 Node 没能跑起来：${probe.error}`);
      return null;
    }
    const version = String(probe.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => hasNodeVersionOutput(line));
    if (!version) return null;
    return { path: nodePath, version };
  }

  private async settleCancelledDownload(): Promise<EnvInstallState> {
    this.hooks.log('安装：用户取消了下载（临时文件已删，系统上没有任何改动）');
    this.discardTempDir();
    this.holding = false;
    return this.publish('cancelled', {
      message: '已取消下载，这台电脑上什么都没改。',
      percent: null,
      bytes: null,
    });
  }

  /**
   * 失败收尾。**起了安装器的失败必须由复检事实说话**：
   * 「这台电脑上什么都没改」这句话只有在复检仍然说"缺"的时候才成立；
   * 复检说已经正常，那就照实说"其实已经落地"。
   */
  private async settleFailure(
    reason: InstallFailureReason,
    installerRan: boolean,
  ): Promise<EnvInstallState> {
    this.hooks.log(
      `环境安装失败：${reason.kind} → ${reason.message}${reason.hint ? `（${reason.hint}）` : ''}`,
    );
    if (!installerRan) {
      this.holding = false;
      this.discardTempDir();
      return this.publish('error', {
        message: visibleFailureText(reason),
        percent: null,
        bytes: null,
        report: null,
        observedVersion: null,
      });
    }
    this.refreshProcessPathFromSystem();
    this.publish('rechecking', { message: '正在重新检测' });
    const report = await this.safeRecheck();
    if (!report) {
      return this.publish('error', {
        message: `${visibleFailureText(reason)} 我们也没能重新检测（重开一次应用再看）。`,
        report: null,
      });
    }
    if (!this.nodeMissing(report)) {
      this.hooks.log('安装报错，但复检显示 Node 已经可用（以事实为准）');
      this.discardTempDir();
      return this.publish('done', {
        message: '安装其实已经落地：复检显示 Node 这一项已经正常。',
        report,
      });
    }
    this.discardTempDir();
    return this.publish('error', { message: visibleFailureText(reason), report });
  }

  /** 用户点了「我确认安装已经结束」：锁已经松开，但结论仍然由复检给 */
  private async confirmDetached(): Promise<void> {
    if (this.detachedSettling) return;
    this.detachedSettling = true;
    this.detachedWatch = false;
    this.refreshProcessPathFromSystem();
    this.publish('rechecking', { message: '正在重新检测', detached: true });
    const report = await this.safeRecheck();
    this.detachedFlag = false;
    // 用户已经确认安装结束，我们落下的临时文件（安装包 / 日志）不再需要
    this.discardTempDir();
    this.detachedSettling = false;
    if (!report) {
      this.publish('error', {
        message: '这一轮没能重新检测。重开一次应用再看。',
        detached: false,
        report: null,
        observedVersion: null,
      });
      return;
    }
    if (this.nodeMissing(report)) {
      this.publish('error', {
        message: '安装结束了，但复检显示这一项还是缺的。',
        detached: false,
        report,
        observedVersion: this.probeInstalledNode()?.version ?? null,
      });
      return;
    }
    this.publish('done', {
      message: '复检显示 Node 这一项已经正常。',
      detached: false,
      report,
      observedVersion: this.probeInstalledNode()?.version ?? null,
    });
  }

  /** 复检：注入的钩子说不清楚时只记一行、返回 null（**不编结论**） */
  private async safeRecheck(): Promise<EnvDoctorReport | null> {
    try {
      return await this.hooks.recheck();
    } catch (error) {
      this.hooks.log(`重新检测没能跑完：${messageOf(error)}`);
      return null;
    }
  }

  private nodeMissing(report: EnvDoctorReport): boolean {
    return (report.checks.find((check) => check.id === 'node')?.status ?? 'missing') === 'missing';
  }

  private publish(
    phase: EnvInstallState['phase'],
    patch: Partial<EnvInstallState>,
  ): EnvInstallState {
    const cancellable = phase === 'preparing' || phase === 'downloading' || phase === 'verifying';
    const next: EnvInstallState = {
      phase,
      method: this.current.method,
      mode: this.current.mode,
      percent: null,
      bytes: null,
      cancellable,
      detached: this.detachedFlag,
      message: null,
      code: this.lastCode,
      report: null,
      // 计划与实测版本要**跨页面重挂载**都能读到（冻结 §3.2.1 的 `EnvInstallState` 增量）：
      // 界面不许靠"我这次会话里记着计划"来渲染进度与收尾，收尾的"更新后版本"也必须是实测到的那个
      plan: this.current.plan,
      observedVersion: this.current.observedVersion,
      ...patch,
    };
    this.current = next;
    // 终态之后不再需要这一轮的计划（`finishDetached` 的补做只在未确定期间发生）
    if (phase === 'done' || phase === 'cancelled' || phase === 'error') this.activePlan = null;
    this.hooks.state(this.state());
    return this.state();
  }

  // -------------------------------------------------------------- 下载、等待与系统事实

  /** 下载（注入的下载器优先；默认走 Electron 的网络栈，遵循系统代理） */
  private download(url: string, dest: string): Promise<TransferResult> {
    if (this.hooks.download) {
      return this.hooks.download(url).then((result) => ({
        kind: 'ok',
        file: result.file,
        bytes: result.bytes,
        total: result.total,
      }));
    }
    return this.downloadWithElectron(url, dest);
  }

  /**
   * 等一次下载：用户点「取消下载」时**立刻放手**（不等对方真的停），
   * 临时文件在对方终于结束之后再删 —— 这样"取消"不会让界面卡在一个不响应的等待里。
   * `work()` **只起一次**（两次调用就是两次下载）。
   */
  private async awaitTransfer(
    dest: string,
    work: () => Promise<TransferResult>,
  ): Promise<TransferOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: TransferOutcome): void => {
        if (settled) return;
        settled = true;
        this.releaseTransfer = null;
        resolve(value);
      };
      const started = work();
      this.releaseTransfer = () => {
        this.abortTransfer();
        // 对方可能还在写文件：等它终于结束再清（清不掉就留给下一轮的残留清理）
        void started.then(
          () => this.removeQuietly(dest),
          () => this.removeQuietly(dest),
        );
        finish({ kind: 'cancelled' });
      };
      started.then(
        (value) => finish(value),
        (error: unknown) => finish({ kind: 'failed', error: messageOf(error) }),
      );
    });
  }

  private downloadWithElectron(url: string, dest: string): Promise<TransferResult> {
    return new Promise((resolve, reject) => {
      const net = electronNet();
      if (!net) {
        reject(new Error('ENOTSUP: 这次没有可用的下载通道（不在应用里运行）'));
        return;
      }
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let stream: fs.WriteStream | null = null;
      let request: NetRequest | null = null;
      const stopTimer = (): void => {
        if (timer) clearTimeout(timer);
        timer = null;
      };
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        stopTimer();
        this.downloadAbort = null;
        action();
      };
      const abort = (): void => {
        try {
          request?.abort();
        } catch {
          // 已经结束
        }
        stream?.destroy();
      };
      try {
        request = net.request({ method: 'GET', url, redirect: 'follow' });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.downloadAbort = abort;
      timer = setTimeout(() => {
        abort();
        finish(() => reject(new Error('ETIMEDOUT: 下载超时')));
      }, TRANSFER_TIMEOUT_MS);
      timer.unref?.();

      request.on('error', (error: Error) => {
        finish(() => reject(new Error(`ENETWORK: ${error.message}`)));
      });
      request.on('response', (response: NetResponse) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          abort();
          finish(() => reject(new Error(`ENETWORK: HTTP ${response.statusCode}`)));
          return;
        }
        const total = contentLength(response.headers);
        let downloaded = 0;
        stream = fs.createWriteStream(dest);
        stream.on('error', (error: Error) => {
          abort();
          finish(() => reject(error));
        });
        stream.on('finish', () => {
          finish(() => resolve({ kind: 'ok', file: dest, bytes: downloaded, total }));
        });
        response.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          stream?.write(chunk);
          this.reportProgress(downloaded, total);
        });
        response.on('end', () => {
          stream?.end();
        });
        response.on('error', (error: Error) => {
          abort();
          finish(() => reject(new Error(`ENETWORK: ${error.message}`)));
        });
      });
      request.end();
    });
  }

  /** 下载进度：算得出百分比才给（算不出就不画进度条）；百分比没变就不推 */
  private reportProgress(downloaded: number, total: number | null): void {
    const percent =
      total && total > 0 ? Math.min(100, Math.floor((downloaded / total) * 100)) : null;
    if (percent !== null && percent === this.lastPercent) return;
    this.lastPercent = percent;
    const label = this.current.method === 'nvm' ? '版本管理器的安装包' : 'Node.js';
    this.publish('downloading', {
      message: percent === null ? `正在下载 ${label}…` : `正在下载 ${label}…${percent}%`,
      percent,
      bytes: total ? { downloaded, total } : null,
    });
  }

  /**
   * 等一个子进程收尾。四种结果：正常退出 / 没起来 / **我们不再等待** / **等待上限到了**。
   *
   * 两个"没等到"的差别（F-02）：
   * - `detach`（默认，安装器与版本管理器命令用）：超时 = 我们不再等待 —— 发布未确定结论、
   *   互斥位继续持有、**不杀**（把安装器杀在半路比不装更糟）；
   * - `stop-waiting`（提权那趟用）：超时只把控制权交回调用方，**不清锁、不发结论** ——
   *   调用方要先做事实复检，再决定是"其实已经落地"还是"等太久"（见 `settleElevationTimeout`）。
   */
  private waitForClose(
    child: ChildProcess,
    timeoutMs: number,
  ): Promise<Exclude<CloseOutcome, { kind: 'timeout' }>>;
  private waitForClose(
    child: ChildProcess,
    timeoutMs: number,
    onTimeout: 'stop-waiting',
  ): Promise<CloseOutcome>;
  private waitForClose(
    child: ChildProcess,
    timeoutMs: number,
    onTimeout: 'detach' | 'stop-waiting' = 'detach',
  ): Promise<CloseOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (value: CloseOutcome): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        this.releaseWait = null;
        resolve(value);
      };
      const detach = (): void => {
        this.detachedFlag = true;
        this.holding = true;
        this.detachedWatch = true;
        this.publish('waiting', {
          percent: null,
          bytes: null,
          message: DETACHED_MESSAGE,
          code: null,
          report: null,
        });
        this.hooks.log('安装：不再等待（安装器继续跑，不做结论，互斥位仍然持有）');
        finish({ kind: 'detached' });
      };
      timer = setTimeout(() => {
        if (onTimeout === 'stop-waiting') {
          // 把结论留给调用方（它要先复检事实）；这里**不**改锁、**不**发任何结论
          this.hooks.log('等待上限到了（stop-waiting）：交回调用方做事实复检');
          finish({ kind: 'timeout' });
          return;
        }
        detach();
      }, timeoutMs);
      timer.unref?.();
      this.releaseWait = detach;
      child.on('error', (error: Error) => {
        this.child = null;
        if (this.detachedWatch) {
          // 已经不再等待了：错误不当结论，但要收尾（后台复检，见 finishDetached）
          this.detachedWatch = false;
          void this.finishDetached(null);
          return;
        }
        finish({ kind: 'error', error: error.message });
      });
      child.on('close', (code: number | null) => {
        this.child = null;
        if (this.detachedWatch) {
          // 冻结文档 R-06 的第 ① 条：不再等待之后安装器**真的结束了**，
          // 那就用复检事实决定锁还在不在（装成了就解锁并给结论；没装成继续保持未确定）
          this.detachedWatch = false;
          void this.finishDetached(code);
          return;
        }
        finish({ kind: 'exit', code });
      });
    });
  }

  /**
   * 「不再等待」之后安装器终于退出：**用复检事实说话**（R-06 第 ① 条）。
   *
   * - 复检证明这一步已经不再缺 → 解开互斥位、把结论从"未确定"改成事实；
   * - 复检仍然说缺 → **保持"未确定"与互斥位**（界面照旧给「重新检测」与「我确认安装已经结束」，
   *   后者的第二条路是 `stop()` 再点一次，第三条是应用重启）。
   */
  private async finishDetached(code: number | null): Promise<void> {
    if (!this.holding || this.detachedSettling) return;
    this.detachedSettling = true;
    try {
      this.lastCode = code;
      this.refreshProcessPathFromSystem();
      // VM 实测补的一步：我们"不再等待"的那一次如果是**版本管理器的安装程序**
      // （用户在它自己的窗口里点了很久才点完），它退出之后要把 nvm 的两步补完 ——
      // 不补的话就会停在"版本管理器装好、但没有 active Node"，下一步 npm 必然报
      // `No active Node.js version is configured…`。
      if (this.detachedNvmResume) {
        this.detachedNvmResume = false;
        const plan = this.activePlan;
        if (plan && plan.method === 'nvm') {
          this.hooks.log(
            '不再等待之后版本管理器的安装程序退出了：接着把它装 Node、切版本这两步补完',
          );
          const resumed = await this.installNodeWithNvm(plan);
          if (resumed.kind === 'failed') {
            this.holding = false;
            this.detachedFlag = false;
            this.discardTempDir();
            this.publish('error', {
              message: visibleFailureText(resumed.reason),
              detached: false,
              report: null,
            });
            return;
          }
          if (resumed.kind === 'detached') {
            // 补做的过程里用户又点了「不再等待」：保持未确定，等他确认或重启
            this.publish('waiting', { message: DETACHED_MESSAGE, detached: true });
            return;
          }
        }
      }
      this.publish('rechecking', { message: '正在重新检测', detached: true });
      const report = await this.safeRecheck();
      if (!report) {
        this.publish('waiting', { message: DETACHED_MESSAGE, detached: true });
        return;
      }
      if (this.nodeMissing(report)) {
        this.hooks.log(
          `不再等待之后安装器退出了（退出码 ${code ?? '未知'}），但复检仍然说这一步缺东西：保持"未确定"`,
        );
        this.publish('waiting', { message: DETACHED_MESSAGE, detached: true, report });
        return;
      }
      this.holding = false;
      this.detachedFlag = false;
      this.hooks.log(
        `不再等待之后安装器退出了（退出码 ${code ?? '未知'}），复检证明已经落地：解锁`,
      );
      this.discardTempDir();
      this.publish('done', {
        message: '安装结束了：复检显示 Node 这一项已经正常。',
        detached: false,
        report,
        observedVersion: this.probeInstalledNode()?.version ?? null,
      });
    } finally {
      this.detachedSettling = false;
    }
  }

  /**
   * 装完之后重读系统里的环境，把它并进**本进程**的查找路径（冻结文档 §4.2）：
   * nvm 把 Node 放在自己的目录里、并且写在用户级的查找路径里，不重读的话复检永远认不出来，
   * 用户就得重开应用。**只读系统里已有的，不写系统里的任何东西**；其它已经打开的终端窗口
   * 我们管不了，所以界面上照旧提示"重开一次"。
   */
  private refreshProcessPathFromSystem(): void {
    const snapshot = readRegistryEnvironment();
    if (!snapshot) return;
    const merged = mergePathFromRegistry(snapshot.machinePath, snapshot.userPath);
    if (merged) {
      // 注册表里那一段排在前面（它才是系统现在的真相），我们已知的 bin 目录接在后面
      const key = Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
      process.env[key] = mergePathFromRegistry(merged, pathWithKnownBins(''));
    }
    // 版本管理器写的是**两个**变量（NVM_HOME / NVM_SYMLINK），只补 PATH 不够：
    // `nvm use` 建符号链接的位置来自 NVM_SYMLINK，子进程读不到它就会去用别的默认位置。
    const injected: string[] = [];
    for (const name of INJECTED_ENV_NAMES) {
      const value = findValue(snapshot.vars, name);
      if (value) {
        process.env[name] = value;
        injected.push(`${name}=${value}`);
      }
    }
    if (injected.length > 0) this.hooks.log(`已重读系统环境并注入本进程：${injected.join('；')}`);
  }

  /**
   * 提权探测只做一次，而且**异步**（F-03）：`whoami /groups` 走异步 spawn，不阻塞事件循环 ——
   * 它会被 `plan()` 调用（用户在确认区切选项时就触发），同步 15 秒的探测会把界面卡住。
   * 结果缓存，一次进程只探一次（替代不了真机验证，见交付说明）。
   */
  private async isElevated(): Promise<boolean> {
    if (this.elevated === null) {
      const probe = await runProbeAsync(system32('whoami.exe'), ['/groups'], PROBE_TIMEOUT_MS);
      this.elevated = probe.error === null && isElevatedProbeOutput(probe.stdout, probe.code);
    }
    return this.elevated;
  }

  private readSignature(file: string): SignatureInfo | null {
    const script = [
      `$s = Get-AuthenticodeSignature -LiteralPath ${psQuote(file)}`,
      `[pscustomobject]@{ Status = [string]$s.Status; Subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress`,
    ].join('; ');
    const shell = this.powerShell();
    if (!shell) return null;
    const probe = runProbe(shell, ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (probe.error || !probe.stdout.trim()) return null;
    try {
      const parsed: unknown = JSON.parse(probe.stdout.trim().split(/\r?\n/).pop() ?? '');
      if (!parsed || typeof parsed !== 'object') return null;
      const record: Record<string, unknown> = { ...parsed };
      const status = typeof record.Status === 'string' ? record.Status : '';
      const subject = typeof record.Subject === 'string' && record.Subject ? record.Subject : null;
      if (!status) return null;
      return { status, subject };
    } catch {
      return null;
    }
  }

  private powerShell(): string | null {
    const fromPath = whichSync('powershell.exe');
    if (fromPath) return fromPath;
    const fallback = system32('WindowsPowerShell\\v1.0\\powershell.exe');
    if (fs.existsSync(fallback)) return fallback;
    return whichSync('pwsh');
  }

  private probeNodePath(): string | null {
    return whichSync('node') ?? findNodeExe();
  }

  /** 版本管理器自己的命令：查找路径 → 它自己写的目录 → 安装程序的默认目录 */
  private findNvmExe(): string | null {
    const fromPath = whichSync('nvm');
    if (fromPath) return fromPath;
    const home = envValue(process.env, 'NVM_HOME');
    if (home) {
      const candidate = path.win32.join(home, 'nvm.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
    const appData = envValue(process.env, 'APPDATA');
    if (appData) {
      const candidate = path.win32.join(appData, 'nvm', 'nvm.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
    const symlink = envValue(process.env, 'NVM_SYMLINK');
    if (symlink) {
      const candidate = path.win32.join(path.win32.dirname(symlink), 'nvm', 'nvm.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** 一次简单的文本取回（版本清单 / 校验清单 / 发布信息）：不落盘、有超时 */
  private async fetchText(url: string): Promise<string | null> {
    return new Promise((resolve) => {
      // 注入口优先（独立反例要真调 plan()，见 `NodeInstallHooks.fetchText`）
      const injected = this.hooks.fetchText;
      if (injected) {
        Promise.resolve(injected(url)).then(
          (text) => resolve(typeof text === 'string' ? text : null),
          () => resolve(null),
        );
        return;
      }
      const net = electronNet();
      if (!net) {
        resolve(null);
        return;
      }
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let request: NetRequest | null = null;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      try {
        request = net.request({ method: 'GET', url, redirect: 'follow' });
      } catch {
        finish(null);
        return;
      }
      timer = setTimeout(() => {
        try {
          request?.abort();
        } catch {
          // 已经结束
        }
        finish(null);
      }, PROBE_TIMEOUT_MS);
      timer.unref?.();
      request.on('error', () => finish(null));
      request.on('response', (response: NetResponse) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          finish(null);
          return;
        }
        const parts: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          parts.push(Buffer.from(chunk));
        });
        response.on('end', () => finish(Buffer.concat(parts).toString('utf8')));
        response.on('error', () => finish(null));
      });
      request.end();
    });
  }

  /** 文件名：直装是 Node 的安装包，版本管理器那条路是它的安装包 */
  private fileNameOf(plan: EnvNodePlan): string {
    if (plan.method === 'nvm') {
      const fromUrl = plan.url.split('/').pop() ?? 'nvm-setup.exe';
      return fromUrl.split('?')[0] || 'nvm-setup.exe';
    }
    return nodeInstallerFileName(plan.version, process.arch);
  }

  /** 取消下载（Electron 请求的 abort + 让等待放手） */
  private abortTransfer(): void {
    this.downloadAbort?.();
    this.releaseTransfer?.();
  }

  /** 临时目录里的残留：只清"上一轮留下的"（超过一天的），正在被安装器使用的那个不动 */
  private cleanStaleTemp(dir: string): void {
    try {
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        try {
          const stat = fs.statSync(file);
          if (Date.now() - stat.mtimeMs > STALE_TEMP_MS) this.removeQuietly(file);
        } catch {
          // 读不到就跳过
        }
      }
    } catch {
      // 目录还没有（第一次下载）就算正常
    }
  }

  private discardTempDir(): void {
    for (const file of [...this.tempFiles]) this.removeQuietly(file);
    this.tempFiles.clear();
  }

  /** 本次下载 / 校验落过盘的东西（取消 / 失败 / 退出时按这个清单删） */
  private removeQuietly(file: string): void {
    try {
      fs.rmSync(file, { force: true });
      this.tempFiles.delete(file);
    } catch {
      // 还被安装器占着（Windows 上删不掉正在使用的文件）：留给下一轮的残留清理
      this.tempFiles.add(file);
    }
  }
}

// ---------------------------------------------------------------- 注册表与环境（IO 层）

export {
  assetSha256,
  compareNodeVersions,
  expandEnvReferences,
  nodeInstallerFileName,
  nodeInstallerUrl,
  parseNodeReleaseIndex,
  parseReleaseSigning,
  parseShasums,
  pickNodeRelease,
  pickNvmSetupAsset,
} from './node-release';
export {
  detectNodeOwner,
  isElevatedProbeOutput,
  mergePathFromRegistry,
  normalizeNodeSource,
} from './node-owner';
export { classifyInstallFailure } from './node-failure';
export { detectInstallerFlavor, installerSilentArgs } from './node-flavor';
export {
  deriveNvmModel,
  deriveNvmModelFromEnvironment,
  isInactiveNodeShimOutput,
  locateNvmExe,
  looksLikeNvmRoot,
  nvmPreferenceKey,
  parseNvmEnvOutput,
  parseNvmInstallOutput,
  parseNvmListOutput,
  parseNvmRegistryPreferences,
  parseNvmUseOutput,
} from './node-nvm';
export {
  NODE_COEXIST_WARNING,
  classifyElevationOutcome,
  decideNodePlan,
  elevationFailure,
  hasNodeVersionOutput,
  isDeveloperModeEnabled,
  nodeChannelOfVersion,
  nodePlanDirection,
  nodePlanFacts,
} from './node-plan';
export { readNodeMsiInstallPath } from './node-io';

export type { NodeReleaseEntry, ReleaseAsset } from './node-release';
export type { InstallFailureKind, InstallFailureReason } from './node-failure';
export type { InstallerFlavor } from './node-flavor';
export type { NvmEnvReport, NvmListOutput, NvmModel, NvmRegistryPreferences } from './node-nvm';
export type {
  ElevationOutcome,
  ElevationProbe,
  NodePlanDecision,
  NodePlanFacts,
} from './node-plan';
