import type { IndexedOccurrence, MapNode, ReplayIndex } from '../replay';
import { edgeId, eventKey } from '../replay';

/** process = zoomed out; handlers = inside one process. (The activity view is a separate screen.) */
export type Level = { kind: 'process' } | { kind: 'handlers'; processId: string };

export interface ModelNode {
  id: string;
  label: string;
  kind: 'process' | 'handler' | 'emitter' | 'stub';
  processId: string;
  /** Short facts shown under the label. */
  detail: string;
  /** Raw node id for handler/emitter nodes, which can be opened in the activity view. */
  rawId?: string;
  /** Drawn only because something is looking at it: it has no activity in the window. */
  idle?: boolean;
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
}

export interface GraphModel {
  nodes: ModelNode[];
  edges: ModelEdge[];
  mapNode: MapNode;
}

export const processNodeId = (processId: string) => `p:${processId}`;

/** `pinned` raw node ids are drawn even when the window gives them nothing to show, so a link to one has somewhere to land. */
export function buildModel(index: ReplayIndex, level: Level, items: IndexedOccurrence[] = index.items, pinned: readonly string[] = []): GraphModel {
  const mapNode: MapNode = (id) => {
    const n = index.nodes.get(id);
    if (!n) return null;
    if (level.kind === 'process') return processNodeId(n.processId);
    return n.processId === level.processId ? n.id : processNodeId(n.processId);
  };

  const edges = new Map<string, ModelEdge & { names: Set<string> }>();
  const used = new Set<string>();
  const handled = new Map<string, number>();
  const emitted = new Map<string, number>();

  for (const item of items) {
    for (const hop of item.hops) {
      const src = mapNode(hop.src);
      const dst = mapNode(hop.dst);
      if (!src || !dst) continue;
      handled.set(dst, (handled.get(dst) ?? 0) + 1);
      emitted.set(src, (emitted.get(src) ?? 0) + 1);
      used.add(src).add(dst);
      if (src === dst) continue;
      const id = edgeId(src, dst);
      const e = edges.get(id) ?? { id, source: src, target: dst, count: 0, times: [], events: [], names: new Set<string>() };
      e.count++;
      e.times.push(item.occ.ts);
      e.names.add(eventKey(item.template));
      edges.set(id, e);
    }
  }

  const detail = (id: string) => `${handled.get(id) ?? 0} in · ${emitted.get(id) ?? 0} out`;
  const nodes: ModelNode[] = [];

  if (level.kind === 'process') {
    for (const [pid, label] of index.processLabel) {
      nodes.push({ id: processNodeId(pid), label, kind: 'process', processId: pid, detail: detail(processNodeId(pid)) });
    }
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
        nodes.push({ id, label: index.processLabel.get(pid) ?? pid, kind: 'stub', processId: pid, detail: 'other process' });
      }
    }
  }

  return {
    nodes,
    edges: [...edges.values()].map(({ names, ...e }) => ({ ...e, events: [...names].sort((a, b) => (index.events.get(a)?.label ?? a).localeCompare(index.events.get(b)?.label ?? b)) })),
    mapNode,
  };
}
