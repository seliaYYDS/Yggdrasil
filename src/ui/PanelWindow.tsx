import type { ReactNode } from 'react';
import { WindowFrame } from '../host/WindowFrame';
import { useDesktopStore, PANEL_RECT_KEY, type PanelKey, type PanelRect } from '../store/desktopStore';

interface Props {
  panel: PanelKey;
  title: string;
  kindLabel?: string;
  minW?: number;
  minH?: number;
  resizable?: boolean;
  /** 关闭后的额外清理；**关闭动画与真正的关闭由 store.requestClose 负责**（✕ 不再直接调它）。 */
  onClose?: () => void;
  /** 覆盖窗口默认最小高度（默认 120px 对矮面板太高）。 */
  minHeightCss?: number;
  children: ReactNode;
}

/**
 * 把常驻 UI（输入框 / 检查器 / 设置 / 轨迹 / 对话）当作普通的可拖动窗口渲染。
 *
 * 层级与派生窗口共用一套：面板的 z 存在 store.panelZ 里，初始值很低（见 DEFAULT_PANEL_Z），
 * 所以新派生的组件会盖在面板上面；点一下面板就被 bringToFront 抬到最上层。
 * 面板之间也互相可比 —— 不再按 Z_OFFSET 常量固定顺序。
 */
export function PanelWindow({
  panel,
  title,
  kindLabel,
  minW,
  minH,
  resizable = true,
  minHeightCss,
  children,
}: Props) {
  const rect = useDesktopStore((s) => s[PANEL_RECT_KEY[panel]]) as PanelRect;
  const setPanelRect = useDesktopStore((s) => s.setPanelRect);
  const z = useDesktopStore((s) => s.panelZ[panel]);
  const focusedId = useDesktopStore((s) => s.focusedId);
  const bringToFront = useDesktopStore((s) => s.bringToFront);
  const minimized = useDesktopStore((s) => !!s.minimizedPanels[panel]);
  const requestMinimize = useDesktopStore((s) => s.requestMinimize);
  const requestClose = useDesktopStore((s) => s.requestClose);

  // 最小化后交给任务栏渲染，这里什么都不画。
  if (minimized) return null;

  const domId = 'panel-' + panel;

  return (
    <WindowFrame
      id={domId}
      title={title}
      kindLabel={kindLabel}
      rect={rect}
      minHeightCss={minHeightCss}
      zIndex={z}
      focused={focusedId === domId}
      onRect={(next) => setPanelRect(panel, next)}
      onFocus={() => bringToFront(domId)}
      // 交给 store：先播"收进任务栏"动画，动画结束才真正收起。
      onMinimize={() => requestMinimize(domId)}
      // 先播淡出再真正关闭（store 里收尾）；onClose 仍然保留给调用方做额外清理。
      onDelete={() => requestClose(domId)}
      minW={minW}
      minH={minH}
      resizable={resizable}
    >
      {children}
    </WindowFrame>
  );
}