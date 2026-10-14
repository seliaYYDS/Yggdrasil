/**
 * 逐行 diff。**为什么需要**：patch_source 那类操作要求"只改这几行"，
 * 而模型"自己指出改了哪几行"经常数错 —— 先算一遍，再照着结果写补丁，稳得多。
 *
 * 输出是 unified diff 的骨架（带 @@ 头与上下文行），并给出新增/删除行数。
 * 中间段太大时（> 2M 格）不做精确 LCS，如实说明并退回"公共前后缀"的结论 —— 不假装算过。
 */
async (args, ctx) => {
  const before = String(args.before ?? '');
  const after = String(args.after ?? '');
  const context = Math.min(20, Math.max(0, Number(args.context) || 2));
  const A = before.split(/\r?\n/);
  const B = after.split(/\r?\n/);

  // 先剥掉公共前后缀：真实补丁绝大多数改动都集中在中间一小段，这样 DP 的规模常常小几个数量级。
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head += 1;
  let tail = 0;
  while (
    tail < A.length - head && tail < B.length - head &&
    A[A.length - 1 - tail] === B[B.length - 1 - tail]
  ) tail += 1;

  const midA = A.slice(head, A.length - tail);
  const midB = B.slice(head, B.length - tail);
  if (midA.length === 0 && midB.length === 0) {
    return { identical: true, added: 0, removed: 0, lines: A.length, message: '两段完全一样。' };
  }

  const CELLS = midA.length * midB.length;
  if (CELLS > 2000000) {
    return {
      identical: false,
      added: midB.length,
      removed: midA.length,
      // 如实说明"没有精确算"：假装给了精确 hunk 比不给更糟。
      note: '中间段太大（' + midA.length + ' x ' + midB.length + ' 行）没做精确 LCS。' +
        '公共前 ' + head + ' 行、后 ' + tail + ' 行未变；中间整体视为全部改写。',
      changedRange: { firstChangedLine: head + 1, beforeLines: midA.length, afterLines: midB.length },
    };
  }

  // 经典 LCS 长度表 + 回溯。规模已被上面的上限挡住。
  const dp = [];
  for (let i = 0; i <= midA.length; i += 1) dp.push(new Array(midB.length + 1).fill(0));
  for (let i = midA.length - 1; i >= 0; i -= 1) {
    for (let j = midB.length - 1; j >= 0; j -= 1) {
      dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) { ops.push([' ', midA[i]]); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', midA[i]]); i += 1; }
    else { ops.push(['+', midB[j]]); j += 1; }
  }
  while (i < midA.length) { ops.push(['-', midA[i]]); i += 1; }
  while (j < midB.length) { ops.push(['+', midB[j]]); j += 1; }

  const added = ops.filter((o) => o[0] === '+').length;
  const removed = ops.filter((o) => o[0] === '-').length;

  // 只保留"改动附近 context 行"的内容：整段贴回去对长文件没有意义。
  const keep = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k += 1) {
    if (ops[k][0] === ' ') continue;
    for (let d = -context; d <= context; d += 1) if (k + d >= 0 && k + d < ops.length) keep[k + d] = true;
  }
  const lines = [];
  let skipped = 0;
  for (let k = 0; k < ops.length; k += 1) {
    if (keep[k]) {
      if (skipped > 0) { lines.push('... (' + skipped + ' 行未变)'); skipped = 0; }
      lines.push(ops[k][0] + ops[k][1]);
    } else skipped += 1;
  }
  if (skipped > 0) lines.push('... (' + skipped + ' 行未变)');

  ctx.log('+' + added + ' / -' + removed);
  return {
    identical: false,
    added,
    removed,
    contextLines: context,
    head: { aStart: 1, bStart: 1, unchanged: head },
    tail: { unchanged: tail },
    diff: lines.join('\n'),
  };
}
