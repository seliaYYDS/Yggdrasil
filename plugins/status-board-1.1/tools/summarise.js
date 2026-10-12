/**
 * 统计数据。**这是插件里的 js 工具**：一个函数表达式，在 Worker 里执行。
 *
 * 能拿到的东西：
 *   args   模型给的参数（按清单里的 params 校验过）
 *   ctx.fields  用户在插件面板填的值（这里是 greeting）
 *   ctx.log()   写一行日志，会跟结果一起回给模型
 *   ctx.fetch() 唯一的网络出口，主机由主线程按白名单把关（这个工具不需要网络）
 */
async (args, ctx) => {
  // 注意：Number('') 是 0，所以必须先滤掉空串，否则 "3, 8, 12, x" 会多算一个 0。
  const nums = String(args.numbers || '')
    .split(/[^0-9.\-]+/)
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x));
  if (nums.length === 0) throw new Error('没解析出任何数字');
  const sum = nums.reduce((a, b) => a + b, 0);
  const min = Math.min.apply(null, nums);
  const max = Math.max.apply(null, nums);
  ctx.log('解析出 ' + nums.length + ' 个数字');
  return {
    count: nums.length,
    sum: Math.round(sum * 100) / 100,
    min,
    max,
    average: Math.round((sum / nums.length) * 100) / 100,
    sentence: '共 ' + nums.length + ' 个数，合计 ' + Math.round(sum * 100) / 100 + '，平均 ' + Math.round((sum / nums.length) * 100) / 100 + '。',
    title: ctx.fields.greeting || '',
  };
}
