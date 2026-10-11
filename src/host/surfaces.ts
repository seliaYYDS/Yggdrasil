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
    description: '每个窗口顶部的标题栏，含标题与操作按钮。替换后所有窗口都会使用你的版本。',
    propsHint: '{ title, kindLabel, actions: {label,title,danger,onClick}[], onMinimize?, onDelete? }',
    // 拖拽 / 缩放 / 最小化 / 删除都从这条标题栏发起。
    // 换掉它 = 拆掉所有窗口的基础操作，所以标记为关键并明确禁止。
    critical: true,
    capabilityHint:
      '拖动窗口、最小化、删除、聚焦提升层级。如果你在自定义标题栏里放按钮，' +
      '请给按钮加上 class="ygg-winbtn" —— 拖动判定靠这个类名排除按钮区域，' +
      '缺了它点按钮会同时触发拖动。',
    builtinHint:
      '一行 flex 布局：左侧 <span> 标题文字、可选的 kind 小标签，中间撑开，' +
      '右侧若干按钮（最小化 / 删除，class="ygg-winbtn"）。高度 30px，' +
      '拖动判定由窗口容器接管：按下点在容器顶部 30px 以内且不在 .ygg-winbtn 上才开始拖动。',
  });

  registerSurface({
    id: 'desktop.background',
    label: '桌面背景',
    description: '整页背景。替换后所有窗口浮在你的背景之上。',
    propsHint: '{ nodeCount }',
    capabilityHint:
      '不要遮挡窗口：背景位于窗口之下，但请不要让它捕获并吞掉鼠标事件后影响窗口点击',
    builtinHint:
      '内置实现就是一个空 div：<div className="ygg-desktop-bg" />，' +
      'CSS 为 position:absolute; inset:0; background:var(--ygg-bg)。' +
      '它不接收鼠标事件、没有子元素。替换它就能整页作画（canvas / WebGL 都行）——' +
      '背景在**窗口之下**，适合画底图、星空、地形这类东西；' +
      '要盖在窗口**之上**的效果请用 desktop.overlay。',
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
      '覆盖在所有窗口之上的透明效果层。整页级效果（流光、扫描线、粒子、后处理）只需要替换它一次，不要逐个窗口改。',
    propsHint: '{ nodeCount }',
    capabilityHint:
      '整层默认 pointer-events:none，不会挡住窗口操作；需要交互时在组件自己的根元素上设 pointer-events:auto。只能用原生 WebGL / Canvas / DOM，不能 import 第三方库。',
    builtinHint:
      '**没有内置实现**（这一层默认是空的，不渲染任何东西）。你给什么就渲染什么。' +
      '外层容器是 position:fixed; inset:0; z-index:300000; pointer-events:none，' +
      '所以你的组件会铺满整个视口，且默认吃不到鼠标事件。',
  });
}
