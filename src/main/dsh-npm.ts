/**
 * 「更新 dsh」该用哪个 npm —— **本进程内唯一的一份解析**（方案 A，见 docs/env-doctor.md §3.5）。
 *
 * 真机 bug 的现场：console 解析并要升级的那份 dsh 在 `~/.nvm/versions/node/v24.14.1/…`，
 * 而 `findNpm()` 在 macOS 上直接 `whichSync('npm')`，撞上了 PATH 里 vite-plus 的 `vp` symlink ——
 * 于是**显示的命令与执行的命令不是同一条 npm**，升级装进了 v22.17.1 的全局树：那份 0.1.5-rc.1
 * 一个字没变，行上却仍写着「更新 dsh → 0.2.0-rc.2」→ 再点还是那样，**不收敛**。
 *
 * 三条规则（写死在这里；报告侧与执行侧都只读它，谁也不许再自己解析一遍）：
 *
 *   1. **定位到了 dsh，而且它是「`<node>` + `<…>/@deepseek-ai/dsh/lib/bin.js`」这样起来的**
 *      → npm 必须是与那个 node **同目录**的那一份。被升级的 dsh 就装在那个 Node 的全局树下，
 *      只有它的 npm 才会把包装回同一棵树（Windows 的 nvm 布局里 `node.exe` 旁边就是 `npm.cmd`）。
 *   2. **`missing`（要新装一份）/ 只能靠 `npx` 起来** → 用 `findNpm()`。这时候没有"被升级的那份
 *      dsh"可绑，任何一个能用的 npm 都合理 —— 保持既有行为不变。
 *   3. **定位到了 dsh，但推不出它属于哪个 Node、或推出来的 npm 不在/不可执行** → `unbound`：
 *      **不给更新入口**，由界面在那一行写一条诚实边界（说不准该装进哪个 Node 的全局目录）。
 *      宁可什么都不显示，也不要给一个装到别处去的按钮。
 *
 * 为什么按进程缓存：报告（`judgeEnvironment` 读到的 `raw.dshNpm`）与执行（`EnvDoctor.fixPlan`）
 * 是两次独立调用，"显示 == 执行"不能靠"但愿 PATH 没变"，要靠**同一个值**。
 * 先例是 `process-dsh.ts` 的 `canRunDsh`（每个进程只测一次）；`refresh` 只由「重新检测」那条路给。
 */

import fs from 'node:fs';
import path from 'node:path';

import { findNpm } from './env-probe';
import { resolveDshLauncher } from './process-dsh';
import { isRunnablePath } from './process-utils';

import type { SettingsValues } from './settings';
import type { DshNpmBinding } from '../shared/ipc';
import type { DshLauncher } from './process-types';

/** dsh 的入口脚本（`@deepseek-ai/dsh/lib/bin.js`）—— 见到它就说明这个 launcher 是「node + bin.js」 */
const DSH_BIN_JS = /[/\\]@deepseek-ai[/\\]dsh[/\\]lib[/\\]bin\.js$/i;

/** `DshLauncher` 里推出 npm 需要的那几项（写成结构类型，反例脚本喂字面量就能测） */
export interface DshLauncherShape {
  file: string;
  prefixArgs: string[];
  viaCmd: boolean;
  kind: string;
}

/** 这个 launcher 的入口脚本是不是 dsh 自己的 `bin.js`（纯函数） */
export function isDshBinJs(candidate: string | undefined | null): boolean {
  return DSH_BIN_JS.test(String(candidate ?? '').trim());
}

/**
 * 纯函数：从启动方式里推出**被升级的那份 dsh 属于哪个 Node**；推不出来给 null（**不猜**）。
 *
 * 只认「不是 cmd 包装 + 第一个前置参数是 dsh 的 bin.js」这一种形状 —— 也就是 `resolveDshLauncher`
 * 里 `kind: 'node-bin'` 那一路（用户在设置里手写的「node + bin.js」自定义命令也是同一形状，
 * 所以按形状判，而不是按 kind 判）。shim / npx / 批处理包装这三种都没有 node 路径可推。
 */
export function dshNodeForLauncher(launcher: DshLauncherShape): string | null {
  if (!launcher || launcher.viaCmd) return null;
  if (!isDshBinJs(launcher.prefixArgs?.[0])) return null;
  const node = String(launcher.file ?? '').trim();
  return node.length > 0 ? node : null;
}

/**
 * 纯函数：由 node 路径推**同目录**的 npm。
 *
 * macOS / Linux 是 `<dir>/npm`；Windows 的 nvm 布局里 `node.exe` 旁边就是 `npm.cmd`
 * （不带扩展名的 `npm` 是个 POSIX sh 脚本，Windows 上 spawn 不了，所以必须点名 `.cmd`）。
 * **它不检查文件在不在** —— 那是 IO 层（`isUsableNpm`）的事，这里只算路径，反例脚本好喂。
 */
export function npmForNode(nodePath: string | null | undefined, platform: string): string | null {
  const node = String(nodePath ?? '').trim();
  if (node.length === 0) return null;
  // **必须按目标平台选 path 实现**（与 `isRunnablePath` 用 `path.win32.extname` 同一条理由，
  // §7.23）：在 macOS 上用 `path.dirname('C:\\nvm\\v24\\node.exe')` 得到的是 `'.'`，
  // 反例脚本根本测不到 win32 那一支。
  const impl = platform === 'win32' ? path.win32 : path.posix;
  const dir = impl.dirname(node);
  return platform === 'win32' ? impl.join(dir, 'npm.cmd') : impl.join(dir, 'npm');
}

/** 路径能不能当 npm 用：**存在** + 可执行（`isRunnablePath` 在 POSIX 上恒真，所以存在性要自己查） */
function isUsableNpm(file: string | null, platform: string): boolean {
  const candidate = String(file ?? '').trim();
  if (candidate.length === 0) return false;
  try {
    if (!fs.existsSync(candidate)) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
  } catch {
    return false;
  }
  return isRunnablePath(candidate, platform);
}

/** `…/node/v24.14.1/bin/node` → `v24.14.1`（给人看的档位名，写进 evidence；认不出时给整条路径） */
function nodeLabel(nodePath: string): string {
  const dir = path.dirname(nodePath);
  const name = path.basename(dir);
  return name.length > 0 && name !== '.' && name !== path.sep ? name : nodePath;
}

/** 推不出绑定时那句话的前半截（说清"为什么推不出来"） */
function unboundReason(launcher: DshLauncher | null, nodePath: string | null): string {
  if (nodePath) {
    return `启动 dsh 的那份 Node（${nodePath}）旁边没有可用的 npm`;
  }
  if (!launcher) return '这一轮没能解析出 dsh 是怎么起来的';
  if (launcher.kind === 'shim')
    return '这台电脑上的 dsh 是通过 shim 启动的，看不出它属于哪一个 Node';
  if (launcher.kind === 'custom' || launcher.kind === 'custom-shim') {
    return 'dsh 是用你在设置里写的那条自定义启动命令启动的，我们看不出它属于哪一个 Node';
  }
  return '这一轮没能把 dsh 绑到某一个确定的 Node 上';
}

/**
 * 一次解析（IO）。三条规则的落点都在这里；结果按进程缓存。
 *
 * `refresh` 只由「重新检测」那条路给：用户可能在两次检测之间把启动命令改对了。
 */
export function resolveDshNpmBinding(
  settings: SettingsValues,
  options: { refresh?: boolean } = {},
): DshNpmBinding {
  if (!options.refresh && bindingCache) return bindingCache;
  bindingCache = computeBinding(settings);
  return bindingCache;
}

/** 上面那份绑定的 `path`（执行侧只读它）；`unbound` 时是 null —— 调用方据此决定"不给入口" */
export function resolveNpmForDsh(
  settings: SettingsValues,
  options: { refresh?: boolean } = {},
): string | null {
  return resolveDshNpmBinding(settings, options).path;
}

/** 只给测试与「重新检测」用：把进程内的缓存丢掉 */
export function resetDshNpmCache(): void {
  bindingCache = null;
}

let bindingCache: DshNpmBinding | null = null;

/**
 * 解析启动方式，**解析不出来给 null 而不是抛**：PATH 里既没有 dsh 也没有 npx 时
 * `resolveDshLauncher` 会抛 —— 那属于规则 2 的"要新装一份"，不是"说不准该装进哪个 Node"。
 */
function safeResolveLauncher(settings: SettingsValues): DshLauncher | null {
  try {
    return resolveDshLauncher(settings);
  } catch {
    return null;
  }
}

function computeBinding(settings: SettingsValues): DshNpmBinding {
  const platform = process.platform;
  const launcher = safeResolveLauncher(settings);
  const nodePath = launcher ? dshNodeForLauncher(launcher) : null;

  // 规则 1：能绑就绑，绑不成就 unbound（**不回退**到 findNpm —— 那正是这个 bug 的成因）
  if (nodePath) {
    const npmPath = npmForNode(nodePath, platform);
    if (isUsableNpm(npmPath, platform)) {
      return {
        kind: 'bound',
        path: npmPath,
        evidence: `更新 dsh 用的是 ${nodeLabel(nodePath)} 那份 Node 自带的 npm（${npmPath}）—— 要升级的 dsh 就装在这个 Node 下。`,
        hint: null,
      };
    }
    return {
      kind: 'unbound',
      path: null,
      evidence: `${unboundReason(launcher, nodePath)} —— 说不准该装进哪个 Node 的全局目录，所以这里不替你更新。`,
      hint: `用启动 dsh 的那份 Node 自带的 npm 装：\`${npmPath ?? 'npm'} i -g @deepseek-ai/dsh\``,
    };
  }

  // 规则 2：没有"被升级的那份 dsh"可绑（missing / npx / 解析不出来）→ 沿用 findNpm()
  if (!launcher || launcher.kind === 'npx') {
    const npmPath = findNpm();
    return {
      kind: 'fallback',
      path: npmPath,
      evidence: npmPath
        ? `这台电脑上还没有可升级的 dsh，装一份新的用系统里的 npm（${npmPath}）。`
        : '这台电脑上还没有可升级的 dsh，也没有找到可用的 npm。',
      hint: null,
    };
  }

  // 规则 3：定位到了 dsh，但推不出它属于哪个 Node（shim / 自定义命令 / 批处理包装）
  return {
    kind: 'unbound',
    path: null,
    evidence: `${unboundReason(launcher, null)} —— 说不准该装进哪个 Node 的全局目录，所以这里不替你更新。`,
    hint: '用启动 dsh 的那份 Node 自带的 npm 装：`npm i -g @deepseek-ai/dsh`',
  };
}
