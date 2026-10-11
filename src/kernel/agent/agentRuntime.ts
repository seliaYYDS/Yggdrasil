import type {
  ComponentNode,
  DerivationOutcome,
  DerivationOp,
  FeedbackLevel,
  Message,
  NodeId,
  RoundResult,
  RunFeedback,
  TraceStep,
  YggNode,
} from '../types';
import { newId } from '../ids';
import { chatStream } from '../llm/client';
import type { ChatMessage } from '../llm/types';
import { parsePlan } from './parse';
import {
  buildObservationPrompt,
  buildSystemPrompt,
  MAX_HISTORY_MESSAGES,
  MAX_ROUNDS,
} from './prompts';
import { executeOps, formatOutcomes, rollback } from '../bus/derivationBus';
import { desktop, useDesktopStore } from '../../store/desktopStore';
import { toolCatalog } from '../registry/toolRegistry';

/** 带 agent facet 的组件。 */
function isAgentic(n: YggNode | undefined): n is ComponentNode & { agent: NonNullable<ComponentNode['agent']> } {
  return !!n && n.kind === 'component' && !!n.agent;
}

function isComponentNode(n: YggNode | undefined): n is ComponentNode {
  return !!n && n.kind === 'component';
}

/** 组件窗口的「改版」按钮用：把自然语言转成组件源码。 */
export function buildComponentPatchPrompt(node: YggNode, instruction: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是 Yggdrasil 的组件修改器。用户会给你一个现有 React 组件的源码和一条修改要求。',
        '只输出修改后的 TSX 源码，不要输出解释，不要用 markdown 代码块包裹。',
        '必须保留 export default 的函数组件，只能 import react / react-dom / react-dom/client，样式写成行内 style 并使用 --ygg- CSS 变量。',
        '视觉风格必须扁平：不要 boxShadow、textShadow、filter、gradient、backdropFilter。',
        '边框克制：只在组件根容器上加边框，内部区块之间不要加边框或分隔线。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: '当前源码：\n' + (isComponentNode(node) ? node.source : '') + '\n\n修改要求：' + instruction,
    },
  ];
}

function stripFence(text: string): string {
  const m = /```(?:tsx|ts|jsx|js)?\s*([\s\S]*?)```/.exec(text);
  return (m ? m[1] : text).trim();
}

/** Agent 的上下文历史：只放对话，不放每步的执行回执（那些走 trace）。 */
function transcriptToMessages(node: YggNode): ChatMessage[] {
  if (!isAgentic(node)) return [];
  return node.agent.messages
    .slice(-MAX_HISTORY_MESSAGES)
    .filter((m: Message) => m.role !== 'system')
    .map((m: Message) => ({ role: m.role, content: m.content }));
}

function appendMessage(nodeId: NodeId, message: Message): void {
  const store = useDesktopStore.getState();
  const node = store.nodes[nodeId];
  if (!isAgentic(node)) return;
  store.updateFacet(nodeId, { messages: [...node.agent.messages, message] });
}

export interface RunOptions {
  originId?: NodeId;
}

export interface RunSummary {
  ok: boolean;
  added: number;
  rounds: number;
  okCount: number;
  failCount: number;
  error?: string;
}

function mkFeedback(level: FeedbackLevel, title: string, detail: string): RunFeedback {
  return { id: newId(), at: Date.now(), level, title, detail };
}

/** 判断一个错误是否值得重试（网络/限流/5xx 是，4xx 参数错误不是）。 */
function isRetryable(msg: string): boolean {
  if (/\b(400|401|403|404|422)\b/.test(msg)) return false;
  return /(429|500|502|503|504|timeout|fetch|network|ECONN|aborted|Failed to fetch)/i.test(msg);
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** 单次运行允许的"出错后重来"次数上限，防止反复失败烧掉轮次。 */
const MAX_RECOVERIES = 3;

/**
 * 带重试的模型调用。
 * 出错不再直接终止整轮 —— 先退避重试；仍失败则把错误交回上层，
 * 由上层决定是否让 Agent 换个做法继续（见 §5.28）。
 */
async function chatWithRetry(
  settings: Parameters<typeof chatStream>[0],
  messages: ChatMessage[],
  onDelta: (chunk: string) => void,
  attempts = 3,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let lastError = '';
  for (let i = 0; i < attempts; i += 1) {
    try {
      const text = await chatStream(settings, messages, { onDelta });
      return { ok: true, text };
    } catch (e) {
      lastError = (e as Error).message;
      if (!isRetryable(lastError) || i === attempts - 1) break;
      await sleep(400 * (i + 1));
    }
  }
  return { ok: false, error: lastError };
}

export async function runDerivation(input: string, options: RunOptions = {}): Promise<RunSummary> {
  const store = useDesktopStore.getState();
  const settings = store.settings;
  const originId = options.originId && store.nodes[options.originId] ? options.originId : store.rootId;
  const origin = store.nodes[originId];
  if (!origin) {
    store.setFeedback(mkFeedback('fail', '找不到发起节点', ''));
    return { ok: false, added: 0, rounds: 0, okCount: 0, failCount: 0, error: '找不到发起节点。' };
  }

  const runId = newId();
  store.beginTrace(runId);
  store.setStatus({ running: true, phase: '准备上下文', detail: '', round: 0, runId });
  appendMessage(originId, { role: 'user', content: input });

  const pushStep = (step: TraceStep) => useDesktopStore.getState().upsertStep(step);

  /** 记录一次"出错后重来"，超过上限就放弃，避免无限重试。 */
  let recoveries = 0;
  const notifyRetry = (roundNo: number, reason: string): void => {
    recoveries += 1;
    pushStep({
      id: newId(),
      runId,
      round: roundNo,
      index: -2,
      kind: 'recover',
      label: '自动恢复',
      summary: '第 ' + roundNo + ' 轮出错，正在换做法重试',
      status: 'running',
      message: reason,
      startedAt: Date.now(),
      endedAt: Date.now(),
    });
    store.log('warn', 'recover #' + recoveries + ' ' + reason);
    useDesktopStore.getState().setStatus({
      phase: '自动恢复中',
      detail: reason,
      round: roundNo,
    });
  };

  const finish = (summary: RunSummary): RunSummary => {
    useDesktopStore.getState().setStatus({
      running: false,
      phase: summary.ok ? '完成' : '失败',
      detail: summary.error ?? '',
      round: 0,
    });
    return summary;
  };

  try {
    const rounds: RoundResult[] = [];
    let totalAdded = 0;
    let okCount = 0;
    let failCount = 0;
    let lastObservations: string[] | null = null;
    let continueLoop = true;
    let round = 0;

    while (continueLoop && round < MAX_ROUNDS) {
      round += 1;
      useDesktopStore.getState().setStatus({ running: true, phase: '模型思考中', round });

      const modelStep: TraceStep = {
        id: newId(),
        runId,
        round,
        index: -1,
        kind: 'llm',
        label: '模型推理',
        summary: '第 ' + round + ' 轮',
        status: 'running',
        message: '等待模型返回…',
        startedAt: Date.now(),
      };
      pushStep(modelStep);

      const systemPrompt = buildSystemPrompt({
        nodes: deskNodes(),
        rootId: desktop().rootId,
        tokens: desktop().tokens,
        tools: agentTools(origin),
        originName: origin.name,
        hostId: originId,
        rolePrompt: isAgentic(origin) ? origin.agent.systemPrompt : '',
        ledger: currentLedger(originId),
        scope: isAgentic(origin) ? origin.agent.scope : undefined,
      });

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...transcriptToMessages(origin).filter((m) => m.content !== input),
        { role: 'user', content: input },
      ];
      if (lastObservations) {
        messages.push({ role: 'user', content: buildObservationPrompt(lastObservations) });
      }

      let buffer = '';
      const call = await chatWithRetry(settings, messages, (chunk) => {
        buffer += chunk;
        // 思考过程只进 trace。
        pushStep({ ...modelStep, message: buffer.slice(-200) });
        useDesktopStore.getState().setStatus({ phase: '模型生成指令中', detail: buffer.slice(-140) });
      });

      if (!call.ok) {
        // 重试仍失败：不断整轮终止，而是把错误回灌，让 Agent 下一轮换个做法。
        const msg = call.error;
        pushStep({ ...modelStep, status: 'fail', message: msg, endedAt: Date.now() });
        store.log('error', 'llm ✕ ' + msg);
        if (round < MAX_ROUNDS && recoveries < MAX_RECOVERIES) {
          lastObservations = [
            '上一轮模型调用失败：' + msg,
            '请换一个更简单的做法重试；如果任务无法完成，用空 ops 结束。',
          ];
          notifyRetry(round, '模型调用失败，正在重试：' + msg);
          continue;
        }
        useDesktopStore.getState().setFeedback(mkFeedback('fail', '模型调用失败（已重试）', msg));
        return finish({ ok: false, added: totalAdded, rounds: rounds.length, okCount, failCount, error: msg });
      }
      const raw = call.text;

      const parsed = parsePlan(raw);
      if (!parsed.ok || !parsed.plan) {
        // 解析失败也交给 Agent 自己修：把错误与原始输出片段回灌，下一轮重来。
        const err = parsed.error ?? '解析失败';
        pushStep({
          ...modelStep,
          status: 'fail',
          message: '未返回合法指令：' + err,
          endedAt: Date.now(),
        });
        store.log('error', 'parse ✕ ' + err);
        if (round < MAX_ROUNDS && recoveries < MAX_RECOVERIES) {
          lastObservations = [
            '你上一轮的输出不是合法指令，解析失败：' + err,
            '原始输出片段：' + raw.slice(0, 300),
            '请只输出一个 JSON 对象，kind 必须是可用接口之一。',
          ];
          notifyRetry(round, '指令格式错误，正在让其自行修复：' + err);
          continue;
        }
        useDesktopStore.getState().setFeedback(
          mkFeedback('fail', '模型反复没有输出合法指令', err),
        );
        return finish({ ok: false, added: totalAdded, rounds: rounds.length, okCount, failCount, error: err });
      }
      const plan = parsed.plan;
      if (plan.reasoning) {
        store.log('llm', round + ' ' + plan.reasoning);
        // 模型的判断写进这一步的 trace，而不是当作对话消息。
        pushStep({ ...modelStep, message: plan.reasoning, endedAt: Date.now() });
      } else {
        pushStep({ ...modelStep, status: 'ok', message: '已返回 ' + raw.length + ' 字符', endedAt: Date.now() });
      }
      if (plan.ops.length === 0) {
        rounds.push({ round, plan, observations: [] });
        break;
      }

      useDesktopStore.getState().setStatus({ phase: '执行指令', detail: plan.ops.length + ' 条', round });
      const result = await executeOps(plan.ops, originId, {
        runId,
        round,
        onStep: (step) => {
          pushStep(step);
          useDesktopStore.getState().setStatus({
            phase: '执行 ' + (step.index + 1) + '/' + plan.ops.length,
            detail: step.label + ' · ' + step.summary,
            round,
          });
        },
      });

      okCount += result.outcomes.filter((o) => o.ok).length;
      failCount += result.outcomes.filter((o) => !o.ok).length;

      const allFailed = result.outcomes.length > 0 && result.outcomes.every((o) => !o.ok);
      if (allFailed) {
        rollback(result);
        const text = formatOutcomes(result.outcomes);
        store.log('error', 'rollback ' + text.join(' | '));
        rounds.push({ round, plan, observations: text });
        // 全部失败：回滚这一轮，但**不终止整个任务** —— 把失败原因回灌，
        // 让 Agent 下一轮换个写法（常见于源码编译错误）。
        if (round < MAX_ROUNDS && recoveries < MAX_RECOVERIES) {
          lastObservations = [
            '你上一轮的所有指令都失败了，已回滚它们造成的改动。失败原因：',
            ...text,
            '请修正后重试。常见原因：源码语法错误、引用了不存在的 id、变量未定义。',
          ];
          notifyRetry(round, '全部指令失败，正在重试：' + (text[0] ?? ''));
          continue;
        }
        useDesktopStore.getState().setFeedback(mkFeedback('fail', '反复失败，已回滚', text.join('\n')));
        return finish({ ok: false, added: totalAdded, rounds: rounds.length, okCount, failCount, error: text[0] });
      }

      totalAdded += result.createdIds.length;
      const observations = formatOutcomes(result.outcomes);
      rounds.push({ round, plan, observations });
      // 把这一轮真正做成的事记进 ledger：跨刷新保留，避免下次重做。
      recordLedger(originId, plan.ops, result);
      // 执行回执只进 trace 与本轮的观察通道，**不写进消息历史** ——
      // 历史里留下"已创建 X"会让后续轮次误以为 X 还存在（见 §5.19）。
      lastObservations = observations;
      continueLoop = plan.continue === true;
    }

    const level: FeedbackLevel = failCount === 0 ? 'ok' : 'partial';
    const title =
      level === 'ok'
        ? '完成：' + okCount + ' 步成功'
        : '部分完成：' + okCount + ' 成功 / ' + failCount + ' 失败';
    // 结果反馈只走提示条与 trace：Agent 没有可直接输出的文字通道。
    useDesktopStore.getState().setFeedback(
      mkFeedback(level, title, '共 ' + rounds.length + ' 轮，新增 ' + totalAdded + ' 个节点'),
    );
    store.log('info', 'done ' + rounds.length + 'r +' + totalAdded);
    return finish({ ok: true, added: totalAdded, rounds: rounds.length, okCount, failCount });
  } catch (e) {
    const msg = (e as Error).message;
    useDesktopStore.getState().setFeedback(mkFeedback('fail', '派生过程异常', msg));
    store.log('error', '✕ ' + msg);
    useDesktopStore.getState().setStatus({ running: false, phase: '失败', detail: msg, round: 0 });
    return { ok: false, added: 0, rounds: 0, okCount: 0, failCount: 0, error: msg };
  }
}

function deskNodes(): Record<string, YggNode> {
  return desktop().nodes;
}

/** 取该 Agent 的 ledger。 */
function currentLedger(originId: NodeId): string[] | undefined {
  const n = desktop().nodes[originId];
  if (!n || n.kind !== 'component' || !n.agent) return undefined;
  return n.agent.ledger;
}

/**
 * 读一个 Agent 当前可见的工具清单。
 * 有 toolIds 时只给那些（子 Agent 因此可以有自己的工具子集，而不是和基底一模一样）。
 */
function agentTools(origin: YggNode | undefined) {
  const all = toolCatalog();
  if (!origin || origin.kind !== 'component' || !origin.agent) return all;
  const ids = origin.agent.toolIds;
  if (!ids || ids.length === 0) return all;
  const wanted = new Set(ids);
  const subset = all.filter((t) => wanted.has(t.id));
  return subset.length > 0 ? subset : all;
}

/** 把这一轮做成的实体记进 ledger。 */
function recordLedger(
  originId: NodeId,
  ops: DerivationOp[],
  result: { outcomes: Array<{ ok: boolean; createdId?: NodeId }> },
): void {
  const entries: string[] = [];
  const store = useDesktopStore.getState();
  ops.forEach((op, i) => {
    const outcome = result.outcomes[i];
    if (!outcome?.ok) return;
    const created = outcome.createdId ? store.nodes[outcome.createdId] : undefined;
    if (op.kind === 'create_component' && created) {
      entries.push('组件「' + created.name + '」(id=' + created.id + ')');
    } else if (op.kind === 'create_agent' && created) {
      entries.push('Agent「' + created.name + '」(id=' + created.id + ')');
    } else if (op.kind === 'create_tool' && created) {
      entries.push('工具「' + created.name + '」(id=' + created.id + ')');
    } else if (op.kind === 'replace_surface' && typeof op.surface === 'string') {
      entries.push('替换了界面插槽 ' + op.surface);
    } else if (op.kind === 'update_theme') {
      entries.push('改写了全局样式');
    } else if (op.kind === 'set_node_tokens' && typeof op.id === 'string') {
      entries.push('覆写了节点 ' + op.id + ' 的局部样式');
    } else if (op.kind === 'update_component' && typeof op.id === 'string') {
      entries.push('修改了组件 ' + op.id);
    }
  });
  if (entries.length > 0) store.appendLedger(originId, entries);
}

export type { DerivationOutcome, DerivationOp };

export { stripFence };