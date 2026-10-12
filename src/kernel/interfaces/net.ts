import { registerInterface } from '../registry/interfaceRegistry';
import { fail, ok, strOr } from '../bus/opContext';
import { fetchImageData, fetchWebSmart, probeImage } from '../net/fetchWeb';
import { prepareImage } from '../../host/image';
import { MAX_STORED_MESSAGES } from '../agent/prompts';
import { useDesktopStore } from '../../store/desktopStore';

/**
 * 联网接口。
 * 让 Agent 能读网页、跟链接、探图片，而不是只能凭空生成。
 */
export function registerNetInterfaces(): void {
  registerInterface({
    kind: 'fetch_url',
    label: '抓取网页',
    description:
      'Fetch a URL: body (HTML stripped) + title + **direct image links** + followable links. To see images, read that section of the response — no need to fetch again. A direct request blocked by CORS automatically goes through the render proxy. maxChars defaults to 12000 / max 60000 and trims only the body (links and images are unaffected).',
    example: { kind: 'fetch_url', url: 'https://example.com', maxChars: 4000 },
    cap: 'net',
    handler: async (op) => {
      const url = strOr(op.url, '');
      if (!url) return fail('fetch_url needs a url.');
      const maxChars = typeof op.maxChars === 'number' ? op.maxChars : undefined;
      try {
        const r = await fetchWebSmart(url, { maxChars });
        if (r.status < 200 || r.status >= 400) {
          return fail('Fetching ' + url + ' returned ' + r.status + '.');
        }
        const head = [
          'url: ' + r.finalUrl,
          r.title ? 'title: ' + r.title : '',
          'via: ' + r.via,
          r.truncated
            ? '正文已截断：共 ' + r.totalChars + ' 字符，这里只回了前 ' + r.text.length + ' 个（要更多就调大 maxChars）'
            : '',
        ]
          .filter(Boolean)
          .join('\n');
        const images = r.images.length
          ? '\n\n图片直链（可直接写进 <img src>）：\n' + r.images.slice(0, 24).join('\n')
          : '';
        const links = r.links.length ? '\n\n可跟进的链接：\n' + r.links.slice(0, 20).join('\n') : '';
        const summary =
          '已抓取 ' + url + '（正文 ' + r.text.length + ' 字符' +
          (r.images.length ? ' · 图 ' + r.images.length : '') +
          (r.links.length ? ' · 链接 ' + r.links.length : '') + '）';
        return ok(summary, {
          observation: head + '\n\n' + r.text + images + links,
        });
      } catch (e) {
        return fail('Fetching ' + url + ' failed: ' + (e as Error).message);
      }
    },
  });

  registerInterface({
    kind: 'fetch_image',
    label: '探测图片',
    description:
      'Check whether an image URL is reachable (HEAD first, no body download) and return status, content-type and byte size. Use it with the direct image links returned by fetch_url: confirm it works, then write it into a component.',
    example: { kind: 'fetch_image', url: 'https://example.com/a.png' },
    cap: 'net',
    handler: async (op) => {
      const url = strOr(op.url, '');
      if (!url) return fail('fetch_image needs a url.');
      try {
        const r = await probeImage(url);
        if (r.status < 200 || r.status >= 400) return fail('Image ' + url + ' returned ' + r.status + '.');
        // 网页或 JSON 说明这不是直链（常见于图床的中间页 / 防盗链拦截页）。
        if (/^(text\/|application\/(json|xml))/i.test(r.contentType)) {
          return fail(
            '这个地址返回的是 ' + r.contentType + '，不是图片 —— 大概率是图片详情页而不是直链。' +
              '换一个以图片扩展名结尾、content-type 是 image/* 的地址。',
          );
        }
        return ok('图片可用：' + r.contentType + ' ' + (r.bytes || '未知') + 'B', {
          observation: JSON.stringify(r),
        });
      } catch (e) {
        return fail('Probing the image failed: ' + (e as Error).message);
      }
    },
  });

  registerInterface({
    kind: 'view_image',
    label: '看图',
    description:
      '**Read an image into your context** (fetch bytes → base64 → **your own vision**; no third-party recognition). Usage: get a direct image link with fetch_url → view_image → you can see it next round → then decide how to write the component. Requires a vision-capable model (a text-only model fails the whole round); bytes are read directly and an image host that disallows cross-origin reads reports an error. One image = one message in the context (it takes space, so do not look at many at once).',
    example: { kind: 'view_image', url: 'https://example.com/a.png', note: '首页主视觉' },
    mutates: false,
    cap: 'net',
    handler: async (op, ctx) => {
      const url = strOr(op.url, '');
      if (!url) return fail('view_image needs a url.');
      const note = strOr(op.note, '');
      const origin = useDesktopStore.getState().nodes[ctx.originId];
      if (!origin || origin.kind !== 'component' || !origin.agent) {
        return fail('view_image needs a caller with agent capability (an image can only enter an agent own context).');
      }
      try {
        // 中转地址来自设置（默认空 = 不中转）。识图本身始终是"base64 交给当前模型"。
        const relay = (useDesktopStore.getState().settings.imageRelay ?? '').trim() || undefined;
        const img = await fetchImageData(url, { relay });
        // 压一遍再进上下文：原图动辄几 MB，base64 之后更大，而且每轮都会重发。
        const prepared = await prepareImage(img.blob);
        const dataUrl = prepared?.dataUrl ?? img.dataUrl;
        const caption =
          '图片内容' + (note ? '（' + note + '）' : '') + '：' + img.finalUrl +
          '（' + img.contentType + '，' + img.bytes + ' 字节，来源 ' + img.via + '）';
        /*
         * 写进**这次运行所属的那个会话**的记忆：
         * 基底 Agent 的对话按输入框分开（每个输入框一份），组件 Agent 用自己 facet 上的一份。
         */
        const store = useDesktopStore.getState();
        if (ctx.originId === store.rootId) {
          store.appendSessionMessage(ctx.sessionId, { role: 'user', content: caption, images: [dataUrl] });
        } else {
          const fresh = store.nodes[ctx.originId];
          if (!fresh || fresh.kind !== 'component' || !fresh.agent) {
            return fail('The caller agent capability disappeared while fetching, so the image did not enter the context.');
          }
          const next = [...fresh.agent.messages, { role: 'user' as const, content: caption, images: [dataUrl] }];
          store.updateFacet(ctx.originId, {
            messages: next.length > MAX_STORED_MESSAGES ? next.slice(-MAX_STORED_MESSAGES) : next,
          });
        }
        return ok('已读取图片并放进上下文', {
          observation:
            caption + '\n这张图**已经进入你的上下文**，下一轮你就能看到它（包括下一轮以及之后的每一轮，' +
            '直到它被历史裁剪掉）。现在可以描述它、判断它是否适合放进界面，或者据此写组件。',
        });
      } catch (e) {
        return fail('Looking at the image failed: ' + (e as Error).message);
      }
    },
  });
}
