import type { ActCap, DerivationOp } from '../types';
import type { OpContext, OpResult } from '../bus/opContext';

/**
 * Agent 接口层。
 *
 * 一个接口 = 一种 Agent 能对系统做的事。总线本身不认识任何具体 kind，
 * 它只查表、调用 handler。新增能力只要 registerInterface，不动总线、不动解析器。
 */
export interface AgentInterface {
  /** op.kind，LLM 输出的就是这个字符串。 */
  kind: string;
  /** 一行摘要，用于进度面板与提示词。 */
  label: string;
  /** 详细说明，写进提示词。 */
  description: string;
  /** 示例 op，写进提示词。 */
  example: Record<string, unknown>;
  /** 该接口是否会在界面上产生可见变化（用于反馈措辞）。 */
  mutates?: boolean;
  /**
   * 它属于哪个能力开关。**不写 = 基础能力**（act 档最低配就有）。
   *
   * 这是"能力开关"的唯一事实来源：接口目录按它过滤、提示词按它裁剪、
   * 执行时按它拒绝。三处读同一份声明，不会各写一份而走偏。
   */
  cap?: ActCap;
  handler: (op: DerivationOp, ctx: OpContext) => Promise<OpResult> | OpResult;
}

const registry = new Map<string, AgentInterface>();

export function registerInterface(def: AgentInterface): void {
  registry.set(def.kind, def);
}

export function getInterface(kind: string): AgentInterface | undefined {
  return registry.get(kind);
}

export function listInterfaces(): AgentInterface[] {
  return [...registry.values()];
}

export function knownKinds(): string[] {
  return [...registry.keys()];
}

/** 这个接口需要哪个能力开关（基础接口返回 undefined）。 */
export function capOf(kind: string): ActCap | undefined {
  return registry.get(kind)?.cap;
}

/**
 * 按能力过滤接口。
 * `caps === undefined` 表示**全开**（老数据兼容）——这也是基底 Agent 的情形。
 */
export function interfacesFor(caps: ActCap[] | undefined): AgentInterface[] {
  if (!caps) return listInterfaces();
  const has = new Set<ActCap>(caps);
  return listInterfaces().filter((d) => !d.cap || has.has(d.cap));
}

/** 生成提示词里的接口清单与示例（按能力裁剪）。 */
export function interfaceCatalog(caps?: ActCap[]): { lines: string[]; examples: string } {
  const lines: string[] = [];
  const examples: string[] = [];
  interfacesFor(caps).forEach((def, i) => {
    lines.push(`${i + 1}. ${def.kind} —— ${def.description}`);
    examples.push(`  ${JSON.stringify(def.example)}`);
  });
  return { lines, examples: `[\n${examples.join(',\n')}\n]` };
}
