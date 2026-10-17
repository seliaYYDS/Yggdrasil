import type { ActCap, PluginPage, PluginPromptPatch } from '../types';
import {
  PLUGIN_ALLOWED_FILES,
  PLUGIN_FORMAT,
  pluginFileAllowed,
  type PluginEndpoint,
  type PluginField,
  type PluginManifest,
  type PluginPackage,
  type PluginParam,
  type PluginSignature,
  type PluginTool,
  type PluginUi,
} from './types';
import { readZip, safeEntryName, writeZip, ZipError } from './zip';
import { plainLines } from '../text';

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

/**
 * 包内容哈希。
 *
 * 规则：把包内所有文件按名字排序，逐个拼成 ~~名字 + \n + 内容~~ 再哈希；
 * **manifest.json 里的 signature 块不参与**（否则签名把自己算进去了，永远验不过）。
 * 签名者与验证者用同一个函数，所以只要文件内容一致，哈希就一致。
 */
export async function packageHash(manifest: PluginManifest, files: Record<string, string>): Promise<string> {
  const parts: string[] = [];
  for (const name of Object.keys(files).sort()) {
    if (name === 'manifest.json') {
      const { signature: _drop, ...rest } = manifest as PluginManifest & { signature?: PluginSignature };
      parts.push(name + '\n' + JSON.stringify(rest));
      continue;
    }
    parts.push(name + '\n' + files[name]);
  }
  const bytes = new TextEncoder().encode(parts.join('\n\0\n'));
  const digest = await crypto.subtle.digest('SHA-256', buf(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 拷成独立 ArrayBuffer：TS 5.9 的 Uint8Array 泛型不直接满足 BufferSource。 */
function buf(u8: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(u8.length);
  copy.set(u8);
  return copy.buffer as ArrayBuffer;
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type SignatureState = 'none' | 'ok' | 'unsupported' | 'bad';

/**
 * 验签：Ed25519，签的是**哈希的十六进制字符串**的字节。
 *
 * 环境不支持 Ed25519（老浏览器）时返回 unsupported —— 不假装验过，也不因此拒绝安装；
 * 界面会如实显示"环境验不了"。验**不过**（bad）则由调用方拒绝安装。
 */
export async function verifySignature(
  hash: string,
  sig: PluginSignature,
): Promise<{ state: SignatureState; fingerprint?: string }> {
  if (sig.alg !== 'ed25519') return { state: 'bad' };
  let pub: Uint8Array;
  let value: Uint8Array;
  try {
    pub = b64ToBytes(sig.publicKey);
    value = b64ToBytes(sig.value);
  } catch {
    return { state: 'bad' };
  }
  const fingerprint = [...pub.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return { state: 'unsupported', fingerprint };
  try {
    const key = await subtle.importKey('raw', buf(pub), { name: 'Ed25519' }, false, ['verify']);
    const ok = await subtle.verify({ name: 'Ed25519' }, key, buf(value), new TextEncoder().encode(hash));
    return { state: ok ? 'ok' : 'bad', fingerprint };
  } catch {
    // 浏览器不支持 Ed25519 时 importKey 会抛错 —— 这是"验不了"，不是"签名是假的"。
    return { state: 'unsupported', fingerprint };
  }
}

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
/**
 * 一个插件"有没有内容"。
 *
 * 判据曾经只认"端点或工具"，于是每次新增一类能力都要在这一处、校验器那一处、
 * 打包脚本那一处各改一遍 —— 漏掉任何一处就是"凭空封死一类插件"。
 * 这个坑**踩了三次**（校验器、打包脚本、以及最后的持久化装载器 —— 第三次最严重：
 * 它把插件在刷新时整个丢掉）。所以判据收到这里，谁要判断都调它。
 */
export function hasPluginContent(counts: {
  endpoints: number;
  tools: number;
  prompts: number;
  pages: number;
}): boolean {
  return counts.endpoints > 0 || counts.tools > 0 || counts.prompts > 0 || counts.pages > 0;
}

/** 一条提示词补丁的文字上限。够写一段要求，又不至于把系统提示挤爆。 */
export const MAX_PATCH_TEXT = 4000;
/** 插件图标：最多几条 path、单条多长。够画一个图标，又不至于塞进来一张画。 */
export const MAX_ICON_PATHS = 12;
export const MAX_ICON_PATH_CHARS = 2000;
/**
 * SVG path 的 `d` 允许出现的字符（白名单）。
 *
 * 只有路径命令、数字、正负号、小数点、指数与分隔符 —— 于是它**只能是路径**：
 * `<`、`>`、引号、括号都进不来，注入这条路从根上没有了。
 */
export const SVG_PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]+$/;

/** a >= b。 */
export function versionAtLeast(a: string, b: string): boolean {
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

  const known = ['id', 'name', 'version', 'minAppVersion', 'author', 'description', 'hosts', 'fields', 'endpoints', 'tools', 'ui', 'signature', 'update', 'prompts', 'pages'];
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
      return bad('该插件要求应用版本至少 ' + minAppVersion + '，当前为 ' + APP_VERSION + '。');
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

  /*
   * **空 hosts 的判定延后到解析完 endpoints / tools 之后**。
   *
   * 原来这里立刻要求非空。那对一个"只提供纯计算工具、根本不联网"的插件（cap: null）
   * 就变成了硬性阻碍：它得凭空写一个用不到的主机名才能打包 —— 而安装确认里
   * 会据此告诉用户"这个插件可以访问 api.example.com"，**那是一句假话**，
   * 比没有白名单更糟。安全上也不需要它：名单为空时任何 ctx.fetch 都会被执行期拦下。
   *
   * 所以规则改成：**只有真的可能发请求时**才要求写清主机（见下面 tools 解析之后的检查）。
   */

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

  const epsRawForNames = Array.isArray(m.endpoints) ? m.endpoints : [];

  // ---- js 工具 ----
  const toolsRaw = Array.isArray(m.tools) ? m.tools : [];
  const tools: PluginTool[] = [];
  for (const t of toolsRaw) {
    if (!t || typeof t !== 'object') return bad('tools 里有一项不是对象。');
    const o = t as Record<string, unknown>;
    const tn = typeof o.name === 'string' ? o.name : '';
    if (!NAME_RE.test(tn)) return bad('tools[].name 不合法：' + tn);
    if (tools.some((x) => x.name === tn) || epsRawForNames.some((e) => (e as Record<string, unknown>).name === tn)) {
      return bad('tools 与 endpoints 里名字重复：' + tn);
    }
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : '';
    if (!label) return bad('tool ' + tn + ' 缺少 label。');
    const desc = typeof o.description === 'string' && o.description.trim() ? o.description.trim() : '';
    if (!desc) return bad('tool ' + tn + ' 缺少 description（模型靠它决定怎么用）。');
    const file = typeof o.file === 'string' ? o.file.trim() : '';
    if (!/^tools\/[a-z][a-z0-9_-]{0,30}\.js$/.test(file)) {
      return bad('tool ' + tn + ' 的 file 要形如 tools/xxx.js（现在是 "' + file + '"）。');
    }
    const timeoutMs = typeof o.timeoutMs === 'number' ? Math.floor(o.timeoutMs) : 8000;
    if (timeoutMs < 200 || timeoutMs > 30000) return bad('tool ' + tn + ' 的 timeoutMs 要在 200 到 30000 之间。');
    const cap = o.cap === undefined ? 'net' : (o.cap as ActCap | null);
    if (!CAPS.includes(cap)) return bad('tool ' + tn + ' 的 cap 不认识：' + String(o.cap));
    // exposeAs 只认两个值；不写就是老行为（注册成 op）。
    const exposeAs = o.exposeAs === undefined ? 'op' : o.exposeAs;
    if (exposeAs !== 'op' && exposeAs !== 'tool') {
      return bad('tool ' + tn + ' 的 exposeAs 只能是 "op" 或 "tool"（现在是 ' + JSON.stringify(o.exposeAs) + '）。');
    }
    const params = Array.isArray(o.params) ? (o.params as PluginParam[]) : [];
    const paramsSchemaRaw = o.paramsSchema;
    if (paramsSchemaRaw !== undefined && (typeof paramsSchemaRaw !== 'object' || paramsSchemaRaw === null || Array.isArray(paramsSchemaRaw))) {
      return bad('tool ' + tn + ' 的 paramsSchema 必须是一个对象。');
    }
    if (exposeAs === 'tool' && params.length === 0 && paramsSchemaRaw === undefined) {
      // 不是错，但值得提醒：没参数的工具在工具目录里只有一行说明。
    }
    tools.push({
      name: tn,
      label,
      description: desc,
      file,
      params,
      exposeAs,
      paramsSchema: paramsSchemaRaw as Record<string, unknown> | undefined,
      cap,
      timeoutMs,
      mutates: o.mutates === true,
      example: o.example && typeof o.example === 'object' ? (o.example as Record<string, unknown>) : undefined,
    });
  }

  // ---- 自带界面 ----
  const uiRaw = Array.isArray(m.ui) ? m.ui : [];
  const ui: PluginUi[] = [];
  for (const u of uiRaw) {
    if (!u || typeof u !== 'object') return bad('ui 里有一项不是对象。');
    const o = u as Record<string, unknown>;
    const un = typeof o.name === 'string' ? o.name : '';
    if (!NAME_RE.test(un)) return bad('ui[].name 不合法：' + un);
    if (ui.some((x) => x.name === un)) return bad('ui 名字重复：' + un);
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : '';
    if (!label) return bad('ui ' + un + ' 缺少 label。');
    const desc = typeof o.description === 'string' && o.description.trim() ? o.description.trim() : '';
    if (!desc) return bad('ui ' + un + ' 缺少 description（模型靠它决定什么时候摆出来）。');
    const file = typeof o.file === 'string' ? o.file.trim() : '';
    if (!/^ui\/[a-z][a-z0-9_-]{0,30}\.tsx$/.test(file)) {
      return bad('ui ' + un + ' 的 file 要形如 ui/xxx.tsx（现在是 "' + file + '"）。');
    }
    ui.push({
      name: un,
      label,
      description: desc,
      file,
      dataDoc: typeof o.dataDoc === 'string' ? o.dataDoc : undefined,
      example: o.example && typeof o.example === 'object' ? (o.example as Record<string, unknown>) : undefined,
    });
  }

  // ---- 提示词补丁 ----
  /*
   * 只允许动**可寻址的段落**。这里校验的是"段落 id 认不认识、insert 有没有锚点" ——
   * 至于"哪些段落不许动"（identity / operations / output-format）在执行侧再拦一次，
   * 因为那份名单是提示词模块的知识，不该在这里抄一遍。
   */
  const promptsRaw = Array.isArray(m.prompts) ? m.prompts : [];
  const prompts: PluginPromptPatch[] = [];
  for (const raw of promptsRaw) {
    if (!raw || typeof raw !== 'object') return bad('prompts 里有一项不是对象。');
    const o = raw as Record<string, unknown>;
    const op = o.op;
    if (op !== 'insert' && op !== 'replace' && op !== 'remove' && op !== 'substitute') {
      return bad('prompts[].op 只能是 insert / replace / remove / substitute（现在是 ' + JSON.stringify(op) + '）。');
    }
    const text = typeof o.text === 'string' ? o.text : '';
    const anchor = typeof o.anchor === 'string' ? o.anchor : undefined;
    const section = typeof o.section === 'string' ? o.section : undefined;
    const position = o.position === 'before' ? 'before' : o.position === 'after' || o.position === undefined ? 'after' : null;
    if (position === null) return bad('prompts[].position 只能是 before 或 after。');
    if (op === 'insert') {
      if (!anchor) return bad('prompts 里 insert 必须写 anchor（段落 id，或 start / end）。');
      if (!text.trim()) return bad('prompts 里 insert 的 text 是空的。');
    } else if (op === 'substitute') {
      const find = typeof o.find === 'string' ? o.find : '';
      if (!find) return bad('prompts 里 substitute 必须写 find（要被替换掉的字面量）。');
      if (find.length > MAX_PATCH_TEXT) return bad('prompts 里 substitute 的 find 太长。');
      if (typeof o.replace !== 'string') return bad('prompts 里 substitute 必须写 replace（替换后的文本，可为空串）。');
      if (o.replace.length > MAX_PATCH_TEXT) return bad('prompts 里 substitute 的 replace 太长。');
    } else {
      if (!section) return bad('prompts 里 ' + op + ' 必须写 section（要动的段落 id）。');
      if (op === 'replace' && !text.trim()) return bad('prompts 里 replace 的 text 是空的（要删就用 remove）。');
    }
    if (text.length > MAX_PATCH_TEXT) {
      return bad('prompts 里的 text 太长（' + text.length + ' 字符，上限 ' + MAX_PATCH_TEXT + '）。');
    }
    prompts.push({
      op,
      anchor,
      position: position as 'before' | 'after',
      section,
      text,
      ...(op === 'substitute'
        ? { find: (o.find as string), replace: (o.replace as string) }
        : {}),
      label: typeof o.label === 'string' ? o.label : undefined,
    });
  }

  // ---- 默认页面 ----
  const pagesRaw = Array.isArray(m.pages) ? m.pages : [];
  const pages: PluginPage[] = [];
  for (const raw of pagesRaw) {
    if (!raw || typeof raw !== 'object') return bad('pages 里有一项不是对象。');
    const o = raw as Record<string, unknown>;
    const pid = typeof o.id === 'string' ? o.id : '';
    if (!NAME_RE.test(pid)) return bad('pages[].id 不合法：' + pid);
    if (pages.some((x) => x.id === pid)) return bad('page 名字重复：' + pid);
    if (epsRawForNames.some((e) => (e as Record<string, unknown>).name === pid)) return bad('pages 与 endpoints 里名字重复：' + pid);
    const plabel = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : '';
    if (!plabel) return bad('page ' + pid + ' 缺少 label（它是工具栏按钮上的字）。');
    const pfile = typeof o.file === 'string' ? o.file.trim() : '';
    if (!/^ui\/[a-z][a-z0-9_-]{0,30}\.tsx$/.test(pfile)) {
      return bad('page ' + pid + ' 的 file 要形如 ui/xxx.tsx（现在是 "' + pfile + '"）。');
    }
    /*
     * 图标：只收 SVG path 的 `d`。
     *
     * 这条校验是**白名单**而不是黑名单：只允许路径命令与数字/分隔符。
     * 于是 `<`、引号、`javascript:` 这些根本写不进来，不需要再逐条去挡
     * （黑名单漏一条就等于开了一个口子）。
     */
    let icon: string[] | undefined;
    if (o.icon !== undefined) {
      const rawIcon = Array.isArray(o.icon) ? o.icon : [o.icon];
      if (rawIcon.length === 0 || rawIcon.length > MAX_ICON_PATHS) {
        return bad('page ' + pid + ' 的 icon 最多 ' + MAX_ICON_PATHS + ' 条 path，也不能为空。');
      }
      const out: string[] = [];
      for (const piece of rawIcon) {
        if (typeof piece !== 'string') return bad('page ' + pid + ' 的 icon 只能是字符串或字符串数组（SVG path 的 d）。');
        const d = piece.trim();
        if (!d) return bad('page ' + pid + ' 的 icon 里有一条空的 path。');
        if (d.length > MAX_ICON_PATH_CHARS) {
          return bad('page ' + pid + ' 的 icon 有一条太长（' + d.length + ' 字符，上限 ' + MAX_ICON_PATH_CHARS + '）。');
        }
        if (!SVG_PATH_RE.test(d)) {
          return bad('page ' + pid + ' 的 icon 里有不是 SVG path 的字符：' + d.slice(0, 40));
        }
        out.push(d);
      }
      icon = out;
    }
    pages.push({
      id: pid,
      label: plabel,
      description: typeof o.description === 'string' ? o.description : undefined,
      file: pfile,
      open: o.open === true,
      rect: o.rect && typeof o.rect === 'object' ? (o.rect as PluginPage['rect']) : undefined,
      data: o.data,
      icon,
    });
  }

  // ---- 版本更新地址 ----
  let update: { url: string } | undefined;
  if (m.update && typeof m.update === 'object') {
    const uUrl = (m.update as Record<string, unknown>).url;
    const uText = typeof uUrl === 'string' ? uUrl : '';
    const uCfg = uText.match(/^\{config:([a-zA-Z][a-zA-Z0-9_]{0,30})\}/);
    if (uCfg) {
      // 与端点同样的两种开头：写死的 http(s) 或用户的地址字段。
      const f = fields.find((x) => x.key === uCfg[1]);
      if (!f) return bad('update.url 里的 {config:' + uCfg[1] + '} 没有对应的字段。');
      if (f.type !== 'url') return bad('update.url 用 ' + uCfg[1] + ' 当地址前缀，它必须是 type: "url"。');
    } else {
      if (!/^https?:\/\//i.test(uText)) return bad('update.url 要是 http(s) 绝对地址。');
      let uHost = '';
      try {
        uHost = new URL(uText.replace(/\{[^}]+\}/g, 'x')).hostname;
      } catch {
        return bad('update.url 解析不了。');
      }
      // 更新的出口也不额外开：必须已经在这个插件的主机白名单里。
      if (!hostAllowed(uHost, hosts)) {
        return bad('update.url 的主机 ' + uHost + ' 不在 hosts 白名单里（更新也不能多开一个出口）。');
      }
    }
    update = { url: uText };
  }

  const epsRaw = epsRawForNames;
  if (!hasPluginContent({ endpoints: epsRaw.length, tools: tools.length, prompts: prompts.length, pages: pages.length })) {
    return bad('至少要有一个 endpoint / tools / prompts / pages。');
  }
  /*
   * 现在知道这个插件**到底会不会发请求**了：
   * 有端点（端点天生要发请求），或某个工具的 cap 不是 null（没写 cap 就默认 net）。
   * 只有这种情况才强制声明 hosts；纯计算插件允许写空数组。
   */
  const canReachNetwork =
    epsRaw.length > 0 || tools.some((t) => (t.cap === undefined ? true : t.cap !== null));
  void canReachNetwork;
  if (hosts.length === 0 && canReachNetwork) {
    return bad('缺少 hosts 白名单（这个插件会发请求，必须写清楚能访问哪些主机）。');
  }
  if (epsRaw.length > MAX_ENDPOINTS) return bad('endpoint 太多（' + epsRaw.length + ' 个，上限 ' + MAX_ENDPOINTS + '）。可拆成两个插件，或只保留常用项。');
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
            (templated.length ? '如需访问用户配置的主机，地址需以 ' + templated.join('/') + ' 开头。' : ''),
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
      tools,
      ui,
      prompts,
      pages,
      update,
      signature: (m.signature && typeof m.signature === 'object' ? (m.signature as PluginSignature) : undefined),
    },
  };
}

/** 单文件形态：{ format, manifest, guide } 或 { format, manifest, files }。 */
async function parseJsonPackage(text: string): Promise<PluginPackage> {
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
  return await finish(checked.manifest, files, o.manifest);
}

/** 只允许白名单里的文件：这一版包里不该有代码，多出来的东西直接拒绝而不是忽略。 */
async function finish(
  manifest: PluginManifest,
  files: Record<string, string>,
  /*
   * **算哈希必须用作者写的原始清单，不能用手上这份校验后的对象。**
   *
   * 校验会把字段补齐/裁剪/重排（tools 只留认识的键、hosts 转小写…），
   * 用它算出来的哈希与作者签名时算的不是一回事 —— 于是"签名永远验不过"，
   * 而且报错还说"内容被改过"，极难查。这个坑真踩过一次。
   */
  rawManifest: unknown = manifest,
): Promise<PluginPackage> {
  for (const name of Object.keys(files)) {
    if (!pluginFileAllowed(name)) {
      throw new Error(
        '包里不允许有 ' + name + '（只支持 ' + PLUGIN_ALLOWED_FILES.join(' / ') + ' 以及 tools/*.js、ui/*.tsx）。',
      );
    }
  }
  // 清单里声明的 tools / ui 文件必须真的在包里 —— 否则装完才发现调用时找不到文件。
  for (const t of manifest.tools ?? []) {
    if (!(t.file in files)) throw new Error('清单声明了 ' + t.file + '，但包里没有这个文件。');
  }
  for (const u of manifest.ui ?? []) {
    if (!(u.file in files)) throw new Error('清单声明了 ' + u.file + '，但包里没有这个文件。');
  }
  const guide = (files['guide.md'] ?? '').trim();
  const withGuide = { ...manifest, guide };
  const hash = await packageHash(rawManifest as PluginManifest, files);
  const sig = manifest.signature;
  let signatureState: SignatureState = 'none';
  let fingerprint: string | undefined;
  if (sig) {
    const checked = await verifySignature(hash, sig);
    fingerprint = checked.fingerprint;
    if (checked.state === 'bad') {
      throw new Error('签名验证失败：包内容与签名不符（内容被修改或签名错误）。已拒绝安装。');
    }
    signatureState = checked.state;
  }
  return { manifest: withGuide, files, hash, signature: signatureState, fingerprint };
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
  return await finish(checked.manifest, files, raw);
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
  return await parseJsonPackage(text);
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
/**
 * 安装确认页要显示的那几行。
 *
 * 这里的原则是**把"装上去会发生什么"说全**，因为这是用户唯一一次"看完再决定"的机会。
 * 之前的实现有两个漏报（都实测过）：
 * 1. **从不列 tools** —— 一个只提供工具的插件（比如 toolbox）显示成"提供的操作："后面空的，
 *    用户完全看不出它会带来什么；而"它给 Agent 加了三个新工具"恰恰是最该说的。
 * 2. 空 hosts 显示成"可访问的主机："后面空白 —— 那看起来像漏填，其实现在
 *    对纯计算插件是合法且正确的（见下面 hosts 的校验规则），所以要明说"不联网"。
 */
export function describeManifest(m: PluginManifest): string[] {
  const lines = [m.name + ' v' + m.version + (m.author ? ' · ' + m.author : '')];
  lines.push(m.description);

  const hostText = m.hosts
    .map((h) => {
      const ref = h.match(/^\{config:([a-zA-Z][a-zA-Z0-9_]{0,30})\}$/);
      if (!ref) return h;
      const f = (m.fields ?? []).find((x) => x.key === ref[1]);
      return '插件面板里的「' + (f?.label ?? ref[1]) + '」';
    })
    .join('、');
  // 空名单不是漏填 —— 说明白，否则用户会以为这个包坏了。
  lines.push('可访问的主机：' + (hostText || '（无：该插件不发网络请求）'));

  const tools = m.tools ?? [];
  const asOps = tools.filter((t) => t.exposeAs !== 'tool');
  const asTools = tools.filter((t) => t.exposeAs === 'tool');
  // 端点与 op 形态的工具，对模型来说都是"一条 op"，合并成一行。
  const ops = [...m.endpoints.map((e) => e.name), ...asOps.map((t) => t.name)];
  if (ops.length) lines.push('提供的操作：' + ops.join('、'));
  if (asTools.length) {
    lines.push(
      '提供的新工具（与内置工具同列，Agent 用 call_tool 调用）：' + asTools.map((t) => t.name).join('、'),
    );
  }
  const uis = m.ui ?? [];
  if (uis.length) lines.push('自带界面（Agent 可用 plugin_ui 显示）：' + uis.map((u) => u.name).join('、'));

  /*
   * **它会改动核心的什么地方。**
   *
   * 这一段是"插件能改核心代码"这件事的**审计面**：声明是静态的，所以安装前能把
   * "动哪一段、插什么文字（前 60 字）"原样摊开给用户看。没有这一段，用户点"安装"
   * 等于签了一张空白支票 —— 而提示词补丁是会直接改变 Agent 行为的。
   */
  const promptPatches = m.prompts ?? [];
  if (promptPatches.length) {
    lines.push('会改动 Agent 提示词（' + promptPatches.length + ' 处）：');
    for (const patch of promptPatches) {
      const label = patch.label ? patch.label + ' — ' : '';
      if (patch.op === 'substitute') {
        /*
         * 替换是**最强**的一个 op：它作用在整份提示词上，连输出契约都能改到。
         * 所以这里不跟别的 op 用同一种写法，而是把"改写范围"明写出来 ——
         * 用户点安装前至少知道它的份量。
         */
        lines.push(
          '    · ' + label + 'substitute：将整份提示词中的「' + (patch.find ?? '') + '」全部替换为「' +
            (patch.replace ?? '') + '」（改写全篇，含输出契约）',
        );
        continue;
      }
      const where = patch.op === 'insert' ? patch.anchor || 'end' : patch.section || '?';
      const preview = (patch.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      lines.push(
        '    · ' + label + patch.op + ' @' + where + (preview ? '：' + preview + (preview.length >= 60 ? '…' : '') : ''),
      );
    }
  }
  const pages = m.pages ?? [];
  if (pages.length) {
    lines.push('会往界面加页面与按钮：' + pages.map((p) => p.label + (p.open ? '（默认打开）' : '')).join('、'));
  }

  const secrets = (m.fields ?? []).filter((f) => f.secret);
  if (secrets.length) lines.push('需要填写的密钥：' + secrets.map((f) => f.label).join('、'));
  /*
   * 出口处统一纯文本化：这些行会**原样显示在安装确认里**，而其中不少内容来自
   * 第三方清单（插件名、说明、页面名、补丁文字预览）。界面不认 markdown，
   * 所以在这里兜住，而不是指望每个插件作者都不写 `**`。
   */
  return plainLines(lines);
}
