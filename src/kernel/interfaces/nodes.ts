import { registerInterface } from '../registry/interfaceRegistry';
import { clampNumber, fail, ok, strOr, tokensOf, type OpResult } from '../bus/opContext';
import { compileComponent } from '../../host/compile';
import {
  defaultWindows,
  desktop,
  fitRectToViewport,
  makeFacet,
  useDesktopStore,
  type PanelKey,
} from '../../store/desktopStore';
import { unregisterTool } from '../registry/toolRegistry';
import { sanitizeTokens } from '../../theme/engine';
import type { ActCap, ComponentNode, DerivationOp, YggNode } from '../types';
import { newNodeId } from '../ids';
import { alignRect, centerRect, clampRect, fillRect, type Rect } from './layout';
import { capScopeConflict, capSummary, DEFAULT_ACT_CAPS, parseCaps } from '../agent/caps';

const RESERVED = new Set(['root']);

/** 解析 scope：'self' 是占位符，会被展开成新组件自己的 id。 */
function parseScope(raw: unknown, selfId: string): string[] | '*' {
  if (raw === '*') return '*';
  if (!Array.isArray(raw)) return [selfId];
  const ids = raw.filter((x): x is string => typeof x === 'string');
  const out = new Set<string>();
  for (const id of ids) out.add(id === 'self' ? selfId : id);
  out.add(selfId);
  return [...out];
}

/**
 * agent 字段是不是"真的要一个 Agent"。
 *
 * 写成空对象、或只给 scope 这类空壳，都不算需求 —— 它们只会把普通组件意外变成 Agent。
 * 真正的 Agent 至少要有一条职责（systemPrompt）或一组工具（tools）。
 */
function hasAgentSubstance(role: unknown, tools: unknown): boolean {
  const hasRole = typeof role === 'string' && role.trim().length > 0;
  const hasTools = Array.isArray(tools) && tools.length > 0;
  return hasRole || hasTools;
}

/**
 * 判断 create_component 的 op 是否真的要接能力（见 hasAgentSubstance）。
 *
 * 只认两种写法：显式给了 agent 对象，或顶层直接给了职责 systemPrompt。
 * 顶层单独的 tools 不算 —— 那更像"顺手写上的字段"，不是"我要一个 Agent"。
 */
function isSubstantiveAgent(op: DerivationOp): boolean {
  const raw = op.agent;
  if (raw && typeof raw === 'object') {
    const a = raw as Record<string, unknown>;
    return hasAgentSubstance(a.systemPrompt ?? op.systemPrompt, a.tools);
  }
  return hasAgentSubstance(op.systemPrompt, null);
}

/**
 * 创建组件的唯一实现。
 *
 * 没有"创建 Agent"这条独立路径 —— **创建一个带 agent 能力的组件，就是创建 Agent**。
 * 带不带能力由 op.agent 或源码里的 useAgent 决定，产出的都是一个普通组件。
 */
/**
 * 改一个**默认窗口**（面板 / 输入框）的位置与尺寸。
 *
 * 与组件分开实现，而不是硬塞进组件那条路：默认窗口没有源码 / 标题 / 挂件 / 锁定这些概念，
 * 混在一起会让"哪些字段对谁有效"变得不可预测。几何算法与 `update_component` 保持一致
 * （同一套 fill / center / align 助手），差别只有夹取时用各自的尺寸下限。
 */
function updateDefaultWindow(op: DerivationOp, ref: string): OpResult {
  const s = desktop();
  const win = defaultWindows(s).find((w) => w.id === ref);
  if (!win) {
    const list = defaultWindows(s).map((w) => w.id + '「' + w.title + '」').join('、');
    return fail('No such default window ' + ref + '. Existing: ' + list);
  }
  const viewW = s.viewW;
  const viewH = s.viewH;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const base = { ...win.rect };
  const pos = op.pos as { x?: unknown; y?: unknown } | undefined;
  if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
    base.x = Math.round(pos.x);
    base.y = Math.round(pos.y);
  }
  const size = op.size as { w?: unknown; h?: unknown } | undefined;
  if (size) {
    base.w = clampNumber(size.w, base.w, win.min.w, viewW);
    base.h = clampNumber(size.h, base.h, win.min.h, viewH);
  }
  let rect: Rect = { ...base };
  const dx = num(op.dx);
  const dy = num(op.dy);
  const dw = num(op.dw);
  const dh = num(op.dh);
  if (dx || dy || dw || dh) {
    rect = { x: rect.x + dx, y: rect.y + dy, w: rect.w + dw, h: rect.h + dh };
  }
  if (op.fill === true) rect = fillRect(viewW, viewH);
  else if (op.center === true) rect = centerRect(rect, viewW, viewH);
  else if (typeof op.align === 'string' && op.align) rect = alignRect(rect, op.align, viewW, viewH);
  // 用各自的尺寸下限夹进视口（面板 280×220 起，输入框 300×70 起）。
  const fitted = fitRectToViewport(rect, viewW, viewH, win.min.w, win.min.h);

  const touched: string[] = [];
  if (fitted.x !== win.rect.x || fitted.y !== win.rect.y) touched.push('position');
  if (fitted.w !== win.rect.w || fitted.h !== win.rect.h) touched.push('size');
  if (op.focus === true) {
    s.bringToFront(win.id);
    touched.push('raised');
  }
  if (touched.length === 0) return fail('No changeable field was given (default windows support pos/size/dx/dy/dw/dh/center/fill/align/focus only).');

  if (win.kind === 'panel') {
    const key = win.id.slice('panel-'.length) as PanelKey;
    s.setPanelRect(key, fitted);
  } else {
    s.setSessionRect(win.id, fitted);
  }
  s.log('op', 'panel ' + win.id + ' ' + touched.join('+'), win.id);
  return ok('Adjusted default window "' + win.title + '": ' + touched.join(', '), {
    observation:
      win.id + ' pos=' + fitted.x + ',' + fitted.y + ' size=' + fitted.w + 'x' + fitted.h,
  });
}

/**
 * 默认窗口的显隐。
 *
 * 映射关系（面板与输入框的"状态"概念不一样，所以在这里统一翻译）：
 * - **面板**：closed = 关掉（面板自己的 open 标记）；minimized = 收进任务栏；active = 打开并取消最小化。
 * - **输入框**：closed = 移除这个会话（只剩一个时拒绝）；minimized / active 照常。
 */
function setDefaultWindowState(ref: string, state: 'active' | 'minimized' | 'closed'): OpResult {
  const s = desktop();
  const win = defaultWindows(s).find((w) => w.id === ref);
  if (!win) {
    const list = defaultWindows(s).map((w) => w.id + '「' + w.title + '」').join('、');
    return fail('No such default window ' + ref + '. Existing: ' + list);
  }
  if (win.kind === 'panel') {
    const key = win.id.slice('panel-'.length) as PanelKey;
    if (state === 'closed') s.setPanelOpen(key, false);
    else if (state === 'minimized') {
      s.setPanelOpen(key, true);
      s.setPanelMinimized(key, true);
    } else {
      s.setPanelOpen(key, true);
      s.setPanelMinimized(key, false);
    }
  } else if (state === 'closed') {
    if (s.sessions.length <= 1) return fail('This is the last input box; closing it would leave no way in.');
    s.removeSession(win.id);
  } else {
    s.setSessionMinimized(win.id, state === 'minimized');
  }
  if (state !== 'closed') s.bringToFront(win.id);
  s.log('op', 'panel ' + win.id + ' ' + state, win.id);
  const label = state === 'active' ? 'shown' : state === 'minimized' ? 'minimised' : 'closed';
  return ok('Default window "' + win.title + '" is now ' + label + '.');
}

function createComponentNode(op: DerivationOp, ctx: { originId: string; sessionId: string }) {
  const name = strOr(op.name, 'component');
  const store = useDesktopStore.getState();
  const id = newNodeId();

  // agent 字段必须是"有实质内容"的需求才算数。
  // 空壳（agent: {}）或只写了 scope 的 agent 字段一律忽略 —— 否则模型出于惯性
  // 顺手带一个空 agent，就会把普通组件变成 Agent（这是"对派生 agent 太敏感"的直接原因）。
  const substantiveAgent = isSubstantiveAgent(op);
  const agentRaw = substantiveAgent ? (op.agent as Record<string, unknown>) : null;
  const ignoredAgent = !!op.agent && !substantiveAgent;

  // 只有一份源码：组件的 source。
  // Agent 能力不携带界面 —— 界面永远是组件自己的事。
  const source = typeof op.source === 'string' ? op.source : '';

  // 源码里从 "yggdrasil" 引入了 useAgent 并调用它，就等于声明"这个组件需要 agent 能力"。
  // 此时若没显式给 agent 字段，就自动接上 —— 否则 useAgent() 拿不到能力，
  // 消息会发不出去（更早的版本甚至会静默发给基底 agent）。
  // 必须同时出现 import 与调用：只提一句名字（注释、字符串）不该装上能力。
  const declaresAgent = /from\s*['"]yggdrasil['"]/.test(source) && /\buseAgent\b/.test(source);
  const wantAgent = substantiveAgent || declaresAgent;
  const autoAttached = wantAgent && !substantiveAgent;
  if (source.trim()) {
    const compiled = compileComponent(id, source);
    if (!compiled.ok) {
      desktop().log('error', 'comp ' + name + ' \u2715 ' + compiled.error);
      return fail('Component "' + name + '" failed to compile: ' + compiled.error);
    }
  }

  const size = (op.size ?? {}) as { w?: unknown; h?: unknown };

  // 显式给了 hostId 就必须存在；静默回退会把东西建到没指定的地方。
  const explicitHost = typeof op.hostId === 'string' && op.hostId.trim() ? op.hostId.trim() : null;
  if (explicitHost && !store.nodes[explicitHost]) {
    return fail('hostId "' + explicitHost + '" does not exist. See inspect for the component ids you can use.');
  }
  const parentId = explicitHost ?? ctx.originId;

  const node: YggNode = {
    id,
    parentId: store.nodes[parentId] ? parentId : 'root',
    kind: 'component',
    name,
    description: typeof op.description === 'string' ? op.description : undefined,
    status: 'active',
    source,
    size: { w: clampNumber(size.w, 380, 200, 1600), h: clampNumber(size.h, 300, 140, 1200) },
    pos: freeSpot(op.pos as { x?: unknown; y?: unknown }),
    z: store.zCounter + 1,
    // 窗口形态：挂件（widget）没有标题栏、根容器透明，靠 hover 出来的按钮操控。
    frame: op.frame === 'widget' ? 'widget' : 'window',
    ...(op.locked === true ? { locked: true } : {}),
    createdAt: Date.now(),
  };

  // 这三个要带出 if 块：下面的返回说明里要用到。
  let mode: 'reply' | 'act' = 'act';
  let caps: ActCap[] | undefined;
  let ignoredForReply = false;
  if (wantAgent) {
    // agent 只贡献"能力"：职责、工具子集、作用域、上下文。
    const rawScope = agentRaw?.scope !== undefined ? agentRaw.scope : op.scope;
    mode = parseMode(agentRaw?.mode ?? op.mode);
    const scope = parseScope(rawScope, id);
    /*
     * reply 档没有 ops，所以"能力开关"和"工具子集"对它没有意义 ——
     * 显式传了就明说被忽略，别让人以为给了却在生效。
     */
    const givenCaps = agentRaw?.caps ?? op.caps;
    const givenTools = pickToolIds(agentRaw?.tools ?? op.tools);
    ignoredForReply = mode === 'reply' && (!!givenCaps || givenTools.length > 0);
    // 能力开关：给了用给的，没给就默认最小集（不是全开）。
    caps = mode === 'reply' ? undefined : parseCaps(givenCaps) ?? DEFAULT_ACT_CAPS;
    const conflict = mode === 'reply' ? null : capScopeConflict(caps, scope);
    if (conflict) return fail('The capability switches of "' + name + '" conflict with its scope: ' + conflict);
    node.agent = makeFacet({
      systemPrompt:
        agentRaw && typeof agentRaw.systemPrompt === 'string'
          ? agentRaw.systemPrompt
          : typeof op.systemPrompt === 'string'
            ? op.systemPrompt
            : '',
      toolIds: pickToolIds(agentRaw?.tools ?? op.tools),
      messages: [],
      ledger: [],
      scope,
      // 创建时就能决定它的进度显不显示（'trace' 默认 / 'none' 不并进 Trace）。
      progress: parseProgress(agentRaw?.progress ?? op.progress),
      mode,
      // act 档的能力开关：给了就用给的，没给就只给默认那两项（desktop + style）。
      caps: mode === 'reply' ? undefined : caps,
    });
  }

  // 记下"从哪来"：这条信息用来画派生连线，也用来在关闭时连回同一个来源。
  node.bornFrom = ctx.sessionId;
  store.addNode(node);
  store.focus(id);
  /*
   * 派生连线：从来源（输入框会话，或发起它的那个组件）的中心，
   * 连到新组件的中心。曲线画在窗口**之下**，所以它是"组件从这条线里长出来"的顺序。
   */
  const view = desktop();
  const ses = view.sessions.find((x) => x.id === ctx.sessionId);
  const host = view.nodes[ctx.originId];
  const center = ses
    ? { x: ses.rect.x + ses.rect.w / 2, y: ses.rect.y + ses.rect.h / 2 }
    : // 宿主组件也可以当源（子 Agent 自己派生出来的东西）；
      // 但基底不算 —— 它不是窗口，没有可用的矩形。
      host && host.kind === 'component' && !host.root
      ? { x: host.pos.x + host.size.w / 2, y: host.pos.y + host.size.h / 2 }
      : null;
  if (center) {
    store.emitCurve({
      fromX: center.x,
      fromY: center.y,
      toX: node.pos.x + node.size.w / 2,
      toY: node.pos.y + node.size.h / 2,
    });
  }
  desktop().log('op', '+ comp ' + name, id);

  // 返回信息只说明"这个组件有没有 agent 能力"，不把它叫成另一种东西。
  const scopeText =
    node.agent && node.agent.scope !== '*' ? (node.agent.scope as string[]).join(', ') : 'all';
  const capNote = wantAgent
    ? 'It now has agent capability (tier ' + mode + '; scope ' + scopeText +
      (mode === 'reply'
        ? '; question and answer, replies show directly in its own interface, no capability switches' +
          (ignoredForReply ? ' (caps/tools were ignored for the reply tier)' : '')
        : '; capability switches ' + capSummary(caps ?? [])) +
      (autoAttached ? ', auto-attached because the source uses useAgent' : '') +
      '), and you can drive it from its own interface with useAgent().'
    : 'It is a plain component for now (the default); only attach agent capability with attach_agent when the user explicitly asks it to think and act on its own (the interface does not change).' +
      (ignoredAgent ? ' The agent object you gave had neither a role nor tools, so it was ignored as an empty shell.' : '');

  return ok('Created component "' + name + '"', {
    createdId: id,
    observation: 'Component id=' + id + ' name=' + name + ' was inserted into the desktop. ' + capNote,
  });
}
/**
 * 解析 Agent 档位。认不出来一律按 act —— 缺省就是 act，这样老数据与老写法都不受影响。
 */
function parseMode(raw: unknown): 'reply' | 'act' {
  return raw === 'reply' ? 'reply' : 'act';
}

/** 取工具 id 列表。 */
function pickToolIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string');
}

/**
 * 子 agent 的进度要不要并进 Trace 面板。
 *
 * 默认 'trace'（显示）—— 创建者不表态时就给个安全的默认，别让进度凭空消失。
 * 创建者如果已经把它画在子 agent 自己的界面里（源码里读 useAgent().progress），
 * 就可以传 'none' 避免重复。认不出来的值一律按默认处理。
 */
function parseProgress(raw: unknown): 'trace' | 'none' {
  return raw === 'none' ? 'none' : 'trace';
}


/**
 * 找可操作的"窗口组件"。
 * 基底也是 component，但它不是窗口，不该被 update_component / set_window_state 当成目标。
 */
function findComponent(id: string): ComponentNode | null {
  const node = desktop().nodes[id];
  return node && node.kind === 'component' && !node.root ? node : null;
}

/** 新窗口落点：找一个没有被占用的偏移。 */
function freeSpot(preferred?: { x?: unknown; y?: unknown }): { x: number; y: number } {
  const store = useDesktopStore.getState();
  if (typeof preferred?.x === 'number' && typeof preferred?.y === 'number') {
    return { x: Math.round(preferred.x), y: Math.round(preferred.y) };
  }
  const base = store.nextLayout();
  const taken = Object.values(store.nodes);
  for (let i = 0; i < 40; i += 1) {
    const x = base.x + i * 26;
    const y = base.y + i * 22;
    const clash = taken.some((n) => n.pos && Math.abs(n.pos.x - x) < 24 && Math.abs(n.pos.y - y) < 24);
    if (!clash) return { x, y };
  }
  return base;
}

export function registerNodeInterfaces(): void {
  registerInterface({
    kind: 'create_component',
    label: '创建组件',
    description:
      '**Create a page/window** (the only creation entry point): one source yields one plain component. pos / size optional — without them it lands in a free spot. Pass frame: "widget" for a widget. The agent field is optional (normally omitted): whether to attach, how, which tier and which capability switches are covered in the "Agent capability" section.',
    example: {
      kind: 'create_component',
      name: 'Calculator',
      size: { w: 320, h: 420 },
      source:
        'import * as React from "react";\n' +
        'export default function Calc(){ const [v, setV] = React.useState("0"); ' +
        'return <div style={{ width: "100%", height: "100%", background: "var(--ygg-surface)", ' +
        'color: "var(--ygg-fg)" }}>{v}</div>; }',
    },
    mutates: true,
    cap: 'desktop',
    handler: (op, ctx) => createComponentNode(op, ctx),
  });

  registerInterface({
    kind: 'update_component',
    label: '修改组件',
    description:
      'Change an existing component (= adjust its window); fields you omit stay as they are: source replaces the source; name renames; status shows/hides; tokens sets local style; z or focus=true raises it; frame switches window/widget; fixed / locked toggle. **Geometry**: absolute `pos/size`, relative `dx dy dw dh`, or `center` / `fill` / `align` computed from the viewport. Results are clamped into the viewport. **Default windows** (Nodes / Settings / Trace / input boxes) are not components — target them with `panel` instead (ids in the "Default windows" section, e.g. panel-settings / input); they support geometry and focus only.',
    example: { kind: 'update_component', id: 'n_xxx', dx: 120, dy: 0, focus: true },
    mutates: true,
    cap: 'desktop',
    handler: (op) => {
      /*
       * 先分流：`panel` 给的是**默认窗口**（常驻面板 / 输入框），它们不是节点。
       * 只认几何与 focus —— 它们没有源码、没有标题、没有挂件形态、也没有锁定。
       */
      const panelRef = strOr(op.panel, '');
      if (panelRef) return updateDefaultWindow(op, panelRef);

      const id = strOr(op.id, '');
      const node = findComponent(id);
      if (!node) return fail('Component ' + id + ' does not exist.');
      const patch: Partial<ComponentNode> = {};
      const touched: string[] = [];

      if (typeof op.source === 'string' && op.source.trim()) {
        const compiled = compileComponent(id, op.source);
        if (!compiled.ok) {
          desktop().log('error', 'comp ' + node.name + ' \u2715 ' + compiled.error);
          return fail('The changed source failed to compile, so this edit was dropped: ' + compiled.error);
        }
        patch.source = op.source;
        touched.push('source');
        // 记下长度变化：用户能从日志看出这次是"整段重写"还是"定点修改"。
        desktop().log(
          'op',
          'comp ' + node.name + ' 源码整段替换 ' + node.source.length + ' → ' + op.source.length + ' 字符（能局部改就别整段换，见 patch_source）',
          id,
        );

        // 新源码真的从 "yggdrasil" 引入并调用了 useAgent，但组件还没有能力时，顺手接上 ——
        // 否则界面上的交互会静默失效。只提一句名字（注释）不触发。
        if (/from\s*['"]yggdrasil['"]/.test(op.source) && /\buseAgent\b/.test(op.source) && !node.agent) {
          useDesktopStore.getState().setFacet(id, makeFacet({ scope: [id] }));
          touched.push('auto-attached agent capability');
        }
      }
      if (typeof op.name === 'string' && op.name.trim()) {
        patch.name = op.name.trim();
        touched.push('title');
      }
      if (op.frame === 'window' || op.frame === 'widget') {
        patch.frame = op.frame;
        touched.push(op.frame === 'widget' ? 'switched to widget' : 'switched to a normal window');
      }
      if (typeof op.fixed === 'boolean') {
        patch.fixed = op.fixed;
        touched.push(op.fixed ? 'fixed' : 'unfixed');
      }
      if (typeof op.locked === 'boolean') {
        patch.locked = op.locked;
        touched.push(op.locked ? 'locked' : 'unlocked');
      }
      const pos = op.pos as { x?: unknown; y?: unknown } | undefined;
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
        patch.pos = { x: Math.round(pos.x), y: Math.round(pos.y) };
        touched.push('position');
      }
      const size = op.size as { w?: unknown; h?: unknown } | undefined;
      if (size) {
        patch.size = {
          w: clampNumber(size.w, node.size.w, 200, 1600),
          h: clampNumber(size.h, node.size.h, 140, 1200),
        };
        touched.push('size');
      }
      // ---- 几何：相对位移 / 缩放，以及"用视口算好的"居中 / 铺满 / 贴边 ----
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const dx = num(op.dx);
      const dy = num(op.dy);
      const dw = num(op.dw);
      const dh = num(op.dh);
      let rect: Rect | null = null;
      if (dx || dy || dw || dh) {
        rect = {
          x: (patch.pos?.x ?? node.pos.x) + dx,
          y: (patch.pos?.y ?? node.pos.y) + dy,
          w: (patch.size?.w ?? node.size.w) + dw,
          h: (patch.size?.h ?? node.size.h) + dh,
        };
        touched.push('relative adjust');
      }
      const viewW = desktop().viewW;
      const viewH = desktop().viewH;
      if (op.fill === true) {
        rect = fillRect(viewW, viewH);
        touched.push('filled');
      } else if (op.center === true) {
        rect = centerRect(rect ?? { ...node.pos, ...node.size }, viewW, viewH);
        touched.push('centred');
      } else if (typeof op.align === 'string' && op.align) {
        rect = alignRect(rect ?? { ...node.pos, ...node.size }, op.align, viewW, viewH);
        touched.push('aligned to edge');
      }
      if (rect) {
        const clamped = clampRect(rect, viewW, viewH);
        patch.pos = { x: clamped.x, y: clamped.y };
        patch.size = { w: clamped.w, h: clamped.h };
      }

      if (typeof op.status === 'string' && ['active', 'minimized', 'closed'].includes(op.status)) {
        patch.status = op.status as ComponentNode['status'];
        touched.push(op.status === 'active' ? 'shown' : op.status === 'minimized' ? 'minimised' : 'closed');
      }
      if (typeof op.z === 'number' && Number.isFinite(op.z)) {
        patch.z = Math.round(op.z);
        touched.push('layer');
      }
      const tokenPatch = sanitizeTokens(tokensOf(op.tokens));
      if (Object.keys(tokenPatch).length > 0) {
        patch.tokens = { ...(node.tokens ?? {}), ...tokenPatch };
        touched.push('local style');
      }
      if (op.tokens && Object.keys(tokenPatch).length === 0 && Object.keys(tokensOf(op.tokens)).length > 0) {
        return fail('No valid --ygg- variable in tokens.');
      }
      if (op.focus === true) touched.push('raised');
      if (touched.length === 0) {
        return fail(
          'update_component was given no field to change (source / name / pos / size / dx / dy / dw / dh / ' +
            'center / fill / align / focus / status / z / tokens).',
        );
      }
      useDesktopStore.getState().updateNode(id, patch as Partial<YggNode>);
      // 置顶走 store 的统一层级逻辑，比自己编一个 z 值可靠。
      if (op.focus === true) useDesktopStore.getState().bringToFront(id);
      desktop().log('op', '~ comp ' + node.name + ' [' + touched.join('+') + ']', id);
      const after = findComponent(id);
      const geo = after
        ? 'now pos=' + after.pos.x + ',' + after.pos.y + ' size=' + after.size.w + 'x' + after.size.h
        : '';
      return ok('Updated component "' + node.name + '": ' + touched.join(', '), {
        observation: 'Component id=' + id + ': ' + touched.join(', ') + ' updated. ' + geo,
      });
    },
  });

  registerInterface({
    kind: 'attach_agent',
    label: '接入 agent 能力',
    description:
      '**Attach agent capability** to an existing component (the interface does not change; it keeps its own source). You must give systemPrompt or tools, otherwise it is rejected; **do not use this by default** — see the "Agent capability" section for the criteria, tiers and capability switches.',
    example: {
      kind: 'attach_agent',
      id: 'n_xxx',
      systemPrompt: 'You answer weather questions',
      scope: ['self'],
    },
    mutates: true,
    cap: 'agents',
    handler: (op) => {
      const id = strOr(op.id, '');
      const node = desktop().nodes[id];
      if (!node || node.kind !== 'component' || node.root) {
        return fail('No component ' + id + ' to attach capability to (the base agent cannot take another).');
      }
      if (node.agent) {
        return fail('Component "' + node.name + '" already has agent capability. Use set_agent_config to change its role.');
      }
      // 没有职责也没有工具的空壳接入会让这个组件变成"没有用途的 Agent"，
      // 这正是"对派生 agent 太敏感"的另一种表现，直接拒绝并把默认做法说清楚。
      if (!hasAgentSubstance(op.systemPrompt, op.tools)) {
        return fail(
          'attach_agent needs either a role (systemPrompt) or tools for this component.' +
          'If you only want it to display content, a plain component is enough — do not attach agent capability.',
        );
      }
      const rawScope = op.scope;
      // 必须用 setFacet 而不是 updateFacet：后者只在 facet 已存在时才生效，
      // 而"接入能力"恰恰是给还没有 facet 的组件装上它。
      const attachMode = parseMode(op.mode);
      const attachScope = parseScope(rawScope, id);
      const attachCaps =
        attachMode === 'reply' ? undefined : parseCaps(op.caps) ?? DEFAULT_ACT_CAPS;
      const attachConflict = attachMode === 'reply' ? null : capScopeConflict(attachCaps, attachScope);
      if (attachConflict) return fail('Capability switches conflict with the scope: ' + attachConflict);
      useDesktopStore.getState().setFacet(id, makeFacet({
        systemPrompt: typeof op.systemPrompt === 'string' ? op.systemPrompt : '',
        toolIds: pickToolIds(op.tools),
        messages: [],
        ledger: [],
        scope: attachScope,
        progress: parseProgress(op.progress),
        mode: attachMode,
        caps: attachCaps,
      }));
      desktop().log('op', 'attach agent ' + node.name, id);
      return ok('Attached agent capability to "' + node.name + '"', {
        observation:
          'id=' + id + ' is now an agent (tier ' + attachMode + '). Its interface does not change (still its own source);' +
          'to render its context in the interface, use import { useAgent } from "yggdrasil" in the source.' +
          (attachMode === 'reply'
            ? 'reply tier: question and answer; the reply is appended to messages as an assistant message, so render a.messages to show it.'
            : 'act tier capability switches: ' + capSummary(attachCaps ?? []) +
              '. If they are not enough, add more with set_agent_config instead of calling attach_agent again.'),
      });
    },
  });

  registerInterface({
    kind: 'detach_agent',
    label: '移除 agent 能力',
    description:
      'Remove an agent capability from a component; it goes back to being a plain component (the interface does not change, the context and scope information is discarded).',
    example: { kind: 'detach_agent', id: 'n_xxx' },
    mutates: true,
    cap: 'agents',
    handler: (op) => {
      const id = strOr(op.id, '');
      const node = desktop().nodes[id];
      if (!node || node.kind !== 'component' || !node.agent) {
        return fail('Component ' + id + ' has no agent capability; nothing to remove.');
      }
      if (node.root) return fail('The base agent capability cannot be removed.');
      useDesktopStore.getState().updateNode(id, { agent: undefined } as Partial<YggNode>);
      desktop().log('op', 'detach agent ' + node.name, id);
      return ok('Removed agent capability from "' + node.name + '"; it is a plain component again');
    },
  });

  registerInterface({
    kind: 'remove_node',
    label: '删除节点',
    description: 'Delete a node, cascading to all of its children and derived tools.',
    example: { kind: 'remove_node', id: 'n_xxx' },
    mutates: true,
    cap: 'desktop',
    handler: (op) => {
      const id = strOr(op.id, '');
      if (RESERVED.has(id) || !desktop().nodes[id]) return fail('Node ' + id + ' does not exist or cannot be deleted.');
      const cascaded = desktop().cascadeIds(id);
      // 锁定 = 用户明确要保住这些东西。删除被拒，并说清怎么解。
      const lockedNames = cascaded
        .map((nid) => desktop().nodes[nid])
        .filter((n): n is ComponentNode => !!n && n.kind === 'component' && n.locked === true)
        .map((n) => '"' + n.name + '" (' + n.id + ')');
      if (lockedNames.length > 0) {
        return fail(
          lockedNames.join(', ') + ' are **locked** and cannot be deleted.' +
            'Locking is how the user protects their work; unlock it in the Nodes panel first (or ask the user to), and never work around it.',
        );
      }
      for (const cid of cascaded) unregisterTool(cid);
      useDesktopStore.getState().removeNode(id);
      desktop().log('op', '- ' + id);
      return ok(
        'Deleted node ' + id + (cascaded.length > 1 ? ' and ' + (cascaded.length - 1) + ' related nodes' : ''),
        { removedIds: cascaded, observation: 'Removed ' + cascaded.join(', ') },
      );
    },
  });

  registerInterface({
    kind: 'set_window_state',
    label: '窗口显隐',
    description:
      'Set a window state: active shows / minimized minimises / closed closes it (the node is kept and can be restored from the taskbar at the bottom left). Identified by name or id. **Default windows** (Nodes / Settings / Trace / input boxes) are targeted with `panel` (see the "Default windows" section): closed shuts the panel, minimized sends it to the taskbar, active reopens it.',
    example: { kind: 'set_window_state', name: 'Calculator', state: 'minimized' },
    mutates: true,
    cap: 'desktop',
    handler: (op) => {
      const state = strOr(op.state, '');
      if (!['active', 'minimized', 'closed'].includes(state)) {
        return fail('state accepts active / minimized / closed only.');
      }
      const panelRef = strOr(op.panel, '');
      if (panelRef) return setDefaultWindowState(panelRef, state as 'active' | 'minimized' | 'closed');
      const id = strOr(op.id, '');
      const name = strOr(op.name, '');
      const targets = Object.values(desktop().nodes).filter(
        (n) => n.kind === 'component' && !n.root,
      );
      const listText = targets.map((n) => n.name + '(' + n.id + ')').join(', ') || '(no components)';

      let node = id ? findComponent(id) : null;
      if (!node && name) {
        const matches = targets.filter((n) => n.name === name);
        if (matches.length === 1) node = matches[0] as ComponentNode;
        else if (matches.length > 1) {
          return fail(matches.length + ' components are all called "' + name + '"; use an id instead: ' +
            matches.map((n) => n.id).join(', '));
        }
      }
      if (!node) {
        if (id || name) return fail('No such window ' + (id || name) + '. Current components: ' + listText);
        return fail('set_window_state needs id or name. Current components: ' + listText);
      }
      useDesktopStore.getState().updateNode(node.id, { status: state as ComponentNode['status'] } as Partial<YggNode>);
      const label = state === 'active' ? 'shown' : state === 'minimized' ? 'minimised' : 'closed';
      desktop().log('op', label + ' ' + node.name, node.id);
      return ok('Window "' + node.name + '" is now ' + label + '.');
    },
  });

  registerInterface({
    kind: 'set_node_tokens',
    label: '覆写局部样式',
    description:
      'Override the local style variables of one node only, affecting that window and its contents, never the global theme. Good for requests like "make that calculator red".',
    example: { kind: 'set_node_tokens', id: 'n_xxx', tokens: { '--ygg-accent': '#FF3D7F' } },
    mutates: true,
    cap: 'style',
    handler: (op) => {
      const id = strOr(op.id, '');
      const node = desktop().nodes[id];
      if (!node) return fail('Node ' + id + ' does not exist.');
      const tokens = sanitizeTokens(tokensOf(op.tokens));
      if (Object.keys(tokens).length === 0) return fail('No valid --ygg- variable.');
      const merged = { ...(node.tokens ?? {}), ...tokens };
      useDesktopStore.getState().updateNode(id, { tokens: merged } as Partial<YggNode>);
      desktop().log('op', 'scope ' + id + ' \u00d7' + Object.keys(tokens).length, id);
      return ok('Overrode ' + Object.keys(tokens).length + ' local variables of "' + node.name + '"', {
        observation: Object.entries(tokens).map(([k, v]) => k + '=' + v).join(' '),
      });
    },
  });

  registerInterface({
    kind: 'list_nodes',
    label: '列出节点',
    description:
      'Find nodes by name or type and return id, type, position, status and whether an agent is attached. Lighter than inspect — good when you just need to know "what is that window id called".',
    example: { kind: 'list_nodes', query: 'calculator' },
    cap: 'desktop',
    handler: (op) => {
      const query = strOr(op.query, '').toLowerCase();
      const kind = strOr(op.type, '');
      let list = Object.values(desktop().nodes);
      if (kind) list = list.filter((n) => n.kind === kind);
      if (query) list = list.filter((n) => n.name.toLowerCase().includes(query));
      if (list.length === 0) return ok('No matching nodes', { observation: '(none)' });
      const text = list
        .map((n) => {
          const pos = n.pos ? ' pos=' + n.pos.x + ',' + n.pos.y : '';
          const size = n.size ? ' size=' + n.size.w + 'x' + n.size.h : '';
          const z = typeof n.z === 'number' ? ' z=' + n.z : '';
          const isAgent = n.kind === 'component' && !!n.agent;
          return (
            '- [' + n.kind + '] id=' + n.id + ' name="' + n.name + '" status=' + n.status + pos + size + z +
            (isAgent ? ' [agent]' : '')
          );
        })
        .join('\n');
      return ok('Matched ' + list.length + ' nodes', { observation: text });
    },
  });
}