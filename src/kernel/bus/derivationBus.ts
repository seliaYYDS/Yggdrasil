import type { ActCap, DerivationOp, NodeId, ThemeTokens, TraceStep } from '../types';
import { newId } from '../ids';
import { desktop, useDesktopStore } from '../../store/desktopStore';
import { unregisterTool } from '../registry/toolRegistry';
import { capOf, getInterface, interfacesFor } from '../registry/interfaceRegistry';
import { CAP_LABELS } from '../agent/caps';
import { fail, ok, type OpContext, type OpResult } from './opContext';
import { MAX_NODES } from '../agent/prompts';

export interface OpOutcome {
  op: DerivationOp;
  ok: boolean;
  message: string;
  observation: string;
  createdId?: NodeId;
  removedIds?: NodeId[];
}

export interface ExecuteResult {
  outcomes: OpOutcome[];
  createdIds: NodeId[];
  /** 样式不是节点，回滚需要单独记住改前的变量。 */
  tokensBefore: ThemeTokens;
  /** 每一步的执行轨迹，供进度面板展示。 */
  steps: TraceStep[];
}

const RESERVED_IDS = new Set(['root']);

/**
 * 会改动某个既有节点的接口，需要宾语节点 id，因此都要过作用域检查。
 * 只做提示词约束是不够的 —— 子 Agent 真的越界时要在这里被挡住。
 */
const TARGETS_NODE: Record<string, string> = {
  update_component: 'id',
  remove_node: 'id',
  set_node_tokens: 'id',
  attach_agent: 'id',
  set_agent_config: 'id',
  clear_agent_context: 'id',
  set_window_state: 'id',
};

function nodeCount(): number {
  return Object.keys(desktop().nodes).length;
}

/** 取发起者的作用域。'*' 或 undefined 表示不受限。 */
function scopeOf(originId: NodeId): string[] | '*' {
  const n = desktop().nodes[originId];
  if (!n || n.kind !== 'component' || !n.agent) return '*';
  return n.agent.scope;
}

/**
 * 判断某个节点是否在发起者的作用域内。
 * 规则：自己、scope 里列出的节点、以及它们的后代都算在内。
 */
function inScope(originId: NodeId, targetId: NodeId, scope: string[] | '*'): boolean {
  if (scope === '*') return true;
  if (targetId === originId) return true;
  if (originId === 'root') return true;

  const nodes = desktop().nodes;
  // 逐级向上看祖先，只要某一级在 scope 里就算命中。
  let cur = nodes[targetId];
  let guard = 0;
  while (cur && guard < 64) {
    if (scope.includes(cur.id)) return true;
    if (cur.parentId === null) break;
    cur = nodes[cur.parentId];
    guard += 1;
  }
  return false;
}

/** 检查一条 op 是否越过作用域；返回 null 表示通过。 */
function scopeViolation(op: DerivationOp, originId: NodeId): string | null {
  const scope = scopeOf(originId);
  if (scope === '*') return null;

  // 带宾语 id 的接口：宾语必须在范围内
  const field = TARGETS_NODE[op.kind];
  if (field) {
    const target = typeof op[field] === 'string' ? (op[field] as string) : '';
    if (target && !inScope(originId, target, scope)) {
      return 'Node ' + target + ' is outside your scope (scope: ' + scope.join(', ') + '), so this was rejected.';
    }
    if (!target && op.kind === 'update_component') {
      return null; // 交给 handler 报"缺少 id"
    }
  }

  // 全局样式：只有不受限的 Agent 才能改。
  if (op.kind === 'update_theme') {
    return 'update_theme changes the whole page, which is outside your scope. To change only yourself, use set_node_tokens.';
  }

  // 界面插槽是全局的。
  if (op.kind === 'replace_surface') {
    return 'replace_surface affects the global interface, which is outside your scope.';
  }

  return null;
}

/**
 * 检查这条 op 需要的"能力开关"这个 Agent 有没有。
 *
 * 提示词已经按能力裁过了（没能力的接口根本不会出现在它的接口目录里），
 * 但**光裁提示词不算数** —— 模型可能从历史、从别处见过这个 kind，猜着调。
 * 所以执行面再拦一道：没能力就明确拒绝，并告诉它缺哪个开关、该找谁加。
 *
 * `caps === undefined` 表示全开（基底 Agent 与老数据都走这条）。
 */
function capsOf(originId: NodeId): ActCap[] | undefined {
  const node = desktop().nodes[originId];
  return node && node.kind === 'component' ? node.agent?.caps : undefined;
}

function capViolation(op: DerivationOp, originId: NodeId): string | null {
  const caps = capsOf(originId);
  if (!caps) return null;
  const need = capOf(op.kind);
  if (!need) return null;
  if (caps.includes(need)) return null;
  return (
    'You do **not have the "' + (CAP_LABELS[need] ?? need) + '" capability**, so ' + op.kind + ' was rejected.' +
    'If you need it, ask the agent that created you to add caps: ["' + need + '"] via set_agent_config;' +
    'What you can do now: ' + (caps.length ? caps.map((c) => CAP_LABELS[c] ?? c).join(', ') : '(nothing)') + '.'
  );
}

export interface ExecuteOptions {
  runId: string;
  round: number;
  /** 这次运行属于哪个会话（基底 Agent 的对话按会话分开，op 需要知道）。 */
  sessionId: string;
  /** 每一步开始时回调，用于实时更新进度面板。 */
  onStep?: (step: TraceStep) => void;
}

export async function executeOps(
  ops: DerivationOp[],
  originId: NodeId,
  options: ExecuteOptions,
): Promise<ExecuteResult> {
  const origin = desktop().nodes[originId] ? originId : desktop().rootId;
  const outcomes: OpOutcome[] = [];
  const createdIds: NodeId[] = [];
  const steps: TraceStep[] = [];
  const tokensBefore = { ...desktop().tokens };

  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index];
    const def = getInterface(op.kind);
    const label = def?.label ?? op.kind;

    const step: TraceStep = {
      id: newId(),
      runId: options.runId,
      round: options.round,
      index,
      kind: op.kind,
      label,
      summary: summarize(op),
      status: 'running',
      message: '',
      startedAt: Date.now(),
    };
    steps.push(step);
    options.onStep?.({ ...step });

    let result: OpResult;
    const violation = def ? scopeViolation(op, origin) : null;
    const capMiss = def && !violation ? capViolation(op, origin) : null;
    if (!def) {
      // 只列出**它自己能用**的 kind：列全套会诱导它去调没能力的接口。
      result = fail(
        'Unknown operation "' + op.kind + '". The kinds available to you:' +
          interfacesFor(capsOf(origin)).map((d) => d.kind).join(', ') + '。',
      );
    } else if (violation) {
      desktop().log('warn', 'scope \u2715 ' + op.kind + ' ' + violation);
      result = fail(violation);
    } else if (capMiss) {
      desktop().log('warn', 'cap \u2715 ' + op.kind + ' ' + originId);
      result = fail(capMiss);
    } else if (def.mutates && nodeCount() >= MAX_NODES) {
      result = fail('The node limit of ' + MAX_NODES + ' has been reached, so this operation was skipped.');
    } else {
      const ctx: OpContext = {
        originId: origin,
        sessionId: options.sessionId,
        round: options.round,
        index,
        note: (text) => {
          step.message = text;
          options.onStep?.({ ...step });
        },
      };
      try {
        result = await def.handler(op, ctx);
      } catch (e) {
        result = fail('Operation "' + label + '" threw: ' + (e as Error).message);
      }
    }

    step.status = result.ok ? 'ok' : 'fail';
    step.message = result.message;
    step.observation = result.observation ?? result.message;
    step.endedAt = Date.now();
    options.onStep?.({ ...step });

    if (result.createdId) createdIds.push(result.createdId);
    outcomes.push({
      op,
      ok: result.ok,
      message: result.message,
      observation: step.observation,
      createdId: result.createdId,
      removedIds: result.removedIds,
    });
  }

  return { outcomes, createdIds, tokensBefore, steps };
}

function summarize(op: DerivationOp): string {
  const parts: string[] = [];
  if (typeof op.id === 'string') parts.push('id=' + op.id);
  if (typeof op.surface === 'string') parts.push('surface=' + op.surface);
  if (typeof op.name === 'string') parts.push('name=' + op.name);
  if (typeof op.before === 'string') parts.push('before=' + op.before);
  if (op.tokens && typeof op.tokens === 'object') {
    parts.push('tokens=' + Object.keys(op.tokens).join('/'));
  }
  if (typeof op.source === 'string') parts.push('source=' + op.source.length + 'B');
  return parts.join(' ') || '—';
}

/** 回滚一轮执行：撤销新建的节点与样式变量改动。 */
export function rollback(result: ExecuteResult): void {
  const store = useDesktopStore.getState();
  for (const id of [...result.createdIds].reverse()) {
    if (RESERVED_IDS.has(id) || !store.nodes[id]) continue;
    unregisterTool(id);
    store.removeNode(id);
  }
  store.applyTokens(result.tokensBefore);
}

/**
 * 单条观察结果回灌给模型的上限。
 * fetch_url 的正文长度由模型自己用 maxChars 指定（最大 60000），这里只做兜底，不额外收紧。
 */
const MAX_OBSERVATION_CHARS = 64000;

/**
 * 一条执行结果转成回灌给模型的文本。
 *
 * **必须带上 observation。** 此前这里只回 message，于是模型看到的全部内容就是
 * 「✓ 已抓取 url（正文 8000 字符 · 图 37 · 链接 20）」这种结论 —— 正文、图片直链、
 * 链接清单、inspect 的结构快照全都只进了轨迹面板，**人能看到，模型看不到**。
 * 结果是模型拿不到任何数据，只能反复重抓同一页。
 */
export function formatOutcomes(outcomes: OpOutcome[]): string[] {
  return outcomes.map((o) => {
    const head = (o.ok ? '✓ ' : '✗ ') + o.message;
    const body = (o.observation ?? '').trim();
    // 很多接口的 observation 与 message 本来就是同一句，别重复贴两遍。
    if (!body || body === o.message.trim()) return head;
    const clipped =
      body.length > MAX_OBSERVATION_CHARS
        ? body.slice(0, MAX_OBSERVATION_CHARS) +
          '\n... (this result was too long and has been truncated; original length ' + body.length + ' characters)'
        : body;
    return head + '\n' + clipped;
  });
}

export { fail, ok };