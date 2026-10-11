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
      '抓取一个网址并返回其正文文本（HTML 会被剥标签）。用于读取资料、文档、接口返回。直连被 CORS 拦时会自动走文本代理。失败会返回原因。',
    example: { kind: 'fetch_url', url: 'https://example.com', maxChars: 4000 },
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
          r.truncated ? '（已截断）' : '',
        ]
          .filter(Boolean)
          .join('\n');
        const links = r.links.length ? '\n\n可跟进的链接：\n' + r.links.slice(0, 20).join('\n') : '';
        return ok('已抓取 ' + url + '（' + r.text.length + ' 字符）', {
          observation: head + '\n\n' + r.text + links,
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
      '检查一个图片网址是否可达，返回状态、类型与字节数。用于确认图片能用，然后再写进组件。',
    example: { kind: 'fetch_image', url: 'https://example.com/a.png' },
    handler: async (op) => {
      const url = strOr(op.url, '');
      if (!url) return fail('fetch_image 需要 url。');
      try {
        const r = await probeImage(url);
        if (r.status < 200 || r.status >= 400) return fail('图片 ' + url + ' 返回 ' + r.status + '。');
        return ok('图片可用：' + r.contentType + ' ' + r.bytes + 'B', {
          observation: JSON.stringify(r),
        });
      } catch (e) {
        return fail('探测图片失败：' + (e as Error).message);
      }
    },
  });
}
