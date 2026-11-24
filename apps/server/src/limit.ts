/**
 * A fixed-window counter per key, in memory. Fine for one server instance (the same assumption `LiveHub` makes); with
 * several instances each keeps its own counts, so the real limit is per instance. Bounded: when `maxKeys` is reached
 * the oldest entries go first, so a flood of distinct keys can't grow it without end.
 */
export function rateLimiter(max: number, windowMs: number, now: () => number, maxKeys = 10_000) {
  const windows = new Map<string, { start: number; n: number }>();
  const current = (key: string, t: number) => {
    const w = windows.get(key);
    return w && t - w.start < windowMs ? w : undefined;
  };
  return {
    /** Counts one hit for `key`. True when that puts it over the limit. */
    hit(key: string): boolean {
      const t = now();
      const w = current(key, t);
      if (w) return ++w.n > max;
      if (windows.size >= maxKeys) {
        for (const [k, v] of windows) if (t - v.start >= windowMs) windows.delete(k);
        for (const k of windows.keys()) { if (windows.size < maxKeys) break; windows.delete(k); }
      }
      windows.set(key, { start: t, n: 1 });
      return 1 > max;
    },
    /** Whether `key` is already over the limit, without counting. */
    over(key: string): boolean {
      const w = current(key, now());
      return !!w && w.n > max;
    },
  };
}
