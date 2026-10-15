import { useDesktopStore, PANEL_TITLES, ALL_PANELS } from '../store/desktopStore';
import { useMemo } from 'react';
import { pluginPageKey, pluginPageWindowId, pluginPages } from '../kernel/plugin/runtime';

/** 左下角任务栏：收着被最小化 / 关闭的窗口、面板与输入框。 */
export function Taskbar() {
  const nodes = useDesktopStore((s) => s.nodes);
  const minimizedPanels = useDesktopStore((s) => s.minimizedPanels);
  const requestRestore = useDesktopStore((s) => s.requestRestore);
  const focus = useDesktopStore((s) => s.focus);
  const sessions = useDesktopStore((s) => s.sessions);

  // 基底不是窗口，不进任务栏。
  const stashed = Object.values(nodes).filter(
    (n) => n.kind === 'component' && !n.root && n.status !== 'active',
  );
  const panelKeys = ALL_PANELS.filter((k) => minimizedPanels[k]);
  /*
   * 插件页面也收进任务栏。它们**不在** ALL_PANELS 里（那是固定的五个内置面板），
   * 所以单独筛一遍 —— 标题从插件清单取，卸载后自然就不出现了。
   */
  // 同 TopBar：订阅 plugins 才能在两装/卸后重算（pluginPages 不是响应式的）。
  const plugins = useDesktopStore((s) => s.plugins);
  const pageKeys = useMemo(
    () => pluginPages().filter((h) => minimizedPanels['page:' + pluginPageKey(h.plugin.id, h.page.id)]),
    [plugins, minimizedPanels],
  );
  const stashedSessions = sessions.filter((s) => s.minimized);

  if (stashed.length === 0 && panelKeys.length === 0 && pageKeys.length === 0 && stashedSessions.length === 0) return null;

  return (
    <div className="ygg-taskbar">
      {stashedSessions.map((ses) => (
        <button
          key={ses.id}
          className="ygg-task is-session"
          title={ses.queue.length > 0 ? '恢复（' + ses.queue.length + ' 条排队）' : '恢复'}
          onClick={() => {
            requestRestore(ses.id);
            focus(ses.id);
          }}
        >
          <span className="ygg-task-dot is-minimized" />
          {ses.title}
        </button>
      ))}
      {panelKeys.map((k) => (
        <button
          key={k}
          className="ygg-task"
          title="恢复"
          onClick={() => {
            // 与下面两类条目一致：恢复也把它抬到最上层。
            requestRestore('panel-' + k);
            focus('panel-' + k);
          }}
        >
          <span className="ygg-task-dot is-minimized" />
          {PANEL_TITLES[k]}
        </button>
      ))}
      {pageKeys.map((h) => {
        const domId = pluginPageWindowId(h.plugin.id, h.page.id);
        return (
          <button
            key={domId}
            className="ygg-task"
            title="恢复"
            onClick={() => {
              // 与面板同一套：先还原（窗口从任务栏"长"回原位），再抬到最上层。
              requestRestore(domId);
              focus(domId);
            }}
          >
            <span className="ygg-task-dot is-minimized" />
            {h.page.label}
          </button>
        );
      })}
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
