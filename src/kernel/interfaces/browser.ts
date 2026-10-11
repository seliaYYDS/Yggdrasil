import { registerInterface } from '../registry/interfaceRegistry';
import { fail, ok, strOr } from '../bus/opContext';
import { desktop, useDesktopStore } from '../../store/desktopStore';
import { closePage, listPages, openPage, resizePage, setFullscreen, viewportInfo } from '../net/browser';
import { newId } from '../ids';

/** 把浏览器页面列表写成人能读、模型也能读的一段文本。 */
function pagesText(): string {
  const list = listPages();
  if (list.length === 0) return '（本应用还没有打开过浏览器页面）';
  return list
    .map(
      (p) =>
        '- id=' + p.id + ' 「' + p.name + '」 url=' + p.url +
        (p.size ? ' size=' + p.size.w + 'x' + p.size.h : ' size=（跨域读不到）') +
        (p.pos ? ' pos=' + p.pos.x + ',' + p.pos.y : ''),
    )
    .join('\n');
}

/**
 * 真实浏览器环境的控制接口。
 *
 * 只暴露浏览器**允许网页做**的事；做不到的（改主窗口大小、在异步里弹新窗口）
 * 一律如实返回原因，并给出可行的替代做法。
 */
export function registerBrowserInterfaces(): void {
  registerInterface({
    kind: 'browser_info',
    label: '读取浏览器窗口',
    description:
      '读取**真实浏览器窗口**的环境信息：可视区（innerW/H）、浏览器窗口（outerW/H）、屏幕分辨率、' +
      '像素比、是否全屏、标签页是否可见，以及当前地址与标题。' +
      '注意这是浏览器窗口，不是应用内部桌面 —— 内部桌面尺寸见系统提示词的「桌面视口」一节。',
    example: { kind: 'browser_info' },
    handler: () => {
      const info = viewportInfo();
      const inner = info.inner as { w: number; h: number };
      return ok('浏览器可视区 ' + inner.w + 'x' + inner.h, {
        observation: JSON.stringify(info, null, 2),
      });
    },
  });

  registerInterface({
    kind: 'browser_resize',
    label: '调整浏览器窗口',
    description:
      '调整真实浏览器窗口的大小 / 位置。target 省略或传 self 表示当前页面，' +
      '也可以传 browser_pages 里的页面 id。' +
      '**浏览器安全限制：网页不能改变用户主窗口的尺寸**，对当前页面调用会被忽略 —— ' +
      '这时返回里会明确说明。能改的是我们自己打开过的窗口。' +
      'fullscreen 可申请/退出全屏（需要用户手势，失败会说明原因）。',
    example: { kind: 'browser_resize', target: 'self', fullscreen: true },
    mutates: true,
    handler: async (op) => {
      const target = typeof op.target === 'string' && op.target.trim() ? op.target.trim() : undefined;

      if (op.fullscreen === true || op.fullscreen === false) {
        const r = await setFullscreen(op.fullscreen === true);
        if (!r.ok) {
          return fail(
            (op.fullscreen ? '申请全屏' : '退出全屏') + '失败：' + r.reason +
              '（全屏需要用户手势，模型异步执行时通常会被拒绝；可以请用户点一下页面再试）',
          );
        }
        const inner = viewportInfo().inner as { w: number; h: number };
        return ok('已' + (op.fullscreen ? '进入' : '退出') + '全屏（可视区 ' + inner.w + 'x' + inner.h + '）', {
          observation: '当前浏览器可视区 ' + inner.w + 'x' + inner.h,
        });
      }

      const opt = {
        width: typeof op.width === 'number' ? op.width : undefined,
        height: typeof op.height === 'number' ? op.height : undefined,
        left: typeof op.left === 'number' ? op.left : undefined,
        top: typeof op.top === 'number' ? op.top : undefined,
      };
      if (
        opt.width === undefined && opt.height === undefined &&
        opt.left === undefined && opt.top === undefined
      ) {
        return fail('browser_resize 需要 width / height / left / top 之一，或 fullscreen。');
      }

      const r = resizePage(target, opt);
      const where = r.handledBy || '当前页面';
      if (r.reason && r.reason.startsWith('write blocked')) {
        return fail('调整「' + where + '」失败：' + r.reason + '（跨域窗口不允许改尺寸）');
      }
      const sizeText = r.size ? r.size.w + 'x' + r.size.h : '（读不到）';
      return ok('已请求调整「' + where + '」，现在 ' + sizeText, {
        observation:
          '请求前 ' + (r.before ? r.before.w + 'x' + r.before.h : '（未知）') +
          ' → 请求后 ' + sizeText +
          (r.reason ? '\n注意：' + r.reason : ''),
      });
    },
  });

  registerInterface({
    kind: 'browser_open',
    label: '新建浏览器页面',
    description:
      '用真实浏览器打开一个新页面（新标签页；给了 width/height 就是新窗口）。会记下句柄，' +
      '之后可以用 browser_pages 查看、browser_close 关闭、browser_resize 调整。' +
      '**浏览器的弹窗拦截**：网页只能在用户手势里开新窗口，模型异步执行时经常被拦。' +
      '被拦时不会失败 —— 会把地址放进输入框里的「打开」按钮，等用户点一下即可。',
    example: { kind: 'browser_open', url: 'https://example.com', width: 1100, height: 800 },
    mutates: true,
    handler: (op) => {
      const url = strOr(op.url, '');
      if (!url) return fail('browser_open 需要 url。');
      const r = openPage(url, {
        name: typeof op.name === 'string' ? op.name : undefined,
        width: typeof op.width === 'number' ? op.width : undefined,
        height: typeof op.height === 'number' ? op.height : undefined,
        left: typeof op.left === 'number' ? op.left : undefined,
        top: typeof op.top === 'number' ? op.top : undefined,
      });

      if (r.ok) {
        desktop().log('op', 'browser + ' + url);
        return ok('已在新页面打开 ' + url, {
          observation:
            '页面 id=' + r.id + '，url=' + url +
            '。可以用 browser_pages 看到它、browser_close 关掉它。',
        });
      }

      if (r.blocked) {
        // 被拦截不是代码错，也不是终点：把地址交给用户点一下。
        const item = { id: newId(), url };
        useDesktopStore.getState().addPendingOpen(item);
        desktop().log('warn', 'browser blocked ' + url);
        return ok('浏览器拦截了弹窗，已把 ' + url + ' 放到输入框的「打开」按钮里，等用户点一下', {
          observation:
            r.reason +
            ' 已经把它挂到输入框上的「打开」按钮，用户点一下就会打开。' +
            '**不要重复再试** —— 再试还是会被拦；可以先用 fetch_url 把内容取回来直接渲染成组件。',
        });
      }

      return fail('打开 ' + url + ' 失败：' + r.reason);
    },
  });

  registerInterface({
    kind: 'browser_pages',
    label: '获取打开的页面',
    description:
      '列出由本应用打开的浏览器页面（id / 名字 / 地址 / 尺寸），以及当前页面自身的地址与可视区。' +
      '注意：浏览器不允许网页枚举用户自己打开的标签页，所以这里只能看到**本应用开出去的**那些。',
    example: { kind: 'browser_pages' },
    handler: () => {
      const list = listPages();
      const info = viewportInfo();
      const inner = info.inner as { w: number; h: number };
      return ok('本应用打开着 ' + list.length + ' 个浏览器页面', {
        observation:
          '## 当前页面\n' +
          '- url: ' + String(info.location) + '\n' +
          '- title: ' + String(info.title) + '\n' +
          '- 可视区: ' + inner.w + 'x' + inner.h + '\n\n' +
          '## 本应用打开的页面\n' + pagesText(),
      });
    },
  });

  registerInterface({
    kind: 'browser_close',
    label: '关闭浏览器页面',
    description:
      '关闭由本应用打开的浏览器页面。target 传页面 id 或名字，传 all（或 *）关掉全部。' +
      '只能关自己打开的窗口 —— 用户自己开的标签页关不掉。',
    example: { kind: 'browser_close', target: 'all' },
    mutates: true,
    handler: (op) => {
      const target = strOr(op.target, '');
      if (!target) return fail('browser_close 需要 target（页面 id、名字，或 all）。');
      const r = closePage(target);
      if (r.missing.length > 0) {
        return fail('找不到页面 ' + r.missing.join('、') + '。当前打开着：\n' + pagesText());
      }
      desktop().log('op', 'browser - ' + target);
      return ok('已关闭 ' + r.closed + ' 个页面', {
        observation: '关闭了 ' + r.closed + ' 个' + (r.failed.length ? '；失败：' + r.failed.join('；') : ''),
      });
    },
  });
}
