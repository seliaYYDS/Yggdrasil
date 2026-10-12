/**
 * 控制台报错捕获。
 *
 * 目的：宿主自己（或某个生成组件）在控制台抛错时，**让用户有机会一键交给 Agent 去修**。
 * 这里只负责"听到"错误并转出去，弹不弹窗、要不要发给 Agent 由 store 决定
 * （那里还要判断 agent 是否空闲、同一个错误是否刚问过）。
 *
 * 三条注意：
 * 1. **不能重复包装**：热更新或重复调用 install 会把同一个 console.error 包好几层，
 *    一个错误被报 N 次。用模块级标记挡住。
 * 2. **我们自己的日志不算**：宿主写控制台通常是在汇报"我已经处理过的错误"，
 *    再拿它去问用户要不要修就是自寻烦恼。这类写入前后会调 beginInternalLog/endInternalLog。
 * 3. **要限流**：一个每帧都抛错的组件会在几秒内产生成百上千条，
 *    所以这里只保留最近若干条，节流交给 store。
 */

export interface ConsoleErrorEvent {
  text: string;
  at: number;
}

type Listener = (e: ConsoleErrorEvent) => void;

const listeners = new Set<Listener>();
let installed = false;
/** > 0 表示当前是"宿主自己在写日志"，这段里的错误不转出去。 */
let internalDepth = 0;
let originalError: ((...args: unknown[]) => void) | null = null;

/** 宿主自己的日志写入，包住它就等于"别报这个错"。 */
export function beginInternalLog(): void {
  internalDepth += 1;
}

export function endInternalLog(): void {
  internalDepth = Math.max(0, internalDepth - 1);
}

export function subscribeConsoleErrors(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 单条错误最多记这么长：再长对定位没帮助，反而把提示框和上下文撑爆。 */
const MAX_ERR_CHARS = 2000;

function stringify(args: unknown[]): string {
  const parts = args.map((a) => {
    if (a instanceof Error) return a.stack || a.message || String(a);
    if (typeof a === 'string') return a;
    if (typeof a === 'number' || typeof a === 'boolean' || a === null) return String(a);
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  });
  const text = parts.join(' ').trim();
  return text.length > MAX_ERR_CHARS ? text.slice(0, MAX_ERR_CHARS) + '…' : text;
}

function emit(text: string): void {
  const value = text.trim();
  if (!value) return;
  if (internalDepth > 0) return;
  const e: ConsoleErrorEvent = { text: value, at: Date.now() };
  for (const fn of listeners) {
    try {
      fn(e);
    } catch {
      /* 监听方自己炸了不能再往外抛（否则又是无限套娃） */
    }
  }
}

export function installConsoleErrorHooks(): void {
  if (installed) return;
  installed = true;

  originalError = console.error.bind(console) as (...args: unknown[]) => void;
  console.error = (...args: unknown[]) => {
    originalError?.(...args);
    emit(stringify(args));
  };

  window.addEventListener('error', (e) => {
    const err = (e as ErrorEvent).error;
    emit(err instanceof Error ? err.stack || err.message : e.message || '未知错误');
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = (e as PromiseRejectionEvent).reason;
    emit('未处理的 Promise 拒绝：' + (reason instanceof Error ? reason.stack || reason.message : stringify([reason])));
  });
}

/** 只给测试用：拆掉钩子并把 console.error 还原。 */
export function uninstallConsoleErrorHooks(): void {
  if (!installed) return;
  installed = false;
  if (originalError) console.error = originalError;
  originalError = null;
}
