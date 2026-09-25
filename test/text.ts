'use strict';

/**
 * 从源码文本里切片段的小工具 —— 自检里"读源码文本"的那批断言全靠它们。
 *
 * 原来长在 `test/selftest.ts` 的 §16 里，但环境自检、环境向导、安装引擎三组都在用，
 * 所以提成独立一份。都是纯函数（不碰文件系统）。
 */

/** 按大括号配平切出一段代码块（给定锚点，取它后面的第一个 `{`） */
export function blockOf(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  if (start < 0) return '';
  const open = source.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return '';
}

/** `export function xxx(` 那个函数体（类方法 / 局部函数用 blockOf） */
export function functionBodyOf(source: string, name: string): string {
  return blockOf(source, `export function ${name}(`);
}

/**
 * 类方法整段（含签名）：按**下一个类成员**为界切。
 *
 * 为什么不复用 `blockOf`：它从锚点之后第一个 `{` 起的配对花括号，而带返回类型注解的方法
 * （`): Promise<{ kind: ... }> {`）第一个 `{` 落在**类型里**，切出来只有类型那一小段。
 */
export function methodSliceOf(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  if (start < 0) return '';
  const rest = source.slice(start + anchor.length);
  const next = /\n {2}(?:private|public|static|readonly|async|[a-zA-Z]+\()/.exec(rest);
  return rest.slice(0, next ? next.index : rest.length);
}

export function stripComments(text: string): string {
  return text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 只留代码、去掉字符串字面量的内容：judgeEnvironment 的 detail 是**给人看的人话**，
 * 里面会提到 `spawn("pnpm")` 这类实现细节（那恰恰是用户要看到的原因），
 * 但"提到"不等于"做了"。模板串里的 `${…}` 是代码，保留下来（别把 IO 一起藏掉）。
 */
export function stripStrings(text: string): string {
  return text.replace(/(['"`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, (whole: string, quote: string) => {
    if (quote !== '`') return `${quote}${quote}`;
    const exprs = [...whole.matchAll(/\$\{([\s\S]*?)\}/g)].map((match) => match[1]);
    return `\`${exprs.join(' ; ')}\``;
  });
}
