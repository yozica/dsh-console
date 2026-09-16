/**
 * Electron 的 `<webview>` 自定义元素：DOM 标准库里没有它的类型，
 * 而渲染层的 tsconfig 刻意不带 electron 的类型（那是主进程的东西）。
 *
 * 所以这里只声明**页面实际用到的**成员 —— 既让 ref/事件有类型，
 * 又不会把整个 Electron API 面拖进渲染层的类型空间。
 */
export interface WebviewElement extends HTMLElement {
  src: string
  /** 用 loadURL 而不是给 src 赋值：切换地址时上一笔导航被中止不会抛 ERR_ABORTED */
  loadURL(url: string): Promise<void>
  reload(): void
  canGoBack(): boolean
  goBack(): void
  getURL(): string
  executeJavaScript(code: string): Promise<string>
}

/** `<webview>` 的 did-fail-load 事件载荷（Electron 把详情挂在事件对象上） */
export interface WebviewFailLoadEvent extends Event {
  errorCode: number
  errorDescription: string
  validatedURL: string
}
