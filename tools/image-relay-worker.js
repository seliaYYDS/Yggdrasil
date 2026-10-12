/**
 * Yggdrasil 图片中转（可选，自建）—— 用来绕开浏览器的跨域读图限制。
 *
 * 为什么要它：跨域读取是**浏览器的硬规则**，页面里没有开关能绕（no-cors 只能发不能读；
 * 跨域图画进 canvas 会污染，toDataURL 直接抛）。想让图片"一定能读"，
 * 只能让页面之外的一方替你取字节 —— 就是这个小服务。
 *
 * 它**只做一件事**：把 ?url= 指向的字节取回来，补上 CORS 响应头，交还给页面。
 * 不存储、不识别、不解析内容。
 *
 * 部署（Cloudflare Workers，免费额度足够）：
 *   1. dash.cloudflare.com -> Workers & Pages -> Create -> Worker
 *   2. 把本文件内容粘进去（把 ALLOW_FROM 改成你自己的来源）-> Deploy
 *   3. 复制它的地址，填进 Yggdrasil 设置里的「图片中转」，建议写成：
 *        https://你的域名/?url={url}
 *      （{url} 会被替换成编码后的图片地址；不写占位符则拼在末尾）
 *
 * 安全（**必读**，否则你会得到一个被人白用的开放代理）：
 *   - 把 ALLOW_FROM 改成你自己的来源；默认的 * 只适合本机临时用。
 *   - BLOCK_HOSTS 拦掉内网与本地地址，避免被拿去做 SSRF 探测。
 *   - 只允许 image/* 类型，别让它变成万能代理。
 */

const ALLOW_FROM = '*'; // 例：'http://127.0.0.1:19387'
const MAX_BYTES = 20 * 1024 * 1024; // 超过就不转，防止被当图床刷流量

// 内网 / 本地地址一律拒绝（SSRF 防护）
const BLOCK_HOSTS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
];

function cors(extra = {}) {
  return {
    'access-control-allow-origin': ALLOW_FROM,
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,HEAD,OPTIONS',
    ...extra,
  };
}

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const target = new URL(req.url).searchParams.get('url');
    if (!target) return new Response('missing ?url=', { status: 400, headers: cors() });

    let u;
    try {
      u = new URL(target);
    } catch {
      return new Response('bad url', { status: 400, headers: cors() });
    }
    if (!/^https?:$/.test(u.protocol) || BLOCK_HOSTS.some((re) => re.test(u.hostname))) {
      return new Response('blocked host', { status: 403, headers: cors() });
    }

    let upstream;
    try {
      upstream = await fetch(u.href, {
        headers: { 'user-agent': 'Mozilla/5.0 (Yggdrasil image relay)', accept: 'image/*,*/*;q=0.8' },
        redirect: 'follow',
      });
    } catch (e) {
      return new Response('upstream failed: ' + e.message, { status: 502, headers: cors() });
    }

    const type = upstream.headers.get('content-type') ?? '';
    if (!/^image\//i.test(type)) {
      return new Response('not an image: ' + type, { status: 415, headers: cors() });
    }
    const len = Number(upstream.headers.get('content-length') ?? '0');
    if (len > MAX_BYTES) return new Response('too large', { status: 413, headers: cors() });

    return new Response(upstream.body, {
      status: 200,
      headers: cors({ 'content-type': type, 'cache-control': 'public, max-age=3600' }),
    });
  },
};
