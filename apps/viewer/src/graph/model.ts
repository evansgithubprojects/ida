import type { Process } from '@ida-dev/core';
import type { IndexedOccurrence, MapNode, ReplayIndex, Trace } from '../replay';
import { countsOnCard, edgeId, eventKey } from '../replay';

/**
 * services = a system view zoomed all the way out; process = the processes (of one service, when `service` is set);
 * handlers = inside one process. (The activity view is a separate screen.)
 */
export type Level = { kind: 'services' } | { kind: 'process'; service?: string } | { kind: 'handlers'; processId: string };

/** How far in a level is: services 0, processes 1, handlers 2. */
export const levelDepth = (l: Level) => (l.kind === 'services' ? 0 : l.kind === 'process' ? 1 : 2);

export const sameLevel = (a: Level, b: Level) =>
  a.kind === b.kind
  && (a.kind !== 'process' || a.service === (b as { service?: string }).service)
  && (a.kind !== 'handlers' || a.processId === (b as { processId: string }).processId);

/** The level a recording opens at: its services when it is a system view, else its processes. */
export const topLevel = (index: ReplayIndex | null): Level => (index?.system ? { kind: 'services' } : { kind: 'process' });

/** The service a process belongs to in a system view; undefined for a broker process or an ordinary recording. */
export const serviceOfProcess = (index: ReplayIndex | null, processId: string) => index?.system?.processService.get(processId) ?? undefined;

/** The level a double-click on a card opens: a service's processes, or a process's handlers. */
export function levelInto(m: ModelNode): Level | null {
  if (m.service) return { kind: 'process', service: m.service };
  if (m.kind === 'process' || m.kind === 'stub') return { kind: 'handlers', processId: m.processId };
  return null;
}

/** The level one step out from `level`. */
export function parentLevel(index: ReplayIndex | null, level: Level): Level | null {
  if (level.kind === 'handlers') {
    if (!index?.system) return { kind: 'process' };
    // A broker process belongs to no one service, so out of it is the whole system.
    const service = serviceOfProcess(index, level.processId);
    return service ? { kind: 'process', service } : { kind: 'services' };
  }
  if (level.kind === 'process' && index?.system) return { kind: 'services' };
  return null;
}

export interface ModelNode {
  id: string;
  label: string;
  /** `service` is a whole service in a system view; `stub` stands for a process (or service) outside the current scope. */
  kind: 'process' | 'handler' | 'emitter' | 'stub' | 'service';
  processId: string;
  /** Short facts shown under the label. */
  detail: string;
  /** Raw node id for handler/emitter nodes, which can be opened in the activity view. */
  rawId?: string;
  /** Drawn only because something is looking at it: it has no activity in the window. */
  idle?: boolean;
  /** Set for a topic, exchange or queue: drawn in that shape. */
  broker?: Process['kind'];
  /** Which broker it belongs to (Kafka, RabbitMQ), for its logo. */
  brokerType?: NonNullable<Process['broker']>['type'];
  /** For a `service` node, or a stub that stands for one: its recorder key. */
  service?: string;
}

export interface ModelEdge {
  id: string;
  source: string;
  target: string;
  /** Total over the window. */
  count: number;
  /** Timestamp of every hop on this route, ascending, so a count at any playhead position is a binary search. */
  times: number[];
  /** `eventKey`s of the events that used this route, by label. */
  events: string[];
  /** Some events on this route were linked through a message header, from another service. */
  propagated?: boolean;
}

export interface GraphModel {
  nodes: ModelNode[];
  edges: ModelEdge[];
  mapNode: MapNode;
}

export const processNodeId = (processId: string) => `p:${processId}`;
export const serviceNodeId = (key: string) => `s:${key}`;

/** `pinned` raw node ids are drawn even when the window gives them nothing to show, so a link to one has somewhere to land. */
export function buildModel(index: ReplayIndex, level: Level, items: IndexedOccurrence[] = index.items, pinned: readonly string[] = []): GraphModel {
  const sys = index.system;
  const mapNode: MapNode = (id) => {
    const n = index.nodes.get(id);
    if (!n) return null;
    if (level.kind === 'handlers') {
      if (n.processId === level.processId) return n.id;
      // In a system view, another service's nodes stand for that service, not for each of its processes.
      const service = sys?.nodeService.get(id);
      if (service && service !== sys!.processService.get(level.processId)) return serviceNodeId(service);
      return processNodeId(n.processId);
    }
    if (!sys) return processNodeId(n.processId);
    // A broker's own node is its process at every level; any other node is its service's, unless that is in scope.
    const service = sys.nodeService.get(id);
    if (!service) return processNodeId(n.processId);
    if (level.kind === 'services' || service !== level.service) return serviceNodeId(service);
    // In its own service, a consumer's handler sits in the broker process it consumes from.
    return processNodeId(n.processId);
  };

  const edges = new Map<string, ModelEdge & { names: Set<string> }>();
  const propagated = new Set<string>();
  const used = new Set<string>();
  const handled = new Map<string, number>();
  const emitted = new Map<string, number>();

  // Zoomed into one service: only what it took part in, and other services' traffic through the brokers it uses.
  let relevant = (_src: string, _dst: string) => true;
  if (sys && level.kind === 'process' && level.service) {
    const own = (id: string) => sys.nodeService.get(id) === level.service;
    const brokerProcess = (id: string) => {
      const pid = index.nodes.get(id)?.processId;
      return pid !== undefined && sys.processService.get(pid) === null ? pid : null;
    };
    const touched = new Set<string>();
    for (const item of items) {
      for (const hop of item.hops) {
        if (!own(hop.src) && !own(hop.dst)) continue;
        for (const id of [hop.src, hop.dst]) { const b = brokerProcess(id); if (b !== null) touched.add(b); }
      }
    }
    // A broker-to-broker route (an exchange routing to a queue) carries the message on: follow it both ways, so a
    // queue fed from an exchange this service publishes to shows where it goes, and vice versa.
    for (let grew = true; grew;) {
      grew = false;
      for (const item of items) {
        for (const hop of item.hops) {
          const a = brokerProcess(hop.src);
          const b = brokerProcess(hop.dst);
          if (a !== null && b !== null && touched.has(a) !== touched.has(b)) { touched.add(a).add(b); grew = true; }
        }
      }
    }
    relevant = (a, b) => own(a) || own(b) || [a, b].some((id) => { const p = brokerProcess(id); return p !== null && touched.has(p); });
  } else if (sys && level.kind === 'handlers') {
    // Inside one process: only what it took part in.
    const inside = (id: string) => index.nodes.get(id)?.processId === level.processId;
    relevant = (a, b) => inside(a) || inside(b);
  }

  for (const item of items) {
    for (const hop of item.hops) {
      if (!relevant(hop.src, hop.dst)) continue;
      const src = mapNode(hop.src);
      const dst = mapNode(hop.dst);
      if (!src || !dst) continue;
      if (countsOnCard(index, hop.dst, dst)) handled.set(dst, (handled.get(dst) ?? 0) + 1);
      if (countsOnCard(index, hop.src, src)) emitted.set(src, (emitted.get(src) ?? 0) + 1);
      used.add(src).add(dst);
      if (src === dst) continue;
      const id = edgeId(src, dst);
      const e = edges.get(id) ?? { id, source: src, target: dst, count: 0, times: [], events: [], names: new Set<string>() };
      e.count++;
      e.times.push(item.occ.ts);
      e.names.add(eventKey(item.template));
      if (item.occ.causality === 'propagated') propagated.add(id);
      edges.set(id, e);
    }
  }

  const detail = (id: string) => `${handled.get(id) ?? 0} in · ${emitted.get(id) ?? 0} out`;
  const nodes: ModelNode[] = [];

  const brokerOf = (pid: string) => {
    const p = index.processes.get(pid);
    return p?.kind && p.kind !== 'emitter' ? p.kind : undefined;
  };
  /** A broker process's kind and broker, spread into its node. */
  const brokerFields = (pid: string) => {
    const kind = brokerOf(pid);
    const type = index.processes.get(pid)?.broker?.type;
    return kind ? { broker: kind, ...(type && { brokerType: type }) } : {};
  };
  const processNode = (pid: string): ModelNode => ({
    id: processNodeId(pid), label: index.processLabel.get(pid) ?? pid, kind: 'process', processId: pid, detail: detail(processNodeId(pid)),
    ...brokerFields(pid),
  });

  if (level.kind === 'services' && sys) {
    for (const key of sys.services.keys()) {
      const id = serviceNodeId(key);
      nodes.push({ id, label: key, kind: 'service', processId: '', service: key, detail: detail(id) });
    }
    // Brokers every service shares, as far as anything in the window used them.
    for (const pid of index.processLabel.keys()) if (sys.processService.get(pid) === null && used.has(processNodeId(pid))) nodes.push(processNode(pid));
  } else if (level.kind === 'process' && sys) {
    for (const pid of index.processLabel.keys()) {
      const owner = sys.processService.get(pid);
      // Its own processes, and the brokers it (or its neighbours) used.
      if (owner === level.service || (owner === null && used.has(processNodeId(pid)))) nodes.push(processNode(pid));
    }
    for (const id of used) {
      if (!id.startsWith('s:')) continue;
      const key = id.slice(2);
      nodes.push({ id, label: key, kind: 'stub', processId: '', service: key, detail: 'other service' });
    }
  } else if (level.kind === 'process' || level.kind === 'services') {
    for (const pid of index.processLabel.keys()) nodes.push(processNode(pid));
  } else {
    for (const n of index.nodes.values()) {
      // An emitter that never fired or received anything is just noise.
      const idle = n.kind === 'emitter' && !handled.get(n.id) && !emitted.get(n.id);
      if (n.processId !== level.processId) continue;
      if (!idle) nodes.push({ id: n.id, label: n.label, kind: n.kind, processId: n.processId, detail: detail(n.id), rawId: n.id });
      else if (pinned.includes(n.id)) nodes.push({ id: n.id, label: n.label, kind: n.kind, processId: n.processId, detail: 'no activity in window', rawId: n.id, idle: true });
    }
    for (const id of used) {
      if (id.startsWith('p:') && id !== processNodeId(level.processId)) {
        const pid = id.slice(2);
        nodes.push({ id, label: index.processLabel.get(pid) ?? pid, kind: 'stub', processId: pid, detail: sys?.processService.get(pid) ? `in ${sys.processService.get(pid)}` : 'other process', ...brokerFields(pid) });
      } else if (id.startsWith('s:')) {
        const key = id.slice(2);
        nodes.push({ id, label: key, kind: 'stub', processId: '', service: key, detail: 'other service' });
      }
    }
  }

  return {
    nodes,
    edges: [...edges.values()].map(({ names, ...e }) => ({ ...e, ...(propagated.has(e.id) && { propagated: true }), events: [...names].sort((a, b) => (index.events.get(a)?.label ?? a).localeCompare(index.events.get(b)?.label ?? b)) })),
    mapNode,
  };
}

/** The cards and pathways of `model` that a trace went through, at whatever level `model` is drawn. */
export function tracedParts(model: GraphModel, trace: Trace): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  for (const { item } of trace.steps) {
    for (const hop of item.hops) {
      const src = model.mapNode(hop.src);
      const dst = model.mapNode(hop.dst);
      if (!src || !dst) continue;
      nodes.add(src).add(dst);
      if (src !== dst) edges.add(edgeId(src, dst));
    }
  }
  return { nodes, edges };
}
