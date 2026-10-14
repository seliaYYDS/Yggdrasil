/**
 * CSV / TSV → JSON。**真正难的不是"按逗号切"**（那个模型会做），
 * 而是带引号的字段：字段里可以有分隔符、可以有换行，\"\" 表示一个引号字符。
 * 按逗号硬切在这种表上会整行错位，而模型很难自己发现切错了。
 *
 * 分隔符不写就自动猜（逗号 / 制表 / 分号 / 竖线），按"引号外的出现次数"投票。
 */
async (args, ctx) => {
  const text = String(args.csv ?? '');
  if (!text.trim()) throw new Error('csv 是空的。');

  const CANDIDATES = [',', '\t', ';', '|'];
  /** 在**引号之外**数分隔符：引号里的逗号不算。 */
  const countOutsideQuotes = (line, ch) => {
    let n = 0, inQ = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (c === '"') { if (inQ && line[i + 1] === '"') i += 1; else inQ = !inQ; }
      else if (!inQ && c === ch) n += 1;
    }
    return n;
  };
  const firstLine = text.split(/\r?\n/)[0] || '';
  const explicit = args.delimiter === undefined ? '' : String(args.delimiter);
  let delim = explicit;
  if (!delim || delim === 'auto') {
    let best = ',', bestCount = 0;
    for (const c of CANDIDATES) {
      const n = countOutsideQuotes(firstLine, c);
      if (n > bestCount) { best = c; bestCount = n; }
    }
    delim = bestCount > 0 ? best : ',';
  }
  if (delim === '\\t' || delim === 'tab') delim = '\t';

  // 状态机解析：跨行的引号字段要能正确接起来。
  const rows = [];
  let row = [], field = '', inQ = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"' && field === '') { inQ = true; i += 1; continue; }
    if (c === delim) { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r') { i += 1; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += c; i += 1;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every((x) => x === '')) rows.pop();

  if (rows.length === 0) throw new Error('没解析出任何行。');
  const hasHeader = args.header === undefined ? true : !/^(false|0|no|off)$/i.test(String(args.header));
  const limit = Math.min(500, Math.max(1, Number(args.limit) || 100));

  const columns = hasHeader ? rows[0] : rows[0].map((_, k) => 'col' + (k + 1));
  const body = hasHeader ? rows.slice(1) : rows;
  const width = columns.length;
  let ragged = 0;
  const outRows = [];
  for (const r of body) {
    if (r.length !== width) ragged += 1;
    const obj = {};
    for (let k = 0; k < width; k += 1) obj[columns[k]] = r[k] === undefined ? null : r[k];
    outRows.push(obj);
  }

  const out = {
    delimiter: delim === '\t' ? '\\t (tab)' : delim,
    columns,
    rowCount: outRows.length,
    rows: outRows.slice(0, limit),
  };
  if (outRows.length > limit) out.note = '只返回前 ' + limit + ' 行（共 ' + outRows.length + ' 行）。';
  if (ragged) out.raggedRows = ragged + ' 行的列数与表头不一致（缺失的补了 null）—— 通常意味着分隔符猜错了或引号没闭合。';
  ctx.log(columns.length + ' 列 × ' + outRows.length + ' 行');
  return out;
}
