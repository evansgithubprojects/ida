import type { Process, Recording } from '@ida-dev/core';

/** One recorder session in a system view (see the server's `SystemView`). */
export interface SystemService {
  sessionId: string;
  recorderKey: string;
  runtime: string;
  sdk: { language: 'js' | 'python'; version: string } | null;
  startedAt: number;
  processIds: string[];
  /** How much later this session's events are drawn so that what it consumed comes after its publish. */
  clockShiftMs?: number;
}

/** A consume occurrence and the publish it came from; see the server's `SystemLink`. */
export interface SystemLink {
  occurrenceId: string;
  parent: { sessionId: string; occurrenceId: string };
  status: 'in-view' | 'outside-window' | 'missing';
  skewMs?: number;
}

/** What `GET /v1/projects/:id/system` returns. */
export interface SystemView {
  recording: Recording;
  services: SystemService[];
  links: SystemLink[];
  from: number;
  to: number;
  truncated: boolean;
}

/** One message that crossed between a session and another service; see the server's `PeerLink`. */
export interface PeerLink {
  /** This session's side: a publish (in `consumedBy`) or a consume (in `publishedBy`). */
  occurrenceId: string;
  /** The other service's recorder key. */
  service: string;
  /** The other side's broker process, when it isn't this side's (RabbitMQ: an exchange routing to a queue). */
  broker?: Pick<Process, 'id' | 'label' | 'kind' | 'broker'>;
}

/** What `GET /v1/sessions/:id/peers` returns: the other ends of one session's broker messages. */
export interface SessionPeers {
  consumedBy: PeerLink[];
  publishedBy: PeerLink[];
}

/** A service is everything recorded under one recorder key: each of its sessions is a run or an instance of it. */
export interface Service {
  key: string;
  sessions: SystemService[];
}

export interface ServiceIndex {
  /** By recorder key, in order of first appearance. */
  services: Map<string, Service>;
  /** The service each graph node belongs to, or null for a broker's own node (a topic, exchange or queue). */
  nodeService: Map<string, string | null>;
  /** The service each process belongs to, or null for a broker process, which every service shares. */
  processService: Map<string, string | null>;
  /** Cross-service links, by the consuming occurrence's id. */
  links: Map<string, SystemLink>;
  /** Links whose parent is in view, by that parent's id: where a published message was consumed. */
  consumers: Map<string, SystemLink[]>;
  /** Occurrence id (as in the merged recording) for a link's parent, when it is in view. */
  parentId(link: SystemLink): string;
}

const BROKER_KINDS = new Set<Process['kind']>(['topic', 'exchange', 'queue']);
export const isBrokerProcess = (p: Pick<Process, 'kind'> | undefined) => !!p && BROKER_KINDS.has(p.kind);

/** Namespaced ids are `<sessionId>/<id>`; a session id is a UUID, so it never contains the separator. */
const sessionOf = (id: string) => {
  const at = id.indexOf('/');
  return at > 0 ? id.slice(0, at) : null;
};

export function buildServiceIndex(view: Omit<SystemView, 'recording'>, recording: Recording): ServiceIndex {
  const services = new Map<string, Service>();
  const keyOfSession = new Map<string, string>();
  for (const s of view.services) {
    const service = services.get(s.recorderKey) ?? { key: s.recorderKey, sessions: [] };
    service.sessions.push(s);
    services.set(s.recorderKey, service);
    keyOfSession.set(s.sessionId, s.recorderKey);
  }
  const serviceOf = (id: string) => keyOfSession.get(sessionOf(id) ?? '') ?? null;

  const processService = new Map<string, string | null>();
  const brokers = new Set<string>();
  for (const p of recording.processes) {
    if (isBrokerProcess(p)) brokers.add(p.id);
    processService.set(p.id, isBrokerProcess(p) ? null : serviceOf(p.id));
  }
  // A broker's emitter node is shared; every other node (a consumer's handler included) is one service's.
  const nodeService = new Map<string, string | null>();
  for (const n of recording.nodes) {
    nodeService.set(n.id, n.kind === 'emitter' && brokers.has(n.processId) ? null : serviceOf(n.id));
  }
  const parentId = (l: SystemLink) => `${l.parent.sessionId}/${l.parent.occurrenceId}`;
  const consumers = new Map<string, SystemLink[]>();
  for (const l of view.links) {
    if (l.status !== 'in-view') continue;
    const list = consumers.get(parentId(l)) ?? [];
    list.push(l);
    consumers.set(parentId(l), list);
  }
  return { services, nodeService, processService, links: new Map(view.links.map((l) => [l.occurrenceId, l])), consumers, parentId };
}
