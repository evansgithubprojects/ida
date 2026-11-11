import { useEffect } from 'react';
import { useTrace } from '../hooks';
import { eventLabel } from '../replay';
import { useStore } from '../store';
import { EventRef, fmtMs } from './common';

const BROKER_NAMES = { kafka: 'Kafka', rabbitmq: 'RabbitMQ' } as const;

/**
 * Trace mode: every step of one message's causal tree, oldest first, across services and brokers. Clicking a step
 * jumps to it (zooming as needed); Esc or ✕ ends the trace.
 */
export function TraceBar() {
  const trace = useTrace();
  const index = useStore((s) => s.index);
  const selection = useStore((s) => s.selection);
  const seek = useStore((s) => s.seekToOccurrence);
  const endTrace = useStore((s) => s.endTrace);
  const on = !!trace;

  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') useStore.getState().endTrace(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [on]);

  if (!trace || !index) return null;
  const { steps } = trace;
  const t0 = steps[0]?.item.occ.ts ?? 0;
  const services = new Set(steps.map((s) => s.service).filter(Boolean));
  const firstError = steps.find((s) => s.item.throws.length);
  const current = selection?.type === 'occurrence' ? selection.id : null;

  return (
    <div className="trace-bar" role="region" aria-label="Trace">
      <div className="trace-head">
        <strong>Trace</strong>
        <span className="muted">
          {steps.length} step{steps.length === 1 ? '' : 's'}
          {services.size > 0 && ` · ${services.size} service${services.size === 1 ? '' : 's'}`}
          {firstError && <> · <span className="err">first error in {firstError.service ?? 'this recording'}</span></>}
        </span>
        <span className="spacer" />
        <button className="trace-close" onClick={endTrace} aria-label="End trace" title="End trace (Esc)">✕</button>
      </div>
      {trace.truncated && <div className="muted trace-note">Earlier steps are outside this window or weren't recorded.</div>}
      <ol className="trace-steps">
        {steps.map((step, k) => {
          const { item } = step;
          const handler = index.nodes.get(item.template.handlerIds[0] ?? '')?.label;
          const error = item.throws[0];
          const prevService = k > 0 ? steps[k - 1]!.service : undefined;
          return (
            <li key={item.occ.id} className={[error && 'has-error', item.occ.id === current && 'current', item.occ.id === trace.occurrenceId && 'origin'].filter(Boolean).join(' ')} style={{ marginLeft: Math.min(step.depth, 6) * 4 }}>
              {k > 0 && <span className="trace-arrow" aria-hidden>→</span>}
              <button className="trace-step" onClick={() => seek(item.occ.id)} title={`At +${fmtMs(item.occ.ts - t0)}`}>
                {step.service && step.service !== prevService && <span className="trace-service">{step.service}</span>}
                {step.broker && (
                  <span className={`trace-broker broker-${step.broker.kind}`}>
                    {BROKER_NAMES[step.broker.type]} {step.broker.name}{step.lagMs !== undefined && ` · ${fmtMs(step.lagMs)}`}
                  </span>
                )}
                <EventRef>{eventLabel(index, item)}</EventRef>
                {handler && <span className="muted"> ▸ {handler}</span>}
                <span className="muted trace-time">+{fmtMs(item.occ.ts - t0)}</span>
                {error && <span className="err"> ✕ {error.message}</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
