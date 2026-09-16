import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

/** 主进程 / preload / 自检：Node 的 CommonJS */
const cjsFiles = ['src/main/**/*.js', 'src/preload/**/*.js', 'test/**/*.js']
/** 构建脚本与工具：Node 的 ESM */
const mjsFiles = ['*.mjs', 'tools/**/*.mjs', 'scripts/**/*.mjs']
/** 渲染层：浏览器环境，含 Vue 单文件组件 */
const rendererFiles = ['src/renderer/**/*.{js,vue}']

export default [
  // 构建产物与生成物不检查
  { ignores: ['dist/**', 'release/**', 'build/**', '.verify/**', 'node_modules/**'] },

  js.configs.recommended,
  ...pluginVue.configs['flat/recommended'],

  {
    files: cjsFiles,
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node }
    }
  },
  {
    files: mjsFiles,
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node }
    }
  },
  {
    files: rendererFiles,
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser }
    }
  },

  {
    rules: {
      // 回调签名里常有用不到的位置参数，用下划线前缀明确表意
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      // 空 catch 是这个仓库有意的写法（catch {} 旁边的注释说明"忽略即可"）
      'no-empty': ['error', { allowEmptyCatch: true }],

      // 这个应用的领域就是终端控制序列：process-utils 要按 ANSI 转义序列切分输出，
      // markdown.js 用 \x00 / \x01 当内部占位符。都是显式字面量，不是拼接出来的正则 ——
      // 这条规则真正要防的（外部输入混进控制字符）在这里不存在。
      'no-control-regex': 'off',

      // 模板里 class 写在 id / ref 前面是本仓库统一的写法，而 Prettier 不重排属性。
      // 按 ESLint 的顺序来只会平白改掉 40 多处，读起来并不会更好。
      'vue/attributes-order': 'off'
    }
  },

  // 必须放最后：关掉所有和 Prettier 冲突的格式类规则，格式化只由 Prettier 负责
  prettier
]
