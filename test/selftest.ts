'use strict';

/**
 * 主进程逻辑自检（不需要 Electron、不会启动/结束任何进程）。
 * 运行：npm test
 *
 * 覆盖：
 *   1. dsh 启动命令解析（node + bin.js / shim / npx 三级回退，按平台判定）
 *   2. ANSI 清理 + 从 dsh 横幅里提取带令牌的 URL
 *   3. HTTP 健康探测的 dsh 判据（真实探测本机端口 + 纯函数夹具）
 *   4. 端口占用解析（Windows 的 netstat / macOS·Linux 的 lsof 夹具 + 可选的真实查询）
 *   5. DshManager 状态机（外部实例接管判定）
 *   6. 渲染层静态检查（含 macOS 的平台适配契约）
 *   7. 主题取值、发布：CHANGELOG 条目与 changeset 片段的汇总规则
 *   8. 自动更新契约（不自动下载 / 安装、macOS 与开发态不加载 electron-updater）
 */

import path from 'node:path';
import fs from 'node:fs';

import * as processUtils from '../src/main/process-utils';
import * as envDoctor from '../src/main/env-doctor';
// 渲染层的纯逻辑（`lib/**` 与 selftest 同属「契约与编排」那一层，见 AGENTS §2 的模块边界）
import * as wizardView from '../src/renderer/lib/wizard-view';
import * as nodeInstaller from '../src/main/node-installer';
import type {
  EnvCheckId,
  EnvCheckStatus,
  EnvDoctorReport,
  EnvNodeOwner,
  EnvStepStatus,
  EnvWizardState,
  EnvWizardStep,
  EnvWizardStepId,
} from '../src/shared/ipc';

import { check, report } from './harness';
import { createEnvFixtures } from './env-fixtures';
import { createRepo } from './repo';
import { blockOf, functionBodyOf, methodSliceOf, stripComments, stripStrings } from './text';
import { runLaunch } from './checks/launch';
import { runRenderer } from './checks/renderer';
import { runStyles } from './checks/styles';
import { runEnvDoctor } from './checks/env-doctor';
import { runPlugin } from './checks/plugin';
import { runRelease } from './checks/release';

async function main(): Promise<void> {
  const repo = createRepo();
  const settings = repo.settings;

  await runLaunch(repo);

  const { srcDir, rendererDir, html, rendererCode, mountJs, cssBlock } = repo;
  const cssText = repo.css;

  runRenderer(repo);
  runStyles(repo);

  // 后面几组还要用的仓库事实（package.json / ipc.ts / 渲染层源码），统一从 repo 取
  const repoRoot = repo.root;
  const ipcSource = repo.ipcSource;
  const flatIpc = repo.flatIpc;

  await runRelease(repo);

  runPlugin(repo);

  // 环境自检 / 环境向导共用的夹具与文本工具（原先定义在下面，现在提成 test/env-fixtures.ts）
  const {
    envSource,
    envCode,
    envJudgeBody,
    envMainCode,
    envPaneCode,
    envVersionProbe,
    envDshProbe,
    envProbe,
    envCheckOf,
    envAllOk,
    envIds,
    envWizardStepIds,
    envNoNodeReport,
  } = createEnvFixtures(repo);

  runEnvDoctor(repo);

  // ---------------------------------------------------------- 17. 首启环境向导（门禁）
  //    冻结文档 §3.8 里归"契约与编排"的那些断言。判定是纯函数，所以全部是夹具 + 静态文本检查：
  //    不装 Node、不起任何进程、不碰网络。
  const wizardSource = stripComments(
    fs.readFileSync(path.join(rendererDir, 'lib', 'env-wizard.ts'), 'utf8'),
  );
  const bootLockSource = stripComments(
    fs.readFileSync(path.join(rendererDir, 'lib', 'boot-lock.ts'), 'utf8'),
  );
  const preloadCode = stripComments(
    fs.readFileSync(path.join(srcDir, 'preload', 'preload.ts'), 'utf8'),
  );
  const appTsCode = stripComments(fs.readFileSync(path.join(rendererDir, 'app.ts'), 'utf8'));

  // ---------------------------------------------------------- 17b. VM-07 的渲染层半边（t31）
  //    修完（复检报告随 `env:fix-state` 落进 `envFix`）之后，**门禁的步骤状态**是另一条读法
  //    （`env:wizard`）。少了这一步，用户装完 pnpm 之后第二步仍然停在「待办」上，只能重开应用。
  check(
    '环境自检（VM-07）：复检报告一到，渲染层就重拉一次门禁结论（不必重开应用）',
    // 盯的是共享状态 `envFix`（由 lib/env-doctor.ts 那一个订阅者写），而不是自己再订一次 IPC
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
    '环境向导：契约增量都在（新联合成员 / 7 个 API / 两个设置项 / ipc.ts 仍然零 import）',
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
        // 契约零 import：只放类型与纯常量（渲染层要读这些类型，拖进 fs/path 就会被卷进包里）
        !/^\s*import\s/m.test(ipcSource) &&
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
        // 渲染层不许绕开 preload：lib/** 与 app.ts 里没有 ipcRenderer
        !/ipcRenderer/.test(rendererCode)
      );
    })(),
  );
  check(
    '环境向导：全局互斥（env:fix 与 env:node-install 读同一个忙位，两个动作不同时改机器）',
    /function anyoneBusy\(\): boolean \{[\s\S]{0,120}?return envFixRunner\.busy \|\| nodeInstaller\.busy\(\);/.test(
      envMainCode,
    ) &&
      (envMainCode.match(/envFixRunner\.busy \|\| nodeInstaller\.busy\(\)/g) ?? []).length === 1 &&
      /if \(anyoneBusy\(\)\) \{[\s\S]{0,160}?phase: 'error', message: BUSY_MESSAGE/.test(
        envMainCode,
      ) &&
      (envMainCode.match(/if \(anyoneBusy\(\)\)/g) ?? []).length === 2 &&
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
      const envDoctorSource = fs.readFileSync(path.join(srcDir, 'main', 'env-doctor.ts'), 'utf8');
      return (
        owners.length === 1 &&
        owners[0] === path.join(srcDir, 'main', 'env-doctor.ts') &&
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
    /catch \(error\) \{[\s\S]{0,400}?return refusedInstallState\(message\);/.test(envMainCode) &&
      /if \(!parsed\)[\s\S]{0,40}?return refusedInstallState\(/.test(envMainCode) &&
      /refusedInstallState\(\s*'不认识的操作/.test(envMainCode) &&
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
      const guardBody = blockOf(envMainCode, 'function wizardSkips(): EnvWizardStepId[]');
      return (
        guardBody.length > 40 &&
        /Array\.isArray\(value\) \? \(value as EnvWizardStepId\[\]\) : \[\]/.test(guardBody) &&
        // 只有这一处读设置里的 envSkips（别的调用点都得过这道守卫）
        (envMainCode.match(/settings\.get\('envSkips'\)/g) ?? []).length === 1 &&
        (envMainCode.match(/wizardSkips\(\)/g) ?? []).length >= 3
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
        stripComments(fs.readFileSync(path.join(rendererDir, 'lib', 'env-wizard.ts'), 'utf8')),
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
  const gateCode = stripComments(
    fs.readFileSync(path.join(rendererDir, 'shell', 'EnvGate.vue'), 'utf8'),
  );
  const gateRaw = fs.readFileSync(path.join(rendererDir, 'shell', 'EnvGate.vue'), 'utf8');
  const topBarCode = stripComments(
    fs.readFileSync(path.join(rendererDir, 'shell', 'TopBar.vue'), 'utf8'),
  );
  const installerCode = stripComments(
    fs.readFileSync(path.join(srcDir, 'main', 'node-installer.ts'), 'utf8'),
  );
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
  check(
    '首启门禁：门禁层不是页面（TAB_ORDER 与 panes 清单里都没有它，容器与启动锁同级）',
    tabOrderBody.length > 0 &&
      !/gate/i.test(tabOrderBody) &&
      !/panes\/[\w]*Gate/i.test(mountJs) &&
      !/id="pane-gate"/.test(html) &&
      /from '\.\/shell\/EnvGate\.vue'/.test(mountJs) &&
      /from '\.\/shell\/GateBanner\.vue'/.test(mountJs) &&
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
  //    纯规则在 `lib/wizard-view.ts`（直接测），接线与"回看卡里没有动作"在 EnvGate.vue / env-wizard.ts。
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
  // ---------------------------------------------------------- 18b. 提权那一次（F-02 / F-03）
  //    都是**真调用**纯函数（不是源码正则）：四种结果分开判 + 三种失败各自的文案/出路 +
  //    "装完必须实测可用"的那把尺。行为覆盖的在真机之外能钉到这里为止（UAC 本身只有真机能验）。
  const elevationProbe = (
    over: Partial<nodeInstaller.ElevationProbe>,
  ): nodeInstaller.ElevationProbe => ({
    code: null,
    stdout: '',
    stderr: '',
    error: null,
    timedOut: false,
    ...over,
  });
  check(
    '安装引擎：提权的四种结果分开判（等太久最先判，不与"用户没允许"混）',
    nodeInstaller.classifyElevationOutcome(
      elevationProbe({ code: 0, stdout: '{"ExitCode":0}' }),
    ) === 'ok' &&
      nodeInstaller.classifyElevationOutcome(
        elevationProbe({
          code: 1,
          stderr: 'This operation was canceled by the user.',
        }),
      ) === 'declined' &&
      nodeInstaller.classifyElevationOutcome(elevationProbe({ timedOut: true })) === 'timeout' &&
      nodeInstaller.classifyElevationOutcome(elevationProbe({ code: 1, stdout: 'boom' })) ===
        'failed' &&
      // 超时**优先**于其它信号：先判 timedOut 才不会被"取消/失败"的文本抢走
      nodeInstaller.classifyElevationOutcome(
        elevationProbe({
          timedOut: true,
          code: 1,
          stderr: 'This operation was canceled by the user.',
        }),
      ) === 'timeout',
  );
  check(
    '安装引擎：三种没成功的提权结果各有自己的类别与出路，超时**不**复用"没权限"的文案',
    (() => {
      const timeout = nodeInstaller.elevationFailure('timeout');
      const declined = nodeInstaller.elevationFailure('declined');
      const failed = nodeInstaller.elevationFailure('failed');
      const kinds: string[] = [timeout.kind, declined.kind, failed.kind];
      return (
        timeout.kind === 'elevation-timeout' &&
        timeout.message.includes('权限询问等太久') &&
        timeout.message.includes('可能仍在系统里进行') &&
        Boolean(timeout.hint) &&
        declined.kind === 'elevation-declined' &&
        declined.message.includes('没有允许') &&
        failed.kind === 'elevation-failed' &&
        // 三条互不相同，而且超时那条不许是 symlink（"等太久"≠"没权限"：F-02 第 1 条）
        new Set(kinds).size === 3 &&
        !kinds.includes('symlink') &&
        timeout.message !== declined.message &&
        declined.message !== failed.message
      );
    })(),
  );
  check(
    '安装引擎：等太久之后先按"未确定"发布、再事实复检（复检用 node --version 那把尺）',
    (() => {
      // `blockOf` 取的是"锚点之后第一个 `{` 起的配对块"，而这两个方法的返回类型里也有 `{}`，
      // 所以这里按**下一个类成员**为界切整段（含签名）。
      const methodSlice = (source: string, anchor: string): string => {
        const start = source.indexOf(anchor);
        if (start < 0) return '';
        const rest = source.slice(start + anchor.length);
        const next = /\n {2}(?:private|public|async|readonly|[a-zA-Z]+\()/.exec(rest);
        return rest.slice(0, next ? next.index : rest.length);
      };
      const settleBody = methodSlice(installerCode, 'private async settleElevationTimeout(');
      const recheckBody = methodSlice(installerCode, 'private recheckActiveNodeLanded(): boolean');
      const waitBody = methodSlice(installerCode, 'private async runElevated(');
      return (
        settleBody.length > 200 &&
        // 先发"未确定"（waiting + detached），再复检
        /publish\('waiting'/.test(settleBody) &&
        settleBody.indexOf("publish('waiting'") < settleBody.indexOf('recheckActiveNodeLanded()') &&
        /detached: true/.test(settleBody) &&
        // 复检证明落地 → 改口（按"已经落地"继续）
        /recheckActiveNodeLanded\(\)[\s\S]{0,400}kind: 'ok'/.test(settleBody) &&
        // 进程还在跑 → 保持未确定；进程结束且没建起来 → 才报 timeout
        /this\.child !== null[\s\S]{0,200}kind: 'stopped'/.test(settleBody) &&
        /kind: 'timeout'/.test(settleBody) &&
        // 复检用的是"有没有版本号"这把统一的尺
        /hasNodeVersionOutput\(/.test(recheckBody) &&
        /refreshProcessPathFromSystem\(\)/.test(recheckBody) &&
        // 提权那一步是异步的、且状态先于起进程（F-03）
        waitBody.includes('waitForClose(child, ELEVATED_TIMEOUT_MS') &&
        waitBody.indexOf('publish(') < waitBody.indexOf('spawnSpec(') &&
        !/spawnSync|runProbe\(/.test(waitBody) &&
        /elevate/.test(installerCode)
      );
    })(),
  );
  check(
    '安装引擎："装完必须实测可用"用的是同一把尺（node / npm 的版本号输出）',
    nodeInstaller.hasNodeVersionOutput('v24.21.0\n') &&
      nodeInstaller.hasNodeVersionOutput('24.21.0') &&
      !nodeInstaller.hasNodeVersionOutput('') &&
      // VM 实测那句是在"没有 active version"时出现的 —— 所以**不许**被当成可用。
      !nodeInstaller.hasNodeVersionOutput(
        'No active Node.js version is configured. Run `nvm install <version>` then `nvm use <version>`.',
      ) &&
      // 同一条判据还要能认出来这句话的那一半（v2 的 shim 原文，VM-11 逐字）
      nodeInstaller.isInactiveNodeShimOutput(
        'No active Node.js version is configured. Run `nvm install <version>` then `nvm use <version>`.',
      ) &&
      !nodeInstaller.isInactiveNodeShimOutput('v24.21.0'),
  );
  // ---------------------------------------------------------- 18c. nvm v2 的真实模型（VM-11 / VM-12）
  //    夹具来自客机的**实测环境**（船长用 guestcontrol 取的原文/结构）：
  //    nvm v2.0.0 装在 `…\Local\Author Software\nvm`、shim 模式、`NVM_HOME`/`NVM_SYMLINK` **不存在**。
  //    用户 PATH 里有 `<root>` 和 `<root>\.nodejs`、`nvm list` 是 `No versions installed.`。
  //    那条"界面报的路径" `…\Local\Software\nvm\nodejs\node.exe` 实测不存在（exit 3）。
  //    `nvm env` 的整段是按官方文档的两种真实排版重建的（客机那份是分节版；我们没拿到逐字字节），
  //    所以这里标**重建**，而 npm 原文 / nvm list 原文 / 路径判定都是**逐字**的）。
  const guestRoot = 'C:\\Users\\tester\\AppData\\Local\\Author Software\\nvm';
  const guestPath = [
    'C:\\Users\\tester\\AppData\\Local\\Programs\\Python\\Python312\\Scripts\\',
    guestRoot,
    `${guestRoot}\\.nodejs`,
    'C:\\Windows\\system32',
  ].join(';');
  const guestRealFiles = new Set([
    `${guestRoot}\\nvm.exe`,
    `${guestRoot}\\.nodejs\\node.exe`,
    `${guestRoot}\\.nodejs\\npm.cmd`,
    `${guestRoot}\\.nodejs\\npx.cmd`,
  ]);
  const guestEnv = { Path: guestPath, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const guestNvmEnvText = [
    'NVM For Windows',
    'Computer',
    '  Windows            : 11',
    '  Administrator      : No',
    '  Developer Mode     : Disabled',
    'Installation',
    '  Version            : v2.0.0',
    `  Path               : ${guestRoot}`,
    'Version Management',
    '  Status             : on',
    '  Operating Mode     : shim',
    'Installed Versions',
    '  Total              : 0 (0 MB)',
    '  Default            : not set',
    `  Path               : ${guestRoot}\\installs`,
    'Download Sources',
    '  Node.js            : https://nodejs.org/dist',
    '  npm                : https://registry.npmjs.org (unreachable)',
  ].join('\n');
  check(
    '安装引擎：`nvm env` 的两种真实排版都认（分节的客机报告 + 官方样例），两个 Path 不混',
    (() => {
      const sectioned = nodeInstaller.parseNvmEnvOutput(guestNvmEnvText);
      const flat = nodeInstaller.parseNvmEnvOutput(
        [
          'NVM For Windows',
          '├─ Version            : v2.0.0-alpha.1',
          '├─ Status             : on',
          '├─ Operating Mode     : shim',
          '└─ Installed Versions : 4',
        ].join('\n'),
      );
      return (
        sectioned.version === 'v2.0.0' &&
        sectioned.status === 'on' &&
        sectioned.mode === 'shim' &&
        sectioned.versionsTotal === 0 &&
        sectioned.defaultVersion === null &&
        sectioned.installsDir === `${guestRoot}\\installs` &&
        sectioned.programRoot === guestRoot &&
        sectioned.nodeMirror === 'https://nodejs.org/dist' &&
        sectioned.npmMirror === 'https://registry.npmjs.org (unreachable)' &&
        flat.version === 'v2.0.0-alpha.1' &&
        flat.versionsTotal === 4 &&
        // 扁平样例里没有版本目录，不许把别的东西塞进去
        flat.installsDir === null
      );
    })(),
  );
  check(
    '安装引擎：`nvm list` 的 v2 单行形状也认（星号是 active + 空格分开的一串）',
    (() => {
      const v2 = nodeInstaller.parseNvmListOutput('* 24.1.0    (default)  22.14.0  20.19.1');
      const v1 = nodeInstaller.parseNvmListOutput(
        ['      24.21.0', '    * 22.12.0 (Currently using 64-bit executable)'].join('\n'),
      );
      const empty = nodeInstaller.parseNvmListOutput('No versions installed.');
      return (
        JSON.stringify(v2) ===
          JSON.stringify({ versions: ['24.1.0', '22.14.0', '20.19.1'], active: '24.1.0' }) &&
        JSON.stringify(v1) ===
          JSON.stringify({ versions: ['24.21.0', '22.12.0'], active: '22.12.0' }) &&
        JSON.stringify(empty) === JSON.stringify({ versions: [], active: null })
      );
    })(),
  );
  check(
    '安装引擎：v2 的模型从**真实证据**推（不依赖 NVM_HOME / NVM_SYMLINK）',
    (() => {
      const model = nodeInstaller.deriveNvmModel({
        exe: `${guestRoot}\\nvm.exe`,
        env: guestEnv,
        report: nodeInstaller.parseNvmEnvOutput(guestNvmEnvText),
        pathDirs: guestPath.split(';'),
        exists: (file: string) => guestRealFiles.has(file),
      });
      // v1 风格机器：真有 NVM_HOME / NVM_SYMLINK 时按真的那套来（不写死排斥）
      const v1Root = 'D:\\Nvm\\nvm';
      const v1 = nodeInstaller.deriveNvmModel({
        exe: null,
        env: {
          NVM_HOME: v1Root,
          NVM_SYMLINK: 'D:\\Node\\nodejs',
          Path: `${v1Root};D:\\Node\\nodejs`,
        },
        report: null,
        pathDirs: [v1Root, 'D:\\Node\\nodejs'],
        exists: (file: string) =>
          file === `${v1Root}\\nvm.exe` || file === 'D:\\Node\\nodejs\\node.exe',
      });
      const none = nodeInstaller.deriveNvmModel({
        exe: null,
        env: {},
        report: null,
        pathDirs: [],
        exists: () => false,
      });
      return (
        model !== null &&
        model.root === guestRoot &&
        model.mode === 'shim' &&
        model.installsDir === `${guestRoot}\\installs` &&
        model.activeDir === `${guestRoot}\\.nodejs` &&
        // 证据链要留得下来（日志里就是它）
        model.evidence.length >= 3 &&
        v1 !== null &&
        v1.root === v1Root &&
        v1.activeDir === 'D:\\Node\\nodejs' &&
        (v1.mode === 'shim') === false &&
        none === null
      );
    })(),
  );
  check(
    '安装引擎：v2 的注册表偏好（`HKCU\\Software\\<发布商>\\Preferences\\nvm`）按真根目录推键名并解析',
    (() => {
      const key = nodeInstaller.nvmPreferenceKey(guestRoot);
      const parsed = nodeInstaller.parseNvmRegistryPreferences(
        [
          'HKEY_CURRENT_USER\\Software\\Author Software\\Preferences\\nvm',
          '    Enabled              REG_DWORD    0x1',
          '    InstallRoot          REG_SZ       ' + guestRoot + '\\installs',
          '    ActiveVersion        REG_SZ       not set',
          '    OperatingMode        REG_SZ       shim',
        ].join('\r\n'),
      );
      return (
        key === 'HKCU\\Software\\Author Software\\Preferences\\nvm' &&
        parsed.installsDir === `${guestRoot}\\installs` &&
        parsed.mode === 'shim' &&
        parsed.status === 'on' &&
        parsed.defaultVersion === null
      );
    })(),
  );
  check(
    '安装引擎：nvm 的每一步都留证据（命令 / 退出码 / stdout / stderr，空的那路写「（空）」）',
    (() => {
      const installSlice = methodSliceOf(installerCode, 'private async installNodeWithNvm(');
      const runSlice = methodSliceOf(installerCode, 'private async runNvmCommand(');
      return (
        /parseNvmInstallOutput\(installed\.tail\)/.test(installSlice) &&
        // 装完还要回清单核对（"命令跑过了"不算数）
        /readNvmList\(model\.exe, extra\)/.test(installSlice) &&
        /正在进行|正在让它下载并安装 Node\.js/.test(installSlice) &&
        // 每条命令都走 logNvmStep（含 stdout/stderr 分开收）
        /private logNvmStep\(/.test(installerCode) &&
        /stdout：\$\{show\(stdout\)\}；stderr：\$\{show\(stderr\)\}/.test(installerCode) &&
        /outRef\.text = \(outRef\.text \+ text\)/.test(runSlice) &&
        /errRef\.text = \(errRef\.text \+ text\)/.test(runSlice) &&
        /logNvmStep\(name, args, outcome\.code, outRef\.text, errRef\.text\)/.test(runSlice)
      );
    })(),
  );
  check(
    '安装引擎：应用**自己装版本**（选版本 → nvm install → nvm use → 实测），不把用户打发去终端',
    (() => {
      const installSlice = methodSliceOf(installerCode, 'private async installNodeWithNvm(');
      return (
        /if \(!alreadyInstalled\)/.test(installSlice) &&
        /\['install', versionArg\]/.test(installSlice) &&
        /useNvmVersion\(model, versionArg/.test(installSlice) &&
        /verifyActiveNode\(plan, model\)/.test(installSlice) &&
        // 没有"让用户自己去终端"这条路：提示语里不许出现"自己打开终端"
        !/自己打开终端|到终端里去/.test(installerCode)
      );
    })(),
  );
  check(
    '安装引擎：shim 模式（v2）不请求提权（官方说明：shim 无符号链接、不需要管理员）',
    (() => {
      const useSlice = methodSliceOf(installerCode, 'private async useNvmVersion(');
      return (
        /model\.mode === 'shim'/.test(useSlice) &&
        // shim 那条分支必须在 runElevated 之前（先看模式，再决定要不要弹 UAC）
        useSlice.indexOf("model.mode === 'shim'") < useSlice.indexOf('await this.runElevated(') &&
        /不请求提权/.test(useSlice)
      );
    })(),
  );
  // 客机那条"界面报的路径"不在磁盘上 —— 绝不能被返回
  const vmGuessed = 'C:\\Users\\tester\\AppData\\Local\\Software\\nvm\\nodejs\\node.exe';
  const vmFound = envDoctor.findNodePathWindows(guestEnv, 'C:\\Users\\tester', (file) =>
    guestRealFiles.has(file),
  );
  const vmNothing = envDoctor.findNodePathWindows(
    { Path: `C:\\Users\\tester\\AppData\\Local\\Software\\nvm\\nodejs`, PATHEXT: '.EXE' },
    'C:\\Users\\tester',
    (file) => guestRealFiles.has(file),
  );
  // 候选目录里必须包含 v2 的 `.nodejs`（从 PATH 里那个 `…\nvm` 推出来）
  const vmCandidates = processUtils.windowsBinCandidates(guestEnv, 'C:\\Users\\tester');
  const vmFoundText: string = vmFound ?? '';
  check(
    '首启门禁：界面上报的 node 路径一定是探测到的真路径（VM-12）',
    vmFound === `${guestRoot}\\.nodejs\\node.exe` &&
      // 客机那条"界面报的路径"（不存在的推测路径）绝不能被返回
      vmFoundText !== vmGuessed &&
      // 只有一条不存在的 PATH 目录时：返回 null（不是那条路径）
      vmNothing === null &&
      vmCandidates.includes(`${guestRoot}\\.nodejs`) &&
      !vmCandidates.includes(vmGuessed),
    `found=${vmFound} nothing=${vmNothing} candidates=${vmCandidates.join(' | ')}`,
  );
  check(
    '首启门禁：界面词表里不出现内部术语（模板与文案，注释不算）',
    (() => {
      const templateOf = (source: string): string =>
        (/<template>([\s\S]*)<\/template>\s*(?:<script|$)/.exec(source)?.[1] ?? '').replace(
          /<!--[\s\S]*?-->/g,
          '',
        );
      const copy =
        [
          gateRaw,
          fs.readFileSync(path.join(rendererDir, 'shell', 'GateBanner.vue'), 'utf8'),
          fs.readFileSync(path.join(rendererDir, 'shell', 'TopBar.vue'), 'utf8'),
        ]
          .map(templateOf)
          .join('\n') +
        templateOf(fs.readFileSync(path.join(rendererDir, 'panes', 'EnvPane.vue'), 'utf8')) +
        html.replace(/<!--[\s\S]*?-->/g, '');
      const forbidden = [
        'EnvCheckId',
        'EnvFixPlan',
        'judgeEnvironment',
        'probe',
        'verbatim',
        'COMSPEC',
        'NVM_SYMLINK',
        'SHASUMS256',
        'sha256:',
        'PATH',
      ];
      return copy.length > 5000 && forbidden.every((word) => !copy.includes(word));
    })(),
  );
  check(
    '首启门禁：新增 5 个变量全是主题无关的尺度值，门禁样式没有字面色值，浅色四色 == R-04 冻结值',
    (() => {
      const wizardVars: [string, string][] = [
        ['--z-gate', '58'],
        ['--wizard-read', '620px'],
        ['--wizard-card', '760px'],
        ['--wizard-rail-dot', '14px'],
        ['--dur-screen', '220ms'],
      ];
      const rootBody = cssBlock(':root');
      const lightBody = cssBlock(":root[data-theme='light']");
      const gateRules = cssText.match(/\.gate-[\w-]*[^{]*\{[^}]*\}/g) ?? [];
      const gateZ = Number(/--z-gate:\s*(\d+)/.exec(rootBody)?.[1] || 0);
      const bootLockZ = Number(/z-index:\s*(\d+)/.exec(cssBlock('.boot-lock'))?.[1] || 0);
      return (
        wizardVars.every(
          ([name, value]) => rootBody.includes(`${name}: ${value};`) && !lightBody.includes(name),
        ) &&
        ['#047857', '#0369a1', '#be123c', '#92400e'].every((color) => lightBody.includes(color)) &&
        gateRules.length > 20 &&
        gateRules.every((rule) => !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(rule)) &&
        // 门禁层压在启动锁下面（R-08：万一交接的那一帧，也是锁盖住门禁）
        gateZ > 0 &&
        gateZ < bootLockZ
      );
    })(),
  );

  // ---------------------------------------------------------- 18d. t29：归属 → 方法、档位跟随、换档显式（VM-14 / VM-15）
  //    需求 §7.7 / §7.8 / §8.5 的判据全部落在安装引擎的两个**纯函数**上：
  //    `detectNodeOwner`（这份 Node 归谁管）与 `decideNodePlan`（目标方法 + 目标档位 + 是不是换档）。
  //    所以这一节是离线夹具：不装 Node、不起进程、不碰网络（VM-14 与 VM-15 的现场都是真机，
  //    但判据必须能在任何平台上被反例钉住 —— 这正是把它们做成纯函数的理由）。
  const nodeReleaseEntry = (
    version: string,
    lts: string | false,
  ): nodeInstaller.NodeReleaseEntry => ({ version, lts, files: [] });
  /** 一份像真的官方清单（新版本在前）：v26.9.0 与 v25.8.0 是当前版，v24.21.0 是稳定版 */
  const nodeReleaseList = [
    nodeReleaseEntry('v26.9.0', false),
    nodeReleaseEntry('v25.8.0', false),
    nodeReleaseEntry('v24.21.0', 'krypton'),
  ];
  const GUEST_NVM_ROOT = 'C:\\Users\\tester\\AppData\\Local\\Author Software\\nvm';
  const guestNvmModel: nodeInstaller.NvmModel = {
    exe: `${GUEST_NVM_ROOT}\\nvm.exe`,
    root: GUEST_NVM_ROOT,
    mode: 'shim',
    installsDir: `${GUEST_NVM_ROOT}\\installs`,
    activeDir: `${GUEST_NVM_ROOT}\\.nodejs`,
    evidence: [`夹具：模型根目录 ${GUEST_NVM_ROOT}`],
  };
  const nodeOwnerOf = (input: {
    nodePath: string | null;
    env: NodeJS.ProcessEnv;
    model: nodeInstaller.NvmModel | null;
    msiInstallPath: string | null;
  }): { owner: EnvNodeOwner; evidence: string[] } => nodeInstaller.detectNodeOwner(input);
  /** 归属判定的四类输入（§7.7 的判据表）：每一类都必须有确定结论 */
  const ownerNvmShim = nodeOwnerOf({
    nodePath: `${GUEST_NVM_ROOT}\\installs\\v26.9.0\\node.exe`,
    env: {},
    model: guestNvmModel,
    msiInstallPath: null,
  });
  const ownerNvmShimDir = nodeOwnerOf({
    nodePath: `${GUEST_NVM_ROOT}\\.nodejs\\node.exe`,
    env: {},
    model: guestNvmModel,
    msiInstallPath: null,
  });
  const ownerNvmLinkV1 = nodeOwnerOf({
    nodePath: 'D:\\tools\\node-v20\\node.exe',
    env: { NVM_SYMLINK: 'D:\\tools\\node-v20' },
    model: null,
    msiInstallPath: null,
  });
  const ownerNvmFromPathVariable = nodeOwnerOf({
    nodePath: 'C:\\Tools\\Nvm\\v20.11.0\\node.exe',
    env: {},
    model: null,
    msiInstallPath: null,
  });
  const ownerSystemDefaultPlace = nodeOwnerOf({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    env: { ProgramFiles: 'C:\\Program Files' },
    model: null,
    msiInstallPath: null,
  });
  const ownerSystemFromMsiInstallPath = nodeOwnerOf({
    nodePath: 'E:\\custom-nodejs\\node.exe',
    env: { ProgramFiles: 'C:\\Program Files' },
    model: null,
    msiInstallPath: 'E:\\custom-nodejs',
  });
  const ownerUnknownVolta = nodeOwnerOf({
    nodePath: 'C:\\Users\\tester\\.volta\\bin\\node.exe',
    env: {},
    model: null,
    msiInstallPath: null,
  });
  const ownerUnknownNvmTools = nodeOwnerOf({
    // N4c 那条判据继续成立：`nvm-tools` 不是"独立的 nvm 目录名"（VM-14 的机器上就有这个名字）
    nodePath: 'D:\\nvm-tools\\node.exe',
    env: {},
    model: null,
    msiInstallPath: null,
  });
  const ownerUnknownNoNode = nodeOwnerOf({
    nodePath: null,
    env: {},
    model: null,
    msiInstallPath: null,
  });
  check(
    '安装引擎（VM-14）：归属判定四类输入各有一个确定结论（v2 shim / v1 link / 系统直装 / 未知）',
    ownerNvmShim.owner === 'nvm' &&
      ownerNvmShim.evidence.length > 0 &&
      ownerNvmShimDir.owner === 'nvm' &&
      ownerNvmLinkV1.owner === 'nvm' &&
      ownerNvmFromPathVariable.owner === 'nvm' &&
      ownerSystemDefaultPlace.owner === 'system' &&
      ownerSystemFromMsiInstallPath.owner === 'system' &&
      ownerUnknownVolta.owner === 'unknown' &&
      ownerUnknownNvmTools.owner === 'unknown' &&
      ownerUnknownNoNode.owner === 'unknown' &&
      // 证据要能对账（评审看的就是这几行）
      ownerUnknownNvmTools.evidence.length > 0,
  );

  const decide = (
    over: Partial<Parameters<typeof nodeInstaller.decideNodePlan>[0]>,
  ): nodeInstaller.NodePlanDecision =>
    nodeInstaller.decideNodePlan({
      mode: 'install',
      owner: 'unknown',
      nvmPresent: false,
      nodeFound: false,
      currentVersion: null,
      releases: nodeReleaseList,
      elevated: false,
      ...over,
    });
  const decideNvmUpdate = decide({
    mode: 'update',
    owner: 'nvm',
    nvmPresent: true,
    nodeFound: true,
    currentVersion: 'v26.9.0',
  });
  const decideSystemUpdate = decide({
    mode: 'update',
    owner: 'system',
    nvmPresent: false,
    nodeFound: true,
    currentVersion: 'v24.21.0',
  });
  const decideUnknownFound = decide({ mode: 'install', owner: 'unknown', nodeFound: true });
  const decideUnknownNothingWithNvm = decide({
    mode: 'install',
    owner: 'unknown',
    nvmPresent: true,
    nodeFound: false,
  });
  const decideUnknownNothingBare = decide({
    mode: 'install',
    owner: 'unknown',
    nvmPresent: false,
    nodeFound: false,
  });
  check(
    '安装引擎（VM-14）：方法跟随归属（nvm → nvm 且不重装管理器 / system → 官方直装 / 未知不默默直装）',
    decideNvmUpdate.method === 'nvm' &&
      // 「机器上已经有可辨认的版本管理器时不再装它一遍」（冻结 §3.2.1 的 installsManager）
      decideNvmUpdate.installsManager === false &&
      decideSystemUpdate.method === 'direct' &&
      decideSystemUpdate.installsManager === true &&
      // 归属未知 + 找到了一份 Node：**不预选**（界面两条路都列、一条都不选），计划不给「开始」
      decideUnknownFound.needChoice === 'choose-method' &&
      decideUnknownFound.refuse !== null &&
      // 一份都没找到：有事实支撑的默认（有管理器就用它，否则官方直装）—— 但仍要写出方法
      decideUnknownNothingWithNvm.method === 'nvm' &&
      decideUnknownNothingWithNvm.installsManager === false &&
      decideUnknownNothingBare.method === 'direct' &&
      decideUnknownNothingBare.refuse === null,
  );
  const decideCurrentFollow = decide({
    mode: 'update',
    owner: 'nvm',
    nvmPresent: true,
    nodeFound: true,
    currentVersion: 'v26.9.0',
  });
  const decideLtsFollow = decide({
    mode: 'update',
    owner: 'system',
    nvmPresent: false,
    nodeFound: true,
    currentVersion: 'v24.21.0',
  });
  const decideExplicitSwitchToLts = decide({
    mode: 'update',
    owner: 'nvm',
    nvmPresent: true,
    nodeFound: true,
    currentVersion: 'v26.9.0',
    requestChannel: 'lts',
  });
  const decideInstallDefault = decide({
    mode: 'install',
    owner: 'system',
    nvmPresent: false,
    nodeFound: true,
    currentVersion: 'v26.9.0',
  });
  check(
    '安装引擎（VM-15）：更新的目标档位跟随当前档位（current→current、lts→lts），install 才用设计默认',
    // 当前 v26.9.0（清单里 lts: false）→ 当前档 = current，目标也落在 current 那条，且不是降级
    decideCurrentFollow.currentChannel === 'current' &&
      decideCurrentFollow.channel === 'current' &&
      decideCurrentFollow.release?.version === 'v26.9.0' &&
      decideCurrentFollow.switchesChannel === false &&
      decideCurrentFollow.direction !== 'older' &&
      // 当前 v24.21.0（清单里 lts 非 false）→ 稳定档
      decideLtsFollow.currentChannel === 'lts' &&
      decideLtsFollow.channel === 'lts' &&
      decideLtsFollow.release?.version === 'v24.21.0' &&
      decideLtsFollow.switchesChannel === false &&
      // 「换档」只可能由**显式**给的档位产生：current → lts 就是一次降档，必须说得出"这是换档"
      decideExplicitSwitchToLts.channel === 'lts' &&
      decideExplicitSwitchToLts.switchesChannel === true &&
      decideExplicitSwitchToLts.direction === 'older' &&
      // install 的设计默认仍然是「最新稳定版」
      decideInstallDefault.channel === 'lts',
  );
  const decideChannelUnknown = decide({
    mode: 'update',
    owner: 'system',
    nvmPresent: false,
    nodeFound: true,
    // 装了清单里没有的版本 → 档位**判不出来**（不许按版本号大小猜）
    currentVersion: 'v21.0.0',
  });
  const decideOlderFromSwitch = decideExplicitSwitchToLts;
  const decideSameChannel = decideCurrentFollow;
  check(
    '安装引擎（VM-15）：档位判不出来时让用户显式选档；direction=older ⟹ 这是换档（四条约定②）',
    decideChannelUnknown.currentChannel === null &&
      decideChannelUnknown.needChoice === 'choose-channel' &&
      decideChannelUnknown.refuse !== null &&
      // 判不出来时不挑目标版本（没有可以显示成"目标"的东西）
      decideChannelUnknown.release === null &&
      decideChannelUnknown.direction === null &&
      // 约定①：needChoice ⟹ 不给「开始」（计划层的 usable === false）
      [decideUnknownFound, decideChannelUnknown].every(
        (item) => item.needChoice !== null && item.refuse !== null,
      ) &&
      // 约定②：direction === 'older' ⟹ switchesChannel（"更新"永不降级）
      [decideUnknownFound, decideChannelUnknown, decideOlderFromSwitch, decideSameChannel].every(
        (item) => item.direction !== 'older' || item.switchesChannel,
      ),
  );
  /**
   * r2（t9）：`switchesChannel` 现在在**所有**分支上算，并按构造保证
   * `direction === 'older' ⟹ switchesChannel === true`。
   *
   * 为什么必须包含 `install` 的设计默认：装了**当前版**的机器上点「安装 / 换一个 Node」
   * （`mode: 'install'`，设计默认 lts）就是一次跨档 —— 目标是**更低**的稳定版，
   * 界面必须说得出「换成稳定版 / 版本从 vX 降到 vY」。旧实现只在"显式给了 channel"
   * 那条分支上算，于是这条可达路径上 `direction === 'older'` 而 `switchesChannel === false`：
   * 两个界面都拿不到"这是换档"的事实，用户看到的就是一次没有解释的降级（VM-15 的另一半）。
   */
  check(
    '安装引擎（VM-15，r2）：install + 已装 current → switchesChannel=true 且 direction=older（界面据此说得出「降到」）',
    decideInstallDefault.switchesChannel === true &&
      decideInstallDefault.direction === 'older' &&
      decideInstallDefault.currentChannel === 'current' &&
      decideInstallDefault.channel === 'lts' &&
      decideInstallDefault.release?.version === 'v24.21.0' &&
      // 反向：同档跟随与判不出档位都不许被误报成"换档"
      decideCurrentFollow.switchesChannel === false &&
      decideLtsFollow.switchesChannel === false &&
      decideChannelUnknown.switchesChannel === false &&
      // 约定②的无条件形式：枚举一批组合，`older` 必须**总是**伴随"这是换档"
      [
        decideInstallDefault,
        decideExplicitSwitchToLts,
        decideCurrentFollow,
        decideLtsFollow,
        decideChannelUnknown,
        decideUnknownFound,
      ].every((item) => item.direction !== 'older' || item.switchesChannel),
  );
  const decideNvmExplicitDirectNotElevated = decide({
    mode: 'update',
    owner: 'nvm',
    nvmPresent: true,
    nodeFound: true,
    currentVersion: 'v26.9.0',
    requestMethod: 'direct',
  });
  const decideNvmExplicitDirectElevated = decide({
    mode: 'update',
    owner: 'nvm',
    nvmPresent: true,
    nodeFound: true,
    currentVersion: 'v26.9.0',
    requestMethod: 'direct',
    elevated: true,
  });
  const decideSystemExplicitNvm = decide({
    mode: 'update',
    owner: 'system',
    nvmPresent: true,
    nodeFound: true,
    currentVersion: 'v24.21.0',
    requestMethod: 'nvm',
  });
  const decideUnknownExplicitDirect = decide({
    mode: 'install',
    owner: 'unknown',
    nodeFound: true,
    requestMethod: 'direct',
  });
  check(
    '安装引擎（VM-14）：归属已知时另一条路只有 §7.8 的两个例外（显式点名 + 并存风险那句话）',
    // 归属 = nvm 且不是提权态：不许用官方安装包再装一份（那正是 VM-14 的现场）
    decideNvmExplicitDirectNotElevated.refuse !== null &&
      // 一次只问一件事：这次挡住它的是"方法不对"，不该同时再叠一个"去选档位"
      decideNvmExplicitDirectNotElevated.needChoice === null &&
      // 例外③：提权态下 nvm 那条路走不了（R-23）→ 用户显式点名才放行，并带上并存风险
      decideNvmExplicitDirectElevated.refuse === null &&
      decideNvmExplicitDirectElevated.coexistWarning === nodeInstaller.NODE_COEXIST_WARNING &&
      // 例外②：归属 = system 时用户显式改走版本管理器 → 同样带并存风险
      decideSystemExplicitNvm.refuse === null &&
      decideSystemExplicitNvm.coexistWarning === nodeInstaller.NODE_COEXIST_WARNING &&
      // 例外①：归属未知时由用户显式点名 → 带并存风险
      decideUnknownExplicitDirect.coexistWarning === nodeInstaller.NODE_COEXIST_WARNING &&
      // 跟随归属那一路**不带**这句话（只有例外才说两份并存）
      decideNvmUpdate.coexistWarning === null &&
      decideSystemUpdate.coexistWarning === null,
  );

  /**
   * `decideNodePlan` 的函数体：它的参数表里就有一个 `{`（`input: { … }`），
   * 所以不能用 `blockOf`（它取锚点之后第一个 `{`，那会切到**类型**里去）。
   * 从返回类型那一行之后切到下一个顶层 `export`。
   */
  const decidePureCode = (() => {
    const start = installerCode.indexOf('export function decideNodePlan(');
    if (start < 0) return '';
    const rest = installerCode.slice(start);
    const bodyStart = rest.indexOf('): NodePlanDecision {');
    if (bodyStart < 0) return '';
    const end = rest.indexOf('\nexport ', bodyStart);
    return stripStrings(rest.slice(bodyStart, end < 0 ? rest.length : end));
  })();
  check(
    '安装引擎：归属与档位的判定只在两个纯函数里（decideNodePlan 没有 fs / 子进程 / process.* / 时钟）',
    decidePureCode.length > 500 &&
      !/\bfs\./.test(decidePureCode) &&
      !/\bspawn|\bexecFile|\bexecSync|\bspawnSync/.test(decidePureCode) &&
      !/process\.env|process\.platform/.test(decidePureCode) &&
      !/Date\.now|\bnew Date\b/.test(decidePureCode),
    `${decidePureCode.length} 字符`,
  );
  check(
    '安装引擎（VM-14）：归属判据只有一份（采集侧与安装计划调同一个导出，渲染层不自己猜）',
    /export function detectNodeOwner\(/.test(installerCode) &&
      /detectNodeOwner\(/.test(envCode) &&
      /deriveNvmModelFromEnvironment\(/.test(envCode) &&
      !/detectNodeOwner/.test(rendererCode) &&
      // 主进程里没有第二处"路径像不像 nvm"的判断（那会与判据漂移）
      (installerCode.match(/export function detectNodeOwner\(/g) ?? []).length === 1,
  );
  check(
    '安装引擎（VM-15）：主进程不再把 lts 当默认档位（省略档位 = 跟随当前档，只有跨档才算换档）',
    // 旧实现那一行（`request.channel === 'current' ? 'current' : 'lts'`）必须已经消失
    !/request\.channel === 'current' \? 'current' : 'lts'/.test(installerCode) &&
      /decideNodePlan\(\{/.test(installerCode) &&
      /else if \(input\.mode === 'update'\)/.test(installerCode) &&
      /channel = currentChannel;/.test(installerCode) &&
      // r2（t9）：换档在**所有**分支上算，且 `older` 本身就是一次换档（按构造保证约定②）
      /const switchesChannel =\s*\n?\s*direction === 'older' \|\| \(currentChannel !== null && channel !== currentChannel\);/.test(
        installerCode,
      ),
  );
  /**
   * r2（t9）：`stopDshForUpdate()` **全仓库恰好一处**，而且在 `execute()` 里、`mode === 'update'`
   * 时**无条件**执行 —— 「更新会先停掉正在运行的 dsh」是确认区上写着的承诺（§8.3 / 交互 §10.5 第 7 条）。
   *
   * 旧实现把它放在 `installPhase()` 的开头，而"机器上已经有可辨认的版本管理器"
   * （`installsManager === false`）那条路**整个跳过**安装阶段 → 用户点"更新"时那句承诺 quietly 落空。
   * 现在两条路（官方直装 / nvm，含不下载管理器的那条）都在同一个地方停**一次**；
   * 调用点只有这一处，所以"停两次"在结构上不可能。
   *
   * 为什么这条是静态的：真跑一次 `run()` 需要有真 nvm / 真 dsh 在跑（沙箱里没有），
   * 而"恰好一次"在这里正好等价于"只有一个调用点、且两条路都经过它"。
   */
  const executeSlice = methodSliceOf(installerCode, 'private async execute(');
  const installPhaseSlice = methodSliceOf(installerCode, 'private async installPhase(');
  check(
    '安装引擎（r2）：更新前停 dsh 恰好一次（两条路都在 execute 里停，installPhase 不再停）',
    (installerCode.match(/this\.stopDshForUpdate\(\)/g) ?? []).length === 1 &&
      /if \(plan\.mode === 'update'\) await this\.stopDshForUpdate\(\);/.test(executeSlice) &&
      !/stopDshForUpdate/.test(installPhaseSlice) &&
      // 必须在任何系统改动之前：下载 / 校验 / 装管理器 / nvm install 都在它后面
      executeSlice.indexOf('await this.stopDshForUpdate()') <
        executeSlice.indexOf('await this.transferPhase(plan)') &&
      executeSlice.indexOf('await this.stopDshForUpdate()') <
        executeSlice.indexOf('await this.installNodeWithNvm(plan)'),
  );
  check(
    't29 契约增量：EnvNodeOwner 三成员 / 报告与计划与状态的新字段 / 请求 method 可选（ipc.ts 仍然零 import）',
    (() => {
      const ownerUnion = /export type EnvNodeOwner =([\s\S]*?);/.exec(flatIpc)?.[1] ?? '';
      const members = [...ownerUnion.matchAll(/'([^']+)'/g)].map((match) => match[1]);
      return (
        members.length === 3 &&
        ['nvm', 'system', 'unknown'].every((name) => members.includes(name)) &&
        !/^\s*import\s/m.test(ipcSource) &&
        /nodeOwner: EnvNodeOwner;/.test(ipcSource) &&
        /nodeOwnerEvidence: string\[\];/.test(ipcSource) &&
        /export interface EnvNodePlan \{/.test(ipcSource) &&
        [
          /owner: EnvNodeOwner;/,
          /nvmPresent: boolean;/,
          /currentVersion: string \| null;/,
          /currentChannel: EnvNodeChannel \| null;/,
          /switchesChannel: boolean;/,
          /direction: 'newer' \| 'same' \| 'older' \| null;/,
          /needChoice: 'choose-method' \| 'choose-channel' \| null;/,
          /installsManager: boolean;/,
        ].every((pattern) => pattern.test(ipcSource)) &&
        /plan: EnvNodePlan \| null;/.test(ipcSource) &&
        /observedVersion: string \| null;/.test(ipcSource) &&
        // 请求形状：method 变成可选（两处 API 各一次）—— 省略 = 跟随归属
        (ipcSource.match(/method\?: EnvNodeMethod;/g) ?? []).length >= 2 &&
        /export interface EnvNodeRequest \{/.test(ipcSource)
      );
    })(),
  );
  check(
    '环境自检页（VM-14 / VM-15）：更新入口不写死方法，档位不写死字面量（默认跟随、显式才换档）',
    // 船长裁定（t29）：冻结 §3.2.1④ 那句「EnvPane 不许出现 channel:」与
    // 需求 §8.5 第 3 条「当前档位判不出来时要让用户显式选一档」互相矛盾 ——
    // 后者为准：**默认不传档位**（跟随当前档），**只有用户显式选档才传**（那才是换档）。
    // 所以这条断言盯的是"不许写死默认"，不是"不许出现 channel"。
    envPaneCode.length > 1000 &&
      // VM-14 的直接成因：写死 `method: 'direct'`
      !/method:\s*'direct'/.test(envPaneCode) &&
      // 档位不许写死成字面量（跟随当前档 = 参数里根本没有 channel）
      !/channel:\s*'(lts|current)'/.test(envPaneCode) &&
      // 入口还在（别把断言写成"这个文件里什么都搜不到"）
      /loadNodePlan\(/.test(envPaneCode) &&
      /runNodeInstall\(/.test(envPaneCode),
  );
  check(
    '安装引擎（VM-14）：nvm 那条路的机器上不再装管理器（installsManager=false 时跳过下载与校验两段）',
    /if \(!plan\.installsManager\)/.test(installerCode) &&
      // 跳过时连下载与校验两段都不进（"没有任何东西要下载"）
      /这台电脑上已经有可辨认的版本管理器：这次不下载、不校验/.test(installerCode) &&
      // 那条路仍然要做完四步：nvm install → nvm list 核对 → nvm use → 实测（判据复用 verifyActiveNode）
      /if \(plan\.method === 'nvm'\) \{/.test(installerCode) &&
      /verifyActiveNode\(plan, model\)/.test(installerCode) &&
      // 管理器已经在时 `url` 指向发布页（不是我们会去下载的地址），sha256 为 null 是正常的
      /display: `nvm install \$\{versionArg\}`/.test(installerCode),
  );

  report();
}

main().catch((error) => {
  console.error('自检异常：', error);
  process.exitCode = 1;
});
