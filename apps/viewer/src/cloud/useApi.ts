import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

/*
 * Every result is kept in memory by key, so a page shows what it showed last time straight away and refreshes it in
 * the background instead of starting empty. Components asking for the same key share one entry and one request.
 * Cleared when the signed-in user changes (see cloud/auth.tsx), so nobody sees someone else's data.
 */
const cache = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();
const inFlight = new Map<string, Promise<unknown>>();
/** The latest request per key, so an older response arriving late never replaces a newer one. */
const latest = new Map<string, number>();
let requests = 0;

function publish(key: string, value: unknown) {
  cache.set(key, value);
  listeners.get(key)?.forEach((l) => l());
}

function subscribe(key: string, listener: () => void) {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(listener);
  return () => { set.delete(listener); };
}

/**
 * Fetches `key`, joining a request for it that is already running unless `force` (a reload after an edit, which
 * must not get an answer from before the edit).
 */
function fetchShared<T>(key: string, load: () => Promise<T>, force: boolean): Promise<T> {
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running && !force) return running;
  const id = ++requests;
  latest.set(key, id);
  const p = load()
    .then((d) => { if (latest.get(key) === id) publish(key, d); return d; })
    .finally(() => { if (inFlight.get(key) === p) inFlight.delete(key); });
  inFlight.set(key, p);
  return p;
}

/** Forgets every result, e.g. on sign-out. Mounted pages keep what they show until they next refresh. */
export function clearApiCache(): void {
  cache.clear();
}

export interface ApiOptions {
  /** Refreshes in the background this often. */
  pollMs?: number;
  /** Refreshes whenever this value changes, e.g. the location key to refetch on every navigation. */
  refreshOn?: unknown;
}

/**
 * The result for `key`, loaded by `load`: the cached result at once when there is one, refreshed in the background.
 * `fresh` turns true once this component has a result loaded since it mounted; use it before deciding anything
 * (like where to redirect) that a stale result could get wrong. `reload` fetches again; after an edit, call it so
 * every component showing this key updates.
 */
export function useApi<T>(key: string, load: () => Promise<T>, opts: ApiOptions = {}) {
  const loadRef = useRef(load);
  loadRef.current = load;
  const data = useSyncExternalStore(
    useCallback((l: () => void) => subscribe(key, l), [key]),
    () => cache.get(key) as T | undefined,
  );
  // Errors and freshness belong to one key: a different key starts over.
  const [state, setState] = useState<{ key: string; error: string | null; fresh: boolean }>({ key, error: null, fresh: false });
  const current = state.key === key ? state : { key, error: null, fresh: false };
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const lastTick = useRef(tick);

  useEffect(() => {
    let alive = true;
    const force = tick !== lastTick.current;
    lastTick.current = tick;
    fetchShared(key, () => loadRef.current(), force).then(
      () => { if (alive) setState({ key, error: null, fresh: true }); },
      (e: Error) => { if (alive) setState((s) => ({ key, error: e.message, fresh: s.key === key && s.fresh })); },
    );
    return () => { alive = false; };
  }, [key, tick, opts.refreshOn]);

  useEffect(() => {
    if (!opts.pollMs) return;
    const id = setInterval(reload, opts.pollMs);
    return () => clearInterval(id);
  }, [opts.pollMs, reload]);

  return { data, error: current.error, fresh: current.fresh, reload };
}

export const ago = (iso: string | null | undefined): string => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};
