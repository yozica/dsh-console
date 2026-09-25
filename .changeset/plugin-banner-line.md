---
'dsh-console': patch
---

插件页那条「重启之后」的结局提示单行时竖直居中：`.banner` 的 `align-items: flex-start` 与图标 `margin-top` 本来是为「标题 + 说明」两行准备的，单行套上去文字会明显偏上（用户真机截图指出）—— 现在单行态加 `.banner.line` 覆盖成居中
