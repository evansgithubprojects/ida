import { eventKey, eventLabel, SPIKE_MIN, SPIKE_RATIO, SPIKE_WINDOW_MS, type IndexedOccurrence, type ReplayIndex } from './index';

/** The usual rate a spike is measured against: the mean over this long before it. */
export const SPIKE_BASELINE_MS = 60_000;
/** A second needs this much recording before it to be judged at all, so an app starting up isn't a spike. */
export const SPIKE_MIN_HISTORY_MS = 5_000;

/** One burst of one kind of event: seconds in a row whose rate jumped well above what it usually is. */
export interface Spike {
  /** `spike:<eventKey>@<start of its first second>`: the same across live rebuilds. */
  id: string;
  eventKey: string;
  label: string;
  /** The first and last of its events, in recording ms. */
  from: number;
  to: number;
  /** Its busiest second, in events per second. */
  peak: number;
  /** The mean rate over the minute before it (or as much of one as was recorded), in events per second. */
  usual: number;
  /** Events in it. */
  count: number;
  /** Its first event, for seeking to where it starts. */
  firstOccurrenceId: string;
}

// `index.ts` imports this module too, so nothing here reads its exports until a function runs.

const cache = new WeakMap<ReplayIndex, Spike[]>();

/**
 * Every spike in the recording, oldest first. A second spikes when its rate is at least `SPIKE_MIN` and at least
 * `SPIKE_RATIO` times the usual rate (the mean over the `SPIKE_BASELINE_MS` before it, leaving out seconds that already
 * spiked, so a long burst doesn't raise its own bar). Seconds in a row merge into one spike. Found over the whole
 * recording, so a spike reads the same in every window; worked out once per index.
 */
export function allSpikes(index: ReplayIndex): Spike[] {
  const have = cache.get(index);
  if (have) return have;
  const byEvent = new Map<string, IndexedOccurrence[]>();
  for (const item of index.items) {
    const key = eventKey(item.template);
    const list = byEvent.get(key);
    if (list) list.push(item); else byEvent.set(key, [item]);
  }
  const startBin = Math.floor(index.start / SPIKE_WINDOW_MS);
  const out: Spike[] = [];
  for (const [key, items] of byEvent) out.push(...spikesOf(index, key, items, startBin));
  out.sort((a, b) => a.from - b.from || a.id.localeCompare(b.id));
  cache.set(index, out);
  return out;
}

/** The spike with this id, or null once it is no longer in the recording. */
export function spikeById(index: ReplayIndex, id: string): Spike | null {
  return allSpikes(index).find((s) => s.id === id) ?? null;
}

/** The spikes of the events among `items` that overlap their time span: what a notification list built from them shows. */
export function spikesAmong(index: ReplayIndex, items: IndexedOccurrence[]): Spike[] {
  if (!items.length) return [];
  const keys = new Set(items.map((i) => eventKey(i.template)));
  const lo = items[0]!.occ.ts;
  const hi = items[items.length - 1]!.occ.ts;
  return allSpikes(index).filter((s) => keys.has(s.eventKey) && s.to >= lo && s.from <= hi);
}

/** The events of `spike`, oldest first. */
export function spikeItems(index: ReplayIndex, spike: Spike): IndexedOccurrence[] {
  return index.items.filter((i) => i.occ.ts >= spike.from && i.occ.ts <= spike.to && eventKey(i.template) === spike.eventKey);
}

/** One event's spikes. `items` are that event's occurrences, oldest first. */
function spikesOf(index: ReplayIndex, key: string, items: IndexedOccurrence[], startBin: number): Spike[] {
  const BIN = SPIKE_WINDOW_MS;
  const PER_SECOND = 1000 / BIN;
  const BASELINE_BINS = SPIKE_BASELINE_MS / BIN;
  const MIN_HISTORY_BINS = SPIKE_MIN_HISTORY_MS / BIN;
  const counts = new Map<number, number>();
  for (const i of items) {
    const b = Math.floor(i.occ.ts / BIN);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const spiked = new Set<number>();
  const usualAt = new Map<number, number>();
  // Bins in order, so the bins a baseline leaves out are already known when it is taken.
  for (const b of [...counts.keys()].sort((x, y) => x - y)) {
    const rate = counts.get(b)! * PER_SECOND;
    if (rate < SPIKE_MIN) continue;
    const history = Math.min(BASELINE_BINS, b - startBin);
    if (history < MIN_HISTORY_BINS) continue;
    let sum = 0;
    let bins = 0;
    for (let k = b - history; k < b; k++) {
      if (spiked.has(k)) continue;
      sum += counts.get(k) ?? 0;
      bins++;
    }
    const usual = bins ? (sum / bins) * PER_SECOND : 0;
    if (rate >= SPIKE_RATIO * usual) {
      spiked.add(b);
      usualAt.set(b, usual);
    }
  }
  if (!spiked.size) return [];

  const label = eventLabel(index, items[0]!);
  const runs: number[][] = [];
  for (const b of [...spiked].sort((x, y) => x - y)) {
    const run = runs.at(-1);
    if (run && run.at(-1) === b - 1) run.push(b); else runs.push([b]);
  }
  return runs.map((run) => {
    const first = run[0]!;
    const last = run.at(-1)!;
    const inRun = items.filter((i) => {
      const b = Math.floor(i.occ.ts / BIN);
      return b >= first && b <= last;
    });
    return {
      id: `spike:${key}@${first * BIN}`,
      eventKey: key,
      label,
      from: inRun[0]!.occ.ts,
      to: inRun.at(-1)!.occ.ts,
      peak: Math.max(...run.map((b) => counts.get(b)! * PER_SECOND)),
      usual: usualAt.get(first)!,
      count: inRun.length,
      firstOccurrenceId: inRun[0]!.occ.id,
    };
  });
}

/** "Shop.order hit 120/s, 8× its usual 15/s". */
export function spikeText(spike: Spike, fmtRate: (perSecond: number) => string): string {
  if (spike.usual === 0) return `${spike.label} hit ${fmtRate(spike.peak)}/s, from nothing before it`;
  return `${spike.label} hit ${fmtRate(spike.peak)}/s, ${Math.round(spike.peak / spike.usual)}× its usual ${fmtRate(spike.usual)}/s`;
}
