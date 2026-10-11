export type StorageKind = 'indexeddb' | 'localstorage' | 'memory';

export interface StorageAdapter {
  readonly kind: StorageKind;
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
  list(): Promise<string[]>;
}

export function createMemoryAdapter(): StorageAdapter {
  const map = new Map<string, unknown>();
  return {
    kind: 'memory',
    async get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T) {
      map.set(key, value);
    },
    async del(key: string) {
      map.delete(key);
    },
    async list() {
      return [...map.keys()];
    },
  };
}
