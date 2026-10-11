import { useDesktopStore, PANEL_TITLES, ALL_PANELS } from '../store/desktopStore';

/** 左下角任务栏：收着被最小化 / 关闭的窗口与面板。 */
export function Taskbar() {
  const nodes = useDesktopStore((s) => s.nodes);
  const minimizedPanels = useDesktopStore((s) => s.minimizedPanels);
  const requestRestore = useDesktopStore((s) => s.requestRestore);
  const focus = useDesktopStore((s) => s.focus);

  // 基底不是窗口，不进任务栏。
  const stashed = Object.values(nodes).filter(
    (n) => n.kind === 'component' && !n.root && n.status !== 'active',
  );
  const panelKeys = ALL_PANELS.filter((k) => minimizedPanels[k]);

  if (stashed.length === 0 && panelKeys.length === 0) return null;

  return (
    <div className="ygg-taskbar">
      {panelKeys.map((k) => (
        <button
          key={k}
          className="ygg-task"
          title="恢复"
          onClick={() => requestRestore('panel-' + k)}
        >
          <span className="ygg-task-dot is-minimized" />
          {PANEL_TITLES[k]}
        </button>
      ))}
      {stashed.map((node) => (
        <button
          key={node.id}
          className="ygg-task"
          title={node.status === 'minimized' ? '恢复' : '重新打开'}
          onClick={() => {
            // 恢复也走 store：窗口从任务栏位置"长"回原位，再抬到最上层。
            requestRestore(node.id);
            focus(node.id);
          }}
        >
          <span className={'ygg-task-dot is-' + node.status} />
          {node.name}
        </button>
      ))}
    </div>
  );
}
