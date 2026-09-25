'use strict';

/**
 * 自检第 18b~18d 与安装引擎：提权、nvm 的真实模型、归属与档位。
 *
 * 这一组全是纯函数 / 静态文本断言（真跑一次安装要有真 nvm、真要提权，沙箱里没有）。
 *
 * 整段从 `test/selftest.ts` 的 `main()` 里搬出来，行为一字未改 —— 搬完的证据是自检输出
 * 逐行一致（314 条同名、同值、同顺序）；夹具与源码文本由 `test/env-fixtures.ts` 提供。
 */

import fs from 'node:fs';
import path from 'node:path';

import * as envDoctor from '../../src/main/env-doctor';
import * as nodeInstaller from '../../src/main/node-installer';
import * as processUtils from '../../src/main/process-utils';
import type { EnvNodeOwner } from '../../src/shared/ipc';

import { createEnvFixtures } from '../env-fixtures';
import { check } from '../harness';
import type { Repo } from '../repo';
import { methodSliceOf, stripStrings } from '../text';

export function runInstallEngine(repo: Repo): void {
  const f = createEnvFixtures(repo);
  const { envCode, envPaneCode, installerCode, gateRaw } = f;
  const rendererDir = repo.rendererDir;
  const flatIpc = repo.flatIpc;
  const ipcSource = repo.ipcSource;
  const rendererCode = repo.rendererCode;
  const html = repo.html;
  const cssBlock = repo.cssBlock;
  const cssText = repo.css;
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
}
