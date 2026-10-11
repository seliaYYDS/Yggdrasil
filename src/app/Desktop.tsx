import { useEffect } from 'react';
import { useDesktopStore } from '../store/desktopStore';
import { WindowFrame } from '../host/WindowFrame';
import { ComponentHost } from '../host/ComponentHost';
import { ErrorBoundary } from './ErrorBoundary';
import { Surface } from '../host/Surface';
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
            <ComponentHost node={node} onError={(m) => log('error', 'comp ' + node.name + ' ✕ ' + m, node.id)} />
          </ErrorBoundary>
        </WindowFrame>
      ))}

      {/* 面板与组件窗口同处一个层叠上下文，层级才可比 */}
      <YggdrasilInput />
      <InspectorPanel />
      <TracePanel />
      <SettingsPanel />

      <Taskbar />
    </div>
  );
}