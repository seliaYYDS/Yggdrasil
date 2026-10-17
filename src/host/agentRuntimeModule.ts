import { createContext, useContext } from 'react';
import { agentSessionId, EMPTY_RUN, useDesktopStore } from '../store/desktopStore';
import { submitInput } from '../kernel/agent/scheduler';
import type { ActCap, ComponentNode, Message, NodeId, TraceStep, YggNode } from '../kernel/types';

/**
 * Agent 能力运行时。
 *
 * **Agent 是接入到组件上的一种能力**，不是独立实体、也不是另一套界面。
 * 组件源码通过 `import { useAgent } from "yggdrasil"` 拿到这份能力，
 * 然后**自己决定**怎么呈现它：聊天框、按钮、进度条、表格都行。
 *
 * 每个组件的 agent 能力是独立的一份：
 * - **记忆独立**：messages / ledger / scope 互不相通；
 * - **工作状态独立**：跑起来时占用的是它自己的会话（'agent:<id>'），
 *   不占基底、不占别的 agent —— 所以基底可以同时继续干活。
 *
 * 进度怎么显示由**创建它的那个 Agent**决定：
 * 组件源码里读 `useAgent().progress` 画在任何位置；
 * 也可以传别人的 id 读别的 agent（`useAgent('n_xxx')`）做监控面板；
 * 不想进 Trace 面板就在创建时写 `agent: { progress: 'none' }`。
 */

/**
 * 当前组件 id。
 *
 * 默认值刻意**不是 'root'**：如果某个组件源码调用了 useAgent() 却没接入
 * agent 能力，退回 'root' 会让它的消息静默发进基底 agent —— 用户会以为
 * 在跟子 agent 说话，实际全被基底收走。用哨兵值让这种情况立刻暴露。
 */
export const NO_AGENT = '__no_agent__';
export const AgentIdContext = createContext<string>(NO_AGENT);

/** 一个 agent 自己的工作状态。 */
export interface AgentProgress {
  running: boolean;
  phase: string;
  detail: string;
  round: number;
  /** 排队等着它处理的输入条数。 */
  queued: number;
  /** 这次运行的步骤（轨迹）—— 可以直接渲染成进度列表。 */
  steps: TraceStep[];
}

export interface AgentApi {
  /** 承载这份能力的组件 id；未接入能力时为 null。 */
  id: string | null;
  name: string;
  /** 承载这份能力的组件本身。 */
  host: YggNode | undefined;
  /** 这个组件是否真的接入了 agent 能力。 */
  attached: boolean;
  /** 这份能力自己的对话历史（reply 档里 assistant 的回复也在里面）。 */
  messages: Message[];
  /**
   * 运行档位。
   * - `'reply'`：一问一答，`messages` 里有它的回复 —— 渲染出来就是聊天框。
   * - `'act'`：输出 ops 去动桌面；它**不会说话**，界面上不该期待出现回复文字。
   */
  mode: 'reply' | 'act';
  /** act 档的能力开关（reply 档为 undefined）。 */
  caps: ActCap[] | undefined;
  /** 这个 agent 自己的工作状态（不含别人）。 */
  progress: AgentProgress;
  /** 兼容旧写法：等于 progress.running。 */
  running: boolean;
  /** 全局还有没有别的东西在跑（基底、其他 agent、其他输入框）。 */
  anyRunning: boolean;
  /** 这个组件的专项职责。 */
  role: string;
  /** 让这个组件去思考并行动。未接入能力时是空操作。 */
  send: (text: string) => void;
  /** 清空它的上下文。 */
  clear: () => void;
}

/**
 * 拿到 agent 能力。
 *
 * `useAgent()` 拿自己所在组件的；`useAgent('n_xxx')` 拿指定组件的 ——
 * 后者用来做"监控面板"这类东西：一个组件显示另一个（或好几个）agent 的进度。
 * 传 id 时**只读**：send / clear 仍然只作用于自己。
 */
export function useAgent(explicitId?: string): AgentApi {
  const ctxId = useContext(AgentIdContext);
  // **能力的权威来源就是 Context**：ComponentHost 只有在组件真的接了能力时
  // 才注入真实 id，否则注入 NO_AGENT。不再二次查询 store ——
  // 那样在 SSR（无 getServerSnapshot）下会读到初始 state，得出错误的 attached。
  const id = explicitId ?? (ctxId !== NO_AGENT ? ctxId : null);

  const node = useDesktopStore((s) => (id ? s.nodes[id] : undefined));
  // 这个 agent 自己的工作状态。EMPTY_RUN 是模块级常量，引用稳定。
  const run = useDesktopStore((s) => (id ? s.agentRuns[id] ?? EMPTY_RUN : EMPTY_RUN));
  // "别的还有没有在跑" —— 只用于展示，不影响本 agent 的忙闲。
  const anyRunning = useDesktopStore((s) =>
    s.sessions.some((ses) => ses.status.running) ||
    Object.values(s.agentRuns).some((r) => r.status.running),
  );

  const comp = node && node.kind === 'component' ? (node as ComponentNode) : undefined;
  const facet = comp?.agent;
  // 显式传 id 时看它有没有能力；用 Context 时，Context 就是权威。
  const attached = explicitId ? !!facet : ctxId !== NO_AGENT && !!id;

  const progress: AgentProgress = {
    running: run.status.running,
    phase: run.status.phase,
    detail: run.status.detail,
    round: run.status.round,
    queued: run.queue.length,
    steps: run.trace,
  };

  return {
    id,
    name: comp?.name ?? '',
    host: comp,
    attached,
    messages: facet?.messages ?? [],
    mode: facet?.mode ?? 'act',
    caps: facet?.caps,
    progress,
    running: progress.running,
    anyRunning,
    role: facet?.systemPrompt ?? '',
    send: (text: string) => {
      const value = text.trim();
      if (!value) return;
      // 没接入能力就不发 —— 绝不静默转给基底。
      if (!id || !attached || !facet) {
        console.warn(
          '[yggdrasil] useAgent().send() 被调用，但该组件未接入 agent 能力，消息未发送。' +
            '请先用 attach_agent 接入能力。',
        );
        return;
      }
      // **发到它自己的会话**：于是它不占基底、基底也不占它，各自显示各自的进度。
      submitInput(value, { originId: id, sessionId: agentSessionId(id) });
    },
    clear: () => {
      if (!id || !attached) return;
      useDesktopStore.getState().updateFacet(id, { messages: [] });
    },
  };
}

/** 这个 id 所在的组件是否具备 agent 能力。 */
export function isAgentId(nodes: Record<NodeId, YggNode>, id: string): boolean {
  const n = nodes[id];
  return !!n && n.kind === 'component' && !!n.agent;
}
