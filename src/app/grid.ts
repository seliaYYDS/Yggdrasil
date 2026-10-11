/**
 * 拖动时的网格吸附。
 *
 * 规则（用户指定的语义）：**吸附点是窗口中心**，不是左上角。
 * 所以窗口中心的 x / y 落在网格线上 —— 视觉上就是"窗口中心对准网格交点"。
 *
 * 这个文件只放纯计算，方便单测；网格图案画在哪、什么时候显示由 UI 决定。
 */

/** 网格边长（像素）。吸附点与背景网格共用这一个值，绝不能各写一份。 */
export const SNAP_GRID = 40;

export interface SnapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 把值吸到最近的网格线上。 */
export function snapValue(v: number): number {
  return Math.round(v / SNAP_GRID) * SNAP_GRID;
}

/**
 * 按"中心对齐网格"算出新的左上角。
 * y 不允许为负（标题栏拖出屏幕上方就再也抓不回来了）。
 */
export function snapCenterToGrid(rect: SnapRect): { x: number; y: number } {
  const cx = snapValue(rect.x + rect.w / 2);
  const cy = snapValue(rect.y + rect.h / 2);
  /*
   * 结果**不能四舍五入**：宽或高是奇数时，中心到左上角的距离是 .5，
   * round 之后中心就偏离网格线半个像素 —— 看着没对上，其实是我们自己算歪的。
   * 半像素的 left/top 浏览器渲染没问题。
   */
  return { x: cx - rect.w / 2, y: Math.max(0, cy - rect.h / 2) };
}

/** 窗口中心是否已经落在网格交点上（给单测与提示用）。 */
export function isCenteredOnGrid(rect: SnapRect): boolean {
  return snapValue(rect.x + rect.w / 2) === rect.x + rect.w / 2
    && snapValue(rect.y + rect.h / 2) === rect.y + rect.h / 2;
}
