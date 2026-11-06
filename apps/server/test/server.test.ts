import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRecorder, type IngestBatch, type RecorderMessage, type Recording } from '@eda-debugger/core';
import { createApp } from '../src/app';
import { migrate, openPglite, type Db } from '../src/db';
import { signStreamToken } from '../src/keys';

const SECRET = 'test-secret';
let db: Db;
let app: ReturnType<typeof createApp>;

// Tokens are just user ids here; Supabase verification is covered by `jose`.
const as = (user: string) => ({ Authorization: `Bearer ${user}` });

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  app = createApp({ db, verifyUser: async (t) => (t.startsWith('user-') ? { id: t } : null), streamSecret: SECRET });
}, 30_000);
afterAll(() => db.close());

async function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await app.request(path, { method, headers: { ...headers, ...(body !== undefined && { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function newProject(user = 'user-a') {
  const org = (await call('POST', '/v1/orgs', as(user), { name: 'Acme' })).body.id;
  const p = (await call('POST', `/v1/orgs/${org}/projects`, as(user), { name: 'Shop' })).body;
  const k = (await call('POST', `/v1/projects/${p.id}/keys`, as(user), { label: 'dev' })).body;
  return { project: p, key: k.key as string };
}

/** A real recorder's messages, so the stored format is exactly what the SDK will upload. */
function recorded(): { messages: RecorderMessage[]; startedAt: number } {
  let t = 0;
  const rec = createRecorder({ now: () => (t += 5), deepLogging: { events: ['go'] } });
  const messages: RecorderMessage[] = [];
  rec.subscribe((m) => messages.push(m));
  const bus = {};
  rec.labelEmitter(bus, 'Shop');
  const child = function child() {};
  const root = function root() { rec.dispatch({ emitter: bus, eventName: 'leaf', handlers: [child], payload: { n: 2 } }, (inv) => inv(child, child)); };
  rec.dispatch({ emitter: bus, eventName: 'go', handlers: [root], payload: { n: 1 } }, (inv) => inv(root, root));
  return { messages, startedAt: rec.export().startedAt };
}

const ingest = (key: string, batch: Partial<IngestBatch>) => call('POST', '/v1/ingest', { Authorization: `Bearer ${key}` }, batch);

describe('projects', () => {
  it('lists only the signed-in user’s projects', async () => {
    const { project } = await newProject('user-a');
    await newProject('user-b');
    const mine = (await call('GET', '/v1/projects', as('user-a'))).body as { id: string }[];
    expect(mine.map((p) => p.id)).toContain(project.id);
    const theirs = (await call('GET', '/v1/projects', as('user-b'))).body as { id: string }[];
    expect(theirs.map((p) => p.id)).not.toContain(project.id);
    expect((await call('GET', `/v1/projects/${project.id}`, as('user-b'))).status).toBe(404);
  });

  it('requires a signed-in user', async () => {
    expect((await call('GET', '/v1/projects')).status).toBe(401);
    expect((await call('GET', '/v1/projects', as('nobody'))).status).toBe(401);
  });

  it('shows a key once and only its prefix afterwards', async () => {
    const { project, key } = await newProject();
    const keys = (await call('GET', `/v1/projects/${project.id}/keys`, as('user-a'))).body;
    expect(keys).toHaveLength(1);
    expect(key.startsWith(keys[0].prefix)).toBe(true);
    expect(JSON.stringify(keys)).not.toContain(key);
  });
});

describe('ingest', () => {
  it('stores a batch and serves it back as a recording', async () => {
    const { project, key } = await newProject();
    const { messages, startedAt } = recorded();
    const sessionId = randomUUID();
    expect((await ingest(key, { recorderKey: 'payments', sessionId, startedAt, seq: 0, messages, runtime: 'node' })).body).toEqual({ ok: true, duplicate: false });

    const recorders = (await call('GET', `/v1/projects/${project.id}/recorders`, as('user-a'))).body;
    expect(recorders).toMatchObject([{ key: 'payments', sessions: 1, live: true, processes: expect.any(Array) }]);
    expect(recorders[0].processes.length).toBeGreaterThan(0);
    const sessions = (await call('GET', `/v1/projects/${project.id}/recorders/payments/sessions`, as('user-a'))).body;
    expect(sessions).toMatchObject([{ id: sessionId, startedAt, occurrences: 2, late: 0 }]);

    const rec = (await call('GET', `/v1/sessions/${sessionId}/recording`, as('user-a'))).body as Recording;
    expect(rec.startedAt).toBe(startedAt);
    expect(rec.occurrences.map((o) => o.id)).toEqual(['e1', 'e2']);
    expect(rec.occurrences[1]!.parentId).toBe('e1');
    expect(rec.occurrences[0]!.payload).toEqual({ n: 1 });
    expect(rec.templates).toHaveLength(2);
    expect(rec.nodes.length).toBeGreaterThanOrEqual(3);
    expect((await call('GET', `/v1/sessions/${sessionId}/recording`, as('user-b'))).status).toBe(404);
  });

  it('acknowledges a replayed batch without storing it twice', async () => {
    const { key } = await newProject();
    const { messages, startedAt } = recorded();
    const batch = { recorderKey: 'r', sessionId: randomUUID(), startedAt, seq: 3, messages };
    await ingest(key, batch);
    expect((await ingest(key, { ...batch, spooled: true })).body).toEqual({ ok: true, duplicate: true });
    const rows = await db.query<{ n: number }>('select count(*)::int as n from occurrences where session_id = $1', [batch.sessionId]);
    expect(rows[0]?.n).toBe(2);
  });

  it('marks spooled occurrences late and keeps gaps', async () => {
    const { key } = await newProject();
    const { messages, startedAt } = recorded();
    const sessionId = randomUUID();
    await ingest(key, { recorderKey: 'r', sessionId, startedAt, seq: 0, messages, spooled: true, gap: { fromTs: 1, toTs: 2, dropped: 7 } });
    const rec = (await call('GET', `/v1/sessions/${sessionId}/recording`, as('user-a'))).body as Recording;
    expect(rec.occurrences.every((o) => o.late)).toBe(true);
    expect(rec.gaps).toEqual([{ fromTs: 1, toTs: 2, dropped: 7 }]);
  });

  it('rejects bad keys, revoked keys and malformed batches', async () => {
    const { project, key } = await newProject();
    const ok = { recorderKey: 'r', sessionId: randomUUID(), startedAt: 1, seq: 0, messages: [] };
    expect((await ingest('nope', ok)).status).toBe(401);
    expect((await ingest(key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A'), ok)).status).toBe(401);
    expect((await ingest(key, { ...ok, recorderKey: 'a/b' })).status).toBe(400);
    expect((await ingest(key, { ...ok, sessionId: 'x' })).status).toBe(400);
    expect((await ingest(key, { ...ok, messages: [{ type: 'bogus' } as never] })).status).toBe(400);
    const [k] = (await call('GET', `/v1/projects/${project.id}/keys`, as('user-a'))).body;
    expect((await call('DELETE', `/v1/projects/${project.id}/keys/${k.id}`, as('user-a'))).status).toBe(204);
    expect((await ingest(key, ok)).status).toBe(401);
  });

  it('refuses to write into a session that belongs to another recorder', async () => {
    const a = await newProject();
    const b = await newProject('user-b');
    const sessionId = randomUUID();
    await ingest(a.key, { recorderKey: 'r', sessionId, startedAt: 1, seq: 0, messages: [] });
    expect((await ingest(b.key, { recorderKey: 'r', sessionId, startedAt: 1, seq: 1, messages: [] })).status).toBe(409);
  });

  it('rate-limits a key', async () => {
    let t = 0;
    const limitedApp = createApp({ db, verifyUser: async () => null, streamSecret: SECRET, ingestPerMinute: 2, now: () => t });
    const { key } = await newProject();
    const send = (seq: number) => limitedApp.request('/v1/ingest', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recorderKey: 'r', sessionId: randomUUID(), startedAt: 1, seq, messages: [] }),
    });
    expect((await send(0)).status).toBe(200);
    expect((await send(1)).status).toBe(200);
    expect((await send(2)).status).toBe(429);
    t += 60_000;
    expect((await send(3)).status).toBe(200);
  });
});

describe('live stream', () => {
  it('sends the latest session, then each new batch', async () => {
    const { project, key } = await newProject();
    const { messages, startedAt } = recorded();
    const sessionId = randomUUID();
    await ingest(key, { recorderKey: 'live', sessionId, startedAt, seq: 0, messages: messages.slice(0, 1) });

    const { token } = (await call('POST', `/v1/projects/${project.id}/recorders/live/stream-token`, as('user-a'))).body;
    const controller = new AbortController();
    const res = await app.request(`/v1/live?token=${encodeURIComponent(token)}`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const events: RecorderMessage[] = [];
    let buf = '';
    const next = async () => {
      while (!buf.includes('\n\n')) buf += new TextDecoder().decode((await reader.read()).value);
      const [frame, ...rest] = buf.split('\n\n');
      buf = rest.join('\n\n');
      const data = frame!.split('\n').find((l) => l.startsWith('data: '))!.slice(6);
      events.push(JSON.parse(data));
    };

    await next();
    expect(events[0]).toMatchObject({ type: 'snapshot' });
    expect((events[0] as { recording: Recording }).recording.occurrences).toHaveLength(1);

    await ingest(key, { recorderKey: 'live', sessionId, startedAt, seq: 1, messages: messages.slice(1) });
    await next();
    expect(events[1]).toMatchObject({ type: 'occurrence' });
    controller.abort();
    await reader.cancel().catch(() => {});
  });

  it('rejects forged and expired tokens', async () => {
    expect((await app.request('/v1/live?token=abc.1.def')).status).toBe(401);
    const expired = signStreamToken(SECRET, randomUUID(), -1);
    expect((await app.request(`/v1/live?token=${expired}`)).status).toBe(401);
  });
});

describe('unexpected errors', () => {
  it('are logged on the server and never described to the client', async () => {
    const leak = new Error('relation "secret_table" does not exist');
    const broken: Db = { query: () => Promise.reject(leak), transaction: () => Promise.reject(leak), close: async () => {} };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await createApp({ db: broken, verifyUser: async () => ({ id: 'user-a' }), streamSecret: SECRET }).request('/v1/projects', { headers: as('user-a') });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'something went wrong on the server' });
      expect(text).not.toContain('secret_table');
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});
