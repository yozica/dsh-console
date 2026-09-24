---
'dsh-console': patch
---

测试夹具里不再带真实的家目录路径

`test/fixtures/broken-patch.stderr.txt` 与 `unmatched-patch.stderr.txt` 是抓下来的真实 dsh 报错，
里面带着当时那台机器的绝对路径（用户名、nvm 版本目录、`.build-home` 结构）。现在统一换成中性的
`/Users/someone/...`：报错形状（堆栈、`YAMLException`、`cordis.patch.yml`、条目 id）一字未改，
自检的断言照旧。
