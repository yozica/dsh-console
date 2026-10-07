/**
 * npm registry 的**只读**版本查询：给「更新 dsh / 更新 pnpm」那两个入口做版本比对用
 * （见 `docs/env-doctor.md` 的「版本比对」一节）。
 *
 * 四条边界，改之前先看：
 *
 *   1. **只读**。一次 GET，不改用户的 `.npmrc`、不写任何配置文件。安装源优先用设置里的
 *      `pluginRegistry`（留空 → 官方源）—— 与 `pluginRegistryEnv()` 只给那一次子进程注入
 *      `npm_config_registry`、绝不落盘是同一条原则。
 *   2. **纯函数与 IO 分开**。`normalizeRegistryBase` / `comparePackageVersions` /
 *      `pickTargetVersion` / `pickPackageUpdate` 都不碰网络与 fs，`scripts/env-doctor-cases.mjs`
 *      喂对象字面量就能把它们测完；**只有 `fetchPackageMetadata` 一个函数上网**。
 *   3. **失败就是"这一轮查不到"**。超时、非 2xx、JSON 坏掉……一律返回 null，调用方降级成
 *      "不带版本号的更新入口"。错误不是结论 —— 断网时说"已是最新版"是错的，说"连不上"也只是噪音。
 *   4. **这里不 import electron**（与 `env-doctor.ts` 同一条纪律）：反例脚本要在普通 Node 里
 *      直接 require 编译产物。
 *
 * 为什么这个文件不在 `env-doctor.ts` 的 barrel 里再导出一遍：它只有 `main-ipc-env.ts` 一个
 * 调用方，而 barrel 是给"页面与反例脚本都读的那份公开面"用的；多一层转手只会让
 * "谁在发网络请求"更难一眼看清。
 */

import type { EnvPkgUpdate } from '../shared/ipc';

/** 官方源。设置里那条留空时用它（与 npm 自己的默认值一致） */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** dsh 本体的包名（一键 install-dsh 装的就是它，见 `env-fix-plan.ts` 的 argv） */
export const DSH_PACKAGE = '@deepseek-ai/dsh';

/**
 * 把设置里那条安装源（或空串）归一成**能拼 URL 的基地址**。
 *
 * 认不出来一律给官方源 —— 与 `pluginRegistryEnv()` 的判据一致（非 http(s) 当没填），
 * 这样"界面上查的源"与"真正执行安装时用的源"不会是两个地方。
 *
 * 末尾斜杠要去掉（拼包名时会变成 `//`，报错信息里看着像另一个主机），**路径前缀要保留** ——
 * 私有源常常挂在 `https://host/artifactory/api/npm/npm-repo` 这种路径下面。
 */
export function normalizeRegistryBase(input: string | null | undefined): string {
  const value = String(input ?? '').trim();
  if (value.length === 0) return DEFAULT_REGISTRY;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return DEFAULT_REGISTRY;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_REGISTRY;
  if (!url.host) return DEFAULT_REGISTRY;
  return value.replace(/\/+$/, '');
}

/** 一个版本号拆开之后的样子（预发布段为空数组 = 稳定版） */
export interface ParsedPackageVersion {
  major: number;
  minor: number;
  patch: number;
  /** 预发布标识符：数字段是 number，字符段是 string（`rc.1` → ['rc', 1]） */
  prerelease: (string | number)[];
}

/**
 * 解析一个版本号（严格 semver + 一个可选的 `v` 前缀，后者是 `node -v` / `pnpm -v` 的写法）。
 * 认不出来返回 null —— 调用方据此跳过垃圾项，**不猜**。
 *
 * 构建元数据（`+sha`）不参与比较，直接丢掉（semver §10）。
 */
export function parsePackageVersion(text: string): ParsedPackageVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(text ?? '').trim(),
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
      ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : [],
  };
}

/**
 * 从一段命令输出里抠出版本号。
 *
 * 为什么要它：`dsh --version` 的 stdout 是干净的，但同一个进程会把 Node 的告警写到 stderr、
 * 而我们在别处是按整段输出收的（真机实测：`(node:13838) Warning: The 'NO_COLOR' env is ignored…`
 * 就排在版本号前面）。版本读数进界面，所以先抠一次再比。
 */
export function versionFromText(text: string | null | undefined): string | null {
  const match = /v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(String(text ?? ''));
  return match ? match[1] : null;
}

/** 这份版本是不是预发布版（`0.1.5-rc.1` → true；认不出来 → false） */
export function isPrereleaseVersion(version: string | null | undefined): boolean {
  return (parsePackageVersion(String(version ?? ''))?.prerelease.length ?? 0) > 0;
}

/**
 * **按 semver 比版本**（含预发布段）：负数 = a 更旧，0 = 相等，正数 = a 更新。
 *
 * 为什么不复用 `updater.ts` 里那个 `compareVersions`：那个是给 **Console 自己**的更新用的，
 * 它**故意**把预发布当同版本处理（"别因为后缀比较写错而天天提示有新版本"）。而这里恰恰相反 ——
 * 用户跑着 `0.1.5-rc.1` 时，`0.2.0-rc.2` 是一次真实的升级，不许被当成"已经是最新"。
 * 两个需求方向相反，所以是两份实现；**别去合并它们**。
 *
 * 规则（semver §11）：数字段按数值比 → 稳定版 > 任何预发布版 → 预发布段逐标识符比，
 * 数字标识符 < 字母标识符，字母按 ASCII 序，前缀全同时标识符多的更大。
 *
 * 认不出来的输入给一个确定但无意义的兜底序（两个都认不出时按字符串），
 * 保证排序稳定、可重复，不会因为一个垃圾项把整份列表搞乱。
 */
export function comparePackageVersions(a: string, b: string): number {
  const left = parsePackageVersion(a);
  const right = parsePackageVersion(b);
  if (!left || !right) {
    if (left) return 1;
    if (right) return -1;
    return a === b ? 0 : a < b ? -1 : 1;
  }
  const keys = ['major', 'minor', 'patch'] as const;
  for (const key of keys) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  // 主版本号相同：没有预发布段的那一份更大（`0.2.0` > `0.2.0-rc.2`）
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const shared = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < shared; index += 1) {
    const one = left.prerelease[index];
    const two = right.prerelease[index];
    if (one === two) continue;
    const oneNumber = typeof one === 'number' ? one : null;
    const twoNumber = typeof two === 'number' ? two : null;
    if (oneNumber !== null && twoNumber !== null) {
      if (oneNumber !== twoNumber) return oneNumber < twoNumber ? -1 : 1;
      continue;
    }
    if (oneNumber === null && twoNumber === null) {
      const oneText = String(one);
      const twoText = String(two);
      if (oneText !== twoText) return oneText < twoText ? -1 : 1;
      continue;
    }
    // 一个是数字标识符、一个是字母：数字更小（`1.0.0-1 < 1.0.0-alpha`）
    return oneNumber !== null ? -1 : 1;
  }
  if (left.prerelease.length === right.prerelease.length) return 0;
  // 前缀全同：标识符多的那个更大（`1.0.0-alpha < 1.0.0-alpha.1`）
  return left.prerelease.length < right.prerelease.length ? -1 : 1;
}

/** 从一个 npm spec 里取包名：`pnpm@10` → `pnpm`；`@scope/name@1` → `@scope/name` */
export function packageNameOfSpec(spec: string): string {
  const value = String(spec ?? '').trim();
  const at = value.lastIndexOf('@');
  return at > 0 ? value.slice(0, at) : value;
}

export interface PickTargetOptions {
  /** 要不要把预发布版也当候选（本机那一份是预发布时为 true） */
  includePrerelease: boolean;
  /** 只在这个主版本里挑（`pnpm@10` → `'10'`）；null / 省略 = 不限 */
  allowMajor?: string | null;
}

/**
 * 从版本列表里挑**目标版本**（纯函数）。
 *
 * `includePrerelease=false` 只考虑不带 `-` 的；`allowMajor` 给了就只考虑该主版本；
 * 认不出来的项直接跳过（registry 上真有非 semver 的东西）；没有候选返回 null。
 * 比较一律走 `comparePackageVersions`（含预发布序）。
 *
 * **注意它挑的是"列表里最新的"，不一定是"那条命令会装到的"** —— 后者由
 * `pickPackageUpdate` 决定（不带版本的 spec 装的是 registry 的 `latest` 标签）。
 * 两个概念分开，是因为它们真的不是一回事。
 */
export function pickTargetVersion(versions: string[], options: PickTargetOptions): string | null {
  const allowMajor = options.allowMajor ?? null;
  const wantedMajor = allowMajor === null ? null : String(allowMajor).trim();
  let best: string | null = null;
  for (const raw of versions ?? []) {
    const version = String(raw ?? '').trim();
    const parsed = parsePackageVersion(version);
    if (!parsed) continue;
    if (!options.includePrerelease && parsed.prerelease.length > 0) continue;
    if (wantedMajor !== null && String(parsed.major) !== wantedMajor) continue;
    if (best === null || comparePackageVersions(version, best) > 0) best = version;
  }
  return best;
}

/** 一次 registry 查询的结果（**两个字段都要**，见 `pickPackageUpdate` 的说明） */
export interface RegistryPackage {
  /** 全部已发布版本号（原样，含预发布；不在这里过滤垃圾项，交给 `pickTargetVersion`） */
  versions: string[];
  /** dist-tags：**不带版本的 `npm i -g <pkg>` 装的就是 `latest` 指向的那一个** */
  distTags: Record<string, string>;
}

/** `versions` / `dist-tags` 的读取：只认形状，不认别的一律当没有（JSON.parse 的兜底） */
function readRegistryPackage(body: unknown): RegistryPackage | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as { versions?: unknown; 'dist-tags'?: unknown };
  if (!record.versions || typeof record.versions !== 'object') return null;
  const versions = Object.keys(record.versions as Record<string, unknown>);
  const distTags: Record<string, string> = {};
  if (record['dist-tags'] && typeof record['dist-tags'] === 'object') {
    for (const [tag, value] of Object.entries(record['dist-tags'] as Record<string, unknown>)) {
      if (typeof value === 'string') distTags[tag] = value;
    }
  }
  return { versions, distTags };
}

export interface FetchPackageOptions {
  /** 归一过的基地址（调用方先过 `normalizeRegistryBase`；这里再过一次是幂等的） */
  base: string;
  timeoutMs: number;
}

/**
 * 取一个包的版本表与 dist-tags。**只读**，任何失败都返回 null（见文件头第 3 条）。
 *
 * `Accept: application/vnd.npm.install-v1+json` 是 npm 的精简元数据（只要版本表，不含说明与
 * 附件）—— 实测 `@deepseek-ai/dsh` 这份约 160 KB，比整份文档小一大截。
 *
 * 超时用 `AbortSignal.timeout`（与 `updater.ts` 同一个写法）：不留自己管的手工定时器，
 * 也就不会漏 clear。`packageNameOfSpec` 之外的调用方都不必自己拼 URL。
 */
export async function fetchPackageMetadata(
  pkg: string,
  options: FetchPackageOptions,
): Promise<RegistryPackage | null> {
  const name = String(pkg ?? '').trim();
  if (!name) return null;
  const base = normalizeRegistryBase(options.base);
  // 带 scope 的包名要把 `/` 编码掉（`@scope%2Fname`）：两条路 registry 都认，但编码后不会被
  // 中间的反向代理当成两段路径
  const url = `${base}/${encodeURIComponent(name)}`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(Math.max(1000, options.timeoutMs)),
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!response.ok) return null;
    return readRegistryPackage(await response.json());
  } catch {
    // 超时 / DNS / 断网 / 代理 / JSON 坏掉 —— 一律"这一轮查不到"，不编原因（原文进不了界面）
    return null;
  }
}

export interface PickPackageUpdateInput {
  /** 本机现在这一份的版本（探测得来的原文，可能带 `v` 前缀或杂字） */
  current: string | null;
  /** 这一次的查询结果；null = 没查到 */
  metadata: RegistryPackage | null;
  /**
   * 装的是"**某个主版本区间里**最高的已发布版本"时给出主版本号（`pnpm@10` → `'10'`）。
   *
   * 不给 = 装的是**不带版本的 spec**（`pnpm` / `@deepseek-ai/dsh`），npm 装的是 registry 的
   * `latest` 标签 —— 那时目标必须取 `latest`，**不能**取"列表里最新的"。
   */
  allowMajor?: string | null;
}

/**
 * 把「本机版本 + 一次查询」算成界面上那一行读数（纯函数，反例脚本直接喂字面量）。
 *
 * **目标必须等于那条命令真的会装到的版本**，这是这一段的全部意义（规范 §4）：
 *
 *   - 不带版本的 spec → `dist-tags.latest`。取"列表里最新的"会出事：`pnpm` 的 `latest` 是
 *     12.8.1，而 12.8.2 / 12.9.0 已经发布在别的 tag 下 —— 按"最新"提示 12.9.0，用户点了装到
 *     12.8.1，然后**永远提示有新版本**（不收敛）。`@deepseek-ai/dsh` 更极端：它一个稳定版都
 *     没有，`latest` 就是 `0.2.0-rc.2`，而"含预发布的最新"是 `0.2.1-alpha.1`。
 *   - 带区间的 spec（缺 VC++ 运行库时的 `pnpm@10`）→ 该区间里最高的已发布版本（range 解析
 *     不看 tag，看版本序），这时 `pickTargetVersion(..., { allowMajor: '10' })` 才是对的。
 *
 * `includePrerelease` 只在区间那一路起作用，判据是**本机那一份是不是预发布**
 * （`pnpm@10` 的候选里本来也没有预发布，这一条是为"本机在 10.x 预发布上"准备的）。
 *
 * `newer` 只在两边都拿得到时才为真；`ahead` 是"本机比安装源上的还新"（用户在 alpha 通道上
 * 时真会发生），界面据此换一句话说 —— 只说"已是最新版"会与"点了会降级"矛盾。
 */
export function pickPackageUpdate(input: PickPackageUpdateInput): EnvPkgUpdate {
  const current = versionFromText(input.current);
  const metadata = input.metadata;
  if (!metadata) {
    return {
      current,
      target: null,
      newer: false,
      ahead: false,
      error: '这一轮没能从安装源取到版本',
    };
  }
  const allowMajor = input.allowMajor ?? null;
  const target =
    allowMajor !== null
      ? pickTargetVersion(metadata.versions, {
          includePrerelease: isPrereleaseVersion(current),
          allowMajor,
        })
      : (metadata.distTags.latest ?? null);
  if (!target) {
    // 源上有这个包，但没有可用的目标（没有 latest 标签 / 这个主版本一个都没发过）：
    // 与"查不到"一样降级成朴素入口，只是不必再说"连不上"（error 仍为 null）
    return { current, target: null, newer: false, ahead: false, error: null };
  }
  if (!current) {
    // 本机版本没测出来（例如 dsh 走的是不报版本的那条解释器组合）：能说清目标的还是说清楚，
    // 但不给"有没有新版"的结论 —— 那是拿不到事实时唯一诚实的选择
    return { current: null, target, newer: false, ahead: false, error: null };
  }
  const order = comparePackageVersions(current, target);
  return { current, target, newer: order < 0, ahead: order > 0, error: null };
}
