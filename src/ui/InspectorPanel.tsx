import { useMemo, useState } from 'react';
import { useDesktopStore, MAX_TRASH } from '../store/desktopStore';
import type { ComponentNode, ToolNode } from '../kernel/types';
import { buildComponentPatchPrompt, stripFence } from '../kernel/agent/agentRuntime';
import { chatStream } from '../kernel/llm/client';
import { compileComponent } from '../host/compile';
import { Surface } from '../host/Surface';
import { PanelWindow } from './PanelWindow';
import {
  ActiveIcon,
  ClearIcon,
  CloseIcon,
  ClosedIcon,
  CodeIcon,
  EditIcon,
  LockIcon,
  MinimizedIcon,
  PinIcon,
  UnlockIcon,
} from './icons';

const KIND_LABEL: Record<string, string> = { agent: 'agent', component: 'comp', tool: 'tool' };

/**
 * 节点检查器。
 * 这里只放节点树 —— 运行日志已经搬到 Trace 面板（见 §5.35），
 * 它和节点树本来就不是一回事。
 */
export function InspectorPanel() {
  const open = useDesktopStore((s) => s.treeOpen);
  const setOpen = useDesktopStore((s) => s.setTreeOpen);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 回收站展开 / 收起。默认收起：它是个兜底入口，不该占着面板（待办 6）。 */
  const [trashOpen, setTrashOpen] = useState(false);
  const trash = useDesktopStore((s) => s.trash);
  const restoreFromTrash = useDesktopStore((s) => s.restoreFromTrash);
  const purgeTrash = useDesktopStore((s) => s.purgeTrash);

  const nodes = useDesktopStore((s) => s.nodes);
  const rootId = useDesktopStore((s) => s.rootId);
  const focused = useDesktopStore((s) => s.focusedId);
  const focus = useDesktopStore((s) => s.focus);
  const removeNode = useDesktopStore((s) => s.removeNode);
  const updateNode = useDesktopStore((s) => s.updateNode);
  const requestMinimize = useDesktopStore((s) => s.requestMinimize);
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
      const out = (await chatStream(settings, buildComponentPatchPrompt(node, instruction))).text;
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
    // 切到最小化时走和标题栏一样的"收进任务栏"动画，不直接抹掉窗口。
    if (next === 'minimized') {
      requestMinimize(node.id);
      return;
    }
    updateNode(node.id, { status: next });
  };

  /*
   * 面板的**结构插槽**：Agent 可以用 replace_surface 覆写它（改完会弹一次确认，可还原结构）。
   * 内置内容作为 children 传下去 —— 想只改结构、不丢功能，就把 children 放进自己的布局里。
   */
  const builtin = (
    <>
      <div className="ygg-panel-body">
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
                  {node.kind === 'component' && node.frame === 'widget' ? (
                    <span className="kind" title="挂件：无标题栏，用右下角按钮操控">挂件</span>
                  ) : null}
                  {node.kind === 'component' && node.locked ? (
                    <span className="kind" title="已锁定：不可删除">已锁</span>
                  ) : null}
                  {node.kind === 'component' || node.kind === 'tool' ? (
                    <button
                      className="ygg-winbtn"
                      title="源码"
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpanded(expanded === node.id ? null : node.id);
                      }}
                    >
                      <CodeIcon width={13} height={13} />
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
                      <EditIcon width={13} height={13} />
                    </button>
                  ) : null}
                  {node.kind === 'component' ? (
                    <button
                      className="ygg-winbtn"
                      title={'状态：' + node.status + '（点击切换）'}
                      onClick={(e) => {
                        e.stopPropagation();
                        cycleStatus(node);
                      }}
                    >
                      {node.status === 'active' ? (
                        <ActiveIcon width={13} height={13} />
                      ) : node.status === 'minimized' ? (
                        <MinimizedIcon width={13} height={13} />
                      ) : (
                        <ClosedIcon width={13} height={13} />
                      )}
                    </button>
                  ) : null}
                  {/* 固定：只有挂件才有意义（普通窗口本来就能随时拖）。固定后 hover 不再出操控按钮。 */}
                  {node.kind === 'component' && node.frame === 'widget' ? (
                    <button
                      className={'ygg-winbtn' + (node.fixed ? ' is-active' : '')}
                      title={
                        node.fixed
                          ? '已固定（点击取消）'
                          : '固定'
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        updateNode(node.id, { fixed: !node.fixed });
                      }}
                    >
                      <PinIcon width={13} height={13} />
                    </button>
                  ) : null}
                  {/* 锁定：所有组件都有。锁定后不可删除（用户与 Agent 都删不掉）。 */}
                  {node.kind === 'component' ? (
                    <button
                      className={'ygg-winbtn' + (node.locked ? ' is-active' : '')}
                      title={node.locked ? '已锁定：不可删除（点击解锁）' : '锁定：不可删除'}
                      onClick={(e) => {
                        e.stopPropagation();
                        updateNode(node.id, { locked: !node.locked });
                      }}
                    >
                      {node.locked ? (
                        <LockIcon width={13} height={13} />
                      ) : (
                        <UnlockIcon width={13} height={13} />
                      )}
                    </button>
                  ) : null}
                  <button
                    className="ygg-winbtn danger"
                    title={node.kind === 'component' && node.locked ? '已锁定，先解锁才能删除' : '删除'}
                    disabled={node.id === rootId || (node.kind === 'component' && node.locked === true)}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeNode(node.id);
                    }}
                  >
                    <CloseIcon width={13} height={13} />
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
        {/*
          回收站：**固定在面板右下角**（绝对定位，不参与节点树的流）。
          删除的组件在这里暂存，可还原或彻底清除；只存当前会话，刷新即清空。
          平时收起成一个图标，有内容时带一个数量，点开才列出来。
        */}
        <div className={'ygg-trash' + (trashOpen ? ' is-open' : '')}>
          {trashOpen ? (
            <div className="ygg-trash-list">
              <div className="ygg-trash-head">
                <span>回收站 {trash.length}/{MAX_TRASH}</span>
                {trash.length > 0 ? (
                  <button className="ygg-btn ghost tiny" title="彻底清除全部" onClick={() => purgeTrash()}>清空</button>
                ) : null}
              </div>
              {trash.length === 0 ? (
                <div className="ygg-trash-empty">被删除的组件会暂存在这里，刷新页面即清空。</div>
              ) : null}
              {trash.slice().reverse().map((t) => (
                <div className="ygg-trash-row" key={t.rootId}>
                  <span className="name" title={t.name}>{t.name}</span>
                  <span className="when">{new Date(t.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                  <button className="ygg-btn ghost tiny" title="还原到桌面" onClick={() => restoreFromTrash(t.rootId)}>还原</button>
                  <button className="ygg-btn tiny danger" title="彻底清除，不可恢复" onClick={() => purgeTrash(t.rootId)}>清除</button>
                </div>
              ))}
            </div>
          ) : null}
          <button
            className="ygg-trash-btn"
            title={trash.length > 0 ? '回收站：' + trash.length + ' 个已删除的组件' : '回收站（空）'}
            onClick={() => setTrashOpen(!trashOpen)}
          >
            <ClearIcon width={14} height={14} />
            {trash.length > 0 ? <span className="badge">{trash.length}</span> : null}
          </button>
        </div>
      </div>
    </>
  );
  return (
    <PanelWindow panel="inspector" title="Nodes" minW={280} minH={220} onClose={() => setOpen(false)}>
      <Surface
        id="panel.inspector"
        props={{ panel: 'inspector', title: 'Nodes', close: () => setOpen(false), children: builtin }}
        fallback={builtin}
      />
    </PanelWindow>
  );
}
