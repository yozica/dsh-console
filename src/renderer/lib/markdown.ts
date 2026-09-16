/**
 * 极简、安全的 Markdown 渲染器（自包含，无第三方依赖）。
 *
 * 安全策略：先把整段输入做 HTML 转义，再在转义后的纯文本上做 Markdown 转换。
 * 这样即使 LLM 输出里夹带 <script>、<img onerror> 之类，也只会被显示成文本，
 * 绝不会被当 HTML 执行。渲染出的标签全部由本模块自己生成。
 *
 * 覆盖子集（LLM 输出最常见的那部分）：
 *   标题 #~######、粗体 **、斜体 *、删除线 ~~、行内代码 `、
 *   围栏代码块 ```、无序/有序列表、引用 >、表格 |、分隔线 ---、链接 [x](url)、段落。
 */

/** 只允许 http / https / mailto 的链接目标，其余一律丢弃（保留文字，去掉链接） */
function safeHref(url: unknown): string {
  const value = String(url || '').trim()
  return /^(https?:\/\/|mailto:)/i.test(value) ? value : ''
}

function escapeHtml(text: unknown): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 行内渲染：在已转义的文本上依次处理行内代码、链接/图片、删除线、粗体、斜体。
 * 行内代码与链接先用占位符取出，避免其内容被后面的粗斜体正则误伤。
 */
function renderInline(input: string): string {
  let text = input
  const tokens: string[] = []
  const stash = (html: string): string => {
    tokens.push(html)
    return `\u0000${tokens.length - 1}\u0000`
  }

  // 行内代码 `code`
  text = text.replace(/`([^`]+)`/g, (_match, code: string) => stash(`<code>${code}</code>`))

  // 图片 ![alt](url)：这里只保留替代文字（应用是文本向的，且 CSP 不加载外链图片）
  // 注意：整段文本已经先转义过，URL 里的括号用平衡匹配，避免维基百科式 (x) 链接留下多余括号
  const LINK_URL = '((?:[^()\\s]+|\\([^()\\s]*\\))+)'
  text = text.replace(new RegExp(`!\\[([^\\]]*)\\]\\(${LINK_URL}\\)`, 'g'), (_match, alt: string) =>
    stash(alt)
  )

  // 链接 [text](url)
  text = text.replace(
    new RegExp(`\\[([^\\]]+)\\]\\(${LINK_URL}\\)`, 'g'),
    (_match, label: string, url: string) => {
      const href = safeHref(url)
      if (!href) return stash(label)
      return stash(
        `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
      )
    }
  )

  // 删除线 ~~text~~
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>')

  // 粗体 **text**
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

  // 斜体 *text*（要求两侧不是空格，避免误伤乘法式）
  text = text.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>')

  // 恢复占位符
  return text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => tokens[Number(index)] ?? '')
}

/** 表格分隔行：每个单元格都是 --- / :--- / ---: 这类 */
function isTableSeparator(line: string): boolean {
  if (!line.startsWith('|')) return false
  const cells = splitTableRow(line)
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

function splitTableRow(line: string): string[] {
  let value = line.trim()
  if (value.startsWith('|')) value = value.slice(1)
  if (value.endsWith('|')) value = value.slice(0, -1)
  return value.split('|')
}

function renderTable(lines: string[]): string {
  const header = splitTableRow(lines[0]).map((cell) => cell.trim())
  const rows = lines.slice(1).map((line) => splitTableRow(line).map((cell) => cell.trim()))
  const head = header.map((cell) => `<th>${renderInline(cell)}</th>`).join('')
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
    .join('')
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

/** 一个块级起点的判定：段落收集遇到这些就停下 */
function isBlockStart(line: string): boolean {
  if (/^\u0001\d+\u0001$/.test(line)) return true // 代码块占位符
  if (/^#{1,6}\s+/.test(line)) return true
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) return true
  if (/^&gt;/.test(line)) return true // 引用（> 已被 HTML 转义为 &gt;）
  if (/^([-*+]\s+|\d+\.\s+)/.test(line)) return true
  if (line.startsWith('|')) return true // 表格
  return false
}

export function renderMarkdown(source: unknown): string {
  if (source == null) return ''
  const text = escapeHtml(String(source).replace(/\r\n?/g, '\n'))

  // 先抽出围栏代码块，内容整体转义后原样放进 <pre><code>
  const codeBlocks: string[] = []
  const withoutCode = text.replace(
    /```([^\n`]*)\n?([\s\S]*?)```/g,
    (_match, lang: string, code: string) => {
      const info = lang.trim()
      const label = info ? ` data-lang="${info}"` : ''
      codeBlocks.push(`<pre><code${label}>${code.trim()}</code></pre>`)
      return `\u0001${codeBlocks.length - 1}\u0001`
    }
  )

  const lines = withoutCode.split('\n')
  const blocks: string[] = []
  let index = 0

  while (index < lines.length) {
    const raw = lines[index]
    const line = raw.trim()

    if (line === '') {
      index++
      continue
    }

    // 代码块占位符独立成块
    if (/^\u0001\d+\u0001$/.test(line)) {
      blocks.push(line)
      index++
      continue
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      index++
      continue
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      blocks.push('<hr>')
      index++
      continue
    }

    // 引用（> 已被转义成 &gt;）
    if (line.startsWith('&gt;')) {
      const quote: string[] = []
      while (index < lines.length && lines[index].trim().startsWith('&gt;')) {
        quote.push(lines[index].trim().replace(/^&gt;\s?/, ''))
        index++
      }
      blocks.push(
        `<blockquote>${quote.map((item) => `<p>${renderInline(item)}</p>`).join('')}</blockquote>`
      )
      continue
    }

    // 表格：当前行是表头，下一行是分隔行
    if (
      line.startsWith('|') &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1].trim())
    ) {
      const tableLines = [line]
      index += 2 // 跳过表头与分隔行
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        tableLines.push(lines[index].trim())
        index++
      }
      blocks.push(renderTable(tableLines))
      continue
    }

    // 列表（无序 -/*/+ 与有序 N.）
    const listMatch = /^([-*+]\s+|\d+\.\s+)/.exec(line)
    if (listMatch) {
      const ordered = /^\d+\.\s+/.test(line)
      const items: string[] = []
      while (index < lines.length) {
        const current = lines[index].trim()
        const itemMatch = ordered ? /^\d+\.\s+(.*)$/.exec(current) : /^[-*+]\s+(.*)$/.exec(current)
        if (!itemMatch) break
        items.push(itemMatch[1])
        index++
      }
      const tag = ordered ? 'ol' : 'ul'
      blocks.push(
        `<${tag}>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`
      )
      continue
    }

    // 段落：收集到空行或下一个块级起点
    const paragraph = [line]
    index++
    while (
      index < lines.length &&
      lines[index].trim() !== '' &&
      !isBlockStart(lines[index].trim())
    ) {
      paragraph.push(lines[index].trim())
      index++
    }
    blocks.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`)
  }

  // 恢复代码块占位符
  return blocks
    .join('\n')
    .replace(/\u0001(\d+)\u0001/g, (_match, idx: string) => codeBlocks[Number(idx)] ?? '')
}
