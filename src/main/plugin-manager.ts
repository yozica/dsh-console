/**
 * 插件装配层：profile 的 bundle 层栈 + `dsh web --dump-config` 的解析 + 装 / 卸 / 升级 + 运行中清单。
 *
 * t54 起这个文件是 **barrel + `PluginManager`**：解析、操作子进程、运行中客户端按主题住在
 * `plugin-*.ts` 里，这里把公开面逐条再导出。**不要在这里加新的纯函数** —— 放对应的叶子模块。
 */
import { resolveDshHome } from './session-archive';

import path from 'node:path';

import fs from 'node:fs';

import { findPnpm, resolveDshLauncher } from './process-utils';

import {
  buildLayers,
  missingLayers,
  parseDump,
  parseProblems,
  plainDependencies,
  pluginProfileDir,
  pluginRegistryEnv,
  readProfileManifest,
  resolveModuleDir,
  runDump,
} from './plugin-parse';

import { applyBundleEdit } from './profile-bundles';

import { Settings } from './settings';

import { PluginRunner } from './plugin-runner';

import type {
  PluginEntry,
  PluginInspectResult,
  PluginLiveSnapshot,
  PluginOpAction,
  PluginOpResult,
  PluginRescueResult,
  PluginTreeLayer,
} from '../shared/ipc';

import type { PatchEditRequest, PatchEditResult } from './patch-layer';

import { PLUGIN_PROFILE } from './plugin-shared';

import {
  PATCH_FILE,
  applyEmptyArrayRepair,
  applyPatchEdit,
  listPatchBackups,
  restorePatchBackup,
} from './patch-layer';

import { LiveClient } from './plugin-live';

import type { DumpRun } from './plugin-parse';

import type { BundleEditResult } from './profile-bundles';

export class PluginManager {
  private readonly live: LiveClient;
  private readonly runner: PluginRunner;

  constructor(
    private readonly settings: Settings,
    /** 当前 dsh 的带令牌地址（DshManager.uiUrl）；由 main.ts 注入 */
    getTokenUrl: () => string | null = () => null,
  ) {
    this.live = new LiveClient(getTokenUrl);
    this.runner = new PluginRunner(settings);
  }

  /** 装 / 卸 / 升级：输出边走边推给界面，返回最终结果 */
  async runOperation(
    action: PluginOpAction,
    spec: string,
    onOutput: (chunk: string) => void,
  ): Promise<PluginOpResult> {
    return await this.runner.run(action, spec, onOutput);
  }

  /**
   * 只看 dsh 自带的组合结果（`--dump-default-config`，不解析你的层）。
   *
   * 用途是**救援**：配置被改坏时 `--dump-config` 会整条失败，而这条命令照样成功 ——
   * 于是界面至少还能把"内置层长什么样"摆出来，一眼区分是你的层坏了还是本来就这样。
   */
  async baseline(): Promise<PluginInspectResult> {
    try {
      const run = await runDump(this.settings.all(), true);
      const treeLayers = parseDump(run.stdout);
      return {
        ok: true,
        baseline: true,
        commands: [run.display],
        treeLayers,
        entryCount: treeLayers.reduce((sum, layer) => sum + layer.entries.length, 0),
        rawDump: treeLayers.length === 0 ? run.stdout : null,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 救援：把补丁层修回可用状态（查看备份、补空数组、从备份恢复）。
   *
   * 与"改你自己的层"分开是因为性质不同：那些是**编辑**，这些是**修**——能不动就不动
   * （`repair-empty` 只认一种坏法），真要动也先备份，而且只接受 profile 目录里的 `.bak-`。
   */
  rescue(
    action: 'repair-empty' | 'list-backups' | 'restore-backup',
    backup?: string,
  ): PluginRescueResult {
    const profileDir = this.profileDir();
    if (action === 'list-backups') {
      return { ok: true, backups: listPatchBackups(profileDir) };
    }
    if (action === 'restore-backup') {
      if (!backup) return { ok: false, error: '没给要恢复的备份文件。' };
      return restorePatchBackup(profileDir, backup);
    }
    // repair-empty：只认"只剩注释 / 空文件"这一种坏法（真正的内容坏了要从备份恢复）
    return applyEmptyArrayRepair(profileDir);
  }

  /** 临时停用 / 恢复一个 bundle：改 profile 的 `dsh.profile.bundles`（备份 + 原子写） */
  editBundle(action: 'suspend' | 'restore', name: string, index = -1): BundleEditResult {
    return applyBundleEdit(this.profileDir(), action, name, index);
  }

  /**
   * 改你自己的补丁层（插入 / 禁用 / 启用 / 移除插入）。
   *
   * **只写 profile 的 `cordis.patch.yml`** —— 那是 profile 级的用户层，不影响 `$DSH_HOME`
   * 级的 `cordis.patch.yml`，也不碰各 bundle。落盘前会备份、原子写；细节见 patch-layer.ts。
   * 这一层是 `patchReload: live`，所以改完即时生效（界面照实写，不催重启）。
   */
  async editLayer(request: PatchEditRequest): Promise<PatchEditResult> {
    const result = applyPatchEdit(this.profileDir(), request);
    if (!result.ok || !result.changed || !result.file) return result;

    // 回读验证：这是我们唯一会写的**用户文件**，"dsh 认不认"必须当场知道，不能等用户
    // 下次打开插件页才发现（真机事故：移除最后一条 insert 之后文件只剩注释，dsh 判它不是
    // 顶层数组，整个插件页读不出来）。只有失败指向这份 overlay 时才回滚 —— dsh 因为别的
    // 原因跑不起来（解释器不对等）不该把一次正确的改动撤掉。
    try {
      await runDump(this.settings.all());
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 必须"点名到这份文件"才算我们写坏了：别的 overlay（比如 $DSH_HOME 级那份）坏了，
      // 不该把这次正确的改动撤掉。
      const blamed = result.file !== undefined && message.includes(result.file);
      if (!blamed || !/top-level YAML array|overlay/i.test(message)) return result;
      const restored = this.rollbackEdit(result);
      return {
        ok: false,
        file: result.file,
        backup: result.backup,
        error: `${message}${restored ? ' —— 已经把补丁层回滚到改动前的内容，没有写坏。' : ' —— 回滚也没成功，请从备份文件手工恢复。'}`,
      };
    }
  }

  /** 把上一次改动用备份还原（没有备份说明改动前这个文件不存在，那就删掉它） */
  private rollbackEdit(result: PatchEditResult): boolean {
    if (!result.file) return false;
    try {
      if (result.backup) fs.copyFileSync(result.backup, result.file);
      else fs.rmSync(result.file, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  cancelOperation(): boolean {
    return this.runner.cancel();
  }

  /** 操作在跑时界面要禁用另一处入口（同一个 profile 目录不能被两个 pnpm 同时改） */
  get operationBusy(): boolean {
    return this.runner.busy;
  }

  /** profile 目录（$DSH_HOME/profiles/web） */
  profileDir(): string {
    return pluginProfileDir();
  }

  /**
   * 一次读完：层栈 + 生效配置 + 所有"没报错的错"。
   * 只跑一次 dump（两次调用等于同一个组合算两遍），页面加载时就调它。
   */
  async inspect(): Promise<PluginInspectResult> {
    const home = resolveDshHome();
    const profileDir = this.profileDir();
    const manifest = readProfileManifest(profileDir);

    // 内置层从 dsh 安装目录解析；树外层与共享目录也各算一个候选
    const launcher = resolveDshLauncher(this.settings.all());
    const dshRoot =
      launcher.kind === 'node-bin' && launcher.prefixArgs.length > 0
        ? path.dirname(path.dirname(launcher.prefixArgs[0]))
        : null;
    const moduleDirs = [profileDir, ...(dshRoot ? [dshRoot] : []), path.join(home, 'profiles')];
    // profile 里列了哪些 bundle，以及哪些是 dsh 自带的（内置的不能停用 —— 那是 dsh 的骨架）。
    // dump 读不出来时页面要靠这份清单救援，所以要跟着结果一起回。
    const bundles = manifest.bundles.map((name) => ({
      name,
      inBox: dshRoot !== null && resolveModuleDir(name, [dshRoot]) !== null,
    }));

    // dump（静态组合）与运行中清单互不依赖，并行取；运行中清单是"尽力而为"，失败不影响页面
    let run: DumpRun;
    let liveResult: { snapshot: PluginLiveSnapshot | null; error: string };
    try {
      [run, liveResult] = await Promise.all([
        runDump(this.settings.all()),
        this.live
          .fetchInventory()
          .then((snapshot) => ({ snapshot, error: '' }))
          .catch((error: unknown) => ({
            snapshot: null,
            error: error instanceof Error ? error.message : String(error),
          })),
      ]);
    } catch (error) {
      // 配置读不出来（overlay 坏了、某个 bundle 解析不到…）：这不是"页面失败"，而是**救援场景**。
      // 带上 bundle 清单，界面才能指着那个把 dsh 弄挂的层说"临时停用它"。
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        profile: PLUGIN_PROFILE,
        home,
        profileDir,
        profileName: manifest.name,
        patchReload: manifest.patchReload,
        bundles,
      };
    }
    const dumpLayers = parseDump(run.stdout);
    const problems = [
      ...parseProblems(run.stderr, path.join(profileDir, PATCH_FILE)),
      ...plainDependencies(manifest, profileDir),
      ...missingLayers(manifest, dumpLayers),
    ];

    const treeLayers: PluginTreeLayer[] = dumpLayers.map((layer) => ({
      label: layer.label,
      source: layer.source,
      patchedBy: layer.patchedBy,
      entries: layer.entries.map((entry): PluginEntry => ({
        id: entry.id,
        name: entry.name,
        disabled: entry.disabled,
        hasConfig: entry.hasConfig,
      })),
    }));

    return {
      ok: true,
      profile: PLUGIN_PROFILE,
      home,
      profileDir,
      profileName: manifest.name,
      patchReload: manifest.patchReload,
      bundles,
      layers: buildLayers({ manifest, profileDir, home, dumpLayers, moduleDirs }),
      treeLayers,
      problems,
      entryCount: dumpLayers.reduce((sum, layer) => sum + layer.entries.length, 0),
      commands: [run.display],
      // 解析不出来（上游改了格式）时保留原文，界面降级成纯文本视图而不是空白
      rawDump: dumpLayers.length === 0 ? run.stdout : null,
      live: liveResult.snapshot,
      liveError: liveResult.error || undefined,
      // 装/卸/升级要 pnpm；`dsh plugin` 自己是裸 spawn，所以这里先把结论告诉界面
      pnpm: (() => {
        const found = findPnpm();
        return { found: found !== null, path: found };
      })(),
      // 界面上要能看见"这次装会走哪个源"；null = 跟随系统 npm 配置
      registry: pluginRegistryEnv(this.settings.all().pluginRegistry).npm_config_registry ?? null,
    };
  }
}

export { PLUGIN_PROFILE } from './plugin-shared';
export {
  bundleDeclared,
  checkDumpResult,
  declaresBundle,
  firstMeaningfulLine,
  missingLayers,
  packageNameOf,
  parseDump,
  parsePluginSpec,
  parseProblems,
  patchLayerInserts,
  plainDependencies,
  pluginRegistryEnv,
  readProfileManifest,
  splitLayerLabel,
  suggestEntryId,
  summarizePluginFailure,
} from './plugin-parse';
export {
  parseTokenUrl,
  stripIncludePrefix,
  summarizeLive,
  unaryEnvelope,
  unwrapLiveValue,
} from './plugin-live';
export type { DumpEntry, DumpLayer, DumpRun, PluginSpec, ProfileManifest } from './plugin-parse';
