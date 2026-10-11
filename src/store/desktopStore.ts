import { create } from 'zustand';
import type {
  AgentFacet,
  ComponentNode,
  LogEntry,
  LogLevel,
  NodeId,
  RunFeedback,
  ThemeTokens,
  TraceStep,
  YggNode,
} from '../kernel/types';
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

export interface RunStatus {
  running: boolean;
  phase: string;
  detail: string;
  round: number;
  runId: string | null;
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
}

interface PersistedRoot {
  nodes: Record<NodeId, YggNode>;
  rootId: NodeId;
  tokens: ThemeTokens;
  settings: LlmSettings;
  logs: LogEntry[];
  panels: PanelRects;
  zCounter: number;
  panelZ: Record<string, number>;
  surfaces: Record<string, string>;
}

const K_NODES = 'nodes';
const K_ROOT = 'rootId';
const K_THEME = 'theme';
const K_SETTINGS = 'settings';
const K_LOGS = 'logs';
const K_PANELS = 'panels';
const K_SURFACES = 'surfaces';

/** 除 API 设置外，这些键在重置时全部清除。 */
const RESETTABLE_KEYS = [K_NODES, K_ROOT, K_THEME, K_LOGS, K_PANELS, 'z', 'panelZ', K_SURFACES];

/** 常驻 UI 面板。它们不是派生节点，不进派生树。 */
export type PanelKey = 'input' | 'inspector' | 'settings' | 'trace';

interface PanelRects {
  input: PanelRect;
  inspector: PanelRect;
  settings: PanelRect;
  trace: PanelRect;
}

export const DEFAULT_PANELS: PanelRects = {
  // 输入框：单行输入 + 一行状态，默认就该矮。
  input: { x: 24, y: 0, w: 560, h: 88 },
  inspector: { x: 24, y: 0, w: 340, h: 420 },
  settings: { x: 0, y: 0, w: 380, h: 388 },
  trace: { x: 0, y: 0, w: 360, h: 400 },
};

export const ALL_PANELS: PanelKey[] = ['input', 'inspector', 'settings', 'trace'];

export const DEFAULT_PANEL_Z: Record<PanelKey, number> = {
  input: 2,
  inspector: 1,
  settings: 1,
  trace: 1,
};

export const PANEL_TITLES: Record<PanelKey, string> = {
  input: 'Yggdrasil',
  inspector: 'Nodes',
  settings: 'LLM',
  trace: 'Trace',
};

/** 面板键到矩形字段的映射。 */
export const PANEL_RECT_KEY: Record<
  PanelKey,
  'inputRect' | 'inspectorRect' | 'settingsRect' | 'traceRect'
> = {
  input: 'inputRect',
  inspector: 'inspectorRect',
  settings: 'settingsRect',
  trace: 'traceRect',
};

/** 视口缩小时派生的窗口最少缩到这个尺寸（再小就没法用了）。 */
export const FOLLOW_MIN_W = 160;
export const FOLLOW_MIN_H = 90;

/** 各面板的尺寸下限，与 PanelWindow 传的 minW / minH 对齐。 */
export const PANEL_MIN: Record<PanelKey, { w: number; h: number }> = {
  input: { w: 300, h: 70 },
  inspector: { w: 280, h: 220 },
  settings: { w: 300, h: 280 },
  trace: { w: 320, h: 240 },
};

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

/** 输入框贴底居中；其余错开。所有面板都按视口夹一遍，小窗口下也不会跑到屏幕外。 */
export function resolvePanels(viewW: number, viewH: number): PanelRects {
  const inputW = Math.min(DEFAULT_PANELS.input.w, Math.max(PANEL_MIN.input.w, viewW - 48));
  const place = (key: PanelKey, rect: PanelRect) =>
    fitRectToViewport(rect, viewW, viewH, PANEL_MIN[key].w, PANEL_MIN[key].h);
  return {
    input: place('input', {
      ...DEFAULT_PANELS.input,
      w: inputW,
      x: Math.max(24, Math.round((viewW - inputW) / 2)),
      y: Math.max(80, viewH - DEFAULT_PANELS.input.h - 20),
    }),
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
  };
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
  };
}

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
  status: RunStatus;
  trace: TraceStep[];
  feedback: RunFeedback | null;
  traceOpen: boolean;
  settings: LlmSettings;
  settingsOpen: boolean;
  treeOpen: boolean;
  resetOpen: boolean;
  inputRect: PanelRect;
  inspectorRect: PanelRect;
  settingsRect: PanelRect;
  traceRect: PanelRect;
  minimizedPanels: Record<string, boolean>;
  panelZ: Record<PanelKey, number>;
  /** 桌面视口的像素尺寸。窗口的 pos / size 都在这个坐标系里。不进持久化。 */
  viewW: number;
  viewH: number;
  /** 等待发送的输入，先来先跑。不进持久化。 */
  queue: QueuedInput[];
  /**
   * 被浏览器弹窗拦截、等用户点一下的待打开页面。不进持久化。
   *
   * 网页只能在"用户手势"里打开新窗口，而 Agent 的指令是异步执行的 ——
   * 所以 `browser_open` 经常会被拦。这里把被拦下的地址存下来，
   * 由用户在输入框里点一下（那是真的手势），页面才打得开。
   */
  pendingOpen: { id: string; url: string }[];
  /** 正在播"收进任务栏"动画的窗口 id（节点 id 或 panel-x）。不进持久化。 */
  leaving: Record<string, true>;
  /** 刚从任务栏展开、正在播"长回原位"动画的窗口 id。不进持久化。 */
  restoring: Record<string, true>;

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
  setStatus: (patch: Partial<RunStatus>) => void;
  setSettings: (patch: Partial<LlmSettings>) => void;
  setSettingsOpen: (open: boolean) => void;
  setTreeOpen: (open: boolean) => void;
  setTraceOpen: (open: boolean) => void;
  setResetOpen: (open: boolean) => void;
  setPanelMinimized: (panel: PanelKey, minimized: boolean) => void;
  upsertStep: (step: TraceStep) => void;
  beginTrace: (runId: string) => void;
  setFeedback: (feedback: RunFeedback | null) => void;
  appendLedger: (agentId: NodeId, entries: string[]) => void;
  setPanelRect: (panel: PanelKey, rect: PanelRect) => void;
  /** 视口变化时把面板与窗口都夹回可见区域，别让用户够不到标题栏。 */
  fitToViewport: (viewW: number, viewH: number) => void;

  applyTokens: (tokens: ThemeTokens) => void;

  /** 记下一个被弹窗拦截、等用户点开的地址。 */
  addPendingOpen: (item: { id: string; url: string }) => void;
  clearPendingOpen: () => void;

  /** 追加一条排队输入。 */
  enqueue: (item: QueuedInput) => void;
  /** 删掉队列里的一条（用户点队列项上的 ✕）。 */
  removeQueued: (id: string) => void;
  /** 取出队首并出队；空队列返回 null。 */
  shiftQueued: () => QueuedInput | null;
  clearQueue: () => void;

  /**
   * 把窗口收进左下角任务栏：先播动画，动画结束才真正变成 minimized。
   * windowId 是节点 id 或 `panel-<key>`，两种情况都在这里分流。
   */
  requestMinimize: (windowId: string) => void;
  /**
   * 从任务栏恢复：先把窗口切回 active 并标记 restoring，WindowFrame 据此播"展开"动画。
   * 与 requestMinimize 对称。
   */
  requestRestore: (windowId: string) => void;

  resetAll: () => Promise<void>;
}

let persistTimer: number | null = null;
let adapterRef: StorageAdapter | null = null;

function snapshot(): PersistedRoot {
  const s = useDesktopStore.getState();
  return {
    nodes: s.nodes,
    rootId: s.rootId,
    // 只存差异：默认值以后改了，老用户才吃得到（见 engine.ts 的 diffTokens）。
    tokens: diffTokens(s.tokens),
    settings: s.settings,
    logs: s.logs.slice(-MAX_LOGS),
    panels: {
      input: s.inputRect,
      inspector: s.inspectorRect,
      settings: s.settingsRect,
      trace: s.traceRect,
    },
    panelZ: s.panelZ,
    zCounter: s.zCounter,
    surfaces: exportSurfaceStates(),
  };
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
    await adapter.set(K_PANELS, snap.panels);
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
  status: { running: false, phase: '', detail: '', round: 0, runId: null },
  trace: [],
  feedback: null,
  traceOpen: false,
  settings: { ...DEFAULT_SETTINGS },
  settingsOpen: false,
  treeOpen: false,
  resetOpen: false,
  inputRect: resolvePanels(window.innerWidth, window.innerHeight).input,
  inspectorRect: resolvePanels(window.innerWidth, window.innerHeight).inspector,
  settingsRect: resolvePanels(window.innerWidth, window.innerHeight).settings,
  traceRect: resolvePanels(window.innerWidth, window.innerHeight).trace,
  minimizedPanels: {},
  panelZ: { ...DEFAULT_PANEL_Z },
  viewW: typeof window === 'undefined' ? 1280 : window.innerWidth,
  viewH: typeof window === 'undefined' ? 800 : window.innerHeight,
  queue: [],
  pendingOpen: [],
  leaving: {},
  restoring: {},

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
    let panels: Partial<PanelRects> | undefined;
    let z: number | undefined;
    let panelZ: Partial<Record<PanelKey, number>> | undefined;
    let surfaces: Record<string, string> | undefined;
    try {
      rawNodes = await adapter.get<Record<string, unknown>>(K_NODES);
      rootId = await adapter.get<NodeId>(K_ROOT);
      theme = await adapter.get<{ tokens: ThemeTokens }>(K_THEME);
      settings = await adapter.get<LlmSettings>(K_SETTINGS);
      logs = await adapter.get<LogEntry[]>(K_LOGS);
      panels = await adapter.get<Partial<PanelRects>>(K_PANELS);
      z = await adapter.get<number>('z');
      panelZ = await adapter.get<Partial<Record<PanelKey, number>>>('panelZ');
      surfaces = await adapter.get<Record<string, string>>(K_SURFACES);
    } catch (e) {
      logs = [];
      void e;
    }

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
    applyTheme(tokens);
    importSurfaceStates(surfaces);
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
      inputRect: panels?.input ?? fallback.input,
      inspectorRect: panels?.inspector ?? fallback.inspector,
      settingsRect: panels?.settings ?? fallback.settings,
      traceRect: panels?.trace ?? fallback.trace,
      zCounter: z ?? 10 + Object.keys(safeNodes).length,
      panelZ: { ...DEFAULT_PANEL_Z, ...(panelZ ?? {}) },
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
    set((s) => {
      const nodes = { ...s.nodes };
      for (const nid of ids) delete nodes[nid];
      return { nodes, focusedId: s.focusedId && ids.includes(s.focusedId) ? null : s.focusedId };
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

  setStatus: (patch) => set((s) => ({ status: { ...s.status, ...patch } })),

  setSettings: (patch) => {
    set((s) => ({ settings: { ...s.settings, ...patch } }));
    schedulePersist();
  },

  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setTreeOpen: (open) => set({ treeOpen: open }),
  setTraceOpen: (open) => set({ traceOpen: open }),
  setResetOpen: (open) => set({ resetOpen: open }),

  setPanelMinimized: (panel, minimized) => {
    set((s) => {
      const next = { ...s.minimizedPanels };
      if (minimized) next[panel] = true;
      else delete next[panel];
      return { minimizedPanels: next };
    });
    schedulePersist();
  },

  beginTrace: (runId) => set({ trace: [], feedback: null, status: { ...get().status, runId } }),

  upsertStep: (step) => {
    set((s) => {
      const i = s.trace.findIndex((x) => x.id === step.id);
      const trace = i >= 0 ? s.trace.map((x, j) => (j === i ? step : x)) : [...s.trace, step];
      return { trace };
    });
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
        inputRect: placePanel('input', s.inputRect),
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

  enqueue: (item) => set((s) => ({ queue: [...s.queue, item] })),

  removeQueued: (id) => set((s) => ({ queue: s.queue.filter((q) => q.id !== id) })),

  shiftQueued: () => {
    const { queue } = get();
    if (queue.length === 0) return null;
    set({ queue: queue.slice(1) });
    return queue[0];
  },

  clearQueue: () => set({ queue: [] }),

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
    if (isPanel) {
      if (!key || !ALL_PANELS.includes(key)) return;
    } else if (!get().nodes[windowId]) {
      return;
    }
    // 先标记再切状态：无论 React 是否把两次更新批到一起，窗口挂载时都能看到 restoring。
    set((s) => ({ restoring: { ...s.restoring, [windowId]: true } }));
    if (isPanel && key) get().setPanelMinimized(key, false);
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
      trace: [],
      feedback: null,
      status: { running: false, phase: '', detail: '', round: 0, runId: null },
      resetOpen: false,
      minimizedPanels: {},
      panelZ: { ...DEFAULT_PANEL_Z },
      queue: [],
      pendingOpen: [],
      leaving: {},
      restoring: {},
      inputRect: panels.input,
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