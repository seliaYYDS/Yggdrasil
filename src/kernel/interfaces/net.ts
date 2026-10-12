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
      '抓取网址：返回正文（HTML 剥标签）+ 标题 + **图片直链** + 可跟进链接。看图片直接看返回里那一节，不用再抓。' +
      '直连被 CORS 拦会自动走渲染代理。maxChars 默认 12000 / 上限 60000，只裁正文（链接与图片不受影响）。',
    example: { kind: 'fetch_url', url: 'https://example.com', maxChars: 4000 },
    cap: 'net',
    handler: async (op) => {
      const url = strOr(op.url, '');
      if (!url) return fail('fetch_url 需要 url。');
      const maxChars = typeof op.maxChars === 'number' ? op.maxChars : undefined;
      try {
        const r = await fetchWebSmart(url, { maxChars });
        if (r.status < 200 || r.status >= 400) {
          return fail('抓取 ' + url + ' 返回 ' + r.status + '。');
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
        return fail('抓取 ' + url + ' 失败：' + (e as Error).message);
      }
    },
  });

  registerInterface({
    kind: 'fetch_image',
    label: '探测图片',
    description:
      '检查一个图片网址是否可达（先 HEAD，不下载正文），返回状态、content-type 与字节数。' +
      '配合 fetch_url 返回的「图片直链」使用：先确认能用，再写进组件。',
    example: { kind: 'fetch_image', url: 'https://example.com/a.png' },
    cap: 'net',
    handler: async (op) => {
      const url = strOr(op.url, '');
      if (!url) return fail('fetch_image 需要 url。');
      try {
        const r = await probeImage(url);
        if (r.status < 200 || r.status >= 400) return fail('图片 ' + url + ' 返回 ' + r.status + '。');
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
        return fail('探测图片失败：' + (e as Error).message);
      }
    },
  });

  registerInterface({
    kind: 'view_image',
    label: '看图',
    description:
      '**把一张图片读进你的上下文**（抓字节 → base64 → 交给**你自己的视觉能力**，没有第三方识别）。' +
      '用法：fetch_url 拿到图片直链 → view_image → 下一轮你就能看到它 → 再决定怎么写组件。' +
      '需要模型支持视觉（纯文本模型这一轮会整条失败）；字节直连读取，图床不允许跨域时会报错。' +
      '一张图 = 上下文里一条消息（会占空间，别一次看太多）。',
    example: { kind: 'view_image', url: 'https://example.com/a.png', note: '首页主视觉' },
    mutates: false,
    cap: 'net',
    handler: async (op, ctx) => {
      const url = strOr(op.url, '');
      if (!url) return fail('view_image 需要 url。');
      const note = strOr(op.note, '');
      const origin = useDesktopStore.getState().nodes[ctx.originId];
      if (!origin || origin.kind !== 'component' || !origin.agent) {
        return fail('view_image 需要一个带 agent 能力的发起者（图片只能进 Agent 自己的上下文）。');
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
            return fail('发起者的 agent 能力在抓图期间消失了，图片没有进入上下文。');
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
        return fail('看图失败：' + (e as Error).message);
      }
    },
  });
}
