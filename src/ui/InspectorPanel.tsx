import { useMemo, useState } from 'react';
import { useDesktopStore } from '../store/desktopStore';
import type { ComponentNode, ToolNode } from '../kernel/types';
import { buildComponentPatchPrompt, stripFence } from '../kernel/agent/agentRuntime';
import { chatStream } from '../kernel/llm/client';
import { compileComponent } from '../host/compile';
import { PanelWindow } from './PanelWindow';

type Tab = 'tree' | 'log';

const KIND_LABEL: Record<string, string> = { agent: 'agent', component: 'comp', tool: 'tool' };

export function InspectorPanel() {
  const open = useDesktopStore((s) => s.treeOpen);
  const setOpen = useDesktopStore((s) => s.setTreeOpen);
  const [tab, setTab] = useState<Tab>('tree');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const nodes = useDesktopStore((s) => s.nodes);
  const rootId = useDesktopStore((s) => s.rootId);
  const focused = useDesktopStore((s) => s.focusedId);
  const logs = useDesktopStore((s) => s.logs);
  const clearLogs = useDesktopStore((s) => s.clearLogs);
  const focus = useDesktopStore((s) => s.focus);
  const removeNode = useDesktopStore((s) => s.removeNode);
  const updateNode = useDesktopStore((s) => s.updateNode);
  const log = useDesktopStore((s) => s.log);
  const settings = useDesktopStore((s) => s.settings);

  const tree = useMemo(() => {
    const lines: Array<{ node: (typeof nodes)[string]; depth: number }> = [];
    const seen = new Set<string>();
    const walk = (id: string, depth: number) => {
      const n = nodes[id];
      if (!n || seen.has(id)) return;
      seen.add(id);
      lines.push({ node: n, depth });
      for (const child of Object.values(nodes).filter((x) => x.parentId === id)) walk(child.id, depth + 1);
    };
    walk(rootId, 0);
    // 宿主已消失或未挂进树的节点也要能看见
    for (const n of Object.values(nodes)) {
      if (!seen.has(n.id)) lines.push({ node: n, depth: 0 });
    }
    return lines;
  }, [nodes, rootId]);

  if (!open) return null;

  const patchComponent = async (node: ComponentNode) => {
    const instruction = window.prompt('', '');
    if (!instruction) return;
    setBusy(true);
    try {
      const out = await chatStream(settings, buildComponentPatchPrompt(node, instruction));
      const source = stripFence(out);
      const check = compileComponent(node.id, source);
      if (!check.ok) {
        log('error', '✕ ' + check.error, node.id);
        return;
      }
      updateNode(node.id, { source });
      log('info', '✎ ' + node.id, node.id);
    } catch (e) {
      log('error', '✕ ' + (e as Error).message, node.id);
    } finally {
      setBusy(false);
    }
  };

  const cycleStatus = (node: ComponentNode) => {
    const next = node.status === 'active' ? 'minimized' : node.status === 'minimized' ? 'closed' : 'active';
    updateNode(node.id, { status: next });
  };

  return (
    <PanelWindow panel="inspector" title="Nodes" minW={280} minH={220} onClose={() => setOpen(false)}>
      <div className="ygg-panel-body">
        <div className="ygg-section">
          <div className="ygg-seg">
            <button className={tab === 'tree' ? 'on' : ''} onClick={() => setTab('tree')}>{tree.length}</button>
            <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>{logs.length}</button>
            {tab === 'log' ? <button onClick={clearLogs}>×</button> : null}
          </div>
        </div>

        {tab === 'tree' ? (
          <div className="ygg-section">
            {tree.map(({ node, depth }) => {
              const isAgent = node.kind === 'component' && !!node.agent;
              return (
                <div key={node.id}>
                  <div
                    className={'ygg-node-row' + (focused === node.id ? ' active' : '')}
                    style={{ marginLeft: depth * 10 }}
                    onClick={() => node.kind === 'component' && focus(node.id)}
                  >
                    <span className="kind">{KIND_LABEL[node.kind] ?? node.kind}</span>
                    <span className="name">{node.name}</span>
                    {isAgent ? <span className="kind" title="带 agent 能力">agent</span> : null}
                    {node.kind === 'component' || node.kind === 'tool' ? (
                      <button
                        className="ygg-winbtn"
                        title="源码"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpanded(expanded === node.id ? null : node.id);
                        }}
                      >
                        {'</>'}
                      </button>
                    ) : null}
                    {node.kind === 'component' ? (
                      <button
                        className="ygg-winbtn"
                        title="改版"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          void patchComponent(node);
                        }}
                      >
                        ✎
                      </button>
                    ) : null}
                    {node.kind === 'component' ? (
                      <button
                        className="ygg-winbtn"
                        title={'状态：' + node.status + '（点击切换 显示/最小化/关闭）'}
                        onClick={(e) => {
                          e.stopPropagation();
                          cycleStatus(node);
                        }}
                      >
                        {node.status === 'active' ? '◉' : node.status === 'minimized' ? '◌' : '○'}
                      </button>
                    ) : null}
                    <button
                      className="ygg-winbtn danger"
                      title="删除"
                      disabled={node.id === rootId}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeNode(node.id);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  {expanded === node.id && (node.kind === 'component' || node.kind === 'tool') ? (
                    <pre className="ygg-log ygg-code" style={{ marginLeft: depth * 10 + 10 }}>
                      {(node as ComponentNode | ToolNode).source}
                    </pre>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="ygg-section">
            <div className="ygg-log">
              {logs.length === 0 ? <div className="ygg-empty">—</div> : null}
              {logs.slice().reverse().map((l) => (
                <div key={l.id} className="ygg-log-line">
                  <span className={'lv ' + l.level}>{l.level}</span>
                  <span>{l.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </PanelWindow>
  );
}