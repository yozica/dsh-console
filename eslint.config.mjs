import js from '@eslint/js';
import pluginVue from 'eslint-plugin-vue';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** 主进程 / preload / 自检：Node 的 CommonJS（迁移期 .js 与 .ts 并存） */
const nodeCjsFiles = ['src/main/**/*.js', 'src/preload/**/*.js', 'test/**/*.js'];
/** 主进程 / preload / 共享类型：Node，源码写 ESM 语法、由 tsc 编译成 CJS */
const nodeTsFiles = [
  'src/main/**/*.ts',
  'src/preload/**/*.ts',
  'src/shared/**/*.ts',
  'test/**/*.ts',
];
/** 所有 TS 文件：TS 规则集只该作用在这些文件上（否则 .js 里的 require() 会被 no-require-imports 误报） */
const tsFiles = ['**/*.{ts,tsx,mts,cts}'];
/** 构建脚本与工具：Node 的 ESM（.mjs 是纯 JS；.mts 由 tsx / Vite 直接执行） */
const mjsFiles = [
  '*.mjs',
  '*.mts',
  'tools/**/*.mjs',
  'tools/**/*.mts',
  'scripts/**/*.mjs',
  'scripts/**/*.mts',
];
/** 渲染层：浏览器环境，含 Vue 单文件组件 */
const rendererFiles = ['src/renderer/**/*.{js,ts,vue}'];

export default [
  // 构建产物与生成物不检查
  // .build-home 是本地打包/冒烟用的临时 HOME（见 .gitignore），里面的脚本不进 lint
  {
    ignores: [
      'dist/**',
      'release/**',
      'build/**',
      '.verify/**',
      'node_modules/**',
      '.build-home/**',
    ],
  },

  js.configs.recommended,
  // TS 规则集（只作用于 .ts/.tsx/.mts/.cts）。这里刻意先用**不带类型信息**的那套：
  // recommendedTypeChecked 需要 parserOptions.projectService 与全量类型信息，lint 会明显变慢，
  // 而且会在迁移期一次性涌入大量 no-unsafe-* / no-floating-promises。等 TS 迁移收尾后
  // 可以作为独立一步打开（那时改动面小、也容易 review）。
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: tsFiles })),
  ...pluginVue.configs['flat/recommended'],

  {
    files: nodeCjsFiles,
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    files: nodeTsFiles,
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: mjsFiles,
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: rendererFiles,
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },

  // Vue 单文件组件里的 <script lang="ts"> 要交给 TS 解析器（vue-eslint-parser 负责外层模板）
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },

  {
    rules: {
      // 回调签名里常有用不到的位置参数，用下划线前缀明确表意
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      // 空 catch 是这个仓库有意的写法（catch {} 旁边的注释说明"忽略即可"）
      'no-empty': ['error', { allowEmptyCatch: true }],

      // 这个应用的领域就是终端控制序列：process-utils 要按 ANSI 转义序列切分输出，
      // markdown.ts 用 \x00 / \x01 当内部占位符。都是显式字面量，不是拼接出来的正则 ——
      // 这条规则真正要防的（外部输入混进控制字符）在这里不存在。
      'no-control-regex': 'off',

      // 模板里 class 写在 id / ref 前面是本仓库统一的写法，而 Prettier 不重排属性。
      // 按 ESLint 的顺序来只会平白改掉 40 多处，读起来并不会更好。
      'vue/attributes-order': 'off',
    },
  },

  // TS 文件用 TS 版的 no-unused-vars（基规则不认识类型标注，会把类型里的参数名
  // 当成"未使用变量"误报 —— 渲染层的 lib/xterm.ts 就撞过这一条）
  {
    files: tsFiles,
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },

  // 必须放最后：关掉所有和 Prettier 冲突的格式类规则，格式化只由 Prettier 负责
  prettier,
];
