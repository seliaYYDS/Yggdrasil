import { registerInterface } from '../registry/interfaceRegistry';
import { fail, ok, strOr, tokensOf } from '../bus/opContext';
import { compileComponent, compileTool } from '../../host/compile';
import { desktop, useDesktopStore } from '../../store/desktopStore';
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
  if (comps.length === 0) return '（没有窗口）';
  return comps
    .map(
      (n) =>
        '- id=' + n.id + ' 「' + n.name + '」 status=' + n.status +
        ' pos=' + n.pos.x + ',' + n.pos.y + ' size=' + n.size.w + 'x' + n.size.h + ' z=' + n.z +
        (n.frame === 'widget' ? ' [挂件' + (n.fixed ? '·已固定' : '') + ']' : '') +
        (n.locked ? ' [已锁定]' : '') +
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
  if (!node || !isAgentNode(node)) return '（' + id + ' 不是 Agent）';
  const f = node.agent!;
  const lines: string[] = [];
  lines.push('- 名称：「' + node.name + '」 id=' + id);
  lines.push('- 位置：' + (node.root === true ? '基底（所有消息的默认接收者）' : '挂在组件 ' + node.parentId + ' 上'));
  lines.push('- 职责（systemPrompt）：' + (f.systemPrompt || '（空）'));
  lines.push('- 工具子集：' + (f.toolIds.length ? f.toolIds.join(', ') : '全部可用工具'));
  lines.push('- 作用域：' + (f.scope === '*' ? '全部节点' : (f.scope as string[]).join(', ') || '（空）'));

  lines.push('', '账本（跨刷新保留，"已经做过的事"，共 ' + f.ledger.length + ' 条）：');
  if (f.ledger.length === 0) lines.push('（空）');
  else for (const e of f.ledger.slice(-30)) lines.push('- ' + e);

  // 运行状态：跑没跑、在做什么、排了几条、最近几步 —— 这是"进度"的查询口。
  const run = useDesktopStore.getState().runOf('agent:' + id);
  lines.push(
    '',
    '运行状态：' + (run.status.running ? '正在跑' : '空闲') +
      (run.status.phase ? '；当前阶段：' + run.status.phase : '') +
      (run.status.detail ? '；细节：' + run.status.detail : '') +
      '；排队 ' + run.queue.length + ' 条',
  );
  lines.push('进度显示：' + (f.progress === 'none' ? '不并进 Trace 面板（创建者自己画在组件界面里）' : '并进 Trace 面板'));
  if (run.trace.length > 0) {
    lines.push('最近步骤（共 ' + run.trace.length + ' 步）：');
    for (const s of run.trace.slice(-6)) {
      lines.push('  [' + s.status + '] ' + (s.round > 0 ? 'R' + s.round + ' ' : '') + s.label + ' — ' + (s.message || '').slice(0, 100));
    }
  }

  lines.push('', '最近消息（共 ' + f.messages.length + ' 条，只列最近 ' + Math.min(10, f.messages.length) + ' 条）：');
  if (f.messages.length === 0) lines.push('（空）');
  else {
    for (const m of f.messages.slice(-10)) {
      const text = m.content.length > 200 ? m.content.slice(0, 200) + '…' : m.content;
      lines.push('[' + m.role + '] ' + text + (m.images?.length ? '（含 ' + m.images.length + ' 张图片）' : ''));
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
  if (!tool) return '（工具 ' + id + ' 已不在注册表里）';
  const lines: string[] = [];
  lines.push('- 说明：' + (tool.description || '（无）'));
  lines.push('- 类型：' + (tool.builtin ? '内置（宿主实现）' : '派生（Agent 写的）'));
  lines.push('- 参数 schema：' + JSON.stringify(tool.paramsSchema ?? {}));
  const node = desktop().nodes[id];
  if (node) {
    lines.push('- 所属：挂在 ' + node.parentId + ' 下' + (node.description ? '；备注：' + node.description : ''));
  }
  lines.push('');
  if (tool.source) {
    const clipped =
      tool.source.length > 30000
        ? tool.source.slice(0, 30000) + '\n…（源码过长已截断，共 ' + tool.source.length + ' 字符）'
        : tool.source;
    lines.push('源码（这就是它现在真实执行的东西）：', clipped);
  } else {
    lines.push(
      '源码：**没有** —— 这是宿主内置的工具（' + id + '），没有可编辑的源码。',
      '要改它的行为：用 create_tool 派生一个自己的工具（在源码里实现你要的算法），再用 call_tool 调它。',
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
  lines.push('- 说明：' + def.description);
  lines.push('- 状态：' + (getSurfaceState(def.id) ? '已被覆写（Agent 写的）' : '使用内置实现（宿主内置，非 Agent 源码）'));
  if (def.propsHint) lines.push('- 可用 props：' + def.propsHint);
  lines.push('- 关键插槽：' + (def.critical ? '是（不要替换）' : '否'));
  if (def.capabilityHint) lines.push('- 能力约束：' + def.capabilityHint);
  if (def.builtinHint) lines.push('- 内置实现：' + def.builtinHint);

  const cur = getSurfaceState(def.id)?.source;
  if (cur) {
    const clipped = cur.length > 30000 ? cur.slice(0, 30000) + '\n…（源码过长已截断，共 ' + cur.length + ' 字符）' : cur;
    lines.push('', '当前源码（这就是它现在真实渲染的东西）：', clipped);
    lines.push('', '要改它就用 patch_source 的 surface 参数定点改；要整体换掉用 replace_surface。');
  } else {
    lines.push(
      '',
      '当前源码：**没有** —— 它现在渲染的是宿主内置实现，没有可读的源码。',
      '要换成你自己的实现：用 replace_surface 给一份完整 source；之后它就变成"已被覆写"，' +
        '再用 inspect before="surface" 就能读到源码，也就能用 patch_source 定点改了。',
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
  if (logs.length === 0) return '（没有日志）';
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
  if (agents.length === 0) return '（没有 Agent）';
  return agents
    .map((a) => {
      const f = a.agent!;
      const where = a.root ? '基底' : '自身组件';
      const scopeText = f.scope === '*' ? '全部' : f.scope.join(', ') || '（空）';
      return (
        '- id=' + a.id + ' 「' + a.name + '」 ' + where + '；消息 ' + f.messages.length + ' 条；' +
        '做过 ' + f.ledger.length + ' 件事；作用域 ' + scopeText +
        (f.systemPrompt ? '；职责：' + f.systemPrompt.slice(0, 60) : '')
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
    'pos: ' + (n.pos ? n.pos.x + ',' + n.pos.y : '（无）'),
    'size: ' + (n.size ? n.size.w + 'x' + n.size.h : '（无）'),
    'z: ' + (typeof n.z === 'number' ? n.z : '（无）'),
    n.parentId ? 'parentId: ' + n.parentId : 'parentId: （无）',
  ];
  const tokens = n.tokens ? Object.entries(n.tokens) : [];
  if (tokens.length > 0) lines.push('局部样式: ' + tokens.map(([k, v]) => k + '=' + v).join(' '));
  if (n.kind === 'component') {
    if (n.frame === 'widget') {
      lines.push('窗口形态: 挂件（无标题栏、透明背景、靠 hover 出来的按钮操控）' + (n.fixed ? '，**已固定**' : ''));
    }
    if (n.locked) lines.push('锁定: **是**（不可删除，要删先解锁）');
    lines.push(
      n.agent
        ? 'agent 能力: 已接入（职责：' + (n.agent.systemPrompt || '（空）') + '；工具：' +
          (n.agent.toolIds.join(', ') || '全部') + '；消息 ' + n.agent.messages.length + ' 条）'
        : 'agent 能力: 未接入',
    );
  }
  const src = (n.kind === 'component' || n.kind === 'tool') && n.source ? n.source : '';
  if (!src) return lines.join('\n');
  const clipped = src.length > 30000 ? src.slice(0, 30000) + '\n…（源码过长已截断，共 ' + src.length + ' 字符）' : src;
  return lines.join('\n') + '\n\n源码：\n' + clipped;
}

export function registerCoreInterfaces(): void {
  registerInterface({
    kind: 'create_tool',
    label: '派生工具',
    description:
      '生成一个可被调用的工具函数。工具里不能发起网络请求（用 fetch_url 接口），但可以做纯计算与数据转换。',
    example: {
      kind: 'create_tool',
      name: 'sum',
      description: '求和',
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
        return fail('工具「' + name + '」编译失败：' + compiled.error);
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
      return ok('已派生工具「' + name + '」', {
        createdId: id,
        observation: '工具 id=' + id + ' name=' + name + ' 已注册，可用 call_tool 调用。',
      });
    },
  });

  registerInterface({
    kind: 'call_tool',
    label: '调用工具',
    description: '调用一个已有工具。用 id，或者用 name 按名字找。',
    example: { kind: 'call_tool', name: 'sum', args: { a: 1, b: 2 } },
    cap: 'tools',
    handler: async (op) => {
      const id = strOr(op.id, '');
      const name = strOr(op.name, '');
      let tool = id ? getTool(id) : undefined;
      if (!tool && name) tool = toolCatalog().some((t) => t.name === name) ? getTool(toolCatalog().find((t) => t.name === name)?.id ?? '') : undefined;
      if (!tool) {
        const list = toolCatalog().map((t) => t.name + '(' + t.id + ')').join('、') || '（没有工具）';
        return fail('找不到工具 ' + (id || name) + '。当前工具：' + list);
      }
      try {
        const value = await tool.run(op.args);
        const text = JSON.stringify(value) ?? 'undefined';
        desktop().log('op', 'tool ' + tool.name + ' \u2192 ' + text.slice(0, 160));
        return ok('工具「' + tool.name + '」返回：' + text.slice(0, 400), { observation: text.slice(0, 2000) });
      } catch (e) {
        desktop().log('error', 'tool ' + tool.name + ' \u2715 ' + (e as Error).message);
        return fail('工具「' + tool.name + '」执行失败：' + (e as Error).message);
      }
    },
  });

  registerInterface({
    kind: 'update_theme',
    label: '改写样式',
    description:
      '改写全局 CSS 变量。这是唯一的全局样式接口：不产生节点、不出现在任何界面上，随时可再次调用覆盖。',
    example: { kind: 'update_theme', tokens: { '--ygg-bg': '#07071A', '--ygg-accent': '#00E5FF' } },
    mutates: true,
    cap: 'global',
    handler: (op) => {
      const tokens = sanitizeTokens(tokensOf(op.tokens));
      const keys = Object.keys(tokens);
      if (keys.length === 0) return fail('样式指令里没有合法的 --ygg- 变量。');
      useDesktopStore.getState().applyTokens({ ...desktop().tokens, ...tokens });
      desktop().log('op', 'tokens \u00d7' + keys.length);
      return ok('已改写 ' + keys.length + ' 个样式变量', { observation: '已生效变量：' + keys.join(', ') });
    },
  });

  registerInterface({
    kind: 'inspect',
    label: '查看界面结构',
    description:
      '查看当前界面结构（"看看页面上现在有什么"）。before 可选：' +
      'windows（视口 + 全部窗口）/ component（**某一个页面的完整现状与源码**，需同时给 id）/ ' +
      'tool（**某一个工具的源码**，需同时给 id）/ ' +
      'agent（**某一个 Agent 的职责全文、账本与最近消息**，需同时给 id）/ ' +
      'surface（**某一个插槽的当前源码与内置实现说明**，需同时给 surface）/ ' +
      'logs（**应用日志，组件运行时报错就在这里**）/ agents / tree / tokens / surfaces / tools / all。',
    example: { kind: 'inspect', before: 'component', id: 'n_xxx' },
    cap: 'desktop',
    handler: (op) => {
      const s = desktop();
      const part = strOr(op.before, 'all');
      const chunks: string[] = [];
      const viewport = '## 视口\n' + s.viewW + ' x ' + s.viewH + '（窗口坐标原点在左上角）';
      if (part === 'all' || part === 'windows') {
        chunks.push(viewport);
        chunks.push('## 窗口\n' + windowsText());
      }
      if (part === 'all' || part === 'agents') chunks.push('## Agent\n' + agentsText());
      if (part === 'all' || part === 'tree') chunks.push('## 节点树\n' + treeText(s.nodes, s.rootId));
      if (part === 'all' || part === 'tokens') chunks.push('## 样式变量\n' + themeText(s.tokens));
      if (part === 'all' || part === 'surfaces') chunks.push('## 界面插槽\n' + surfacesText());
      if (part === 'all' || part === 'tools') chunks.push('## 工具\n' + toolCatalogText(toolCatalog()));
      if (part === 'all' || part === 'logs') chunks.push('## 日志\n' + logsText());
      if (part === 'agent') {
        const aid = strOr(op.id, '');
        const a = aid ? s.nodes[aid] : undefined;
        if (!aid || !a || !isAgentNode(a)) {
          const list = Object.values(s.nodes)
            .filter(isAgentNode)
            .map((n) => n.name + '(' + n.id + ')')
            .join('、');
          return fail('inspect before="agent" 需要 id，且该节点要具备 agent 能力。当前 Agent：' + (list || '（没有）'));
        }
        chunks.push('## Agent ' + a.name + '\n' + agentDetailText(aid));
      }
      if (part === 'surface') {
        const sid = strOr(op.surface, '');
        const def = sid ? getSurfaceDef(sid) : undefined;
        if (!sid || !def) {
          return fail(
            'inspect before="surface" 需要 surface。可用插槽：' +
              (listSurfaces().map((s) => s.id).join('、') || '（无）'),
          );
        }
        chunks.push('## 插槽 ' + def.id + '「' + def.label + '」\n' + surfaceDetailText(def));
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
          return fail('inspect before="tool" 需要 id，且该 id 必须是已注册的工具。当前工具：' + (list || '（没有工具）'));
        }
        chunks.push('## 工具 ' + tool.name + '\n' + toolDetailText(tid));
      }
      if (part === 'component') {
        const cid = strOr(op.id, '');
        const target = cid ? s.nodes[cid] : undefined;
        if (!target) {
          const list = Object.values(s.nodes)
            .filter((n) => n.kind === 'component' && !n.root)
            .map((n) => n.name + '(' + n.id + ')')
            .join('、');
          return fail('inspect before="component" 需要 id。当前窗口：' + (list || '（没有窗口）'));
        }
        chunks.push(viewport);
        chunks.push('## 页面 ' + target.name + '\n' + nodeText(target));
      }
      if (chunks.length === 0) {
        return fail(
          'inspect 的 before 只接受 windows / component / tool / surface / agent / logs / agents / tree / tokens / surfaces / tools / all。',
        );
      }
      if (part === 'all') {
        const total = Object.keys(s.nodes).length;
        chunks.unshift('节点总数 ' + total + ' / 上限 ' + MAX_NODES);
      }
      return ok('已读取界面结构（' + part + '）', { observation: chunks.join('\n\n') });
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
      '在**已有源码**里做定点替换（修 bug / 加一小块功能）。' +
      '目标二选一：给 `id` 改组件源码；给 `surface` 改插槽源码。' +
      'edits 是 [{ find, replace, all? }]：find 必须**原样**来自当前源码且**唯一命中**；' +
      '不唯一时把锚点写长一点（带上前后文），或传 all:true 表示全部替换。' +
      '多个 edit 顺序生效。**全部替换先在内存里做完再编译，编译通过才写入** —— ' +
      '失败就整体放弃，源码一个字都不会变。' +
      '**修自己之前做的东西就用它**：不要用 create_component 重建，也不要整段重写 source。',
    example: {
      kind: 'patch_source',
      id: 'n_xxx',
      edits: [{ find: 'const [v, setV] = React.useState("0")', replace: 'const [v, setV] = React.useState("")' }],
    },
    mutates: true,
    cap: 'desktop',
    handler: (op) => {
      const id = strOr(op.id, '');
      const surface = strOr(op.surface, '');
      if (!id && !surface) return fail('patch_source 需要 id（改组件）或 surface（改插槽）其中之一。');
      if (id && surface) return fail('id 与 surface 只能给一个：不确定改哪个就先 inspect。');

      const rawEdits = op.edits;
      if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
        return fail('edits 必须是非空数组，每项形如 { find, replace, all? }。');
      }
      const edits: { find: string; replace: string; all: boolean }[] = [];
      for (const [i, item] of rawEdits.entries()) {
        const e = (item ?? {}) as Record<string, unknown>;
        if (typeof e.find !== 'string' || e.find === '') {
          return fail('edits[' + i + '].find 必须是非空字符串。');
        }
        if (typeof e.replace !== 'string') {
          return fail('edits[' + i + '].replace 必须是字符串（删掉就传空串）。');
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
          return fail('插槽 ' + surface + ' 不存在。可用插槽：' + (ids || '（无）'));
        }
        const cur = getSurfaceState(surface)?.source;
        if (!cur) {
          return fail(
            '插槽 ' + surface + ' 目前还是**内置实现**（宿主内置，没有可读的源码），不能 patch。' +
              '先 `inspect before="surface" surface="' + surface + '"` 看它现在的结构与内置实现说明，' +
              '再用 replace_surface 给一份**完整**实现；之后它就是"已被覆写"，也就能用 patch_source 定点改了。',
          );
        }
        current = cur;
        label = '插槽「' + def.label + '」';
        key = 'surface_' + surface;
        write = (next) => setSurfaceSource(surface, next);
      } else {
        const node = desktop().nodes[id];
        if (!node || node.kind !== 'component' || node.root) {
          const list = Object.values(desktop().nodes)
            .filter((n) => n.kind === 'component' && !n.root)
            .map((n) => n.name + '(' + n.id + ')')
            .join('、');
          return fail('组件 ' + id + ' 不存在。当前窗口：' + (list || '（没有窗口）'));
        }
        if (!node.source.trim()) return fail('组件「' + node.name + '」目前没有源码，没有可替换的内容。');
        current = node.source;
        label = '组件「' + node.name + '」';
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
            'edits[' + i + '] 在' + label + '的**当前源码**里找不到这段内容，本次修改已整体放弃（源码未变）：\n' +
              '---\n' + e.find + '\n---\n' +
              '请先用 inspect before="component" id=... 或 list_surfaces 看**当前真实源码**，' +
              '把 find 写成源码里原样的一段（不要凭记忆写，也不要凭上一轮改之前的样子写）。',
          );
        }
        if (hits > 1 && !e.all) {
          return fail(
            'edits[' + i + '] 在' + label + '里出现了 ' + hits + ' 次，不唯一，本次修改已整体放弃（源码未变）：\n' +
              '---\n' + e.find + '\n---\n' +
              '请把锚点写长一点（带上前后文让它唯一），或者传 all: true 明确表示全部替换。',
          );
        }
        next = e.all ? next.split(e.find).join(e.replace) : next.replace(e.find, e.replace);
        notes.push('第 ' + (i + 1) + ' 处 ×' + hits);
      }
      if (next === current) {
        return fail('替换之后源码没有任何变化：find 与 replace 是不是写成一样了？');
      }

      // ---- 先编译，通过才写入（原子） ----
      const compiled = compileComponent(key, next);
      if (!compiled.ok) {
        if (surface) desktop().log('error', 'surface ' + surface + ' \u2715 ' + compiled.error);
        else desktop().log('error', 'comp ' + label + ' \u2715 ' + compiled.error);
        return fail(
          '改动后的源码**编译失败，本次修改已整体放弃 —— 原源码一个字都没变**：' +
            compiled.error +
            '\n请缩小改动范围（一次只改一个地方），或者先用 inspect 确认当前源码。',
        );
      }

      write(next);
      if (surface) desktop().log('op', 'patch surface ' + surface + ' (' + edits.length + ' 处)');
      else desktop().log('op', 'patch ' + label + ' (' + edits.length + ' 处)', id);

      return ok('已局部修改' + label + '（' + edits.length + ' 处）', {
        observation:
          '改动明细：' + notes.join('；') +
          '。源码长度 ' + current.length + ' → ' + next.length +
          '。改动已通过编译并生效；如果界面上的表现还不对，先 inspect before="logs" 看运行时报错，再继续用 patch_source 小步修改。',
      });
    },
  });

  registerInterface({
    kind: 'list_surfaces',
    label: '查看界面插槽',
    description: '列出界面上所有可被替换的插槽、它们当前是否已被覆写，以及各自的可用 props。',
    example: { kind: 'list_surfaces' },
    cap: 'global',
    handler: () => ok('共 ' + listSurfaces().length + ' 个插槽', { observation: surfacesText() }),
  });

  registerInterface({
    kind: 'replace_surface',
    label: '替换界面元素',
    description:
      '用一段 TSX 覆写界面上指定的插槽，替换该元素的外观与行为。source 为 null 或空字符串时还原成内置实现。' +
      '**关键插槽（承载窗口拖拽等基础能力）会被拒绝，除非显式传 allowCritical=true。**',
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
        return fail('插槽 ' + surface + ' 不存在。可用插槽：' + (ids || '（无）'));
      }
      const raw = op.source;
      if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) {
        clearSurfaceSource(surface);
        desktop().log('op', 'surface reset ' + surface);
        return ok('已还原插槽「' + def.label + '」为内置实现');
      }
      if (typeof raw !== 'string') return fail('source 必须是字符串或 null。');

      // 关键插槽承载窗口基础能力（拖拽 / 最小化 / 删除）。
      // 替换它会把所有窗口的操作拆掉 —— 需要显式确认才放行。
      if (isCriticalSurface(surface) && op.allowCritical !== true) {
        return fail(
          '插槽 ' + surface + ' 是**关键插槽**，承载窗口的基础能力（' +
            (listSurfaces().find((s) => s.id === surface)?.capabilityHint ?? '拖拽等') +
            '）。替换它会破坏所有窗口的操作，已拒绝。' +
            '如果你确实要点额外装饰，请改用非关键插槽，或先用 set_node_tokens / update_component 调整窗口本身。',
        );
      }

      const compiled = compileComponent('surface_' + surface, raw);
      if (!compiled.ok) {
        desktop().log('error', 'surface ' + surface + ' \u2715 ' + compiled.error);
        return fail('插槽「' + def.label + '」的替换源码编译失败，已放弃：' + compiled.error);
      }
      // 记下长度变化：用户能从日志看出这次是"整段重写"还是"定点修改"。
      const prevLen = getSurfaceState(surface)?.source?.length ?? 0;
      desktop().log(
        'op',
        'surface ' + surface + ' 源码整段替换 ' + prevLen + ' → ' + raw.length + ' 字符（能局部改就别整段换，见 patch_source）',
      );
      setSurfaceSource(surface, raw);
      desktop().log('op', 'surface ' + surface);
      return ok('已替换界面元素「' + def.label + '」', {
        observation:
          '插槽 ' + surface + ' 已被覆写。' + (def.propsHint ? ' 该插槽组件会收到 props：' + def.propsHint : ''),
      });
    },
  });

  registerInterface({
    kind: 'set_agent_config',
    label: '配置 Agent',
    description:
      '修改某个 Agent 的名字、职责、作用域、工具子集，或它的进度显不显示（progress: "trace" / "none"）。' +
      '用 id 指定（Agent 就是带 agent 能力的组件）。这不会清空它的对话历史。',
    example: { kind: 'set_agent_config', id: 'n_xxx', systemPrompt: '你专注于数据分析' },
    cap: 'agents',
    handler: (op) => {
      const id = strOr(op.id, '');
      const all = Object.values(desktop().nodes);
      const agent = id ? all.find((n) => isAgentNode(n) && n.id === id) : undefined;
      if (!agent) {
        const list = all.filter(isAgentNode).map((n) => n.name + '(' + n.id + ')').join('、');
        return fail('找不到 Agent ' + (id || '') + '。当前 Agent：' + (list || '（无）'));
      }
      const touched: string[] = [];
      const nodePatch: Record<string, unknown> = {};
      const facetPatch: Record<string, unknown> = {};
      if (typeof op.name === 'string' && op.name.trim()) {
        nodePatch.name = op.name.trim();
        touched.push('名字');
      }
      if (typeof op.systemPrompt === 'string') {
        facetPatch.systemPrompt = op.systemPrompt;
        touched.push('职责');
      }
      if (Array.isArray(op.scope)) {
        facetPatch.scope = op.scope.filter((x): x is string => typeof x === 'string');
        touched.push('作用域');
      }
      if (Array.isArray(op.tools)) {
        facetPatch.toolIds = op.tools.filter((x): x is string => typeof x === 'string');
        touched.push('工具');
      }
      if (op.progress === 'trace' || op.progress === 'none') {
        facetPatch.progress = op.progress;
        touched.push(op.progress === 'none' ? '不显示进度' : '显示进度');
      }
      if (op.mode === 'reply' || op.mode === 'act') {
        facetPatch.mode = op.mode;
        touched.push(op.mode === 'reply' ? '档位=reply（只回话）' : '档位=act（要动手）');
      }
      if (Array.isArray(op.caps)) {
        const next = parseCaps(op.caps) ?? DEFAULT_ACT_CAPS;
        // 没同时给 scope 就按它现有的作用域判（agent.kind 收窄后才能取 facet）。
        const curFacet = agent.kind === 'component' ? agent.agent : undefined;
        const nextScope = Array.isArray(op.scope)
          ? op.scope.filter((x): x is string => typeof x === 'string')
          : curFacet?.scope;
        const conflict = capScopeConflict(next, nextScope);
        if (conflict) return fail('能力开关与作用域冲突：' + conflict);
        facetPatch.caps = next;
        touched.push('能力开关=' + capSummary(next));
      }
      if (touched.length === 0) {
        return fail('set_agent_config 需要 name / systemPrompt / scope / tools / progress / mode / caps 之一。');
      }
      const store = useDesktopStore.getState();
      if (Object.keys(nodePatch).length) store.updateNode(agent.id, nodePatch as Partial<YggNode>);
      if (Object.keys(facetPatch).length) store.updateFacet(agent.id, facetPatch);
      desktop().log('op', 'agent cfg ' + agent.name, agent.id);
      return ok('已更新 Agent「' + agent.name + '」的 ' + touched.join('、'));
    },
  });

  registerInterface({
    kind: 'clear_agent_context',
    label: '清空 Agent 上下文',
    description:
      '清空某个 Agent 的对话历史**与"已做过的事"账本**，让它从零开始。' +
      '账本不清掉的话，它还会记得做过的组件，和"从零开始"是矛盾的。' +
      '用 id 指定（Agent 就是带 agent 能力的组件）。',
    example: { kind: 'clear_agent_context', id: 'n_xxx' },
    cap: 'agents',
    handler: (op) => {
      const id = strOr(op.id, '');
      const all = Object.values(desktop().nodes);
      const found = id ? all.find((n) => n.id === id) : undefined;
      if (!found || found.kind !== 'component' || !found.agent) {
        return fail('找不到 Agent ' + (id || '') + '。');
      }
      const facet = found.agent;
      const n = facet.messages.length;
      const l = facet.ledger.length;
      useDesktopStore.getState().updateFacet(found.id, { messages: [], ledger: [] });
      desktop().log('op', 'agent clear ' + found.name, found.id);
      return ok('已清空「' + found.name + '」的 ' + n + ' 条历史与 ' + l + ' 条账本');
    },
  });
}