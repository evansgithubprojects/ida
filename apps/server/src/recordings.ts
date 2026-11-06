import { RECORDING_VERSION, type Finding, type GraphNode, type Occurrence, type Process, type Recording, type Template } from '@eda-debugger/core';
import type { Db } from './db';

/** A stored session as a `Recording` the viewer can open, or null when there is no such session. */
export async function sessionRecording(db: Pick<Db, 'query'>, sessionId: string): Promise<Recording | null> {
  const [session] = await db.query<{ started_at: number }>('select started_at from sessions where id = $1', [sessionId]);
  if (!session) return null;
  const data = <T>(table: string) => db.query<{ data: T }>(`select data from ${table} where session_id = $1 order by id`, [sessionId]).then((rows) => rows.map((r) => r.data));
  const [processes, nodes, templates, findings, occurrences, gaps] = await Promise.all([
    data<Process>('session_processes'),
    data<GraphNode>('session_nodes'),
    data<Template>('session_templates'),
    data<Finding>('findings'),
    db.query<{ data: Occurrence; late: boolean }>('select data, late from occurrences where session_id = $1 order by ts, id', [sessionId]),
    db.query<{ from_ts: number; to_ts: number; dropped: number }>('select from_ts, to_ts, dropped from session_gaps where session_id = $1 order by from_ts', [sessionId]),
  ]);
  return {
    version: RECORDING_VERSION,
    startedAt: session.started_at,
    processes,
    nodes,
    templates,
    occurrences: occurrences.map((o) => (o.late ? { ...o.data, late: true } : o.data)),
    findings,
    ...(gaps.length && { gaps: gaps.map((g) => ({ fromTs: g.from_ts, toTs: g.to_ts, dropped: g.dropped })) }),
  };
}
