---
'dsh-console': patch
---

插件页层栈视图末尾那句「还有 N 条…」的左内边距（真机翻看发现，比上面所有内容左移 16px）

它用的是全局零件 `.hint`（本身没有左右内边距），而同一块里的小标题是
`.plugin-entries .block-head { padding: 0 16px }`、条目行是 `.plugin-entry { padding: 6px 16px }`
—— 于是那行注释贴到了卡片的左边缘。补一条 `.plugin-entries .hint { padding: 0 16px }`。

实测（headless Chrome，2 倍缩放）：条目文字左缘 32~~33 设备像素，这句**原来在 0~~1、现在 33**。
机械等价因此从 577 变成 **578（+1，就是这一条修复）**；`npm test` 315/315、lint / format:check /
typecheck / build 全绿。
