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
    // 换掉它 = 拆掉所有窗口的基础操作，所以标记为关键并明确禁止。
    critical: true,
    capabilityHint:
      'Dragging the window, minimising, deleting and focusing (raising the layer). If you put buttons in a custom title bar,' +
      'give them class="ygg-winbtn" — the drag test uses that class to exclude the button area,' +
      'without it, clicking a button also starts a drag.',
    builtinHint:
      'A single flex row: a <span> title on the left, an optional small kind tag, a spacer in the middle,' +
      'and the buttons on the right (minimise / delete, class="ygg-winbtn"). Height 30px;' +
      'the drag test is handled by the window container: a drag starts when the press is within the top 30px of the container and not on .ygg-winbtn.',
  });

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
      'the background is **below the windows**, which suits backdrops, starfields and terrain;' +
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
