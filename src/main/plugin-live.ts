/**
 * 运行中清单：令牌换 cookie 的客户端、信封与应答解包、快照归纳
 *
 * t54 从 `plugin-manager.ts` 拆出来的；那个文件现在只剩三个类（Runner / Live / Manager）+ barrel，
 * 别的模块与自检的 import 路径不用改。
 */
import { asRecord } from './plugin-parse';

import type {
  PluginFiberPhase,
  PluginLiveEntry,
  PluginLivePreset,
  PluginLiveSnapshot,
} from '../shared/ipc';

import { LIVE_ENDPOINT, LIVE_TIMEOUT_MS } from './plugin-shared';

/** `http://127.0.0.1:3080/?token=xyz` → { origin, token }；没有令牌或不是 URL 时返回 null */
export function parseTokenUrl(
  url: string | null | undefined,
): { origin: string; token: string } | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const token = parsed.searchParams.get('token');
    if (!token) return null;
    return { origin: parsed.origin, token };
  } catch {
    return null;
  }
}

/** 运行中的条目 id 带 `include:` 前缀（它们是从根 include 加载进来的），对配置里的 id 时要剥掉 */
export function stripIncludePrefix(entryId: string): string {
  const prefix = 'include:';
  return entryId.startsWith(prefix) ? entryId.slice(prefix.length) : entryId;
}

/** 一元调用的请求信封（dsh 客户端协议：type / rpcId / method / payload.args） */
export function unaryEnvelope(method: string, rpcId: string): string {
  return JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: {} } });
}

/** 从 server-response 信封里取出 value；ok:false 或形状不对时返回 null */
export function unwrapLiveValue(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const envelope = asRecord(parsed);
  if (envelope.type !== 'server-response') return null;
  const result = asRecord(envelope.result);
  if (result.ok !== true) return null;
  return result.value;
}

/** 把接口返回整理成界面要的形状（计数、预设行数） */
export function summarizeLive(value: unknown): PluginLiveSnapshot {
  const raw = asRecord(value);
  const entries: PluginLiveEntry[] = (Array.isArray(raw.entries) ? raw.entries : []).map((item) => {
    const entry = asRecord(item);
    const phase = entry.fiberPhase;
    return {
      entryId: typeof entry.entryId === 'string' ? entry.entryId : String(entry.entryId ?? ''),
      moduleName: typeof entry.moduleName === 'string' ? entry.moduleName : '',
      enabled: entry.enabled === true,
      fiberPhase: (typeof phase === 'string' ? phase : null) as PluginFiberPhase,
    };
  });
  const presets: PluginLivePreset[] = (Array.isArray(raw.agentPresets) ? raw.agentPresets : []).map(
    (item) => {
      const preset = asRecord(item);
      return {
        id: typeof preset.id === 'string' ? preset.id : '',
        name: typeof preset.name === 'string' ? preset.name : null,
        isDefault: preset.isDefault === true,
        broken: typeof preset.broken === 'string' ? preset.broken : null,
        rows: Array.isArray(preset.rows) ? preset.rows.length : 0,
      };
    },
  );
  return {
    entries,
    presets,
    counts: {
      total: entries.length,
      active: entries.filter((entry) => entry.fiberPhase === 'active').length,
      failed: entries.filter((entry) => entry.fiberPhase === 'failed').length,
      idle: entries.filter((entry) => entry.fiberPhase === null).length,
    },
  };
}

/**
 * 运行中清单的客户端：令牌换 cookie（30 天），再用 cookie 调一次接口。
 * cookie 缓存在实例里；401 时自动重换一次（dsh 重启后旧 cookie 就失效了）。
 */
export class LiveClient {
  private cookie: string | null = null;

  constructor(private readonly getTokenUrl: () => string | null) {}

  private async authenticate(origin: string, token: string): Promise<void> {
    const response = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
    });
    const raw = response.headers.getSetCookie?.() ?? [];
    const cookie = raw.map((line) => line.split(';')[0]).find((pair) => pair.includes('='));
    if (!cookie) throw new Error('dsh 没有回访问 cookie（可能这个地址不是它的）');
    this.cookie = cookie;
  }

  private async post(origin: string, method: string, rpcId: string): Promise<Response> {
    return fetch(`${origin}/api/${LIVE_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: unaryEnvelope(method, rpcId),
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
    });
  }

  async fetchInventory(): Promise<PluginLiveSnapshot> {
    const target = parseTokenUrl(this.getTokenUrl());
    if (!target) {
      throw new Error('dsh 不是本应用启动的（拿不到访问令牌），运行中的清单读不到');
    }
    if (!this.cookie) await this.authenticate(target.origin, target.token);

    let response = await this.post(target.origin, LIVE_ENDPOINT, 'plugin-inventory-1');
    if (response.status === 401) {
      // cookie 过期（dsh 重启过）：重换一次再试
      this.cookie = null;
      await this.authenticate(target.origin, target.token);
      response = await this.post(target.origin, LIVE_ENDPOINT, 'plugin-inventory-2');
    }
    if (!response.ok) throw new Error(`dsh 返回 ${response.status}`);
    const value = unwrapLiveValue(await response.text());
    if (value === null) throw new Error('dsh 的应答看不懂（协议可能变了）');
    return summarizeLive(value);
  }
}

// ---------------------------------------------------------------- 对外
