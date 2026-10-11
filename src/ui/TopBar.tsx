import { useDesktopStore } from '../store/desktopStore';

/** 固定在页面右上角的按钮组。输入框本身只保留输入。 */
export function TopBar() {
  const setSettingsOpen = useDesktopStore((s) => s.setSettingsOpen);
  const setTreeOpen = useDesktopStore((s) => s.setTreeOpen);
  const setTraceOpen = useDesktopStore((s) => s.setTraceOpen);
  const setResetOpen = useDesktopStore((s) => s.setResetOpen);
  const storageNote = useDesktopStore((s) => s.storageNote);
  const traceCount = useDesktopStore((s) => s.trace.length);

  return (
    <div className="ygg-topbar">
      <button className="ygg-topbtn" title={'执行轨迹 · ' + storageNote} onClick={() => setTraceOpen(true)}>
        {traceCount > 0 ? <span className="badge">{traceCount}</span> : null}
        ≡
      </button>
      <button className="ygg-topbtn" title="节点" onClick={() => setTreeOpen(true)}>
        ☰
      </button>
      <button className="ygg-topbtn" title="设置" onClick={() => setSettingsOpen(true)}>
        ⚙
      </button>
      <button className="ygg-topbtn is-danger" title="重置" onClick={() => setResetOpen(true)}>
        ⟲
      </button>
    </div>
  );
}
