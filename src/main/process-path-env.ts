/**
 * 给子进程补 PATH：pathWithKnownBins / envWithKnownBins / 全局 dsh bin.js
 *
 * 把已知的 bin 目录补进子进程环境（从 `process-utils.ts` 拆出来的；那个文件现在只做 barrel 再导出，
 * 6 个消费者与两个反例脚本的 import 路径不用改）。
 */
import { findPnpm } from './process-pnpm';
import { homeDir } from './process-proc';
import { findNodeExe, isFile, versionManagerInstalls } from './process-shell';

import fs from 'node:fs';
import path from 'node:path';

/**
 * 给子进程的 PATH 前置已知的 bin 目录（node 与 pnpm 所在目录）。
 * 只影响我们 spawn 的那一个子进程，不动应用自己的环境。
 */
export function pathWithKnownBins(base: string | undefined): string {
  const extra: string[] = [];
  const push = (exe: string | null) => {
    const dir = exe ? path.dirname(exe) : '';
    if (dir && !extra.includes(dir)) extra.push(dir);
  };
  push(findNodeExe());
  push(findPnpm());
  const rest = String(base || '')
    .split(path.delimiter)
    .filter((dir) => dir && !extra.includes(dir));
  return [...extra, ...rest].join(path.delimiter);
}

/**
 * 复制一份环境变量并把已知 bin 目录补进 PATH。
 *
 * **Windows 上这个键通常叫 `Path`**（Node 原样保留系统的大小写）。如果直接写
 * `{ ...process.env, PATH: patched }`，就会同时存在 `Path` 与 `PATH` 两个只差大小写的键 ——
 * 哪个生效取决于运行时怎么构造环境块，等于"补了 pnpm 目录却可能白补"。所以这里先找到
 * 已有的那个键、**原地改它**（没有才新写 `PATH`）。
 */
export function envWithKnownBins(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
  env[key] = pathWithKnownBins(env[key]);
  return env;
}

/**
 * 丢掉环境里所有 `npm_config_*` / `NPM_CONFIG_*`（**大小写不敏感地按前缀匹配**），其余原样保留。
 *
 * 为什么要它（真机实测的根因，见 docs/env-doctor.md 的「根因：继承的 npm_config_*」）：
 * Electron 是被人从某个终端 / 工具里拉起来的，那个环境里往往已经有一整套 npm 的配置变量
 * （`npm_config_global_prefix`、`npm_config_prefix`、`npm_config_registry`…）。我们 spawn 修复
 * 子进程时是 `{ ...process.env }` 再补 PATH，于是这些键**原样传给了 npm**。而 npm 的优先级是
 * "环境变量 > 由自身位置推出的默认值"，结果就是：不管用哪一份 npm 执行 `i -g`，全局目录都由
 * **父进程那套变量**决定，而不是由 npm 自己的位置决定。实测（v24.14.1 那份 npm）：
 *
 * | 试验                                            | `npm prefix -g`            |
 * | ----------------------------------------------- | -------------------------- |
 * | 现状（继承的 env）                              | `…/node/**v22.17.1**` ❌    |
 * | 只清 `npm_config_global_prefix` + `_prefix`     | 仍是 v22.17.1 ❌（不够）    |
 * | `env -i`（只给 PATH / HOME）                    | `…/node/**v24.14.1**` ✅    |
 * | `env -i` + 只放回 `npm_config_prefix=…`         | v22.17.1（**单这一键就能翻转**） |
 *
 * 所以修复子进程的 env 要清到"让 npm 从它自己的位置推全局目录"：**只留我们刻意注入的那一项**
 * （`pluginRegistryEnv()` 给的 `npm_config_registry`，由调用方在 `cleanNpmEnv` **之后**合成，
 * 见 `EnvFixRunner.execute`）。用户写在 `~/.npmrc` 里的源不受影响 —— npm 仍会读 userconfig，
 * 清掉的只是"从父进程继承来的那一份"。
 *
 * **判据是前缀，不是一张固定清单**：npm 的配置键是开放的（任何 `npm_config_<key>` 都会被读成
 * 一项配置），列清单必然漏，而漏掉一个就等于没修（上表第二行就是这么翻车的）。
 *
 * **不丢别的**：PATH、HOME、代理（`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`）、locale 一律保留
 * —— 清的是 npm 的配置键，不是"环境"。`base` 给 `undefined` / 空对象也不炸（返回空对象）。
 */
export function cleanNpmEnv(base: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base ?? {})) {
    if (key.toLowerCase().startsWith('npm_config_')) continue;
    env[key] = value;
  }
  return env;
}

/** 全局 node_modules 的候选目录（PATH 里没有 shim 时直接来这里找包） */
function globalNodeModulesRoots(): string[] {
  const home = homeDir();
  const roots: string[] = [];
  const push = (dir: string) => {
    if (dir && !roots.includes(dir)) roots.push(dir);
  };
  // 1. 从 node 自己所在的位置反推 npm 前缀，**排最前**：
  //    这样选到的包和将要执行它的 node 是同一份安装，不会出现版本错配
  const nodeExe = findNodeExe();
  if (nodeExe) {
    let real = nodeExe;
    try {
      real = fs.realpathSync(nodeExe);
    } catch {
      /* 用原始路径 */
    }
    const prefix = path.dirname(path.dirname(real));
    push(path.join(prefix, 'lib', 'node_modules'));
    push(path.join(prefix, 'node_modules'));
  }
  // 2. 常见的系统级全局目录
  push('/usr/local/lib/node_modules');
  push('/opt/homebrew/lib/node_modules');
  push(path.join(home, '.npm-global', 'lib', 'node_modules'));
  push(path.join(home, 'Library', 'pnpm', 'global', '5', 'node_modules'));
  // 3. 版本管理器里其它 Node 版本的全局目录（兜底）
  for (const install of versionManagerInstalls()) push(install.modules);
  return roots;
}

/** 从全局安装目录里找 @deepseek-ai/dsh 的 bin.js（不依赖 PATH 里的 shim） */
export function findGlobalDshBinJs(): string | null {
  for (const root of globalNodeModulesRoots()) {
    const candidate = path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (isFile(candidate)) return candidate;
  }
  return null;
}
