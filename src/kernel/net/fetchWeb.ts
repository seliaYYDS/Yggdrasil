/**
 * 联网能力。
 *
 * 走一个可配置的 CORS 代理（默认 r.jina.ai 文本代理），因为浏览器里直接 fetch 任意站点
 * 会被 CORS 拦掉。所有结果都做长度裁剪后再回灌给模型，避免把整个页面塞进上下文。
 */

export interface WebFetchOptions {
  /** 只取前 N 个字符，默认 6000。 */
  maxChars?: number;
  signal?: AbortSignal;
}

export interface WebFetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title: string;
  text: string;
  truncated: boolean;
  links: string[];
}

export const DEFAULT_PROXY = 'https://r.jina.ai/';

function absUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('url 为空。');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed;
  return new URL(withScheme);
}

function stripTags(html: string): string {
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const spaced = noScript
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return spaced
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function titleOf(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? stripTags(m[1]).slice(0, 200) : '';
}

function linksOf(html: string, base: string): string[] {
  const out = new Set<string>();
  const re = /<a\s+[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const u = new URL(m[1], base);
      if (u.protocol === 'http:' || u.protocol === 'https:') out.add(u.href);
    } catch {
      /* 忽略非法链接 */
    }
    if (out.size >= 40) break;
  }
  return [...out];
}

export async function fetchWeb(rawUrl: string, options: WebFetchOptions = {}): Promise<WebFetchResult> {
  const url = absUrl(rawUrl);
  const maxChars = Math.min(Math.max(options.maxChars ?? 6000, 200), 40000);

  const res = await fetch(url.href, {
    method: 'GET',
    headers: { Accept: 'text/html,application/json,text/plain,*/*' },
    signal: options.signal,
    redirect: 'follow',
  });

  const contentType = res.headers.get('content-type') ?? '';
  const raw = await res.text();
  const isHtml = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw);
  const body = isHtml ? stripTags(raw) : raw.trim();

  const truncated = body.length > maxChars;
  return {
    url: url.href,
    finalUrl: res.url || url.href,
    status: res.status,
    contentType,
    title: isHtml ? titleOf(raw) : '',
    text: truncated ? body.slice(0, maxChars) : body,
    truncated,
    links: isHtml ? linksOf(raw, res.url || url.href) : [],
  };
}

/** 通过文本代理抓取，用于绕开 CORS。 */
export async function fetchViaProxy(rawUrl: string, options: WebFetchOptions = {}): Promise<WebFetchResult> {
  const url = absUrl(rawUrl);
  const proxy = DEFAULT_PROXY + url.href;
  const maxChars = Math.min(Math.max(options.maxChars ?? 6000, 200), 40000);

  const res = await fetch(proxy, {
    method: 'GET',
    headers: { Accept: 'text/plain' },
    signal: options.signal,
  });
  const body = (await res.text()).trim();
  const truncated = body.length > maxChars;

  return {
    url: url.href,
    finalUrl: url.href,
    status: res.status,
    contentType: 'text/plain',
    title: '',
    text: truncated ? body.slice(0, maxChars) : body,
    truncated,
    links: [],
  };
}

/** 优先直连，直连失败（通常是 CORS）自动回退到代理。 */
export async function fetchWebSmart(rawUrl: string, options: WebFetchOptions = {}): Promise<WebFetchResult & { via: 'direct' | 'proxy' }> {
  try {
    const direct = await fetchWeb(rawUrl, options);
    if (direct.status >= 200 && direct.status < 400 && direct.text) return { ...direct, via: 'direct' };
  } catch {
    /* 落到代理 */
  }
  const proxied = await fetchViaProxy(rawUrl, options);
  return { ...proxied, via: 'proxy' };
}

/** 抓图片：只验证可达性与尺寸，不把二进制塞进上下文。 */
export async function probeImage(rawUrl: string, options: WebFetchOptions = {}): Promise<{ url: string; status: number; contentType: string; bytes: number }> {
  const url = absUrl(rawUrl);
  const res = await fetch(url.href, { method: 'GET', signal: options.signal });
  const blob = await res.blob().catch(() => null);
  return {
    url: url.href,
    status: res.status,
    contentType: res.headers.get('content-type') ?? blob?.type ?? '',
    bytes: blob?.size ?? 0,
  };
}
