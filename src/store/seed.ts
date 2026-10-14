import type { AgentFacet, ComponentNode, LogEntry, ThemeTokens, YggNode } from '../kernel/types';
import type { LlmSettings } from '../kernel/llm/types';
import type { PersistedSession, PanelRect } from './desktopStore';

/**
 * \`.seed\` 场景文件。
 *
 * 设计取舍：
 * - **就是一个 JSON**，带格式标记与版本号。出问题时用文本编辑器就能看、能改、能 diff，
 *   不需要专门的工具 —— 场景文件最怕"坏了打不开又说不清哪里坏"。
 * - **分区块**：文件里只装用户勾选的那些（界面 / 组件 / 历史 / 设置），导入时**只覆盖文件里有的区块**，
 *   没带的保持原样。这样"只导出组件"这种用法才成立。
 * - **不写死应用数据结构的内部键名**，而是复用落盘用的那几个键（见 seedStorageEntries）——
 *   导入时直接写进存储再走一遍 hydrate()，迁移 / 去重 / 夹取全部复用，不必再写第二套装载逻辑。
 */
export type SeedPart = 'interface' | 'components' | 'history' | 'settings';

export const SEED_FORMAT = 'yggdrasil.seed';
export const SEED_VERSION = 1;
export const SEED_EXT = '.seed';

/** 导出对话框里的四个区块（顺序即展示顺序）。 */
export const SEED_PART_INFO: { id: SeedPart; label: string; hint: string }[] = [
  { id: 'interface', label: '界面', hint: '主题样式、界面插槽（背景/标题栏/效果层）、面板与输入框的位置与层级' },
  { id: 'components', label: '组件', hint: '所有组件的源码、位置尺寸、挂件/锁定状态、局部样式，以及 agent 的职责与能力开关' },
  { id: 'history', label: 'Agent 历史', hint: '对话记忆与"已经做过的事"账本；不勾就不带上任何记忆（组件本身仍会带着 agent 的职责与能力）' },
  { id: 'settings', label: '设置', hint: '连接、模型与各项参数（API Key 默认不含）' },
];

/** 运行时用的持久化快照（就是 store.snapshot() 的返回形状）。 */
export interface SeedSnapshot {
  nodes: Record<string, YggNode>;
  rootId: string;
  tokens: ThemeTokens;
  settings: LlmSettings;
  logs: LogEntry[];
  panels: { inspector: PanelRect; settings: PanelRect; trace: PanelRect };
  sessions: PersistedSession[];
  panelZ: Record<string, number>;
  zCounter: number;
  surfaces: Record<string, string>;
}

export interface SeedFile {
  format: typeof SEED_FORMAT;
  version: number;
  app: string;
  exportedAt: string;
  /** 文件里实际带了哪些区块。 */
  parts: SeedPart[];
  /** 一行摘要，导入确认框与文件注释都用它。 */
  summary: string;
  data: Partial<{
    nodes: Record<string, YggNode>;
    rootId: string;
    theme: { tokens: ThemeTokens };
    surfaces: Record<string, string>;
    panels: SeedSnapshot['panels'];
    panelZ: Record<string, number>;
    z: number;
    sessions: PersistedSession[];
    settings: LlmSettings;
  }>;
}

/** 带 agent 能力的组件（YggNode 是联合类型，取 agent 前要窄化一下）。 */
function isAgent(n: YggNode): n is ComponentNode & { agent: AgentFacet } {
  return n.kind === 'component' && !!n.agent;
}

/** 深拷贝：导出的内容必须与此刻的内存脱钩，否则导出后再改界面会把文件内容也改掉。 */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** 去掉 agent 的对话记忆与账本，只留"配置"。 */
function stripHistory(node: YggNode): YggNode {
  if (node.kind !== 'component' || !node.agent) return node;
  const agent = { ...node.agent, messages: [], ledger: [] };
  return { ...node, agent };
}

/**
 * 按勾选组装场景文件。
 *
 * 两个必须写清楚的行为：
 * - **不勾"Agent 历史"就不会带上任何对话与账本**（组件里的 agent 会被剥成空记忆）——
 *   这样"只想把界面结构发出去"才真的不泄密。
 * - **不勾"包含 API Key"时 settings 里就没有 apiKey 字段**（不是空串）：导入时
 *   空串会把用户的 key 清掉，而缺字段会让 hydrate 保留原有 key。
 */
export function buildSeed(
  snap: SeedSnapshot,
  parts: SeedPart[],
  includeApiKey = false,
): SeedFile {
  const picked = new Set(parts);
  const withHistory = picked.has('history');
  const data: SeedFile['data'] = {};

  /*
   * 组件区块**只由 `components` 决定**，不再被"Agent 历史"拖着走。
   *
   * 以前两个区块绑在一起（勾历史就必然带组件），理由是"历史依附于组件"。
   * 但组件**本身就带着它自己的 agent 配置**（职责 / 能力 / 模式）—— 那是组件的一部分，
   * 不是"历史"。真正属于历史的只有对话记忆与账本，而那两个可以独立地不导出。
   * 现在：带组件就带组件（含 agent 配置），带历史才额外带上记忆与账本。
   */
  if (picked.has('components')) {
    const nodes: Record<string, YggNode> = {};
    for (const [id, node] of Object.entries(snap.nodes)) {
      nodes[id] = withHistory ? clone(node) : stripHistory(clone(node));
    }
    data.nodes = nodes;
    data.rootId = snap.rootId;
  }

  if (picked.has('interface')) {
    data.theme = { tokens: clone(snap.tokens) };
    data.surfaces = clone(snap.surfaces);
    data.panels = clone(snap.panels);
    data.panelZ = clone(snap.panelZ);
    data.z = snap.zCounter;
  }

  /*
   * 输入框（会话）属于界面；它们的**对话记忆**属于历史 —— 与组件同样的解绑方式：
   * 带界面就带输入框本身，勾历史才带它们各自的 messages。
   */
  if (picked.has('interface') || withHistory) {
    data.sessions = snap.sessions.map((ses) => ({
      id: ses.id,
      title: ses.title,
      rect: clone(ses.rect),
      z: ses.z,
      minimized: ses.minimized,
      ...(withHistory && ses.messages?.length ? { messages: clone(ses.messages) } : {}),
    }));
  }

  if (picked.has('settings')) {
    const settings = clone(snap.settings);
    if (!includeApiKey) delete (settings as Partial<LlmSettings>).apiKey;
    data.settings = settings;
  }

  const agents = Object.values(data.nodes ?? {}).filter(isAgent);
  const messages =
    agents.reduce((n, a) => n + a.agent.messages.length, 0) +
    (data.sessions ?? []).reduce((n, ses) => n + (ses.messages?.length ?? 0), 0);
  const components = Object.values(data.nodes ?? {}).filter((n) => n.kind === 'component' && !n.root).length;
  const summary =
    parts.map((p) => SEED_PART_INFO.find((x) => x.id === p)?.label ?? p).join(' + ') +
    ' · ' + components + ' 组件 / ' + agents.length + ' Agent / ' + messages + ' 条记忆';

  return {
    format: SEED_FORMAT,
    version: SEED_VERSION,
    app: 'yggdrasil',
    exportedAt: new Date().toISOString(),
    parts: [...picked],
    summary,
    data,
  };
}

/** 解析一个 .seed 文件。任何不合格式的情况都给出人能看懂的原因，不抛异常。 */
export function parseSeed(text: string): { ok: true; seed: SeedFile } | { ok: false; error: string } {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { ok: false, error: '文件是空的。' };
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, error: '不是合法的 JSON：' + (e as Error).message };
  }
  if (!raw || typeof raw !== 'object') return { ok: false, error: '顶层不是一个对象。' };
  const seed = raw as Partial<SeedFile>;
  if (seed.format !== SEED_FORMAT) {
    return { ok: false, error: '这不是 Yggdrasil 场景文件（缺少 format: ' + SEED_FORMAT + '）。' };
  }
  if (!seed.data || typeof seed.data !== 'object') return { ok: false, error: '文件里没有 data 区块。' };
  const version = typeof seed.version === 'number' ? seed.version : 0;
  if (version > SEED_VERSION) {
    return { ok: false, error: '这个场景文件来自更新的版本（v' + version + '），当前只认到 v' + SEED_VERSION + '。' };
  }
  const data = seed.data as SeedFile['data'];
  const known: SeedPart[] = ['interface', 'components', 'history', 'settings'];
  const parts = Array.isArray(seed.parts) ? seed.parts.filter((p): p is SeedPart => known.includes(p as SeedPart)) : [];
  return {
    ok: true,
    seed: {
      format: SEED_FORMAT,
      version,
      app: typeof seed.app === 'string' ? seed.app : 'yggdrasil',
      exportedAt: typeof seed.exportedAt === 'string' ? seed.exportedAt : '',
      parts,
      summary: typeof seed.summary === 'string' ? seed.summary : '',
      data,
    },
  };
}

/** 文件里到底装了什么，给导入确认框用。 */
export function describeSeed(seed: SeedFile): string[] {
  const lines: string[] = [];
  const d = seed.data;
  if (d.nodes) {
    const all = Object.values(d.nodes);
    const comps = all.filter((n) => n.kind === 'component' && !n.root);
    const agents = all.filter(isAgent);
    const msgs = agents.reduce((n, a) => n + a.agent.messages.length, 0);
    lines.push('组件 ' + comps.length + ' 个（其中 Agent ' + agents.length + ' 个）');
    if (msgs > 0) lines.push('组件 Agent 的记忆 ' + msgs + ' 条');
  }
  if (d.theme) lines.push('主题样式变量');
  if (d.surfaces) lines.push('界面插槽 ' + Object.keys(d.surfaces).length + ' 个');
  if (d.panels) lines.push('面板位置');
  if (d.sessions) {
    const msgs = d.sessions.reduce((n, s) => n + (s.messages?.length ?? 0), 0);
    lines.push('输入框 ' + d.sessions.length + ' 个' + (msgs ? '（含对话 ' + msgs + ' 条）' : ''));
  }
  if (d.settings) {
    const hasKey = typeof (d.settings as LlmSettings).apiKey === 'string';
    lines.push('设置' + (hasKey ? '（**包含 API Key**）' : '（不含 API Key）'));
  }
  if (lines.length === 0) lines.push('（文件里没有任何可导入的区块）');
  const when = seed.exportedAt ? new Date(seed.exportedAt).toLocaleString() : '未知时间';
  return ['导出于 ' + when, ...lines];
}

/** 场景文件 → 落盘用的键值对。导入就是把它们写进存储再走一遍 hydrate()。 */
/**
 * 场景文件 → 落盘用的键值对。
 *
 * parts 可选：只导入勾选的那些区块。**不传就全部导入**（老调用方的行为不变）。
 *
 * 依赖关系在这里处理，而不是让调用方去拼：
 * - 组件与历史都放在 nodes / sessions 里，所以要它们任一被勾选就得带上那两个键；
 * - "只导入历史"没有意义（历史依附于组件与输入框），这时自动按"组件 + 历史"处理；
 * - 界面区块里的面板位置 / 层级是纯 UI 的，不勾就不写。
 */
export function seedStorageEntries(seed: SeedFile, parts?: SeedPart[]): [string, unknown][] {
  const d = seed.data;
  const want = parts ? new Set(parts) : null;
  const has = (p: SeedPart) => (want ? want.has(p) : true);
  /*
   * 组件与历史**互不绑定**（待办 1）：组件区块只由 `components` 决定；
   * 历史（记忆 / 账本）由 `history` 决定。只导入历史而不导入组件时，
   * 记忆没有载体可以挂 —— 那就照实不写，而不是擅自把组件也覆盖掉。
   */
  const withNodes = has('components');
  const out: [string, unknown][] = [];

  if (d.nodes && withNodes) {
    out.push(['nodes', d.nodes]);
    if (d.rootId) out.push(['rootId', d.rootId]);
  }
  if (d.theme && has('interface')) out.push(['theme', d.theme]);
  if (d.surfaces && has('interface')) out.push(['surfaces', d.surfaces]);
  if (d.panels && has('interface')) out.push(['panels', d.panels]);
  if (d.panelZ && has('interface')) out.push(['panelZ', d.panelZ]);
  if (typeof d.z === 'number' && has('interface')) out.push(['z', d.z]);
  // 输入框（会话）本身属于"界面"，它们的对话内容属于"历史"。
  if (d.sessions && (has('interface') || has('history'))) {
    out.push([
      'sessions',
      // 只导入界面时把对话记忆剥掉：否则"导入界面"会顺手把别人的聊天记录带进来。
      has('history')
        ? d.sessions
        : d.sessions.map((ses) => ({ ...ses, messages: [] })),
    ]);
  }
  if (d.settings && has('settings')) out.push(['settings', d.settings]);
  return out;
}

/** 文件里到底有没有"组件"：光有 nodes 键不算，还得真的有一个非 root 的组件。 */
function hasComponents(seed: SeedFile): boolean {
  const nodes = seed.data.nodes;
  if (!nodes) return false;
  return Object.values(nodes).some((n) => n.kind === 'component' && !n.root);
}

/** 文件里到底有没有"历史"：组件 agent 的记忆 / 账本，或输入框的对话。 */
function hasHistory(seed: SeedFile): boolean {
  const d = seed.data;
  const inNodes = Object.values(d.nodes ?? {}).some(
    (n) => isAgent(n) && (n.agent.messages.length > 0 || n.agent.ledger.length > 0),
  );
  const inSessions = (d.sessions ?? []).some((ses) => (ses.messages?.length ?? 0) > 0);
  return inNodes || inSessions;
}

/** 文件里到底有没有"界面"：主题 / 插槽 / 面板位置 / 输入框，任一有内容才算。 */
function hasInterface(seed: SeedFile): boolean {
  const d = seed.data;
  if (d.theme && Object.keys(d.theme.tokens ?? {}).length > 0) return true;
  if (d.surfaces && Object.keys(d.surfaces).length > 0) return true;
  if (d.panels) return true;
  return (d.sessions?.length ?? 0) > 0;
}

/**
 * 文件里可选的区块 —— 给导入对话框渲染勾选框用。
 *
 * **按内容判断，而不是按"键在不在"**（待办 3）：一个只带了 root 的 nodes、
 * 或者一份记忆全空的文件，不该显示"组件"/"历史"的勾选框 —— 勾了也没用，
 * 反而让人以为这个文件里有东西。
 */
export function seedPartOptions(seed: SeedFile): { id: SeedPart; label: string; available: boolean }[] {
  const d = seed.data;
  const meta = (p: SeedPart) => SEED_PART_INFO.find((x) => x.id === p)?.label ?? p;
  return [
    { id: 'interface', label: meta('interface'), available: hasInterface(seed) },
    { id: 'components', label: meta('components'), available: hasComponents(seed) },
    { id: 'history', label: meta('history'), available: hasHistory(seed) },
    { id: 'settings', label: meta('settings'), available: !!d.settings },
  ];
}

/** 导出文件名：yggdrasil-2026-02-14-1530.seed */
export function seedFileName(at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    'yggdrasil-' + at.getFullYear() + '-' + p(at.getMonth() + 1) + '-' + p(at.getDate()) +
    '-' + p(at.getHours()) + p(at.getMinutes()) + SEED_EXT
  );
}

/** 序列化成文件内容：两空格缩进，便于人看与 diff。 */
export function seedToText(seed: SeedFile): string {
  return JSON.stringify(seed, null, 2);
}
