/**
 * 「更新完 dsh 要不要提示重启」的判据 —— 纯函数，喂字面量就能测（反例脚本 O9 组）。
 *
 * 为什么要有它：这条提示原来只由**会话内的一个布尔**在管（用户点过「先不用」就记成"别再问"，
 * 而打开任何更新入口时会把它复位）。真机上于是出现一个荒谬的结果 —— 用户更新完 dsh、**自己重启了
 * dsh**，之后只要再点一次「选择版本…」，那个布尔被复位，提示又冒出来说"新版本的 dsh 要重新启动
 * 之后才会生效"，而那次更新其实早就生效了。
 *
 * 正确的问法是**比事实**：现在跑着的那份 dsh，是这次更新之后才起来的吗？
 *
 *   - 是（`startedAt >= finishedAt`）→ 提示该消失；
 *   - 不是（更旧）→ 提示；
 *   - **任一时刻拿不到**（null）→ 也提示 —— 缺事实时不装作知道。宁可多问一句（代价是用户再点
 *     一次「先不用」），也不要谎报"已经生效了"。
 *
 * 注意这是**倒过来**的保守方向：事实越全越可能不提示，事实缺失反而提示。
 */
export function shouldAskRestartDsh(input: {
  /** 当前在跑的那份 dsh 是什么时候起来的（快照里的 `dsh.startedAt`）；没在跑 / 读不到时 null */
  startedAt: number | null;
  /** 这一次更新是什么时候跑完的（`EnvFixState.finishedAt`）；还没跑完时 null */
  finishedAt: number | null;
}): boolean {
  const { startedAt, finishedAt } = input;
  if (finishedAt === null) return true;
  if (startedAt === null) return true;
  return startedAt < finishedAt;
}
