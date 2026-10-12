/**
 * 联网能力。
 *
 * 走一个可配置的 CORS 代理（默认 r.jina.ai 文本代理），因为浏览器里直接 fetch 任意站点
 * 会被 CORS 拦掉。所有结果都做长度裁剪后再回灌给模型，避免把整个页面塞进上下文。
 *
 * 一条重要约束：**链接与图片是在裁剪之前从完整正文里抽的**。
 * 先裁剪再抽取会让"图片在页面后半段"的情况永远找不到直链。
 */

export interface WebFetchOptions {
  /** 只取正文前 N 个字符，默认 12000。注意链接与图片不受这个限制。 */
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
  /** 裁剪前的正文总长度；配合 truncated 告诉模型丢了多少。 */
  totalChars: number;
  truncated: boolean;
  /** 页面里的超链接（已补成绝对地址）。 */
  links: string[];
  /** 页面里的图片直链，可直接写进 <img src>。 */
  images: string[];
}

export const DEFAULT_PROXY = 'https://r.jina.ai/';

/** 正文裁剪的默认值与上限。 */
export const DEFAULT_MAX_CHARS = 12000;
export const MAX_MAX_CHARS = 60000;

/** 单类 URL（链接 / 图片）最多回多少个，防止一个列表页把上下文塞满。 */
const MAX_URLS = 60;

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

/** 看起来像图片文件名的地址（用来把"裸 URL"分到图片还是链接）。 */
const IMAGE_EXT_RE = /\.(?:jpe?g|png|gif|webp|avif|bmp|svg|ico)(?:[?#]|$)/i;

/**
 * 把任意写法的地址补成绝对 http(s) 地址。
 * 过滤掉 data: / blob: / javascript: 这些不能当图片用的东西。
 */
function resolveUrl(raw: string, base: string): string | null {
  const s = String(raw ?? '').trim().replace(/^[\s'"]+|[\s'"]+$/g, '');
  if (!s) return null;
  if (/^(data|blob|javascript|about|mailto|tel):/i.test(s)) return null;
  try {
    const u = new URL(s, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return null;
  }
}

/** 取标签里的某个属性值，单引号 / 双引号 / 不加引号都认。 */
function attr(tag: string, name: string): string | null {
  const re = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

interface Scan {
  links: string[];
  images: string[];
}

/** 图片标签上常见的懒加载属性，逐个都收一遍。 */
const IMG_SRC_ATTRS = [
  'src',
  'data-src',
  'data-original',
  'data-lazy-src',
  'data-imgurl',
  'data-url',
  'data-image',
];

/** srcset 形如 "a.jpg 1x, b.jpg 2x"，取最后一档（通常是最大的那个）。 */
function srcsetUrl(value: string, base: string): string | null {
  const parts = value
    .split(',')
    .map((p) => p.trim().split(/\s+/)[0])
    .filter(Boolean);
  if (parts.length === 0) return null;
  return resolveUrl(parts[parts.length - 1], base);
}

/** 从 HTML 里抽链接与图片直链。 */
export function scanHtml(html: string, base: string): Scan {
  const links = new Set<string>();
  const images = new Set<string>();

  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    if (links.size >= MAX_URLS) break;
    const u = resolveUrl(attr(m[0], 'href') ?? '', base);
    if (u) links.add(u);
  }

  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    if (images.size >= MAX_URLS) break;
    const tag = m[0];
    for (const key of IMG_SRC_ATTRS) {
      const v = attr(tag, key);
      const u = v ? resolveUrl(v, base) : null;
      if (u) images.add(u);
    }
    const set = attr(tag, 'srcset') ?? attr(tag, 'data-srcset');
    const u = set ? srcsetUrl(set, base) : null;
    if (u) images.add(u);
  }

  // og:image / twitter:image —— 分享卡片用的主图，通常就是页面里最该拿的那张。
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const prop = (attr(tag, 'property') ?? attr(tag, 'name') ?? '').toLowerCase();
    if (prop !== 'og:image' && prop !== 'og:image:url' && prop !== 'twitter:image') continue;
    const u = resolveUrl(attr(tag, 'content') ?? '', base);
    if (u) images.add(u);
  }

  // 内联样式里的 background-image:url(...)
  for (const m of html.matchAll(/background(?:-image)?\s*:\s*[^;"']*url\(([^)]+)\)/gi)) {
    if (images.size >= MAX_URLS) break;
    const u = resolveUrl(m[1], base);
    if (u) images.add(u);
  }

  const bare = scanBareUrls(html, base);
  for (const u of bare.images) images.add(u);
  for (const u of bare.links) if (links.size < MAX_URLS) links.add(u);

  return { links: [...links].slice(0, MAX_URLS), images: [...images].slice(0, MAX_URLS) };
}

/**
 * 从 markdown 里抽链接与图片。
 * r.jina.ai 这类渲染型代理回的是 markdown：图片是 ![alt](url)，链接是 [text](url)。
 * 之前代理这条路一条链接都不返回 —— 而直连几乎总是被 CORS 拦掉，等于联网全程瞎着。
 */
export function scanMarkdown(text: string, base: string): Scan {
  const images = new Set<string>();
  const links = new Set<string>();
  const imgRe = /!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g;

  for (const m of text.matchAll(imgRe)) {
    if (images.size >= MAX_URLS) break;
    const u = resolveUrl(m[1], base);
    if (u) images.add(u);
  }

  const rest = text.replace(imgRe, ' ');
  for (const m of rest.matchAll(/\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g)) {
    if (links.size >= MAX_URLS) break;
    const u = resolveUrl(m[1], base);
    if (u) links.add(u);
  }

  return { links: [...links], images: [...images] };
}

/** 兜底：正文里裸写的绝对 URL。JSON 接口、纯文本清单、markdown 漏网的都靠它。 */
export function scanBareUrls(text: string, base: string): Scan {
  const links = new Set<string>();
  const images = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]\\]+/g)) {
    const u = resolveUrl(m[0], base);
    if (!u) continue;
    if (IMAGE_EXT_RE.test(u)) images.add(u);
    else links.add(u);
    if (images.size >= MAX_URLS && links.size >= MAX_URLS) break;
  }
  return { links: [...links].slice(0, MAX_URLS), images: [...images].slice(0, MAX_URLS) };
}

function mergeScan(...scans: Scan[]): Scan {
  const links = new Set<string>();
  const images = new Set<string>();
  for (const s of scans) {
    for (const u of s.images) images.add(u);
    for (const u of s.links) links.add(u);
  }
  return { links: [...links].slice(0, MAX_URLS), images: [...images].slice(0, MAX_URLS) };
}

function clampChars(v: number | undefined): number {
  return Math.min(Math.max(v ?? DEFAULT_MAX_CHARS, 200), MAX_MAX_CHARS);
}

/** 直连抓取 HTML / JSON / 纯文本。跨域会被浏览器拦掉，所以调用方一般走 fetchWebSmart。 */
export async function fetchWeb(rawUrl: string, options: WebFetchOptions = {}): Promise<WebFetchResult> {
  const url = absUrl(rawUrl);
  const maxChars = clampChars(options.maxChars);

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
  const base = res.url || url.href;

  // 注意顺序：从**完整**正文里抽 URL，再裁正文。
  const scan = isHtml
    ? mergeScan(scanHtml(raw, base), scanMarkdown(raw, base))
    : mergeScan(scanMarkdown(raw, base), scanBareUrls(raw, base));

  const truncated = body.length > maxChars;
  return {
    url: url.href,
    finalUrl: base,
    status: res.status,
    contentType,
    title: isHtml ? titleOf(raw) : '',
    text: truncated ? body.slice(0, maxChars) : body,
    totalChars: body.length,
    truncated,
    links: scan.links,
    images: scan.images,
  };
}

/** 通过文本代理抓取，用于绕开 CORS。代理回的是 markdown，链接与图片照样能捞出来。 */
export async function fetchViaProxy(rawUrl: string, options: WebFetchOptions = {}): Promise<WebFetchResult> {
  const url = absUrl(rawUrl);
  const proxy = DEFAULT_PROXY + url.href;
  const maxChars = clampChars(options.maxChars);

  const res = await fetch(proxy, {
    method: 'GET',
    headers: { Accept: 'text/plain' },
    signal: options.signal,
  });
  const body = (await res.text()).trim();
  const truncated = body.length > maxChars;
  const scan = mergeScan(scanMarkdown(body, url.href), scanBareUrls(body, url.href));

  return {
    url: url.href,
    finalUrl: url.href,
    status: res.status,
    contentType: 'text/plain',
    title: '',
    text: truncated ? body.slice(0, maxChars) : body,
    totalChars: body.length,
    truncated,
    links: scan.links,
    images: scan.images,
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

/**
 * 抓图片：只验证可达性与尺寸，不把二进制塞进上下文。
 * 先试 HEAD（不下载正文），拿不到 content-type 再退回 GET。
 */
export async function probeImage(
  rawUrl: string,
  options: WebFetchOptions = {},
): Promise<{ url: string; status: number; contentType: string; bytes: number }> {
  const url = absUrl(rawUrl);

  const head = await fetch(url.href, { method: 'HEAD', signal: options.signal }).catch(() => null);
  const headType = head?.headers.get('content-type') ?? '';
  if (head && head.ok && headType) {
    const len = Number(head.headers.get('content-length') ?? '0');
    return {
      url: url.href,
      status: head.status,
      contentType: headType,
      bytes: Number.isFinite(len) && len > 0 ? len : 0,
    };
  }

  const res = await fetch(url.href, { method: 'GET', signal: options.signal });
  const blob = await res.blob().catch(() => null);
  return {
    url: url.href,
    status: res.status,
    contentType: res.headers.get('content-type') ?? blob?.type ?? '',
    bytes: blob?.size ?? 0,
  };
}

/**
 * 图片代理。
 *
 * 为什么要它：图片的字节只能用 fetch 读，而 fetch 跨域需要对方回 ACAO 头 ——
 * 大部分图床不给。所以直连失败时走一个图片代理（它会替我们取图并加上 CORS 头）。
 * 与文本代理（r.jina.ai）分开，因为文本代理回的是 markdown，拿不到图片字节。
 */
export const DEFAULT_IMAGE_PROXY = 'https://images.weserv.nl/?url=';

export interface ImageDataResult {
  url: string;
  finalUrl: string;
  contentType: string;
  bytes: number;
  /** data:image/...;base64,... —— 可以直接放进多模态消息。 */
  dataUrl: string;
  /** 原始字节。要给宿主做缩放时直接用，不必再解一遍 data URL。 */
  blob: Blob;
  via: 'direct' | 'proxy';
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  // 浏览器里 FileReader 最省事。
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  }
  // 没有 FileReader（Node / 测试环境）就自己拼 base64。
  // 分块是为了别把大图一次性铺开成参数列表（大数据量下 spread 会爆栈）。
  return blob
    .arrayBuffer()
    .then((ab) => {
      const bytes = new Uint8Array(ab);
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      if (typeof btoa !== 'function') return null;
      return 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + btoa(binary);
    })
    .catch(() => null);
}

/**
 * 把一张图片读成 data URL。
 *
 * 顺序：直连 → 图片代理。两边都失败就抛错（错误信息要能让 Agent 自己决定下一步）。
 * **不在这里做缩放**：缩放要用 canvas，那是宿主环境的事（见 host/image.ts），
 * 这一层只负责"把字节拿到手"。
 */
export async function fetchImageData(
  rawUrl: string,
  options: WebFetchOptions = {},
): Promise<ImageDataResult> {
  const url = absUrl(rawUrl);

  const attempt = async (target: string, via: 'direct' | 'proxy'): Promise<ImageDataResult | null> => {
    const res = await fetch(target, { method: 'GET', signal: options.signal });
    if (!res.ok) return null;
    const blob = await res.blob().catch(() => null);
    if (!blob) return null;
    const type = res.headers.get('content-type') ?? blob.type ?? '';
    if (!/^image\//i.test(type)) return null;
    const dataUrl = await blobToDataUrl(blob);
    if (!dataUrl) return null;
    return { url: url.href, finalUrl: target, contentType: type, bytes: blob.size, dataUrl, blob, via };
  };

  const direct = await attempt(url.href, 'direct').catch(() => null);
  if (direct) return direct;

  // 代理要去掉协议前缀（weserv 的约定是 ?url=host/path）。
  const proxied = await attempt(
    DEFAULT_IMAGE_PROXY + encodeURIComponent(url.href.replace(/^https?:\/\//, '')),
    'proxy',
  ).catch(() => null);
  if (proxied) return proxied;

  throw new Error(
    '读不到这张图的字节：直连被 CORS 拦、图片代理也没成功。' +
      '可以改用 fetch_image 确认它可达，把直链写进组件的 <img src> 让用户看到；' +
      '或换一张允许跨域读取的图（很多图床 / wiki / github 的图都可以）。',
  );
}
