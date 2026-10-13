import { registerInterface } from '../registry/interfaceRegistry';
import { embedMarkers } from '../workspace/embed';
import { fail, ok, strOr, tokensOf } from '../bus/opContext';
import { compileComponent, compileTool } from '../../host/compile';
import { defaultWindows, defaultWindowsText, desktop, useDesktopStore } from '../../store/desktopStore';
import { getTool, registerTool, toolCatalog } from '../registry/toolRegistry';
import { sanitizeTokens } from '../../theme/engine';
import {
  clearSurfaceSource,
  getSurfaceDef,
  getSurfaceState,
  isCriticalSurface,
  listSurfaces,
  setSurfaceSource,
  surfacesText,
} from '../registry/surfaceRegistry';
import { MAX_NODES, themeText, toolCatalogText, treeText } from '../agent/prompts';
import { capScopeConflict, capSummary, DEFAULT_ACT_CAPS, parseCaps } from '../agent/caps';
import { newNodeId } from '../ids';
import { isAgentNode } from '../types';
import type { ComponentNode, JsonSchema, YggNode } from '../types';

function asSchema(v: unknown): JsonSchema {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as JsonSchema;
  return { type: 'object', properties: {} };
}

/** 窗口快照：Agent 用它判断"现在屏幕上有什么"。 */
function windowsText(): string {
  const comps = Object.values(desktop().nodes).filter(
    (n): n is ComponentNode => n.kind === 'component' && !n.root,
  );
  if (comps.length === 0) return '(no windows)';
  return comps
    .map(
      (n) =>
        '- id=' + n.id + ' "' + n.name + '" status=' + n.status +
        ' pos=' + n.pos.x + ',' + n.pos.y + ' size=' + n.size.w + 'x' + n.size.h + ' z=' + n.z +
        (n.frame === 'widget' ? ' [widget' + (n.fixed ? ' / fixed' : '') + ']' : '') +
        (n.locked ? ' [locked]' : '') +
        (n.agent ? ' [agent]' : ''),
    )
    .join('\n');
}

/**
 * 一个 Agent 的完整现状：职责全文、工具子集、作用域、账本、最近消息。
 *
 * 为什么需要：组件出问题时，光有源码不够 —— 还要知道"它接收过什么、
 * 它做过什么"。账本记录的是跨刷新保留的"已做过的事"，消息记录的是它自己的对话。
 * 没有这个入口，调一个 Agent 组件就只能靠猜它记得什么。
 */
function agentDetailText(id: string): string {
  const node = desktop().nodes[id];
  if (!node || !isAgentNode(node)) return '(no such agent: ' + id + ')';
  const f = node.agent!;
  const lines: string[] = [];
  lines.push('- name: "' + node.name + '" id=' + id);
  lines.push('- host: ' + (node.root === true ? 'the base agent (default receiver of every message)' : 'attached to component ' + node.parentId));
  lines.push('- role (systemPrompt): ' + (f.systemPrompt || '(empty)'));
  lines.push('- tool subset: ' + (f.toolIds.length ? f.toolIds.join(', ') : 'all available tools'));
  lines.push('- scope: ' + (f.scope === '*' ? 'all nodes' : (f.scope as string[]).join(', ') || '(empty)'));

  lines.push('', 'Ledger (kept across reloads: "things already done"; ' + f.ledger.length + ' entries):');
  if (f.ledger.length === 0) lines.push('(empty)');
  else for (const e of f.ledger.slice(-30)) lines.push('- ' + e);

  // 运行状态：跑没跑、在做什么、排了几条、最近几步 —— 这是"进度"的查询口。
  const run = useDesktopStore.getState().runOf('agent:' + id);
  lines.push(
    '',
    'Run state: ' + (run.status.running ? 'running' : 'idle') +
      (run.status.phase ? '; phase: ' + run.status.phase : '') +
      (run.status.detail ? '; detail: ' + run.status.detail : '') +
      '; queued ' + run.queue.length,
  );
  lines.push('Progress display: ' + (f.progress === 'none' ? 'not merged into the Trace panel (the creator draws it in the component)' : 'merged into the Trace panel'));
  if (run.trace.length > 0) {
    lines.push('Recent steps (' + run.trace.length + ' total):');
    for (const s of run.trace.slice(-6)) {
      lines.push('  [' + s.status + '] ' + (s.round > 0 ? 'R' + s.round + ' ' : '') + s.label + ' — ' + (s.message || '').slice(0, 100));
    }
  }

  // 基底 Agent 的历史在**输入框会话**上（每个输入框一份），不在 facet 上。
  const baseSessions = node.root === true ? desktop().sessions : [];
  if (baseSessions.length > 0) {
    lines.push(
      '',
      'Conversation memory: **per input box** (the base agent does not share it); current input boxes: ' +
        baseSessions.map((s) => s.title + ': ' + s.messages.length + ' messages').join('; '),
    );
  }
  const own = baseSessions.length > 0 ? [] : f.messages;
  lines.push('', 'Recent messages (' + own.length + ' total; newest ' + Math.min(10, own.length) + '):');
  if (own.length === 0) lines.push(baseSessions.length > 0 ? '(the base agent history lives in each input box — see the counts above)' : '(empty)');
  else {
    for (const m of own.slice(-10)) {
      const text = m.content.length > 200 ? m.content.slice(0, 200) + '…' : m.content;
      lines.push('[' + m.role + '] ' + text + (m.images?.length ? ' (with ' + m.images.length + ' images)' : ''));
    }
  }
  return lines.join('\n');
}

/**
 * 一个工具的完整现状：说明、参数 schema、源码。
 *
 * 内置工具由宿主实现，没有可编辑的源码 —— 但必须**说清楚**，
 * 而不是让 Agent 对着一个列在目录里的 id 查不到东西。
 */
function toolDetailText(id: string): string {
  const tool = getTool(id);
  if (!tool) return '(tool ' + id + ' is no longer registered)';
  const lines: string[] = [];
  lines.push('- description: ' + (tool.description || '(none)'));
  lines.push('- type: ' + (tool.builtin ? 'builtin (host implementation)' : 'derived (written by an agent)'));
  lines.push('- params schema: ' + JSON.stringify(tool.paramsSchema ?? {}));
  const node = desktop().nodes[id];
  if (node) {
    lines.push('- belongs to: ' + node.parentId + (node.description ? '; note: ' + node.description : ''));
  }
  lines.push('');
  if (tool.source) {
    const clipped =
      tool.source.length > 30000
        ? tool.source.slice(0, 30000) + '\n... (source too long, truncated; ' + tool.source.length + ' chars in total)'
        : tool.source;
    lines.push('Source (this is what it actually runs right now):', clipped);
  } else {
    lines.push(
      'Source: **none** — this is a host builtin tool (' + id + ') and has no editable source.',
      'To change what it does, derive your own tool with create_tool (implement the algorithm in its source) and call it with call_tool.',
    );
  }
  return lines.join('\n');
}

/**
 * 一个插槽的完整现状：状态、可用 props、内置实现说明、以及**当前源码**。
 *
 * 这是"把背景换成 WebGL"这类请求的关键一环：
 * 插槽不是窗口，inspect before="component" 找不到它；
 * 而 list_surfaces 只给目录。没有这个入口，Agent 拿不到背景的现状，
 * 只能对着一个名字凭空写一份替换实现 —— 或者干脆放弃。
 */
function surfaceDetailText(def: ReturnType<typeof getSurfaceDef> & object): string {
  const lines: string[] = [];
  lines.push('- description: ' + def.description);
  lines.push('- state: ' + (getSurfaceState(def.id) ? 'overridden (written by an agent)' : 'uses the built-in implementation (host code, not agent source)'));
  if (def.propsHint) lines.push('- available props: ' + def.propsHint);
  lines.push('- critical slot: ' + (def.critical ? 'yes (do not replace)' : 'no'));
  if (def.capabilityHint) lines.push('- capability constraint: ' + def.capabilityHint);
  if (def.builtinHint) lines.push('- built-in implementation: ' + def.builtinHint);

  const cur = getSurfaceState(def.id)?.source;
  if (cur) {
    const clipped = cur.length > 30000 ? cur.slice(0, 30000) + '\n... (source too long, truncated; ' + cur.length + ' chars in total)' : cur;
    lines.push('', 'Current source (this is what it actually renders right now):', clipped);
    lines.push('', 'To change it, patch it with patch_source and the surface argument; to replace it entirely use replace_surface.');
  } else {
    lines.push(
      '',
      'Current source: **none** — it renders the host built-in implementation, which has no readable source.',
      'To use your own implementation: give a complete source with replace_surface; it then becomes "overridden",' +
        'after which inspect before="surface" can read the source and patch_source works on it.',
    );
  }
  return lines.join('\n');
}

/**
 * 应用日志。**组件运行时报错只在这里**（ErrorBoundary 会记一条 error），
 * 所以这是"修一个坏掉的组件"的第一步：先看日志里到底报了什么，
 * 再 inspect before="component" 看当前源码，最后用 patch_source 定点改。
 * 不给 Agent 看日志的话，它只能靠猜 —— 那就会变成"整段重写"。
 */
function logsText(): string {
  const logs = desktop().logs;
  if (logs.length === 0) return '(no logs)';
  // 只给最近一段：日志是排查线索，不是全文档案。
  return logs
    .slice(-40)
    .map((l) => {
      const when = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      const where = l.nodeId ? ' (' + l.nodeId + ')' : '';
      return '[' + when + '] ' + l.level + where + ' ' + l.text;
    })
    .join('\n');
}

function agentsText(): string {
  const agents = Object.values(desktop().nodes).filter(isAgentNode);
  if (agents.length === 0) return '(no agents)';
  return agents
    .map((a) => {
      const f = a.agent!;
      const where = a.root ? 'base' : 'its own component';
      const scopeText = f.scope === '*' ? 'all' : f.scope.join(', ') || '(empty)';
      return (
        '- id=' + a.id + ' "' + a.name + '" ' + where + '; messages ' + f.messages.length + ';' +
        ' ledger ' + f.ledger.length + ' entries; scope ' + scopeText +
        (f.systemPrompt ? '; role: ' + f.systemPrompt.slice(0, 60) : '')
      );
    })
    .join('\n');
}

/** 把一个节点的完整现状写成文本（"查看这个页面"）。 */
function nodeText(n: YggNode): string {
  const lines = [
    'id: ' + n.id,
    'kind: ' + n.kind,
    'name: ' + n.name,
    'status: ' + n.status,
    'pos: ' + (n.pos ? n.pos.x + ',' + n.pos.y : '(none)'),
    'size: ' + (n.size ? n.size.w + 'x' + n.size.h : '(none)'),
    'z: ' + (typeof n.z === 'number' ? n.z : '(none)'),
    n.parentId ? 'parentId: ' + n.parentId : 'parentId: (none)',
  ];
  const tokens = n.tokens ? Object.entries(n.tokens) : [];
  if (tokens.length > 0) lines.push('local style: ' + tokens.map(([k, v]) => k + '=' + v).join(' '));
  if (n.kind === 'component') {
    if (n.frame === 'widget') {
      lines.push('shape: widget (no title bar, transparent background, driven by buttons that appear on hover)' + (n.fixed ? ', **fixed**' : ''));
    }
    if (n.locked) lines.push('locked: **yes** (cannot be deleted; unlock first)');
    lines.push(
      n.agent
        ? 'agent capability: attached (role: ' + (n.agent.systemPrompt || '(empty)') + '; tools: ' +
          (n.agent.toolIds.join(', ') || 'all') + '; messages ' + n.agent.messages.length + ')'
        : 'agent capability: not attached',
    );
  }
  const src = (n.kind === 'component' || n.kind === 'tool') && n.source ? n.source : '';
  if (!src) return lines.join('\n');
  const clipped = src.length > 30000 ? src.slice(0, 30000) + '\n... (source too long, truncated; ' + src.length + ' chars in total)' : src;
  return lines.join('\n') + '\n\nSource:\n' + clipped;
}

export /**
 * 把工具返回值变成能回灌的文本。
 *
 * 三件事：
 * ① 能序列化就原样给（不再截断 —— 交给观察通道的隐藏协议与预算处理）；
 * ② 不能序列化（循环引用、BigInt、函数…）**说清是什么问题**，而不是静默变成 undefined；
 * ③ 二进制（ArrayBuffer / 类型化数组）**不能进文本上下文**，所以明确告诉模型
 *    "它是什么、多大、以及要走哪条路"（嵌入组件 / 写进工作区），而不是丢掉或印出一堆乱码。
 */
function stringifyToolResult(value: unknown): string {
  if (value === undefined) return "(工具没有返回值)";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  // 二进制：文本上下文里放不下它，如实说明并给出路
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const size = value instanceof ArrayBuffer ? value.byteLength : (value as ArrayBufferView).byteLength;
    return (
      "(工具返回了二进制数据，" + size + " 字节。" +
      "**字节进不了文本上下文** —— 要交付它就先写进工作区（让工具用 ws_run 的 ctx.workspace.write），" +
      "再在组件源码里用 @ws/名字 嵌入。)"
    );
  }
  try {
    const text = JSON.stringify(value, null, 1);
    return text === undefined ? String(value) : text;
  } catch (e) {
    return "(工具返回了无法序列化的值：" + (e as Error).message + " —— 请返回普通对象/数组/字符串。)";
  }
}
export function registerCoreInterfaces(): void {
  registerInterface({
    kind: 'create_tool',
    label: '派生工具',
    description:
      'Create a callable tool function. A tool cannot perform network requests (use fetch_url for that), but it can do pure computation and data transformation.',
    example: {
      kind: 'create_tool',
      name: 'sum',
      description: 'Sum',
      paramsSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
      source: 'export default function (args) { return args.a + args.b; }',
    },
    mutates: true,
    cap: 'tools',
    handler: (op, ctx) => {
      const name = strOr(op.name, 'unnamed_tool');
      const description = strOr(op.description, '');
      const source = typeof op.source === 'string' ? op.source : '';
      const id = newNodeId();
      const compiled = compileTool(id, source);
      if (!compiled.ok) {
        desktop().log('error', 'tool ' + name + ' \u2715 ' + compiled.error);
        return fail('Tool "' + name + '" failed to compile: ' + compiled.error);
      }
      const paramsSchema = asSchema(op.paramsSchema);
      registerTool({ id, name, description, paramsSchema, source, builtin: false, run: compiled.run });
      const store = useDesktopStore.getState();
      const node: YggNode = {
        id,
        parentId: typeof op.bindTo === 'string' && store.nodes[op.bindTo] ? op.bindTo : ctx.originId,
        kind: 'tool',
        name,
        description,
        status: 'active',
        paramsSchema,
        source,
        createdAt: Date.now(),
      };
      store.addNode(node);
      desktop().log('op', '+ tool ' + name, id);
      return ok('Derived tool "' + name + '"', {
        createdId: id,
        observation: 'Tool id=' + id + ' name=' + name + ' is registered; call it with call_tool.',
      });
    },
  });

  registerInterface({
    kind: 'call_tool',
    label: '调用工具',
    description:
      'Call an existing tool, by id or by name. The result is fed back to you in full (large payloads are replaced by a numbered placeholder you can read back), so you do not need to print it again yourself. Binary results cannot enter the text context — write them into the workspace and embed them in a component instead.',
    example: { kind: 'call_tool', name: 'sum', args: { a: 1, b: 2 } },
    cap: 'tools',
    handler: async (op) => {
      const id = strOr(op.id, '');
      const name = strOr(op.name, '');
      let tool = id ? getTool(id) : undefined;
      if (!tool && name) tool = toolCatalog().some((t) => t.name === name) ? getTool(toolCatalog().find((t) => t.name === name)?.id ?? '') : undefined;
      if (!tool) {
        const list = toolCatalog().map((t) => t.name + '(' + t.id + ')').join(', ') || '(no tools)';
        return fail('No such tool ' + (id || name) + '. Current tools: ' + list);
      }
      try {
        const value = await tool.run(op.args);
        /*
         * 结果要**完整**回灌给模型，而不是截到 400 字符。
         *
         * 这里原来是 message 截 400、observation 截 2000 —— 结果是：
         * 工具算出来的东西**只有一小截能被看见**，稍大一点（更别说二进制）就等于没有。
         * 一个"能跑但拿不到结果"的接口比没有更糟：模型会以为算完了，
         * 却看不到任何东西，然后开始瞎猜。
         *
         * 现在交给**观察通道**统一处理：那里有隐藏协议（超长载荷整块换成带序号的占位，
         * 可取回）与预算裁剪，比在各接口里各写一个 slice 更准也更一致。
         */
        const text = stringifyToolResult(value);
        desktop().log('op', 'tool ' + tool.name + ' \u2192 ' + text.slice(0, 160));
        return ok('Tool "' + tool.name + '" returned', { observation: text });
      } catch (e) {
        desktop().log('error', 'tool ' + tool.name + ' \u2715 ' + (e as Error).message);
        return fail('Tool "' + tool.name + '" failed while running: ' + (e as Error).message);
      }
    },
  });

  registerInterface({
    kind: 'update_theme',
    label: '改写样式',
    description:
      'Rewrite the global CSS variables. This is the only global styling operation: it creates no node and shows up nowhere in the interface, and it can be called again at any time to overwrite.',
    example: { kind: 'update_theme', tokens: { '--ygg-bg': '#07071A', '--ygg-accent': '#00E5FF' } },
    mutates: true,
    cap: 'global',
    handler: (op) => {
      const tokens = sanitizeTokens(tokensOf(op.tokens));
      const keys = Object.keys(tokens);
      if (keys.length === 0) return fail('The style operation contains no valid --ygg- variable.');
      useDesktopStore.getState().applyTokens({ ...desktop().tokens, ...tokens });
      desktop().log('op', 'tokens \u00d7' + keys.length);
      return ok('Rewrote ' + keys.length + ' style variables', { observation: 'Variables now in effect: ' + keys.join(', ') });
    },
  });

  registerInterface({
    kind: 'inspect',
    label: '查看界面结构',
    description:
      'Inspect the interface. before: windows (viewport + every window) / component id= (one page full state **and source**) / tool id= (tool source) / surface = (slot state, current source and built-in implementation) / agent id= (role text, ledger, recent messages) / logs (**runtime errors are recorded here**) / agents / tree / tokens / surfaces / tools / all.',
    example: { kind: 'inspect', before: 'component', id: 'n_xxx' },
    cap: 'desktop',
    handler: (op) => {
      const s = desktop();
      const part = strOr(op.before, 'all');
      const chunks: string[] = [];
      const viewport = '## Viewport\n' + s.viewW + ' x ' + s.viewH + ' (window coordinates start at the top-left)';
      if (part === 'all' || part === 'windows') {
        chunks.push(viewport);
        chunks.push('## Windows\n' + windowsText());
        // 默认窗口（Nodes / 设置 / Trace / 输入框）不是组件，但也能移动 / 缩放 / 显隐。
        chunks.push('## Default windows\n' + defaultWindowsText(defaultWindows(s)));
      }
      if (part === 'all' || part === 'agents') chunks.push('## Agent\n' + agentsText());
      if (part === 'all' || part === 'tree') chunks.push('## Node tree\n' + treeText(s.nodes, s.rootId));
      if (part === 'all' || part === 'tokens') chunks.push('## Style tokens\n' + themeText(s.tokens));
      if (part === 'all' || part === 'surfaces') chunks.push('## Surface slots\n' + surfacesText());
      if (part === 'all' || part === 'tools') chunks.push('## Tools\n' + toolCatalogText(toolCatalog()));
      if (part === 'all' || part === 'logs') chunks.push('## Logs\n' + logsText());
      if (part === 'agent') {
        const aid = strOr(op.id, '');
        const a = aid ? s.nodes[aid] : undefined;
        if (!aid || !a || !isAgentNode(a)) {
          const list = Object.values(s.nodes)
            .filter(isAgentNode)
            .map((n) => n.name + '(' + n.id + ')')
            .join('、');
          return fail('inspect before="agent" needs an id whose node has agent capability. Current agents: ' + (list || '(none)'));
        }
        chunks.push('## Agent ' + a.name + '\n' + agentDetailText(aid));
      }
      if (part === 'surface') {
        const sid = strOr(op.surface, '');
        const def = sid ? getSurfaceDef(sid) : undefined;
        if (!sid || !def) {
          return fail(
            'inspect before="surface" needs a surface. Available slots: ' +
              (listSurfaces().map((s) => s.id).join(', ') || '(none)'),
          );
        }
        chunks.push('## Slot ' + def.id + ' "' + def.label + '"\n' + surfaceDetailText(def));
      }
      if (part === 'tool') {
        const tid = strOr(op.id, '');
        /*
         * 从**工具注册表**查，而不是从节点树查：
         * 内置工具（builtin.calc 等）只有注册表条目、没有节点 ——
         * 从节点查会对着一份列着它们 id 的目录报"找不到"，这是纯粹的误导。
         */
        const tool = tid ? getTool(tid) : undefined;
        if (!tid || !tool) {
          const list = toolCatalog()
            .map((t) => t.name + '(' + t.id + ')')
            .join('、');
          return fail('inspect before="tool" needs the id of a registered tool. Current tools: ' + (list || '(no tools)'));
        }
        chunks.push('## Tool ' + tool.name + '\n' + toolDetailText(tid));
      }
      if (part === 'component') {
        const cid = strOr(op.id, '');
        const target = cid ? s.nodes[cid] : undefined;
        if (!target) {
          const list = Object.values(s.nodes)
            .filter((n) => n.kind === 'component' && !n.root)
            .map((n) => n.name + '(' + n.id + ')')
            .join('、');
          return fail('inspect before="component" needs an id. Current windows: ' + (list || '(no windows)'));
        }
        chunks.push(viewport);
        chunks.push('## Page ' + target.name + '\n' + nodeText(target));
      }
      if (chunks.length === 0) {
        return fail(
          'inspect before= accepts windows / component / tool / surface / agent / logs / agents / tree / tokens / surfaces / tools / all only.',
        );
      }
      if (part === 'all') {
        const total = Object.keys(s.nodes).length;
        chunks.unshift('Total nodes ' + total + ' / limit ' + MAX_NODES);
      }
      return ok('Read the interface structure (' + part + ')', { observation: chunks.join('\n\n') });
    },
  });


  /*
   * 定点修改已有源码。
   *
   * 为什么必须有这个接口：在此之前，改一行代码的唯一办法是**整段重新给一遍 source**。
   * 对模型来说那等于"重写" —— 它会把原本能用的一大半内容记错、丢掉或改掉，
   * 于是"修一个小问题"变成"破坏性重写"。有了 find/replace，
   * 改动量与风险都跟真实改动成正比。
   *
   * 两条硬约束：
   * 1. find 必须在当前源码里唯一命中（除非显式 all:true）—— 改错地方比不改更糟。
   * 2. 所有替换先全部做完再编译，**编译通过才写入**；失败则整体放弃、源码保持原样。
   */
  registerInterface({
    kind: 'patch_source',
    label: '局部修改源码',
    description:
      'Make a targeted replacement inside **existing source** (fix a bug / add a feature). Choose one target: `id` edits a component, `surface` edits a slot. edits = [{ find, replace, all? }]: find is copied **verbatim** from the current source and must match **exactly once** (otherwise lengthen the anchor, or pass all:true). **All replacements are done in memory and compiled before anything is written** — on failure the whole edit is dropped and the source is unchanged.',
    example: {
      kind: 'patch_source',
      id: 'n_xxx',
      edits: [{ find: 'const [v, setV] = React.useState("0")', replace: 'const [v, setV] = React.useState("")' }],
    },
    mutates: true,
    cap: 'desktop',
    handler: async (op) => {
      const id = strOr(op.id, '');
      const surface = strOr(op.surface, '');
      if (!id && !surface) return fail('patch_source needs either id (edit a component) or surface (edit a slot).');
      if (id && surface) return fail('Give only one of id and surface; inspect first if you are unsure which to edit.');

      const rawEdits = op.edits;
      if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
        return fail('edits must be a non-empty array of { find, replace, all? }.');
      }
      const edits: { find: string; replace: string; all: boolean }[] = [];
      for (const [i, item] of rawEdits.entries()) {
        const e = (item ?? {}) as Record<string, unknown>;
        if (typeof e.find !== 'string' || e.find === '') {
          return fail('edits[' + i + '].find must be a non-empty string.');
        }
        if (typeof e.replace !== 'string') {
          return fail('edits[' + i + '].replace must be a string (pass an empty string to delete).');
        }
        edits.push({ find: e.find, replace: e.replace, all: e.all === true });
      }

      // ---- 取当前源码 ----
      let current = '';
      let label = '';
      let key = '';
      let write: (next: string) => void;
      if (surface) {
        const def = getSurfaceDef(surface);
        if (!def) {
          const ids = listSurfaces().map((s) => s.id).join(', ');
          return fail('Slot ' + surface + ' does not exist. Available slots: ' + (ids || '(none)'));
        }
        const cur = getSurfaceState(surface)?.source;
        if (!cur) {
          return fail(
            'Slot ' + surface + ' is still the **built-in implementation** (host code, no readable source), so it cannot be patched.' +
              'First run `inspect before="surface" surface="' + surface + '"` to see its structure and the built-in description,' +
              'then give a **complete** implementation with replace_surface; it then becomes "overridden" and patchable with patch_source.',
          );
        }
        current = cur;
        label = 'slot "' + def.label + '"';
        key = 'surface_' + surface;
        write = (next) => setSurfaceSource(surface, next);
      } else {
        const node = desktop().nodes[id];
        if (!node || node.kind !== 'component' || node.root) {
          const list = Object.values(desktop().nodes)
            .filter((n) => n.kind === 'component' && !n.root)
            .map((n) => n.name + '(' + n.id + ')')
            .join('、');
          return fail('Component ' + id + ' does not exist. Current windows: ' + (list || '(no windows)'));
        }
        /*
         * 锁定的组件不允许改源码。
         *
         * 插件的自带界面就是**锁定**进来的：它是插件作者的代码，
         * 让 agent 悄悄改掉它，等于绕过了"插件代码只读"这条约定。
         * 用户仍然可以在 Nodes 面板里解锁（那时他就是有意的）。
         */
        if (node.locked === true) {
          return fail(
            '"' + node.name + '" is **locked**, so its source cannot be rewritten. Locked components are protected' +
              ' (plugin-shipped interfaces arrive locked). Ask the user to unlock it in the Nodes panel if the change is intended.',
          );
        }
        if (!node.source.trim()) return fail('Component "' + node.name + '" has no source, so there is nothing to replace.');
        current = node.source;
        label = 'component "' + node.name + '"';
        key = id;
        write = (next) => useDesktopStore.getState().updateNode(id, { source: next });
      }

      // ---- 逐个替换（在内存里累积） ----
      let next = current;
      const notes: string[] = [];
      for (const [i, e] of edits.entries()) {
        const hits = next.split(e.find).length - 1;
        if (hits === 0) {
          return fail(
            'edits[' + i + '] cannot find this text in the **current source** of ' + label + ', so the whole edit was dropped (source unchanged):\n' +
              '---\n' + e.find + '\n---\n' +
              'Use inspect before="component" id=... or list_surfaces to read the **current real source** first,' +
              'and write find as a verbatim fragment of it (never from memory, and never from how it looked before your last change).',
          );
        }
        if (hits > 1 && !e.all) {
          return fail(
            'edits[' + i + '].find occurs ' + hits + ' times in ' + label + ', so it is not unique and the whole edit was dropped (source unchanged):\n' +
              '---\n' + e.find + '\n---\n' +
              'Lengthen the anchor (include surrounding text so it is unique), or pass all: true to replace every occurrence.',
          );
        }
        next = e.all ? next.split(e.find).join(e.replace) : next.replace(e.find, e.replace);
        notes.push('#' + (i + 1) + ' x' + hits);
      }
      // 这次改动里可能引入 @ws/ 标记（例如把图片换成变量），统一在这里嵌入。
      const emb = await embedMarkers(next);
      if (emb.errors.length) return fail(emb.errors.join('\n'));
      next = emb.source;
      if (next === current) {
        return fail('The source is unchanged after the replacement — did you write find and replace identically?');
      }

      // ---- 先编译，通过才写入（原子） ----
      const compiled = compileComponent(key, next);
      if (!compiled.ok) {
        if (surface) desktop().log('error', 'surface ' + surface + ' \u2715 ' + compiled.error);
        else desktop().log('error', 'comp ' + label + ' \u2715 ' + compiled.error);
        return fail(
          'The changed source **failed to compile, so the whole edit was dropped — not one character of the original source changed**:' +
            compiled.error +
            '\nShrink the change (edit one place at a time), or confirm the current source with inspect first.',
        );
      }

      write(next);
      if (surface) desktop().log('op', 'patch surface ' + surface + ' (' + edits.length + ')');
      else desktop().log('op', 'patch ' + label + ' (' + edits.length + ')', id);

      return ok('Patched ' + label + ' (' + edits.length + ' edits)', {
        observation:
          'Changes: ' + notes.join('; ') +
          '. Source length ' + current.length + ' → ' + next.length +
          '. It compiled and is now in effect; if the interface still looks wrong, inspect before="logs" for runtime errors and keep patching in small steps.',
      });
    },
  });

  registerInterface({
    kind: 'list_surfaces',
    label: '查看界面插槽',
    description: 'List every replaceable slot on the interface, whether it is currently overridden, and the props each one accepts.',
    example: { kind: 'list_surfaces' },
    cap: 'global',
    handler: () => ok(listSurfaces().length + ' slots', { observation: surfacesText() }),
  });

  registerInterface({
    kind: 'replace_surface',
    label: '替换界面元素',
    description:
      'Overwrite a named interface slot with a piece of TSX, replacing that element look and behaviour. source null or empty restores the built-in implementation. **A critical slot (one carrying basic window abilities such as dragging) is rejected unless allowCritical=true is passed explicitly.**',
    example: {
      kind: 'replace_surface',
      surface: 'window.titlebar',
      source: 'export default function Titlebar({ title }){ ... }',
    },
    mutates: true,
    cap: 'global',
    handler: (op) => {
      const surface = strOr(op.surface, '');
      const def = listSurfaces().find((s) => s.id === surface);
      if (!def) {
        const ids = listSurfaces().map((s) => s.id).join(', ');
        return fail('Slot ' + surface + ' does not exist. Available slots: ' + (ids || '(none)'));
      }
      const raw = op.source;
      if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) {
        clearSurfaceSource(surface);
        desktop().log('op', 'surface reset ' + surface);
        return ok('Restored slot "' + def.label + '" to the built-in implementation');
      }
      if (typeof raw !== 'string') return fail('source must be a string or null.');

      // 关键插槽承载窗口基础能力（拖拽 / 最小化 / 删除）。
      // 替换它会把所有窗口的操作拆掉 —— 需要显式确认才放行。
      if (isCriticalSurface(surface) && op.allowCritical !== true) {
        return fail(
          'Slot ' + surface + ' is a **critical slot** carrying basic window abilities (' +
            (listSurfaces().find((s) => s.id === surface)?.capabilityHint ?? 'dragging and so on') +
            '). Replacing it would break the controls of every window, so it was rejected.' +
            'If you really want extra decoration, use a non-critical slot, or adjust the window itself with set_node_tokens / update_component.',
        );
      }

      const compiled = compileComponent('surface_' + surface, raw);
      if (!compiled.ok) {
        desktop().log('error', 'surface ' + surface + ' \u2715 ' + compiled.error);
        return fail('The replacement source for slot "' + def.label + '" failed to compile, so it was dropped: ' + compiled.error);
      }
      // 记下长度变化：用户能从日志看出这次是"整段重写"还是"定点修改"。
      const prevLen = getSurfaceState(surface)?.source?.length ?? 0;
      desktop().log(
        'op',
        'surface ' + surface + ' 源码整段替换 ' + prevLen + ' → ' + raw.length + ' 字符（能局部改就别整段换，见 patch_source）',
      );
      setSurfaceSource(surface, raw);
      desktop().log('op', 'surface ' + surface);
      return ok('Replaced interface element "' + def.label + '"', {
        observation:
          'Slot ' + surface + ' is now overridden.' + (def.propsHint ? ' Its component receives the props: ' + def.propsHint : ''),
      });
    },
  });

  registerInterface({
    kind: 'set_agent_config',
    label: '配置 Agent',
    description:
      'Change an agent name, role, scope, tool subset, or whether its progress is shown (progress: "trace" / "none"). Identified by id (an agent is a component with agent capability). This does not clear its conversation history.',
    example: { kind: 'set_agent_config', id: 'n_xxx', systemPrompt: 'You focus on data analysis' },
    cap: 'agents',
    handler: (op) => {
      const id = strOr(op.id, '');
      const all = Object.values(desktop().nodes);
      const agent = id ? all.find((n) => isAgentNode(n) && n.id === id) : undefined;
      if (!agent) {
        const list = all.filter(isAgentNode).map((n) => n.name + '(' + n.id + ')').join('、');
        return fail('No such agent ' + (id || '') + '. Current agents: ' + (list || '(none)'));
      }
      const touched: string[] = [];
      const nodePatch: Record<string, unknown> = {};
      const facetPatch: Record<string, unknown> = {};
      if (typeof op.name === 'string' && op.name.trim()) {
        nodePatch.name = op.name.trim();
        touched.push('name');
      }
      if (typeof op.systemPrompt === 'string') {
        facetPatch.systemPrompt = op.systemPrompt;
        touched.push('role');
      }
      if (Array.isArray(op.scope)) {
        facetPatch.scope = op.scope.filter((x): x is string => typeof x === 'string');
        touched.push('scope');
      }
      if (Array.isArray(op.tools)) {
        facetPatch.toolIds = op.tools.filter((x): x is string => typeof x === 'string');
        touched.push('tools');
      }
      if (op.progress === 'trace' || op.progress === 'none') {
        facetPatch.progress = op.progress;
        touched.push(op.progress === 'none' ? 'progress hidden' : 'progress shown');
      }
      if (op.mode === 'reply' || op.mode === 'act') {
        facetPatch.mode = op.mode;
        touched.push(op.mode === 'reply' ? 'tier=reply (talk only)' : 'tier=act (takes action)');
      }
      if (Array.isArray(op.caps)) {
        const next = parseCaps(op.caps) ?? DEFAULT_ACT_CAPS;
        // 没同时给 scope 就按它现有的作用域判（agent.kind 收窄后才能取 facet）。
        const curFacet = agent.kind === 'component' ? agent.agent : undefined;
        const nextScope = Array.isArray(op.scope)
          ? op.scope.filter((x): x is string => typeof x === 'string')
          : curFacet?.scope;
        const conflict = capScopeConflict(next, nextScope);
        if (conflict) return fail('Capability switches conflict with the scope: ' + conflict);
        facetPatch.caps = next;
        touched.push('capability switches=' + capSummary(next));
      }
      if (touched.length === 0) {
        return fail('set_agent_config needs one of name / systemPrompt / scope / tools / progress / mode / caps.');
      }
      const store = useDesktopStore.getState();
      if (Object.keys(nodePatch).length) store.updateNode(agent.id, nodePatch as Partial<YggNode>);
      if (Object.keys(facetPatch).length) store.updateFacet(agent.id, facetPatch);
      desktop().log('op', 'agent cfg ' + agent.name, agent.id);
      return ok('Updated agent "' + agent.name + '": ' + touched.join(', '));
    },
  });

  registerInterface({
    kind: 'clear_agent_context',
    label: '清空 Agent 上下文',
    description:
      'Clear an agent conversation history **and the shared ledger** (without clearing the ledger it still remembers the components it made). Identified by id. **The base agent conversation is per input box**: with id=root only **the current input box** history is cleared, other input boxes are untouched.',
    example: { kind: 'clear_agent_context', id: 'n_xxx' },
    cap: 'agents',
    handler: (op, ctx) => {
      const id = strOr(op.id, '');
      const all = Object.values(desktop().nodes);
      const found = id ? all.find((n) => n.id === id) : undefined;
      if (!found || found.kind !== 'component' || !found.agent) {
        return fail('No such agent ' + (id || '') + '.');
      }
      const facet = found.agent;
      const l = facet.ledger.length;
      const store = useDesktopStore.getState();
      // 基底：历史在会话上（只清当前这个输入框）；组件：历史在它自己的 facet 上。
      if (found.root === true) {
        const n = store.sessions.find((s) => s.id === ctx.sessionId)?.messages.length ?? 0;
        store.clearSessionMessages(ctx.sessionId);
        store.updateFacet(found.id, { ledger: [] });
        desktop().log('op', 'agent clear ' + found.name + ' @' + ctx.sessionId, found.id);
        return ok('Cleared ' + n + ' messages from the current input box, plus the shared ledger of ' + l + ' entries');
      }
      const n = facet.messages.length;
      store.updateFacet(found.id, { messages: [], ledger: [] });
      desktop().log('op', 'agent clear ' + found.name, found.id);
      return ok('Cleared "' + found.name + '": ' + n + ' messages and ' + l + ' ledger entries');
    },
  });
}