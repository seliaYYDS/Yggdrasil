/**
 * 控制台捕获：**错误上报** + **原样留档**。
 *
 * 两个用途，同一套钩子：
 * 1. 宿主自己（或某个生成组件）在控制台抛错时，让用户有机会一键交给 Agent 去修。
 *    这里只负责"听到"错误并转出去，弹不弹窗、要不要发给 Agent 由 store 决定。
 * 2. **留档给 Agent 读**：`console.log / info / warn / debug / error` 与未捕获异常都进一个环形缓冲，
 *    由 `inspect before="console"` 取出来。排查"组件为什么不显示"要的正是这个 ——
 *    运行时账本（store.logs）只记"谁调了什么操作"，记不到组件里自己打的那一行。
 *
 * 四条注意：
 * 1. **不能重复包装**：热更新或重复调用 install 会把同一个 console.* 包好几层，
 *    一条日志被报 N 次、进缓冲 N 次。用模块级标记挡住。
 * 2. **我们自己的日志不算"要修的错"**：宿主写控制台通常是在汇报"我已经处理过的错误"，
 *    再拿它去问用户要不要修就是自寻烦恼。这类写入前后会调 beginInternalLog/endInternalLog
 *    （留档仍然留 —— Agent 想看的是控制台原样）。
 * 3. **要限流**：一个每帧都抛错/打日志的组件会在几秒内产生成百上千条，
 *    所以环形缓冲只保留最近若干条，节流交给 store。
 * 4. **单条要截断**：一条几万字符的日志会把提示框与上下文撑爆。
 */

export interface ConsoleErrorEvent {
  text: string;
  at: number;
}

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'debug' | 'error';

export interface ConsoleEntry {
  level: ConsoleLevel;
  text: string;
  at: number;
}

type Listener = (e: ConsoleErrorEvent) => void;

const listeners = new Set<Listener>();
let installed = false;
/** > 0 表示当前是"宿主自己在写日志"，这段里的错误不转出去。 */
let internalDepth = 0;

/** 宿主的日志写入，包住它就等于"别报这个错"。 */
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

/** 单条最多记这么长：再长对定位没帮助，反而把提示框和上下文撑爆。 */
const MAX_ERR_CHARS = 2000;
/** 环形缓冲上限：只留最近这些条。 */
export const MAX_CONSOLE_ENTRIES = 200;
/** 读的时候一次最多给这么多条。 */
const MAX_CONSOLE_READ = 200;

const ring: ConsoleEntry[] = [];

function stringify(args: unknown[]): string {
  const parts = args.map((a) => {
    if (a instanceof Error) return a.stack || a.message || String(a);
    if (typeof a === 'string') return a;
    if (typeof a === 'number' || typeof a === 'boolean' || a === null) return String(a);
    if (typeof a === 'undefined') return 'undefined';
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  });
  const text = parts.join(' ').trim();
  return text.length > MAX_ERR_CHARS ? text.slice(0, MAX_ERR_CHARS) + '…' : text;
}

/** 进环形缓冲（控制台原样留档，不看 internalDepth）。 */
function record(level: ConsoleLevel, text: string): void {
  const value = text.trim();
  if (!value) return;
  ring.push({ level, text: value.length > MAX_ERR_CHARS ? value.slice(0, MAX_ERR_CHARS) + '…' : value, at: Date.now() });
  while (ring.length > MAX_CONSOLE_ENTRIES) ring.shift();
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

/**
 * 读最近的控制台输出（时间正序）。
 *
 * `level` 只认那五档；给别的值（或没给）就是全部。
 */
export function readConsole(limit = 60, level?: string): ConsoleEntry[] {
  const want: ConsoleLevel | null =
    level === 'log' || level === 'info' || level === 'warn' || level === 'debug' || level === 'error' ? level : null;
  const list = want ? ring.filter((e) => e.level === want) : ring.slice();
  const n = Math.max(1, Math.min(MAX_CONSOLE_READ, Math.floor(limit) || 60));
  return list.slice(-n);
}

/** 清空留档（`inspect` 里的"清空"由用户/Agent 自己决定；这里只给操作留一个入口）。 */
export function clearConsole(): void {
  ring.length = 0;
}

export function consoleSize(): number {
  return ring.length;
}

const originals: Partial<Record<ConsoleLevel, (...args: unknown[]) => void>> = {};

/** 只给测试用：拆掉钩子并把 console.* 还原。 */
export function uninstallConsoleErrorHooks(): void {
  if (!installed) return;
  installed = false;
  for (const [level, fn] of Object.entries(originals)) {
    if (fn) (console as unknown as Record<string, unknown>)[level] = fn;
  }
  for (const k of Object.keys(originals)) delete (originals as Record<string, unknown>)[k];
}

export function installConsoleErrorHooks(): void {
  if (installed) return;
  installed = true;

  const levels: ConsoleLevel[] = ['log', 'info', 'warn', 'debug', 'error'];
  for (const level of levels) {
    const original = (console as unknown as Record<string, unknown>)[level];
    const bound = typeof original === 'function' ? (original as (...a: unknown[]) => void).bind(console) : null;
    originals[level] = bound ?? undefined;
    (console as unknown as Record<string, unknown>)[level] = (...args: unknown[]) => {
      bound?.(...args);
      const text = stringify(args);
      record(level, text);
      if (level === 'error') emit(text);
    };
  }

  window.addEventListener('error', (e) => {
    const err = (e as ErrorEvent).error;
    const text = err instanceof Error ? err.stack || err.message : (e as ErrorEvent).message || '未知错误';
    record('error', text);
    emit(text);
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = (e as PromiseRejectionEvent).reason;
    const text =
      '未处理的 Promise 拒绝：' + (reason instanceof Error ? reason.stack || reason.message : stringify([reason]));
    record('error', text);
    emit(text);
  });
}
