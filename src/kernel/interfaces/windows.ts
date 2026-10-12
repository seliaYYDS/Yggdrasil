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
      '把桌面上的窗口按统一规则重新排布，只改位置与尺寸，不新建也不删除。' +
      'mode：grid 网格 / cascade 斜向层叠 / stack 全部居中叠放。' +
      '只处理当前显示中的窗口，最小化或关闭的不动。坐标由服务端按视口算，比你手算每个窗口的坐标可靠。',
    example: { kind: 'arrange_windows', mode: 'grid' },
    mutates: true,
    cap: 'desktop',
    handler: (op) => {
      const mode = strOr(op.mode, 'grid');
      const store = desktop();
      const targets = Object.values(store.nodes).filter(
        (n): n is ComponentNode => n.kind === 'component' && !n.root && n.status === 'active',
      );
      if (targets.length === 0) return fail('当前没有显示中的窗口，没什么可排布的。');
      if (!(ARRANGE_MODES as readonly string[]).includes(mode)) {
        return fail('mode 只接受 ' + ARRANGE_MODES.join(' / ') + '。');
      }

      const rects = layoutFor(mode, targets.length, store.viewW, store.viewH);
      if (!rects) return fail('mode 只接受 ' + ARRANGE_MODES.join(' / ') + '。');

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
      return ok('已按 ' + mode + ' 排布 ' + ordered.length + ' 个窗口', {
        observation:
          '视口 ' + store.viewW + 'x' + store.viewH + '，排布结果：\n' + list +
          (skipped > 0 ? '\n（另有 ' + skipped + ' 个窗口未显示，没有动）' : ''),
      });
    },
  });
}
