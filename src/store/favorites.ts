import { createStore, get, set } from 'idb-keyval';
import type { AgentFacet, ComponentNode, NodeFrame, Pos2D, Size2D, ThemeTokens } from '../kernel/types';

/**
 * 组件收藏。
 *
 * 需求要点与对应的做法：
 * - **长期保留** —— 存进 IndexedDB；
 * - **清除组件时不会被删除** —— 用的是**另一个数据库**（见 FAV_DB），
 *   而"重置 / 删除组件"清的是主库里的那几个键。不同库意味着**结构上就碰不到**，
 *   不依赖"记得把收藏排除掉"这种约定；
 * - **被关闭后能重建出一个相同的组件** —— 所以收藏里存的是**重建所需的全部字段**，
 *   而不是一个指向节点的 id（节点 id 重建后就变了，拿它当锚点等于收藏会失效）。
 */
export const FAV_DB = 'yggdrasil-favorites';
export const FAV_STORE = 'favorites';
export const FAV_KEY = 'list';

/** 收藏一条组件（挂件也是组件，只是 frame 不同）。 */
export interface FavoriteEntry {
  /** 收藏自己的 id —— 与源节点解耦：同一个组件可以收藏多次（不同版本）。 */
  id: string;
  name: string;
  source: string;
  /** 'widget' = 挂件。缺省是普通窗口。 */
  frame?: NodeFrame;
  size: Size2D;
  /** 局部样式覆盖。 */
  tokens?: ThemeTokens;
  description?: string;
  /**
   * agent 的**配置**：职责、能力开关、作用域、工具子集、档位。
   *
   * **不含 messages / ledger** —— 收藏是"这份东西的模板"，不是"它的聊天记录"。
   * 重建出来的 agent 有一份干净的记忆，但性格（systemPrompt）与权限原样保留。
   */
  agent?: Omit<AgentFacet, 'messages' | 'ledger'>;
  /** 当初收藏的是哪个节点（只用于显示"来自哪里"，重建时不依赖它）。 */
  originNodeId?: string;
  savedAt: string;
}

let seq = 0;
/** 收藏 id：与节点 id 同一类短 id，但不共用命名空间。 */
export function newFavoriteId(): string {
  seq += 1;
  return 'fav_' + Date.now().toString(36) + '_' + seq.toString(36);
}

/** 从一个组件节点抽出要长期保存的那份。 */
export function favoriteFromNode(node: ComponentNode, existingId?: string): FavoriteEntry {
  const entry: FavoriteEntry = {
    id: existingId ?? newFavoriteId(),
    name: node.name,
    source: node.source,
    size: { w: node.size.w, h: node.size.h },
    savedAt: new Date().toISOString(),
    originNodeId: node.id,
  };
  if (node.frame) entry.frame = node.frame;
  if (node.tokens && Object.keys(node.tokens).length) entry.tokens = { ...node.tokens };
  if (node.description) entry.description = node.description;
  if (node.agent) {
    /* 只留配置，不留记忆与账本（见 FavoriteEntry.agent 的说明）。 */
    const { messages: _m, ledger: _l, ...config } = node.agent;
    void _m;
    void _l;
    entry.agent = config;
  }
  return entry;
}

/** 收藏 → 一个可以直接 addNode 的组件节点（记忆是空的）。 */
export function nodeFromFavorite(fav: FavoriteEntry, id: string, pos: Pos2D, z: number): ComponentNode {
  const node: ComponentNode = {
    id,
    parentId: null,
    kind: 'component',
    name: fav.name,
    status: 'active',
    createdAt: Date.now(),
    source: fav.source,
    pos,
    size: { w: fav.size.w, h: fav.size.h },
    z,
  };
  if (fav.description) node.description = fav.description;
  if (fav.frame === 'widget') node.frame = 'widget';
  if (fav.tokens) node.tokens = { ...fav.tokens };
  if (fav.agent) node.agent = { ...fav.agent, messages: [], ledger: [] };
  return node;
}

/**
 * 存哪：**有 IndexedDB 就用它，没有就退回内存**。
 *
 * 与工作区后端同一个判断（见 kernel/workspace/store.ts）：内存版本刷新就没，
 * 但比"整个功能不可用"好，也比"假装存下了其实没有"诚实。
 */
interface FavoriteBackend {
  kind: 'indexeddb' | 'memory';
  load: () => Promise<FavoriteEntry[]>;
  save: (list: FavoriteEntry[]) => Promise<void>;
}

let memList: FavoriteEntry[] = [];

function createIdbBackend(): FavoriteBackend {
  const kv = createStore(FAV_DB, FAV_STORE);
  return {
    kind: 'indexeddb',
    load: async () => {
      const raw = await get<FavoriteEntry[]>(FAV_KEY, kv);
      return Array.isArray(raw) ? raw.filter(isFavorite) : [];
    },
    save: (list) => set(FAV_KEY, list, kv),
  };
}

function createMemoryBackend(): FavoriteBackend {
  return {
    kind: 'memory',
    load: async () => memList,
    save: async (list) => {
      memList = list;
    },
  };
}

/** 老数据 / 手改过存储时的兜底：形状不对的条目直接丢掉，不让它把界面带崩。 */
export function isFavorite(v: unknown): v is FavoriteEntry {
  const f = v as FavoriteEntry | null;
  return !!f && typeof f.id === 'string' && typeof f.name === 'string' && typeof f.source === 'string' && !!f.size;
}

let backend: FavoriteBackend | null = null;

export function favoriteBackendKind(): 'indexeddb' | 'memory' {
  return favoriteBackend().kind;
}

function favoriteBackend(): FavoriteBackend {
  if (backend) return backend;
  try {
    if (typeof indexedDB !== 'undefined') {
      backend = createIdbBackend();
      return backend;
    }
  } catch {
    /* 隐私模式之类把它挡了，落到内存 */
  }
  backend = createMemoryBackend();
  return backend;
}

/** 换个后端（测试用）。传 null 回到自动挑。 */
export function setFavoriteBackend(next: FavoriteBackend | null): void {
  backend = next;
}

/** 供测试直接给一个内存后端。 */
export function memoryFavoriteBackend(): FavoriteBackend {
  return createMemoryBackend();
}

export async function loadFavorites(): Promise<FavoriteEntry[]> {
  try {
    const list = await favoriteBackend().load();
    return list.filter(isFavorite);
  } catch {
    // 读不出来就当没有 —— 收藏读失败不该让整个应用起不来。
    return [];
  }
}

export async function saveFavorites(list: FavoriteEntry[]): Promise<void> {
  try {
    await favoriteBackend().save(list);
  } catch (e) {
    void e;
  }
}
