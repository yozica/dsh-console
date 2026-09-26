'use strict';

/**
 * 自检第 17 组与 18/18a：首启环境向导（门禁）与门禁界面。
 *
 * 冻结文档 §3.8 里归"契约与编排"的那些断言。判定是纯函数，所以全部是夹具 + 静态文本检查：
 * 不装 Node、不起任何进程、不碰网络。
 *
 * 整段从 `test/selftest.ts` 的 `main()` 里搬出来，行为一字未改 —— 搬完的证据是自检输出
 * 逐行一致（314 条同名、同值、同顺序）；夹具与源码文本由 `test/env-fixtures.ts` 提供。
 */

import fs from 'node:fs';
import path from 'node:path';

import * as envDoctor from '../../src/main/env-doctor';
import * as wizardView from '../../src/renderer/gate/wizard-view.js';
import type {
  EnvCheckId,
  EnvCheckStatus,
  EnvDoctorReport,
  EnvStepStatus,
  EnvWizardState,
  EnvWizardStep,
  EnvWizardStepId,
} from '../../src/shared/ipc';

import { createEnvFixtures } from '../env-fixtures';
import { check } from '../harness';
import type { Repo } from '../repo';
import { blockOf, functionBodyOf, stripComments, stripStrings } from '../text';

export function runEnvWizard(repo: Repo): void {
  const f = createEnvFixtures(repo);
  const {
    envSource,
    envCode,
    envJudgeBody,
    envMainCode,
    envPaneCode,
    installerCode,
    gateRaw,
    gateCode,
    envVersionProbe,
    envDshProbe,
    envProbe,
    envCheckOf,
    envAllOk,
    envIds,
    envWizardStepIds,
    envNoNodeReport,
  } = f;
  const repoRoot = repo.root;
  const srcDir = repo.srcDir;
  const settings = repo.settings;
  const rendererCode = repo.rendererCode;
  const mountJs = repo.mountJs;
  const html = repo.html;
  const rendererDir = repo.rendererDir;
  const ipcSource = repo.ipcSource;
  const flatIpc = repo.flatIpc;
  // ---------------------------------------------------------- 17. 首启环境向导（门禁）
  //    冻结文档 §3.8 里归"契约与编排"的那些断言。判定是纯函数，所以全部是夹具 + 静态文本检查：
  //    不装 Node、不起任何进程、不碰网络。
  const wizardSource = stripComments(fs.readFileSync(repo.tsPath('env-wizard.ts'), 'utf8'));
  const bootLockSource = stripComments(fs.readFileSync(repo.tsPath('boot-lock.ts'), 'utf8'));
  const preloadCode = stripComments(
    fs.readFileSync(path.join(srcDir, 'preload', 'preload.ts'), 'utf8'),
  );
  const appTsCode = stripComments(fs.readFileSync(path.join(rendererDir, 'app.ts'), 'utf8'));

  // ---------------------------------------------------------- 17b. VM-07 的渲染层半边（t31）
  //    修完（复检报告随 `env:fix-state` 落进 `envFix`）之后，**门禁的步骤状态**是另一条读法
  //    （`env:wizard`）。少了这一步，用户装完 pnpm 之后第二步仍然停在「待办」上，只能重开应用。
  check(
    '环境自检（VM-07）：复检报告一到，渲染层就重拉一次门禁结论（不必重开应用）',
    // 盯的是共享状态 `envFix`（由 state/env-doctor.ts 那一个订阅者写），而不是自己再订一次 IPC
    /watch\(envFix, \(state\) => \{[\s\S]{0,200}?if \(!state\.report\) return;[\s\S]{0,120}?void loadWizard\(\);/.test(
      wizardSource,
    ) &&
      /function watchFixReports\(\): void \{/.test(wizardSource) &&
      // 并且真的在接线时调用了它（幂等位里）
      /wired = true;[\s\S]{0,400}?watchFixReports\(\);/.test(wizardSource) &&
      // 只"再拉一次结论"：不 refresh（主进程缓存刚被复检刷新过）、不加启动锁、不改判定
      !/watch\(envFix,[\s\S]{0,200}?refresh: true/.test(wizardSource),
  );

  /**
   * 手写一份报告：门禁判定只看 `checks` 的 id / status、`plans` 与 `error`，
   * 其余字段按 §3 的形状补占位值。用它才能摆出"某一项是 warn"这类
   * `judgeEnvironment` 在当前实现里不会产出的组合（受限环境下 warn 行是存在的）。
   */
  const wizardReport = (
    statuses: Partial<Record<EnvCheckId, EnvCheckStatus>>,
    over: Partial<EnvDoctorReport> = {},
  ): EnvDoctorReport => ({
    checkedAt: 0,
    checks: envIds.map((id) => ({
      id,
      status: statuses[id] ?? 'ok',
      detail: `${id}：这一轮的事实`,
      fixHint: null,
      fixAction: null,
    })),
    counts: { ok: 8, warn: 0, missing: 0 },
    firstProblemId: null,
    nodeRange: envDoctor.NODE_RANGE,
    plans: [],
    error: null,
    // t29：归属是**采集侧给的事实**（判定只搬运）。门禁判定不看它，所以这里是占位值
    nodeOwner: 'unknown',
    nodeOwnerEvidence: [],
    ...over,
  });
  const wizardSkips = (...ids: string[]): EnvWizardStepId[] =>
    ids.filter((id): id is EnvWizardStepId => envWizardStepIds.some((known) => known === id));

  // 契约增量：新联合的成员、7 个新 API、两个设置项、ipc.ts 仍然零 import
  check(
    '环境向导：契约增量都在（新联合成员 / 7 个 API / 两个设置项 / 契约零运行时 import）',
    (() => {
      const wizardApiNames = [
        'envWizard',
        'envWizardSkip',
        'envNodePlan',
        'envNodeInstall',
        'envNodeStop',
        'onEnvInstallState',
        'onEnvInstallOutput',
      ];
      const installPhaseUnion = /export type EnvInstallPhase =([\s\S]*?);/.exec(flatIpc)?.[1] ?? '';
      const stepUnion = /export type EnvWizardStepId =([\s\S]*?);/.exec(flatIpc)?.[1] ?? '';
      const statusUnion = /export type EnvStepStatus =([\s\S]*?);/.exec(flatIpc)?.[1] ?? '';
      const gateUnion = /export type EnvGateState =([\s\S]*?);/.exec(flatIpc)?.[1] ?? '';
      /** 数联合类型的成员：按引号里的名字数，别按 `|` 切（多行写法会让分隔符本身也被数进去） */
      const membersOf = (union: string): string[] =>
        [...union.matchAll(/'([^']+)'/g)].map((match) => match[1]);
      return (
        // 契约零**运行时** import：只放类型与纯常量（t55 起叶子之间允许 `import type`；
        // 渲染层要读这些类型，值 import 会把 fs/path 卷进包里）
        !/^\s*import\s+(?!type\b)/m.test(ipcSource) &&
        membersOf(stepUnion).length === 3 &&
        ['node', 'pnpm', 'dsh'].every((id) => stepUnion.includes(`'${id}'`)) &&
        membersOf(statusUnion).length === 4 &&
        ['done', 'todo', 'skipped', 'unknown'].every((s) => statusUnion.includes(`'${s}'`)) &&
        membersOf(gateUnion).length === 3 &&
        ['open', 'blocked', 'unknown'].every((s) => gateUnion.includes(`'${s}'`)) &&
        // 10 个安装相位：三个终态（done / cancelled / error）必须在
        membersOf(installPhaseUnion).length === 10 &&
        [
          'idle',
          'preparing',
          'downloading',
          'verifying',
          'installing',
          'waiting',
          'rechecking',
        ].every((phase) => installPhaseUnion.includes(`'${phase}'`)) &&
        ['done', 'cancelled', 'error'].every((phase) => installPhaseUnion.includes(`'${phase}'`)) &&
        /export interface EnvWizardState \{/.test(ipcSource) &&
        /currentStepId: EnvWizardStepId \| null;/.test(ipcSource) &&
        /gateReason: string \| null;/.test(ipcSource) &&
        /fixAction: EnvFixAction \| null;/.test(ipcSource) &&
        /export interface EnvInstallState \{/.test(ipcSource) &&
        /detached: boolean;/.test(ipcSource) &&
        /cancellable: boolean;/.test(ipcSource) &&
        /envSkips: EnvWizardStepId\[\];/.test(ipcSource) &&
        /envNodeSource: string;/.test(ipcSource) &&
        // 签名自述（冻结 §3.2 的逐字块）：它是**发布元数据**的说法，用具名类型与 `signer` 分开。
        // `signer === null` 只表示"还没读"，不许当成"未签名"；计划阶段的那次确认只认 'unsigned'。
        /export type EnvReleaseSigning = 'signed' \| 'unsigned' \| 'unknown';/.test(ipcSource) &&
        (() => {
          const planBody =
            /\nexport interface EnvNodePlan \{([\s\S]*?)\n\}/.exec(ipcSource)?.[1] ?? '';
          return (
            /releaseSigning: EnvReleaseSigning;/.test(planBody) &&
            /signer: string \| null;/.test(planBody) &&
            !/signer: string;/.test(planBody)
          );
        })() &&
        wizardApiNames.every((name) => new RegExp(`\\n\\s{2}${name}:`).test(ipcSource)) &&
        // EnvFixAction 仍是两个成员（Node 不走它，见冻结 §3.5）
        (() => {
          const actionUnion = /export type EnvFixAction =([\s\S]*?);/.exec(flatIpc)?.[1] ?? '';
          return (
            membersOf(actionUnion).length === 2 &&
            actionUnion.includes("'install-pnpm'") &&
            actionUnion.includes("'install-dsh'")
          );
        })()
      );
    })(),
  );

  const wizardHealthy = envDoctor.judgeWizard(envAllOk, []);
  const wizardNoNode = envDoctor.judgeWizard(envNoNodeReport, []);
  const wizardStepOf = (state: EnvWizardState, id: EnvWizardStepId) =>
    state.steps.find((step) => step.id === id) ?? {
      id,
      status: 'unknown' as const,
      detail: '',
      checkIds: [],
      skippable: false,
      fixAction: null,
    };
  check(
    '环境向导：八项全好时直接放行（open、无当前步骤、无理由、三步都完成）',
    wizardHealthy.gate === 'open' &&
      wizardHealthy.currentStepId === null &&
      wizardHealthy.gateReason === null &&
      wizardHealthy.steps.length === 3 &&
      wizardHealthy.steps.every((step) => step.status === 'done') &&
      wizardHealthy.steps.every((step) => step.detail.length > 0 && step.checkIds.length > 0) &&
      wizardStepOf(wizardHealthy, 'node').fixAction === null &&
      wizardStepOf(wizardHealthy, 'pnpm').fixAction === 'install-pnpm' &&
      wizardStepOf(wizardHealthy, 'dsh').fixAction === 'install-dsh' &&
      wizardStepOf(wizardHealthy, 'node').skippable === false &&
      wizardStepOf(wizardHealthy, 'pnpm').skippable === true &&
      wizardStepOf(wizardHealthy, 'dsh').skippable === false &&
      wizardHealthy.report === envAllOk,
  );
  check(
    '环境向导：缺 Node 时挡住（blocked，当前步骤是 node，理由非空）',
    wizardNoNode.gate === 'blocked' &&
      wizardNoNode.currentStepId === 'node' &&
      Boolean(wizardNoNode.gateReason) &&
      wizardStepOf(wizardNoNode, 'node').status === 'todo' &&
      /Node/.test(String(wizardNoNode.gateReason)),
  );
  // 判据表（冻结 §2.2 第一步）：只有判据行是 missing 才算"缺东西"

  const wizardVersionWarn = envDoctor.judgeWizard(
    envDoctor.judgeEnvironment(envProbe({ node: envVersionProbe({ version: 'v20.9.0' }) })),
    [],
  );
  const wizardNpxDsh = envDoctor.judgeWizard(
    envDoctor.judgeEnvironment(envProbe({ dsh: envDshProbe({ kind: 'npx' }) })),
    [],
  );
  const wizardDeadDsh = envDoctor.judgeWizard(
    envDoctor.judgeEnvironment(
      envProbe({
        dsh: envDshProbe({ kind: 'node-bin', runs: false, version: null, exitCode: null }),
      }),
    ),
    [],
  );
  check(
    '环境向导：三步骤判据与 §2.2 一致（版本 warn / npx warn 都算完成；跑不动 dsh 才是待办）',
    // node-version 只是解释原因，不参与判据：它 warn 也照样算这一步完成
    wizardVersionWarn.gate === 'open' &&
      wizardStepOf(wizardVersionWarn, 'node').status === 'done' &&
      // dsh 走 npx 是 warn（能用但每次联网），实测跑得动 → 这一步完成
      wizardNpxDsh.gate === 'open' &&
      wizardStepOf(wizardNpxDsh, 'dsh').status === 'done' &&
      wizardStepOf(wizardNpxDsh, 'pnpm').status === 'done' &&
      // 定位得到但实测跑不动（退出码 0 + 零输出）→ 这一步是待办，门禁挡住
      wizardDeadDsh.gate === 'blocked' &&
      wizardStepOf(wizardDeadDsh, 'dsh').status === 'todo' &&
      wizardDeadDsh.currentStepId === 'dsh',
  );
  // warn 不当成缺失：没有 missing 证据时**不挡人**（需求 §4.3）。
  // 注意 §2.2 的判据是"那一项不是 missing 就算满足"，所以只有 warn 行时步骤可以是 done；
  // 冻结 §3.8 第 4 条"三步骤全 warn → 三步 unknown"只在报告整体出错（error 非空）时成立，
  // 见下一条（文档这两处在字面上互相矛盾，实现以 §2.2 的判据表为准）。
  const wizardAllWarn = wizardReport({
    node: 'warn',
    'node-version': 'warn',
    npm: 'warn',
    pnpm: 'warn',
    dsh: 'warn',
    'dsh-run': 'warn',
  });
  const wizardAllWarnState = envDoctor.judgeWizard(wizardAllWarn, []);
  check(
    '环境向导：warn 不当成缺失（只有 warn 行 → 门禁不是 blocked，没有任何 todo）',
    wizardAllWarnState.gate !== 'blocked' &&
      wizardAllWarnState.steps.every((step) => step.status !== 'todo') &&
      wizardAllWarnState.steps.filter((step) => step.status === 'done').length === 3,
  );
  // 报告整体出错（error 非空）：没有 missing 证据的步骤记 unknown（不宣称"好了"），有证据仍是 todo
  const wizardErrorOnly = envDoctor.judgeWizard(
    wizardReport(
      { 'node-version': 'warn', npm: 'warn', pnpm: 'warn', dsh: 'warn', 'dsh-run': 'warn' },
      { error: '这一轮没测全：解析本地 Shell 失败' },
    ),
    [],
  );
  const wizardErrorWithMissing = envDoctor.judgeWizard(
    wizardReport({ pnpm: 'missing' }, { error: '这一轮没测全：解析本地 Shell 失败' }),
    [],
  );
  check(
    '环境向导：报告整体出错时没有 missing 证据的步骤记 unknown，有证据的仍然 blocked',
    wizardErrorOnly.gate === 'unknown' &&
      wizardErrorOnly.steps.every((step) => step.status === 'unknown') &&
      wizardErrorOnly.currentStepId === 'node' &&
      Boolean(wizardErrorOnly.gateReason) &&
      wizardErrorWithMissing.gate === 'blocked' &&
      wizardStepOf(wizardErrorWithMissing, 'pnpm').status === 'todo' &&
      wizardStepOf(wizardErrorWithMissing, 'node').status === 'unknown' &&
      wizardErrorWithMissing.currentStepId === 'pnpm',
  );
  const wizardUnknownOnly = envDoctor.judgeWizard(
    wizardReport({ pnpm: 'warn', dsh: 'warn', 'dsh-run': 'warn' }, { error: '这一轮没测全' }),
    [],
  );
  check(
    '环境向导：currentStepId 取第一个 todo、否则第一个 unknown、否则 null',
    envDoctor.judgeWizard(wizardReport({ pnpm: 'missing', dsh: 'missing' }), []).currentStepId ===
      'pnpm' &&
      wizardUnknownOnly.currentStepId === 'node' &&
      wizardHealthy.currentStepId === null &&
      // 推论：blocked 时当前步骤一定是 todo（界面上永远有可做的动作）
      [wizardNoNode, wizardErrorWithMissing].every((state) => {
        if (state.gate !== 'blocked') return false;
        const current = state.steps.find((step) => step.id === state.currentStepId);
        return current !== undefined && current.status === 'todo';
      }),
  );
  check(
    '环境向导：不可跳过的步骤跳过无效（node / dsh 仍 blocked、仍是 todo），未知 id 被忽略',
    (() => {
      const blocked = wizardReport({ node: 'missing', dsh: 'missing', pnpm: 'missing' });
      const withIgnored = envDoctor.judgeWizard(
        blocked,
        wizardSkips('node', 'dsh', 'shell', 'node'),
      );
      const withPnpm = envDoctor.judgeWizard(blocked, wizardSkips('pnpm'));
      return (
        withIgnored.gate === 'blocked' &&
        wizardStepOf(withIgnored, 'node').status === 'todo' &&
        wizardStepOf(withIgnored, 'dsh').status === 'todo' &&
        withIgnored.skips.length === 0 &&
        withPnpm.gate === 'blocked' &&
        wizardStepOf(withPnpm, 'pnpm').status === 'skipped' &&
        withPnpm.skips.length === 1 &&
        withPnpm.skips[0] === 'pnpm' &&
        // 跳过一个只剩 warn 证据的步骤也照样生效（那是可跳过的）
        envDoctor.judgeWizard(wizardReport({ pnpm: 'warn' }), wizardSkips('pnpm')).skips[0] ===
          'pnpm'
      );
    })(),
  );
  check(
    '环境向导：skipped 项判 warn 不是 missing（五个子进程项各一条夹具）',
    (() => {
      const skippedProbe = (over: Partial<envDoctor.EnvProbeRaw>): envDoctor.EnvProbeRaw =>
        envProbe(over);
      const fixtures: [EnvCheckId, envDoctor.EnvProbeRaw][] = [
        [
          'node-version',
          skippedProbe({ node: envVersionProbe({ version: null, exitCode: null, skipped: true }) }),
        ],
        [
          'npm',
          skippedProbe({ npm: envVersionProbe({ version: null, exitCode: null, skipped: true }) }),
        ],
        [
          'pnpm',
          skippedProbe({ pnpm: envVersionProbe({ version: null, exitCode: null, skipped: true }) }),
        ],
        [
          'dsh',
          skippedProbe({
            dsh: envDshProbe({ kind: null, display: null, runs: false, skipped: true }),
          }),
        ],
        [
          'dsh-run',
          skippedProbe({
            dsh: envDshProbe({ kind: null, display: null, runs: false, skipped: true }),
          }),
        ],
      ];
      return fixtures.every(([id, raw]) => {
        const row = envCheckOf(envDoctor.judgeEnvironment(raw), id);
        return row.status === 'warn' && /这一轮没测/.test(row.detail);
      });
    })(),
  );
  const wizardQuickProbe = envDoctor.collectBootProbe(settings.all(), {
    platform: process.platform,
    packaged: false,
    bundled: { electron: '44.3.0', node: '24.19.0', chrome: '140.0.0' },
  });
  const wizardQuickReport = envDoctor.judgeEnvironment(wizardQuickProbe);
  check(
    '环境向导：快速探测把"要起子进程才知道的项"标成 skipped（判定给 warn，实测结果为空）',
    wizardQuickProbe.node.skipped === true &&
      wizardQuickProbe.npm.skipped === true &&
      wizardQuickProbe.pnpm.skipped === true &&
      wizardQuickProbe.dsh.skipped === true &&
      wizardQuickProbe.node.version === null &&
      wizardQuickProbe.npm.version === null &&
      wizardQuickProbe.pnpm.version === null &&
      wizardQuickProbe.dsh.runs === false &&
      wizardQuickProbe.dsh.kind === null &&
      wizardQuickProbe.checkedAt > 0 &&
      typeof wizardQuickProbe.shell.exists === 'boolean' &&
      ['node-version', 'npm', 'pnpm', 'dsh', 'dsh-run'].every(
        (id) => envCheckOf(wizardQuickReport, id as EnvCheckId).status === 'warn',
      ) &&
      // 路径是**真实证据**：找到了就是 ok，没找到就是 missing（快速探测的判据全在文件系统上）
      envCheckOf(wizardQuickReport, 'node').status ===
        (wizardQuickProbe.node.path ? 'ok' : 'missing') &&
      // 而且它能被同一个判定函数消费（纯净机器 → blocked → 不自动启动）
      typeof envDoctor.judgeWizard(wizardQuickReport, []).gate === 'string',
  );
  const wizardBootBody = stripStrings(stripComments(functionBodyOf(envSource, 'collectBootProbe')));
  check(
    '环境向导：collectBootProbe 只读文件系统（没有 spawn / launchSpec / execFile，复用既有三个查找函数）',
    wizardBootBody.length > 200 &&
      !/\bspawn|\bexecFile|\bexecSync|\bspawnSync|\blaunchSpec/.test(wizardBootBody) &&
      !/process\.env/.test(wizardBootBody) &&
      !/collectEnvProbe\(/.test(wizardBootBody) &&
      /findNodePath\(\)/.test(wizardBootBody) &&
      /findNpm\(\)/.test(wizardBootBody) &&
      /findPnpmPath\(\)/.test(wizardBootBody),
    `${wizardBootBody.length} 字符`,
  );
  const wizardJudgeBody = stripStrings(stripComments(functionBodyOf(envSource, 'judgeWizard')));
  check(
    '环境向导：judgeWizard 是纯函数（没有 fs / 子进程 / process.* / 时钟；入参不被修改）',
    wizardJudgeBody.length > 200 &&
      !/\bfs\./.test(wizardJudgeBody) &&
      !/\bspawn|\bexecFile|\bexecSync|\bspawnSync/.test(wizardJudgeBody) &&
      !/process\.env|process\.platform|process\.versions/.test(wizardJudgeBody) &&
      !/Date\.now|\bnew Date\b/.test(wizardJudgeBody) &&
      (() => {
        const report = wizardReport({ node: 'missing' });
        const skips = wizardSkips('node', 'pnpm');
        const before = JSON.stringify(report);
        const beforeSkips = JSON.stringify(skips);
        envDoctor.judgeWizard(report, skips);
        return JSON.stringify(report) === before && JSON.stringify(skips) === beforeSkips;
      })(),
    `${wizardJudgeBody.length} 字符`,
  );

  // 渲染层的判定面：唯一来源、门禁与启动锁互斥、逃生口不经过任何安装动作
  check(
    '环境向导：gateVisible 读 bootLockVisible（门禁与启动锁互斥的唯一落点）',
    /export const gateVisible[\s\S]{0,600}?bootLockVisible\.value/.test(wizardSource) &&
      /export const bootLockVisible: Ref<boolean> = ref\(false\)/.test(bootLockSource) &&
      /export function setBootLockVisible\(on: boolean\): void \{[\s\S]{0,120}?bootLockVisible\.value = Boolean\(on\);/.test(
        bootLockSource,
      ) &&
      // 写它的人只有一个：app.ts 的 setBootLock（上锁与解锁都要写）
      /function setBootLock\(on: boolean\): void \{[\s\S]{0,300}?setBootLockVisible\(on\);/.test(
        appTsCode,
      ) &&
      (rendererCode.match(/setBootLockVisible\(on\)/g) ?? []).length === 1,
  );
  const wizardEscapeBody = blockOf(wizardSource, 'export function escapeGate(');
  check(
    '环境向导：逃生口不经过任何安装动作（只改内存相位：不发 IPC、不写盘、不看安装状态）',
    wizardEscapeBody.length > 40 &&
      /gatePhase\.value = 'escaped';/.test(wizardEscapeBody) &&
      !/api\./.test(wizardEscapeBody) &&
      !/patchSettings/.test(wizardEscapeBody) &&
      !/envWizardSkip|skipStep/.test(wizardEscapeBody) &&
      !/await|install\.value/.test(wizardEscapeBody) &&
      // 门禁的「进入界面 / 重新打开向导」同样不写盘
      /export function enterMainUi\(\): void \{[\s\S]{0,200}?gatePhase\.value = 'entered';/.test(
        wizardSource,
      ) &&
      !/patchSettings/.test(wizardSource),
  );
  check(
    '环境向导：preload 暴露 7 个新成员，且通道名与主进程 handler 一一对应',
    (() => {
      const wizardApiNames = [
        'envWizard',
        'envWizardSkip',
        'envNodePlan',
        'envNodeInstall',
        'envNodeStop',
        'onEnvInstallState',
        'onEnvInstallOutput',
      ];
      const channels = [
        'env:wizard',
        'env:wizard-skip',
        'env:node-plan',
        'env:node-install',
        'env:node-stop',
      ];
      const events = ['env:install-state', 'env:install-output'];
      return (
        wizardApiNames.every((name) => new RegExp(`\\n\\s{2}${name}:`).test(preloadCode)) &&
        channels.every(
          (channel) =>
            preloadCode.includes(`ipcRenderer.invoke('${channel}'`) &&
            envMainCode.includes(`'${channel}'`),
        ) &&
        events.every(
          (channel) =>
            preloadCode.includes(`subscribe('${channel}'`) &&
            envMainCode.includes(`sendToRenderer('${channel}'`),
        ) &&
        // 渲染层不许绕开 preload：utils/ state/ shared/ 与 app.ts 里都没有 ipcRenderer
        !/ipcRenderer/.test(rendererCode)
      );
    })(),
  );
  check(
    '环境向导：全局互斥（env:fix 与 env:node-install 读同一个忙位，两个动作不同时改机器）',
    // 忙位本身在 main-ipc-shared.ts（t57 从 main.ts 搬出去），call site 在 main-ipc-env.ts
    /function anyoneBusy\(ctx: IpcContext\): boolean \{[\s\S]{0,120}?return ctx\.envFixRunner\.busy \|\| ctx\.nodeInstaller\.busy\(\);/.test(
      envMainCode,
    ) &&
      (envMainCode.match(/ctx\.envFixRunner\.busy \|\| ctx\.nodeInstaller\.busy\(\)/g) ?? [])
        .length === 1 &&
      /if \(anyoneBusy\(ctx\)\) \{[\s\S]{0,160}?phase: 'error', message: BUSY_MESSAGE/.test(
        envMainCode,
      ) &&
      (envMainCode.match(/if \(anyoneBusy\(ctx\)\)/g) ?? []).length === 2 &&
      /const BUSY_MESSAGE = '正在执行上一步的操作，完成后按钮会自动恢复';/.test(envMainCode),
  );
  check(
    '环境向导：渲染层只递选择（env:node-install 只取 method / mode / channel，地址与校验值由主进程现算）',
    /function parseNodeRequest\([\s\S]{0,700}?method !== 'direct' && method !== 'nvm'/.test(
      envMainCode,
    ) &&
      /mode !== 'install' && mode !== 'update'/.test(envMainCode) &&
      /channel !== undefined && channel !== 'lts' && channel !== 'current'/.test(envMainCode) &&
      /const parsed = parseNodeRequest\(request\);/.test(envMainCode) &&
      /return await nodeInstaller\.run\(parsed\);/.test(envMainCode) &&
      /return await nodeInstaller\.plan\(parsed\);/.test(envMainCode) &&
      // 渲染层递回来的 URL / sha256 / argv 一概不采信
      !/request\??\.(url|sha256|file|args)\b/.test(envMainCode) &&
      !/\.sha256\b/.test(envMainCode) &&
      // 渲染层只递三个字段：lib 里没有把计划里的地址再发回去的路径
      !/api\.envNodeInstall\(\{[^}]*url/.test(wizardSource) &&
      !/sha256/.test(wizardSource),
  );
  check(
    '环境向导：「更新 pnpm」就是既有的 install-pnpm（全局 npm 安装 argv 全仓库只有一处）',
    (() => {
      const tsFiles: string[] = [];
      const collect = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) collect(full);
          else if (entry.name.endsWith('.ts')) tsFiles.push(full);
        }
      };
      collect(srcDir);
      // 全局 npm 安装的 argv 只有一处：`['i', '-g', <spec>]`。`<spec>` 现在由 `pnpmInstallSpec()`
      // 按"有没有 VC++ 运行库"现算（VM-09），所以这里认 `'i', '-g'` 这一对字面量，
      // 再单独钉住"pnpm 那一档不是写死的版本、而是走 pnpmInstallSpec()"。
      const owners = tsFiles.filter((file) =>
        /['"]i['"],\s*['"]-g['"]/.test(fs.readFileSync(file, 'utf8')),
      );
      // t51 起 `pnpmInstallSpec` / `npmLaunchSpec` 住在 env-fix-plan.ts（env-doctor.ts 已变成 barrel）
      const envDoctorSource = envSource;
      return (
        owners.length === 1 &&
        path.basename(owners[0]) === 'env-fix-plan.ts' &&
        // 版本策略只有一处落点（不许在别处又拼一遍 argv）
        /['"]i['"],\s*['"]-g['"],\s*pnpmInstallSpec\(/.test(envDoctorSource) &&
        // 更新入口走的是既有的 envFix（渲染层只递 action），没有第二条路
        /envFixAction|envFix/.test(preloadCode) &&
        !/install-pnpm/.test(wizardSource)
      );
    })(),
  );
  check(
    '环境向导：每个编排相位都有终态（请求失败也回 error 状态，不留一个转圈的"正在安装"）',
    // 主进程：两个入口的失败都表达成状态里的 error，而不是抛出去让渲染层干等
    /catch \(error\) \{[\s\S]{0,400}?return refusedInstallState\(ctx, message\);/.test(
      envMainCode,
    ) &&
      /if \(!parsed\)[\s\S]{0,40}?return refusedInstallState\(\s*ctx,/.test(envMainCode) &&
      /refusedInstallState\(\s*ctx,\s*'不认识的操作/.test(envMainCode) &&
      // 渲染层：IPC 自己失败时也要落一个终态（不能停在 preparing/downloading 的转圈里）
      /install\.value = \{[\s\S]{0,80}?\.\.\.EMPTY_INSTALL,[\s\S]{0,120}?phase: 'error'/.test(
        wizardSource,
      ) &&
      // 停止是同步、不抛，而且返回完整状态（安装 / 等待之后它只把 detached 置真）
      /ipcMain\.handle\([\s\S]{0,30}'env:node-stop'[\s\S]{0,80}?nodeInstaller\.stop\(\)/.test(
        envMainCode,
      ) &&
      /export async function stopNodeInstall\(\): Promise<void>/.test(wizardSource) &&
      // 相位机每一步都有下一步：逃生的下一步是 entered/done 这类收尾，不是留在 checking
      ['escaped', 'entered', 'done'].every((phase) => wizardSource.includes(`'${phase}'`)),
  );

  // ---------------------------------------------------------- 17b. t8 独立验证的三条缺陷（F-01 / F-02）
  /**
   * F-01：`judgeWizard` 必须满足冻结 §2.1「任何输入都不抛」。
   *
   * **行为断言**（不是纯静态）：真的把畸形输入喂进去，看它有没有抛、有没有给出门禁三态。
   * 可达路径是"用户手改 settings.json 成 `"envSkips": null`"，所以 `skips` 的守卫最要紧。
   */
  const asReport = (value: unknown): EnvDoctorReport => value as EnvDoctorReport;
  const asSkips = (value: unknown): EnvWizardStepId[] => value as EnvWizardStepId[];
  check(
    '环境向导（F-01）：judgeWizard 对任何输入都不抛，且总给出门禁三态 + 三步',
    (() => {
      const malformed: [string, unknown, unknown][] = [
        ['(null, null)', null, null],
        ['(undefined, undefined)', undefined, undefined],
        ['({}, undefined)', {}, undefined],
        ['({checks:"x",plans:5}, ["bogus"])', { checks: 'x', plans: 5, error: null }, ['bogus']],
        [
          '({checks:null,plans:null,error:"x"}, null)',
          { checks: null, plans: null, error: 'x' },
          null,
        ],
        ['([], [])', [], []],
        ['({error:{}}, "x")', { error: {} }, 'x'],
        ['({checks:[null,42]}, [null])', { checks: [null, 42] }, [null]],
      ];
      return malformed.every(([, report, skips]) => {
        try {
          const state = envDoctor.judgeWizard(asReport(report), asSkips(skips));
          return (
            ['open', 'blocked', 'unknown'].includes(state.gate) &&
            state.steps.length === 3 &&
            Array.isArray(state.skips) &&
            (state.currentStepId === null || envWizardStepIds.includes(state.currentStepId))
          );
        } catch {
          return false;
        }
      });
    })(),
    '8 组畸形输入（null / undefined / 字段类型全错 / checks 里混进非对象）都不抛',
  );
  /**
   * F-01 的可达路径：设置文件是用户手改得动的，`"envSkips": null` 真的会出现。
   * 主进程只允许在 `wizardSkips()` 里读它，而那个函数只用数组、其它一律当空数组 ——
   * 于是 `env:wizard` 不会 reject，向导不会永远停在"检查中 + 错误"。
   */
  check(
    '环境向导（F-01 可达路径）：设置里的 envSkips 被手改成 null 也拿得到结论',
    (() => {
      const guardBody = blockOf(
        envMainCode,
        'function wizardSkips(settings: Settings): EnvWizardStepId[]',
      );
      return (
        guardBody.length > 40 &&
        /Array\.isArray\(value\) \? \(value as EnvWizardStepId\[\]\) : \[\]/.test(guardBody) &&
        // 只有这一处读设置里的 envSkips（别的调用点都得过这道守卫）
        (envMainCode.match(/settings\.get\('envSkips'\)/g) ?? []).length === 1 &&
        (envMainCode.match(/wizardSkips\(settings\)/g) ?? []).length >= 3
      );
    })(),
  );
  /**
   * F-02：从主界面横幅点「重新检测」**不得**把全屏门禁层拉出来（R-08 ② / §3.8 #15）。
   * 根因是当初用"是不是一次 refresh"代替了"这一轮属不属于门禁层"——
   * 这里把那条规则钉住：`checking` 的可见性 = 第一轮 / 用户重开 / 层本来就在屏幕上。
   * （**行为面**由验证者的独立用例 `scripts/env-wizard-cases.mjs` 的 K11 用可控 Promise 桩
   *  在"等待期间"取样证明，那份脚本由本门禁自动收录，不归我改。）
   */
  check(
    '首启门禁（F-02）：横幅触发的 checking 不显示门禁层（判据是"这一轮属不属于门禁层"，不是 refresh）',
    /const belongsToGateLayer = !started \|\| reopenRequested \|\| layerWasVisible;/.test(
      wizardSource,
    ) &&
      /checkingVisible = belongsToGateLayer;/.test(wizardSource) &&
      // 改之前那种写法（用 refresh 当判据 / 用上一轮的可见性推下一轮）必须已经消失
      !/checkingVisible = showChecking/.test(wizardSource) &&
      !/visibleAfterRound/.test(wizardSource) &&
      // 取样必须在改相位之前（否则读到的是刚写进去的 checking）
      wizardSource.indexOf('const layerWasVisible = gateVisible.value;') <
        wizardSource.indexOf("gatePhase.value = 'checking';"),
  );
  /**
   * F-03：`src/shared/ipc.ts` 与冻结文档 §3.1~§3.4 的"逐字可贴"块必须完全一致
   *（船长已核实是**契约文件错、不是文档错**）。断言直接拿文档里的代码块来比对 ——
   * 以后任何"顺手改一个字"都会红；`signer` 的语义也必须写着"尚未读取"（不是"未签名"）。
   */
  check(
    '契约（F-03）：ipc.ts 与冻结 §3.1~§3.4 的逐字块完全一致（具名 EnvReleaseSigning + signer = 尚未读取）',
    (() => {
      const freezeDoc = fs.readFileSync(
        path.join(repoRoot, 'docs', 'env-wizard-freeze.md'),
        'utf8',
      );
      const blockAfter = (heading: string): string => {
        const start = freezeDoc.indexOf(heading);
        if (start < 0) return '';
        const open = freezeDoc.indexOf('```ts\n', start);
        const close = freezeDoc.indexOf('\n```', open + 6);
        return open >= 0 && close > open ? freezeDoc.slice(open + 6, close) : '';
      };
      const headings = [
        '### 3.1 门禁与步骤',
        '### 3.2 Node 安装 / 更新通道',
        '### 3.3 `DshConsoleApi` 的增量',
        '### 3.4 设置项增量',
      ];
      const blocks = headings.map(blockAfter);
      const planBody = /\nexport interface EnvNodePlan \{([\s\S]*?)\n\}/.exec(ipcSource)?.[1] ?? '';
      return (
        blocks.every((block) => block.length > 200 && ipcSource.includes(block)) &&
        // 具名类型（不是内联联合）
        /export type EnvReleaseSigning = 'signed' \| 'unsigned' \| 'unknown';/.test(blocks[1]) &&
        /releaseSigning: EnvReleaseSigning;/.test(planBody) &&
        // signer 只有一个含义：计划阶段恒为 null = "尚未读取"，绝不是"未签名"

        /计划阶段恒为 null，语义是"尚未读取"/.test(planBody) &&
        !/未签名 \/ 读不到时为 null/.test(planBody) &&
        // R-25 / R-26 / R-27 同步过的三处注释都在（后来者照着旧注释就会把未签名确认加回计划阶段）
        /1\.2\.x 的资产 digest 是 none/.test(planBody) &&
        /校验清单取不到（网络类）/.test(planBody) &&
        /发布元数据的\*\*签名自述（R-27）/.test(planBody)
      );
    })(),
  );

  // ---------------------------------------------------------- 17c. VM 实测（VM-03 / VM-04）
  /** VM 那台机器的探测形状：版本管理器目录里有 node.exe，但 `node --version` 出不来结果 */
  const vmProbeRaw = (over: Partial<envDoctor.EnvProbeRaw> = {}): envDoctor.EnvProbeRaw =>
    envProbe({
      node: envVersionProbe({
        path: 'C:\\Users\\vm\\AppData\\Roaming\\nvm\\node.exe',
        version: null,
        exitCode: 0,
        error: null,
      }),
      ...over,
    });
  /**
   * VM-03：完成判据必须回到"真的能跑"这条线上。
   *
   * VM 实测现场：第一步显示「已完成」，而下一步的 npm 立刻报
   * "No active Node.js version is configured"。旧判据只看"文件在不在"，
   * 而阶段一 `canRunDsh` 早就定下同一条纪律：**有输出才算可用**。
   */
  const vmDeadNodeReport = envDoctor.judgeEnvironment(vmProbeRaw());
  const vmDeadNodeState = envDoctor.judgeWizard(vmDeadNodeReport, []);
  check(
    '环境自检（VM-03）：Node 的文件在、但跑不出结果 → 这一项判「不可用」（missing），不是黄灯',
    envCheckOf(vmDeadNodeReport, 'node').status === 'ok' &&
      envCheckOf(vmDeadNodeReport, 'node-version').status === 'missing' &&
      /没有任何输出/.test(envCheckOf(vmDeadNodeReport, 'node-version').detail) &&
      Boolean(envCheckOf(vmDeadNodeReport, 'node-version').fixHint),
  );
  check(
    '环境向导（VM-03）：第一步只在"真的能跑"时才算完成（VM 上它曾经显示「已完成」）',
    wizardStepOf(vmDeadNodeState, 'node').status === 'todo' &&
      vmDeadNodeState.gate === 'blocked' &&
      vmDeadNodeState.currentStepId === 'node' &&
      vmDeadNodeState.steps.length === 3,
  );
  const vmSilentNpm = envDoctor.judgeEnvironment(
    envProbe({ npm: envVersionProbe({ version: null, exitCode: 1, error: null }) }),
  );
  const vmSilentPnpm = envDoctor.judgeEnvironment(
    envProbe({ pnpm: envVersionProbe({ version: null, exitCode: 0, error: null }) }),
  );
  const vmBlockedNode = envDoctor.judgeEnvironment(
    envProbe({
      node: envVersionProbe({
        path: '/usr/bin/node',
        version: null,
        exitCode: null,
        error: 'spawnSync EPERM',
      }),
    }),
  );
  check(
    '环境自检（VM-03）：黄灯只留给"这个运行环境不允许起子进程"（EPERM 一类），其余跑不起来＝不可用',
    envCheckOf(vmBlockedNode, 'node-version').status === 'warn' &&
      envCheckOf(vmSilentNpm, 'npm').status === 'missing' &&
      envCheckOf(vmSilentPnpm, 'pnpm').status === 'missing',
  );

  /** 冻结 §3.8 #22 的词表（界面文案里不许出现的内部术语） */
  const VM_FORBIDDEN = [
    'PATH',
    'dsh.cmd',
    'npx',
    'COMSPEC',
    'verbatim',
    'SHA256',
    'SHASUMS256',
    'NVM_SYMLINK',
    'NVM_HOME',
  ];
  const vmForbiddenIn = (text: string): string[] =>
    VM_FORBIDDEN.filter((word) =>
      new RegExp(
        `(?<![\\w.$])${word.replace('.', '\\.')}(?![\\w$])`,
        word === 'verbatim' ? 'i' : '',
      ).test(text),
    );
  check(
    '首启门禁（VM-04）：主进程产出的用户可见文案里不出现内部术语（拿 VM 那台的夹具真跑一遍）',
    (() => {
      // 夹具里刻意带上 VM 现场那句原始报错（它含 PATH / dsh.cmd / npx）——
      // 旧代码把它原样贴进 detail，界面上就出现了内部术语；这条断言必须对那种写法变红。
      const report = envDoctor.judgeEnvironment(
        vmProbeRaw({
          npm: envVersionProbe({
            path: 'C:\\Program Files\\nodejs\\npm.cmd',
            version: null,
            exitCode: 1,
            error: 'No active version',
          }),
          pnpm: envVersionProbe({ path: null, version: null, exitCode: null }),
          dsh: envDshProbe({
            kind: null,
            display: null,
            runs: false,
            resolveError: '找不到 dsh: PATH 里没有 dsh.cmd，也没有 npx。请在设置里指定启动命令。',
          }),
        }),
      );
      const texts: string[] = [];
      for (const item of report.checks) texts.push(item.detail, item.fixHint ?? '');
      for (const plan of report.plans) texts.push(plan.note, plan.display);
      return texts.length >= 10 && texts.every((text) => vmForbiddenIn(text).length === 0);
    })(),
  );
  check(
    '首启门禁（VM-04）：主进程源码里的用户可见文案也不出现内部术语（覆盖面补到"主进程产出"）',
    (() => {
      /** 抠一段代码里的字符串字面量（注释已剥） */
      const literalsOf = (code: string): string[] =>
        [...code.matchAll(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g)].map((match) => match[0]);
      /** 与探测内部取值比较用的字面量（`raw.dsh.kind === 'npx'`）不是界面文案 */
      const comparedLiterals = (code: string): Set<string> =>
        new Set(
          [...code.matchAll(/(?:===|!==)\s*((['"`])(?:\\.|(?!\2)[^\\])*\2)/g)].map(
            (match) => match[1],
          ),
        );
      const copyLiteralsOf = (code: string): string[] => {
        const compared = comparedLiterals(code);
        return literalsOf(code).filter((literal) => !compared.has(literal));
      };
      const envDoctorCopy = copyLiteralsOf(
        stripComments(fs.readFileSync(path.join(srcDir, 'main', 'env-doctor.ts'), 'utf8')),
      );
      const wizardCopy = copyLiteralsOf(
        stripComments(fs.readFileSync(repo.tsPath('env-wizard.ts'), 'utf8')),
      );
      // 安装引擎那边只算"界面会显示的字段"里的值：`NVM_HOME` / `SHASUMS256.txt` 这类
      // 环境变量键名与 URL 不上界面（它们出现在别的语句里，不该被这条断言误伤）
      const installerFields = [
        ...stripComments(
          fs.readFileSync(path.join(srcDir, 'main', 'node-installer.ts'), 'utf8'),
        ).matchAll(
          /(?:detail|fixHint|note|message|refuseReason|evidence|summary|display|target)\s*:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g,
        ),
      ].map((match) => match[0]);
      const groups = [envDoctorCopy, wizardCopy, installerFields];
      const violations = groups.flatMap((group) =>
        group.filter((text) => vmForbiddenIn(text).length > 0),
      );
      return (
        groups.every((group) => group.length > 0) &&
        violations.length === 0 &&
        // 反过来证明这条断言真的看得见东西：把 VM 现场那句话塞进同一套规则里，必须命中
        vmForbiddenIn('找不到 dsh: PATH 里没有 dsh.cmd，也没有 npx。').length === 3
      );
    })(),
  );

  // ---------------------------------------------------------- 17e. VM-13：不许把应用能做的事推给用户
  //    与 VM-04 的词表规则并列：一个不许把**内部记号**暴露给用户，一个不许把**活**推给用户。
  //    F-05 的现场：门禁第一步的事实行（env-doctor 的 node-version detail）写着「…（先在终端里选一个
  //    版本，或重装官方 Node）」，而它就显示在两条一键安装路的并列位置上 —— 一边给「安装」按钮，
  //    一边让用户自己去终端里选。上一轮只扫了 `installerCode`（引擎侧），漏了这里。
  /** 把人打发的表述（出现即红）。`你自己有权限的终端` 那种**真的只能用户做**的情形不在此列，见下 */
  const PUNTING_PHRASES = [
    '先在终端',
    '先在命令行',
    '到终端里去',
    '自己打开终端',
    '自己去终端',
    '自己到终端',
    '自行在终端',
    '手动到终端',
    '手动在终端',
    '你自己去敲',
  ];
  check(
    '环境自检（VM-13）：门禁事实行不再把用户打发去终端，且「管理器在、零版本」说的是那一种状态',
    (() => {
      // 客机状态：node.exe 在版本管理器的目录里，但跑不出结果（零版本）
      const fixture = envProbe({
        node: envVersionProbe({
          path: 'C:\\Users\\tester\\AppData\\Local\\Software\\nvm\\nodejs\\node.exe',
          version: null,
          exitCode: 0,
          error: null,
        }),
        nodeFromVersionManager: true,
      });
      const report = envDoctor.judgeEnvironment(fixture);
      const texts: string[] = [];
      for (const item of report.checks) texts.push(item.detail, item.fixHint ?? '');
      for (const plan of report.plans) texts.push(plan.note, plan.display);
      const dynamicHits = texts.filter((text) =>
        PUNTING_PHRASES.some((phrase) => text.includes(phrase)),
      );
      const versionRow = report.checks.find((item) => item.id === 'node-version');
      // 静态：env-doctor 里所有字符串字面量（注释已剥）—— 与 VM-04 那两条同一套做法
      const literals = [...stripComments(envSource).matchAll(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g)].map(
        (match) => match[0],
      );
      const staticHits = literals.filter((literal) =>
        PUNTING_PHRASES.some((phrase) => literal.includes(phrase)),
      );
      return (
        // ① 行为：这一状态必须说中它（版本管理器在、零版本），出路指向应用内那条路
        versionRow?.status === 'missing' &&
        /版本管理器/.test(versionRow.detail) &&
        /安装/.test(versionRow.fixHint ?? '') &&
        // ② 两种扫法都不许命中"打发用户"的表述
        dynamicHits.length === 0 &&
        staticHits.length === 0 &&
        // ③ 自证：同一套规则对**修之前那句**必须命中（变异实验的断言版）
        PUNTING_PHRASES.some((phrase) =>
          '版本管理器还没选中一个版本时也是这个样子（先在终端里选一个版本，或重装官方 Node）'.includes(
            phrase,
          ),
        )
      );
    })(),
  );
  check(
    '环境自检（VM-13）：「这一轮没测」（快速探测）的出路不是"去终端跑一次"',
    (() => {
      // skipped 的项只是**我们**还没测（1.5 秒后完整检测就来），没有任何东西坏掉
      const skipped = envProbe({
        node: envVersionProbe({ version: null, exitCode: null, skipped: true }),
        npm: envVersionProbe({ path: '/opt/npm', version: null, exitCode: null, skipped: true }),
        pnpm: envVersionProbe({ path: '/opt/pnpm', version: null, exitCode: null, skipped: true }),
        dsh: envDshProbe({
          kind: null,
          display: null,
          runs: false,
          version: null,
          resolveError: null,
          skipped: true,
        }),
      });
      const report = envDoctor.judgeEnvironment(skipped);
      const hints = report.checks
        .filter((item) => /这一轮没测/.test(item.detail))
        .map((item) => item.fixHint ?? '');
      return (
        hints.length >= 5 &&
        hints.every((hint) => /完整检测/.test(hint)) &&
        hints.every((hint) => !PUNTING_PHRASES.some((phrase) => hint.includes(phrase))) &&
        // 「这个运行环境不允许起子进程」是**真的只能用户做**：那里保留"手工确认"，并先让用户点重新检测
        /重新检测/.test(
          envCheckOf(
            envDoctor.judgeEnvironment(
              envProbe({
                node: envVersionProbe({
                  path: '/usr/bin/node',
                  version: null,
                  exitCode: null,
                  error: 'spawnSync EPERM',
                }),
              }),
            ),
            'node-version',
          ).fixHint ?? '',
        )
      );
    })(),
  );

  // ---------------------------------------------------------- 17d. 原始错误进日志（VM-04 的另一半）
  //    裁定②是成对的：「细节留日志、结论给人话」。17c 钉住了「界面里找不到」，
  //    这一节钉住另一半 —— 被撤下去的那句原文必须**真的落到日志里**（`EnvDoctorHooks.log`），
  //    否则它既不在界面上、也不在日志里，下次真机排查就只能靠猜。
  /** VM 现场那句原始报错：含 PATH / dsh.cmd / npx，界面上一律不许出现 */
  const vmResolveError = '找不到 dsh: PATH 里没有 dsh.cmd，也没有 npx。请在设置里指定启动命令。';
  const vmLogRaw = vmProbeRaw({
    npm: envVersionProbe({
      path: 'C:\\Program Files\\nodejs\\npm.cmd',
      version: null,
      exitCode: 1,
      error: null,
      // VM 上那句原因**只在 stderr 上**（error 是 null）：界面不许显示它，日志必须留下它
      stderr: 'No active Node.js version is configured',
    }),
    pnpm: envVersionProbe({ path: null, version: null, exitCode: null }),
    dsh: envDshProbe({ kind: null, display: null, runs: false, resolveError: vmResolveError }),
  });
  const vmLogReport = envDoctor.judgeEnvironment(vmLogRaw);
  const vmLogLines = envDoctor.probeTroubleLines(vmLogRaw, vmLogReport);
  const vmLogText = vmLogLines.join('\n');
  /** 报告里所有"用户看得见"的字符串（界面文案的取值面，与 17c 同一套口径） */
  const vmVisibleTexts = (report: EnvDoctorReport): string[] => {
    const texts: string[] = [];
    for (const item of report.checks) texts.push(item.detail, item.fixHint ?? '');
    for (const plan of report.plans) texts.push(plan.note, plan.display);
    return texts;
  };
  check(
    '首启门禁（VM-04 的另一半）：被界面撤下去的原始错误落进日志（子进程错误串 / stderr / dsh 定位原文）',
    vmLogLines.length >= 3 &&
      vmLogText.includes(vmResolveError) &&
      /node --version[\s\S]*退出码 0/.test(vmLogText) &&
      // 这句只可能来自 stderr（`error` 是 null）：stderr 没接进日志的话这条就红
      /stderr：No active Node.js version is configured/.test(vmLogText) &&
      vmLogLines.every((line) => line.length > 0),
  );
  check(
    '首启门禁（VM-04 的另一半）：同一份夹具，界面文案里仍然找不到这些内部术语（词表不放松）',
    (() => {
      const visible = vmVisibleTexts(vmLogReport);
      // 成对判据：日志里**有**这些词（它记的就是原文），界面文案里一个都不许有
      return (
        visible.length >= 10 &&
        vmForbiddenIn(vmLogText).length >= 3 &&
        visible.every((text) => vmForbiddenIn(text).length === 0)
      );
    })(),
  );
  const vmBlockedRaw = envProbe({
    node: envVersionProbe({
      path: '/usr/bin/node',
      version: null,
      exitCode: null,
      error: 'spawnSync EPERM',
    }),
  });
  const vmBlockedReport = envDoctor.judgeEnvironment(vmBlockedRaw);
  const vmBlockedLines = envDoctor.probeTroubleLines(vmBlockedRaw, vmBlockedReport);
  check(
    '首启门禁（VM-04 的另一半）：黄灯（这个环境不允许起子进程）也把原文记下来 —— 日志里有，界面上没有',
    envCheckOf(vmBlockedReport, 'node-version').status === 'warn' &&
      vmBlockedLines.some((line) => line.includes('spawnSync EPERM')) &&
      // 没写 stderr 的夹具不会长出 `stderr：undefined`（可选字段要干净地缺席）
      !vmBlockedLines.join('\n').includes('stderr') &&
      vmVisibleTexts(vmBlockedReport).every((text) => !/EPERM/.test(text)),
  );
  /** 快速探测的形状（`collectBootProbe`）：这一轮**不起子进程**，所以没有任何原文可记 */
  const envSkippedProbe = envProbe({
    node: envVersionProbe({ version: null, exitCode: null, skipped: true }),
    npm: envVersionProbe({
      path: '/opt/homebrew/bin/npm',
      version: null,
      exitCode: null,
      skipped: true,
    }),
    pnpm: envVersionProbe({
      path: '/opt/homebrew/bin/pnpm',
      version: null,
      exitCode: null,
      skipped: true,
    }),
    dsh: envDshProbe({
      kind: null,
      display: null,
      runs: false,
      version: null,
      resolveError: null,
      skipped: true,
    }),
  });
  check(
    '环境自检：日志不刷屏 —— 正常的机器一条都不记，快速探测（没起子进程）没有原文可记',
    envDoctor.probeTroubleLines(envProbe(), envAllOk).length === 0 &&
      envDoctor.judgeEnvironment(envSkippedProbe).counts.warn >= 3 &&
      envDoctor.probeTroubleLines(envSkippedProbe, envDoctor.judgeEnvironment(envSkippedProbe))
        .length === 0,
  );
  check(
    '环境自检：日志行是纯函数算出来的（自检直接喂夹具；模块自己不碰 console / logger）',
    (() => {
      const body = stripStrings(blockOf(envSource, 'export function probeTroubleLines('));
      return (
        body.length > 200 &&
        !/\bfs\./.test(body) &&
        !/\bspawn|execFile|execSync|spawnSync/.test(body) &&
        !/process\.(env|platform|versions)/.test(body) &&
        !/Date\.now|new Date\b/.test(body) &&
        !/console\./.test(envCode)
      );
    })(),
  );
  check(
    '环境自检：stderr 只走日志这条路（判定不读它；不写它的旧夹具也照常跑）',
    /stderrTail\(stderr\)/.test(envCode) &&
      /let stderr = '';/.test(envCode) &&
      /stderr: run\.stderr,/.test(envCode) &&
      /export const STDERR_TAIL_CHARS = \d+;/.test(envSource) &&
      // 判定不看 stderr：结论仍然只由「有输出才算可用」那条线决定
      !/stderr/.test(envJudgeBody) &&
      /stderr/.test(blockOf(envSource, 'export function probeTroubleLines(')),
  );
  check(
    '环境自检：日志钩子是可选的（不传也照常跑），main.ts 接的是既有 logger、不另造通道',
    (() => {
      const hooksBody = blockOf(envSource, 'export interface EnvDoctorHooks {');
      const mainEnvBlock = blockOf(envMainCode, 'new EnvDoctor(settings, {');
      const envLogLine = /log: \(line\) =>[^\n]*/.exec(mainEnvBlock)?.[0] ?? '';
      return (
        // `log?`：既有调用方一个字都不改也能编译、也能跑
        /\blog\?:\s*\(line: string\) => void;/.test(hooksBody) &&
        // 主进程把它接进 console —— logger.ts 早把 console 落盘成 <userData>/logs/console.log
        /console\.log\(/.test(envLogLine) &&
        /\[env\]/.test(envLogLine) &&
        // 原文不进事件日志：那是用户看得见的界面，正是它不该出现的地方
        !/dshManager/.test(envLogLine) &&
        /installFileLogging\(path\.join\(app\.getPath\('userData'\), 'logs'\)\)/.test(
          envMainCode,
        ) &&
        // 记日志只经过可选的 `hooks.log`（模块自己不起一套日志通道）
        /this\.hooks\.log/.test(envSource)
      );
    })(),
  );

  // ---------------------------------------------------------- 18. 门禁界面与安装引擎
  //    冻结文档 §3.8 里"由渲染层 / 安装引擎提清单、由契约与编排落地"的那几条
  //    （第 12~14、16、19、20、22、23 条）。`test/selftest.ts` 只由契约与编排改（§5.3）。
  const topBarCode = stripComments(fs.readFileSync(repo.vuePath('TopBar.vue'), 'utf8'));
  const escapeButtonTag = /<button[^>]*@click="escape"[^>]*>/.exec(gateRaw)?.[0] ?? '';
  const gateEscapeBody = blockOf(gateCode, 'function escape(): void');
  check(
    '首启门禁：逃生口不写盘、不依赖任何安装动作（组件里没有 patchSettings / envWizardSkip）',
    gateCode.length > 500 &&
      !/patchSettings/.test(gateCode) &&
      !/envWizardSkip/.test(gateCode) &&
      gateEscapeBody.length > 10 &&
      /escapeGate\(\);/.test(gateEscapeBody) &&
      !/api\.|await|install\.value/.test(gateEscapeBody) &&
      // 逃生按钮那一行不带 `:disabled` / `v-if` / `v-show`：忙位与相位都拦不住它
      escapeButtonTag.length > 40 &&
      !/:disabled|v-if|v-show/.test(escapeButtonTag) &&
      /v-if="screen !== 'released'"[\s\S]{0,200}?@click="escape"/.test(gateRaw),
  );
  check(
    '首启门禁：跳过 / 恢复只走 envWizardSkip（渲染层那两处都不碰 patchSettings）',
    (() => {
      const confirmSkipBody = blockOf(gateCode, 'async function confirmSkip(): Promise<void>');
      const restoreStepBody = blockOf(envPaneCode, 'async function restoreStep(');
      return (
        confirmSkipBody.length > 20 &&
        /skipStep\('pnpm', true\)/.test(confirmSkipBody) &&
        !/patchSettings/.test(confirmSkipBody) &&
        restoreStepBody.length > 20 &&
        /skipStep\(step, false\)/.test(restoreStepBody) &&
        !/patchSettings/.test(restoreStepBody)
      );
    })(),
  );
  const tabOrderBody = /const TAB_ORDER: TabId\[\] = \[([\s\S]*?)\];/.exec(appTsCode)?.[1] ?? '';
  // "是不是页面"看**挂载清单里的 import 说明符**，不看目录名、也不看注释：
  // 门禁层从 `gate/` 进来，页面在 `pages/<一处>/` 下（t67 起的结构）。
  const mountImports = [...mountJs.matchAll(/from\s+'([^']*)'/g)].map((match) => match[1]);
  check(
    '首启门禁：门禁层不是页面（TAB_ORDER 与页面清单里都没有它，容器与启动锁同级）',
    tabOrderBody.length > 0 &&
      !/gate/i.test(tabOrderBody) &&
      mountImports.includes('./gate/EnvGate.vue') &&
      mountImports.includes('./gate/GateBanner.vue') &&
      !mountImports.some((spec) => /^\.\/pages\/[\w/]*Gate/.test(spec)) &&
      !mountImports.some((spec) => /^\.\/pages\/[\w/]*(EnvGate|GateBanner)\.vue$/.test(spec)) &&
      !/id="pane-gate"/.test(html) &&
      /id="gate-root"/.test(html) &&
      /id="boot-lock"/.test(html) &&
      // 同一层：门禁容器在启动锁之前，两者都在九页容器之外
      html.indexOf('id="gate-root"') < html.indexOf('id="boot-lock"'),
  );
  check(
    '首启门禁：顶栏的标题与"右侧控件收起"读同一个 gateVisible（R-03）',
    (topBarCode.match(/gateVisible/g) ?? []).length >= 3 &&
      // 标题里的门禁分支只由 gateVisible 决定（t45 起前面还有一条"详情层面包屑"，所以是 if 而不是三元）
      /if \(gateVisible\.value\) return '运行环境准备';/.test(topBarCode) &&
      /v-if="!gateVisible"/.test(topBarCode) &&
      // 顶栏不许自己去读判定结果（两套显示条件就会漂）
      !/wizard\.value|gatePhase|judgeWizard/.test(topBarCode),
  );
  /**
   * 评审 T11-B：键盘捷径的改道判据必须是「门禁层**接管着**界面」，不是 `gateVisible`。
   *
   * 两者在收尾相位上都会是 false —— 但那是「不该显示」，不是「正在显示」。靠"恰好"成立的东西
   * 会被下一次无关改动打破（谁给某个收尾相位加一种显示，Ctrl+R 就又会被吃掉），而交互 §2.5
   * 写的是「逃生口点了之后恢复」。所以这里钉住两件事：收尾相位**显式放行**，且键盘那一段读的
   * 是这个判据本身。
   */
  const gateDiversionBody = blockOf(appTsCode, 'const gateDiversion = computed(');
  const shortcutBody = blockOf(appTsCode, 'function wireShortcuts(): void');
  check(
    '首启门禁：逃生 / 放行 / 收尾之后键盘捷径恢复（改道判据不是 gateVisible 自己）',
    gateDiversionBody.length > 100 &&
      ['escaped', 'entered', 'done', 'unknown'].every((phase) =>
        gateDiversionBody.includes(`'${phase}'`),
      ) &&
      /if \(gateDiversion\.value\)/.test(shortcutBody) &&
      !/gateVisible\.value/.test(shortcutBody),
  );
  check(
    '安装引擎：不拼 shell（spawn 数组 + launchSpec + 补过 PATH + stdio 数组 + 没有 shell: true）',
    /spawn\(file, args, \{/.test(installerCode) &&
      /envWithKnownBins\(process\.env\)/.test(installerCode) &&
      /stdio: \['ignore', 'pipe', 'pipe'\]/.test(installerCode) &&
      !/shell:\s*true/.test(installerCode) &&
      /launchSpec\(/.test(installerCode) &&
      !/spawn\(\s*'[^']*\.cmd'/.test(installerCode),
  );
  const detachBody = blockOf(installerCode, 'detachOnQuit(): void');
  check(
    '安装引擎：退出时不杀安装器（只有下载 / 校验那一支被取消，安装 / 等待不碰 child）',
    detachBody.length > 40 &&
      !/\.kill\(/.test(detachBody) &&
      ['preparing', 'downloading', 'verifying'].every((phase) =>
        detachBody.includes(`'${phase}'`),
      ) &&
      !/'installing'|'waiting'/.test(detachBody),
  );
  // 计划里那句 `note` 是确认区的风险说明：它**不许**替发布方断言"没有数字签名"
  const installerPlanNotes = [
    ...installerCode.matchAll(/note:\s*(?:'([^']*)'|`([^`]*)`|\[([\s\S]{0,400}?)\])/g),
  ].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
  check(
    '安装引擎：未签名的结论只在读到之后说（计划阶段的 signer === null 不推出未签名）',
    installerCode.length > 1000 &&
      installerPlanNotes.length >= 3 &&
      installerPlanNotes.every((note) => !/没有数字签名|未签名/.test(note)) &&
      // 发布自述来自一个可离线测的纯函数（三档都认），官方直装恒为 unknown
      /export function parseReleaseSigning\(body: string\): 'signed' \| 'unsigned' \| 'unknown'/.test(
        installerCode,
      ) &&
      (installerCode.match(/releaseSigning: 'unknown'/g) ?? []).length >= 2 &&
      /releaseSigning,/.test(installerCode) &&
      // "读到之后"那条路（安装包真没签名）才读 releaseSigning 决定继续还是中止
      /plan\.releaseSigning === 'unsigned'/.test(installerCode),
    `${installerPlanNotes.length} 处 plan.note`,
  );
  // ---------------------------------------------------------- 18a. 向导的视图相位（t43）
  //    冻结 §0.3 的 R-28 ~ R-31：左轨走过的节点可点（回看）、正文画"正在看哪一步"、
  //    判定前进不推人、用户显式重开的那一轮判成 open 也显示放行页。
  //    纯规则在 `gate/wizard-view.ts`（直接测），接线与"回看卡里没有动作"在 EnvGate.vue / env-wizard.ts。
  const stepOf = (id: EnvWizardStepId, status: EnvStepStatus): EnvWizardStep => ({
    id,
    status,
    detail: `${id} 的判据（带路径与版本）`,
    checkIds: [],
    skippable: id === 'pnpm',
    fixAction: null,
  });
  const viewSteps = [stepOf('node', 'done'), stepOf('pnpm', 'done'), stepOf('dsh', 'todo')];
  check(
    '环境向导：左轨只有走过的步骤能点开看（已完成 / 已跳过可以，当前与没轮到的都不行）',
    wizardView.canViewStep(stepOf('node', 'done'), 'dsh') === true &&
      wizardView.canViewStep(stepOf('pnpm', 'skipped'), null) === true &&
      // 当前步骤不给"可看"：点它的意思是回到当前（调用方把钉住清掉），不是钉住它
      wizardView.canViewStep(stepOf('dsh', 'todo'), 'dsh') === false &&
      // 还没轮到的、以及"我们没测出来"的，都不给点
      wizardView.canViewStep(stepOf('pnpm', 'todo'), 'dsh') === false &&
      wizardView.canViewStep(stepOf('dsh', 'unknown'), null) === false,
  );
  check(
    '环境向导：正文画的是钉住的那一步（那一步不再成立时静默回到当前，不停在一条不成立的回看上）',
    wizardView.resolveViewedStep('dsh', 'node', viewSteps) === 'node' &&
      wizardView.resolveViewedStep('dsh', null, viewSteps) === 'dsh' &&
      // 钉住的那一步已经不是"走过的"了（新报告换了状态）→ 回到当前
      wizardView.resolveViewedStep('dsh', 'node', [
        stepOf('node', 'todo'),
        stepOf('pnpm', 'done'),
        stepOf('dsh', 'todo'),
      ]) === 'dsh' &&
      // 那一步从列表里消失（兜底）→ 回到当前
      wizardView.resolveViewedStep('dsh', 'node', [stepOf('dsh', 'todo')]) === 'dsh' &&
      // 三步都完成（判定给的当前步骤是 null）+ 没钉住 → 正文没有步骤可画
      wizardView.resolveViewedStep(null, null, [stepOf('node', 'done')]) === null,
  );
  check(
    '环境向导：判定前进只出一行提示、不把用户推走（两种前进的文案 + 没前进时不出提示）',
    (() => {
      const titles: Record<EnvWizardStepId, string> = {
        node: '安装 Node.js',
        pnpm: '安装 pnpm',
        dsh: '安装 dsh',
      };
      const title = (id: EnvWizardStepId): string => titles[id];
      const next = wizardView.advanceNotice(
        'pnpm',
        { stepId: 'node', currentAtPin: 'node' },
        title,
      );
      const done = wizardView.advanceNotice(null, { stepId: 'node', currentAtPin: 'node' }, title);
      return (
        // 没钉住（第二个参数 null）→ 没有提示
        wizardView.advanceNotice('node', null, title) === null &&
        // **判定没动**也没有提示：用户只是往回翻看，当前步骤原地没动 ——
        // 真机验证抓到的第一版就是拿"正在看的 ≠ 当前"当判据，于是回看第一步时冒出一句
        // 错的「下一步（安装 dsh）也已经就绪了」（dsh 那时还没好）
        wizardView.advanceNotice('dsh', { stepId: 'node', currentAtPin: 'dsh' }, title) === null &&
        // 从**放行页**点开回看（钉住时本来就没有当前步骤）→ 不能与"没钉住"混为一谈，
        // 判定变成已放行时同样要出「三步都完成了」（真机验证抓到的第二处）
        wizardView.advanceNotice(null, { stepId: 'node', currentAtPin: null }, title) === null &&
        // 第一步在完成、判定前进了
        next?.text === '下一步（安装 pnpm）也已经就绪了' &&
        next.action === '继续' &&
        // 三步全部完成：当前步骤成了 null
        done?.text === '三步都完成了' &&
        done.action === '看看结果'
      );
    })(),
    '两种前进',
  );
  const reviewCard = gateRaw.slice(
    gateRaw.indexOf('<div v-if="reviewStep"'),
    gateRaw.indexOf('<div v-else-if="currentStep"'),
  );
  const railButton =
    /<button[\s\S]{0,400}?class="gate-node-body gate-node-button"[\s\S]{0,400}?↩ 回看这一步/.exec(
      gateRaw,
    )?.[0] ?? '';
  check(
    '环境向导：左轨走过的节点是按钮（进 Tab 顺序、aria-current 标出正在看的那一步）',
    railButton.length > 100 &&
      /:aria-current="item\.viewed \? 'true' : undefined"/.test(railButton) &&
      /@click="viewStepFromRail\(item\.id\)"/.test(railButton) &&
      // 没走到的那一支仍然是纯读数（div，不是按钮；保持 R-01 ② 的原意）
      /<div v-else class="gate-node-body">/.test(gateRaw) &&
      // 可点与否来自纯函数，不在模板里手写状态判断
      /viewable: canViewStep\(step, id\)/.test(gateCode),
  );
  check(
    '环境向导：只读回看卡里没有安装 / 跳过动作（回看时屏上仍然只有一件事可做）',
    reviewCard.length > 200 &&
      /reviewStep\.detail/.test(reviewCard) &&
      /@click="backToCurrent"/.test(reviewCard) &&
      !/openNodeConfirm|openFixConfirm|openSkipConfirm|runNodeInstall|runEnvFix|openNodeSwitch|retryFix|skipStep/.test(
        reviewCard,
      ) &&
      // 两句结论都在卡里（已完成 / 你选择了跳过）
      /这一步已经完成，不用再做什么/.test(reviewCard) &&
      /这一步你选择了跳过/.test(reviewCard),
  );
  check(
    '环境向导：判定前进 / 重开后正文不会被推走（回看优先于放行页、新报告不清钉住）',
    // 回看优先于放行页：钉住期间判定即使已经放行，正文也留在回看卡上，点了「看看结果」才进放行页
    /const screen = computed<'checking' \| 'blocked' \| 'released'>\(\(\) => \{[\s\S]{0,300}?if \(reviewStep\.value\) return 'blocked';/.test(
      gateCode,
    ) &&
      // 提示行是唯一的前进入口（不是自动跳）
      /v-if="notice"[\s\S]{0,260}?@click="backToCurrent"/.test(gateCode) &&
      // 新报告进来时**不许**清钉住 —— 清了就等于把用户推走
      !/pinnedStepId/.test(blockOf(wizardSource, 'function applyWizardState(')) &&
      // 挡住页的表头跟着判定说：回看时不能把"已就绪"说成"还没准备好"
      /wizard\?\.gate === 'open' \? '运行环境已经就绪' : '运行环境还没准备好'/.test(gateCode),
  );
  check(
    '环境向导：用户显式重开的那一轮判成 open 也显示放行页（R-31），离开时把这一轮与钉住都清掉',
    (() => {
      const gateVisibleBody = blockOf(wizardSource, 'export const gateVisible');
      const reopenBody = blockOf(wizardSource, 'export function reopenGate(');
      const selectBody = blockOf(wizardSource, 'export function selectViewedStep(');
      return (
        /if \(phase === 'released'\) return blocking \|\| reopened;/.test(gateVisibleBody) &&
        /reopened = true;/.test(reopenBody) &&
        /pinnedStepId\.value = null;/.test(reopenBody) &&
        // 点当前步骤 / 点一个看不动的步骤 → 回来（不是钉住一个不允许看的步骤）；
        // 同时记下"钉住那一刻判定在哪一步"，判定后来往前挪了才出提示（R-30）
        /const viewable = canViewStep\(step, state\.currentStepId\);/.test(selectBody) &&
        /pinnedStepId\.value = viewable \? stepId : null;/.test(selectBody) &&
        /pinnedAtStepId\.value = viewable \? state\.currentStepId : null;/.test(selectBody) &&
        // 没钉住与"钉住时本来就没有当前步骤"分得开：界面拿到的是对象（`activePin`）而不是可空 id
        /export const activePin: ComputedRef<ViewPin \| null> = computed/.test(wizardSource) &&
        // 两个"离开门禁层"的动作都要把「用户要看的那一轮」清掉
        /reopened = false;/.test(blockOf(wizardSource, 'export function escapeGate(')) &&
        /reopened = false;/.test(blockOf(wizardSource, 'export function enterMainUi('))
      );
    })(),
    'R-31',
  );
}
