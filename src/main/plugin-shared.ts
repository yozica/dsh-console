/**
 * 插件装配层各模块共用的常量（profile 名 / 各种超时 / 输出上限）
 *
 * t54 从 `plugin-manager.ts` 拆出来的；那个文件现在只剩三个类（Runner / Live / Manager）+ barrel，
 * 别的模块与自检的 import 路径不用改。
 */

/**
 * console 启动的就是 `dsh web`，而 `dsh web` 是 `--profile web` 的别名，
 * 所以插件页永远针对 `web` 这个 profile。
 * `desktop` 是 CLI 保留给 Electron 的名字（`bin.js` 直接报错），我们不碰也不需要。
 */
export const PLUGIN_PROFILE = 'web';

/** dump 是启动前的组合计算，不该慢；超时按失败处理而不是无限等 */
export const DUMP_TIMEOUT_MS = 20_000;
/** 运行中清单走本机 HTTP，正常是毫秒级；超时按"读不到"处理 */
export const LIVE_TIMEOUT_MS = 5_000;
/** dsh 客户端的 Remote 端点：`<service>/<method>` 就是 /api 后面的路径 */
export const LIVE_ENDPOINT = 'pluginInventory/list';
/** 装/卸/升级最慢的是 pnpm 拉包；给它一个上限，避免界面永远停在"进行中" */
export const OP_TIMEOUT_MS = 10 * 60 * 1000;
/** 归纳失败原因时只看尾部这些字节（pnpm 的报错通常在最后） */
export const OP_TAIL_CHARS = 8000;
/** 本机 web profile 的 dump 约 17 KB；留足余量，异常大时按失败处理 */
export const DUMP_MAX_BUFFER = 8 * 1024 * 1024;

// ---------------------------------------------------------------- 磁盘上的形状
