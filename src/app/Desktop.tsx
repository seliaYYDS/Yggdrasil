import { useCallback, useEffect } from 'react';
import { useDesktopStore } from '../store/desktopStore';
import { WindowFrame } from '../host/WindowFrame';
import { ComponentHost } from '../host/ComponentHost';
import { ErrorBoundary } from './ErrorBoundary';
import { Surface } from '../host/Surface';
import { SNAP_GRID } from './grid';
import { Taskbar } from '../ui/Taskbar';
import { YggdrasilInput } from '../ui/YggdrasilInput';
import { InspectorPanel } from '../ui/InspectorPanel';
import { TracePanel } from '../ui/TracePanel';
import { SettingsPanel } from '../ui/SettingsPanel';
import type { ComponentNode } from '../kernel/types';

export function Desktop() {
  const nodes = useDesktopStore((s) => s.nodes);
  const focusedId = useDesktopStore((s) => s.focusedId);
  const focus = useDesktopStore((s) => s.focus);
  const updateNode = useDesktopStore((s) => s.updateNode);
  const removeNode = useDesktopStore((s) => s.removeNode);
  const requestMinimize = useDesktopStore((s) => s.requestMinimize);
  const sessions = useDesktopStore((s) => s.sessions);
  const log = useDesktopStore((s) => s.log);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const s = useDesktopStore.getState();
      if (s.settingsOpen) s.setSettingsOpen(false);
      else if (s.resetOpen) s.setResetOpen(false);
      else if (s.treeOpen) s.setTreeOpen(false);
      else if (s.traceOpen) s.setTraceOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /*
   * 运行时报错上报必须是**稳定引用**：ComponentHost 用了 memo，
   * 每次渲染都新建一个闭包会让比较永远失败，等于没 memo。
   * 所以这里传 id / name 作为参数，而不是为每个窗口各造一个箭头函数。
   */
  // 按住 Shift 拖动窗口时铺一层网格；网格尺寸与吸附点共用 SNAP_GRID，不会各写一份。
  const snapDrag = useDesktopStore((s) => s.snapDrag);

  const reportError = useCallback(
    (m: string, id: string, name: string) => log('error', 'comp ' + name + ' ✕ ' + m, id),
    [log],
  );

  const all = Object.values(nodes);
  // 基底 Agent 也是"带 agent 能力的组件"，但它不是窗口，不参与渲染。
  // 这里必须排除，否则它会被当成一个空组件窗口画出来。
  const visible = all.filter(
    (n): n is ComponentNode => n.kind === 'component' && !n.root && n.status === 'active',
  );

  return (
    <div className="ygg-desktop">
      <Surface
        id="desktop.background"
        props={{ nodeCount: visible.length }}
        fallback={<div className="ygg-desktop-bg" />}
      />

      {/*
        网格：只作为背景图案，层级夹在背景与窗口之间（z-index: 0）。
        用 SVG <pattern> 画线，不用渐变 —— 一是界面约束里禁掉了渐变，二是 SVG 线更锐利。
      */}
      {snapDrag ? (
        <div className="ygg-grid-overlay" aria-hidden>
          <svg width="100%" height="100%">
            <defs>
              <pattern id="ygg-snap-grid" width={SNAP_GRID} height={SNAP_GRID} patternUnits="userSpaceOnUse">
                <path
                  d={'M ' + SNAP_GRID + ' 0 L 0 0 0 ' + SNAP_GRID}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#ygg-snap-grid)" />
          </svg>
        </div>
      ) : null}

      {visible.map((node) => (
        <WindowFrame
          key={node.id}
          id={node.id}
          title={node.name}
          rect={{ x: node.pos.x, y: node.pos.y, w: node.size.w, h: node.size.h }}
          zIndex={node.z}
          focused={focusedId === node.id}
          tokens={node.tokens}
          onRect={(r) => updateNode(node.id, { pos: { x: r.x, y: r.y }, size: { w: r.w, h: r.h } })}
          onFocus={() => focus(node.id)}
          // 交给 store：先播"收进任务栏"动画，动画结束才真正变成 minimized。
          onMinimize={() => requestMinimize(node.id)}
          onDelete={() => removeNode(node.id)}
        >
          <ErrorBoundary onError={(m) => log('error', 'comp ' + node.name + ' ✕ ' + m, node.id)}>
            <ComponentHost node={node} onError={reportError} />
          </ErrorBoundary>
        </WindowFrame>
      ))}

      {/* 每个输入框是一个独立会话；面板与组件窗口同处一个层叠上下文，层级才可比 */}
      {sessions.map((ses) => (
        <YggdrasilInput key={ses.id} session={ses} />
      ))}
      <InspectorPanel />
      <TracePanel />
      <SettingsPanel />

      <Taskbar />
    </div>
  );
}