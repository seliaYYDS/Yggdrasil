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
import type { ChatMessage, ContentPart } from '../llm/types';
import { parsePlan } from './parse';
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

function historyMessages(nodeId: NodeId, sessionId: string, input: string): ChatMessage[] {
  /*
   * 整块裁剪，不要一条一条滑：发出去的历史越长，每次"滑动"作废的前缀就越多。
   * 允许涨到上限 + 余量，再一次性削回上限。
   */
  const all = sessionMemory(nodeId, sessionId);
  /*
   * ⚠ **必须先复制再动**：这份数组就是会话记忆本身，下面那个 `pop()` 会把真实记忆删掉。
   * 之前写的是 `sessionMemory(...).slice(-MAX)`，slice 恰好复制了一份才没出事；
   * 改成"没超上限就原样用"之后，`pop()` 直接作用在记忆上 ——
   * 结果是每轮开头刚写进去的那条请求又被弹出去，会话记忆永远是空的。
   */
  const list =
    all.length > MAX_HISTORY_MESSAGES + HISTORY_TRIM_SLACK
      ? all.slice(-MAX_HISTORY_MESSAGES)
      : all.slice();
  if (list.length > 0 && list[list.length - 1].content === input) list.pop();
  return list
    .filter((m: Message) => m.role !== 'system')
    .map((m: Message) => ({ role: m.role, content: userContent(m.content, m.images) }));
}

/*
 * 记忆写入统一走 pushMemory（见上）：基底写会话、组件写 facet，两处都封顶
 * MAX_STORED_MESSAGES —— 识图会让消息带 base64，不封顶能把 IndexedDB 撑爆。
 */

export interface RunOptions {
  originId?: NodeId;
  /** 发起这次运行的输入框（会话）。工作状态按会话隔离，默认是主会话。 */
  sessionId?: string;
  /** 这次请求附带的图片（data URL）。用户在输入框里粘贴或拖进来的。 */
  images?: string[];
}

/**
 * 一条用户消息的 content。
 * 没有图片就是纯文本；有图片时拼成多模态内容块（OpenAI 兼容格式）。
 * 抽成独立函数是为了能直接单测形状。
 */
export function userContent(text: string, images?: string[]): ChatMessage['content'] {
  const list = (images ?? []).filter((u) => typeof u === 'string' && u.startsWith('data:image/'));
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
      ? '这个报错看起来和图片有关：**当前模型大概率不支持识图**。'
      : '这次请求带了 ' + images.length + ' 张图片。如果模型不支持识图，就会像这样整条失败。') +
    '请在右上角设置里换一个支持视觉的模型（例如 gpt-4o / claude-3.5 / qwen-vl）再试；' +
    '换成纯文本模型时，先把图片去掉。'
  );
}

/** 当前请求的标记，与提示词里的「你每次只处理标注为【本次请求】的那一条消息」对应。 */
const CURRENT_REQUEST_TAG = '【本次请求】';

/** 单次运行允许的"出错后重来"次数上限，防止反复失败烧掉轮次。 */
const MAX_RECOVERIES = 3;

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
  /** 服务端报的用量；没报就是 null（上层按字符估算）。 */
  usage: LlmUsage | null;
  /** 这一次（含重试后成功的那次）的耗时。 */
  ms: number;
}
interface CallFail {
  ok: false;
  error: string;
}

async function chatWithRetry(
  settings: Parameters<typeof chatStream>[0],
  messages: ChatMessage[],
  handlers: StreamHandlers,
  attempts = 3,
): Promise<CallOk | CallFail> {
  let lastError = '';
  for (let i = 0; i < attempts; i += 1) {
    handlers.onAttempt?.(i);
    const ctl = new AbortController();
    const timer = window.setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const out = await chatStream(settings, messages, {
        onDelta: handlers.onDelta,
        onThinking: handlers.onThinking,
        signal: ctl.signal,
      });
      return { ok: true, text: out.text, usage: out.usage, ms: out.ms };
    } catch (e) {
      lastError = (e as Error).message;
      if (!isRetryable(lastError) || i === attempts - 1) break;
      await sleep(400 * (i + 1));
    } finally {
      window.clearTimeout(timer);
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
    store.addMetrics(sessionId, {
      tokensIn: call.usage.promptTokens,
      tokensOut: call.usage.completionTokens,
      cachedIn: call.usage.cachedTokens,
      msTotal: Math.max(1, call.ms),
      exact: true,
    });
    return;
  }
  store.addMetrics(sessionId, {
    tokensIn: estimateTokens('x'.repeat(promptChars)),
    tokensOut: outEst,
    cachedIn: 0,
    msTotal: Math.max(1, call.ms),
    exact: false,
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
    { role: 'user', content: userContent(input, images) },
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
  });

  const failReply = (title: string, detail: string, err: string): RunSummary => {
    store.upsertSessionStep(sessionId, { ...step, status: 'fail', message: err, endedAt: Date.now() });
    store.setSessionStatus(sessionId, { running: false, phase: '失败', detail: err, round: 0 });
    store.setFeedback(mkFeedback('fail', title, detail + visionHint(images, detail)));
    store.log('warn', 'reply ✕ ' + err.slice(0, 120));
    return { ok: false, added: 0, rounds: 0, okCount: 0, failCount: 1, error: err };
  };

  if (!call.ok) return failReply('模型回复失败', call.error, call.error);
  const reply = call.text.trim();
  if (!reply) return failReply('模型没有返回内容', '这次调用没有拿到任何文本。', '空内容');
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
  const images = (options.images ?? []).filter(
    (u) => typeof u === 'string' && u.startsWith('data:image/'),
  );
  const runId = newId();
  store.beginSessionTrace(sessionId, runId);
  store.setSessionStatus(sessionId, { running: true, phase: '准备上下文', detail: '', round: 0, runId });
  pushMemory(originId, sessionId, { role: 'user', content: input, ...(images.length ? { images } : {}) });

  /*
   * 档位分流。
   *
   * reply 档到此为止：一句小提示词 + 一次调用，回复落进 messages。
   * act 档才需要下面那一整套（接口目录、JSON 解析、多轮、观察回灌、账本、作用域）。
   */
  if (isAgentic(origin) && origin.agent.mode === 'reply') {
    return runReply(input, originId, sessionId, runId, images);
  }

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
     * 上一轮的"指令 + 结果"指纹。
     * 没有轮次上限，所以需要一个**空转判定**兜底：连续两轮给出完全相同的指令、
     * 又得到完全相同的结果，说明再跑下去不会有新东西。这不是步数上限 ——
     * 只要每轮真的在推进，轮次就不封顶。
     */
    let lastSignature = '';

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
        const promptInput: SystemPromptInput = {
          nodes: deskNodes(),
          rootId: desktop().rootId,
          viewW: desktop().viewW,
          viewH: desktop().viewH,
          tokens: desktop().tokens,
          tools: agentTools(origin),
          originName: origin.name,
          hostId: originId,
          rolePrompt: isAgentic(origin) ? origin.agent.systemPrompt : '',
          ledger: currentLedger(originId),
          scope: isAgentic(origin) ? origin.agent.scope : undefined,
          // 能力开关：没开的接口不会出现在接口目录里，提示词也少一大截。
          caps: isAgentic(origin) ? origin.agent.caps : undefined,
          adultMode: store.settings.adultMode === true,
          defaultWindows: defaultWindowsText(defaultWindows(desktop())),
        };
        const systemPrompt = buildSystemPrompt(promptInput);
        const snapshotPrompt = buildSnapshotPrompt(promptInput);

        const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt },
          ...historyMessages(originId, sessionId, input),
          // 显式标出"这一条才是本次任务"：历史里那一串旧请求不加标记时，
          // 模型会把它们当成还没做完的事，于是把上一个任务又做一遍。
          { role: 'user', content: userContent(CURRENT_REQUEST_TAG + '\n' + input, images) },
        ];
        /*
         * **最快的缓存前缀**：稳定系统提示 → 历史 → 本次请求 → 观察回灌 → 本轮的快照。
         *
         * 逐轮会变的只有最后那一条：观察回灌只会在尾部追加（所以上一轮那段仍能复用），
         * 快照排在它后面（它每轮都变，放最后才不污染前面任何东西）。
         * 以前快照在系统提示里，导致历史与请求每轮全部重算 —— 命中率就是这么丢的。
         */
        messages.push({
          role: 'user',
          content:
            (observationLog.length > 0 ? buildObservationPrompt(observationLog) + '\n\n' : '') +
            snapshotPrompt,
        });

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
        }, 3);

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
              '上一轮模型调用失败：' + msg,
              '请换一个更简单的做法重试；如果任务无法完成，用空 ops 结束。',
            ]);
            notifyRetry(round, '模型调用失败，正在重试：' + msg);
            continue;
          }
          useDesktopStore.getState().setFeedback(
            mkFeedback(
              'fail',
              images.length > 0 ? '带图片的请求失败' : '模型调用失败（已重试）',
              msg + visionHint(images, msg),
            ),
          );
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
          if (recoveries < MAX_RECOVERIES) {
            pushObservations([
              '你上一轮的输出不是合法指令，解析失败：' + err,
              '原始输出片段：' + raw.slice(0, 300),
              '请只输出一个 JSON 对象，kind 必须是可用接口之一。',
            ]);
            notifyRetry(round, '指令格式错误，正在让其自行修复：' + err);
            continue;
          }
          useDesktopStore.getState().setFeedback(
            mkFeedback('fail', '模型反复没有输出合法指令', err + visionHint(images, err)),
          );
          return finish({ ok: false, added: totalAdded, rounds: rounds.length, okCount, failCount, error: err });
        }
        const plan = parsed.plan;
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
          onStep: (step) => {
            pushStep(step);
            setRunStatus({
              phase: '执行 ' + (step.index + 1) + '/' + plan.ops.length,
              detail: step.label + ' · ' + step.summary,
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
              '你上一轮的所有指令都失败了，已回滚它们造成的改动。失败原因：',
              ...text,
              '请修正后重试。常见原因：源码语法错误、引用了不存在的 id、变量未定义。',
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

        // 无轮次上限下的空转保护：指令与结果都与上一轮完全一致时停下来。
        // 只判"完全一致"，因此真实的推进（哪怕只是新建了一个同名字的组件）不会被误伤。
        const signature = JSON.stringify(plan.ops) + '\u0000' + observations.join('\u0001');
        if (plan.continue === true && signature === lastSignature) {
          store.log('warn', 'loop ✕ 连续两轮指令与结果完全一致，判定空转');
          useDesktopStore.getState().setFeedback(
            mkFeedback('fail', '检测到空转，已停止', '连续两轮的指令与结果完全一致，继续下去不会有新结果。'),
          );
          return finish({ ok: false, added: totalAdded, rounds: rounds.length, okCount, failCount, error: '空转' });
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
          '你上一轮执行时出现了内部异常：' + msg,
          '请换一个更简单、更保守的做法重试。',
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
        mkFeedback('fail', '没有产生任何改动', '模型这一轮没有给出可执行的指令，界面上什么都没变。换个说法再说一次通常就好了。'),
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
      entries.push('组件「' + created.name + '」(id=' + created.id + ')');
    } else if (op.kind === 'create_tool' && created) {
      entries.push('工具「' + created.name + '」(id=' + created.id + ')');
    } else if (op.kind === 'replace_surface' && typeof op.surface === 'string') {
      entries.push('替换了界面插槽 ' + op.surface);
    } else if (op.kind === 'update_theme') {
      entries.push('改写了全局样式');
    } else if (op.kind === 'set_node_tokens' && typeof op.id === 'string') {
      entries.push('覆写了节点 id=' + op.id + ' 的局部样式');
    } else if (op.kind === 'update_component' && typeof op.id === 'string') {
      const name = store.nodes[op.id]?.name ?? '';
      entries.push('修改了组件' + (name ? '「' + name + '」' : '') + ' id=' + op.id);
    }
  });
  if (entries.length === 0) return;
  const from = request.replace(/\s+/g, ' ').trim().slice(0, 40);
  store.appendLedger(
    originId,
    entries.map((e) => e + (from ? '　← 请求「' + from + '」' : '')),
  );
}

export type { DerivationOutcome, DerivationOp };

export { stripFence };