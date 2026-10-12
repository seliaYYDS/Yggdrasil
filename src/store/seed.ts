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
  { id: 'history', label: 'Agent 历史', hint: '对话记忆与"已经做过的事"账本（依附于组件与输入框，需同时勾选其一）' },
  { id: 'settings', label: '设置', hint: 'Base / 模型 / 温度 / 图片中转 / 成人模式（API Key 默认不含）' },
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

  if (picked.has('components') || withHistory) {
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
export function seedStorageEntries(seed: SeedFile): [string, unknown][] {
  const d = seed.data;
  const out: [string, unknown][] = [];
  if (d.nodes) {
    out.push(['nodes', d.nodes]);
    if (d.rootId) out.push(['rootId', d.rootId]);
  }
  if (d.theme) out.push(['theme', d.theme]);
  if (d.surfaces) out.push(['surfaces', d.surfaces]);
  if (d.panels) out.push(['panels', d.panels]);
  if (d.panelZ) out.push(['panelZ', d.panelZ]);
  if (typeof d.z === 'number') out.push(['z', d.z]);
  if (d.sessions) out.push(['sessions', d.sessions]);
  if (d.settings) out.push(['settings', d.settings]);
  return out;
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
