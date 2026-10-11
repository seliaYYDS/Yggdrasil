import { newId } from '../ids';

/**
 * 真实浏览器环境的控制层。
 *
 * 这里做的事都是**浏览器允许网页做的事**，边界老老实实写清楚：
 *
 * | 想做的 | 浏览器实际允许的 |
 * | --- | --- |
 * | 读窗口大小 | 随便读（inner / outer / screen / dpr / 全屏状态） |
 * | 改主窗口大小 | **不允许**。`resizeTo` 对不是脚本打开的窗口无效，只能申请全屏（且要用户手势） |
 * | 新建页面 | `window.open`，但**必须处在用户手势里**，否则被弹窗拦截 |
 * | 获取打开的页面 | 只能列出**我们自己开出去的**那些；用户自己开的标签页读不到 |
 * | 关闭页面 | `close()` 只对脚本打开的窗口有效 |
 *
 * 被限制住的部分一律**如实返回原因**，绝不假装成功。
 */

export interface PageInfo {
  id: string;
  url: string;
  name: string;
  closed: boolean;
  sameOrigin: boolean;
  size: { w: number; h: number } | null;
  pos: { x: number; y: number } | null;
  openedAt: number;
}

interface Entry {
  id: string;
  url: string;
  name: string;
  openedAt: number;
  handle: Window | null;
}

const pages = new Map<string, Entry>();

function canOpen(): boolean {
  return typeof window !== 'undefined' && typeof window.open === 'function';
}

/** 尽量读一个窗口的尺寸/位置；跨域会抛 SecurityError，那就返回 null。 */
function readGeometry(handle: Window | null): {
  sameOrigin: boolean;
  size: { w: number; h: number } | null;
  pos: { x: number; y: number } | null;
} {
  if (!handle) return { sameOrigin: false, size: null, pos: null };
  try {
    const w = handle.innerWidth;
    const h = handle.innerHeight;
    if (typeof w !== 'number' || typeof h !== 'number') return { sameOrigin: false, size: null, pos: null };
    let pos: { x: number; y: number } | null = null;
    try {
      pos = { x: handle.screenX, y: handle.screenY };
    } catch {
      pos = null;
    }
    return { sameOrigin: true, size: { w, h }, pos };
  } catch {
    // 跨域：只说明"读不到"，不是失败。
    return { sameOrigin: false, size: null, pos: null };
  }
}

/** 当前这个页面（主窗口）的环境信息。 */
export function viewportInfo(): Record<string, unknown> {
  const d = typeof document !== 'undefined' ? document : undefined;
  const fullscreen = !!(d && d.fullscreenElement);
  return {
    inner: { w: window.innerWidth, h: window.innerHeight },
    outer: { w: window.outerWidth ?? null, h: window.outerHeight ?? null },
    screen: { w: window.screen?.width ?? null, h: window.screen?.height ?? null },
    devicePixelRatio: window.devicePixelRatio ?? null,
    fullscreen,
    visible: typeof document !== 'undefined' ? document.visibilityState !== 'hidden' : null,
    location: window.location?.href ?? '',
    title: typeof document !== 'undefined' ? document.title : '',
  };
}

export interface OpenOptions {
  name?: string;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
}

export interface OpenResult {
  ok: boolean;
  id?: string;
  url: string;
  /** true 表示被浏览器弹窗拦截（不是代码错）。 */
  blocked?: boolean;
  reason?: string;
}

/** 打开一个新页面（新标签或新窗口）。 */
export function openPage(url: string, options: OpenOptions = {}): OpenResult {
  const id = newId();
  if (!canOpen()) return { ok: false, url, reason: '当前环境不支持 window.open。' };

  const name = options.name?.trim() || id;
  const sized =
    typeof options.width === 'number' || typeof options.height === 'number';
  const features = sized
    ? [
        'popup=yes',
        'width=' + Math.round(options.width ?? 1024),
        'height=' + Math.round(options.height ?? 768),
        'left=' + Math.round(options.left ?? 40),
        'top=' + Math.round(options.top ?? 40),
      ].join(',')
    : '';

  let handle: Window | null = null;
  try {
    handle = features ? window.open(url, name, features) : window.open(url, name);
  } catch (e) {
    return { ok: false, url, reason: (e as Error).message };
  }

  if (!handle) {
    return {
      ok: false,
      url,
      blocked: true,
      reason: '浏览器拦截了新窗口：网页只能在"用户手势"里打开新窗口，而这条指令是模型异步执行的。',
    };
  }

  // 防反向标签劫持：不让新页面通过 opener 反过来改这个页面。
  try {
    handle.opener = null;
  } catch {
    /* 跨域时改不了，忽略 */
  }

  pages.set(id, { id, url, name, openedAt: Date.now(), handle });
  return { ok: true, id, url };
}

/** 列出由本应用打开、且还没被关掉的页面。 */
export function listPages(): PageInfo[] {
  const out: PageInfo[] = [];
  for (const e of pages.values()) {
    let closed = true;
    try {
      closed = !e.handle || e.handle.closed;
    } catch {
      closed = true;
    }
    if (closed) {
      pages.delete(e.id);
      continue;
    }
    const geo = readGeometry(e.handle);
    out.push({
      id: e.id,
      url: e.url,
      name: e.name,
      closed: false,
      sameOrigin: geo.sameOrigin,
      size: geo.size,
      pos: geo.pos,
      openedAt: e.openedAt,
    });
  }
  return out;
}

function findEntry(idOrName: string): Entry | undefined {
  const key = idOrName.trim();
  if (!key) return undefined;
  for (const e of pages.values()) {
    if (e.id === key || e.name === key) return e;
  }
  return undefined;
}

export interface CloseResult {
  closed: number;
  missing: string[];
  failed: string[];
}

/** 关闭页面。idOrName 传 '*' 或 'all' 关掉全部。 */
export function closePage(idOrName: string): CloseResult {
  const all = idOrName === '*' || idOrName.toLowerCase() === 'all';
  const targets = all ? [...pages.values()] : [findEntry(idOrName)].filter(Boolean) as Entry[];
  const missing: string[] = [];
  const failed: string[] = [];
  let closed = 0;

  if (!all && targets.length === 0) missing.push(idOrName);

  for (const e of targets) {
    try {
      if (e.handle && !e.handle.closed) e.handle.close();
      closed += 1;
    } catch (err) {
      failed.push(e.id + '：' + (err as Error).message);
    }
    pages.delete(e.id);
  }
  return { closed, missing, failed };
}

export interface ResizeOptions {
  width?: number;
  height?: number;
  left?: number;
  top?: number;
}

export interface ResizeResult {
  attempted: boolean;
  handledBy: string;
  before: { w: number; h: number } | null;
  after: { w: number; h: number } | null;
  size: { w: number; h: number } | null;
  reason?: string;
}

/**
 * 调整窗口大小。
 * - `target` 为空 / 'self'：当前页面。浏览器**不允许**网页改主窗口尺寸，这里会如实报告结果。
 * - `target` 为页面 id / name：我们自己开出去的窗口（同源时能改）。
 */
export function resizePage(target: string | undefined, o: ResizeOptions): ResizeResult {
  const isSelf = !target || target === 'self' || target === 'this';
  const handle: Window | null = isSelf ? window : findEntry(target ?? '')?.handle ?? null;
  const label = isSelf ? '当前页面' : target ?? '';

  if (!handle) {
    return { attempted: false, handledBy: label, before: null, after: null, size: null, reason: '找不到这个页面。' };
  }

  const before = isSelf
    ? { w: window.innerWidth, h: window.innerHeight }
    : readGeometry(handle).size;

  try {
    if (typeof o.width === 'number' || typeof o.height === 'number') {
      handle.resizeTo(
        Math.round(o.width ?? handle.innerWidth),
        Math.round(o.height ?? handle.innerHeight),
      );
    }
    if (typeof o.left === 'number' || typeof o.top === 'number') {
      handle.moveTo(Math.round(o.left ?? 0), Math.round(o.top ?? 0));
    }
  } catch (e) {
    return {
      attempted: true,
      handledBy: label,
      before,
      after: null,
      size: null,
      reason: 'write blocked: ' + (e as Error).message,
    };
  }

  const after = isSelf
    ? { w: window.innerWidth, h: window.innerHeight }
    : readGeometry(handle).size;
  const reason =
    before && after && before.w === after.w && before.h === after.h
      ? '浏览器忽略了 resizeTo：网页不能改变主窗口尺寸（只有脚本打开的窗口才能）。'
      : undefined;
  return { attempted: true, handledBy: label, before, after, size: after, reason };
}

/** 申请 / 退出全屏。需要用户手势，失败时返回原因。 */
export async function setFullscreen(on: boolean): Promise<{ ok: boolean; reason?: string }> {
  try {
    if (on) {
      if (document.fullscreenElement) return { ok: true };
      await document.documentElement.requestFullscreen();
    } else if (document.fullscreenElement) {
      await document.exitFullscreen();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
