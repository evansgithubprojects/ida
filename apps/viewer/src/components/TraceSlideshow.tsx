import { useEffect, type ReactNode } from 'react';
import { eventLabel } from '../replay';
import { useStore } from '../store';
import { BROKER_NAMES } from './BrokerLogo';
import { EventRef, fmtMs } from './common';

/** How long autoplay shows each slide. */
const AUTO_MS = 2500;

const TITLES = { throw: 'Error', finding: 'Corrupt payload', occurrence: 'Event' } as const;

/**
 * Trace mode's footer, in place of the timeline: the path that led to an error, a corrupt payload or an event, one step
 * at a time. Each slide lights its pathway on the graph and says why it matters. ←/→ step, Space plays, Esc closes.
 */
export function TraceSlideshow({ exit }: { /** Shown at the right end of the controls. */ exit?: ReactNode }) {
  const trace = useStore((s) => s.trace);
  const index = useStore((s) => s.index);
  const { traceStep, setTraceAuto, endTrace } = useStore.getState();
  const at = trace?.at ?? 0;
  const auto = trace?.auto ?? false;

  useEffect(() => {
    if (!auto) return;
    const timer = setTimeout(() => useStore.getState().traceStep(at + 1), AUTO_MS);
    return () => clearTimeout(timer);
  }, [auto, at]);

  // Keeps the step shown in view in a long strip.
  useEffect(() => {
    document.querySelector('.trace-steps li.current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [at]);

  if (!trace || !index) return null;
  const { slides, target, truncated } = trace.path;
  const slide = slides[at]!;
  const t0 = slides[0]!.item.occ.ts;
  const services = new Set(slides.map((s) => s.service).filter(Boolean));
  const last = slides.length - 1;

  return (
    <div className="timeline trace-show" role="region" aria-label="Trace">
      <div className="controls">
        <strong>Trace · {TITLES[target.type]}</strong>
        <span className="muted readout">
          step {at + 1} of {slides.length}
          {services.size > 0 && ` · ${services.size} service${services.size === 1 ? '' : 's'}`}
          {' · '}+{fmtMs(slide.item.occ.ts - t0)}
        </span>
        <span className="segmented">
          <button onClick={() => traceStep(at - 1)} disabled={at === 0} aria-label="Previous step" title="Previous step (←)">‹ Prev</button>
          <button className="primary" onClick={() => setTraceAuto(!auto)} aria-label={auto ? 'Pause' : 'Play'} title="Step through on its own (Space)">
            {auto ? '❚❚ Pause' : '▶ Play'}
          </button>
          <button onClick={() => traceStep(at + 1)} disabled={at === last} aria-label="Next step" title="Next step (→)">Next ›</button>
        </span>
        <span className="controls-end">
          {exit}
          <button className="trace-close" onClick={endTrace} aria-label="End trace" title="End trace (Esc)">✕</button>
        </span>
      </div>
      <p className={`trace-subtitle role-${slide.role}`} aria-live="polite">{slide.subtitle}</p>
      {truncated && at === 0 && <div className="muted trace-note">Earlier steps are outside this window or weren't recorded.</div>}
      <ol className="trace-steps">
        {slides.map((s, k) => {
          const handler = s.thrownBy ? index.nodes.get(s.thrownBy.handlerId)?.label : index.nodes.get(s.item.template.handlerIds[0] ?? '')?.label;
          const prevService = k > 0 ? slides[k - 1]!.service : undefined;
          const cls = [s.thrownBy && 'has-error', k === at && 'current', k < at && 'seen', k === last && 'origin', target.type === 'finding' && k === last && 'has-warn'];
          return (
            <li key={s.item.occ.id} className={cls.filter(Boolean).join(' ')}>
              {k > 0 && <span className="trace-arrow" aria-hidden>→</span>}
              <button className="trace-step" onClick={() => traceStep(k)} aria-current={k === at ? 'step' : undefined} title={s.subtitle}>
                {s.service && s.service !== prevService && <span className="trace-service">{s.service}</span>}
                {s.broker && (
                  <span className={`trace-broker broker-${s.broker.kind}`}>
                    {BROKER_NAMES[s.broker.type]} {s.broker.name}{s.lagMs !== undefined && ` · ${fmtMs(s.lagMs)}`}
                  </span>
                )}
                <EventRef>{eventLabel(index, s.item)}</EventRef>
                {handler && <span className="muted"> ▸ {handler}</span>}
                {s.thrownBy && <span className="err"> ✕</span>}
                {target.type === 'finding' && k === last && <span className="warn"> ⚠</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
