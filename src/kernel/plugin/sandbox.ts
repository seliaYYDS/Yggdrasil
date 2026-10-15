import { hostAllowed } from './package';

/**
 * 插件 js 工具的**隔离执行**。
 *
 * 安全模型（三句话）：
 * 1. 工具在 **Worker** 里跑，主页面读不到、也读不到主页面；
 * 2. 那个 Worker **自己没有网络**：进工具之前，全局的
 *    fetch / XMLHttpRequest / WebSocket / EventSource / importScripts 全部抹掉；
 * 3. 唯一的出口是 ~~ctx.fetch()~~ —— 它把请求发回主线程，由主线程**按插件的主机白名单**
 *    校验后代为执行，再把结果递回去。所以 js 工具和声明式端点受同一堵墙管着。
 *
 * 拿不到 Worker 时**拒绝执行**（而不是退回主线程裸跑）：
 * "隔离不了就不跑"比"偷偷不隔离"诚实。
 */
export interface SandboxJob {
  /** 工具源码：一个函数表达式（async (args, ctx) => ...）。 */
  source: string;
  args: Record<string, unknown>;
  /**
   * 工具在 ctx.fields 里能看到的字段。
   *
   * **调用方按安全等级过滤过了**：高/标准档把 secret 字段去掉（给空串）。
   * 沙箱自己不判断等级 —— 它拿到的就是允许看到的那一份。
   */
  fields: Record<string, string>;
  plugin: { id: string; name: string; version: string };
  timeoutMs: number;
  /** 允许 ctx.fetch 访问的主机（就是插件生效的那份白名单）。 */
  allowHosts: string[];
  /** 一次调用最多几次 ctx.fetch（安全等级决定；Infinity = 不限）。 */
  maxFetches?: number;
  /** 单次响应正文最多取多少字符（安全等级决定）。 */
  maxResponseBytes?: number;
  /** 工具日志单条上限（安全等级决定）。 */
  logChars?: number;
  /** 桥接出去的请求；默认用全局 fetch。测试里可以换成桩。 */
  fetchImpl?: typeof fetch;
  /**
   * 工作区桥。**沙箱本身不认识工作区** —— 它只把脚本的 workspace 调用转发出去，
   * 由调用方（workspace/run.ts）去读写真正的后端。
   *
   * 这样做的好处：沙箱保持"通用执行器"的身份（插件工具也可以复用它），
   * 而"哪个执行环境能碰工作区"变成一个显式开关 —— 插件工具**不给**这个桥，
   * 于是它们碰不到工作区（用户明确要求插件用不了）。
   */
  workspace?: (req: { op: string; name?: string; data?: unknown }) => Promise<unknown>;
  /** 日志上限之外，还要不要额外限制脚本能写多少文件（防止一次调用刷爆工作区）。 */
  maxWorkspaceWrites?: number;
  /**
   * 用户按"停止"时会被 abort。
   *
   * 一个脚本工具可能跑满整个 timeout（默认 8 秒，最长 30 秒），
   * 只靠"下一轮不再调用"是停不下来的 —— 必须真的把 Worker 终止掉。
   */
  signal?: AbortSignal;
}

export interface SandboxResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  logs: string[];
  fetches: number;
  /** true = 因为用户停止而结束（不是失败，不该报成错误）。 */
  stopped?: boolean;
}

/** 可注入的执行器：测试用它在 Node 里跑同一套协议（Node 没有 Worker）。 */
export type ToolExecutor = (job: SandboxJob) => Promise<SandboxResult>;

let injected: ToolExecutor | null = null;

export function setToolExecutor(fn: ToolExecutor | null): void {
  injected = fn;
}

/** 这个环境能不能安全地跑 js 工具。 */
export function toolSandboxKind(): 'injected' | 'worker' | 'unavailable' {
  if (injected) return 'injected';
  return typeof Worker === 'undefined' ? 'unavailable' : 'worker';
}

export async function runTool(job: SandboxJob): Promise<SandboxResult> {
  /*
   * 已经按过停止：一条都不跑。
   * 注意这个检查在**注入执行器之前** —— 测试里注入的执行器也该享受同样的语义。
   */
  if (job.signal?.aborted) return { ok: false, error: '已停止', logs: [], fetches: 0, stopped: true };
  if (injected) return injected(job);
  if (typeof Worker === 'undefined') {
    return {
      ok: false,
      error: '这个环境不支持隔离执行（没有 Worker），所以插件的 js 工具被停用了。声明式端点不受影响。',
      logs: [],
      fetches: 0,
    };
  }
  return runInWorker(job);
}

/** Worker 里的引导代码：抹掉网络能力，只留 ctx.fetch 这一个出口。 */
export const WORKER_SHIM = [
  'const pending = new Map();',
  'let seq = 0;',
  '// 配额：主线程也会独立计数（双保险），这里先在源头拦住。',
  'let fetched = 0;',
  'let quota = Infinity;',
  'let logCap = 400;',
  "self.addEventListener('message', async (e) => {",
  '  const m = e.data || {};',
  "  if (m.type === 'fetch-result' || m.type === 'ws-result') { const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m.result); } return; }",
  "  if (m.type !== 'run') return;",
  '  // 断网：唯一出口是 ctx.fetch（主线程校验主机后代跑）',
  '  /*',
  '   * ⚠ 这是一份**拒绝清单**，而且必须写全 —— 漏掉一个能联网的全局，整堵墙就形同虚设。',
  '   * 真实教训：最初只抹了 fetch / XHR / WebSocket / EventSource / importScripts，',
  '   * 漏掉了 **Worker** —— 于是工具可以 new Worker(URL.createObjectURL(new Blob([自己的代码])))：',
  '   * 嵌套 Worker 是全新作用域、**自带完整的 fetch**，而我的擦除只作用在外层。',
  '   * 这样就能绕开 ctx.fetch 与主机白名单，直接把密钥通过查询串发出去（no-cors 也能发）。',
  '   * 所以下面这份名单里，凡是"能发起网络请求"或"能让代码跑到别的作用域"的都要有。',
  '   */',
  '  const KILL = [',
  "    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'importScripts',",
  "    'Worker', 'SharedWorker', 'ServiceWorker', 'BroadcastChannel', 'MessageChannel',",
  "    'sendBeacon', 'Notification', 'Image', 'Request', 'Response',",
  "    'indexedDB', 'caches', 'openDatabase', 'localStorage', 'sessionStorage',",
  '  ];',
  '  for (const k of KILL) {',
  '    try { self[k] = undefined; } catch (err) { /* 有的全局不可写，忽略 */ }',
  '  }',
  '  // navigator.sendBeacon 是另一条能带上数据的出口，整块拿走。',
  '  try { if (typeof self.navigator !== "undefined") self.navigator = undefined; } catch (err) {}',
  '  try { if (typeof self.location !== "undefined") self.location = undefined; } catch (err) {}',
  '  quota = typeof m.maxFetches === "number" ? m.maxFetches : Infinity;',
  '  logCap = typeof m.logChars === "number" ? m.logChars : 400;',
  '  // 工作区桥：只有主线程显式打开时才有（插件工具拿不到它）。',
  '  const wsRpc = (op, payload) => new Promise((resolve, reject) => {',
  '    const id = ++seq;',
  '    pending.set(id, (r) => {',
  "      if (!r) return reject(new Error('工作区调用没有结果'));",
  '      if (r.error) return reject(new Error(r.error));',
  '      resolve(r);',
  '    });',
  "    self.postMessage({ type: 'ws', id, op, payload: payload || null });",
  '  });',
  '  const workspaceApi = m.hasWorkspace',
  '    ? {',
  '        list: () => wsRpc("list", null),',
  '        read: (name) => wsRpc("read", { name: String(name) }),',
  '        write: (name, data) => wsRpc("write", { name: String(name), data }),',
  '        delete: (name) => wsRpc("delete", { name: String(name) }),',
  '      }',
  '    : undefined;',
  '  const ctx = {',
  '    args: m.args,',
  '    fields: m.fields,',
  '    plugin: m.plugin,',
  '    workspace: workspaceApi,',
  "    log: (t) => self.postMessage({ type: 'log', text: String(t).slice(0, logCap) }),",
  '    fetch: (url, init) => new Promise((resolve, reject) => {',
  '      if (fetched >= quota) {',
  "        return reject(new Error('这次调用已经用完联网配额（' + quota + ' 个请求）。要更多就把设置里的安全等级调低一档。'));",
  '      }',
  '      fetched += 1;',
  '      const id = ++seq;',
  '      pending.set(id, (r) => {',
  "        if (!r) return reject(new Error('fetch 没有结果'));",
  "        if (r.error) return reject(new Error(r.error));",
  '        resolve(r);',
  '      });',
  "      self.postMessage({ type: 'fetch', id, url: String(url), init: init || null });",
  '    }),',
  '  };',
  '  try {',
  "    const fn = (0, eval)('(' + m.source + ')');",
  "    if (typeof fn !== 'function') throw new Error('工具源码必须是一个函数（形如 async (args, ctx) => {...}）');",
  '    let value = await fn(m.args, ctx);',
  '    value = value === undefined ? null : JSON.parse(JSON.stringify(value));',
  "    self.postMessage({ type: 'done', value });",
  '  } catch (err) {',
  "    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });",
  '  }',
  '});',
].join('\n');

/** 把一次 ctx.fetch 桥接到主线程：**这里是主机白名单真正生效的地方**。 */
export async function bridgeFetch(
  raw: string,
  init: unknown,
  allowHosts: string[],
  fetchImpl: typeof fetch,
  maxBytes = 200000,
  /** 用户按"停止"时把它交给 fetch —— 在途的那次请求会被真的断掉。 */
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: '不是合法地址：' + raw };
  }
  if (!/^https?:$/.test(url.protocol)) return { error: '只允许 http(s)：' + url.protocol };
  if (!hostAllowed(url.hostname, allowHosts)) {
    return { error: '插件不允许访问 ' + url.hostname + '（白名单：' + (allowHosts.join(', ') || '空') + '）' };
  }
  try {
    const res = await fetchImpl(url.href, { ...((init as RequestInit) || {}), ...(signal ? { signal } : {}) });
    const text = await res.text();
    // 工具拿到的正文也限制一下：不然一个 100MB 的响应会先炸内存再炸上下文。
    return { ok: res.ok, status: res.status, text: text.slice(0, maxBytes) };
  } catch (e) {
    // 中止不是"请求失败"：如实说停止，别让它看起来像网络故障。
    if (signal?.aborted) return { error: '已停止' };
    return { error: '请求 ' + url.hostname + ' 失败：' + (e as Error).message };
  }
}

async function runInWorker(job: SandboxJob): Promise<SandboxResult> {
  const fetchImpl = job.fetchImpl ?? fetch;
  const logs: string[] = [];
  let fetches = 0;

  const url = URL.createObjectURL(new Blob([WORKER_SHIM], { type: 'text/javascript' }));
  const worker = new Worker(url);
  return await new Promise<SandboxResult>((resolve) => {
    let settled = false;
    const finish = (r: SandboxResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      // 用户按了停止：把 Worker 直接 terminate（它可能正卡在一个长循环里）。
      job.signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve(r);
    };
    const onAbort = () => finish({ ok: false, error: '已停止', logs, fetches, stopped: true });
    job.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = window.setTimeout(() => {
      finish({ ok: false, error: '执行超时（' + job.timeoutMs + 'ms），已终止。', logs, fetches });
    }, job.timeoutMs);

    worker.onmessage = (e: MessageEvent) => {
      void (async () => {
      const m = (e.data || {}) as Record<string, unknown>;
      if (m.type === 'log') {
        // 主线程侧也按等级截一次（Worker 侧已截，这里是双保险）
        logs.push(String(m.text).slice(0, job.logChars ?? 400));
        return;
      }
      if (m.type === 'ws') {
        // 工作区调用：交给注入的桥（沙箱不知道工作区是什么）。
        if (!job.workspace) {
          worker.postMessage({ type: 'ws-result', id: m.id, result: { error: '这个执行环境没有工作区访问权限。' } });
          return;
        }
        try {
          const result = await job.workspace({ op: String(m.op), ...(m.payload || {}) } as never);
          worker.postMessage({ type: 'ws-result', id: m.id, result });
        } catch (e) {
          worker.postMessage({ type: 'ws-result', id: m.id, result: { error: (e as Error).message } });
        }
        return;
      }
      if (m.type === 'fetch') {
        fetches += 1;
        // 双保险：Worker 侧已经拦过配额，这里再拦一次（万一 shim 没生效）。
        const overQuota = job.maxFetches !== undefined && fetches > job.maxFetches;
        const result = overQuota
          ? { error: '这次调用已经用完联网配额（' + job.maxFetches + ' 个请求）。' }
          : await bridgeFetch(String(m.url), m.init, job.allowHosts, fetchImpl, job.maxResponseBytes, job.signal);
        worker.postMessage({ type: 'fetch-result', id: m.id, result });
        return;
      }
      if (m.type === 'done') return finish({ ok: true, value: m.value, logs, fetches });
      if (m.type === 'error') return finish({ ok: false, error: String(m.message), logs, fetches });
      })();
    };
    worker.onerror = (e: ErrorEvent) => finish({ ok: false, error: 'Worker 出错：' + (e.message || '未知'), logs, fetches });

    worker.postMessage({
      type: 'run',
      source: job.source,
      args: job.args,
      fields: job.fields,
      plugin: job.plugin,
      maxFetches: job.maxFetches ?? Infinity,
      logChars: job.logChars ?? 400,
      hasWorkspace: !!job.workspace,
    });
  });
}
