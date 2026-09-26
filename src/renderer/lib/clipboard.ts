/**
 * 复制到剪贴板 + 状态栏那句回话（t58 从 `EnvGate.vue` 提出来：向导的确认区与它拆出去的子组件
 * 都要用同一份，两处各写一遍迟早有一处忘了说话）。
 *
 * 失败**不抛**：剪贴板权限在真实环境里会被拒，界面只能说一句"请手动选中"，不该把一次点击
 * 变成一个未处理拒绝。
 */
import { say } from './status-message.js';

export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    say('已复制到剪贴板');
  } catch {
    say('复制失败，请手动选中这一行');
  }
}
