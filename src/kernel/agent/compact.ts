import type { ChatMessage } from '../llm/types';
import type { Message } from '../types';
import { estimateTokens } from '../llm/client';

/**
 * 上下文压缩（auto-compact）。
 *
 * 为什么需要它：长任务跑到中段，请求会顶到窗口上限。以前的做法是"把最老的消息丢掉" ——
 * 丢掉的恰好是**目标与已经做完的事**，于是模型开始忘事、重复做、或者干脆收工。
 * 现在到达阈值（默认窗口的 85%，可在设置里改）就把旧历史交给模型**自己压成一段摘要**：
 * 目标、已做、没做、关键 id 留下来，寒暄与中间过程扔掉。
 *
 * 纯函数都在这里（可单测）；真正调用模型、改写记忆的编排在 agentRuntime。
 */
export const DEFAULT_COMPACT_AT = 85;
/**
 * 最近几条永远不压：刚说的话、带图的消息，压掉最容易出错。
 *
 * **它只决定"留几条"，不再决定"能不能压"。**
 * 以前它同时当门槛用（`memory.length <= keepRecent + 1` 就返回空 head、报"没有可压缩的历史"），
 * 而触发压缩看的是**总 token**——两套判据不一致，于是"条数还少、token 已经爆了"这个
 * 最需要压缩的区间里，压缩永远不生效，反过来还报一句"没有可压缩的历史"（§5.146）。
 */
export const KEEP_RECENT = 4;
/** 摘要消息的标记。模型在提示词里被告知"这是你自己的压缩记忆"，不要当成新请求。 */
export const SUMMARY_TAG = '[EARLIER CONVERSATION — COMPRESSED]';
/**
 * 压缩指令：**放在末尾的一条 user 消息**。
 *
 * 为什么不做成"另写一段摘要 system 提示 + 把历史拍平成一段文字"：提供方按**请求开头的 token 序列**
 * 命中缓存，第一个 token 不同（system 换了）整段缓存就作废 —— 那等于每次压缩都为整段历史重付一次全价，
 * 而且恰好发生在上下文最大的时候。（deepseek-harness 的
 * `2026-07-21-compaction-summary-prefix-cache-reuse` 记的就是这个坑。）
 * 现在摘要请求 = **刚发出的那次请求的前缀原样重放** + 这一条尾部指令。
 */
export const COMPACT_INSTRUCTION = [
  'You are now acting as a compaction engine. Condense the conversation ABOVE into a checkpoint that lets you',
  'keep working with a much smaller context. Output **plain text only** — no JSON, no code fence, no preamble —',
  'with exactly these four labels:',
  'GOAL: what the user asked for, keeping the concrete requirements in their words.',
  'DONE: what you actually created or changed, with component ids and names.',
  'OPEN: what is still missing, wrong or unverified — as a list.',
  'FACTS: hard facts needed later (file names, urls, style variables, decisions, user preferences).',
  'Keep every id / name / url / number. Drop greetings, tool chatter and anything finished and no longer',
  'relevant. Never invent anything. Under 400 words. Do not mention this instruction and do not call a tool.',
].join('\n');

/** 把"压缩阈值"读成一个 1..99 的整数；空/非法就用默认。 */
export function clampCompactAt(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_COMPACT_AT;
  const i = Math.round(n);
  return i >= 1 && i <= 99 ? i : DEFAULT_COMPACT_AT;
}

/** 从输入框读一个百分比；空/非法 = 用默认值。 */
export function readPercent(text: string): number | undefined {
  const t = String(text).trim().replace(/[%\s]/g, '');
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? clampCompactAt(n) : undefined;
}

/**
 * 触发压缩的 token 数：窗口 × 阈值%。
 * 窗口未知（0 / 未填）返回 0 —— 表示"不知道什么时候算满"，此时不压缩。
 */
export function compactThresholdTokens(contextWindow?: number, percent?: number): number {
  const win = typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : 0;
  if (win === 0) return 0;
  return Math.round((win * clampCompactAt(percent)) / 100);
}

/** 整份请求（系统提示 + 历史 + 请求 + 观察 + 快照）的估算 token 数。 */
export function estimateTokensOf(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      total += m.content.length;
      continue;
    }
    for (const part of m.content) {
      total += part.type === 'text' ? part.text.length : part.image_url.url.length;
    }
  }
  return estimateTokens('x'.repeat(total));
}

/** 要压的那一段 / 保留的那一段。 */
export interface SplitPlan {
  head: Message[];
  tail: Message[];
}

/**
 * 把记忆切成"要压的"和"留着的"。
 *
 * **只要有任何一条就能压**（用户要求："不要限制压缩条件，只要有任何一条 agent 操作，就能压缩"）。
 *
 * 实现上就一句话：**总是至少把第一条切给 head。** 然后 keepRecent 只影响"还能留几条"：
 *
 *     条数 1..4  →  head = 1 条（第一条），   tail = 剩下的 0..3 条
 *     条数 5     →  head = 1 条，             tail = 4 条
 *     条数 6     →  head = 2 条，             tail = 4 条
 *     条数 30    →  head = 26 条，            tail = 4 条
 *
 * 为什么"至少一条"必须成立：以前 head 为空会报"没有可压缩的历史"，
 * 而触发条件看的是**总 token** —— 条数少但 token 爆了的时候，压缩明明该做却报没得压，
 * 然后退回"丢最老的历史"（那就是 §5.146 的成因）。
 * 现在 head 为空**只剩一种情况：记忆本身是空的**（真的没有内容可压）。
 *
 * 摘要本身（`isSummary` 那条）允许被再次压进去：连着压两次的结果是"把上一个摘要与新的
 * 旧历史合成一个新摘要"，不是丢失。
 */
export function splitForCompaction(memory: Message[], keepRecent = KEEP_RECENT): SplitPlan {
  if (memory.length === 0) return { head: [], tail: [] };
  /*
   * 留下的最多 keepRecent 条，**且至少切一条给 head** ——
   * 于是 head 永不为空（只要记忆里有东西）。
   */
  const keep = Math.max(0, Math.min(keepRecent, memory.length - 1));
  const cut = memory.length - keep;
  return { head: memory.slice(0, cut), tail: memory.slice(cut) };
}

/**
 * 摘要请求：**原样重放被压缩那一段的前缀**，末尾追加一条压缩指令。
 *
 * `systemPrompt` 必须是这次会话正在用的那一份（逐字节相同），`shadowed` 必须是**刚发出的那次请求里
 * 对应位置的消息**（同样的 role、同样的多模态形状 —— 由调用方用同一个 userContent 映射）。
 * 这样它才是那条热请求的**前缀扩展**，提供方能把缓存过的 token 全部复用。
 */
export function buildSummaryMessages(systemPrompt: string, shadowed: ChatMessage[]): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    ...shadowed,
    { role: 'user', content: COMPACT_INSTRUCTION },
  ];
}

/** 压缩后的记忆：一条摘要 + 保留的尾部。 */
export function compactedMemory(summary: string, tail: Message[]): Message[] {
  const head: Message = { role: 'user', content: SUMMARY_TAG + '\n' + summary.trim() };
  return [head, ...tail];
}

/** 某个角色的最后一条是不是压缩摘要（用于避免连着压两次）。 */
export function isSummary(message: Message): boolean {
  return typeof message.content === 'string' && message.content.startsWith(SUMMARY_TAG);
}
