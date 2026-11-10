import type { IngestBatch, Occurrence, RecorderMessage } from '@ida-dev/core';
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
  if (typeof b.startedAt !== 'number' || !Number.isFinite(b.startedAt)) return 'startedAt must be epoch milliseconds';
  if (!Number.isInteger(b.seq) || b.seq! < 0) return 'seq must be a non-negative integer';
  if (!Array.isArray(b.messages)) return 'messages must be an array';
  for (const m of b.messages) {
    if (!m || typeof m !== 'object' || !MESSAGE_TYPES.has((m as RecorderMessage).type)) return 'every message needs a known type';
  }
  if (b.gap && !(typeof b.gap.fromTs === 'number' && typeof b.gap.toTs === 'number' && Number.isInteger(b.gap.dropped))) return 'gap is malformed';
  if (b.runtime !== undefined && typeof b.runtime !== 'string') return 'runtime must be a string';
  return b as IngestBatch;
}

export class SessionConflict extends Error {}

export interface Ingested {
  recorderId: string;
  /** False when this `seq` was already stored: nothing was written again. */
  stored: boolean;
}

/** Stores one batch for `projectId`. Safe to repeat: a `(sessionId, seq)` already seen changes nothing. */
export async function ingest(db: Db, projectId: string, batch: IngestBatch): Promise<Ingested> {
  return db.transaction(async (tx) => {
    const [rec] = await tx.query<{ id: string }>(
      `insert into recorders (project_id, key) values ($1, $2)
       on conflict (project_id, key) do update set last_seen_at = now() returning id`,
      [projectId, batch.recorderKey],
    );
    const recorderId = rec!.id;
    const [session] = await tx.query<{ recorder_id: string }>(
      `insert into sessions (id, recorder_id, started_at, runtime) values ($1, $2, $3, $4)
       on conflict (id) do update set last_seen_at = now() returning recorder_id`,
      [batch.sessionId, recorderId, batch.startedAt, batch.runtime ?? ''],
    );
    // A session id is chosen by the SDK, so make sure nobody can write into another recorder's (or project's) session.
    if (session!.recorder_id !== recorderId) throw new SessionConflict('sessionId belongs to another recorder');

    const fresh = await tx.query('insert into ingest_batches (session_id, seq) values ($1, $2) on conflict do nothing returning seq', [batch.sessionId, batch.seq]);
    if (!fresh.length) return { recorderId, stored: false };

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
      await tx.query(
        `insert into occurrences (session_id, id, ts, data, late)
         select $1, x->>'id', (x->>'ts')::float8, x, $3 from jsonb_array_elements($2::jsonb) as t(x)
         on conflict (session_id, id) do nothing`,
        [sid, JSON.stringify(occurrences), !!batch.spooled],
      );
    }
    if (batch.gap) {
      await tx.query('insert into session_gaps (session_id, from_ts, to_ts, dropped) values ($1, $2, $3, $4)', [sid, batch.gap.fromTs, batch.gap.toTs, batch.gap.dropped]);
    }
    return { recorderId, stored: true };
  });
}
