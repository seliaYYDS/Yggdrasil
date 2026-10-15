import { create } from 'zustand';
import type {
  AgentFacet,
  ComponentNode,
  LogEntry,
  LogLevel,
  Message,
  NodeId,
  ResetPart,
  RunFeedback,
  ThemeTokens,
  TraceStep,
  YggNode,
} from '../kernel/types';
import { MAX_STORED_MESSAGES } from '../kernel/agent/prompts';
import { formatCacheHitPercent } from '../kernel/agent/usage';
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
import { clearSurfaceSource, exportSurfaceStates, importSurfaceStates } from '../kernel/registry/surfaceRegistry';
import { favoriteFromNode, loadFavorites, nodeFromFavorite, saveFavorites, type FavoriteEntry } from './favorites';
import { ALL_RESET_PARTS } from './reset';
import { hasPluginContent } from '../kernel/plugin/package';
import { buildSeed, seedStorageEntries, type SeedFile, type SeedPart } from './seed';
import { syncPluginRuntime } from '../kernel/plugin/runtime';
import { policyFor } from '../kernel/security';
import type { InstalledPlugin, PluginPackage } from '../kernel/plugin/types';

/**
 * 一个会话的用量统计。**不进持久化** —— 刷新后重新开始计，避免把历史数字当成这次的开销。
 */
/**
 * 输入侧的**三个互斥桶**。与 deepseek-harness 的 TokenUsageProjection 同构
 * （见 deepseek-harness 的 packages/llm/token-meter/src/projection.ts）：
 *
 * - `uncached` = 真正花钱、没命中缓存的输入；
 * - `cacheRead` = 命中缓存读回来的输入；
 * - `cacheWrite` = 写进缓存的输入（Anthropic 系才有；OpenAI/DeepSeek 报 0）。
 *
 * **互斥**是关键：计费输入 = 三者之和，命中率 = cacheRead / 三者之和。
 * 以前我们只有一个 promptTokens（其中含着命中数），做分母就等于"命中/含命中"，
 * 与 DSH 的口径在报 cacheWrite 的服务商上会对不上。
 */
export interface TokenBuckets {
  uncached: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 一次会话的用量统计。**不进持久化** —— 刷新后重新开始计，避免把历史数字当成这次的开销。 */
export interface SessionMetrics extends TokenBuckets {
  /** 累计输出 token。 */
  tokensOut: number;
  /**
   * 累计的**生成耗时**（毫秒，只算模型出字的那段时间）。
   * 整体 tok/s = tokensOut / (msTotal / 1000)，所以必须攒这个数，不能只留"最近一次"。
   */
  msTotal: number;
  /** 跑过几次（用来区分"0"和"还没有数据"）。 */
  runs: number;
  /** true = 数字全部来自服务端 usage；false = 含本地估算（界面会标 ~）。 */
  exact: boolean;
  /**
   * **最近一次请求**的同三个桶。
   *
   * 主显示（状态栏那行）用**累计**值 —— 与 DSH 一致：那个数字要回答的是
   * "这个会话的缓存到底省了多少"，分母越大越稳；单次请求的命中率天然会抖
   * （每步的请求前缀与上一步的重合度本来就不齐），n=1 时噪声就是全部。
   * 单轮值放悬浮说明，那里本来就不需要平滑。
   */
  last: TokenBuckets;
}

export function emptyBuckets(): TokenBuckets {
  return { uncached: 0, cacheRead: 0, cacheWrite: 0 };
}

export function emptyMetrics(): SessionMetrics {
  return {
    ...emptyBuckets(),
    tokensOut: 0,
    msTotal: 0,
    runs: 0,
    exact: true,
    last: emptyBuckets(),
  };
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

/** 计费输入 = 三个互斥桶之和（与 DSH 的 billedInputTokens 同一个定义）。 */
export function billedInput(b: TokenBuckets): number {
  return b.uncached + b.cacheRead + b.cacheWrite;
}

/**
 * 主显示的命中率文本：**整个会话的累计值**（与 DSH 的 UsagePill 一致）。
 *
 * 分母是三个互斥桶之和，不是"含命中数的 prompt 总量"—— 这是口径的关键。
 */
export function hitRateText(m: SessionMetrics): string | null {
  return formatCacheHitPercent(m.cacheRead, billedInput(m));
}

/** 悬浮说明里那个"最近一次请求"的命中率文本。 */
export function stepHitRateText(m: SessionMetrics): string | null {
  return formatCacheHitPercent(m.last.cacheRead, billedInput(m.last));
}

/**
 * 回收站里的一条：被删掉的组件 + 它被删时的那棵子树。
 *
 * 整棵子树一起存（而不是只存被点的那个节点）：删除本来就是级联的，
 * 只还原父节点会留下"子节点不见了"的半截结果。
 */
export interface TrashEntry {
  /** 被删的那个节点的 id（还原时用它做提示与去重）。 */
  rootId: NodeId;
  /** 名字，供界面显示（取被删节点的名字）。 */
  name: string;
  /** 被删时刻（显示"什么时候删的"）。 */
  at: number;
  /** 整棵子树的节点（含被删节点自己）。 */
  nodes: YggNode[];
  /** 每个组件各自的运行状态（还原后进度还在）。 */
  agentRuns: Record<string, RunSlice>;
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
  /**
   * 这条排队输入提到的**工作区文件**（只有名字，没有内容）。
   *
   * 排队项要留住它，否则"上传文件 + 排队发送"时，轮到它执行就不知道有哪些文件了；
   * 而内容在工作区里，不需要（也不应该）复制进队列。
   */
  files?: string[];
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
/**
 * 回收站容量（待办 6）。用户明确要求 5 个 —— 它兜的是"手滑删错了"，
 * 不是归档：满了丢最老的，界面上也只列最近这几条。
 */
export const MAX_TRASH = 5;

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
  pluginPageRects?: Record<string, PanelRect>;
  pluginPageOpen?: Record<string, boolean>;
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
/** 插件页面的几何与开合；与内置面板分开存，因为它们的数量是动态的。 */
const K_PAGE_RECTS = 'pluginPageRects';
const K_PAGE_OPEN = 'pluginPageOpen';

/** 除 API 设置外，这些键在重置时全部清除。 */
const RESETTABLE_KEYS = [K_NODES, K_ROOT, K_THEME, K_LOGS, K_PANELS, K_SESSIONS, 'z', 'panelZ', K_SURFACES, K_PAGE_RECTS, K_PAGE_OPEN];

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

/**
 * 面板的**显示名**：面板标题、任务栏、以及 Agent 看到的默认窗口清单都用它。
 *
 * 必须与面板自己传的 title 一致 —— 之前 settings 这里写的是旧名 'LLM'，
 * 于是最小化之后任务栏显示 'LLM'，而窗口标题是 '设置'，看起来像两个东西。
 * 统一成一份，就不会再对不上。
 */
export const PANEL_TITLES: Record<PanelKey, string> = {
  inspector: 'Nodes',
  settings: '设置',
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
 * 挂件右下角那三个操控按钮的尺寸。
 *
 * 与 `global.css` 的 `.ygg-widget-controls` 同步（3 个 18px 按钮 + 2×2 间距 + 2×2 内边距
 * = 62×22）。这类"TS 与 CSS 必须对得上"的常量在本项目已有先例（DEATH_MS 与 --ygg-t-slow 都是 260），
 * 所以这里同样写死并注明来源。
 */
export const WIDGET_CONTROLS = { w: 62, h: 22 };

/**
 * 挂件**必须留在视口里**的那一小块：控制面板本身 + 它距窗口边缘的 2px。
 *
 * 为什么是"这一块"而不是"整个挂件"：挂件没有标题栏，用户能抓住的**只有右下角这三个按钮**。
 * 那块一旦跑出屏幕，挂件就再也挪不回来、也改不了大小 —— 所以夹取的对象是它，不是整个挂件。
 */
export const WIDGET_GRAB = { w: WIDGET_CONTROLS.w + 2, h: WIDGET_CONTROLS.h + 2 };

/**
 * 移动挂件时夹住位置：保证右下角那块（控制面板所在处）始终落在视口内。
 *
 * 只夹**位置**，不夹尺寸 —— 尺寸那边不需要：控制面板会自己往可见处挪（见 widgetControlsOffset），
 * 而"挪得回去"只取决于窗口的左上角离视口边缘够不够远。
 */
export function clampWidgetPos(
  rect: PanelRect,
  viewW: number,
  viewH: number,
): PanelRect {
  // 右边至少露出 WIDGET_GRAB.w，所以 x 最大是 viewW 减它；左边最多藏到只剩这一块。
  const minX = WIDGET_GRAB.w - rect.w;
  const maxX = Math.max(minX, viewW - WIDGET_GRAB.w);
  // y 不能为负（与普通窗口一致：别把窗口顶部拖到屏幕外），下边同理留出那一块。
  const minY = Math.max(0, WIDGET_GRAB.h - rect.h);
  const maxY = Math.max(minY, viewH - WIDGET_GRAB.h);
  return {
    ...rect,
    x: Math.min(Math.max(rect.x, minX), maxX),
    y: Math.min(Math.max(rect.y, minY), maxY),
  };
}

/**
 * 挂件控制面板的落点：默认贴窗口右下角（right/bottom = 2px）。
 *
 * 窗口右下角出界时**往回挪**，让它落在可见区域里 —— 否则挂件被拖到屏幕外之后，
 * 那三个按钮就跟着出界，用户再也点不到，挂件也就"要不回来"了。
 *
 * 挪动有上限：窗口是 `overflow: hidden`，挪出窗口自身范围就会被裁掉，
 * 所以最多挪到窗口左/上边缘。
 */
export function widgetControlsOffset(
  rect: PanelRect,
  viewW: number,
  viewH: number,
): { right: number; bottom: number } {
  const overRight = Math.max(0, rect.x + rect.w - viewW);
  const overBottom = Math.max(0, rect.y + rect.h - viewH);
  return {
    right: Math.min(2 + overRight, Math.max(2, rect.w - WIDGET_CONTROLS.w - 2)),
    bottom: Math.min(2 + overBottom, Math.max(2, rect.h - WIDGET_CONTROLS.h - 2)),
  };
}

/**
 * 插件页面的**设计尺寸**与尺寸下限。
 *
 * 与内置面板同理：视口变大时不该让窗口无限跟着长（否则"缩小再放大"会越放越大），
 * 所以跟随视口时要按设计尺寸封顶。页面没有随包示例时这两个值就是唯一依据，
 * 所以放在这里由**窗口**与**视口跟随**共用一份。
 */
export const PAGE_DESIGN_SIZE = { w: 460, h: 340 };
export const PAGE_MIN_SIZE = { w: 220, h: 140 };

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
    /*
     * ⚠ 这里原来写的是"没有端点就丢掉"。
     *
     * 那是一个**装载期**的判据，比校验器更致命：校验器只是在安装时拒绝新插件，
     * 而这里会把已经装着、已经生效的插件在**刷新时整个丢掉** ——
     * 表现就是"改核心代码的插件保存不下来"。而它其实一直都在存储里，只是被这行滤掉了。
     *
     * 判据现在与校验器共用同一个 hasPluginContent（端点/工具/提示词/页面，有一即算）。
     */
    const hasContent = hasPluginContent({
      endpoints: Array.isArray(p.endpoints) ? p.endpoints.length : 0,
      tools: Array.isArray(p.tools) ? p.tools.length : 0,
      prompts: Array.isArray(p.prompts) ? p.prompts.length : 0,
      pages: Array.isArray(p.pages) ? p.pages.length : 0,
    });
    if (!hasContent) continue;
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
      // 上面那条判据不再保证 endpoints 一定是数组（有一类内容就够），所以这里显式兜底。
      endpoints: Array.isArray(p.endpoints) ? p.endpoints : [],
      tools: Array.isArray(p.tools) ? p.tools : [],
      ui: Array.isArray(p.ui) ? p.ui : [],
      // 老数据没有这两项：补空数组，不能让它们变成 undefined（下游会 .map）。
      prompts: Array.isArray(p.prompts) ? p.prompts : [],
      pages: Array.isArray(p.pages) ? p.pages : [],
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
  /**
   * 顶栏徽标的"已看过"水位：轨迹里已经有这么多步是用户看过的。
   *
   * 为什么需要它：徽标以前显示的是**轨迹总步数**，只有手动清空轨迹才会归零 ——
   * 用户点开看过之后它还挂在那里，是个假通知。现在徽标 = 总步数 - 这个水位，
   * 面板打开期间水位跟着涨（正在看着就不用提示），所以关掉再开也不会立刻又冒出数字。
   */
  traceSeen: number;
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
  /**
   * 面板与插件页面的层级。键是 string 而不是 PanelKey —— 插件页面的键由装了哪些插件决定，
   * 是动态的，塞不进一个固定联合类型里。
   */
  panelZ: Record<string, number>;
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
  /**
   * 清空**全部运行痕迹**：每个会话与每个 agent 的轨迹、运行日志、
   * 以及 agent 的对话记忆与账本。
   *
   * 为什么"清轨迹"要连记忆一起清：轨迹面板是"运行过什么"的唯一入口。
   * 用户点清空的意图是"我不想看到这些了"；如果留着对话记忆，
   * 下一轮 Agent 还会接着上次说 —— 那和"清空"的直觉相反。
   * 组件源码与桌面本身不动（那是成果，不是痕迹）。
   */
  clearTraces: () => void;

  /** 再开一个输入框（= 再开一个可以并行干活的 Agent 会话）。返回新会话 id。 */
  addSession: () => string;
  /** 关掉一个输入框；关掉之后它的排队项一并丢弃。 */
  removeSession: (id: string) => void;
  setSessionRect: (id: string, rect: PanelRect) => void;
  setSessionMinimized: (id: string, minimized: boolean) => void;
  /** 会话级状态：会话之间互不相通。 */
  setSessionStatus: (id: string, patch: Partial<RunStatus>) => void;
  /** 开一次运行：往轨迹里插一条带用户请求的"任务分隔"，**不清空**已有步骤（待办 5）。 */
  beginSessionTrace: (id: string, runId: string, request: string) => void;
  upsertSessionStep: (id: string, step: TraceStep) => void;
  /** 入队 / 出队 / 删除排队项，都在指定会话里。 */
  enqueue: (id: string, item: QueuedInput) => void;
  removeQueued: (id: string, itemId: string) => void;
  shiftQueued: (id: string) => QueuedInput | null;
  /** 会话 id -> 是否该会话还有排队项。 */
  clearQueue: (id: string) => void;
  /** 累加一次运行的用量（token / 速度 / 缓存命中）。 */
  addMetrics: (id: string, delta: Partial<SessionMetrics>) => void;

  /* ---------------- 组件收藏 ---------------- */
  /**
   * 收藏的组件（长期保留，存 IndexedDB 的**另一个库**里）。
   *
   * 与 nodes 完全解耦：删组件、重置、清回收站都不会碰到它 ——
   * 只有用户自己点"取消收藏"才会消失。
   */
  /* ---------------- 插件提供的默认页面 ---------------- */
  /**
   * 插件页面的窗口矩形与开合状态（key = 插件id.页面id）。
   *
   * 单独一份而不是塞进面板那套固定字段里：页面数量由**装了哪些插件**决定，是动态的；
   * 内置面板是固定的五个。混在一起会让"哪些 key 合法"变得说不清。
   */
  pluginPageRects: Record<string, PanelRect>;
  pluginPageOpen: Record<string, boolean>;
  /** 开/关一个插件页面（工具栏按钮点它）。 */
  setPluginPageOpen: (key: string, open: boolean) => void;
  setPluginPageRect: (key: string, rect: PanelRect) => void;

  favorites: FavoriteEntry[];
  /** 收藏一个组件/挂件（同一个 source 已收藏过就只更新名称与截图信息）。 */
  favoriteNode: (nodeId: NodeId) => void;
  /** 取消收藏。 */
  unfavorite: (favoriteId: string) => void;
  /** 用收藏重建一个组件（新 id、自动找一个空位、并聚焦）。返回新节点 id。 */
  restoreFavorite: (favoriteId: string) => NodeId | null;
  /** 某个组件是不是已经被收藏了（按 source 比 —— 重建后 id 会变）。 */
  isFavorited: (nodeId: NodeId) => boolean;
  /** 追加一条消息到这个会话的记忆（基底 agent 的对话按会话分开）。 */
  appendSessionMessage: (id: string, message: Message) => void;
  /**
   * 整体替换某个会话的记忆（上下文压缩后用）。
   * 与 append 分开是有意的：压缩是"换掉整段历史"，不是再追加一条。
   */
  replaceSessionMessages: (id: string, messages: Message[]) => void;
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

  /**
   * 本次任务里被改过结构的**默认界面**插槽（常驻面板 + 窗口标题栏）。
   *
   * 为什么要有：默认界面是宿主代码，Agent 改它的结构之后用户未必看得出来
   * （例如 Nodes 面板换了排布、标题栏换了布局），所以改完要问一句"要不要还原"。
   * 这里只记插槽 id —— 还原时逐个 clearSurfaceSource，**只动结构，不碰样式变量**。
   */
  structChanges: string[];
  /**
   * **回收站**：被删掉的组件在这里暂存，可以还原或彻底清除。
   *
   * 三条约定：
   * - **只存组件**（含它整棵子树与 agent 配置）—— 工具节点是派生出来的，还原意义不大；
   * - **上限 5 个**，先进先出：满了就丢最老的那个（用户要的是"手滑删错了能捡回来"，不是归档）；
   * - **只在当前会话有效**：不进持久化，刷新页面即清空（用户明确要求如此）。
   */
  trash: TrashEntry[];
  /** 记一笔"默认界面结构被改了"。 */
  noteStructChange: (slot: string) => void;
  /** 处理确认弹窗：restore=true 把记录里的插槽结构还原成内置实现，false = 保留。两种都会清空记录。 */
  resolveStructChanges: (restore: boolean) => void;

  /** 从回收站还原一个组件（连同它被删时的整棵子树）。 */
  restoreFromTrash: (id: string) => void;
  /** 彻底清除回收站里的一个 / 全部条目。 */
  purgeTrash: (id?: string) => void;
  setTreeOpen: (open: boolean) => void;
  setTraceOpen: (open: boolean) => void;
  /** 把当前这批轨迹标记为"已看过"（打开面板时自动调用）。 */
  markTraceSeen: () => void;
  setResetOpen: (open: boolean) => void;
  setPanelMinimized: (panel: string, minimized: boolean) => void;
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
  importSeed: (seed: SeedFile, parts?: SeedPart[]) => Promise<void>;
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
  /**
   * 按区块重置（`resetAll()` 等价于"全部区块"，行为完全一致）。
   *
   * 区块的划分与说明见 store/reset.ts —— 那里是唯一一份定义，
   * 界面上的勾选框与这里的实现读同一份。
   */
  resetParts: (parts: ResetPart[]) => Promise<void>;
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
/**
 * 把一棵被删的子树放进回收站，并把它们从桌面上摘掉。
 *
 * 抽成一个纯函数（返回 state 补丁）而不是写在 removeNode 里：删除有两条路径
 * （带淡出动画的与即时的），两条必须做出**完全一样**的回收站行为 ——
 * 分散写迟早会漏掉一条，表现为"有时候能捡回来有时候不能"。
 *
 * 只收**组件**：工具节点是派生的，还原它没有意义（它跟着创建它的组件走）。
 * 返回补丁时不动 dying —— 那是调用方的事。
 */
function dropIntoTrash(
  s: DesktopState,
  rootId: NodeId,
  ids: NodeId[],
): Partial<DesktopState> {
  const nodes = { ...s.nodes };
  const agentRuns = { ...s.agentRuns };
  // 先把要收的抄下来（之后 nodes 就被改了）。
  const taken: YggNode[] = [];
  const runs: Record<string, RunSlice> = {};
  const root = s.nodes[rootId];
  for (const nid of ids) {
    const n = s.nodes[nid];
    if (!n) continue;
    if (n.kind === 'component') {
      taken.push(n);
      if (s.agentRuns[nid]) runs[nid] = s.agentRuns[nid];
    }
  }
  for (const nid of ids) {
    delete nodes[nid];
    // 被删掉的 agent 的运行状态一并清掉，别留下没有窗口的进度。
    delete agentRuns[nid];
  }
  const patch: Partial<DesktopState> = {
    nodes,
    agentRuns,
    focusedId: s.focusedId && ids.includes(s.focusedId) ? null : s.focusedId,
  };
  // 只有组件才进回收站；工具节点的删除只影响桌面。
  if (taken.length === 0) return patch;
  const entry: TrashEntry = {
    rootId,
    name: root && root.kind === 'component' ? root.name : String(rootId),
    at: Date.now(),
    nodes: taken,
    agentRuns: runs,
  };
  // 同一个 id 再删一次时只留最新那条（否则还原时会撞 id）。
  const rest = s.trash.filter((t) => t.rootId !== rootId);
  // 先进先出：超出上限丢最老的。
  const trash = [...rest, entry].slice(-MAX_TRASH);
  return { ...patch, trash };
}

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
    pluginPageRects: s.pluginPageRects,
    pluginPageOpen: s.pluginPageOpen,
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
    await adapter.set(K_PAGE_RECTS, snap.pluginPageRects);
    await adapter.set(K_PAGE_OPEN, snap.pluginPageOpen);
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
  pluginPageRects: {},
  pluginPageOpen: {},
  favorites: [],
  feedback: null,
  traceOpen: false,
  traceSeen: 0,
  structChanges: [],
  trash: [],
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
    let favorites: FavoriteEntry[] | undefined;
    let pageRects: Record<string, PanelRect> | undefined;
    let pageOpen: Record<string, boolean> | undefined;
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
      /*
       * 收藏存在**另一个数据库**里（见 store/favorites.ts）：重置与删组件都碰不到它，
       * 所以这里单独读一次，而且读失败不该影响其它数据 —— loadFavorites 自己会兜住。
       */
      favorites = await loadFavorites();
      pageRects = await adapter.get<Record<string, PanelRect>>(K_PAGE_RECTS);
      pageOpen = await adapter.get<Record<string, boolean>>(K_PAGE_OPEN);
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
      // 收藏：**存储里没有就保留内存里那份**（与插件同一个理由 —— 它不是主库的键，
      // 读失败时不该把已经加载/刚收藏的那份清掉）。
      favorites: favorites ?? get().favorites,
      pluginPageRects: pageRects ?? {},
      pluginPageOpen: pageOpen ?? {},
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
          const dying = { ...s.dying };
          for (const nid of ids) delete dying[nid];
          return { ...dropIntoTrash(s, id, ids), dying };
        });
        st.log('op', '- ' + id);
        schedulePersist();
      }, DEATH_MS);
      return;
    }

    set((s) => ({
      ...dropIntoTrash(s, id, ids),
    }));
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

      /*
       * 插件页面也是常驻窗口，也要能被抬到最上层。
       *
       * 少了这一条：点它（或点工具栏按钮）层级一动不动，它一直停在 panelZ 的兜底值，
       * 而组件从 10 起算 —— 表现就是"插件窗口永远在最底层"，怎么点都上不来。
       * 键与内置面板同一套约定：**DOM id 带前缀、层级存裸键**。
       */
      if (id.startsWith('page-')) {
        const key = id.slice('page-'.length);
        // 用**这一份** plugins 判断页面还在不在（而不是去问运行时模块）：
        // 同一个快照里做判断，插件刚被卸掉时也不会把层级写给一个已经不在的页面。
        const known = s.plugins.some(
          (p) => p.enabled && (p.pages ?? []).some((pg) => p.id + '.' + pg.id === key),
        );
        if (!known) return s;
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

  clearTraces: () => {
    set((s0) => {
      // 会话：轨迹清空，状态复位（否则界面会停在"运行中"）。
      const sessions = s0.sessions.map((ses) => ({
        ...ses,
        trace: [],
        status: { ...ses.status, running: false, phase: '', detail: '', round: 0 },
        // 对话记忆也清掉：见上面 clearTraces 的说明。
        messages: [],
      }));
      // agent：轨迹 + 记忆 + 账本一起清（记忆留着就等于没清）。
      const nodes = { ...s0.nodes };
      for (const [id, n] of Object.entries(nodes)) {
        if (n.kind !== 'component' || !n.agent) continue;
        nodes[id] = { ...n, agent: { ...n.agent, messages: [], ledger: [] } };
      }
      const agentRuns = Object.fromEntries(
        Object.entries(s0.agentRuns).map(([id, run]) => [
          id,
          { ...run, trace: [], status: { ...run.status, running: false, phase: '', detail: '', round: 0 } },
        ]),
      );
      return { sessions, nodes, agentRuns, logs: [], feedback: null, traceSeen: 0 };
    });
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

  beginSessionTrace: (id, runId, request) => {
    /*
     * **不再清空轨迹**（待办 5）：新任务只在轨迹里插一条"任务分隔"——它带着用户这次说的那句话。
     *
     * 以前每开一轮就把 trace 清空，于是"上一次做了什么"在界面上直接消失，
     * 用户只能看到最后一次运行的步骤。现在历次任务的步骤都留着，用分隔行隔开，
     * 分隔行本身就是"这次的请求是什么"。
     * 只动**这个会话自己**的轨迹 —— 子 agent 起跑不会顶掉基底的。
     */
    const step: TraceStep = {
      id: newNodeId(),
      runId,
      round: 0,
      index: -5,
      kind: 'task',
      label: '任务',
      summary: request,
      status: 'running',
      message: '',
      startedAt: Date.now(),
      endedAt: Date.now(),
    };
    set((s) => ({
      feedback: null,
      ...mapRun(s, id, (run) => ({
        ...run,
        trace: [...run.trace, step],
        status: { ...run.status, runId },
      })),
    }));
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
    // 打开即"看过"：徽标立刻清零，不用再点一次。
    if (open) get().markTraceSeen();
  },

  markTraceSeen: () => {
    set({ traceSeen: traceTotal(get()) });
  },

  noteStructChange: (slot) => {
    if (!slot) return;
    set((s) => (s.structChanges.includes(slot) ? s : { structChanges: [...s.structChanges, slot] }));
  },

  restoreFromTrash: (id) => {
    const entry = get().trash.find((t) => t.rootId === id);
    if (!entry) return;
    set((s) => {
      const nodes = { ...s.nodes };
      for (const n of entry.nodes) {
        /*
         * id 撞车时**跳过**：还原是"把原来的东西放回去"，不是"覆盖现在的东西"。
         * 撞车发生在"删了之后又建了同 id 的组件"（正常流程不会，id 是新生成的），
         * 真撞上时保现在的、丢回收站里的那一个更安全。
         */
        if (nodes[n.id]) continue;
        nodes[n.id] = n;
      }
      return {
        nodes,
        agentRuns: { ...s.agentRuns, ...entry.agentRuns },
        trash: s.trash.filter((t) => t.rootId !== id),
        focusedId: entry.rootId in nodes ? entry.rootId : s.focusedId,
      };
    });
    get().log('op', '↺ ' + entry.name);
    schedulePersist();
  },

  purgeTrash: (id) => {
    set((s) => ({ trash: id === undefined ? [] : s.trash.filter((t) => t.rootId !== id) }));
  },

  resolveStructChanges: (restore) => {
    const slots = [...get().structChanges];
    if (restore) {
      // 只还原结构：样式（--ygg- 变量、节点局部变量）一律不碰。
      for (const slot of slots) clearSurfaceSource(slot);
    }
    if (slots.length > 0) {
      get().log('op', (restore ? 'struct restore · ' : 'struct keep · ') + slots.join('+'));
    }
    set({ structChanges: [] });
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
      prompts: manifest.prompts ?? [],
      pages: manifest.pages ?? [],
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

  importSeed: async (seed, parts) => {
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
    for (const [key, value] of seedStorageEntries(seed, parts)) {
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
    get().log('op', 'seed import · ' + (parts && parts.length ? parts.join('+') : seed.parts.join('+')));
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
    /*
     * 插件页面也是"常驻窗口"，不是组件节点 —— 少了这一条，关闭会被当成删组件，
     * 于是页面关不掉（而且会在 nodes 里白查一次）。
     */
    const isPage = windowId.startsWith('page-');
    const isSession = s.sessions.some((ses) => ses.id === windowId);
    // 组件交给 removeNode：它自己会标记 dying 并延后删除。
    if (!isPanel && !isPage && !isSession) {
      get().removeNode(windowId);
      return;
    }
    // 只剩一个输入框不能关：全关掉就没有入口了（UI 也不给按钮）。
    if (isSession && s.sessions.length <= 1) return;
    if (s.dying[windowId]) return;
    set((cur) => ({ dying: { ...cur.dying, [windowId]: true } }));
    // 面板：记下这一轮的世代号，过期的关闭不再生效（见 openPanel）。
    const closeKey = isPanel ? (windowId.slice('panel-'.length) as PanelKey) : isPage ? windowId.slice('page-'.length) : null;
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
      if (windowId.startsWith('page-')) {
        // 插件页面：动画播完才真正关掉（与面板同一条路径，只是收尾方式不同）。
        st.setPluginPageOpen(windowId.slice('page-'.length), false);
      } else if (isPanel) {
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

      /*
       * 输入框：按比例走 x/w，**高度不参与**。
       *
       * 这里原来写的是 `h: Math.min(fitted.h, DEFAULT_INPUT_RECT.h)` —— 把
       * `DEFAULT_INPUT_RECT.h`（88）当成了高度上限。它不是上限，是**缺省值**：
       * 输入框是"内容多高就多高"，高度由输入框自己的 auto-height 效应每一轮重算，
       * 而那个效应是靠"当前 h"反推 y 来保持底边不动的。
       *
       * 两者一撞就是这个现象：fitToViewport 每次 resize 都跑（**只改宽度也跑**），
       * 它把 h 从 200 改回 88，auto-height 效应再把 h 拉回 200 并把 y 减少 112 ——
       * 盒子整体上移，而底边其实没动。输入框越长，跳得越远。
       *
       * 所以高度只交给 fitRectToViewport 做"装不进视口才收紧"，
       * 宽度仍然封顶在设计宽度上（那是齐整性，不是上限问题）。
       */
      const sessions = s.sessions.map((ses) => {
        const fitted = fitRectToViewport(
          { x: ses.rect.x * sx, y: ses.rect.y * sy, w: ses.rect.w * sx, h: ses.rect.h },
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

      /*
       * 插件页面也按同一套规则跟随。
       *
       * 它们与面板一样是"默认窗口"，只是几何存在自己的表里。漏掉它们的表现与漏掉面板完全一样：
       * 缩小浏览器后页面留在原地，标题栏被挤到屏幕外，用户拖不回来。
       * 封顶用声明的 rect（页面自己说的尺寸），没声明就用统一的设计尺寸 ——
       * 与面板封顶在 DEFAULT_PANELS 是同一个理由：防棘轮。
       */
      const pageKeys = Object.keys(s.pluginPageRects);
      const nextPageRects: Record<string, PanelRect> = {};
      let pagesTouched = false;
      for (const key of pageKeys) {
        const r = s.pluginPageRects[key];
        const dot = key.indexOf('.');
        const page =
          dot < 0
            ? undefined
            : s.plugins
                .find((p) => p.id === key.slice(0, dot))
                ?.pages?.find((g) => g.id === key.slice(dot + 1));
        const capW = page?.rect?.w ?? PAGE_DESIGN_SIZE.w;
        const capH = page?.rect?.h ?? PAGE_DESIGN_SIZE.h;
        const fitted = fitRectToViewport(scaleOf(r), viewW, viewH, PAGE_MIN_SIZE.w, PAGE_MIN_SIZE.h);
        const next = { ...fitted, w: Math.min(fitted.w, capW), h: Math.min(fitted.h, capH) };
        nextPageRects[key] = next;
        if (next.x !== r.x || next.y !== r.y || next.w !== r.w || next.h !== r.h) pagesTouched = true;
      }

      return {
        viewW,
        viewH,
        sessions,
        /*
         * **五个面板一个都不能少。**
         *
         * 这里曾经只写了 inspector / settings / trace，plugins 与 workspace 漏在外面 ——
         * 表现就是那两个窗口不跟随视口：缩小浏览器后它们留在原地，标题栏被挤到屏幕外。
         * 三个"看起来正常"的面板掩盖了两个不正常的面板，所以断言要按 ALL_PANELS 逐个数，
         * 而不是抽查一两个。
         */
        inspectorRect: placePanel('inspector', s.inspectorRect),
        settingsRect: placePanel('settings', s.settingsRect),
        traceRect: placePanel('trace', s.traceRect),
        pluginsRect: placePanel('plugins', s.pluginsRect),
        workspaceRect: placePanel('workspace', s.workspaceRect),
        ...(pagesTouched ? { pluginPageRects: nextPageRects } : {}),
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
            // 三个互斥桶分别累加（计费输入与命中率都从它们算）。
            uncached: m.uncached + (delta.uncached ?? 0),
            cacheRead: m.cacheRead + (delta.cacheRead ?? 0),
            cacheWrite: m.cacheWrite + (delta.cacheWrite ?? 0),
            tokensOut: m.tokensOut + (delta.tokensOut ?? 0),
            // 生成耗时累加：整体速度要从总量算，不能用"最近一次"。
            msTotal: m.msTotal + (delta.msTotal ?? 0),
            runs: m.runs + 1,
            // 只要有一次是估算的，整体就标成非精确（界面上带 ~）。
            exact: m.exact && delta.exact !== false,
            // "最近一次"是**覆盖**而不是累加。
            last: delta.last ?? emptyBuckets(),
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

  replaceSessionMessages: (id, messages) => {
    set((s) => ({
      sessions: s.sessions.map((ses) => {
        if (ses.id !== id) return ses;
        // 同样受存储上限约束：压缩本身不该成为绕过上限的口子。
        return { ...ses, messages: messages.length > MAX_STORED_MESSAGES ? messages.slice(-MAX_STORED_MESSAGES) : messages };
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
      } else if (windowId.startsWith('page-')) {
        // 插件页面：与面板同一套最小化机制，只是键带了 `page:` 前缀（避免与面板键撞名）。
        get().setPanelMinimized('page:' + windowId.slice('page-'.length), true);
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
    /*
     * 插件页面也是"常驻窗口"，也要能从任务栏长回来。
     * 少了这一条它会在下面的"组件节点"判断里被挡掉 —— 表现是点任务栏那一项没反应，
     * 而窗口明明还收在任务栏里。
     */
    const isPage = windowId.startsWith('page-');
    const pageKey = isPage ? 'page:' + windowId.slice('page-'.length) : null;
    const isSession = get().sessions.some((ses) => ses.id === windowId);
    if (isPanel) {
      if (!key || !ALL_PANELS.includes(key)) return;
    } else if (isPage) {
      if (!pageKey || !get().minimizedPanels[pageKey]) return;
    } else if (!isSession && !get().nodes[windowId]) {
      return;
    }
    // 先标记再切状态：无论 React 是否把两次更新批到一起，窗口挂载时都能看到 restoring。
    set((s) => ({ restoring: { ...s.restoring, [windowId]: true } }));
    if (isPanel && key) get().setPanelMinimized(key, false);
    else if (isPage && pageKey) get().setPanelMinimized(pageKey, false);
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

  setPluginPageOpen: (key, open) => {
    set((s) => {
      const next: Partial<DesktopState> = { pluginPageOpen: { ...s.pluginPageOpen, [key]: open } };
      /*
       * **打开就等于抬到最上层**，与点一个面板同义。
       * 不这么做的话新开的页面会落在组件下面（组件从 10 起算，页面还没有层级），
       * 用户点完按钮看不到窗口，只会以为按钮坏了。
       */
      if (open) {
        const z = s.zCounter + 1;
        next.zCounter = z;
        next.panelZ = { ...s.panelZ, [key]: z };
      }
      return next;
    });
    schedulePersist();
  },

  setPluginPageRect: (key, rect) => {
    set((s) => ({ pluginPageRects: { ...s.pluginPageRects, [key]: rect } }));
    schedulePersist();
  },

  favoriteNode: (nodeId) => {
    const node = get().nodes[nodeId];
    if (!node || node.kind !== 'component') return;
    /*
     * 按 **source** 判重，而不是按节点 id：
     * 收藏被用来重建组件，重建出来的是**新 id** —— 拿 id 当锚点的话，
     * 用户对同一个组件点两次就会得到两份一模一样的收藏，而星号也没法反映"已收藏"。
     *
     * 代价说清楚：**同一份源码的不同实例共享一条收藏**（点第二次是更新名字/配置）。
     * 这是有意的取舍 —— 两个源码逐字节相同的组件本来就是同一个东西的两个副本，
     * 分别收藏两份只会让人分不清该用哪个。
     */
    const already = get().favorites.find((f) => f.source === node.source);
    const entry = favoriteFromNode(node, already?.id);
    const next = already
      ? get().favorites.map((f) => (f.id === already.id ? entry : f))
      : [...get().favorites, entry];
    set({ favorites: next });
    void saveFavorites(next);
    get().log('info', (already ? '\u2605 已更新收藏 ' : '\u2605 收藏 ') + node.name, nodeId);
  },

  unfavorite: (favoriteId) => {
    const next = get().favorites.filter((f) => f.id !== favoriteId);
    if (next.length === get().favorites.length) return;
    set({ favorites: next });
    void saveFavorites(next);
    get().log('info', '\u2606 取消收藏 ' + favoriteId);
  },

  restoreFavorite: (favoriteId) => {
    const fav = get().favorites.find((f) => f.id === favoriteId);
    if (!fav) return null;
    const id = newNodeId();
    const pos = get().nextLayout();
    const node = nodeFromFavorite(fav, id, pos, get().zCounter + 1);
    set((cur) => ({ nodes: { ...cur.nodes, [id]: node }, zCounter: cur.zCounter + 1 }));
    get().focus(id);
    /*
     * 重建**不画派生连线**：那条线表示"从某个来源长出来"，而这里是用户从收藏里取的，
     * 没有来源。画一条不知道从哪到哪的线只会让人以为它被谁派生过。
     */
    get().log('op', '+ comp ' + fav.name + '（来自收藏）', id);
    return id;
  },

  isFavorited: (nodeId) => {
    const node = get().nodes[nodeId];
    if (!node || node.kind !== 'component') return false;
    return get().favorites.some((f) => f.source === node.source);
  },

  resetAll: async () => {
    await get().resetParts(ALL_RESET_PARTS);
  },

  /**
   * 按区块重置。
   *
   * 与 resetAll 的关系：resetAll 只是"全部区块"的一次调用，**行为完全等价**
   * （老调用点不用改）。真正的实现在这里。
   *
   * 每个区块清什么，见 RESET_PART_INFO 的 hint —— 那些文案与这里的代码是同一份划分，
   * 改一处要改另一处。
   */
  resetParts: async (parts) => {
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
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const want = new Set(parts);
    const s0 = get();
    const patch: Record<string, unknown> = {};

    /* 无论清哪些区块，这些都是"正在进行中的动作"，重置后不该留着。 */
    patch.resetOpen = false;
    patch.feedback = null;
    patch.seedDialog = null;
    patch.snapDrag = false;
    patch.resizing = false;
    patch.pendingShot = null;

    if (want.has('interface')) {
      resetConsoleAskMemory();
      applyTheme(DEFAULT_TOKENS);
      importSurfaceStates(null);
      patch.viewW = viewW;
      patch.viewH = viewH;
      patch.tokens = { ...DEFAULT_TOKENS };
      patch.minimizedPanels = {};
      // 插件页面属于界面：位置与开合都复位（页面本身还在 —— 那是插件带来的，不是用户摆的）。
      patch.pluginPageRects = {};
      patch.pluginPageOpen = {};
      patch.panelZ = { ...DEFAULT_PANEL_Z };
      patch.zCounter = 10;
      patch.inspectorRect = panels.inspector;
      patch.settingsRect = panels.settings;
      patch.traceRect = panels.trace;
      patch.pluginsRect = panels.plugins;
      patch.workspaceRect = panels.workspace;
      /*
       * 输入框怎么处理，看历史有没有一起清 —— 这是两件事的边界：
       *
       * - **界面 + 历史一起清** → 收敛成**一个干净的新会话**。
       *   这正好等于旧的"重置"行为（全选是默认值，所以默认路径没有变化）。
       * - **只清界面** → 输入框与里面的对话都留着，只把矩形复位。
       *   对话是历史，不该被"复位界面"连累；多开的框同理（那是用户开的会话）。
       *
       * 两种情况下都**保证至少有一个输入框**：一个都没有的话界面就没法输入了，
       * 那是坏掉的状态，不是"已重置"。
       */
      const base = resolveInputRect(viewW, viewH);
      patch.sessions = want.has('history')
        ? [makeSession(1, base, viewW, viewH)]
        : (s0.sessions.length ? s0.sessions : [makeSession(1, base, viewW, viewH)]).map((ses, i) => ({
            ...ses,
            rect: makeSession(i + 1, base, viewW, viewH).rect,
            minimized: false,
          }));
    }

    if (want.has('components')) {
      patch.nodes = { root: createRootAgent() };
      patch.rootId = 'root';
      patch.focusedId = null;
      patch.trash = [];
      // 这些映射里的 key 都是节点 id，节点没了它们就是悬空的。
      patch.dying = {};
      patch.leaving = {};
      patch.restoring = {};
      patch.curves = [];
      patch.pendingOpen = [];
      patch.structChanges = [];
      // 组件 agent 的运行状态跟着组件走；**会话的运行状态留着**（那是输入框的）。
      patch.agentRuns = Object.fromEntries(
        Object.entries(s0.agentRuns).filter(([key]) => !key.startsWith(AGENT_SESSION_PREFIX)),
      );
    }

    if (want.has('history')) {
      /*
       * 历史分散在两处：组件 agent 的 messages/ledger 在 nodes 里，输入框的对话在 sessions 里。
       * 注意 nodes 可能已经被上面的 components 重置过了 —— 所以取 patch 里的那份，
       * 否则会把刚清空的节点树又写回旧的。
       */
      const nodes = (patch.nodes as Record<string, YggNode> | undefined) ?? { ...s0.nodes };
      const stripped: Record<string, YggNode> = {};
      for (const [id, n] of Object.entries(nodes)) {
        stripped[id] =
          n.kind === 'component' && n.agent
            ? { ...n, agent: { ...n.agent, messages: [], ledger: [] } }
            : n;
      }
      patch.nodes = stripped;
      patch.sessions = ((patch.sessions as InputSession[] | undefined) ?? s0.sessions).map((ses) => ({
        ...ses,
        messages: [],
      }));
    }

    if (want.has('logs')) {
      patch.logs = [];
      patch.traceSeen = 0;
      patch.sessions = ((patch.sessions as InputSession[] | undefined) ?? s0.sessions).map((ses) => ({
        ...ses,
        trace: [],
      }));
      const runs = (patch.agentRuns as typeof s0.agentRuns | undefined) ?? s0.agentRuns;
      patch.agentRuns = Object.fromEntries(
        Object.entries(runs).map(([key, slice]) => [key, { ...slice, trace: [] }]),
      );
    }

    // 控制台里"要不要让 Agent 修"的待确认也属于运行痕迹，一律收掉。
    patch.consolePrompt = null;
    // 只打需要改的字段 —— 没勾的区块原样保留。
    set(patch as never);
    /*
     * 落盘一次。
     *
     * **必要**：saveNow 会把全部键按当前状态重写一遍，于是被清掉的区块
     * （主题、插槽、节点…）在存储里也真的没了。只改内存不落盘的话，
     * 刷新一次旧数据就从存储里回来了 —— 那是最难查的一类"重置没生效"。
     */
    await saveNow();
    get().log('info', 'reset done [' + (parts.join(', ') || '无') + ']');
  },
}));

/**
 * 轨迹里一共有多少步：会话 + 各组件 agent 的运行记录。
 *
 * 顶栏徽标与"看过"水位必须用**同一个口径**，否则水位永远追不上徽标。
 */
export function traceTotal(s: {
  sessions: { trace: TraceStep[] }[];
  agentRuns: Record<string, { trace: TraceStep[] }>;
}): number {
  return (
    s.sessions.reduce((n, ses) => n + ses.trace.length, 0) +
    Object.values(s.agentRuns ?? {}).reduce((n, run) => n + (run?.trace?.length ?? 0), 0)
  );
}

/** 供非 React 代码（派生总线）读取状态。 */
export function desktop() {
  return useDesktopStore.getState();
}