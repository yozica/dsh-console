---
'dsh-console': patch
---

修内嵌页控制台日志**全丢**的问题：`readConsoleMessage()` 读错了参数位置。

Electron 现在的 `console-message` 形状是 **`(event, details)`** —— 详情在**第二个**参数上，
而原来的实现按"详情在第一个参数"去读，于是每条 guest 消息都被读成
`level='info'` + `message=''`；而 `wireGuestDiagnostics` 只记 error/warning，
**所有内嵌页 console 因此被静默丢弃**。

真机症状（2026-09-27）：应用日志里出现两条**内容为空**的 `[renderer:info]`，而内嵌页里
打的任何 `console.warn/error` 都进不了日志 —— 排查内嵌页问题等于没有证据。

改动：判据取 `args[1]`（数字 = 旧的五参数形状；带 `message` 的对象 = 现在的形状），
级别数字 0..3 映射成 verbose/info/warning/error，并补上 `sourceUrl` / `lineNumber`；
参数缺失时返回空值而不抛（事件回调里抛错会打断整条转发）。
新增 `test/checks/embedded.ts` 四条件断言钉住两种形状 —— 这块此前**零覆盖**，
正是它能活到今天的原因；写断言时当场又抓出我第一版修法里"旧形状判据写错"（`args[0]` 是
event 不是 level）。
