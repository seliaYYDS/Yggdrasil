/**
 * 文本统计。**这是一个"工具"形态的插件能力**（exposeAs: "tool"）：
 * Agent 在 ## Available tools 里看到它，用 call_tool 调 —— 与内置的 calc / now 完全同列。
 *
 * 它不需要网络，所以 cap 是 null（任何 Agent 都能用，不管开没开 net）。
 */
async (args, ctx) => {
  const text = String(args.text || '');
  if (!text.trim()) throw new Error('text 是空的 —— 给我一段要统计的文字。');
  const top = Math.max(1, Math.min(20, Number(args.top) || 5));

  const chars = text.length;
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '').length;
  // 英文按空白切；中文没有空格，所以同时统计 CJK 字符数，否则中文会被算成"1 个词"。
  const cjk = (text.match(/[\u3000-\u9fff]/g) || []).length;
  const words = text.split(/\s+/).filter((w) => w !== '');
  const freq = new Map();
  for (const w of words) {
    const key = w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!key) continue;
    freq.set(key, (freq.get(key) || 0) + 1);
  }
  const frequent = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([word, count]) => ({ word, count }));
  ctx.log('统计 ' + chars + ' 字符 / ' + words.length + ' 词');
  return { chars, lines, cjkChars: cjk, words: words.length, uniqueWords: freq.size, frequentWords: frequent };
}
