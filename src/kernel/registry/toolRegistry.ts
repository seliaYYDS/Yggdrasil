import type { ActCap, JsonSchema } from '../types';
import type { ToolCatalogEntry } from '../agent/prompts';

export interface RuntimeTool {
  id: string;
  name: string;
  description: string;
  paramsSchema?: JsonSchema;
  source: string;
  builtin: boolean;
  /**
   * 由某个插件提供时记下插件 id。
   *
   * 有了它才能做到两件事：插件被关掉/卸载时**按来源撤干净**（不是靠名字反推），
   * 以及"回滚派生工具"时**跳过插件工具** —— 那些不是 Agent 造的，删了就等于插件莫名失效。
   */
  pluginId?: string;
  /**
   * 这个工具需要哪个能力开关。undefined = 基础能力（任何 Agent 都能用）。
   *
   * 只有插件工具会带它：内置工具（calc / now / random）与派生工具都是基础能力。
   * 它必须在这里声明，否则会出现一个真实的安全缺口 —— 见 call_tool 里的检查。
   */
  cap?: ActCap;
  /**
   * 执行工具。
   *
   * `signal`：用户按"停止"时中止长任务（沙箱里的脚本工具可能跑满整个 timeout）。
   * 内置工具（calc / now / random）是纯计算，忽略它即可。
   */
  run: (args: unknown, signal?: AbortSignal) => unknown;
}

const tools = new Map<string, RuntimeTool>();

export function registerTool(tool: RuntimeTool): void {
  tools.set(tool.id, tool);
}

export function unregisterTool(id: string): void {
  tools.delete(id);
}

export function getTool(id: string): RuntimeTool | undefined {
  return tools.get(id);
}

export function listTools(): RuntimeTool[] {
  return [...tools.values()];
}

export function toolCatalog(): ToolCatalogEntry[] {
  return listTools().map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    paramsSchema: t.paramsSchema,
    builtin: t.builtin,
    pluginId: t.pluginId,
    cap: t.cap,
  }));
}

export async function callTool(id: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
  const tool = tools.get(id);
  if (!tool) throw new Error('No such tool: ' + id);
  return await tool.run(args, signal);
}

/**
 * 清掉所有**派生**工具（Agent 用 create_tool 造的那些），保留内置工具与插件工具。
 *
 * 插件工具必须跳过：它不是"这一轮造出来的东西"，回滚它等于让插件在运行中无故失效，
 * 而且下次同步才会补回来 —— 表现就是"打着字插件忽然不能用了"。
 */
export function pruneDerivedTools(): void {
  for (const t of [...tools.values()]) {
    if (!t.builtin && !t.pluginId) tools.delete(t.id);
  }
}

/** 按来源撤掉某个插件的全部工具。 */
export function unregisterPluginTools(pluginId: string): void {
  for (const t of [...tools.values()]) {
    if (t.pluginId === pluginId) tools.delete(t.id);
  }
}

/** 这个工具当前**允许**被谁用：没声明 cap 就是人人可用。 */
export function toolCap(id: string): ActCap | undefined {
  return tools.get(id)?.cap;
}
