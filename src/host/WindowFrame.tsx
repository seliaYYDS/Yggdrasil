import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Surface } from './Surface';
import { useDesktopStore } from '../store/desktopStore';

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
  children,
}: Props) {
  const [drag, setDrag] = useState<DragMode | null>(null);
  const origin = useRef({ x: 0, y: 0, px: 0, py: 0 });

  // 最小化由 store 统一驱动：先标记 leaving 播动画，260ms 后才真正变成 minimized。
  const leaving = useDesktopStore((s) => !!s.leaving[id]);
  const [lunge, setLunge] = useState<{ dx: number; dy: number } | null>(null);

  const move = useCallback((next: WindowRect) => onRect?.(next), [onRect]);

  /**
   * 收进任务栏的动画分两帧：先切到 .is-leaving（关掉入场动画、只留 transform/opacity 过渡），
   * 下一帧再给位移 —— 同一帧里改，过渡不一定被触发。
   * 终点取左下角任务栏的位置，于是窗口看起来是"缩着飞向任务栏"。
   */
  useEffect(() => {
    if (!leaving) {
      setLunge(null);
      return;
    }
    const raf = window.requestAnimationFrame(() => {
      setLunge({
        dx: TASKBAR_ANCHOR_X - (rect.x + rect.w / 2),
        dy: window.innerHeight - TASKBAR_ANCHOR_Y_FROM_BOTTOM - (rect.y + rect.h / 2),
      });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [leaving, rect.x, rect.y, rect.w, rect.h]);

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
      if ((e.target as HTMLElement).closest('.ygg-winbtn')) return;
      if ((e.target as HTMLElement).closest('.ygg-resize')) return;

      // 只有顶部条区域才触发拖动，避免在窗口内容里乱拖。
      const box = e.currentTarget.getBoundingClientRect();
      if (e.clientY - box.top > TITLEBAR_H) return;

      origin.current = { x: e.clientX, y: e.clientY, px: rect.x, py: rect.y };
      setDrag({ kind: 'move' });
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [onFocus, onRect, rect.x, rect.y],
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
      if (drag.kind === 'move') {
        move({
          ...rect,
          x: origin.current.px + (e.clientX - origin.current.x),
          y: Math.max(0, origin.current.py + (e.clientY - origin.current.y)),
        });
      } else {
        move({
          ...rect,
          w: Math.max(minW, drag.startW + (e.clientX - drag.startX)),
          h: Math.max(minH, drag.startH + (e.clientY - drag.startY)),
        });
      }
    };
    const onUp = () => setDrag(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [drag, minH, minW, move, rect]);

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
        (focused ? ' is-focused' : '') +
        (drag ? ' is-dragging' : '') +
        (minimized ? ' is-minimized' : '') +
        (leaving ? ' is-leaving' : '')
      }
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        zIndex,
        ...(minHeightCss ? { '--ygg-win-min-h': minHeightCss + 'px' } : {}),
        ...(tokens ?? {}),
        ...(lunge
          ? {
              transform:
                'translate(' + Math.round(lunge.dx) + 'px, ' + Math.round(lunge.dy) + 'px) scale(' + LEAVE_SCALE + ')',
              opacity: 0,
            }
          : {}),
      }}
      // 聚焦提升用 capture；拖动判定在同一个 handler 里做，
      // 两者都挂在容器上，不受插槽被替换的影响。
      onPointerDownCapture={onPointerDown}
      data-ygg-node={id}
    >
      {/*
        标题栏是插槽，Agent 可以换掉它的外观。
        但它承载的基础能力（拖动 / 最小化 / 删除）已经上移到容器层，
        所以即使被替换，窗口仍然可拖可操作。
      */}
      <Surface
        id="window.titlebar"
        props={{ title, kindLabel, actions, onMinimize, onDelete }}
        fallback={builtinTitlebar}
      />
      <div className="ygg-window-body">{children}</div>
      {resizable && onRect ? <div className="ygg-resize" onPointerDown={onPointerDownResize} /> : null}
    </div>
  );
}