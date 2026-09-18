/**
 * 自己实现的「滚到看得见」。
 *
 * 为什么不用原生 `scrollIntoView({ behavior: 'smooth' })`：它的时长与曲线都由浏览器定，
 * 不给调 —— 实测偏快，用户的原话是"还没看清就到了"。这里换成一条**固定时长**（由调用处给）
 * 的缓入缓出曲线：起步与收尾都慢、中间快，读起来像"被带过去"，而不是"跳过去"。
 *
 * 系统开了「减弱动效」时直接跳过去，不自己造动画 —— 那是用户的明确偏好。
 */

/** 缓入缓出（三次方）：t=0 与 t=1 处导数为 0 */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** 最近的、真能滚的祖先容器；都没有就返回 null（那时元素本来就在视野里） */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

/**
 * 把元素缓动滚到它所在容器的正中间（水平方向不动），动画结束兑现。
 * 已经居中、或者没有可滚容器时立刻兑现。
 */
export function scrollIntoViewEased(el: HTMLElement, durationMs: number): Promise<void> {
  const scroller = scrollParent(el);
  if (!scroller) return Promise.resolve();

  // 目标位置按"元素中心对齐容器中心"算，再夹到可滚范围内
  const elRect = el.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  const centered =
    scroller.scrollTop +
    (elRect.top + elRect.height / 2) -
    (scrollerRect.top + scrollerRect.height / 2);
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const to = Math.max(0, Math.min(max, centered));
  const from = scroller.scrollTop;
  const delta = to - from;

  if (Math.abs(delta) < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    scroller.scrollTop = to;
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const startedAt = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - startedAt) / durationMs);
      scroller.scrollTop = from + delta * easeInOutCubic(t);
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}
