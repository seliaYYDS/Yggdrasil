import type { DerivationOp, DerivationPlan } from '../types';
import { knownKinds } from '../registry/interfaceRegistry';

export interface ParseResult {
  ok: boolean;
  plan?: DerivationPlan;
  error?: string;
  raw: string;
}

function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i += 1) {
    const c = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 把模型输出解析成派生计划。
 * kind 不做硬白名单 —— 未知 kind 交给总线报「未知接口」，错误信息里能带上可用清单与 kind 名。
 */
export function parsePlan(text: string): ParseResult {
  const raw = text.trim();
  const json = extractJson(raw);
  if (!json) return { ok: false, error: '模型回复里没有找到 JSON 对象。', raw };

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: 'JSON 解析失败：' + (e as Error).message, raw };
  }
  if (!data || typeof data !== 'object') return { ok: false, error: 'JSON 顶层不是对象。', raw };

  const obj = data as Record<string, unknown>;
  const opsRaw = Array.isArray(obj.ops) ? obj.ops : [];
  const ops: DerivationOp[] = [];
  for (const item of opsRaw) {
    if (!item || typeof item !== 'object') continue;
    const op = item as Record<string, unknown>;
    if (typeof op.kind !== 'string' || !op.kind) continue;
    ops.push({ ...op, kind: op.kind });
  }

  if (ops.length === 0 && opsRaw.length > 0) {
    return {
      ok: false,
      error: 'ops 里没有一条带 kind 的指令。可用 kind：' + knownKinds().join(', ') + '。',
      raw,
    };
  }

  return {
    ok: true,
    raw,
    plan: {
      reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : undefined,
      continue: obj.continue === true,
      ops,
    },
  };
}
