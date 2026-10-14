/**
 * 数值统计。**Agent 真正缺的一类**：内置 calc 只能算"一个算式"，
 * 而它经常需要"这批数的中位数/标准差/p95 是多少" —— 让模型自己心算这些数字极易出错，
 * 而用 create_tool 现写一个又要多花两轮。
 *
 * 参数以**字符串**到达（沙箱契约），所以统一先切分再转数。
 * 明确返回总体与样本两个标准差，避免那个经典的"除以 n 还是 n-1"歧义。
 */
async (args, ctx) => {
  const raw = String(args.values || '');
  if (!raw.trim()) throw new Error('values 是空的 —— 给我一串数字，逗号/空格/换行分隔都行。');
  const tokens = raw.split(/[,\s;，、]+/).filter((x) => x !== '');
  const nums = [];
  const ignored = [];
  for (const t of tokens) {
    const n = Number(t);
    if (Number.isFinite(n)) nums.push(n);
    else ignored.push(t);
  }
  if (nums.length === 0) throw new Error('没解析出任何数字（收到：' + tokens.slice(0, 8).join(', ') + '）。');

  const sorted = nums.slice().sort((a, b) => a - b);
  const n = nums.length;
  const sum = nums.reduce((a, b) => a + b, 0);
  const mean = sum / n;

  /** 线性插值分位数（与 numpy 默认一致）—— 不是"取第 k 个"，那在偶数个样本上是错的。 */
  const quantile = (q) => {
    if (n === 1) return sorted[0];
    const pos = (n - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  };
  const variance = (sample) => {
    if (n < 2) return 0;
    const d = nums.reduce((a, b) => a + (b - mean) * (b - mean), 0);
    return d / (sample ? n - 1 : n);
  };
  const round = (x) => Math.round(x * 1e6) / 1e6;
  const p = (q) => round(quantile(q));

  ctx.log(n + ' 个数；均值 ' + round(mean));
  return {
    count: n,
    sum: round(sum),
    min: sorted[0],
    max: sorted[n - 1],
    range: round(sorted[n - 1] - sorted[0]),
    mean: round(mean),
    median: p(0.5),
    stddev: round(Math.sqrt(variance(false))),
    stddevSample: round(Math.sqrt(variance(true))),
    percentiles: { p25: p(0.25), p50: p(0.5), p75: p(0.75), p90: p(0.9), p95: p(0.95), p99: p(0.99) },
    // 四分位距：比"最大最小"更能说明离散程度，也常被拿来找离群点。
    iqr: round(p(0.75) - p(0.25)),
    ...(ignored.length ? { ignored: ignored.slice(0, 10) } : {}),
  };
}
