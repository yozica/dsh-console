'use strict';

/**
 * 自检第 6 组：渲染层静态检查。
 *
 * 渲染层没有类型检查，这一组就是它的类型检查：元素 id / class / API 名拼错、挂载点断链、
 * 平台适配走样都在这儿挡。界面已经逐页迁到 Vue 单文件组件，所以**标记与脚本都要把 .vue
 * 一起算进来**（panes/ 是页面，shell/ 是外壳），否则迁走的部分会悄悄脱离覆盖。
 *
 * 整段从 `test/selftest.ts` 的 `main()` 里搬出来，行为一字未改 —— 搬完的证据是自检输出
 * 逐行一致（314 条同名、同值、同顺序）；它要的那些源码文本由 `repo` 统一读好。
 */

import fs from 'node:fs';
import path from 'node:path';

import { check } from '../harness';
import type { PackageJson, Repo } from '../repo';

export function runRenderer(repo: Repo): void {
  const { srcDir, rendererDir, html, vueFiles, markup, rendererCode, mountJs, root } = repo;
  // §6 里单独读了一次全局表（变量在下一节才定义，这里不提前引用 allCss）
  const cssText = repo.css;

  const htmlIds = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const jsIds = [
    ...new Set([...rendererCode.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1])),
  ];
  const missingIds = jsIds.filter((id) => !htmlIds.has(id));
  check(
    '渲染层：JS 引用的元素 id 都存在于标记里（HTML + .vue）',
    missingIds.length === 0,
    missingIds.length
      ? `缺少 ${missingIds.join(', ')}`
      : `${jsIds.length} 个 id（覆盖 ${vueFiles.length} 个 .vue）`,
  );

  // preload 已随主进程一起迁到 TS（src/preload/preload.ts），这里读它
  const preloadJs = fs.readFileSync(path.join(srcDir, 'preload', 'preload.ts'), 'utf8');
  const exposed = new Set([...preloadJs.matchAll(/^\s{2}([A-Za-z]+):/gm)].map((match) => match[1]));
  const apiCalls = [
    ...new Set([...rendererCode.matchAll(/\bapi\.([A-Za-z]+)\(/g)].map((match) => match[1])),
  ];
  const missingApi = apiCalls.filter((name) => !exposed.has(name));
  check(
    '渲染层：调用的 api.* 都在 preload 里暴露',
    missingApi.length === 0,
    missingApi.length ? `缺少 ${missingApi.join(', ')}` : `${apiCalls.length} 个方法`,
  );

  // 会话的"输入"与"输出"必须成对：只调 sessionInput 而不订阅 onSessionOutput，
  // 输入会送进 PTY，但 PTY 返回的提示符与回显没人接 —— 界面上就是"打字没反应"。
  // 迁移时正好漏了这条订阅（本地 Shell 全程没有回显），所以用检查盯住。
  const createsShell = /api\.createShell\(/.test(rendererCode);
  const wiresSession =
    /api\.sessionInput\(/.test(rendererCode) && /api\.onSessionOutput\(/.test(rendererCode);
  check(
    '渲染层：发起会话的页面同时接了输入与输出',
    !createsShell || wiresSession,
    createsShell
      ? wiresSession
        ? '输入/输出成对'
        : '有 createShell 但没有 onSessionOutput'
      : '没有会话功能',
  );

  // 每个组件都必须**有人用**：要么在 mount.ts 的挂载清单里，要么被别的组件 import
  //（t45 起「终端」页把 dsh 那一路拆成了子组件 DshTerminal，它不该出现在挂载清单里）。
  // 两种都不占的组件等于死代码 —— 界面上那块永远空着，或者根本没人渲染它。
  const allVueSources =
    mountJs +
    vueFiles
      .map(({ dir, name }) => fs.readFileSync(path.join(rendererDir, dir, name), 'utf8'))
      .join('\n');
  const unusedVue = vueFiles
    .filter(({ dir, name }) => {
      const stem = name.replace(/\.vue$/, '');
      // 两种写法都算：挂载清单里是 `./panes/X.vue`，同目录的组件之间是 `./X.vue`
      const specs = [
        dir === 'panes' ? `./panes/${stem}.vue` : `./shell/${stem}.vue`,
        `./${stem}.vue`,
      ];
      return !specs.some((spec) => allVueSources.includes(`from '${spec}'`));
    })
    .map(({ name }) => name);
  check(
    '渲染层：每个 .vue 组件都被用到（在挂载清单里，或被别的组件 import）',
    vueFiles.length > 0 && unusedVue.length === 0,
    unusedVue.length ? `没人用 ${unusedVue.join(', ')}` : `${vueFiles.length} 个组件`,
  );
  // 挂了终端的页面必须自己订阅容器尺寸变化。"靠全局 resize"或"切页时才 fit"都不够：
  // 本地 Shell 就因此不跟随窗口（踩过 —— 旧代码里是 app.js 的全局 resize 处理器负责，
  // 迁移时只搬进了终端页）。
  const terminalUsers = vueFiles.filter(({ dir, name }) =>
    fs.readFileSync(path.join(rendererDir, dir, name), 'utf8').includes('attachTerminal('),
  );
  const noObserver = terminalUsers
    .filter(
      ({ dir, name }) =>
        !fs.readFileSync(path.join(rendererDir, dir, name), 'utf8').includes('ResizeObserver'),
    )
    .map(({ name }) => name);
  check(
    '渲染层：用终端的页面都订阅了容器尺寸变化',
    terminalUsers.length > 0 && noObserver.length === 0,
    noObserver.length
      ? `缺 ResizeObserver：${noObserver.join(', ')}`
      : `${terminalUsers.length} 个页面`,
  );
  // 挂了终端的页面还要让应用快捷键穿过去：xterm 会把 Ctrl+2~6 当控制字符吃掉并停止冒泡，
  // 不调 attachCustomKeyEventHandler 的话，人在终端里按这些键切不动页面
  // （症状：只有 Ctrl+1 有效，因为 1 恰好不在 xterm 的按键表里）。
  const noShortcutPassthrough = terminalUsers
    .filter(
      ({ dir, name }) =>
        !fs
          .readFileSync(path.join(rendererDir, dir, name), 'utf8')
          .includes('passAppShortcutsThrough'),
    )
    .map(({ name }) => name);
  check(
    '渲染层：用终端的页面让应用快捷键穿过去',
    terminalUsers.length > 0 && noShortcutPassthrough.length === 0,
    noShortcutPassthrough.length
      ? `未放行：${noShortcutPassthrough.join(', ')}`
      : `${terminalUsers.length} 个页面`,
  );
  // 挂载点必须是"布局透明"的（display: contents）：否则组件渲染出的内容会多包一层块级元素，
  // 把父级的 flex/grid 链断掉 —— 症状是内嵌页只剩顶上一条（webview 退回默认高度）。
  // （css 变量在下面的主题一节才定义，这里单独读一次，别提前引用。）
  const rootIds = [...html.matchAll(/id="([\w-]*-root)"/g)].map((match) => match[1]);
  const contentsRules = (cssText.match(/#[\w-]*-root[^{]*\{[^}]*\}/g) || []).filter((rule) =>
    /display:\s*contents/.test(rule),
  );
  const declaredTransparent = new Set(
    contentsRules.flatMap((rule) => [...rule.matchAll(/#([\w-]*-root)/g)].map((match) => match[1])),
  );
  const notTransparent = rootIds.filter((id) => !declaredTransparent.has(id));
  check(
    '渲染层：每个挂载点都是 display: contents',
    rootIds.length > 0 && notTransparent.length === 0,
    notTransparent.length ? `未声明 ${notTransparent.join(', ')}` : `${rootIds.length} 个挂载点`,
  );
  check(
    '渲染层：外壳与页面的挂载点都在',
    rootIds.length >= 5 && /export function mountAll/.test(mountJs),
    `${rootIds.length} 个挂载点`,
  );

  // CSS 与 JS 的契约：样式用 body[data-xxx] 当开关，就必须有人去设置这个属性。
  // 漏掉的话按钮改了状态、界面毫无反应 —— 应用内全屏就这么整个失效过一次
  // （CSS 里 8 条规则全挂在 body[data-immersive] 上，而没人写它）。
  const bodyFlags = [
    ...new Set([...cssText.matchAll(/body\[data-([\w-]+)/g)].map((match) => match[1])),
  ];
  const unwiredFlags = bodyFlags.filter((flag) => {
    const camel = flag.replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
    return !new RegExp(`dataset\\.(?:${flag}|${camel})\\s*=`).test(rendererCode);
  });
  check(
    '渲染层：CSS 用到的 body[data-*] 开关都有人设置',
    bodyFlags.length > 0 && unwiredFlags.length === 0,
    unwiredFlags.length ? `没人设置 ${unwiredFlags.join(', ')}` : bodyFlags.join(', '),
  );

  // macOS 适配的契约一：红绿灯画在**窗口**左上角，而贴窗口左边的是左栏（.rail）——
  // 顶栏在左栏右侧，够不到红绿灯。踩过两次，所以四条都用检查钉住：
  //   1. 左栏顶部让出一条与标题栏等高的区域（padding-top）
  //   2. 顶栏只在「应用内全屏（左栏被藏掉、顶栏变成最左列）」时才让白
  //   3. 顶栏在非全屏时**不能**有左内边距（否则页面标题被冤枉缩进 84px）
  //   4. 系统全屏（红绿灯自动隐藏）时把 1、2 都撤回
  const platformJs = fs.readFileSync(path.join(rendererDir, 'lib', 'platform.ts'), 'utf8');
  check(
    '渲染层：macOS 红绿灯留白给左栏（应用内全屏让白、系统全屏撤回、非全屏顶栏不缩进）',
    /html\[data-platform='darwin'\]\s*\.rail\s*\{[^}]*padding-top/.test(cssText) &&
      /html\[data-platform='darwin'\]\s*body\[data-immersive='true'\]\s*\.topbar\s*\{[^}]*padding-left/.test(
        cssText,
      ) &&
      !/html\[data-platform='darwin'\]\s*\.topbar\s*\{[^}]*padding-left/.test(cssText) &&
      /html\[data-platform='darwin'\]\s*body\[data-native-fullscreen='true'\]\s*\.rail\s*\{[^}]*padding-top/.test(
        cssText,
      ) &&
      /html\[data-platform='darwin'\]\s*body\[data-native-fullscreen='true'\]\s*\.topbar[^{]*\{[^}]*padding-left/.test(
        cssText,
      ) &&
      // 门禁层是**另一条左轨**（.gate-rail）：全屏时它也得顶到窗口上沿，
      // 否则向导页的左栏会比"没有门禁时"低 36px（用户抓图指出过）
      /html\[data-platform='darwin'\]\s*body\[data-native-fullscreen='true'\]\s*\.gate-rail\s*\{[^}]*margin-top: calc\(-1 \* var\(--bar-h\)\)/.test(
        cssText,
      ) &&
      /html\[data-platform='darwin'\]\s*body\[data-native-fullscreen='true'\]\s*\.gate-rail\s*\{[^}]*padding-top: 16px/.test(
        cssText,
      ) &&
      /api\.onFullscreen\(/.test(rendererCode) &&
      /onFullscreen:/.test(preloadJs) &&
      /documentElement\.dataset\.platform\s*=/.test(platformJs) &&
      /setPlatform\(snapshot\.value\?\.env\?\.platform\)/.test(rendererCode),
    '两条左轨的让位与撤回 + 应用内全屏顶栏让位 + 非全屏不缩进 + platform/全屏状态都有来源',
  );

  // macOS 适配的契约二：三处快捷键处理器都必须走平台修饰键
  // （mac 认 Cmd、其它平台认 Ctrl），不能各自写死 ctrlKey —— 写死的话 mac 上全部失灵。
  const shortcutFiles = ['app.ts', 'dev-diagnostics.ts', path.join('lib', 'xterm.ts')];
  const notPlatformAware = shortcutFiles.filter(
    (rel) => !fs.readFileSync(path.join(rendererDir, rel), 'utf8').includes('isAppModifier('),
  );
  check(
    '渲染层：三处快捷键处理器都按平台取修饰键',
    notPlatformAware.length === 0,
    notPlatformAware.length
      ? `未适配：${notPlatformAware.join(', ')}`
      : `${shortcutFiles.length} 处都走 isAppModifier`,
  );

  // 依赖从"index.html 里的 script 标签"改成了模块导入（Vite 构建），
  // 所以要检查的是：入口被引入、入口导入了样式表、xterm 由 lib/xterm.ts 直接用类导入。
  const rendererEntry = fs.readFileSync(path.join(rendererDir, 'main.ts'), 'utf8');
  const xtermLib = fs.readFileSync(path.join(rendererDir, 'lib', 'xterm.ts'), 'utf8');
  check(
    '渲染层：入口被引入，样式与 xterm 都有来源',
    /<script type="module" src="\.\/main\.ts"><\/script>/.test(html) &&
      /import '\.\/styles\.css'/.test(rendererEntry) &&
      /from '@xterm\/xterm'/.test(xtermLib) &&
      /from '@xterm\/addon-fit'/.test(xtermLib),
  );
  // 产物必须是普通脚本：file:// 下 ES module 会走 CORS 检查而加载失败。
  // 这条检查看的是"有没有把 module 改回 classic"的构建插件，以及入口有没有动态 import
  // （动态 import 会切出第二个 chunk，跨 chunk 就必须用模块语法）。
  const viteConfig = fs.readFileSync(path.join(root, 'vite.config.mts'), 'utf8');
  check(
    '构建：产物走普通脚本（file:// 兼容）',
    /type="module" crossorigin /.test(viteConfig) && /classicScriptPlugin/.test(viteConfig),
    'vite.config.mts 里把 module 标签改回 defer',
  );
  check(
    '构建：入口不用动态 import（否则产物跨 chunk 必须用模块语法）',
    !/\bawait import\(|\bimport\(/.test(rendererEntry),
  );

  // macOS 打包必须签名（没有开发者证书时用 ad-hoc，即 `mac.identity: "-"`）。
  // 踩过：0.2.1 的 mac 包装完在 Finder 里双击只报「已损坏，无法打开」——因为打包时
  // **完全没签名**（Electron 自带二进制的签名被重新打包改坏了，等于"签名存在但无效"），
  // 而 Apple 芯片上签名无效的 app 会被系统直接拒绝。同一个坑还有第二个入口：
  // CI 里的 CSC_IDENTITY_AUTO_DISCOVERY=false 会让 app-builder-lib 的 isSignAllowed()
  // 提前返回 false，连 ad-hoc 签名都跳过 —— 所以这两处一起检查。
  const pkgJson = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  ) as PackageJson;
  const releaseWorkflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  check(
    '构建：macOS 走 ad-hoc 签名，且 CI 没有把签名整个关掉',
    pkgJson.build?.mac?.identity === '-' &&
      !/CSC_IDENTITY_AUTO_DISCOVERY\s*:\s*['"]?false/.test(releaseWorkflow),
    `mac.identity=${JSON.stringify(pkgJson.build?.mac?.identity)}`,
  );
  // xterm 与 addon 必须直接用导入的类，不能绕 window 全局：
  // UMD 全局是命名空间对象（window.FitAddon.FitAddon 才是类），把 ESM 导入的类
  // 挂上去再读 .FitAddon 就是 undefined —— fit addon 会静默装不上、
  // 终端永远停在默认 80×24（踩过：容器 966×723，终端却只画 572×432）。
  check(
    '渲染层：xterm 与 addon 用导入的类，不经过 window 全局',
    !/window\.(Terminal|FitAddon|WebLinksAddon)/.test(rendererCode) &&
      /new Terminal\(/.test(xtermLib) &&
      /new FitAddon\(/.test(xtermLib),
  );
  // 两个内嵌页必须各自用独立且持久的分区：DSH 界面存令牌 cookie，用量页存登录态。
  // 扫 markup（HTML + .vue）：两个 webview 现在分别住在各自的页面组件里。
  const partitions = [
    ...markup.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<webview[^>]*partition="([^"]+)"/g),
  ].map((match) => match[1]);
  const allPersistent =
    partitions.length === 2 && partitions.every((name) => name.startsWith('persist:'));
  check(
    '渲染层：两个内嵌页各有独立的持久分区',
    allPersistent && new Set(partitions).size === partitions.length,
    partitions.length ? partitions.join(' / ') : '没有找到 webview 分区',
  );
}
