export type NodeId = string;

/**
 * 节点类型只有两种。
 * 注意这里**没有 'agent'** —— Agent 不是一种节点，而是组件的一种能力（见 AgentFacet）。
 */
export type NodeKind = 'component' | 'tool';

export type NodeStatus = 'active' | 'minimized' | 'closed' | 'error';

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /**
   * 这一条附带的图片（data URL）。用户在输入框里粘贴或拖进来的。
   * 只有 user 消息会带。发请求时会被拼成多模态 content。
   */
  images?: string[];
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface Pos2D {
  x: number;
  y: number;
}

export interface Size2D {
  w: number;
  h: number;
}

export interface BaseNode {
  id: NodeId;
  parentId: NodeId | null;
  kind: NodeKind;
  name: string;
  status: NodeStatus;
  description?: string;
  error?: string;
  createdAt: number;
  pos?: Pos2D;
  size?: Size2D;
  z?: number;
  /** 节点的局部样式覆盖。 */
  tokens?: ThemeTokens;
}

/**
 * Agent 能力。
 *
 * Agent 不是独立的节点类型，而是**组件可选的一个 facet**：
 * 一个组件带上这个 facet，就有了自己的上下文、自己的工具、自己的作用域。
 * 这正是"派生 Agent 作为创建组件时的一种思路"，而不是另一套并行的东西。
 *
 * 隔离保证：每个 facet 的 messages / ledger / scope 互不相通；
 * 且 scope 之外的操作会被 executeOps 在代码层拒绝（不只是提示词约束）。
 */
export interface AgentFacet {
  /** 它的专项职责，进入它自己的系统提示。 */
  systemPrompt: string;
  /** 它可用工具的 id 子集；为空表示只用内置工具。 */
  toolIds: NodeId[];
  /** 它自己的对话历史。 */
  messages: Message[];
  /** 它自己做过什么，跨刷新保留，用于避免重做。 */
  ledger: string[];
  /**
   * 它的作用域：允许它读写的节点 id。
   * 为空表示"仅自己与自己的后代"（派生 Agent 的默认值）。
   * 基底 Agent 用 scope='*' 表示不受限。
   */
  scope: NodeId[] | '*';
}

export interface ComponentNode extends BaseNode {
  kind: 'component';
  source: string;
  size: Size2D;
  pos: Pos2D;
  z: number;
  /** 带这个字段的组件就是一个 Agent。 */
  agent?: AgentFacet;
  /** 基底 Agent：它是 agent 组件，但不作为窗口渲染。 */
  root?: boolean;
}

export interface ToolNode extends BaseNode {
  kind: 'tool';
  paramsSchema: JsonSchema;
  source: string;
}

export type YggNode = ComponentNode | ToolNode;

export type ThemeTokens = Record<string, string>;

/* ------------------------------------------------------------------ */
/* 派生指令：开放类型，由 Agent 接口注册表在运行时解释                    */
/* ------------------------------------------------------------------ */

export interface DerivationOp {
  kind: string;
  [key: string]: unknown;
}

export interface DerivationPlan {
  reasoning?: string;
  continue?: boolean;
  ops: DerivationOp[];
}

/* ------------------------------------------------------------------ */
/* 界面表面                                                            */
/* ------------------------------------------------------------------ */

export interface SurfaceDef {
  id: string;
  label: string;
  description: string;
  propsHint?: string;
  /**
   * 该插槽是否承载"窗口基础能力"。
   * true 表示替换它会拆掉宿主的关键功能（例如拖拽），
   * 提示词里会明确警告 Agent 不要动它。
   */
  critical?: boolean;
  /** critical 插槽必须保留的能力说明，写给 Agent 看。 */
  capabilityHint?: string;
  /**
   * **内置实现是什么**，写给 Agent 看。
   *
   * 插槽的"内置实现"是宿主自己的代码，不是 Agent 写的、也读不到源码 ——
   * 但 Agent 要替换它、就必须知道它原本长什么样、靠哪些类名和结构工作。
   * 没有这段说明，Agent 只能对着一个"使用内置实现"的字符串干猜。
   */
  builtinHint?: string;
}

export interface SurfaceState {
  id: string;
  source: string;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* 执行轨迹与反馈                                                       */
/* ------------------------------------------------------------------ */

export type TraceStatus = 'running' | 'ok' | 'fail' | 'skipped';

export interface TraceStep {
  id: string;
  runId: string;
  round: number;
  index: number;
  kind: string;
  label: string;
  summary: string;
  status: TraceStatus;
  message: string;
  /** op 类步骤的返回内容（接口的 observation）。 */
  observation?: string;
  /** 模型推理步：模型单独的思考流（部分服务端会返回 reasoning_content）。 */
  thinking?: string;
  /** 模型推理步：模型这一轮的原始输出全文。 */
  raw?: string;
  startedAt: number;
  endedAt?: number;
}

export type FeedbackLevel = 'ok' | 'fail' | 'partial';

export interface RunFeedback {
  id: string;
  at: number;
  level: FeedbackLevel;
  title: string;
  detail: string;
}

/* ------------------------------------------------------------------ */
/* 运行态                                                              */
/* ------------------------------------------------------------------ */

export type LogLevel = 'info' | 'warn' | 'error' | 'llm' | 'op';

export interface LogEntry {
  id: string;
  at: number;
  level: LogLevel;
  text: string;
  nodeId?: NodeId;
}

export interface RoundResult {
  round: number;
  plan: DerivationPlan;
  observations: string[];
}

export interface DerivationOutcome {
  rounds: RoundResult[];
  created: NodeId[];
}

export function isComponent(n: YggNode | undefined): n is ComponentNode {
  return !!n && n.kind === 'component';
}

export function isTool(n: YggNode | undefined): n is ToolNode {
  return !!n && n.kind === 'tool';
}

/** 这个节点是不是一个 Agent（组件带 agent facet）。 */
export function isAgentNode(n: YggNode | undefined): n is ComponentNode {
  return isComponent(n) && !!n.agent;
}

/** 用于渲染的窗口：是组件、且不是基底。 */
export function isWindowNode(n: YggNode | undefined): n is ComponentNode {
  return isComponent(n) && !n.root;
}
