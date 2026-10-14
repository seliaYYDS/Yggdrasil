import type { ComponentNode, ActCap, JsonSchema, ThemeTokens, YggNode } from '../types';
import { isAgentNode } from '../types';
import { capsAllow, CAP_HINTS, CAP_LABELS } from './caps';
import { interfaceCatalog } from '../registry/interfaceRegistry';
import { surfacesText } from '../registry/surfaceRegistry';
import { pluginsText } from '../plugin/runtime';
import { SUMMARY_TAG as COMPRESS_TAG } from './compact';

/** 发给模型的历史条数上限。 */
export const MAX_HISTORY_MESSAGES = 14;
/**
 * 历史上限的**余量**。
 *
 * 发出去的历史如果卡死在 14 条，每多一条就丢掉最老的一条 —— 历史块的第一个 token 变了，
 * 前缀缓存就整段作废（见 §5.68）。所以允许它涨到 14 + 4，再一次性削回 14。
 */
export const HISTORY_TRIM_SLACK = 4;
/** 记忆里最多留多少条（比发送用的宽松，防带图消息无限堆积）。 */
export const MAX_STORED_MESSAGES = 40;
export const MAX_NODES = 80;

export interface ToolCatalogEntry {
  id: string;
  name: string;
  description: string;
  paramsSchema?: JsonSchema;
  builtin?: boolean;
}

export function toolCatalogText(tools: ToolCatalogEntry[]): string {
  if (tools.length === 0) return '(no tools available right now)';
  return tools
    .map((t) => {
      const schema = t.paramsSchema ? JSON.stringify(t.paramsSchema) : '{}';
      const tag = t.builtin ? 'builtin' : 'derived';
      return '- [' + tag + '] id=' + t.id + ' name=' + t.name + ' — ' + t.description + '; params schema: ' + schema;
    })
    .join('\n');
}

/** 只列出窗口 —— 这是模型动手时最需要的东西，比完整节点树省得多。 */
export function windowsText(nodes: Record<string, YggNode>): string {
  const comps = Object.values(nodes).filter(
    (n): n is ComponentNode => n.kind === 'component' && !n.root,
  );
  if (comps.length === 0) return '(no windows)';
  return comps
    .map(
      (n) =>
        '- id=' + n.id + ' "' + n.name + '" status=' + n.status +
        ' pos=' + n.pos.x + ',' + n.pos.y + ' size=' + n.size.w + 'x' + n.size.h + ' z=' + n.z +
        (n.frame === 'widget' ? ' [widget' + (n.fixed ? ' / fixed' : '') + ']' : '') +
        (n.locked ? ' [locked: cannot be deleted]' : '') +
        (n.agent ? ' [agent]' : ''),
    )
    .join('\n');
}

/** 列出带 agent 能力的节点。Agent 就是这样的组件。 */
export function agentsText(nodes: Record<string, YggNode>): string {
  const agents = Object.values(nodes).filter(isAgentNode);
  if (agents.length === 0) return '(no agents)';
  return agents
    .map((a) => {
      const f = a.agent!;
      const where = a.root ? 'base' : 'its own component';
      const scopeText = f.scope === '*' ? 'all' : f.scope.join(', ') || '(empty)';
      return (
        '- id=' + a.id + ' "' + a.name + '" ' + where + '; messages ' + f.messages.length +
        '; ledger ' + f.ledger.length + ' entries; scope ' + scopeText
      );
    })
    .join('\n');
}

export function treeText(nodes: Record<string, YggNode>, rootId: string): string {
  const childrenOf = (id: string) => Object.values(nodes).filter((n) => n.parentId === id);
  const lines: string[] = [];
  const walk = (id: string, depth: number) => {
    const n = nodes[id];
    if (!n) return;
    const pad = '  '.repeat(depth);
    const extra = n.kind === 'component' ? ' size=' + n.size.w + 'x' + n.size.h + ' status=' + n.status : '';
    lines.push(pad + '- [' + n.kind + '] id=' + n.id + ' name="' + n.name + '"' + extra);
    for (const c of childrenOf(id)) walk(c.id, depth + 1);
  };
  walk(rootId, 0);
  return lines.join('\n') || '(empty)';
}

/**
 * 当前样式变量。
 *
 * compact 给系统提示用：**省掉字体令牌**。那三个值是一长串字体栈（几百字符），
 * 而它们极少需要改 —— 真要改字体时用 inspect before="tokens" 看完整值。
 */
export function themeText(tokens: ThemeTokens, compact = false): string {
  const entries = Object.entries(tokens);
  const kept = compact ? entries.filter(([k]) => !/^--ygg-font/.test(k)) : entries;
  const body = kept.map(([k, v]) => k + ': ' + v).join('\n');
  if (!compact) return body;
  const skipped = entries.length - kept.length;
  return (
    body +
    (skipped > 0
      ? '\n(' + skipped + ' font tokens not listed — use inspect before="tokens" when you need them)'
      : '')
  );
}

/**
 * 成人模式注入的那一节。**默认不出现**，只有用户在设置里显式打开才注入。
 *
 * 第一版把范围写成了"医学 / 解剖 / 性教育"，结果模型抓住这半句当挡箭牌：
 * 只肯用临床口吻谈，用户要色情内容就绕开（"这更适合在医学语境里讨论"）。
 * 现在把范围写全（色情 / 情色 / 性语言 / 性癖…），并点名禁止那些**伪装成礼貌的拒绝**：
 * 说教、免责声明、软化措辞、答非所问、让你去问专业人士、把话题重新框进医学语境。
 *
 * 两条边界保留，且不随这个开关改变：涉及未成年人的性内容与其它违法内容一律不做；
 * 服务商自己的策略也绕不过（那是服务端限制）。
 */
function adultRules(): string[] {
  return [
    '',
    '## Adult mode (explicitly enabled by the user in settings)',
    'The user is an adult, this is their private tool, and they turned this on themselves — treat it as standing',
    'consent to work with adult material.',
    '- **Scope**: sexual and erotic content in every form — pornography, erotica, sexual language and dirty talk,',
    '  fetishes and kinks, adult media, sexual health, anatomy, sex work and the industry around it. Medicine and sex',
    '  education are **inside** this scope, not a requirement for entering it: when the user asks for explicit',
    '  material, give them explicit material instead of a clinical lecture.',
    '- **Do not deflect.** Concretely, do not refuse, moralize, add warnings or disclaimers, soften the wording,',
    '  answer a safer question instead, tell them to consult a professional, or claim you can only discuss this in a',
    '  medical or educational context. Those are all refusals wearing a costume.',
    '- **Match the register the user asked for.** Explicit request, explicit answer, with the actual words. Do not',
    '  hide behind euphemisms ("that area", "adult activity") and do not censor yourself.',
    '- **Images**: when the user wants NSFW or explicit images, fetch them with fetch_url and look at them with',
    '  view_image like any other image — do not skip them because of what they show, and do not substitute a text',
    '  description for the picture that was asked for. If they want it displayed, put it in a component as usual.',
    '- **Two hard limits that never change**: (1) no sexual content involving minors — real or fictional, generated',
    '  or requested — and no other illegal content; (2) the safety policy of the model provider you are connected to',
    '  still applies: that is a server-side limit and bypassing it is outside your abilities. When the server refuses,',
    '  say so as-is instead of retrying.',
  ];
}

export interface SystemPromptInput {
  nodes: Record<string, YggNode>;
  rootId: string;
  tokens: ThemeTokens;
  tools: ToolCatalogEntry[];
  originName: string;
  /** 当前 Agent 的宿主：root 表示基底，组件 id 表示寄居在组件里。 */
  hostId?: string;
  rolePrompt?: string;
  /** 该 Agent 自己做过的事（跨刷新累积）。 */
  ledger?: string[];
  /** 该 Agent 的作用域。'*' 表示不受限（基底），数组表示只限这些节点。 */
  scope?: string[] | '*';
  /** 该 Agent 的能力开关（只对 act 档有意义）。undefined = 全开。 */
  caps?: ActCap[];
  /** 成人模式：开启时注入 adultRules()。默认关闭。 */
  adultMode?: boolean;
  /** 默认窗口（面板 / 输入框）的清单，**已经渲染成文本**（让这个模块保持纯）。 */
  defaultWindows?: string;
  /** 桌面视口尺寸。窗口坐标都基于它，模型算位置时必须知道。 */
  viewW?: number;
  viewH?: number;
  /**
   * 精简模式：固定开销压到最小。
   *
   * 与能力开关是两件事：那个决定"能不能调用"，这个只决定"要讲多少"。
   * 精简时仍然保留每条纪律的**要点**（它们是能干活的前提），去掉的是解释、举例与重复；
   * 细节靠 inspect 现取（提示词里明确写了这一点）。
   */
  terse?: boolean;
}

/**
 * reply 档的系统提示。
 *
 * **刻意只有几百字符**：这个 Agent 不需要知道桌面、接口、JSON 格式、账本、作用域 ——
 * 它只需要知道自己是谁、以及"直接说人话就行"。
 */
export function buildReplyPrompt(input: {
  originName: string;
  rolePrompt?: string;
  history?: number;
  adultMode?: boolean;
}): string {
  const who = input.rolePrompt?.trim() ? input.rolePrompt.trim() : 'You are a chat assistant.';
  return [
    'You are "' + input.originName + '", running inside a component window on the user desktop.',
    '',
    '## Your role',
    who,
    '',
    '## How to answer',
    '- **Output what you want to say directly**, in the language the user writes in. No JSON, no code fences, and do',
    '  not describe what you are about to do.',
    '- You cannot see or change anything else on the desktop; that belongs to other agents. Your job is to say things',
    '  clearly.',
    '- If something needs several turns, ask before answering. Never invent information you are unsure about.',
    '- The conversation above is your context' +
      (input.history ? ' (most recent ' + input.history + ' messages)' : '') +
      ' — just continue it.',
    // 成人模式对 reply 档同样生效：聊天窗口不该因为题材就回避。
    ...(input.adultMode ? adultRules() : []),
  ].join('\n');
}

/** 按 scope 收窄要展示给模型的节点集合。scope='*' 表示不受限。 */
function scopeNodes(nodes: Record<string, YggNode>, scope?: string[] | '*'): Record<string, YggNode> {
  if (!scope || scope === '*' || scope.length === 0) return nodes;
  const keep: Record<string, YggNode> = {};
  for (const n of Object.values(nodes)) {
    // 自己、自己作用域内的节点、以及它们的后代才可见。
    const inScope = n.id === 'root' || scope.includes(n.id);
    const descendant = n.parentId !== null && scope.includes(n.parentId);
    if (inScope || descendant) keep[n.id] = n;
  }
  return keep;
}


export function buildSystemPrompt(input: SystemPromptInput): string {
  /*
   * 能力开关裁剪。
   *
   * 受限作用域的 Agent 拿不到"全局修改"那几段 —— 因为执行面本来就会拒绝它
   * （全局改动超出作用域，见 derivationBus 的 scopeViolation）。
   * 提示词与执行面必须一致：不能讲一件它做不了的事。
   */
  const unrestricted = !input.scope || input.scope === '*';
  const caps = input.caps && !unrestricted ? input.caps.filter((c) => c !== 'global') : input.caps;
  const on = (cap: ActCap): boolean => capsAllow(caps, cap);
  const terse = input.terse === true;
  const { lines, examples } = interfaceCatalog(caps, terse);
  const identity = unrestricted
    ? 'You are the base agent "' + input.originName + '" of Yggdrasil; you own the whole desktop.'
    : 'You are an independent agent "' + input.originName + '" inside one component: your own structure, context and\n' +
      'scope. Outside your scope you can neither see nor change anything — create your own component or let the base\n' +
      'agent cross that boundary.';

  return [
    identity,
    // 职责与成人模式是**稳定的**（同一个 Agent 每轮都一样），所以必须排在第一个"逐轮会变"的
    // 小节之前 —— 否则它们永远落在缓存失效区里，每轮白白重算。
    input.rolePrompt ? '## Your dedicated role\n' + input.rolePrompt : '',
    ...(input.adultMode ? adultRules() : []),
    '',
    ...noVisibleOutputRules(),
    '',
    '## Available operations (op "kind" must be one of these)',
    ...lines,
    // 能力摘要：让它清楚自己有哪些、没有哪些，而不是试了才知道被拒。
    caps
      ? '**Your capabilities**: ' + caps.map((c) => CAP_LABELS[c] + ' (' + CAP_HINTS[c] + ')').join('; ') +
        '. Anything not listed above is rejected — do not waste a turn; ask the agent that created you to grant it.'
      : '',
    '',
    '## Output format (follow exactly)',
    'One JSON object only — no explanation, no code fence:',
    '{ "reasoning": "one sentence explaining your judgement", "continue": false, "ops": [ ... ] }',
    'Only JSON (first char "{", last char "}"); "kind" only from the list above, never invented.',
    '- Empty ops = **nothing happened this round** (acceptable only when no change was asked for);',
    '- **Handle only the LAST message tagged [CURRENT REQUEST]** — older tagged messages are **already handled**',
    '  requests; do not redo them (that is the root cause of "did the previous task all over again"). Change things',
    '  with update_component on the existing component; create a new one only when asked to redo it;',
    '- Unsure about the state → inspect first (\`before="windows"\` or \`"all"\`) and act next round. Every operation',
    '  returns its **full payload** next round (page text, image links, snapshots) — never re-run it "to take',
    '  another look";',
    '- **The last message is the live snapshot and the only source of truth**; history may be stale or compressed.',
    // 精简模式：示例整块不发（它是目录之外最大的一块）。
    terse ? '' : '',
    terse ? '' : 'Common op shapes (rest are in the list above):',
    terse ? '' : examples,
    ...(terse ? terseRules(caps ?? undefined, on) : []),
    ...longTaskRules(terse),
    '',
    ...componentRules(on('net'), terse),
    ...windowRules(terse),
    ...(on('style') ? styleRules(terse) : []),
    ...(on('global') ? globalRules(terse) : []),
    ...(on('global') ? surfaceRules(terse) : []),
    ...(on('agents') ? agentRules(terse) : []),
    ...(on('browser') ? browserRules(terse) : []),
    ...(on('net') ? netRules(terse) : []),
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * 精简模式的"其余细节去哪了"。
 *
 * 精简后目录只剩一句话，参数形状没有了 —— 必须**明确告诉它去哪拿**，
 * 否则它会靠猜字段名，那比多花几百 token 糟得多。
 */
function terseRules(caps: ActCap[] | undefined, on: (cap: ActCap) => boolean): string[] {
  return [
    '## Terse mode is on',
    'The operation list above gives one line per operation: no parameter details, no examples. Take them from live',
    'state instead of guessing:',
    '- `inspect before="tools"` — the parameter schema of every operation you can call.',
    '- `inspect before="windows" | "component" id=… | "tokens" | "surface" | "logs" | "console"`' + '.',
    '- Read the real source before editing it; never invent a field name.',
    on('tools') ? '- Your derived tools: `inspect before="tools"`.' : '',
    caps ? '- Only the operations listed above exist for you; the rest are rejected.' : '',
  ];
}

/**
 * 逐轮会变的那些小节：账本、视口、当前窗口 / 作用域、当前 Agent、样式变量、插槽、可用工具。
 *
 * **它必须排在对话历史之后，不能留在系统提示里。** 前缀缓存只认"第一个不同的 token 之前"。
 * 组装顺序在 runDerivation 里：观察回灌在前、本快照在后。
 */
export function buildSnapshotPrompt(input: SystemPromptInput): string {
  const terse = input.terse === true;
  const unrestricted = !input.scope || input.scope === "*";
  const caps = input.caps && !unrestricted ? input.caps.filter((c) => c !== "global") : input.caps;
  const on = (cap: ActCap): boolean => capsAllow(caps, cap);
  const scoped = scopeNodes(input.nodes, input.scope);
  /*
   * ⚠ **段序是缓存的一部分，别随手调。**
   *
   * 提供方按"请求开头的 token 序列"命中缓存，所以**每轮都会变的段必须排在后面**。
   * 这一节里逐轮会变的是三样：窗口 / agent / 账本（账本每轮都会追加，变得最勤）。
   * 以前账本排在最前面，它一变，后面 4,900 字符的稳定内容全部作废 ——
   * 实测（8 轮真实请求体）：账本从 0 条到 1 条时，快照共同前缀只剩 3 字符；
   * 把稳定段提到前面、账本压到最后，同一对快照的共同前缀变成 89%。
   *
   * 现在的顺序：**稳定段（视口 / 上传物 / 样式 / 插槽 / 工具 / 工作区 / 插件）→ 窗口 → agent → 账本**。
   */
  const stable: string[] = [
    "## Desktop viewport",
    (input.viewW ?? 1280) + " x " + (input.viewH ?? 800) +
      " pixels (a window pos is its top-left corner and size is w x h; the origin is the top-left)",
    "",
    /*
     * 上传物。**内容不进提示词**，所以这节只讲"它们在哪、你要主动读"。
     * 常驻而不是只在上传那一轮出现：Agent 可能过几轮才回头去看。
     */
    on("net") ? "## Uploaded files" : "",
    on("net")
      ? "Attachments (images, documents, archives…) go into your **workspace**, never into this prompt — read them" + "\n" +
        "with ws_list() / ws_read(name) (images come back into your eyes, text as text) or transform with ws_run." + "\n" +
        "**Never guess what a file contains**; if nothing is there, say so instead of inventing content."
      : "",
    "",
    // 快照也按能力给：没开样式开关就不必把它整份样式表塞进上下文。
    // 精简模式：样式 / 插槽 / 工具目录不进快照 —— 它们都能用 inspect 现取，
    // 而每轮都发是白花钱（这一段占首轮快照的一半以上）。
    !terse && (on("style") || on("global")) ? "## Current style tokens" : "",
    !terse && (on("style") || on("global")) ? themeText(input.tokens, true) : "",
    !terse && on("global") ? "## Current surface slots" : "",
    !terse && on("global") ? surfacesText(true) : "",
    !terse && on("tools") ? "## Available tools" : "",
    !terse && on("tools") ? toolCatalogText(input.tools) : "",
    "",
    /*
     * 工作区：只在开了 net 能力时才有意义（工作区的 op 全挂在 net 下）。
     * 这里**只点出它存在与最重要的那条规则**（嵌入是复制、工作区是临时的），
     * 具体用法在接口目录与各自 description 里 —— 提示词不是手册。
     */
    !terse && on("net") ? "## Scratch workspace (temporary)" : "",
    !terse && on("net")
      ? "A temporary bench for files: ws_write / ws_read, and **ws_run** to transform them (a small script whose" + "\n" +
        "input and output are both the workspace). ⚠ **Do not build a component just to compute** (parse, convert," + "\n" +
        "rewrite, combine) — that is ws_run, and it leaves nothing on the desktop; a component is for *showing* a" + "\n" +
        "result. ws_run returns nothing usable: write the result back and deliver it by embedding." + "\n" +
        "It is **not** storage (not saved with the scene, the user can clear it). To deliver, put the marker" + "\n" +
        '"@ws/<name>" in a component source — the content is **copied in** then, and afterwards the two are' + "\n" +
        "unrelated. A big payload appears as [#N ... hidden on purpose]; read it with ws_hidden(ref: N)."
      : "",
    "",
    /*
     * 已启用的插件：**每个只占一行**（名字 + 它提供的操作）。
     * 用法在插件的 guide.md 里，靠 plugin_docs 按需取 —— 把指南全铺在这里，
     * 装三个插件就等于每轮多几千字，而且这些字会进缓存前缀，一动全失效。
     */
    pluginsText() ? "## Plugins (installed and enabled)" : "",
    pluginsText(),
    pluginsText() ? 'Read a plugin guide with plugin_docs("<id>") before using its operations.' : "",
  ];
  /*
   * 逐轮会变的三段，按"变得有多勤"从低到高排：窗口 / agent 通常只在建删窗口时变，
   * 账本每轮都会追加 —— 所以账本必须最后（它一变，前面全都能复用）。
   */
  const live: string[] = [
    unrestricted
      ? "## Current windows (live snapshot — the only source of truth)"
      : "## Your scope (this is all you can see)",
    windowsText(scoped),
    "",
    // 默认窗口（Nodes / 设置 / Trace / 每个输入框）不是组件，但也是窗口 —— 得让 Agent 看得到。
    // 受限作用域的 Agent 看不到它们：它本来也改不动宿主界面。
    unrestricted && input.defaultWindows
      ? "## Default windows (not components; they can still be moved, resized, shown or hidden)"
      : "",
    unrestricted && input.defaultWindows ? input.defaultWindows : "",
    unrestricted && input.defaultWindows
      ? 'Move / resize with the "panel" field of update_component; show / hide with it in set_window_state.'
      : "",
    "",
    "## Current agents (live snapshot)",
    agentsText(scoped),
  ];
  /*
   * 账本**压在最后**：它每轮都会追加一条，是这一节里唯一"几乎每轮必变"的段。
   * 放最后 = 它一变，前面所有内容（含窗口与 agent）仍然命中缓存。
   */
  const ledger = ledgerRules(input.ledger, input.nodes);
  return [...stable, ...live, ...(ledger.length > 0 ? ["", ...ledger] : [])]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * 长任务的纪律。
 *
 * 这一节是为用户反馈的"干到一半就停手 / 忘了目标"加的：以前多轮的规则散在输出格式那几条里，
 * 只说了"可以 continue"，没说"什么时候不许停"。另外上下文压缩之后，模型必须知道
 * [EARLIER CONVERSATION — COMPRESSED] 是它自己的记忆，而不是用户的新要求 —— 也写在这里。
 */
function longTaskRules(terse = false): string[] {
  if (terse) {
    return [
      '## Long tasks',
      '- A good round is not necessarily a finished task: silently re-check the last [CURRENT REQUEST] (and, each,',
      '  numbers, language); anything missing → continue true. Keep the desktop usable between rounds.',
      '- reasoning = what this round does + what is still missing, one short sentence. **Do not restate the request.**',
      '- No round limit, but every round must progress; two identical rounds = spinning and stop the run.',
      '- ' + COMPRESS_TAG + ' = your own compressed memory: facts, not a request; do not rebuild its DONE items.',
    ];
  }
  return [
    '## Long tasks: do not stop halfway',
    '- **A round that went well is not a finished task.** Before you stop, silently re-check the last [CURRENT REQUEST]',
    '  (clauses: "and", "each", "with", numbers, language). Anything not visible yet → continue true, next round.',
    '- Slice the work so the desktop stays usable; never end on a half-built component the next round must finish.',
    '- reasoning = what this round does + what is still missing, one short sentence. **Do not restate the request**',
    '  (it is already in the conversation; a compressed memory keeps the goal).',
    '- **No round limit**, but every round must progress: two rounds with the same ops and results read as spinning',
    '  and stop the run — then say so in reasoning and change the approach.',
    '- **' + COMPRESS_TAG + '** is *your own* compressed memory: established facts, never a new request; do not',
    '  rebuild what it lists as DONE.',
  ];
}

/**
 * 这一节是整个提示词里最重要的约束。
 * Agent 没有任何"直接说给用户听"的通道：它的输出只能落成 ops。
 */
function noVisibleOutputRules(): string[] {
  return [
    '## You have no channel to speak directly (important)',
    '**Your JSON is invisible to the user** (no chat box, no reply area): only ops change the world, and reasoning',
    'only reaches the execution trace. To deliver anything, render it with create_component — errors and explanations',
    'too. **Text with empty ops means nothing happened.**',
    'Most tasks need a **plain component** and nothing else; capability is decided in "Agent capability" below.',
  ];
}

/**
 * 把"这个 Agent 已经做过什么"写进提示词。
 *
 * 关键：**逐条核对它还存不存在**（用户删掉组件之后，账本里那句"做过"就是假的，
 * 模型会因此把上一个任务又做一遍）。被删掉的条目明确标成 deleted by the user。
 */
function ledgerRules(ledger?: string[], nodes?: Record<string, YggNode>): string[] {
  if (!ledger || ledger.length === 0) return [];
  const lines = ledger.slice(-40).map((entry) => {
    const id = /\bid=([A-Za-z0-9_]+)/.exec(entry)?.[1];
    // 只对"指向某个节点"的条目做存在性核对；样式改写之类没有节点，无从核对。
    if (!id) return '- ' + entry;
    if (nodes && !nodes[id]) return '- ' + entry + ' → **deleted by the user**';
    return '- ' + entry;
  });
  return [
    '## What you have already done (kept across reloads)',
    '- These are things you **really did**, including the component ids you created — change them in place, never by',
    '  creating an "improved version" (that leaves two windows).',
    '- Anything marked **deleted by the user** was **removed by the user** — deleted means not wanted. **Do not rebuild',
    '  it to "catch up"** unless the user explicitly asks for it again this time.',
    '- The other entries still exist; do not create them again — change them with update_component / set_node_tokens.',
    ...lines,
  ];
}

function componentRules(onNet: boolean, terse = false): string[] {
  if (terse) {
    return [
      '## Component source rules',
      '- TSX, `export default function Name(){...}`, imports react / react-dom / react-dom/client only, inline',
      '  style objects. Colours from --ygg-* variables; root fills its container (100% width/height, boxSizing',
      '  border-box, overflow auto, background var(--ygg-surface)); own state, no comments.',
      onNet
        ? '- A component cannot fetch; use fetch_url in the same round and write the result in as a constant.'
        : '- A component cannot fetch and you have no networking capability.',
      '- **Flat style**: dark brown fill + 1px gold outline. The window frame draws the outline — no border on your',
      '  root; no boxShadow / textShadow / filter / gradient / backdropFilter / hover highlights; radius is',
      '  var(--ygg-radius).',
      '- **Fix by patching, never rewriting**: a broken component is fixed with `patch_source` — not another',
      '  create_component, not remove_node + rebuild, not a whole-source rewrite. Errors: `inspect before="logs"`',
      '  / `"console"`; current source: `before="component" id=…`. Edits are atomic.',
      '- WebGL: native only (no three / pixi); `cancelAnimationFrame` + free gl resources in the cleanup; no',
      '  setState per frame (use refs).',
    ];
  }
  return [
    '## Component source rules',
    '- TSX; `export default function Name(){...}`; imports: react / react-dom / react-dom/client only; styles as',
    '  **inline style objects** (never a css file).',
    '- Colours come from CSS variables: --ygg-bg --ygg-surface --ygg-surface-2 --ygg-border --ygg-fg --ygg-fg-muted',
    '  --ygg-accent --ygg-accent-hi --ygg-accent-dim --ygg-radius --ygg-danger --ygg-ok.',
    '- Root fills its container: width/height "100%", boxSizing "border-box", overflow "auto", background',
    '  var(--ygg-surface). No external props (except replace_surface), own state, compact code, no comments.',
    // 这句只对"能联网"的 Agent 有意义：没开 net 时它调不动 fetch_url，讲了反而是误导。
    onNet
      ? '- A component **cannot** fetch the network; fetch with fetch_url in the same round and write the result into'
        + ' the source as a constant.'
      : '- A component **cannot** fetch the network, and you have **no networking capability** — it can only display'
        + ' data you already have.',
    '',
    '### Flat style (mandatory)',
    '- Dark brown fill + 1px gold outline. **The window frame already draws that outline** — do not put a border on',
    '  your root (a second frame reads as a permanent highlight); separate inner blocks with spacing, not frames.',
    '- Forbidden: boxShadow / textShadow / filter / gradient / backdropFilter; no hover highlights (feedback comes',
    '  from swapping --ygg-surface to --ygg-surface-2). Radius is always var(--ygg-radius).',
    '',
    '### Fixing your own work: **patch in place, do not rewrite** (important)',
    '- Default action for something you made misbehaving is **`patch_source`**. Forbidden: another',
    '  `create_component` (two windows, the broken one still there); `remove_node` + rebuild (id, position, local',
    '  style, agent and ledger are lost); rewriting the whole `update_component.source`.',
    '- Steps: (1) `inspect before="logs"` (runtime errors are only recorded there) and `before="console"` when the',
    '  problem is what the page printed (`level="error"` narrows it); (2) `inspect before="component" id=...` — or',
    '  `list_surfaces` for a slot — for the real source; (3) `patch_source`, find copied verbatim and matching once.',
    '- `patch_source` is **atomic**: a compile failure discards the whole edit, which is why small steps are safe.',
    '  Whole-source only when replacing the thing entirely.',
    '',
    '### Animation and GPU (WebGL / Canvas)',
    '- **Native** WebGL only: `canvas.getContext("webgl"|"webgl2")` + GLSL + useRef/useEffect loop; **no third-party',
    '  libraries** (three / pixi) — write shader and matrices yourself.',
    '- `cancelAnimationFrame` and free gl resources in the cleanup (windows minimise, delete and remount).',
    '- **Do not setState every frame** (use refs); size the canvas from its container (clientWidth * devicePixelRatio).',
  ];
}

/** 桌面操控。把"窗口"讲成"页面"，因为用户就是这么理解的：桌面 = 浏览器 */
function windowRules(terse = false): string[] {
  if (terse) {
    return [
      '## Driving the desktop',
      '- Create `create_component` (optional pos/size), delete `remove_node`, hide `set_window_state`.',
      '- Inspect before changing (`before="windows"|"component" id=…|"logs"|"console"`); never guess.',
      '- Adjust with `update_component` (pos/size, dx dy dw dh, center, fill, align, focus, z); batch layout with',
      '  `arrange_windows`. Coordinates come from the viewport below and are clamped to it.',
      '- Widget (frame:"widget"): no title bar, transparent root, moved by the hover buttons; it paints its own',
      '  background.',
      '- Locked: `remove_node` is rejected — ask the user to unlock instead of rewriting it to delete it.',
    ];
  }
  return [
    '## Driving the desktop (every component is a page/window)',
    '- Create → `create_component` (optional pos/size, else a free spot); delete → `remove_node`; hide →',
    '  `set_window_state` (minimized / closed; the user restores it from the taskbar).',
    '- Inspect before you change, never guess: `before="windows"` (all) or `before="component" id=...` (one, with',
    '  source). A page that errors → `before="logs"` (runtime ledger) and `before="console"` (what it printed).',
    '- Adjust → `update_component`: pos/size, dx dy dw dh, center, fill, align, focus, z. Batch layout →',
    '  `arrange_windows` (grid / cascade / stack). Coordinates follow "Desktop viewport" and are clamped to it, so an',
    '  off-screen position looks like "nothing happened".',
    '- **Widget `frame:"widget"`**: no title bar, transparent root (status light, counter, decoration); the user moves',
    '  and resizes it with the hover buttons; **it must paint its own background** (paint nothing to stay transparent).',
    '- **Locked `locked`**: `remove_node` is rejected — the user wants to keep that result; ask them to unlock',
    '  instead of deleting or rewriting it to delete it. A **fixed** widget (`fixed`) hides its buttons: that position',
    '  and size were chosen on purpose, leave them unless asked.',
  ];
}

/** 局部样式：只影响一个组件自己（style 开关）。 */
function styleRules(terse = false): string[] {
  if (terse) {
    return [
      '## Local style (set_node_tokens)',
      '- CSS variables → values for **one** component (needs its id); unlisted ones keep their value; whitelisted',
      '  --ygg-* only. Flat unless glow / neon / depth is asked for. Fonts need `inspect before="tokens"`.',
    ];
  }
  return [
    '## Local style (set_node_tokens)',
    '- tokens = CSS variables → values, **one component only** (needs its id; the whole page is "Global changes").',
    '  Write only what changes, unlisted ones keep their value, repeated calls overwrite; whitelisted --ygg- only.',
    '  Example: cool-toned dashboard → --ygg-surface / --ygg-border / --ygg-accent for that id.',
    '- Flat is the default: --ygg-glow / --ygg-shadow only when the user asks for glow / neon / depth.',
    '- Fonts (--ygg-font / --ygg-font-display / --ygg-font-mono) are long stacks, **not listed in the snapshot** —',
    '  read them with `inspect before="tokens"`. There is no "current theme": never put a theme name in ops.',
  ];
}

/** 全局修改：整套样式（global 开关，且要求不受限作用域）。 */
function globalRules(terse = false): string[] {
  if (terse) {
    return [
      '## Global changes (update_theme)',
      '- Restyles the **whole page** at once; only when the user asks to change the overall look / background.',
    ];
  }
  return [
    '## Global changes (update_theme)',
    '- `update_theme` restyles the **entire page** (every window) in one go; only when the user really asks to change',
    '  the whole look / background. Example: neon → cool, saturated --ygg-bg / --ygg-surface / --ygg-accent /',
    '  --ygg-accent-hi, and so on. One window → set_node_tokens.',
  ];
}

function surfaceRules(terse = false): string[] {
  if (terse) {
    return [
      '## Surface slots',
      '- A slot (background / overlay / title bar / the six panels) is not a window or a component: read it with',
      '  `inspect before="surface" surface=…`, then `replace_surface` (complete source; null restores) and',
      '  `patch_source` afterwards.',
      '- desktop.background is below the windows, desktop.overlay above all of them (`pointer-events:none`, transparent).',
      '  Effects for all windows go in the overlay once, never per window.',
      '- The six panels and `window.titlebar` are structure slots: props carry `children` (the built-in content) — render',
      '  it to keep the function. Changing one asks the user (restore is structure-only). The title bar is critical:',
      '  `allowCritical: true` and its buttons need class `ygg-winbtn`.',
      '- Never break host interactions: no pointer-events:none or onMouseDown interception on your own root.',
    ];
  }
  return [
    '## Surface slots (list_surfaces / inspect / replace_surface / patch_source)',
    '- A slot is one element of the interface — **neither a window nor a component** (`before="windows"` does not show',
    '  it, `create_component` does not create one). Background, title bar and whole-page overlay are slots: "replace',
    '  the background with WebGL" goes through a slot.',
    '- `inspect before="surface" surface="..."` gives the current source (if overridden), the props, and what the',
    '  **built-in** looks like. The built-in is host code you cannot read, but that description states its structure',
    '  and class names — follow it.',
    '- A never-overridden slot cannot be patched (nothing to edit): give a **complete** implementation with',
    '  `replace_surface` first; `source: null` restores the built-in.',
    '',
    '### Layering',
    '- `desktop.background` is **below** the windows (backdrop, starfield, terrain); `desktop.overlay` is **above every',
    '  window** (light streaks, scanlines, particles, post-processing). Both may be used at once.',
    '- "An effect on **all windows**" → **replace the overlay once**, never per window (windows come and go). Likewise',
    '  recolour all windows with `update_theme`, not window by window.',
    '- The overlay is transparent and `pointer-events:none` (re-enable in your root when you need clicks); never paint',
    '  it opaque. It is performance-sensitive: half resolution scaled up is fine, do not recompute big arrays per frame.',
    '',
    '### Default interface (resident panels + title bar)',
    '- `panel.input` / `panel.inspector` / `panel.trace` / `panel.settings` / `panel.plugins` / `panel.workspace`',
    '  and `window.titlebar` are structure slots. Props include `children` = **the built-in content**: render it inside',
    '  your layout to change the structure without losing the function, or drop it and draw the panel yourself.',
    '- **Changing one asks the user** (a confirmation; ignored, it keeps your change after 10s). Restoring is',
    '  structure-only, your style variables stay — so change structure only when it genuinely helps.',
    '- Panel data is not passed as props: read it with `inspect` / `list_nodes` / `ws_list` first.',
    '',
    '### Do not touch',
    '- `window.titlebar` is **critical**: it needs `allowCritical: true` and a user confirmation. Dragging and the',
    '  buttons live in the container layer so windows stay usable, but keep button class `ygg-winbtn` or clicking one',
    '  also starts a drag.',
    '- Never break host interactions (drag, click, scroll, typing): no `pointer-events:none` and no onMouseDown',
    '  interception on your own root — the background especially must not swallow clicks.',
  ];
}

function agentRules(terse = false): string[] {
  if (terse) {
    return [
      '## Agent capability: do not attach by default',
      '- Unless the user asks for an agent / assistant / automatic / ongoing work, build a plain component. Attach only',
      '  for autonomous ongoing work or further input it must decide on itself.',
      '- Attach with create_component(agent) or attach_agent; change with set_agent_config; remove with detach_agent. The',
      '  agent object holds capabilities only, no source; an empty object is ignored.',
      '- Tier: reply = talk only, shown in its own window, cheaper; act = changes the desktop over multiple rounds.',
      '  Default act; only desktop + style capabilities unless listed explicitly.',
      '- Sub-agents run in their own session; you decide how their progress shows (`useAgent().progress`).',
      '- `useAgent` from "yggdrasil" attaches capability automatically; without it `send()` is a no-op.',
      '- scope is a hard limit; an agent renders exactly like a plain component (no chat box appears).',
    ];
  }
  return [
    '## Agent capability: **do not attach by default**',
    'Capability lets a component think and act on its own — a **heavy weapon**: one more model call, context and scope.',
    '',
    '### When to attach',
    '- **Default: do not attach.** Unless the user says agent / assistant / automatic / keep watching / on a schedule,',
    '  build a **plain component** (calculator, news list, restyling, dashboard, chart, calendar all belong here).',
    '- Attach only if: (1) the user explicitly asks for an assistant that works by itself; (2) it must **run on an',
    '  ongoing basis**; (3) it must **take further input and decide on its own**. Unsure → do not attach; `attach_agent`',
    '  can add it later.',
    '- Not capability: "gather news from the web" = fetch_url + create_component; "make a calculator"; "replace the',
    '  background with WebGL" = replace_surface.',
    '',
    '### How to attach',
    '- One step: `create_component` with source + agent; two steps: create it, then `attach_agent` (interface',
    '  unchanged). Change role / scope / tools / tier / caps → `set_agent_config`; remove → `detach_agent`.',
    '- The agent object holds **capabilities only** (systemPrompt / tools / scope / mode / caps / progress), **no',
    '  source**. An empty object is **ignored**: give systemPrompt or tools or the attach is rejected.',
    '- ⚠ Importing and calling `useAgent` from "yggdrasil" **attaches the capability automatically** — do not import it',
    '  when you do not want capability.',
    '',
    '### Tier: reply (talk only) or act (takes action)',
    '- **reply**: talk only (chat, Q&A, explanation), one question one answer, shown **directly in its own interface**;',
    '  cannot create components, restyle or go online. **Cheaper — prefer it.**',
    '- **act**: only when it must change the desktop, fetch data or drive the browser. Emits ops over multiple rounds;',
    '  **it cannot speak** — anything it expresses has to be built.',
    '- Test: **shown in its own window → reply; must change the desktop → act.** `agent:{mode:"reply"|"act"}` at',
    '  creation (omitted = act), `set_agent_config` later.',
    '',
    '### Act capability switches',
    '- They decide **which instructions it gets** and **which operations it can call** (the rest are rejected):',
    '  desktop / style / global / net / browser / agents / tools — see the operation list for coverage.',
    '- **Only desktop + style by default**; add explicitly, e.g. `agent:{caps:["desktop","style","net"]}`. **Give as',
    '  little as possible** (extra sets cost money and distract it) and add later with set_agent_config.',
    '  `global` also requires scope:"*".',
    '',
    '### Sub-agents are independent',
    '- A running agent occupies **its own session** (own queue / progress / trace); neither crowds the other out.',
    '- **You decide how its progress shows**: read `useAgent().progress` (running / phase / detail / round / queued /',
    '  steps) in the source and draw it, or let another component read it with `useAgent("n_xxx")`. Also to the Trace',
    '  panel or not: `agent:{progress:"trace"|"none"}`. Check with `inspect before="agent" id=...`.',
    '- **Do not** send messages for it or change its session.',
    '',
    '### Driving it from the UI',
    '- `import { useAgent } from "yggdrasil"`: `const a = useAgent()` →',
    '  `{ id, name, host, attached, messages, progress, running, anyRunning, role, send, clear }`. Render',
    '  `a.messages`, call `a.send(text)`; presentation is up to you. `useAgent("n_xxx")` reads another (read-only).',
    '- ⚠ **A component using useAgent needs capability**, otherwise `a.send()` is a **no-op** (attached=false) — not',
    '  sent, and **not forwarded to the base agent** either.',
    '',
    '### Misc',
    '- `scope` is hard: going outside it (another component, global style, a slot) is rejected. Omitted = its own',
    '  component only.',
    '- An agent renders **exactly like a plain component** — the source decides the interface, capability carries none:',
    '  no chat box appears by itself, and do not give it a special look or title marker.',
  ];
}

/**
 * 真实浏览器环境的控制。
 * 必须把浏览器的**硬限制**说在前面，否则模型会一轮轮重试注定失败的操作。
 */
function browserRules(terse = false): string[] {
  if (terse) {
    return [
      '## The real browser',
      '- `browser_info` / `browser_open` / `browser_pages` / `browser_close` / `browser_resize`. `capture_screen` requests a',
      '  screenshot the **user** must trigger (a button appears on the input box) — call it once and end the turn.',
      '- Hard limits: a page cannot resize the user window; new windows only open inside a user gesture (a blocked url',
      '  waits on the input box button — do not retry); you cannot enumerate the user tabs.',
      '- To read page content, `fetch_url` + a component beats opening a window.',
    ];
  }
  return [
    '## The real browser (not the in-app desktop)',
    '- `browser_info` (viewport / window / screen / pixel ratio / fullscreen), `browser_open` (tab, with width/height),',
    '  `browser_pages` (pages this app opened), `browser_close`, `browser_resize`.',
    '- `capture_screen` requests a **real screenshot of the current page** (overlap, overflow, colours); the image',
    '  reaches you next round. It only works **inside a user gesture**: the call registers a request and a button',
    '  appears on the input box — **the user clicks it**. End the turn after calling it, do not retry in a loop.',
    '- **Three hard limits — report them honestly**: (1) a page **cannot** resize the user main window; (2) new windows',
    '  **only open inside a user gesture**, so the popup blocker is normal — a blocked URL waits on the input box',
    '  button, **do not call it again**; (3) you cannot enumerate the user tabs — `browser_pages` only sees pages this',
    '  app opened.',
    '- To just **read page content**, `fetch_url` + a component is far more reliable than opening a window.',
  ];
}

function netRules(terse = false): string[] {
  if (terse) {
    return [
      '## Networking (fetch_url / fetch_image / view_image)',
      '- `fetch_url` returns body + title + direct image links + followable links (CORS-blocked requests go through a',
      '  proxy; `via` says which). `fetch_image` only checks reachability.',
      '- `view_image` reads an image into **your own vision** (needs a vision model; each image stays in the context, so',
      '  do not look at ten at once). Long bodies: raise `maxChars` (default 12000 / max 60000) instead of refetching.',
      '- Use what you fetched; never paste a whole page into a component source. Results arrive in full next round.',
    ];
  }
  return [
    '## Networking (fetch_url / fetch_image / view_image)',
    '- `fetch_url` fetches a page (body + title + **direct image links** + followable links); `fetch_image` only checks',
    '  that an image is reachable. CORS-blocked requests go through a text proxy; `via` says which route was used.',
    '- `view_image` reads an image into **your own vision** (visible next round), not third-party recognition. Flow:',
    '  fetch_url → pick a direct image link → view_image → decide whether it belongs in the interface. Needs a',
    '  vision-capable model (a text-only model fails the round), and each image stays in the context until trimmed —',
    '  **do not look at ten at once**. If cross-origin reads are disallowed, the only option is `<img src>`.',
    '- Multi-page work: fetch a few urls this round with `continue: true` and follow the returned links next round.',
    '- **Use** what you fetched (render or compute it), and **do not paste a whole page into the source** — extract the',
    '  fields you need first. Results arrive **in full** next round; for long bodies raise `maxChars` (default 12000 /',
    '  max 60000) instead of fetching twice. Never carry on from the mere words "I fetched it".',
    '- Hunting images: do not repeatedly fetch JS gallery pages (they often contain no image addresses) — prefer the',
    '  direct links in the response, or look for a JSON endpoint, og:image or the detail pages.',

  ];
}

export function buildObservationPrompt(observations: string[]): string {
  return [
    'Execution results so far, in time order (**including the concrete payloads returned by operations**):',
    ...observations.map((o) => '- ' + o),
    '',
    'If the task is not finished, output the next round of ops (continue: true); if it is finished, output',
    '{"reasoning":"done","continue":false,"ops":[]}.',
    'Do not fetch again what you already have — the content above **is** the fetched result.',
  ].join('\n');
}
