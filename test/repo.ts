'use strict';

/**
 * 自检共用的"仓库事实"：路径、临时目录、共享的 `Settings` 实例，以及那些被反复读到的源码文本。
 *
 * 原来这些都长在 `test/selftest.ts` 的 `main()` 开头，别的段落（环境自检、安装引擎、门禁界面）
 * 隔着几千行还在用同一个 `settings` / `sandbox` / `rendererCode` —— 拆文件时它们必须有一个
 * 公开的落脚点，所以收进这里。往后各主题要共享的派生值也加在这一份里，以免出现"检查 A 从检查 B
 * 的文件里 import 一个派生值"这种绕回去的依赖。
 *
 * 这里只做**读**，不碰网络、不起子进程、不写仓库（`.verify/` 除外）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { Settings } from '../src/main/settings';

/** package.json 里自检真正读到的字段（用最小的 interface 兜住 JSON.parse 的 any） */
export interface PackageJson {
  version: string;
  build?: { mac?: { identity?: string } };
}

export interface Repo {
  /** 仓库根 */
  root: string;
  /** `test/` 目录（夹具都在它下面；搬进子目录的模块不能再用 `__dirname` 拼） */
  testDir: string;
  /** 自检的临时目录（`.verify/`，建好且被 git 忽略） */
  sandbox: string;
  /** 共享的设置实例（§1 起就要求：不认识的键要报错、且一个字都不写） */
  settings: Settings;

  // ---- 源码文本：自检里大量断言是"读源码文本"的，集中读一次 ----
  srcDir: string;
  rendererDir: string;
  libDir: string;
  /** `index.html` 原文 */
  html: string;
  /** `panes/` 与 `shell/` 下的 `.vue`（形如 `{ dir, name }`） */
  vueFiles: { dir: string; name: string }[];
  /** 所有 `.vue` 的全文拼接 */
  vueSource: string;
  /** `lib/` 下所有 `.ts` 的拼接 */
  libSource: string;
  /** 渲染层脚本的两处来源：`app.ts` + `lib/` */
  rendererJs: string;
  /** 标记的两处来源：静态 HTML + `.vue` 模板 */
  markup: string;
  /** 渲染层脚本：`app.ts` + `lib/` + `.vue` */
  rendererAll: string;
  /** `rendererAll` 去掉注释（注释里常拿没实现的写法举例，当真引用去查会误报） */
  rendererCode: string;
  mountJs: string;
  /** 仓库根的 `package.json`（只声明自检真正读到的字段） */
  pkg: PackageJson;
  /** `shared/ipc.ts`（barrel）+ `shared/ipc-*.ts`（八个主题模块）的全文拼接（顺序与拆分前一致） */
  ipcSource: string;
  /** 同上，但空白压平（类型声明会被 Prettier 折行，压平才好匹配） */
  flatIpc: string;
  /** `panes/UiPane.vue` 原文（内嵌界面那一页，几处契约断言都读它） */
  uiPaneSource: string;
  /** `main.ts` + `main-*.ts`（入口拆出的几个簇）的全文拼接 */
  mainSource: string;

  /**
   * `src/main/plugin-manager.ts`（barrel + 三个类）+ `src/main/plugin-*.ts`（四个叶子模块）的全文拼接。
   * t54 把它按主题拆开之后，"读源码文本"的断言要看整份。
   */
  pluginSource: string;
  /**
   * `src/main/process-utils.ts`（barrel）+ `src/main/process-*.ts`（八个叶子模块）的全文拼接。
   * t50 把这一个文件按主题拆开之后，"读源码文本"的断言要看整份，不能只看 barrel ——
   * 那里只有 re-export，一条 `export function …(…)` 都搜不到。
   */
  processUtilsSource: string;
  /** 读 `test/fixtures/<名字>` 下的夹具（真实输出，不是编出来的） */
  fixture(name: string): string;
  /** 全局表 `styles.css` 原文 */
  css: string;
  /** 各组件 `<style>` 块的拼接 */
  vueStyles: string;
  /** 两层样式表：全局表 + 各组件块（t48 起「整份样式」就是这两层） */
  allCss: string;

  // ---- 处理文本的小工具（用得太多，跟着数据一起放这里） ----
  /** 把一段文本转义成可以塞进正则里的字面量 */
  escaped(text: string): string;
  /** 从两层样式表里取一条规则的规则体：`cssBlock('.btn')` */
  cssBlock(selector: string): string;
}

export function createRepo(): Repo {
  const root = path.join(__dirname, '..');
  const sandbox = path.join(root, '.verify');
  fs.mkdirSync(sandbox, { recursive: true });

  const settings = new Settings(path.join(sandbox, 'settings.json'));
  settings.patch({ port: 3080, host: '127.0.0.1', extraArgs: '' });

  const srcDir = path.join(root, 'src');
  const rendererDir = path.join(srcDir, 'renderer');

  // 界面已经逐页迁到 Vue 单文件组件，所以**标记与脚本都要把 .vue 一起算进来**
  // （panes/ 是页面，shell/ 是外壳），否则迁走的部分会悄悄脱离这些检查的覆盖。
  const vueDirs = ['panes', 'shell'];
  const vueFiles: { dir: string; name: string }[] = [];
  for (const dir of vueDirs) {
    const full = path.join(rendererDir, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full).filter((n) => n.endsWith('.vue'))) {
      vueFiles.push({ dir, name });
    }
  }
  const vueSource = vueFiles
    .map(({ dir, name }) => fs.readFileSync(path.join(rendererDir, dir, name), 'utf8'))
    .join('\n');

  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const libDir = path.join(rendererDir, 'lib');
  const libSource = fs.existsSync(libDir)
    ? fs
        .readdirSync(libDir)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => fs.readFileSync(path.join(libDir, name), 'utf8'))
        .join('\n')
    : '';
  const rendererJs = `${fs.readFileSync(path.join(rendererDir, 'app.ts'), 'utf8')}\n${libSource}`;
  const markup = `${html}\n${vueSource}`;
  const rendererAll = `${rendererJs}\n${vueSource}`;
  // 只看代码，不看注释：注释里常拿 `getElementById('btn-xxx')` 这种示意写法举例，
  // 当真引用去查会误报（已经误报过一次）。
  const rendererCode = rendererAll.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  const mountJs = fs.readFileSync(path.join(rendererDir, 'mount.ts'), 'utf8');
  // t54 起 plugin-manager.ts 是 barrel + 三个类，解析与子进程住在 plugin-*.ts 里 ——
  // "读源码文本"的断言要看整份（barrel 里一条 `export function …` 都搜不到）。
  // t56/t57 起 main.ts 拆出了若干簇（主题 / 内嵌页诊断 / 菜单 / 外链 / 崩溃兜底）——
  // "读 main.ts 文本"的断言要看**主进程入口那一组**的全部源码。
  const mainSource = [
    'main',
    'main-theme',
    'main-embedded',
    'main-menu',
    'main-crash',
    'main-url',
    'main-ipc',
    'main-ipc-shared',
    'main-ipc-app',
    'main-ipc-archive',
    'main-ipc-plugin',
    'main-ipc-env',
  ]
    .map((stem) => fs.readFileSync(path.join(srcDir, 'main', `${stem}.ts`), 'utf8'))
    .join('\n');

  const pluginSource = [
    'plugin-manager',
    'plugin-shared',
    'plugin-parse',
    'plugin-runner',
    'plugin-live',
  ]
    .map((stem) => fs.readFileSync(path.join(srcDir, 'main', `${stem}.ts`), 'utf8'))
    .join('\n');
  const processUtilsSource = [
    'process-utils',
    'process-types',
    'process-shell',
    'process-pnpm',
    'process-path-env',
    'process-dsh',
    'process-launch',
    'process-probe',
    'process-proc',
  ]
    .map((stem) => fs.readFileSync(path.join(srcDir, 'main', `${stem}.ts`), 'utf8'))
    .join('\n');
  // t55 起 shared/ipc.ts 是 barrel，契约按主题住在 ipc-*.ts 里 ——
  // "读源码文本"的断言要看整份（barrel 里一条 `export type` 都搜不到）。
  // 顺序与拆分前的原文一致（外壳 → 更新 → 运行时 → 归档 → 插件 → 环境 → Node → API）。
  const ipcSource = [
    'ipc',
    'ipc-shell',
    'ipc-update',
    'ipc-runtime',
    'ipc-archive',
    'ipc-plugin',
    'ipc-env',
    'ipc-node',
    'ipc-api',
  ]
    .map((stem) => fs.readFileSync(path.join(srcDir, 'shared', `${stem}.ts`), 'utf8'))
    .join('\n');
  const flatIpc = ipcSource.replace(/\s+/g, ' ');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as PackageJson;
  const uiPaneSource = fs.readFileSync(path.join(rendererDir, 'panes', 'UiPane.vue'), 'utf8');
  // 全局表（变量 / 主题 / 骨架 / 共享件）与各组件自己的 `<style>` 块是两层：
  // 变量块与主题仍在全局表里（那不是页面私有的东西），所以读变量块的检查只看 `css`。
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  const vueStyles = vueFiles
    .map(({ dir, name }) => {
      const text = fs.readFileSync(path.join(rendererDir, dir, name), 'utf8');
      return text.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? '';
    })
    .join('\n');
  const allCss = `${css}\n${vueStyles}`;

  return {
    root,
    testDir: __dirname,
    sandbox,
    settings,
    srcDir,
    rendererDir,
    libDir,
    html,
    vueFiles,
    vueSource,
    libSource,
    rendererJs,
    markup,
    rendererAll,
    rendererCode,
    mountJs,
    uiPaneSource,
    pluginSource,
    mainSource,
    processUtilsSource,
    fixture: (name: string): string =>
      fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'),
    pkg,
    ipcSource,
    flatIpc,
    css,
    vueStyles,
    allCss,
    escaped: (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    cssBlock: (selector: string): string =>
      allCss.match(
        new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`),
      )?.[0] || '',
  };
}
