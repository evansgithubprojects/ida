import type { RecorderMessage, Recording } from '@ida/core';
import { create } from 'zustand';
import type { Level } from './graph/model';
import { ZOOM_MS } from './graph/zoom';
import { buildIndex, capWindow, keepNewest, parseRunId, parseThrowId, windowAround, type ReplayIndex } from './replay';

export const SPEEDS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 4];
/** Wall-clock lengths of the lit fade and the red flash, scaled to recording time by playback speed. */
export const FADE_WALL_MS = 700;
export const FLASH_WALL_MS = 900;
/**
 * A following live view's clock never stops, so pulses in flight always finish and the graph keeps animating between
 * upload bursts. A burst that arrives is already in the past, so its events are shifted (see `liveShift`) to play from
 * now, at their recorded spacing. The live view draws no playhead, so the delay this adds is invisible. A burst more
 * than this late (a hidden tab, a long outage) is not replayed: it lands in the past and the clock moves on.
 */
export const LIVE_RESYNC_MS = 10_000;

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

export type LiveStatus = 'off' | 'connecting' | 'on' | 'error';

interface State {
  recording: Recording | null;
  index: ReplayIndex | null;
  sourceName: string;
  t: number;
  playing: boolean;
  speed: number;
  window: [number, number];
  level: Level;
  /** Graph setting: hide the count and the pulse on pathways with no suspect payloads. Persists across reloads. */
  hideHealthy: boolean;
  /** Whether the inspector panel is shown. Persists across reloads. */
  inspectorOpen: boolean;
  selection: Selection;
  /** Everything inspected at this zoom level, oldest first; `selection` is always its last entry. */
  trail: NonNullable<Selection>[];
  /** A node or pathway the graph should pan to and pulse; `seq` makes repeat requests for the same one count. */
  focus: (FocusTarget & { seq: number }) | null;
  live: LiveStatus;
  following: boolean;
  /** Live only: how many ms later than recorded each late occurrence plays, so a burst plays from the moment it arrives. */
  liveShift: Map<string, number>;
  /** Live follows the stream's newest events with no timeline; Replay opens the scrub window. Saved recordings are always Replay. */
  mode: 'live' | 'replay';

  setMode(mode: 'live' | 'replay'): void;
  load(recording: Recording, name: string): void;
  setT(t: number): void;
  togglePlay(): void;
  pause(): void;
  tick(wallMs: number): void;
  setSpeed(speed: number): void;
  /** Sets the replay window, narrowed to the event cap: `keep` is the side that stays put, the other edge follows. */
  setWindow(window: [number, number], keep?: 'start' | 'end'): void;
  setLevel(level: Level): void;
  setHideHealthy(hide: boolean): void;
  setInspectorOpen(open: boolean): void;
  /** `fromGraph` marks a click on the graph itself: everything drawn there sits directly under the level, so it starts a new trail. */
  select(selection: Selection, opts?: { fromGraph?: boolean }): void;
  /** Inspects an occurrence and moves the playhead to it; see `selectAt`. */
  seekToOccurrence(id: string): void;
  /** Selects `selection` and moves the playhead to the occurrence it is about; the window follows it if needed. */
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

const SETTINGS_KEY = 'ida_graph_settings';

interface Settings { hideHealthy: boolean; inspectorOpen: boolean }

function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>;
    return { hideHealthy: saved.hideHealthy === true, inspectorOpen: saved.inspectorOpen !== false };
  } catch {
    return { hideHealthy: false, inspectorOpen: true };
  }
}

/** Merges into what is stored, so changing one setting keeps the others. */
function saveSettings(patch: Partial<Settings>): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), ...patch })); } catch { /* storage unavailable: the setting just won't persist */ }
}

export const useStore = create<State>()((set, get) => {
  /** Asks the graph to pan to and pulse `target`; `seq` makes repeat requests count, and the request clears itself. */
  let focusSeq = 0; // never reset, so a request is told apart from every earlier one even after focus clears
  const setFocus = (target: FocusTarget, extraMs = 0) => {
    const seq = ++focusSeq;
    set({ focus: { ...target, seq } });
    setTimeout(() => { if (get().focus?.seq === seq) set({ focus: null }); }, 1600 + extraMs);
  };

  /** The replay window stays put while the playhead is inside it; once it leaves, the window moves to trail it. */
  const trailing = (index: ReplayIndex | null, window: [number, number], t: number): [number, number] =>
    !index || (t >= window[0] && t <= window[1]) ? window : windowAround(index, t);

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

  /** Where a following live view's clock stands after new events arrive: where it was, or the newest event at the start. */
  function followT(end: number, t: number | null): number {
    return t === null ? end : t;
  }

  /** Shifts for the occurrences that just arrived so that the first of them plays at `t`; earlier shifts are kept. */
  function shiftsFor(prev: ReplayIndex | null, index: ReplayIndex, t: number, old: Map<string, number>): Map<string, number> {
    const out = new Map<string, number>();
    const fresh = prev ? index.items.filter((i) => !prev.byId.has(i.occ.id)) : [];
    for (const i of index.items) {
      const kept = old.get(i.occ.id);
      if (kept) out.set(i.occ.id, kept);
    }
    if (!fresh.length) return out;
    const late = t - Math.min(...fresh.map((i) => i.occ.ts));
    if (late > 0 && late <= LIVE_RESYNC_MS) for (const i of fresh) out.set(i.occ.id, late);
    return out;
  }

  function applyRecording(streamed: Recording, live: boolean, name?: string) {
    // A live stream never ends, so only its newest events are kept. A saved recording is loaded whole.
    const recording = live ? keepNewest(streamed) : streamed;
    const index = buildIndex(recording);
    const s = get();
    const keepView = live && s.index !== null;
    const mode: 'live' | 'replay' = keepView ? s.mode : live ? 'live' : 'replay';
    const following = mode === 'live';
    // The newest events: a big recording opens on its latest stretch, and a following live view slides along.
    const full = capWindow(index, [index.start, index.end], 'end');
    // Old events leave as new ones arrive, so a window left behind is pulled back inside what is still kept.
    const stay: [number, number] = [Math.max(s.window[0], index.start), Math.min(s.window[1], index.end)];
    const kept = stay[0] <= stay[1] ? stay : full;
    set({
      recording, index,
      sourceName: name ?? s.sourceName,
      window: keepView && !following ? kept : full,
      // A following live view trails the newest events slightly and catches up in real time (see `tick`), so the pulses
      // of what just arrived play out instead of the playhead jumping past them.
      t: keepView && !following ? Math.min(Math.max(s.t, kept[0]), kept[1])
        : following && live ? followT(index.end, keepView ? s.t : null) : full[0],
      speed: keepView ? s.speed : pickSpeed(full[1] - full[0]),
      level: keepView ? s.level : { kind: 'process' },
      selection: keepView ? s.selection : null,
      trail: keepView ? s.trail : [],
      playing: false,
      following, mode,
      liveShift: following && live && keepView ? shiftsFor(s.index, index, s.t, s.liveShift) : new Map(),
    });
  }

  return {
    recording: null, index: null, sourceName: '', t: 0, playing: false, speed: 1, window: [0, 0],
    level: { kind: 'process' }, ...loadSettings(), selection: null, trail: [], focus: null, live: 'off', following: true, mode: 'live', liveShift: new Map(),

    load(recording, name) {
      get().disconnectLive();
      applyRecording(recording, false, name);
    },
    setMode(mode) {
      const { index, t, live } = get();
      if (!index) return;
      if (mode === 'live') {
        if (live === 'off') return;
        const full = capWindow(index, [index.start, index.end], 'end');
        set({ mode, following: true, playing: false, window: full, t: followT(index.end, null), liveShift: new Map() });
      } else {
        const [w0, w1] = get().window;
        set({ mode, following: false, playing: false, t: Math.min(Math.max(t, w0), w1), liveShift: new Map() });
      }
    },
    setT(t) {
      const { index, window } = get();
      const at = index ? Math.min(Math.max(t, index.start), index.end) : t;
      set({ t: at, window: trailing(index, window, at), following: false, mode: 'replay' });
    },
    togglePlay() {
      const { playing, t, index, window } = get();
      if (playing) return set({ playing: false });
      const at = index && t >= index.end ? index.start : t;
      set({ playing: true, t: at, window: trailing(index, window, at), following: false, mode: 'replay' });
    },
    pause() { set({ playing: false }); },
    tick(wallMs) {
      const { t, speed, window, playing, following, live, index } = get();
      if (!playing) {
        // A following live view's clock never stops.
        if (following && live === 'on' && index) set({ t: t + wallMs });
        return;
      }
      const next = t + wallMs * speed;
      const end = index ? index.end : window[1];
      if (next >= end) set({ t: end, window: trailing(index, window, end), playing: false });
      else set({ t: next, window: trailing(index, window, next) });
    },
    setSpeed(speed) { set({ speed }); },
    setWindow(window, keep = 'end') {
      const { t, index } = get();
      const sorted: [number, number] = [Math.min(...window), Math.max(...window)];
      const [a, b] = index ? capWindow(index, sorted, keep) : sorted;
      set({ window: [a, b], t: Math.min(Math.max(t, a), b), following: false, mode: 'replay' });
    },
    setLevel(level) { set({ level, selection: null, trail: [] }); },
    setHideHealthy(hideHealthy) {
      set({ hideHealthy });
      saveSettings({ hideHealthy });
    },
    setInspectorOpen(inspectorOpen) {
      set({ inspectorOpen });
      saveSettings({ inspectorOpen });
    },
    select(selection, opts) {
      // Clicking the graph itself needs no pan; anything else (a link in the inspector) shows where it is.
      if (selection && !opts?.fromGraph) reveal(selection);
      else set((s) => ({ selection, trail: !selection ? [] : [selection] }));
      // Clicking something on the graph is asking to see it, so a hidden inspector opens.
      if (selection && opts?.fromGraph && !get().inspectorOpen) get().setInspectorOpen(true);
    },
    seekToOccurrence(id) { get().selectAt({ type: 'occurrence', id }, id); },
    selectAt(selection, occurrenceId) {
      const item = get().index?.byId.get(occurrenceId);
      if (!item) return;
      const { window, index } = get();
      const ts = item.occ.ts;
      reveal(selection, { t: ts, playing: false, following: false, mode: 'replay', window: trailing(index, window, ts) });
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
