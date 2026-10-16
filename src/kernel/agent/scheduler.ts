import { newId } from '../ids';
import type { NodeId } from '../types';
import { MAIN_SESSION, useDesktopStore } from '../../store/desktopStore';
import { compactSessionNow, runDerivation } from './agentRuntime';

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

/**
 * 会话 id -> 是不是正在**手动压缩上下文**。
 *
 * 为什么需要单独一个集合：手动压缩不经过 drain（它不是一次派生运行），
 * 但它确实是"这个会话此刻在忙"。不登记的话会有两个后果：
 *
 * 1. **提交会并发开跑**。压缩期间 submitInput 看到 busy 里没有这个会话，就直接调 drain()
 *    —— 于是"压缩改写记忆"和"一轮派生写记忆"同时进行，互相覆盖（这是真会坏数据的那种）；
 * 2. **"停止"按不动**。输入框在 running=true 时会把发送键变成停止，而 stopRun 是从
 *    running 表里取控制器的 —— 手动压缩没登记就取不到，用户点了没反应。
 */
const compacting = new Set<string>();

/** 这个会话是不是正在手动压缩（UI 与 submitInput 都要看它）。 */
export function isCompacting(sessionId: string = MAIN_SESSION): boolean {
  return compacting.has(sessionId);
}

/**
 * 发起一次**手动压缩**（用户点输入框右下角的圆环）。
 *
 * 走这里而不是让 UI 直接调 compactSessionNow，是为了把"这个会话在忙"登记下来：
 * 提交会因此排队、停止也能真的打断那次摘要请求。返回值表示**是否真的开始了**
 * （已经在跑 / 已经在压 → false，界面据此不重复触发）。
 */
export function submitCompaction(originId: NodeId, sessionId: string = MAIN_SESSION): boolean {
  if (compacting.has(sessionId) || busy.has(sessionId)) return false;
  compacting.add(sessionId);
  // 同时写进 store：输入框是**响应式**读它的（这个模块内部的 Set 不触发 React 重渲染）。
  useDesktopStore.getState().setCompacting(sessionId, true);
  // 复用同一张控制器表：于是输入框的"停止"按钮对它同样有效。
  const ctl = new AbortController();
  running.set(sessionId, ctl);
  void (async () => {
    try {
      await compactSessionNow(originId, sessionId, ctl.signal);
    } catch (e) {
      useDesktopStore.getState().log('warn', 'compact ✕ ' + ((e as Error)?.message ?? String(e)).slice(0, 120));
    } finally {
      compacting.delete(sessionId);
      useDesktopStore.getState().setCompacting(sessionId, false);
      if (running.get(sessionId) === ctl) running.delete(sessionId);
      /*
       * **压缩期间排队的输入要在这里接上。**
       *
       * 上面把压缩期的提交都塞进了队列（避免与压缩并发改记忆），但压缩不在 drain 的循环里 ——
       * 没人接的话那些输入会永远躺着：用户看到"排队 N 条"再也不会动。
       *
       * 被停止时不接：stopRun 已经把队列清空了，语义就是"停下来"。
       */
      if (!ctl.signal.aborted) {
        const next = useDesktopStore.getState().shiftQueued(sessionId);
        if (next && useDesktopStore.getState().nodes[next.originId]) {
          void drain(sessionId, next.text, next.originId, next.files ?? []);
        } else if (next) {
          // 目标已被删：丢掉这条，再把剩下的也接上（与 drain 里的处理一致）。
          useDesktopStore.getState().log('warn', 'queue ✕ 目标已删除，丢弃一条排队输入');
          const after = useDesktopStore.getState().shiftQueued(sessionId);
          if (after) void drain(sessionId, after.text, after.originId, after.files ?? []);
        }
      }
    }
  })();
  return true;
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

  /*
   * 忙**或正在压缩**都进队列 —— 不并发开跑。
   * 见 compacting 的注释：压缩与派生会同时改同一份记忆。
   */
  if (busy.has(sessionId) || compacting.has(sessionId)) {
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
