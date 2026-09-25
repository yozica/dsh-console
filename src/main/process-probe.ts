/**
 * HTTP 健康探测与端口占用查询（netstat / lsof 解析）
 *
 * 探测端口上是不是 dsh、谁在占用（从 `process-utils.ts` 拆出来的；那个文件现在只做 barrel 再导出，
 * 6 个消费者与两个反例脚本的 import 路径不用改）。
 */
import type { PortOwner, ProbeResult } from './process-types';
import { isWindows } from './process-types';

import { execFile } from 'node:child_process';
import http from 'node:http';

/** 判断 HTTP 响应是否来自 dsh web。 */
export function isDshResponse(statusCode: number | undefined, body: unknown): boolean {
  const text = String(body || '');
  if (/dsh web authentication required/.test(text)) return true;
  if (statusCode === 200 && /__DSH_BOOT__|DeepSeek Harness/i.test(text)) return true;
  return false;
}

/** 探测一个 HTTP 地址。 */
export function probeHttp(url: string, timeoutMs = 1500): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const finish = (value: Omit<ProbeResult, 'latencyMs'>) => {
      if (settled) return;
      settled = true;
      resolve({ latencyMs: Date.now() - started, ...value });
    };
    let request: http.ClientRequest;
    try {
      request = http.get(
        url,
        { timeout: timeoutMs, headers: { 'user-agent': 'dsh-console' } },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            if (body.length < 65536) body += chunk;
          });
          res.on('end', () => {
            finish({
              reachable: true,
              statusCode: res.statusCode,
              isDsh: isDshResponse(res.statusCode, body),
              body: body.slice(0, 300),
              location: res.headers.location,
            });
          });
          res.on('error', (error: Error) =>
            finish({ reachable: false, error: error.message, isDsh: false }),
          );
        },
      );
    } catch (error) {
      finish({
        reachable: false,
        error: error instanceof Error ? error.message : String(error),
        isDsh: false,
      });
      return;
    }
    request.on('timeout', () => {
      request.destroy();
      finish({ reachable: false, error: 'timeout', isDsh: false });
    });
    request.on('error', (error: Error) =>
      finish({ reachable: false, error: error.message, isDsh: false }),
    );
  });
}

/**
 * 从 netstat -ano 输出里解析监听指定端口的 PID（纯函数，便于单测）。
 */
export function parseNetstatForPort(stdout: string, port: number): PortOwner | null {
  const wanted = `:${port}`;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const [proto, local, , state, pidText] = cols;
    if (proto.toUpperCase() !== 'TCP') continue;
    if (state.toUpperCase() !== 'LISTENING') continue;
    if (!local.endsWith(wanted)) continue;
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    return { pid, local, port: Number(port) };
  }
  return null;
}

/**
 * 从 `lsof -nP -iTCP:<port> -sTCP:LISTEN` 输出里解析监听者 PID（纯函数，便于单测）。
 * 行形如：COMMAND   PID USER   FD  TYPE DEVICE SIZE/OFF NODE NAME
 *          node   42112  abc   20u IPv4 0x...      0t0  TCP 127.0.0.1:3080 (LISTEN)
 * NAME 列在协议名（TCP）之后：可能是 *:3080、127.0.0.1:3080 或 [::1]:3080。
 */
export function parseLsofForPort(stdout: string, port: number): PortOwner | null {
  const wanted = `:${Number(port)}`;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!/\(LISTEN\)/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    const pid = Number(cols[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const tcpAt = cols.indexOf('TCP');
    const name = tcpAt >= 0 ? cols[tcpAt + 1] || '' : '';
    const local = name.split('->')[0]; // 只看本地地址，别把 ESTABLISHED 的对端算进来
    if (!local || !local.endsWith(wanted)) continue;
    return { pid, local, port: Number(port) };
  }
  return null;
}

/** 用平台自带命令找出监听指定端口的进程 PID。 */
export function portOwnerSync(port: number): Promise<PortOwner | null> {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0) {
      resolve(null);
      return;
    }
    const finish = (stdout: string | undefined) => {
      if (!stdout) {
        resolve(null);
        return;
      }
      resolve(isWindows ? parseNetstatForPort(stdout, port) : parseLsofForPort(stdout, port));
    };
    try {
      if (isWindows) {
        execFile(
          'netstat',
          ['-ano', '-p', 'tcp'],
          { windowsHide: true, timeout: 8000 },
          (error, stdout) => {
            if (error) {
              resolve(null);
              return;
            }
            finish(stdout);
          },
        );
      } else {
        // lsof 查询端口时经常要 sudo 才全（别的用户的进程看不见）；
        // 本应用场景只关心自己启动的 dsh，无权限时返回 null 由状态机兜底。
        execFile(
          'lsof',
          ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'],
          { timeout: 8000 },
          (error, stdout) => {
            if (error) {
              resolve(null);
              return;
            }
            finish(stdout);
          },
        );
      }
    } catch {
      // 系统命令起不来（受限环境）：当作未知，不影响状态机
      resolve(null);
    }
  });
}
