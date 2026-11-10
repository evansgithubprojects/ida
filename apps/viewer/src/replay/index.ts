import type { Finding, GraphNode, Occurrence, Recording, Template } from '@ida/core';
import { compareRank, findingRank, throwRank, tierOf, type Rank, type Tier } from './severity';
export type { Tier } from './severity';

/** A route an occurrence travelled: source node -> one receiving node. */
export interface Hop {
  src: string;
  dst: string;
}

export interface IndexedOccurrence {
  occ: Occurrence;
  template: Template;
  hops: Hop[];
  /**
   * Error times (per throwing handler) in recording ms. `id` is the `throwId` of the error's origin, so the same
   * error has the same `id` in every handler it propagated through; `rethrown` marks those later handlers.
   */
  throws: { at: number; handlerId: string; message: string; id: string; rethrown: boolean }[];
}

/** One kind of event as people name it, `Emitter.eventName`, across all of its templates. */
export interface EventInfo {
  /** See `eventKey`. */
  key: string;
  emitterId: string;
  name: string;
  label: string;
}

export interface ReplayIndex {
  recording: Recording;
  /** By `eventKey`. */
  events: Map<string, EventInfo>;
  items: IndexedOccurrence[];
  byId: Map<string, IndexedOccurrence>;
  nodes: Map<string, GraphNode>;
  /** Handlers (and emitters) that deliver to an external system. */
  externalNodes: Set<string>;
  processLabel: Map<string, string>;
  findingsByOcc: Map<string, Finding[]>;
  findingsById: Map<string, Finding>;
  /** Findings traced to a throw, keyed by `throwId`. */
  findingsBySource: Map<string, Finding[]>;
  /** Where each error went on after being thrown, by the `throwId` of its origin: the handlers it propagated out of. */
  propagations: Map<string, { occurrenceId: string; handlerId: string }[]>;
  start: number;
  end: number;
  /**
   * What displayed times count from. Recorder timestamps are relative to the recorder's start, so this is a fixed 0.
   * It must not follow `start`: a live view drops its oldest event every flush, which moves `start`, and every
   * time on screen would then change and re-render with it. `start` is for geometry and windowing only.
   */
  origin: number;
}

/** Resolves a raw node id to the id shown at the current zoom level, or null to hide it. */
export type MapNode = (nodeId: string) => string | null;

/** Identifies an event across its templates: the emitter plus the event name. Either may contain any character. */
export const eventKey = (t: Pick<Template, 'emitterId' | 'eventName'>) => JSON.stringify([t.emitterId, t.eventName]);

/** Identifies one handler's failure while handling one occurrence. */
export const throwId = (occurrenceId: string, handlerId: string) => `${occurrenceId}|${handlerId}`;

/** Splits a `throwId` back into its parts; occurrence ids may themselves contain the separator. */
/**
 * A short, stable name for an error (six letters and digits), shown wherever it is referenced so it's easy to tell
 * two mentions apart or match them up. It is a hash of the `throwId`, so it doesn't change as the buffer evicts or
 * new errors arrive.
 */
export function errorCode(throwId: string): string {
  // Two 32-bit FNV-1a passes with different seeds give 53 bits, so the reduction to 36^6 values is evenly spread.
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < throwId.length; i++) {
    const c = throwId.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  const h = (a >>> 0) * 2 ** 21 + ((b >>> 0) >>> 11);
  return (h % 36 ** 6).toString(36).toUpperCase().padStart(6, '0');
}

/**
 * The `throwId` of the error `handlerId` failed with while handling `occurrenceId`, or null when it didn't throw
 * there. An error that propagated through several handlers has the `throwId` of where it was first thrown.
 */
export function throwIdFor(index: ReplayIndex, occurrenceId: string, handlerId: string): string | null {
  return index.byId.get(occurrenceId)?.throws.find((t) => t.handlerId === handlerId)?.id ?? null;
}

export function parseThrowId(index: ReplayIndex, id: string): { occurrenceId: string; handlerId: string } | null {
  for (let at = id.indexOf('|'); at >= 0; at = id.indexOf('|', at + 1)) {
    if (index.byId.has(id.slice(0, at))) return { occurrenceId: id.slice(0, at), handlerId: id.slice(at + 1) };
  }
  return null;
}

export type RunDir = 'handled' | 'emitted';

/** One thing a handler did: handle an event, or emit one. */
export interface Run {
  /** See `runId`. */
  id: string;
  item: IndexedOccurrence;
  /** The handler (raw node id). */
  nodeId: string;
  dir: RunDir;
  /** How long the handler ran; only known for runs that handled an event. */
  ms?: number;
  /** The message of the error the handler threw, if it did. */
  error?: string;
  /** The error was thrown first by another handler and propagated up through this one: this run is upstream of it. */
  downstream?: boolean;
}

/** Identifies one run of one handler for one occurrence. */
export const runId = (occurrenceId: string, nodeId: string, dir: RunDir) => JSON.stringify([occurrenceId, nodeId, dir]);

export function parseRunId(index: ReplayIndex, id: string): { occurrenceId: string; nodeId: string; dir: RunDir } | null {
  try {
    const [occurrenceId, nodeId, dir] = JSON.parse(id) as unknown[];
    if (typeof occurrenceId !== 'string' || typeof nodeId !== 'string' || (dir !== 'handled' && dir !== 'emitted')) return null;
    return index.byId.has(occurrenceId) ? { occurrenceId, nodeId, dir } : null;
  } catch {
    return null;
  }
}

function runsOf(item: IndexedOccurrence, nodeId: string): Run[] {
  const out: Run[] = [];
  const result = item.occ.handlerResults.find((r) => r.handlerId === nodeId);
  if (item.template.handlerIds.includes(nodeId)) {
    out.push({ id: runId(item.occ.id, nodeId, 'handled'), item, nodeId, dir: 'handled', ms: result?.durationMs, error: result?.error?.message, downstream: !!result?.rethrown });
  }
  if (item.occ.sourceNodeId === nodeId) out.push({ id: runId(item.occ.id, nodeId, 'emitted'), item, nodeId, dir: 'emitted' });
  return out;
}

/** Everything one handler did inside the window, oldest first. */
export function activityOf(index: ReplayIndex, window: [number, number], nodeId: string): Run[] {
  return inWindow(index, window).flatMap((i) => runsOf(i, nodeId));
}

/** One run by id, wherever it falls. */
export function runById(index: ReplayIndex, id: string): Run | null {
  const p = parseRunId(index, id);
  return p ? runsOf(index.byId.get(p.occurrenceId)!, p.nodeId).find((r) => r.dir === p.dir) ?? null : null;
}

/** A run that threw, or whose payload is suspected corrupt. */
export const isProblemRun = (index: ReplayIndex, run: Run) => !!run.error || index.findingsByOcc.has(run.item.occ.id);

export function buildIndex(recording: Recording): ReplayIndex {
  const templates = new Map(recording.templates.map((t) => [t.id, t]));
  const nodes = new Map(recording.nodes.map((n) => [n.id, n]));
  const findingsByOcc = new Map<string, Finding[]>();
  const findingsById = new Map<string, Finding>();
  const findingsBySource = new Map<string, Finding[]>();
  for (const f of recording.findings ?? []) {
    findingsByOcc.set(f.occurrenceId, [...(findingsByOcc.get(f.occurrenceId) ?? []), f]);
    findingsById.set(f.id, f);
    if (f.taintSource) {
      const key = throwId(f.taintSource.occurrenceId, f.taintSource.handlerId);
      findingsBySource.set(key, [...(findingsBySource.get(key) ?? []), f]);
    }
  }
  const propagations = new Map<string, { occurrenceId: string; handlerId: string }[]>();
  const items: IndexedOccurrence[] = [];
  for (const occ of [...recording.occurrences].sort((a, b) => a.ts - b.ts)) {
    const template = templates.get(occ.templateId);
    if (!template) continue;
    // Events nobody listens to dead-end at their own emitter so they still show up.
    const targets = template.handlerIds.length ? template.handlerIds : [template.emitterId];
    items.push({
      occ, template,
      hops: targets.map((dst) => ({ src: occ.sourceNodeId, dst })),
      throws: occ.handlerResults
        .filter((r) => r.error)
        .map((r) => ({
          at: r.ts + r.durationMs, handlerId: r.handlerId, message: r.error!.message,
          id: r.rethrown ? throwId(r.rethrown.occurrenceId, r.rethrown.handlerId) : throwId(occ.id, r.handlerId),
          rethrown: !!r.rethrown,
        })),
    });
    for (const r of occ.handlerResults) {
      if (!r.rethrown) continue;
      const key = throwId(r.rethrown.occurrenceId, r.rethrown.handlerId);
      propagations.set(key, [...(propagations.get(key) ?? []), { occurrenceId: occ.id, handlerId: r.handlerId }]);
    }
  }
  const events = new Map<string, EventInfo>();
  for (const t of recording.templates) {
    const key = eventKey(t);
    if (!events.has(key)) events.set(key, { key, emitterId: t.emitterId, name: t.eventName, label: `${nodes.get(t.emitterId)?.label ?? '?'}.${t.eventName}` });
  }
  const externalNodes = new Set<string>();
  for (const t of recording.templates) {
    if (!t.external?.length) continue;
    // An external system is usually a handler marked external; otherwise it hangs off the event's emitter.
    const marked = t.handlerIds.filter((id) => t.external!.includes(nodes.get(id)?.label ?? ''));
    for (const id of marked.length ? marked : [t.emitterId]) externalNodes.add(id);
  }
  const start = items.length ? (items[0] as IndexedOccurrence).occ.ts : 0;
  const end = items.reduce((m, i) => Math.max(m, i.occ.ts + i.occ.durationMs), start);
  return {
    recording, events, items, byId: new Map(items.map((i) => [i.occ.id, i])), nodes, externalNodes,
    processLabel: new Map(recording.processes.map((p) => [p.id, p.label])),
    findingsByOcc, findingsById, findingsBySource, propagations, start, end, origin: 0,
  };
}

export const edgeId = (src: string, dst: string) => `${src}>${dst}`;

export interface ActiveOptions {
  /** How long a lit pathway takes to fade, in recording ms. */
  fadeMs: number;
  /** How long the red flash on a throw lasts, in recording ms. */
  flashMs: number;
  window?: [number, number];
  mapNode?: MapNode;
  /** How far later than recorded an occurrence plays (ms, never negative); a live view uses it to play a burst on arrival. */
  shiftOf?: (occurrenceId: string) => number;
}

export interface Active {
  /** 0..1 brightness. */
  litEdges: Map<string, number>;
  /** How far along each event still travelling an edge is, 0 (just sent) to 1 (arrived): one entry per event in flight. */
  pulses: Map<string, number[]>;
  litNodes: Map<string, number>;
  /**
   * Throws that just happened: grab attention. Only the handler that threw is marked, not the pathway into it: a
   * throw says nothing about the payload, and a corrupt one is flagged on its own (`flaggedEdges`).
   */
  flashingNodes: Set<string>;
  /** Throws at or before the playhead: persistent indicator after the flash fades. */
  thrownNodes: Map<string, number>;
  /** Suspected-corrupt payloads at or before the playhead. */
  flaggedEdges: Map<string, { count: number; high: boolean }>;
  /** Flagged payloads lighting up right now. */
  litFlaggedEdges: Set<string>;
}

/** Everything that should be drawn at time `t`. Pure: replay never re-runs user code. */
export function activeAt(index: ReplayIndex, t: number, opts: ActiveOptions): Active {
  const map = opts.mapNode ?? ((id: string) => id);
  const [w0, w1] = opts.window ?? [-Infinity, Infinity];
  const out: Active = {
    litEdges: new Map(), pulses: new Map(), litNodes: new Map(), flashingNodes: new Set(),
    thrownNodes: new Map(), flaggedEdges: new Map(),
    litFlaggedEdges: new Set(),
  };
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const bumpFlag = (m: Map<string, { count: number; high: boolean }>, k: string, high: boolean) => {
    const cur = m.get(k) ?? { count: 0, high: false };
    m.set(k, { count: cur.count + 1, high: cur.high || high });
  };

  const flights = new Map<string, { progress: number; h: number }[]>();

  // Sorted by ts, so start at the window's first event: the cost follows the window, not the recording.
  for (let at = firstAtOrAfter(index.items, w0); at < index.items.length; at++) {
    const { occ, hops, throws } = index.items[at] as IndexedOccurrence;
    if (occ.ts > t || occ.ts > w1) break; // nothing later can have happened yet (a shift only ever delays)
    const shift = opts.shiftOf?.(occ.id) ?? 0;
    if (occ.ts + shift > t) continue;
    const flags = index.findingsByOcc.get(occ.id);
    const high = !!flags?.some((f) => f.priority === 'high');
    const age = t - occ.ts - shift;

    for (const hop of hops) {
      const src = map(hop.src);
      const dst = map(hop.dst);
      if (!src || !dst || src === dst) continue;
      const id = edgeId(src, dst);

      if (age >= 0 && age < opts.fadeMs) {
        const v = 1 - age / opts.fadeMs;
        out.litEdges.set(id, Math.max(out.litEdges.get(id) ?? 0, v));
        const flight = { progress: age / opts.fadeMs, h: hashId(occ.id) };
        const inFlight = flights.get(id);
        if (inFlight) inFlight.push(flight); else flights.set(id, [flight]);
        out.litNodes.set(src, Math.max(out.litNodes.get(src) ?? 0, v));
        out.litNodes.set(dst, Math.max(out.litNodes.get(dst) ?? 0, v));
        if (flags) out.litFlaggedEdges.add(id);
      }
      if (age >= 0 && flags) {
        bumpFlag(out.flaggedEdges, id, high);
      }
      for (const th of throws) {
        // A propagated error is still the one error, so only the handler that first threw it is marked.
        if (th.rethrown || th.handlerId !== hop.dst || th.at + shift > t) continue;
        bump(out.thrownNodes, dst);
        if (t - th.at - shift < opts.flashMs) out.flashingNodes.add(dst);
      }
    }
  }
  for (const [id, list] of flights) out.pulses.set(id, samplePulses(list));
  return out;
}

/** Most pulses drawn on one pathway at once. */
export const MAX_PULSES = 8;

/** A 32-bit FNV-1a hash: the same occurrence always gets the same number. */
function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * The pulses to draw on a pathway with `list` in flight, oldest first. A busy pathway has far more in flight than can be
 * drawn, and taking the newest few would bunch them all at the start of the line. Instead keep the events whose hash
 * is a multiple of a power of two, the smallest that leaves `MAX_PULSES` or fewer: the same events stay chosen from
 * frame to frame (so pulses glide rather than swap places) and they are spread along the whole line.
 */
function samplePulses(list: { progress: number; h: number }[]): number[] {
  let kept = list;
  for (let stride = 2; kept.length > MAX_PULSES; stride *= 2) kept = list.filter((f) => f.h % stride === 0);
  return kept.map((f) => f.progress);
}

/** One mark on the timeline: every point that lands on the same pixel column, drawn once. */
export interface Tick { x: number; count: number; rank: number }

/**
 * Collapses points to at most one tick per pixel column, so thousands of events draw as a bounded number of
 * marks. A merged tick keeps how many points it stands for and the highest `rank` among them. Sorted by `x`.
 */
export function mergeTicks(points: { x: number; rank?: number }[]): Tick[] {
  const byColumn = new Map<number, Tick>();
  for (const { x, rank = 0 } of points) {
    const col = Math.round(x);
    const tick = byColumn.get(col);
    if (tick) {
      tick.count++;
      tick.rank = Math.max(tick.rank, rank);
    } else {
      byColumn.set(col, { x: col, count: 1, rank });
    }
  }
  return [...byColumn.values()].sort((a, b) => a.x - b.x);
}

/** The position of the first item at or after `ts` (`items.length` when there is none). `items` is sorted by `ts`. */
function firstAtOrAfter(items: IndexedOccurrence[], ts: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((items[mid] as IndexedOccurrence).occ.ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The position of the first item after `ts`. */
function firstAfter(items: IndexedOccurrence[], ts: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((items[mid] as IndexedOccurrence).occ.ts <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Items inside the replay window, for lists and the histogram. */
export function inWindow(index: ReplayIndex, window: [number, number]): IndexedOccurrence[] {
  return index.items.slice(firstAtOrAfter(index.items, window[0]), firstAfter(index.items, window[1]));
}

/** The most events a live view keeps in memory: a few windows' worth, so scrubbing back a little still works. */
export const MAX_KEPT_EVENTS = 2000;

/**
 * `recording` with only its newest `max` occurrences, and the findings about them. Everything the viewer derives
 * (the index, the timeline overview) then stays bounded however long a live stream runs. Processes, handlers and
 * templates are few, so they stay.
 */
export function keepNewest(recording: Recording, max = MAX_KEPT_EVENTS): Recording {
  if (recording.occurrences.length <= max) return recording;
  const occurrences = [...recording.occurrences].sort((a, b) => a.ts - b.ts).slice(-max);
  const kept = new Set(occurrences.map((o) => o.id));
  return { ...recording, occurrences, findings: recording.findings?.filter((f) => kept.has(f.occurrenceId)) };
}

/** The most events a replay window holds. Everything the viewer draws or lists comes from the window, so this bounds its work. */
export const MAX_WINDOW_EVENTS = 500;

/**
 * `window`, narrowed to hold at most `max` events. `keep` is the side that stays where it is; the other edge moves in
 * (so dragging a handle makes the opposite one follow, and a live window keeps its newest events).
 */
export function capWindow(index: ReplayIndex, window: [number, number], keep: 'start' | 'end', max = MAX_WINDOW_EVENTS): [number, number] {
  const lo = firstAtOrAfter(index.items, window[0]);
  const hi = firstAfter(index.items, window[1]);
  if (hi - lo <= max) return window;
  return keep === 'end'
    ? [(index.items[hi - max] as IndexedOccurrence).occ.ts, window[1]]
    : [window[0], (index.items[lo + max - 1] as IndexedOccurrence).occ.ts];
}

/** How many events past the playhead an automatic window reaches, so playback has room before the window has to move. */
export const TRAIL_AHEAD_EVENTS = 100;

/**
 * The window that trails playhead `t`: the newest `max` events up to a little past `t`. The viewer moves to it only
 * when `t` leaves the current window, so playing doesn't rebuild the graph on every frame.
 */
export function windowAround(index: ReplayIndex, t: number, max = MAX_WINDOW_EVENTS, ahead = TRAIL_AHEAD_EVENTS): [number, number] {
  const n = index.items.length;
  if (!n) return [index.start, index.end];
  const hi = Math.min(firstAfter(index.items, t) + ahead, n);
  const lo = Math.max(hi - max, 0);
  return [lo === 0 ? index.start : (index.items[lo] as IndexedOccurrence).occ.ts, hi >= n ? index.end : (index.items[hi - 1] as IndexedOccurrence).occ.ts];
}

/**
 * How many of the ascending `times` have fired by playhead `t`. The playhead starts on the first event, so
 * counting is strict (an event at `t` hasn't ticked yet) and every counter starts at zero; at the end of the
 * window everything counts, so the counters finish on their totals.
 */
export function countFired(times: number[], t: number, end: number): number {
  if (t >= end) return times.length;
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** "Auth.login ▸ Cart.cart:load": the chain of events that led to this one, root first. */
export function chainOf(index: ReplayIndex, occurrenceId: string): IndexedOccurrence[] {
  const chain: IndexedOccurrence[] = [];
  const seen = new Set<string>();
  let cur = index.byId.get(occurrenceId);
  while (cur && !seen.has(cur.occ.id)) {
    seen.add(cur.occ.id);
    chain.unshift(cur);
    cur = cur.occ.parentId ? index.byId.get(cur.occ.parentId) : undefined;
  }
  return chain;
}

export type ChainStep = { kind: 'event'; item: IndexedOccurrence } | { kind: 'handler'; nodeId: string };

/**
 * The chain of events leading to `occurrenceId` with the handler that emitted each next event
 * between them, root first. `truncated` means the root's parent was evicted from the buffer.
 */
export function callChain(index: ReplayIndex, occurrenceId: string): { steps: ChainStep[]; truncated: boolean } {
  const chain = chainOf(index, occurrenceId);
  const steps: ChainStep[] = [];
  chain.forEach((item, k) => {
    // A root's source is its own emitter, which the event label already names.
    if (k > 0) steps.push({ kind: 'handler', nodeId: item.occ.sourceNodeId });
    steps.push({ kind: 'event', item });
  });
  const parentId = chain[0]?.occ.parentId;
  return { steps, truncated: !!parentId && !index.byId.has(parentId) };
}

export function eventLabel(index: ReplayIndex, item: IndexedOccurrence): string {
  return index.events.get(eventKey(item.template))?.label ?? `?.${item.template.eventName}`;
}

export interface Notification {
  /** Selection id: a `throwId` for throws, the finding id for findings. */
  id: string;
  kind: 'throw' | 'finding';
  occurrenceId: string;
  rank: Rank;
  tier: Tier;
  text: string;
  external: boolean;
  /** Set for findings with no error thrown. */
  unattributed: boolean;
  /** Set for findings, which render their own summary. */
  finding?: Finding;
}

/** Throws and findings among `items`, most severe first. */
export function notifications(index: ReplayIndex, items: IndexedOccurrence[]): Notification[] {
  const out: Notification[] = [];
  for (const i of items) {
    for (const th of i.throws) {
      if (th.rethrown) continue;
      const id = th.id;
      const rank = throwRank(index.findingsBySource.get(id) ?? [], th.at);
      out.push({ id, kind: 'throw', occurrenceId: i.occ.id, rank, tier: tierOf(rank.score), text: `${index.nodes.get(th.handlerId)?.label} threw: ${th.message}`, external: rank.external, unattributed: false });
    }
    for (const f of index.findingsByOcc.get(i.occ.id) ?? []) {
      const rank = findingRank(f);
      out.push({ id: f.id, kind: 'finding', occurrenceId: i.occ.id, rank, tier: tierOf(rank.score), text: f.summary, external: rank.external, unattributed: !f.taintSource, finding: f });
    }
  }
  return out.sort((a, b) => compareRank(a.rank, b.rank));
}

export interface Recipient {
  label: string;
  external: boolean;
  /** Corrupted payloads delivered here. */
  count: number;
  /** The node to show on the graph for this recipient. */
  nodeId?: string;
}

/** Where `findings` were sent: external systems first, then by how many payloads each received. */
export function recipientsOf(index: ReplayIndex, findings: Finding[]): Recipient[] {
  const byLabel = new Map<string, Recipient>();
  const add = (label: string, external: boolean, nodeId?: string) => {
    const key = `${external}:${label}`;
    const have = byLabel.get(key);
    if (have) have.count++;
    else byLabel.set(key, { label, external, count: 1, nodeId });
  };
  for (const f of findings) {
    const item = index.byId.get(f.occurrenceId);
    const external = new Set(f.externalTargets);
    // An external system is usually a handler marked external; otherwise it hangs off the event's emitter.
    for (const label of external) {
      const handler = item?.template.handlerIds.find((id) => index.nodes.get(id)?.label === label);
      add(label, true, handler ?? item?.template.emitterId);
    }
    // Events nobody listens to dead-end at their own emitter; that isn't a recipient.
    for (const dst of item?.template.handlerIds ?? []) {
      const label = index.nodes.get(dst)?.label ?? dst;
      if (!external.has(label)) add(label, false, dst);
    }
  }
  return [...byLabel.values()].sort((a, b) => Number(b.external) - Number(a.external) || b.count - a.count || a.label.localeCompare(b.label));
}

/** How often the graph's rates update, in recording ms. Each rate is the average over one such step. */
export const RATE_STEP_MS = 5000;
/** How many past rates the inspector charts: 60 steps of 5 s, the last five minutes. */
export const RATE_HISTORY = 60;

/**
 * Events per second, per pathway and per node as receiver (`in`) and sender (`out`), for each of the last
 * `RATE_HISTORY` completed `RATE_STEP_MS` steps before `t`, oldest first. Steps are fixed to recording time, so the
 * newest value only changes when the playhead crosses into the next step. Counted like the window totals in
 * `buildModel`: a node's traffic inside its own process counts towards it, but not towards a pathway.
 */
export interface RateSeries {
  /** The step `t` is in; the newest value covers the step before it. */
  step: number;
  edges: Map<string, number[]>;
  in: Map<string, number[]>;
  out: Map<string, number[]>;
}

interface RateOptions {
  mapNode?: MapNode;
  shiftOf?: (occurrenceId: string) => number;
}

/** Calls `visit` for every hop of every event that plays in `[lo, hi)`, scanning from item `scanFrom`. */
function eachPlayedHop(index: ReplayIndex, lo: number, hi: number, opts: RateOptions, scanFrom: number, visit: (src: string, dst: string, at: number) => void): void {
  const map = opts.mapNode ?? ((id: string) => id);
  for (let i = scanFrom; i < index.items.length; i++) {
    const { occ, hops } = index.items[i] as IndexedOccurrence;
    if (occ.ts >= hi) break; // sorted by ts, and a shift only ever delays
    const at = occ.ts + (opts.shiftOf?.(occ.id) ?? 0);
    if (at < lo || at >= hi) continue;
    for (const hop of hops) {
      const src = map(hop.src);
      const dst = map(hop.dst);
      if (src && dst) visit(src, dst, at);
    }
  }
}

export function rateSeries(index: ReplayIndex, t: number, opts: RateOptions = {}): RateSeries {
  const step = Math.floor(t / RATE_STEP_MS);
  const hi = step * RATE_STEP_MS;
  const lo = hi - RATE_HISTORY * RATE_STEP_MS;
  const out: RateSeries = { step, edges: new Map(), in: new Map(), out: new Map() };
  const add = (m: Map<string, number[]>, k: string, slot: number) => {
    let row = m.get(k);
    if (!row) m.set(k, (row = new Array<number>(RATE_HISTORY).fill(0)));
    row[slot]! += 1;
  };
  eachPlayedHop(index, lo, hi, opts, 0, (src, dst, at) => {
    const slot = Math.floor((at - lo) / RATE_STEP_MS);
    add(out.in, dst, slot);
    add(out.out, src, slot);
    if (src !== dst) add(out.edges, edgeId(src, dst), slot);
  });
  // Counted whole, then turned into per-second rates, so a steady 4/s reads exactly 4.
  for (const m of [out.edges, out.in, out.out]) for (const row of m.values()) for (let i = 0; i < row.length; i++) row[i] = row[i]! * 1000 / RATE_STEP_MS;
  return out;
}

/** The last second is checked for a spike this precisely: a rate at least this many events per second... */
export const SPIKE_MIN = 10;
/** ...and at least this many times the shown 5 s rate, gets shown at once instead of at the next step. */
export const SPIKE_RATIO = 2;
/** How far back a spike check looks, in ms. */
export const SPIKE_WINDOW_MS = 1000;

/** Events per second over the last `SPIKE_WINDOW_MS` up to `t`, counted like `rateSeries`. */
export interface RecentRates {
  edges: Map<string, number>;
  in: Map<string, number>;
  out: Map<string, number>;
}

// Nudges both edges of the window so it covers (t - window, t]: an event exactly `window` ago is out, one at `t` is in.
const NUDGE = 1e-6;

/** `maxShiftMs` is how much later than recorded an event can play, which sets how far back the scan has to start. */
export function recentRates(index: ReplayIndex, t: number, opts: RateOptions & { maxShiftMs?: number } = {}): RecentRates {
  const lo = t - SPIKE_WINDOW_MS + NUDGE;
  const out: RecentRates = { edges: new Map(), in: new Map(), out: new Map() };
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1000 / SPIKE_WINDOW_MS);
  eachPlayedHop(index, lo, t + NUDGE, opts, firstAtOrAfter(index.items, lo - (opts.maxShiftMs ?? 0)), (src, dst) => {
    bump(out.in, dst);
    bump(out.out, src);
    if (src !== dst) bump(out.edges, edgeId(src, dst));
  });
  return out;
}

/** What a label shows, and whether it is a spike shown ahead of its step. */
export interface Shown { value: number; spike: boolean }
export interface ShownRates {
  edges: Map<string, Shown>;
  in: Map<string, Shown>;
  out: Map<string, Shown>;
}

/** The spikes latched so far in one step at one zoom level (`key`), per pathway and per node. */
export interface HeldSpikes {
  key: string;
  edges: Map<string, number>;
  in: Map<string, number>;
  out: Map<string, number>;
}

/**
 * What the graph's labels show: the 5 s rate, except where the last second spiked. A spike is latched the first time
 * it meets both limits within a step and held until the step changes (`key` changes), when the label goes back to the
 * new step's average. Pass the `held` from the previous call; it is ignored once `key` differs.
 */
export function shownRates(series: RateSeries, recent: RecentRates, held: HeldSpikes | null, key: string): { shown: ShownRates; held: HeldSpikes } {
  const next: HeldSpikes = held && held.key === key
    ? { key, edges: new Map(held.edges), in: new Map(held.in), out: new Map(held.out) }
    : { key, edges: new Map(), in: new Map(), out: new Map() };
  const shown: ShownRates = { edges: new Map(), in: new Map(), out: new Map() };
  for (const kind of ['edges', 'in', 'out'] as const) {
    const ids = new Set([...series[kind].keys(), ...recent[kind].keys(), ...next[kind].keys()]);
    for (const id of ids) {
      const base = series[kind].get(id)?.at(-1) ?? 0;
      let spike = next[kind].get(id);
      if (spike === undefined) {
        const r = recent[kind].get(id) ?? 0;
        if (r >= SPIKE_MIN && r >= SPIKE_RATIO * base) { next[kind].set(id, r); spike = r; }
      }
      shown[kind].set(id, { value: spike ?? base, spike: spike !== undefined });
    }
  }
  return { shown, held: next };
}

/** The graph's rates: the series the inspector charts, and what the labels show. */
export interface Rates {
  series: RateSeries;
  shown: ShownRates;
}

/** A rate for display: one decimal below 10/s, whole numbers above. */
export function fmtRate(perSecond: number): string {
  if (perSecond === 0) return '0';
  return perSecond < 10 ? perSecond.toFixed(1).replace(/\.0$/, '') : String(Math.round(perSecond));
}
