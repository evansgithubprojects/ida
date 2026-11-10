import { RECORDING_VERSION, type Finding, type GraphNode, type Occurrence, type Process, type Recording, type Template } from '@ida-dev/core';
import type { Db } from './db';

/** Most occurrences one recording response holds; matches the SDK's default `maxEvents`. */
export const MAX_RECORDING_OCCURRENCES = 50_000;

export interface RecordingWindow {
  /** Occurrence times (ms since the session started) to include: `from <= ts <= to`. */
  from?: number;
  to?: number;
  /** Most occurrences to return. When more fall in the window the oldest are left out. */
  limit?: number;
}

/**
 * A stored session as a `Recording` the viewer can open, or null when there is no such session. Bounded: at most
 * `limit` occurrences (the newest, the way the SDK's ring buffer keeps them), so one huge session can't make a response
 * of unbounded size. `truncated` says whether anything was left out.
 */
export async function sessionRecordingWindow(
  db: Pick<Db, 'query'>, sessionId: string, window: RecordingWindow = {},
): Promise<{ recording: Recording; truncated: boolean } | null> {
  const [session] = await db.query<{ started_at: number }>('select started_at from sessions where id = $1', [sessionId]);
  if (!session) return null;
  const limit = Math.min(window.limit ?? MAX_RECORDING_OCCURRENCES, MAX_RECORDING_OCCURRENCES);
  const data = <T>(table: string) => db.query<{ data: T }>(`select data from ${table} where session_id = $1 order by id`, [sessionId]).then((rows) => rows.map((r) => r.data));
  const [processes, nodes, templates, findings, newest, gaps] = await Promise.all([
    data<Process>('session_processes'),
    data<GraphNode>('session_nodes'),
    data<Template>('session_templates'),
    data<Finding>('findings'),
    db.query<{ data: Occurrence; late: boolean }>(
      `select data, late from occurrences where session_id = $1 and ts >= $2 and ts <= $3 order by ts desc, id desc limit $4`,
      [sessionId, window.from ?? -Infinity, window.to ?? Infinity, limit + 1],
    ),
    db.query<{ from_ts: number; to_ts: number; dropped: number }>('select from_ts, to_ts, dropped from session_gaps where session_id = $1 order by from_ts', [sessionId]),
  ]);
  const truncated = newest.length > limit;
  if (truncated) newest.length = limit;
  const occurrences = newest.reverse();
  return {
    truncated,
    recording: {
      version: RECORDING_VERSION,
      startedAt: session.started_at,
      processes,
      nodes,
      templates,
      occurrences: occurrences.map((o) => (o.late ? { ...o.data, late: true } : o.data)),
      findings,
      ...(gaps.length && { gaps: gaps.map((g) => ({ fromTs: g.from_ts, toTs: g.to_ts, dropped: g.dropped })) }),
    },
  };
}

/** The whole stored session (up to the cap), or null when there is no such session. */
export async function sessionRecording(db: Pick<Db, 'query'>, sessionId: string): Promise<Recording | null> {
  return (await sessionRecordingWindow(db, sessionId))?.recording ?? null;
}
