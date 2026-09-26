'use strict';

/**
 * 自检第 7 组：主题、样式与视觉契约。
 *
 * 「整份样式」自 t48 起是**两层**：全局表（变量 / 主题 / 骨架 / 共享件）+ 各组件自己的
 * `<style>` 块。变量块与主题仍在全局表里 —— 那不是页面私有的东西，所以读变量块的检查
 * 只看全局表；查"某条规则还在不在"的走两层（否则页面规则搬进组件后会成片假红）。
 *
 * 整段从 `test/selftest.ts` 的 `main()` 里搬出来，行为一字未改 —— 搬完的证据是自检输出
 * 逐行一致（314 条同名、同值、同顺序）；两层样式表与取规则体的 `cssBlock` 由 `repo` 提供。
 */

import fs from 'node:fs';
import path from 'node:path';

import { DEFAULTS } from '../../src/main/settings';
import * as restartNav from '../../src/renderer/state/restart-nav.js';

import { check } from '../harness';
import type { Repo } from '../repo';

export function runStyles(repo: Repo): void {
  const {
    rendererDir,
    vueSource,
    rendererJs,
    markup,
    rendererCode,
    css,
    allCss,
    escaped,
    cssBlock,
    uiPaneSource,
  } = repo;

  check('主题：CSS 定义了亮色变量块', /:root\[data-theme='light'\]\s*\{/.test(css));

  // 深色基础块 + 亮色覆盖块之外不应再出现硬编码颜色，否则亮色下会漏改。
  // 先剥注释：解释性注释里常引用颜色字面量（例如说明"xterm 自带样式写死了 #000"），
  // 那不是样式声明，不该报（这类误报已经出现三次）。两层都要查 —— 搬进组件的规则
  // 同样是"亮色下会漏改"的一份。
  const cssCode = allCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const withoutVarBlocks = cssCode
    .replace(/:root\s*\{[\s\S]*?\n\}/, '')
    .replace(/:root\[data-theme='light'\]\s*\{[\s\S]*?\n\}/, '');
  const strayColors = [...withoutVarBlocks.matchAll(/#[0-9a-fA-F]{3,6}\b|rgba?\(/g)].map(
    (match) => match[0],
  );
  check(
    '主题：样式表除变量块外没有硬编码颜色',
    strayColors.length === 0,
    strayColors.length ? `残留 ${[...new Set(strayColors)].join(', ')}` : '全部走 CSS 变量',
  );

  // 主题无关的尺度令牌（字号、圆角、字体）不需要亮色重复定义，只需要覆盖颜色令牌
  const parseVars = (block: string | null | undefined): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const match of String(block || '').matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi))
      out[match[1]] = match[2].trim();
    return out;
  };
  const isColorValue = (value: string): boolean => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(value);
  const darkBlock = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  const lightBlock = css.match(/:root\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/);
  const darkVars = parseVars(darkBlock && darkBlock[1]);
  const lightVars = parseVars(lightBlock && lightBlock[1]);
  const darkColors = Object.keys(darkVars).filter((name) => isColorValue(darkVars[name]));
  const uncovered = darkColors.filter((name) => !(name in lightVars));
  check(
    '主题：亮色覆盖了深色的全部颜色变量',
    uncovered.length === 0,
    uncovered.length ? `未覆盖 ${uncovered.join(', ')}` : `${darkColors.length} 个颜色变量`,
  );

  const usedVars = new Set([...css.matchAll(/var\(--([a-z0-9-]+)/gi)].map((match) => match[1]));
  const undefinedVars = [...usedVars].filter((name) => !(name in darkVars) && !(name in lightVars));
  check(
    '主题：样式里 var() 引用的变量都有定义',
    undefinedVars.length === 0,
    undefinedVars.length ? `未定义 ${undefinedVars.join(', ')}` : `${usedVars.size} 个引用`,
  );

  const openBraces = (css.match(/\{/g) || []).length;
  const closeBraces = (css.match(/\}/g) || []).length;
  check('样式：花括号配对', openBraces === closeBraces, `${openBraces} / ${closeBraces}`);

  // @font-face 指到不存在的文件会静默回退到系统字体，等于"刻意选字体"这件事白做了。
  // 引号不挑：Prettier 会按 singleQuote 配置把 url() 里的引号统一成单引号。
  const fontUrls = [...css.matchAll(/url\(["']([^"']+\.woff2)["']\)/g)].map((match) => match[1]);
  const missingFonts = fontUrls.filter((rel) => !fs.existsSync(path.resolve(rendererDir, rel)));
  check(
    '字体：@font-face 引用的文件都存在',
    fontUrls.length > 0 && missingFonts.length === 0,
    missingFonts.length ? `缺失 ${missingFonts.join(', ')}` : `${fontUrls.length} 个 woff2`,
  );

  // 页面容器不能用 display:none 隐藏：<webview> 会以 0 尺寸挂载 guest，
  // 切回来时 guest 的视口可能还是旧的 —— 症状是内嵌页只渲染出顶部一小条。
  const paneBlock = css.match(/\n\.pane\s*\{([\s\S]*?)\n\}/);
  const paneBody = paneBlock ? paneBlock[1] : '';
  const paneUsesDisplayNone = /display:\s*none/.test(paneBody);
  check(
    '样式：页面容器靠 visibility 隐藏，不用 display:none',
    !paneUsesDisplayNone && /visibility:\s*hidden/.test(paneBody),
    paneUsesDisplayNone
      ? '又用回 display:none 了（webview 会拿到错误视口）'
      : 'visibility: hidden + absolute',
  );

  // 每个 <webview> 都必须在样式里拿到明确高度。漏一个，它就会退化成浏览器默认的
  // 替换元素尺寸（约 300×150），内嵌页只剩顶部一小条 —— 这个坑真踩过一次。
  const hasSizedRule = (selector: string): boolean => {
    const rule = css.match(new RegExp(`${escaped(selector)}\\s*\\{([\\s\\S]*?)\\n\\}`));
    return rule ? /(^|\s)(height|inset)\s*:/.test(rule[1]) : false;
  };
  // 扫 markup（HTML + .vue）：webview 现在住在页面组件里。
  // 先剥掉注释：注释里常拿 `<webview>` 这种示意写法举例，会被"找标签"的正则误当成真标签。
  const markupCode = markup.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const webviews = [...markupCode.matchAll(/<webview\b[^>]*>/g)].map((match) => match[0]);
  const unsizedViews = webviews.filter((tag) => {
    const id = (tag.match(/id="([^"]+)"/) || [])[1];
    const classes = ((tag.match(/class="([^"]+)"/) || [])[1] || '').split(/\s+/).filter(Boolean);
    const selectors = [...(id ? [`#${id}`] : []), ...classes.map((name) => `.${name}`)];
    return !selectors.some(hasSizedRule);
  });
  check(
    '样式：每个 webview 都有明确高度的样式',
    webviews.length === 2 && unsizedViews.length === 0,
    unsizedViews.length
      ? `没尺寸规则：${unsizedViews.length} 个`
      : `${webviews.length} 个 webview 都有`,
  );

  // 标记里写了但样式表里没有的 class，通常意味着"这块还没做完"。
  // 用 markup（HTML + .vue 模板）：迁到 Vue 的页面不能因此脱离这条覆盖。
  // 两种来源都要认：
  //   1. 静态 `class="a b"` —— 但要排除 `:class` 绑定（值是表达式，不是类名）
  //   2. 动态 `:class="{ active: 条件, 'is-on': 条件 }"` —— 取花括号里的键名
  const staticClasses = [...markup.matchAll(/(?<!:)class="([^"]+)"/g)]
    .flatMap((match) => match[1].split(/\s+/))
    .filter((name) => name && !/[{}():]/.test(name));
  const dynamicClasses = [...markup.matchAll(/:class="\{([^}]*)\}"/g)]
    .flatMap((match) =>
      match[1].split(',').map((pair) => pair.split(':')[0].trim().replace(/^'|'$/g, '')),
    )
    .filter((name) => /^[a-zA-Z][\w-]*$/.test(name));
  const htmlClasses = new Set([...staticClasses, ...dynamicClasses]);
  const cssClasses = new Set([...allCss.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]));
  const unstyled = [...htmlClasses].filter((name) => !cssClasses.has(name));
  check(
    '样式：标记用到的 class 都有对应样式（HTML + .vue，两层样式表都算）',
    unstyled.length === 0,
    unstyled.length ? `未定义样式 ${unstyled.join(', ')}` : `${htmlClasses.size} 个 class`,
  );

  // t48 样式分层。判据是"这个 class 只有这一页在用"，搬走的必须是私有的：
  //   - 搬进组件后**全局表里不许再有一份** —— 两份定义谁生效要看谁更具体（scoped 会 +1 个属性
  //     选择器），正是分层想消灭的那种推理；
  //   - 跨组件的共享件（`.check` 被 5 处画、`.panel-block > .hint` 多处用）**必须留在全局表**，
  //     否则搬进某一个组件后，别的页面就没有这条样式了。
  // 查"规则在不在"要先剥注释：两张表里都有解释性注释点名这些 class（"设置页那一族（.settings…）"），
  // 拿原文去 match 会把注释当成定义 —— 这正是这类检查最容易骗过自己的地方。
  const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // 组件按「一处一目录」散在 `pages/*` / `gate/` / `layout/` 下 —— 按**文件名**找（重名当场抛错）
  const readScoped = (file: string): string => {
    const text = fs.readFileSync(repo.vuePath(file), 'utf8');
    // **行首锚定**：组件里的注释会引用这个标签（"这些规则原来在 …… 里"），不锚定就会从注释
    // 那一处开始吞、把 script 与 template 都算成块内容。
    const body = text.match(/^<style[^>]*scoped[^>]*>([\s\S]*?)^<\/style>/m)?.[1] ?? '';
    return body.replace(/\/\*[\s\S]*?\*\//g, '');
  };
  // 改一页就往这张表里加一行。它同时守住三件事：
  //   ① 搬走的私有规则**不许在全局表里留第二份**；② `staysGlobal` 的共享件**不许被搬走**；
  //   ③ 组件里**真有**那些规则 —— 别只删不加。
  const styleLayers: { pane: string; scoped: string[]; staysGlobal: string[] }[] = [
    {
      pane: 'SettingsPane.vue',
      scoped: [
        '.settings',
        '.form-row',
        '.input-suffix',
        '.update-head',
        '.update-title',
        '.update-phase',
        '.update-progress',
        '.update-bar',
        '.spotlight',
        // 这条原来误放在「控制台」一节里，其实只有设置页用（t48 第三批顺手收回来）
        '.settings-status',
      ],
      // 设置页画了、但是多页共用的：复选框行（5 处）、卡片后面那句提示（多处）
      staysGlobal: ['.check', '.panel-block > .hint'],
    },
    {
      pane: 'TerminalPane.vue',
      scoped: ['.term-body', '.term-view', '.shell-tab', '.shell-pane', '.chips', '.btn.outline'],
      // `.term-host` 的**基础**规则（relative + flex: 1 1 auto）两路终端共用，留在全局表（§7.30）
      staysGlobal: ['.term-host'],
    },
    {
      pane: 'DshTerminal.vue',
      scoped: ['.bar-title'],
      staysGlobal: ['.term-host'],
    },
    {
      pane: 'UiPane.vue',
      scoped: ['.ui-paste'],
      // 两个内嵌页共用的 webview 盒子留在全局表
      staysGlobal: ['.embedded-view', '.webview-wrap'],
    },
    {
      pane: 'GateBanner.vue',
      scoped: ['.gate-banner-actions'],
      staysGlobal: ['.banner'],
    },
    {
      pane: 'RailNav.vue',
      scoped: ['.rail', '.rail-brand', '.rail-nav', '.rail-item', '.rail-service', '.theme-switch'],
      // 跨组件布局契约（`.app` / `.workspace` / `.pane`，标记在 index.html 里）留在全局表
      staysGlobal: ['.pane', '.spacer'],
    },
    {
      pane: 'TopBar.vue',
      scoped: ['.topbar', '.page-title', '.topbar-note', '.immersive-only'],
      staysGlobal: ['.spacer'],
    },
    {
      pane: 'StatusBar.vue',
      scoped: ['.statusbar', '.kbd-hint', '.update-hint'],
      staysGlobal: ['.spacer'],
    },
    {
      pane: 'CloseDialog.vue',
      scoped: ['.close-dialog', '.close-card', '.close-title', '.close-lead', '.close-impact'],
      // `.check` 是多页共用的复选框行，留在全局表
      staysGlobal: ['.check'],
    },
    {
      pane: 'EnvGate.vue',
      scoped: ['.gate', '.gate-rail', '.gate-node', '.gate-node-dot', '.gate-brand', '.gate-queue'],
      // 与环境自检详情层共用的向导零件（EnvPane 复用选项 / 选择 / 确认 / 进度行）：留在全局表
      staysGlobal: [
        '.gate-option',
        '.gate-choice-group',
        '.gate-confirm-table',
        '.wizard-progress',
      ],
    },
    {
      // t58：向导的确认区拆成 gate/GateNodeConfirm.vue（只读的"将要执行"卡片）。
      // 它只带走了那条"加载中"的说明行；确认区的零件与父组件、自检页共用 → 进全局表。
      pane: 'GateNodeConfirm.vue',
      scoped: ['.gate-confirm-loading'],
      staysGlobal: [
        '.gate-confirm',
        '.gate-confirm-title',
        '.gate-confirm-cmd',
        '.gate-detail',
        '.gate-fact-more',
      ],
    },
    {
      // t61：EnvGate 拆出来的结果行（点色 + 结论 + 说明 + 那排出路）
      pane: 'GateResult.vue',
      scoped: ['.gate-result', '.gate-result-dot', '.gate-result-title', '.gate-result-note'],
      staysGlobal: ['.btn'],
    },
    {
      // t61：EnvGate 拆出来的选择区（版本档位 + 安装方法两组单选）
      pane: 'GateNodeChoice.vue',
      scoped: ['.gate-method-fact'],
      staysGlobal: ['.gate-option', '.gate-choice-row'],
    },
    {
      // t62：EnvGate 拆出来的操作行（一屏唯一一处强调色实底 + 一条次操作）。
      // 它自己**没有** `<style scoped>`：`.gate-actions` 父组件那两处也在用 → 在全局表（见下）。
      pane: 'GateActions.vue',
      scoped: [],
      staysGlobal: ['.gate-actions', '.gate-option-hint'],
    },
    {
      // t63：EnvGate 拆出来的事实行 / 进行中进度
      pane: 'GateFacts.vue',
      scoped: ['.gate-facts', '.gate-fact', '.gate-fact-detail', '.gate-fact-title'],
      staysGlobal: ['.wizard-progress', '.gate-fact-more'],
    },
    {
      pane: 'PluginPane.vue',
      // t59 起层栈视图与操作输出各是一个子组件：`.plugin-layer` / `.plugin-detail-actions` 与
      // `.plugin-op` 跟着它们走了，剩下的是这一页自己的（表头、救援、生效配置、安装行）。
      scoped: [
        '.plugin',
        '.plugin-views',
        '.plugin-problems',
        '.plugin-problem',
        '.plugin-install-input',
        '.plugin-rescue',
      ],
      // 与别处共用的：`.btn` / `.panel*` / `.banner` / `.hint` / `.empty` / `.spacer` / `.block-head`
      staysGlobal: ['.panel-block', '.block-head'],
    },
    {
      // t64：PluginPane 拆出来的生效配置视图（搜索 / 过滤 + 分组条目 + 行内改补丁层）
      pane: 'PluginConfigView.vue',
      scoped: ['.plugin-config', '.plugin-config-bar', '.plugin-search', '.plugin-group'],
      staysGlobal: ['.plugin-tag', '.plugin-entry', '.plugin-entry-list'],
    },
    {
      // t59：插件页拆出来的层栈视图（左边列表 + 右边详情）
      pane: 'PluginStackView.vue',
      scoped: [
        '.plugin-body',
        '.plugin-side',
        '.plugin-layer',
        '.plugin-stack',
        '.plugin-detail',
        '.plugin-meta',
        '.plugin-entries',
      ],
      // 与父组件的"生效配置"视图共用同一种条目 / 标签 → 进全局表（t59 收进去的）
      staysGlobal: ['.plugin-tag', '.plugin-entry', '.plugin-entry-list'],
    },
    {
      // t59：插件页拆出来的操作输出面板（原文照贴 + 中断 / 收起 / 插进我的层）
      pane: 'PluginOpPanel.vue',
      scoped: ['.plugin-op', '.plugin-op-head', '.plugin-op-out', '.plugin-op-actions'],
      staysGlobal: ['.plugin-tag'],
    },
    {
      pane: 'EnvPane.vue',
      // t60 起"更新 Node / pnpm 的确认区"是 pages/env/EnvUpdateConfirm.vue：`.env-channel` 跟着它走了，
      // `.env-confirm*` 因为这一页的"一键修复"确认区也画，收进了全局表（见下一行）。
      scoped: [
        '.env',
        '.env-scope',
        '.env-list',
        '.env-row',
        '.env-main',
        '.env-source',
        '.env-skip',
      ],
      // 与别处共用的：`.env-actions`（设置页「运行环境」卡也画）、`.env-op*`（环境向导的执行输出面板同形）
      staysGlobal: ['.env-actions', '.env-op'],
    },
    {
      // t60：环境自检页拆出来的"更新 Node / pnpm 的确认区"
      pane: 'EnvUpdateConfirm.vue',
      scoped: ['.env-channel'],
      // 与父组件的"一键修复"确认区共用同一套确认区零件 → 进全局表（t60 收进去的）
      staysGlobal: ['.env-confirm', '.env-confirm-title', '.env-confirm-cmd', '.env-confirm-line'],
    },
    {
      pane: 'DashboardPane.vue',
      scoped: [
        '.dash',
        '.focus-card',
        '.rule',
        '.stats',
        '.stat',
        '.meta-line',
        '.event-log',
        '.chart',
        '.spark',
        '.command',
      ],
      // `.panel` / `.panel-head` / `.panel-block` / `.hint` 是卡片零件，`.block-head` /
      // `.block-note` 插件页也在用 —— 都留在全局表；`.lamp` 是共享的指示灯基础形状
      staysGlobal: ['.panel-head', '.block-head', '.lamp'],
    },
    {
      pane: 'ArchivePane.vue',
      scoped: [
        '.archive',
        '.archive-body',
        '.archive-search-input',
        '.archive-item',
        '.archive-turn-body',
        '.archive-empty',
      ],
      staysGlobal: [],
    },
  ];
  const layerProblems: string[] = [];
  // 一律**行首锚定**：要查的是"这条选择器自己有没有被定义"，而不是"哪条选择器里提到了它"。
  // 反例：`.gate-rail` 在全局表里只作为 `html[…] body[…] .gate-rail { … }` 的**一部分**出现
  // （macOS 全屏要撤回门禁左轨的留白，见 §7.3）—— 用 contains 会把它误判成"私有规则没搬干净"。
  // 要求选择器**自成一条规则**：`^选择器` 后面只能跟 `,` 或 `{`（中间可空白）。
  // 只写行首锚定还不够 —— `.close-card .check { … }`（`.check` 是共享件，这一条留在全局表）
  // 与 `.topbar-note.lit { … }`（顶栏那格"亮一下"的变体）都会以 `.close-card` / `.topbar-note`
  // 开头，于是把"私有规则没搬干净"和"共享变体还在"混为一谈。
  const definedIn = (text: string, sel: string): boolean =>
    new RegExp(`^${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:,|\\{)`, 'm').test(text);
  for (const row of styleLayers) {
    const scopedRules = readScoped(row.pane);
    for (const sel of row.scoped) {
      if (definedIn(cssRules, sel)) layerProblems.push(`${row.pane}: ${sel} 还在全局表里`);
      if (!definedIn(scopedRules, sel)) layerProblems.push(`${row.pane}: 组件里缺 ${sel}`);
    }
    for (const sel of row.staysGlobal) {
      if (!definedIn(cssRules, sel)) layerProblems.push(`${row.pane}: 共享件 ${sel} 没留在全局表`);
      if (definedIn(scopedRules, sel))
        layerProblems.push(`${row.pane}: 共享件 ${sel} 被搬进组件了`);
    }
  }
  // v-html 渲染出来的元素没有 scope 属性，`.archive-turn-body <元素>` 必须写成 `:deep(...)`。
  // **多行选择器列表踩过**：`.archive-turn-body h1,\n h2,\n h3 { }` 只给最后一行加了 :deep()，
  // 前几行会编译成 `.archive-turn-body h2[data-v-x]` —— 一条都匹配不上（h2..h5、ul 就是这么漏的，
  // 靠"看构建产物里的选择器"才抓到）。`(?!\{)` 是因为 `.archive-turn-body {` 本来就该是普通写法。
  const archiveRules = readScoped('ArchivePane.vue');
  const deepLeaks = archiveRules
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\.archive-turn-body\s+(?!\{)\S/.test(line) && !line.includes(':deep('));
  check(
    '样式分层：页面私有的规则搬进组件的 <style scoped>，共享件留在全局表（v-html 内容走 :deep）',
    layerProblems.length === 0 &&
      // 私有规则列表非空的行，组件里就得真有那个块；`scoped: []` 的行（搬完之后一条私有规则
      // 都不剩、组件整个 <style scoped> 也删了）不算错 —— 它的两个 class 都在 staysGlobal 里。
      styleLayers.every((row) => row.scoped.length === 0 || readScoped(row.pane).length > 0) &&
      /\.archive-turn-body :deep\(/.test(archiveRules) &&
      // 段落标记必须**自成一行**：段落重写脚本会把最后一条规则的 `}` 与下一节标记粘成一行
      // （`} /* ==== 卡片 */`），那样 marker 正则就再也认不出那一节 —— 攒了几轮才一次性修掉 12 处。
      !/\}[ \t]*\/\* ={10,}/.test(css) &&
      deepLeaks.length === 0,
    layerProblems.length || deepLeaks.length
      ? [...layerProblems, ...deepLeaks.map((l) => `漏了 :deep：${l}`)].join('；')
      : `${styleLayers.length} 个页面、${styleLayers.reduce((n, r) => n + r.scoped.length, 0)} 条私有规则`,
  );

  // t66：上面那张表守的是"该搬的搬了、该留的留了"，但它**看不见规则够不够得着**那个元素 ——
  // 而 `<style scoped>` 的生效范围是：本组件模板里的元素 ＋（被别的组件当子组件用时）**它的根元素**
  // （根元素同时带上父组件的 scope id）。所以一条**自成规则**的类选择器（`.foo {`）只要被别的
  // 组件模板用到，在那边就是死规则。
  // 为什么两层表与像素夹具都抓不到：机械等价比的是"规则并集"，同一条 `.foo` 放全局还是放 scoped
  // 在并集里一模一样；像素夹具的静态标记**没有 data-v 属性**，scoped 与全局渲染结果相同。这类
  // 缺陷只有"谁够得着"能看出来。
  // 真实案例（用户真机翻看时发现）：t62 把 `.gate-actions { margin-top: 16px }` 搬进 `GateActions.vue`
  // 的 scoped 块，而 `EnvGate.vue` 的放行页与回看卡也在用同一个 class —— 那两处的按钮行贴着上面的
  // 清单，少了 16px。现在这条规则在全局表，并有这条自检守着。
  // 只看**自成一条规则**的选择器：带上下文的（`.close-card .btn-row`）本来就是"只在本组件内部生效"
  // 的覆盖，跨组件复用同一个 class 是正常的。`@media` 里的规则会被算成带上下文（保守，不误报）。
  const readVue = (rel: string): string => fs.readFileSync(path.join(rendererDir, rel), 'utf8');
  const templateClasses = (text: string): Set<string> => {
    const tpl = text.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? '';
    const names = new Set<string>();
    for (const m of tpl.matchAll(/\bclass="([^"]*)"/g)) {
      for (const n of m[1].split(/\s+/)) if (n) names.add(n);
    }
    // `:class="cond ? 'a' : 'b'"` 这类字面量分支也算用到；拼出来的字符串（\`x-${n}\`）不猜。
    for (const m of tpl.matchAll(/:class="([^"]*)"/g)) {
      for (const n of m[1].matchAll(/'([A-Za-z][\w-]*)'/g)) names.add(n[1]);
    }
    return names;
  };
  const usedBy = new Map<string, string[]>();
  for (const file of repo.vueFiles) {
    for (const cls of templateClasses(readVue(file.path))) {
      usedBy.set(cls, [...(usedBy.get(cls) ?? []), file.name]);
    }
  }
  const deadScoped: string[] = [];
  for (const { path: rel, name } of repo.vueFiles) {
    // **行首锚定**切块：`.vue` 里的说明性注释常引用这个标签（"这些规则原来在 …… 里"），
    // 不锚定的话，注释里那一处会被当成开始标记、把整份文件都算成块内容 —— 真踩过：
    // 注入回那个 bug 之后这条检查反而报了 PASS，因为块内容从注释一直吞到真正的 `</style>`。
    const blocks = readVue(rel).match(/^<style[^>]*scoped[^>]*>([\s\S]*?)^<\/style>/gm) ?? [];
    const bare = new Set<string>();
    for (const block of blocks) {
      const body = block
        .replace(/^<[^>]*>/, '')
        .replace(/<\/style>$/, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      for (const rule of body.matchAll(/([^{}]+)\{/g)) {
        for (const one of rule[1].split(',')) {
          const single = /^\.([A-Za-z][\w-]*)$/.exec(one.trim());
          if (single) bare.add(single[1]);
        }
      }
    }
    for (const cls of bare) {
      const others = (usedBy.get(cls) ?? []).filter((file) => file !== name);
      if (others.length) {
        deadScoped.push(`${name} 的 .${cls} 在 ${others.join(' / ')} 里够不着（应进全局表）`);
      }
    }
  }
  check(
    '样式分层：自成一条规则的私有类不会被别的组件用到（scoped 够不着别的模板）',
    deadScoped.length === 0,
    deadScoped.length
      ? deadScoped.join('；')
      : `${repo.vueFiles.length} 个组件、${usedBy.size} 个模板 class 都查过`,
  );

  check(
    '主题：终端两套配色都在（xterm 不走 CSS）',
    /TERM_THEMES[^=]*=\s*\{[\s\S]*?dark:\s*\{[\s\S]*?light:\s*\{/.test(rendererJs),
  );
  check('主题：设置里有 themeMode 默认值', DEFAULTS.themeMode === 'system');
  check(
    '主题：左下角开关与设置项都存在',
    markup.includes('id="theme-switch"') && markup.includes('id="s-themeMode"'),
    '开关在 layout/RailNav.vue，主题下拉框在 pages/settings/SettingsPane.vue',
  );

  // 启动锁必须是单向状态机（idle → waiting → done）。
  // 早期版本用布尔量 + 每次状态变化重新判定，结果解锁后只要条件又变回不满足
  // （用户手动退出全屏就会），锁会重新扣上来。这几条检查就是防它回归。
  const armCalls = (rendererJs.match(/setBootLock\(true\)/g) || []).length;
  check(
    '启动锁：只在一处上锁（idle → waiting）',
    armCalls === 1,
    `${armCalls} 处 setBootLock(true)`,
  );
  check('启动锁：解锁写入 done，不可逆', /bootLockState = 'done'/.test(rendererJs));
  check('启动锁：done 之后直接返回', /if \(bootLockState === 'done'\) return/.test(rendererJs));
  // t44（冻结 §0.4 的 R-32）：向导结束后的自动启动那一次也要上锁，但**不许**改成可重入 ——
  // 只加一个显式的第二回合；回合带 5 秒窗口，且只有放行页那条路开回合（逃生口不上锁）。
  // 计数与切片都先剥掉注释（注释里也会提到这些名字）。
  const bootLockCode = rendererJs.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const armAfterGateBody =
    bootLockCode.match(/function armAfterGate\(\): void \{[\s\S]*?\n\}/)?.[0] ?? '';
  const gateAutoStartBody =
    bootLockCode.match(/function wireGateAutoStart\(\): void \{[\s\S]*?\n\}/)?.[0] ?? '';
  const idleWrites = (bootLockCode.match(/bootLockState = 'idle';/g) || []).length;
  // t46 起"开回合"这件事收进了一个 `armEpisode()`：第二回合（向导之后）与第三回合（重启之后）
  // 都只委托给它，不许各自复制一遍体。5 秒窗口、"没有等待就不上锁"、不自己调 setBootLock
  // 这三条仍然逐字成立 —— 只是从 armAfterGate 挪到了 armEpisode。
  const armEpisodeBody = bootLockCode.match(/function armEpisode\([\s\S]*?\n\}/)?.[0] ?? '';
  const armAfterRestartBody =
    bootLockCode.match(/function armAfterRestart\(\): void \{[\s\S]*?\n\}/)?.[0] ?? '';
  check(
    '启动锁：向导之后的自动启动是"显式开的一个回合"（只委托给 armEpisode、带 5 秒窗口、自己不调 setBootLock）',
    armEpisodeBody.length > 200 &&
      armAfterGateBody.length > 60 &&
      /armEpisode\('afterGate'\);/.test(armAfterGateBody) &&
      /bootLockEpisode = episode;/.test(armEpisodeBody) &&
      /bootLockState = 'idle';/.test(armEpisodeBody) &&
      /GATE_ARM_WINDOW_MS/.test(armEpisodeBody) &&
      /if \(bootLockState === 'idle'\) bootLockState = 'done';/.test(armEpisodeBody) &&
      // 写 idle 的地方只有两处：声明那一行 + armEpisode。上锁本身仍然只有一处（idle → waiting）
      idleWrites === 1 &&
      /let bootLockState: BootLockState = 'idle';/.test(bootLockCode) &&
      !/setBootLock\(/.test(armEpisodeBody) &&
      !/setBootLock\(/.test(armAfterGateBody),
    `${idleWrites} 处 bootLockState = 'idle';`,
  );
  // t46：第三个回合（点了「重启 dsh」之后）。同样只委托给 armEpisode；锁文案按回合分开 ——
  // 重启那一轮不抢屏（规格 §1 的 4A），所以它的 note 不许提全屏。
  const lockCopyBody = bootLockCode.match(/const LOCK_COPY[\s\S]*?\n\};/)?.[0] ?? '';
  check(
    '启动锁：重启 dsh 之后是第三个回合（afterRestart），锁文案按回合分开、重启那轮不提全屏',
    armAfterRestartBody.length > 40 &&
      /armEpisode\('afterRestart', RESTART_ARM_WINDOW_MS\);/.test(armAfterRestartBody) &&
      // 重启要先把旧实例停掉、等端口释放（最长 10 秒），所以窗口比 R-32 那个长
      /const RESTART_ARM_WINDOW_MS = 20000;/.test(bootLockCode) &&
      // 中间相位（stopping / stopped）不许把这一回合收掉 —— 它的过期只由窗口定时器管
      /if \(bootLockEpisode !== 'afterRestart'\) bootLockState = 'done';/.test(bootLockCode) &&
      // 与第二回合不同：重启可能来第二次，所以**不带**幂等守卫
      !/bootLockEpisode === 'afterRestart'\) return/.test(armAfterRestartBody) &&
      ['startup', 'afterGate', 'afterRestart'].every((key) =>
        new RegExp(`${key}: \\{`).test(lockCopyBody),
      ) &&
      /afterRestart: \{[^}]*noteTail: '就绪后自动打开 DeepSeek Harness'/.test(lockCopyBody) &&
      !/afterRestart: \{[^}]*全屏/.test(lockCopyBody) &&
      (lockCopyBody.match(/并进入全屏/g) || []).length === 2,
  );
  // t46：就绪判据是**纯函数**，直接喂相位试 —— 只看 running 会切到"还没捕获到令牌"那一屏
  check(
    '重启后进 Harness：就绪判据 = 看见旧实例停过 + running + 已拿到带令牌地址（只看 running 会切到 401，立意图当场就判成到了）',
    restartNav.isRestartReady('running', 'http://127.0.0.1:3080/?token=abc') &&
      !restartNav.isRestartReady('running', null) &&
      !restartNav.isRestartReady('running', undefined) &&
      !restartNav.isRestartReady('starting', 'http://127.0.0.1:3080/?token=abc') &&
      // 真机踩到的那条：点下去那一刻旧实例还是 running + 带着旧令牌，**不许**当场判成"到了"
      !restartNav.restartArrived(
        {
          reason: 'plugin',
          outcome: 'pending',
          startedAt: 0,
          error: null,
          leftRunning: false,
          sawStarting: false,
          uiUrlAtBegin: 'http://127.0.0.1:3080/?token=old',
        },
        'running',
        'http://127.0.0.1:3080/?token=old',
      ) &&
      // 看见它停过之后（leftRunning）才算到
      restartNav.restartArrived(
        {
          reason: 'plugin',
          outcome: 'pending',
          startedAt: 0,
          error: null,
          leftRunning: true,
          sawStarting: true,
          uiUrlAtBegin: 'http://127.0.0.1:3080/?token=old',
        },
        'running',
        'http://127.0.0.1:3080/?token=new',
      ) &&
      // 万一没看见中间相位（快得不给观察机会）：令牌换了也算到（令牌是每进程随机的）
      restartNav.restartArrived(
        {
          reason: 'plugin',
          outcome: 'pending',
          startedAt: 0,
          error: null,
          leftRunning: false,
          sawStarting: false,
          uiUrlAtBegin: 'http://127.0.0.1:3080/?token=old',
        },
        'running',
        'http://127.0.0.1:3080/?token=new',
      ) &&
      // "起不来"也要先看见它 starting 过：重启必然经过 stopped，那一段不是失败（真机踩到过）
      !restartNav.restartStalled(
        {
          reason: 'plugin',
          outcome: 'pending',
          startedAt: 0,
          error: null,
          leftRunning: true,
          sawStarting: false,
          uiUrlAtBegin: null,
        },
        'stopped',
      ) &&
      restartNav.restartStalled(
        {
          reason: 'plugin',
          outcome: 'pending',
          startedAt: 0,
          error: null,
          leftRunning: true,
          sawStarting: true,
          uiUrlAtBegin: null,
        },
        'stopped',
      ) &&
      // "起不来"的三个终态：stopping / starting 还在路上，不算
      restartNav.isRestartStalled('stopped') &&
      restartNav.isRestartStalled('degraded') &&
      restartNav.isRestartStalled('conflict') &&
      !restartNav.isRestartStalled('starting') &&
      !restartNav.isRestartStalled('stopping') &&
      !restartNav.isRestartStalled('running') &&
      // 四个入口的文案各自不同（状态栏那句与到达提示都要能对上）
      new Set(
        (['plugin', 'dashboard', 'env', 'ui'] as const).map((reason) =>
          restartNav.readyMessage(reason),
        ),
      ).size === 4,
  );
  // t46：意图必须在调 restart 之前立 —— `start()` 一 spawn 就返回，晚立就错过那 5 秒上锁窗口
  const restartFlowSource = fs.readFileSync(repo.tsPath('restart-flow.ts'), 'utf8');
  const restartFlowBody =
    restartFlowSource
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .match(/export async function restartThenOpenHarness\([\s\S]*?\n\}/)?.[0] ?? '';
  check(
    '重启后进 Harness：意图在调用重启之前立（start 一 spawn 就返回，晚立就错过上锁窗口）',
    restartFlowBody.length > 200 &&
      // 立意图时把"当时的带令牌地址"一起带上（用来判断令牌到底换没换）
      /beginRestartNav\(reason, getDsh\(\)\?\.uiUrl \?\? null\)/.test(restartFlowBody) &&
      restartFlowBody.indexOf('beginRestartNav(reason') > 0 &&
      restartFlowBody.indexOf('beginRestartNav(reason') <
        restartFlowBody.indexOf("mode === 'start'") &&
      // 失败与"用户取消"分开处理：取消不该在界面上说成"重启失败"
      /if \(result\.cancelled\) clearRestartNav\(\)/.test(restartFlowBody) &&
      /else if \(!result\.ok\) settleRestartNav\('failed'/.test(restartFlowBody) &&
      // 编排这一层不许自己 setBootLock / 不许自己切页 —— 那是 app.ts 的事
      !/setBootLock\(|currentTab\.value =/.test(restartFlowBody),
  );
  // t46：四个入口共用同一条流程（规格 §1 的 3B + "顺带的第四处"）
  const entryFiles = ['PluginPane', 'DashboardPane', 'EnvPane', 'UiPane'];
  const entryMissing = entryFiles.filter(
    (name) =>
      !new RegExp(
        `restartThenOpenHarness\\(api, \\(\\) => dsh\\.value, '(plugin|dashboard|env|ui)'`,
      ).test(fs.readFileSync(repo.vuePath(`${name}.vue`), 'utf8')),
  );
  check(
    '重启后进 Harness：四个入口都走同一条流程（插件页 / 控制台 / 环境自检 / 重启为受管实例）',
    entryMissing.length === 0 &&
      // 页面里不许再有人自己调 restartFlow —— 那条路已经收进编排层 state/restart-flow.ts
      // （编排层自己当然要用它，所以这里只查四个页面，不查 rendererCode 合集）
      !entryFiles.some((name) =>
        /restartFlow\(/.test(fs.readFileSync(repo.vuePath(`${name}.vue`), 'utf8')),
      ) &&
      /restartThenOpenHarness/.test(rendererCode),
    entryMissing.length ? `缺：${entryMissing.join(', ')}` : `${entryFiles.length} 个入口`,
  );
  // t46：这两份源码要用在下面几条钉子里（黄条四态、到达提示）。`uiPaneSource` 后面第 12 节
  // 还要再用一次，所以在这儿声明一次就够（放在它们之前，别在下面重复声明）。
  const mergedPluginSource = fs.readFileSync(repo.vuePath('PluginPane.vue'), 'utf8');
  const restartNavCode = fs.readFileSync(repo.tsPath('restart-nav.ts'), 'utf8');
  const topBarSource = fs.readFileSync(repo.vuePath('TopBar.vue'), 'utf8');
  const stylesCode = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  // t46：黄条的四态 + Harness 页那条到达提示（可关闭）
  check(
    '重启后进 Harness：新一轮开始时收掉上一条到达提示（它说的是"上一轮已生效"）',
    /harnessArrivalNotice\.value = null;/.test(
      fs.readFileSync(repo.tsPath('restart-nav.ts'), 'utf8'),
    ) &&
      restartNav.beginRestartNav('plugin') === undefined &&
      restartNav.restartNav.value.outcome === 'pending' &&
      restartNav.harnessArrivalNotice.value === null,
  );
  // 黄条那两条规则的原文（按行取整段，避免 `[\s\S]*?` 跨到别的规则里去）
  const bannerBlock = stylesCode.match(/^\.banner \{[\s\S]*?^\}/m)?.[0] ?? '';
  const bannerIconBlock = stylesCode.match(/^\.banner \.i \{[\s\S]*?^\}/m)?.[0] ?? '';
  check(
    '重启后进 Harness：黄条有进行中 / 失败 / 未就绪 / 已生效四态，到达提示走顶栏那格已有的信息位（方案 A）',
    ['pending', 'failed', 'unready', 'external', 'escaped', 'ready'].every((state) =>
      new RegExp(`case '${state}':`).test(mergedPluginSource),
    ) &&
      /id="plugin-restart-line"/.test(mergedPluginSource) &&
      /id="btn-plugin-restart"/.test(mergedPluginSource) &&
      /:disabled="navPending"/.test(mergedPluginSource) &&
      // 到达提示 = 工具栏右端那条**已有**的状态槽亮一下（方案 A，见 docs/harness-arrival-design.html）：
      // 用户先否了"可关闭的常驻横条"（"给个轻提示就可以了"），又否了"浮在正文上的胶囊"
      // （"不好看，你学一下UI设计呗"）—— 所以既不新增表面、也不遮内容、也没有按钮。
      // 那一格是**顶栏**右侧的上下文信息（`#topbar-note`）——它窗口模式与全屏模式都在，
      // 而 Harness 页工具条右端那格在应用内全屏时整条被藏起来。
      /id="topbar-note"/.test(topBarSource) &&
      /harnessArrivalNotice\.value \|\| contextNote\.value/.test(topBarSource) &&
      /:class="\{ lit: harnessArrivalNotice \}"/.test(topBarSource) &&
      /import \{ harnessArrivalNotice \} from '[^']*restart-nav\.js';/.test(topBarSource) &&
      !/harnessArrivalNotice/.test(uiPaneSource) &&
      !/id="ui-arrival"/.test(uiPaneSource) &&
      !/class="toast"/.test(uiPaneSource) &&
      !/btn-ui-arrival-dismiss/.test(uiPaneSource) &&
      !/dismissHarnessArrival/.test(uiPaneSource) &&
      /ARRIVAL_TOAST_MS = 4000/.test(restartNavCode) &&
      /arrivalTimer = setTimeout\(/.test(restartNavCode) &&
      /harnessArrivalNotice\.value = null;\n {2}\}, ARRIVAL_TOAST_MS\);/.test(restartNavCode) &&
      // 文案要短（那一格宽度有限）；长解释留在插件页那条黄条里
      /plugin: '✓ 装配层改动已加载'/.test(restartNavCode) &&
      // 样式：只给状态槽加一层绿色底；浮层/胶囊那套已经删掉
      // `.topbar-note.lit` t48 起在 `layout/TopBar.vue` 的 <style scoped> 里
      /\.topbar-note\.lit \{[\s\S]*?color: var\(--run\);[\s\S]*?background: var\(--run-soft\);[\s\S]*?\}/.test(
        allCss,
      ) &&
      // 「已经删掉的那套」要两层都没有才算数
      /\.toast \{/.test(allCss) === false &&
      /\.banner\.arrival/.test(allCss) === false &&
      // 黄条的竖直居中**不能按"单行 / 两行"分叉**：同一条黄条在宽窗口是一行、窄窗口才是两行，
      // JS 判不出来 —— 老写法用 `line: !!navLine` 挂变体，于是"装/卸/升级"那条默认文案
      // （宽窗口下一行）永远拿不到覆盖，一直是偏上的（用户第二次抓图指出，真机量出来偏上 3.5px）。
      // 现在统一居中：两行时最高的那一项本来就是文本块，居中与顶对齐对它的位置没有影响。
      /align-items: center;/.test(bannerBlock) &&
      /align-items: flex-start;/.test(bannerBlock) === false &&
      bannerIconBlock.length > 0 &&
      /margin-top/.test(bannerIconBlock) === false &&
      /\.banner\.line/.test(allCss) === false &&
      // 那条宽度依赖的类在渲染层也不许再出现（注释里留着都会诱导人加回来）
      /banner\.line/.test(vueSource) === false &&
      /line: !!navLine/.test(vueSource) === false &&
      /:class="\{ rose: navOutcome === 'failed' \}"/.test(vueSource),
  );

  // t46：用户在锁上按「不等了」/ Esc 要**取消**这次跳转（唯一会取消的路径，规格 §2.4）
  const userSkipBody =
    bootLockCode.match(/function userSkipBootLock\(\): void \{[\s\S]*?\n\}/)?.[0] ?? '';
  const wireBootLockBody =
    bootLockCode.match(/function wireBootLock\(\): void \{[\s\S]*?\n\}/)?.[0] ?? '';
  check(
    '启动锁：锁上的「不等了」/ Esc 取消这一轮跳转（唯一会取消的路径）',
    userSkipBody.length > 80 &&
      /restartNav\.value\.outcome === 'pending'/.test(userSkipBody) &&
      /settleRestartNav\('escaped'\)/.test(userSkipBody) &&
      /releaseBootLock\(\);/.test(userSkipBody) &&
      /userSkipBootLock\(\)/.test(wireBootLockBody) &&
      // Esc 那条路也走它（两处都是"用户说别等了"）
      (bootLockCode.match(/userSkipBootLock\(\)/g) || []).length >= 3,
  );
  check(
    '启动锁：只有放行页那条路开第二回合（逃生口不上锁），且整个运行只试一次',
    gateAutoStartBody.length > 200 &&
      /if \(phase === 'entered'\) armAfterGate\(\);/.test(gateAutoStartBody) &&
      /if \(phase !== 'escaped' && phase !== 'entered'\) return;/.test(gateAutoStartBody) &&
      /if \(gateAutoStartTried\) return;/.test(gateAutoStartBody) &&
      // armAfterGate 只有"定义 + 这一处调用"
      (bootLockCode.match(/armAfterGate\(\)/g) || []).length === 2 &&
      // 上锁那一刻要把窗口定时器收掉（不然它 5 秒后还会去改状态）
      /clearTimeout\(gateArmTimer\)/.test(bootLockCode),
  );

  // 解锁条件里一旦掺进"当前是否全屏"，用户一退全屏就会重新满足上锁条件。
  // 只看代码，不看注释（注释里提到 immersive 是为了解释这个坑）。
  const updateBootLockBody =
    rendererJs.match(/function updateBootLock\([\s\S]*?\n {2}\}/)?.[0] || '';
  const updateBootLockCode = updateBootLockBody
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  check(
    '启动锁：解锁判定不看当前是否全屏',
    updateBootLockBody.length > 0 && !/immersive/.test(updateBootLockCode),
    updateBootLockBody ? `函数体 ${updateBootLockBody.length} 字符` : '没找到 updateBootLock',
  );

  // 锁必须盖满窗口、且盖住顶栏：左栏是贯穿全高的整列、顶栏又在最上面，
  // 留任何一条缝都会露出"DSH Console"品牌或页面标题（两次被用户抓图指出）。
  // 读**两层**样式表（`allCss` = 全局表 + 各组件 `<style>` 块）：t48 起页面自己的规则搬进了
  // 组件里，只看全局表会让"这条规则还在不在"这类断言成片假红（`EnvPane` 那两条就这么红的）。
  const lockZ = Number(cssBlock('.boot-lock').match(/z-index:\s*(\d+)/)?.[1] || 0);
  const topbarZ = Number(cssBlock('.topbar').match(/z-index:\s*(\d+)/)?.[1] || 0);
  check('启动锁：盖满窗口（inset: 0）', /inset:\s*0;/.test(cssBlock('.boot-lock')));
  check(
    '启动锁：顶栏也被盖住（没给它更高的 z-index）',
    lockZ > 0 && topbarZ < lockZ,
    `lock=${lockZ} topbar=${topbarZ}`,
  );
  check(
    '渲染层：整块内容区不画焦点环（main 的焦点是程序化交过去的，不是 Tab 来的）',
    (() => {
      const ring = cssBlock(':focus-visible');
      // 控件的焦点环必须原样留着（可达性），只掐掉 main 那一圈 —— 真机上用户报的
      // "多余的框"就是它（CDP 强制 :focus-visible 复现：顶部/左边/下边各一条蓝边）
      return (
        /outline:\s*2px solid var\(--focus\)/.test(ring) &&
        /outline-offset:\s*2px/.test(ring) &&
        /outline:\s*none/.test(cssBlock('main:focus-visible'))
      );
    })(),
    cssBlock('main:focus-visible').replace(/\s+/g, ' ').trim(),
  );
}
