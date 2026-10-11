import { newId } from '../ids';
import type { NodeId } from '../types';
import { useDesktopStore } from '../../store/desktopStore';
import { runDerivation } from './agentRuntime';

/**
 * 输入调度器。
 *
 * 只有一个任务在跑：Agent 思考时再来一条输入，不再被拒，而是**排队**。
 * 当前任务结束后自动按先来后到接着发，队列在界面上可逐条删除。
 *
 * 为什么需要它：`runDerivation` 读写同一份 store（trace / status / 节点树），
 * 并发跑两条会互相覆盖状态。串行是唯一正确的做法，队列只是把"被拒绝"
 * 变成"稍后执行"。
 */

let busy = false;

/** 是否已有任务在跑（含它在跑完后要继续消化的排队项）。 */
export function isBusy(): boolean {
  return busy;
}

/** 队列长度。 */
export function queueLength(): number {
  return useDesktopStore.getState().queue.length;
}

/**
 * 提交一条输入。
 * 空闲 → 立刻开跑；忙碌 → 入队，等当前任务结束后自动发送。
 * 目标 Agent 不存在时在**提交那一刻**回落到基底。
 */
export function submitInput(text: string, originId?: NodeId): void {
  const value = text.trim();
  if (!value) return;
  const store = useDesktopStore.getState();
  const target = originId && store.nodes[originId] ? originId : store.rootId;

  if (busy) {
    store.enqueue({ id: newId(), text: value, originId: target, createdAt: Date.now() });
    return;
  }
  void drain(value, target);
}

/**
 * 串行执行：跑完一条再从队列取下一跳，直到队列空。
 *
 * 一条出错不阻塞后面的排队项 —— `runDerivation` 自己吞掉错误并返回摘要，
 * 这里再兜一层，保证 `busy` 一定被复位。
 *
 * 排队期间目标组件被删掉的条目**直接丢弃**，不静默改发给基底：
 * 那会让人以为在跟子 Agent 说话，实际基底收走了（同 §5.30 的教训）。
 */
async function drain(firstText: string, firstOrigin: NodeId): Promise<void> {
  busy = true;
  let text: string | null = firstText;
  let origin: NodeId = firstOrigin;
  try {
    while (text !== null) {
      try {
        await runDerivation(text, { originId: origin });
      } catch (e) {
        useDesktopStore.getState().log('error', 'run ✕ ' + (e as Error).message);
      }

      let next = useDesktopStore.getState().shiftQueued();
      while (next && !useDesktopStore.getState().nodes[next.originId]) {
        useDesktopStore.getState().log('warn', 'queue ✕ 目标已删除，丢弃一条排队输入');
        next = useDesktopStore.getState().shiftQueued();
      }
      text = next ? next.text : null;
      if (next) origin = next.originId;
    }
  } finally {
    busy = false;
  }
}
