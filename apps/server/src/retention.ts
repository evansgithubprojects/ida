import type { Db } from './db';

/**
 * Deletes recorded data older than `before` (epoch ms): whole sessions not heard from since then, and, in sessions
 * still running, their older events. Projects, keys and recorders are kept. Runs on the embedded dev database (see
 * `startRetention`), which otherwise grows for as long as the demo app keeps uploading.
 */
export async function prune(db: Db, before: number): Promise<{ sessions: number; occurrences: number }> {
  const cutoff = new Date(before).toISOString();
  // Deleting a session takes everything recorded in it with it (on delete cascade).
  const [sessions] = await db.query<{ n: number }>(
    'with d as (delete from sessions where last_seen_at < $1 returning 1) select count(*)::int as n from d', [cutoff]);
  const [occurrences] = await db.query<{ n: number }>(
    'with d as (delete from occurrences where wall_ts < $1 returning 1) select count(*)::int as n from d', [before]);
  if (occurrences!.n) {
    await db.query(
      `delete from occurrence_links l where not exists
         (select 1 from occurrences o where o.session_id = l.child_session and o.id = l.child_id)`);
  }
  // Batch numbers only matter while an SDK might still resend that batch from its spool.
  await db.query('delete from ingest_batches where received_at < $1', [cutoff]);
  return { sessions: sessions!.n, occurrences: occurrences!.n };
}

/**
 * Prunes now and then every hour, keeping `hours` of data. A plain VACUUM after each prune lets the freed space be
 * reused, so the files stop growing (they don't shrink: that takes a VACUUM FULL, which locks the tables).
 */
export function startRetention(db: Db, hours: number, log: (line: string) => void = console.log): () => void {
  const run = async () => {
    try {
      const { sessions, occurrences } = await prune(db, Date.now() - hours * 3_600_000);
      if (sessions || occurrences) {
        await db.query('vacuum');
        log(`[server] retention: deleted ${sessions} session${sessions === 1 ? '' : 's'} and ${occurrences} event${occurrences === 1 ? '' : 's'} older than ${hours} h`);
      }
    } catch (err) {
      log(`[server] retention failed: ${(err as Error).message}`);
    }
  };
  void run();
  const timer = setInterval(run, 3_600_000);
  timer.unref();
  return () => clearInterval(timer);
}
