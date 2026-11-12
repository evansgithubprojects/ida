import {
  RECORDING_VERSION, type Finding, type GraphNode, type Occurrence, type Process, type Recording, type Template,
} from '@ida-dev/core';
import type { Db } from './db';

/** One service (a recorder session) that has events in the window. */
export interface SystemService {
  sessionId: string;
  recorderKey: string;
  runtime: string;
  sdk: { language: 'js' | 'python'; version: string } | null;
  /** Epoch ms. */
  startedAt: number;
  /** Ids (in the merged recording) of the processes this session used, broker processes included. */
  processIds: string[];
  /**
   * How far this session's events were moved later, so that each message it consumed comes after the publish it came
   * from. Stored with the session, so it is the same in every view. Set only when they were moved. See `settleClocks`.
   */
  clockShiftMs?: number;
}

/**
 * A cross-service link, from a consume occurrence to the publish that caused it.
 * - `in-view`: the parent is in this window, and the child's `parentId` points at it
 * - `outside-window`: the parent was recorded, but before `from` (or it was cut by the limit)
 * - `missing`: no such occurrence in this project: the publisher wasn't recorded, or the header named another project
 */
export interface SystemLink {
  /** The consume occurrence, as namespaced in the merged recording. */
  occurrenceId: string;
  parent: { sessionId: string; occurrenceId: string };
  status: 'in-view' | 'outside-window' | 'missing';
  /**
   * Set when the message was consumed before it was published, by the services' clocks, by more than both clocks'
   * measured error: they disagree by at least this many ms. (The consumer's events are moved after it anyway, as far as
   * the links allow; see `settleClocks`.)
   */
  skewMs?: number;
}

/** Every service's events in one wall-clock window, merged into one recording. */
export interface SystemView {
  /** `startedAt` is `from`; occurrence `ts` values are ms after it. */
  recording: Recording;
  services: SystemService[];
  links: SystemLink[];
  from: number;
  to: number;
  /** More than `limit` occurrences fell in the window; the oldest were left out. */
  truncated: boolean;
}

/**
 * Limits `systemView` to one stored batch, for the project's live stream: these occurrences and findings of one
 * session, on the clock (`from`) of the snapshot the stream already sent.
 */
export interface BatchScope {
  sessionId: string;
  occurrenceIds: string[];
  findingIds: string[];
}

const BROKER_KINDS = new Set(['topic', 'exchange', 'queue']);
const isBroker = (p: Process) => !!p.kind && BROKER_KINDS.has(p.kind);

/**
 * Ids are only unique within a session, so everything is namespaced `<sessionId>/<id>`, except broker processes
 * (topics, exchanges, queues), whose ids are already deterministic and are shared by every service that uses them.
 * A broker process's emitter node is shared too, as `<processId>/emitter`, so pathways from several services meet
 * at one topic.
 */
export async function systemView(
  db: Pick<Db, 'query'>, projectId: string, from: number, to: number, limit: number, only?: BatchScope,
): Promise<SystemView> {
  // Newest first, so the limit drops the oldest events, the way the SDK's ring buffer does.
  const rows = only
    ? await db.query<{ session_id: string; data: Occurrence; late: boolean; wall_ts: number }>(
      `select session_id, data, late, wall_ts from occurrences
       where project_id = $1 and session_id = $2 and id = any($3::text[])
       order by wall_ts desc, id`,
      [projectId, only.sessionId, only.occurrenceIds],
    )
    : await db.query<{ session_id: string; data: Occurrence; late: boolean; wall_ts: number }>(
      `select session_id, data, late, wall_ts from occurrences
       where project_id = $1 and wall_ts >= $2 and wall_ts <= $3
       order by wall_ts desc, id limit $4`,
      [projectId, from, to, limit + 1],
    );
  const truncated = rows.length > limit;
  if (truncated) rows.length = limit;
  rows.reverse();

  const sessionIds = only ? [only.sessionId] : [...new Set(rows.map((r) => r.session_id))];
  const empty: SystemView = {
    recording: { version: RECORDING_VERSION, startedAt: from, processes: [], nodes: [], templates: [], occurrences: [] },
    services: [], links: [], from, to, truncated,
  };
  if (!sessionIds.length) return empty;

  const bySession = <T>(table: string) =>
    db.query<{ session_id: string; data: T }>(`select session_id, data from ${table} where session_id = any($1::uuid[]) order by session_id, id`, [sessionIds]);
  const [sessions, processRows, nodeRows, templateRows, findingRows, linkRows, gapRows] = await Promise.all([
    db.query<{ id: string; started_at: number; runtime: string; sdk: SystemService['sdk']; key: string; clock_offset: number; clock_shift: number; clock_error: number | null }>(
      `select s.id, s.started_at, s.runtime, s.sdk, r.key, s.clock_offset::float8 as clock_offset, s.clock_shift::float8 as clock_shift, s.clock_error::float8 as clock_error
       from sessions s join recorders r on r.id = s.recorder_id
       where s.id = any($1::uuid[]) order by s.started_at, s.id`,
      [sessionIds],
    ),
    bySession<Process>('session_processes'),
    bySession<GraphNode>('session_nodes'),
    bySession<Template>('session_templates'),
    bySession<Finding>('findings'),
    // The parent only counts when it is in this project: a header can name any session id.
    db.query<{ child_session: string; child_id: string; parent_session: string; parent_id: string; parent_wall: number | null; parent_shift: number | null }>(
      `select l.child_session, l.child_id, l.parent_session, l.parent_id, p.wall_ts as parent_wall, ps.clock_shift::float8 as parent_shift
       from occurrence_links l
       left join occurrences p on p.session_id = l.parent_session and p.id = l.parent_id and p.project_id = l.project_id
       left join sessions ps on ps.id = p.session_id
       where l.project_id = $1 and l.child_session = any($2::uuid[])`,
      [projectId, sessionIds],
    ),
    db.query<{ session_id: string; from_ts: number; to_ts: number; dropped: number }>(
      'select session_id, from_ts, to_ts, dropped from session_gaps where session_id = any($1::uuid[]) order by from_ts',
      [sessionIds],
    ),
  ]);

  const wallOf = new Map(rows.map((r) => [`${r.session_id}/${r.data.id}`, r.wall_ts]));
  const shiftOf = new Map(sessions.map((s) => [s.id, s.clock_shift]));
  /** Where a session's clock starts on the window's: its start, corrected by its clock offset and shift (see ingest). */
  const startOf = new Map(sessions.map((s) => [s.id, Number(s.started_at) + s.clock_offset + s.clock_shift - from]));
  /** A session-clock timestamp, moved onto the window's clock. */
  const shift = (sid: string, ts: number) => ts + startOf.get(sid)!;
  const ns = (sid: string, id: string) => `${sid}/${id}`;

  // Processes: broker ones shared, the rest per session.
  const processes = new Map<string, Process>();
  const processId = new Map<string, string>(); // `${sid}/${id}` -> merged id
  const usedBy = new Map<string, Set<string>>(); // sid -> merged process ids
  for (const { session_id: sid, data: p } of processRows) {
    const id = isBroker(p) ? p.id : ns(sid, p.id);
    processId.set(ns(sid, p.id), id);
    if (!processes.has(id)) processes.set(id, { ...p, id });
    (usedBy.get(sid) ?? usedBy.set(sid, new Set()).get(sid)!).add(id);
  }
  const mapProcess = (sid: string, id: string) => processId.get(ns(sid, id)) ?? ns(sid, id);
  const sharedProcess = (id: string) => { const p = processes.get(id); return !!p && isBroker(p); };

  // Nodes: a broker process's emitter node is shared; handlers always belong to their service.
  const nodes = new Map<string, GraphNode>();
  const nodeId = new Map<string, string>();
  for (const { session_id: sid, data: n } of nodeRows) {
    const pid = mapProcess(sid, n.processId);
    const id = n.kind === 'emitter' && sharedProcess(pid) ? `${pid}/emitter` : ns(sid, n.id);
    nodeId.set(ns(sid, n.id), id);
    if (!nodes.has(id)) nodes.set(id, { ...n, id, processId: pid });
  }
  const mapNode = (sid: string, id: string) => nodeId.get(ns(sid, id)) ?? ns(sid, id);

  // Only templates and findings the window's occurrences use.
  const inView = new Set(rows.map((r) => ns(r.session_id, r.data.id)));
  const usedTemplates = new Set(rows.map((r) => ns(r.session_id, r.data.templateId)));
  const templates: Template[] = templateRows
    .filter((t) => usedTemplates.has(ns(t.session_id, t.data.id)))
    .map(({ session_id: sid, data: t }) => ({
      ...t, id: ns(sid, t.id), emitterId: mapNode(sid, t.emitterId), handlerIds: t.handlerIds.map((h) => mapNode(sid, h)),
    }));

  const links: SystemLink[] = [];
  const linkOf = new Map<string, { parent: string }>();
  const errorOf = new Map(sessions.map((s) => [s.id, s.clock_error ?? 0]));
  for (const l of linkRows) {
    const child = ns(l.child_session, l.child_id);
    if (!inView.has(child)) continue;
    const parent = ns(l.parent_session, l.parent_id);
    // In a batch, a parent the stream has already sent (anything since `from`) is in view on the other end.
    const shown = inView.has(parent) || (!!only && l.parent_wall !== null && l.parent_wall >= from);
    const status = shown ? 'in-view' : l.parent_wall !== null ? 'outside-window' : 'missing';
    // Skew is how far the clocks disagreed, so it is measured before either session's shift.
    const childWall = wallOf.get(child)! - (shiftOf.get(l.child_session) ?? 0);
    const parentWall = l.parent_wall === null ? null : l.parent_wall - (l.parent_shift ?? 0);
    // An inversion within both clocks' measured error is that error, not disagreement.
    const tolerance = (errorOf.get(l.child_session) ?? 0) + (errorOf.get(l.parent_session) ?? 0);
    const skew = parentWall !== null && parentWall - childWall > tolerance ? parentWall - childWall : 0;
    links.push({
      occurrenceId: child, parent: { sessionId: l.parent_session, occurrenceId: l.parent_id }, status,
      ...(skew > 0 && { skewMs: skew }),
    });
    if (status === 'in-view') linkOf.set(child, { parent });
  }

  const occurrences: Occurrence[] = rows.map(({ session_id: sid, data: o, late, wall_ts }) => {
    const id = ns(sid, o.id);
    const remote = linkOf.get(id);
    return {
      ...o,
      id,
      templateId: ns(sid, o.templateId),
      parentId: remote ? remote.parent : o.parentId === null ? null : ns(sid, o.parentId),
      sourceNodeId: mapNode(sid, o.sourceNodeId),
      ts: wall_ts - from,
      handlerResults: o.handlerResults.map((h) => ({
        ...h,
        handlerId: mapNode(sid, h.handlerId),
        ts: shift(sid, h.ts),
        ...(h.rethrown && { rethrown: { occurrenceId: ns(sid, h.rethrown.occurrenceId), handlerId: mapNode(sid, h.rethrown.handlerId) } }),
      })),
      ...(late && { late: true }),
    };
  });

  const findings: Finding[] = findingRows
    .filter((f) => (only ? only.findingIds.includes(f.data.id) : inView.has(ns(f.session_id, f.data.occurrenceId))))
    .map(({ session_id: sid, data: f }) => ({
      ...f,
      id: ns(sid, f.id),
      occurrenceId: ns(sid, f.occurrenceId),
      ts: shift(sid, f.ts),
      taintSource: f.taintSource && { occurrenceId: ns(sid, f.taintSource.occurrenceId), handlerId: mapNode(sid, f.taintSource.handlerId) },
    }));

  const gaps = (only ? [] : gapRows)
    .map((g) => ({ fromTs: shift(g.session_id, g.from_ts), toTs: shift(g.session_id, g.to_ts), dropped: g.dropped }))
    .filter((g) => g.toTs >= 0 && g.fromTs <= to - from);

  return {
    recording: {
      version: RECORDING_VERSION,
      startedAt: from,
      processes: [...processes.values()],
      nodes: [...nodes.values()],
      templates,
      occurrences,
      findings,
      ...(gaps.length && { gaps }),
    },
    services: sessions.map((s) => ({
      sessionId: s.id, recorderKey: s.key, runtime: s.runtime, sdk: s.sdk ?? null, startedAt: s.started_at,
      processIds: [...(usedBy.get(s.id) ?? [])],
      ...(s.clock_shift > 0 && { clockShiftMs: s.clock_shift }),
    })),
    links,
    from,
    to,
    truncated,
  };
}
