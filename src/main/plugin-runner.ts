/**
 * 插件操作子进程（装 / 卸 / 升级）与输出归纳
 *
 * t54 从 `plugin-manager.ts` 拆出来的；那个文件现在只剩三个类（Runner / Live / Manager）+ barrel，
 * 别的模块与自检的 import 路径不用改。
 */
import { spawn } from 'node:child_process';

import path from 'node:path';

import {
  packageNameOf,
  parsePluginSpec,
  pluginProfileDir,
  pluginRegistryEnv,
  profilePatchEnables,
  resolveModuleDir,
  suggestEntryId,
  summarizePluginFailure,
} from './plugin-parse';

import {
  dshLaunchSpec,
  envWithKnownBins,
  findPnpm,
  findPnpmForProfile,
  homeDir,
  resolveDshLauncher,
} from './process-utils';

import { Settings } from './settings';

import type { PluginOpAction, PluginOpResult } from '../shared/ipc';

import { OP_TAIL_CHARS, OP_TIMEOUT_MS, PLUGIN_PROFILE } from './plugin-shared';

import type { LaunchSpec } from './process-utils';

import type { ChildProcess } from 'node:child_process';

/** 一次插件的安装/卸载/升级 */
export class PluginRunner {
  private child: ChildProcess | null = null;

  constructor(private readonly settings: Settings) {}

  /** 当前是否有操作在跑（界面上按钮据此禁用，也避免两个 pnpm 同时改同一个目录） */
  get busy(): boolean {
    return this.child !== null;
  }

  cancel(): boolean {
    if (!this.child) return false;
    this.child.kill();
    return true;
  }

  /**
   * 真跑一次 `dsh plugin --profile web <args>`，把输出边读边推给界面。
   * 返回退出码与输出尾部（尾部用于归纳失败原因）。
   *
   * 收的是**统一包装器算好的 spec**（`dshLaunchSpec`）而不是裸的 file/args：Windows 上
   * shim / npx / 自定义 shim 这三条回退 launcher 给的是 `cmd.exe` + `/d /s /c`，
   * 不带 `windowsVerbatimArguments` 时 Node 会把内嵌引号再转义一遍，cmd 直接报
   * `'"…dsh.cmd"' is not recognized` —— 那正是"用户自己装了 dsh 却解析不到"时插件页全废的原因。
   */
  private async spawnOnce(
    spec: LaunchSpec,
    env: NodeJS.ProcessEnv,
    onOutput: (chunk: string) => void,
  ): Promise<{ code: number | null; tail: string; error?: string }> {
    let tail = '';
    const collect = (chunk: Buffer | string) => {
      const text = String(chunk);
      tail = (tail + text).slice(-OP_TAIL_CHARS);
      onOutput(text);
    };

    return await new Promise((resolve) => {
      const child = spawn(spec.file, spec.args, {
        env,
        // cwd 必须固定：相对路径（`./hello-plugin`）由 dsh 按**调用目录**解析，
        // 而继承来的 cwd 是 Electron 的启动目录（从 Finder 起可能是 /）—— 那样
        // 用户填的相对路径会莫名其妙地找不到。固定成主目录，界面上也这么写。
        cwd: homeDir(),
        windowsHide: true,
        // 命令行是 launchSpec 按 cmd 规则拼好的，Node 不要再加引号
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;

      const timer = setTimeout(() => {
        collect(`\n（超过 ${Math.round(OP_TIMEOUT_MS / 60000)} 分钟，已中断）\n`);
        child.kill();
      }, OP_TIMEOUT_MS);
      timer.unref?.();

      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.on('error', (error) => {
        clearTimeout(timer);
        this.child = null;
        collect(`\n${error.message}\n`);
        resolve({ code: null, tail, error: error.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        this.child = null;
        resolve({ code, tail });
      });
    });
  }

  async run(
    action: PluginOpAction,
    spec: string,
    onOutput: (chunk: string) => void,
  ): Promise<PluginOpResult> {
    if (this.busy) return { ok: false, error: '已经有一个插件操作在进行中' };
    const parsed = parsePluginSpec(spec);
    if (!parsed) return { ok: false, error: '请填写要安装的包名或路径' };

    // 归纳失败原因时只对 npm 包带上"用户写的包名"（本地目录 / git 的 spec 不是包名）
    const requested = parsed.kind === 'npm' ? spec : undefined;

    const launcher = resolveDshLauncher(this.settings.all());

    // 内置包（随 dsh 装好的）装了也白装：它不在"从 registry 取"的路径上，而且
    // 用户真正想做的通常是**启用**它 —— 那是 patch 层 insert 的事。
    if (action === 'add' && parsed.kind === 'npm') {
      const name = packageNameOf(spec);
      const dshRoot =
        launcher.kind === 'node-bin' && launcher.prefixArgs.length > 0
          ? path.dirname(path.dirname(launcher.prefixArgs[0]))
          : null;
      if (name && dshRoot && resolveModuleDir(name, [dshRoot]) !== null) {
        const enabled = profilePatchEnables(name);
        const id = suggestEntryId(name);
        return {
          ok: false,
          error: enabled
            ? `「${name}」是随 dsh 一起装好的内置插件，而且你自己的 patch 层里已经 insert 了它 —— 它已经启用了，这里不需要装任何东西（插件页左边「你的层」那一栏就是它）。内置包的分发不经过 registry，所以 registry 上也确实没有"装了就能用"这回事。`
            : `「${name}」是随 dsh 一起装好的内置插件（已经在 dsh 安装目录里），不需要用 pnpm 再装一遍。要启用它，请在 profile 的 cordis.patch.yml 里 insert 一行 —— 插件页左边「你的层」那一栏就是它。`,
          // 还没启用时，界面就地给一个「插进我的层」按钮（见 PluginPane 的输出区）
          ...(enabled ? {} : { needsEnable: { id, name } }),
        };
      }
    }

    // 没装 pnpm 就别起子进程了：`dsh plugin` 内部是裸 spawnSync("pnpm")，只会以
    // 退出码 127 失败（实测：`dsh: pnpm not found on PATH`），而且它**会先把 profile
    // 初始化出来**才失败 —— 白改一遍磁盘。这里提前说清怎么办。
    // `findPnpm()` 查的就是我们等下要塞给子进程的那份 PATH 加几个已知目录，
    // 所以它说没有，子进程一定找不到。
    if (findPnpm() === null) {
      return {
        ok: false,
        error:
          '这台机器上没找到 pnpm —— dsh 通过它管理 profile 里的插件依赖。装一个（`npm i -g pnpm`，或 `corepack enable pnpm`）再回来，插件页会自己认出来。',
      };
    }

    // `dsh plugin --profile web <action> [-w] <spec>`：spec 永远是**一个** argv，不拼 shell。
    // `-w` 只在 pnpm 自己要求时加（见下面重试）：profile 里那份 pnpm-workspace.yaml 是
    // dsh 模板写的（`packages: [.]`，没有 ignore-workspace-root-check），pnpm 9 会把它
    // 当 workspace root，于是 `add` 直接报 ERR_PNPM_ADDING_TO_ROOT。
    // 经 `dshLaunchSpec` 统一包装：Windows 上回退 launcher（shim / npx / 自定义 shim）是
    // `cmd.exe` + `/d /s /c`，必须带 `windowsVerbatimArguments`，见 spawnOnce 的说明。
    const specFor = (extra: string[]): LaunchSpec =>
      dshLaunchSpec(
        launcher,
        [
          'plugin',
          '--profile',
          PLUGIN_PROFILE,
          action,
          ...extra,
          ...(action === 'update' && spec.trim() === '' ? [] : [spec]),
        ],
        process.platform,
      );
    // 用哪份 pnpm：**要和这份 profile 记的那个大版本一致**（`.modules.yaml` 里的 packageManager）。
    // `envWithKnownBins` 补的是 `findPnpm()` 找到的那份（PATH 优先），而 PATH 里第一份未必是当初
    // 装这份 node_modules 的那一档 —— store 布局按大版本走，拿错版本只会得到一段用户看不懂的报错。
    const pick = findPnpmForProfile(pluginProfileDir());
    if (!pick.matched && pick.expectedMajor) {
      onOutput(
        `（提示：这份 profile 的依赖是 pnpm ${pick.expectedMajor} 装的，而这台机器上找到的` +
          `${pick.version ? `是 pnpm ${pick.version}` : ' pnpm 读不出版本'} —— 两个大版本的 store ` +
          `布局不一样，装之前先把 pnpm 换成一致的那一档。）\n`,
      );
    }
    // 安装源：设置里填了才覆盖，且只覆盖这一个子进程（见 pluginRegistryEnv）
    const registryOverride = pluginRegistryEnv(this.settings.all().pluginRegistry);
    const env: NodeJS.ProcessEnv = {
      // Windows 上 PATH 这个键叫 `Path`，直接写 `PATH` 会造出两个只差大小写的键（见 envWithKnownBins）
      ...envWithKnownBins(process.env),
      ...registryOverride,
    };
    if (pick.file) {
      // 把选中的那份 pnpm 的目录顶到最前：dsh 在 profile 目录里裸 `spawnSync('pnpm')`，只认 PATH
      const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
      const dir = path.dirname(pick.file);
      env[key] = [
        dir,
        ...String(env[key] || '')
          .split(path.delimiter)
          .filter((item) => item && item !== dir),
      ].join(path.delimiter);
    }
    const pnpmContext = { used: pick.version, expectedMajor: pick.expectedMajor };
    const registry = registryOverride.npm_config_registry;
    if (registry) onOutput(`（本次操作使用 registry：${registry}）\n`);

    const first = await this.spawnOnce(specFor([]), env, onOutput);
    if (first.error) return { ok: false, code: null, error: first.error };
    if (first.code === 0) return { ok: true, code: first.code };

    if (/ADDING_TO_ROOT|workspace root/i.test(first.tail)) {
      onOutput('\n（pnpm 说这是 workspace root，加 -w 重试）\n');
      const retry = await this.spawnOnce(specFor(['-w']), env, onOutput);
      if (retry.error) return { ok: false, code: null, error: retry.error };
      if (retry.code === 0) return { ok: true, code: retry.code };
      return {
        ok: false,
        code: retry.code,
        summary: summarizePluginFailure(retry.tail, requested, pnpmContext),
      };
    }
    return { ok: false, code: first.code, summary: summarizePluginFailure(first.tail, requested) };
  }
}

// ---------------------------------------------------------------- 运行中的清单
//
// 静态组合（dump）拿不到"运行中"的事实：根 include 行、两个原生目录选择器、HMR
// 这几行是启动时挂的，配置里根本没有；条目是被禁用还是真的活着也只有进程知道。
// 这些只在 dsh 的 Loader 里，而访问它要先过 dsh web 的鉴权 —— 所以走它自己的接口：
//
//   1. GET  <origin>/?token=<控制台捕获的令牌>   → 303 + Set-Cookie: dsh-auth-<hash>=…
//   2. POST <origin>/api/pluginInventory/list   → 带 cookie 与下面这个信封
//
// 这是 rc 版本的内部协议（cookie 名、路径形状、信封字段），上游一改就会失效，
// 所以整条路都是"尽力而为"：任何一步失败都只记一句原因，页面退回纯静态视图。
