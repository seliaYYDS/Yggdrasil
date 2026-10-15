import type { DerivationOp } from '../types';
import { fail, ok, str, strOr, type OpContext, type OpResult } from '../bus/opContext';
import { listInterfaces, registerInterface, unregisterInterface } from '../registry/interfaceRegistry';
import { hostAllowed, versionAtLeast } from './package';
import { runTool, toolSandboxKind } from './sandbox';
import { registerTool, unregisterPluginTools } from '../registry/toolRegistry';
import { policyFor, type SecurityPolicy } from '../security';
import { useDesktopStore } from '../../store/desktopStore';
import type { InstalledPlugin, PluginEndpoint, PluginTool } from './types';
import type { PluginPage, PluginPromptPatch } from '../types';

/**
 * 插件的运行时：把插件的端点变成**普通接口**，并执行它们的 HTTP 调用。
 *
 * 为什么变成普通接口，而不是另立一套"插件调用"：
 * 这样能力开关、按能力裁剪提示词、参数校验、成败回读、账本记录全部自动复用 ——
 * 模型也不用学新格式，它看到的就是又多了一个能干活的 kind。
 *
 * 出口墙在 httpCall 里：地址模板来自清单（模型碰不到），最终地址的主机必须落在
 * 插件的 hosts 白名单里。模型只能给声明过的参数值，所以它没法把这个插件当跳板去打别处。
 */

/** 当前已安装且**已启用**的插件（plugin_docs 与提示词都读它）。 */
let current: InstalledPlugin[] = [];

/** 当前安全策略（从设置里读；设置坏了就按默认档）。 */
export function securityPolicy(): SecurityPolicy {
  return policyFor(useDesktopStore.getState().settings.securityLevel);
}

/**
 * 工具能看到的字段：按等级决定要不要把 secret 字段抹掉。
 *
 * 抹成空串而不是删掉键 —— 这样插件写 ctx.fields.token 仍然是字符串，
 * 不会因为"键不存在"而抛错或走进奇怪的 else 分支，行为只是"没配"。
 */
export function visibleFields(plugin: InstalledPlugin, policy: SecurityPolicy): Record<string, string> {
  if (policy.exposeSecretsToTools) return { ...plugin.values };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(plugin.values)) {
    const field = plugin.fields.find((f) => f.key === k);
    out[k] = field?.secret ? '' : v;
  }
  return out;
}

export function pluginKind(pluginId: string, name: string): string {
  return pluginId + '.' + name;
}

/**
 * 把可用插件换成这一份（先全部撤掉再登记，幂等）。
 *
 * 每个插件贡献**两个可能**的入口，互不影响：
 * - 端点与 `exposeAs: 'op'` 的工具 → 注册成 **op**（`<插件id>.<名字>`），模型直接调用；
 * - `exposeAs: 'tool'` 的工具 → 注册进**工具表**，出现在 `## Available tools`，用 `call_tool` 调。
 *
 * 撤销时两边都要按 pluginId 扫干净 —— 只撤一边就会出现"卸载了但还能调"。
 */
export function syncPluginRuntime(plugins: InstalledPlugin[]): void {
  const ids = new Set([...current, ...plugins].map((p) => p.id));
  for (const id of ids) {
    unregisterPluginInterfaces(id);
    unregisterPluginTools(id);
  }
  current = plugins.filter((p) => p.enabled);
  for (const p of current) {
    for (const e of p.endpoints) registerEndpoint(p, e);
    for (const t of p.tools ?? []) {
      if (t.exposeAs === 'tool') registerPluginTool(p, t);
      else registerToolInterface(p, t);
    }
  }
}

export function enabledPlugins(): InstalledPlugin[] {
  return current;
}

export function allKnownPlugins(): InstalledPlugin[] {
  return current;
}
/**
 * 已启用插件声明的**系统提示词补丁**，按"插件安装顺序 → 插件内声明顺序"展平。
 *
 * 顺序**必须稳定**：系统提示是缓存前缀，顺序一变整段缓存就失效。所以这里不排序、
 * 不按字母序，就按声明顺序来。
 *
 * 另外给每条补上 pluginId 与 index —— 调用方要用它给插进去的段落一个稳定 id
 * （多个插件插在同一锚点上时，各自成段、互不覆盖）。
 */
export function promptPatches(): (PluginPromptPatch & { pluginId: string; index: number })[] {
  const out: (PluginPromptPatch & { pluginId: string; index: number })[] = [];
  for (const p of current) {
    const list = p.prompts ?? [];
    for (let i = 0; i < list.length; i += 1) out.push({ ...list[i], pluginId: p.id, index: i });
  }
  return out;
}

/** 一个页面 + 它属于哪个插件（渲染与工具栏都要这两样）。 */
export interface PluginPageHost {
  plugin: InstalledPlugin;
  page: PluginPage;
}

/** 已启用插件的**全部页面**（工具栏按钮 + 常驻窗口）。 */
export function pluginPages(): PluginPageHost[] {
  const out: PluginPageHost[] = [];
  for (const p of current) for (const page of p.pages ?? []) out.push({ plugin: p, page });
  return out;
}

/** 插件页面的窗口 id。用 page- 前缀与内置面板的 panel- 区分开。 */
export function pluginPageWindowId(pluginId: string, pageId: string): string {
  return 'page-' + pluginId + '.' + pageId;
}

/** 页面在 store 里的键（几何与开合都按它存）。 */
export function pluginPageKey(pluginId: string, pageId: string): string {
  return pluginId + '.' + pageId;
}

/** 从窗口 id 反解出页面（任务栏标题、渲染时都要用）。找不到说明插件已被关掉/卸载。 */
export function pageFromWindowId(windowId: string): PluginPageHost | null {
  if (!windowId.startsWith('page-')) return null;
  const key = windowId.slice('page-'.length);
  const dot = key.indexOf('.');
  if (dot < 0) return null;
  const pluginId = key.slice(0, dot);
  const pageId = key.slice(dot + 1);
  return pluginPages().find((x) => x.plugin.id === pluginId && x.page.id === pageId) ?? null;
}

/**
 * 撤掉一个插件登记过的所有接口。
 *
 * 直接扫注册表按 pluginId 匹配，而不是从 current 里反推名字 ——
 * 之前只撤端点、忘了 js 工具，结果"卸载了但工具还能调"。按来源扫就不会漏。
 */
function unregisterPluginInterfaces(pluginId: string): void {
  for (const def of listInterfaces()) {
    if (def.pluginId === pluginId) unregisterInterface(def.kind);
  }
}

/**
 * 生效的主机白名单 = 清单里的静态条目 + 用户填的地址解析出来的主机。
 *
 * 自建服务这类插件的主机只能来自用户："http://127.0.0.1:3000" 只在这一刻才知道。
 * 注意：这仍然是**用户自己填的值**，插件改不了它，所以出口墙没有被拆掉。
 */
export function effectiveHosts(plugin: InstalledPlugin): string[] {
  const out: string[] = [];
  for (const h of plugin.hosts) {
    const ref = h.match(/^\{config:([a-zA-Z][a-zA-Z0-9_]{0,30})\}$/);
    if (!ref) { out.push(h); continue; }
    const field = plugin.fields.find((x) => x.key === ref[1]);
    const raw = (plugin.values[ref[1]] ?? field?.default ?? '').trim();
    if (!raw) continue;
    try {
      // 可以是完整地址，也可以只写主机名。
      out.push(new URL(raw.includes('://') ? raw : 'http://' + raw).hostname.toLowerCase());
    } catch {
      /* 填得不成形就当它没有 —— 下面的缺失字段检查会把它报出来 */
    }
  }
  return out;
}

/** 模板里引用了、但用户还没填的字段（要给出"去面板里填 XXX"这种能照做的错误）。 */
function missingFields(plugin: InstalledPlugin, e: PluginEndpoint): string[] {
  const texts = [e.url, ...Object.values(e.headers ?? {})].join(' ');
  const keys = [...texts.matchAll(/\{config:([a-zA-Z][a-zA-Z0-9_]{0,30})\}/g)].map((m) => m[1]);
  const missing: string[] = [];
  for (const key of new Set(keys)) {
    const field = plugin.fields.find((x) => x.key === key);
    // 只拦"必填但没填"的。可选的字段（例如 Cookie）留空是正常用法，不该挡住调用。
    if (!field?.required) continue;
    const value = (plugin.values[key] ?? field.default ?? '').trim();
    if (!value) missing.push(field.label);
  }
  return missing;
}

/** 用清单里的字段模板渲染字符串（url / headers 里的 {config:key}）。 */
function renderTemplate(
  text: string,
  plugin: InstalledPlugin,
  params: Record<string, string>,
  encode: boolean,
): string {
  return text.replace(/\{([^}]+)\}/g, (_all, key: string) => {
    let value: string;
    if (key.startsWith('config:')) {
      const field = key.slice(7);
      /*
       * **同名参数优先于用户填的值。**
       *
       * 这次实测暴露的问题：搜索返回 0 条，而"市场"是个用户配置字段 —— 模型看得见、改不了，
       * 于是只能瞎猜到放弃。允许参数覆盖配置之后，它就能自己换一个市场再试。
       */
      const explicit = params[field];
      if (explicit !== undefined && explicit !== '') {
        value = explicit;
      } else {
        const f = plugin.fields.find((x) => x.key === field);
        value = plugin.values[field] ?? f?.default ?? '';
      }
      /*
       * url 类型的字段**原样插入**：把 http://localhost:3000 编码成 http%3A%2F%2F... 就废了。
       * 顺手去掉结尾斜杠，这样模板里写 {config:base_url}/search 不会变成 //search。
       */
      const asUrl = plugin.fields.find((x) => x.key === key.slice(7))?.type === 'url';
      if (asUrl) return value.trim().replace(/\/+$/, '');
    } else {
      value = params[key] ?? '';
    }
    return encode ? encodeURIComponent(value) : value;
  });
}

/**
 * 按点路径从响应里挑字段（数组段末尾加 []）。
 *
 * 存在的理由很具体：一次搜索的原始响应动辄十几 KB，全塞进观察就等于把上下文烧掉，
 * 截断又会切出坏 JSON 让模型没法解析。挑字段是"声明式"这条路能真正好用的关键一步。
 */
export function pickPaths(data: unknown, paths: string[], maxItems = 10): Record<string, unknown> {
  const walk = (value: unknown, segs: string[]): unknown => {
    if (segs.length === 0) return value;
    const head = segs[0];
    const rest = segs.slice(1);
    const map = head.endsWith('[]');
    const key = map ? head.slice(0, -2) : head;
    const next =
      key === '' ? value : value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    if (map) {
      if (!Array.isArray(next)) return [];
      return next.slice(0, maxItems).map((item) => walk(item, rest));
    }
    return walk(next, rest);
  };
  const out: Record<string, unknown> = {};
  for (const p of paths) out[p] = walk(data, p.split('.'));
  return out;
}

function clip(text: string, maxChars: number): { text: string; note: string } {
  if (text.length <= maxChars) return { text, note: '' };
  return {
    text: text.slice(0, maxChars),
    note: '\n... (response truncated: ' + text.length + ' chars in total, first ' + maxChars + ' returned)',
  };
}

/**
 * 收集模型给的参数：只认声明过的名字，缺省的用 default，必填缺了就报错。
 *
 * `allowStructured`：允许对象/数组，并把它 **JSON.stringify 后**交给工具。
 * 只有 **tool 形态**才开这个口子 —— 工具是在沙箱里跑 JS，收到一段 JSON 文本是很自然的输入
 * （json_query 就是靠它才能让模型直接把对象传进来，而不用自己先手写转义）。
 * 声明式端点不开：那里的参数要嵌进 URL 或请求体，把对象塞进去只会得到双重编码。
 */
function collectParams(
  e: PluginEndpoint,
  op: DerivationOp,
  allowStructured = false,
): { ok: true; params: Record<string, string> } | { ok: false; error: string } {
  const params: Record<string, string> = {};
  for (const p of e.params ?? []) {
    const raw = (op as Record<string, unknown>)[p.name];
    if (raw === undefined || raw === null || raw === '') {
      if (p.default !== undefined) { params[p.name] = p.default; continue; }
      if (p.required) return { ok: false, error: '缺少参数 ' + p.name + '（' + p.description + '）' };
      params[p.name] = '';
      continue;
    }
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      if (allowStructured && typeof raw === 'object' && raw !== null) {
        // 对象/数组原样序列化成文本：工具那边 JSON.parse 就得到结构，模型不必自己转义。
        params[p.name] = JSON.stringify(raw);
        continue;
      }
      return {
        ok: false,
        error: '参数 ' + p.name + ' 只能是字符串、数字或布尔值' + (allowStructured ? '，或者对象/数组' : '') + '。',
      };
    }
    params[p.name] = String(raw);
  }
  return { ok: true, params };
}

/**
 * 真正发请求。任何一步不合规都**先拒绝再解释**：主机不在白名单、参数缺失、
 * 地址模板渲染后不合法 —— 全部在 fetch 之前拦住。
 */
export async function httpCall(
  plugin: InstalledPlugin,
  e: PluginEndpoint,
  op: DerivationOp,
  fetchImpl: typeof fetch = fetch,
): Promise<OpResult> {
  const missing = missingFields(plugin, e);
  if (missing.length) {
    // 报"去插件面板填 XXX"，而不是让它以一个莫名其妙的 URL 报错。
    return fail('这个插件还没配好：请在插件面板里填写「' + missing.join('」「') + '」。');
  }
  const collected = collectParams(e, op);
  if (!collected.ok) return fail(collected.error);
  const params = collected.params;

  const urlText = renderTemplate(e.url, plugin, params, true);
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    return fail('插件 ' + plugin.id + ' 的地址模板渲染后不是合法地址：' + urlText);
  }
  if (!hostAllowed(url.hostname, effectiveHosts(plugin))) {
    // 正常走不到这里（清单校验时已经查过），但执行时再查一次：清单是数据，数据可能被改过。
    return fail(
      '插件 ' + plugin.id + ' 不允许访问 ' + url.hostname +
        '（白名单：' + (effectiveHosts(plugin).join(', ') || '空 —— 去插件面板填写 API 地址') + '）。',
    );
  }

  const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.9, */*;q=0.8' };
  for (const [k, v] of Object.entries(e.headers ?? {})) {
    /*
     * 头里引用了**没填**的字段就整条丢掉。
     *
     * 这是"可选鉴权"能成立的关键：'Bearer {config:token}' 在没填 token 时会被渲染成 'Bearer '，
     * 服务端会把它当无效令牌直接拒（而不是当匿名请求）—— 那样不填 token 就用不了了。
     */
    const refs = [...v.matchAll(/\{config:([a-zA-Z][a-zA-Z0-9_]{0,30})\}/g)].map((m) => m[1]);
    const blank = refs.some((key) => {
      const f = plugin.fields.find((x) => x.key === key);
      return !((plugin.values[key] ?? f?.default ?? '').trim());
    });
    if (blank) continue;
    headers[k] = renderTemplate(v, plugin, params, false);
  }

  const method = e.method ?? 'GET';
  const init: RequestInit = { method, headers };
  if (method === 'POST') {
    headers['content-type'] = headers['content-type'] ?? 'application/json';
    /*
     * 默认全放，但清单可以用 body: ["title"] 指定**只把这些参数放进 JSON 体**。
     * 需要它是因为路径参数（owner / repo 之类）不属于请求体，
     * 混进去虽然多数服务端会忽略，但写清楚更不容易踩到"未知字段就报错"的 API。
     */
    const keys = e.body && e.body.length ? e.body : Object.keys(params);
    const payload: Record<string, string> = {};
    for (const k of keys) if (params[k] !== undefined) payload[k] = params[k];
    init.body = JSON.stringify(payload);
  }

  let res: Response;
  try {
    res = await fetchImpl(url.href, init);
  } catch (e2) {
    return fail(
      'Calling ' + url.hostname + ' failed: ' + (e2 as Error).message +
        '。若是浏览器拦下的跨域请求，那是主机端不允许页面读取（CORS），插件与页面都无法绕过；' +
        '换一个允许跨域的主机，或者接受拿不到返回。',
    );
  }

  const body = await res.text().catch(() => '');
  /*
   * 有 pick 就先解析再挑字段：观察里只留模型真正要用的东西。
   * 解析失败（不是 JSON）就退回原文 —— 插件返回 HTML/纯文本也是合法的。
   */
  let shown = body;
  let pickedNote = '';
  if (e.pick && e.pick.length && body.trim()) {
    try {
      const picked = pickPaths(JSON.parse(body), e.pick);
      shown = JSON.stringify(picked, null, 1);
      pickedNote = '\n(picked fields; the full response was ' + body.length + ' chars)';
      /*
       * 最难查的一类失败：**挑的路径一个都没命中**，但正文其实很大。
       * 这时回读看起来像"没有结果"，模型会得出错误结论（"没搜到"而不是"插件写错了"）。
       * 所以明确区分这两种情况。
       */
      const values = Object.values(picked);
      const allEmpty = values.length > 0 && values.every((v) => (Array.isArray(v) ? v.length === 0 : v === null || v === undefined));
      if (allEmpty && body.length > 200) {
        pickedNote += '\n⚠ 正文有内容但挑出来的字段全是空的：多半是响应结构与插件里写的 pick 路径不一致（不是"没搜到"）。请把这条如实告诉用户。';
      }
    } catch {
      shown = body;
    }
  }
  /*
   * 空结果要**明说**：只挑字段之后，"0 条"和"字段名挑错了"在回读里长得一模一样，
   * 而模型最需要的信息恰恰是"这次真的什么都没搜到"。
   */
  let emptyNote = '';
  if (e.emptyHint && shown.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(shown) as Record<string, unknown>;
      const values = Object.values(obj);
      const zeroCount = typeof obj.resultCount === 'number' && obj.resultCount === 0;
      const allEmpty = values.length > 0 && values.every((v) => Array.isArray(v) ? v.length === 0 : v === null);
      if (zeroCount || allEmpty) emptyNote = '\n' + e.emptyHint;
    } catch {
      /* 挑出来的不是对象就跳过 */
    }
  }
  const clipped = clip(shown, e.maxChars ?? 8000);
  const head = plugin.name + ' · ' + (e.label || e.name) + ' · HTTP ' + res.status;
  if (!res.ok) {
    return fail(head + '。返回正文：\n' + clipped.text.slice(0, 1000));
  }
  return ok(head, {
    observation:
      'HTTP ' + res.status + ' from ' + url.hostname + '：\n' + clipped.text + clipped.note + pickedNote + emptyNote,
  });
}

/** 把一个插件的所有端点登记成接口。 */
function registerEndpoint(plugin: InstalledPlugin, e: PluginEndpoint): void {
  const kind = pluginKind(plugin.id, e.name);
  registerInterface({
    kind,
    label: e.label,
    description: '[' + plugin.name + '] ' + e.description,
    example: e.example ?? defaultExample(kind, e),
    mutates: e.mutates === true,
    cap: e.cap === null ? undefined : e.cap ?? 'net',
    pluginId: plugin.id,
    handler: (op: DerivationOp, _ctx: OpContext) => httpCall(plugin, e, op),
  });
}

/** 插件没给 example 时自己造一个：**kind 必须是真 kind**，否则等于教模型写错。 */
/**
 * 把一个 js 工具登记成接口。
 *
 * 与声明式端点唯一的区别是"怎么算出来"：端点是拼地址发请求，工具是丢进 Worker 里跑。
 * 校验、能力开关、账本、回读、截断这些全都一样 —— 模型不需要知道某个 op 背后是哪种。
 */
function registerToolInterface(plugin: InstalledPlugin, tool: PluginTool): void {
  const kind = pluginKind(plugin.id, tool.name);
  registerInterface({
    kind,
    label: tool.label,
    description: '[' + plugin.name + ' · js 工具] ' + tool.description,
    example: tool.example ?? defaultToolExample(kind, tool),
    mutates: tool.mutates === true,
    cap: tool.cap === null ? undefined : tool.cap ?? 'net',
    pluginId: plugin.id,
    // op 形态与 tool 形态共用同一段执行（配额 / 白名单 / 密钥遮蔽 / 截断都必须一致）。
    handler: (op: DerivationOp): Promise<OpResult> => executePluginTool(plugin, tool, op),
  });
}

/**
 * 跑一个插件的 js 工具。**op 形态与 tool 形态共用这段** —— 两条路只是"模型怎么发现它"不同，
 * 执行、配额、密钥遮蔽、白名单、截断必须完全一致，否则同一份代码会因为注册方式不同而松紧不同。
 */
async function executePluginTool(plugin: InstalledPlugin, tool: PluginTool, args: unknown): Promise<OpResult> {
  const source = plugin.files[tool.file];
  if (!source) return fail('插件包里找不到 ' + tool.file + '（装的时候没带进来？）。');
  const policy = securityPolicy();
  /*
   * 高安全档直接不执行 —— 连"限制着跑"都不做。
   * 理由：js 工具的价值是"声明式表达不了的那点逻辑"，在最高安全档下，
   * "代码来自别人"这件事本身就不该被接受；声明式端点不受影响（那是数据不是代码）。
   */
  if (!policy.allowPluginTools) {
    return fail(
      '当前安全等级是「' + policy.label + '」，**禁止执行插件自带的 js 工具**。' +
        '要用它请在设置里把安全等级降到「标准」或更低；声明式端点不受影响。',
    );
  }
  const asOp = (args ?? {}) as Record<string, unknown>;
  // 工具允许结构化参数（见 collectParams 的说明）。
  const collected = collectParams({ params: tool.params ?? [] } as PluginEndpoint, asOp as DerivationOp, true);
  if (!collected.ok) return fail(collected.error);
  const res = await runTool({
    source,
    args: collected.params,
    // **密钥遮蔽**：不给工具看 secret 字段（等级决定），它拿到的就是允许看到的那份。
    fields: visibleFields(plugin, policy),
    plugin: { id: plugin.id, name: plugin.name, version: plugin.version },
    timeoutMs: tool.timeoutMs ?? 8000,
    allowHosts: effectiveHosts(plugin),
    maxFetches: policy.fetchPerCall,
    maxResponseBytes: policy.responseBytes,
    logChars: policy.logChars,
  });
  const head = plugin.name + ' · ' + tool.label;
  if (!res.ok) {
    return fail(head + ' 执行失败：' + (res.error ?? '未知错误') + (res.logs.length ? '\n日志：' + res.logs.join(' / ') : ''));
  }
  const text = typeof res.value === 'string' ? res.value : JSON.stringify(res.value, null, 1);
  const clipped = clip(text ?? 'null', 12000);
  return ok(head + ' · ok', {
    observation:
      clipped.text + clipped.note + (res.logs.length ? '\n(log: ' + res.logs.join(' / ') + ')' : ''),
  });
}

/**
 * 把一个插件工具注册成**真工具**（进工具表，走 call_tool）。
 *
 * 与 `registerToolInterface`（op 形态）的区别只有入口：
 * - 这里进 `## Available tools`，模型看得见参数 schema，用 call_tool 调；
 * - 那里注册成一个 op，模型在本轮指令里直接写 kind。
 *
 * 两条路最终都落到 `executePluginTool`，所以配额、白名单、密钥遮蔽、截断完全一致。
 *
 * ⚠ `cap` 必须带上（见 toolRegistry 的说明）：插件工具默认是 net —— 一个拿不到联网能力
 * 的 Agent 不该因为插件装了就能发请求。call_tool 会在执行前按它拒绝。
 */
function registerPluginTool(plugin: InstalledPlugin, tool: PluginTool): void {
  const id = pluginKind(plugin.id, tool.name);
  registerTool({
    id,
    name: tool.name,
    // 工具目录里展示的说明：带上插件名前缀，模型才知道这是谁的、从哪来的。
    description: '[' + plugin.name + '] ' + tool.description,
    paramsSchema: pluginToolSchema(tool),
    source: plugin.files[tool.file] ?? '',
    builtin: false,
    pluginId: plugin.id,
    cap: tool.cap === null ? undefined : tool.cap ?? 'net',
    run: async (args) => {
      const res = await executePluginTool(plugin, tool, args);
      if (!res.ok) throw new Error(res.message || 'plugin tool failed');
      return res.observation ?? '';
    },
  });
}

/**
 * 工具的参数 schema：插件给了就用它，没给就按 `params` 生成一个。
 *
 * 自动生成的那份只保证**字段名与必填**正确 —— 类型信息不在 `PluginParam` 里
 * （声明式端点的参数本来就是字符串模板）。够模型把参数名写对，这正是最容易错的地方。
 */
export function pluginToolSchema(tool: PluginTool): Record<string, unknown> {
  if (tool.paramsSchema) return tool.paramsSchema;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of tool.params ?? []) {
    properties[p.name] = { type: 'string', description: p.description };
    if (p.required) required.push(p.name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
  };
}

function defaultToolExample(kind: string, tool: PluginTool): Record<string, unknown> {
  const out: Record<string, unknown> = { kind };
  for (const p of tool.params ?? []) out[p.name] = p.default ?? (p.required ? '<' + p.name + '>' : '');
  return out;
}

function defaultExample(kind: string, e: PluginEndpoint): Record<string, unknown> {
  const out: Record<string, unknown> = { kind };
  for (const p of e.params ?? []) out[p.name] = p.default ?? (p.required ? '<' + p.name + '>' : '');
  return out;
}

/**
 * 插件文档：**按需**读。
 *
 * 提示词里每个插件只占一行，用法在 guide.md 里 —— 想用某个插件时再调这个接口把指南拿回来。
 * 不这么做的话，装几个插件就等于每轮都给模型塞几千字，而且会把这些文字插进缓存前缀里。
 */
export function registerPluginDocsInterface(): void {
  registerInterface({
    kind: 'plugin_docs',
    label: '读插件指南',
    description:
      'Read the usage guide of an installed plugin (its guide.md) plus the exact parameters of its operations and tools. Call this before using a plugin you have not used yet — the prompt only lists plugin names, their operations and their tool names. Note the two ways a plugin gives you something to call: **operations** (use them directly, kind = <plugin id>.<name>) and **tools** (already listed under "Available tools"; call them with call_tool). Pass id, or omit it to list the installed plugins.',
    example: { kind: 'plugin_docs', id: 'music-search' },
    cap: null as never,
    handler: (op: DerivationOp): OpResult => {
      const id = strOr(op.id, '');
      if (!id) {
        if (current.length === 0) return ok('No plugin is installed and enabled.');
        return ok(
          current.length + ' plugin(s) enabled',
          {
            observation: current
              .map((p) => '- ' + p.id + ' — ' + p.name + ' v' + p.version + ': ' + p.description)
              .join('\n'),
          },
        );
      }
      const plugin = current.find((p) => p.id === id);
      if (!plugin) {
        return fail(
          'No enabled plugin with id "' + id + '". Enabled: ' + (current.map((p) => p.id).join(', ') || '(none)'),
        );
      }
      const ops = plugin.endpoints
        .map((e) => {
          const ps = (e.params ?? [])
            .map((p) => p.name + (p.required ? ' (required)' : '') + ' — ' + p.description)
            .join('; ');
          return '- ' + pluginKind(plugin.id, e.name) + ': ' + e.description + (ps ? '\n    params: ' + ps : '');
        })
        .join('\n');
      const tools = (plugin.tools ?? [])
        .map((t) => {
          const ps = (t.params ?? [])
            .map((p) => p.name + (p.required ? ' (required)' : '') + ' — ' + p.description)
            .join('; ');
          return '- ' + pluginKind(plugin.id, t.name) + ' (js tool): ' + t.description + (ps ? '\n    params: ' + ps : '');
        })
        .join('\n');
      const uis = (plugin.ui ?? [])
        .map((u) => '- ' + u.name + ': ' + u.description + (u.dataDoc ? '\n    data: ' + u.dataDoc : ''))
        .join('\n');
      const sandboxNote =
        (plugin.tools ?? []).length > 0 && toolSandboxKind() === 'unavailable'
          ? '\n\n⚠ 这个环境不支持隔离执行（没有 Worker），所以上面的 js 工具被停用了。'
          : '';
      const guide = str(plugin.guide).trim();
      return ok('Guide of ' + plugin.name, {
        observation:
          '# Plugin ' + plugin.name + ' (id: ' + plugin.id + ', v' + plugin.version + ')\n' +
          plugin.description + '\n\n' +
          '## Operations\n' +
          ops +
          (tools ? '\n\n## JS tools\n' + tools : '') +
          (uis ? '\n\n## Interfaces this plugin can put on screen\n' + uis : '') +
          sandboxNote +
          (guide ? '\n\n## Guide\n' + guide : '\n\n(no guide.md in this plugin)'),
      });
    },
  });
}

/**
 * 升级前后的权限差异。
 *
 * 为什么必须有：插件是"软件"，升级等于换一份别人写的代码。
 * 用户点"安装"时的授权是针对**上一版**给的；这一版多要了一个主机、多了一个端点，
 * 必须再讲一遍 —— 否则"升级"就成了绕过授权的通道。
 */
export function pluginDiff(prev: InstalledPlugin | undefined, next: InstalledPlugin): string[] {
  if (!prev) return [];
  const lines: string[] = [];
  const add = (list: string[], what: string, isNew: (x: string) => boolean) => {
    const newly = list.filter(isNew);
    if (newly.length) lines.push('新增' + what + '：' + newly.join('、'));
  };
  const gone = (list: string[], what: string, isGone: (x: string) => boolean) => {
    const removed = list.filter(isGone);
    if (removed.length) lines.push('移除' + what + '：' + removed.join('、'));
  };
  add(next.hosts, '可访问的主机', (h) => !prev.hosts.includes(h));
  gone(prev.hosts, '可访问的主机', (h) => !next.hosts.includes(h));
  add(next.endpoints.map((e) => e.name), '操作', (n) => !prev.endpoints.some((e) => e.name === n));
  gone(prev.endpoints.map((e) => e.name), '操作', (n) => !next.endpoints.some((e) => e.name === n));
  /*
   * 工具按**形态**分开报：op 形态与 tool 形态对用户的含义不同 ——
   * 前者是"又多了一个能调的操作"，后者是"又给 Agent 加了一个工具"（会进它的工具目录）。
   * 尤其重要的是**形态可以变**（同一个名字从 op 改成 tool），那也是一次权限变化。
   */
  const toolLabel = (t: { name: string; exposeAs?: 'op' | 'tool' }) =>
    t.name + (t.exposeAs === 'tool' ? '（工具）' : '（操作）');
  const byName = (p: InstalledPlugin) => new Map((p.tools ?? []).map((t) => [t.name, t]));
  const prevTools = byName(prev);
  const nextTools = byName(next);
  add((next.tools ?? []).map(toolLabel), 'js 工具', (label) => {
    // 名字或形态任一变了就算"新增"（形态变了会在下面再报一次"移除"旧形态）。
    const t = nextTools.get(label.replace(/（.*）$/, ''));
    const old = t ? prevTools.get(t.name) : undefined;
    return !old || (old.exposeAs === 'tool') !== (t?.exposeAs === 'tool');
  });
  gone((prev.tools ?? []).map(toolLabel), 'js 工具', (label) => {
    const name = label.replace(/（.*）$/, '');
    const t = nextTools.get(name);
    const old = prevTools.get(name);
    return !t || (old?.exposeAs === 'tool') !== (t.exposeAs === 'tool');
  });
  add((next.ui ?? []).map((u) => u.name), '自带界面', (n) => !(prev.ui ?? []).some((u) => u.name === n));
  /*
   * **提示词补丁与页面的差异必须单独报。**
   *
   * 它们是"这个版本开始会改变 Agent 行为 / 往界面加东西"的信号 —— 而升级最容易
   * 被当成"无关紧要的更新"点掉。只报新增的主机与端点是不够的：一个插件完全可以在
   * 不新增任何网络出口的情况下，靠插一段提示词改变 Agent 的行为。
   */
  const patchKey = (p: { op: string; anchor?: string; section?: string; text?: string; find?: string; replace?: string }) =>
    p.op +
    '@' +
    (p.op === 'insert' ? p.anchor ?? 'end' : p.op === 'substitute' ? (p.find ?? '') + '→' + (p.replace ?? '') : p.section ?? '?') +
    ':' +
    (p.text ?? '').slice(0, 40);
  const prevPatches = new Set((prev.prompts ?? []).map(patchKey));
  const nextPatches = new Set((next.prompts ?? []).map(patchKey));
  const newPatches = (next.prompts ?? []).filter((p) => !prevPatches.has(patchKey(p)));
  const gonePatches = (prev.prompts ?? []).filter((p) => !nextPatches.has(patchKey(p)));
  if (newPatches.length) lines.push('**新增/改动了 Agent 提示词**：' + newPatches.length + ' 处');
  if (gonePatches.length) lines.push('移除了提示词改动：' + gonePatches.length + ' 处');
  add((next.pages ?? []).map((p) => p.label), '页面', (n) => !(prev.pages ?? []).some((p) => p.label === n));
  gone((prev.pages ?? []).map((p) => p.label), '页面', (n) => !(next.pages ?? []).some((p) => p.label === n));
  add((next.fields ?? []).filter((f) => f.secret).map((f) => f.label), '要填的密钥', (l) => !(prev.fields ?? []).some((f) => f.secret && f.label === l));
  // 能力开关变了也要说：从 net 变成 global 是完全不同的事。
  const capOf = (p: InstalledPlugin) => {
    const set = new Set<string>();
    for (const e of p.endpoints) if (e.cap) set.add(e.cap);
    for (const t of p.tools ?? []) if (t.cap) set.add(t.cap);
    return set;
  };
  const before = capOf(prev);
  const after = capOf(next);
  for (const c of after) if (!before.has(c)) lines.push('新增能力开关：' + c);
  if (next.signature !== 'ok' && prev.signature === 'ok') lines.push('⚠ 这一版**没有有效签名**了（上一版有）');
  if (prev.hash && next.hash && prev.hash !== next.hash && prev.version === next.version) {
    lines.push('⚠ **版本号没变但内容变了**（' + prev.hash.slice(0, 8) + ' → ' + next.hash.slice(0, 8) + '）');
  }
  return lines;
}

/**
 * 检查更新：读清单里声明的 update.url，拿回 ~~{version, url}~~ 比一比。
 *
 * 更新也**不多开网络出口**：地址的主机必须在插件自己的白名单里。
 */
export async function checkPluginUpdate(
  plugin: InstalledPlugin,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; error?: string; latest?: string; url?: string; newer?: boolean }> {
  const at = plugin.update?.url;
  if (!at) return { ok: false, error: '这个插件没有声明更新地址（manifest.update.url）。' };
  const cfgRef = at.match(/^\{config:([a-zA-Z][a-zA-Z0-9_]{0,30})\}/);
  if (cfgRef) {
    const f = plugin.fields.find((x) => x.key === cfgRef[1]);
    const base = (plugin.values[cfgRef[1]] ?? f?.default ?? '').trim();
    if (!base) {
      return { ok: false, error: '请先在插件面板里填写「' + (f?.label ?? cfgRef[1]) + '」（更新地址基于它）。' };
    }
  }
  const resolved = cfgRef
    ? at.replace(/^\{config:[^}]+\}/, (plugin.values[cfgRef[1]] ?? plugin.fields.find((x) => x.key === cfgRef[1])?.default ?? '').trim().replace(/\/+$/, ''))
    : at;
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    return { ok: false, error: '更新地址不是合法地址：' + resolved };
  }
  if (!hostAllowed(url.hostname, effectiveHosts(plugin))) {
    return { ok: false, error: '更新地址的主机 ' + url.hostname + ' 不在这个插件的主机白名单里。' };
  }
  try {
    const res = await fetchImpl(url.href, { headers: { accept: 'application/json, text/plain, */*' } });
    const body = await res.text();
    if (!res.ok) return { ok: false, error: '更新地址返回 HTTP ' + res.status };
    const info = JSON.parse(body) as { version?: string; url?: string };
    if (!info.version) return { ok: false, error: '更新信息里没有 version 字段。' };
    /*
     * 更新信息里的下载地址可以是相对路径（以 / 开头）—— 相对**更新清单自己的地址**解析。
     * 这样把清单和包放在同一个目录下就不必写死端口，本机演示也能直接用。
     */
    let download = info.url;
    if (download && download.startsWith('/')) {
      download = new URL(download, url).href;
    }
    return {
      ok: true,
      latest: info.version,
      url: download,
      newer: versionAtLeast(info.version, plugin.version) && info.version !== plugin.version,
    };
  } catch (e) {
    return { ok: false, error: '拿更新信息失败：' + (e as Error).message };
  }
}

/** 提示词里的插件段：每个插件一行，**不塞指南**。 */
export function pluginsText(): string {
  if (current.length === 0) return '';
  const policy = securityPolicy();
  const note =
    '\n(current security level: **' + policy.level + '** — ' +
    (policy.allowPluginTools
      ? 'plugin js tools run with a fetch budget of ' + (policy.fetchPerCall === Infinity ? 'no limit' : policy.fetchPerCall) + ' per call'
      : 'plugin js tools are **disabled**; declarative operations still work') +
    (policy.exposeSecretsToTools ? '' : ', and plugin tools cannot read secret fields') +
    ')';
  return current
    .map((p) => {
      const kinds = p.endpoints.map((e) => pluginKind(p.id, e.name)).join(', ');
      /*
       * 工具分两种形态，必须**分开列** —— 因为调用方式完全不同：
       * - op 形态：直接写进 ops，kind 就是插件前缀那个名字；
       * - tool 形态：用 call_tool，而且它已经出现在 ## Available tools 里。
       * 混在一行里会让模型拿 op 的调用方式去调 tool 形态（或反过来）。
       */
      const all = p.tools ?? [];
      const asOps = all.filter((t) => t.exposeAs !== 'tool').map((t) => pluginKind(p.id, t.name)).join(', ');
      const asTools = all.filter((t) => t.exposeAs === 'tool').map((t) => pluginKind(p.id, t.name)).join(', ');
      const uis = (p.ui ?? []).map((u) => u.name).join(', ');
      return '- ' + p.name + ' (id "' + p.id + '" v' + p.version + '): ' + p.description +
        '\n  operations: ' + (kinds + (asOps ? (kinds ? ', ' : '') + asOps : '') || '(none)') +
        (asTools ? '\n  **tools** (they are already listed under "Available tools"; call them with call_tool): ' + asTools : '') +
        (uis ? '\n  screens it can put up (use plugin_ui with this id): ' + uis : '') +
        '\n  read its guide with plugin_docs("' + p.id + '") before using it.';
    })
    .join('\n') + note;
}
