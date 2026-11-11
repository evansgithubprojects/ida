import { RECORDING_VERSION, type Recording } from '@ida-dev/core';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { allows, ensureUser, projectAccess, visibleProjects, type Access } from './access';
import type { User, VerifyUser } from './auth';
import type { Db } from './db';
import { ingest, parseBatch, SessionConflict } from './ingest';
import { sessionPeers } from './peers';
import { newIngestKey, parseIngestKey, sameHash, signStreamToken, verifyStreamToken } from './keys';
import { notFound, cleanName, iso, UUID } from './http';
import { rateLimiter } from './limit';
import { LiveHub } from './live';
import { inviteRoutes } from './invites';
import type { Mailer } from './mail';
import { orgRoutes } from './orgs';
import { MAX_RECORDING_OCCURRENCES, sessionRecording, sessionRecordingWindow } from './recordings';
import { systemView } from './system';

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
  /** Who is calling, for the limits on failed sign-ins. Behind a proxy the socket address is the proxy's: pass one that reads its header. */
  clientIp?: (c: Context) => string | undefined;
  /** Failed ingest-key or sign-in attempts allowed per client address per minute, before it is refused outright. @default 30 */
  failuresPerMinute?: number;
  /** Requests one signed-in person can make per minute. @default 300 */
  apiPerMinute?: number;
  /** How often an open live stream re-checks that its viewer still has access, in ms. @default 30000 */
  streamRecheckMs?: number;
  /** Most live streams one person can hold open at once. @default 20 */
  maxStreamsPerUser?: number;
  /** Sends invitation emails. Leave out to only hand the link to the admin who invited. */
  sendMail?: Mailer;
  /** The web app's address, for links in emails. @default the first of `webOrigins` */
  webAppUrl?: string;
  /** For tests. */
  now?: () => number;
}

type Env = { Variables: { user: User } };

/** A recorder counts as live when it sent something this recently. */
const LIVE_MS = 30_000;
/** The system view's window when none is given, and the longest one allowed. */
const SYSTEM_WINDOW_MS = 5 * 60_000;
const SYSTEM_MAX_WINDOW_MS = 24 * 60 * 60_000;
/** Most occurrences one system view returns; matches the SDK's default `maxEvents`. */
const SYSTEM_MAX_OCCURRENCES = 50_000;

export function createApp(opts: AppOptions) {
  const { db, verifyUser, streamSecret } = opts;
  const hub = opts.hub ?? new LiveHub();
  const now = opts.now ?? Date.now;
  const app = new Hono<Env>();
  // Anything unexpected (a database or driver error, say) is logged here and never described to the client: its
  // message can name tables, SQL or infrastructure. Covers the mounted org and invite routes too.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error(`[server] unhandled error on ${c.req.method} ${c.req.path}:`, err);
    return c.json({ error: 'something went wrong on the server' }, 500);
  });

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

  // Failed attempts per client address. Counted only when a key or token is wrong, so honest clients never see it, and
  // checked before the database is touched, so guessing keys can't be used to hammer it.
  const failures = rateLimiter(opts.failuresPerMinute ?? 30, 60_000, now);
  const clientIp = (c: Context): string => {
    if (opts.clientIp) return opts.clientIp(c) ?? 'unknown';
    try { return getConnInfo(c).remote.address ?? 'unknown'; } catch { return 'unknown'; } // no socket, as in tests
  };
  const tooMany = (c: Context) => c.json({ error: 'too many requests' }, 429, { 'Retry-After': '60' });

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
      // Taken first, for the SDK's clock estimate (see `clock` on IngestBatch).
      const receivedAt = now();
      const ip = clientIp(c);
      if (failures.over(ip)) return tooMany(c);
      const presented = parseIngestKey(bearer(c) ?? '');
      if (!presented) { failures.hit(ip); return c.json({ error: 'missing or malformed project key' }, 401); }
      const [key] = await db.query<{ id: string; project_id: string; key_hash: string }>(
        'select id, project_id, key_hash from project_keys where prefix = $1 and revoked_at is null',
        [presented.prefix],
      );
      if (!key || !sameHash(key.key_hash, presented.hash)) { failures.hit(ip); return c.json({ error: 'unknown or revoked project key' }, 401); }
      if (limited(presented.prefix)) return c.json({ error: 'too many requests' }, 429);

      const batch = parseBatch(await c.req.json().catch(() => null));
      if (typeof batch === 'string') return c.json({ error: batch }, 400);
      try {
        const { recorderId, stored } = await ingest(db, key.project_id, batch, receivedAt);
        void db.query('update project_keys set last_used_at = now() where id = $1', [key.id]);
        await db.query('insert into key_recorders (key_id, recorder_id) values ($1, $2) on conflict do nothing', [key.id, recorderId]);
        if (stored) hub.publish(recorderId, { sessionId: batch.sessionId, messages: batch.messages });
        return c.json({ ok: true, duplicate: !stored, receivedAt, repliedAt: now() });
      } catch (err) {
        if (err instanceof SessionConflict) return c.json({ error: err.message }, 409);
        throw err;
      }
    },
  );

  // --- Live stream (web app, authenticated by a short-lived, single-use stream token) ---

  const usedTokens = new Map<string, number>(); // nonce -> expiry, so a token works once
  const claimToken = (nonce: string, expires: number) => {
    const t = now();
    for (const [n, e] of usedTokens) if (e < t) usedTokens.delete(n);
    if (usedTokens.has(nonce)) return false;
    usedTokens.set(nonce, expires);
    return true;
  };
  const openStreams = new Map<string, number>(); // user -> streams currently open
  const maxStreams = opts.maxStreamsPerUser ?? 20;

  // The viewer opens this with EventSource from the web app's origin, so the browser needs CORS headers on the stream itself.
  app.use('/v1/live', cors({ origin: opts.webOrigins ?? [], allowMethods: ['GET'] }));
  app.get('/v1/live', async (c) => {
    const ip = clientIp(c);
    if (failures.over(ip)) return tooMany(c);
    const grant = verifyStreamToken(streamSecret, c.req.query('token') ?? '', now());
    // One use only: a copy of the URL (from a log, say) is useless once the viewer has connected.
    if (!grant || !claimToken(grant.nonce, grant.expires)) { failures.hit(ip); return c.json({ error: 'invalid or expired stream token' }, 401); }
    const { recorderId, projectId, userId } = grant;
    // The token was made for this person; make sure they still have access right now.
    if (!allows(await projectAccess(db, userId, projectId), 'viewer')) return c.json({ error: 'invalid or expired stream token' }, 401);
    if ((openStreams.get(userId) ?? 0) >= maxStreams) return c.json({ error: 'too many open live streams' }, 429);
    openStreams.set(userId, (openStreams.get(userId) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (openStreams.get(userId) ?? 1) - 1;
      if (left > 0) openStreams.set(userId, left); else openStreams.delete(userId);
    };
    return streamSSE(c, async (stream) => {
      stream.onAbort(release); // also covers a client leaving before the first snapshot is sent
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
      let end!: () => void;
      const ended = new Promise<void>((resolve) => { end = resolve; });
      stream.onAbort(end);
      // An open stream keeps checking its viewer: if their access is removed, it ends instead of running on.
      const recheck = setInterval(() => {
        projectAccess(db, userId, projectId).then((a) => { if (!allows(a, 'viewer')) end(); }, () => {});
      }, opts.streamRecheckMs ?? 30_000);
      await ended;
      clearInterval(ping);
      clearInterval(recheck);
      stop();
      release();
    });
  });

  // --- Web-app API (authenticated by the Supabase user's access token) ---

  // Every method a project route answers to must be listed, or the browser's preflight blocks it before it is sent.
  app.use('/v1/projects/*', cors({ origin: opts.webOrigins ?? [], allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }));
  app.use('/v1/projects', cors({ origin: opts.webOrigins ?? [], allowHeaders: ['Authorization'], allowMethods: ['GET'] }));
  app.use('/v1/sessions/*', cors({ origin: opts.webOrigins ?? [], allowHeaders: ['Authorization'], allowMethods: ['GET'], exposeHeaders: ['X-Ida-Truncated'] }));
  const perUser = rateLimiter(opts.apiPerMinute ?? 300, 60_000, now);
  const authed = async (c: Context<Env>, next: () => Promise<void>) => {
    // A path like /v1/projects matches both its own pattern and `/v1/projects/*`; once is enough.
    if (c.get('user')) return next();
    const ip = clientIp(c);
    if (failures.over(ip)) return tooMany(c);
    const user = await verifyUser(bearer(c) ?? '');
    if (!user) { failures.hit(ip); return c.json({ error: 'sign in required' }, 401); }
    // Before anything is written: ensureUser below touches the database.
    if (perUser.hit(user.id)) return tooMany(c);
    c.set('user', user);
    await ensureUser(db, user);
    await next();
  };
  // The user API only takes small JSON bodies (names, roles, a list of grants); refuse anything bigger unread.
  const smallBodies = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'request body too large' }, 413) });
  for (const path of ['/v1/projects', '/v1/projects/*', '/v1/me', '/v1/orgs', '/v1/orgs/*', '/v1/invites', '/v1/invites/*']) app.use(path, smallBodies);
  const userApi = { origin: opts.webOrigins ?? [], allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST', 'PATCH', 'DELETE'] };
  for (const path of ['/v1/me', '/v1/orgs', '/v1/orgs/*', '/v1/invites', '/v1/invites/*']) { app.use(path, cors(userApi)); app.use(path, authed); }
  app.route('/v1', orgRoutes(db));
  app.route('/v1', inviteRoutes({ db, sendMail: opts.sendMail, webAppUrl: opts.webAppUrl ?? opts.webOrigins?.[0] ?? 'http://localhost:5173', now }));
  app.use('/v1/projects', authed);
  app.use('/v1/projects/*', authed);
  app.use('/v1/sessions/*', authed);

  /**
   * The project named in the URL when the signed-in user may do `need` in it. Someone with no access at all gets the
   * same 404 as a missing project; someone who can see it but not do this gets a 403. Returns a response to send otherwise.
   */
  const guard = async (c: Context<Env>, need: Access): Promise<(ProjectRow & { access: Access }) | Response> => {
    const id = c.req.param('projectId');
    if (!id || !UUID.test(id)) return notFound(c);
    const access = await projectAccess(db, c.get('user').id, id);
    if (!access) return notFound(c);
    if (!allows(access, need)) return c.json({ error: 'you do not have permission to do that' }, 403);
    const [p] = await db.query<ProjectRow>('select id, name, created_at, org_id from projects where id = $1', [id]);
    return p ? { ...p, access } : notFound(c);
  };

  app.get('/v1/projects', async (c) => {
    const rows = await visibleProjects(db, c.get('user').id);
    return c.json(rows.map((r) => ({ ...project(r), recorders: r.recorders, lastSeenAt: iso(r.last_seen_at) })));
  });

  app.get('/v1/projects/:projectId', async (c) => {
    const p = await guard(c, 'viewer');
    return p instanceof Response ? p : c.json({ ...project(p), access: p.access });
  });

  app.patch('/v1/projects/:projectId', async (c) => {
    const g = await guard(c, 'editor');
    if (g instanceof Response) return g;
    const name = cleanName((await c.req.json().catch(() => ({}))).name);
    if (!name) return c.json({ error: 'name is required (1-100 characters)' }, 400);
    const [p] = await db.query<ProjectRow>('update projects set name = $2 where id = $1 returning id, name, created_at, org_id', [c.req.param('projectId'), name]);
    return c.json({ ...project(p!), access: g.access });
  });

  app.delete('/v1/projects/:projectId', async (c) => {
    const g = await guard(c, 'admin');
    if (g instanceof Response) return g;
    await db.query('delete from projects where id = $1', [c.req.param('projectId')]);
    return c.body(null, 204);
  });

  // Who can open a project: the org's owners and admins (through their org role) and the members it was granted to.
  app.get('/v1/projects/:projectId/members', async (c) => {
    const g = await guard(c, 'admin');
    if (g instanceof Response) return g;
    const rows = await db.query<{ user_id: string; org_role: string; grant: 'editor' | 'viewer' | null; email: string | null; name: string | null }>(
      `select m.user_id, m.role as org_role, pm.role as grant, u.email, coalesce(m.display_name, u.email, u.name) as name
       from org_members m
       left join project_members pm on pm.project_id = $1 and pm.user_id = m.user_id
       left join users u on u.id = m.user_id
       where m.org_id = $2 and (m.role in ('owner', 'admin') or pm.role is not null)
       order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, lower(coalesce(m.display_name, u.email, u.name, m.user_id))`,
      [g.id, g.org_id],
    );
    return c.json(rows.map((r) => ({
      userId: r.user_id, email: r.email, name: r.name, orgRole: r.org_role,
      access: r.org_role === 'member' ? r.grant : 'admin', via: r.org_role === 'member' ? 'project' : 'org',
    })));
  });

  app.put('/v1/projects/:projectId/members/:userId', async (c) => {
    const g = await guard(c, 'admin');
    if (g instanceof Response) return g;
    const role = (await c.req.json().catch(() => ({}))).role;
    if (role !== 'editor' && role !== 'viewer') return c.json({ error: 'role must be editor or viewer' }, 400);
    const [m] = await db.query<{ role: string }>('select role from org_members where org_id = $1 and user_id = $2', [g.org_id, c.req.param('userId')]);
    if (!m) return c.json({ error: 'only members of the organization can be given access' }, 404);
    if (m.role !== 'member') return c.json({ error: 'owners and admins can already open every project in the organization' }, 400);
    await db.query(
      `insert into project_members (project_id, user_id, role) values ($1, $2, $3)
       on conflict (project_id, user_id) do update set role = excluded.role`,
      [g.id, c.req.param('userId'), role],
    );
    return c.json({ userId: c.req.param('userId'), access: role });
  });

  app.delete('/v1/projects/:projectId/members/:userId', async (c) => {
    const g = await guard(c, 'admin');
    if (g instanceof Response) return g;
    const done = await db.query('delete from project_members where project_id = $1 and user_id = $2 returning user_id', [g.id, c.req.param('userId')]);
    return done.length ? c.body(null, 204) : notFound(c);
  });

  app.get('/v1/projects/:projectId/keys', async (c) => {
    const g = await guard(c, 'editor');
    if (g instanceof Response) return g;
    const rows = await db.query<{ id: string; prefix: string; label: string; created_at: string; last_used_at: string | null; revoked_at: string | null; recorders: string[] }>(
      `select k.id, k.prefix, k.label, k.created_at, k.last_used_at, k.revoked_at,
              coalesce((select array_agg(r.key order by r.key) from key_recorders kr join recorders r on r.id = kr.recorder_id where kr.key_id = k.id), '{}') as recorders
         from project_keys k where k.project_id = $1 order by k.created_at desc`,
      [c.req.param('projectId')],
    );
    return c.json(rows.map((k) => ({ id: k.id, prefix: `ida_${k.prefix}_`, label: k.label, createdAt: iso(k.created_at), lastUsedAt: iso(k.last_used_at), revokedAt: iso(k.revoked_at), recorders: k.recorders })));
  });

  app.post('/v1/projects/:projectId/keys', async (c) => {
    const g = await guard(c, 'editor');
    if (g instanceof Response) return g;
    const label = String((await c.req.json().catch(() => ({}))).label ?? '').trim().slice(0, 100);
    const { key, prefix, hash } = newIngestKey();
    const [row] = await db.query<{ id: string; created_at: string }>(
      'insert into project_keys (project_id, prefix, key_hash, label) values ($1, $2, $3, $4) returning id, created_at',
      [c.req.param('projectId'), prefix, hash, label],
    );
    // The only time the full key is returned.
    return c.json({ id: row!.id, key, prefix: `ida_${prefix}_`, label, createdAt: iso(row!.created_at) }, 201);
  });

  app.delete('/v1/projects/:projectId/keys/:keyId', async (c) => {
    const g = await guard(c, 'editor');
    if (g instanceof Response) return g;
    const keyId = c.req.param('keyId');
    if (!UUID.test(keyId)) return notFound(c);
    const done = await db.query('update project_keys set revoked_at = coalesce(revoked_at, now()) where id = $1 and project_id = $2 returning id', [keyId, c.req.param('projectId')]);
    return done.length ? c.body(null, 204) : notFound(c);
  });

  app.get('/v1/projects/:projectId/recorders', async (c) => {
    const g = await guard(c, 'viewer');
    if (g instanceof Response) return g;
    const rows = await db.query<{ id: string; key: string; created_at: string; last_seen_at: string; sessions: number; processes: string[] }>(
      // The processes are those of the newest session, which is what the live view shows.
      `select r.id, r.key, r.created_at, r.last_seen_at, count(s.id)::int as sessions,
         coalesce((
           select array_agg(distinct p.data->>'label' order by p.data->>'label')
           from session_processes p
           where p.session_id = (select n.id from sessions n where n.recorder_id = r.id order by n.started_at desc limit 1)
         ), '{}') as processes
       from recorders r left join sessions s on s.recorder_id = r.id
       where r.project_id = $1 group by r.id order by r.key`,
      [c.req.param('projectId')],
    );
    return c.json(rows.map((r) => ({
      key: r.key, createdAt: iso(r.created_at), lastSeenAt: iso(r.last_seen_at), sessions: r.sessions, processes: r.processes,
      live: now() - new Date(r.last_seen_at).getTime() < LIVE_MS,
    })));
  });

  /** The recorder named in the URL, inside a project the user can view: its id, or the response to send instead. */
  const ownRecorder = async (c: Context<Env>): Promise<{ id: string } | Response> => {
    const g = await guard(c, 'viewer');
    if (g instanceof Response) return g;
    const [r] = await db.query<{ id: string }>('select id from recorders where project_id = $1 and key = $2', [c.req.param('projectId'), c.req.param('recorderKey')]);
    return r ?? notFound(c);
  };

  app.get('/v1/projects/:projectId/recorders/:recorderKey/sessions', async (c) => {
    const r = await ownRecorder(c);
    if (r instanceof Response) return r;
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
    if (r instanceof Response) return r;
    return c.json({ token: signStreamToken(streamSecret, { recorderId: r.id, projectId: c.req.param('projectId'), userId: c.get('user').id }, 30_000, now()) });
  });

  // Every service's events in one wall-clock window, linked across services. `from` / `to` are epoch ms.
  app.get('/v1/projects/:projectId/system', async (c) => {
    const g = await guard(c, 'viewer');
    if (g instanceof Response) return g;
    const num = (name: string) => {
      const v = c.req.query(name);
      return v === undefined ? undefined : /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
    };
    const to = num('to') ?? now();
    const from = num('from') ?? to - SYSTEM_WINDOW_MS;
    const limit = num('limit') ?? SYSTEM_MAX_OCCURRENCES;
    if (![from, to, limit].every(Number.isFinite) || from > to) return c.json({ error: 'from and to must be epoch milliseconds, from <= to' }, 400);
    if (to - from > SYSTEM_MAX_WINDOW_MS) return c.json({ error: 'the window can be at most 24 hours' }, 400);
    if (!Number.isInteger(limit) || limit < 1 || limit > SYSTEM_MAX_OCCURRENCES) return c.json({ error: `limit must be 1-${SYSTEM_MAX_OCCURRENCES}` }, 400);
    return c.json(await systemView(db, g.id, from, to, limit));
  });

  // The other ends of a session's Kafka / RabbitMQ messages, so a single service's view can draw them.
  app.get('/v1/sessions/:sessionId/peers', async (c) => {
    const id = c.req.param('sessionId');
    if (!UUID.test(id)) return notFound(c);
    const [owner] = await db.query<{ project_id: string }>(
      'select r.project_id from sessions s join recorders r on r.id = s.recorder_id where s.id = $1',
      [id],
    );
    if (!owner || !(await projectAccess(db, c.get('user').id, owner.project_id))) return notFound(c);
    return c.json(await sessionPeers(db, owner.project_id, id));
  });

  // The same for a recorder's newest session: what its live view shows.
  app.get('/v1/projects/:projectId/recorders/:recorderKey/peers', async (c) => {
    const r = await ownRecorder(c);
    if (r instanceof Response) return r;
    const session = await latestSession(db, r.id);
    return c.json(session ? await sessionPeers(db, c.req.param('projectId'), session) : { consumedBy: [], publishedBy: [] });
  });

  app.get('/v1/sessions/:sessionId/recording', async (c) => {
    const id = c.req.param('sessionId');
    if (!UUID.test(id)) return notFound(c);
    const [owner] = await db.query<{ project_id: string }>(
      'select r.project_id from sessions s join recorders r on r.id = s.recorder_id where s.id = $1',
      [id],
    );
    if (!owner || !(await projectAccess(db, c.get('user').id, owner.project_id))) return notFound(c);
    // `from` / `to` pick a window (ms since the session started) and `limit` caps the events; by default everything up
    // to the cap comes back, newest kept. `X-Ida-Truncated: true` says some older events were left out.
    const num = (name: string) => {
      const v = c.req.query(name);
      return v === undefined ? undefined : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
    };
    const [from, to, limit] = [num('from'), num('to'), num('limit')];
    if ([from, to, limit].some((n) => n !== undefined && !Number.isFinite(n)) || (from !== undefined && to !== undefined && from > to)) {
      return c.json({ error: 'from and to must be numbers of milliseconds, from <= to' }, 400);
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECORDING_OCCURRENCES)) {
      return c.json({ error: `limit must be 1-${MAX_RECORDING_OCCURRENCES}` }, 400);
    }
    const page = await sessionRecordingWindow(db, id, { from, to, limit });
    if (!page) return notFound(c);
    return c.json(page.recording, 200, page.truncated ? { 'X-Ida-Truncated': 'true' } : {});
  });

  return app;
}

interface ProjectRow { id: string; name: string; created_at: string; org_id: string }

const project = (p: ProjectRow) => ({ id: p.id, name: p.name, orgId: p.org_id, createdAt: iso(p.created_at) });
const bearer = (c: Context) => /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1];

async function latestSession(db: Db, recorderId: string): Promise<string | null> {
  const [s] = await db.query<{ id: string }>('select id from sessions where recorder_id = $1 order by started_at desc limit 1', [recorderId]);
  return s?.id ?? null;
}

const emptyRecording = (startedAt: number): Recording => ({ version: RECORDING_VERSION, startedAt, processes: [], nodes: [], templates: [], occurrences: [] });
