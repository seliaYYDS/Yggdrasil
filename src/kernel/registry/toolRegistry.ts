import type { JsonSchema } from '../types';
import type { ToolCatalogEntry } from '../agent/prompts';

export interface RuntimeTool {
  id: string;
  name: string;
  description: string;
  paramsSchema?: JsonSchema;
  source: string;
  builtin: boolean;
  run: (args: unknown) => unknown;
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
  }));
}

export async function callTool(id: string, args: unknown): Promise<unknown> {
  const tool = tools.get(id);
  if (!tool) throw new Error('找不到工具：' + id);
  return await tool.run(args);
}

/** 清掉所有派生工具，保留内置工具。用于回滚。 */
export function pruneDerivedTools(): void {
  for (const t of [...tools.values()]) {
    if (!t.builtin) tools.delete(t.id);
  }
}
