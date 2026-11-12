import type { Finding } from '@ida-dev/core';
import { memo, useDeferredValue, useMemo, useRef, useState } from 'react';
import { useModel, useRates } from '../hooks';
import { levelInto, serviceOfProcess, type GraphModel, type ModelNode } from '../graph/model';
import { RATE_HISTORY, activityOf, chainOf, errorCode, throwIdFor, countFired, edgeId, eventKey, eventLabel, inWindow, isProblemRun, notifications, parseRunId, parseThrowId, recipientsOf, runById, serviceOfOccurrence, throwId, type IndexedOccurrence, type Notification, type ReplayIndex, type Run, type Tier } from '../replay';
import { TRAIL_MAX, useStore, type LiveStatus, type Selection } from '../store';
import { Badge, CallChain, ErrorId, CaptureBadge, EventLink, EventRef, FindingBadges, FindingChain, FindingSummary, fmtMs, HandlerLink, InspectLink, Json, NodeRef, RateChart, Section, shortValue } from './common';

export function Inspector() {
  const index = useStore((s) => s.index)!;
  const selection = useStore((s) => s.selection);
  return (
    <aside className="inspector" id="inspector">
      <Crumbs index={index} />
      {!selection && <Overview index={index} />}
      {selection?.type === 'event' && <EventDetail index={index} id={selection.id} />}
      {selection?.type === 'node' && <NodeDetail index={index} id={selection.id} />}
      {selection?.type === 'edge' && <EdgeDetail key={selection.id} index={index} id={selection.id} />}
      {selection?.type === 'run' && <RunDetail index={index} id={selection.id} />}
      {selection?.type === 'occurrence' && <OccurrenceDetail index={index} id={selection.id} />}
      {selection?.type === 'throw' && <ErrorDetail index={index} id={selection.id} />}
      {selection?.type === 'finding' && <FindingSelection index={index} id={selection.id} />}
    </aside>
  );
}

/** The level being looked at, then everything inspected on it so far. The first crumb returns to the level overview. */
function Crumbs({ index }: { index: ReplayIndex }) {
  const model = useModel();
  const level = useStore((s) => s.level);
  const trail = useStore((s) => s.trail);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const nodeLabel = (id: string) => model?.nodes.find((n) => n.id === id)?.label ?? index.nodes.get(id)?.label ?? id;
  const label = (t: NonNullable<Selection>) => {
    if (t.type === 'node') return nodeLabel(t.id);
    if (t.type === 'event') return index.events.get(t.id)?.label ?? t.id;
    if (t.type === 'run') {
      const r = parseRunId(index, t.id);
      const item = r && index.byId.get(r.occurrenceId);
      return r && item ? `${nodeLabel(r.nodeId)} ${r.dir} ${eventLabel(index, item)}` : t.id;
    }
    if (t.type === 'edge') {
      const e = model?.edges.find((x) => x.id === t.id);
      return e ? `${nodeLabel(e.source)} → ${nodeLabel(e.target)}` : t.id;
    }
    if (t.type === 'throw') {
      const src = parseThrowId(index, t.id);
      return src ? `${errorCode(t.id)} · ${nodeLabel(src.handlerId)} threw` : t.id;
    }
    if (t.type === 'finding') {
      const f = index.findingsById.get(t.id);
      const item = f && index.byId.get(f.occurrenceId);
      return item ? `suspect: ${eventLabel(index, item)}` : t.id;
    }
    const item = index.byId.get(t.id);
    return item ? eventLabel(index, item) : t.id;
  };
  const labelNode = (t: NonNullable<Selection>) => {
    if (t.type === 'node') return ['process', 'service', 'stub'].includes(model?.nodes.find((n) => n.id === t.id)?.kind ?? '') ? label(t) : <NodeRef id={t.id} label={label(t)} />;
    if (t.type === 'edge' || t.type === 'throw' || t.type === 'finding' || t.type === 'run') return label(t);
    return <EventRef>{label(t)}</EventRef>;
  };
  const root = level.kind === 'handlers' ? index.processLabel.get(level.processId) ?? level.processId
    : level.kind === 'services' ? 'Services' : level.service ?? 'Emitters';
  return (
    <nav className="inspector-crumbs" aria-label="Inspection trail">
      <button className={selection ? '' : 'current'} onClick={() => select(null)} title="Overview of this level">{root}</button>
      {trail.length >= TRAIL_MAX && <span className="muted">› …</span>}
      {trail.map((t, k) => (
        <span key={`${t.type}:${t.id}`} className="crumb">
          <span className="muted">›</span>
          {k === trail.length - 1 ? <span className="current" title={label(t)}>{labelNode(t)}</span> : <button onClick={() => select(t)} title={label(t)}>{labelNode(t)}</button>}
        </span>
      ))}
    </nav>
  );
}

function Overview({ index }: { index: ReplayIndex }) {
  const model = useModel();
  const level = useStore((s) => s.level);
  const window = useStore((s) => s.window);
  const live = useStore((s) => s.live);
  // Inside a process, the overview covers only the traffic that touches that process.
  const items = useMemo(() => {
    const all = inWindow(index, window);
    if (!model) return all;
    if (level.kind === 'process' && level.service) {
      // Inside a service: the traffic it took part in.
      const own = (id: string) => index.system?.nodeService.get(id) === level.service;
      return all.filter((i) => i.hops.some((h) => own(h.src) || own(h.dst)));
    }
    if (level.kind !== 'handlers') return all;
    const inside = (id: string) => !model.mapNode(id)?.startsWith('p:');
    return all.filter((i) => i.hops.some((h) => inside(h.src) || inside(h.dst)));
  }, [index, window, level, model]);
  const list = useMemo(() => notifications(index, items), [items, index]);

  return (
    <>
      <Section title={<>Recording{live !== 'off' && <LiveDot status={live} />}</>}>
        <dl className="facts">
          <dt>Events</dt><dd>{items.length} in window ({index.items.length} total)</dd>
        </dl>
        <p className="hint">
          {level.kind === 'services'
            ? 'Each card is a service; topics, exchanges and queues sit between the services that use them. Dotted pathways carry messages from one service to another. Double-click a card to zoom in.'
            : 'Click a node or pathway to inspect it. Double-click an emitter to zoom in. Click a handler to see its activity.'}
        </p>
      </Section>
      <NotificationList index={index} title="Notifications" list={list} empty="No throws or suspected corrupt payloads in this window." />
    </>
  );
}

/** Whether the recording is still streaming in: a pulsing dot while live, the connection state otherwise. */
function LiveDot({ status }: { status: Exclude<LiveStatus, 'off'> }) {
  return (
    <span className={`live live-${status} live-dot`} role="status" title={status === 'on' ? 'Receiving events from the app' : undefined}>
      <span className="dot" aria-hidden="true">●</span> {status === 'on' ? 'live' : status}
    </span>
  );
}

/** Throws and suspected corrupt payloads in the order given; clicking one inspects it. */
function NotificationList({ index, title, list, empty }: { index: ReplayIndex; title: string; list: Notification[]; empty: string }) {
  const { cap, setMore } = useRowCap();
  const rows = useDeferredValue(list.slice(0, cap));
  return (
    <Section title={title} aside={list.length}>
      {list.length === 0 && <p className="hint">{empty}</p>}
      <ul className="list">
        {rows.map((n) => <NotificationRow key={`${n.kind}:${n.id}`} index={index} start={index.origin} n={n} />)}
      </ul>
      <ShowMore total={list.length} cap={cap} onMore={() => setMore(true)} />
    </Section>
  );
}

/**
 * One notification. A live view rebuilds the index several times a second and the list can hold hundreds of
 * rows, so a row only re-renders when its own notification changes (or the recording's start moves, which
 * shifts its time). `index` is left out of the comparison: what a row reads from it is fixed for its finding.
 */
const NotificationRow = memo(
  function NotificationRow({ index, start, n }: { index: ReplayIndex; start: number; n: Notification }) {
    const startTrace = useStore((s) => s.startTrace);
    return (
      <li>
        <button className={`row ${n.external ? 'row-high' : ''}`} onClick={() => startTrace({ type: n.kind, id: n.id, occurrenceId: n.occurrenceId })} title="Step through what led to this">
          <span className="row-head">
            {n.kind === 'throw' ? <><Badge tone="error">✕ Error</Badge><ErrorId id={n.id} /></> : <Badge tone="warn">⚠ Corrupt Payload</Badge>}
            <TierBadge tier={n.tier} />
            {n.external && <Badge tone="external">EXTERNAL</Badge>}
            <span className="muted">{fmtMs(n.rank.ts - start)}</span>
          </span>
          <span className="row-text">{n.finding ? <FindingSummary index={index} finding={n.finding} /> : n.text}</span>
        </button>
      </li>
    );
  },
  (a, b) =>
    a.start === b.start && a.n.kind === b.n.kind && a.n.id === b.n.id && a.n.tier === b.n.tier && a.n.external === b.n.external
    && a.n.rank.ts === b.n.rank.ts && a.n.text === b.n.text && a.n.finding === b.n.finding && a.n.occurrenceId === b.n.occurrenceId,
);

/**
 * How many rows a list draws. A row is a dozen or so components, and a live view re-draws lists on every burst of
 * events, so it starts short; Replay keeps the long list.
 */
const LIVE_ROWS = 50;
const REPLAY_ROWS = 200;

function useRowCap(): { cap: number; more: boolean; setMore(v: boolean): void } {
  const live = useStore((s) => s.mode === 'live' && s.live === 'on');
  const [more, setMore] = useState(false);
  return { cap: live && !more ? LIVE_ROWS : REPLAY_ROWS, more, setMore };
}

function ShowMore({ total, cap, onMore }: { total: number; cap: number; onMore(): void }) {
  return total > cap ? <button onClick={onMore}>Show {Math.min(total, REPLAY_ROWS) - cap} more ({total} total)</button> : null;
}

/** How many notifications the event inspector lists, newest first. */
const RECENT_NOTIFICATIONS = 20;

const NO_RATES: number[] = new Array<number>(RATE_HISTORY).fill(0);
const peak = (...rows: number[][]) => Math.max(0, ...rows.flat());

const IN_COLOR = 'var(--accent)';
const OUT_COLOR = 'var(--lg-blue-light1)';

/** The node's or pathway's events per second over the last few minutes, from the same series the graph shows. */
function RateSection({ id, kind }: { id: string; kind: 'node' | 'edge' }) {
  const model = useModel();
  const level = useStore((s) => s.level);
  const rates = useRates(model, level);
  if (kind === 'edge') {
    const values = rates?.series.edges.get(id) ?? NO_RATES;
    return <Section title="Rate"><RateChart series={[{ label: 'Events', values, color: IN_COLOR, current: rates?.shown.edges.get(id) }]} max={peak(values)} /></Section>;
  }
  const ins = rates?.series.in.get(id) ?? NO_RATES;
  const outs = rates?.series.out.get(id) ?? NO_RATES;
  const max = peak(ins, outs);
  return (
    <Section title="Rate">
      <RateChart
        max={max}
        series={[
          { label: 'In', values: ins, color: IN_COLOR, current: rates?.shown.in.get(id) },
          { label: 'Out', values: outs, color: OUT_COLOR, current: rates?.shown.out.get(id) },
        ]}
      />
    </Section>
  );
}

/** A graph node by name: a handler links to its inspector, a process to the process node's. */
function NodeName({ model, id }: { model: GraphModel; id: string }) {
  const select = useStore((s) => s.select);
  const m = model.nodes.find((n) => n.id === id);
  const label = m?.label ?? id;
  if (m?.kind === 'process' || m?.kind === 'stub' || m?.kind === 'service') return <InspectLink label={label} onOpen={() => select({ type: 'node', id })}>{label}</InspectLink>;
  return <HandlerLink id={id} label={label} />;
}

/** One kind of event across all of its templates: who fires it, the pathways it takes at this zoom level, and what has gone wrong with it. */
function EventDetail({ index, id }: { index: ReplayIndex; id: string }) {
  const model = useModel();
  const window = useStore((s) => s.window);
  const select = useStore((s) => s.select);
  const ev = index.events.get(id);
  const all = useMemo(() => index.items.filter((i) => eventKey(i.template) === id), [index, id]);
  const items = useMemo(() => all.filter((i) => i.occ.ts >= window[0] && i.occ.ts <= window[1]), [all, window]);
  const pathways = useMemo(() => {
    if (!model) return [];
    const fired = new Map<string, number>();
    for (const i of items) {
      for (const h of i.hops) {
        const src = model.mapNode(h.src);
        const dst = model.mapNode(h.dst);
        if (src && dst && src !== dst) fired.set(edgeId(src, dst), (fired.get(edgeId(src, dst)) ?? 0) + 1);
      }
    }
    return model.edges.filter((e) => fired.has(e.id)).map((edge) => ({ edge, n: fired.get(edge.id)! })).sort((a, b) => b.n - a.n);
  }, [model, items]);
  const recent = useMemo(() => notifications(index, items).sort((a, b) => b.rank.ts - a.rank.ts).slice(0, RECENT_NOTIFICATIONS), [index, items]);
  if (!ev || !model) return <p className="hint">That event is no longer in the recording.</p>;
  const shapes = [...new Set(all.map((i) => i.template.payloadShape))];
  return (
    <>
      <Section title={<EventRef>{ev.label}</EventRef>} aside={<Badge tone="muted">event</Badge>}>
        <dl className="facts">
          <dt>Emitter</dt>
          <dd><HandlerLink id={ev.emitterId} /></dd>
          <dt>Fired</dt><dd>{items.length} in window ({all.length} total)</dd>
          <dt>Payload</dt><dd>{shapes.map((s) => <code key={s} className="shape">{s}</code>)}</dd>
        </dl>
      </Section>
      <Section title="Pathways" aside={pathways.length}>
        {pathways.length === 0 && <p className="hint">None at this zoom level.</p>}
        <ul className="list">
          {pathways.map(({ edge, n }) => (
            <li key={edge.id}>
              <button className="row" title="Inspect pathway" onClick={() => select({ type: 'edge', id: edge.id })}>
                <span className="row-head">
                  <span className="row-text"><NodeName model={model} id={edge.source} /> → <NodeName model={model} id={edge.target} /></span>
                  <span className="muted">{n}×</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
      <NotificationList index={index} title="Recent notifications" list={recent} empty="No throws or suspected corrupt payloads for this event in this window." />
    </>
  );
}

function NodeDetail({ index, id }: { index: ReplayIndex; id: string }) {
  const model = useModel();
  const window = useStore((s) => s.window);
  const setLevel = useStore((s) => s.setLevel);
  const m = model?.nodes.find((n) => n.id === id);
  const items = useMemo(() => inWindow(index, window).filter((i) => i.hops.some((h) => model?.mapNode(h.dst) === id) || model?.mapNode(i.occ.sourceNodeId) === id), [index, window, model, id]);
  const runs = useMemo(() => (m?.kind === 'handler' && m.rawId ? activityOf(index, window, m.rawId) : null), [index, window, m]);
  if (!m) return null;
  const handled = runs?.filter((r) => r.dir === 'handled') ?? [];
  const avg = handled.length ? handled.reduce((n, r) => n + (r.ms ?? 0), 0) / handled.length : 0;
  const threw = items.reduce((n, i) => n + i.throws.filter((t) => !t.rethrown && model?.mapNode(t.handlerId) === id).length, 0);
  // An event can land in both lists when the node sends it to itself (or, for a process, between its own handlers).
  // Counted per event, not per template: payloads belong to the run and pathway inspectors, not here.
  const receiving = new Map<string, number>();
  const sending = new Map<string, number>();
  for (const i of items) {
    const lists = [];
    if (i.hops.some((h) => model?.mapNode(h.dst) === id)) lists.push(receiving);
    if (model?.mapNode(i.occ.sourceNodeId) === id) lists.push(sending);
    const key = eventKey(i.template);
    for (const events of lists) events.set(key, (events.get(key) ?? 0) + 1);
  }
  return (
    <>
      <Section title={m.kind === 'process' || m.kind === 'stub' || m.kind === 'service' ? m.label : <NodeRef id={m.id} label={m.label} />} aside={<Badge tone="muted">{m.broker ?? (m.service && m.kind === 'stub' ? 'service' : m.kind === 'process' ? 'emitter' : m.kind)}</Badge>}>
        <dl className="facts">
          {m.processId && <><dt>Emitter</dt><dd>{index.processLabel.get(m.processId)}</dd></>}
          <SystemFacts index={index} m={m} />
          <dt>Traffic</dt><dd>{m.detail}</dd>
          <dt>Throws</dt><dd>{threw ? <Badge tone="error">✕ {threw}</Badge> : 'none'}</dd>
          {runs && <><dt>Activity</dt><dd>handled {handled.length} · emitted {runs.length - handled.length} · avg {fmtMs(avg)}</dd></>}
        </dl>
        {levelInto(m) && <button className="primary" onClick={() => setLevel(levelInto(m)!)}>Zoom into {m.service ? 'service' : m.broker ?? 'emitter'}</button>}
      </Section>
      {m.kind !== 'stub' && <RateSection id={id} kind="node" />}
      <EventList title="Receiving" events={receiving} />
      <EventList title="Sending" events={sending} />
      {runs && <ActivitySection index={index} runs={runs} window={window} />}
    </>
  );
}

const CAUSALITY: Record<string, string> = {
  sync: 'sync',
  inferred: 'inferred (after an await or a timer)',
  propagated: 'from another service, in a message header',
};

const META_NAMES: Record<string, string> = {
  topic: 'Topic', partition: 'Partition', offset: 'Offset', group: 'Consumer group', key: 'Key', exchange: 'Exchange',
  routingKey: 'Routing key', queue: 'Queue', deliveryTag: 'Delivery tag', redelivered: 'Redelivered', messages: 'Messages',
  firstOffset: 'First offset', lastOffset: 'Last offset',
};

/** One broker fact recorded with a message. */
function MetaFact({ name, value }: { name: string; value: unknown }) {
  const shown = value === '' && name === 'exchange' ? '(default exchange)' : typeof value === 'string' ? value : JSON.stringify(value);
  return <><dt>{META_NAMES[name] ?? name}</dt><dd><code>{shown}</code></dd></>;
}

/**
 * In a system view, where a consumed message came from and where a published one went. Only a parent in the window
 * can be jumped to; one outside it, or one that was never recorded, is said so.
 */
function CrossService({ index, item }: { index: ReplayIndex; item: IndexedOccurrence }) {
  const seek = useStore((s) => s.seekToOccurrence);
  const sys = index.system;
  const consumers = sys?.consumers.get(item.occ.id) ?? [];
  if (!sys) return item.occ.remoteParent ? <><dt>From</dt><dd className="muted">another service (open the system view to follow it)</dd></> : null;
  const link = sys.links.get(item.occ.id);
  const serviceOf = (occId: string) => {
    const i = index.byId.get(occId);
    return i ? serviceOfOccurrence(index, i) : undefined;
  };
  return (
    <>
      {link && (
        <>
          <dt>Published by</dt>
          <dd>
            {link.status === 'in-view' ? (
              <button className="link" onClick={() => seek(sys.parentId(link))}>
                {serviceOf(sys.parentId(link)) ?? 'another service'} · <EventRef>{eventLabel(index, index.byId.get(sys.parentId(link))!)}</EventRef>
              </button>
            ) : link.status === 'outside-window'
              ? <span className="muted">a service, before this window</span>
              : <span className="muted">a service Ida doesn't record (or another project)</span>}
            {link.skewMs !== undefined && (
              <div><Badge tone="warn" title="Consumed before it was published, by the services' clocks: they disagree by at least this much. Times are shown as recorded.">clock skew ≥ {fmtMs(link.skewMs)}</Badge></div>
            )}
          </dd>
        </>
      )}
      {consumers.length > 0 && (
        <>
          <dt>Consumed by</dt>
          <dd>
            <ul className="handler-list">
              {consumers.map((l) => (
                <li key={l.occurrenceId}>
                  <button className="link" onClick={() => seek(l.occurrenceId)}>
                    {serviceOf(l.occurrenceId) ?? 'a service'} · <EventRef>{eventLabel(index, index.byId.get(l.occurrenceId)!)}</EventRef>
                  </button>
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}
    </>
  );
}

/** In a system view: which service a node is in, or for a service, its runs; for a broker, which broker it is. */
function SystemFacts({ index, m }: { index: ReplayIndex; m: ModelNode }) {
  const sys = index.system;
  if (!sys) return null;
  const broker = m.broker && index.processes.get(m.processId)?.broker;
  if (broker) {
    return <><dt>Broker</dt><dd>{broker.type === 'kafka' ? 'Kafka' : 'RabbitMQ'}{broker.cluster ? ` · ${broker.type === 'kafka' ? 'cluster' : 'vhost'} ${broker.cluster}` : ''}</dd></>;
  }
  const service = m.service ? sys.services.get(m.service) : undefined;
  if (service) {
    const runtimes = [...new Set(service.sessions.map((s) => [s.sdk && `${s.sdk.language === 'js' ? 'JavaScript' : 'Python'} SDK ${s.sdk.version}`, s.runtime].filter(Boolean).join(' · ')))];
    return (
      <>
        <dt>Runs</dt><dd>{service.sessions.length} in this window{service.sessions.length > 1 && <span className="muted"> (restarts or instances)</span>}</dd>
        <dt>Runtime</dt><dd>{runtimes.map((r) => <div key={r}>{r || <span className="muted">unknown</span>}</div>)}</dd>
        {service.sessions.some((s) => s.clockShiftMs) && (
          <>
            <dt>Clock</dt>
            <dd title="Its clock put a consume before the publish it came from, so its events are drawn that much later. The order within the service is unchanged.">
              drawn {fmtMs(Math.max(...service.sessions.map((s) => s.clockShiftMs ?? 0)))} later, to keep each message after its publish
            </dd>
          </>
        )}
      </>
    );
  }
  const owner = m.rawId ? sys.nodeService.get(m.rawId) : serviceOfProcess(index, m.processId);
  return owner ? <><dt>Service</dt><dd>{owner}</dd></> : null;
}

/** What a handler did over time (handled above the line, emitted below), then its runs. Clean runs are hidden until asked for. */
function ActivitySection({ index, runs, window }: { index: ReplayIndex; runs: Run[]; window: [number, number] }) {
  const [showAll, setShowAll] = useState(false);
  const { cap, setMore } = useRowCap();
  const problems = useMemo(() => runs.filter((r) => isProblemRun(index, r)), [index, runs]);
  const shown = showAll ? runs : problems;
  // The rows are drawn at low priority, so a burst of new events never blocks the graph's animation.
  const rows = useDeferredValue(shown.slice(0, cap));
  return (
    <Section title="Activity" aside={showAll ? runs.length : `${problems.length} of ${runs.length}`}>
      <ActivityTrack index={index} runs={runs} window={window} />
      {runs.length === 0
        ? <p className="hint">This handler did nothing in the selected window.</p>
        : <CleanToggle shown={problems.length} total={runs.length} noun="runs" checked={showAll} onChange={setShowAll} empty="No throws or suspected corrupt payloads in this window." />}
      <ul className="list">
        {rows.map((r) => {
          const thrown = r.error ? throwIdFor(index, r.item.occ.id, r.nodeId) : null;
          return (
            <RunRow
              key={r.id}
              runId={r.id}
              occId={r.item.occ.id}
              eventId={eventKey(r.item.template)}
              ts={r.item.occ.ts}
              start={index.origin}
              error={r.error}
              downstream={!!r.downstream}
              errorId={r.error ? thrown ?? throwId(r.item.occ.id, r.nodeId) : null}
              thrown={thrown}
              flagged={index.findingsByOcc.has(r.item.occ.id)}
            />
          );
        })}
      </ul>
      <ShowMore total={shown.length} cap={cap} onMore={() => setMore(true)} />
    </Section>
  );
}

interface RunRowProps { runId: string; occId: string; eventId: string; ts: number; start: number; error?: string; downstream: boolean; errorId: string | null; thrown: string | null; flagged: boolean }

/** One run of a handler. Everything it draws is in its props, so a burst of new events leaves the old rows alone. */
const RunRow = memo(function RunRow(p: RunRowProps) {
  const selectAt = useStore((s) => s.selectAt);
  return (
    <li>
      <button className="row" onClick={() => {
        // A run that threw is best explained by its error.
        selectAt(p.thrown ? { type: 'throw', id: p.thrown } : { type: 'run', id: p.runId }, p.occId);
      }}>
        <span className="row-head">
          {p.error && <Badge tone="error">{p.downstream ? '✕ Downstream Error' : '✕ Error'}</Badge>}
          {p.errorId && <ErrorId id={p.errorId} />}
          {p.flagged && <Badge tone="warn">⚠ Corrupt Payload</Badge>}
          <span className="muted">{fmtMs(p.ts - p.start)}</span>
        </span>
        <span className="row-text"><EventLink id={p.eventId} /></span>
        {p.error && <span className="run-error" title={p.error}>{p.error}</span>}
      </button>
    </li>
  );
});

/** The activity mini-timeline. It follows the playhead, so it is the only part of the section that redraws every frame. */
function ActivityTrack({ index, runs, window }: { index: ReplayIndex; runs: Run[]; window: [number, number] }) {
  const t = useStore((s) => s.t);
  const setT = useStore((s) => s.setT);
  const scrubbing = useRef(false);
  const span = Math.max(window[1] - window[0], 1);
  // The timeline spans the replay window, so a pointer position maps straight to a time inside it.
  const scrub = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setT(window[0] + Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * span);
  };
  return (
    <svg
      className="mini"
      viewBox="0 0 1000 24"
      preserveAspectRatio="none"
      role="slider"
      tabIndex={0}
      aria-label="Replay position"
      aria-valuemin={0}
      aria-valuemax={Math.round(span)}
      aria-valuenow={Math.round(Math.min(Math.max(t - window[0], 0), span))}
      onPointerDown={(e) => { scrubbing.current = true; e.currentTarget.setPointerCapture(e.pointerId); scrub(e); }}
      onPointerMove={(e) => { if (scrubbing.current) scrub(e); }}
      onPointerUp={() => { scrubbing.current = false; }}
      onPointerCancel={() => { scrubbing.current = false; }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        setT(Math.min(Math.max(t + (e.key === 'ArrowRight' ? 1 : -1) * span / 100, window[0]), window[1]));
      }}
    >
      <ActivityDots index={index} runs={runs} window={window} />
      {t >= window[0] && t <= window[1] && <line x1={((t - window[0]) / span) * 1000} x2={((t - window[0]) / span) * 1000} y1={0} y2={24} className="mini-playhead" />}
    </svg>
  );
}

const ActivityDots = memo(function ActivityDots({ index, runs, window }: { index: ReplayIndex; runs: Run[]; window: [number, number] }) {
  const span = Math.max(window[1] - window[0], 1);
  return (
    <>
      {runs.map((r) => {
        const cls = r.error ? 'dot-error' : index.findingsByOcc.has(r.item.occ.id) ? 'dot-warn' : r.dir === 'handled' ? 'dot-in' : 'dot-out';
        return <circle key={r.id} cx={((r.item.occ.ts - window[0]) / span) * 1000} cy={r.dir === 'handled' ? 8 : 17} r={3} className={cls} />;
      })}
    </>
  );
});

/** "Show clean …" checkbox for a list that defaults to its problem entries, with the hint for when there are none. */
function CleanToggle({ shown, total, noun, checked, onChange, empty }: { shown: number; total: number; noun: string; checked: boolean; onChange(v: boolean): void; empty: string }) {
  return (
    <>
      {shown < total && (
        <label className="checkbox">
          <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
          Show clean {noun} ({total - shown})
        </label>
      )}
      {!checked && shown === 0 && <p className="hint">{empty}</p>}
    </>
  );
}

/** One run of a handler: what the activity log shows for a row, plus the payload it received. */
function RunDetail({ index, id }: { index: ReplayIndex; id: string }) {
  const run = runById(index, id);
  const p = parseRunId(index, id);
  if (!run || !p) return <p className="hint">That run is no longer in the recording.</p>;
  const { item, dir, ms, error } = run;
  const findings = index.findingsByOcc.get(item.occ.id);
  return (
    <>
      <Section title={<><HandlerLink id={p.nodeId} during={dir === 'handled' ? item.occ.id : undefined} /> {dir}</>} aside={findings?.length ? <FindingBadges findings={findings} /> : undefined}>
        <dl className="facts">
          <dt>At</dt><dd>{fmtMs(item.occ.ts - index.origin)}</dd>
          <dt>Event</dt><dd><EventLink id={eventKey(item.template)} /></dd>
          <dt>Took</dt><dd>{ms !== undefined ? fmtMs(ms) : '—'}</dd>
          <dt>Result</dt><dd>{error ? <><span className="err">✕ {error}</span> <ErrorId id={throwIdFor(index, item.occ.id, p.nodeId) ?? throwId(item.occ.id, p.nodeId)} /></> : dir === 'handled' ? 'ok' : '—'}</dd>
        </dl>
        <div className="chain" aria-label="Call chain"><CallChain index={index} occurrenceId={item.occ.id} /></div>
      </Section>
      <PayloadSection item={item} findings={findings} />
    </>
  );
}

/** Events and how often each occurred, by `eventKey`. */
function EventList({ title, events }: { title: string; events: Map<string, number> }) {
  return (
    <Section title={title} aside={events.size}>
      {events.size === 0 ? <p className="muted">none in this window</p> : (
        <ul className="list">
          {[...events].map(([key, n]) => (
            <li key={key} className="tpl"><strong><EventLink id={key} /></strong><span className="muted">{n}×</span></li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function EdgeDetail({ index, id }: { index: ReplayIndex; id: string }) {
  const model = useModel();
  const window = useStore((s) => s.window);
  const select = useStore((s) => s.select);
  const { cap, setMore } = useRowCap();
  const edge = model?.edges.find((e) => e.id === id);
  const items = useMemo(
    () => (model ? inWindow(index, window).filter((i) => i.hops.some((h) => `${model.mapNode(h.src)}>${model.mapNode(h.dst)}` === id)) : []),
    [index, window, model, id],
  );
  // Only suspect payloads show until asked for. A throw on the receiving end says nothing about the payload itself.
  const [showAll, setShowAll] = useState(false);
  const problems = useMemo(() => items.filter((i) => index.findingsByOcc.has(i.occ.id)), [items, index]);
  if (!edge || !model) return null;
  const shown = showAll ? items : problems;
  const rows = useDeferredValue(shown.slice(0, cap));
  return (
    <>
      <Section title="Pathway">
        <p className="route"><NodeName model={model} id={edge.source} /> → <NodeName model={model} id={edge.target} /></p>
        <dl className="facts"><dt>Events</dt><dd>{edge.events.map((e, k) => <span key={e}>{k > 0 && ', '}<EventLink id={e} /></span>)}</dd><dt>Fired</dt><dd><FiredCount times={edge.times} end={window[1]} /> of {edge.count}×</dd></dl>
      </Section>
      <RateSection id={id} kind="edge" />
      <Section title="Payloads" aside={showAll ? items.length : `${problems.length} of ${items.length}`}>
        <CleanToggle shown={problems.length} total={items.length} noun="payloads" checked={showAll} onChange={setShowAll} empty="No suspected corrupt payloads on this pathway in this window." />
        <ul className="list">
          {rows.map((i) => (
            <PayloadRow
              key={i.occ.id}
              occId={i.occ.id}
              ts={i.occ.ts}
              start={index.origin}
              flagged={index.findingsByOcc.has(i.occ.id)}
              errorKind={i.throws.length === 0 ? null : i.throws.every((th) => th.rethrown) ? 'downstream' : 'error'}
              throwIds={i.throws.map((th) => th.id).join('\n')}
              full={i.occ.capture === 'full'}
              payload={i.occ.payload}
              shape={i.template.payloadShape}
            />
          ))}
        </ul>
        <ShowMore total={shown.length} cap={cap} onMore={() => setMore(true)} />
      </Section>
    </>
  );
}

interface PayloadRowProps { occId: string; ts: number; start: number; flagged: boolean; errorKind: 'error' | 'downstream' | null; throwIds: string; full: boolean; payload: unknown; shape: string }

/** One payload on a pathway. Like `RunRow`, it only redraws when something it shows changes. */
const PayloadRow = memo(function PayloadRow(p: PayloadRowProps) {
  const seek = useStore((s) => s.seekToOccurrence);
  return (
    <li>
      <button className="row" onClick={() => seek(p.occId)}>
        <span className="row-head">
          {p.errorKind && <Badge tone="error">{p.errorKind === 'downstream' ? '✕ Downstream Error' : '✕ Error'}</Badge>}
          {p.throwIds && p.throwIds.split('\n').map((id) => <ErrorId key={id} id={id} />)}
          {p.flagged && <Badge tone="warn">⚠ Corrupt Payload</Badge>}
          <span className="muted">{fmtMs(p.ts - p.start)}</span>
        </span>
        {p.full
          ? <code className="payload">{JSON.stringify(p.payload)}</code>
          : <code className="payload shape" title="Template-only: values were not stored, this is the payload's shape">{p.shape}</code>}
      </button>
    </li>
  );
});

/** How often a pathway has fired by the playhead. Reads the playhead itself so the rest of the inspector doesn't redraw with it. */
function FiredCount({ times, end }: { times: number[]; end: number }) {
  const t = useStore((s) => s.t);
  return <>{countFired(times, t, end)}</>;
}

export function OccurrenceDetail({ index, id }: { index: ReplayIndex; id: string }) {
  const item = index.byId.get(id);
  if (!item) return <p className="hint">That event is no longer in the recording.</p>;
  // A flagged event and its finding are the same thing to inspect.
  if (index.findingsByOcc.has(id)) return <CorruptPayloadDetail index={index} occurrenceId={id} />;
  return (
    <>
      <Section title={<EventLink id={eventKey(item.template)} />} aside={<CaptureBadge occ={item.occ} />}>
        <EventFacts index={index} item={item} />
      </Section>
      <PayloadSection item={item} />
    </>
  );
}

/** When and where an event happened, who handled it, and (unless `chain` is false) the events that led to it. */
function EventFacts({ index, item, chain: showChain = true }: { index: ReplayIndex; item: IndexedOccurrence; chain?: boolean }) {
  const seek = useStore((s) => s.seekToOccurrence);
  const startTrace = useStore((s) => s.startTrace);
  const tracing = useStore((s) => s.trace !== null);
  const chain = chainOf(index, item.occ.id);
  const showNode = (nid: string) => <HandlerLink id={nid} />;
  const results = item.occ.handlerResults;
  return (
    <>
      <dl className="facts">
        <dt>At</dt><dd>{fmtMs(item.occ.ts - index.origin)} · took {fmtMs(item.occ.durationMs)}</dd>
        <dt>Emitted by</dt><dd>{showNode(item.occ.sourceNodeId)}</dd>
        <dt>Handlers</dt>
        <dd>
          {item.occ.blocked ? <span className="muted">none, blocked by policy</span> : results.length === 0 && <span className="muted">none</span>}
          <ul className="handler-list">
            {results.map((r, k) => (
              <li key={k}>
                <HandlerLink id={r.handlerId} during={item.occ.id} />
                {r.error && <><span className="err"> ✕ {r.error.name}: {r.error.message}</span> <ErrorId id={throwIdFor(index, item.occ.id, r.handlerId) ?? throwId(item.occ.id, r.handlerId)} /></>}
              </li>
            ))}
          </ul>
        </dd>
        <dt>Causality</dt><dd>{CAUSALITY[item.occ.causality] ?? item.occ.causality}</dd>
        <CrossService index={index} item={item} />
        {item.occ.meta && Object.entries(item.occ.meta).map(([k, v]) => (
          <MetaFact key={k} name={k} value={v} />
        ))}
      </dl>
      {!tracing && (
        <button className="trace-start" onClick={() => startTrace({ type: 'occurrence', id: item.occ.id, occurrenceId: item.occ.id })} title="Step through what led to this event, across services (T)">
          Trace what led here
        </button>
      )}
      {showChain && <div className="chain" aria-label="Causal chain">
        {chain.map((c, k) => (
          <span key={c.occ.id}>
            {k > 0 && <span className="muted"> ▸ </span>}
            <button className={`link ${c.occ.id === item.occ.id ? 'current' : ''}`} onClick={() => seek(c.occ.id)}><EventRef>{eventLabel(index, c)}</EventRef></button>
          </span>
        ))}
      </div>}
    </>
  );
}

/** The payload, led by what was flagged in it when it is suspected corrupt. */
function PayloadSection({ item, findings = [] }: { item: IndexedOccurrence; findings?: Finding[] }) {
  return (
    <Section title="Payload" aside={<CaptureBadge occ={item.occ} />}>
      {findings.map((f) => (
        <div key={f.id}>
          <ul className="reasons">{f.reasons.map((r, k) => <li key={k}>{r.message}</li>)}</ul>
          {f.diff.length > 0 && (
            <table className="diff">
              <thead><tr><th>Field</th><th>Before</th><th>Now</th></tr></thead>
              <tbody>
                {f.diff.map((d, k) => (
                  <tr key={k}><td>{d.path || '(payload)'}</td><td><code>{shortValue(d.baseline)}</code></td><td><code>{shortValue(d.actual)}</code></td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
      {item.occ.capture === 'full' ? (
        <Json value={item.occ.payload} />
      ) : (
        <>
          <p className="hint">Template-only: values were not stored. The shape of every occurrence of this template is:</p>
          <code className="shape">{item.template.payloadShape}</code>
        </>
      )}
    </Section>
  );
}

const TIER_TONE = { critical: 'external', high: 'error', medium: 'warn', low: 'muted' } as const;

function TierBadge({ tier }: { tier: Tier }) {
  return <Badge tone={TIER_TONE[tier]} title="Severity, from confidence and whether an external system is reached">{tier}</Badge>;
}

/** Where payloads went, external systems first. Clicking a row shows that recipient on the graph. */
function Recipients({ index, findings }: { index: ReplayIndex; findings: Finding[] }) {
  const inspectNode = useStore((s) => s.inspectNode);
  const recipients = recipientsOf(index, findings);
  return (
    <Section title="Recipients" aside={recipients.length}>
      {recipients.length === 0 && <p className="hint">No receiving handlers or external systems.</p>}
      <ul className="list">
        {recipients.map((r) => {
          const nodeId = r.nodeId;
          return (
            <li key={`${r.external}:${r.label}`}>
              <button className={`row ${r.external ? 'row-high' : ''}`} disabled={!nodeId} title="Inspect and show on graph" onClick={() => nodeId && inspectNode(nodeId)}>
                <span className="row-head">
                  {r.external ? <Badge tone="external">EXTERNAL</Badge> : <Badge tone="muted">internal</Badge>}
                  <span className="row-text">{nodeId ? <NodeRef id={nodeId} label={r.label} /> : r.label}</span>
                  <span className="muted">{r.count} corrupted payload{r.count === 1 ? '' : 's'}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** A handler failure and everything it is suspected of corrupting. */
function ErrorDetail({ index, id }: { index: ReplayIndex; id: string }) {
  const seek = useStore((s) => s.seekToOccurrence);
  const startTrace = useStore((s) => s.startTrace);
  const src = parseThrowId(index, id);
  const item = src && index.byId.get(src.occurrenceId);
  if (!src || !item) return <p className="hint">That error is no longer in the recording.</p>;
  const thrown = item.throws.find((t) => t.handlerId === src.handlerId);
  const tainted = index.findingsBySource.get(id) ?? [];
  const propagated = index.propagations.get(id) ?? [];
  const external = tainted.filter((f) => f.priority === 'high').length;
  const rank = notifications(index, [item]).find((n) => n.id === id)?.tier;
  return (
    <>
      <Section title={<><ErrorId id={id} /> <HandlerLink id={src.handlerId} /> {thrown ? 'threw' : 'reported an error'}</>} aside={rank && <TierBadge tier={rank} />}>
        <dl className="facts">
          {thrown && <><dt>Error</dt><dd>{thrown.message}</dd></>}
          <dt>At</dt><dd>{fmtMs((thrown?.at ?? item.occ.ts) - index.origin)}</dd>
          <dt>While handling</dt><dd><button className="link" onClick={() => seek(item.occ.id)}><EventRef>{eventLabel(index, item)}</EventRef></button></dd>
          <dt>Corrupted payloads sent</dt><dd>{tainted.length}</dd>
          <dt>Sent to external systems</dt><dd>{external}</dd>
        </dl>
        {tainted.length === 0 && <p className="hint">No payload sent after this error has been flagged as corrupt.</p>}
      </Section>
      {propagated.length > 0 && (
        <Section title="Propagated through" aside={propagated.length}>
          <ul className="list">
            {propagated.map((p) => {
              const at = index.byId.get(p.occurrenceId);
              return (
                <li key={`${p.occurrenceId}|${p.handlerId}`} className="tpl">
                  <HandlerLink id={p.handlerId} during={p.occurrenceId} />
                  {at && <EventLink id={eventKey(at.template)} />}
                </li>
              );
            })}
          </ul>
        </Section>
      )}
      {tainted.length > 0 && <Recipients index={index} findings={tainted} />}
      {tainted.length > 0 && (
        <Section title="Corrupted payloads" aside={tainted.length}>
          <ul className="list">
            {tainted.map((f) => (
              <li key={f.id}>
                <button className={`row ${f.priority === 'high' ? 'row-high' : ''}`} onClick={() => startTrace({ type: 'finding', id: f.id, occurrenceId: f.occurrenceId })}>
                  <span className="row-head">
                    <Badge tone="warn">⚠ Corrupt Payload</Badge>
                    {f.priority === 'high' && <Badge tone="external">EXTERNAL</Badge>}
                    <span className="muted">{fmtMs(f.ts - index.origin)}</span>
                  </span>
                  <span className="row-text"><FindingSummary index={index} finding={f} /></span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

function FindingSelection({ index, id }: { index: ReplayIndex; id: string }) {
  const finding = index.findingsById.get(id);
  if (!finding) return <p className="hint">That payload is no longer in the recording.</p>;
  return <CorruptPayloadDetail index={index} occurrenceId={finding.occurrenceId} />;
}

/**
 * The one inspector for a suspected corrupt payload, whether it was opened from a notification, an error, a
 * pathway or the timeline: the error it is traced to, the event itself, the payload and what was flagged in it, and
 * where it went.
 */
function CorruptPayloadDetail({ index, occurrenceId }: { index: ReplayIndex; occurrenceId: string }) {
  const startTrace = useStore((s) => s.startTrace);
  const item = index.byId.get(occurrenceId);
  const findings = index.findingsByOcc.get(occurrenceId) ?? [];
  if (!item || findings.length === 0) return <p className="hint">That payload is no longer in the recording.</p>;
  const ranked = notifications(index, [item]).filter((n) => n.kind === 'finding');
  const tier = ranked[0]?.tier;
  const sources = [...new Map(findings.flatMap((f) => (f.taintSource ? [[throwId(f.taintSource.occurrenceId, f.taintSource.handlerId), f.taintSource] as const] : []))).entries()];
  const external = [...new Set(findings.flatMap((f) => f.externalTargets))];
  return (
    <>
      {sources.length > 0 && (
        <Section title="Source error">
          {sources.map(([id, source]) => {
            const sourceItem = index.byId.get(source.occurrenceId);
            const message = sourceItem?.throws.find((t) => t.handlerId === source.handlerId)?.message;
            return sourceItem ? (
              <button key={id} className="link source-error" onClick={() => startTrace({ type: 'throw', id, occurrenceId: source.occurrenceId })}>
                <ErrorId id={id} /> <NodeRef id={source.handlerId} /> {message ? `threw: ${message}` : 'reported an error'} →
              </button>
            ) : (
              <p key={id} className="hint">The source error is no longer in the recording.</p>
            );
          })}
        </Section>
      )}
      <Section title={<EventLink id={eventKey(item.template)} />} aside={tier && <TierBadge tier={tier} />}>
        <div className="row-badges">
          <Badge tone="warn">⚠ Corrupt Payload</Badge>
          {external.length > 0 && <Badge tone="external" title={external.join(', ')}>EXTERNAL · {external.join(', ')}</Badge>}
          {[...new Set(findings.map((f) => f.confidence))].map((c) => <Badge key={c} tone="muted">{c} confidence</Badge>)}
          {findings.some((f) => f.basis === 'shape') && <Badge tone="muted">shape comparison only</Badge>}
          {findings.some((f) => f.retroactive) && <Badge tone="muted">found after the fact</Badge>}
        </div>
        {/* Findings on one event differ only in what was flagged, so they share a chain unless traced to different throws. */}
        {[...new Map(findings.map((f) => [f.taintSource?.handlerId, f])).values()].map((f) => (
          <p key={f.id} className="finding-chain"><FindingChain index={index} finding={f} /></p>
        ))}
        <EventFacts index={index} item={item} chain={false} />
      </Section>
      <PayloadSection item={item} findings={findings} />
    </>
  );
}
