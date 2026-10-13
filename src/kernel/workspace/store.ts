import { clear, createStore, del, entries, get, set } from 'idb-keyval';

/**
 * 工作区沙盒：**给 Agent 用的临时加工台**。
 *
 * 定位（决定了下面每一条实现）：
 * - **临时**，不是长期存储。里面的东西是加工过程中的中间产物，用完就该消失。
 * - **只有 Agent 能写**。用户只能看和删（界面约束，数据不加密 —— 内容是临时的，
 *   为它加一层加密没有意义，也挡不住开发者工具）。
 * - **不是交付通道，是加工通道**：交付靠"嵌入"—— Agent 把结果写进组件源码时，
 *   宿主在那一刻把内容**复制**进去。嵌入之后组件与工作区**再无关系**，
 *   所以"清空工作区"永远弄不坏已经做好的界面。这条是整个设计的地基。
 * - **不进 .seed**：场景文件是内容，工作区是过程。
 *
 * 后端是**可插拔**的：IndexedDB 可用就用它（结构化克隆，Blob 能直接存）；
 * 不可用（隐私模式 / 老浏览器 / 测试环境）就退回内存 ——
 * 那时**只支持文本**，二进制会被明确拒绝，而不是悄悄存坏。
 */

export const WS_DB = 'yggdrasil-workspace';
export const WS_STORE = 'files';

export type WorkspaceKind = 'text' | 'image' | 'binary';

export interface WorkspaceEntry {
  /** 稳定标识符：给 Agent 用的名字（唯一），也是嵌入标记里的那个名字。 */
  name: string;
  kind: WorkspaceKind;
  /** MIME 类型（图片要用它决定预览方式）。 */
  mime: string;
  /** 字节数（文本按 UTF-8 算）。 */
  size: number;
  createdAt: number;
  updatedAt: number;
  /** 纯文本内容；二进制（图片等）存在 blob 里。 */
  text?: string;
  blob?: Blob;
}

/** 一个文件的元信息（列目录与回读里用它，不含内容）。 */
export interface WorkspaceMeta {
  name: string;
  kind: WorkspaceKind;
  mime: string;
  size: number;
  updatedAt: number;
}

export function metaOf(e: WorkspaceEntry): WorkspaceMeta {
  return { name: e.name, kind: e.kind, mime: e.mime, size: e.size, updatedAt: e.updatedAt };
}

/** 后端接口：只要能按名字存取条目就够了。 */
export interface WorkspaceBackend {
  readonly kind: 'idb' | 'memory';
  /** 这个后端能不能存二进制（内存后端不行）。 */
  readonly supportsBlobs: boolean;
  get(name: string): Promise<WorkspaceEntry | undefined>;
  set(entry: WorkspaceEntry): Promise<void>;
  del(name: string): Promise<void>;
  all(): Promise<WorkspaceEntry[]>;
  clear(): Promise<void>;
}

function createMemoryBackend(): WorkspaceBackend {
  const map = new Map<string, WorkspaceEntry>();
  return {
    kind: 'memory',
    supportsBlobs: false,
    async get(name) {
      return map.get(name);
    },
    async set(entry) {
      map.set(entry.name, entry);
    },
    async del(name) {
      map.delete(name);
    },
    async all() {
      return [...map.values()];
    },
    async clear() {
      map.clear();
    },
  };
}

function createIdbBackend(): WorkspaceBackend {
  const kv = createStore(WS_DB, WS_STORE);
  return {
    kind: 'idb',
    supportsBlobs: true,
    get: (name) => get<WorkspaceEntry>(name, kv),
    set: async (entry) => {
      await set(entry.name, entry, kv);
    },
    del: (name) => del(name, kv),
    all: async () => (await entries<string, WorkspaceEntry>(kv)).map(([, v]) => v),
    clear: () => clear(kv),
  };
}

let backend: WorkspaceBackend | null = null;

/**
 * 拿当前后端（第一次调用时挑一个）。
 *
 * 挑不动就退回内存：**工作区在内存里也能用**（只是刷新就没），
 * 比"整个功能直接不可用"好，也比"假装能用、其实写不进去"诚实。
 */
export function workspaceBackend(): WorkspaceBackend {
  if (backend) return backend;
  try {
    if (typeof indexedDB !== 'undefined') {
      backend = createIdbBackend();
      return backend;
    }
  } catch {
    /* 被隐私模式挡住之类，落到内存 */
  }
  backend = createMemoryBackend();
  return backend;
}

/** 测试与宿主可以用它换后端（例如换成内存实现来跑断言）。 */
export function setWorkspaceBackend(next: WorkspaceBackend | null): void {
  backend = next;
}

export function workspaceBackendKind(): 'idb' | 'memory' {
  return workspaceBackend().kind;
}

/*
 * **工作区变更信号**。
 *
 * 面板要"实时"看到 Agent 写进来的东西，但它不该去轮询 IndexedDB ——
 * 轮询既有延迟又白耗电。所以所有写路径（putEntry / deleteEntry / clearWorkspace）
 * 在改完之后**打一下这个信号**，面板订阅它即可。
 *
 * 刻意做成"版本号 + 订阅函数"而不是直接依赖 store：
 * 工作区是独立于 store 的一块（它有自己的后端与生命周期），
 * 让它反过来把 store 引进来会形成环。面板自己去接这个信号，方向是干净的。
 */
let revision = 0;
const listeners = new Set<() => void>();

export function workspaceRevision(): number {
  return revision;
}

export function onWorkspaceChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function bump(): void {
  revision += 1;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* 一个订阅者出错不该影响别人 */
    }
  }
}

/** 名字规则：和插件端点一样宽，但不允许路径分隔符（它不是文件系统）。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;

export function validName(name: string): boolean {
  return NAME_RE.test(name) && !name.includes('..');
}

/** 由 MIME / 扩展名判断种类。图片单独一类是因为它要走多模态读回来。 */
export function kindOf(mime: string, name: string): WorkspaceKind {
  if (/^image\//i.test(mime)) return 'image';
  if (/^text\/|json|xml|javascript|csv/i.test(mime)) return 'text';
  if (/\.(txt|md|json|csv|xml|ts|tsx|js|css|html|log)$/i.test(name)) return 'text';
  return 'binary';
}

export function bytesOfText(text: string): number {
  return new TextEncoder().encode(text).length;
}

export async function listWorkspace(): Promise<WorkspaceMeta[]> {
  const all = await workspaceBackend().all();
  return all
    .filter((v): v is WorkspaceEntry => !!v && typeof v.name === 'string')
    .map(metaOf)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getEntry(name: string): Promise<WorkspaceEntry | undefined> {
  const v = await workspaceBackend().get(name);
  return v && v.name === name ? v : undefined;
}

export async function putEntry(entry: WorkspaceEntry): Promise<void> {
  // 内存后端存不了 Blob：**明确拒绝**而不是存一个取不出来的东西。
  if (entry.blob && !workspaceBackend().supportsBlobs) {
    throw new Error(
      '这个环境没有可用的 IndexedDB，工作区只能在内存里工作、**只能存文本**。' +
        '二进制（图片/音频）存不了 —— 请直接用外部链接，或换一个允许 IndexedDB 的浏览器/隐私模式。',
    );
  }
  await workspaceBackend().set(entry);
  // 写进去了 -> 通知面板（实时刷新靠这个，不靠轮询）
  bump();
}

export async function deleteEntry(name: string): Promise<boolean> {
  const had = await getEntry(name);
  if (!had) return false;
  await workspaceBackend().del(name);
  bump();
  return true;
}

export async function clearWorkspace(): Promise<number> {
  const all = await listWorkspace();
  await workspaceBackend().clear();
  bump();
  return all.length;
}

/** 已用字节数（工作区自己的口径，用于配额提示）。 */
export async function usageBytes(): Promise<number> {
  const all = await listWorkspace();
  return all.reduce((n, m) => n + m.size, 0);
}

/**
 * 容量上限。**不是浏览器的真实配额**，而是我们自己的软上限 ——
 * 目的是"到点给出人能看懂的错误"，而不是让 IndexedDB 抛 QuotaExceededError 进回读。
 */
export const WORKSPACE_SOFT_LIMIT = 32 * 1024 * 1024;

export function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

/**
 * 嵌入标记：写在组件源码的**字符串字面量**里，形如 "@ws/logo.png"。
 *
 * 为什么用字符串而不是别的语法：组件源码是 TSX，字符串在任何位置都合法 ——
 * <img src="@ws/logo.png" />、style={{ backgroundImage: "url(@ws/a.png)" }} 都成立，
 * 宿主只要做一次文本替换。
 *
 * 为什么是"复制"而不是"链接"：标记在**写入组件的那一刻**就被替换成真实内容。
 * 之后工作区里的文件删了、改了，组件都不受影响 —— 已交付的界面不会因为
 * 清理临时文件而坏掉。这是"工作区是临时的"与"界面是永久的"能同时成立的唯一方式。
 */
export const WS_MARKER_PREFIX = '@ws/';

/** 找出源码里引用的所有工作区名字（去重、保序）。 */
export function markersIn(source: string): string[] {
  const out: string[] = [];
  const re = /@ws\/([A-Za-z0-9][A-Za-z0-9._-]{0,60})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** 把一个条目变成可以嵌进源码的字面量内容（文本原样，二进制转 data URL）。 */
export async function embedValue(entry: WorkspaceEntry): Promise<string> {
  if (entry.kind === 'text' && typeof entry.text === 'string') return entry.text;
  const blob = entry.blob;
  if (!blob) return '';
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return 'data:' + (entry.mime || 'application/octet-stream') + ';base64,' + bytesToBase64(bytes);
}

/** 把一个条目的内容变成能放进回读的文本（二进制返回 undefined，走"隐藏"协议）。 */
export function textOf(entry: WorkspaceEntry): string | undefined {
  return entry.kind === 'text' && typeof entry.text === 'string' ? entry.text : undefined;
}
