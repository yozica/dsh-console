/**
 * 「安装源上的版本读数」：dsh 与 pnpm 各一份（一次查询两个包 + 5 分钟缓存）。
 *
 * 为什么单独一个模块（t81 从 `main-ipc-env.ts` 里抽出来）：这些读数有**两个**消费者 ——
 * 界面（`env:pkg-updates`）与**执行侧**（`EnvDoctor.fixPlan('update-pnpm')` 要把目标版本钉进 argv）。
 * 两边必须拿到**同一份**结果，否则又会出现"界面显示装到 A、实际装的是 B"。
 *
 * 三条边界（与 `npm-registry.ts` 同源）：
 *   1. **只读**：一次 GET；不改用户的 `.npmrc`、不写任何配置文件。安装源优先用设置里的
 *      `pluginRegistry`（留空 → 官方源）。
 *   2. **不进 `EnvDoctorReport`**：那条路首启门禁也在读，塞网络请求会把门禁变成"断网就进不去"。
 *   3. **失败就是"这一轮查不到"**：超时 / 非 2xx / JSON 坏掉一律降级，**不把错误当结论**。
 */
import {
  DSH_PACKAGE,
  fetchPackageMetadata,
  normalizeRegistryBase,
  pickPackageUpdate,
} from './npm-registry';
import { majorOf } from './process-pnpm';

import type { EnvPkgUpdates, EnvPnpmBinding } from '../shared/ipc';
import type { SettingsValues } from './settings';

/** 缓存时长：与"模型目录缓存"同量级。这一轮查不到时不许把人长期锁在"查不到"上 */
export const PKG_UPDATE_TTL_MS = 5 * 60 * 1000;

/** 单次查询的超时：几秒。超时不是"已是最新"，是"这一轮查不到" */
export const PKG_QUERY_TIMEOUT_MS = 8000;

let cache: { at: number; value: EnvPkgUpdates } | null = null;

/** 清掉缓存（「重新检测」、修复完成后复检时用） */
export function invalidatePkgUpdates(): void {
  cache = null;
}

/**
 * pnpm 的目标钉在哪条大版本线上（硬约定 2）：**profile 记的那条**，读不到就跟随当前那份的 major。
 *
 * 为什么不能取 latest：store 布局按大版本走（9 → `store/v3`、10 → `store/v10`），拿 11 去动 10 装的
 * `node_modules` 会被 pnpm 直接拒绝（真机踩过，见 `parseProfilePnpmMajor` 的注释）。
 * 所以"更新 pnpm" = **同一大版本内的最新**。跨大版本是另一件事，本轮不做。
 */
export function pnpmMajorForUpdates(binding: EnvPnpmBinding): string | null {
  return binding.expectedMajor ?? majorOf(binding.version);
}

export interface PkgUpdatesInput {
  settings: SettingsValues;
  /** 本机这一份的版本（`EnvDoctor.installedVersions()` 的只读结果） */
  installed: { dsh: string | null; pnpm: string | null };
  /** pnpm 的归属事实（决定目标钉在哪条大版本线上，也在没有 pnpm 时说清对象是谁） */
  pnpmBinding: EnvPnpmBinding;
  /**
   * pnpm 的**安装**线（没有 pnpm 时用）：缺 VC++ 运行库时是纯 JS 那条 10.x，其余是"最新"。
   * 调用方从 `pnpmInstallSpec()` 算好传进来 —— 这样本模块不必 import 修复计划那一层。
   */
  pnpmInstallMajor: string | null;
  refresh?: boolean;
}

/** 取一份版本读数（默认走缓存；`refresh` 绕过它）。失败一律降级成"这一轮查不到"。 */
export async function loadPkgUpdates(input: PkgUpdatesInput): Promise<EnvPkgUpdates> {
  const now = Date.now();
  if (!input.refresh && cache && now - cache.at < PKG_UPDATE_TTL_MS) return cache.value;

  const base = normalizeRegistryBase(input.settings.pluginRegistry);
  const [dshMeta, pnpmMeta] = await Promise.all([
    fetchPackageMetadata(DSH_PACKAGE, { base, timeoutMs: PKG_QUERY_TIMEOUT_MS }),
    fetchPackageMetadata('pnpm', { base, timeoutMs: PKG_QUERY_TIMEOUT_MS }),
  ]);

  // 有 pnpm 时按"同一大版本内最新"取（更新路径）；没有 pnpm 时按安装线取（那一行给的是"一键安装"）
  const pnpmMajor = input.pnpmBinding.file
    ? pnpmMajorForUpdates(input.pnpmBinding)
    : input.pnpmInstallMajor;

  const value: EnvPkgUpdates = {
    checkedAt: Date.now(),
    // dsh 装的是不带版本的 spec → 目标取 dist-tags.latest（见 pickPackageUpdate 的说明）
    dsh: pickPackageUpdate({ current: input.installed.dsh, metadata: dshMeta }),
    pnpm: pickPackageUpdate({
      current: input.installed.pnpm,
      metadata: pnpmMeta,
      allowMajor: pnpmMajor,
    }),
  };
  cache = { at: Date.now(), value };
  return value;
}

/** 缓存里的那份（没查过时 null）—— 给"只想知道这一轮有没有查过"的调用方 */
export function cachedPkgUpdates(): EnvPkgUpdates | null {
  return cache?.value ?? null;
}
