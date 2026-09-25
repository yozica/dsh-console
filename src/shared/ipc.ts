/**
 * 主进程 ↔ 渲染层之间的**契约类型**。
 *
 * 为什么单独一个目录：这些形状两边都要用（主进程产出、渲染层消费），
 * 放在任何一侧都会让另一侧为了一个类型去 import 主进程代码（渲染层会把 fs/path 拖进包里）。
 * 所以放在 shared/：只允许**类型**与纯常量，禁止 import 任何运行时依赖。
 *
 * 约定：这里描述的是"跨进程线缆上的形状"，不是内部实现细节 ——
 * 主进程内部的类型（比如进程树终止参数）就留在各自的模块里。
 *
 * t55 起这个文件是 **barrel**：按主题住在 `ipc-*.ts` 里（外壳 / 自动更新 / 运行时快照 /
 * 归档 / 插件 / 环境 / Node 通道 / API），这里 `export *` 再导出一次，消费方一行不用改。
 */

export * from './ipc-shell';
export * from './ipc-update';
export * from './ipc-runtime';
export * from './ipc-archive';
export * from './ipc-plugin';
export * from './ipc-env';
export * from './ipc-node';
export * from './ipc-api';
