import type { StorageAdapter } from './adapter';

const PREFIX = 'ygg:';

export function createLocalStorageAdapter(): StorageAdapter {
  return {
    kind: 'localstorage',
    async get<T>(key: string) {
      const raw = window.localStorage.getItem(PREFIX + key);
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    },
    async set<T>(key: string, value: T) {
      window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    },
    async del(key: string) {
      window.localStorage.removeItem(PREFIX + key);
    },
    async list() {
      const out: string[] = [];
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
      }
      return out;
    },
  };
}
