import { RECORDING_VERSION, type Recording } from '@eda-debugger/core';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { User, VerifyUser } from './auth';
import type { Db } from './db';
import { ingest, parseBatch, SessionConflict } from './ingest';
import { newIngestKey, parseIngestKey, sameHash, signStreamToken, verifyStreamToken } from './keys';
import { LiveHub } from './live';
import { sessionRecording } from './recordings';

export interface AppOptions {
  db: Db;
  verifyUser: VerifyUser;
  /** Signs live-stream tokens. Any long random string; keep it secret. */
  streamSecret: string;
  /** Web-app origins allowed to call the user API. Ingest accepts any origin: browser apps upload too. */
  webOrigins?: string[];
  hub?: LiveHub;
  /** Largest accepted ingest body, in bytes. @default 2 MiB */
  maxBatchBytes?: number;
  /** Ingest requests allowed per key per minute. @default 600 */
  ingestPerMinute?: number;
  /** For tests. */
  now?: () => number;
}

type Env = { Variables: { user: User } };

/** A recorder counts as live when it sent something this recently. */
const LIVE_MS = 30_000;

export function createApp(opts: AppOptions) {
  const { db, verifyUser, streamSecret } = opts;
  const hub = opts.hub ?? new LiveHub();
  const now = opts.now ?? Date.now;
  const app = new Hono<Env>();

  // --- Ingest (SDK, authenticated by project key) ---

  const windows = new Map<string, { start: number; n: number }>();
  const limited = (prefix: string) => {
    const t = now();
    const w = windows.get(prefix);
    if (!w || t - w.start >= 60_000) {
      windows.set(prefix, { start: t, n: 1 });
      return false;
    }
    return ++w.n > (opts.ingestPerMinute ?? 600);
  };

  const maxBatchBytes = opts.maxBatchBytes ?? 2 * 1024 * 1024;
  const tooLarge = (c: Context) => c.json({ error: 'batch too large' }, 413);
  app.use('/v1/ingest', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['POST'] }));
  app.post(
    '/v1/ingest',
    async (c, next) => {
      const declared = Number(c.req.header('Content-Length') ?? NaN);
      if (!(declared > maxBatchBytes)) return next();
      // Answering before the body is read lets the connection close under a client still sending, which it sees as
      // a network error (and an uploader would retry forever). Read and discard the body first, within reason.
      if (declared <= 8 * maxBatchBytes) await c.req.raw.body?.pipeTo(new WritableStream()).catch(() => {});
      return tooLarge(c);
    },
    bodyLimit({ maxSize: maxBatchBytes, onError: tooLarge }), // bodies without a Content-Length
    async (c) => {
      const presented = parseIngestKey(bearer(c) ?? '');
      if (!presented) return c.json({ error: 'missing or malformed project key' }, 401);
      const [key] = await db.query<{ id: string; project_id: string; key_hash: string }>(
        'select id, project_id, key_hash from project_keys where prefix = $1 and revoked_at is null',
        [presented.prefix],
      );
      if (!key || !sameHash(key.key_hash, presented.hash)) return c.json({ error: 'unknown or revoked project key' }, 401);
      if (limited(presented.prefix)) return c.json({ error: 'too many requests' }, 429);

      const batch = parseBatch(await c.req.json().catch(() => null));
      if (typeof batch === 'string') return c.json({ error: batch }, 400);
      try {
        const { recorderId, stored } = await ingest(db, key.project_id, batch);
        void db.query('update project_keys set last_used_at = now() where id = $1', [key.id]);
        if (stored) hub.publish(recorderId, { sessionId: batch.sessionId, messages: batch.messages });
        return c.json({ ok: true, duplicate: !stored });
      } catch (err) {
        if (err instanceof SessionConflict) return c.json({ error: err.message }, 409);
        throw err;
      }
    },
  );

  // --- Live stream (web app, authenticated by a short-lived stream token) ---

  // The viewer opens this with EventSource from the web app's origin, so the browser needs CORS headers on the stream itself.
  app.use('/v1/live', cors({ origin: opts.webOrigins ?? [], allowMethods: ['GET'] }));
  app.get('/v1/live', async (c) => {
    const recorderId = verifyStreamToken(streamSecret, c.req.query('token') ?? '', now());
    if (!recorderId) return c.json({ error: 'invalid or expired stream token' }, 401);
    return streamSSE(c, async (stream) => {
      let current: string | null = null;
      const snapshot = async (sessionId: string | null) => {
        const recording = sessionId ? await sessionRecording(db, sessionId) : null;
        current = sessionId;
        await stream.writeSSE({ data: JSON.stringify({ type: 'snapshot', recording: recording ?? emptyRecording(now()) }) });
      };
      // Live batches queue up while a snapshot is being read, so none slip between the two.
      let chain: Promise<void> = snapshot(await latestSession(db, recorderId));
      const stop = hub.watch(recorderId, (b) => {
        chain = chain.then(async () => {
          // A new run of the app: its timestamps start over, so the viewer starts from that session's snapshot.
          if (b.sessionId !== current) return snapshot(b.sessionId);
          for (const m of b.messages) await stream.writeSSE({ data: JSON.stringify(m) });
        });
      });
      const ping = setInterval(() => { chain = chain.then(() => stream.writeSSE({ event: 'ping', data: '' })); }, 25_000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      stop();
    });
  });

  // --- Web-app API (authenticated by the Supabase user's access token) ---

  app.use('/v1/projects/*', cors({ origin: opts.webOrigins ?? [], allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST', 'PATCH', 'DELETE'] }));
  app.use('/v1/projects', cors({ origin: opts.webOrigins ?? [], allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST'] }));
  app.use('/v1/sessions/*', cors({ origin: opts.webOrigins ?? [], allowHeaders: ['Authorization'], allowMethods: ['GET'] }));
  const authed = async (c: Context<Env>, next: () => Promise<void>) => {
    const user = await verifyUser(bearer(c) ?? '');
    if (!user) return c.json({ error: 'sign in required' }, 401);
    c.set('user', user);
    await next();
  };
  app.use('/v1/projects', authed);
  app.use('/v1/projects/*', authed);
  app.use('/v1/sessions/*', authed);

  /** The project when the signed-in user owns it. Others get the same 404 as a missing one. */
  const ownProject = async (c: Context<Env>) => {
    const id = c.req.param('projectId');
    if (!id || !UUID.test(id)) return null;
    const [p] = await db.query<ProjectRow>('select id, name, created_at from projects where id = $1 and owner_id = $2', [id, c.get('user').id]);
    return p ?? null;
  };
  const notFound = (c: Context) => c.json({ error: 'not found' }, 404);

  app.get('/v1/projects', async (c) => {
    const rows = await db.query<ProjectRow & { recorders: number; last_seen_at: string | null }>(
      `select p.id, p.name, p.created_at, count(r.id)::int as recorders, max(r.last_seen_at) as last_seen_at
       from projects p left join recorders r on r.project_id = p.id
       where p.owner_id = $1 group by p.id order by p.created_at desc`,
      [c.get('user').id],
    );
    return c.json(rows.map((r) => ({ ...project(r), recorders: r.recorders, lastSeenAt: iso(r.last_seen_at) })));
  });

  app.post('/v1/projects', async (c) => {
    const name = cleanName((await c.req.json().catch(() => ({}))).name);
    if (!name) return c.json({ error: 'name is required (1-100 characters)' }, 400);
    const [p] = await db.query<ProjectRow>('insert into projects (owner_id, name) values ($1, $2) returning id, name, created_at', [c.get('user').id, name]);
    return c.json(project(p!), 201);
  });

  app.get('/v1/projects/:projectId', async (c) => {
    const p = await ownProject(c);
    return p ? c.json(project(p)) : notFound(c);
  });

  app.patch('/v1/projects/:projectId', async (c) => {
    if (!(await ownProject(c))) return notFound(c);
    const name = cleanName((await c.req.json().catch(() => ({}))).name);
    if (!name) return c.json({ error: 'name is required (1-100 characters)' }, 400);
    const [p] = await db.query<ProjectRow>('update projects set name = $2 where id = $1 returning id, name, created_at', [c.req.param('projectId'), name]);
    return c.json(project(p!));
  });

  app.delete('/v1/projects/:projectId', async (c) => {
    if (!(await ownProject(c))) return notFound(c);
    await db.query('delete from projects where id = $1', [c.req.param('projectId')]);
    return c.body(null, 204);
  });

  app.get('/v1/projects/:projectId/keys', async (c) => {
    if (!(await ownProject(c))) return notFound(c);
    const rows = await db.query<{ id: string; prefix: string; label: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>(
      'select id, prefix, label, created_at, last_used_at, revoked_at from project_keys where project_id = $1 order by created_at desc',
      [c.req.param('projectId')],
    );
    return c.json(rows.map((k) => ({ id: k.id, prefix: `eda_${k.prefix}_`, label: k.label, createdAt: iso(k.created_at), lastUsedAt: iso(k.last_used_at), revokedAt: iso(k.revoked_at) })));
  });

  app.post('/v1/projects/:projectId/keys', async (c) => {
    if (!(await ownProject(c))) return notFound(c);
    const label = String((await c.req.json().catch(() => ({}))).label ?? '').trim().slice(0, 100);
    const { key, prefix, hash } = newIngestKey();
    const [row] = await db.query<{ id: string; created_at: string }>(
      'insert into project_keys (project_id, prefix, key_hash, label) values ($1, $2, $3, $4) returning id, created_at',
      [c.req.param('projectId'), prefix, hash, label],
    );
    // The only time the full key is returned.
    return c.json({ id: row!.id, key, prefix: `eda_${prefix}_`, label, createdAt: iso(row!.created_at) }, 201);
  });

  app.delete('/v1/projects/:projectId/keys/:keyId', async (c) => {
    if (!(await ownProject(c))) return notFound(c);
    const keyId = c.req.param('keyId');
    if (!UUID.test(keyId)) return notFound(c);
    const done = await db.query('update project_keys set revoked_at = coalesce(revoked_at, now()) where id = $1 and project_id = $2 returning id', [keyId, c.req.param('projectId')]);
    return done.length ? c.body(null, 204) : notFound(c);
  });

  app.get('/v1/projects/:projectId/recorders', async (c) => {
    if (!(await ownProject(c))) return notFound(c);
    const rows = await db.query<{ id: string; key: string; created_at: string; last_seen_at: string; sessions: number }>(
      `select r.id, r.key, r.created_at, r.last_seen_at, count(s.id)::int as sessions
       from recorders r left join sessions s on s.recorder_id = r.id
       where r.project_id = $1 group by r.id order by r.key`,
      [c.req.param('projectId')],
    );
    return c.json(rows.map((r) => ({
      key: r.key, createdAt: iso(r.created_at), lastSeenAt: iso(r.last_seen_at), sessions: r.sessions,
      live: now() - new Date(r.last_seen_at).getTime() < LIVE_MS,
    })));
  });

  /** The recorder named in the URL, inside a project the user owns. */
  const ownRecorder = async (c: Context<Env>) => {
    if (!(await ownProject(c))) return null;
    const [r] = await db.query<{ id: string }>('select id from recorders where project_id = $1 and key = $2', [c.req.param('projectId'), c.req.param('recorderKey')]);
    return r ?? null;
  };

  app.get('/v1/projects/:projectId/recorders/:recorderKey/sessions', async (c) => {
    const r = await ownRecorder(c);
    if (!r) return notFound(c);
    const rows = await db.query<{ id: string; started_at: number; runtime: string; last_seen_at: string; occurrences: number; late: number; gaps: number }>(
      `select s.id, s.started_at, s.runtime, s.last_seen_at,
         (select count(*)::int from occurrences o where o.session_id = s.id) as occurrences,
         (select count(*)::int from occurrences o where o.session_id = s.id and o.late) as late,
         (select count(*)::int from session_gaps g where g.session_id = s.id) as gaps
       from sessions s where s.recorder_id = $1 order by s.started_at desc limit 200`,
      [r.id],
    );
    return c.json(rows.map((s) => ({
      id: s.id, startedAt: s.started_at, runtime: s.runtime, lastSeenAt: iso(s.last_seen_at),
      occurrences: s.occurrences, late: s.late, gaps: s.gaps, live: now() - new Date(s.last_seen_at).getTime() < LIVE_MS,
    })));
  });

  app.post('/v1/projects/:projectId/recorders/:recorderKey/stream-token', async (c) => {
    const r = await ownRecorder(c);
    if (!r) return notFound(c);
    return c.json({ token: signStreamToken(streamSecret, r.id, 60_000, now()) });
  });

  app.get('/v1/sessions/:sessionId/recording', async (c) => {
    const id = c.req.param('sessionId');
    if (!UUID.test(id)) return notFound(c);
    const [owned] = await db.query(
      `select 1 from sessions s join recorders r on r.id = s.recorder_id join projects p on p.id = r.project_id
       where s.id = $1 and p.owner_id = $2`,
      [id, c.get('user').id],
    );
    if (!owned) return notFound(c);
    return c.json(await sessionRecording(db, id));
  });

  return app;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ProjectRow { id: string; name: string; created_at: string }

const iso = (v: string | Date | null) => (v ? new Date(v).toISOString() : null);
const project = (p: ProjectRow) => ({ id: p.id, name: p.name, createdAt: iso(p.created_at) });
const bearer = (c: Context) => /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1];
const cleanName = (v: unknown) => (typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 100 ? v.trim() : null);

async function latestSession(db: Db, recorderId: string): Promise<string | null> {
  const [s] = await db.query<{ id: string }>('select id from sessions where recorder_id = $1 order by started_at desc limit 1', [recorderId]);
  return s?.id ?? null;
}

const emptyRecording = (startedAt: number): Recording => ({ version: RECORDING_VERSION, startedAt, processes: [], nodes: [], templates: [], occurrences: [] });
