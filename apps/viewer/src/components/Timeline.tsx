import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { inWindow, mergeTicks, type ReplayIndex, type Tick } from '../replay';
import { SPEEDS, useStore } from '../store';
import { fmtMs } from './common';

const H = 64;
// Window bounds are wall-clock: recorder timestamps count from the recording's start.
const fmtDate = (epochMs: number) => new Date(epochMs).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });

/** The footer: Live follows the stream; Replay opens the scrub panel. A saved recording shows only the scrub panel. */
export function Timeline({ exit }: { /** Shown at the right end of the play controls. */ exit?: ReactNode }) {
  const index = useStore((s) => s.index)!;
  const mode = useStore((s) => s.mode);
  const live = useStore((s) => s.live);
  const window = useStore((s) => s.window);
  const { setMode } = useStore.getState();
  const shown = useMemo(() => inWindow(index, window).length, [index, window]);
  return (
    <div className="timeline">
      {/* A saved recording has no stream to follow, so there is nothing to switch between. */}
      {live !== 'off' && (
      <div className="modebar">
        <div className="segmented" role="group" aria-label="View mode">
          <button
            className={mode === 'live' ? 'primary' : ''}
            aria-pressed={mode === 'live'}
            onClick={() => setMode('live')}
          >● Live</button>
          <button className={mode === 'replay' ? 'primary' : ''} aria-pressed={mode === 'replay'} onClick={() => setMode('replay')}>Replay</button>
        </div>
        {mode === 'live' && (
          <>
            <span className={`live live-${live}`}>● {live === 'on' ? 'live' : live}</span>
            <span className="readout muted">newest {shown} events</span>
          </>
        )}
      </div>
      )}
      {mode === 'replay' && <ReplayPanel exit={exit} />}
    </div>
  );
}

function ReplayPanel({ exit }: { exit?: ReactNode }) {
  const index = useStore((s) => s.index)!;
  const t = useStore((s) => s.t);
  const playing = useStore((s) => s.playing);
  const speed = useStore((s) => s.speed);
  const window = useStore((s) => s.window);
  const { togglePlay, setSpeed, setT } = useStore.getState();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const dragging = useRef(false);
  // The stretch of the recording the track shows, or null for all of it. Wheel zooms around the pointer; sideways scroll pans.
  const [zoom, setZoom] = useState<[number, number] | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const span = Math.max(index.end - index.start, 1);
  const view = useMemo(() => (zoom && clampView(index, zoom)) || fullView(index), [index, zoom]);
  const viewSpan = view[1] - view[0];
  const x = (at: number) => ((at - view[0]) / viewSpan) * width;
  const time = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    return view[0] + Math.min(Math.max((clientX - r.left) / r.width, 0), 1) * viewSpan;
  };

  // A wheel listener can't be passive here: the page must not scroll while the track zooms.
  const wheel = useRef<(e: WheelEvent) => void>(() => {});
  wheel.current = (e) => {
    e.preventDefault();
    const r = box.current!.getBoundingClientRect();
    const f = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
    const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
    if (sideways) {
      const d = ((e.deltaX || e.deltaY) / r.width) * viewSpan;
      setZoom(clampView(index, [view[0] + d, view[1] + d]));
    } else {
      const next = Math.min(Math.max(viewSpan * Math.exp(e.deltaY * 0.002), MIN_VIEW_MS), span);
      const at = view[0] + f * viewSpan;
      setZoom(clampView(index, [at - f * next, at + (1 - f) * next]));
    }
  };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const on = (e: WheelEvent) => wheel.current(e);
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  }, []);

  const onDown = (e: React.PointerEvent) => {
    dragging.current = true;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    onMove(e);
  };
  const onMove = (e: React.PointerEvent) => {
    if (dragging.current) setT(time(e.clientX));
  };

  const shown = useMemo(() => inWindow(index, window).length, [index, window]);

  return (
    <>
      <div className="controls">
        <button className="primary" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚ Pause' : '▶ Play'}</button>
        <label>
          Speed
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {[...new Set([...SPEEDS, speed])].sort((a, b) => a - b).map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
        </label>
        <span className="readout">{fmtMs(t - index.start)} / {fmtMs(span)}</span>
        <span className="readout muted" title="The graph and lists show the shaded stretch of the timeline, which follows the playhead; at most 500 events at a time">
          {fmtDate(index.recording.startedAt + window[0])} – {fmtDate(index.recording.startedAt + window[1])} · {shown} of {index.items.length} events shown
        </span>
        {zoom && <button onClick={() => setZoom(null)} title="Show the whole recording">Reset zoom</button>}
        {exit && <span className="controls-end">{exit}</span>}
      </div>
      <div
        className="track"
        ref={box}
        style={{ height: H }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        title="Scroll to zoom, shift-scroll to pan"
      >
        <svg width={width} height={H}>
          <TimelineBase index={index} view={view} width={width} />
          <rect x={x(window[0])} y={0} width={Math.max(x(window[1]) - x(window[0]), 2)} height={H} className="window-band" />
          <TimelineTicks index={index} view={view} width={width} />
          {t >= view[0] && t <= view[1] && <line x1={x(t)} x2={x(t)} y1={0} y2={H} className="playhead" />}
        </svg>
      </div>
    </>
  );
}

/**
 * Vertical ticks from `y1` to `y2` as one path. A busy recording has hundreds of them, and one element per kind
 * keeps each live update to a few DOM nodes instead of one per tick.
 */
const ticksPath = (ticks: Tick[], y1: number, y2: number) => ticks.map((k) => `M${k.x} ${y1}V${y2}`).join('');

type View = [number, number];

/** The narrowest stretch the track zooms to. */
const MIN_VIEW_MS = 20;

/** The whole recording, as a view. */
const fullView = (index: ReplayIndex): View => [index.start, Math.max(index.end, index.start + 1)];

/** `want` moved inside the recording, keeping its width. Null when it takes in everything, which means "not zoomed". */
function clampView(index: ReplayIndex, want: View): View | null {
  const full = fullView(index);
  const w = want[1] - want[0];
  if (w >= full[1] - full[0]) return null;
  const a = Math.min(Math.max(want[0], full[0]), full[1] - w);
  return [a, a + w];
}

const pointsAt = (times: number[], view: View, width: number, rank?: (i: number) => number) =>
  times.map((at, i) => ({ x: ((at - view[0]) / (view[1] - view[0])) * width, rank: rank?.(i) })).filter((p) => p.x >= 0 && p.x <= width);

/**
 * The parts of the track that only change when the recording or the pane width does: the histogram, lost
 * stretches and late uploads. Kept apart from the playhead so that moving it doesn't redraw them.
 */
const TimelineBase = memo(function TimelineBase({ index, view, width }: { index: ReplayIndex; view: View; width: number }) {
  const span = view[1] - view[0];
  const x = (time: number) => ((time - view[0]) / span) * width;
  const bins = useMemo(() => {
    const n = Math.max(20, Math.floor(width / 6));
    const counts = new Array<number>(n).fill(0);
    for (const i of index.items) {
      const f = (i.occ.ts - view[0]) / span;
      if (f >= 0 && f <= 1) counts[Math.min(n - 1, Math.floor(f * n))]!++;
    }
    return counts;
  }, [index, width, view, span]);
  const max = Math.max(1, ...bins);
  const bw = width / bins.length;
  // Uploaded from the offline spool after the fact, and stretches lost when the spool overflowed.
  const late = useMemo(() => mergeTicks(pointsAt(index.items.filter((i) => i.occ.late).map((i) => i.occ.ts), view, width)), [index, view, width]);
  const gaps = index.recording.gaps ?? [];
  return (
    <>
      <path className="bar" d={bins.map((c, i) => {
        const h = (c / max) * (H - 24);
        return h > 0 ? `M${i * bw} ${H - 14 - h}h${Math.max(bw - 1, 1)}v${h}h${-Math.max(bw - 1, 1)}Z` : '';
      }).join('')} />
      {gaps.map((g, i) => (
        <rect key={`g${i}`} x={x(g.fromTs)} width={Math.max(x(g.toTs) - x(g.fromTs), 3)} y={0} height={H} className="gap">
          <title>{g.dropped} events lost: the offline spool was full</title>
        </rect>
      ))}
      {late.length > 0 && <path className="tick-late" d={ticksPath(late, 0, 10)}><title>uploaded late, from the offline spool</title></path>}
    </>
  );
});

/** Errors and suspected corrupt payloads, one tick per pixel column however many events there are, drawn as one path per kind. */
const TimelineTicks = memo(function TimelineTicks({ index, view, width }: { index: ReplayIndex; view: View; width: number }) {
  const errors = useMemo(
    () => mergeTicks(pointsAt(index.items.flatMap((i) => i.throws.filter((th) => !th.rethrown).map((th) => th.at)), view, width)),
    [index, view, width],
  );
  const flagged = useMemo(() => {
    const hits = index.items.filter((i) => index.findingsByOcc.has(i.occ.id));
    return mergeTicks(pointsAt(hits.map((i) => i.occ.ts), view, width, (n) => (index.findingsByOcc.get(hits[n]!.occ.id)!.some((f) => f.priority === 'high') ? 1 : 0)));
  }, [index, view, width]);
  const warn = flagged.filter((k) => !k.rank);
  const high = flagged.filter((k) => k.rank);
  return (
    <>
      {errors.length > 0 && <path className="tick-error" d={ticksPath(errors, H - 12, H)}><title>handler threw</title></path>}
      {warn.length > 0 && <path className="tick-warn" d={ticksPath(warn, H - 12, H)}><title>suspected corrupt payload</title></path>}
      {high.length > 0 && <path className="tick-high" d={ticksPath(high, H - 12, H)}><title>suspected corrupt payload reaching an external system</title></path>}
    </>
  );
});
