import { newId } from '../ids';
import type { NodeId } from '../types';
import { MAIN_SESSION, useDesktopStore } from '../../store/desktopStore';
import { runDerivation } from './agentRuntime';

/**
 * 输入调度器。
 *
 * **每个会话各有一条自己的串行队列**，互相独立 ——
 * 两个输入框、以及每个组件 agent（'agent:<nodeId>'）都各算一个会话，
 * 所以基底与子 agent、子 agent 之间都能同时跑，各自显示各自的进度。
 *
 * 为什么会话内部必须串行：`runDerivation` 会写这个会话的 trace / status / 队列，
 * 同一会话并发跑两条会互相覆盖。会话之间则天然隔离 ——
 * 它们共享的是底层记忆（节点树、样式、基底的对话历史与账本），
 * 不共享工作状态。
 */

/** 会话 id -> 是否正在跑。 */
const busy = new Set<string>();

/**
 * 会话 id -> 当前这次运行的中止控制器。
 *
 * "停止"要能打断**正在流式生成的那次请求**，所以必须把控制器留在这里：
 * UI 只知道会话 id，拿不到 runDerivation 内部那个 signal。
 */
const running = new Map<string, AbortController>();

/**
 * 停止某个会话正在跑的这一轮。
 *
 * 语义（写在按钮的 title 里，别让用户猜）：
 * - 中止正在进行的模型请求；
 * - **清空这个会话的排队项** —— 按了停止就是要停下来，不是在原地等下一跳；
 * - 已经落地的改动不回滚（组件已经建出来了，那是实实在在的结果）。
 */
export function stopRun(sessionId: string = MAIN_SESSION): boolean {
  const ctl = running.get(sessionId);
  if (!ctl) return false;
  const store = useDesktopStore.getState();
  store.clearQueue(sessionId);
  ctl.abort();
  store.log('warn', '已停止 ' + sessionId);
  return true;
}

/** 这个会话是不是可以被打断（UI 据此决定按钮是"发送"还是"停止"）。 */
export function canStop(sessionId: string = MAIN_SESSION): boolean {
  return running.has(sessionId);
}

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
  options: { originId?: NodeId; sessionId?: string; files?: string[] } = {},
): boolean {
  const value = text.trim();
  const files = options.files ?? [];
  // 只有文件没有文字也要能发（"看看这个"）。
  if (!value && files.length === 0) return false;
  const store = useDesktopStore.getState();
  const sessionId = options.sessionId ?? MAIN_SESSION;
  // 输入框会话要求输入框在；agent 会话要求目标组件在（hasSession 两种都认）。
  if (!store.hasSession(sessionId)) return false;
  const target = options.originId && store.nodes[options.originId] ? options.originId : store.rootId;

  if (busy.has(sessionId)) {
    store.enqueue(sessionId, {
      id: newId(),
      text: value,
      originId: target,
      createdAt: Date.now(),
      ...(files.length ? { files } : {}),
    });
    return true;
  }
  void drain(sessionId, value, target, files);
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
async function drain(
  sessionId: string,
  firstText: string,
  firstOrigin: NodeId,
  firstFiles: string[] = [],
): Promise<void> {
  busy.add(sessionId);
  // 每次运行一个控制器，"停止"就是把它 abort 掉。
  const ctl = new AbortController();
  running.set(sessionId, ctl);
  let text: string | null = firstText;
  let origin: NodeId = firstOrigin;
  let files: string[] = firstFiles;
  try {
    while (text !== null) {
      try {
        await runDerivation(text, { originId: origin, sessionId, files, signal: ctl.signal });
      } catch (e) {
        useDesktopStore.getState().log('error', 'run ✕ ' + (e as Error).message);
      }
      // 被停止之后不再消化队列（stopRun 已经把它清空了，这里只是兜一层）。
      if (ctl.signal.aborted) break;

      let next = useDesktopStore.getState().shiftQueued(sessionId);
      while (next && !useDesktopStore.getState().nodes[next.originId]) {
        useDesktopStore.getState().log('warn', 'queue ✕ 目标已删除，丢弃一条排队输入');
        next = useDesktopStore.getState().shiftQueued(sessionId);
      }
      text = next ? next.text : null;
      if (next) {
        origin = next.originId;
        files = next.files ?? [];
        useDesktopStore
          .getState()
          .log('info', 'queue → ' + (next.text || '（文件）').slice(0, 60));
      }
    }
  } finally {
    busy.delete(sessionId);
    if (running.get(sessionId) === ctl) running.delete(sessionId);
    // 停止之后把这个会话的状态收尾，否则界面会一直停在"运行中"。
    if (ctl.signal.aborted) {
      const store = useDesktopStore.getState();
      store.setSessionStatus(sessionId, { running: false, phase: '已停止', detail: '', round: 0 });
    }
  }
}
