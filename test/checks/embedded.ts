'use strict';

/**
 * 自检第 13 组：内嵌页诊断的参数形状。
 *
 * 这一组只有一个对象：`readConsoleMessage()` 能不能正确读 Electron 的 `console-message`。
 * **它此前零覆盖**，于是踩过一次真坑（2026-09-27）：函数按"新版详情在第一个参数"去读，
 * 而 Electron 44 的实际形状是 `(event, details)` —— 每个 guest 消息都被读成
 * `level='info'` + `message=''`，而 `wireGuestDiagnostics` 只记 error/warning，
 * 于是**所有内嵌页 console 被静默丢弃**，表现为"插件打什么日志都进不了应用日志"。
 * 真机证据：日志里出现两条**内容为空**的 `[renderer:info]`。
 *
 * 所以这里把两种参数形状都钉住：钉的是**形状**（谁在第几个参数上），不是具体文案。
 */

import { readConsoleMessage } from '../../src/main/main-embedded';

import { check } from '../harness';

/** 结构比较（不引断言库）：值相同就算过，`extra` 里带上实际值方便 CI 注解 */
function same(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function runEmbedded(): void {
  // 现在的形状：`(event, details)`；`details.level` 是数字（0 verbose / 1 info / 2 warning / 3 error）
  const modern = readConsoleMessage([
    { type: 'console-message' },
    {
      level: 2,
      message: 'hello from guest',
      source: 'console-api',
      sourceUrl: 'http://127.0.0.1:3080/app.js',
      lineNumber: 42,
    },
  ]);
  check(
    '内嵌页诊断：Electron 现在的形状 `(event, details)` 能读出 level / message / source / line',
    same(modern, {
      level: 'warning',
      message: 'hello from guest',
      source: 'http://127.0.0.1:3080/app.js',
      line: 42,
    }),
    JSON.stringify(modern),
  );

  // 旧版的形状：`(event, level, message, line, sourceId)` 五个位置参数 —— 迁移期两边都要能读
  const legacy = readConsoleMessage([{}, 3, 'legacy error', 7, 'legacy.js']);
  check(
    '内嵌页诊断：旧的五参数形状仍能读出来（event, level, message, line, sourceId）',
    same(legacy, { level: 'error', message: 'legacy error', source: 'legacy.js', line: 7 }),
    JSON.stringify(legacy),
  );

  // 级别必须是**能过 `wireGuestDiagnostics` 白名单**的两个值：只有 warning / error 会进日志，
  // 读成 'info' 就等于静默丢弃 —— 这条是那次真坑的直接复现判据。
  const warn = readConsoleMessage([{}, { level: 2, message: 'w' }]);
  const error = readConsoleMessage([{}, { level: 3, message: 'e' }]);
  check(
    '内嵌页诊断：warning / error 不会被读丢（读成 info 就等于整条消息进不了日志）',
    warn.level === 'warning' && error.level === 'error',
    `warn=${warn.level} error=${error.level}`,
  );

  // 参数缺失时不许抛：这是事件回调，抛出去会把转发链整个打断
  const empty = readConsoleMessage([]);
  check(
    '内嵌页诊断：参数缺失时返回空值而不是抛错（事件回调里抛错会打断整条转发）',
    same(empty, { level: 'info', message: '', source: '', line: 0 }),
    JSON.stringify(empty),
  );
}
