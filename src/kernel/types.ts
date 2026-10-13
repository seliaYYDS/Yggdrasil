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
/**
 * 一个 act 档 Agent 的**能力开关**。
 *
 * 一个开关同时决定三件事，而且它们是**同一份声明**（接口注册时就标好了归属）：
 * 1. 它的系统提示里有没有对应的那一段；
 * 2. 接口目录里出不出现对应的 op；
 * 3. 执行时那些 op 让不让它调（没能力直接拒绝，而不是靠它没看见）。
 *
 * 这么做是为了让子 Agent 的提示词跟它真正要干的事成正比 ——
 * 一个只负责画界面的 Agent 不该收到浏览器控制、联网、派生 Agent 那一整套说明。
 *
 * 注意：这是**注意力与执行面的管理**，不是安全边界
 * （一个带 agents 能力的 Agent 本来就能派生别的 Agent）。
 */
export type ActCap = 'desktop' | 'style' | 'global' | 'net' | 'browser' | 'agents' | 'tools';

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
  /**
   * 它的进度要不要并进 Trace 面板。默认 'trace'（显示）。
   *
   * 为什么是个开关：创建它的那个 Agent 最清楚进度该显示在哪 ——
   * 如果它已经在子 Agent 自己的界面里画了进度条，再往 Trace 里塞一份就是重复。
   * 所以"显不显示"在**创建时**由创建者决定。
   */
  progress?: 'trace' | 'none';
  /**
   * 运行档位。
   * - `'act'`（缺省）：完整派生管线 —— 输出 ops、多轮、观察回灌。
   * - `'reply'`：一问一答。只发一段小提示词，模型的**文本回复**直接落进 messages，
   *   组件渲染出来即可。没有 ops、没有 JSON、没有轮次、没有账本与作用域。
   *
   * 缺省是 `'act'`，老数据不受影响。
   */
  mode?: 'reply' | 'act';
  /**
   * act 档的能力开关。**缺省 = 全开**（老数据兼容：没存 caps 的 agent 行为不变）。
   *
   * 新建时由创建者给定；给多少就只接多少提示词。
   * reply 档没有 ops，这个字段无意义（会被忽略）。
   */
  caps?: ActCap[];
}

/**
 * 窗口形态。
 * - `'window'`（缺省）：有标题栏的普通窗口。
 * - `'widget'`：**挂件** —— 不画标题栏、根容器透明无边框、不能被直接拖动；
 *   鼠标移上去时右下角出现三个按钮（缩放 / 移动 / 关闭），按住"移动"或"缩放"才能改。
 *   适合状态灯、悬浮计数器、装饰性小组件这类"只要那一小块"的东西。
 */
export type NodeFrame = 'window' | 'widget';

export interface ComponentNode extends BaseNode {
  kind: 'component';
  source: string;
  size: Size2D;
  pos: Pos2D;
  z: number;
  /** 窗口形态。缺省 'window'（普通窗口）。 */
  frame?: NodeFrame;
  /**
   * 挂件专用：固定。
   * 固定后 hover 不再显示操控按钮，位置与大小也就动不了。
   */
  fixed?: boolean;
  /**
   * 锁定：**不可被删除**。用户与 Agent 都删不掉 —— 用来保护已经满意的东西。
   * 要先在 Nodes 里解锁才能删。
   */
  locked?: boolean;
  /**
   * 它是从哪儿被派生出来的：**发起这次派生的输入框会话 id，或发起它的组件 id**。
   * 用来画"派生连线"（从源的中心连到它的中心），也让"关闭"能连回同一个来源。
   */
  bornFrom?: string;
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
   * 这个插槽是**默认界面**（常驻面板 / 窗口标题栏）的结构。
   *
   * 改动它要弹一次确认（"要不要还原"）：默认界面是用户天天看的东西，
   * 被 Agent 改了结构未必马上看得出来，而且改坏了不好恢复。
   * 只标"结构"，样式（--ygg- 变量）不走这条 —— 还原结构时也不动样式。
   */
  defaultWindow?: boolean;
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

