import type { RecorderMessage, Recording } from '@eda-debugger/core';
import { create } from 'zustand';
import type { Level } from './graph/model';
import { ZOOM_MS } from './graph/zoom';
import { buildIndex, parseRunId, parseThrowId, type ReplayIndex } from './replay';

export const SPEEDS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 4];
/** Wall-clock lengths of the lit fade and the red flash, scaled to recording time by playback speed. */
export const FADE_WALL_MS = 700;
export const FLASH_WALL_MS = 900;

/** How many steps of the inspection trail the inspector keeps. */
export const TRAIL_MAX = 8;

/** A `throw` id is `<occurrenceId>|<handlerId>`; see `throwId`. An `event` id is an `eventKey`, a `run` id a `runId`. */
export type Selection =
  | { type: 'event'; id: string }
  | { type: 'node'; id: string }
  | { type: 'edge'; id: string }
  | { type: 'occurrence'; id: string }
  | { type: 'throw'; id: string }
  | { type: 'finding'; id: string }
  | { type: 'run'; id: string }
  | null;

/** What the graph should pan to and pulse: a node (raw or as drawn) or a pathway. */
export type FocusTarget = { nodeId: string; edgeId?: undefined } | { nodeId?: undefined; edgeId: string };

/** The graph element a selection is about, or null when it has none in the recording. */
export function focusTargetOf(index: ReplayIndex | null, sel: NonNullable<Selection>): FocusTarget | null {
  if (!index) return null;
  switch (sel.type) {
    case 'node': return { nodeId: sel.id };
    case 'edge': return { edgeId: sel.id };
    case 'event': { const e = index.events.get(sel.id); return e ? { nodeId: e.emitterId } : null; }
    case 'occurrence': { const i = index.byId.get(sel.id); return i ? { nodeId: i.occ.sourceNodeId } : null; }
    case 'run': { const r = parseRunId(index, sel.id); return r ? { nodeId: r.nodeId } : null; }
    case 'throw': { const t = parseThrowId(index, sel.id); return t ? { nodeId: t.handlerId } : null; }
    case 'finding': {
      const f = index.findingsById.get(sel.id);
      const i = f && index.byId.get(f.occurrenceId);
      return i ? { nodeId: i.occ.sourceNodeId } : null;
    }
  }
}

/** Events, errors, payloads and runs mean the same thing at every zoom level, so inspecting one survives a zoom. */
const levelFree = (t: Selection) => t?.type === 'event' || t?.type === 'throw' || t?.type === 'finding' || t?.type === 'run';

/**
 * The zoom level that draws what `sel` is about, or null when the current one already does. Handlers are only drawn
 * inside their own process, so a link to one in another process (or, for the selections that name a specific
 * handler, from the process overview) changes scope instead of stopping at that process's node.
 */
function scopeFor(index: ReplayIndex | null, level: Level, sel: NonNullable<Selection>, target: FocusTarget | null): Level | null {
  const processId = target?.nodeId ? index?.nodes.get(target.nodeId)?.processId : undefined;
  if (!processId) return null;
  if (level.kind === 'handlers') return level.processId === processId ? null : { kind: 'handlers', processId };
  return sel.type === 'node' || sel.type === 'run' || sel.type === 'throw' || sel.type === 'finding' ? { kind: 'handlers', processId } : null;
}

type LiveStatus = 'off' | 'connecting' | 'on' | 'error';

interface State {
  recording: Recording | null;
  index: ReplayIndex | null;
  sourceName: string;
  t: number;
  playing: boolean;
  speed: number;
  window: [number, number];
  level: Level;
  selection: Selection;
  /** Everything inspected at this zoom level, oldest first; `selection` is always its last entry. */
  trail: NonNullable<Selection>[];
  /** A node or pathway the graph should pan to and pulse; `seq` makes repeat requests for the same one count. */
  focus: (FocusTarget & { seq: number }) | null;
  live: LiveStatus;
  following: boolean;

  load(recording: Recording, name: string): void;
  setT(t: number): void;
  togglePlay(): void;
  pause(): void;
  tick(wallMs: number): void;
  setSpeed(speed: number): void;
  setWindow(window: [number, number]): void;
  setLevel(level: Level): void;
  /** `fromGraph` marks a click on the graph itself: everything drawn there sits directly under the level, so it starts a new trail. */
  select(selection: Selection, opts?: { fromGraph?: boolean }): void;
  /** Inspects an occurrence and moves the playhead to it; see `selectAt`. */
  seekToOccurrence(id: string): void;
  /** Selects `selection` and moves the playhead to the occurrence it is about, widening the window to include it. */
  selectAt(selection: NonNullable<Selection>, occurrenceId: string): void;
  /** Inspects a handler: zooms into its process if needed, selects it and pans the graph to it. */
  inspectNode(rawNodeId: string): void;
  /** `name` is shown as the source instead of the URL. */
  connectLive(url: string, name?: string): void;
  disconnectLive(): void;
  /** Disconnects and forgets the current recording, so a page that loads another doesn't show this one meanwhile. */
  unload(): void;
}

const sameSelection = (a: NonNullable<Selection>, b: NonNullable<Selection>) => a.type === b.type && a.id === b.id;

/**
 * Inspecting something already on the trail goes back to it. Something of the same kind as the last step is a sibling
 * of it (another node on the graph, another event in the chain, another finding on the occurrence), so it takes that
 * step's place; anything else is added to the end.
 */
export function extendTrail(trail: NonNullable<Selection>[], next: NonNullable<Selection>): NonNullable<Selection>[] {
  const at = trail.findIndex((t) => sameSelection(t, next));
  if (at >= 0) return trail.slice(0, at + 1);
  const base = trail.length && trail[trail.length - 1]!.type === next.type ? trail.slice(0, -1) : trail;
  return [...base, next].slice(-TRAIL_MAX);
}

export function pickSpeed(rangeMs: number): number {
  const fit = SPEEDS.filter((s) => rangeMs / s >= 8000);
  return fit.length ? (fit[fit.length - 1] as number) : (SPEEDS[0] as number);
}

let source: EventSource | null = null;

export const useStore = create<State>()((set, get) => {
  /** Asks the graph to pan to and pulse `target`; `seq` makes repeat requests count, and the request clears itself. */
  let focusSeq = 0; // never reset, so a request is told apart from every earlier one even after focus clears
  const setFocus = (target: FocusTarget, extraMs = 0) => {
    const seq = ++focusSeq;
    set({ focus: { ...target, seq } });
    setTimeout(() => { if (get().focus?.seq === seq) set({ focus: null }); }, 1600 + extraMs);
  };

  /** Selects `selection` and shows it on the graph, first changing zoom level if it isn't drawn at the current one. */
  const reveal = (selection: NonNullable<Selection>, extra: Partial<State> = {}) => {
    const { index, level, trail } = get();
    const target = focusTargetOf(index, selection);
    const to = scopeFor(index, level, selection, target);
    // Node, edge and occurrence selections belong to the level being left.
    set({ ...extra, selection, trail: extendTrail(to ? trail.filter(levelFree) : trail, selection), ...(to && { level: to }) });
    if (target) setFocus(target, to ? ZOOM_MS : 0);
  };

  let pending: Recording | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    flushTimer = null;
    if (!pending) return;
    const rec = pending;
    pending = null;
    applyRecording(rec, true);
  };
  const schedule = () => {
    if (!flushTimer) flushTimer = setTimeout(flush, 250);
  };

  function applyRecording(recording: Recording, live: boolean, name?: string) {
    const index = buildIndex(recording);
    const s = get();
    const keepView = live && s.index !== null;
    const following = keepView ? s.following : true;
    const full: [number, number] = [index.start, index.end];
    set({
      recording, index,
      sourceName: name ?? s.sourceName,
      window: keepView && !following ? s.window : full,
      t: keepView && !following ? Math.min(Math.max(s.t, index.start), index.end) : following && live ? index.end : index.start,
      speed: keepView ? s.speed : pickSpeed(index.end - index.start),
      level: keepView ? s.level : { kind: 'process' },
      selection: keepView ? s.selection : null,
      trail: keepView ? s.trail : [],
      playing: false,
      following,
    });
  }

  return {
    recording: null, index: null, sourceName: '', t: 0, playing: false, speed: 1, window: [0, 0],
    level: { kind: 'process' }, selection: null, trail: [], focus: null, live: 'off', following: true,

    load(recording, name) {
      get().disconnectLive();
      applyRecording(recording, false, name);
    },
    setT(t) {
      const [w0, w1] = get().window;
      set({ t: Math.min(Math.max(t, w0), w1), following: false });
    },
    togglePlay() {
      const { playing, t, window } = get();
      if (playing) return set({ playing: false });
      set({ playing: true, t: t >= window[1] ? window[0] : t, following: false });
    },
    pause() { set({ playing: false }); },
    tick(wallMs) {
      const { t, speed, window, playing } = get();
      if (!playing) return;
      const next = t + wallMs * speed;
      if (next >= window[1]) set({ t: window[1], playing: false });
      else set({ t: next });
    },
    setSpeed(speed) { set({ speed }); },
    setWindow(window) {
      const [a, b] = window;
      const { t } = get();
      set({ window: [Math.min(a, b), Math.max(a, b)], t: Math.min(Math.max(t, Math.min(a, b)), Math.max(a, b)), following: false });
    },
    setLevel(level) { set({ level, selection: null, trail: [] }); },
    select(selection, opts) {
      // Clicking the graph itself needs no pan; anything else (a link in the inspector) shows where it is.
      if (selection && !opts?.fromGraph) reveal(selection);
      else set((s) => ({ selection, trail: !selection ? [] : [selection] }));
    },
    seekToOccurrence(id) { get().selectAt({ type: 'occurrence', id }, id); },
    selectAt(selection, occurrenceId) {
      const item = get().index?.byId.get(occurrenceId);
      if (!item) return;
      const [w0, w1] = get().window;
      reveal(selection, {
        t: item.occ.ts, playing: false, following: false,
        window: [Math.min(w0, item.occ.ts), Math.max(w1, item.occ.ts)],
      });
    },
    inspectNode(nodeId) { reveal({ type: 'node', id: nodeId }); },

    connectLive(url, name) {
      get().disconnectLive();
      set({ live: 'connecting' });
      const es = new EventSource(url);
      source = es;
      es.onopen = () => set({ live: 'on' });
      es.onerror = () => set({ live: es.readyState === EventSource.CLOSED ? 'error' : 'connecting' });
      es.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as RecorderMessage;
        if (msg.type === 'snapshot') {
          pending = msg.recording;
          flush();
          set({ sourceName: `live · ${name ?? url}` });
        } else if (msg.type === 'finding') {
          const base = pending ?? get().recording;
          // A finding re-sent under the same id is an existing one that was traced to its source error.
          const known = (base?.findings ?? []).some((f) => f.id === msg.finding.id);
          if (base) {
            const list = base.findings ?? [];
            pending = { ...base, findings: known ? list.map((f) => (f.id === msg.finding.id ? msg.finding : f)) : [...list, msg.finding] };
            schedule();
          }
        } else if (msg.type === 'occurrence') {
          const base = pending ?? get().recording;
          if (!base) return;
          const have = <T extends { id: string }>(list: T[], item: T) => list.some((x) => x.id === item.id);
          pending = {
            ...base,
            processes: [...base.processes, ...msg.processes.filter((p) => !have(base.processes, p))],
            nodes: [...base.nodes, ...msg.nodes.filter((n) => !have(base.nodes, n))],
            templates: have(base.templates, msg.template)
              ? base.templates.map((t) => (t.id === msg.template.id ? msg.template : t))
              : [...base.templates, msg.template],
            occurrences: have(base.occurrences, msg.occurrence)
              ? base.occurrences.map((o) => (o.id === msg.occurrence.id ? msg.occurrence : o))
              : [...base.occurrences, msg.occurrence],
          };
          schedule();
        }
      };
    },
    disconnectLive() {
      source?.close();
      source = null;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      pending = null;
      if (get().live !== 'off') set({ live: 'off' });
    },
    unload() {
      get().disconnectLive();
      set({ recording: null, index: null, sourceName: '', selection: null, trail: [], focus: null, playing: false, level: { kind: 'process' } });
    },
  };
});
