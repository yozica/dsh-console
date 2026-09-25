/**
 * 官方版本清单 / 校验清单 / nvm 发布资产（纯函数）
 *
 * t52 从 `node-installer.ts` 拆出来的（那个文件现在只剩 `NodeInstaller` 类 + `NodeInstallHooks`
 * 接口 + barrel；`buildPlan` 与 `transferPhase` 必须留在同一个文件里 —— 反例脚本按这对锚点
 * 切源码，见 AGENTS §7.35）。
 */
import { NODE_DIST_HOST } from './node-shared';

import type { EnvNodeChannel } from '../shared/ipc';

export interface NodeReleaseEntry {
  version: string;
  lts: string | false;
  files: string[];
  npm?: string;
}

/** 官方版本清单（index.json）→ 条目数组；解析失败返回空数组（不抛） */
export function parseNodeReleaseIndex(text: string): NodeReleaseEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const list: NodeReleaseEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const record: Record<string, unknown> = { ...item };
    const version = typeof record.version === 'string' ? record.version : '';
    if (!version) continue;
    const files = Array.isArray(record.files)
      ? record.files.filter((file): file is string => typeof file === 'string')
      : [];
    const entry: NodeReleaseEntry = {
      version,
      lts: typeof record.lts === 'string' ? record.lts : false,
      files,
    };
    if (typeof record.npm === 'string') entry.npm = record.npm;
    list.push(entry);
  }
  return list;
}

/**
 * 选档：`lts` = 清单里第一条 `lts !== false`（清单是新版本在前，所以这就是最新稳定版）；
 * `current` = 第一条。都不满足返回 null。
 */
export function pickNodeRelease(
  list: NodeReleaseEntry[],
  channel: EnvNodeChannel,
): NodeReleaseEntry | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  if (channel === 'current') return list[0];
  return list.find((entry) => entry.lts !== false) ?? null;
}

/**
 * 该档在这台电脑的架构上有没有 Windows 安装包（读 `files` 里的 `win-<arch>-msi`）。
 *
 * **真机事实（2026-09，866 条清单全量扫描）**：index.json 里从来没有 `win-arm64-msi`
 * 这一项（出现 0 次，`win-x64-msi` 出现 631 次），但同一个版本目录下的校验清单里**确实有**
 * `node-v<版本>-arm64.msi`（对 v24.21.0 实测两个文件都 HTTP 200：x64 33230848 字节、
 * arm64 29671424 字节）。按冻结文档 §4.2 的字面（只读 `files`）实现，结果是 arm64 机器上
 * 「直接安装官方版本」这条路会被判成架构不支持 —— 这不是猜测，是已核对的外部事实，
 * 已按「与冻结冲突就报给船长」的规矩上报，等裁定；在那之前不擅自放宽判据。
 */
/** Node 官方只出这三种 Windows msi 命名 */
const WINDOWS_MSI_ARCHES = ['x64', 'arm64', 'ia32'];

/**
 * 官方下载地址（纯拼装；**存在性不在这里判**）。
 *
 * 为什么不再读 `files` 数组（船长 2026-09 裁定，推翻冻结 §4.2 的初稿）：
 * index.json 的 866 条里 `win-arm64-msi` 出现 **0 次**（`win-x64-msi` 631 次、
 * `win-arm64-zip` 161 次），可同一个版本目录下的 `SHASUMS256.txt` 里
 * `node-v<版本>-arm64.msi` 确实存在（v26.9.0 两个 msi 的 HEAD 都是 200：
 * x64 36520960 字节 / arm64 32501760 字节）。所以**存在性以版本目录里的校验清单
 * 为权威证据**（为了校验哈希我们本来就要取它），index.json 只用来列版本。
 * 于是这里只负责按架构拼出规范地址；认不出的架构 / 版本返回 null。
 */
export function nodeInstallerUrl(entry: NodeReleaseEntry, arch: string): string | null {
  const normalized = String(arch ?? '').toLowerCase();
  if (!WINDOWS_MSI_ARCHES.includes(normalized)) return null;
  if (!/^v\d+\.\d+\.\d+$/.test(String(entry.version ?? ''))) return null;
  return `${NODE_DIST_HOST}/${entry.version}/node-${entry.version}-${normalized}.msi`;
}

/** 安装包文件名（与 `nodeInstallerUrl` 同一套规则；校验清单里查的就是它） */
export function nodeInstallerFileName(version: string, arch: string): string {
  return `node-${version}-${arch}.msi`;
}

/** 官方校验清单文本 → 目标文件的 sha256；清单里没有这个文件返回 null */
export function parseShasums(text: string, fileName: string): string | null {
  const target = String(fileName ?? '').trim();
  if (!target) return null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (!match) continue;
    if (match[2] === target) return match[1].toLowerCase();
  }
  return null;
}

/** `v24.19.0` / `24.19.0` / `24.19` → [24,19,0]；认不出来返回 null */
function versionParts(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const parts: [number, number, number] = [
    Number(match[1]),
    Number(match[2]),
    match[3] === undefined ? 0 : Number(match[3]),
  ];
  return parts.every((part) => Number.isFinite(part)) ? parts : null;
}

/** Node 版本比较（只认 `vX.Y.Z` / `X.Y.Z` / `X.Y` 这类串；认不出按 0 处理，不抛） */
export function compareNodeVersions(a: string, b: string): number {
  const left = versionParts(a) ?? [0, 0, 0];
  const right = versionParts(b) ?? [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    const diff = left[index] - right[index];
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** GitHub 发布资产的最小形状（只取我们要的字段 + 摘要） */
export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  /** GitHub 给的 `sha256:<值>`；老发布 / 老接口可能没有 */
  digest?: string | null;
}

/** 每个架构在资产名里可能出现的写法（`x64` 在 nvm 里叫 `amd64`） */
const ARCH_TOKENS: Record<string, string[]> = {
  x64: ['amd64', 'x64'],
  arm64: ['arm64', 'aarch64'],
  ia32: ['x86', 'ia32'],
};
const ALL_ARCH_TOKENS = ['amd64', 'x64', 'arm64', 'aarch64', 'x86', 'ia32'];
/** 资产名里的预发布标记（发布级的 `prerelease` 由调用方过滤，这里是第二道闸） */
const PRERELEASE_TOKENS = ['alpha', 'beta', 'rc', 'pre', 'preview', 'hotfix', 'nightly', 'dev'];

/**
 * 在发布资产里挑版本管理器的安装包：**按模式挑**，不写死文件名
 * （v1 是 `nvm-setup.exe`，v2 变成 `nvm-<版本>-<架构>-setup.exe`）。
 *
 * 规则（真机核对过 GitHub 上两种命名都在）：只认 `setup.exe`（这一条同时排掉
 * `nvm-setup.zip` / `nvm-noinstall.zip` / `nvm-update.exe` / `*-sync.exe`）；
 * 名字里有预发布标记的跳过；名字里带了架构标记就必须与本机架构一致;
 * **没有**架构标记的老式名字（v1）只对 x64 有效。挑不到返回 null。
 */
export function pickNvmSetupAsset(assets: ReleaseAsset[], arch: string): ReleaseAsset | null {
  if (!Array.isArray(assets)) return null;
  const wanted = ARCH_TOKENS[arch] ?? [String(arch ?? '').toLowerCase()];
  let best: { asset: ReleaseAsset; score: number; version: string } | null = null;
  for (const asset of assets) {
    if (!asset || typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string')
      continue;
    const name = asset.name.toLowerCase();
    if (!/^nvm-.*setup\.exe$/.test(name)) continue;
    const segments = name.split(/[-._]/);
    if (segments.some((segment) => PRERELEASE_TOKENS.includes(segment))) continue;
    const exact = wanted.some((token) => segments.includes(token));
    const otherArch = ALL_ARCH_TOKENS.some(
      (token) => !wanted.includes(token) && segments.includes(token),
    );
    if (otherArch) continue;
    // 老式名字（v1.1.x 的 nvm-setup.exe）没有架构标记，那是 x64 的构建
    if (!exact && arch !== 'x64') continue;
    const version = /nvm-(\d+(?:\.\d+)*)/.exec(name)?.[1] ?? '';
    const score = exact ? 0 : 1;
    if (
      !best ||
      score < best.score ||
      (score === best.score && compareNodeVersions(version, best.version) > 0)
    ) {
      best = { asset, score, version };
    }
  }
  return best ? best.asset : null;
}

/** 资产的 sha256（`sha256:<值>` → 值）；没有 / 认不出返回 null（界面要说"这次没能校验完整性"） */
export function assetSha256(asset: ReleaseAsset): string | null {
  const digest = typeof asset.digest === 'string' ? asset.digest.trim() : '';
  const match = /^sha256:([0-9a-f]{64})$/i.exec(digest);
  return match ? match[1].toLowerCase() : null;
}

/**
 * 发布说明里**自己声明**的签名状态（纯函数，离线可测）。
 *
 * nvm-windows 的发布说明正文里有机器可读的一行（实测 2026-09）：
 * - `Unsigned community build from \`cli/src/manifest.json\` version \`2.0.0\`.`（最新稳定 v2.0.0）
 * - `Authenticode-signed community build from \`…\``（v2.0.1-hotfix.2，prerelease）
 * - 1.2.x 那条线**没有这一行** → `unknown`
 *
 * 顺序要紧：`Unsigned …` 必须在 `Authenticode-signed …` 之前判 —— "Unsigned" 里也含 "signed"。
 */
export function parseReleaseSigning(body: string): 'signed' | 'unsigned' | 'unknown' {
  const text = String(body ?? '');
  if (/unsigned community build/i.test(text)) return 'unsigned';
  if (/authenticode-signed community build/i.test(text)) return 'signed';
  return 'unknown';
}

/**
 * 展开 `%NAME%` 这类环境变量引用（键名大小写不敏感）；查不到的引用**原样留着**
 * —— 一个用户自己写的目录不该被我们悄悄删掉。
 *
 * 为什么需要它：Windows 的 PATH 里常见 `%NVM_HOME%;%NVM_SYMLINK%`（本机实测就是），
 * 不展开的话合并出来的那一段里没有任何真实目录，nvm 装完照样找不到 Node。
 */
export function expandEnvReferences(value: string, vars: Record<string, string>): string {
  const lookup = new Map<string, string>();
  for (const [key, text] of Object.entries(vars)) {
    if (typeof text === 'string') lookup.set(key.toLowerCase(), text);
  }
  const replacer = (whole: string, name: string): string => lookup.get(name.toLowerCase()) ?? whole;
  return String(value ?? '').replace(/%([^%]+)%/g, replacer);
}

// ---------------------------------------------------------------- 失败分类（冻结清单之外的实现手段）
