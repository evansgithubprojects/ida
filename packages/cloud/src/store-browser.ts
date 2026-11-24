import type { SpoolStore } from './spool';

const STORE = 'batches';

/** Keeps spooled batches in IndexedDB, so they survive a reload. */
export function indexedDbStore(name = 'eda-debugger-spool'): SpoolStore {
  let opened: Promise<IDBDatabase> | null = null;
  const open = () => (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  };
  return {
    where: `IndexedDB (${name})`,
    async list() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const out: { id: number; bytes: number }[] = [];
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return resolve(out);
          out.push({ id: cur.key as number, bytes: (cur.value as string).length });
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
    },
    write: async (id, data) => { await run('readwrite', (s) => s.put(data, id)); },
    read: (id) => run('readonly', (s) => s.get(id) as IDBRequest<string | undefined>),
    remove: async (id) => { await run('readwrite', (s) => s.delete(id)); },
  };
}

/** IndexedDB when the page has it, else memory. */
export const defaultBrowserStore = (): SpoolStore | null => (typeof indexedDB !== 'undefined' ? indexedDbStore() : null);
