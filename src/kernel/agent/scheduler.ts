import { newId } from '../ids';
import type { NodeId } from '../types';
import { MAIN_SESSION, useDesktopStore } from '../../store/desktopStore';
import { runDerivation } from './agentRuntime';

/**
 * 输入调度器。
 *
 * **每个输入框（会话）各有一条自己的串行队列**，互相独立 ——
 * 两个输入框可以同时在跑，各自显示各自的进度。
 *
 * 为什么会话内部必须串行：`runDerivation` 会写这个会话的 trace / status / 队列，
 * 同一会话并发跑两条会互相覆盖。会话之间则天然隔离 ——
 * 它们共享的是底层记忆（节点树、样式、基底的对话历史与账本），
 * 不共享工作状态。
 */

/** 会话 id -> 是否正在跑。 */
const busy = new Set<string>();

/** 某个会话是否正在跑（含它跑完后要继续消化的排队项）。 */
export function isBusy(sessionId: string = MAIN_SESSION): boolean {
  return busy.has(sessionId);
}

/** 任意会话在跑 —— 给"全局是否有任务在跑"这类展示用。 */
export function anyBusy(): boolean {
  return busy.size > 0;
}

/** 队列长度。 */
export function queueLength(sessionId: string = MAIN_SESSION): number {
  const ses = useDesktopStore.getState().sessions.find((x) => x.id === sessionId);
  return ses ? ses.queue.length : 0;
}

/**
 * 提交一条输入。
 * 空闲 → 立刻开跑；忙碌 → 进这个会话的队列，等它跑完自动接着发。
 * 目标 Agent 不存在时在**提交那一刻**回落到基底。
 *
 * 返回是否真的收下了。调用方据此决定要不要清空输入框。
 */
export function submitInput(
  text: string,
  options: { originId?: NodeId; sessionId?: string } = {},
): boolean {
  const value = text.trim();
  if (!value) return false;
  const store = useDesktopStore.getState();
  const sessionId = options.sessionId ?? MAIN_SESSION;
  if (!store.sessions.some((s) => s.id === sessionId)) return false;
  const target = options.originId && store.nodes[options.originId] ? options.originId : store.rootId;

  if (busy.has(sessionId)) {
    store.enqueue(sessionId, { id: newId(), text: value, originId: target, createdAt: Date.now() });
    return true;
  }
  void drain(sessionId, value, target);
  return true;
}

/**
 * 串行执行：跑完一条再从队列取下一跳，直到队列空。
 *
 * 一条出错不阻塞后面的排队项 —— `runDerivation` 自己吞掉错误并返回摘要，
 * 这里再兜一层，保证 busy 标记一定被复位。
 *
 * 排队期间目标组件被删掉的条目**直接丢弃**，不静默改发给基底：
 * 那会让人以为在跟子 Agent 说话，实际基底收走了（同 §5.30 的教训）。
 */
async function drain(sessionId: string, firstText: string, firstOrigin: NodeId): Promise<void> {
  busy.add(sessionId);
  let text: string | null = firstText;
  let origin: NodeId = firstOrigin;
  try {
    while (text !== null) {
      try {
        await runDerivation(text, { originId: origin, sessionId });
      } catch (e) {
        useDesktopStore.getState().log('error', 'run ✕ ' + (e as Error).message);
      }

      let next = useDesktopStore.getState().shiftQueued(sessionId);
      while (next && !useDesktopStore.getState().nodes[next.originId]) {
        useDesktopStore.getState().log('warn', 'queue ✕ 目标已删除，丢弃一条排队输入');
        next = useDesktopStore.getState().shiftQueued(sessionId);
      }
      text = next ? next.text : null;
      if (next) {
        origin = next.originId;
        useDesktopStore.getState().log('info', 'queue → ' + next.text.slice(0, 60));
      }
    }
  } finally {
    busy.delete(sessionId);
  }
}
