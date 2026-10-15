import { useMemo } from 'react';
import { WindowFrame } from '../host/WindowFrame';
import { useDesktopStore, type PanelRect } from '../store/desktopStore';
import { pluginPageKey, pluginPageWindowId, type PluginPageHost } from '../kernel/plugin/runtime';
import { compileComponent } from '../host/compile';
import { ErrorBoundary } from '../app/ErrorBoundary';

/**
 * 插件提供的**默认页面**：一个常驻窗口，工具栏上有一个按钮开关它。
 *
 * 与 `plugin_ui` 建出来的组件窗口的区别在于定位：
 * - `plugin_ui` 是**Agent 摆出来的一块界面**（内容由 Agent 传 data 决定，窗口被锁定）；
 * - 这里是**插件给界面加的一个页面**（像 Nodes / Trace 那样常驻，用户自己开关，位置会记住）。
 *
 * 源码契约与 ui/*.tsx **完全相同**（export default 一个函数组件，可以 import react 与
 * "yggdrasil"），data 的注入方式也一样 —— 只是这里的 data 来自清单里的静态声明，
 * 因为运行时没有人会给它传参。
 */
export function PluginPageWindow({ host, index }: { host: PluginPageHost; index: number }) {
  const key = pluginPageKey(host.plugin.id, host.page.id);
  const domId = pluginPageWindowId(host.plugin.id, host.page.id);
  const rect = useDesktopStore((s) => s.pluginPageRects[key]);
  const minimized = useDesktopStore((s) => !!s.minimizedPanels['page:' + key]);
  const z = useDesktopStore((s) => s.panelZ[domId] ?? 1);
  const focusedId = useDesktopStore((s) => s.focusedId);
  const bringToFront = useDesktopStore((s) => s.bringToFront);
  const setRect = useDesktopStore((s) => s.setPluginPageRect);
  const requestMinimize = useDesktopStore((s) => s.requestMinimize);
  const requestClose = useDesktopStore((s) => s.requestClose);

  const file = host.plugin.files[host.page.file] ?? '';
  /*
   * 数据注入与 plugin_ui 同一套：组件没有 props，data 作为**模块顶层常量**注入。
   * 直接放在源码前面，不解析、不改写插件自己的代码。
   */
  const source = file ? 'const data = ' + JSON.stringify(host.page.data ?? null) + ';\n' + file + '\n' : '';
  const compiled = useMemo(() => (source ? compileComponent('page_' + key, source) : null), [source, key]);

  /*
   * 缺省落点：按页面序号错开，别叠在 Nodes 面板上（内置面板占了左边与右边）。
   * 只用作**首次**位置 —— 用户一拖就会写进 pluginPageRects，之后一直用它。
   */
  const fallback: PanelRect = {
    x: 96 + (index % 5) * 28,
    y: 130 + (index % 5) * 26,
    w: 460,
    h: 340,
  };
  const resolved = rect ?? host.page.rect ?? fallback;

  // 最小化后交给任务栏渲染，这里什么都不画（与 PanelWindow 一致）。
  if (minimized) return null;

  let body;
  if (!file) {
    body = <div className="ygg-blank">插件包里找不到 {host.page.file}。</div>;
  } else if (compiled && compiled.ok) {
    const C = compiled.Component;
    body = <C />;
  } else {
    body = (
      <div className="ygg-error-panel">
        <div className="title">✕</div>
        <pre>{compiled ? compiled.error : '未知编译错误'}</pre>
      </div>
    );
  }

  return (
    <WindowFrame
      id={domId}
      title={host.page.label}
      kindLabel={host.plugin.name}
      rect={resolved}
      zIndex={z}
      focused={focusedId === domId}
      onRect={(next) => setRect(key, next)}
      onFocus={() => bringToFront(domId)}
      onMinimize={() => requestMinimize(domId)}
      onDelete={() => requestClose(domId)}
      minW={220}
      minH={140}
    >
      <ErrorBoundary onError={() => undefined}>{body}</ErrorBoundary>
    </WindowFrame>
  );
}
