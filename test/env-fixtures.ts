'use strict';

/**
 * 环境自检 / 环境向导共用的夹具与派生文本。
 *
 * 判定是纯函数，所以这里不需要任何真实环境（这正是把它做成纯函数的理由）：一份"什么都好"的
 * 原始事实，各条断言按需覆盖一两项。这些夹具被后面几组（向导的判定、安装引擎）反复引用，
 * 所以不能留在某一个检查模块里自己读 —— 提成一份，谁要谁取。
 */

import fs from 'node:fs';
import path from 'node:path';

import * as envDoctor from '../src/main/env-doctor';
import type { EnvCheckId, EnvDoctorReport, EnvWizardStepId } from '../src/shared/ipc';

import type { Repo } from './repo';
import { functionBodyOf, stripComments } from './text';

export interface EnvFixtures {
  /** `src/main/env-doctor.ts` 原文 */
  envSource: string;
  /** 同上，剥掉注释 */
  envCode: string;
  /** `judgeEnvironment` 的函数体，剥注释 */
  envJudgeBody: string;
  /** `src/main/main.ts` 原文，剥注释 */
  envMainCode: string;
  /** `panes/EnvPane.vue` 原文，剥注释 */
  envPaneCode: string;
  /** `src/main/node-installer.ts` 原文，剥注释（门禁界面与安装引擎两组都在读） */
  installerCode: string;
  /** `shell/EnvGate.vue` 原文（门禁界面的标记与文案） */
  gateRaw: string;
  /** 同上，剥注释 */
  gateCode: string;
  envVersionProbe(over?: Partial<envDoctor.VersionProbe>): envDoctor.VersionProbe;
  envDshProbe(over?: Partial<envDoctor.DshProbe>): envDoctor.DshProbe;
  envProbe(over?: Partial<envDoctor.EnvProbeRaw>): envDoctor.EnvProbeRaw;
  envCheckOf(report: EnvDoctorReport, id: EnvCheckId): EnvDoctorReport['checks'][number];
  /** 一份"什么都好"的报告（八项全 ok） */
  envAllOk: EnvDoctorReport;
  envIds: EnvCheckId[];
  /** 三个引导步骤（与主进程的 `WIZARD_STEP_IDS` 同一份顺序） */
  envWizardStepIds: EnvWizardStepId[];
  /** 只有 Node 缺失的那份原始事实（救援 / 向导那两组也在用） */
  envNoNode: envDoctor.EnvProbeRaw;
  envNoNodeReport: EnvDoctorReport;
}

export function createEnvFixtures(repo: Repo): EnvFixtures {
  const envSource = fs.readFileSync(path.join(repo.srcDir, 'main', 'env-doctor.ts'), 'utf8');
  const envCode = stripComments(envSource);
  const envJudgeBody = stripComments(functionBodyOf(envSource, 'judgeEnvironment'));
  const envMainCode = stripComments(
    fs.readFileSync(path.join(repo.root, 'src', 'main', 'main.ts'), 'utf8'),
  );
  const envPaneCode = stripComments(
    fs.readFileSync(path.join(repo.rendererDir, 'panes', 'EnvPane.vue'), 'utf8'),
  );
  const installerCode = stripComments(
    fs.readFileSync(path.join(repo.srcDir, 'main', 'node-installer.ts'), 'utf8'),
  );
  const gateRaw = fs.readFileSync(path.join(repo.rendererDir, 'shell', 'EnvGate.vue'), 'utf8');
  const gateCode = stripComments(gateRaw);

  // 夹具：一份"什么都好"的原始事实，各条断言按需覆盖一两项。
  const envVersionProbe = (over: Partial<envDoctor.VersionProbe> = {}): envDoctor.VersionProbe => ({
    path: '/opt/homebrew/bin/node',
    version: 'v24.19.0',
    exitCode: 0,
    error: null,
    ...over,
  });
  const envDshProbe = (over: Partial<envDoctor.DshProbe> = {}): envDoctor.DshProbe => ({
    kind: 'node-bin',
    display: '/opt/homebrew/bin/node /usr/local/lib/bin.js',
    runs: true,
    version: '0.5.3',
    exitCode: 0,
    error: null,
    resolveError: null,
    ...over,
  });
  const envProbe = (over: Partial<envDoctor.EnvProbeRaw> = {}): envDoctor.EnvProbeRaw => ({
    checkedAt: 0,
    platform: 'darwin',
    packaged: true,
    bundled: { electron: '44.3.0', node: '24.19.0', chrome: '140.0.0' },
    node: envVersionProbe(),
    npm: envVersionProbe({ path: '/opt/homebrew/bin/npm', version: '10.9.0' }),
    pnpm: envVersionProbe({ path: '/opt/homebrew/bin/pnpm', version: '9.15.0' }),
    dsh: envDshProbe(),
    shell: { file: '/bin/zsh', exists: true },
    error: null,
    ...over,
  });
  const envCheckOf = (report: EnvDoctorReport, id: EnvCheckId) =>
    report.checks.find((item) => item.id === id) ?? {
      id,
      status: 'missing' as const,
      detail: '',
      fixHint: null,
      fixAction: null,
    };

  const envAllOk = envDoctor.judgeEnvironment(envProbe());
  const envIds: EnvCheckId[] = [
    'node',
    'node-version',
    'npm',
    'pnpm',
    'dsh',
    'dsh-run',
    'bundled-runtime',
    'shell',
  ];
  const envWizardStepIds: EnvWizardStepId[] = ['node', 'pnpm', 'dsh'];
  const envNoNode = envProbe({
    node: envVersionProbe({ path: null, version: null, exitCode: null }),
  });
  const envNoNodeReport = envDoctor.judgeEnvironment(envNoNode);

  return {
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
    envNoNode,
    envNoNodeReport,
  };
}
