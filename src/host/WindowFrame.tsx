import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Surface } from './Surface';
import { clampWidgetPos, useDesktopStore, widgetControlsOffset } from '../store/desktopStore';
import { snapCenterToGrid } from '../app/grid';
import { CloseIcon, MoveIcon, ScaleIcon } from '../ui/icons';

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
  /**
   * 整窗的拖放（输入框用它做"拖文件进来上传"）。
   *
   * 为什么放在窗口层而不是输入行上：用户拖文件过来是希望"扔进这个窗口"，
   * 不会精确瞄准那一行文字；落点太小就会出现"我明明拖进来了却没反应"。
   * 只有显式传了它的窗口才接拖放，别的窗口不受影响。
   */
  onDropFiles?: (files: File[]) => void;
  /** 初始引导的锚点（渲染成 data-ygg-intro）。只有输入框窗口会传。 */
  introTag?: string;
  /** 正在播"被收走"的淡出动画：淡出结束后才真正删除。 */
  dying?: boolean;
  /**
   * 刚派生出来：入场动画更慢、带一点延迟，让派生连线先到。
   *
   * **只影响挂载那一刻**（之后由内部的 entrance 状态接管）—— 调用方现算这个值不会
   * 造成动画重播，但也别指望中途改它能换动画。
   */
  newborn?: boolean;
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
  dying,
  newborn,
  children,
  onDropFiles,
  introTag,
}: Props) {
  const isWidget = frame === 'widget';
  /** 挂件固定后连操控按钮都不出，避免误碰。 */
  const pinned = isWidget && fixed === true;
  /** 有文件正拖在这个窗口上方（用一圈高亮让"松手会落在这里"看得出来）。 */
  const [dropping, setDropping] = useState(false);
  const [drag, setDrag] = useState<DragMode | null>(null);
  const origin = useRef({ x: 0, y: 0, px: 0, py: 0 });
  /** 拖动中是否按着 Shift（= 网格吸附）。用 ref 记，pointermove 里比对，避免反复写 store。 */
  const snapRef = useRef(false);
  const setSnapDrag = useDesktopStore((s) => s.setSnapDrag);
  // 挂件的控制面板要按视口算落点，位置夹取也要用它。
  const viewW = useDesktopStore((s) => s.viewW);
  const viewH = useDesktopStore((s) => s.viewH);

  // 最小化 / 恢复都由 store 驱动：先标记 leaving（或 restoring），动画播完才真正收放。
  const leaving = useDesktopStore((s) => !!s.leaving[id]);
  const restoring = useDesktopStore((s) => !!s.restoring[id]);
  // 关闭淡出：面板与输入框由 store.requestClose 标记，组件由 removeNode 标记 ——
  // 统一在这里读，调用方不用各自传一遍。
  const dyingNow = useDesktopStore((s) => !!s.dying[id]);
  const setResizing = useDesktopStore((s) => s.setResizing);
  const [lunge, setLunge] = useState(false);
  /** 挂载那一刻决定：从任务栏展开的窗口不再播入场动画，改播"长回原位"。 */
  const [fromTaskbar] = useState(restoring);
  const [settled, setSettled] = useState(!restoring);
  /*
   * **入场动画的种类在挂载那一刻定下来，之后一辈子不变。**
   *
   * 为什么要"定下来"而不是每次渲染现算：动画只要 animation-name 变了，浏览器就会
   * 从头重播。而 newborn 原来是按时间算的（Date.now() - createdAt < 1500），
   * 于是**用户第一次点这个窗口**时——点击会触发聚焦、聚焦会触发重渲染——它刚好跨过
   * 1.5 秒变成 false，is-newborn 被摘掉，animation 退回基类的 ygg-window-in，
   * 完整的淡入就重播了一次。用户看到的就是"点一下，窗口闪一下"。
   *
   * 三种取值：
   * - 'born'：刚派生出来的（曲线的动画先走 260ms，组件再浮现）
   * - 'in'  ：普通新建
   * - 'none'：从任务栏展开的 —— 它要播的是"长回原位"，不该再叠一个入场
   */
  const [entrance] = useState<'born' | 'in' | 'none'>(() =>
    restoring ? 'none' : newborn ? 'born' : 'in',
  );

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
        setResizing(true);
      }
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [onRect, pinned, resizable, rect.x, rect.y, rect.w, rect.h, setResizing],
  );

  const onPointerDownResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!onRect || !resizable) return;
      e.stopPropagation();
      setDrag({ kind: 'resize', startW: rect.w, startH: rect.h, startX: e.clientX, startY: e.clientY });
      setResizing(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [onRect, resizable, rect.h, rect.w, setResizing],
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
        const placed = { ...next, x: snapped.x, y: snapped.y };
        /*
         * 挂件额外夹一次：保证右下角那块控制面板还留在视口里。
         * 普通窗口不用夹 —— 它的标题栏就是把手，而挂件的把手就在那一小块上。
         */
        move(isWidget ? clampWidgetPos(placed, viewW, viewH) : placed);
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
      // 松手后自动高度才能重新工作（此时用户尺寸已经生效，见 YggdrasilInput 的 userSized）。
      if (drag.kind === 'resize') setResizing(false);
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
  }, [drag, isWidget, minH, minW, move, rect, setSnapDrag, setResizing, viewW, viewH]);

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
        // 入场类由挂载时定下的 entrance 决定，**不会**随重渲染变化（见上面的说明）。
        (entrance === 'born' ? ' is-newborn' : entrance === 'in' ? ' is-entering' : '') +
        (dying || dyingNow ? ' is-dying' : '') +
        (pinned ? ' is-fixed' : '') +
        (focused ? ' is-focused' : '') +
        (drag ? ' is-dragging' : '') +
        (minimized ? ' is-minimized' : '') +
        (leaving ? ' is-leaving' : '') +
        // 从任务栏展开的窗口整个生命周期都不播入场动画，避免动画结束后又被它顶一下。
        (fromTaskbar ? ' is-restoring' : '') +
        (dropping ? ' is-dropping' : '')
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
      /*
       * 拖放（输入框用它做"拖文件进来上传"）。
       * - dragenter / dragover 都要 preventDefault：默认行为是不接受拖放，不拦就没有 drop。
       * - 只认真的带文件的拖动（拖窗口等内部拖动不该点亮）。
       * - drop 时 stopPropagation，避免和别的落点打架。
       */
      onDragEnter={
        onDropFiles
          ? (e) => {
              if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
              e.preventDefault();
              setDropping(true);
            }
          : undefined
      }
      onDragOver={
        onDropFiles
          ? (e) => {
              if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
              e.preventDefault();
              if (!dropping) setDropping(true);
            }
          : undefined
      }
      onDragLeave={
        onDropFiles
          ? (e) => {
              // 移到子元素上也会触发 leave：用 relatedTarget 是否还在窗口内来区分。
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setDropping(false);
            }
          : undefined
      }
      onDrop={
        onDropFiles
          ? (e) => {
              if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
              e.preventDefault();
              e.stopPropagation();
              setDropping(false);
              const list = Array.from(e.dataTransfer?.files ?? []);
              if (list.length > 0) onDropFiles(list);
            }
          : undefined
      }
      onPointerDownCapture={onPointerDown}
      data-ygg-node={id}
      // 初始引导用的锚点（只有输入框会传）。
      {...(introTag ? { 'data-ygg-intro': introTag } : {})}
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
      {/*
        挂件拖动 / 缩放时的**尺寸提示框**。
        挂件没有标题栏、背景也常常是全透明的（状态灯、计数器、纯装饰），
        光看内容看不出它有多大、边界在哪 —— 拖一个看不见边的东西很难受。
        所以按住把手期间补一圈白框：框就是窗口的实际外框，所见即所得。
      */}
      {isWidget && drag ? <div className="ygg-widget-size-frame" /> : null}
      {isWidget && !pinned ? (
        <div
          className="ygg-widget-controls"
          /*
           * 控制面板默认贴窗口右下角；窗口右下角出界时自动往回挪到可见处 ——
           * 否则挂件被拖出屏幕后那三个按钮也跟着出界，就再也点不到、要不回来了。
           */
          style={widgetControlsOffset(rect, viewW, viewH)}
        >
          <button
            className="ygg-widget-btn"
            title="按住拖动可缩放"
            onPointerDown={startGrip('resize')}
          >
            <ScaleIcon width={12} height={12} />
          </button>
          <button className="ygg-widget-btn" title="按住拖动可移动" onPointerDown={startGrip('move')}>
            <MoveIcon width={12} height={12} />
          </button>
          {onDelete ? (
            <button className="ygg-widget-btn danger" title="关闭（删除）" onClick={onDelete}>
              <CloseIcon width={12} height={12} />
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