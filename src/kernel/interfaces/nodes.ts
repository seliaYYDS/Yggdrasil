import { registerInterface } from '../registry/interfaceRegistry';
import { clampNumber, fail, ok, strOr, tokensOf } from '../bus/opContext';
import { compileComponent } from '../../host/compile';
import { desktop, makeFacet, useDesktopStore } from '../../store/desktopStore';
import { unregisterTool } from '../registry/toolRegistry';
import { sanitizeTokens } from '../../theme/engine';
import type { ComponentNode, DerivationOp, YggNode } from '../types';
import { newNodeId } from '../ids';
import { alignRect, centerRect, clampRect, fillRect, type Rect } from './layout';

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
function createComponentNode(op: DerivationOp, ctx: { originId: string }) {
  const name = strOr(op.name, '组件');
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
      return fail('组件「' + name + '」编译失败：' + compiled.error);
    }
  }

  const size = (op.size ?? {}) as { w?: unknown; h?: unknown };

  // 显式给了 hostId 就必须存在；静默回退会把东西建到没指定的地方。
  const explicitHost = typeof op.hostId === 'string' && op.hostId.trim() ? op.hostId.trim() : null;
  if (explicitHost && !store.nodes[explicitHost]) {
    return fail('hostId "' + explicitHost + '" 不存在。可用的组件 id 见 inspect。');
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
    createdAt: Date.now(),
  };

  if (wantAgent) {
    // agent 只贡献"能力"：职责、工具子集、作用域、上下文。
    const rawScope = agentRaw?.scope !== undefined ? agentRaw.scope : op.scope;
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
      scope: parseScope(rawScope, id),
    });
  }

  store.addNode(node);
  store.focus(id);
  desktop().log('op', '+ comp ' + name, id);

  // 返回信息只说明"这个组件有没有 agent 能力"，不把它叫成另一种东西。
  const scopeText =
    node.agent && node.agent.scope !== '*' ? (node.agent.scope as string[]).join(', ') : '全部';
  const capNote = wantAgent
    ? '它已具备 agent 能力（作用域 ' + scopeText +
      (autoAttached ? '，检测到源码用了 useAgent 已自动接入' : '') +
      '），可在自己的界面里用 useAgent() 驱动它。'
    : '它目前是普通组件（默认如此）；只有当用户明确要求它自己思考、自己行动时，才用 attach_agent 接入 agent 能力（界面不变）。' +
      (ignoredAgent ? ' 你给的 agent 字段里没有职责也没有工具，已按空壳忽略。' : '');

  return ok('已创建组件「' + name + '」', {
    createdId: id,
    observation: '组件 id=' + id + ' name=' + name + ' 已插入桌面。' + capNote,
  });
}
/** 取工具 id 列表。 */
function pickToolIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string');
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
      '**新建一个页面/窗口**：生成一个界面组件插入桌面。' +
      '**这是默认也是唯一的创建入口**，绝大多数任务（计算器、列表、图表、看板、抓取结果展示）都到这里为止：' +
      '给一个 source，产出一个普通组件。pos / size 可选，不给就落在空位。' +
      'agent 字段是**可选的、默认不写**的重武器，只有用户明确要求"这个组件自己思考 / 自己行动 / 定时自主运行"时才附带；' +
      '判据见提示词「agent 能力」一节。',
    example: {
      kind: 'create_component',
      name: '计算器',
      description: '一个普通计算器',
      size: { w: 320, h: 420 },
      pos: { x: 200, y: 120 },
      source:
        'import * as React from "react";\n' +
        'export default function Calc(){ const [v, setV] = React.useState("0");\n' +
        '  return <div style={{ width: "100%", height: "100%", boxSizing: "border-box", overflow: "auto",' +
        ' background: "var(--ygg-surface)", color: "var(--ygg-fg)", border: "1px solid var(--ygg-border)",' +
        ' borderRadius: "var(--ygg-radius)" }}>{v}</div>; }',
    },
    mutates: true,
    handler: (op, ctx) => createComponentNode(op, ctx),
  });

  registerInterface({
    kind: 'update_component',
    label: '修改组件',
    description:
      '修改已有组件（这就是"调整窗口"）。未给出的字段不动。' +
      '换源码 source；改标题 name；显隐 status = active / minimized / closed；覆写局部样式 tokens；' +
      '层级 z 或 focus=true 置顶。' +
      '**几何**：绝对 `pos {x,y}` / `size {w,h}`；相对 `dx` `dy` `dw` `dh`；' +
      '或直接用视口算好的 `center=true`（居中）、`fill=true`（铺满）、`align`（left/right/top/bottom/center 贴边）。' +
      '所有几何结果都会夹进视口，不会跑到屏幕外。',
    example: { kind: 'update_component', id: 'n_xxx', dx: 120, dy: 0, focus: true },
    mutates: true,
    handler: (op) => {
      const id = strOr(op.id, '');
      const node = findComponent(id);
      if (!node) return fail('组件 ' + id + ' 不存在。');
      const patch: Partial<ComponentNode> = {};
      const touched: string[] = [];

      if (typeof op.source === 'string' && op.source.trim()) {
        const compiled = compileComponent(id, op.source);
        if (!compiled.ok) {
          desktop().log('error', 'comp ' + node.name + ' \u2715 ' + compiled.error);
          return fail('改动后的源码编译失败，已放弃本次修改：' + compiled.error);
        }
        patch.source = op.source;
        touched.push('源码');

        // 新源码真的从 "yggdrasil" 引入并调用了 useAgent，但组件还没有能力时，顺手接上 ——
        // 否则界面上的交互会静默失效。只提一句名字（注释）不触发。
        if (/from\s*['"]yggdrasil['"]/.test(op.source) && /\buseAgent\b/.test(op.source) && !node.agent) {
          useDesktopStore.getState().setFacet(id, makeFacet({ scope: [id] }));
          touched.push('自动接入 agent 能力');
        }
      }
      if (typeof op.name === 'string' && op.name.trim()) {
        patch.name = op.name.trim();
        touched.push('标题');
      }
      const pos = op.pos as { x?: unknown; y?: unknown } | undefined;
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
        patch.pos = { x: Math.round(pos.x), y: Math.round(pos.y) };
        touched.push('位置');
      }
      const size = op.size as { w?: unknown; h?: unknown } | undefined;
      if (size) {
        patch.size = {
          w: clampNumber(size.w, node.size.w, 200, 1600),
          h: clampNumber(size.h, node.size.h, 140, 1200),
        };
        touched.push('尺寸');
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
        touched.push('相对调整');
      }
      const viewW = desktop().viewW;
      const viewH = desktop().viewH;
      if (op.fill === true) {
        rect = fillRect(viewW, viewH);
        touched.push('铺满');
      } else if (op.center === true) {
        rect = centerRect(rect ?? { ...node.pos, ...node.size }, viewW, viewH);
        touched.push('居中');
      } else if (typeof op.align === 'string' && op.align) {
        rect = alignRect(rect ?? { ...node.pos, ...node.size }, op.align, viewW, viewH);
        touched.push('贴边');
      }
      if (rect) {
        const clamped = clampRect(rect, viewW, viewH);
        patch.pos = { x: clamped.x, y: clamped.y };
        patch.size = { w: clamped.w, h: clamped.h };
      }

      if (typeof op.status === 'string' && ['active', 'minimized', 'closed'].includes(op.status)) {
        patch.status = op.status as ComponentNode['status'];
        touched.push(op.status === 'active' ? '显示' : op.status === 'minimized' ? '最小化' : '关闭');
      }
      if (typeof op.z === 'number' && Number.isFinite(op.z)) {
        patch.z = Math.round(op.z);
        touched.push('层级');
      }
      const tokenPatch = sanitizeTokens(tokensOf(op.tokens));
      if (Object.keys(tokenPatch).length > 0) {
        patch.tokens = { ...(node.tokens ?? {}), ...tokenPatch };
        touched.push('局部样式');
      }
      if (op.tokens && Object.keys(tokenPatch).length === 0 && Object.keys(tokensOf(op.tokens)).length > 0) {
        return fail('tokens 里没有合法的 --ygg- 变量。');
      }
      if (op.focus === true) touched.push('置顶');
      if (touched.length === 0) {
        return fail(
          'update_component 没有给出任何要改的字段（source / name / pos / size / dx / dy / dw / dh / ' +
            'center / fill / align / focus / status / z / tokens）。',
        );
      }
      useDesktopStore.getState().updateNode(id, patch as Partial<YggNode>);
      // 置顶走 store 的统一层级逻辑，比自己编一个 z 值可靠。
      if (op.focus === true) useDesktopStore.getState().bringToFront(id);
      desktop().log('op', '~ comp ' + node.name + ' [' + touched.join('+') + ']', id);
      const after = findComponent(id);
      const geo = after
        ? '现在 pos=' + after.pos.x + ',' + after.pos.y + ' size=' + after.size.w + 'x' + after.size.h
        : '';
      return ok('已修改组件「' + node.name + '」：' + touched.join('、'), {
        observation: '组件 id=' + id + ' 的 ' + touched.join('、') + ' 已更新。' + geo,
      });
    },
  });

  registerInterface({
    kind: 'attach_agent',
    label: '接入 agent 能力',
    description:
      '给一个已存在的组件**接入 agent 能力**。接入后这个组件就有自己的上下文、职责与作用域，' +
      '可以自己思考并行动。' +
      '**界面不变** —— 组件长什么样完全由它自己的 source 决定；' +
      '要让它在界面上呈现消息或按钮，就在它的源码里用 import { useAgent } from "yggdrasil" 自行渲染。' +
      '这是"派生 Agent"的正解：Agent 是能力，不是另一种窗口。' +
      '**默认不要用**：用户没明确要求"它自己思考 / 自己行动 / 定时自主运行"时，普通组件就够了。' +
      '必须给出 systemPrompt（它的职责）或 tools，否则会被拒绝。',
    example: {
      kind: 'attach_agent',
      id: 'n_xxx',
      systemPrompt: '你负责回答天气问题',
      scope: ['self'],
    },
    mutates: true,
    handler: (op) => {
      const id = strOr(op.id, '');
      const node = desktop().nodes[id];
      if (!node || node.kind !== 'component' || node.root) {
        return fail('找不到可接入能力的组件 ' + id + '（基底不可再接入）。');
      }
      if (node.agent) {
        return fail('组件「' + node.name + '」已经具备 agent 能力了。改它的职责用 set_agent_config。');
      }
      // 没有职责也没有工具的空壳接入会让这个组件变成"没有用途的 Agent"，
      // 这正是"对派生 agent 太敏感"的另一种表现，直接拒绝并把默认做法说清楚。
      if (!hasAgentSubstance(op.systemPrompt, op.tools)) {
        return fail(
          'attach_agent 需要给出这个组件自己的职责（systemPrompt）或工具（tools）。' +
          '若你只是想让它把内容显示出来，普通组件就够了 —— 不要接入 agent 能力。',
        );
      }
      const rawScope = op.scope;
      // 必须用 setFacet 而不是 updateFacet：后者只在 facet 已存在时才生效，
      // 而"接入能力"恰恰是给还没有 facet 的组件装上它。
      useDesktopStore.getState().setFacet(id, makeFacet({
        systemPrompt: typeof op.systemPrompt === 'string' ? op.systemPrompt : '',
        toolIds: pickToolIds(op.tools),
        messages: [],
        ledger: [],
        scope: parseScope(rawScope, id),
      }));
      desktop().log('op', 'attach agent ' + node.name, id);
      return ok('已给「' + node.name + '」接入 agent 能力', {
        observation:
          'id=' + id + ' 现在是一个 Agent。它的界面不变（还是它自己的 source）；' +
          '要让它在界面上呈现上下文，在源码里用 import { useAgent } from "yggdrasil"。',
      });
    },
  });

  registerInterface({
    kind: 'detach_agent',
    label: '移除 agent 能力',
    description:
      '移除一个组件的 agent 能力，它会退回成普通组件（界面不变，上下文与作用域信息丢弃）。',
    example: { kind: 'detach_agent', id: 'n_xxx' },
    mutates: true,
    handler: (op) => {
      const id = strOr(op.id, '');
      const node = desktop().nodes[id];
      if (!node || node.kind !== 'component' || !node.agent) {
        return fail('组件 ' + id + ' 没有 agent 能力，无需移除。');
      }
      if (node.root) return fail('基底不可移除 agent 能力。');
      useDesktopStore.getState().updateNode(id, { agent: undefined } as Partial<YggNode>);
      desktop().log('op', 'detach agent ' + node.name, id);
      return ok('已移除「' + node.name + '」的 agent 能力，它现在是普通组件');
    },
  });

  registerInterface({
    kind: 'remove_node',
    label: '删除节点',
    description: '删除某个节点，会级联删除其全部子节点与派生工具。',
    example: { kind: 'remove_node', id: 'n_xxx' },
    mutates: true,
    handler: (op) => {
      const id = strOr(op.id, '');
      if (RESERVED.has(id) || !desktop().nodes[id]) return fail('节点 ' + id + ' 不存在或不可删除。');
      const cascaded = desktop().cascadeIds(id);
      for (const cid of cascaded) unregisterTool(cid);
      useDesktopStore.getState().removeNode(id);
      desktop().log('op', '- ' + id);
      return ok(
        '已删除节点 ' + id + (cascaded.length > 1 ? ' 及其 ' + (cascaded.length - 1) + ' 个关联节点' : ''),
        { removedIds: cascaded, observation: '已移除 ' + cascaded.join(', ') },
      );
    },
  });

  registerInterface({
    kind: 'set_window_state',
    label: '窗口显隐',
    description:
      '设置组件的窗口状态：active 显示 / minimized 最小化 / closed 关闭（保留节点，可从桌面左下任务栏恢复）。按名字或 id 指定。',
    example: { kind: 'set_window_state', name: '计算器', state: 'minimized' },
    mutates: true,
    handler: (op) => {
      const state = strOr(op.state, '');
      if (!['active', 'minimized', 'closed'].includes(state)) {
        return fail('state 只接受 active / minimized / closed。');
      }
      const id = strOr(op.id, '');
      const name = strOr(op.name, '');
      const targets = Object.values(desktop().nodes).filter(
        (n) => n.kind === 'component' && !n.root,
      );
      const listText = targets.map((n) => n.name + '(' + n.id + ')').join('、') || '（没有组件）';

      let node = id ? findComponent(id) : null;
      if (!node && name) {
        const matches = targets.filter((n) => n.name === name);
        if (matches.length === 1) node = matches[0] as ComponentNode;
        else if (matches.length > 1) {
          return fail('有 ' + matches.length + ' 个组件都叫「' + name + '」，请改用 id：' +
            matches.map((n) => n.id).join(', '));
        }
      }
      if (!node) {
        if (id || name) return fail('找不到窗口 ' + (id || name) + '。当前组件：' + listText);
        return fail('set_window_state 需要 id 或 name。当前组件：' + listText);
      }
      useDesktopStore.getState().updateNode(node.id, { status: state as ComponentNode['status'] } as Partial<YggNode>);
      const label = state === 'active' ? '显示' : state === 'minimized' ? '最小化' : '关闭';
      desktop().log('op', label + ' ' + node.name, node.id);
      return ok('已' + label + '窗口「' + node.name + '」');
    },
  });

  registerInterface({
    kind: 'set_node_tokens',
    label: '覆写局部样式',
    description:
      '只改写某一个节点的局部样式变量，影响该窗口及其内部元素，不动全局。适合"把那个计算器变红"这类要求。',
    example: { kind: 'set_node_tokens', id: 'n_xxx', tokens: { '--ygg-accent': '#FF3D7F' } },
    mutates: true,
    handler: (op) => {
      const id = strOr(op.id, '');
      const node = desktop().nodes[id];
      if (!node) return fail('节点 ' + id + ' 不存在。');
      const tokens = sanitizeTokens(tokensOf(op.tokens));
      if (Object.keys(tokens).length === 0) return fail('没有合法的 --ygg- 变量。');
      const merged = { ...(node.tokens ?? {}), ...tokens };
      useDesktopStore.getState().updateNode(id, { tokens: merged } as Partial<YggNode>);
      desktop().log('op', 'scope ' + id + ' \u00d7' + Object.keys(tokens).length, id);
      return ok('已覆写「' + node.name + '」的 ' + Object.keys(tokens).length + ' 个局部变量', {
        observation: Object.entries(tokens).map(([k, v]) => k + '=' + v).join(' '),
      });
    },
  });

  registerInterface({
    kind: 'list_nodes',
    label: '列出节点',
    description:
      '按名字或类型查找节点，返回 id、类型、位置、状态、是否挂了 Agent。比 inspect 更轻，适合只是想知道"那个窗口叫什么 id"。',
    example: { kind: 'list_nodes', query: '计算器' },
    handler: (op) => {
      const query = strOr(op.query, '').toLowerCase();
      const kind = strOr(op.type, '');
      let list = Object.values(desktop().nodes);
      if (kind) list = list.filter((n) => n.kind === kind);
      if (query) list = list.filter((n) => n.name.toLowerCase().includes(query));
      if (list.length === 0) return ok('没有匹配的节点', { observation: '（无）' });
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
      return ok('匹配 ' + list.length + ' 个节点', { observation: text });
    },
  });
}