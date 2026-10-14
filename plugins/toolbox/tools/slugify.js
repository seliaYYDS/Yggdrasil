/** 把标题转成 URL / id 安全的短名。工具形态，无网络。 */
async (args) => {
  const raw = String(args.title || '').trim();
  if (!raw) throw new Error('title 是空的。');
  // 非 ASCII（中文等）没法直接转写，**不猜拼音** —— 那样结果是编出来的。
  const slug = raw.toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    return { slug: '', note: '这段标题里没有可用的 ASCII 字符（中文标题转不出短名）。请自己起一个英文短名，不要让我猜拼音。' };
  }
  return { slug, length: slug.length };
}
