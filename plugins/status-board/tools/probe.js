/** 联网探活：唯一出口是 ctx.fetch（主线程按白名单校验）。 */
async (args, ctx) => {
  const started = Date.now();
  const res = await ctx.fetch('https://httpbin.org/delay/1');
  const ms = Date.now() - started;
  ctx.log('HTTP ' + res.status + ' in ' + ms + 'ms');
  return { ms, status: res.status, bytes: String(res.text || '').length };
}
