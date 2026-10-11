import { useDesktopStore, MAX_SESSIONS } from '../store/desktopStore';
import { NewInputIcon, NodesIcon, ResetIcon, SettingsIcon, TraceIcon } from './icons';

/** 固定在页面右上角的按钮组。输入框本身只保留输入。 */
export function TopBar() {
  const setSettingsOpen = useDesktopStore((s) => s.setSettingsOpen);
  const setTreeOpen = useDesktopStore((s) => s.setTreeOpen);
  const setTraceOpen = useDesktopStore((s) => s.setTraceOpen);
  const setResetOpen = useDesktopStore((s) => s.setResetOpen);
  const addSession = useDesktopStore((s) => s.addSession);
  const storageNote = useDesktopStore((s) => s.storageNote);
  // 所有输入框的轨迹合起来算 —— 轨迹面板就是合并展示的。
  const traceCount = useDesktopStore((s) => s.sessions.reduce((n, ses) => n + ses.trace.length, 0));
  const sessionCount = useDesktopStore((s) => s.sessions.length);
  const runningCount = useDesktopStore((s) => s.sessions.filter((ses) => ses.status.running).length);

  return (
    <div className="ygg-topbar">
      <button
        className="ygg-topbtn"
        title={sessionCount >= MAX_SESSIONS ? '已达输入框上限' : '再开一个输入框（可并行干活）'}
        disabled={sessionCount >= MAX_SESSIONS}
        onClick={() => addSession()}
      >
        <NewInputIcon />
        {sessionCount > 1 ? <span className="tag">{sessionCount}</span> : null}
      </button>
      <button
        className="ygg-topbtn"
        title={'执行轨迹 · ' + storageNote}
        onClick={() => setTraceOpen(true)}
      >
        <TraceIcon />
        {traceCount > 0 ? <span className="badge">{traceCount}</span> : null}
        {runningCount > 0 ? <span className="pulse" title={runningCount + ' 个任务在跑'} /> : null}
      </button>
      <button className="ygg-topbtn" title="节点树" onClick={() => setTreeOpen(true)}>
        <NodesIcon />
      </button>
      <button className="ygg-topbtn" title="设置" onClick={() => setSettingsOpen(true)}>
        <SettingsIcon />
      </button>
      <button className="ygg-topbtn is-danger" title="重置" onClick={() => setResetOpen(true)}>
        <ResetIcon />
      </button>
    </div>
  );
}
