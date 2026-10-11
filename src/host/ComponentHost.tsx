import { useMemo } from 'react';
import { compileComponent } from './compile';
import { ErrorBoundary } from '../app/ErrorBoundary';
import { AgentIdContext, NO_AGENT } from './agentRuntimeModule';
import type { ComponentNode } from '../kernel/types';

interface Props {
  node: ComponentNode;
  onError: (message: string) => void;
}

/**
 * 渲染一个窗口的内容。
 *
 * **只有一份 source —— 就是组件自己的 source。**
 * Agent 不是另一套界面：它是"接入"到这个组件上的一种能力。
 *
 * - 没有 agent 能力：只渲染 source。
 * - 有 agent 能力：同样只渲染 source，但额外注入 AgentIdContext，
 *   于是源码里的 `useAgent()` 能拿到这个组件的上下文、消息与派发能力。
 *
 * 也就是说：**界面长什么样永远是组件源码自己的事**，
 * agent 能力只决定"它能思考、能行动、有自己的一份上下文"。
 */
export function ComponentHost({ node, onError }: Props) {
  const hasSource = !!node.source.trim();
  const result = useMemo(
    () => (hasSource ? compileComponent(node.id, node.source) : null),
    [hasSource, node.id, node.source],
  );

  let body: React.ReactNode;
  if (!hasSource) {
    body = <div className="ygg-blank">还没有内容</div>;
  } else if (result && result.ok) {
    const C = result.Component;
    body = (
      <ErrorBoundary onError={onError}>
        <C />
      </ErrorBoundary>
    );
  } else {
    body = (
      <div className="ygg-error-panel">
        <div className="title">✕</div>
        <pre>{result ? result.error : '未知编译错误'}</pre>
      </div>
    );
  }

  // 有 agent 能力：注入真实 id，useAgent() 才能正确路由到"这个组件"。
  // 没有能力时注入哨兵值 NO_AGENT —— 让源码里的 useAgent() 明确知道自己没被接上，
  // 而不是退回默认值把消息发进基底（那是个静默的错误路由）。
  const value = node.agent ? node.id : NO_AGENT;
  return <AgentIdContext.Provider value={value}>{body}</AgentIdContext.Provider>;
}