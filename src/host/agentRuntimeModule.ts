import { createContext, useContext } from 'react';
import { useDesktopStore } from '../store/desktopStore';
import { submitInput } from '../kernel/agent/scheduler';
import type { ComponentNode, Message, NodeId, YggNode } from '../kernel/types';

/**
 * Agent 能力运行时。
 *
 * **Agent 是接入到组件上的一种能力**，不是独立实体、也不是另一套界面。
 * 组件源码通过 `import { useAgent } from "yggdrasil"` 拿到这份能力，
 * 然后**自己决定**怎么呈现它：聊天框、按钮、表格都行。
 *
 * 每个组件的 agent 能力是独立的一份：messages / ledger / scope 互不相通。
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

export interface AgentApi {
  /** 承载这份能力的组件 id；未接入能力时为 null。 */
  id: string | null;
  name: string;
  /** 承载这份能力的组件本身。 */
  host: YggNode | undefined;
  /** 这个组件是否真的接入了 agent 能力。 */
  attached: boolean;
  /** 这份能力自己的对话历史。 */
  messages: Message[];
  /** 全局是否有任务在跑。 */
  running: boolean;
  /** 这个组件的专项职责。 */
  role: string;
  /** 让这个组件去思考并行动。未接入能力时是空操作。 */
  send: (text: string) => void;
  /** 清空它的上下文。 */
  clear: () => void;
}

export function useAgent(): AgentApi {
  const ctxId = useContext(AgentIdContext);
  // **能力的权威来源就是 Context**：ComponentHost 只有在组件真的接了能力时
  // 才注入真实 id，否则注入 NO_AGENT。不再二次查询 store ——
  // 那样在 SSR（无 getServerSnapshot）下会读到初始 state，得出错误的 attached。
  const attached = ctxId !== NO_AGENT;
  const id = attached ? ctxId : null;

  const node = useDesktopStore((s) => (id ? s.nodes[id] : undefined));
  const running = useDesktopStore((s) => s.status.running);

  const comp = node && node.kind === 'component' ? (node as ComponentNode) : undefined;
  const facet = comp?.agent;

  return {
    id,
    name: comp?.name ?? '',
    host: comp,
    attached,
    messages: facet?.messages ?? [],
    running,
    role: facet?.systemPrompt ?? '',
    send: (text: string) => {
      const value = text.trim();
      if (!value) return;
      // 没接入能力就不发 —— 绝不静默转给基底。
      if (!id || !attached) {
        console.warn(
          '[yggdrasil] useAgent().send() 被调用，但这个组件没有接入 agent 能力，消息未发送。' +
            '请先用 attach_agent 给它接入能力。',
        );
        return;
      }
      // 走调度器：已有任务在跑时排队，而不是并发抢同一份 store。
      submitInput(value, id);
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