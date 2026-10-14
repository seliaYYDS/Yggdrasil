/**
 * 层层解码。**这是处理 API 时最常见的坑**：返回的 JSON 里套着一段被转义的 JSON 字符串，
 * 再套一层 URL 编码 —— 模型看到的是 \"{\\\"a\\\":1}\" 这种东西，靠肉眼剥很容易剥错一层。
 *
 * 每剥一层都记下"这层是什么、剥完变成什么"，所以你能看出它到底被包了几层、每层是什么类型。
 */
async (args, ctx) => {
  const ENTITIES = [
    ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&apos;', "'"], ['&nbsp;', ' '],
  ];
  const decodeHtml = (s) => {
    let out = s;
    for (const [a, b] of ENTITIES) out = out.split(a).join(b);
    // 数字实体：&#123; 与 &#x1F600;
    out = out.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
    out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
    return out;
  };
  const hasEntity = (s) => /&(amp|lt|gt|quot|#39|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/.test(s);

  /**
   * 试剥一层。返回 null 表示"这层剥不出来"。
   * 顺序有意如此：JSON 字符串包在最外面（\"…\"），而 URL 编码往往在最里层。
   */
  const tryOne = (s) => {
    const t = s.trim();
    // ① JSON 字符串字面量：带引号且解析出来还是字符串（不是对象）。
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
      try {
        const v = JSON.parse(t);
        if (typeof v === 'string' && v !== s) return { kind: 'json-string', value: v };
      } catch (e) { /* 不是合法 JSON 字符串，往下试 */ }
    }
    /*
     * 这里**故意没有**"把 JSON 重新格式化"这一步。
     * 那不是在解码 —— 它只是把同样的数据换个排版写一遍，会让 layers 里多出一条
     * 什么都没解出来的记录，反而掩盖"到底被包了三层还是两层"。
     * 要读结构用 json_query。
     */
    // ③ \uXXXX / \n 这类转义序列（不在 JSON 引号里的时候也会遇到）。
    if (/\\u[0-9a-fA-F]{4}|\\[nrt"\\/]/.test(s)) {
      try {
        const v = JSON.parse('"' + s.replace(/"/g, '\\"') + '"');
        if (typeof v === 'string' && v !== s) return { kind: 'js-escapes', value: v };
      } catch (e) { /* 忽略 */ }
    }
    // ④ URL 编码：必须有 %XX 才算，否则 decodeURIComponent 会把 "+" 之类误改。
    if (/%[0-9a-fA-F]{2}/.test(s)) {
      try {
        const v = decodeURIComponent(s);
        if (v !== s) return { kind: 'url', value: v };
      } catch (e) { /* 不完整的百分号序列，忽略 */ }
    }
    // ⑤ HTML 实体
    if (hasEntity(s)) {
      const v = decodeHtml(s);
      if (v !== s) return { kind: 'html-entities', value: v };
    }
    return null;
  };

  const start = String(args.text ?? '');
  if (!start) throw new Error('text 是空的。');
  const maxDepth = Math.min(10, Math.max(1, Number(args.maxDepth) || 5));

  const layers = [];
  let cur = start;
  for (let d = 0; d < maxDepth; d += 1) {
    const step = tryOne(cur);
    if (!step) break;
    cur = step.value;
    layers.push({ layer: layers.length + 1, kind: step.kind, preview: cur.length > 200 ? cur.slice(0, 200) + '…' : cur });
  }

  const out = {
    layers: layers.length,
    steps: layers,
    final: cur.length > 4000 ? cur.slice(0, 4000) + '\n… (还有 ' + (cur.length - 4000) + ' 字符，用 maxDepth 或先截断再看)' : cur,
  };
  if (layers.length === 0) out.note = '没有发现需要解码的层 —— 这段文本本来就是明文，或者它的编码方式不在支持列表里（json-string / js-escapes / url / html-entities）。';
  // base64 只**提示**、不自动剥：一个恰好合法的 base64 可能解出乱码，那比不剥更糟。
  if (/^[A-Za-z0-9+/=\s]{16,}$/.test(start.trim())) {
    out.hint = '这段看起来也可能是 base64。用 encode 的 op=base64_decode 试，不要在这一层自动剥。';
  }
  ctx.log('剥了 ' + layers.length + ' 层');
  return out;
}
