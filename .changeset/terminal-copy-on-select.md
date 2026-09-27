---
'dsh-console': patch
---

终端页支持复制：选中文字后 Ctrl+C 就是复制

原来 dsh 终端里选中的内容复制不出来 —— 工具栏只有「清空显示 / 重新显示历史 / 发送 Ctrl+C」，
而 Ctrl+C 没被接管，会被当成控制字符发给 dsh（而 `dsh web` 不读 stdin，等于白按）。

现在选中一段文字后按 Ctrl+C 即可复制，状态栏会说一句结果。没选中时 Ctrl+C 仍是"发给 dsh"，
不影响用它停 dsh。macOS 上不接管（那儿的中断键就是 Ctrl+C、复制是 ⌘C），本地 Shell 也不接管
（它的 Ctrl+C 是正经中断，还能打断正在跑的命令）。
