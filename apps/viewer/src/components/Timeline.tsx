import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { capWindow, inWindow, mergeTicks, type ReplayIndex, type Tick } from '../replay';
import { SPEEDS, useStore } from '../store';
import { fmtMs } from './common';

const H = 64;
type Drag = 'playhead' | 'w0' | 'w1' | null;

/** The footer: Live follows the stream; Replay opens the scrub panel. */
export function Timeline() {
  const index = useStore((s) => s.index)!;
  const mode = useStore((s) => s.mode);
  const live = useStore((s) => s.live);
  const window = useStore((s) => s.window);
  const { setMode } = useStore.getState();
  const shown = useMemo(() => inWindow(index, window).length, [index, window]);
  return (
    <div className="timeline">
      <div className="modebar">
        <div className="segmented" role="group" aria-label="View mode">
          <button
            className={mode === 'live' ? 'primary' : ''}
            aria-pressed={mode === 'live'}
            disabled={live === 'off'}
            title={live === 'off' ? 'No live stream: this is a saved recording' : undefined}
            onClick={() => setMode('live')}
          >● Live</button>
          <button className={mode === 'replay' ? 'primary' : ''} aria-pressed={mode === 'replay'} onClick={() => setMode('replay')}>Replay</button>
        </div>
        {mode === 'live' && (
          <>
            {live !== 'off' && <span className={`live live-${live}`}>● {live === 'on' ? 'live' : live}</span>}
            <span className="readout muted">newest {shown} events</span>
          </>
        )}
      </div>
      {mode === 'replay' && <ReplayPanel />}
    </div>
  );
}

function ReplayPanel() {
  const index = useStore((s) => s.index)!;
  const t = useStore((s) => s.t);
  const playing = useStore((s) => s.playing);
  const speed = useStore((s) => s.speed);
  const window = useStore((s) => s.window);
  const { togglePlay, setSpeed, setT, setWindow } = useStore.getState();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const drag = useRef<Drag>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const span = Math.max(index.end - index.start, 1);
  const x = (time: number) => ((time - index.start) / span) * width;
  const time = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    return index.start + Math.min(Math.max((clientX - r.left) / r.width, 0), 1) * span;
  };

  const onDown = (e: React.PointerEvent) => {
    const px = e.clientX - box.current!.getBoundingClientRect().left;
    const hit = (v: number) => Math.abs(px - x(v)) < 8;
    drag.current = hit(window[0]) ? 'w0' : hit(window[1]) ? 'w1' : 'playhead';
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    onMove(e);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const v = time(e.clientX);
    if (drag.current === 'playhead') setT(v);
    else if (drag.current === 'w0') setWindow([Math.min(v, window[1]), window[1]], 'start');
    else setWindow([window[0], Math.max(v, window[0])], 'end');
  };

  // Opening, and "Reset window", show the newest events up to the cap.
  const home = useMemo(() => capWindow(index, [index.start, index.end], 'end'), [index]);
  const atHome = window[0] === home[0] && window[1] === home[1];
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
        <span className="readout muted" title="Only the events in the window are drawn and listed; at most 500 at a time">
          window {fmtMs(window[0] - index.start)} – {fmtMs(window[1] - index.start)} · {shown} of {index.items.length} events
        </span>
        {!atHome && <button onClick={() => setWindow(home)}>Reset window</button>}
      </div>
      <div
        className="track"
        ref={box}
        style={{ height: H }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <svg width={width} height={H}>
          <TimelineBase index={index} width={width} />
          <rect x={0} y={0} width={Math.max(x(window[0]), 0)} height={H} className="dim" />
          <rect x={x(window[1])} y={0} width={Math.max(width - x(window[1]), 0)} height={H} className="dim" />
          <TimelineTicks index={index} width={width} />
          <rect x={x(window[0]) - 3} y={0} width={6} height={H} className="handle" />
          <rect x={x(window[1]) - 3} y={0} width={6} height={H} className="handle" />
          <line x1={x(t)} x2={x(t)} y1={0} y2={H} className="playhead" />
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

const pointsAt = (times: number[], index: ReplayIndex, width: number, rank?: (i: number) => number) => {
  const span = Math.max(index.end - index.start, 1);
  return times.map((at, i) => ({ x: ((at - index.start) / span) * width, rank: rank?.(i) }));
};

/**
 * The parts of the track that only change when the recording or the pane width does: the histogram, lost
 * stretches and late uploads. Kept apart from the playhead so that moving it doesn't redraw them.
 */
const TimelineBase = memo(function TimelineBase({ index, width }: { index: ReplayIndex; width: number }) {
  const span = Math.max(index.end - index.start, 1);
  const x = (time: number) => ((time - index.start) / span) * width;
  const bins = useMemo(() => {
    const n = Math.max(20, Math.floor(width / 6));
    const counts = new Array<number>(n).fill(0);
    for (const i of index.items) counts[Math.min(n - 1, Math.floor(((i.occ.ts - index.start) / span) * n))]!++;
    return counts;
  }, [index, width, span]);
  const max = Math.max(1, ...bins);
  const bw = width / bins.length;
  // Uploaded from the offline spool after the fact, and stretches lost when the spool overflowed.
  const late = useMemo(() => mergeTicks(pointsAt(index.items.filter((i) => i.occ.late).map((i) => i.occ.ts), index, width)), [index, width]);
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
const TimelineTicks = memo(function TimelineTicks({ index, width }: { index: ReplayIndex; width: number }) {
  const errors = useMemo(
    () => mergeTicks(pointsAt(index.items.flatMap((i) => i.throws.filter((th) => !th.rethrown).map((th) => th.at)), index, width)),
    [index, width],
  );
  const flagged = useMemo(() => {
    const hits = index.items.filter((i) => index.findingsByOcc.has(i.occ.id));
    return mergeTicks(pointsAt(hits.map((i) => i.occ.ts), index, width, (n) => (index.findingsByOcc.get(hits[n]!.occ.id)!.some((f) => f.priority === 'high') ? 1 : 0)));
  }, [index, width]);
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
