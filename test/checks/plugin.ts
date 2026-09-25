'use strict';

/**
 * 自检第 16 组的后续三块：插件装配层（只读）、你自己的补丁层、救援（P2）。
 *
 * 这一层全靠"别人写的文件 + 别人打印的文本"：profile 的 package.json 与
 * `dsh web --dump-config` 的 stdout/stderr。夹具是**真实输出**（本机 web profile），
 * 所以上游改格式时这里第一时间变红，而不是等到用户发现层栈是空的。
 *
 * 整段从 `test/selftest.ts` 的 `main()` 里搬出来，行为一字未改 —— 搬完的证据是自检输出
 * 逐行一致（314 条同名、同值、同顺序）；`plugin-manager.ts` 原文与 `fixtures/` 读取由 `repo` 提供。
 */

import fs from 'node:fs';
import path from 'node:path';

import * as patchLayer from '../../src/main/patch-layer';
import * as pluginManager from '../../src/main/plugin-manager';
import * as processUtils from '../../src/main/process-utils';
import * as profileBundles from '../../src/main/profile-bundles';
import { DEFAULTS } from '../../src/main/settings';

import { check, skip, IS_WINDOWS } from '../harness';
import type { Repo } from '../repo';

export function runPlugin(repo: Repo): void {
  const pluginSource = repo.pluginSource;
  const fixture = repo.fixture;
  const sandbox = repo.sandbox;
  const rendererDir = repo.rendererDir;
  const html = repo.html;
  const rendererCode = repo.rendererCode;
  const mountJs = repo.mountJs;
  const cssBlock = repo.cssBlock;
  const cssText = repo.css;
  const allCss = repo.allCss;
  const flatIpc = repo.flatIpc;
  const vueSource = repo.vueSource;
  const rendererAll = repo.rendererAll;
  const settings = repo.settings;

  // ---------------------------------------------------------- 16. 插件装配层（只读）
  //    这一层全靠"别人写的文件 + 别人打印的文本"：profile 的 package.json 与
  //    `dsh web --dump-config` 的 stdout/stderr。夹具是**真实输出**（本机 web profile），
  //    所以上游改格式时这里第一时间变红，而不是等到用户发现层栈是空的。
  //
  //    钉的都是"回退了会静默坏掉"的东西：
  //      - 空输出被当成成功（旧 Node 上 dsh 就是退出码 0 + 零输出）→ 会显示成"没有插件"；
  //      - 未匹配的 patch 行来自 stderr（不在 dump 里）→ 漏读就等于丢掉唯一的告警；
  //      - 层归因（`patched by`）解析错 → 用户会以为自己的层生效了；
  //      - 把 profile 写成 desktop（CLI 保留给 Electron，直接报错）。

  const realDump = fixture('dump-config-web.txt');
  const dumpLayers = pluginManager.parseDump(realDump);
  const dumpedEntries = dumpLayers.reduce((sum, layer) => sum + layer.entries.length, 0);
  const patchedEntries = dumpLayers
    .filter((layer) => layer.patchedBy !== null)
    .reduce((sum, layer) => sum + layer.entries.length, 0);
  check(
    '插件：真实 dump 解析出层归因与全部条目（patched by 要拆开）',
    dumpedEntries === 152 &&
      patchedEntries === 25 &&
      dumpLayers.some((layer) => layer.source === '@deepseek-ai/dsh-base') &&
      dumpLayers.some((layer) => layer.patchedBy === '@deepseek-ai/dsh-web-app'),
    `${dumpedEntries} 条 / 被覆盖 ${patchedEntries} 条 / ${dumpLayers.length} 个层段`,
  );
  check(
    '插件：同一条目被覆盖时能看出是"被禁用"还是"config 被替换"',
    (() => {
      const patched = dumpLayers
        .filter((layer) => layer.patchedBy !== null)
        .flatMap((layer) => layer.entries);
      const disabled = patched.filter((entry) => entry.disabled).length;
      const withConfig = patched.filter((entry) => entry.hasConfig).length;
      // 真实数据：25 条被覆盖里 23 条是"关掉"，12 条替换了 config（有重叠）
      return disabled === 23 && withConfig === 12;
    })(),
  );
  check(
    '插件：未匹配的 patch 行只在 stderr 上，解析成 unmatched-patch 并带出条目 id',
    (() => {
      const problems = pluginManager.parseProblems(fixture('unmatched-patch.stderr.txt'));
      const hit = problems.find((item) => item.kind === 'unmatched-patch');
      return (
        Boolean(hit) &&
        hit?.entryId === '这个条目不存在' &&
        Boolean(hit?.file?.endsWith('cordis.patch.yml'))
      );
    })(),
  );
  check(
    '插件：巡检里"指向了不存在的 id"只有本页能改的那份层才给动作（机器级那层不给）',
    (() => {
      const text = fixture('unmatched-patch.stderr.txt');
      // 夹具里 dsh 打的就是它自己那份 profile 层的真实全路径 —— 拿它当 ownPatchFile，
      // 应当判成"能改"（这条同时钉住路径比较不被真机上的绝对路径绕过去）
      const own = /\[(.+?)\]/.exec(text)?.[1] ?? '';
      const mine = pluginManager.parseProblems(text, own)[0];
      // 同一个文件名、但在别的目录（机器级的 $DSH_HOME/cordis.patch.yml 就是这种）
      const elsewhere = pluginManager.parseProblems(
        text,
        path.join('/tmp', 'other-home', 'profiles', 'web', 'cordis.patch.yml'),
      )[0];
      // 老调用方不传 ownPatchFile：一律不给动作，绝不能默认成"能改"
      const none = pluginManager.parseProblems(text)[0];
      return (
        own.endsWith('cordis.patch.yml') &&
        mine?.kind === 'unmatched-patch' &&
        mine?.entryId === '这个条目不存在' &&
        mine?.editable === true &&
        elsewhere?.editable === false &&
        none?.editable === false
      );
    })(),
  );
  check(
    '插件：patch 解析失败也来自 stderr，归到 parse-error 并点名文件',
    (() => {
      const problems = pluginManager.parseProblems(fixture('broken-patch.stderr.txt'));
      const hit = problems.find((item) => item.kind === 'parse-error');
      return Boolean(hit) && /YAMLException|unexpected end/.test(hit?.detail || '');
    })(),
  );
  check(
    '插件：空输出不算成功；失败时给的是诊断行而不是 Node 的堆栈首行',
    pluginManager.checkDumpResult(0, '', '') !== null &&
      pluginManager.checkDumpResult(0, realDump, '') === null &&
      (() => {
        const why = pluginManager.checkDumpResult(1, '', fixture('broken-patch.stderr.txt'));
        return (
          Boolean(why) && why?.includes('cordis.patch.yml') === true && !why?.includes('file://')
        );
      })(),
  );
  check(
    '插件：真实 profile manifest 读得出 bundles 顺序与 patchReload',
    (() => {
      const manifest = pluginManager.readProfileManifest(
        path.join(repo.testDir, 'fixtures', 'profile'),
      );
      return (
        manifest.name === 'dsh-profile-web' &&
        manifest.bundles.length === 2 &&
        manifest.bundles[0] === '@deepseek-ai/dsh-base' &&
        manifest.patchReload === 'live' &&
        Object.keys(manifest.dependencies).length === 0
      );
    })(),
  );
  check(
    '插件：装进来却没形成层的依赖、以及什么都没贡献的 bundle 都会被列出来（普通依赖带包名）',
    (() => {
      const plain = pluginManager.plainDependencies(
        {
          name: null,
          dependencies: { 'some-lib': 'link:../lib' },
          bundles: ['@deepseek-ai/dsh-base'],
          patchReload: null,
        },
        path.join(sandbox, '没有这个目录'),
      );
      const missing = pluginManager.missingLayers(
        {
          name: null,
          dependencies: {},
          bundles: ['@deepseek-ai/dsh-base', 'ghost-bundle'],
          patchReload: null,
        },
        dumpLayers,
      );
      return (
        plain.length === 1 &&
        plain[0].kind === 'plain-dependency' &&
        // 包名要单独带出来：界面靠它给「卸掉它」，不解析那句人话
        plain[0].packageName === 'some-lib' &&
        missing.length === 1 &&
        missing[0].kind === 'missing-layer'
      );
    })(),
  );
  // 「临时停用」之后回不去，是因为它掉进了"不形成层"这一档、而那一档只给「卸掉它」。
  // 分档的唯一依据是**包自己有没有声明 dsh.bundle**（读 profile 的 node_modules）：
  // 声明过 = 它本来该形成层、是被人从 bundles 里摘掉的 → 给「放回层里」。
  check(
    '插件：声明过 dsh.bundle 却不在列表里 = 「掉出了层列表」（能放回）；真·普通依赖只能卸',
    (() => {
      const dir = path.join(sandbox, 'plain-deps');
      fs.rmSync(dir, { recursive: true, force: true });
      const writeManifest = (name: string, raw: unknown) => {
        const packageDir = path.join(dir, 'node_modules', name);
        fs.mkdirSync(packageDir, { recursive: true });
        fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(raw), 'utf8');
      };
      writeManifest('@yozica/dsh-plugin-paths', {
        name: '@yozica/dsh-plugin-paths',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      });
      writeManifest('some-lib', { name: 'some-lib', dsh: { profile: { bundles: [] } } });
      const problems = pluginManager.plainDependencies(
        {
          name: null,
          dependencies: {
            '@yozica/dsh-plugin-paths': 'link:../paths',
            'some-lib': 'link:../lib',
            读不到的包: '^1.0.0',
          },
          bundles: ['@deepseek-ai/dsh-base'],
          patchReload: null,
        },
        dir,
      );
      const suspended = problems.find((item) => item.packageName === '@yozica/dsh-plugin-paths');
      const plain = problems.find((item) => item.packageName === 'some-lib');
      const unreadable = problems.find((item) => item.packageName === '读不到的包');
      return (
        problems.length === 3 &&
        suspended?.kind === 'suspended-bundle' &&
        plain?.kind === 'plain-dependency' &&
        // 没装到 / 读不到 package.json：按"本来就不是 bundle"处理，绝不当成能放回的
        unreadable?.kind === 'plain-dependency' &&
        pluginManager.bundleDeclared({ dsh: { bundle: './cordis.patch.yml' } }) &&
        !pluginManager.bundleDeclared({ dsh: { profile: {} } }) &&
        !pluginManager.bundleDeclared(null)
      );
    })(),
  );
  // 运行中清单：走 dsh 自己的接口（令牌换 cookie → /api/pluginInventory/list）。
  // 这是 rc 版本的内部协议，所以两道保险：真实应答当夹具钉住形状 + 纯函数钉住解析。
  const liveRaw = fixture('plugin-inventory.json');
  const liveValue = pluginManager.unwrapLiveValue(liveRaw);
  const live = pluginManager.summarizeLive(liveValue);
  check(
    '插件：真实应答能解出运行中的条目与预设行数',
    live.entries.length >= 150 &&
      live.presets.find((preset) => preset.id === 'standard')?.rows === 28 &&
      live.counts.total === live.entries.length &&
      live.counts.active > 0 &&
      live.counts.idle > 0,
    `${live.counts.total} 条 · active ${live.counts.active} · 未挂载 ${live.counts.idle} · 预设 ${live.presets.length} 个`,
  );
  check(
    '插件：运行中的 id 带 include: 前缀，剥掉才和配置里的 id 对得上',
    live.entries.some((entry) => entry.entryId.startsWith('include:')) &&
      pluginManager.stripIncludePrefix('include:llm') === 'llm' &&
      pluginManager.stripIncludePrefix('llm') === 'llm' &&
      // 启动时挂的行没有 include: 前缀，id 还是生成的哈希
      live.entries.some((entry) => /^[0-9a-f]{8}$/.test(entry.entryId)) &&
      live.entries.some((entry) => entry.entryId === 'include'),
  );
  check(
    '插件：令牌地址解析（没有令牌、地址不是 URL、空值都要老实返回 null）',
    (() => {
      const ok = pluginManager.parseTokenUrl('http://127.0.0.1:3080/?token=abc123');
      return (
        ok?.origin === 'http://127.0.0.1:3080' &&
        ok?.token === 'abc123' &&
        pluginManager.parseTokenUrl('http://127.0.0.1:3080/') === null &&
        pluginManager.parseTokenUrl('不是 URL') === null &&
        pluginManager.parseTokenUrl('') === null &&
        pluginManager.parseTokenUrl(null) === null
      );
    })(),
  );
  check(
    '插件：调用信封与应答解包（ok:false / 非 JSON / 不是 server-response 都算失败）',
    (() => {
      const envelope = JSON.parse(pluginManager.unaryEnvelope('pluginInventory/list', 'probe')) as {
        type?: string;
        method?: string;
        payload?: { args?: unknown };
      };
      return (
        envelope.type === 'client-request' &&
        envelope.method === 'pluginInventory/list' &&
        envelope.payload?.args !== undefined &&
        pluginManager.unwrapLiveValue(liveRaw) !== null &&
        pluginManager.unwrapLiveValue('{"type":"server-response","result":{"ok":false}}') ===
          null &&
        pluginManager.unwrapLiveValue('不是 JSON') === null &&
        pluginManager.unwrapLiveValue('{"type":"other"}') === null
      );
    })(),
  );

  check(
    '快捷键：TAB_ORDER 与左栏顺序一致（不一致就会"按 7 打开别的页"）',
    (() => {
      const appTs = fs.readFileSync(path.join(rendererDir, 'app.ts'), 'utf8');
      const railVue = fs.readFileSync(path.join(rendererDir, 'shell', 'RailNav.vue'), 'utf8');
      const orderBlock = /TAB_ORDER: TabId\[\] = \[([\s\S]*?)\]/.exec(appTs)?.[1] ?? '';
      const order = [...orderBlock.matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
      const rail = [...railVue.matchAll(/\{ id: '([a-z]+)'/g)].map((match) => match[1]);
      // 不比"至少 8 项"：页面数会随左栏增删（t45 就是 9 → 7），"两边逐项一致"才是契约
      return order.length > 0 && order.join() === rail.join();
    })(),
    '左栏顺序 = 快捷键 1..N',
  );

  /**
   * 取 `startPattern` 命中的那个 `<div>` **自己的整段**（按 div 开闭标签配对）。
   * 用来断言"某个东西真的套在这个 div 里"，而不是靠前后顺序猜 —— 纯粹的
   * indexOf 顺序检查抓不到"它跑到那个 div 后面并排站着了"这种错。
   */
  function divBlock(source: string, startPattern: RegExp): string {
    const start = startPattern.exec(source);
    if (!start) return '';
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = start.index;
    let depth = 0;
    for (let match = tags.exec(source); match; match = tags.exec(source)) {
      depth += match[0] === '</div>' ? -1 : 1;
      if (depth === 0) return source.slice(start.index, match.index + match[0].length);
    }
    return '';
  }

  // ── t45：左栏 9 → 7（终端合并、环境自检挪进设置）。四条钉子盯住"合并之后不许两头都在"。
  const railSource = fs.readFileSync(path.join(rendererDir, 'shell', 'RailNav.vue'), 'utf8');
  const railStoreSource = fs.readFileSync(path.join(rendererDir, 'lib', 'store.ts'), 'utf8');
  const appSource = fs.readFileSync(path.join(rendererDir, 'app.ts'), 'utf8');
  const mergedTermSource = fs.readFileSync(
    path.join(rendererDir, 'panes', 'TerminalPane.vue'),
    'utf8',
  );
  const railSettingsSource = fs.readFileSync(
    path.join(rendererDir, 'panes', 'SettingsPane.vue'),
    'utf8',
  );
  const envLayerSource = fs.readFileSync(path.join(rendererDir, 'lib', 'env-layer.ts'), 'utf8');
  const htmlCode = html.replace(/<!--[\s\S]*?-->/g, '');
  const tabIdUnion = /export type TabId =([\s\S]*?);/.exec(railStoreSource)?.[1] ?? '';
  const tabIds = [...tabIdUnion.matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
  check(
    '渲染层：左栏七项（TabId 里没有 shell / env，页面容器也没有 pane-shell）',
    tabIds.length === 7 &&
      !tabIds.includes('shell') &&
      !tabIds.includes('env') &&
      !/\{ id: 'shell'/.test(railSource) &&
      !/\{ id: 'env'/.test(railSource) &&
      !/id="pane-shell"/.test(htmlCode) &&
      // 快捷键顺序里也不许再出现这两个 id（不再是"至少 8 项"，这一轮就是 7 项）
      !/TAB_ORDER[\s\S]{0,220}?'(shell|env)'/.test(appSource) &&
      // 快捷键正则也不能再放行 8 / 9
      /\^\[1-7\]\$/.test(fs.readFileSync(path.join(rendererDir, 'lib', 'xterm.ts'), 'utf8')),
    `TabId = ${tabIds.join(', ')}`,
  );
  check(
    '渲染层：环境自检是设置里的详情层（不是页面）',
    /id="env-detail-layer"/.test(htmlCode) &&
      /id="env-root"/.test(htmlCode) &&
      /export function openEnvDetail\(\): void \{/.test(envLayerSource) &&
      /export function closeEnvDetail\(\): void \{/.test(envLayerSource) &&
      /export function closeEnvDetailOnTabChange\(\): void \{/.test(envLayerSource) &&
      // 四个入口都改成打开详情层了，谁都不许再切到 'env'
      !/currentTab\.value = 'env'/.test(rendererCode) &&
      (rendererCode.match(/openEnvDetail\(\)/g) ?? []).length >= 4 &&
      // 切页要收掉这一层，免得盖住用户刚点的那一页
      /closeEnvDetailOnTabChange\(\);/.test(railSource),
  );
  // 详情层必须挂在 <main> 里面：main 是 position: relative，它的 inset: 0 正好是"页面区"。
  // 挂在 .app 外面（body 下）时 inset: 0 是整个窗口 —— 左栏与顶栏一起被吃掉
  // （真机上出现过：点「查看详情」之后左栏整条不见了，EnvPane 自己的步骤栏占着左栏的位置，
  // 看着像左栏变成了向导；只看 open 类的检查全是绿的，因为它确实"打开了"）。
  const mainBlock = /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(htmlCode)?.[1] ?? '';
  check(
    '渲染层：环境自检详情层盖的是工作区（挂在 <main> 里，不吃掉左栏与顶栏）',
    /id="env-detail-layer"/.test(mainBlock) &&
      /id="env-root"/.test(mainBlock) &&
      // 类名必须是这一层独有的：`.env-detail` 是 EnvPane 里每行结论下面那串说明文字用的
      // （带 margin 3px 与那套行高），撞上会让整层跟着偏移并继承文字样式（踩过）
      /<div class="env-detail-layer" id="env-detail-layer">/.test(mainBlock) &&
      /\.env-detail-layer \{[^}]*position: absolute/.test(cssText) &&
      /\.env-detail-layer \{[^}]*inset: 0/.test(cssText) &&
      /\.env-detail-layer\.open \{[^}]*display: flex/.test(cssText) &&
      // 前提：左栏与顶栏本来就在 <main> 外面（所以"留在外面"是结构保证的，不靠 z-index 让位）
      /id="rail-root"/.test(htmlCode) &&
      /id="topbar-root"/.test(htmlCode) &&
      !/id="rail-root"/.test(mainBlock) &&
      !/id="topbar-root"/.test(mainBlock) &&
      // 出现且只出现一次（别为了"盖住工作区"再复制一层出来）
      (htmlCode.match(/id="env-detail-layer"/g) ?? []).length === 1,
    mainBlock ? `main 那段 ${mainBlock.split('\n').length} 行` : '找不到 <main>',
  );
  check(
    '渲染层：终端页的会话条第一项固定是 dsh 终端、新建按钮镂空（两路终端在一个页面里）',
    /id="tab-dsh-term"/.test(mergedTermSource) &&
      /activate\(DSH_ID\)/.test(mergedTermSource) &&
      /const DSH_ID = 'dsh';/.test(mergedTermSource) &&
      /<DshTerminal \/>/.test(mergedTermSource) &&
      // 关掉最后一个本地 Shell 要回到 dsh 那一路，不能停在"没有会话"的空屏上
      /activeId\.value = DSH_ID;/.test(mergedTermSource) &&
      // dsh 那一路是子组件：不在挂载清单里，但必须被宿主 import（上面那条通用检查盯着）
      !mountJs.includes("from './panes/DshTerminal.vue'") &&
      // 会话条上的动作是**镂空**的（.btn.outline），实心只留给"当前在看的那一路"：
      // 之前它用 .btn.primary（实心 accent），比选中的标签还抢眼，看不出选中了谁
      /id="btn-new-shell"[\s\S]{0,80}class="btn small outline"/.test(mergedTermSource) &&
      // 这两条规则 t48 起在 `panes/TerminalPane.vue` 的 <style scoped> 里（cssBlock 读两层）
      /\.btn\.outline \{[^}]*background: transparent/.test(cssBlock('.btn.outline')) &&
      /\.shell-tab\.active \{[^}]*background: var\(--accent-soft\)/.test(
        cssBlock('.shell-tab.active'),
      ),
  );
  // 两路终端都得套在 .term-body 里：它的 inset:0 才是对"会话条下面那块区域"算的。
  // 少了这一层，dsh 那一路会去对整个 .pane 定位 —— 它的状态条（清空显示 / 显示历史 /
  // Ctrl+C）就与会话条叠在同一行（真机上出现过，会话条上的标签和按钮糊成一片）。
  // 而 `.term-host` 的**基础**规则必须留着 relative + flex：dsh 那一路的子组件
  // DshTerminal 自己也用这个类（那是它 `.bar` 下面的 flex 子项）；把基础规则改成绝对
  // 定位，它会铺满整个 `.term-view`、把状态条整行盖掉（踩过 —— 而且 rect 量出来一切
  // 正常，因为元素确实"在"。只有本地 Shell 那一路，直接挂在 `.term-body` 下的那个，
  // 才用 `.term-body > .term-host` 改绝对定位铺满）。
  // 最后两条同样来自踩坑：本地 Shell 那一块是**不透明**的、又排在 .term-view 后面
  // （两者 z-index 都是 auto），dsh 那一路在的时候必须靠 `active` 把它藏起来；
  // 否则它是"遮挡"而不是"重叠"，连重叠面积都量不出来（只有带 z-index 的空状态
  // 能穿出来，看着像状态条凭空消失了）。而"藏"的写法只能是给**不在看的那一路**写
  // hidden —— visibility 会继承，给"在看的那一路"写 visible 就会连 `.pane` 的隐藏
  // 一起穿掉（用户抓图：切到 Harness 页，本地 Shell 的终端还画在上面）。
  const termBodyBlock = divBlock(mergedTermSource, /<div class="term-body">/);
  check(
    '渲染层：两路终端共用 .term-body（dsh 那一路的定位基准不是整个页面）',
    /class="term-view"/.test(termBodyBlock) &&
      /<div class="term-host" :class="\{ active: !dshActive \}" ref="host">/.test(termBodyBlock) &&
      // `.term-body` 与本地 Shell 那一路在 TerminalPane 的 scoped 块里；`.term-host` 的**基础**
      // 规则两路共用、留在全局表 —— cssBlock 读两层，所以这几条不用改判据
      /\.term-body \{[^}]*position: relative/.test(cssBlock('.term-body')) &&
      /\.term-host \{[^}]*position: relative/.test(cssBlock('.term-host')) &&
      /\.term-host \{[^}]*flex: 1 1 auto/.test(cssBlock('.term-host')) &&
      /\.term-body > \.term-host \{[^}]*position: absolute/.test(
        cssBlock('.term-body > .term-host'),
      ) &&
      // 只给"不在看的那一路"写 hidden；**不许**给"在看的那一路"写 visible ——
      // visibility 是继承属性，显式 visible 会从 `.pane` 的隐藏里穿出来
      // （踩过：切到别的 tab，本地 Shell 的终端照样画在那一页上面）
      /\.term-body > \.term-host:not\(\.active\) \{[^}]*visibility: hidden/.test(
        cssBlock('.term-body > .term-host:not(.active)'),
      ) &&
      !/\.term-body > \.term-host\.active[^{]*\{[^}]*visibility: visible/.test(allCss),
    termBodyBlock
      ? `term-body 套着 ${termBodyBlock.split('\n').length} 行`
      : 'term-body 里没套住两路',
  );
  check(
    '设置页：「运行环境」卡是简化展示 + 「查看详情」打开详情层',
    /<h3>运行环境<\/h3>/.test(railSettingsSource) &&
      /id="btn-env-detail"/.test(railSettingsSource) &&
      /@click="openEnvDetail"/.test(railSettingsSource) &&
      /id="btn-env-recheck"/.test(railSettingsSource) &&
      /loadEnvReport\(true\)/.test(railSettingsSource),
  );

  // 装 / 卸 / 升级：spec 只用于"确认文案与提示"，命令原样透传给 pnpm；错误归纳要认出常见失败。
  check(
    '插件安装：spec 分得清 npm / 本地 / tarball / git，并认得出 git 有没有固定 sha',
    (() => {
      const npm = pluginManager.parsePluginSpec('dsh-hello-plugin');
      const scoped = pluginManager.parsePluginSpec('@scope/name@1.2.3');
      const local = pluginManager.parsePluginSpec('./hello-plugin');
      const tarball = pluginManager.parsePluginSpec('./hello-0.1.0.tgz');
      const pinned = pluginManager.parsePluginSpec('github:you/hello#a1b2c3d4');
      const floating = pluginManager.parsePluginSpec('github:you/hello');
      return (
        npm?.kind === 'npm' &&
        scoped?.kind === 'npm' &&
        local?.kind === 'local' &&
        tarball?.kind === 'tarball' &&
        pinned?.kind === 'git' &&
        pinned.pinned === true &&
        floating?.kind === 'git' &&
        floating.pinned === false &&
        pluginManager.parsePluginSpec('   ') === null
      );
    })(),
  );
  check(
    '插件安装：常见失败各归纳成一句人话，认不出来返回 null（不编原因）',
    (() => {
      const notFound = pluginManager.summarizePluginFailure(
        'dsh: pnpm not found on PATH — install pnpm to manage profile plugins',
      );
      const git = pluginManager.summarizePluginFailure(
        'ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED  Ignored build scripts: dsh-x',
      );
      const missing = pluginManager.summarizePluginFailure(
        'ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/x: Not Found',
      );
      const denied = pluginManager.summarizePluginFailure('Error: EPERM: operation not permitted');
      return (
        Boolean(notFound && git && missing && denied) &&
        pluginManager.summarizePluginFailure('Done in 1.4s') === null
      );
    })(),
  );
  check(
    '插件安装：从 spec 里取得出包名（带版本/标签也要取对）',
    pluginManager.packageNameOf('@scope/name@1.2.3') === '@scope/name' &&
      pluginManager.packageNameOf('@scope/name') === '@scope/name' &&
      pluginManager.packageNameOf('plain-name@latest') === 'plain-name' &&
      pluginManager.packageNameOf('plain-name') === 'plain-name',
  );
  check(
    '插件安装：链到已停服的淘宝镜像要单独说，别笼统说"包不存在"（并把失败的主机名带出来）',
    (() => {
      const taobao = pluginManager.summarizePluginFailure(
        'ERR_PNPM_FETCH_404  GET https://registry.npm.taobao.org/@deepseek-ai%2Fdsh-type-meta: Not Found - 404',
      );
      const other = pluginManager.summarizePluginFailure(
        'ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/@x%2Fy: Not Found - 404',
      );
      return (
        Boolean(taobao?.includes('npmmirror')) &&
        Boolean(other?.includes('registry.npmjs.org')) &&
        !other?.includes('npmmirror')
      );
    })(),
  );
  check(
    '插件安装：404 缺的是依赖、不是你要的那个包时，要指名道姓（夹具是真实输出）',
    (() => {
      const real = fixture('pnpm-missing-dep.stderr.txt');
      const hint = pluginManager.summarizePluginFailure(real, '@deepseek-ai/dsh-time-context');
      return (
        Boolean(hint?.includes('@deepseek-ai/dsh-type-meta')) &&
        Boolean(hint?.includes('@deepseek-ai/dsh-time-context')) &&
        !hint?.includes('名字或版本可能不对')
      );
    })(),
  );
  check(
    '插件安装：缺的正是你要的那个包时，仍按"包不存在"说（并把主机名带出来）',
    (() => {
      const real = fixture('pnpm-missing-dep.stderr.txt');
      const hint = pluginManager.summarizePluginFailure(real, '@deepseek-ai/dsh-type-meta');
      return Boolean(hint?.includes('registry.example.com')) && !hint?.includes('依赖');
    })(),
  );
  check(
    '插件安装：安装源留空 / 写错都退回系统配置，填了才覆盖（只认 http(s)，末尾斜杠去掉）',
    (() => {
      const env = pluginManager.pluginRegistryEnv;
      const effective = env(' https://registry.npmmirror.com/ ');
      return (
        env('').npm_config_registry === undefined &&
        env('   ').npm_config_registry === undefined &&
        // 裸主机名 / 非 http(s) 都当没填：写错的代价是"装不上"，不如退回系统配置
        env('registry.npmjs.org').npm_config_registry === undefined &&
        env('ftp://mirror.example.com').npm_config_registry === undefined &&
        effective.npm_config_registry === 'https://registry.npmmirror.com' &&
        env('http://127.0.0.1:4873').npm_config_registry === 'http://127.0.0.1:4873'
      );
    })(),
  );
  check(
    '插件安装：补 PATH 时保留系统原有的键名（Windows 上叫 `Path`，不能造出两个只差大小写的键）',
    (() => {
      const win = processUtils.envWithKnownBins({ Path: 'C:\\Windows\\System32', FOO: '1' });
      const posix = processUtils.envWithKnownBins({ PATH: '/usr/bin', FOO: '1' });
      const bare = processUtils.envWithKnownBins({});
      const pathKeys = (env: NodeJS.ProcessEnv) =>
        Object.keys(env).filter((key) => key.toLowerCase() === 'path');
      return (
        // 只有一个 path 键，而且键名原样（`Path` 还是 `Path`）
        pathKeys(win).length === 1 &&
        pathKeys(win)[0] === 'Path' &&
        // 原有值还在末尾（前面补的是 node / pnpm 的目录），别的变量没动
        String(win.Path).endsWith('C:\\Windows\\System32') &&
        win.FOO === '1' &&
        String(win.Path) !== 'C:\\Windows\\System32' &&
        pathKeys(posix).length === 1 &&
        pathKeys(posix)[0] === 'PATH' &&
        String(posix.PATH).endsWith('/usr/bin') &&
        pathKeys(bare).length === 1 &&
        pathKeys(bare)[0] === 'PATH'
      );
    })(),
  );
  check(
    '插件安装：Windows 上找 pnpm / node 不写死 .cmd（独立安装包是 pnpm.exe），并有已知目录兜底',
    (() => {
      const source = repo.processUtilsSource;
      // 写死 `pnpm.cmd` 会漏掉 pnpm 官方安装包装的 `pnpm.exe`；交给 whichSync 按 PATHEXT 展开
      const viaPathext = /whichSync\('pnpm'\)/.test(source) && /whichSync\('node'\)/.test(source);
      // 键名大小写不统一（LocalAppData / LOCALAPPDATA 都见过），按小写索引后两种写法都要认
      const upper = processUtils.windowsBinCandidates(
        {
          PNPM_HOME: 'C:\\pnpm-home',
          APPDATA: 'C:\\AppData',
          LOCALAPPDATA: 'C:\\LocalAppData',
          ProgramFiles: 'C:\\Program Files',
          NVM_SYMLINK: 'C:\\Program Files\\nodejs',
        },
        'C:\\Users\\x',
      );
      const mixed = processUtils.windowsBinCandidates(
        { Pnpm_Home: 'C:\\pnpm-home', AppData: 'C:\\AppData', LocalAppData: 'C:\\LocalAppData' },
        'C:\\Users\\x',
      );
      const empty = processUtils.windowsBinCandidates({}, 'C:\\Users\\x');
      return (
        viaPathext &&
        upper.includes('C:\\pnpm-home') &&
        upper.includes('C:\\AppData\\npm') &&
        upper.includes('C:\\LocalAppData\\pnpm') &&
        upper.includes('C:\\Program Files\\nodejs') &&
        upper.includes('C:\\Users\\x\\.volta\\bin') &&
        // 大小写不同的同一组变量 → 同一组目录，顺序也一样
        mixed.slice(0, 3).join('|') === upper.slice(0, 3).join('|') &&
        // 一个变量都没有时也不炸（只留 volta 那条固定路径）
        empty.length === 1 &&
        empty[0] === 'C:\\Users\\x\\.volta\\bin'
      );
    })(),
  );
  check(
    '插件安装：安装源走子进程环境变量，不写用户的 .npmrc',
    /pluginRegistry: string;/.test(flatIpc) &&
      DEFAULTS.pluginRegistry === '' &&
      /npm_config_registry/.test(pluginSource) &&
      /pluginRegistryEnv\(this\.settings\.all\(\)\.pluginRegistry\)/.test(pluginSource) &&
      // 只注入环境；一旦有人改成往磁盘写 .npmrc，就会动到用户全局配置
      !/\.npmrc/.test(pluginSource.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
  );
  check(
    '插件安装：没装 pnpm 时在起子进程之前拦下（`dsh plugin` 只会退出码 127，还会白建一遍 profile）',
    (() => {
      const guard = pluginSource.indexOf('if (findPnpm() === null)');
      const spawn = pluginSource.indexOf('const first = await this.spawnOnce');
      return guard !== -1 && spawn !== -1 && guard < spawn;
    })(),
  );
  check(
    '插件安装：patch 层里"已经插入了某个包"看得出来（注释里提到的不算）',
    (() => {
      const real = fixture('profile-cordis.patch.yml');
      return (
        pluginManager.patchLayerInserts(real, '@deepseek-ai/dsh-time-context') &&
        !pluginManager.patchLayerInserts(real, '@deepseek-ai/dsh-other') &&
        // 只在注释里出现的名字不算：真机上用户会以为"我明明装过了"
        !pluginManager.patchLayerInserts(
          '# 提到过 @deepseek-ai/dsh-base，但没有插入它\n[]',
          '@deepseek-ai/dsh-base',
        )
      );
    })(),
  );
  check(
    '插件安装：内置包要分清"还没启用"与"你已经启用了"（两种话说得不一样）',
    /profilePatchEnables\(name\)/.test(pluginSource) && /needsEnable/.test(pluginSource),
  );

  // ---------------------------------------------------------- 补丁层：改你自己的覆盖
  //    这是唯一会**写用户文件**的地方，所以钉三件事：只动匹配到的那一段（往返一致）、
  //    找不齐就不写（不猜）、写盘前先备份。夹具是那台机器上真实的 cordis.patch.yml。
  const realPatch = fixture('profile-cordis.patch.yml');
  check(
    '补丁层：禁用 / 启用只动匹配到的那一段（往返之后与原文一字不差）',
    (() => {
      const disabled = patchLayer.disableEntry(realPatch, 'time-context');
      const back = patchLayer.enableEntry(disabled.text, 'time-context');
      return (
        disabled.changed &&
        /^\s+disabled: true$/m.test(disabled.text) &&
        // 注释与缩进都不能被改没
        disabled.text.includes('# 想恢复成"什么都不改"') &&
        disabled.text.includes("name: '@deepseek-ai/dsh-time-context'") &&
        back.changed &&
        back.text === realPatch
      );
    })(),
  );
  check(
    '补丁层：层里没有那条时，禁用 = 加一条覆盖，启用 = 把它整条删掉（回到原样）',
    (() => {
      const disabled = patchLayer.disableEntry(realPatch, 'timer');
      const back = patchLayer.enableEntry(disabled.text, 'timer');
      // 另一头：条目是被**下面某一层**关掉的（base 把 hmr 关了）时，启用 = 写一条 disabled: false 盖住它
      const turnedOn = patchLayer.enableEntry(realPatch, 'hmr');
      const turnedOff = patchLayer.disableEntry(turnedOn.text, 'hmr');
      return (
        disabled.changed &&
        disabled.text.includes('- id: timer\n  disabled: true') &&
        back.changed &&
        // 只为禁用而存在的那条要整条消失，不能留下一条空的 `- id: timer`
        !back.text.includes('- id: timer') &&
        back.text === realPatch &&
        turnedOn.changed &&
        turnedOn.text.includes('- id: hmr\n  disabled: false') &&
        turnedOff.changed &&
        turnedOff.text.includes('- id: hmr\n  disabled: true') &&
        // 不能因此插出第二条
        turnedOff.text.split('- id: hmr').length === 2
      );
    })(),
  );
  check(
    '补丁层：插入不重复；移除只对自己插入的条目开放（覆盖条目不动它）',
    (() => {
      const once = patchLayer.insertPlugin(realPatch, 'hello', 'dsh-hello-plugin');
      const twice = patchLayer.insertPlugin(once.text, 'hello', 'dsh-hello-plugin');
      const removed = patchLayer.removeInsert(once.text, 'hello');
      const refused = patchLayer.removeInsert(
        patchLayer.disableEntry(realPatch, 'timer').text,
        'timer',
      );
      return (
        once.changed &&
        !twice.changed &&
        removed.changed &&
        removed.text === realPatch &&
        // 只为禁用而写的 `- id: timer` 不是 insert，这个动作不碰它
        !refused.changed &&
        refused.text.includes('- id: timer')
      );
    })(),
  );
  check(
    '补丁层：巡检给的"删掉这一行"只删那一条（覆盖条目 / insert 块里的都认，删完仍留顶层数组）',
    (() => {
      // 覆盖/禁用形状的条目（`- id: ghost` 那一层）——removeInsert 不碰它，dropEntry 要能删
      const ghostOverride = `${realPatch}- id: ghost\n  disabled: true\n`;
      const dropped = patchLayer.dropEntry(ghostOverride, 'ghost');
      // 嵌套形状的：insert 块里只剩它一条 → 连块一起删，不能留一个空的 `- insert:`
      const onlyNested = "# 注释\n- insert:\n    - id: ghost\n      name: 'dsh-ghost'\n";
      const droppedNested = patchLayer.dropEntry(onlyNested, 'ghost');
      // 块里还有别的条目时，只删那一条
      const siblings = `${onlyNested}    - id: keep\n      name: 'dsh-keep'\n`;
      const droppedOne = patchLayer.dropEntry(siblings, 'ghost');
      const missing = patchLayer.dropEntry(realPatch, '没有这条');
      return (
        dropped.changed &&
        !dropped.text.includes('ghost') &&
        // 别动夹具里原有的注释与那条 time-context
        dropped.text.includes('# 想恢复成"什么都不改"') &&
        dropped.text.includes("name: '@deepseek-ai/dsh-time-context'") &&
        droppedNested.changed &&
        !droppedNested.text.includes('- insert:') &&
        // 只剩注释时必须补 `[]`，dsh 否则读不出来
        /^\[\]$/m.test(droppedNested.text) &&
        droppedOne.changed &&
        !droppedOne.text.includes('ghost') &&
        droppedOne.text.includes('- id: keep') &&
        // 找不到就一个字节都不写
        !missing.changed &&
        missing.text === realPatch
      );
    })(),
  );
  check(
    '补丁层：删完最后一条要留下一个顶层数组（只剩注释 dsh 会直接报错）',
    (() => {
      // 真机事故：移除最后一条 insert 之后文件只剩注释，dsh 判它不是顶层数组，
      // 整个插件页读不出来（overlay … must be a top-level YAML array of loader patch entries）。
      const only = "- insert:\n    - id: hello\n      name: 'dsh-hello-plugin'\n";
      const removed = patchLayer.removeInsert(only, 'hello');
      const inserted = patchLayer.insertPlugin('# 只有注释\n', 'hello', 'dsh-hello-plugin');
      return (
        removed.changed &&
        /^\[\]$/m.test(removed.text) &&
        !/^- /m.test(removed.text) &&
        // 从"只有注释"的文件开始插入，也要是合法数组（注释 + 条目，不需要 []）
        inserted.changed &&
        /^- insert:/m.test(inserted.text) &&
        !/^\[\]$/m.test(inserted.text)
      );
    })(),
  );
  check(
    '补丁层：写完回读验证，只有失败点名到这份 overlay 时才回滚',
    /await runDump\(this\.settings\.all\(\)\)/.test(pluginSource) &&
      /rollbackEdit\(result\)/.test(pluginSource) &&
      /top-level YAML array\|overlay/.test(pluginSource) &&
      /message\.includes\(result\.file\)/.test(pluginSource),
  );
  check(
    '补丁层：写盘前先备份、原子写；id 不合法就一个字节都不写',
    (() => {
      const dir = path.join(sandbox, 'patch-layer');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'cordis.patch.yml');
      fs.writeFileSync(file, realPatch, 'utf8');

      const inserted = patchLayer.applyPatchEdit(dir, {
        action: 'insert',
        id: 'hello',
        name: 'dsh-hello-plugin',
      });
      const after = fs.readFileSync(file, 'utf8');
      const backup = inserted.backup ? fs.readFileSync(inserted.backup, 'utf8') : '';
      const bad = patchLayer.applyPatchEdit(dir, { action: 'disable', id: 'bad id!' });

      return (
        inserted.ok &&
        inserted.changed === true &&
        Boolean(
          inserted.backup && path.basename(inserted.backup).startsWith('cordis.patch.yml.bak-'),
        ) &&
        after.includes('- id: hello') &&
        // 备份里必须是改动前的原文
        backup === realPatch &&
        bad.ok === false &&
        fs.readFileSync(file, 'utf8') === after
      );
    })(),
  );
  check(
    '插件页：条目上有禁用 / 启用，内置包被拦下时给「插进我的层」',
    /editLayer\(entry\.disabled \? 'enable' : 'disable', entry\.id\)/.test(vueSource) &&
      /editLayer\('remove-insert', entry\.id\)/.test(vueSource) &&
      /opNeedsEnable/.test(vueSource) &&
      /pluginEditLayer/.test(flatIpc),
  );
  // ---------------------------------------------------------- 救援（P2）
  //    dsh 因为插件起不来、或配置被改坏时，这一页要能把人捞出来。两条出路：
  //    「只看内置层」（配置坏掉时它照样能成）与「临时停用某个 bundle」（改 package.json，
  //    恢复时插回原位置 —— 层序就是覆盖顺序，追加到末尾会把"恢复"变成"挪到最后"）。
  const realManifest = fixture('profile/package.json');
  check(
    '救援：临时停用 / 恢复 bundle 记住原位置（恢复之后与原文一字不差）',
    (() => {
      const suspended = profileBundles.suspendBundle(realManifest, '@deepseek-ai/dsh-web-app');
      const restored = profileBundles.restoreBundle(
        suspended.text,
        '@deepseek-ai/dsh-web-app',
        suspended.index,
      );
      const again = profileBundles.suspendBundle(realManifest, '不在列表里');
      return (
        suspended.changed &&
        suspended.index === 1 &&
        !suspended.text.includes('dsh-web-app') &&
        // 其余键原样保留
        suspended.text.includes('patchReload') &&
        suspended.text.includes('"dependencies": {}') &&
        restored.changed &&
        restored.text === realManifest &&
        !again.changed
      );
    })(),
  );
  // 界面重开之后内存里那条"刚停用"的记录就没了 —— 恢复不能因此插错位置（层序就是覆盖顺序）。
  // 出路是读改动前的备份：最近的一份里就写着它当时在第几位。
  check(
    '救援：没带位置也能从改动前的备份里找回它原来在第几位（找不到就放末尾、并说实话）',
    (() => {
      const dir = path.join(sandbox, 'bundle-recover');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'package.json');
      // 备份 = 改动前的样子（`@deepseek-ai/dsh-web-app` 在第 2 位）
      fs.writeFileSync(path.join(dir, 'package.json.bak-20260925-101010'), realManifest, 'utf8');
      fs.writeFileSync(
        file,
        profileBundles.suspendBundle(realManifest, '@deepseek-ai/dsh-web-app').text,
        'utf8',
      );

      const restored = profileBundles.applyBundleEdit(dir, 'restore', '@deepseek-ai/dsh-web-app');
      const after = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        dsh: { profile: { bundles: string[] } };
      };
      return (
        restored.ok === true &&
        restored.index === 1 &&
        after.dsh.profile.bundles[1] === '@deepseek-ai/dsh-web-app' &&
        // 位置是从哪份备份里找回来的，要说出来（人才能核对）
        /package\.json\.bak-20260925-101010/.test(restored.detail ?? '') &&
        // 没有那份记录时：不假装知道，老实追加到末尾
        profileBundles.recoverBundleIndex(dir, '从来没在列表里过') === null
      );
    })(),
  );
  check(
    '救援：只剩注释的补丁层能补成空数组；有内容的文件它不动',
    (() => {
      const broken = '# 只剩注释\n# 还是没有数组\n';
      const fixed = patchLayer.repairEmptyArray(broken);
      const untouched = patchLayer.repairEmptyArray(realPatch);
      const empty = patchLayer.repairEmptyArray('');
      return (
        fixed.changed &&
        /^\[\]$/m.test(fixed.text) &&
        // 注释保住，只在后面补 []
        fixed.text.includes('# 只剩注释') &&
        !untouched.changed &&
        untouched.text === realPatch &&
        empty.changed &&
        /^\[\]$/m.test(empty.text)
      );
    })(),
  );
  check(
    '救援：备份按时间倒序列出；恢复只认这份 profile 里的 .bak-（递来的路径不可信）',
    (() => {
      const dir = path.join(sandbox, 'patch-rescue');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'cordis.patch.yml');
      fs.writeFileSync(file, '# 坏掉的\n', 'utf8');
      fs.writeFileSync(
        path.join(dir, 'cordis.patch.yml.bak-20260101-000000'),
        '# 旧备份\n',
        'utf8',
      );
      fs.utimesSync(
        path.join(dir, 'cordis.patch.yml.bak-20260101-000000'),
        new Date(1000),
        new Date(1000),
      );
      fs.writeFileSync(
        path.join(dir, 'cordis.patch.yml.bak-20260102-000000'),
        '- id: from-backup\n',
        'utf8',
      );
      const list = patchLayer.listPatchBackups(dir);
      const refused = patchLayer.restorePatchBackup(dir, '/etc/passwd');
      const restored = patchLayer.restorePatchBackup(dir, list[0]?.path ?? '');
      const after = fs.readFileSync(file, 'utf8');
      const savedCurrent = restored.backup ? fs.readFileSync(restored.backup, 'utf8') : '';
      return (
        list.length === 2 &&
        // 最近的在前
        list[0].name === 'cordis.patch.yml.bak-20260102-000000' &&
        refused.ok === false &&
        restored.ok === true &&
        after === '- id: from-backup\n' &&
        // 恢复之前那份"坏掉的"也被备份了 —— 这一步同样可逆
        savedCurrent === '# 坏掉的\n'
      );
    })(),
  );
  check(
    '救援：dump 读不出来时也带上 bundle 清单，且只有非内置的才给「临时停用」',
    /bundles\?: \{ name: string; inBox: boolean \}\[\]/.test(flatIpc) &&
      /inBox: dshRoot !== null/.test(pluginSource) &&
      // 失败时提前返回也要带着它（否则"bundle 解析不到"这种救援场景无从下手）
      /bundles,\n\s*\};/.test(pluginSource) &&
      /!item\.inBox && line\.includes\(item\.name\)/.test(vueSource),
  );
  check(
    '救援：界面上有「修成空配置」与「从备份恢复」，契约里有 pluginRescue',
    /repairLayer/.test(vueSource) &&
      /restoreBackup/.test(vueSource) &&
      /loadBackups/.test(vueSource) &&
      /pluginRescue/.test(vueSource) &&
      /pluginRescue/.test(flatIpc),
  );
  check(
    '救援：配置坏掉时「只看内置层」这条路还在（--dump-default-config，不解析你的层）',
    /--dump-default-config/.test(pluginSource) &&
      /baseline: true/.test(pluginSource) &&
      /pluginDefaultConfig/.test(flatIpc) &&
      /pluginBundleEdit/.test(flatIpc),
  );
  check(
    '救援：基线视图不会被「读不出来」的空态挡住（否则点了按钮什么也看不到）',
    /error && !baseline/.test(vueSource) && /data && !baseline/.test(vueSource),
  );
  check(
    '救援：基线视图里不给作用于真实配置的动作（条目上的、以及巡检那块的两个按钮）',
    // 条目上的动作
    /v-if="!baseline"/.test(vueSource) &&
      // 巡检那块整块藏掉：它说的都是真实配置，而这一屏明说"不是你现在生效的配置"
      /problems\.length && !baseline/.test(vueSource),
  );
  check(
    '救援：界面有救援条与两个出口，而不是只显示一句错误',
    /loadBaseline/.test(vueSource) &&
      /plugin-rescue/.test(vueSource) &&
      /editBundle\('suspend'/.test(vueSource) &&
      /editBundle\('restore'/.test(vueSource) &&
      /showRescue/.test(vueSource),
  );
  // 停用**不是单向门**。原来「恢复」只长在救援条里，而救援条只在 dsh 起不来时出现 ——
  // 在层栈详情里点「临时停用」的人，dsh 明明好好的，于是界面上再也找不到"放回去"。
  check(
    '救援：「放回层里」不依赖救援条 —— 巡检那行里也有，黄条上也有（停用之后回得去）',
    // t53 起"哪条能放回 / 那一档叫什么"这些判据住在 lib/plugin-view.ts，所以要读整份渲染层源码
    /if \(kind === 'suspended-bundle'\) return '掉出了层列表'/.test(rendererAll) &&
      /function canRestore\(item: PluginProblem\): boolean/.test(rendererAll) &&
      /restoreProblem\(item\)/.test(vueSource) &&
      /放回层里/.test(vueSource) &&
      /id="btn-plugin-restore-bundle"/.test(vueSource) &&
      /editBundle\('restore', suspended\.name, suspended\.index\)/.test(vueSource) &&
      // 两种"不形成层"都能卸；只有被摘掉的那种能放回
      /item\.kind === 'plain-dependency' \|\| item\.kind === 'suspended-bundle'/.test(rendererAll),
  );
  check(
    '插件安装：spec 是一个 argv（不拼 shell）、PATH 补过 pnpm、输出双向都收',
    // 起的是**包装器算好的 spec**（不是裸 file/args），并且必须把 verbatim 传下去：
    // Windows 上 shim / npx / 自定义 shim 走 cmd.exe，漏了这个标志就报 not recognized
    /spawn\(spec\.file, spec\.args,/.test(pluginSource) &&
      /windowsVerbatimArguments: spec\.windowsVerbatimArguments/.test(pluginSource) &&
      // 补 PATH 走 envWithKnownBins（保留系统原有的键名，见下一条）
      /envWithKnownBins\(process\.env\)/.test(pluginSource) &&
      /stdio: \['ignore', 'pipe', 'pipe'\]/.test(pluginSource) &&
      // 相对路径按 cwd 解析，cwd 不能继承（Electron 的启动目录不可预测）
      /cwd: homeDir\(\)/.test(pluginSource) &&
      !/shell:\s*true/.test(pluginSource) &&
      /child\.stderr\?\.on\('data', collect\)/.test(pluginSource),
  );
  check(
    '插件安装：pnpm 说"这是 workspace root"时用 -w 重试一次（dsh 模板缺 ignore-workspace-root-check）',
    /ADDING_TO_ROOT\|workspace root/.test(pluginSource) &&
      /specFor\(\['-w'\]\)/.test(pluginSource) &&
      // 第一次调用不带 -w（只有在 pnpm 明确要求时才加）
      /specFor\(\[\]\), env, onOutput\)/.test(pluginSource),
  );
  // 「启动 dsh」这条路的三种回退 launcher（process-utils 的 shim / npx / 自定义 shim 分支）：
  // 它们给的都是 cmd.exe + `/d /s /c`，所以包装后的 spec 必须是「单个 /c 字符串 + 外层引号 +
  // verbatim」。钉「形状 + 标志位」两样，不只看 argv 文本（F1 当初就是因为只钉文本而漏掉标志位）。
  const envDshFallbacks: { kind: string; launcher: processUtils.DshLauncher }[] = [
    {
      kind: 'shim',
      launcher: {
        file: processUtils.COMSPEC,
        prefixArgs: ['/d', '/s', '/c', '"D:\\Node\\nodejs\\dsh.cmd"'],
        viaCmd: true,
        display: 'D:\\Node\\nodejs\\dsh.cmd',
        kind: 'shim',
      },
    },
    {
      kind: 'npx',
      launcher: {
        file: processUtils.COMSPEC,
        prefixArgs: ['/d', '/s', '/c', '"D:\\Node\\nodejs\\npx.cmd"', '-y', '@deepseek-ai/dsh'],
        viaCmd: true,
        display: 'D:\\Node\\nodejs\\npx.cmd -y @deepseek-ai/dsh',
        kind: 'npx',
      },
    },
    {
      kind: 'custom-shim',
      launcher: {
        file: processUtils.COMSPEC,
        prefixArgs: ['/d', '/s', '/c', '"C:\\Program Files\\my tools\\dsh.cmd"'],
        viaCmd: true,
        display: '"C:\\Program Files\\my tools\\dsh.cmd"',
        kind: 'custom-shim',
      },
    },
  ];
  const envDshSpecs = envDshFallbacks.map((item) => ({
    kind: item.kind,
    spec: processUtils.dshLaunchSpec(item.launcher, ['web', '--no-open'], 'win32'),
  }));
  check(
    '环境自检：启动 dsh 的回退 launcher（shim / npx / 自定义 shim）在 Windows 上真的起得来',
    envDshSpecs.every(
      ({ spec }) =>
        spec.file === processUtils.COMSPEC &&
        processUtils.isRunnablePath(spec.file, 'win32') &&
        spec.windowsVerbatimArguments === true &&
        // /d /s /c + **整条命令拼成一个参数**（这样 cmd 的 /s 剥掉最外层引号后才是真命令行）
        spec.args.length === 4 &&
        spec.args[0] === '/d' &&
        spec.args[1] === '/s' &&
        spec.args[2] === '/c' &&
        spec.args[3].startsWith('""') &&
        spec.args[3].endsWith('"') &&
        // 子命令（`web --no-open`）在同一个字符串里，没有被拆成独立 argv
        / web --no-open"$/.test(spec.args[3]),
    ),
    envDshSpecs.map(({ kind, spec }) => `${kind}: ${spec.file} ${spec.args.join(' ')}`).join(' | '),
  );
  if (!IS_WINDOWS) {
    skip(
      '环境自检：回退 launcher 是**从 PATH 真解析出来**的（而不是手工构造的夹具）',
      '那三条回退分支（shim / npx）只在 Windows 上生效',
    );
  } else {
    // 真解析一遍：把 PATH 指向只放着 `dsh.cmd`（或 `npx.cmd`）的夹具目录，
    // resolveDshLauncher 就会落到对应的回退分支上 —— 离线、不起任何子进程。
    const fallbackDir = path.join(sandbox, 'dsh-fallback');
    fs.mkdirSync(fallbackDir, { recursive: true });
    const pathBefore = process.env.PATH;
    const resolved: string[] = [];
    try {
      // 1) shim：PATH 里只有 dsh.cmd，且没有 node → 解析器落到 shim 分支
      const shimDir = path.join(fallbackDir, 'shim');
      fs.mkdirSync(shimDir, { recursive: true });
      fs.writeFileSync(path.join(shimDir, 'dsh.cmd'), '@echo off\r\n');
      process.env.PATH = shimDir;
      const shimLauncher = processUtils.resolveDshLauncher({ ...settings.all(), dshCommand: '' });
      const shimSpec = processUtils.dshLaunchSpec(shimLauncher, ['web'], 'win32');
      resolved.push(`shim=${shimLauncher.kind}`);
      check(
        '环境自检：PATH 里只有 dsh.cmd 时解析成 shim，且包装后的 spec 带 verbatim',
        shimLauncher.kind === 'shim' &&
          shimSpec.file === processUtils.COMSPEC &&
          shimSpec.windowsVerbatimArguments === true &&
          /dsh\.cmd" web"$/.test(shimSpec.args[3]),
      );
      // 2) npx：PATH 里只有 npx.cmd（没有 dsh shim、没有 node）
      const npxDir = path.join(fallbackDir, 'npx');
      fs.mkdirSync(npxDir, { recursive: true });
      fs.writeFileSync(path.join(npxDir, 'npx.cmd'), '@echo off\r\n');
      process.env.PATH = npxDir;
      const npxLauncher = processUtils.resolveDshLauncher({ ...settings.all(), dshCommand: '' });
      const npxSpec = processUtils.dshLaunchSpec(npxLauncher, ['web'], 'win32');
      resolved.push(`npx=${npxLauncher.kind}`);
      check(
        '环境自检：PATH 里只有 npx.cmd 时解析成 npx，且包装后的 spec 带 verbatim',
        npxLauncher.kind === 'npx' &&
          npxSpec.file === processUtils.COMSPEC &&
          npxSpec.windowsVerbatimArguments === true &&
          /npx\.cmd" -y @deepseek-ai\/dsh web"$/.test(npxSpec.args[3]),
      );
      // 3) custom-shim：设置里写死的 .cmd（不需要改 PATH）
      const customLauncher = processUtils.resolveDshLauncher({
        ...settings.all(),
        dshCommand: path.join(fallbackDir, 'shim', 'dsh.cmd'),
      });
      const customSpec = processUtils.dshLaunchSpec(customLauncher, ['web'], 'win32');
      resolved.push(`custom=${customLauncher.kind}`);
      check(
        '环境自检：自定义命令写 .cmd 时解析成 custom-shim，且包装后的 spec 带 verbatim',
        customLauncher.kind === 'custom-shim' &&
          customSpec.file === processUtils.COMSPEC &&
          customSpec.windowsVerbatimArguments === true,
      );
    } finally {
      process.env.PATH = pathBefore;
    }
  }
  check(
    '插件安装：契约里有 3 个 API 与操作结果类型',
    (() => {
      // t55 起契约按主题拆在 shared/ipc-*.ts 里 → 读整份
      const ipc = repo.ipcSource;
      return (
        /pluginRun: \(request: \{ action: PluginOpAction; spec: string \}\) => Promise<PluginOpResult>/.test(
          ipc,
        ) &&
        /pluginCancel: \(\) => Promise<boolean>/.test(ipc) &&
        /onPluginOutput:/.test(ipc) &&
        /export type PluginOpAction = 'add' \| 'remove' \| 'update'/.test(ipc)
      );
    })(),
  );

  check(
    '插件：只碰 web profile（desktop 是 CLI 保留给 Electron 的，传进去直接报错）',
    pluginManager.PLUGIN_PROFILE === 'web' &&
      /PLUGIN_PROFILE/.test(pluginSource) &&
      !/'--profile',\s*'desktop'/.test(pluginSource) &&
      !/"--profile",\s*"desktop"/.test(pluginSource),
  );
}
