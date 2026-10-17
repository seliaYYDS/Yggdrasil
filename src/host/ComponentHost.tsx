import { memo, useMemo } from 'react';
import { compileComponent } from './compile';
import { ErrorBoundary } from '../app/ErrorBoundary';
import { AgentIdContext, NO_AGENT } from './agentRuntimeModule';
import type { ComponentNode } from '../kernel/types';

interface Props {
  node: ComponentNode;
  /**
   * 运行时报错上报。**必须传稳定引用**（Desktop 里用 useCallback 包一层），
   * 否则下面的 memo 比较永远失败，等于没 memo。
   * 参数里带上 id / name，这样调用方不需要为每个窗口各造一个闭包。
   */
  onError: (message: string, id: string, name: string) => void;
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
function ComponentHostInner({ node, onError }: Props) {
  const hasSource = !!node.source.trim();
  const result = useMemo(
    () => (hasSource ? compileComponent(node.id, node.source) : null),
    [hasSource, node.id, node.source],
  );

  let body: React.ReactNode;
  if (!hasSource) {
    body = <div className="ygg-blank">暂无内容</div>;
  } else if (result && result.ok) {
    const C = result.Component;
    body = (
      <ErrorBoundary onError={(m) => onError(m, node.id, node.name)}>
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

/**
 * 只在**内容**变化时重渲染。
 *
 * 默认的浅比较会拿 `node` 对象比引用 —— 而拖动窗口时每个 pointermove 都会生成新的 node
 * 对象（pos 变了），于是所有窗口的内容都会跟着重渲染一遍。整页效果类的组件
 * （WebGL / canvas / 大量 DOM）在这种重渲染里会被反复执行渲染函数，非常贵。
 *
 * 所以这里手写比较：位置、尺寸、层级、焦点都不影响内容，直接忽略。
 */
export const ComponentHost = memo(
  ComponentHostInner,
  (a, b) =>
    a.node.id === b.node.id &&
    a.node.source === b.node.source &&
    !!a.node.agent === !!b.node.agent &&
    a.onError === b.onError,
);