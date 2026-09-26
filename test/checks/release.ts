'use strict';

/**
 * 自检第 8~15 组：发布链路、自动更新契约与打包约定。
 *
 * 覆盖 CHANGELOG 与版本号对齐、changeset 片段的汇总规则、Release 标题与正文的生成、
 * 自动更新的边界（不偷偷下载 / 不偷偷安装 / macOS 的分支）、启动早期的日志与兜底、
 * 产物命名与更新源、自动全屏的前提、macOS 版本检查、依赖归属与包体积、更新卡片的分平台文案。
 *
 * 整段从 `test/selftest.ts` 的 `main()` 里搬出来，行为一字未改 —— 搬完的证据是自检输出
 * 逐行一致（314 条同名、同值、同顺序）；`package.json` / `ipc.ts` 那份文本由 `repo` 提供
 * （后面几千行的段落还要用同一份，所以不能留在这里自己读）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { DEFAULTS } from '../../src/main/settings';
import { RELEASES_URL, UPDATE_MAC_FEED_URL } from '../../src/shared/ipc';

import { check } from '../harness';
import type { Repo } from '../repo';

export async function runRelease(repo: Repo): Promise<void> {
  const repoRoot = repo.root;
  const pkg = repo.pkg;
  const ipcSource = repo.ipcSource;
  const flatIpc = repo.flatIpc;
  const rendererDir = repo.rendererDir;
  const rendererJs = repo.rendererJs;
  const uiPaneSource = repo.uiPaneSource;

  // ---------------------------------------------------------- 8. 发布：CHANGELOG 与版本号对齐
  //    发版时 Release 正文是按版本号从 CHANGELOG.md 里取的（tools/changelog-extract.mts）。
  //    忘了写条目的话，CI 会红在最后那个 publish job —— 这里提前到构建阶段就拦住，
  //    两个 build job 都会先失败，不会出现"包打好了才发现没说明"。
  // 读不到就给空串：下面的断言会以"缺条目"的形式失败，比在这里抛异常更好读
  const changelogPath = path.join(repoRoot, 'CHANGELOG.md');
  const changelogText = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
  // 动态 import：提取逻辑只此一份，不在自检里再抄一遍正则。
  // 这里写 .mjs（而不是 .mts）：NodeNext 与 tsx 都会把这个标识符解析到同名的 .mts 源码，
  // 而 .mjs 才是"工具最终以 ESM 运行"时它真实的名字。
  const { extractChangelog } = await import('../../tools/changelog-extract.mjs');
  const section = extractChangelog(changelogText, pkg.version);
  check(
    `发布：CHANGELOG.md 有当前版本 ${pkg.version} 的条目`,
    Boolean(section && section.trim()),
    section ? section.split('\n')[0] : '缺条目 —— 发版前先在 CHANGELOG.md 里写这一版',
  );

  // ---------------------------------------------------------- 9. 发布片段（changesets）
  //    CHANGELOG 不再手写：每条改动写一个 .changeset/*.md 片段，发版前由 tools/release-prepare.mts
  //    汇总成 `## [x.y.z] - YYYY-MM-DD` 的条目。汇总脚本万一算错版本号或写歪标题，
  //    坏掉的是 Release 正文 —— 所以这里把它的纯函数逐个钉住。
  const releaseTools = await import('../../tools/release-prepare.mjs');

  check(
    '发布片段：版本号规则与 changesets 一致（0.2.2 + patch / minor / major）',
    releaseTools.incrementVersion('0.2.2', 'patch') === '0.2.3' &&
      releaseTools.incrementVersion('0.2.2', 'minor') === '0.3.0' &&
      releaseTools.incrementVersion('0.2.2', 'major') === '1.0.0',
  );
  check(
    '发布片段：多个片段时取最高一级',
    releaseTools.pickBump(['patch', 'major', 'minor']) === 'major' &&
      releaseTools.pickBump(['patch', 'patch']) === 'patch',
  );
  const parsedFragment = releaseTools.parseFragment(
    "---\n'dsh-console': minor\n---\n\n### 小节\n\n正文\n",
    'dsh-console',
  );
  check(
    '发布片段：能解析 front matter 与正文（小节结构原样保留）',
    parsedFragment?.type === 'minor' && parsedFragment.body === '### 小节\n\n正文',
  );
  check(
    '发布片段：空片段（changeset add --empty）不算本包的改动',
    releaseTools.parseFragment('---\n---\n', 'dsh-console') === null,
  );
  const releaseEntry = releaseTools.buildEntry('0.2.3', '2026-09-17', [
    { file: 'a.md', type: 'patch', body: '一条改动' },
  ]);
  check(
    '发布片段：条目是 `## [x.y.z] - 日期`（提取脚本认的形状）',
    releaseEntry === '## [0.2.3] - 2026-09-17\n\n一条改动',
    releaseEntry.split('\n')[0],
  );
  const insertedEntry = releaseTools.insertEntry(
    '# Changelog\n\n## [Unreleased]\n\n## [0.2.2] - 2026-09-16\n\n旧条目\n',
    releaseEntry,
  );
  check(
    '发布片段：新条目插在 Unreleased 之后、上一个版本之前',
    insertedEntry.indexOf('## [Unreleased]') < insertedEntry.indexOf('一条改动') &&
      insertedEntry.indexOf('一条改动') < insertedEntry.indexOf('## [0.2.2]'),
  );
  check(
    '发布片段：改版本号只动 "version" 那一行，package.json 其余部分逐字节不变',
    releaseTools.replaceVersion('{\n  "name": "x",\n  "version": "0.2.2"\n}\n', '0.3.0') ===
      '{\n  "name": "x",\n  "version": "0.3.0"\n}\n',
  );
  // 配置里必须留着 changelog: false —— 打开它 changesets 就会自己写 `## x.y.z` 这种
  // 没有方括号与日期的标题，与提取脚本的契约不符（见 tools/release-prepare.mts 顶部说明）。
  const changesetConfig = JSON.parse(
    fs.readFileSync(path.join(repoRoot, '.changeset/config.json'), 'utf8'),
  ) as { changelog?: unknown; privatePackages?: { version?: unknown } };
  check(
    '发布片段：.changeset/config.json 关掉了 changesets 自带的 CHANGELOG 生成',
    changesetConfig.changelog === false,
    `changelog=${JSON.stringify(changesetConfig.changelog)}`,
  );
  check(
    '发布片段：私有包也要能被改版本号（privatePackages.version）',
    changesetConfig.privatePackages?.version === true,
  );

  // ---------------------------------------------------------- 10. Release 的标题与正文
  //    publish job 用 tools/release-notes.mts 生成标题与正文：标题 = `v<版本>: <主题>`（主题
  //    写在 CHANGELOG 标题行里），正文里的安装表来自**真实产物清单**。这两块最容易在改标题
  //    格式、改产物名、或换 electron-builder 之后悄悄跑偏 —— 而跑偏的代价是发出去的 Release
  //    让人下错文件（v0.2.0 就是说明里让下、页面上没有），所以全部钉住。
  const releaseNotes = await import('../../tools/release-notes.mjs');
  const sampleAssets = [
    'DSH.Console.Setup.0.3.0.exe',
    'DSH.Console.0.3.0.exe',
    'DSH.Console-0.3.0-arm64.dmg',
    'DSH.Console-0.3.0.dmg',
    'DSH.Console-0.3.0.zip',
    'DSH.Console.0.3.0.exe.blockmap',
    'latest.yml',
  ];

  check(
    '发布正文：标题 = `v<版本>: <主题>`，主题取自 CHANGELOG 标题行',
    releaseNotes.releaseTitle(
      '0.3.0',
      releaseNotes.extractTopic('## [0.3.0] - 2026-09-17: TypeScript 迁移'),
    ) === 'v0.3.0: TypeScript 迁移',
  );
  check(
    '发布正文：没写主题时标题退化成 v<版本>；早期条目的 `——` 也认',
    releaseNotes.extractTopic('## [0.3.0] - 2026-09-17') === null &&
      releaseNotes.releaseTitle('0.3.0', null) === 'v0.3.0' &&
      releaseNotes.extractTopic('## [0.2.2] - 2026-09-16 —— 归档会话页') === '归档会话页',
  );

  const classified = releaseNotes.classifyAssets(sampleAssets);
  check(
    '发布正文：四类核心产物都认得出来，zip 与更新器元数据分列',
    classified.missing.length === 0 &&
      classified.downloads.length === 5 &&
      classified.metadata.length === 2,
    classified.downloads.map((item: { label: string }) => item.label).join(' / '),
  );
  check(
    '发布正文：缺 Windows 产物时判为"不该发"（v0.2.0 就是缺了这两个）',
    releaseNotes.classifyAssets(['DSH.Console-0.3.0-arm64.dmg', 'DSH.Console-0.3.0.dmg']).missing
      .length === 2,
  );

  const composed = releaseNotes.composeReleaseNotes({
    version: '0.3.0',
    topic: 'TypeScript 迁移',
    entry: '## [0.3.0] - 2026-09-17: TypeScript 迁移\n\n一条改动',
    assets: sampleAssets,
  });
  check(
    '发布正文：H1 写版本与主题、不留重复的二级标题行、安装表点名真实文件',
    composed.startsWith('# DSH Console v0.3.0: TypeScript 迁移') &&
      !composed.includes('## [0.3.0]') &&
      composed.includes('`DSH.Console.Setup.0.3.0.exe`') &&
      composed.includes('## 安装'),
  );
  let assetGateThrew = false;
  try {
    releaseNotes.composeReleaseNotes({
      version: '0.3.0',
      topic: null,
      entry: '## [0.3.0] - 2026-09-17\n\n一条改动',
      assets: ['DSH.Console-0.3.0.dmg'],
    });
  } catch {
    assetGateThrew = true;
  }
  check('发布正文：产物不全时直接抛错，不会默默发出', assetGateThrew);

  // ---------------------------------------------------------- 11. 自动更新契约
  //     electron-updater 接上了 GitHub Releases 的 latest.yml。三条最容易静默失效的边界：
  //     不会偷偷下载 / 偷偷安装；macOS 是 ad-hoc 签名（Squirrel.Mac 会拒绝安装）所以不更新；
  //     开发态没有 app-update.yml 所以连 electron-updater 都不加载。
  // 类型声明会被 Prettier 折行，所以先把空白压平再匹配
  check(
    '自动更新：契约里有 7 个相位、UpdateState 字段与 4 个 API',
    /export type UpdatePhase = 'idle' \| 'checking' \| 'available' \| 'downloading' \| 'downloaded' \| 'error' \| 'unsupported';/.test(
      flatIpc,
    ) &&
      /export interface UpdateState \{/.test(flatIpc) &&
      /canAutoUpdate: boolean;/.test(flatIpc) &&
      /releasesUrl: string;/.test(flatIpc) &&
      /checkForUpdates: \(\) => Promise<UpdateState>;/.test(flatIpc) &&
      /downloadUpdate: \(\) => Promise<UpdateState>;/.test(flatIpc) &&
      /installUpdate: \(\) => Promise<boolean>;/.test(flatIpc) &&
      /onUpdateState: \(handler: \(state: UpdateState\) => void\) => \(\) => void;/.test(flatIpc),
  );
  check(
    '自动更新：autoCheckUpdates 在契约与 DEFAULTS 两处一致（默认开）',
    /autoCheckUpdates: boolean;/.test(flatIpc) && DEFAULTS.autoCheckUpdates === true,
    `DEFAULTS.autoCheckUpdates=${JSON.stringify(DEFAULTS.autoCheckUpdates)}`,
  );

  const updaterSource = fs.readFileSync(path.join(repoRoot, 'src', 'main', 'updater.ts'), 'utf8');
  // 只看代码不看注释：文件头与行内注释为了解释原因会反复提到这些名字，当真值去查会误报
  const updaterCode = updaterSource.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  check(
    '自动更新：不会偷偷下载 / 偷偷安装（autoDownload 与 autoInstallOnAppQuit 都写死 false）',
    /autoDownload = false/.test(updaterCode) && /autoInstallOnAppQuit = false/.test(updaterCode),
  );
  check(
    '自动更新：macOS 分支存在（ad-hoc 签名 → 能查、不能自动装，引导去下载页）',
    /process\.platform === 'darwin'/.test(updaterCode) &&
      /ad-hoc 签名/.test(updaterCode) &&
      /canAutoUpdate: false/.test(updaterCode) &&
      /canCheck: true/.test(updaterCode) &&
      /releasesUrl/.test(updaterCode),
  );
  check(
    '自动更新：未打包时不加载 electron-updater（没有顶层 import，只按需 require）',
    /!app\.isPackaged/.test(updaterCode) &&
      /开发态不检查更新/.test(updaterCode) &&
      /createRequire/.test(updaterCode) &&
      !/^import\s*\{[^}]*\}\s*from\s*'electron-updater'/m.test(updaterSource),
  );

  // 关闭询问改成渲染层自己画的卡片（`shell/CloseDialog.vue`）之后，多了两处**只会静默坏掉**的点：
  //   1. 渲染层没接住时必须退回原生弹窗 —— 不然渲染层一卡，窗口就再也关不掉了。
  //      注意**只给握手设时限**：卡片显示出来之后就不能再计时，否则用户多想两秒都会被判成
  //      "卡住"，系统弹窗自己冒出来（第一版就是这么错的）；
  //   2. 真正退出（托盘菜单 / 自动更新的 quitAndInstall / 系统关机）都走 before-quit，
  //      那里**先**置 isQuitting，close 处理器才敢放行 —— 不置位的话「收起」会把退出一起拦下来。
  // 两条都是"只有用户撞上才发现"的类型，所以在这里钉住（同 7.19 的说明）。
  // t56/t57 起 main.ts 拆出了几个簇（主题 / 内嵌页诊断 / 菜单 / 外链 / 崩溃兜底）：
  // 这些钉子钉的是"主进程入口那一组"的形状，所以读整份。
  const mainCloseCode = repo.mainSource.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  check(
    '关闭询问：只给"卡片显示出来"设时限（用户想多久都行），且真正退出不被拦',
    /const CLOSE_ACK_TIMEOUT_MS = \d+;/.test(mainCloseCode) &&
      /ack: \(\) => clearTimeout\(handshake\)/.test(mainCloseCode) &&
      /sendToRenderer\('app:close-request', null\);/.test(mainCloseCode) &&
      /askCloseActionNative\(\);/.test(mainCloseCode) &&
      /app\.on\('before-quit'[\s\S]{0,200}?isQuitting = true;/.test(mainCloseCode),
  );

  // ---------------------------------------------------------- 10a-2. 外链
  //   真机弹过「DSH Console 出错了（未处理的 Promise 拒绝）：Error: No application found to open URL」：
  //   在内嵌的 DSH 界面里点一个文件引用（`dsh-resource://…`），guest 的 window open handler 把**任何**
  //   URL 都丢给 `shell.openExternal`，而它的返回值被 `void` 丢掉 —— 一次 reject 就顶成全局未处理拒绝。
  //   钉两件事：三处入口（主窗口、内嵌页、渲染层 IPC）共用一个 helper，不再有裸调用；
  //   且 helper 自己既守 scheme 白名单、又接住失败。
  check(
    '外链：三处入口共用一个 helper（scheme 白名单 + 接住 openExternal 的失败）',
    // 定义一处（t57 起住在 main-url.ts）+ 三处调用都走同一个 helper；
    // 裸的 shell.openExternal( 全组只剩 helper 里那一处
    /async function openExternalSafely\(url: string, from: string\): Promise<boolean>/.test(
      mainCloseCode,
    ) &&
      (mainCloseCode.match(/shell\.openExternal\(/g) || []).length === 1 &&
      (mainCloseCode.match(/\.openExternalSafely\(/g) || []).length === 3 &&
      !/void shell\.openExternal\(/.test(mainCloseCode) &&
      !/await shell\.openExternal\(target\)/.test(mainCloseCode) &&
      /const EXTERNAL_URL_SCHEMES = new Set\(\['http:', 'https:', 'mailto:'\]\)/.test(
        mainCloseCode,
      ) &&
      /await shell\.openExternal\(url\);[\s\S]{0,120}?catch/.test(mainCloseCode),
  );

  // ---------------------------------------------------------- 10b. 启动早期：日志与兜底
  //    §7.24 的由来：真机上"双击没反应、过一会系统报崩溃"，而日志里一行都没有 —— 分不清
  //    "进程没起来"和"起来了但没到 ready"。所以钉四件事：ready 之前就落一行启动记录、
  //    拿不到单实例锁时**同步**记一行并立刻退出、未捕获异常落盘并弹带日志路径的框、
  //    以及那个"立刻落盘"的原语真的是同步的（缓冲流那份会被 app.exit 丢掉）。
  //    四条都是静态检查：真机行为要在打包后跑一次（见 §7.24「哪条自检守着」）。
  check(
    '启动早期：ready 之前就落一行启动记录（版本 / 平台 / 是否打包 / userData）',
    /fileLog\.writeLine\(/.test(mainCloseCode) &&
      // 位置即语义：必须在 whenReady 之前
      mainCloseCode.indexOf('fileLog.writeLine(') < mainCloseCode.indexOf('app.whenReady()') &&
      /app\.getVersion\(\)/.test(mainCloseCode) &&
      /process\.platform/.test(mainCloseCode) &&
      /process\.versions\.electron/.test(mainCloseCode),
  );
  check(
    '启动早期：拿不到单实例锁时同步记一行、并立刻 exit（不再留一个没窗口的进程）',
    /if \(!gotLock\) \{[\s\S]{0,400}?fileLog\.writeLine\(/.test(mainCloseCode) &&
      /if \(!gotLock\) \{[\s\S]{0,700}?app\.exit\(0\);/.test(mainCloseCode) &&
      // 这一条正是修掉的那个坑：ready 之前 quit 不保证真的退（会变成"没有响应"）。
      // 窗口收紧到 300：再往后就是 window-all-closed 里那个**正当**的 app.quit()
      !/if \(!gotLock\) \{[\s\S]{0,300}?app\.quit\(\)/.test(mainCloseCode),
  );
  check(
    '启动早期：未捕获异常 / 未处理的 Promise 拒绝都落盘，并弹带日志路径的框',
    /process\.on\('uncaughtException'/.test(mainCloseCode) &&
      /process\.on\('unhandledRejection'/.test(mainCloseCode) &&
      // showErrorBox 是官方文档写明"可以在 ready 之前安全调用"的那个 API
      /dialog\.showErrorBox\([\s\S]{0,120}?describeValue\(value\)/.test(mainCloseCode) &&
      /日志文件（把下面这段内容发出来就能定位）/.test(mainCloseCode) &&
      // 记录之后不退出（与 Electron 默认行为一致：硬退会把"还能用一半"变成"完全不能用"）
      !/uncaughtException'[\s\S]{0,500}?process\.exit\(/.test(mainCloseCode),
  );
  const loggerCode = fs
    .readFileSync(path.join(repoRoot, 'src', 'main', 'logger.ts'), 'utf8')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  check(
    '启动早期：writeLine 是同步落盘、没文件时仍打到终端，且日志流出错不带走主进程',
    /writeLine: \(line: string\) => void;/.test(loggerCode) &&
      /appendFileSync\(file/.test(loggerCode) &&
      // 日志文件没建成时不能静默：至少保持"这一行看得见"
      /file: '', writeLine: \(line: string\) => console\.log\(line\)/.test(loggerCode) &&
      // WriteStream 的 error 没人接 = 未捕获异常（实测：删掉日志目录，整个 node 进程当场退出）
      /stream\.on\('error'/.test(loggerCode) &&
      /streamAlive = false;/.test(loggerCode) &&
      /if \(!streamAlive\) return;/.test(loggerCode),
  );

  // ---------------------------------------------------------- 11. 产物命名与更新源
  //    electron-updater 按 latest.yml / latest-mac.yml 里的文件名去 Releases 下载。名字一旦对不上
  //    就是"能检查到新版本、下载 404"。而 productName 里带空格时三个阶段会各改一次（磁盘保留空格、
  //    yml 变 -、GitHub 资产变 .），所以在 build 配置里给每个 target 写死 artifactName 是硬约定。
  const buildConfig = (
    JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      build: Record<string, { artifactName?: string }>;
    }
  ).build;
  const artifactNames = ['nsis', 'portable', 'mac', 'dmg'].map(
    (target) => buildConfig[target]?.artifactName ?? '',
  );
  check(
    '产物命名：四个 target 都写死了 artifactName，且里面没有空格',
    artifactNames.every((name) => name.length > 0 && !/\s/.test(name)),
    artifactNames.join(' | '),
  );
  check(
    '产物命名：macOS 的 dmg 与 zip 同名基底（同一个 mac.artifactName / dmg.artifactName 模板）',
    buildConfig.dmg?.artifactName === buildConfig.mac?.artifactName,
    `dmg=${buildConfig.dmg?.artifactName} mac=${buildConfig.mac?.artifactName}`,
  );

  // ---------------------------------------------------------- 12. 自动全屏的前提
  //    应用内全屏是"为内嵌 DSH 界面让出整屏"。外部实例拿不到令牌时这一页只有一段说明，
  //    为它收起左栏与底栏没有意义 —— 用户点开 Harness 页莫名全屏就是这个问题。
  const storeSource = fs.readFileSync(path.join(rendererDir, 'lib', 'store.ts'), 'utf8');
  const codeOf = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
  const uiPaneCode = codeOf(uiPaneSource);
  const storeCode = codeOf(storeSource);
  const appCode = codeOf(rendererJs);

  check(
    '自动全屏：store 用 uiLoadable 表达"内嵌界面可用或即将可用"（令牌在或本应用启动）',
    /export const uiLoadable = computed\(\(\) => Boolean\(dsh\.value\?\.uiUrl\) \|\| owned\.value\)/.test(
      storeCode,
    ),
  );
  check(
    '自动全屏：切到 Harness 页时先看界面能不能用，再看设置（外部实例没令牌不自动全屏）',
    /function maybeAutoFullscreen\(\)[\s\S]*?!uiLoadable\.value && !pastedUrl\.value[\s\S]*?return/.test(
      uiPaneCode,
    ) && /settings\.value\.uiFullscreenOnStart/.test(uiPaneCode),
  );
  check(
    '自动全屏：启动时自动打开那条路同样要求 uiLoadable',
    /settings\.value\.uiFullscreenOnStart && uiLoadable\.value/.test(appCode),
  );

  // ---------------------------------------------------------- 13. macOS 的版本检查
  //    macOS 装不了自动更新（ad-hoc 签名），但**照样要知道有没有新版本** —— 主进程直接取
  //    `releases/latest/download/latest-mac.yml` 比版本号，不碰 Squirrel。这几条钉住：
  //    契约里有 canCheck、macOS 分支会去查、比较函数正确、更新源地址与 build.publish 一致。
  const publishConfig = (
    JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      build?: { publish?: { owner?: string; repo?: string }[] };
    }
  ).build?.publish?.[0];

  check(
    'macOS 更新：契约里有 canCheck（"能不能查"与"能不能装"分开）',
    /canCheck: boolean;/.test(flatIpc) && /canCheck: true/.test(updaterSource),
  );
  check(
    'macOS 更新：darwin 分支会去查 latest-mac.yml（不加载 electron-updater）',
    /process\.platform === 'darwin'/.test(updaterSource) &&
      /checkFeedVersion/.test(updaterSource) &&
      /latest\/download\/latest-mac\.yml/.test(ipcSource) &&
      /compareVersions\(latest, current\) > 0/.test(updaterSource),
  );
  check(
    'macOS 更新：更新源地址与 package.json 的 build.publish 是同一个人/仓库',
    Boolean(publishConfig?.owner) &&
      RELEASES_URL.includes(`github.com/${publishConfig?.owner}/${publishConfig?.repo}`) &&
      UPDATE_MAC_FEED_URL.includes(`github.com/${publishConfig?.owner}/${publishConfig?.repo}`),
    `${publishConfig?.owner}/${publishConfig?.repo}`,
  );
  const { compareVersions, parseFeedVersion } = await import('../../src/main/updater.js');
  check(
    'macOS 更新：版本比较与 yml 解析都对（0.4.2 > 0.4.1、后缀按同版本、坏数据返回 null）',
    compareVersions('0.4.2', '0.4.1') > 0 &&
      compareVersions('0.4.1', '0.4.1') === 0 &&
      compareVersions('0.10.0', '0.9.9') > 0 &&
      compareVersions('0.4.1-beta.1', '0.4.1') === 0 &&
      parseFeedVersion('version: 0.4.2\nfiles:\n') === '0.4.2' &&
      parseFeedVersion('files:\n') === null,
  );

  // ---------------------------------------------------------- 14. 依赖归属与包体积
  //    渲染层依赖（vue / @xterm / @fontsource）会被 Vite 打进 dist/renderer；如果它们还挂在
  //    dependencies 里，electron-builder 会**再拷一份**进 app.asar —— 实测让 asar 从 2.1 MB 涨到
  //    20.2 MB、未压缩的 .app 从 289 MB 涨到 306 MB。规则：dependencies 只放主进程运行时真的要
  //    require 的包（现在是 node-pty 与 electron-updater），其余一律 devDependencies。
  const pkgAll = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const prodDeps = Object.keys(pkgAll.dependencies ?? {});
  const devDeps = pkgAll.devDependencies ?? {};
  /** 主进程/preload 的源码（含 shared：它只放类型，但一起查没坏处） */
  const mainSideCode = [
    ...fs
      .readdirSync(path.join(repoRoot, 'src', 'main'))
      .filter((file) => file.endsWith('.ts'))
      .map((file) => fs.readFileSync(path.join(repoRoot, 'src', 'main', file), 'utf8')),
    fs.readFileSync(path.join(repoRoot, 'src', 'preload', 'preload.ts'), 'utf8'),
  ]
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*/gm, '');
  const usedByMain = (name: string): boolean =>
    mainSideCode.includes(`from '${name}'`) ||
    mainSideCode.includes(`require('${name}')`) ||
    mainSideCode.includes(`import('${name}')`);

  check(
    '打包：每个生产依赖都真的被主进程 require（不然它会白白多进一份到 app.asar）',
    prodDeps.length > 0 && prodDeps.every(usedByMain),
    prodDeps.map((name) => `${name}${usedByMain(name) ? '' : '（主进程没用到）'}`).join(' / '),
  );
  check(
    '打包：渲染层依赖在 devDependencies 而不是 dependencies（Vite 已经把它们打进 dist）',
    ['vue', '@xterm/xterm', '@fontsource/ibm-plex-sans', '@fontsource/ibm-plex-mono'].every(
      (name) => name in devDeps && !prodDeps.includes(name),
    ),
    prodDeps.join(' / '),
  );

  // ---------------------------------------------------------- 15. 更新卡片的"分平台"契约
  //    只钉**结构**：说明行必须由 canAutoUpdate 分支决定（Windows 才承诺下载/安装，macOS 上
  //    根本没这两件事 —— 写死成 Windows 那套时用户看截图指出了这个错）。
  //
  //    具体的措辞与排版**不在这里钉**：那是外观，改动频繁，钉字面量只会让"润色一句话就得改断言"
  //    （判据见 AGENTS「为什么这些检查放在自检里」）。渲染出来的每个相位的文案由本地冒烟脚本
  //    打印出来给人看，那里也会量"按钮在标题行里"这类布局。
  const settingsSource = fs.readFileSync(repo.vuePath('SettingsPane.vue'), 'utf8');
  check(
    '更新卡片：说明行由 canAutoUpdate 分支决定（Windows 才承诺下载/安装）',
    /const updateNote = computed[\s\S]{0,400}?update\.value\.canAutoUpdate/.test(settingsSource),
  );
  check(
    '设置页：保存被主进程拒了会说出来（不能显示"已保存"）',
    /catch \(cause\)[\s\S]{0,300}?flash\(/.test(settingsSource),
  );
  check(
    '设置页：表单字段都在设置契约里（键名写错只会静默不生效，看不出来）',
    (() => {
      const block = /const form = reactive\(\{([\s\S]*?)\n\}\)/.exec(settingsSource)?.[1] ?? '';
      const keys = [...block.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]);
      return keys.length >= 15 && keys.every((key) => key in DEFAULTS);
    })(),
  );
}
