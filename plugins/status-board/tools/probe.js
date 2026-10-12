/** 联网探活：唯一出口是 ctx.fetch（主线程按白名单校验），这里打的是 GitHub 的限流接口。 */
async (args, ctx) => {
  const started = Date.now();
  const res = await ctx.fetch('https://api.github.com/rate_limit', {
    headers: { accept: 'application/vnd.github+json' },
  });
  const ms = Date.now() - started;
  let remaining = null;
  try { remaining = JSON.parse(res.text).resources.core.remaining; } catch (e) { /* 不是 JSON 就算了 */ }
  ctx.log('HTTP ' + res.status + ' in ' + ms + 'ms');
  return { ms, status: res.status, remaining };
}
