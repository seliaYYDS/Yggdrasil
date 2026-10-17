import { registerSurface } from '../kernel/registry/surfaceRegistry';

/**
 * 内置插槽声明。Agent 可以通过 replace_surface 覆写其中任意一个。
 * 新增插槽：在这里注册，并在渲染处用 <Surface id=... /> 包住内置实现。
 *
 * 注意：只注册真正被渲染的插槽。声明了却没有渲染处的插槽会误导 Agent
 * 去做无效果的替换，所以不保留占位项。
 *
 * 每个插槽都要写清楚 **builtinHint：内置实现到底长什么样**。
 * Agent 读不到内置实现的源码（那是宿主代码），没有这段说明它只能干猜 ——
 * "把背景换成 WebGL"这类请求就会卡在"抓不到背景源码"上。
 */
export function registerBuiltinSurfaces(): void {
  registerSurface({
    id: 'window.titlebar',
    label: '窗口标题栏',
    description: 'The title bar at the top of every window, holding the title and the window buttons. Once replaced, every window uses your version.',
    propsHint: '{ title, kindLabel, actions: {label,title,danger,onClick}[], onMinimize?, onDelete? }',
    // 拖拽 / 缩放 / 最小化 / 删除都从这条标题栏发起。
    // 基础能力已经上移到窗口容器层，所以替换它不会让窗口变成拖不动；
    // 但它仍然是**默认界面的结构**：换掉要弹一次确认让用户能还原。
    critical: true,
    defaultWindow: true,
    capabilityHint:
      'Dragging the window, minimising, deleting and focusing (raising the layer). If you put buttons in a custom title bar,' +
      'give them class="ygg-winbtn" — the drag test uses that class to exclude the button area,' +
      'without it, clicking a button also starts a drag.',
    builtinHint:
      'A single flex row: a <span> title on the left, an optional small kind tag, a spacer in the middle,' +
      'and the buttons on the right (minimise / delete, class="ygg-winbtn"). Height 30px;' +
      'the drag test is handled by the window container: a drag starts when the press is within the top 30px of the container and not on .ygg-winbtn.',
  });

  /**
   * 默认窗口面板的**可读内置源码**。
   *
   * 面板的内置实现是宿主 React 代码、读不到 —— 但真实内容是通过 `children` 交给插槽的，
   * 所以"原样透传"与内置**行为完全等价**。登记进插槽（SurfaceDef.builtinSource），
   * patch_source 才能从一份真源码开始改：第一次改动就是 find/replace，而不是整段重写。
   */
  const PANEL_BUILTIN_SOURCE = 'export default function Panel(props) {\n  return props.children;\n}';

  /*
   * 常驻面板的**结构插槽**。
   *
   * 面板内置实现是宿主代码（读不到源码），所以 props 里一定带 `children` ——
   * **内置内容本身**（一个 React 元素）。想"只改结构、不丢功能"就把它放进自己的布局里；
   * 想整块换掉就不渲染它。数据（节点、轨迹、文件列表……）不经过 props：
   * 它们活在宿主状态里，由面板自己读；要数据用 inspect / list_nodes / ws_list / ws_read。
   *
   * 既然内容本来就是通过 `children` 交出来的，"原样透传"就是与内置等价的实现 ——
   * 这里因此同时登记 PANEL_BUILTIN_SOURCE，让 patch_source 能从一份真源码开始改。
   *
   * 这些插槽都标 defaultWindow：改完会弹一次确认，用户可以选择把结构还原。
   */
  const panelSlot = (key: string, label: string, description: string): void =>
    registerSurface({
      id: 'panel.' + key,
      label,
      description,
      propsHint: '{ panel, title, close, children }',
      defaultWindow: true,
      builtinSource: PANEL_BUILTIN_SOURCE,
      builtinHint:
        'The built-in body of this panel. Its host implementation is not readable — but the **readable built-in' +
        ' source** is the `children` pass-through (inspect before="surface" prints it): render `children` in your' +
        ' own structure to change the layout without losing the function, or drop it and draw the panel yourself' +
        ' (no panel data is passed as props; read what you need with inspect / list_nodes / ws_list).',
    });

  panelSlot('input', '输入框', 'The composer window body: the text field, the queue, the send button and the metrics line. Replacing it changes how the user talks to the agent.');
  panelSlot('inspector', '节点面板', 'The Nodes panel body: the tree of agents, components, tools and surface slots. Replacing it changes how the user browses the desktop.');
  panelSlot('trace', '轨迹面板', 'The Trace panel body: every session\'s run steps, with the filters and the expandable raw output. Replacing it changes how the user reads what the agent did.');
  panelSlot('settings', '设置面板', 'The Settings panel body: model, provider, context window, security level. Replacing it changes where the user configures the LLM.');
  panelSlot('plugins', '插件面板', 'The Plugins panel body: installed plugins, their fields and their signatures. Replacing it changes how the user manages plugins.');
  panelSlot('workspace', '工作区面板', 'The Workspace panel body: the files the agent can read and write. Replacing it changes how the user browses those files.');

  registerSurface({
    id: 'desktop.background',
    label: '桌面背景',
    description: 'The page background. Once replaced, every window floats above your background.',
    propsHint: '{ nodeCount }',
    capabilityHint:
      'Do not block the windows: the background sits below them, so never let it capture and swallow mouse events in a way that breaks clicking on windows',
    builtinHint:
      'The built-in implementation is an empty div: <div className="ygg-desktop-bg" />,' +
      'with CSS position:absolute; inset:0; background:var(--ygg-bg).' +
      'It receives no mouse events and has no children. Replacing it lets you paint the whole page (canvas / WebGL both work) —' +
      'the background is **below the windows**;' +
      'for effects that must cover the windows, use desktop.overlay.',
  });

  /*
   * 整页效果层：**一次改这一层就够了，不要挨个窗口改**。
   * 它盖在所有窗口与面板之上，所以适合做"给所有窗口叠加流光 / 扫描线 / 粒子"这类效果。
   * 默认 pointer-events: none，不影响用户点窗口（要交互就在自己的根元素上开 pointer-events）。
   */
  registerSurface({
    id: 'desktop.overlay',
    label: '整页效果层',
    description:
      'A transparent effect layer covering every window. Page-wide effects (light streaks, scanlines, particles, post-processing) need it replaced once — never per window.',
    propsHint: '{ nodeCount }',
    capabilityHint:
      'The whole layer is pointer-events:none by default so it never blocks window controls; turn pointer-events:auto back on in your own root when you need interaction. Only native WebGL / Canvas / DOM — no third-party imports.',
    builtinHint:
      '**There is no built-in implementation** (this layer is empty by default and renders nothing). Whatever you provide is what renders.' +
      'The outer container is position:fixed; inset:0; z-index:300000; pointer-events:none,' +
      'so your component fills the whole viewport and receives no mouse events by default.',
  });
}
