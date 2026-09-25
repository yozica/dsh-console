/**
 * 门禁判定：三步表 + `collectBootProbe` + `judgeWizard`
 *
 * t51 从 `env-doctor.ts` 拆出来的；那个文件现在只做 barrel + 两个有状态的类（`EnvDoctor` /
 * `EnvFixRunner`），别的模块与两个反例脚本的 import 路径都不用改。
 */
import type {
  EnvCheck,
  EnvCheckId,
  EnvCheckStatus,
  EnvDoctorReport,
  EnvFixAction,
  EnvFixPlan,
  EnvGateState,
  EnvNodeOwner,
  EnvStepStatus,
  EnvWizardState,
  EnvWizardStep,
  EnvWizardStepId,
} from '../shared/ipc';
import {
  deriveNvmModelFromEnvironment,
  detectNodeOwner,
  readNodeMsiInstallPath,
} from './node-installer';
import type { SettingsValues } from './settings';
import { looksVersionManagerNode } from './env-judge';
import type { EnvProbeRaw, EnvRuntime } from './env-probe-types';
import { emptyProbe, findNodePath, findNpm, findPnpmPath, messageOf } from './env-probe';
import fs from 'node:fs';
import { hasVcRuntime, resolveShell } from './process-utils';

/** 三个引导步骤：数组顺序 = 界面顺序 = 用户要走的顺序（需求 §4.2） */
export const WIZARD_STEP_IDS: EnvWizardStepId[] = ['node', 'pnpm', 'dsh'];

/**
 * 每个步骤读哪几项既有自检（**只分组，不新增探测项**）。
 * 这里的项只用来"解释原因"与界面上的「展开看详情」，判据本身见 `WIZARD_STEP_JUDGE`。
 */
export const WIZARD_STEP_CHECK_IDS: Record<EnvWizardStepId, EnvCheckId[]> = {
  node: ['node', 'node-version', 'npm'],
  pnpm: ['pnpm'],
  dsh: ['dsh', 'dsh-run'],
};

/**
 * 能不能跳过。`node` 与 `dsh` 恒为 false —— 缺了它们 dsh 根本起不来，
 * "跳过"只会把用户送进一个用不了的主界面；`pnpm` 只有插件页受影响，允许跳。
 * 不可跳过的 id 写进设置也会被判定忽略（反绕过，见需求 §4.3）。
 */
export const WIZARD_STEP_SKIPPABLE: Record<EnvWizardStepId, boolean> = {
  node: false,
  pnpm: true,
  dsh: false,
};

/** 步骤能用哪个既有 npm 动作替用户做（`node` 恒为 null：它走安装通道 `envNodeInstall`） */
export const WIZARD_STEP_FIX_ACTION: Record<EnvWizardStepId, EnvFixAction | null> = {
  node: null,
  pnpm: 'install-pnpm',
  dsh: 'install-dsh',
};

/** 步骤名字（人话，用在 `gateReason` 这类主进程现拼的句子里） */
export const WIZARD_STEP_LABEL: Record<EnvWizardStepId, string> = {
  node: 'Node',
  pnpm: 'pnpm',
  dsh: 'dsh',
};

type CheckStatusLookup = (id: EnvCheckId) => EnvCheckStatus;

/** 三步各自的判据（冻结 §2.2 的表；`node` 那条按 VM-03 收严，理由见 `judgeWizard` 的注释） */
export const WIZARD_STEP_JUDGE: Record<EnvWizardStepId, (statusOf: CheckStatusLookup) => boolean> =
  {
    // **真的能跑才算完成**：找到文件还不够 —— `node --version` 出不来结果就是"还没准备好"
    node: (statusOf) => statusOf('node') !== 'missing' && statusOf('node-version') !== 'missing',
    pnpm: (statusOf) => statusOf('pnpm') !== 'missing',
    dsh: (statusOf) => statusOf('dsh') !== 'missing' && statusOf('dsh-run') !== 'missing',
  };

/** 三档状态的"严重程度"：缺东西 > 测不出来 > 正常（挑那一行的事实给界面看时用） */
const CHECK_SEVERITY: Record<EnvCheckStatus, number> = { missing: 3, warn: 2, ok: 1 };

/**
 * 读一个字段：**只接受对象**，其余（`null` / `undefined` / 字符串 / 数字）一律读成 `undefined`。
 *
 * 判定函数的入参从线缆与磁盘来（用户手改得动 `settings.json`，老界面也可能递来别的形状），
 * 所以读字段这一步本身就不能抛。`judgeWizard` 的「任何输入都不抛」从这里起步。
 */
function fieldOf(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') return undefined;
  return (source as Record<string, unknown>)[key];
}

/** 只接受数组；不是数组（`null` / `undefined` / 字符串 / 数字）一律当空数组，绝不抛 */
export function arrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * 归属事实（需求 §7.7 / 冻结 §3.2.1）：把「真实路径 + 环境变量 + §7.6 的模型 + 注册表里的安装目录」
 * 凑齐，然后交给**唯一的那份判据** `detectNodeOwner`（安装引擎里的纯函数）。
 *
 * 这里**只凑事实、不做判断**（判定必须是纯函数，才能被离线夹具钉住）：
 *   - `withRegistry` = 完整探测（已经要起子进程了，多读一个注册表键没有代价）；
 *   - 快速探测传 false —— 启动瞬间那一次**不起子进程**（R-14），
 *     而读 `HKLM\SOFTWARE\Node.js` 要起 `reg.exe`。那条正面证据只是加分项，缺了不影响结论。
 */
export function nodeOwnershipFacts(
  nodePath: string | null,
  withRegistry: boolean,
): { owner: EnvNodeOwner; evidence: string[] } {
  const model = deriveNvmModelFromEnvironment(process.env);
  return detectNodeOwner({
    nodePath,
    env: process.env,
    model,
    msiInstallPath: withRegistry ? readNodeMsiInstallPath() : null,
  });
}

/** 一组自检里最值得先看的那一行（同级按传入顺序；空数组给 null，不抛） */
function worstRow(rows: EnvCheck[]): EnvCheck | null {
  let best: EnvCheck | null = null;
  for (const row of rows) {
    if (!best || CHECK_SEVERITY[row.status] > CHECK_SEVERITY[best.status]) best = row;
  }
  return best;
}

/**
 * 启动瞬间的**快速探测**（需求 R-14）：只读文件系统，**不起任何子进程**。
 *
 * 为什么需要它：完整探测（`collectEnvProbe`）要起 `node --version` / `npm -v` / `pnpm -v` /
 * `dsh --version` 四次子进程（各 8 秒超时），在健康机器上为了"决定要不要自动拉起 dsh"
 * 多等几百毫秒到几秒是不值的。而"纯净机器"的判据（找不到 node）本来就是**文件系统事实**。
 *
 * 所以这里只查 node / npm / pnpm 三个**路径**（复用既有的三个查找函数，不另写一套 PATH 解析），
 * 把"必须起子进程才知道的项"标成 `skipped`：判定一律给 `warn`（= 这一轮没测），不是 `missing`。
 * 判定仍然走**同一个** `judgeEnvironment` + `judgeWizard` —— 判据只有一处。
 *
 * 任何意外都不抛：照 `emptyProbe` 的做法给一份"事实为空 + error 带原因"的原始事实
 * （于是判定给 `unknown`，不挡人）。1.5 秒后的完整探测照旧跑，那才是门禁层与自检页的结论来源。
 */
export function collectBootProbe(settings: SettingsValues, runtime: EnvRuntime): EnvProbeRaw {
  try {
    const nodePath = findNodePath();
    const npmPath = findNpm();
    const pnpmPath = findPnpmPath();

    // 本地 Shell 也是"只读文件系统"就能确定的（resolveShell 只查 PATH 与几个固定路径）
    let shellFile: string | null = null;
    let shellExists = false;
    let error: string | null = null;
    try {
      const spec = resolveShell(settings);
      shellFile = spec.file || null;
      shellExists = Boolean(shellFile && fs.existsSync(shellFile));
    } catch (err) {
      error = `快速探测解析本地 Shell 失败：${messageOf(err)}`;
    }
    // 归属同样只读文件系统与环境（**不读注册表：那要起 reg.exe**，见 nodeOwnershipFacts）
    const ownership = nodeOwnershipFacts(nodePath, false);

    return {
      checkedAt: Date.now(),
      platform: runtime.platform,
      packaged: runtime.packaged,
      bundled: runtime.bundled,
      node: { path: nodePath, version: null, exitCode: null, error: null, skipped: true },
      npm: { path: npmPath, version: null, exitCode: null, error: null, skipped: true },
      pnpm: { path: pnpmPath, version: null, exitCode: null, error: null, skipped: true },
      // dsh 的定位要先解析启动命令（node-bin 那条路会实测），快速探测整项不测
      dsh: {
        kind: null,
        display: null,
        runs: false,
        version: null,
        exitCode: null,
        error: null,
        resolveError: null,
        skipped: true,
      },
      shell: { file: shellFile, exists: shellExists },
      // 快速探测也顺带认一下：这条判据只看两个文件在不在，不必等 1.5 秒后的完整探测
      vcRuntime: hasVcRuntime(),
      // 同理：只看路径形状，不起子进程
      nodeFromVersionManager: looksVersionManagerNode(nodePath),
      nodeOwner: ownership.owner,
      nodeOwnerEvidence: ownership.evidence,
      error,
    };
  } catch (err) {
    return emptyProbe(runtime, `快速探测没能完成：${messageOf(err)}`);
  }
}

/**
 * 门禁判定（设计冻结 §2.2）：把一份既有报告判成"三步各是什么状态、门禁开不开、当前该处理哪一步"。
 *
 * **纯函数**：只读入参（不碰磁盘、不起子进程、不读 `process.*`、不看时钟），任何输入都不抛。
 * 界面**不自己判**——两套判据就是两套口径，"环境 OK"必须只有一个答案。
 *
 * 三步的判据（`WIZARD_STEP_JUDGE`）：
 *   - `node`：`node` 与 `node-version` 都不是 `missing` —— **真的能跑才算完成**。
 *     VM 实测（VM-03）踩到的正是这里：`node.exe` 在（版本管理器的 shim），但 `node --version`
 *     出不来结果，旧判据（只看文件在不在）于是把第一步判成「已完成」，而下一步的 npm 立刻报
 *     "No active Node.js version is configured" —— 界面说的和机器能做的是两件事。
 *     现在只有"这个运行环境不允许起子进程"（EPERM 一类）才留黄灯、不挡人。
 *   - `pnpm`：`pnpm` 那一项不是 `missing`
 *   - `dsh` ：`dsh` 与 `dsh-run` 都不是 `missing`（定位得到 + 实测跑得动）
 *
 * 判据不满足时按三条决定状态（顺序即优先级）：
 *   1. 用户跳过过它、且它可跳过 → `skipped`
 *   2. `checkIds` 里至少一项 `missing` → `todo`（**有证据的缺失**，门禁挡住人的唯一理由）
 *   3. 否则 → `unknown`（只有 `warn`，也就是这一轮测不出来；需求 §4.3：不挡人）
 *
 * `report.error !== null` 时：**没有 `missing` 证据的步骤一律记 `unknown`**（不宣称"这一步好了"），
 * 有 `missing` 证据的步骤仍是 `todo`（有证据就挡）。用户的显式跳过（`skipped`）不因此改变 ——
 * 那是他的选择，与"我们测不出来"是两回事。
 *
 * **入参形状不可信**：`skips` 来自用户手改得动的 `settings.json`（`"envSkips": null` 是真实可达到的），
 * `checks` / `plans` 来自报告。所以一进门就用 `fieldOf` / `arrayOf` 归一化一次，
 * 后面**只读归一化后的值** —— 冻结 §2.1 的「任何输入都不抛」靠"每个字段各自打补丁"守不住。
 */
export function judgeWizard(report: EnvDoctorReport, skips: EnvWizardStepId[]): EnvWizardState {
  const requestedSkips: EnvWizardStepId[] = arrayOf<EnvWizardStepId>(skips);
  const acceptedSkips: EnvWizardStepId[] = [];
  for (const id of WIZARD_STEP_IDS) {
    if (!WIZARD_STEP_SKIPPABLE[id]) continue; // 不可跳过的 id 被忽略（不是报错、也不是生效）
    if (!acceptedSkips.includes(id) && requestedSkips.includes(id)) acceptedSkips.push(id);
  }

  const checks: EnvCheck[] = arrayOf<EnvCheck>(fieldOf(report, 'checks'));
  const plans: EnvFixPlan[] = arrayOf<EnvFixPlan>(fieldOf(report, 'plans'));
  const reportError = fieldOf(report, 'error');
  // 只有"明确写了 null"才算"这一轮没有错误"；字段缺失（畸形输入）按"没测全"处理：
  // 宁可给 `unknown`（不挡人），也不对着一份来路不明的报告宣称"环境 OK"。
  const failed = reportError !== null && reportError !== undefined;

  const rowOf = (id: EnvCheckId): EnvCheck | null => {
    for (const row of checks) if (row && row.id === id) return row;
    return null;
  };
  // 拿不到那一行 = 没有证据（当"测不出来"，绝不当"缺东西"）
  const statusOf = (id: EnvCheckId): EnvCheckStatus => rowOf(id)?.status ?? 'warn';

  const steps: EnvWizardStep[] = [];
  for (const id of WIZARD_STEP_IDS) {
    const checkIds = WIZARD_STEP_CHECK_IDS[id];
    const rows: EnvCheck[] = [];
    for (const checkId of checkIds) {
      const row = rowOf(checkId);
      if (row) rows.push(row);
    }

    let status: EnvStepStatus;
    if (WIZARD_STEP_JUDGE[id](statusOf)) status = 'done';
    else if (WIZARD_STEP_SKIPPABLE[id] && acceptedSkips.includes(id)) status = 'skipped';
    else if (checkIds.some((checkId) => statusOf(checkId) === 'missing')) status = 'todo';
    else status = 'unknown';

    // error 非空 = 这一轮没测全：没有 missing 证据的步骤不宣称"好了"，但也不挡人
    if (status === 'done' && failed) status = 'unknown';

    let detail: string;
    if (status === 'done') {
      detail = worstRow(rows.filter((row) => row.status === 'ok'))?.detail ?? '这一步已经就绪';
    } else if (status === 'skipped') {
      detail = `已经按你的选择跳过这一步：${worstRow(rows)?.detail ?? '（这一项没有拿到可判断的信息）'}`;
    } else {
      // todo / unknown：把最重的那一行的事实原样给出来（界面直接显示，不重新拼）
      detail = worstRow(rows)?.detail ?? '（这一项没有拿到可判断的信息）';
    }

    const planned = WIZARD_STEP_FIX_ACTION[id];
    const fixAction: EnvFixAction | null =
      planned !== null && plans.some((plan) => plan && plan.action === planned) ? planned : null;

    steps.push({
      id,
      status,
      detail,
      checkIds: [...checkIds],
      skippable: WIZARD_STEP_SKIPPABLE[id],
      fixAction,
    });
  }

  const todos = steps.filter((step) => step.status === 'todo');
  const unknowns = steps.filter((step) => step.status === 'unknown');
  const gate: EnvGateState =
    todos.length > 0 ? 'blocked' : unknowns.length > 0 ? 'unknown' : 'open';
  const currentStepId: EnvWizardStepId | null = todos[0]?.id ?? unknowns[0]?.id ?? null;
  const labels = (list: EnvWizardStep[]) =>
    list.map((step) => WIZARD_STEP_LABEL[step.id]).join('、');
  const gateReason: string | null =
    gate === 'blocked'
      ? `还缺 ${labels(todos)} —— 装好它们才能进入主界面`
      : gate === 'unknown'
        ? `${labels(unknowns)} 这一轮没测出来（不是缺东西）：可以重新检测，也可以直接进入主界面`
        : null;

  return { report, steps, gate, currentStepId, gateReason, skips: acceptedSkips };
}
