import { registerInterface } from '../registry/interfaceRegistry';
import { fail, ok, strOr, tokensOf } from '../bus/opContext';
import { compileComponent, compileTool } from '../../host/compile';
import { desktop, useDesktopStore } from '../../store/desktopStore';
import { getTool, registerTool, toolCatalog } from '../registry/toolRegistry';
import { sanitizeTokens } from '../../theme/engine';
import {
  clearSurfaceSource,
  isCriticalSurface,
  listSurfaces,
  setSurfaceSource,
  surfacesText,
} from '../registry/surfaceRegistry';
import { MAX_NODES, themeText, toolCatalogText, treeText } from '../agent/prompts';
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
        (n.agent ? ' [agent]' : ''),
    )
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
      '读取当前界面结构并回传给你自己，用于改动前确认 id 与现状。before 可选：windows（窗口）/ agents（Agent）/ tree / tokens / surfaces / tools / all。',
    example: { kind: 'inspect', before: 'all' },
    handler: (op) => {
      const s = desktop();
      const part = strOr(op.before, 'all');
      const chunks: string[] = [];
      if (part === 'all' || part === 'windows') chunks.push('## 窗口\n' + windowsText());
      if (part === 'all' || part === 'agents') chunks.push('## Agent\n' + agentsText());
      if (part === 'all' || part === 'tree') chunks.push('## 节点树\n' + treeText(s.nodes, s.rootId));
      if (part === 'all' || part === 'tokens') chunks.push('## 样式变量\n' + themeText(s.tokens));
      if (part === 'all' || part === 'surfaces') chunks.push('## 界面插槽\n' + surfacesText());
      if (part === 'all' || part === 'tools') chunks.push('## 工具\n' + toolCatalogText(toolCatalog()));
      if (chunks.length === 0) {
        return fail('inspect 的 before 只接受 windows / agents / tree / tokens / surfaces / tools / all。');
      }
      if (part === 'all') {
        const total = Object.keys(s.nodes).length;
        chunks.unshift('节点总数 ' + total + ' / 上限 ' + MAX_NODES);
      }
      return ok('已读取界面结构（' + part + '）', { observation: chunks.join('\n\n') });
    },
  });

  registerInterface({
    kind: 'list_surfaces',
    label: '查看界面插槽',
    description: '列出界面上所有可被替换的插槽、它们当前是否已被覆写，以及各自的可用 props。',
    example: { kind: 'list_surfaces' },
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
      '修改某个 Agent 的名字、职责、作用域或工具子集。用 id 指定（Agent 就是带 agent 能力的组件）。这不会清空它的对话历史。',
    example: { kind: 'set_agent_config', id: 'n_xxx', systemPrompt: '你专注于数据分析' },
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
      if (touched.length === 0) {
        return fail('set_agent_config 需要 name / systemPrompt / scope / tools 之一。');
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
    description: '清空某个 Agent 的对话历史，让它从零开始。用 id 指定（Agent 就是带 agent 能力的组件）。',
    example: { kind: 'clear_agent_context', id: 'n_xxx' },
    handler: (op) => {
      const id = strOr(op.id, '');
      const all = Object.values(desktop().nodes);
      const found = id ? all.find((n) => n.id === id) : undefined;
      if (!found || found.kind !== 'component' || !found.agent) {
        return fail('找不到 Agent ' + (id || '') + '。');
      }
      const facet = found.agent;
      const n = facet.messages.length;
      useDesktopStore.getState().updateFacet(found.id, { messages: [] });
      desktop().log('op', 'agent clear ' + found.name, found.id);
      return ok('已清空「' + found.name + '」的 ' + n + ' 条历史');
    },
  });
}