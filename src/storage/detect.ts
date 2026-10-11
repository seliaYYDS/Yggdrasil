import { createMemoryAdapter, type StorageAdapter } from './adapter';
import { createIdbAdapter } from './idbAdapter';
import { createLocalStorageAdapter } from './lsAdapter';

const PROBE_KEY = '__ygg_probe__';
const PROBE_TIMEOUT_MS = 2000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('storage probe timeout')), ms);
    p.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function probeIndexedDB(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  const idb = createIdbAdapter();
  try {
    await withTimeout(idb.set(PROBE_KEY, { ok: true }), PROBE_TIMEOUT_MS);
    const back = await withTimeout(idb.get<{ ok: boolean }>(PROBE_KEY), PROBE_TIMEOUT_MS);
    await idb.del(PROBE_KEY);
    return back?.ok === true;
  } catch {
    return false;
  }
}

export function probeLocalStorage(): boolean {
  try {
    const k = PROBE_KEY;
    window.localStorage.setItem(k, '1');
    const ok = window.localStorage.getItem(k) === '1';
    window.localStorage.removeItem(k);
    return ok;
  } catch {
    return false;
  }
}

let active: StorageAdapter | null = null;

export async function initStorage(): Promise<StorageAdapter> {
  if (active) return active;
  if (await probeIndexedDB()) {
    active = createIdbAdapter();
  } else if (probeLocalStorage()) {
    active = createLocalStorageAdapter();
  } else {
    active = createMemoryAdapter();
  }
  return active;
}

export function getStorage(): StorageAdapter {
  if (!active) throw new Error('storage not initialised');
  return active;
}
