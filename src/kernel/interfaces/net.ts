import { registerInterface } from '../registry/interfaceRegistry';
import { fail, ok, strOr } from '../bus/opContext';
import { fetchWebSmart, probeImage } from '../net/fetchWeb';

/**
 * 联网接口。
 * 让 Agent 能读网页、跟链接、探图片，而不是只能凭空生成。
 */
export function registerNetInterfaces(): void {
  registerInterface({
    kind: 'fetch_url',
    label: '抓取网页',
    description:
      '抓取一个网址，返回正文文本（HTML 会被剥标签）、页面里的**图片直链**与可跟进的链接。' +
      '找图片时直接看返回里的「图片直链」一节，那些地址可以直接写进 <img src>，不需要再抓一遍。' +
      '直连被 CORS 拦时会自动走渲染代理（代理回 markdown，链接与图片同样会被抽出来）。' +
      'maxChars 可选，默认 12000，最大 60000；只裁正文，链接与图片不受影响。失败会返回原因。',
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
}
