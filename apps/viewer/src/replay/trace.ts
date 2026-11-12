import type { Process } from '@ida-dev/core';
import { chainOf, eventLabel, parseThrowId, recipientsOf, serviceOfOccurrence, type Hop, type IndexedOccurrence, type ReplayIndex } from './index';

/** What a trace was started from: an error, a suspected corrupt payload, or any one event. */
export interface TraceTarget {
  type: 'throw' | 'finding' | 'occurrence';
  /** The throw id, finding id or occurrence id. */
  id: string;
  occurrenceId: string;
}

/**
 * Why a slide is in the path:
 * - `root`: where the chain starts
 * - `step`: a handler emitted the next event
 * - `hop`: the event crossed a broker or went to another service
 * - `throw`: a handler threw here
 * - `tainted`: emitted after the failure a corrupt payload is traced to
 * - `target`: the event the trace was started from (a throw target ends on a `throw` slide instead)
 */
export type SlideRole = 'root' | 'step' | 'hop' | 'throw' | 'tainted' | 'target';

export interface TraceSlide {
  item: IndexedOccurrence;
  role: SlideRole;
  /**
   * The pathways this step is drawn with: the event's routes to the handlers the trace goes on through (the one that
   * emitted a later step, the one that threw), not to every handler it reached. The target event keeps all of its
   * routes, unless it ends on a throw.
   */
  hops: Hop[];
  /** In a system view, the service it ran in. */
  service?: string;
  /** Set when the event is a message on a topic, exchange or queue. */
  broker?: { type: 'kafka' | 'rabbitmq'; kind: Process['kind']; name: string };
  /** For a message consumed from another service: how long after its publish it was handled. */
  lagMs?: number;
  /** The handler that threw here, on a `throw` slide. */
  thrownBy?: { id: string; handlerId: string; message: string };
  /** The process this step happens in (the throwing handler's, else the emitter's): the trace zooms into its handlers. */
  processId?: string;
  /** One sentence on why this step matters to the trace. */
  subtitle: string;
}

/**
 * One linear path that led to an error or a suspected corrupt payload, oldest first. It is a snapshot: it keeps its
 * occurrences even after a live view drops them.
 */
export interface TracePath {
  target: TraceTarget;
  slides: TraceSlide[];
  /** Some of the story is missing: the root's cause is outside the window or was never recorded. */
  truncated: boolean;
}

const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(ms < 10 ? 2 : 0)}ms`);

/**
 * The events that caused `target`, root first. An error or event follows its chain of parents. A corrupt payload
 * runs through the error it is traced to and then the payload's own chain, merged in time order. Null when the
 * target is no longer in the recording.
 */
export function tracePath(index: ReplayIndex, target: TraceTarget): TracePath | null {
  const end = index.byId.get(target.occurrenceId);
  if (!end) return null;
  const finding = target.type === 'finding' ? index.findingsById.get(target.id) : undefined;
  const source = finding?.taintSource && index.byId.has(finding.taintSource.occurrenceId) ? finding.taintSource : null;
  const items = new Map<string, IndexedOccurrence>();
  for (const c of source ? chainOf(index, source.occurrenceId) : []) items.set(c.occ.id, c);
  for (const c of chainOf(index, end.occ.id)) items.set(c.occ.id, c);
  const ordered = [...items.values()].sort((a, b) => a.occ.ts - b.occ.ts || (a.occ.id === end.occ.id ? 1 : b.occ.id === end.occ.id ? -1 : 0));
  // The target always closes the slideshow, even when an event of the taint chain happened at the same moment.
  const path = [...ordered.filter((i) => i !== end), end];
  const thrownAt = target.type === 'throw' ? parseThrowId(index, target.id) : null;
  const sourceAt = source ? path.findIndex((i) => i.occ.id === source.occurrenceId) : -1;

  const slides = path.map((item, k): TraceSlide => {
    const slide: Omit<TraceSlide, 'subtitle'> = { item, role: 'step', hops: item.hops };
    const service = serviceOfOccurrence(index, item);
    if (service) slide.service = service;
    const proc = index.processes.get(index.nodes.get(item.template.emitterId)?.processId ?? '');
    if (proc?.broker && (proc.kind === 'topic' || proc.kind === 'exchange' || proc.kind === 'queue')) {
      slide.broker = { type: proc.broker.type, kind: proc.kind, name: proc.label };
    }
    const parent = item.occ.causality === 'propagated' && item.occ.parentId ? index.byId.get(item.occ.parentId) : undefined;
    if (parent) slide.lagMs = item.occ.ts - parent.occ.ts;

    const last = k === path.length - 1;
    const pick = (handlerId?: string) => item.throws.find((t) => !t.rethrown && (!handlerId || t.handlerId === handlerId));
    const thrown = last && thrownAt ? pick(thrownAt.handlerId)
      : k === sourceAt ? pick(source!.handlerId) ?? pick()
      : last && target.type === 'finding' ? undefined
      : pick();
    if (thrown) slide.thrownBy = { id: thrown.id, handlerId: thrown.handlerId, message: thrown.message };
    if (!last || thrown) {
      const keep = new Set<string>();
      if (thrown) keep.add(thrown.handlerId);
      if (k === sourceAt) keep.add(source!.handlerId);
      // A later step this event caused was emitted by the handler that was running: the trace goes on through it.
      for (const later of path.slice(k + 1)) if (later.occ.parentId === item.occ.id) keep.add(later.occ.sourceNodeId);
      slide.hops = relevantHops(item, keep);
    }
    const processId = index.nodes.get(thrown?.handlerId ?? item.occ.sourceNodeId)?.processId;
    if (processId) slide.processId = processId;
    const prev = path[k - 1];
    const prevService = k > 0 ? serviceOfOccurrence(index, prev!) : undefined;
    slide.role = thrown ? 'throw'
      : last ? 'target'
      : k === 0 ? 'root'
      : sourceAt >= 0 && k > sourceAt ? 'tainted'
      : slide.broker || (slide.service && slide.service !== prevService) ? 'hop'
      : 'step';
    return { ...slide, subtitle: '' };
  });

  const root = path[0]!;
  const rootLink = index.system?.links.get(root.occ.id);
  const truncated = (!!root.occ.parentId && !index.byId.has(root.occ.parentId)) || (!!rootLink && rootLink.status !== 'in-view');
  const out: TracePath = { target, slides, truncated };
  slides.forEach((s, k) => (s.subtitle = subtitleOf(index, out, k)));
  return out;
}

/**
 * `item`'s routes to the handlers in `keep`, plus its routes to anything that isn't one of its handlers (a publish to a
 * broker, a message routed from an exchange to a queue, an event nobody listens to). Every route if that leaves none.
 */
function relevantHops(item: IndexedOccurrence, keep: Set<string>): Hop[] {
  const handlers = new Set(item.template.handlerIds);
  const hops = item.hops.filter((h) => !handlers.has(h.dst) || keep.has(h.dst));
  return hops.length ? hops : item.hops;
}

/** Why slide `k` matters, filled in from a template for its role. */
export function subtitleOf(index: ReplayIndex, path: TracePath, k: number): string {
  const slide = path.slides[k]!;
  const { item } = slide;
  const event = eventLabel(index, item);
  const node = (id: string) => index.nodes.get(id)?.label ?? id;
  const prev = path.slides[k - 1];
  const emitter = node(item.occ.sourceNodeId);
  const where = slide.service ? ` in ${slide.service}` : '';
  // Who emitted this event, said from the event the previous slide showed.
  const cause = prev && item.occ.parentId === prev.item.occ.id ? `${emitter} handled ${eventLabel(index, prev.item)} and emitted ${event}` : `${emitter} emitted ${event}`;

  // What happened at this step, whatever its role.
  const flow = (): string => {
    if (k === 0) return `${event} started this chain${where}`;
    if (slide.broker && slide.lagMs !== undefined) {
      return `${event} came through ${slide.broker.kind} ${slide.broker.name} and was picked up${where} ${fmt(slide.lagMs)} after it was published`;
    }
    if (slide.broker) return `${cause}, publishing it to ${slide.broker.kind} ${slide.broker.name}`;
    if (slide.service && slide.service !== prev?.service) return `${cause}, crossing into ${slide.service}`;
    return cause;
  };

  switch (slide.role) {
    case 'root':
      return `${flow()}.${path.truncated ? ' What caused it is outside the recording.' : ''}`;
    case 'step':
    case 'hop':
      return `${flow()}.`;
    case 'throw': {
      const t = slide.thrownBy!;
      const what = `${node(t.handlerId)} threw "${t.message}" while handling ${event}${where}.`;
      if (path.target.type === 'finding') return `${what} The suspect payload is traced to this error.`;
      return k === path.slides.length - 1 ? `${what} This is the error.` : what;
    }
    case 'tainted':
      return `${flow()} after the failure, so it may carry the bad state.`;
    case 'target': {
      if (path.target.type === 'finding') {
        const f = index.findingsById.get(path.target.id) ?? index.findingsByOcc.get(item.occ.id)?.[0];
        const reason = f?.reasons[0]?.message;
        const to = recipientsOf(index, f ? [f] : []).map((r) => r.label);
        return `${event} carried a suspected corrupt payload${reason ? ` (${reason})` : ''}${to.length ? ` to ${to.join(', ')}` : ''}.`;
      }
      return `${flow()}. This is the event you traced.`;
    }
  }
}
