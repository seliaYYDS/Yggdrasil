import { registerInterface } from '../registry/interfaceRegistry';
import { fail, ok, strOr } from '../bus/opContext';
import { desktop, useDesktopStore } from '../../store/desktopStore';
import { ARRANGE_MODES, layoutFor } from './layout';
import type { ComponentNode } from '../types';

/**
 * 桌面操控接口。
 *
 * 桌面就是这套系统里的"浏览器"，每个组件就是一个页面/窗口。
 * 创建、关闭、查看、改单个窗口分别由 create_component / remove_node / inspect / update_component
 * 负责（**不在这里再开一条平行入口**）；这里只补一件它们做不到的事：
 * 按统一规则**批量**排布所有窗口。
 */
export function registerWindowInterfaces(): void {
  registerInterface({
    kind: 'arrange_windows',
    label: '排布窗口',
    description:
      'Re-layout the desktop windows by one uniform rule; only positions and sizes change, nothing is created or deleted. mode: grid / cascade / stack (all centred and stacked). Only visible windows are handled — minimised or closed ones stay put. Coordinates are computed from the viewport, which is more reliable than working them out yourself.',
    example: { kind: 'arrange_windows', mode: 'grid' },
    mutates: true,
    cap: 'desktop',
    handler: (op) => {
      const mode = strOr(op.mode, 'grid');
      const store = desktop();
      const targets = Object.values(store.nodes).filter(
        (n): n is ComponentNode => n.kind === 'component' && !n.root && n.status === 'active',
      );
      if (targets.length === 0) return fail('No windows are visible right now, so there is nothing to arrange.');
      if (!(ARRANGE_MODES as readonly string[]).includes(mode)) {
        return fail('mode accepts ' + ARRANGE_MODES.join(' / ') + ' only.');
      }

      const rects = layoutFor(mode, targets.length, store.viewW, store.viewH);
      if (!rects) return fail('mode accepts ' + ARRANGE_MODES.join(' / ') + ' only.');

      // 按层级从低到高摆，视觉顺序与层叠顺序一致。
      const ordered = [...targets].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
      const s = useDesktopStore.getState();
      ordered.forEach((n, i) => {
        const r = rects[i];
        s.updateNode(n.id, { pos: { x: r.x, y: r.y }, size: { w: r.w, h: r.h } });
      });
      const skipped = Object.values(store.nodes).filter(
        (n) => n.kind === 'component' && !n.root && n.status !== 'active',
      ).length;
      s.log('op', 'arrange ' + mode + ' ×' + ordered.length);

      const list = ordered
        .map((n, i) => '- ' + n.name + '(' + n.id + ') → ' + rects[i].x + ',' + rects[i].y + ' ' + rects[i].w + 'x' + rects[i].h)
        .join('\n');
      return ok('Arranged ' + ordered.length + ' windows with mode ' + mode, {
        observation:
          'Viewport ' + store.viewW + 'x' + store.viewH + '; result:\n' + list +
          (skipped > 0 ? '\n(' + skipped + ' more windows are hidden and were left alone)' : ''),
      });
    },
  });
}
