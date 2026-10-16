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
import { chatStream, estimateTokens, type LlmUsage } from '../llm/client';
import type { ChatMessage, ContentPart, LlmSettings } from '../llm/types';
import { looksLikeNativeCall, nativeCallsFromArgs, parsePlan, planFromNativeCalls } from './parse';
import {
  buildSummaryMessages,
  compactedMemory,
  compactThresholdTokens,
  estimateTokensOf,
  splitForCompaction,
} from './compact';
import {
  buildObservationPrompt,
  buildReplyPrompt,
  buildSnapshotPrompt,
  buildSystemPrompt,
  HISTORY_TRIM_SLACK,
  MAX_HISTORY_MESSAGES,
  MAX_STORED_MESSAGES,
  type SystemPromptInput,
} from './prompts';
import { executeOps, formatOutcomes, rollback, type ExecuteResult } from '../bus/derivationBus';
import {
  defaultWindows,
  defaultWindowsText,
  desktop,
  MAIN_SESSION,
  type RunStatus,
  useDesktopStore,
} from '../../store/desktopStore';
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
        'You are a Yggdrasil component editor. The user gives you the source of an existing React component plus one change request.',
        'Output only the modified TSX source — no explanation and no markdown code fence.',
        'Keep the export default function component; you may only import react / react-dom / react-dom/client; write styles as inline style objects using --ygg- CSS variables.',
        'The visual style must be flat: no boxShadow, textShadow, filter, gradient or backdropFilter.',
        'Be restrained with borders: put a border on the root container only; no borders or dividers between inner blocks.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: 'Current source:\n' + (isComponentNode(node) ? node.source : '') + '\n\nRequested change: ' + instruction,
    },
  ];
}

function stripFence(text: string): string {
  const m = /```(?:tsx|ts|jsx|js)?\s*([\s\S]*?)```/.exec(text);
  return (m ? m[1] : text).trim();
}

/**
 * Agent 的上下文历史：只放对话，不放每步的执行回执（那些走 trace）。
 *
 * 读**最新**的节点，然后**只去掉末尾那一条当前输入**。
 * 之前是拿 runDerivation 开头那份旧快照再按内容全局过滤，有两个毛病：
 * 1. 同一句话连发两次时，会把上一次那条真实请求也从历史里删掉（历史被改写）；
 * 2. 旧快照与真实历史可能已经不一致。
 */
/**
 * 这个会话的记忆该从哪读。
 *
 * - **基底 Agent**（root）：记忆在**输入框会话**上 —— 每个输入框一份，互不串台；
 * - **组件 Agent**：记忆在它自己的 facet 上（一个组件就一个会话）。
 *
 * 共享的是工作环境（节点树、样式、账本），不是对话。
 */
function sessionMemory(originId: NodeId, sessionId: string): Message[] {
  const store = useDesktopStore.getState();
  if (originId === store.rootId) {
    return store.sessions.find((s) => s.id === sessionId)?.messages ?? [];
  }
  const node = store.nodes[originId];
  return isAgentic(node) ? node.agent.messages : [];
}

/**
 * 旧历史压成一段摘要，写回记忆。
 *
 * 失败**不抛**：压缩只是"省上下文"的手段，它自己不该变成新的失败点 ——
 * 返回 compacted:false，调用方退回"丢最老的历史"继续跑。
 */
async function compactMemory(
  originId: NodeId,
  sessionId: string,
  settings: LlmSettings,
  /** 这次会话正在用的系统提示（逐字节相同地重放，才能复用缓存）。 */
  systemPrompt: string,
  signal?: AbortSignal,
): Promise<{ compacted: boolean; before: number; after: number; error?: string }> {
  const memory = sessionMemory(originId, sessionId);
  const before = memory.length;
  const { head, tail } = splitForCompaction(memory);
  if (head.length === 0) return { compacted: false, before, after: before, error: '没有可压缩的历史' };
  /*
   * 被压缩的那一段要**按请求里的样子**重放：同一个 userContent、同一套多模态形状、同样的顺序。
   * 它正好是刚发出那次请求的开头（历史排在最前），所以这是一次"前缀扩展"而不是一次新请求。
   */
  const shadowed: ChatMessage[] = head
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: userContent(m.content, m.images, settings.vision !== false) }));
  let call;
  try {
    // 压缩不需要流式回调（界面上只看到一条"压缩上下文"的轨迹），给一个空实现。
    call = await chatWithRetry(settings, buildSummaryMessages(systemPrompt, shadowed), { onDelta: () => {} }, 2, signal);
  } catch (e) {
    return { compacted: false, before, after: before, error: (e as Error).message };
  }
  if (!call.ok) return { compacted: false, before, after: before, error: call.error };
  const summary = call.text.trim();
  if (!summary) return { compacted: false, before, after: before, error: '摘要为空' };
  replaceMemory(originId, sessionId, compactedMemory(summary, tail));
  return { compacted: true, before, after: tail.length + 1 };
}

/** 整体替换这个会话的记忆（上下文压缩后用）。 */
function replaceMemory(originId: NodeId, sessionId: string, messages: Message[]): void {
  const store = useDesktopStore.getState();
  if (originId === store.rootId) {
    store.replaceSessionMessages(sessionId, messages);
    return;
  }
  const node = store.nodes[originId];
  if (!isAgentic(node)) return;
  store.updateFacet(originId, {
    messages: messages.length > MAX_STORED_MESSAGES ? messages.slice(-MAX_STORED_MESSAGES) : messages,
  });
}

/** 把一条消息写进这个会话的记忆。 */
function pushMemory(originId: NodeId, sessionId: string, message: Message): void {
  const store = useDesktopStore.getState();
  if (originId === store.rootId) {
    store.appendSessionMessage(sessionId, message);
    return;
  }
  const node = store.nodes[originId];
  if (!isAgentic(node)) return;
  const next = [...node.agent.messages, message];
  store.updateFacet(originId, {
    messages: next.length > MAX_STORED_MESSAGES ? next.slice(-MAX_STORED_MESSAGES) : next,
  });
}

/**
 * 这一轮要发的对话历史。
 *
 * **长度由"压缩"管，不再按条数削**：以前卡死 14 条，长任务跑到中段就把最老的
 * （往往正是目标与已经做完的事）丢掉 —— 模型于是忘事、重复做、或者干脆收工。
 * 现在：
 *   - 知道窗口（设置里填了 contextWindow）→ 不按条数削，全部带上。真的溢出时先压缩
 *     （见 compactMemory），压缩不成才用 budgetTokens 兜底丢最老的；
 *   - 不知道窗口 → 退回老上限：连窗口都不知道时，保守一点好过把请求顶爆。
 */
function historyMessages(
  nodeId: NodeId,
  sessionId: string,
  /** 这一轮请求在记忆里的**原文**（与发出去的那条逐字节相同）；用它把本轮这条从历史里去掉。 */
  requestText: string,
  /**
   * 历史能占的 token 上限：
   *   undefined = **窗口未知** → 沿用老条数上限（保守）；
   *   0         = 知道窗口、长度交给压缩管 → 不设上限；
   *   > 0       = 到阈值了但压缩没成功 → 按预算丢最老的兜底。
   */
  budgetTokens?: number,
): ChatMessage[] {
  const settings = useDesktopStore.getState().settings;
  const all = sessionMemory(nodeId, sessionId);
  /*
   * ⚠ **必须先复制再动**：这份数组就是会话记忆本身，下面那个 `pop()` 会把真实记忆删掉。
   */
  const list =
    budgetTokens === undefined && all.length > MAX_HISTORY_MESSAGES + HISTORY_TRIM_SLACK
      ? all.slice(-MAX_HISTORY_MESSAGES)
      : all.slice();
  // 先去掉"这一轮的请求"（它下面单独发），预算只管历史。
  if (list.length > 0 && list[list.length - 1].content === requestText) list.pop();
  /*
   * **溢出兜底**：整份请求已经到阈值，而压缩没能把记忆变短（没有 key / 摘要失败 /
   * 某一轮单独就超了）。这时从最新往回装，装不下就丢最老的整块 ——
   * 宁可丢历史，也不要让这一轮因为超出窗口而失败。正常路径（压缩成功）不会走到这里。
   */
  if (budgetTokens !== undefined && budgetTokens > 0 && list.length > 0) {
    let used = 0;
    let keep = list.length;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const content = list[i].content;
      used += estimateTokens(typeof content === 'string' ? content : JSON.stringify(content));
      if (used > budgetTokens) {
        keep = i + 1;
        break;
      }
    }
    if (keep < list.length) list.splice(0, list.length - keep);
  }
  return list
    .filter((m: Message) => m.role !== 'system')
    .map((m: Message) => ({ role: m.role, content: userContent(m.content, m.images, settings.vision !== false) }));
}

/*
 * 记忆写入统一走 pushMemory（见上）：基底写会话、组件写 facet，两处都封顶
 * MAX_STORED_MESSAGES —— 识图会让消息带 base64，不封顶能把 IndexedDB 撑爆。
 */

export interface RunOptions {
  originId?: NodeId;
  /** 发起这次运行的输入框（会话）。工作状态按会话隔离，默认是主会话。 */
  sessionId?: string;
  /**
   * 这次请求提到的**工作区文件**（只有名字）。
   *
   * 上传的文件本身已经写进工作区；这里只是把名字带过来，
   * 让这一轮知道"有哪些文件可以读"。内容**不进**提示词与记忆。
   */
  files?: string[];
  /** 用户按"停止"时在这里中止 —— 轮次之间、以及模型调用中都会检查它。 */
  signal?: AbortSignal;
}

/**
 * 一条用户消息的 content。
 * 没有图片就是纯文本；有图片时拼成多模态内容块（OpenAI 兼容格式）。
 * 抽成独立函数是为了能直接单测形状。
 */
export function userContent(text: string, images?: string[], allowVision = true): ChatMessage['content'] {
  // 关掉"视觉"就不带图片块：纯文本模型收到图片会整条失败（见 visionHint）。
  // 带图的记忆仍然留着，只是这一轮不送 —— 用户改回开关就能重新看到它们。
  const list = (allowVision ? images ?? [] : []).filter((u) => typeof u === 'string' && u.startsWith('data:image/'));
  if (list.length === 0) return text;
  const parts: ContentPart[] = [{ type: 'text', text }];
  for (const url of list) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
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

/**
 * 判断一个错误是否值得重试。
 *
 * 之前是"先排除 4xx、再看白名单关键词" —— 白名单太窄（没覆盖 408/409/425/520~527 等），
 * 于是不少本来能重试的错直接放弃，用户看到的就是"错误处理有时不触发"。
 * 现在改成：**只有明确的 4xx 客户端错误才不重试，其余一律重试**（重试本身有次数上限）。
 */
function isRetryable(msg: string): boolean {
  // 请求本身有问题：重试多少次都一样。
  if (/\b(400|401|403|404|405|406|410|413|414|415|422|451)\b/.test(msg)) return false;
  // 参数/响应格式类错误也不值得重试。
  if (/没有可读流|空内容/.test(msg)) return false;
  return true;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/**
 * 单次模型请求的超时。
 * 没有它，一个卡住的连接会让调度器永远停在 busy —— 之后所有输入都只会进队列、永远发不出去，
 * 用户看到的就是"消息被吞掉"。
 */
const REQUEST_TIMEOUT_MS = 120000;

/** trace 里最多保留多少字符的思考 / 原始输出（够看，又不会把存储撑爆）。 */
const MAX_THINK_CHARS = 20000;
const MAX_RAW_CHARS = 20000;
/** 流式刷新节流：每个 chunk 都写一次 store 会让轨迹面板不停重渲染。 */
const STREAM_FLUSH_MS = 120;


/**
 * 带图片的请求失败时，给用户一句能直接照做的提示。
 *
 * 浏览器的报错千奇百怪，但"模型不支持识图"是这类失败里最常见的一种 ——
 * 而且用户从原始报错里基本看不出来该做什么。这里不假装能精确判定，
 * 只在错误里能看出跟图片/多模态有关时说得更肯定一点。
 */
function visionHint(images: string[], error: string): string {
  if (images.length === 0) return '';
  const looksVision = /image|vision|multi-?modal|modalit|content|unsupported|not support/i.test(error);
  return (
    '\n\n' +
    (looksVision
      ? '报错与图片有关：当前模型可能不支持识图。'
      : '这次请求带了 ' + images.length + ' 张图片；模型不支持识图时会整条失败。') +
    '可在设置里换一个支持视觉的模型（gpt-4o / claude-3.5 / qwen-vl）。'
  );
}

/** 当前请求的标记，与提示词里的「你每次只处理标注为【本次请求】的那一条消息」对应。 */
const CURRENT_REQUEST_TAG = '[CURRENT REQUEST]';

/** 单次运行允许的"出错后重来"次数上限，防止反复失败烧掉轮次。 */
const MAX_RECOVERIES = 3;

/**
 * 像不像模型自己的原生工具调用标记。
 *
 * 只用来决定回灌时**要不要点名这个错**：解析层认得出的形式早就被翻译成 ops 了
 * （见 parse.ts），走到"仍然失败"说明是它认不出的变体（标签被截断、格式怪……）。
 * 这时唯一的出路是明确告诉模型"这个协议没有工具调用语法"，
 * 否则它只会用同一种写法把恢复机会一次次耗光。
 */
/* looksLikeToolCall 已挪到解析层（parse.ts 的 looksLikeNativeCall）—— 判据只留一份。 */

/**
 * 观察结果的滚动预算（字符）。超过就丢掉最老的几条。
 * 取 40000 —— 大约能留住 3~4 次默认长度的抓取，够多步任务用，单次请求也不会失控。
 */
const OBSERVATION_BUDGET = 40000;

/**
 * 带重试的模型调用。
 * 出错不再直接终止整轮 —— 先退避重试；仍失败则把错误交回上层，
 * 由上层决定是否让 Agent 换个做法继续（见 §5.28）。
 */
interface StreamHandlers {
  onDelta: (chunk: string) => void;
  onThinking?: (chunk: string) => void;
  /**
   * 每次尝试开始前回调。
   * **必须用它清空累积的正文 / 思考缓冲** —— 否则重试会把上一次的半截输出和新输出
   * 拼在一起，解析器取到的可能是上一次那半截坏 JSON。这是"重试好像没生效"的一个真实成因。
   */
  onAttempt?: (attempt: number) => void;
}

interface CallOk {
  ok: true;
  text: string;
  /** 服务端走原生工具调用时，调用在这里（正文通常是空的）。见 parse.ts 的 nativeCallsFromArgs。 */
  toolCalls: { name: string; arguments: string }[];
  /** 服务端报的用量；没报就是 null（上层按字符估算）。 */
  usage: LlmUsage | null;
  /** 这一次（含重试后成功的那次）的耗时。 */
  ms: number;
}
interface CallFail {
  ok: false;
  error: string;
  /** true = 用户按了"停止"（不是服务端/网络故障），不要再重试、也不要当失败汇报。 */
  stopped?: boolean;
}

async function chatWithRetry(
  settings: Parameters<typeof chatStream>[0],
  messages: ChatMessage[],
  handlers: StreamHandlers,
  attempts = 3,
  /** 用户按"停止"时会被 abort —— 中止不是故障，不该重试、也不该报成错误。 */
  stopSignal?: AbortSignal,
): Promise<CallOk | CallFail> {
  let lastError = '';
  for (let i = 0; i < attempts; i += 1) {
    if (stopSignal?.aborted) return { ok: false, error: '已停止', stopped: true };
    handlers.onAttempt?.(i);
    const ctl = new AbortController();
    const timer = window.setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    // 停止信号与超时信号合并：任一触发都中止这次请求。
    const onStop = () => ctl.abort();
    stopSignal?.addEventListener('abort', onStop, { once: true });
    try {
      const out = await chatStream(settings, messages, {
        onDelta: handlers.onDelta,
        onThinking: handlers.onThinking,
        signal: ctl.signal,
      });
      return { ok: true, text: out.text, toolCalls: out.toolCalls, usage: out.usage, ms: out.ms };
    } catch (e) {
      lastError = (e as Error).message;
      if (stopSignal?.aborted) return { ok: false, error: '已停止', stopped: true };
      if (!isRetryable(lastError) || i === attempts - 1) break;
      await sleep(400 * (i + 1));
    } finally {
      window.clearTimeout(timer);
      stopSignal?.removeEventListener('abort', onStop);
    }
  }
  return { ok: false, error: lastError };
}

/**
 * 把一次模型调用的用量记到会话上。
 *
 * 优先用服务端报的 usage；它没报就按字符估算，并把 `exact` 标成 false ——
 * 界面会在数字前面加个 ~，用户一眼能看出这不是准数。
 *
 * 这里只攒**原始量**（token 数 + 生成耗时），速度与命中率都由界面上那两个纯函数算：
 * 整体速度用输出 token 除以耗时（输入是并发回来的、拿它算速度没有意义）。
 */
function recordUsage(
  sessionId: string,
  call: { usage: LlmUsage | null; ms: number },
  promptChars: number,
  outputText: string,
): void {
  const store = useDesktopStore.getState();
  const outEst = estimateTokens(outputText);
  if (call.usage) {
    /*
     * 服务商给的 promptTokens **含着命中数**，所以这里要减出来 ——
     * 三个桶必须互斥（计费输入 = 三者之和），否则命中率的分母会偏大。
     * 这正是 deepseek-harness 在适配器里做的事（TokenUsage 的注释写得很清楚：
     * "Adapters whose providers fold cache hits into a total prompt count
     * (DeepSeek's prompt_tokens) subtract them out."）。
     */
    const u = call.usage;
    const cacheRead = Math.max(0, u.cachedTokens);
    const cacheWrite = Math.max(0, u.cacheWriteTokens ?? 0);
    const uncached = Math.max(0, u.promptTokens - cacheRead);
    store.addMetrics(sessionId, {
      uncached,
      cacheRead,
      cacheWrite,
      tokensOut: u.completionTokens,
      msTotal: Math.max(1, call.ms),
      exact: true,
      // "最近一次"是**覆盖**：悬浮说明里显示它，主显示用累计值。
      last: { uncached, cacheRead, cacheWrite },
    });
    return;
  }
  const est = estimateTokens('x'.repeat(promptChars));
  store.addMetrics(sessionId, {
    uncached: est,
    cacheRead: 0,
    cacheWrite: 0,
    tokensOut: outEst,
    msTotal: Math.max(1, call.ms),
    exact: false,
    last: { uncached: est, cacheRead: 0, cacheWrite: 0 },
  });
}

/**
 * reply 档：一问一答。
 *
 * 与 act 档（runDerivation）的区别**只在管线**：
 * 提示词只有几百字符、模型直接输出文本、一次调用、没有 ops / JSON / 轮次 / 账本 / 作用域。
 * 会话、进度、轨迹、记忆这些机制完全一样 —— 所以它照样不占基底，进度照样能查。
 *
 * 回复会作为 **assistant 消息**写进这个 Agent 的 messages，
 * 组件渲染 a.messages 就能看到（这是 act 档没有的：act 的产出是 ops，不是话）。
 */
async function runReply(
  input: string,
  originId: NodeId,
  sessionId: string,
  runId: string,
  images: string[],
  signal?: AbortSignal,
): Promise<RunSummary> {
  const store = useDesktopStore.getState();
  const origin = store.nodes[originId];
  if (!origin || origin.kind !== 'component') {
    return { ok: false, added: 0, rounds: 0, okCount: 0, failCount: 1, error: '发起组件不存在。' };
  }
  const role = isAgentic(origin) ? origin.agent.systemPrompt : '';
  const historyCount = sessionMemory(originId, sessionId).length;

  const step: TraceStep = {
    id: newId(),
    runId,
    round: 0,
    index: -1,
    kind: 'llm',
    label: '模型回复',
    summary: '回复',
    status: 'running',
    message: '等待模型返回…',
    startedAt: Date.now(),
  };
  store.upsertSessionStep(sessionId, step);
  store.setSessionStatus(sessionId, { running: true, phase: '模型回复中', detail: '', round: 0, runId });

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildReplyPrompt({
        originName: origin.name,
        rolePrompt: role,
        history: historyCount,
        adultMode: store.settings.adultMode === true,
      }),
    },
    ...historyMessages(originId, sessionId, input),
    // 不加【本次请求】标记 —— 那是给 act 档多轮执行用的；这里就是普通的对话上下文。
    { role: 'user', content: userContent(input, images, store.settings.vision !== false) },
  ];

  let text = '';
  let thinking = '';
  const call = await chatWithRetry(store.settings, messages, {
    onDelta: (chunk) => {
      text += chunk;
    },
    onThinking: (chunk) => {
      thinking += chunk;
    },
    // 重试必须清空缓冲，否则会把上一次的半截回复和新回复拼起来。
    onAttempt: () => {
      text = '';
      thinking = '';
    },
  }, 3, signal);

  const failReply = (title: string, detail: string, err: string): RunSummary => {
    store.upsertSessionStep(sessionId, { ...step, status: 'fail', message: err, endedAt: Date.now() });
    store.setSessionStatus(sessionId, { running: false, phase: '失败', detail: err, round: 0 });
    store.setFeedback(mkFeedback('fail', title, detail + visionHint(images, detail)));
    store.log('warn', 'reply ✕ ' + err.slice(0, 120));
    return { ok: false, added: 0, rounds: 0, okCount: 0, failCount: 1, error: err };
  };

  // 停止要排在"失败"前面：它是用户意图，不是故障。
  if (!call.ok && call.stopped) return failReply('已停止', '已按停止。', '已停止');
  if (!call.ok) return failReply('模型回复失败', call.error, call.error);
  const reply = call.text.trim();
  if (!reply) return failReply('模型没有返回内容', '这次调用没有返回文本。', '空内容');
  recordUsage(sessionId, call, messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0), reply);

  // 回复写进记忆：这就是"它说过的话"，组件从这里渲染。
  pushMemory(originId, sessionId, { role: 'assistant', content: reply });
  store.upsertSessionStep(sessionId, {
    ...step,
    status: 'ok',
    message: reply.slice(0, 2000),
    thinking: thinking ? thinking.slice(0, MAX_THINK_CHARS) : undefined,
    raw: call.text.slice(0, MAX_RAW_CHARS),
    endedAt: Date.now(),
  });
  store.setSessionStatus(sessionId, { running: false, phase: '完成', detail: '', round: 0 });
  store.log('llm', 'reply ' + reply.slice(0, 60));
  return { ok: true, added: 0, rounds: 0, okCount: 1, failCount: 0 };
}

export async function runDerivation(input: string, options: RunOptions = {}): Promise<RunSummary> {
  const store = useDesktopStore.getState();
  const settings = store.settings;
  /*
   * 发起节点必须存在。
   *
   * 以前这里会**静默回落到基底**：提交时组件还在、跑起来时已被删，于是这条消息
   * 被基底吃掉了 —— 用户以为在跟子 agent 说话，实际是基底在干。宁可明确失败。
   * 只有"用户直接对着输入框说话"（没给 originId）才落到基底。
   */
  const originId = options.originId ?? store.rootId;
  const origin = store.nodes[originId];
  if (!origin) {
    const msg = '发起节点 ' + originId + ' 已不存在（可能在排队期间被删了），这条消息不再执行。';
    store.log('warn', 'run ✕ ' + msg);
    store.setFeedback(mkFeedback('fail', '发起节点已删除', msg));
    return { ok: false, added: 0, rounds: 0, okCount: 0, failCount: 0, error: msg };
  }

  const sessionId = options.sessionId ?? MAIN_SESSION;
  // 用户按"停止"时 abort 它；轮次之间与模型调用中都会检查。
  const signal = options.signal;
  /*
   * 用户上传的文件已经写进工作区，这里只留下**名字**。
   *
   * 刻意不再把它们拼成多模态或塞进提示词：上传物进上下文会（1）每轮重发、
   * （2）把历史撑大、（3）让"要不要看"这件事由上传自动决定。
   * 现在由 Agent 主动 ws_read —— 它想看什么、看多少，是它的决定。
   */
  const files = (options.files ?? []).filter((f) => typeof f === 'string' && f.length > 0);
  // 有上传文件时，在提示词里明确"它们在哪儿、要主动读"（内容不进提示词）。
  const uploadNote = files.length
    ? '\n\n[UPLOADED FILES] 用户这一轮上传了这些文件，它们**已经在你的工作区里**，' +
      '内容**不在**上下文中：' + files.join('、') +
      '。需要什么先用 ws_read 读（或者用 ws_run 加工），不要凭空猜内容。'
    : '';
  const runId = newId();
  // 轨迹里插一条"任务分隔"，带上用户这次说的那句话（待见 §5.113 的待办 5）。
  store.beginSessionTrace(sessionId, runId, input);
  store.setSessionStatus(sessionId, { running: true, phase: '准备上下文', detail: '', round: 0, runId });
  /*
   * 档位分流。
   *
   * reply 档到此为止：一句小提示词 + 一次调用，回复落进 messages。
   * act 档才需要下面那一整套（接口目录、JSON 解析、多轮、观察回灌、账本、作用域）。
   */
  if (isAgentic(origin) && origin.agent.mode === 'reply') {
    // reply 档的请求没有标记，记忆里存的就是原文 —— 发出去的与存下来的逐字节相同。
    // 记忆里也**不**存文件内容；要读就再读一次（文件还在工作区）。
    pushMemory(originId, sessionId, { role: 'user', content: input });
    return runReply(input, originId, sessionId, runId, [], options.signal);
  }
  /*
   * act 档这一轮用户消息的**唯一拼法**：它既是发出去的那条请求，也是写进记忆的那条。
   *
   * 两处必须是同一个字符串。以前发的是带 [CURRENT REQUEST] 标记的版本、存的却是不带标记的原文，
   * 于是下一轮的历史里同一条消息短了十几个字符 —— **前缀缓存正是从那里断开**，后面那条旧请求
   * 连同整段尾部全部作废（实测换轮只有 77% 能命中）。日志式请求的关键就在这：**只追加，不改写过的东西**。
   * 代价是历史里的旧请求也带着这个标记，所以提示词里那条规则改成"只处理**最后一条**带标记的"。
   */
  const requestText = CURRENT_REQUEST_TAG + '\n' + input + uploadNote;
  pushMemory(originId, sessionId, { role: 'user', content: requestText });

  const pushStep = (step: TraceStep) => useDesktopStore.getState().upsertSessionStep(sessionId, step);
  const setRunStatus = (patch: Partial<RunStatus>): void =>
    useDesktopStore.getState().setSessionStatus(sessionId, patch);

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
    setRunStatus({
      phase: '自动恢复中',
      detail: reason,
      round: roundNo,
    });
  };

  const finish = (summary: RunSummary): RunSummary => {
    setRunStatus({
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
    /**
     * 所有轮次的观察结果，滚动保留。
     *
     * 不能只带最后一轮：多步任务里第 1 轮抓到的页面，到第 3 轮就看不见了，
     * 模型只能反复重抓同一页。用字符预算保留最近的内容。
     */
    const observationLog: string[] = [];
    const pushObservations = (lines: string[]): void => {
      if (lines.length === 0) return;
      observationLog.push(...lines);
      let total = observationLog.reduce((n, s) => n + s.length, 0);
      while (observationLog.length > 1 && total > OBSERVATION_BUDGET) {
        total -= observationLog.shift()!.length;
      }
    };
    let continueLoop = true;
    let round = 0;
    /**
     * 上一轮的"指令 + 结果"指纹，以及它连续重复了几轮。
     *
     * **这里不再"两轮相同就终止任务"**（待办 4）。那种判法把"看起来没进展"直接当成失败：
     * 轮询、等一个异步结果、或者两轮里同样的 inspect 拿到同样的快照，都会被它误杀 ——
     * 用户看到的就是"任务莫名其妙停了"。
     * 现在相同轮次只做两件事：**提醒模型换个做法**（回灌一条观察），
     * 以及记一条日志；只有在**连续很多轮**之后才兜底停下，防的是真的失控烧钱。
     */
    let lastSignature = '';
    let sameRounds = 0;
    /** 连续多少轮完全相同才兜底停（给足模型自我纠正的机会；正常任务走不到这里）。 */
    const SAME_ROUND_LIMIT = 12;

    while (continueLoop) {
    /** 本轮的执行结果。catch 里用它回滚，避免异常留下半成品。 */
    let roundResult: ExecuteResult | null = null;
    try {
        round += 1;
        setRunStatus({ running: true, phase: '模型思考中', round });

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

        /*
         * 系统提示与快照共用同一份入参 —— 两份提示词必须看到同一个世界，
         * 分两处构造迟早会走偏。
         *
         * 顺序也有讲究：**稳定的进系统消息，逐轮会变的进最后那条消息**（见下面的 messages）。
         */
        const promptInput: SystemPromptInput = promptInputFor(originId, origin);
        const systemPrompt = buildSystemPrompt(promptInput);
        const snapshotPrompt = buildSnapshotPrompt(promptInput);

        const systemMessage: ChatMessage = { role: 'system', content: systemPrompt };
        // 显式标出"这一条才是本次任务"：历史里那一串旧请求不加标记时，
        // 模型会把它们当成还没做完的事，于是把上一个任务又做一遍。
        const requestMessage: ChatMessage = { role: 'user', content: userContent(requestText) };
        /*
         * 尾部拆成**两条消息**，顺序是「快照在前、观察在后」。
         *
         * 以前两者拼成一条（观察在前），那是最坏的排法：观察段每轮都重排
         * （预算一满就丢最老的、新一轮又插进来），它的第一个字节就变，于是**整份快照**
         * 也跟着作废 —— 哪怕桌面状态一个字节都没动。实测 8 轮真实请求体：
         * 拼成一条（观察在前）命中 75.2%；拆成两条且快照在前，命中 91.6%。
         *
         * 放在**最后**是因为它是这一轮唯一"注定要变"的东西：放最后 = 它变只影响自己。
         */
        const snapshotMessage: ChatMessage = { role: 'user', content: snapshotPrompt };
        const observationMessage: ChatMessage | null =
          observationLog.length > 0 ? { role: 'user', content: buildObservationPrompt(observationLog) } : null;
        /** 历史能占多少 token：阈值减去系统提示 / 请求 / 快照 / 观察这几块的估算。 */
        const fixedTail = (): ChatMessage[] =>
          observationMessage ? [snapshotMessage, observationMessage] : [snapshotMessage];
        const historyBudget = (): number => {
          const threshold = compactThresholdTokens(store.settings.contextWindow, store.settings.compactAt);
          if (threshold <= 0) return 0;
          return Math.max(0, threshold - estimateTokensOf([systemMessage, requestMessage, ...fixedTail()]));
        };
        const buildMessages = (budgetTokens: number | undefined): ChatMessage[] => [
          systemMessage,
          ...historyMessages(originId, sessionId, requestText, budgetTokens),
          requestMessage,
          ...fixedTail(),
        ];
        /*
         * 先**完整**拼一份（不削历史）再看有没有到阈值：
         * 顺序反了的话，"按预算削历史"会抢在压缩前面动手 —— 那就又变回了截断。
         */
        const thresholdTokens = compactThresholdTokens(store.settings.contextWindow, store.settings.compactAt);
        /** 把这次请求的估算长度与窗口记进运行状态 —— 输入框右下角的圆环读它们。 */
        const publishContext = (msgs: ChatMessage[]): void => {
          setRunStatus({
            contextTokens: estimateTokensOf(msgs),
            contextLimit: store.settings.contextWindow ?? 0,
            contextThreshold: thresholdTokens,
          });
        };
        // 窗口未知（threshold 0）→ 0 会变成"不设上限"，那是错的，要传 undefined 走保守分支。
        let messages = buildMessages(thresholdTokens > 0 ? 0 : undefined);
        publishContext(messages);
        if (thresholdTokens > 0 && estimateTokensOf(messages) > thresholdTokens) {
          const res = await compactMemory(originId, sessionId, store.settings, systemPrompt, signal);
          // 压成功 → 记忆短了，重拼；压不成 → 重拼时给历史一个预算兜底。
          messages = buildMessages(res.compacted ? 0 : historyBudget());
          publishContext(messages);
          pushStep({
            id: newId(),
            runId,
            round,
            index: -4,
            kind: 'compact',
            label: '压缩上下文',
            summary: res.compacted ? '旧历史已压成摘要' : '压缩失败，退回丢弃最老的历史',
            status: res.compacted ? 'ok' : 'fail',
            message: res.compacted
              ? res.before + ' 条 → ' + res.after + ' 条；请求约 ' + estimateTokensOf(messages) + ' token'
              : res.error ?? '未知原因',
            startedAt: Date.now(),
            endedAt: Date.now(),
          });
          store.log(res.compacted ? 'info' : 'warn', res.compacted ? 'compact ' + res.before + ' → ' + res.after + ' 条' : 'compact ✕ ' + (res.error ?? '未知'));
        }
        /*
         * 这里曾经又 push 了一条"观察回灌 + 快照" —— buildMessages() 里已经拼过同一条，
         * 于是每条请求都把这段尾部发两遍：白烧 token，还把"每轮只有一条会变"变成两条
         * （实测同一轮 R1→R2 的字节前缀只有 75%）。删掉，只留 buildMessages 里那一份。
         */

        // 正文与思考分开收集：思考单独展示，不参与 JSON 解析。
        let buffer = '';
        let thinking = '';
        let lastFlush = 0;
        const flush = (force = false): void => {
          const now = Date.now();
          if (!force && now - lastFlush < STREAM_FLUSH_MS) return;
          lastFlush = now;
          pushStep({
            ...modelStep,
            message: (thinking || buffer).slice(-200) || '等待模型返回…',
            thinking: thinking ? thinking.slice(0, MAX_THINK_CHARS) : undefined,
            raw: buffer ? buffer.slice(0, MAX_RAW_CHARS) : undefined,
          });
        };
        const call = await chatWithRetry(settings, messages, {
          // 每次重试都从头累积，绝不把上一次的半截输出留下来
          onAttempt: () => {
            buffer = '';
            thinking = '';
            flush(true);
          },
          onDelta: (chunk) => {
            buffer += chunk;
            flush();
            setRunStatus({ phase: '模型生成指令中', detail: buffer.slice(-140) });
          },
          onThinking: (chunk) => {
            thinking += chunk;
            flush();
            setRunStatus({ phase: '模型思考中', detail: chunk.slice(-140) });
          },
        }, 3, signal);

        if (call.ok) {
          // 每轮都记：act 档一轮可能发多次请求，累计的才是这次任务真实的开销。
          recordUsage(
            sessionId,
            call,
            messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0),
            buffer,
          );
        }

        if (!call.ok) {
          // 重试仍失败：不断整轮终止，而是把错误回灌，让 Agent 下一轮换个做法。
          const msg = call.error;
          pushStep({
            ...modelStep,
            status: 'fail',
            message: msg,
            thinking: thinking ? thinking.slice(0, MAX_THINK_CHARS) : undefined,
            raw: buffer ? buffer.slice(0, MAX_RAW_CHARS) : undefined,
            endedAt: Date.now(),
          });
          store.log('error', 'llm ✕ ' + msg);
          if (recoveries < MAX_RECOVERIES) {
            pushObservations([
              'The model call in the previous round failed: ' + msg,
              'Retry with a simpler approach; if the task cannot be completed, finish with empty ops.',
            ]);
            notifyRetry(round, '模型调用失败，正在重试：' + msg);
            continue;
          }
          useDesktopStore.getState().setFeedback(
            mkFeedback(
              'fail',
              '模型调用失败（已重试）',
              msg,
            ),
          );
          return finish({ ok: false, added: totalAdded, rounds: rounds.length, okCount, failCount, error: msg });
        }
        const raw = call.text;

        /*
         * 正文不是计划时，先看网关有没有把调用放进 tool_calls（那种情况下正文是空的）。
         * 两条来源走**同一个**翻译器：解析层只认一种计划形状，模型用哪种信封都能跑
         * （为什么必须有这一层，见 parse.ts 的 extractNativeCalls）。
         */
        const nativeFromArgs = nativeCallsFromArgs(call.toolCalls ?? []);
        let parsed = parsePlan(raw);
        if ((!parsed.ok || !parsed.plan) && nativeFromArgs.length > 0) {
          parsed = planFromNativeCalls(nativeFromArgs, raw);
        }
        if (!parsed.ok || !parsed.plan) {
          // 解析失败也交给 Agent 自己修：把错误与原始输出片段回灌，下一轮重来。
          const err = parsed.error ?? '解析失败';
          /*
           * **原文与思考必须一起写进这一步。**
           *
           * upsertSessionStep 是**整体替换**（不是合并），而 modelStep 本身没有这两个字段 ——
           * 少了它们，流式阶段 flush 上去的 raw 就被这一步覆盖掉，轨迹里只剩一句
           * "未返回合法指令"。用户看到的正是这个：格式一错就不知道模型到底写了什么，
           * 而"是 JSON 语法错、还是压根没输出 JSON、还是把 JSON 包在解释里"只能看原文才分得清。
           */
          pushStep({
            ...modelStep,
            status: 'fail',
            message: '未返回合法指令：' + err,
            thinking: thinking ? thinking.slice(0, MAX_THINK_CHARS) : undefined,
            raw: raw.slice(0, MAX_RAW_CHARS),
            endedAt: Date.now(),
          });
          store.log('error', 'parse ✕ ' + err);
          if (recoveries < MAX_RECOVERIES) {
            pushObservations([
              'Your previous output was not a valid plan; parsing failed: ' + err,
              'Raw output fragment: ' + raw.slice(0, 300),
              // 翻译器认得出的形式走不到这里；认不出的必须**点名**，否则模型会一直重犯。
              ...(looksLikeNativeCall(raw)
                ? [
                    'Your reply was written in native tool-call syntax (a call block with named parameters).' +
                      ' This protocol declares no tools and never uses that syntax: put every call into ops' +
                      ' as a JSON object, e.g. { "kind": "ws_read", "name": "note.txt" }.',
                  ]
                : []),
              'Output one JSON object only, and kind must be one of the available operations.',
            ]);
            notifyRetry(round, '指令格式错误，正在让其自行修复：' + err);
            continue;
          }
          useDesktopStore.getState().setFeedback(
            mkFeedback('fail', '模型反复没有输出合法指令', err),
          );
          return finish({ ok: false, added: totalAdded, rounds: rounds.length, okCount, failCount, error: err });
        }
        const plan = parsed.plan;
        /*
         * 翻译来的计划：**告诉模型它是怎么被处理的**。
         *
         * 只执行、不吭声，模型下一轮还会用同一种语法（它并不知道我们收下了）。
         * 这条 observation 会跟着本轮结果一起进下一轮的提示词，于是它改用 ops。
         */
        if (parsed.via === 'native') {
          const kinds = plan.ops.map((o) => o.kind).join(', ');
          pushObservations([
            'Your reply used native tool-call syntax instead of a plan; it was translated into ops and executed: ' + kinds + '.',
            'Put those calls into the ops array next time, e.g. { "kind": "ws_read", "name": "note.txt" }.',
          ]);
          store.log('warn', '工具调用语法 → ops: ' + kinds);
        }
        // 收尾时把这一步标记成完成，并把全文（思考 / 原始输出）留在 trace 上 ——
        // 之前这一支忘了把 status 改成 ok，轨迹里会一直显示"进行中"。
        const finalizeModel = (msg: string): void => {
          pushStep({
            ...modelStep,
            status: 'ok',
            message: msg,
            thinking: thinking ? thinking.slice(0, MAX_THINK_CHARS) : undefined,
            raw: buffer ? buffer.slice(0, MAX_RAW_CHARS) : undefined,
            endedAt: Date.now(),
          });
        };
        if (plan.reasoning) {
          store.log('llm', round + ' ' + plan.reasoning);
          // 模型的判断写进这一步的 trace，而不是当作对话消息。
          finalizeModel(plan.reasoning);
        } else {
          finalizeModel('已返回 ' + raw.length + ' 字符');
        }
        if (plan.ops.length === 0) {
          rounds.push({ round, plan, observations: [] });
          break;
        }

        setRunStatus({ phase: '执行指令', detail: plan.ops.length + ' 条', round });
        const result = await executeOps(plan.ops, originId, {
          runId,
          round,
          sessionId,
          // 停止信号一路传到每条操作：在途的请求会断，未执行的直接不执行。
          signal,
          onStep: (step) => {
            pushStep(step);
            setRunStatus({
              phase: '执行 ' + (step.index + 1) + '/' + plan.ops.length,
              // 要点为空时只显示标签 —— 别拼出"抓取网页 · "这种空尾巴。
              detail: step.summary ? step.label + ' · ' + step.summary : step.label,
              round,
            });
          },
        });
        roundResult = result;

        const allFailed = result.outcomes.length > 0 && result.outcomes.every((o) => !o.ok);
        if (allFailed) {
          rollback(result);
          const text = formatOutcomes(result.outcomes);
          store.log('error', 'rollback ' + text.join(' | '));
          rounds.push({ round, plan, observations: text });
          // 全部失败：回滚这一轮，但**不终止整个任务** —— 把失败原因回灌，
          // 让 Agent 下一轮换个写法（常见于源码编译错误）。
          if (recoveries < MAX_RECOVERIES) {
            /*
             * 这一轮已经回滚、马上会重试，所以**不计入最终成败**。
             * 之前是先记账再恢复，于是哪怕模型自己修好了，用户最后仍会收到一条
             * "部分完成：N 成功 / M 失败" 的提示 —— 这就是"每次有错都通知用户"的来源。
             */
            pushObservations([
              'Every operation in your previous round failed, and their changes have been rolled back. Reasons:',
              ...text,
              'Fix them and try again. Common causes: a source syntax error, a reference to an id that does not exist, an undefined variable.',
            ]);
            notifyRetry(round, '全部指令失败，正在重试：' + (text[0] ?? ''));
            continue;
          }
          // 重试机会用完了：这时才把失败算进最终结果，并明确告诉用户。
          failCount += result.outcomes.length;
          useDesktopStore.getState().setFeedback(mkFeedback('fail', '反复失败，已回滚', text.join('\n')));
          return finish({ ok: false, added: totalAdded, rounds: rounds.length, okCount, failCount, error: text[0] });
        }

        okCount += result.outcomes.filter((o) => o.ok).length;
        failCount += result.outcomes.filter((o) => !o.ok).length;
        totalAdded += result.createdIds.length;
        const observations = formatOutcomes(result.outcomes);
        rounds.push({ round, plan, observations });
        // 把这一轮真正做成的事记进 ledger：跨刷新保留，避免下次重做。
        recordLedger(originId, plan.ops, result, input);
        // 执行回执只进 trace 与本轮的观察通道，**不写进消息历史** ——
        // 历史里留下"已创建 X"会让后续轮次误以为 X 还存在（见 §5.19）。
        pushObservations(observations);

        /*
         * 与上一轮完全一致时**不终止任务**，只提醒（待办 4）。
         *
         * 以前这里是"两次相同就判空转、直接结束本轮任务"。那个阈值太紧：
         * 轮询、等异步结果、同一份 inspect 拿到同一份快照，都会被误判成失败。
         * 现在把判断结果变成**回灌给模型的观察**（它自己决定要不要换做法），
         * 只有连续重复 SAME_ROUND_LIMIT 轮才兜底停 —— 那是防失控，不是常规出口。
         */
        const signature = JSON.stringify(plan.ops) + '\u0000' + observations.join('\u0001');
        if (plan.continue === true && signature === lastSignature) {
          sameRounds += 1;
          store.log('warn', 'loop · 连续 ' + (sameRounds + 1) + ' 轮指令与结果相同');
          if (sameRounds >= SAME_ROUND_LIMIT) {
            useDesktopStore.getState().setFeedback(
              mkFeedback('fail', '连续多轮没有进展，已停止', '连续 ' + (sameRounds + 1) + ' 轮的指令与结果完全一致，继续下去不会有新结果。'),
            );
            return finish({ ok: false, added: totalAdded, rounds: rounds.length, okCount, failCount, error: '无进展' });
          }
          // 提醒它换做法：把"你在重复"这件事明确说出来，并给出常见的下一步。
          pushObservations([
            'Your last round repeated the previous round exactly: same ops, same results. Repeating it again will',
            'not change anything. Change the approach — inspect the current state first, fix the failing source, or',
            'finish with {"reasoning":"done","continue":false,"ops":[]} if the task is actually complete.',
          ]);
        } else {
          sameRounds = 0;
        }
        lastSignature = signature;
        continueLoop = plan.continue === true;
    } catch (e) {
      /*
       * 单轮里出现意外异常（编排代码本身出错、store 状态异常等）时，**不直接结束整个任务** ——
       * 和 op 失败一样走恢复流程：回滚这一轮的改动、把原因回灌、重试。
       * 之前这类异常直接落到最外层 catch，一次就把任务判死，看起来就是"错误处理没触发"。
       */
      const msg = (e as Error)?.message ?? String(e);
      store.log('error', 'round ' + round + ' ✕ ' + msg);
      if (roundResult) rollback(roundResult);
      pushStep({
        id: newId(),
        runId,
        round,
        index: -3,
        kind: 'recover',
        label: '单轮异常',
        summary: '第 ' + round + ' 轮抛出异常' + (roundResult ? '（已回滚该轮改动）' : ''),
        status: 'fail',
        message: msg,
        startedAt: Date.now(),
        endedAt: Date.now(),
      });
      if (recoveries < MAX_RECOVERIES) {
        pushObservations([
          'An internal exception occurred while executing your previous round: ' + msg,
          'Retry with a simpler, more conservative approach.',
        ]);
        notifyRetry(round, '单轮异常，正在重试：' + msg);
        continue;
      }
      useDesktopStore.getState().setFeedback(mkFeedback('fail', '执行异常（已重试）', msg));
      return finish({ ok: false, added: totalAdded, rounds: rounds.length, okCount, failCount, error: msg });
    }
    }

    /*
     * 模型可能回一个空 ops 说"已完成"，界面上却什么都没变。
     * 这种情况不能报成功 —— 用户什么都看不到，只会以为系统坏了。
     */
    if (okCount === 0 && failCount === 0 && totalAdded === 0) {
      useDesktopStore.getState().setFeedback(
        mkFeedback('fail', '没有产生任何改动', '模型这一轮没有给出可执行的指令，界面没有变化。可以换一种说法再试。'),
      );
      return finish({ ok: false, added: 0, rounds: rounds.length, okCount: 0, failCount: 0, error: '空指令' });
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
    setRunStatus({ running: false, phase: '失败', detail: msg, round: 0 });
    return { ok: false, added: 0, rounds: 0, okCount: 0, failCount: 0, error: msg };
  }
}

function deskNodes(): Record<string, YggNode> {
  return desktop().nodes;
}

/**
 * 组装一份 promptInput。
 *
 * **抽成一处**：系统提示、快照、以及手动压缩都要看到同一个世界。
 * 以前它内联在 runDerivation 的循环里，于是"手动压缩"想复用它只能重写一遍 ——
 * 那两份迟早会走偏（漏一个字段就等于压缩时看到的世界和真实请求不一样，
 * 而复用缓存恰恰要求前缀逐字节相同）。
 */
function promptInputFor(originId: NodeId, origin: YggNode): SystemPromptInput {
  const store = useDesktopStore.getState();
  const desk = desktop();
  return {
    nodes: deskNodes(),
    rootId: desk.rootId,
    viewW: desk.viewW,
    viewH: desk.viewH,
    tokens: desk.tokens,
    tools: agentTools(origin),
    originName: origin.name,
    hostId: originId,
    rolePrompt: isAgentic(origin) ? origin.agent.systemPrompt : '',
    ledger: currentLedger(originId),
    scope: isAgentic(origin) ? origin.agent.scope : undefined,
    // 能力开关：没开的接口不会出现在接口目录里，提示词也少一大截。
    caps: isAgentic(origin) ? origin.agent.caps : undefined,
    adultMode: store.settings.adultMode === true,
    // 精简模式：固定提示词压到最简（内容与能力开关无关，只影响"讲多少"）。
    terse: store.settings.terse === true,
    defaultWindows: defaultWindowsText(defaultWindows(desk)),
  };
}

/**
 * 这个会话现在"大概占了多少上下文"（估算 token）。
 *
 * 与真正发出去的那份**同一套拼法**（同一个系统提示、同一份快照、同一份记忆），
 * 只是用"当前完整记忆"而不是某一轮的历史切片 —— 圆环要回答的是
 * "现在大概多少"，不需要精确到某一轮。**只用于展示与手动压缩后的刷新。**
 */
export function contextUsageOf(originId: NodeId, sessionId: string): number {
  const store = useDesktopStore.getState();
  const origin = store.nodes[originId];
  if (!origin || origin.kind !== 'component') return 0;
  const input = promptInputFor(originId, origin);
  const system = buildSystemPrompt(input);
  const memory = sessionMemory(originId, sessionId)
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: userContent(m.content, m.images, store.settings.vision !== false) }));
  return estimateTokensOf([
    { role: 'system', content: system },
    ...memory,
    { role: 'user', content: buildSnapshotPrompt(input) },
  ]);
}

/**
 * **手动压缩**：用户点输入框右下角那个圆环时调用。
 *
 * 与自动压缩走同一个 compactMemory、同样的参数 —— 区别只是触发者。
 * 有意不复制一份实现：手动压缩唯一的价值就是"我现在就想压"，
 * 如果它的行为与自动压缩不同，用户按下去得到的就不是他预期的那件事。
 */
export async function compactSessionNow(
  originId: NodeId,
  sessionId: string,
): Promise<{ ok: boolean; before: number; after: number; error?: string }> {
  const store = useDesktopStore.getState();
  const origin = store.nodes[originId];
  if (!origin || origin.kind !== 'component') {
    return { ok: false, before: 0, after: 0, error: '发起节点不存在。' };
  }
  const step: TraceStep = {
    id: newId(),
    runId: 'manual-compact',
    round: 0,
    index: -5,
    kind: 'compact',
    label: '手动压缩上下文',
    summary: '用户点了上下文圆环',
    status: 'running',
    message: '正在把旧历史压成摘要…',
    startedAt: Date.now(),
  };
  store.upsertSessionStep(sessionId, step);
  store.setSessionStatus(sessionId, { phase: '压缩上下文中', detail: '' });

  const systemPrompt = buildSystemPrompt(promptInputFor(originId, origin));
  const res = await compactMemory(originId, sessionId, store.settings, systemPrompt);

  // 压完立刻刷新圆环：这是用户按下去的**唯一可见结果**，不刷新等于没反馈。
  const after = contextUsageOf(originId, sessionId);
  store.upsertSessionStep(sessionId, {
    ...step,
    status: res.compacted ? 'ok' : 'fail',
    summary: res.compacted ? res.before + ' 条 → ' + res.after + ' 条' : '没有压缩',
    message: res.compacted
      ? '旧历史已压成摘要；上下文约 ' + after + ' token'
      : (res.error ?? '没有可压缩的历史'),
    endedAt: Date.now(),
  });
  store.setSessionStatus(sessionId, {
    phase: '',
    detail: '',
    contextTokens: after,
    contextLimit: store.settings.contextWindow ?? 0,
    contextThreshold: compactThresholdTokens(store.settings.contextWindow, store.settings.compactAt),
  });
  store.log(res.compacted ? 'info' : 'warn', res.compacted
    ? 'compact (manual) ' + res.before + ' → ' + res.after + ' 条'
    : 'compact (manual) ✕ ' + (res.error ?? '未知'));
  return { ok: res.compacted, before: res.before, after: res.after, error: res.error };
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
  /*
   * **按能力裁剪插件工具**：一个没开 net 的 Agent 不该在工具目录里看到插件带来的联网工具。
   *
   * 提示词裁剪只是第一道（让它别去试），真正的拒绝在 call_tool 里 ——
   * 模型可能从别处见过工具名，光裁目录挡不住。
   */
  const caps = origin.agent.caps;
  const visible = caps ? all.filter((t) => !t.cap || caps.includes(t.cap)) : all;
  const ids = origin.agent.toolIds;
  if (!ids || ids.length === 0) return visible;
  const wanted = new Set(ids);
  const subset = visible.filter((t) => wanted.has(t.id));
  return subset.length > 0 ? subset : visible;
}

/**
 * 把这一轮做成的实体记进 ledger。
 *
 * 每条都带上"来自哪个请求"，这样模型能直接看出"这条历史是在回应哪句话" ——
 * 没有这个对应关系时，它只能看到一串互不相关的实体，容易把旧请求当成没做完。
 */
function recordLedger(
  originId: NodeId,
  ops: DerivationOp[],
  result: { outcomes: Array<{ ok: boolean; createdId?: NodeId }> },
  request: string,
): void {
  const entries: string[] = [];
  const store = useDesktopStore.getState();
  ops.forEach((op, i) => {
    const outcome = result.outcomes[i];
    if (!outcome?.ok) return;
    const created = outcome.createdId ? store.nodes[outcome.createdId] : undefined;
    if (op.kind === 'create_component' && created) {
      entries.push('component "' + created.name + '" (id=' + created.id + ')');
    } else if (op.kind === 'create_tool' && created) {
      entries.push('tool "' + created.name + '" (id=' + created.id + ')');
    } else if (op.kind === 'replace_surface' && typeof op.surface === 'string') {
      entries.push('replaced surface slot ' + op.surface);
    } else if (op.kind === 'update_theme') {
      entries.push('rewrote the global style');
    } else if (op.kind === 'set_node_tokens' && typeof op.id === 'string') {
      entries.push('overrode the local style of node id=' + op.id);
    } else if (op.kind === 'update_component' && typeof op.id === 'string') {
      const name = store.nodes[op.id]?.name ?? '';
      entries.push('changed component' + (name ? ' "' + name + '"' : '') + ' id=' + op.id);
    }
  });
  if (entries.length === 0) return;
  /*
   * 请求引文**只挂在该轮第一条**账本行上。
   *
   * 以前每条都挂：一轮做了 4 件事，快照里就有 4 行重复同一句用户原话 ——
   * 账本本来就排在每轮的最后一条消息里（离回答最近），重复引用等于每轮把
   * "用户要什么"往模型眼前推好几次，它就会把目标当成每轮都要交代的事。
   * 一条足够归属，多的只是占上下文。
   */
  const from = request.replace(/\s+/g, ' ').trim().slice(0, 40);
  store.appendLedger(
    originId,
    entries.map((e, i) => e + (from && i === 0 ? '  <- request "' + from + '"' : '')),
  );
}

export type { DerivationOutcome, DerivationOp };

export { stripFence };