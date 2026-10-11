import { createStore, del, get, keys, set } from 'idb-keyval';
import type { StorageAdapter } from './adapter';

export const IDB_DB = 'yggdrasil';
export const IDB_STORE = 'kv';

export function createIdbAdapter(): StorageAdapter {
  const store = createStore(IDB_DB, IDB_STORE);
  return {
    kind: 'indexeddb',
    get: <T>(key: string) => get<T>(key, store),
    set: <T>(key: string, value: T) => set(key, value, store),
    del: (key: string) => del(key, store),
    list: async () => (await keys(store)).map((k) => String(k)),
  };
}
