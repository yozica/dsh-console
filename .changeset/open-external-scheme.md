---
'dsh-console': patch
---

内嵌页里点非 http(s) 链接（例如 DSH 自己的文件引用 `dsh-resource://…`）不再弹「DSH Console 出错了（未处理的 Promise 拒绝）」：外链统一走一个 helper，只把 http/https/mailto 交给系统程序，并接住 `shell.openExternal` 的失败（写进日志）
