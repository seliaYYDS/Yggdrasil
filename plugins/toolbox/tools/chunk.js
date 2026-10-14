/** 把一串东西切成若干块。工具形态，无网络。 */
async (args) => {
  const items = String(args.items || '').split(',').map((x) => x.trim()).filter((x) => x !== '');
  const size = Math.max(1, Math.min(50, Number(args.size) || 3));
  if (items.length === 0) throw new Error('items 是空的 —— 用逗号分隔。');
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return { total: items.length, size, chunks, chunkCount: chunks.length };
}
