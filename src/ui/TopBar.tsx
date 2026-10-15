import { useMemo } from 'react';
import { useDesktopStore, MAX_SESSIONS, traceTotal } from '../store/desktopStore';
import { pluginPageKey, pluginPageWindowId, pluginPages } from '../kernel/plugin/runtime';
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
  /*
   * 徽标 = **没看过**的步数，不是轨迹总数。
   * 以前挂的是总数：点开看过之后它还挂在那里，只有手动"清空轨迹"才会消失 —— 那是个假通知。
   */
  const traceCount = useDesktopStore(traceTotal);
  const traceSeen = useDesktopStore((s) => s.traceSeen);
  const unseen = Math.max(0, traceCount - traceSeen);
  /*
   * 插件页面：**每个页面一个工具栏按钮**。这就是"插件给界面加一个按钮"的落点 ——
   * 页面的开合、层级、最小化都与内置面板共用同一套机制。
   */
  /*
   * 必须**订阅 plugins**：pluginPages() 读的是运行时模块里的模块级状态，它不是响应式的。
   * 不订阅的话，装完插件工具栏不会多出按钮（要等到别的 state 变化才顺带重渲染）——
   * 那是最像"功能没做"的一类 bug。useMemo 的依赖也用它，保证装/卸时重算。
   */
  const plugins = useDesktopStore((s) => s.plugins);
  const pages = useMemo(() => pluginPages(), [plugins]);
  const pageOpen = useDesktopStore((s) => s.pluginPageOpen);
  const setPageOpen = useDesktopStore((s) => s.setPluginPageOpen);
  const bringToFront = useDesktopStore((s) => s.bringToFront);
  const pageMinimized = useDesktopStore((s) => s.minimizedPanels);
  const sessionCount = useDesktopStore((s) => s.sessions.length);
  const runningCount = useDesktopStore((s) => s.sessions.filter((ses) => ses.status.running).length);

  return (
    <div className="ygg-topbar">
      <button
        className="ygg-topbtn"
        title={sessionCount >= MAX_SESSIONS ? '已达输入框上限' : '新建输入框'}
        disabled={sessionCount >= MAX_SESSIONS}
        onClick={() => addSession()}
      >
        <NewInputIcon />
        {sessionCount > 1 ? <span className="tag">{sessionCount}</span> : null}
      </button>
      <button
        className="ygg-topbtn"
        title="执行轨迹"
        onClick={() => setTraceOpen(true)}
      >
        <TraceIcon />
        {unseen > 0 ? <span className="badge">{unseen}</span> : null}
        {runningCount > 0 ? <span className="pulse" title={runningCount + ' 个任务运行中'} /> : null}
      </button>
      <button className="ygg-topbtn" title="节点树" onClick={() => setTreeOpen(true)}>
        <NodesIcon />
      </button>
      <button className="ygg-topbtn" title="工作区" onClick={() => setWorkspaceOpen(true)}>
        <WorkspaceIcon />
      </button>
      <button className="ygg-topbtn" title="插件" onClick={() => setPluginsOpen(true)}>
        <PluginIcon />
      </button>
      {pages.map((h) => {
        const key = pluginPageKey(h.plugin.id, h.page.id);
        const domId = pluginPageWindowId(h.plugin.id, h.page.id);
        const open = pageOpen[key] === true && !pageMinimized['page:' + key];
        return (
          <button
            key={key}
            className={'ygg-topbtn' + (open ? ' is-on' : '')}
            title={h.page.description || h.plugin.name + ' · ' + h.page.label}
            onClick={() => {
              // 已开 → 抬到最上层（再点一次不关：工具栏按钮的惯例是"打开/聚焦"）。
              // 已关 → 打开。要关就用窗口右上角的 ✕。
              if (open) bringToFront(domId);
              else setPageOpen(key, true);
            }}
          >
            {/*
              按钮**只有图标**，页面名放在 title 里 —— 与这一排其它按钮（节点树 / 工作区 / 设置）
              完全一致。加一行文字会把这一排的节奏打乱，而且它是"永久占位"的，
              页面一多就把别的按钮挤走；名字本来就是 hover 才需要的信息。
            */}
            <PluginIcon />
          </button>
        );
      })}
      <button className="ygg-topbtn" title="设置" onClick={() => setSettingsOpen(true)}>
        <SettingsIcon />
      </button>
      <button className="ygg-topbtn is-danger" title="重置" onClick={() => setResetOpen(true)}>
        <ResetIcon />
      </button>
    </div>
  );
}
