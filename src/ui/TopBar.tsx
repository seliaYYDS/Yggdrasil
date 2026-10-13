import { useDesktopStore, MAX_SESSIONS } from '../store/desktopStore';
import { ExportIcon, ImportIcon, NewInputIcon, NodesIcon, PluginIcon, ResetIcon, SettingsIcon, TraceIcon, WorkspaceIcon } from './icons';

/**
 * 固定在页面上方两组按钮。
 *
 * 左上角 = 场景的进出口（导出 / 导入），右上角 = 打开各个面板与重置。
 * 分开是有意的：一边是"整个场景的进出"，一边是"看某个面板"，不该混在一排里找。
 */
export function TopBar() {
  const setSeedDialog = useDesktopStore((s) => s.setSeedDialog);

  return (
    <>
      {/*
        左上角：场景的导出 / 导入。
        放在左边是有意的 —— 右边那组是"打开某个面板"（视图），左边这组是"整个场景的进出"，
        两类操作分开，不必在一排图标里找。
      */}
      <div className="ygg-topbar ygg-topbar-left">
        <button className="ygg-topbtn" title="导出场景（.seed）" onClick={() => setSeedDialog('export')}>
          <ExportIcon />
        </button>
        <button className="ygg-topbtn" title="导入场景（.seed）" onClick={() => setSeedDialog('import')}>
          <ImportIcon />
        </button>
      </div>
      <TopRight />
    </>
  );
}

/** 右上角那组：输入框 / 轨迹 / 节点树 / 设置 / 重置。 */
function TopRight() {
  const setSettingsOpen = useDesktopStore((s) => s.setSettingsOpen);
  const setPluginsOpen = useDesktopStore((s) => s.setPluginsOpen);
  const setWorkspaceOpen = useDesktopStore((s) => s.setWorkspaceOpen);
  const setTreeOpen = useDesktopStore((s) => s.setTreeOpen);
  const setTraceOpen = useDesktopStore((s) => s.setTraceOpen);
  const setResetOpen = useDesktopStore((s) => s.setResetOpen);
  const addSession = useDesktopStore((s) => s.addSession);
  const storageNote = useDesktopStore((s) => s.storageNote);
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
      <button className="ygg-topbtn" title="工作区（Agent 的临时加工台）" onClick={() => setWorkspaceOpen(true)}>
        <WorkspaceIcon />
      </button>
      <button className="ygg-topbtn" title="插件" onClick={() => setPluginsOpen(true)}>
        <PluginIcon />
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
