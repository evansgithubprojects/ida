import { useEffect, useMemo, useRef, useState } from 'react';
import { SPEEDS, useStore } from '../store';
import { fmtMs } from './common';

const H = 64;
type Drag = 'playhead' | 'w0' | 'w1' | null;

export function Timeline() {
  const index = useStore((s) => s.index)!;
  const t = useStore((s) => s.t);
  const playing = useStore((s) => s.playing);
  const speed = useStore((s) => s.speed);
  const window = useStore((s) => s.window);
  const live = useStore((s) => s.live);
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

  const bins = useMemo(() => {
    const n = Math.max(20, Math.floor(width / 6));
    const counts = new Array<number>(n).fill(0);
    for (const i of index.items) counts[Math.min(n - 1, Math.floor(((i.occ.ts - index.start) / span) * n))]!++;
    return counts;
  }, [index, width, span]);
  const max = Math.max(1, ...bins);

  // Uploaded from the offline spool after the fact, and stretches lost when the spool overflowed.
  const late = useMemo(() => index.items.filter((i) => i.occ.late).map((i) => i.occ.ts), [index]);
  const gaps = index.recording.gaps ?? [];
  const errors = useMemo(() => index.items.flatMap((i) => i.throws.filter((th) => !th.rethrown).map((th) => th.at)), [index]);
  const flagged = useMemo(
    () => index.items.filter((i) => index.findingsByOcc.has(i.occ.id)).map((i) => ({ at: i.occ.ts, high: index.findingsByOcc.get(i.occ.id)!.some((f) => f.priority === 'high') })),
    [index],
  );

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
    else if (drag.current === 'w0') setWindow([Math.min(v, window[1]), window[1]]);
    else setWindow([window[0], Math.max(v, window[0])]);
  };

  const bw = width / bins.length;
  const full = window[0] <= index.start && window[1] >= index.end;

  return (
    <div className="timeline">
      <div className="controls">
        <button className="primary" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚ Pause' : '▶ Play'}</button>
        <label>
          Speed
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {[...new Set([...SPEEDS, speed])].sort((a, b) => a - b).map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
        </label>
        <span className="readout">{fmtMs(t - index.start)} / {fmtMs(span)}</span>
        <span className="readout muted">window {fmtMs(window[0] - index.start)} – {fmtMs(window[1] - index.start)}</span>
        {!full && <button onClick={() => setWindow([index.start, index.end])}>Reset window</button>}
        {live !== 'off' && <span className={`live live-${live}`}>● live {live === 'on' ? '' : live}</span>}
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
          {bins.map((c, i) => (
            <rect key={i} x={i * bw} width={Math.max(bw - 1, 1)} y={H - 14 - (c / max) * (H - 24)} height={(c / max) * (H - 24)} className="bar" />
          ))}
          {gaps.map((g, i) => (
            <rect key={`g${i}`} x={x(g.fromTs)} width={Math.max(x(g.toTs) - x(g.fromTs), 3)} y={0} height={H} className="gap">
              <title>{g.dropped} events lost: the offline spool was full</title>
            </rect>
          ))}
          {late.map((at, i) => <line key={`l${i}`} x1={x(at)} x2={x(at)} y1={0} y2={10} className="tick-late"><title>uploaded late, from the offline spool</title></line>)}
          <rect x={0} y={0} width={Math.max(x(window[0]), 0)} height={H} className="dim" />
          <rect x={x(window[1])} y={0} width={Math.max(width - x(window[1]), 0)} height={H} className="dim" />
          {errors.map((at, i) => <line key={`e${i}`} x1={x(at)} x2={x(at)} y1={H - 12} y2={H} className="tick-error"><title>handler threw</title></line>)}
          {flagged.map((f, i) => (
            <line key={`f${i}`} x1={x(f.at)} x2={x(f.at)} y1={H - 12} y2={H} className={f.high ? 'tick-high' : 'tick-warn'}><title>suspected corrupt payload</title></line>
          ))}
          <rect x={x(window[0]) - 3} y={0} width={6} height={H} className="handle" />
          <rect x={x(window[1]) - 3} y={0} width={6} height={H} className="handle" />
          <line x1={x(t)} x2={x(t)} y1={0} y2={H} className="playhead" />
        </svg>
      </div>
    </div>
  );
}
