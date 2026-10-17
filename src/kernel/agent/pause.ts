/**
 * "这一轮跑完就停" 的会话标记。
 *
 * 为什么需要它：有些操作**必须等用户**才能继续 —— 目前只有 `capture_screen`：
 * 浏览器只在用户手势里允许抓屏，图要等用户点一下才进上下文。
 * 让 Agent 继续跑下去有两个后果：
 *
 * 1. 它在**没看到图**的前提下接着改界面（这正是它要看图的原因）；
 * 2. 用户点完截图回来时这个会话还忙着，那条带图的输入只能排队 ——
 *    看起来就是"点了发送没反应，被塞进队列了"。
 *
 * 只做一件事：记下"这个会话跑完这一轮就停"。不复用 `stopRun` ——
 * 那是用户按停止（会清队列、会标成已停止），语义不同。
 */
const paused = new Set<string>();

/** 请求"本轮结束后停下"（由需要等用户的操作调用）。 */
export function requestPause(sessionId: string): void {
  paused.add(sessionId);
}

/** 读到就清掉：一次请求只停一轮。 */
export function takePause(sessionId: string): boolean {
  if (!paused.has(sessionId)) return false;
  paused.delete(sessionId);
  return true;
}

/** 开跑前清掉上一个任务留下的标记（它只对"请求它的那次运行"有意义）。 */
export function clearPause(sessionId: string): void {
  paused.delete(sessionId);
}

/** 当前是否有挂着的请求（诊断与断言用）。 */
export function pauseRequested(sessionId: string): boolean {
  return paused.has(sessionId);
}
