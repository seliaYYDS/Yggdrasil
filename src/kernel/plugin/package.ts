import type { ActCap } from '../types';
import {
  PLUGIN_ALLOWED_FILES,
  PLUGIN_FORMAT,
  type PluginEndpoint,
  type PluginField,
  type PluginManifest,
  type PluginPackage,
} from './types';
import { readZip, safeEntryName, writeZip, ZipError } from './zip';

/**
 * 插件包的解析与校验。
 *
 * 原则：**装之前人必须能读懂它**。所以解析分两步 —— 先只读清单、不碰任何代码，
 * 界面把清单摊开给人看（要哪些主机、要用户填什么），确认了才安装。
 * 这一版包里本来就没有可执行文件（只有 manifest 与 guide），但流程按最坏情况设计，
 * 以后加了 js 工具也不必改授权流程。
 *
 * 两个入口：.graft（zip，作者用真实文件写）与 .json（单文件，便于粘贴与 diff）。
 * 两者在内存里落到同一个形状（manifest + files），所以校验器只有一个。
 */

/** 应用版本：minAppVersion 比它大就拒绝。与 package.json 保持一致。 */
export const APP_VERSION = '0.1.0';

const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
// 端点名允许下划线，和系统里已有的 kind 一致（create_component / set_window_state 都是这种写法）。
const NAME_RE = /^[a-z][a-z0-9_-]{0,30}$/;
const FIELD_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,30}$/;
const VERSION_RE = /^\d+\.\d+(\.\d+)?$/;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const CAPS: (ActCap | null)[] = ['desktop', 'style', 'global', 'net', 'browser', 'agents', 'tools', null];

/** 提示词预算：一个插件的端点太多，说明它该拆包，或者该等 js 工具。 */
/**
 * 一个插件最多多少端点。
 *
 * 原先是 20，被真实插件（网易云）顶到了上限：这个 API 有 436 个接口，
 * "做一个完整插件"很容易超过 20。放开到 60，仍然要有上限 ——
 * 因为端点会进提示词，无上限等于把提示词交给插件作者随意撑大。
 */
export const MAX_ENDPOINTS = 60;

function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** 主机名是否在白名单里（精确或子域）。这是插件的出口墙。 */
export function hostAllowed(host: string, hosts: string[]): boolean {
  const h = host.toLowerCase();
  return hosts.some((raw) => {
    const allow = raw.trim().toLowerCase();
    if (!allow) return false;
    return h === allow || h.endsWith('.' + allow);
  });
}

function checkManifest(raw: unknown): { ok: true; manifest: PluginManifest } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'manifest 不是一个对象。' };
  const m = raw as Record<string, unknown>;
  const bad = (msg: string) => ({ ok: false as const, error: 'manifest 有问题：' + msg });

  const known = ['id', 'name', 'version', 'minAppVersion', 'author', 'description', 'hosts', 'fields', 'endpoints'];
  const unknown = Object.keys(m).filter((k) => !known.includes(k));
  if (unknown.length) return bad('不认识的字段 ' + unknown.join(', ') + '（这一版只认 ' + known.join(', ') + '）。');

  const id = typeof m.id === 'string' ? m.id : '';
  if (!ID_RE.test(id)) return bad('id 要小写字母开头、只含小写字母数字与连字符（现在是 "' + id + '"）。');
  const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim() : '';
  if (!name) return bad('缺少 name。');
  const version = typeof m.version === 'string' ? m.version : '';
  if (!VERSION_RE.test(version)) return bad('version 要像 1.0 或 1.0.0（现在是 "' + version + '"）。');
  const description = typeof m.description === 'string' && m.description.trim() ? m.description.trim() : '';
  if (!description) return bad('缺少 description。');

  const minAppVersion = typeof m.minAppVersion === 'string' ? m.minAppVersion : undefined;
  if (minAppVersion) {
    if (!VERSION_RE.test(minAppVersion)) return bad('minAppVersion 要像 1.0（现在是 "' + minAppVersion + '"）。');
    if (!versionAtLeast(APP_VERSION, minAppVersion)) {
      return bad('它要求应用至少 ' + minAppVersion + '，当前是 ' + APP_VERSION + '。');
    }
  }

  const hostsRaw = Array.isArray(m.hosts) ? m.hosts : [];
  const hosts: string[] = [];
  for (const h of hostsRaw) {
    if (typeof h !== 'string') return bad('hosts 里有不合法的域名：' + String(h));
    // 用户配置的主机：自建服务的地址只能由用户填，不可能写死在清单里。
    const ref = h.match(/^\{config:([a-zA-Z][a-zA-Z0-9_]{0,30})\}$/);
    if (ref) {
      hosts.push(h);
      continue;
    }
    if (!HOST_RE.test(h)) return bad('hosts 里有不合法的域名：' + String(h));
    hosts.push(h.toLowerCase());
  }

  // 先报"缺 hosts"：否则会先撞上"端点不在空名单里"，后者更难懂。
  if (hosts.length === 0) return bad('缺少 hosts 白名单（插件要访问哪些主机必须写清楚）。');

  const fieldsRaw = Array.isArray(m.fields) ? m.fields : [];
  const fields: PluginField[] = [];
  for (const f of fieldsRaw) {
    if (!f || typeof f !== 'object') return bad('fields 里有一项不是对象。');
    const o = f as Record<string, unknown>;
    if (typeof o.key !== 'string' || !FIELD_RE.test(o.key)) return bad('fields[].key 不合法：' + String(o.key));
    if (fields.some((x) => x.key === o.key)) return bad('fields 里 key 重复：' + o.key);
    if (typeof o.label !== 'string' || !o.label.trim()) return bad('fields[' + o.key + '] 缺少 label。');
    if (o.type !== undefined && o.type !== 'text' && o.type !== 'url') {
      return bad('fields[' + o.key + '] 的 type 只支持 text 或 url（现在是 ' + String(o.type) + '）。');
    }
    fields.push({
      key: o.key,
      label: o.label,
      hint: typeof o.hint === 'string' ? o.hint : undefined,
      placeholder: typeof o.placeholder === 'string' ? o.placeholder : undefined,
      // type / required 必须带下去：hosts 与 url 插值都读它，漏了就会出现"字段明明写了 url 却说它不是"。
      type: o.type === 'url' ? 'url' : undefined,
      required: o.required === true,
      secret: o.secret === true,
      default: typeof o.default === 'string' ? o.default : undefined,
    });
  }

  // 被 hosts 引用的字段必须存在，而且必须是 url 类型（否则用户填个"北京"也能进白名单）。
  for (const h of hosts) {
    const ref = h.match(/^\{config:([a-zA-Z][a-zA-Z0-9_]{0,30})\}$/);
    if (!ref) continue;
    const f = fields.find((x) => x.key === ref[1]);
    if (!f) return bad('hosts 里的 {config:' + ref[1] + '} 没有对应的字段。');
    if (f.type !== 'url') return bad('字段 ' + ref[1] + ' 被 hosts 引用了，它必须是 type: "url"。');
  }

  const epsRaw = Array.isArray(m.endpoints) ? m.endpoints : [];
  if (epsRaw.length === 0) return bad('至少要有一个 endpoint，否则装它没有意义。');
  if (epsRaw.length > MAX_ENDPOINTS) return bad('endpoint 太多（' + epsRaw.length + ' 个，上限 ' + MAX_ENDPOINTS + '）。拆成两个插件，或只保留常用的。');
  const endpoints: PluginEndpoint[] = [];
  for (const e of epsRaw) {
    if (!e || typeof e !== 'object') return bad('endpoints 里有一项不是对象。');
    const o = e as Record<string, unknown>;
    const en = typeof o.name === 'string' ? o.name : '';
    if (!NAME_RE.test(en)) return bad('endpoints[].name 要小写字母开头、只含小写字母数字、下划线与连字符（"' + en + '"）。');
    if (endpoints.some((x) => x.name === en)) return bad('endpoint 名字重复：' + en);
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : '';
    if (!label) return bad('endpoint ' + en + ' 缺少 label。');
    const desc = typeof o.description === 'string' && o.description.trim() ? o.description.trim() : '';
    if (!desc) return bad('endpoint ' + en + ' 缺少 description（模型靠它决定怎么用）。');
    const url = typeof o.url === 'string' ? o.url.trim() : '';
    /*
     * 地址有两种开头：写死的 http(s)://，或者 {config:某地址字段}。
     * 后者是"自建服务"必需的形式 —— 地址由用户填，清单里查不到主机，
     * 所以这里只检查它引用的字段对不对，真正的主机校验留到执行时（对着用户填的值查）。
     */
    const cfgPrefix = url.match(/^\{config:([a-zA-Z][a-zA-Z0-9_]{0,30})\}/);
    if (cfgPrefix) {
      const f = fields.find((x) => x.key === cfgPrefix[1]);
      if (!f) return bad('endpoint ' + en + ' 的 url 里的 {config:' + cfgPrefix[1] + '} 没有对应的字段。');
      if (f.type !== 'url') {
        return bad('endpoint ' + en + ' 的 url 用 ' + cfgPrefix[1] + ' 当地址前缀，它必须是 type: "url"。');
      }
    } else {
      if (!/^https?:\/\//i.test(url)) {
        return bad('endpoint ' + en + ' 的 url 必须是 http(s) 绝对地址，或以 {config:地址字段} 开头。');
      }
      let host = '';
      try {
        host = new URL(url.replace(/\{[^}]+\}/g, 'x')).hostname;
      } catch {
        return bad('endpoint ' + en + ' 的 url 解析不了：' + url);
      }
      const templated = hosts.filter((h) => h.startsWith('{config:'));
      if (!hostAllowed(host, hosts)) {
        return bad(
          'endpoint ' + en + ' 请求 ' + host + '，但它不在 hosts 白名单里（' + (hosts.join(', ') || '空') + '）。' +
            (templated.length ? '要走用户配置的主机，地址得写成 ' + templated.join('/') + ' 开头。' : ''),
        );
      }
    }
    const method = o.method === 'POST' ? 'POST' : 'GET';
    const cap = o.cap === undefined ? 'net' : (o.cap as ActCap | null);
    if (!CAPS.includes(cap)) return bad('endpoint ' + en + ' 的 cap 不认识：' + String(o.cap));
    const maxChars = typeof o.maxChars === 'number' ? Math.floor(o.maxChars) : 8000;
    if (maxChars < 100 || maxChars > 200000) return bad('endpoint ' + en + ' 的 maxChars 要在 100 到 200000 之间。');
    const bodyRaw = Array.isArray(o.body) ? o.body : [];
    for (const b of bodyRaw) {
      if (typeof b !== 'string') return bad('endpoint ' + en + ' 的 body 里只能写参数名。');
    }
    const pickRaw = Array.isArray(o.pick) ? o.pick : [];
    for (const pk of pickRaw) {
      if (typeof pk !== 'string' || !/^[A-Za-z0-9_\[\].-]+$/.test(pk)) {
        return bad('endpoint ' + en + ' 的 pick 里有不合法的路径：' + String(pk));
      }
    }
    const paramsRaw = Array.isArray(o.params) ? o.params : [];
    const params = [];
    for (const pr of paramsRaw) {
      if (!pr || typeof pr !== 'object') return bad('endpoint ' + en + ' 的 params 里有一项不是对象。');
      const po = pr as Record<string, unknown>;
      if (typeof po.name !== 'string' || !FIELD_RE.test(po.name)) return bad('endpoint ' + en + ' 的 params[].name 不合法。');
      params.push({
        name: po.name,
        description: typeof po.description === 'string' ? po.description : '',
        required: po.required === true,
        default: typeof po.default === 'string' ? po.default : undefined,
      });
    }
    // url 模板里的 {参数名} 必须都声明过，反过来也提示一下：拼错参数名是最常见的错。
    const used = [...url.matchAll(/\{([^}]+)\}/g)].map((x) => x[1]);
    for (const u of used) {
      if (u.startsWith('config:')) {
        const key = u.slice(7);
        if (!fields.some((f) => f.key === key)) return bad('endpoint ' + en + ' 用了 {config:' + key + '}，但没有声明这个字段。');
        continue;
      }
      if (!params.some((x) => x.name === u)) return bad('endpoint ' + en + ' 的 url 里用了 {' + u + '}，但 params 里没有它。');
    }
    if (o.emptyHint !== undefined && typeof o.emptyHint !== 'string') {
      return bad('endpoint ' + en + ' 的 emptyHint 必须是字符串。');
    }
    for (const b of bodyRaw) {
      if (!params.some((x) => x.name === b)) return bad('endpoint ' + en + ' 的 body 里有没声明的参数 ' + b + '。');
    }
    endpoints.push({
      name: en,
      label,
      description: desc,
      method,
      url,
      params,
      headers: (o.headers && typeof o.headers === 'object' ? (o.headers as Record<string, string>) : undefined),
      cap,
      body: bodyRaw.length ? (bodyRaw as string[]) : undefined,
      pick: pickRaw.length ? (pickRaw as string[]) : undefined,
      emptyHint: typeof o.emptyHint === 'string' ? o.emptyHint : undefined,
      maxChars,
      mutates: o.mutates === true,
      example: (o.example && typeof o.example === 'object' ? (o.example as Record<string, unknown>) : undefined),
    });
  }

  return {
    ok: true,
    manifest: {
      id,
      name,
      version,
      minAppVersion,
      author: typeof m.author === 'string' ? m.author : undefined,
      description,
      hosts,
      fields,
      endpoints,
    },
  };
}

/** 单文件形态：{ format, manifest, guide } 或 { format, manifest, files }。 */
function parseJsonPackage(text: string): PluginPackage {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error('不是合法的 JSON：' + (e as Error).message);
  }
  if (!raw || typeof raw !== 'object') throw new Error('顶层不是一个对象。');
  const o = raw as Record<string, unknown>;
  if (o.format !== PLUGIN_FORMAT) throw new Error('这不是插件文件（缺少 format: ' + PLUGIN_FORMAT + '）。');
  const checked = checkManifest(o.manifest);
  if (!checked.ok) throw new Error(checked.error);
  const files: Record<string, string> = {};
  if (o.files && typeof o.files === 'object') {
    for (const [k, v] of Object.entries(o.files as Record<string, unknown>)) {
      if (typeof v !== 'string') throw new Error('files[' + k + '] 不是字符串。');
      files[safeEntryName(k)] = v;
    }
  }
  if (typeof o.guide === 'string' && !files['guide.md']) files['guide.md'] = o.guide;
  return finish(checked.manifest, files);
}

/** 只允许白名单里的文件：这一版包里不该有代码，多出来的东西直接拒绝而不是忽略。 */
function finish(manifest: PluginManifest, files: Record<string, string>): PluginPackage {
  for (const name of Object.keys(files)) {
    if (!PLUGIN_ALLOWED_FILES.includes(name)) {
      throw new Error('包里不允许有 ' + name + '（这一版只支持 ' + PLUGIN_ALLOWED_FILES.join(' / ') + '）。');
    }
  }
  const guide = (files['guide.md'] ?? '').trim();
  return { manifest: { ...manifest, guide }, files };
}

/** 读 .graft（zip）。 */
export async function parseGraft(bytes: Uint8Array): Promise<PluginPackage> {
  let entries: { name: string; text: string }[];
  try {
    entries = await readZip(bytes);
  } catch (e) {
    throw new Error(e instanceof ZipError ? e.message : '读包失败：' + (e as Error).message);
  }
  const files: Record<string, string> = {};
  for (const en of entries) files[en.name] = en.text;
  const manifestText = files['manifest.json'];
  if (!manifestText) throw new Error('包里缺少 manifest.json。');
  let raw: unknown;
  try {
    raw = JSON.parse(manifestText);
  } catch (e) {
    throw new Error('manifest.json 不是合法 JSON：' + (e as Error).message);
  }
  const checked = checkManifest(raw);
  if (!checked.ok) throw new Error(checked.error);
  return finish(checked.manifest, files);
}

/**
 * 按文件名/内容自动选入口。
 * 文件名后缀只当提示：真正的判据是「像不像 zip」（PK 开头）——
 * 用户把 .graft 改名成 .json 之类的情况不该让解析器猜错。
 */
export async function parsePluginPackage(
  fileName: string,
  bytes: Uint8Array,
): Promise<PluginPackage> {
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) return parseGraft(bytes);
  const text = new TextDecoder().decode(bytes);
  if (/\.graft$/i.test(fileName) && !text.trim().startsWith('{')) {
    throw new Error('这个 .graft 不是 zip 包（也不是 JSON 单文件）：开头既不是 PK 也不是 {。');
  }
  return parseJsonPackage(text);
}

/** 把清单 + guide 打成一个 stored zip（确定性）。测试与将来的"导出插件"都用它。 */
export function packPlugin(manifest: PluginManifest, guide: string): Uint8Array {
  /*
   * guide 要剥掉再序列化：它在内存里挂在 manifest 上（运行时与提示词读着方便），
   * 但它不是清单字段 —— 写回去就会变成"不认识的字段 guide"，自己打自己。
   * guide 的载体始终是 guide.md。
   */
  const { guide: _drop, ...clean } = manifest;
  const files: { name: string; text: string }[] = [
    { name: 'manifest.json', text: JSON.stringify(clean, null, 2) + '\n' },
  ];
  if (guide.trim()) files.push({ name: 'guide.md', text: guide });
  return writeZip(files);
}

/** 给安装确认框用：把权限摊开成人能读的几行。 */
export function describeManifest(m: PluginManifest): string[] {
  const lines = [m.name + ' v' + m.version + (m.author ? ' · ' + m.author : '')];
  lines.push(m.description);
  lines.push(
    '可访问的主机：' +
      m.hosts
        .map((h) => {
          const ref = h.match(/^\{config:([a-zA-Z][a-zA-Z0-9_]{0,30})\}$/);
          if (!ref) return h;
          const f = (m.fields ?? []).find((x) => x.key === ref[1]);
          return '你在插件面板里填的「' + (f?.label ?? ref[1]) + '」';
        })
        .join('、'),
  );
  lines.push('提供的操作：' + m.endpoints.map((e) => e.name).join('、'));
  const secrets = (m.fields ?? []).filter((f) => f.secret);
  if (secrets.length) lines.push('需要你填的密钥：' + secrets.map((f) => f.label).join('、'));
  return lines;
}
