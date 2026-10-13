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
/** 最近几条永远不压：刚说的话、带图的消息，压掉最容易出错。 */
export const KEEP_RECENT = 4;
/** 摘要消息的标记。模型在提示词里被告知"这是你自己的压缩记忆"，不要当成新请求。 */
export const SUMMARY_TAG = '[EARLIER CONVERSATION — COMPRESSED]';
/** 给摘要模型的输入上限（字符）：压缩自身也不能顶爆窗口。 */
const TRANSCRIPT_MAX_CHARS = 48000;
const PER_MESSAGE_MAX_CHARS = 1500;

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

/** 要压的那一段 / 保留的那一段。头部为空表示"没什么可压的"。 */
export interface SplitPlan {
  head: Message[];
  tail: Message[];
}

export function splitForCompaction(memory: Message[], keepRecent = KEEP_RECENT): SplitPlan {
  if (memory.length <= keepRecent + 1) return { head: [], tail: memory.slice() };
  const cut = memory.length - keepRecent;
  return { head: memory.slice(0, cut), tail: memory.slice(cut) };
}

function renderOne(m: Message): string {
  const who = m.role === 'assistant' ? 'ASSISTANT' : 'USER';
  // 记忆里的图片挂在 images 上（content 永远是文本）；摘要里只要知道"这里有过图"。
  const text = m.content + (m.images && m.images.length > 0 ? ' [image x' + m.images.length + ']' : '');
  const capped = text.length > PER_MESSAGE_MAX_CHARS ? text.slice(0, PER_MESSAGE_MAX_CHARS) + ' …' : text;
  return who + ': ' + capped;
}

/**
 * 把要压缩的消息渲染成一段文字给摘要模型。
 *
 * 从**最新**往回取：太老的内容本来就是要丢掉的，宁可让最近的那部分完整。
 */
export function renderTranscript(messages: Message[]): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const line = renderOne(messages[i]);
    if (used + line.length > TRANSCRIPT_MAX_CHARS) {
      lines.unshift('(older messages omitted)');
      break;
    }
    used += line.length;
    lines.unshift(line);
  }
  return lines.join('\n');
}

/** 摘要请求：只要一段纯文本，四个标签，越短越好。 */
export function buildSummaryMessages(transcript: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You compress a working session for yourself so that you can keep working with a smaller context.',
        'Output **plain text only** (no JSON, no code fence), with these four labels and nothing else:',
        'GOAL: what the user asked for (keep their wording for the concrete requirements).',
        'DONE: what you actually created or changed, with component ids and names.',
        'OPEN: what is still missing, wrong or unverified — as a list.',
        'FACTS: hard facts needed later (file names, urls, style variables, user preferences, decisions taken).',
        'Rules: keep every id / name / url / number; drop greetings, tool chatter and anything finished and no longer',
        'relevant; never invent anything. Keep it under 400 words.',
      ].join('\n'),
    },
    { role: 'user', content: 'Session so far:\n' + transcript },
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
