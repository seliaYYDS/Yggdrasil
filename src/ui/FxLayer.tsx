import { useDesktopStore } from '../store/desktopStore';
import type { FxCurve } from '../store/desktopStore';

/**
 * 派生连线层。
 *
 * 组件被创建 / 关闭时，从"发起它的那个输入框（或组件）"的中心，
 * 连一条 S 形曲线到它的中心 —— 让人看得出**这东西是从哪儿长出来的**，
 * 而不是凭空出现在桌面上。
 *
 * 几何用三次贝塞尔：控制点取在同一水平线上（左右各半个水平距离），
 * 于是曲线在中段自然扭转成 S 形，两端切线水平 —— 这是"从一个点流到另一个点"最顺的形状。
 */
function curvePath(c: FxCurve): string {
  const dx = c.toX - c.fromX;
  const c1x = c.fromX + dx * 0.5;
  const c2x = c.toX - dx * 0.5;
  return `M ${Math.round(c.fromX)} ${Math.round(c.fromY)} C ${Math.round(c1x)} ${Math.round(c.fromY)}, ${Math.round(c2x)} ${Math.round(c.toY)}, ${Math.round(c.toX)} ${Math.round(c.toY)}`;
}

/** 一条正在播的曲线（自带动画，到点由 store 移除）。 */
function Curve({ c }: { c: FxCurve }) {
  const path = curvePath(c);
  return (
    <>
      {/* 底下一层更粗更淡的，做出一点辉光感（不用 filter，保持扁平） */}
      <path className={'ygg-curve-halo is-' + c.kind} d={path} pathLength={1} />
      <path className={'ygg-curve is-' + c.kind} d={path} pathLength={1} />
      {/* 终点一个小圆点：让"落点"更明确 */}
      <circle className={'ygg-curve-dot is-' + c.kind} cx={c.toX} cy={c.toY} r={3} />
    </>
  );
}

export function FxLayer() {
  const curves = useDesktopStore((s) => s.curves);
  if (curves.length === 0) return null;
  // 曲线坐标就是桌面坐标，所以这一层铺满视口、直接按坐标画即可。
  return (
    <>
      {curves
        .filter((c) => c.layer === 'back')
        .map((c) => (
          <svg className="ygg-fx ygg-fx-back" key={c.id} aria-hidden>
            <Curve c={c} />
          </svg>
        ))}
      {curves
        .filter((c) => c.layer === 'front')
        .map((c) => (
          <svg className="ygg-fx ygg-fx-front" key={c.id} aria-hidden>
            <Curve c={c} />
          </svg>
        ))}
    </>
  );
}
