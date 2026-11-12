import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, openPglite, type Db } from '../src/db';
import { prune } from '../src/retention';

let db: Db;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 10, 12);

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
}, 30_000);
afterAll(() => db.close());

/** A session last heard from `seenAgo` ms before NOW, with one event at each of `eventsAgo`. */
async function session(projectId: string, seenAgo: number, eventsAgo: number[]) {
  const [recorder] = await db.query<{ id: string }>(
    'insert into recorders (id, project_id, key) values ($1, $2, $3) returning id', [randomUUID(), projectId, randomUUID()]);
  const id = randomUUID();
  const startedAt = NOW - 48 * HOUR;
  await db.query('insert into sessions (id, recorder_id, started_at, last_seen_at) values ($1, $2, $3, $4)',
    [id, recorder!.id, startedAt, new Date(NOW - seenAgo).toISOString()]);
  for (const [i, ago] of eventsAgo.entries()) {
    const ts = NOW - ago - startedAt;
    await db.query('insert into occurrences (session_id, id, ts, data, project_id, wall_ts) values ($1, $2, $3, $4, $5, $6)',
      [id, `e${i}`, ts, { id: `e${i}` }, projectId, startedAt + ts]);
    await db.query(`insert into occurrence_links (project_id, child_session, child_id, parent_session, parent_id) values ($1, $2, $3, $4, 'e0')`,
      [projectId, id, `e${i}`, randomUUID()]);
  }
  return id;
}

describe('prune', () => {
  it('deletes old sessions and old events, and keeps the project and recent data', async () => {
    const [org] = await db.query<{ id: string }>(`insert into orgs (name, created_by) values ('Acme', 'u') returning id`);
    const [project] = await db.query<{ id: string }>(`insert into projects (name, org_id) values ('Shop', $1) returning id`, [org!.id]);
    const old = await session(project!.id, 30 * HOUR, [31 * HOUR]);
    const live = await session(project!.id, 0, [40 * HOUR, 25 * HOUR, 2 * HOUR]);

    expect(await prune(db, NOW - 24 * HOUR)).toEqual({ sessions: 1, occurrences: 2 });

    expect(await db.query('select id from sessions where id = $1', [old])).toHaveLength(0);
    expect((await db.query<{ id: string }>('select id from occurrences where session_id = $1', [live])).map((r) => r.id)).toEqual(['e2']);
    expect((await db.query<{ child_id: string }>('select child_id from occurrence_links where child_session = $1', [live])).map((r) => r.child_id)).toEqual(['e2']);
    expect(await db.query('select id from projects where id = $1', [project!.id])).toHaveLength(1);
    expect(await prune(db, NOW - 24 * HOUR)).toEqual({ sessions: 0, occurrences: 0 });
    await db.query('vacuum');
  });
});
