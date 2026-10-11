import { registerSurface } from '../kernel/registry/surfaceRegistry';

/**
 * 内置插槽声明。Agent 可以通过 replace_surface 覆写其中任意一个。
 * 新增插槽：在这里注册，并在渲染处用 <Surface id=... /> 包住内置实现。
 *
 * 注意：只注册真正被渲染的插槽。声明了却没人用的插槽会误导 Agent
 * 去做无效果的替换，所以不保留占位项。
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
    capabilityHint: '拖动窗口、最小化、删除、聚焦提升层级',
  });

  registerSurface({
    id: 'desktop.background',
    label: '桌面背景',
    description: '整页背景。替换后所有窗口浮在你的背景之上。',
    propsHint: '{ nodeCount }',
    capabilityHint: '不要遮挡窗口：背景位于窗口之下，但请不要让它捕获并吞掉鼠标事件后影响窗口点击',
  });
}
