/**
 * 状态栏那一句话的唯一出口（`app.ts` 里接线，与 §7.31 的到达提示同一套做法）。
 *
 * t58 从 `EnvGate.vue` 提出来：向导的确认区拆成子组件之后，"复制"这类动作要说话的地方从一个
 * 变成两个，各写一遍 `dispatchEvent` 迟早会漂。
 */
export function say(message: string): void {
  window.dispatchEvent(new CustomEvent('dsh:status-message', { detail: message }));
}
