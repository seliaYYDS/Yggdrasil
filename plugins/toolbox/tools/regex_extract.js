/**
 * 正则提取。**这是模型最容易出错、又最常需要的一步**：
 * 让它"从这 5KB 日志里把所有的 request id 找出来"，它要么漏、要么编。
 * 正则交给引擎执行，结果逐条列出来，它只需要用。
 *
 * 强制带上 g（一次给全部匹配）—— 只给第一个匹配对"提取"这个用途几乎总是错的。
 */
async (args, ctx) => {
  const text = String(args.text ?? '');
  const pattern = String(args.pattern || '');
  if (!pattern) throw new Error('pattern 是空的 —— 给我一个正则（不含两边的斜杠）。');
  if (!text) throw new Error('text 是空的。');
  if (text.length > 200000) throw new Error('text 太长（' + text.length + ' 字符，上限 200000）。先切一段再提。');

  const flagsRaw = String(args.flags ?? '');
  // 只保留合法的、且**必须含 g**：不带 g 的 exec 只会给第一个匹配。
  const flags = [...new Set((flagsRaw.replace(/[^gimsuy]/g, '') + 'g').split(''))].join('');
  const limit = Math.min(500, Math.max(1, Number(args.limit) || 100));
  const wantGroup = args.group === undefined || args.group === '' ? null : String(args.group);

  let re;
  try { re = new RegExp(pattern, flags); }
  catch (e) { throw new Error('正则编译失败：' + e.message + '（pattern = ' + pattern + '）'); }

  const matches = [];
  let m;
  let truncated = false;
  while ((m = re.exec(text)) !== null) {
    const groups = m.length > 1 ? m.slice(1) : [];
    matches.push({
      match: m[0],
      index: m.index,
      ...(groups.length ? { groups } : {}),
      ...(m.groups && Object.keys(m.groups).length ? { named: m.groups } : {}),
    });
    if (matches.length >= limit) { truncated = true; break; }
    // 空匹配（如 \b 或 a*）必须手动推进，否则 lastIndex 不动、无限循环。
    if (m[0] === '') re.lastIndex += 1;
  }

  const out = { count: matches.length, matches };
  if (truncated) out.note = '只返回了前 ' + limit + ' 个匹配（还有更多）。缩小 pattern 或加 limit。';
  if (matches.length === 0) out.note = '一个都没匹配到。检查 pattern 是否被 JSON 转义过（\\d 写成 d 是常见错误）。';

  // 指定 group 时额外给一列扁平结果 —— "把所有 id 列出来"才是最常见的用途。
  if (wantGroup !== null && matches.length) {
    const asIndex = /^\d+$/.test(wantGroup) ? Number(wantGroup) : null;
    out.picked = matches.map((x) => {
      if (asIndex !== null) return x.groups ? x.groups[asIndex - 1] : undefined;
      return x.named ? x.named[wantGroup] : undefined;
    });
  }
  ctx.log('匹配 ' + out.count + ' 条');
  return out;
}
