import { registerInterface } from '../registry/interfaceRegistry';
import { fail, ok, strOr } from '../bus/opContext';
import { desktop, useDesktopStore } from '../../store/desktopStore';
import { canCaptureScreen } from '../../host/screen';
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
      'Read the **real browser window** environment: viewport (innerW/H), browser window (outerW/H), screen resolution, pixel ratio, fullscreen, tab visibility, plus the current URL and title. Note this is the browser window, not the in-app desktop — see the "Desktop viewport" section for the latter.',
    example: { kind: 'browser_info' },
    cap: 'browser',
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
      'Resize / reposition a real browser window. Omitting target or passing self means the current page; you may also pass a page id from browser_pages. **Browser security limit: a page cannot resize the user main window**, so calling it on the current page is ignored — the response says so explicitly. Windows this app opened itself can be changed. fullscreen requests or leaves fullscreen (needs a user gesture; failures explain why).',
    example: { kind: 'browser_resize', target: 'self', fullscreen: true },
    mutates: true,
    cap: 'browser',
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
        return fail('browser_resize needs one of width / height / left / top, or fullscreen.');
      }

      const r = resizePage(target, opt);
      const where = r.handledBy || '当前页面';
      if (r.reason && r.reason.startsWith('write blocked')) {
        return fail('Failed to resize "' + where + '": ' + r.reason + ' (cross-origin windows cannot be resized)');
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
      'Open a new page in the real browser (a new tab; with width/height it becomes a new window). The handle is recorded, so you can later list it with browser_pages, close it with browser_close and resize it with browser_resize. **Popup blocking**: a page may only open windows inside a user gesture, and an asynchronously running model is often blocked. Being blocked is not a failure — the URL is attached to the "open" button of the input box for the user to click.',
    example: { kind: 'browser_open', url: 'https://example.com', width: 1100, height: 800 },
    mutates: true,
    cap: 'browser',
    handler: (op) => {
      const url = strOr(op.url, '');
      if (!url) return fail('browser_open needs a url.');
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

      return fail('Failed to open ' + url + ': ' + r.reason);
    },
  });

  registerInterface({
    kind: 'browser_pages',
    label: '获取打开的页面',
    description:
      'List the browser pages this app opened (id / name / url / size), plus the current page own url and viewport. Note: the browser does not let a page enumerate the tabs the user opened, so only pages **opened by this app** appear here.',
    example: { kind: 'browser_pages' },
    cap: 'browser',
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
      'Close browser pages this app opened. Pass a page id or name as target, or all (or *) to close every one. Only windows you opened can be closed — tabs the user opened cannot.',
    example: { kind: 'browser_close', target: 'all' },
    mutates: true,
    cap: 'browser',
    handler: (op) => {
      const target = strOr(op.target, '');
      if (!target) return fail('browser_close needs a target (page id, name, or all).');
      const r = closePage(target);
      if (r.missing.length > 0) {
        return fail('No such page ' + r.missing.join(', ') + '. Currently open:\n' + pagesText());
      }
      desktop().log('op', 'browser - ' + target);
      return ok('已关闭 ' + r.closed + ' 个页面', {
        observation: '关闭了 ' + r.closed + ' 个' + (r.failed.length ? '；失败：' + r.failed.join('；') : ''),
      });
    },
  });

  registerInterface({
    kind: 'capture_screen',
    label: '抓取页面截图',
    description:
      '**Ask for a real screenshot of the current page**; it is put into your context (you will see it next round). Use it to check what you actually built: overlap, overflow, wrong colours. ⚠ The browser requires screen capture to be triggered by a **user gesture**, so this call only registers a request: a "screenshot for the agent" button appears on the input box and **the user clicks it** before the image arrives. End your turn after calling it — do not call it repeatedly waiting for a result.',
    example: { kind: 'capture_screen' },
    cap: 'browser',
    handler: (_op, ctx) => {
      const store = useDesktopStore.getState();
      if (!canCaptureScreen()) {
        return fail('This browser does not support screen capture (getDisplayMedia is missing), so no screenshot can be taken.');
      }
      store.requestShot(ctx.sessionId);
      store.log('op', '请求截图', ctx.sessionId);
      return ok('已请求截图：请用户在输入框上点「截图给 Agent」，图会进入你的上下文。', {
        observation:
          '截图需要用户手势，已挂起请求。**这一轮到此为止**，不要重复调用；' +
          '图到手后你会收到一条带图片的新消息。',
      });
    },
  });
}
