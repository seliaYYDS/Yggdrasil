/**
 * 从 JSON 里按路径取值。**为什么需要**：一次 API 返回动辄十几 KB，
 * 整个塞进上下文既贵又容易看错；而模型"自己从一大段 JSON 里读数"正是它最容易出错的地方。
 *
 * 路径写法与插件的声明式端点 pick 完全一致（同一套语义，学一次两边都会用）：
 *   data.items[].name      数组里每一项的 name
 *   meta.total             普通字段
 *   0.results[].url        以数组下标开头也可以
 *
 * 参数可以直接给对象（不用先自己转成字符串）—— 见 collectParams 的 allowStructured。
 */
async (args, ctx) => {
  let data;
  const rawJson = args.json;
  if (rawJson === undefined || rawJson === null || rawJson === '') throw new Error('json 是空的。');
  if (typeof rawJson === 'string') {
    try { data = JSON.parse(rawJson); }
    catch (e) { throw new Error('json 解析失败：' + e.message + '（前 120 字符：' + rawJson.slice(0, 120) + '）'); }
  } else {
    data = rawJson;
  }

  const pathsRaw = String(args.path ?? '');
  if (!pathsRaw.trim()) throw new Error('path 是空的 —— 给我要取的字段路径，每行一个（例如 data.items[].name）。');
  const paths = pathsRaw.split(/[\n,]+/).map((x) => x.trim()).filter((x) => x !== '');
  const maxItems = Math.min(50, Math.max(1, Number(args.maxItems) || 10));

  /** 按点路径取；段末尾加 [] 表示"这是个数组，对每一项继续走"。与 runtime 的 pickPaths 同一套规则。 */
  const walk = (value, segs) => {
    if (segs.length === 0) return value;
    const head = segs[0];
    const rest = segs.slice(1);
    const isMap = head.endsWith('[]');
    const key = isMap ? head.slice(0, -2) : head;
    let next;
    if (key === '') next = value;
    else if (Array.isArray(value) && /^\d+$/.test(key)) next = value[Number(key)];
    else next = value && typeof value === 'object' ? value[key] : undefined;
    if (isMap) {
      if (!Array.isArray(next)) return [];
      return next.slice(0, maxItems).map((item) => walk(item, rest));
    }
    return walk(next, rest);
  };

  const picked = {};
  for (const p of paths) picked[p] = walk(data, p.split('.'));

  /*
   * 区分"确实为空"与"路径写错了"。
   * 这两种情况在回读里长得一样，而结论完全不同（"接口没数据" vs "我取错字段了"）——
   * 这正是声明式端点那边踩过的坑，这里沿用同样的提醒。
   */
  const values = Object.values(picked);
  const allEmpty = values.length > 0 && values.every((v) => v === undefined || (Array.isArray(v) && v.length === 0));
  const out = { picked };
  if (allEmpty) {
    const top = Array.isArray(data) ? '[array of ' + data.length + ']' : Object.keys(data || {}).slice(0, 20);
    out.note = '这些路径一个都没取到值。**顶层真实的键**是：' + JSON.stringify(top) +
      '。对照它们检查路径（数组段要写成 items[]、不是 items）。';
  }
  ctx.log('取 ' + paths.length + ' 条路径');
  return out;
}
