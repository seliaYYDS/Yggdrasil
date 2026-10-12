import type { DerivationOp } from '../types';
import { fail, ok, str, strOr, type OpContext, type OpResult } from '../bus/opContext';
import { registerInterface, unregisterInterface } from '../registry/interfaceRegistry';
import { hostAllowed } from './package';
import type { InstalledPlugin, PluginEndpoint } from './types';

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

export function pluginKind(pluginId: string, name: string): string {
  return pluginId + '.' + name;
}

/** 把可用插件换成这一份（先全部撤掉再登记，幂等）。 */
export function syncPluginRuntime(plugins: InstalledPlugin[]): void {
  const ids = new Set([...current, ...plugins].map((p) => p.id));
  for (const id of ids) unregisterPluginInterfaces(id);
  current = plugins.filter((p) => p.enabled);
  for (const p of current) for (const e of p.endpoints) registerEndpoint(p, e);
}

export function enabledPlugins(): InstalledPlugin[] {
  return current;
}

export function allKnownPlugins(): InstalledPlugin[] {
  return current;
}

function unregisterPluginInterfaces(pluginId: string): void {
  for (const e of endpointsOf(pluginId)) unregisterInterface(pluginKind(pluginId, e.name));
}

function endpointsOf(pluginId: string): PluginEndpoint[] {
  return current.find((p) => p.id === pluginId)?.endpoints ?? [];
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

/** 收集模型给的参数：只认声明过的名字，缺省的用 default，必填缺了就报错。 */
function collectParams(
  e: PluginEndpoint,
  op: DerivationOp,
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
      return { ok: false, error: '参数 ' + p.name + ' 只能是字符串、数字或布尔值。' };
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
      'Read the usage guide of an installed plugin (its guide.md) plus the exact parameters of its operations. Call this before using a plugin you have not used yet — the prompt only lists plugin names and their operations. Pass id, or omit it to list the installed plugins.',
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
      const guide = str(plugin.guide).trim();
      return ok('Guide of ' + plugin.name, {
        observation:
          '# Plugin ' + plugin.name + ' (id: ' + plugin.id + ', v' + plugin.version + ')\n' +
          plugin.description + '\n\n' +
          '## Operations\n' +
          ops +
          (guide ? '\n\n## Guide\n' + guide : '\n\n(no guide.md in this plugin)'),
      });
    },
  });
}

/** 提示词里的插件段：每个插件一行，**不塞指南**。 */
export function pluginsText(): string {
  if (current.length === 0) return '';
  return current
    .map((p) => {
      const kinds = p.endpoints.map((e) => pluginKind(p.id, e.name)).join(', ');
      return '- ' + p.name + ' (id "' + p.id + '" v' + p.version + '): ' + p.description +
        '\n  operations: ' + kinds +
        '\n  read its guide with plugin_docs("' + p.id + '") before using it.';
    })
    .join('\n');
}
