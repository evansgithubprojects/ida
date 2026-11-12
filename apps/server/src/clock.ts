import type { Db } from './db';

/**
 * Which links to check first:
 * - `batch`: links into or out of these occurrences of one session (what a stored batch could have changed)
 * - `sessions`: every link into or out of these sessions (after their clock estimate changed)
 * - `'all'`: every link in the project (backfill)
 */
export type SettleScope = { batch?: { sessionId: string; ids: string[] }; sessions?: string[] } | 'all';

/** Moves carry along chains of services (A to B to C); a few passes settle any chain a real system has. */
const MAX_PASSES = 5;

/**
 * Stores what message links prove about each session's clock. A message can't be consumed before it was published,
 * so when the stored times say it was (the services' clocks disagree by more than their estimates caught), the
 * consuming session is moved later, by the least that puts every message it consumed after its publish. The move is
 * kept in `sessions.clock_shift` and applied to the session's `wall_ts`, so every window and every viewer sees the
 * same timeline, and the session's own events never change order.
 *
 * A session is only ever moved later. Two services that message each other can't both be satisfied when their clocks
 * disagree, so a move is limited by the room the links going back the other way have; otherwise each would keep
 * pushing the other later. What can't be fixed stays visible as skew in the system view.
 *
 * Returns the sessions it moved.
 */
export async function settleClocks(db: Pick<Db, 'query'>, projectId: string, scope: SettleScope): Promise<Set<string>> {
  const moved = new Set<string>();
  let where = scopeClause(scope);
  for (let pass = 0; pass < MAX_PASSES && where; pass++) {
    const gaps = await db.query<{ child: string; gap: number }>(
      `select l.child_session as child, max(p.wall_ts - c.wall_ts)::float8 as gap
       from occurrence_links l
       join occurrences c on c.session_id = l.child_session and c.id = l.child_id
       join occurrences p on p.session_id = l.parent_session and p.id = l.parent_id and p.project_id = l.project_id
       where l.project_id = $1 and l.child_session <> l.parent_session and (${where.sql})
       group by l.child_session
       having max(p.wall_ts - c.wall_ts) > 0`,
      [projectId, ...where.params],
    );
    if (!gaps.length) break;

    // The room each session has before moving it would break a message it sent to a session it also consumes from.
    const room = new Map((await db.query<{ session: string; slack: number }>(
      `select l.parent_session as session, min(c.wall_ts - p.wall_ts)::float8 as slack
       from occurrence_links l
       join occurrences c on c.session_id = l.child_session and c.id = l.child_id
       join occurrences p on p.session_id = l.parent_session and p.id = l.parent_id and p.project_id = l.project_id
       where l.project_id = $1 and l.parent_session = any($2::uuid[]) and l.child_session <> l.parent_session
         and exists (select 1 from occurrence_links r
                     where r.project_id = l.project_id and r.child_session = l.parent_session and r.parent_session = l.child_session)
       group by l.parent_session`,
      [projectId, gaps.map((g) => g.child)],
    )).map((r) => [r.session, Math.max(0, r.slack)]));

    const next: string[] = [];
    for (const { child, gap } of gaps) {
      const by = Math.min(gap, room.get(child) ?? Infinity);
      if (!(by > 0)) continue;
      await db.query('update sessions set clock_shift = clock_shift + $2 where id = $1', [child, by]);
      await db.query('update occurrences set wall_ts = wall_ts + $2 where session_id = $1', [child, by]);
      moved.add(child);
      next.push(child);
    }
    // What the moved sessions published now lands later too, so whoever consumed it may need to move.
    where = next.length ? { sql: 'l.parent_session = any($2::uuid[])', params: [next] } : null;
  }
  return moved;
}

/** Settles every project's sessions: run once when the `clock_shift` column is added, for what is already stored. */
export async function settleAllProjects(db: Pick<Db, 'query' | 'transaction'>): Promise<number> {
  const projects = await db.query<{ project_id: string }>('select distinct project_id from occurrence_links');
  let moved = 0;
  for (const { project_id } of projects) {
    moved += (await db.transaction((tx) => settleClocks(tx, project_id, 'all'))).size;
  }
  return moved;
}

function scopeClause(scope: SettleScope): { sql: string; params: unknown[] } | null {
  if (scope === 'all') return { sql: 'true', params: [] };
  const parts: string[] = [];
  const params: unknown[] = [];
  const param = (v: unknown) => { params.push(v); return `$${params.length + 1}`; };
  if (scope.batch?.ids.length) {
    const sid = param(scope.batch.sessionId), ids = param(scope.batch.ids);
    // A consume in this batch, or a publish in it that someone already consumed (the consumer uploaded first).
    parts.push(`(l.child_session = ${sid}::uuid and l.child_id = any(${ids}::text[]))`);
    parts.push(`(l.parent_session = ${sid}::uuid and l.parent_id = any(${ids}::text[]))`);
  }
  if (scope.sessions?.length) {
    const sids = param(scope.sessions);
    parts.push(`l.child_session = any(${sids}::uuid[])`, `l.parent_session = any(${sids}::uuid[])`);
  }
  return parts.length ? { sql: parts.join(' or '), params } : null;
}
