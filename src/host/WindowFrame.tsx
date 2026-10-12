import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Surface } from './Surface';
import { useDesktopStore } from '../store/desktopStore';
import { snapCenterToGrid } from '../app/grid';

/** 任务栏锚点：左下角。窗口最小化时朝这里缩小并位移，"收进"任务栏。 */
const TASKBAR_ANCHOR_X = 26;
const TASKBAR_ANCHOR_Y_FROM_BOTTOM = 30;
/** 收进任务栏时缩到的比例。 */
const LEAVE_SCALE = 0.06;

export interface WindowRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameAction {
  label: string;
  title?: string;
  danger?: boolean;
  active?: boolean;
  onClick: () => void;
}

interface Props {
  id: string;
  title: string;
  kindLabel?: string;
  rect: WindowRect;
  zIndex: number;
  focused?: boolean;
  minimized?: boolean;
  onRect?: (rect: WindowRect) => void;
  onFocus?: () => void;
  actions?: FrameAction[];
  onMinimize?: () => void;
  onDelete?: () => void;
  minW?: number;
  minH?: number;
  resizable?: boolean;
  /** 覆盖 CSS 里的窗口默认最小高度（矮面板需要）。 */
  minHeightCss?: number;
  tokens?: Record<string, string>;
  /**
   * 窗口形态。
   * `'widget'` = 挂件：不画标题栏、根容器透明无边框、**不能被直接拖动** ——
   * 只能按住 hover 出来的"移动 / 缩放"按钮来改。
   */
  frame?: 'window' | 'widget';
  /** 挂件固定后连操控按钮都不显示（也就动不了）。 */
  fixed?: boolean;
  children: ReactNode;
}

type DragMode =
  | { kind: 'move' }
  | { kind: 'resize'; startW: number; startH: number; startX: number; startY: number };

export function WindowFrame({
  id,
  title,
  kindLabel,
  rect,
  zIndex,
  focused,
  minimized,
  onRect,
  onFocus,
  actions,
  onMinimize,
  onDelete,
  minW = 200,
  minH = 120,
  resizable = true,
  minHeightCss,
  tokens,
  frame,
  fixed,
  children,
}: Props) {
  const isWidget = frame === 'widget';
  /** 挂件固定后连操控按钮都不出，避免误碰。 */
  const pinned = isWidget && fixed === true;
  const [drag, setDrag] = useState<DragMode | null>(null);
  const origin = useRef({ x: 0, y: 0, px: 0, py: 0 });
  /** 拖动中是否按着 Shift（= 网格吸附）。用 ref 记，pointermove 里比对，避免反复写 store。 */
  const snapRef = useRef(false);
  const setSnapDrag = useDesktopStore((s) => s.setSnapDrag);

  // 最小化 / 恢复都由 store 驱动：先标记 leaving（或 restoring），动画播完才真正收放。
  const leaving = useDesktopStore((s) => !!s.leaving[id]);
  const restoring = useDesktopStore((s) => !!s.restoring[id]);
  const [lunge, setLunge] = useState(false);
  /** 挂载那一刻决定：从任务栏展开的窗口不再播入场动画，改播"长回原位"。 */
  const [fromTaskbar] = useState(restoring);
  const [settled, setSettled] = useState(!restoring);

  const move = useCallback((next: WindowRect) => onRect?.(next), [onRect]);

  /**
   * 动画分两帧：先切类（关掉入场动画、只留 transform/opacity 过渡），下一帧再给位移 ——
   * 同一帧里改，过渡不一定被触发。
   * 起点 / 终点都是左下角任务栏：收进去时从原位缩向它，展开时从它长回原位。
   */
  useEffect(() => {
    if (!leaving) {
      setLunge(false);
      return;
    }
    const raf = window.requestAnimationFrame(() => setLunge(true));
    return () => window.cancelAnimationFrame(raf);
  }, [leaving, rect.x, rect.y, rect.w, rect.h]);

  useEffect(() => {
    if (!restoring) {
      setSettled(true);
      return;
    }
    const raf = window.requestAnimationFrame(() => setSettled(true));
    return () => window.cancelAnimationFrame(raf);
  }, [restoring]);

  /** 窗口中心指向任务栏锚点的位移 + 缩到很小。收进去与展开共用同一段换算。 */
  const flyToTaskbar =
    'translate(' +
    Math.round(TASKBAR_ANCHOR_X - (rect.x + rect.w / 2)) + 'px, ' +
    Math.round(window.innerHeight - TASKBAR_ANCHOR_Y_FROM_BOTTOM - (rect.y + rect.h / 2)) + 'px) scale(' +
    LEAVE_SCALE + ')';
  const flying = lunge || !settled;

  /**
   * 按下窗口顶部区域开始拖动。
   *
   * 关键点：这个处理器挂在**窗口容器**上，而不是挂在可被 Agent 替换的
   * window.titlebar 插槽上。否则一旦 Agent 换掉标题栏，所有窗口就都拖不动了
   * （曾经真的发生过）。
   * 判定方式：按下点位于窗口顶部 titlebar 高度以内，且不在按钮上。
   */
  const TITLEBAR_H = 30;

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      onFocus?.();
      if (!onRect) return;
      /*
       * 挂件**不能被直接拖**：点它只提升层级（也算"我在操作它了"）。
       * 要挪位置得按住右下角那个"移动"按钮 —— 见 startGrip。
       */
      if (isWidget) return;
      if ((e.target as HTMLElement).closest('.ygg-winbtn')) return;
      if ((e.target as HTMLElement).closest('.ygg-resize')) return;

      // 只有顶部条区域才触发拖动，避免在窗口内容里乱拖。
      const box = e.currentTarget.getBoundingClientRect();
      if (e.clientY - box.top > TITLEBAR_H) return;

      origin.current = { x: e.clientX, y: e.clientY, px: rect.x, py: rect.y };
      setDrag({ kind: 'move' });
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [isWidget, onFocus, onRect, rect.x, rect.y],
  );

  /**
   * 挂件右下角那三个按钮里的"移动 / 缩放"其实是**把手**：
   * 按下去（并按住）才开始拖动 / 缩放，松手即结束 —— 复用上面同一个 pointermove 循环，
   * 所以网格吸附、视口夹取这些行为跟普通窗口完全一致。
   */
  const startGrip = useCallback(
    (kind: 'move' | 'resize') => (e: React.PointerEvent<HTMLElement>) => {
      if (!onRect || pinned) return;
      if (kind === 'resize' && !resizable) return;
      // 别让这次按下被容器当成普通点击（挂件不拖，但普通窗口的标题栏判定也要跳过）。
      e.preventDefault();
      e.stopPropagation();
      if (kind === 'move') {
        origin.current = { x: e.clientX, y: e.clientY, px: rect.x, py: rect.y };
        setDrag({ kind: 'move' });
      } else {
        setDrag({ kind: 'resize', startW: rect.w, startH: rect.h, startX: e.clientX, startY: e.clientY });
      }
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [onRect, pinned, resizable, rect.x, rect.y, rect.w, rect.h],
  );

  const onPointerDownResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!onRect || !resizable) return;
      e.stopPropagation();
      setDrag({ kind: 'resize', startW: rect.w, startH: rect.h, startX: e.clientX, startY: e.clientY });
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [onRect, resizable, rect.h, rect.w],
  );

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      /*
       * 按住 Shift 拖动 = 网格吸附。
       *
       * 直接在 pointermove 上读 e.shiftKey：这样拖动**中途**按下或松开 Shift 都会立刻生效，
       * 不需要额外监听键盘事件，也不怕焦点跑掉。
       * 吸附点是**窗口中心**（见 app/grid.ts），所以窗口中心会落在网格交点上。
       */
      if (drag.kind === 'move' && e.shiftKey !== snapRef.current) {
        snapRef.current = e.shiftKey;
        setSnapDrag(e.shiftKey);
      }
      if (drag.kind === 'move') {
        const next = {
          ...rect,
          x: origin.current.px + (e.clientX - origin.current.x),
          y: Math.max(0, origin.current.py + (e.clientY - origin.current.y)),
        };
        const snapped = e.shiftKey ? snapCenterToGrid(next) : { x: next.x, y: next.y };
        move({ ...next, x: snapped.x, y: snapped.y });
      } else {
        move({
          ...rect,
          w: Math.max(minW, drag.startW + (e.clientX - drag.startX)),
          h: Math.max(minH, drag.startH + (e.clientY - drag.startY)),
        });
      }
    };
    const onUp = () => {
      setDrag(null);
      // 结束拖动一定收起网格：中途松开 Shift 而指针没再动过的情况也得清掉。
      if (snapRef.current) {
        snapRef.current = false;
        setSnapDrag(false);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [drag, minH, minW, move, rect, setSnapDrag]);

  const builtinTitlebar = (
    <div className="ygg-titlebar" data-ygg-drag={onRect ? '1' : '0'}>
      <span className="ygg-title-text">{title}</span>
      {kindLabel ? <span className="ygg-title-kind">{kindLabel}</span> : null}
      <span className="ygg-title-spacer" />
      {actions?.map((a) => (
        <button
          key={a.label}
          className={'ygg-winbtn' + (a.danger ? ' danger' : '') + (a.active ? ' is-active' : '')}
          title={a.title}
          onClick={() => a.onClick()}
        >
          {a.label}
        </button>
      ))}
      {onMinimize ? (
        <button className="ygg-winbtn" title="最小化" onClick={onMinimize}>–</button>
      ) : null}
      {onDelete ? (
        <button className="ygg-winbtn danger" title="删除" onClick={onDelete}>✕</button>
      ) : null}
    </div>
  );

  return (
    <div
      className={
        'ygg-window' +
        (isWidget ? ' is-widget' : '') +
        (pinned ? ' is-fixed' : '') +
        (focused ? ' is-focused' : '') +
        (drag ? ' is-dragging' : '') +
        (minimized ? ' is-minimized' : '') +
        (leaving ? ' is-leaving' : '') +
        // 从任务栏展开的窗口整个生命周期都不播入场动画，避免动画结束后又被它顶一下。
        (fromTaskbar ? ' is-restoring' : '')
      }
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        zIndex,
        ...(minHeightCss ? { '--ygg-win-min-h': minHeightCss + 'px' } : {}),
        ...(tokens ?? {}),
        ...(flying ? { transform: flyToTaskbar, opacity: 0 } : {}),
      }}
      // 聚焦提升用 capture；拖动判定在同一个 handler 里做，
      // 两者都挂在容器上，不受插槽被替换的影响。
      onPointerDownCapture={onPointerDown}
      data-ygg-node={id}
    >
      {/*
        挂件**不画标题栏**（也不占它的高度）：它就是一整块内容。
        普通窗口的标题栏是插槽，Agent 可以换掉它的外观；
        但它承载的基础能力（拖动 / 最小化 / 删除）已经上移到容器层，所以即使被替换也可拖可操作。
      */}
      {isWidget ? null : (
        <Surface
          id="window.titlebar"
          props={{ title, kindLabel, actions, onMinimize, onDelete }}
          fallback={builtinTitlebar}
        />
      )}
      <div className="ygg-window-body">{children}</div>
      {/*
        挂件的操控：hover 时右下角浮出三个按钮。
        前两个是**把手**（按住才生效），第三个是普通点击。
        固定之后整个不渲染 —— 用户"固定"的意思就是别再来烦我。
      */}
      {isWidget && !pinned ? (
        <div className="ygg-widget-controls">
          <button
            className="ygg-widget-btn"
            title="按住拖动可缩放"
            onPointerDown={startGrip('resize')}
          >
            ⤡
          </button>
          <button className="ygg-widget-btn" title="按住拖动可移动" onPointerDown={startGrip('move')}>
            ✥
          </button>
          {onDelete ? (
            <button className="ygg-widget-btn danger" title="关闭（删除）" onClick={onDelete}>
              ✕
            </button>
          ) : null}
        </div>
      ) : null}
      {/* 挂件不给右下角那个缩放手柄 —— 它已经有"缩放"按钮了，两个手柄只会打架。 */}
      {!isWidget && resizable && onRect ? (
        <div className="ygg-resize" onPointerDown={onPointerDownResize} />
      ) : null}
    </div>
  );
}