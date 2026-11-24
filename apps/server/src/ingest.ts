import type { IngestBatch, Occurrence, RecorderMessage } from '@ida-dev/core';
import { settleClocks } from './clock';
import type { Db } from './db';

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_TYPES = new Set(['occurrence', 'finding', 'snapshot']);

/** The batch, or why it was rejected. Checks the envelope; message bodies are stored as the SDK sent them. */
export function parseBatch(x: unknown): IngestBatch | string {
  if (!x || typeof x !== 'object') return 'body must be a JSON object';
  const b = x as Partial<IngestBatch>;
  if (typeof b.recorderKey !== 'string' || !KEY.test(b.recorderKey)) return 'recorderKey must be 1-64 letters, digits, ".", "_", ":" or "-"';
  if (typeof b.sessionId !== 'string' || !UUID.test(b.sessionId)) return 'sessionId must be a UUID';
  if (!Number.isSafeInteger(b.startedAt) || b.startedAt! < 0) return 'startedAt must be whole epoch milliseconds';
  if (!Number.isInteger(b.seq) || b.seq! < 0) return 'seq must be a non-negative integer';
  if (!Array.isArray(b.messages)) return 'messages must be an array';
  for (const m of b.messages) {
    if (!m || typeof m !== 'object' || !MESSAGE_TYPES.has((m as RecorderMessage).type)) return 'every message needs a known type';
  }
  if (b.gap && !(typeof b.gap.fromTs === 'number' && typeof b.gap.toTs === 'number' && Number.isInteger(b.gap.dropped))) return 'gap is malformed';
  if (b.runtime !== undefined && typeof b.runtime !== 'string') return 'runtime must be a string';
  if (b.sentAt !== undefined && !(typeof b.sentAt === 'number' && Number.isFinite(b.sentAt))) return 'sentAt must be epoch milliseconds';
  if (b.clock !== undefined && !(b.clock && Number.isFinite(b.clock.offsetMs) && Number.isFinite(b.clock.errorMs) && b.clock.errorMs >= 0)) {
    return 'clock must be { offsetMs: number, errorMs: number >= 0 }';
  }
  if (b.sdk !== undefined && !(b.sdk && (b.sdk.language === 'js' || b.sdk.language === 'python') && typeof b.sdk.version === 'string')) {
    return 'sdk must be { language: "js" | "python", version: string }';
  }
  return b as IngestBatch;
}

export class SessionConflict extends Error {}

/**
 * The error assumed for an offset taken from one request's `sentAt`: its network latency is unknown. Any round-trip
 * estimate from the SDK is better and replaces it.
 */
const ONE_WAY_ERROR_MS = 60_000;
/** A stored estimate this old is replaced by a newer one that disagrees with it, so drift over a long run is followed. */
const CLOCK_STALE_MS = 10 * 60_000;

/** This batch's estimate of the session's clock offset, if it carries one. */
function clockEstimate(batch: IngestBatch, receivedAt: number): { offsetMs: number; errorMs: number } | undefined {
  if (batch.clock) return batch.clock;
  if (batch.sentAt !== undefined && !batch.spooled) return { offsetMs: receivedAt - batch.sentAt, errorMs: ONE_WAY_ERROR_MS };
  return undefined;
}

const OCC_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** The occurrence's `remoteParent`, if it is well formed. Message bodies aren't otherwise checked, so this one is. */
function remoteParentOf(o: Occurrence): { sessionId: string; occurrenceId: string } | undefined {
  const p = (o as { remoteParent?: unknown }).remoteParent as { sessionId?: unknown; occurrenceId?: unknown } | undefined;
  if (!p || typeof p !== 'object' || typeof o.id !== 'string') return undefined;
  if (typeof p.sessionId !== 'string' || !UUID.test(p.sessionId)) return undefined;
  if (typeof p.occurrenceId !== 'string' || !OCC_ID.test(p.occurrenceId)) return undefined;
  return { sessionId: p.sessionId.toLowerCase(), occurrenceId: p.occurrenceId };
}

export interface Ingested {
  recorderId: string;
  /** False when this `seq` was already stored: nothing was written again. */
  stored: boolean;
  /** Some session's stored times moved (a better clock estimate, or a clock shift), so views drawn earlier are off. */
  moved: boolean;
}

/** Stores one batch for `projectId`. Safe to repeat: a `(sessionId, seq)` already seen changes nothing. */
export async function ingest(db: Db, projectId: string, batch: IngestBatch, receivedAt = Date.now()): Promise<Ingested> {
  return db.transaction(async (tx) => {
    const [rec] = await tx.query<{ id: string }>(
      `insert into recorders (project_id, key) values ($1, $2)
       on conflict (project_id, key) do update set last_seen_at = now() returning id`,
      [projectId, batch.recorderKey],
    );
    const recorderId = rec!.id;
    const [session] = await tx.query<{ recorder_id: string; started_at: number; clock_offset: number; clock_shift: number; clock_error: number | null; clock_age_ms: number | null }>(
      `insert into sessions (id, recorder_id, started_at, runtime, sdk) values ($1, $2, $3, $4, $5)
       on conflict (id) do update set last_seen_at = now()
       returning recorder_id, started_at, clock_offset, clock_shift, clock_error, (extract(epoch from now() - clock_at) * 1000)::float8 as clock_age_ms`,
      [batch.sessionId, recorderId, batch.startedAt, batch.runtime ?? '', batch.sdk ? JSON.stringify(batch.sdk) : null],
    );
    // A session id is chosen by the SDK, so make sure nobody can write into another recorder's (or project's) session.
    if (session!.recorder_id !== recorderId) throw new SessionConflict('sessionId belongs to another recorder');

    // Put the session on our clock. A better estimate moves everything the session already stored by the same amount,
    // so its own events never change order. The clock shift was measured against the old estimate, so it starts over
    // and is settled again from the session's links (see `settleClocks`).
    let offset = session!.clock_offset;
    let shift = session!.clock_shift;
    let reset = false;
    const est = clockEstimate(batch, receivedAt);
    if (est) {
      const err = session!.clock_error;
      const better = err === null || est.errorMs < err;
      const drifted = err !== null && (session!.clock_age_ms ?? 0) > CLOCK_STALE_MS && Math.abs(est.offsetMs - offset) > est.errorMs + err;
      if (better || drifted) {
        await tx.query('update sessions set clock_offset = $2, clock_error = $3, clock_shift = 0, clock_at = now() where id = $1', [batch.sessionId, est.offsetMs, est.errorMs]);
        const by = est.offsetMs - offset - shift;
        if (by !== 0) {
          const [u] = await tx.query<{ n: number }>(
            'with u as (update occurrences set wall_ts = wall_ts + $2 where session_id = $1 returning 1) select count(*)::int as n from u',
            [batch.sessionId, by],
          );
          reset = u!.n > 0;
        }
        offset = est.offsetMs;
        shift = 0;
      }
    }

    const fresh = await tx.query('insert into ingest_batches (session_id, seq) values ($1, $2) on conflict do nothing returning seq', [batch.sessionId, batch.seq]);
    if (!fresh.length) {
      if (reset) await settleClocks(tx, projectId, { sessions: [batch.sessionId] });
      return { recorderId, stored: false, moved: reset };
    }

    const processes = [], nodes = [], templates = [], occurrences: Occurrence[] = [], findings = [];
    for (const m of batch.messages) {
      if (m.type === 'occurrence') {
        processes.push(...m.processes);
        nodes.push(...m.nodes);
        templates.push(m.template);
        occurrences.push(m.occurrence);
      } else if (m.type === 'finding') {
        findings.push(m.finding);
      } else {
        processes.push(...m.recording.processes);
        nodes.push(...m.recording.nodes);
        templates.push(...m.recording.templates);
        occurrences.push(...m.recording.occurrences);
        findings.push(...(m.recording.findings ?? []));
      }
    }
    const sid = batch.sessionId;
    // Later copies win: templates gain fields (e.g. `external`) and findings get re-attributed after a throw.
    const upsert = (table: string, rows: { id: string }[]) =>
      rows.length && tx.query(
        `insert into ${table} (session_id, id, data)
         select distinct on (x->>'id') $1, x->>'id', x from jsonb_array_elements($2::jsonb) with ordinality as t(x, n)
         order by x->>'id', n desc
         on conflict (session_id, id) do update set data = excluded.data`,
        [sid, JSON.stringify(rows)],
      );
    await upsert('session_processes', processes);
    await upsert('session_nodes', nodes);
    await upsert('session_templates', templates);
    await upsert('findings', findings);
    if (occurrences.length) {
      // One batch can hold an occurrence twice: sent when its emit returned, then again when its async handlers
      // settled. Keep the later copy; Postgres refuses to update one row twice in a single insert.
      const latest = [...new Map(occurrences.map((o) => [o.id, o])).values()];
      // Wall time comes from the session's stored start and clock offset, so a batch can't move its own events in time.
      // An occurrence sent again is the same one, complete: its async handlers have settled. Batches arrive in order,
      // so the later copy wins. Its time and `late` mark stay as first stored.
      await tx.query(
        `insert into occurrences (session_id, id, ts, data, late, project_id, wall_ts)
         select $1, x->>'id', (x->>'ts')::float8, x, $3, $4, $5::float8 + $6::float8 + (x->>'ts')::float8 from jsonb_array_elements($2::jsonb) as t(x)
         on conflict (session_id, id) do update set data = excluded.data`,
        [sid, JSON.stringify(latest), !!batch.spooled, projectId, session!.started_at, offset + shift],
      );
      const links = latest.flatMap((o) => {
        const p = remoteParentOf(o);
        return p ? [{ child: o.id, parentSession: p.sessionId, parent: p.occurrenceId }] : [];
      });
      if (links.length) {
        await tx.query(
          `insert into occurrence_links (project_id, child_session, child_id, parent_session, parent_id)
           select $1, $2, x->>'child', (x->>'parentSession')::uuid, x->>'parent' from jsonb_array_elements($3::jsonb) as t(x)
           on conflict (child_session, child_id) do nothing`,
          [projectId, sid, JSON.stringify(links)],
        );
      }
    }
    if (batch.gap) {
      await tx.query('insert into session_gaps (session_id, from_ts, to_ts, dropped) values ($1, $2, $3, $4)', [sid, batch.gap.fromTs, batch.gap.toTs, batch.gap.dropped]);
    }
    const ids = occurrences.map((o) => o.id);
    const settled = await settleClocks(tx, projectId, { batch: { sessionId: sid, ids }, ...(reset && { sessions: [sid] }) });
    return { recorderId, stored: true, moved: reset || settled.size > 0 };
  });
}
