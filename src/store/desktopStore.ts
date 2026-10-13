import { create } from 'zustand';
import type {
  AgentFacet,
  ComponentNode,
  LogEntry,
  LogLevel,
  Message,
  NodeId,
  RunFeedback,
  ThemeTokens,
  TraceStep,
  YggNode,
} from '../kernel/types';
import { MAX_STORED_MESSAGES } from '../kernel/agent/prompts';
import { newNodeId } from '../kernel/ids';
import type { StorageAdapter, StorageKind } from '../storage/adapter';
import { initStorage } from '../storage/detect';
import { DEFAULT_SETTINGS, type LlmSettings } from '../kernel/llm/types';
import {
  applyTheme,
  DEFAULT_TOKENS,
  diffTokens,
  mergeTokens,
  migrateTokens,
  sanitizeTokens,
} from '../theme/engine';
import { exportSurfaceStates, importSurfaceStates } from '../kernel/registry/surfaceRegistry';
import { buildSeed, seedStorageEntries, type SeedFile, type SeedPart } from './seed';
import { syncPluginRuntime } from '../kernel/plugin/runtime';
import { policyFor } from '../kernel/security';
import type { InstalledPlugin, PluginPackage } from '../kernel/plugin/types';

/**
 * 一个会话的用量统计。**不进持久化** —— 刷新后重新开始计，避免把历史数字当成这次的开销。
 */
export interface SessionMetrics {
  /** 累计输入 token（含每轮重发的历史，所以它天然比"内容量"大）。 */
  tokensIn: number;
  /** 累计输出 token。 */
  tokensOut: number;
  /** 累计命中缓存的输入 token。 */
  cachedIn: number;
  /**
   * 累计的**生成耗时**（毫秒，只算模型出字的那段时间）。
   * 整体 tok/s = tokensOut / (msTotal / 1000)，所以必须攒这个数，不能只留"最近一次"。
   */
  msTotal: number;
  /** 跑过几次（用来区分"0"和"还没有数据"）。 */
  runs: number;
  /** true = 数字全部来自服务端 usage；false = 含本地估算（界面会标 ~）。 */
  exact: boolean;
}

export function emptyMetrics(): SessionMetrics {
  return { tokensIn: 0, tokensOut: 0, cachedIn: 0, msTotal: 0, runs: 0, exact: true };
}

/**
 * 整体的输出速度：**累计输出 token / 累计生成耗时**。
 *
 * 不是"最近一次"的瞬时速度 —— 用户要的是这个会话整体的表现。
 */
export function avgTps(m: Pick<SessionMetrics, 'tokensOut' | 'msTotal'>): number {
  if (m.msTotal <= 0) return 0;
  return m.tokensOut / (m.msTotal / 1000);
}

/** 整体命中率 = 累计命中 / 累计输入。0..1；没有输入时返回 null（"还没有数据"，不是 0）。 */
export function hitRate(m: Pick<SessionMetrics, 'tokensIn' | 'cachedIn'>): number | null {
  if (m.tokensIn <= 0) return null;
  return m.cachedIn / m.tokensIn;
}

export interface RunStatus {
  running: boolean;
  phase: string;
  detail: string;
  round: number;
  runId: string | null;
}

/** 一个**默认窗口**（常驻面板或输入框会话）的对外视图 —— 供 Agent 读取与修改。 */
export interface DefaultWindow {
  id: string;
  title: string;
  kind: 'panel' | 'input';
  rect: PanelRect;
  z: number;
  minimized: boolean;
  /** 面板被 ✕ 关掉时为 false（输入框没有这个概念，恒为 true）。 */
  open: boolean;
  /** 改尺寸时不能低于它。 */
  min: { w: number; h: number };
}

export interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 排队等待发送的一条输入。
 *
 * 队列**不进持久化**：刷新后自动跑一堆旧指令是意外行为，而不是功能。
 */
export interface QueuedInput {
  id: string;
  text: string;
  /** 目标 Agent（组件 id）。发出时若该组件已被删，会自动回落到基底。 */
  originId: NodeId;
  createdAt: number;
  /** 这条排队输入附带的图片（data URL）。 */
  images?: string[];
}

/**
 * 一个输入框 = 一个独立的 Agent 会话。
 *
 * **共享的**：桌面（节点树 / 样式）、基底的对话历史与账本 —— 也就是"底层记忆"。
 * **不共享的**：status / trace / queue 这三样"工作状态"。
 * 所以两个输入框可以同时在跑，各自显示各自的进度，互不打断。
 */
export interface InputSession {
  /** 'input' 是第一个；之后是 'input-2'、'input-3'…… */
  id: string;
  title: string;
  rect: PanelRect;
  z: number;
  minimized: boolean;
  status: RunStatus;
  trace: TraceStep[];
  queue: QueuedInput[];
  /** 这个会话的用量统计（token / 速度 / 缓存命中），不进持久化。 */
  metrics: SessionMetrics;
  /**
   * **这个输入框自己的对话记忆。**
   *
   * 每个输入框是一个独立会话：各自记着自己说过什么、基底答过什么，
   * 所以"在 A 框聊的事"不会跑到 B 框的上下文里。
   * 共享的只有**工作环境**（节点树、样式、账本），那是"这个桌面现在是什么样"。
   */
  messages: Message[];
}

/** 第一个输入框的 id，也是基底那一份"主会话"。 */
export const MAIN_SESSION = 'input';

/** 同时最多开几个输入框。再多屏幕放不下，投入产出也不划算。 */
export const MAX_SESSIONS = 6;

export function emptyStatus(): RunStatus {
  return { running: false, phase: '', detail: '', round: 0, runId: null };
}

/** 第 n 个输入框（n 从 1 开始）的 id 与标题。 */
export function sessionIdOf(n: number): string {
  return n <= 1 ? MAIN_SESSION : 'input-' + n;
}
/** 反过来：从 id 取回序号。认不出来返回 0。 */
export function numberOfSessionId(id: string): number {
  if (id === MAIN_SESSION) return 1;
  const m = /^input-(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}
export function sessionTitleOf(n: number): string {
  return n <= 1 ? 'Yggdrasil' : 'Yggdrasil ' + n;
}

/** 造一个新会话。落点按序号错开，避免叠在一起。 */
export function makeSession(n: number, base: PanelRect, viewW: number, viewH: number): InputSession {
  const rect: PanelRect = n <= 1
    ? base
    : fitRectToViewport(
        { x: base.x + (n - 1) * 30, y: Math.max(40, base.y - (n - 1) * 40), w: base.w, h: base.h },
        viewW,
        viewH,
        PANEL_MIN_SESSION.w,
        PANEL_MIN_SESSION.h,
      );
  return {
    id: sessionIdOf(n),
    title: sessionTitleOf(n),
    rect,
    z: 2 + n,
    minimized: false,
    status: emptyStatus(),
    trace: [],
    queue: [],
    metrics: emptyMetrics(),
    messages: [],
  };
}

/** 只持久化几何与可见性；status / trace / queue 是瞬态的。 */
export interface PersistedSession {
  id: string;
  title: string;
  rect: PanelRect;
  z: number;
  minimized: boolean;
  /** 会话自己的对话记忆，跟着会话一起存。 */
  messages?: Message[];
}

interface PersistedRoot {
  nodes: Record<NodeId, YggNode>;
  rootId: NodeId;
  tokens: ThemeTokens;
  settings: LlmSettings;
  logs: LogEntry[];
  panels: PanelRects;
  sessions: PersistedSession[];
  zCounter: number;
  panelZ: Record<string, number>;
  surfaces: Record<string, string>;
  plugins?: InstalledPlugin[];
}

const K_NODES = 'nodes';
const K_ROOT = 'rootId';
const K_THEME = 'theme';
const K_SETTINGS = 'settings';
const K_LOGS = 'logs';
const K_PANELS = 'panels';
const K_SURFACES = 'surfaces';
const K_SESSIONS = 'sessions';
const K_PLUGINS = 'plugins';

/** 除 API 设置外，这些键在重置时全部清除。 */
const RESETTABLE_KEYS = [K_NODES, K_ROOT, K_THEME, K_LOGS, K_PANELS, K_SESSIONS, 'z', 'panelZ', K_SURFACES];

/** 常驻 UI 面板（输入框是会话，不在这里）。它们不是派生节点，不进派生树。 */
export type PanelKey = 'inspector' | 'settings' | 'trace' | 'plugins' | 'workspace';

interface PanelRects {
  inspector: PanelRect;
  settings: PanelRect;
  trace: PanelRect;
  plugins: PanelRect;
  workspace: PanelRect;
}

export const DEFAULT_PANELS: PanelRects = {
  inspector: { x: 24, y: 0, w: 340, h: 420 },
  settings: { x: 0, y: 0, w: 380, h: 388 },
  trace: { x: 0, y: 0, w: 360, h: 400 },
  plugins: { x: 0, y: 0, w: 420, h: 460 },
  workspace: { x: 0, y: 0, w: 380, h: 400 },
};

/** 输入会话的默认尺寸：单行输入 + 一行状态，默认就该矮。 */
export const DEFAULT_INPUT_RECT: PanelRect = { x: 24, y: 0, w: 560, h: 88 };

export const ALL_PANELS: PanelKey[] = ['inspector', 'settings', 'trace', 'plugins', 'workspace'];

export const DEFAULT_PANEL_Z: Record<PanelKey, number> = {
  inspector: 1,
  settings: 1,
  trace: 1,
  plugins: 1,
  workspace: 1,
};

export const PANEL_TITLES: Record<PanelKey, string> = {
  inspector: 'Nodes',
  settings: 'LLM',
  trace: 'Trace',
  plugins: '插件',
  workspace: '工作区',
};

/** 面板键到矩形字段的映射。 */
export const PANEL_RECT_KEY: Record<
  PanelKey,
  'inspectorRect' | 'settingsRect' | 'traceRect' | 'pluginsRect' | 'workspaceRect'
> = {
  inspector: 'inspectorRect',
  settings: 'settingsRect',
  trace: 'traceRect',
  plugins: 'pluginsRect',
  workspace: 'workspaceRect',
};

/** 视口缩小时派生的窗口最少缩到这个尺寸（再小就没法用了）。 */
export const FOLLOW_MIN_W = 160;
export const FOLLOW_MIN_H = 90;

/** 面板显示用的名字（给 Agent 看的清单用它）。 */
export const PANEL_LABELS: Record<PanelKey, string> = {
  inspector: 'Nodes',
  plugins: '插件',
  settings: '设置',
  trace: 'Trace',
  workspace: '工作区',
};

/** 各面板的尺寸下限，与 PanelWindow 传的 minW / minH 对齐。 */
export const PANEL_MIN: Record<PanelKey, { w: number; h: number }> = {
  inspector: { w: 280, h: 220 },
  settings: { w: 300, h: 280 },
  trace: { w: 320, h: 240 },
  plugins: { w: 340, h: 300 },
  workspace: { w: 320, h: 260 },
};

/** 输入会话的尺寸下限。 */
export const PANEL_MIN_SESSION = { w: 300, h: 70 };

/**
 * 把一个矩形夹进视口。
 *
 * 尺寸语义：正常情况下不低于 min，也不超过视口；
 * **视口比 min 还小时以视口为准** —— 自适应优先于最小尺寸，否则小窗口下必然出界。
 * 只保留一个绝对下限（160×48），免得算出一个不可用的窗口。
 */
export function fitSizeIn(rect: PanelRect, viewW: number, viewH: number, minW: number, minH: number) {
  const maxW = Math.max(160, viewW - 8);
  const maxH = Math.max(48, viewH - 8);
  return {
    w: Math.max(Math.min(minW, maxW), Math.min(rect.w, maxW)),
    h: Math.max(Math.min(minH, maxH), Math.min(rect.h, maxH)),
  };
}

export function fitRectToViewport(
  rect: PanelRect,
  viewW: number,
  viewH: number,
  minW: number,
  minH: number,
): PanelRect {
  const { w, h } = fitSizeIn(rect, viewW, viewH, minW, minH);
  return {
    x: Math.max(0, Math.min(rect.x, Math.max(0, viewW - w))),
    y: Math.max(0, Math.min(rect.y, Math.max(0, viewH - h))),
    w,
    h,
  };
}

/** 第一个输入框贴底居中；其余面板错开。所有面板都按视口夹一遍，小窗口下也不会跑到屏幕外。 */
export function resolvePanels(viewW: number, viewH: number): PanelRects {
  const place = (key: PanelKey, rect: PanelRect) =>
    fitRectToViewport(rect, viewW, viewH, PANEL_MIN[key].w, PANEL_MIN[key].h);
  return {
    inspector: place('inspector', { ...DEFAULT_PANELS.inspector, x: 24, y: 72 }),
    settings: place('settings', {
      ...DEFAULT_PANELS.settings,
      x: Math.max(24, viewW - DEFAULT_PANELS.settings.w - 380),
      y: 72,
    }),
    trace: place('trace', {
      ...DEFAULT_PANELS.trace,
      x: Math.max(24, viewW - DEFAULT_PANELS.trace.w - 24),
      y: 72,
    }),
    plugins: place('plugins', {
      ...DEFAULT_PANELS.plugins,
      x: Math.max(24, viewW - DEFAULT_PANELS.plugins.w - 24),
      y: 72,
    }),
    workspace: place('workspace', {
      ...DEFAULT_PANELS.workspace,
      x: Math.max(24, viewW - DEFAULT_PANELS.workspace.w - 24),
      y: 100,
    }),
  };
}

/** 第一个输入框的默认落点（贴底居中），按视口夹一遍。 */
export function resolveInputRect(viewW: number, viewH: number): PanelRect {
  const w = Math.min(DEFAULT_INPUT_RECT.w, Math.max(PANEL_MIN_SESSION.w, viewW - 48));
  return fitRectToViewport(
    {
      ...DEFAULT_INPUT_RECT,
      w,
      x: Math.max(24, Math.round((viewW - w) / 2)),
      y: Math.max(80, viewH - DEFAULT_INPUT_RECT.h - 20),
    },
    viewW,
    viewH,
    PANEL_MIN_SESSION.w,
    PANEL_MIN_SESSION.h,
  );
}

const MAX_LOGS = 200;

/**
 * "收进任务栏"动画时长，与 CSS 的 `--ygg-t-slow`（260ms）对齐。
 * 窗口先播完这段动画，才真正切换成 minimized —— 否则窗口会先消失、动画无从谈起。
 */
const LEAVE_MS = 260;

/** "从任务栏展开"动画时长，与收进去的时长一致，来回对称。 */
const RESTORE_MS = 260;

/** 造一个 agent facet。 */
export function makeFacet(partial: Partial<AgentFacet> = {}): AgentFacet {
  return {
    systemPrompt: partial.systemPrompt ?? '',
    toolIds: partial.toolIds ?? [],
    messages: partial.messages ?? [],
    ledger: partial.ledger ?? [],
    scope: partial.scope ?? '*',
    progress: partial.progress ?? 'trace',
    // 缺省 act：老数据、基底、以及手写的 facet 都走完整工作流（行为不变）。
    // caps 刻意**不给默认**：undefined = 全开，只有创建/接入指令才会写明确的开关。
    mode: partial.mode ?? 'act',
    ...(partial.caps ? { caps: partial.caps } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 运行会话：输入框与组件 agent 各一份工作状态                          */
/* ------------------------------------------------------------------ */

/**
 * 一次运行的"工作状态"：队列、进度、轨迹。
 *
 * 输入框会话（'input' / 'input-2'）和组件 agent（'agent:<nodeId>'）各有一份，
 * **互不相通** —— 这就是"子 agent 不占用基底"的实现基础。
 * 共享的是底层记忆（节点树、样式、各自的对话历史与账本），不是这个。
 */
/** 一条派生连线的几何与时间。坐标是桌面坐标系，渲染时直接用。 */
export interface FxCurve {
  id: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

/** 曲线存活时长，与 CSS 动画时长对齐。 */
export const CURVE_MS = 820;
/** 关闭动画时长：先淡出，再真正删除。 */
export const DEATH_MS = 260;

export interface RunSlice {
  status: RunStatus;
  trace: TraceStep[];
  queue: QueuedInput[];
}

/** 组件 agent 的运行会话前缀。 */
export const AGENT_SESSION_PREFIX = 'agent:';

/** 某个组件 agent 的运行会话 id。 */
export function agentSessionId(nodeId: string): string {
  return AGENT_SESSION_PREFIX + nodeId;
}

export function isAgentSession(id: string): boolean {
  return typeof id === 'string' && id.startsWith(AGENT_SESSION_PREFIX);
}

/** 空运行状态（常量：给组件订阅时保持引用稳定，避免无谓重渲染）。 */
export const EMPTY_RUN: RunSlice = Object.freeze({
  status: emptyStatus(),
  trace: [],
  queue: [],
}) as RunSlice;

/**
 * 基底 Agent。
 * 它也是一个"带 agent facet 的组件"，只是 root: true 不作为窗口渲染。
 * scope='*' 是它与派生 Agent 唯一的结构性差异：派生 Agent 默认只能看见自己。
 */
export function createRootAgent(): ComponentNode {
  return {
    id: 'root',
    parentId: null,
    kind: 'component',
    name: 'Yggdrasil',
    description: '基底 Agent，可读写整个桌面。',
    status: 'active',
    root: true,
    source: '',
    size: { w: 0, h: 0 },
    pos: { x: 0, y: 0 },
    z: 0,
    agent: makeFacet({ scope: '*' }),
    createdAt: Date.now(),
  };
}

/** 新窗口落点：沿对角线散开，避免完全重叠。 */
function layoutFor(index: number): { x: number; y: number } {
  const step = 38;
  const col = index % 7;
  const row = Math.floor(index / 7) % 5;
  return { x: 96 + col * step, y: 88 + row * step };
}

/**
 * 迁移旧数据：早期版本里 Agent 是独立的 kind:'agent' 节点。
 * 现在 Agent 是组件的 facet，所以要把旧节点折叠成"带 facet 的组件"，
 * 否则老用户存储里的 Agent 会渲染不出来。
 */
/**
 * 清洗存下来的插件列表。
 *
 * 存储是外部输入（可能被手改过、可能来自旧版本），所以逐条校验形状：
 * 认不出来的条目直接丢掉，而不是让它在下游某处炸掉。
 */
function safePlugins(raw: unknown): InstalledPlugin[] {
  if (!Array.isArray(raw)) return [];
  const out: InstalledPlugin[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Partial<InstalledPlugin>;
    if (typeof p.id !== 'string' || !p.id) continue;
    if (!Array.isArray(p.endpoints) || p.endpoints.length === 0) continue;
    out.push({
      id: p.id,
      name: typeof p.name === 'string' ? p.name : p.id,
      files: p.files && typeof p.files === 'object' ? (p.files as Record<string, string>) : {},
      hash: typeof p.hash === 'string' ? p.hash : '',
      signature: p.signature === 'ok' ? 'ok' : p.signature === 'unsupported' ? 'unsupported' : 'none',
      fingerprint: typeof p.fingerprint === 'string' ? p.fingerprint : undefined,
      version: typeof p.version === 'string' ? p.version : '0',
      author: typeof p.author === 'string' ? p.author : undefined,
      description: typeof p.description === 'string' ? p.description : '',
      hosts: Array.isArray(p.hosts) ? p.hosts.filter((h): h is string => typeof h === 'string') : [],
      fields: Array.isArray(p.fields) ? p.fields : [],
      endpoints: p.endpoints,
      tools: Array.isArray(p.tools) ? p.tools : [],
      ui: Array.isArray(p.ui) ? p.ui : [],
      update: p.update && typeof p.update === 'object' ? (p.update as { url: string }) : undefined,
      guide: typeof p.guide === 'string' ? p.guide : '',
      enabled: p.enabled !== false,
      installedAt: typeof p.installedAt === 'string' ? p.installedAt : '',
      source: typeof p.source === 'string' ? p.source : '',
      values: p.values && typeof p.values === 'object' ? (p.values as Record<string, string>) : {},
    });
  }
  return out;
}

function migrateNodes(raw: Record<string, unknown> | undefined): Record<NodeId, YggNode> {
  if (!raw || typeof raw !== 'object') return { root: createRootAgent() };
  const out: Record<NodeId, YggNode> = {};
  const agentsByHost = new Map<string, Record<string, unknown>>();

  for (const [id, value] of Object.entries(raw)) {
    const n = value as Record<string, unknown>;
    if (!n || typeof n !== 'object') continue;

    if (n.kind === 'agent') {
      // 旧模型的 Agent 是独立节点，一律先登记，稍后折叠成 facet。
      const host = typeof n.hostId === 'string' ? n.hostId : 'root';
      // 基底自己（root: true）单独处理：它必须保持 root 语义。
      if (n.root === true || id === 'root') {
        out.root = migrateRootAgent(n);
        continue;
      }
      agentsByHost.set(host, n);
      continue;
    }

    if (n.kind === 'component' || n.kind === 'tool') {
      out[id] = n as unknown as YggNode;
    }
  }

  // 把旧 agent 折叠成宿主组件上的 facet。
  for (const [hostId, a] of agentsByHost) {
    const host = out[hostId];
    if (host && host.kind === 'component' && !host.root) {
      host.agent = makeFacet({
        systemPrompt: typeof a.systemPrompt === 'string' ? a.systemPrompt : '',
        messages: Array.isArray(a.messages) ? (a.messages as AgentFacet['messages']) : [],
        ledger: Array.isArray(a.ledger) ? (a.ledger as string[]) : [],
        scope: Array.isArray(a.scope) ? (a.scope as string[]) : '*',
      });
      // 只有在宿主还没有自己的源码时才借用 agent 的界面源码 ——
      // 不能无条件覆盖，也不能用 agent 的名字去改宿主的名字。
      if (!host.source && typeof a.source === 'string') host.source = a.source;
      continue;
    }

    // 宿主不存在（例如挂在 root 上的独立分身）：补建一个组件来承载它。
    const aid = typeof a.id === 'string' ? a.id : newNodeId();
    if (out[aid]) continue;
    out[aid] = {
      id: aid,
      parentId: 'root',
      kind: 'component',
      name: typeof a.name === 'string' && a.name ? a.name : 'Agent',
      status: 'active',
      source: typeof a.source === 'string' ? a.source : '',
      size: { w: 420, h: 320 },
      pos: { x: 120, y: 120 },
      z: 10,
      agent: makeFacet({
        systemPrompt: typeof a.systemPrompt === 'string' ? a.systemPrompt : '',
        messages: Array.isArray(a.messages) ? (a.messages as AgentFacet['messages']) : [],
        ledger: Array.isArray(a.ledger) ? (a.ledger as string[]) : [],
        scope: [aid],
      }),
      createdAt: typeof a.createdAt === 'number' ? a.createdAt : Date.now(),
    };
  }

  // 基底必须存在、且必须带 root 标记 —— 缺了就补一个，绝不留下无 root 标记的基底。
  if (!out.root || out.root.kind !== 'component' || out.root.root !== true) {
    const existing = out.root;
    out.root = createRootAgent();
    if (existing && existing.kind === 'component' && existing.agent) {
      out.root.agent = existing.agent;
    }
  }

  return out;
}

/** 把旧的 kind:'agent' 基底折叠成带 root 标记的组件。 */
function migrateRootAgent(a: Record<string, unknown>): ComponentNode {
  return {
    ...createRootAgent(),
    agent: makeFacet({
      systemPrompt: typeof a.systemPrompt === 'string' ? a.systemPrompt : '',
      messages: Array.isArray(a.messages) ? (a.messages as AgentFacet['messages']) : [],
      ledger: Array.isArray(a.ledger) ? (a.ledger as string[]) : [],
      scope: '*',
    }),
    createdAt: typeof a.createdAt === 'number' ? a.createdAt : Date.now(),
  };
}

interface DesktopState {
  loaded: boolean;
  storageKind: StorageKind;
  storageNote: string;
  nodes: Record<NodeId, YggNode>;
  rootId: NodeId;
  tokens: ThemeTokens;
  focusedId: NodeId | null;
  zCounter: number;
  logs: LogEntry[];
  /** 每个输入框一个会话。至少一个。 */
  sessions: InputSession[];
  /**
   * 组件 agent 的运行状态，键是**节点 id**。
   *
   * 为什么和 sessions 分开：输入框会话还要带窗口几何（rect / z / 最小化），
   * 而组件 agent 没有面板，只需要队列 / 进度 / 轨迹。
   * 两者用同一套动作读写（见 mapRun），但存储形状不同。
   * 不进持久化：进度和排队项都是瞬态的。
   */
  agentRuns: Record<NodeId, RunSlice>;
  feedback: RunFeedback | null;
  traceOpen: boolean;
  /** 插件面板开着没。 */
  pluginsOpen: boolean;
  /** 工作区面板开着没。 */
  workspaceOpen: boolean;
  /** 已安装的插件（含用户填的值）。 */
  plugins: InstalledPlugin[];
  settings: LlmSettings;
  settingsOpen: boolean;
  treeOpen: boolean;
  resetOpen: boolean;
  inspectorRect: PanelRect;
  settingsRect: PanelRect;
  traceRect: PanelRect;
  pluginsRect: PanelRect;
  workspaceRect: PanelRect;
  minimizedPanels: Record<string, boolean>;
  panelZ: Record<PanelKey, number>;
  /** 桌面视口的像素尺寸。窗口的 pos / size 都在这个坐标系里。不进持久化。 */
  viewW: number;
  viewH: number;
  /**
   * 被浏览器弹窗拦截、等用户点一下的待打开页面。不进持久化。
   *
   * 网页只能在"用户手势"里打开新窗口，而 Agent 的指令是异步执行的 ——
   * 所以 `browser_open` 经常会被拦。这里把被拦下的地址存下来，
   * 由用户在输入框里点一下（那是真的手势），页面才打得开。
   */
  pendingOpen: { id: string; url: string }[];
  /** 正在播"收进任务栏"动画的窗口 id（节点 id、panel-x 或会话 id）。不进持久化。 */
  leaving: Record<string, true>;
  /** 刚从任务栏展开、正在播"长回原位"动画的窗口 id。不进持久化。 */
  restoring: Record<string, true>;
  /**
   * 正在按住 Shift 拖动窗口 —— 此时启用网格吸附，并在背景盖一层网格。
   * 不进持久化。
   */
  snapDrag: boolean;
  /**
   * 正在播的"派生连线"：从发起它的输入框 / 组件中心，连到新组件中心的一条 S 曲线。
   * 纯视觉，不进持久化 —— 每个图形到点自己过期。
   */
  curves: FxCurve[];
  /**
   * 正在播"消失动画"的节点 id。它们仍在 nodes 里，只是渲染成淡出态；
   * 动画结束后才真正删除。不进持久化。
   */
  dying: Record<string, true>;
  /**
   * 控制台报错后"要不要让 Agent 来修"的待确认提示。null = 没有。
   * 纯瞬态，不进持久化。
   */
  consolePrompt: { id: string; text: string } | null;
  /**
   * Agent 请求了截图、等用户点一下。
   *
   * 浏览器只在**用户手势**里允许屏幕捕获，所以 Agent 的调用只能"登记请求"，
   * 由输入框显示一个按钮等用户点。记住是哪个会话要的，图才能进对上下文。
   */
  pendingShot: { sessionId: string } | null;

  hydrate: () => Promise<void>;
  addNode: (node: YggNode) => void;
  updateNode: (id: NodeId, patch: Partial<YggNode>) => void;
  /** 只更新某个组件**已有**的 agent facet（没有则什么都不做）。 */
  updateFacet: (id: NodeId, patch: Partial<AgentFacet>) => void;
  /** 装上 / 整体替换某个组件的 agent facet（用于"接入能力"）。 */
  setFacet: (id: NodeId, facet: AgentFacet) => void;
  removeNode: (id: NodeId) => void;
  cascadeIds: (id: NodeId) => NodeId[];
  focus: (id: NodeId | null) => void;
  bringToFront: (id: string) => void;
  countComponents: () => number;
  nextLayout: () => { x: number; y: number };

  log: (level: LogLevel, text: string, nodeId?: NodeId) => void;
  clearLogs: () => void;

  /** 再开一个输入框（= 再开一个可以并行干活的 Agent 会话）。返回新会话 id。 */
  addSession: () => string;
  /** 关掉一个输入框；关掉之后它的排队项一并丢弃。 */
  removeSession: (id: string) => void;
  setSessionRect: (id: string, rect: PanelRect) => void;
  setSessionMinimized: (id: string, minimized: boolean) => void;
  /** 会话级状态：会话之间互不相通。 */
  setSessionStatus: (id: string, patch: Partial<RunStatus>) => void;
  beginSessionTrace: (id: string, runId: string) => void;
  upsertSessionStep: (id: string, step: TraceStep) => void;
  /** 入队 / 出队 / 删除排队项，都在指定会话里。 */
  enqueue: (id: string, item: QueuedInput) => void;
  removeQueued: (id: string, itemId: string) => void;
  shiftQueued: (id: string) => QueuedInput | null;
  /** 会话 id -> 是否该会话还有排队项。 */
  clearQueue: (id: string) => void;
  /** 累加一次运行的用量（token / 速度 / 缓存命中）。 */
  addMetrics: (
    id: string,
    delta: Partial<SessionMetrics> & { tokensIn?: number; tokensOut?: number; msTotal?: number },
  ) => void;
  /** 追加一条消息到这个会话的记忆（基底 agent 的对话按会话分开）。 */
  appendSessionMessage: (id: string, message: Message) => void;
  /** 清空这个会话的记忆。 */
  clearSessionMessages: (id: string) => void;
  /**
   * 这个会话 id 现在有效吗。
   * 输入框会话要求输入框存在；agent 会话要求目标组件还在（且带能力）。
   */
  hasSession: (id: string) => boolean;
  /** 读运行状态（只读，给组件订阅用）。 */
  runOf: (id: string) => RunSlice;

  setSettings: (patch: Partial<LlmSettings>) => void;
  setSettingsOpen: (open: boolean) => void;
  setPluginsOpen: (open: boolean) => void;
  setWorkspaceOpen: (open: boolean) => void;
  /** 装一个已解析并通过校验的插件包。 */
  installPlugin: (pkg: PluginPackage, source: string) => InstalledPlugin;
  setPluginEnabled: (id: string, enabled: boolean) => void;
  /** 卸载：撤掉接口、清掉状态。**不动用户已填的值之外的东西。** */
  uninstallPlugin: (id: string) => void;
  /** 用户填一个字段（密钥或配置）。 */
  setPluginValue: (id: string, key: string, value: string) => void;
  setTreeOpen: (open: boolean) => void;
  setTraceOpen: (open: boolean) => void;
  setResetOpen: (open: boolean) => void;
  setPanelMinimized: (panel: PanelKey, minimized: boolean) => void;
  /** 打开 / 关掉一个面板（把三个各自不同的开合标记统一成一个入口）。 */
  setPanelOpen: (panel: PanelKey, open: boolean) => void;
  /** 拖动中切换网格吸附（按住 / 松开 Shift 都会调）。 */
  setSnapDrag: (on: boolean) => void;
  /**
   * 正在用右下角手柄调整窗口尺寸。
   *
   * 存在的理由：输入框的"内容多高就多高"是自动跟随的，而调整尺寸期间它**必须停手** ——
   * 否则用户每拖一下，自动高度就把尺寸和位置改回去，表现为"越拖越跑"。
   */
  resizing: boolean;
  setResizing: (on: boolean) => void;
  /**
   * 关闭一个窗口（组件 / 面板 / 输入框），**先播淡出动画再真正关闭**。
   * 组件走 removeNode（它自己也会播），面板与输入框在这里收尾。
   */
  requestClose: (windowId: string) => void;
  /**
   * 播一条派生连线。`layer` 决定画在窗口之下还是之上。
   * 到点自动移除，调用方不用管回收。
   */
  emitCurve: (c: Omit<FxCurve, 'id'>) => void;
  /**
   * 收到一条控制台报错。
   *
   * 这里做**全部的策略判断**（组件只管听、对话框只管显示）：
   * - **Agent 忙的时候不问** —— 问了也做不了，还会把正在跑的任务搞乱；
   * - **同一个错误短时间内不问第二次**，也**不连续追问**（否则一个每帧抛错的组件会把我问疯）；
   * - 空闲且是新错误 → 弹出确认框。
   */
  reportConsoleError: (text: string) => void;
  /** 关掉那个确认框（用户点了取消，或已经交给 Agent 了）。 */
  dismissConsolePrompt: () => void;
  /** 导出/导入场景的对话框：'export' | 'import' | null。 */
  seedDialog: 'export' | 'import' | null;
  setSeedDialog: (mode: 'export' | 'import' | null) => void;
  /** 按勾选的区块组装一个 .seed（纯函数，不落盘 —— 下载交给 UI）。 */
  exportSeed: (parts: SeedPart[], includeApiKey: boolean) => SeedFile;
  /**
   * 载入一个场景：把文件里的区块**写进落盘存储，再走一遍 hydrate()**。
   * 这样迁移 / 去重 / 夹进视口这些逻辑全部复用，不必再写第二套装载逻辑。
   * 只覆盖文件里带的区块，其余保持原样。
   */
  importSeed: (seed: SeedFile) => Promise<void>;
  /** Agent 请求截图（真正的抓取要等用户点按钮，见 pendingShot）。 */
  requestShot: (sessionId: string) => void;
  /** 清掉待截图请求（用户点了、或放弃了）。 */
  clearPendingShot: () => void;
  /** 内部用：挂上提示（策略判断在 reportConsoleError 里，别直接调它）。 */
  showConsolePrompt: (text: string) => void;
  setFeedback: (feedback: RunFeedback | null) => void;
  appendLedger: (agentId: NodeId, entries: string[]) => void;
  setPanelRect: (panel: PanelKey, rect: PanelRect) => void;
  /** 视口变化时把面板与窗口都夹回可见区域，别让用户够不到标题栏。 */
  fitToViewport: (viewW: number, viewH: number) => void;

  applyTokens: (tokens: ThemeTokens) => void;

  /** 记下一个被弹窗拦截、等用户点开的地址。 */
  addPendingOpen: (item: { id: string; url: string }) => void;
  clearPendingOpen: () => void;

  /**
   * 把窗口收进左下角任务栏：先播动画，动画结束才真正变成 minimized。
   * windowId 是节点 id、`panel-<key>` 或会话 id，三种情况都在这里分流。
   */
  requestMinimize: (windowId: string) => void;
  /**
   * 从任务栏恢复：先把窗口切回 active 并标记 restoring，WindowFrame 据此播"展开"动画。
   * 与 requestMinimize 对称。
   */
  requestRestore: (windowId: string) => void;

  resetAll: () => Promise<void>;
}

/** 同一个错误在这个时间内不再追问（毫秒）。 */
const ERROR_ASK_COOLDOWN_MS = 20000;
/** 两次追问之间至少隔这么久 —— 防止一个狂抛错的组件把我问疯。 */
const ERROR_ASK_GAP_MS = 4000;
/** Agent 忙时先记下错误，等它空闲再问；这是轮询间隔。 */
const ERROR_RETRY_MS = 800;
/**
 * 等待空闲期间暂存的错误。
 *
 * 之前是"忙就直接丢" —— 用户看到的现象就是"有时候不弹，刷新一下才弹"：
 * 报错时 Agent 正在跑，这条错误被永久丢掉；刷新后同一个错误再抛一次，那时空闲了才弹。
 * 现在暂存下来，等它跑完再问。
 */
let pendingError: { text: string; at: number } | null = null;
let retryTimer: number | null = null;
/** 指纹 -> 上次问过的时间。只活在内存里，刷新即清。 */
const consoleAsked = new Map<string, number>();
let lastAskAt = 0;
/** 单独包一层是为了测试里能替换时间源（不用真的等 60 秒）。 */
function nowMs(): number {
  return Date.now();
}

/** 清掉"问过哪些错误"的记忆。重置之后应当重新开始问。 */
export function resetConsoleAskMemory(): void {
  consoleAsked.clear();
  lastAskAt = 0;
  pendingError = null;
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
}

/** 有没有任何会话在跑。 */
function isAgentRunning(s: DesktopState): boolean {
  return (
    s.sessions.some((ses) => ses.status.running) ||
    Object.values(s.agentRuns).some((r) => r.status.running)
  );
}

/**
 * 真正决定"弹不弹"的地方。返回是否弹了。
 *
 * 三条策略：同一个错误 20s 内不重复问；两次追问至少隔 4s（防狂抛错刷屏）；
 * 已经有提示时不再叠。
 */
function tryShowConsolePrompt(text: string): boolean {
  const s = useDesktopStore.getState();
  if (s.consolePrompt) return false;
  const fp = text.slice(0, 300);
  const last = consoleAsked.get(fp) ?? 0;
  if (nowMs() - last < ERROR_ASK_COOLDOWN_MS) return false;
  if (nowMs() - lastAskAt < ERROR_ASK_GAP_MS) return false;
  consoleAsked.set(fp, nowMs());
  lastAskAt = nowMs();
  pendingError = null;
  s.showConsolePrompt(text);
  return true;
}

/** Agent 忙的时候挂一个轮询，等它空闲了再把暂存的错误问出来。 */
function scheduleConsoleRetry(): void {
  if (retryTimer !== null) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    const s = useDesktopStore.getState();
    if (!pendingError) return;
    if (isAgentRunning(s)) {
      scheduleConsoleRetry();
      return;
    }
    tryShowConsolePrompt(pendingError.text);
  }, ERROR_RETRY_MS);
}

let persistTimer: number | null = null;
let adapterRef: StorageAdapter | null = null;

/**
 * 把一次运行状态的修改同时映射到"输入框会话"和"组件 agent"两种存储上。
 *
 * 这是这一版的关键：动作的签名不动（都只收一个会话 id），
 * 于是调度器 / agentRuntime 完全不用知道自己在驱动的是输入框还是子 agent。
 * 只有这里知道两种存储形状的差别。
 */
function mapRun(
  s: DesktopState,
  id: string,
  fn: (run: RunSlice) => RunSlice,
): Partial<DesktopState> {
  if (isAgentSession(id)) {
    const key = id.slice(AGENT_SESSION_PREFIX.length);
    const cur = s.agentRuns[key] ?? EMPTY_RUN;
    return { agentRuns: { ...s.agentRuns, [key]: fn(cur) } };
  }
  return {
    sessions: s.sessions.map((ses) =>
      ses.id === id
        ? { ...ses, ...fn({ status: ses.status, trace: ses.trace, queue: ses.queue }) }
        : ses,
    ),
  };
}

/**
 * 列出所有**默认窗口**：三个常驻面板 + 每个输入框会话。
 *
 * 用途是让 Agent 能"看到并改到"它们（以前它只能看组件，默认窗口完全不存在于它的世界里）。
 */
export function defaultWindows(s: DesktopState): DefaultWindow[] {
  const panelOpen: Record<PanelKey, boolean> = {
    inspector: s.treeOpen,
    settings: s.settingsOpen,
    trace: s.traceOpen,
    plugins: s.pluginsOpen,
    workspace: s.workspaceOpen,
  };
  const out: DefaultWindow[] = ALL_PANELS.map((key) => {
    const id = 'panel-' + key;
    return {
      id,
      title: PANEL_LABELS[key],
      kind: 'panel' as const,
      rect: s[PANEL_RECT_KEY[key]] as PanelRect,
      z: s.panelZ[key],
      minimized: !!s.minimizedPanels[key],
      open: panelOpen[key],
      min: PANEL_MIN[key],
    };
  });
  for (const ses of s.sessions) {
    out.push({
      id: ses.id,
      title: ses.title,
      kind: 'input',
      rect: ses.rect,
      z: ses.z,
      minimized: ses.minimized,
      open: true,
      min: PANEL_MIN_SESSION,
    });
  }
  return out;
}

/** 把默认窗口列成给模型看的一段文本。 */
export function defaultWindowsText(wins: DefaultWindow[]): string {
  if (wins.length === 0) return '（没有默认窗口）';
  return wins
    .map(
      (w) =>
        '- id=' + w.id + ' 「' + w.title + '」 ' +
        (w.minimized ? '已最小化' : w.open ? '显示中' : '已关闭') +
        ' pos=' + Math.round(w.rect.x) + ',' + Math.round(w.rect.y) +
        ' size=' + Math.round(w.rect.w) + 'x' + Math.round(w.rect.h) +
        ' z=' + w.z,
    )
    .join('\n');
}

/** 只读地取一份运行状态。 */
function readRun(s: DesktopState, id: string): RunSlice {
  if (isAgentSession(id)) return s.agentRuns[id.slice(AGENT_SESSION_PREFIX.length)] ?? EMPTY_RUN;
  const ses = s.sessions.find((x) => x.id === id);
  return ses ? { status: ses.status, trace: ses.trace, queue: ses.queue } : EMPTY_RUN;
}

export /**
 * 打开一个面板时的统一动作：置开 + 取消最小化 + 抬到最前。
 *
 * 只 setOpen(true) 是不够的：面板最小化后由任务栏接管渲染（PanelWindow 直接返回 null），
 * 这时再点顶栏那个按钮只是把已经为 true 的开关又设成 true —— 界面毫无变化，
 * 用户看到的就是"有时打不开"。已经在最前面时也顺手聚焦，符合"点了就该出来"的预期。
 */
/**
 * 面板"正在关闭"的世代号。
 *
 * 关面板是先标记 dying、DEATH_MS 之后才真正把开关设成 false（为了播淡出动画）。
 * 如果用户在这 260ms 内又点了打开（"关掉再开"是很自然的动作），
 * 那个还没到点的定时器会把刚打开的面板又关掉 —— 表现就是**点了没反应 / 闪一下又没了**。
 * 世代号用来作废过期的那一次关闭。
 */
const panelCloseToken: Record<string, number> = {};

function openPanel(key: PanelKey): void {
  const st = useDesktopStore.getState();
  // 作废进行中的关闭：清掉 dying 标记，并让定时器认出自己已经过期。
  panelCloseToken[key] = (panelCloseToken[key] ?? 0) + 1;
  if (st.dying['panel-' + key]) {
    const dying = { ...st.dying };
    delete dying['panel-' + key];
    useDesktopStore.setState({ dying });
  }
  if (st.minimizedPanels[key]) st.setPanelMinimized(key, false);
  st.bringToFront('panel-' + key);
}

export function snapshot(): PersistedRoot {
  const s = useDesktopStore.getState();
  return {
    nodes: s.nodes,
    rootId: s.rootId,
    // 只存差异：默认值以后改了，老用户才吃得到（见 engine.ts 的 diffTokens）。
    tokens: diffTokens(s.tokens),
    settings: s.settings,
    logs: s.logs.slice(-MAX_LOGS),
    panels: {
      inspector: s.inspectorRect,
      settings: s.settingsRect,
      trace: s.traceRect,
      plugins: s.pluginsRect,
      workspace: s.workspaceRect,
    },
    // 会话存几何、可见性，以及**它自己的对话记忆**；
    // 运行状态与排队项是瞬态，不落盘。
    sessions: s.sessions.map((ses) => ({
      id: ses.id,
      title: ses.title,
      rect: ses.rect,
      z: ses.z,
      minimized: ses.minimized,
      messages: ses.messages.slice(-MAX_STORED_MESSAGES),
    })),
    panelZ: s.panelZ,
    zCounter: s.zCounter,
    surfaces: exportSurfaceStates(),
    // 插件：清单 + 开关 + 用户填的值。**值里可能有密钥**，所以它只落本地存储，
    // 不进 .seed（场景文件会被转发，密钥不该跟着走）。
    plugins: s.plugins,
  };
}

/**
 * 插件列表变了之后唯一要做的事：写状态 → 同步运行时（登记/撤掉接口）→ 落盘。
 *
 * 集中成一个函数是有意的：以前每个动作各写一遍这三步，漏一步就会出现
 * "界面显示已禁用、但模型还能调它"这种最难查的不一致。
 */
function applyPlugins(next: InstalledPlugin[]): void {
  useDesktopStore.setState({ plugins: next });
  syncPluginRuntime(next);
  schedulePersist();
}

function schedulePersist(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    void saveNow();
  }, 400);
}

async function saveNow(): Promise<void> {
  const adapter = adapterRef;
  if (!adapter) return;
  const snap = snapshot();
  try {
    await adapter.set(K_NODES, snap.nodes);
    await adapter.set(K_ROOT, snap.rootId);
    await adapter.set(K_THEME, { tokens: snap.tokens });
    await adapter.set(K_SETTINGS, snap.settings);
    await adapter.set(K_LOGS, snap.logs);
    await adapter.set(K_PLUGINS, snap.plugins);
    await adapter.set(K_PANELS, snap.panels);
    await adapter.set(K_SESSIONS, snap.sessions);
    await adapter.set('z', snap.zCounter);
    await adapter.set('panelZ', snap.panelZ);
    await adapter.set(K_SURFACES, snap.surfaces);
  } catch (e) {
    useDesktopStore.getState().log('warn', 'persist \u2715 ' + (e as Error).message);
  }
}

export const useDesktopStore = create<DesktopState>()((set, get) => ({
  loaded: false,
  storageKind: 'memory',
  storageNote: '',
  nodes: { root: createRootAgent() },
  rootId: 'root',
  tokens: { ...DEFAULT_TOKENS },
  focusedId: null,
  zCounter: 10,
  logs: [],
  sessions: [makeSession(1, resolveInputRect(window.innerWidth, window.innerHeight), window.innerWidth, window.innerHeight)],
  agentRuns: {},
  feedback: null,
  traceOpen: false,
  pluginsOpen: false,
  workspaceOpen: false,
  plugins: [],
  settings: { ...DEFAULT_SETTINGS },
  settingsOpen: false,
  treeOpen: false,
  resetOpen: false,
  inspectorRect: resolvePanels(window.innerWidth, window.innerHeight).inspector,
  settingsRect: resolvePanels(window.innerWidth, window.innerHeight).settings,
  traceRect: resolvePanels(window.innerWidth, window.innerHeight).trace,
  pluginsRect: resolvePanels(window.innerWidth, window.innerHeight).plugins,
  workspaceRect: resolvePanels(window.innerWidth, window.innerHeight).workspace,
  minimizedPanels: {},
  panelZ: { ...DEFAULT_PANEL_Z },
  viewW: typeof window === 'undefined' ? 1280 : window.innerWidth,
  viewH: typeof window === 'undefined' ? 800 : window.innerHeight,
  pendingOpen: [],
  leaving: {},
  restoring: {},
  snapDrag: false,
  resizing: false,
  curves: [],
  dying: {},
  consolePrompt: null,
  pendingShot: null,
  seedDialog: null,

  hydrate: async () => {
    const adapter = await initStorage();
    adapterRef = adapter;
    const note =
      adapter.kind === 'indexeddb' ? 'IndexedDB' : adapter.kind === 'localstorage' ? 'localStorage' : 'memory';

    let rawNodes: Record<string, unknown> | undefined;
    let rootId: NodeId | undefined;
    let theme: { tokens: ThemeTokens } | undefined;
    let settings: LlmSettings | undefined;
    let logs: LogEntry[] | undefined;
    let plugins: InstalledPlugin[] | undefined;
    let panels: Partial<PanelRects> & { input?: PanelRect } | undefined;
    let sessions: PersistedSession[] | undefined;
    let z: number | undefined;
    // 老数据里还有面板键 'input'（那时输入框还是个普通面板），所以这里用宽松类型读。
    let panelZ: Record<string, number> | undefined;
    let surfaces: Record<string, string> | undefined;
    try {
      rawNodes = await adapter.get<Record<string, unknown>>(K_NODES);
      rootId = await adapter.get<NodeId>(K_ROOT);
      theme = await adapter.get<{ tokens: ThemeTokens }>(K_THEME);
      settings = await adapter.get<LlmSettings>(K_SETTINGS);
      logs = await adapter.get<LogEntry[]>(K_LOGS);
      panels = await adapter.get<Partial<PanelRects> & { input?: PanelRect }>(K_PANELS);
      plugins = await adapter.get<InstalledPlugin[]>(K_PLUGINS);
      sessions = await adapter.get<PersistedSession[]>(K_SESSIONS);
      z = await adapter.get<number>('z');
      panelZ = await adapter.get<Record<string, number>>('panelZ');
      surfaces = await adapter.get<Record<string, string>>(K_SURFACES);
    } catch (e) {
      logs = [];
      void e;
    }

    /*
     * 存储里**没有**插件键时，保留内存里现有的那份。
     * 两个原因：① 首次加载时内存本来就是空的，这个分支等价；
     * ② 落盘是防抖的（400ms），刚装完插件就 hydrate（例如导入场景）时存储可能还是旧的一份 ——
     * 那时以内存为准才对，否则"导入一个场景"会把刚装的插件弄丢。
     */
    const safePluginList = plugins === undefined ? get().plugins : safePlugins(plugins);
    const safeNodes = migrateNodes(rawNodes);
    if (!safeNodes.root) safeNodes.root = createRootAgent();
    const safeRoot = rootId && safeNodes[rootId] ? rootId : 'root';
    /*
     * 先按值丢掉"等于历史默认值"的条目（老用户存储里留着的旧默认），
     * 再和当前默认值合并。不这么做的话，换了默认样式对老用户完全无效 ——
     * 他们本地那份旧默认值会盖回来，而且是以 <html> 行内样式的形式，优先级更高。
     */
    const tokens = mergeTokens(
      DEFAULT_TOKENS,
      migrateTokens(sanitizeTokens(theme?.tokens ?? {})),
    );

    const fallback = resolvePanels(window.innerWidth, window.innerHeight);
    /*
     * 会话恢复：优先用存下来的列表；老数据没有 sessions 字段，
     * 就用旧的 panels.input / panelZ.input 造出第一个。
     */
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const firstRect = panels?.input ?? resolveInputRect(viewW, viewH);
    const restored: InputSession[] = [];
    if (Array.isArray(sessions) && sessions.length > 0) {
      const taken = new Set<string>();
      for (const [i, p] of sessions.slice(0, MAX_SESSIONS).entries()) {
        let id = typeof p.id === 'string' && p.id ? p.id : sessionIdOf(i + 1);
        /*
         * 去重：早期版本用 `length + 1` 编序号，关掉中间的输入框后会把同一个 id
         * 发给两个会话 —— 那种脏数据可能已经存进浏览器了，恢复时必须修掉，
         * 否则两个窗口会互相顶掉（同样的 id = 同一个 DOM key、同一个 store 项）。
         */
        if (taken.has(id)) {
          let n = 1;
          while (taken.has(sessionIdOf(n))) n += 1;
          id = sessionIdOf(n);
        }
        taken.add(id);
        // 标题跟着 id 走，避免"id 是 input-3、标题却写着 Yggdrasil 2"这种错位。
        const n = numberOfSessionId(id) || i + 1;
        restored.push({
          id,
          title: sessionTitleOf(n),
          rect: fitRectToViewport(
            p.rect ?? firstRect,
            viewW,
            viewH,
            PANEL_MIN_SESSION.w,
            PANEL_MIN_SESSION.h,
          ),
          z: typeof p.z === 'number' ? p.z : 2 + n,
          minimized: p.minimized === true,
          status: emptyStatus(),
          trace: [],
          queue: [],
          metrics: emptyMetrics(),
          messages: Array.isArray(p.messages) ? (p.messages as Message[]) : [],
        });
      }
    } else {
      restored.push(makeSession(1, firstRect, viewW, viewH));
    }
    /*
     * 迁移：老版本里基底的对话存在 root 的 facet 上（所有输入框共用一份）。
     * 现在改成"每个输入框自己一份"，所以把 old root 的那份**搬到第一个输入框**，
     * 并清掉 root 上的旧数组 —— 不清的话它会一直是死数据，还每次都被持久化。
     */
    const rootNode = safeNodes.root;
    const rootFacet = rootNode && rootNode.kind === 'component' ? rootNode.agent : undefined;
    if (
      restored[0] &&
      restored[0].messages.length === 0 &&
      rootFacet &&
      rootFacet.messages.length > 0 &&
      !restored.some((ses) => ses.messages.length > 0)
    ) {
      restored[0].messages = rootFacet.messages;
      rootFacet.messages = [];
    }

    const legacyZ = panelZ?.input;
    if (typeof legacyZ === 'number' && restored[0]) restored[0].z = legacyZ;

    applyTheme(tokens);
    importSurfaceStates(surfaces);
    // 已安装且已启用的插件要重新登记接口：接口表是内存里的，刷新页面就没了。
    syncPluginRuntime(safePluginList);
    set({
      loaded: true,
      storageKind: adapter.kind,
      storageNote: note,
      viewW: window.innerWidth,
      viewH: window.innerHeight,
      nodes: safeNodes,
      rootId: safeRoot,
      tokens,
      settings: { ...DEFAULT_SETTINGS, ...(settings ?? {}) },
      logs: logs ?? [],
      sessions: restored,
      inspectorRect: panels?.inspector ?? fallback.inspector,
      settingsRect: panels?.settings ?? fallback.settings,
      traceRect: panels?.trace ?? fallback.trace,
      pluginsRect: panels?.plugins ?? fallback.plugins,
      workspaceRect: panels?.workspace ?? fallback.workspace,
      plugins: safePluginList,
      zCounter: z ?? 10 + Object.keys(safeNodes).length,
      panelZ: {
        ...DEFAULT_PANEL_Z,
        ...Object.fromEntries(
          Object.entries(panelZ ?? {}).filter(([k]) => (ALL_PANELS as string[]).includes(k)),
        ),
      },
    });
    get().log('info', 'store ' + note);
  },

  addNode: (node) => {
    set((s) => ({ nodes: { ...s.nodes, [node.id]: node } }));
    schedulePersist();
  },

  updateNode: (id, patch) => {
    set((s) => {
      const cur = s.nodes[id];
      if (!cur) return s;
      return { nodes: { ...s.nodes, [id]: { ...cur, ...patch } as YggNode } };
    });
    schedulePersist();
  },

  updateFacet: (id, patch) => {
    set((s) => {
      const cur = s.nodes[id];
      if (!cur || cur.kind !== 'component' || !cur.agent) return s;
      return { nodes: { ...s.nodes, [id]: { ...cur, agent: { ...cur.agent, ...patch } } } };
    });
    schedulePersist();
  },

  setFacet: (id, facet) => {
    set((s) => {
      const cur = s.nodes[id];
      if (!cur || cur.kind !== 'component') return s;
      return { nodes: { ...s.nodes, [id]: { ...cur, agent: facet } } };
    });
    schedulePersist();
  },

  cascadeIds: (id) => {
    const { nodes } = get();
    const out: NodeId[] = [];
    const walk = (nid: NodeId) => {
      out.push(nid);
      for (const n of Object.values(nodes)) {
        if (n.parentId === nid) walk(n.id);
      }
    };
    walk(id);
    return out;
  },

  removeNode: (id) => {
    const ids = get().cascadeIds(id);
    /*
     * 锁定是**硬拦截**：删掉锁定的节点等于把用户的保护措施拆了。
     * 这里兜底，UI 与 remove_node 指令各自还有一道（它们能给出更好的说明）。
     */
    const lockedHit = ids.find((nid) => {
      const n = get().nodes[nid];
      return !!n && n.kind === 'component' && n.locked === true;
    });
    if (lockedHit) {
      get().log('warn', '已锁定，未删除 ' + lockedHit, lockedHit);
      return;
    }

    /*
     * 先让窗口淡出，260ms 后才真正删。
     * 关闭**不画连线**（用户要求：直接淡出就好），只有创建时才连。
     */
    const s0 = get();
    const freshly = ids.filter((nid) => !s0.dying[nid]);
    if (freshly.length > 0) {
      set((s) => {
        const dying = { ...s.dying };
        for (const nid of freshly) dying[nid] = true;
        return { dying };
      });

      window.setTimeout(() => {
        const st = useDesktopStore.getState();
        set((s) => {
          const nodes = { ...s.nodes };
          for (const nid of ids) delete nodes[nid];
          // 被删掉的 agent 的运行状态一并清掉，别留下没有窗口的进度。
          const agentRuns = { ...s.agentRuns };
          for (const nid of ids) delete agentRuns[nid];
          const dying = { ...s.dying };
          for (const nid of ids) delete dying[nid];
          return {
            nodes,
            agentRuns,
            dying,
            focusedId: s.focusedId && ids.includes(s.focusedId) ? null : s.focusedId,
          };
        });
        st.log('op', '- ' + id);
        schedulePersist();
      }, DEATH_MS);
      return;
    }

    set((s) => {
      const nodes = { ...s.nodes };
      for (const nid of ids) delete nodes[nid];
      const agentRuns = { ...s.agentRuns };
      for (const nid of ids) delete agentRuns[nid];
      return {
        nodes,
        agentRuns,
        focusedId: s.focusedId && ids.includes(s.focusedId) ? null : s.focusedId,
      };
    });
    schedulePersist();
  },

  focus: (id) => {
    if (!id) {
      set({ focusedId: null });
      return;
    }
    get().bringToFront(id);
  },

  bringToFront: (id) => {
    set((s) => {
      // 基底不是窗口，不参与层级。
      if (id === 'root') return { focusedId: null };

      const z = s.zCounter + 1;

      if (id.startsWith('panel-')) {
        const key = id.slice('panel-'.length) as PanelKey;
        if (!ALL_PANELS.includes(key)) return s;
        return { zCounter: z, panelZ: { ...s.panelZ, [key]: z }, focusedId: id };
      }

      // 输入会话也是窗口，和面板、组件共用一套层级。
      if (s.sessions.some((ses) => ses.id === id)) {
        return {
          zCounter: z,
          focusedId: id,
          sessions: s.sessions.map((ses) => (ses.id === id ? { ...ses, z } : ses)),
        };
      }

      const node = s.nodes[id];
      if (!node) return s;

      return {
        focusedId: id,
        zCounter: z,
        nodes: {
          ...s.nodes,
          [id]: { ...node, z, status: node.status === 'minimized' ? 'active' : node.status },
        },
      };
    });
    schedulePersist();
  },

  countComponents: () => Object.values(get().nodes).filter((n) => n.kind === 'component' && !n.root).length,

  nextLayout: () => layoutFor(get().countComponents()),

  log: (level, text, nodeId) => {
    set((s) => {
      const entry: LogEntry = { id: newNodeId(), at: Date.now(), level, text, nodeId };
      const logs = [...s.logs, entry];
      return { logs: logs.length > MAX_LOGS ? logs.slice(-MAX_LOGS) : logs };
    });
    schedulePersist();
  },

  clearLogs: () => {
    set({ logs: [] });
    schedulePersist();
  },

  addSession: () => {
    const s = get();
    if (s.sessions.length >= MAX_SESSIONS) return '';
    /*
     * 序号要挑**空出来的**，不能直接用 `length + 1`。
     * 关掉中间一个（或关掉第一个）之后 length 会变小，再加就会撞上已存在的 id ——
     * 例如只剩 'input-2' 时 length === 1，length + 1 又算回 2，于是开出第二个 'input-2'。
     */
    const used = new Set(s.sessions.map((x) => x.id));
    let n = 1;
    while (used.has(sessionIdOf(n))) n += 1;
    const fresh = makeSession(n, resolveInputRect(s.viewW, s.viewH), s.viewW, s.viewH);
    set({ sessions: [...s.sessions, fresh], focusedId: fresh.id });
    schedulePersist();
    return fresh.id;
  },

  removeSession: (id) => {
    set((s) => {
      // 至少留一个：全关掉就没有入口了。
      if (s.sessions.length <= 1) return s;
      return {
        sessions: s.sessions.filter((ses) => ses.id !== id),
        focusedId: s.focusedId === id ? null : s.focusedId,
      };
    });
    schedulePersist();
  },

  setSessionRect: (id, rect) => {
    set((s) => ({
      sessions: s.sessions.map((ses) => (ses.id === id ? { ...ses, rect } : ses)),
    }));
    schedulePersist();
  },

  setSessionMinimized: (id, minimized) => {
    set((s) => ({
      sessions: s.sessions.map((ses) => (ses.id === id ? { ...ses, minimized } : ses)),
    }));
    schedulePersist();
  },

  setSessionStatus: (id, patch) => {
    set((s) => mapRun(s, id, (run) => ({ ...run, status: { ...run.status, ...patch } })));
    // 运行刚结束 → 顺手把"跑到一半时报的错"问出来（不用等轮询）。
    if (patch.running === false && pendingError) {
      const s = get();
      if (!isAgentRunning(s)) scheduleConsoleRetry();
    }
  },

  beginSessionTrace: (id, runId) => {
    // 清空 trace 只清**这个会话自己**的 —— 子 agent 起跑不会再顶掉基底的轨迹。
    set((s) => ({ feedback: null, ...mapRun(s, id, (run) => ({ ...run, trace: [], status: { ...run.status, runId } })) }));
  },

  upsertSessionStep: (id, step) => {
    set((s) =>
      mapRun(s, id, (run) => {
        const i = run.trace.findIndex((x) => x.id === step.id);
        return {
          ...run,
          trace: i >= 0 ? run.trace.map((x, j) => (j === i ? step : x)) : [...run.trace, step],
        };
      }),
    );
  },

  setSettings: (patch) => {
    set((s) => ({ settings: { ...s.settings, ...patch } }));
    schedulePersist();
  },

  setSettingsOpen: (open) => {
    set({ settingsOpen: open });
    if (open) openPanel('settings');
  },
  setPluginsOpen: (open) => {
    set({ pluginsOpen: open });
    if (open) openPanel('plugins');
  },
  setWorkspaceOpen: (open) => {
    set({ workspaceOpen: open });
    if (open) openPanel('workspace');
  },
  setTreeOpen: (open) => {
    set({ treeOpen: open });
    if (open) openPanel('inspector');
  },
  setTraceOpen: (open) => {
    set({ traceOpen: open });
    if (open) openPanel('trace');
  },
  setResetOpen: (open) => set({ resetOpen: open }),

  setPanelOpen: (panel, open) => {
    if (panel === 'inspector') get().setTreeOpen(open);
    else if (panel === 'trace') get().setTraceOpen(open);
    else if (panel === 'plugins') get().setPluginsOpen(open);
    else if (panel === 'workspace') get().setWorkspaceOpen(open);
    else get().setSettingsOpen(open);
  },

  setPanelMinimized: (panel, minimized) => {
    set((s) => {
      const next = { ...s.minimizedPanels };
      if (minimized) next[panel] = true;
      else delete next[panel];
      return { minimizedPanels: next };
    });
    schedulePersist();
  },

  reportConsoleError: (text) => {
    const value = text.trim();
    if (!value) return;
    // Agent 忙 → **记下来等它空闲**（以前是直接丢，所以"有时要刷新才弹"）。
    if (isAgentRunning(get())) {
      // 只留最新一条：连抛错时问最靠后的那个更有意义。
      pendingError = { text: value, at: nowMs() };
      scheduleConsoleRetry();
      return;
    }
    tryShowConsolePrompt(value);
  },

  dismissConsolePrompt: () => set({ consolePrompt: null }),

  setSeedDialog: (mode) => set({ seedDialog: mode }),

  installPlugin: (pkg, source) => {
    const manifest = pkg.manifest;
    /*
     * 高安全档只收已签名的包。
     * 检查放在这里（而不是只在界面上禁用按钮）—— 导入 .seed 之类的路径也可能走到安装。
     */
    const policy = policyFor(get().settings.securityLevel);
    if (policy.requireSignature && pkg.signature !== 'ok') {
      throw new Error(
        '安全等级「' + policy.label + '」要求插件必须已签名，这个包是「' +
          (pkg.signature === 'none' ? '未签名' : pkg.signature === 'unsupported' ? '环境无法验证签名' : '签名无效') +
          '」。请在设置里降低安全等级，或改用已签名的插件包。',
      );
    }
    /*
     * 装：清单 + guide + 用户字段的默认值。
     * 同 id 视为**升级**：保留用户已填的值（填一次密码不该因为升级就丢），
     * 但开关状态也保留 —— 升级不该把一个禁用中的插件悄悄打开。
     */
    const prev = get().plugins.find((p) => p.id === manifest.id);
    const values: Record<string, string> = {};
    for (const f of manifest.fields ?? []) {
      values[f.key] = prev?.values[f.key] ?? f.default ?? '';
    }
    const installed: InstalledPlugin = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      author: manifest.author,
      description: manifest.description,
      hosts: manifest.hosts,
      fields: manifest.fields ?? [],
      endpoints: manifest.endpoints,
      tools: manifest.tools ?? [],
      ui: manifest.ui ?? [],
      update: manifest.update,
      guide: manifest.guide ?? '',
      files: pkg.files ?? {},
      hash: pkg.hash,
      signature: pkg.signature,
      fingerprint: pkg.fingerprint,
      enabled: prev ? prev.enabled : true,
      installedAt: new Date().toISOString(),
      source,
      values,
    };
    const next = [...get().plugins.filter((p) => p.id !== manifest.id), installed];
    applyPlugins(next);
    get().log('op', (prev ? 'plugin upgrade ' : 'plugin install ') + manifest.id + ' v' + manifest.version);
    return installed;
  },

  setPluginEnabled: (id, enabled) => {
    const next = get().plugins.map((p) => (p.id === id ? { ...p, enabled } : p));
    applyPlugins(next);
    get().log('op', 'plugin ' + (enabled ? 'on ' : 'off ') + id);
  },

  uninstallPlugin: (id) => {
    const next = get().plugins.filter((p) => p.id !== id);
    applyPlugins(next);
    get().log('op', 'plugin remove ' + id);
  },

  setPluginValue: (id, key, value) => {
    const next = get().plugins.map((p) =>
      p.id === id ? { ...p, values: { ...p.values, [key]: value } } : p,
    );
    applyPlugins(next);
  },

  exportSeed: (parts, includeApiKey) => buildSeed(snapshot(), parts, includeApiKey),

  importSeed: async (seed) => {
    const adapter = await initStorage();
    adapterRef = adapter;
    /*
     * 先掐掉待落盘的定时器：它会在 400ms 后按**当前状态**重写存储，
     * 如果插在我们的写入与 hydrate 之间，就会把刚导进去的区块盖回旧值。
     */
    if (persistTimer !== null) {
      window.clearTimeout(persistTimer);
      persistTimer = null;
    }
    for (const [key, value] of seedStorageEntries(seed)) {
      /*
       * 设置**按字段合并**：文件里有的字段覆盖，没有的保持当前。
       *
       * 这一步不是可选的：导出时可以不含 API Key，如果直接把这个 settings 写进去，
       * hydrate 会用 DEFAULT_SETTINGS 补缺字段 —— 用户的 key 就被清成空串了。
       * "没导出 key" 应当意味着"不要动我的 key"，而不是"把 key 删掉"。
       */
      if (key === 'settings') {
        await adapter.set(key, { ...get().settings, ...(value as LlmSettings) });
        continue;
      }
      await adapter.set(key, value);
    }
    // 导入场景**不动已装的插件**：插件是"软件"，场景是"内容"。
    // 这里显式记住再恢复，是因为存储里那份可能是防抖尚未落盘的旧值。
    const pluginsBefore = get().plugins;
    // 交给 hydrate：它负责迁移、去重、夹取，并把 loaded / 视口等一起复位。
    await get().hydrate();
    applyPlugins(pluginsBefore);
    get().log('op', 'seed import · ' + seed.parts.join('+'));
    schedulePersist();
  },

  requestShot: (sessionId) => set({ pendingShot: { sessionId } }),
  clearPendingShot: () => set({ pendingShot: null }),

  showConsolePrompt: (text) => set({ consolePrompt: { id: newNodeId(), text } }),

  emitCurve: (c) => {
    const id = newNodeId();
    set((s) => ({ curves: [...s.curves, { ...c, id }] }));
    // 到点自己走，调用方不用管回收；图形多了也只是短暂堆积。
    window.setTimeout(() => {
      set((s) => ({ curves: s.curves.filter((x) => x.id !== id) }));
    }, CURVE_MS);
  },

  setResizing: (on) => set({ resizing: on }),

  requestClose: (windowId) => {
    const s = get();
    const isPanel = windowId.startsWith('panel-');
    const isSession = s.sessions.some((ses) => ses.id === windowId);
    // 组件交给 removeNode：它自己会标记 dying 并延后删除。
    if (!isPanel && !isSession) {
      get().removeNode(windowId);
      return;
    }
    // 只剩一个输入框不能关：全关掉就没有入口了（UI 也不给按钮）。
    if (isSession && s.sessions.length <= 1) return;
    if (s.dying[windowId]) return;
    set((cur) => ({ dying: { ...cur.dying, [windowId]: true } }));
    // 面板：记下这一轮的世代号，过期的关闭不再生效（见 openPanel）。
    const closeKey = isPanel ? (windowId.slice('panel-'.length) as PanelKey) : null;
    const closeToken = closeKey ? (panelCloseToken[closeKey] = (panelCloseToken[closeKey] ?? 0) + 1) : 0;
    window.setTimeout(() => {
      const st = get();
      /*
       * 已经被重新打开了就别再关：清掉 dying 之后直接返回。
       * 这一步是"关掉再开"能正常工作的关键。
       */
      if (closeKey && panelCloseToken[closeKey] !== closeToken) {
        set((cur) => {
          if (!cur.dying[windowId]) return {};
          const dying = { ...cur.dying };
          delete dying[windowId];
          return { dying };
        });
        return;
      }
      set((cur) => {
        const dying = { ...cur.dying };
        delete dying[windowId];
        return { dying };
      });
      if (isPanel) {
        const key = windowId.slice('panel-'.length) as PanelKey;
        if (key === 'inspector') st.setTreeOpen(false);
        else if (key === 'trace') st.setTraceOpen(false);
        else if (key === 'settings') st.setSettingsOpen(false);
        else if (key === 'plugins') st.setPluginsOpen(false);
        else if (key === 'workspace') st.setWorkspaceOpen(false);
      } else {
        st.removeSession(windowId);
      }
    }, DEATH_MS);
  },

  setSnapDrag: (on) => {
    // 只在变化时写 store：拖动中每次 pointermove 都会调到这里。
    if (get().snapDrag !== on) set({ snapDrag: on });
  },

  setFeedback: (feedback) => set({ feedback }),

  appendLedger: (agentId, entries) => {
    if (entries.length === 0) return;
    set((s) => {
      const node = s.nodes[agentId];
      if (!node || node.kind !== 'component' || !node.agent) return s;
      const merged = [...node.agent.ledger, ...entries];
      const ledger = merged.length > 60 ? merged.slice(-60) : merged;
      return { nodes: { ...s.nodes, [agentId]: { ...node, agent: { ...node.agent, ledger } } } };
    });
    schedulePersist();
  },

  setPanelRect: (panel, rect) => {
    const key = PANEL_RECT_KEY[panel];
    set({ [key]: rect } as Pick<DesktopState, typeof key>);
    schedulePersist();
  },

  fitToViewport: (viewW, viewH) => {
    set((s) => {
      /*
       * 视口变化时**按比例重新排布**，而不是只做越界夹取。
       *
       * 只夹取的问题是：把浏览器缩小一半，所有窗口留在原地 —— 整个桌面看起来"没反应"，
       * 只有真的被挤出屏幕的那几个才动。这里改成等比缩放（x/w 跟宽度、y/h 跟高度），
       * 桌面整体像被缩放了一样跟着走，窗口之间的相对布局保持不变。
       */
      const oldW = s.viewW > 0 ? s.viewW : viewW;
      const oldH = s.viewH > 0 ? s.viewH : viewH;
      const sx = viewW / oldW;
      const sy = viewH / oldH;
      const scaled = Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001;

      const scaleOf = (r: PanelRect): PanelRect =>
        scaled ? { x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy } : r;

      /**
       * 面板缩放。
       *
       * 除了视口夹取，还**封顶在它的设计尺寸**上：面板有"自然大小"，
       * 视口变大时不该比设计尺寸还大。没有这个封顶就会出现棘轮 ——
       * 缩到最小尺寸被兜住、再放大时按放大后的值继续乘，越放越大。
       */
      const placePanel = (key: PanelKey, r: PanelRect): PanelRect => {
        const fitted = fitRectToViewport(scaleOf(r), viewW, viewH, PANEL_MIN[key].w, PANEL_MIN[key].h);
        return {
          ...fitted,
          w: Math.min(fitted.w, DEFAULT_PANELS[key].w),
          h: Math.min(fitted.h, DEFAULT_PANELS[key].h),
        };
      };

      // 会话面板与派生窗口一起按比例走（尺寸封顶在它的设计尺寸上，避免棘轮）。
      const sessions = s.sessions.map((ses) => {
        const fitted = fitRectToViewport(
          scaleOf(ses.rect),
          viewW,
          viewH,
          PANEL_MIN_SESSION.w,
          PANEL_MIN_SESSION.h,
        );
        return {
          ...ses,
          rect: {
            ...fitted,
            w: Math.min(fitted.w, DEFAULT_INPUT_RECT.w),
            h: Math.min(fitted.h, DEFAULT_INPUT_RECT.h),
          },
        };
      });

      const nodes = { ...s.nodes };
      let touched = false;
      for (const n of Object.values(nodes)) {
        if (n.kind !== 'component' || n.root || !n.pos || !n.size) continue;
        const raw = scaled
          ? { x: n.pos.x * sx, y: n.pos.y * sy, w: n.size.w * sx, h: n.size.h * sy }
          : { x: n.pos.x, y: n.pos.y, w: n.size.w, h: n.size.h };
        // 派生窗口用更小的跟随后下限：比它自己的最小尺寸更容易被"按比例"保留下来
        // （用 200x120 的话，视口一缩到一半窗口就被兜住，再放大就会越放越大）。
        const next = fitRectToViewport(
          { x: raw.x, y: raw.y, w: raw.w, h: raw.h },
          viewW,
          viewH,
          FOLLOW_MIN_W,
          FOLLOW_MIN_H,
        );
        if (
          next.x !== n.pos.x || next.y !== n.pos.y ||
          next.w !== n.size.w || next.h !== n.size.h
        ) {
          nodes[n.id] = { ...n, size: { w: next.w, h: next.h }, pos: { x: next.x, y: next.y } };
          touched = true;
        }
      }

      return {
        viewW,
        viewH,
        sessions,
        inspectorRect: placePanel('inspector', s.inspectorRect),
        settingsRect: placePanel('settings', s.settingsRect),
        traceRect: placePanel('trace', s.traceRect),
        ...(touched ? { nodes } : {}),
      };
    });
    schedulePersist();
  },

  applyTokens: (tokens) => {
    const merged = mergeTokens(DEFAULT_TOKENS, sanitizeTokens(tokens));
    applyTheme(merged);
    set({ tokens: merged });
    schedulePersist();
  },

  addPendingOpen: (item) =>
    set((s) => (s.pendingOpen.some((p) => p.url === item.url) ? s : { pendingOpen: [...s.pendingOpen, item] })),

  clearPendingOpen: () => set({ pendingOpen: [] }),

  enqueue: (id, item) => {
    set((s) => mapRun(s, id, (run) => ({ ...run, queue: [...run.queue, item] })));
  },

  removeQueued: (id, itemId) => {
    set((s) => mapRun(s, id, (run) => ({ ...run, queue: run.queue.filter((q) => q.id !== itemId) })));
  },

  shiftQueued: (id) => {
    const head = readRun(get(), id).queue[0];
    if (!head) return null;
    set((s) => mapRun(s, id, (run) => ({ ...run, queue: run.queue.slice(1) })));
    return head;
  },

  clearQueue: (id) => {
    set((s) => mapRun(s, id, (run) => ({ ...run, queue: [] })));
  },

  addMetrics: (id, delta) => {
    set((s) => ({
      sessions: s.sessions.map((ses) => {
        if (ses.id !== id) return ses;
        const m = ses.metrics;
        return {
          ...ses,
          metrics: {
            tokensIn: m.tokensIn + (delta.tokensIn ?? 0),
            tokensOut: m.tokensOut + (delta.tokensOut ?? 0),
            cachedIn: m.cachedIn + (delta.cachedIn ?? 0),
            // 生成耗时累加：整体速度要从总量算，不能用"最近一次"。
            msTotal: m.msTotal + (delta.msTotal ?? 0),
            runs: m.runs + 1,
            // 只要有一次是估算的，整体就标成非精确（界面上带 ~）。
            exact: m.exact && delta.exact !== false,
          },
        };
      }),
    }));
  },

  appendSessionMessage: (id, message) => {
    set((s) => ({
      sessions: s.sessions.map((ses) => {
        if (ses.id !== id) return ses;
        const next = [...ses.messages, message];
        // 与 facet 记忆同一个上限：带图的消息是 base64，不封顶会无限涨。
        return { ...ses, messages: next.length > MAX_STORED_MESSAGES ? next.slice(-MAX_STORED_MESSAGES) : next };
      }),
    }));
    schedulePersist();
  },

  clearSessionMessages: (id) => {
    set((s) => ({ sessions: s.sessions.map((ses) => (ses.id === id ? { ...ses, messages: [] } : ses)) }));
    schedulePersist();
  },

  hasSession: (id) => {
    const s = get();
    if (isAgentSession(id)) return !!s.nodes[id.slice(AGENT_SESSION_PREFIX.length)];
    return s.sessions.some((x) => x.id === id);
  },

  runOf: (id) => readRun(get(), id),

  requestMinimize: (windowId) => {
    if (get().leaving[windowId]) return;
    set((s) => ({ leaving: { ...s.leaving, [windowId]: true } }));
    window.setTimeout(() => {
      set((s) => {
        const leaving = { ...s.leaving };
        delete leaving[windowId];
        return { leaving };
      });
      if (windowId.startsWith('panel-')) {
        const key = windowId.slice('panel-'.length) as PanelKey;
        if (ALL_PANELS.includes(key)) get().setPanelMinimized(key, true);
      } else if (get().sessions.some((ses) => ses.id === windowId)) {
        get().setSessionMinimized(windowId, true);
      } else {
        // 节点可能在这 260ms 里被删掉了：updateNode 对不存在的 id 是空操作。
        get().updateNode(windowId, { status: 'minimized' } as Partial<YggNode>);
      }
    }, LEAVE_MS);
  },

  requestRestore: (windowId) => {
    if (get().restoring[windowId]) return;
    const isPanel = windowId.startsWith('panel-');
    const key = isPanel ? (windowId.slice('panel-'.length) as PanelKey) : null;
    const isSession = get().sessions.some((ses) => ses.id === windowId);
    if (isPanel) {
      if (!key || !ALL_PANELS.includes(key)) return;
    } else if (!isSession && !get().nodes[windowId]) {
      return;
    }
    // 先标记再切状态：无论 React 是否把两次更新批到一起，窗口挂载时都能看到 restoring。
    set((s) => ({ restoring: { ...s.restoring, [windowId]: true } }));
    if (isPanel && key) get().setPanelMinimized(key, false);
    else if (isSession) get().setSessionMinimized(windowId, false);
    else get().updateNode(windowId, { status: 'active' } as Partial<YggNode>);
    window.setTimeout(() => {
      set((s) => {
        const restoring = { ...s.restoring };
        delete restoring[windowId];
        return { restoring };
      });
    }, RESTORE_MS);
  },

  resetAll: async () => {
    const adapter = adapterRef;
    if (persistTimer !== null) {
      window.clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (adapter) {
      for (const key of RESETTABLE_KEYS) {
        try {
          await adapter.del(key);
        } catch {
          /* 单个键删除失败不阻塞重置 */
        }
      }
      try {
        await adapter.set(K_SETTINGS, get().settings);
      } catch {
        /* 设置重写失败时下面的内存状态仍然重置 */
      }
    }
    const panels = resolvePanels(window.innerWidth, window.innerHeight);
    resetConsoleAskMemory();
    applyTheme(DEFAULT_TOKENS);
    importSurfaceStates(null);
    set({
      viewW: window.innerWidth,
      viewH: window.innerHeight,
      nodes: { root: createRootAgent() },
      rootId: 'root',
      tokens: { ...DEFAULT_TOKENS },
      focusedId: null,
      zCounter: 10,
      logs: [],
      feedback: null,
      sessions: [
        makeSession(1, resolveInputRect(window.innerWidth, window.innerHeight), window.innerWidth, window.innerHeight),
      ],
      agentRuns: {},
      resetOpen: false,
      minimizedPanels: {},
      panelZ: { ...DEFAULT_PANEL_Z },
      pendingOpen: [],
      leaving: {},
      restoring: {},
      snapDrag: false,
      resizing: false,
      curves: [],
      dying: {},
      consolePrompt: null,
      pendingShot: null,
      seedDialog: null,
      inspectorRect: panels.inspector,
      settingsRect: panels.settings,
      traceRect: panels.trace,
    });
    get().log('info', 'reset');
  },
}));

/** 供非 React 代码（派生总线）读取状态。 */
export function desktop() {
  return useDesktopStore.getState();
}