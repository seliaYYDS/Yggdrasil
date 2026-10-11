import type { DerivationOp, NodeId, ThemeTokens } from '../types';

export interface OpResult {
  ok: boolean;
  /** 一行人类可读的成败说明。 */
  message: string;
  /** 回灌给模型的观察文本；缺省时用 message。 */
  observation?: string;
  /** 本接口新建的节点，用于回滚。 */
  createdId?: NodeId;
  /** 本接口删除/级联的节点。 */
  removedIds?: NodeId[];
}

export interface OpContext {
  /** 发起本次派生的节点。 */
  originId: NodeId;
  round: number;
  index: number;
  /** 上报一条子步骤（用于透明化：比如编译耗时、替换了哪个插槽）。 */
  note: (text: string) => void;
}

export function ok(message: string, extra: Partial<OpResult> = {}): OpResult {
  return { ok: true, message, ...extra };
}

export function fail(message: string): OpResult {
  return { ok: false, message };
}

export function clampNumber(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

export function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

export function strOr(v: unknown, fallback: string): string {
  const s = str(v).trim();
  return s || fallback;
}

export function tokensOf(v: unknown): ThemeTokens {
  if (!v || typeof v !== 'object') return {};
  const out: ThemeTokens = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

export type { DerivationOp };
