import type { Finding, Occurrence } from '@eda-debugger/core';
import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { callChain, errorCode, eventKey, fmtRate, RATE_STEP_MS, recipientsOf, throwId, throwIdFor, type ReplayIndex } from '../replay';
import { useStore } from '../store';

export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(ms < 10 ? 2 : 0)}ms`);

export function Badge({ tone, children, title }: { tone: 'full' | 'template' | 'error' | 'warn' | 'external' | 'muted'; children: ReactNode; title?: string }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>;
}

/** Makes it obvious whether an occurrence's data is template-only or fully captured. */
export function CaptureBadge({ occ }: { occ: Occurrence }) {
  return occ.capture === 'full' ? (
    <Badge tone="full" title="The full payload was captured for this occurrence">full capture</Badge>
  ) : (
    <Badge tone="template" title="Only the template (payload shape) is stored; values were not captured">template-only</Badge>
  );
}

export function FindingBadges({ findings }: { findings?: Finding[] }) {
  if (!findings?.length) return null;
  const high = findings.some((f) => f.priority === 'high');
  return (
    <>
      <Badge tone="warn" title="Suspected corrupt payload">⚠ Corrupt Payload</Badge>
      {high && <Badge tone="external" title="Reaches an external system">EXTERNAL</Badge>}
    </>
  );
}

const ICON_PATHS = {
  // lightning bolt: something fired
  event: <path d="M8.5 1 3 8.5h3.2L5.5 15 13 6.8H9.4z" />,
  // receiving socket: something that handles
  handler: <path d="M2 3h12v4.5H2zM2 9h12v4H2zM4 5.2h2M4 11h2" />,
  // box with an arrow leaving it: something outside the app
  external: <path d="M7 3H2.5v10.5H13V9M9 2.5h4.5V7M13.5 2.5 7 9" />,
} as const;

const ICON_NAMES = { event: 'Event', handler: 'Handler', external: 'External handler' } as const;

/**
 * Small colored marker that tells events (violet bolt), handlers (teal block) and external handlers (red, arrow out) apart at a glance. Hovering it names
 * the kind. The tooltip renders into `body` because icons often sit in clipped, ellipsized labels, and the empty
 * `title` keeps an enclosing element's native tooltip from covering it.
 */
export function EntityIcon({ kind }: { kind: keyof typeof ICON_PATHS }) {
  const name = ICON_NAMES[kind];
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  return (
    <span
      className="entity-icon-wrap"
      title=""
      onMouseEnter={(e) => { const r = e.currentTarget.getBoundingClientRect(); setTip({ x: r.left + r.width / 2, y: r.top }); }}
      onMouseLeave={() => setTip(null)}
    >
      <svg className={`entity-icon entity-${kind}`} viewBox="0 0 16 16" width="12" height="12" role="img" aria-label={name}>
        {ICON_PATHS[kind]}
      </svg>
      {tip && createPortal(<span className={`entity-tip entity-tip-${kind}`} role="tooltip" style={{ left: tip.x, top: tip.y }}>{name}</span>, document.body)}
    </span>
  );
}

export function EventRef({ children }: { children: ReactNode }) {
  return <span className="entity-ref"><EntityIcon kind="event" />{children}</span>;
}

/**
 * A name that opens its inspector (and shows itself on the graph, via `onOpen`). It is a span rather than a button
 * because it often sits inside a clickable row, and it keeps the click to itself so the row doesn't also act on it.
 */
export function InspectLink({ label, onOpen, children }: { label: string; onOpen: () => void; children: ReactNode }) {
  const open = (e: MouseEvent | KeyboardEvent) => { e.stopPropagation(); onOpen(); };
  return (
    <span className="event-link" role="link" tabIndex={0} title={`Inspect ${label}`} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open(e); }}>
      {children}
    </span>
  );
}

export function EventLink({ id }: { id: string }) {
  const label = useStore((s) => s.index?.events.get(id)?.label ?? id);
  const select = useStore((s) => s.select);
  return <InspectLink label={label} onOpen={() => select({ type: 'event', id })}><EventRef>{label}</EventRef></InspectLink>;
}

export function HandlerRef({ children }: { children: ReactNode }) {
  return <span className="entity-ref"><EntityIcon kind="handler" />{children}</span>;
}

/**
 * A handler or emitter by raw node id, with the external icon when it delivers to an external system. A node outside
 * the graph's current scope (another process, or any handler while zoomed out) is named with its process first, as
 * in `Cart › startPayment`, unless `qualify` is false because the process is already shown next to it.
 */
export function NodeRef({ id, label, qualify = true }: { id: string; label?: string; qualify?: boolean }) {
  const external = useStore((s) => s.index?.externalNodes.has(id) ?? false);
  const name = useStore((s) => label ?? s.index?.nodes.get(id)?.label ?? id);
  const scope = useStore((s) => (qualify ? outOfScopeProcess(s, id) : null));
  return (
    <span className="entity-ref">
      <EntityIcon kind={external ? 'external' : 'handler'} />
      {scope && scope !== name && <span className="node-scope">{scope} ›</span>}
      {name}
    </span>
  );
}

/** The label of the node's process when the graph isn't zoomed into it, or null when the node is in scope. */
function outOfScopeProcess(s: Pick<ReturnType<typeof useStore.getState>, 'index' | 'level'>, id: string): string | null {
  const processId = s.index?.nodes.get(id)?.processId;
  if (!processId || (s.level.kind === 'handlers' && s.level.processId === processId)) return null;
  return s.index?.processLabel.get(processId) ?? processId;
}

/**
 * A `NodeRef` that opens the node's inspector and shows it on the graph, zooming into its process if needed. `during`
 * is the occurrence the handler was handling at this point: if it threw there, the link opens that error instead,
 * since that's the entry in its activity this reference is about.
 */
export function HandlerLink({ id, label, during }: { id: string; label?: string; during?: string }) {
  const name = useStore((s) => label ?? s.index?.nodes.get(id)?.label ?? id);
  const scope = useStore((s) => outOfScopeProcess(s, id));
  const thrown = useStore((s) => (during && s.index ? throwIdFor(s.index, during, id) : null));
  const inspectNode = useStore((s) => s.inspectNode);
  const selectAt = useStore((s) => s.selectAt);
  const full = scope && scope !== name ? `${scope} › ${name}` : name;
  return (
    <InspectLink
      label={thrown ? `error ${errorCode(thrown)} in ${full}` : full}
      onOpen={() => (thrown && during ? selectAt({ type: 'throw', id: thrown }, during) : inspectNode(id))}
    >
      <NodeRef id={id} label={name} />
    </InspectLink>
  );
}

/** An error's short id (see `errorCode`). The same id anywhere means the same error. */
export function ErrorId({ id }: { id: string }) {
  return <code className="error-id" title="Error id: the same id everywhere means the same error">{errorCode(id)}</code>;
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export function Section({ title, children, aside }: { title: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="section">
      <h3>{title}{aside != null && aside !== false && <span className="aside">{aside}</span>}</h3>
      {children}
    </section>
  );
}

/**
 * Events with the handler that emitted each next one between them, root first. `threw` marks the handler (or, when
 * it isn't a step, the emitter) that threw with a ✕ after its name.
 */
export function CallChain({ index, occurrenceId, threw, errorId, tail }: { index: ReplayIndex; occurrenceId: string; threw?: string; errorId?: string; tail?: ReactNode[] }) {
  const { steps, truncated } = callChain(index, occurrenceId);
  const marked = steps.findIndex((s) => s.kind === 'handler' && s.nodeId === threw);
  const markAt = marked >= 0 ? marked : steps.findIndex((s) => s.kind === 'event' && s.item.template.emitterId === threw);
  const error = <span className="chain-error" title="Threw the error this is traced to"> ✕{errorId && <> <ErrorId id={errorId} /></>}</span>;
  // A handler step emitted the next event while handling the previous one, so that's the run it links to.
  const handling = (n: number) => { const prev = steps[n - 1]; return prev?.kind === 'event' ? prev.item.occ.id : undefined; };
  const parts: ReactNode[] = steps.map((s, n) => (
    <span key={n} className={n === steps.length - 1 && s.kind === 'event' ? 'current-step' : ''}>
      {s.kind === 'handler'
        ? <HandlerLink id={s.nodeId} during={handling(n)} />
        : <EventLink id={eventKey(s.item.template)} />}
      {n === markAt && error}
    </span>
  ));
  parts.push(...(tail ?? []));
  return (
    <span className="call-chain">
      {truncated && <span className="muted" title="Earlier events were evicted from the buffer">… ▸ </span>}
      {parts.map((p, n) => <span key={n}>{n > 0 && <span className="muted"> ▸ </span>}{p}</span>)}
    </span>
  );
}

// Values JSON cannot carry are stored as { $eda: 'NaN' | 'undefined' | ... }.
export const shortValue = (v: unknown) => {
  if (typeof v === 'object' && v !== null && typeof (v as { $eda?: unknown }).$eda === 'string') return (v as { $eda: string }).$eda;
  const s = v === undefined ? 'undefined' : JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
};

/**
 * A flagged payload in a notification: each flagged field with the value that was sent, then the event that carried
 * it and how many recipients it reached. The full call chain is in the finding's inspector (`FindingChain`); the
 * external badge is shown separately.
 */
export function FindingSummary({ index, finding }: { index: ReplayIndex; finding: Finding }) {
  const item = index.byId.get(finding.occurrenceId);
  const recipients = recipientsOf(index, [finding]);
  return (
    <span className="finding-summary">
      {finding.diff.length > 0 && (
        <code className="flagged">{finding.diff.map((d) => `${d.path || 'payload'}: ${shortValue(d.actual)}`).join('\n')}</code>
      )}
      {item
        ? <span className="call-chain"><span className="current-step"><EventLink id={eventKey(item.template)} /></span></span>
        : <span className="muted">event no longer recorded</span>}
      {item && (
        <span className="finding-recipients">
          → {recipients.length} recipient{recipients.length === 1 ? '' : 's'}
        </span>
      )}
    </span>
  );
}

/** The call chain a flagged payload travelled, ✕ on the method that threw (if any), out to its recipients. */
export function FindingChain({ index, finding }: { index: ReplayIndex; finding: Finding }) {
  const item = index.byId.get(finding.occurrenceId);
  if (!item) return <span className="muted">event no longer recorded</span>;
  const recipients = finding.externalTargets.length
    ? finding.externalTargets.map((t) => {
      const handler = item.template.handlerIds.find((id) => index.nodes.get(id)?.label === t);
      return handler ? <HandlerLink key={t} id={handler} during={item.occ.id} /> : <span key={t} className="entity-ref"><EntityIcon kind="external" />{t}</span>;
    })
    : item.template.handlerIds.map((id) => <HandlerLink key={id} id={id} during={item.occ.id} />);
  const source = finding.taintSource;
  return <CallChain index={index} occurrenceId={item.occ.id} threw={source?.handlerId} errorId={source ? throwId(source.occurrenceId, source.handlerId) : undefined} tail={recipients} />;
}

/** How long ago a step ended, e.g. "35s ago" or "2m 05s ago". */
function agoLabel(ms: number): string {
  const secs = Math.round(ms / 1000);
  return secs < 60 ? `${secs}s ago` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s ago`;
}

const CHART_W = 240;
const CHART_H = 48;

/**
 * Events per second over the last few minutes, oldest first, one value per `RATE_STEP_MS` step. The readout above
 * shows the newest value, or the one under the pointer. `max` is passed in so charts shown side by side share a scale.
 */
export function RateChart({ label, values, max, current }: { label: string; values: number[]; max: number; current?: { value: number; spike: boolean } }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = values.length;
  const top = max > 0 ? max : 1;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * CHART_W : CHART_W);
  // 2px headroom so a peak's stroke isn't clipped; the baseline sits on the bottom edge.
  const y = (v: number) => CHART_H - 1 - (v / top) * (CHART_H - 3);
  const path = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const shown = hover ?? n - 1;
  // The newest point reads what the graph's label shows, which can be a spike ahead of the last completed step.
  const atNow = hover === null || hover === n - 1;
  const readout = atNow && current ? current.value : values[shown] ?? 0;
  const minutes = Math.round((n * RATE_STEP_MS) / 60_000);
  return (
    <figure className="rate-chart">
      <figcaption>
        <span>{label}</span>
        <strong>{fmtRate(readout)}/s</strong>
        <span className={current?.spike && atNow ? 'spike' : 'muted'}>{!atNow ? agoLabel((n - 1 - hover!) * RATE_STEP_MS) : current?.spike ? 'spike' : `last ${RATE_STEP_MS / 1000} s`}</span>
      </figcaption>
      <div className="rate-plot">
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${label}: ${fmtRate(values[n - 1] ?? 0)} events per second now, peak ${fmtRate(max)} per second over the last ${minutes} minutes`}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHover(Math.min(n - 1, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
          }}
          onPointerLeave={() => setHover(null)}
        >
          <line x1={0} x2={CHART_W} y1={CHART_H - 0.5} y2={CHART_H - 0.5} className="rate-baseline" vectorEffect="non-scaling-stroke" />
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={CHART_H} className="rate-crosshair" vectorEffect="non-scaling-stroke" />}
          <path d={path} className="rate-line" vectorEffect="non-scaling-stroke" />
        </svg>
        {/* In HTML so the stretched SVG doesn't squash it into an oval. */}
        <span className="rate-dot" style={{ left: `${(x(shown) / CHART_W) * 100}%`, top: `${(y(values[shown] ?? 0) / CHART_H) * 100}%` }} />
      </div>
      <div className="rate-axis muted"><span>{minutes} min ago</span><span>peak {fmtRate(max)}/s</span><span>now</span></div>
    </figure>
  );
}
