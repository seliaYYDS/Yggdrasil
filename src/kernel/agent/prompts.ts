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
  const { lines, examples } = interfaceCatalog(caps);
  const identity = unrestricted
    ? 'You are the base agent "' + input.originName + '" of Yggdrasil, and you own the whole desktop.'
    : 'You are an independent agent "' + input.originName + '" running inside one component.\n' +
      'You have your own structure, your own context and your own scope. Anything outside your scope you can neither ' +
      'see nor change; when you need to work across that boundary, create your own component or let the base agent do it.';

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
      ? '**Your capability switches**: ' +
        caps.map((c) => CAP_LABELS[c] + ' (' + CAP_HINTS[c] + ')').join('; ') +
        '. The operations not listed above cannot be called — you would simply be rejected, so do not waste a turn ' +
        'trying; if you really need one, ask the agent that created you to grant it.'
      : '',
    '',
    '## Output format (follow exactly)',
    'Output one JSON object only — no explanation, no markdown code fence:',
    '{ "reasoning": "one sentence explaining your judgement", "continue": false, "ops": [ ... ] }',
    'Only JSON (first char "{", last char "}"); "kind" must come from the list above, never invent one.',
    'A few hard rules:',
    '- An empty ops list **means nothing happened this round**; it is only acceptable when the user asked for no change;',
    '- **You only ever handle the message tagged [CURRENT REQUEST]**: earlier user messages are **already handled**',
    '  historical requests, so do not execute them again unless the user explicitly asks this time (that is the root',
    '  cause of "did the previous task all over again"); to change something use update_component on the existing',
    '  component, and only create a new one when explicitly asked to redo it;',
    '- When unsure about the current state, inspect first (before="windows" or "all") and act next round;',
    '- The **concrete payload** returned by every operation comes back to you in full next round (page text, image',
    '  links, structure snapshots) — never re-run an operation just to "take another look";',
    '- **The last message is the live snapshot and the only source of truth** for the current state; the history may',
    '  be stale or compressed.',
    '',
    'Examples of op elements (only the most common ones; see the operation list above for the rest):',
    examples,
    '',
    ...longTaskRules(),
    '',
    ...componentRules(on('net')),
    ...windowRules(),
    ...(on('style') ? styleRules() : []),
    ...(on('global') ? globalRules() : []),
    ...(on('global') ? surfaceRules() : []),
    ...(on('agents') ? agentRules() : []),
    ...(on('browser') ? browserRules() : []),
    ...(on('net') ? netRules() : []),
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * 逐轮会变的那些小节：账本、视口、当前窗口 / 作用域、当前 Agent、样式变量、插槽、可用工具。
 *
 * **它必须排在对话历史之后，不能留在系统提示里。** 前缀缓存只认"第一个不同的 token 之前"。
 * 组装顺序在 runDerivation 里：观察回灌在前、本快照在后。
 */
export function buildSnapshotPrompt(input: SystemPromptInput): string {
  const unrestricted = !input.scope || input.scope === '*';
  const caps = input.caps && !unrestricted ? input.caps.filter((c) => c !== 'global') : input.caps;
  const on = (cap: ActCap): boolean => capsAllow(caps, cap);
  const scoped = scopeNodes(input.nodes, input.scope);
  return [
    ...ledgerRules(input.ledger, input.nodes),
    '',
    '## Desktop viewport',
    (input.viewW ?? 1280) + ' x ' + (input.viewH ?? 800) +
      ' pixels (a window pos is its top-left corner and size is w x h; the origin is the top-left)',
    '',
    /*
     * 上传物。**内容不进提示词**，所以这节只讲"它们在哪、你要主动读"。
     * 常驻而不是只在上传那一轮出现：Agent 可能过几轮才回头去看。
     */
    on('net') ? '## Uploaded files' : '',
    on('net')
      ? 'Files the user attaches (images, documents, archives…) go into your **workspace**, never into this prompt.\n' +
        'So read them yourself before using them: ws_list() to see what is there, ws_read(name) for one file\n' +
        '(images come back into your eyes, text comes back as text), ws_run(...) to transform them.\n' +
        '**Never guess what a file contains** — if the user mentions an attachment, read it first; if nothing\n' +
        'is there, say so instead of inventing content.'
      : '',
    '',
    unrestricted
      ? '## Current windows (live snapshot — the only source of truth)'
      : '## Your scope (this is all you can see)',
    windowsText(scoped),
    '',
    // 默认窗口（Nodes / 设置 / Trace / 每个输入框）不是组件，但也是窗口 —— 得让 Agent 看得到。
    // 受限作用域的 Agent 看不到它们：它本来也改不动宿主界面。
    unrestricted && input.defaultWindows
      ? '## Default windows (not components; they can still be moved, resized, shown or hidden)'
      : '',
    unrestricted && input.defaultWindows ? input.defaultWindows : '',
    unrestricted && input.defaultWindows
      ? 'Move or resize them with the "panel" field of update_component (ids above); show or hide them with the "panel" field of set_window_state.'
      : '',
    '',
    '## Current agents (live snapshot)',
    agentsText(scoped),
    '',
    // 快照也按能力给：没开样式开关就不必把它整份样式表塞进上下文。
    on('style') || on('global') ? '## Current style tokens' : '',
    on('style') || on('global') ? themeText(input.tokens, true) : '',
    '',
    on('global') ? '## Current surface slots' : '',
    on('global') ? surfacesText(true) : '',
    '',
    on('tools') ? '## Available tools' : '',
    on('tools') ? toolCatalogText(input.tools) : '',
    '',
    /*
     * 工作区：只在开了 net 能力时才有意义（工作区的 op 全挂在 net 下）。
     * 这里**只点出它存在与最重要的那条规则**（嵌入是复制、工作区是临时的），
     * 具体用法在接口目录与各自 description 里 —— 提示词不是手册。
     */
    on('net') ? '## Scratch workspace (temporary)' : '',
    on('net')
      ? 'You have a temporary bench for files: put text or fetched bytes there with ws_write, read them back with\n' +
        'ws_read, and **transform them with ws_run** — a small script whose input and output are both the workspace.\n' +
        '⚠ **Do not build a component just to run a calculation** (parsing, converting, rewriting, combining, computing):\n' +
        'that is what ws_run is for, and it leaves nothing behind on the desktop. A component is for *showing* a result.\n' +
        'ws_run returns nothing usable — write the result back into the workspace and deliver it by embedding.\n' +
        'and clean up with ws_delete. It is **not** storage — it is not saved with the scene and the user\n' +
        'can clear it at any time. To deliver something from it, put the marker "@ws/<name>" in a component source:\n' +
        'the content is **copied in** at that moment, and after that the component and the workspace are unrelated\n' +
        '(deleting the file will not break what you built). If a result contains a big payload you will see it as\n' +
        '[#N ... hidden on purpose] instead of a wall of base64 — call ws_hidden(ref: N) to actually read it back.'
      : '',
    '',
    /*
     * 已启用的插件：**每个只占一行**（名字 + 它提供的操作）。
     * 用法在插件的 guide.md 里，靠 plugin_docs 按需取 —— 把指南全铺在这里，
     * 装三个插件就等于每轮多几千字，而且这些字会进缓存前缀，一动全失效。
     */
    pluginsText() ? '## Plugins (installed and enabled)' : '',
    pluginsText(),
    pluginsText() ? 'Read a plugin guide with plugin_docs("<id>") before using its operations.' : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * 长任务的纪律。
 *
 * 这一节是为用户反馈的"干到一半就停手 / 忘了目标"加的：以前多轮的规则散在输出格式那几条里，
 * 只说了"可以 continue"，没说"什么时候不许停"。另外上下文压缩之后，模型必须知道
 * [EARLIER CONVERSATION — COMPRESSED] 是它自己的记忆，而不是用户的新要求 —— 也写在这里。
 */
function longTaskRules(): string[] {
  return [
    '## Long tasks: do not stop halfway',
    '- **A round that went well is not a finished task.** Before you stop, re-read the message tagged',
    '  [CURRENT REQUEST] clause by clause ("and", "each", "with", numbers, language) — if any part is not visible on',
    '  the interface yet, set continue true and do the next part.',
    '- Work in slices that leave the desktop usable (create → fill → wire → adjust). Do not end a round on a',
    '  half-built component that the next round is supposed to finish.',
    '- Put the goal and what is still missing into reasoning **every round**, in one short sentence — it is the plan',
    '  the user reads in the trace and the thread you keep when history gets compressed.',
    '- **There is no round limit.** A round may be small; it must make real progress. Two rounds in a row with the',
    '  same ops and the same results are read as spinning and stop the run — when a round produced nothing useful,',
    '  say so in reasoning and change the approach instead of repeating it.',
    '- A message tagged **' + COMPRESS_TAG + '** is *your own* compressed memory of earlier rounds: treat it as',
    '  established facts, never as a new request, and do not rebuild the things it lists as DONE.',
  ];
}

/**
 * 这一节是整个提示词里最重要的约束。
 * Agent 没有任何"直接说给用户听"的通道：它的输出只能落成 ops。
 */
function noVisibleOutputRules(): string[] {
  return [
    '## You have no channel to speak directly (important)',
    '**The JSON you output is invisible to the user**: there is no chat box, no message list and no reply area, and',
    'the only way you can affect the world is ops. Your reasoning only reaches the execution trace.',
    'So to deliver something, make it visible on the interface — render delivered content with create_component;',
    'errors and explanations belong inside a component too. **Text alone with empty ops means nothing happened**, and',
    'the user will think the system is broken.',
    'Most tasks need a **plain component** and nothing else — "what can you do" is a window listing your abilities,',
    'not an agent. When to attach capability is decided in "Agent capability" below.',
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

function componentRules(onNet: boolean): string[] {
  return [
    '## Component source rules (source of create_component / update_component / replace_surface)',
    '- TSX; must `export default function Name(){...}`; you may only import react / react-dom / react-dom/client;',
    '  write styles as **inline style objects** (never import a css file).',
    '- Colours come from CSS variables: --ygg-bg --ygg-surface --ygg-surface-2 --ygg-border --ygg-fg --ygg-fg-muted',
    '  --ygg-accent --ygg-accent-hi --ygg-accent-dim --ygg-radius --ygg-danger --ygg-ok.',
    '- The root element fills its container: width/height "100%", boxSizing "border-box", overflow "auto", background',
    '  var(--ygg-surface); do not rely on external props (except for replace_surface), manage your own state, keep the',
    '  code compact and do not write comments.',
    // 这句只对"能联网"的 Agent 有意义：没开 net 时它调不动 fetch_url，讲了反而是误导。
    onNet
      ? '- A component **cannot** fetch the network directly (CORS blocks it); to go online, fetch with fetch_url in the'
        + ' same round and write the result into the source as a constant.'
      : '- A component **cannot** fetch the network directly (CORS blocks it), and you have **no networking capability**,'
        + ' so a component can only display data you already have.',
    '',
    '### Visual style: flat, mandatory',
    '- Use only "dark brown fill + 1px gold outline". **The window frame already draws that outline** — do not',
    '  put a border on your root element (a second 1px frame right inside the window reads as a permanent',
    '  highlight). Separate inner blocks with spacing and layering instead of framing every one.',
    '- Forbidden: boxShadow / textShadow / filter / gradient / backdropFilter; no hover highlights either (feedback',
    '  comes from swapping --ygg-surface to --ygg-surface-2). Corner radius is always var(--ygg-radius).',
    '',
    '### Fixing your own work: **patch in place, do not rewrite** (important)',
    '- When something you made misbehaves, the **default action is `patch_source`**, not doing it again. Three things',
    '  are forbidden: creating another one with `create_component` (the user sees two windows, the broken one still',
    '  there); `remove_node` followed by a rebuild (the id changes and position / size / local style / agent',
    '  capability and ledger are all lost, and every reference to it breaks); **rewriting the whole**',
    '  `update_component.source` (restating everything to change one line guarantees you misremember and drop parts',
    '  that worked).',
    '- Three steps: (1) `inspect before="logs"` for the **real error** (errors thrown while a component runs are only',
    '  recorded in the log); (2) `inspect before="component" id=...` (or `list_surfaces` for a slot) for the',
    '  **current real source**; (3) `patch_source` in small steps — find must be copied verbatim from the source and',
    '  must match exactly once (lengthen the anchor rather than gambling).',
    '- `patch_source` is **atomic**: if it does not compile the whole edit is discarded and the source is unchanged,',
    '  which is why small steps are safe.',
    '- Only use a whole source when "replace this thing entirely"; a full replacement leaves a trace in the log',
    '  ("source replaced whole: x → y chars") that the user can see.',
    '',
    '### Animation and GPU (WebGL / Canvas)',
    '- **Native** WebGL is available: `canvas.getContext("webgl"|"webgl2")` + GLSL + a loop started from',
    '  useRef/useEffect; **you may not import third-party libraries** such as three / pixi — write the shader and',
    '  matrices yourself.',
    '- The loop must `cancelAnimationFrame` in the useEffect cleanup and free gl resources (windows get minimised,',
    '  deleted and remounted).',
    '- **Do not setState every frame** (it drags the whole interface down); keep state in refs, and size the canvas',
    '  from its container (clientWidth * devicePixelRatio).',
  ];
}

/** 桌面操控。把"窗口"讲成"页面"，因为用户就是这么理解的：桌面 = 浏览器 */
function windowRules(): string[] {
  return [
    '## Driving the desktop (the desktop is the browser; every component is a page/window)',
    '- Create → `create_component` (optional pos/size, otherwise it lands in a free spot); delete entirely →',
    '  `remove_node` (children go too); just tuck away → `set_window_state` with minimized / closed (the user can',
    '  restore it from the taskbar).',
    '- Inspect → `before="windows"` for all, `before="component" id=...` for one page (source included) — look before',
    '  you change, never guess. A page that errors → `before="logs"` (runtime errors are only recorded there).',
    '- Adjust → `update_component`: pos/size, dx dy dw dh, center, fill, align, focus, z.',
    '- Batch layout → `arrange_windows` (grid / cascade / stack) — more reliable than computing each coordinate.',
    '- **Coordinates follow the "Desktop viewport" section**; geometry is clamped into the viewport, so coordinates off',
    '  screen simply look like "nothing happened".',
    '- **Widget `frame:"widget"`**: a small piece of interface with no title bar and a transparent root (status light,',
    '  floating counter, decoration). It cannot be dragged directly — the user moves and resizes it with the buttons',
    '  that appear on hover; **a widget must paint its own background** (the host does not), so paint nothing to stay',
    '  transparent.',
    '- **Locked `locked`**: `update_component` can set `locked:true`, after which the component **cannot be',
    '  deleted** (`remove_node` is rejected). Seeing "[locked]" means the user wants to keep that result: **do not',
    '  delete it, and do not rewrite it merely to delete it** — ask the user to unlock if it has to go.',
    '- The user may also **fix** a widget (`fixed`): its control buttons disappear. That position and size were chosen',
    '  on purpose — leave them alone unless asked.',
  ];
}

/** 局部样式：只影响一个组件自己（style 开关）。 */
function styleRules(): string[] {
  return [
    '## Local style (set_node_tokens)',
    '- tokens maps CSS variables to values: write only what changes, unlisted ones keep their value, repeated calls',
    '  overwrite; only whitelisted --ygg- variables are accepted.',
    '- It changes **one component only** and requires its id. Changing the whole theme is a different switch (see',
    '  "Global changes"). Example: make a dashboard cool-toned → write --ygg-surface / --ygg-border / --ygg-accent for it.',
    '- Flat is the default: write --ygg-glow / --ygg-shadow only when the user asks for glow / neon / depth.',
    '- Fonts are theme variables too: --ygg-font (body) / --ygg-font-display (headings) / --ygg-font-mono (monospace).',
    '  They are long font stacks, so they are **not listed in the style snapshot below** — read them with',
    '  `inspect before="tokens"` when you need to change them.',
    'There is no such thing as a "current theme": never put a theme name in ops.',
  ];
}

/** 全局修改：整套样式（global 开关，且要求不受限作用域）。 */
function globalRules(): string[] {
  return [
    '## Global changes (update_theme)',
    '- `update_theme` changes the style variables of the **entire page** in one go; example: "switch to neon" → give',
    '  --ygg-bg --ygg-surface --ygg-surface-2 --ygg-border --ygg-fg --ygg-fg-muted --ygg-accent --ygg-accent-hi cool,',
    '  highly saturated values.',
    '- It affects every window, so be careful: only do it when the user really asks to "change the whole look /',
    '  background". To change one window use set_node_tokens.',
  ];
}

function surfaceRules(): string[] {
  return [
    '## Surface slots (list_surfaces / inspect / replace_surface / patch_source)',
    '- A slot is "one element of the interface" and is **neither a window nor a component**',
    '  (`inspect before="windows"` does not show them, and `create_component` does not create one). **The',
    '  background, the title bar and the whole-page overlay are all slots** — "replace the background with a WebGL',
    '  animation" goes through a slot, not through a new window.',
    '- **Read what it looks like now**: `inspect before="surface" surface="desktop.background"` gives its current',
    '  source (when overridden), the available props, and **what the built-in implementation looks like**. The built-in',
    '  implementation is host code and you cannot read its source, but the description states its structure and key',
    '  class names — replace it following those.',
    '- A slot that has never been overridden cannot be patched (there is no source to edit): first give a **complete**',
    '  implementation with `replace_surface`; only then is it "overridden" and patchable with `patch_source`.',
    '  Passing source: null restores the built-in implementation.',
    '- A slot component receives the props that slot defines (see "Current surface slots").',
    '',
    '### Get the layering right',
    '- **Background `desktop.background`**: **below** the windows — backdrop, starfield, terrain, animated backgrounds.',
    '- **Whole-page overlay `desktop.overlay`**: **above every window** — light streaks, scanlines, particles,',
    '  post-processing. Both may be used at once.',
    '- "Add an effect to **all windows**" → **replace the overlay once**. **Never** write it per window: the number of',
    '  windows changes, you will inevitably miss some, and newly created windows would not have it. Likewise recolour',
    '  all windows with `update_theme` instead of calling set_node_tokens window by window.',
    '- The overlay is transparent and `pointer-events:none` (turn auto back on in your own root when you need clicks);',
    '  never paint an opaque fill there, it would cover the windows.',
    '- The overlay is performance-sensitive: you may render at half resolution and scale up; do not recompute large',
    '  arrays every frame.',
    '',
    '### Do not touch',
    '- **Never replace a critical slot**: `window.titlebar` carries dragging, minimising, deleting and focusing, so',
    '  replacing it takes those away from every window; the executor rejects the attempt. To change how a window looks,',
    '  use `update_component` or `set_node_tokens`.',
    '- Never break host interactions (drag, click, scroll, typing): no `pointer-events:none` on your own root and no',
    '  intercepting onMouseDown there — the background especially must not swallow clicks, or windows become',
    '  unclickable. When unsure, inspect first.',
  ];
}

function agentRules(): string[] {
  return [
    '## Agent capability: **do not attach by default**',
    'Agent capability means this component can think and act on its own. It is a **heavy weapon**: one more model',
    'call, one more context, one more layer of scoping.',
    '',
    '### When to attach',
    '- **By default, do not attach**: when the user does not mention agent / assistant / automatic / keep watching / on',
    '  a schedule, build a **plain component** (calculator, news list, restyling, dashboard, chart, calendar — all of',
    '  these belong here).',
    '- Attach only when one of these holds: (1) the user explicitly asks for "an assistant/agent that can ... by',
    '  itself"; (2) it must **run autonomously on an ongoing basis**; (3) it must **receive further input and decide on',
    '  its own** instead of you doing everything in one go. When unsure, **do not attach** — it can be added later with',
    '  attach_agent.',
    '- Counter-examples (none of these get capability): "gather news from the web" = fetch_url + create_component;',
    '  "make a calculator"; "replace the background with WebGL" = replace_surface.',
    '',
    '### How to attach',
    '- One step: `create_component` with both source and agent; two steps: create the component, then',
    '  `attach_agent` (the interface does not change).',
    '- Change role / scope / tools / tier / capability switches → `set_agent_config`; remove capability →',
    '  `detach_agent`.',
    '- The agent object holds **capabilities only**: systemPrompt / tools / scope / mode / caps / progress.',
    '  **No source.**',
    '- ⚠ Importing and calling `useAgent` from "yggdrasil" **attaches the capability automatically**; do not import it',
    '  when you do not want capability.',
    '- ⚠ An empty agent object (`{}` or scope only) is **ignored**; when you really mean to attach you must give',
    '  systemPrompt or tools, otherwise attach_agent is rejected.',
    '',
    '### Tier: reply (talk only) or act (takes action)',
    '- **reply**: for agents that only need to talk — chat, Q&A, explanation. One question, one answer; the reply shows',
    '  **directly in its own interface**. It cannot create components, change styles or go online. **Cheaper and faster',
    '  — prefer it.**',
    '- **act**: only when it must move things on the desktop (create components / restyle / lay out), fetch data, or',
    '  drive the browser. It emits ops and runs multiple rounds; **it cannot speak** — anything it wants to express has',
    '  to be built.',
    '- Test: **if what the user wants can be shown inside its own window → reply; if it must change anything on the',
    '  desktop → act.** Set it at creation with `agent:{mode:"reply"|"act"}` (omitted = act); change it later with',
    '  set_agent_config.',
    '',
    '### Act capability switches',
    '- The switches decide **which instructions it receives** and **which operations it can actually call** (the rest',
    '  are rejected outright). Available: desktop (desktop operations) / style (single-window styling) / global (global',
    '  style and host interface) / net (networking) / browser (browser and screen capture) / agents (derived agents) /',
    '  tools (derived tools); see the operation list for what each covers.',
    '- **Only desktop + style are granted by default**; add others explicitly:',
    '  `agent:{caps:["desktop","style","net"]}`.',
    '- **Prefer giving less**: an agent that only draws interfaces receives the whole browser / networking /',
    '  derived-agent instruction set, which costs money and distracts it. Add more later with set_agent_config, no need',
    '  to rebuild. `global` additionally requires scope:"*", otherwise it is rejected.',
    '',
    '### Sub-agents run independently; they never occupy you',
    '- A running agent occupies **its own session** (its own queue / progress / trace). It does not crowd you out and',
    '  you do not crowd it out — you can keep taking user requests.',
    '- How its progress is displayed **is your decision at creation time**: read `useAgent().progress` (running /',
    '  phase / detail / round / queued / steps) in the source and draw it anywhere, or let another component read it',
    '  with `useAgent("n_xxx")` as a monitor panel. Whether it also goes to the Trace panel is',
    '  `agent:{progress:"trace"|"none"}`. To check progress: `inspect before="agent" id=...`.',
    '- **Do not** send messages on its behalf or change its session — those are its own.',
    '',
    '### Driving the capability from the UI',
    '- `import { useAgent } from "yggdrasil"`: `const a = useAgent()` →',
    '  `{ id, name, host, attached, messages, progress, running, anyRunning, role, send, clear }`; render',
    '  `a.messages` to show the conversation, call `a.send(text)` to make it work — how you present it is up to you.',
    '  `useAgent("n_xxx")` reads another agent (read-only).',
    '- ⚠ **A component that uses useAgent must have agent capability**: otherwise `a.send()` is a **no-op**',
    '  (attached=false) — the message is not sent, and it is **not forwarded to the base agent** either.',
    '',
    '### Misc',
    '- `scope` is a hard constraint: going outside it (touching another component, changing global style, replacing a',
    '  slot) is rejected by the executor. Omitted means its own component only.',
    '- An agent renders **exactly like a plain component**: one source decides the interface and capability carries no',
    '  interface — do not expect a chat box to appear, and do not give it a special look or a title marker just because',
    '  it is called an agent.',
  ];
}

/**
 * 真实浏览器环境的控制。
 * 必须把浏览器的**硬限制**说在前面，否则模型会一轮轮重试注定失败的操作。
 */
function browserRules(): string[] {
  return [
    '## The real browser (not the same thing as the in-app desktop)',
    'This is the **real browser**, not the in-app desktop (that one is "Driving the desktop").',
    '- Real browser: use `browser_*` — `browser_info` reads the browser viewport / window / screen / pixel ratio /',
    '  fullscreen; `browser_open` opens a tab (with width/height, a window); `browser_pages` lists the pages this',
    '  app opened; `browser_close` closes them; `browser_resize` resizes them.',
    '- `capture_screen` asks the user for a **real screenshot of the current page** so you can check what you actually',
    '  built (overlap, overflow, wrong colours). The image goes into your context and **you will see it next round**.',
    '  ⚠ The browser only allows screen capture **inside a user gesture**, so the call merely registers a request: a',
    '  "screenshot for the agent" button appears on the input box and **the user clicks it**. End your turn after',
    '  calling it — do not call it repeatedly waiting for a result.',
    '- **Three hard limits — report them honestly instead of forcing through**:',
    '  (1) a web page **cannot** resize the user main window (browser_resize on the current page is ignored by the browser);',
    '  (2) new windows **only open inside a user gesture** — the model runs asynchronously, so being blocked by the',
    '     popup blocker is normal; a blocked URL is attached to the "open" button of the input box for the user to',
    '     click, so **do not call it again**;',
    '  (3) the browser **does not allow** enumerating the tabs the user opened — browser_pages only sees pages this app opened.',
    '- If you only want to **read page content**, pulling the text with `fetch_url` and rendering it into a component',
    '  is far more reliable than opening a window.',
  ];
}

function netRules(): string[] {
  return [
    '## Networking (fetch_url / fetch_image / view_image)',
    '- `fetch_url` fetches a page (body + title + **direct image links** + followable links); `fetch_image` only',
    '  checks that an image is reachable. When a direct request is blocked by CORS it automatically goes through a text',
    '  proxy, and the returned `via` tells you which route was used.',
    '- **To actually look at an image use `view_image`**: it reads the image as base64 and hands it to **your own',
    '  vision** (you can see it next round); it is not third-party recognition. Standard flow: fetch_url → pick from the',
    '  direct image links → view_image → then decide whether it belongs in the interface. It requires a vision-capable',
    '  model (a text-only model fails the whole round); one image = one message in the context that keeps being resent',
    '  until trimmed, so **do not look at ten at once**. When the host disallows cross-origin reads you get an explicit',
    '  error, and then the only option is putting the direct link into `<img src>` for the user to see.',
    '- Multi-page tasks: fetch one or more urls in a round, set `continue: true`, and continue next round from the',
    '  returned links.',
    '- **Actually use** what you fetched (render it into a component, compute with it) instead of stopping at fetching,',
    '  and **do not paste a whole page into the component source** — extract the fields you need first.',
    '- Fetch results arrive **in full** next round (body + direct image links + links); for long bodies raise',
    '  `maxChars` (default 12000 / max 60000) instead of fetching the same page twice. Never carry on from the mere',
    '  words "I fetched it".',
    '- **When hunting for images, do not repeatedly fetch JS gallery pages** (script-rendered pages such as Baidu image',
    '  search usually contain no image addresses): prefer the direct image links in the response, or look for a JSON',
    '  endpoint, og:image, or the detail pages themselves.',

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
