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
      const f = plugin.fields.find((x) => x.key === field);
      value = plugin.values[field] ?? f?.default ?? '';
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
  if (!hostAllowed(url.hostname, plugin.hosts)) {
    // 正常走不到这里（清单校验时已经查过），但执行时再查一次：清单是数据，数据可能被改过。
    return fail('插件 ' + plugin.id + ' 不允许访问 ' + url.hostname + '（白名单：' + plugin.hosts.join(', ') + '）。');
  }

  const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.9, */*;q=0.8' };
  for (const [k, v] of Object.entries(e.headers ?? {})) headers[k] = renderTemplate(v, plugin, params, false);

  const method = e.method ?? 'GET';
  const init: RequestInit = { method, headers };
  if (method === 'POST') {
    headers['content-type'] = headers['content-type'] ?? 'application/json';
    init.body = JSON.stringify(params);
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
    } catch {
      shown = body;
    }
  }
  const clipped = clip(shown, e.maxChars ?? 8000);
  const head = plugin.name + ' · ' + (e.label || e.name) + ' · HTTP ' + res.status;
  if (!res.ok) {
    return fail(head + '。返回正文：\n' + clipped.text.slice(0, 1000));
  }
  return ok(head, {
    observation:
      'HTTP ' + res.status + ' from ' + url.hostname + '：\n' + clipped.text + clipped.note + pickedNote,
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
