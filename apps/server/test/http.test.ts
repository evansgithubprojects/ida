/**
 * The real server process (src/main.ts) over real HTTP: Supabase-style token verification against a local JWKS,
 * every API route, live streaming, limits, CORS, and data surviving a restart.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectRecorder, type IngestBatch, type Recording } from '@ida/core';
import { resetRecorders } from '../../../packages/core/src/registry';
import { memoryStore } from '../../../packages/cloud/src/spool';
import { createUploader } from '../../../packages/cloud/src/uploader';

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));
const WEB = 'http://localhost:5173';

let issuerServer: Server;
let issuerUrl: string;
let signingKey: CryptoKey;
let otherKey: CryptoKey;
let dataDir: string;
let server: ChildProcess | null = null;
let base: string;

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address() as { port: number };
    s.close(() => resolve(port));
  });
});

/** Starts src/main.ts the way `npm run dev` does, and waits until it listens. */
async function startServer(): Promise<string> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, SUPABASE_URL: issuerUrl, PGLITE_DIR: dataDir, PORT: String(port), WEB_ORIGINS: WEB, STREAM_SECRET: 'http-test-secret', DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = child;
  let out = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 30_000);
    const onData = (d: Buffer) => {
      out += d;
      if (out.includes('listening')) { clearTimeout(timer); resolve(); }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  (child as ChildProcess & { log: () => string }).log = () => out;
  return `http://127.0.0.1:${port}`;
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const s = server;
  await new Promise<void>((resolve) => { s.once('exit', () => resolve()); s.kill('SIGTERM'); });
  server = null;
}

/** An access token shaped like Supabase's. */
function token(sub: string, opts: { key?: CryptoKey; issuer?: string; audience?: string; expiresIn?: string } = {}) {
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: opts.key ? 'other' : 'test-key' })
    .setSubject(sub)
    .setIssuer(opts.issuer ?? `${issuerUrl}/auth/v1`)
    .setAudience(opts.audience ?? 'authenticated')
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(opts.key ?? signingKey);
}

let alice: string;
let bob: string;

async function call(method: string, path: string, auth?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(auth && { Authorization: `Bearer ${auth}` }), ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

beforeAll(async () => {
  ({ privateKey: signingKey } = await generateKeyPair('ES256', { extractable: true }).then(async (kp) => {
    const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };
    issuerServer = createServer((req, res) => {
      if (req.url === '/auth/v1/.well-known/jwks.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: [jwk] }));
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => issuerServer.listen(0, '127.0.0.1', r));
    issuerUrl = `http://127.0.0.1:${(issuerServer.address() as { port: number }).port}`;
    return kp;
  }));
  ({ privateKey: otherKey } = await generateKeyPair('ES256'));
  dataDir = await mkdtemp(join(tmpdir(), 'eda-server-'));
  base = await startServer();
  alice = await token(`alice-${randomUUID()}`);
  bob = await token(`bob-${randomUUID()}`);
}, 60_000);

afterAll(async () => {
  await stopServer();
  await new Promise<void>((r) => issuerServer?.close(() => r()));
  await rm(dataDir, { recursive: true, force: true });
  resetRecorders();
});

/** A new org for `user`, as if they had just signed up. */
async function newOrg(user = alice) {
  return (await call('POST', '/v1/orgs', user, { name: 'Acme' })).body.id as string;
}

async function projectWithKey(user = alice, name = 'Shop') {
  const project = (await call('POST', `/v1/orgs/${await newOrg(user)}/projects`, user, { name })).body;
  const key = (await call('POST', `/v1/projects/${project.id}/keys`, user, { label: 'test' })).body;
  return { project, key: key.key as string, keyId: key.id as string };
}

const batch = (sessionId: string, seq: number, extra: Partial<IngestBatch> = {}): IngestBatch => ({
  recorderKey: 'payments', sessionId, startedAt: 1_700_000_000_000, seq, messages: [], ...extra,
});

describe('signing in (Supabase-style tokens)', () => {
  it('accepts a valid token', async () => {
    expect(await call('GET', '/v1/projects', alice)).toMatchObject({ status: 200, body: [] });
  });

  it.each([
    ['no token', async () => undefined],
    ['garbage', async () => 'not-a-jwt'],
    ['signed by another key', () => token('x', { key: otherKey })],
    ['another issuer', () => token('x', { issuer: 'https://evil.example/auth/v1' })],
    ['another audience', () => token('x', { audience: 'anon' })],
    ['expired', () => token('x', { expiresIn: '-1m' })],
  ])('rejects %s', async (_name, make) => {
    const r = await call('GET', '/v1/projects', await make());
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'sign in required' });
  });
});

describe('projects and keys', () => {
  it('creates, lists, renames and validates projects', async () => {
    const projects = `/v1/orgs/${await newOrg()}/projects`;
    const created = await call('POST', projects, alice, { name: '  Checkout  ' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Checkout' });
    const id = created.body.id;
    expect((await call('GET', '/v1/projects', alice)).body.map((p: { id: string }) => p.id)).toContain(id);
    expect((await call('PATCH', `/v1/projects/${id}`, alice, { name: 'Checkout v2' })).body).toMatchObject({ id, name: 'Checkout v2' });
    expect((await call('GET', `/v1/projects/${id}`, alice)).body.name).toBe('Checkout v2');
    expect((await call('POST', projects, alice, { name: '' })).status).toBe(400);
    expect((await call('POST', projects, alice, { name: 'x'.repeat(101) })).status).toBe(400);
    expect((await call('POST', projects, alice, '{not json', { 'Content-Type': 'application/json' })).status).toBe(400);
    expect((await call('GET', '/v1/projects/not-a-uuid', alice)).status).toBe(404);
  });

  it('shows a new key once, then only its prefix, and revokes it', async () => {
    const { project, key, keyId } = await projectWithKey();
    expect(key).toMatch(/^ida_[0-9a-f]{12}_[A-Za-z0-9_-]{32}$/);
    const list = (await call('GET', `/v1/projects/${project.id}/keys`, alice)).body;
    expect(list).toMatchObject([{ id: keyId, label: 'test', revokedAt: null, lastUsedAt: null }]);
    expect(JSON.stringify(list)).not.toContain(key.slice(-32));
    expect((await call('POST', '/v1/ingest', key, batch(randomUUID(), 0))).status).toBe(200);
    expect((await call('GET', `/v1/projects/${project.id}/keys`, alice)).body[0].lastUsedAt).not.toBeNull();
    expect((await call('DELETE', `/v1/projects/${project.id}/keys/${keyId}`, alice)).status).toBe(204);
    expect((await call('GET', `/v1/projects/${project.id}/keys`, alice)).body[0].revokedAt).not.toBeNull();
    expect((await call('POST', '/v1/ingest', key, batch(randomUUID(), 0)))).toMatchObject({ status: 401, body: { error: 'unknown or revoked project key' } });
    expect((await call('DELETE', `/v1/projects/${project.id}/keys/${randomUUID()}`, alice)).status).toBe(404);
  });

  it('keeps every project, key, recorder and recording private to its owner', async () => {
    const { project, key } = await projectWithKey(alice);
    const sessionId = randomUUID();
    await call('POST', '/v1/ingest', key, batch(sessionId, 0));
    const id = project.id;
    expect((await call('GET', '/v1/projects', bob)).body.map((p: { id: string }) => p.id)).not.toContain(id);
    for (const [method, path] of [
      ['GET', `/v1/projects/${id}`], ['PATCH', `/v1/projects/${id}`], ['DELETE', `/v1/projects/${id}`],
      ['GET', `/v1/projects/${id}/keys`], ['POST', `/v1/projects/${id}/keys`], ['GET', `/v1/projects/${id}/recorders`],
      ['GET', `/v1/projects/${id}/recorders/payments/sessions`], ['POST', `/v1/projects/${id}/recorders/payments/stream-token`],
      ['GET', `/v1/sessions/${sessionId}/recording`],
    ] as const) {
      expect((await call(method, path, bob, method === 'GET' ? undefined : { name: 'mine now' })).status, `${method} ${path}`).toBe(404);
    }
    expect((await call('GET', `/v1/projects/${id}`, alice)).body.name).toBe('Shop');
  });

  it('deleting a project removes its recordings and stops its keys', async () => {
    const { project, key } = await projectWithKey();
    const sessionId = randomUUID();
    await call('POST', '/v1/ingest', key, batch(sessionId, 0));
    expect((await call('DELETE', `/v1/projects/${project.id}`, alice)).status).toBe(204);
    expect((await call('GET', `/v1/projects/${project.id}`, alice)).status).toBe(404);
    expect((await call('GET', `/v1/sessions/${sessionId}/recording`, alice)).status).toBe(404);
    expect((await call('POST', '/v1/ingest', key, batch(sessionId, 1))).status).toBe(401);
  });
});

describe('ingest over HTTP', () => {
  it('takes uploads from the real SDK and serves them back as a recording', async () => {
    const { project, key } = await projectWithKey();
    const uploader = createUploader({ projectKey: key, endpoint: base, spool: memoryStore(), quiet: true, flushMs: 60_000 }, () => null, 'http-test');
    const rec = connectRecorder(`checkout-${randomUUID().slice(0, 8)}`, { deepLogging: { events: ['checkout'] } });
    const bus = {};
    rec.labelEmitter(bus, 'Cart');
    const pay = function startPayment() {};
    for (let i = 0; i < 3; i++) rec.dispatch({ emitter: bus, eventName: 'checkout', handlers: [pay], payload: { total: i } }, (inv) => inv(pay, pay));
    await uploader.flush();
    expect(uploader.status.state).toBe('online');
    await uploader.close();

    const [recorder] = (await call('GET', `/v1/projects/${project.id}/recorders`, alice)).body;
    expect(recorder).toMatchObject({ key: rec.key, sessions: 1, live: true });
    const [session] = (await call('GET', `/v1/projects/${project.id}/recorders/${rec.key}/sessions`, alice)).body;
    expect(session).toMatchObject({ occurrences: 3, late: 0, gaps: 0, runtime: 'http-test', live: true });
    const recording = (await call('GET', `/v1/sessions/${session.id}/recording`, alice)).body as Recording;
    expect(recording.occurrences.map((o) => o.payload)).toEqual([{ total: 0 }, { total: 1 }, { total: 2 }]);
    expect(recording.processes.map((p) => p.label)).toEqual(['Cart']);
    expect(recording.nodes.map((n) => n.label).sort()).toEqual(['Cart', 'startPayment']);
  });

  it('accepts browser uploads from any origin', async () => {
    const r = await fetch(`${base}/v1/ingest`, { method: 'OPTIONS', headers: { Origin: 'https://some-app.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
  });

  it('rejects oversized and malformed batches', async () => {
    const { key } = await projectWithKey();
    const huge = JSON.stringify(batch(randomUUID(), 0, { runtime: 'x'.repeat(2 * 1024 * 1024 + 1) }));
    expect((await call('POST', '/v1/ingest', key, huge))).toMatchObject({ status: 413, body: { error: 'batch too large' } });
    expect((await call('POST', '/v1/ingest', key, '{oops', { 'Content-Type': 'application/json' }))).toMatchObject({ status: 400 });
    expect((await call('POST', '/v1/ingest', key, { ...batch(randomUUID(), 0), seq: -1 })).body.error).toMatch(/seq/);
  });

  it('treats a replayed batch as delivered without storing it again', async () => {
    const { project, key } = await projectWithKey();
    const sessionId = randomUUID();
    const occ = { type: 'occurrence', occurrence: { id: 'e1', templateId: 't1', parentId: null, sourceNodeId: 'n1', ts: 5, durationMs: 0, handlerResults: [], capture: 'template', causality: 'sync' }, template: { id: 't1' }, nodes: [], processes: [] } as never;
    expect((await call('POST', '/v1/ingest', key, batch(sessionId, 0, { messages: [occ] }))).body).toEqual({ ok: true, duplicate: false });
    expect((await call('POST', '/v1/ingest', key, batch(sessionId, 0, { messages: [occ], spooled: true }))).body).toEqual({ ok: true, duplicate: true });
    const [s] = (await call('GET', `/v1/projects/${project.id}/recorders/payments/sessions`, alice)).body;
    expect(s).toMatchObject({ occurrences: 1, late: 0 });
  });
});

describe('web-app CORS', () => {
  it('lets the configured web app call the API and no one else', async () => {
    const pre = (origin: string) => fetch(`${base}/v1/projects`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    expect((await pre(WEB)).headers.get('access-control-allow-origin')).toBe(WEB);
    expect((await pre('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
  });

  // A method missing here is blocked by the browser's preflight, which the web app can only report as "can't reach
  // the server". One request per route family and method the web app sends.
  it.each([
    ['PATCH', '/v1/projects/x'],
    ['DELETE', '/v1/projects/x'],
    ['POST', '/v1/projects/x/keys'],
    ['PUT', '/v1/projects/x/members/u'],
    ['DELETE', '/v1/projects/x/members/u'],
    ['POST', '/v1/orgs'],
    ['PATCH', '/v1/orgs/x/members/u'],
    ['DELETE', '/v1/orgs/x'],
    ['POST', '/v1/invites/accept'],
  ])('allows %s %s from the web app', async (method, path) => {
    const r = await fetch(`${base}${path}`, { method: 'OPTIONS', headers: { Origin: WEB, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'authorization,content-type' } });
    expect(r.headers.get('access-control-allow-methods')?.split(',')).toContain(method);
  });

  it('lets the web app open the live stream from its own origin', async () => {
    // The stream is opened with EventSource, which the browser blocks without these headers; even a rejected token must carry them.
    const get = (origin: string) => fetch(`${base}/v1/live?token=nope`, { headers: { Origin: origin } });
    expect((await get(WEB)).headers.get('access-control-allow-origin')).toBe(WEB);
    expect((await get('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('live stream over HTTP', () => {
  it('streams the newest session, each new batch, and a fresh snapshot when the app restarts', async () => {
    const { project, key } = await projectWithKey();
    const first = randomUUID();
    const occ = (id: string, ts: number) => ({ type: 'occurrence', occurrence: { id, templateId: 't1', parentId: null, sourceNodeId: 'n1', ts, durationMs: 0, handlerResults: [], capture: 'template', causality: 'sync' }, template: { id: 't1' }, nodes: [], processes: [] }) as never;
    await call('POST', '/v1/ingest', key, batch(first, 0, { recorderKey: 'live', messages: [occ('e1', 1)] }));

    const { token: streamToken } = (await call('POST', `/v1/projects/${project.id}/recorders/live/stream-token`, alice)).body;
    const ac = new AbortController();
    const res = await fetch(`${base}/v1/live?token=${encodeURIComponent(streamToken)}`, { signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const next = async (): Promise<any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
      for (;;) {
        const at = buf.indexOf('\n\n');
        if (at >= 0) {
          const frame = buf.slice(0, at);
          buf = buf.slice(at + 2);
          const data = frame.split('\n').find((l) => l.startsWith('data: '));
          if (data && !frame.includes('event: ping')) return JSON.parse(data.slice(6));
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buf += decoder.decode(value, { stream: true });
      }
    };

    const snap = await next();
    expect(snap.type).toBe('snapshot');
    expect(snap.recording.occurrences.map((o: { id: string }) => o.id)).toEqual(['e1']);

    await call('POST', '/v1/ingest', key, batch(first, 1, { recorderKey: 'live', messages: [occ('e2', 2)] }));
    expect(await next()).toMatchObject({ type: 'occurrence', occurrence: { id: 'e2' } });

    // A new run of the app: the stream switches to its session.
    const second = randomUUID();
    await call('POST', '/v1/ingest', key, batch(second, 0, { recorderKey: 'live', startedAt: 1_800_000_000_000, messages: [occ('e1', 1)] }));
    const restarted = await next();
    expect(restarted.type).toBe('snapshot');
    expect(restarted.recording.startedAt).toBe(1_800_000_000_000);

    ac.abort();
    await reader.cancel().catch(() => {});
  });

  it('refuses a stream without a valid token', async () => {
    expect((await fetch(`${base}/v1/live`)).status).toBe(401);
    expect((await fetch(`${base}/v1/live?token=${randomUUID()}.${Date.now() + 60_000}.forged`)).status).toBe(401);
  });
});

describe('restarts', () => {
  it('keeps data and does not re-run migrations', async () => {
    const { project, key } = await projectWithKey(alice, 'Survives restart');
    const sessionId = randomUUID();
    await call('POST', '/v1/ingest', key, batch(sessionId, 0));
    await stopServer();
    base = await startServer();
    expect((server as ChildProcess & { log: () => string }).log()).not.toContain('applied migrations');
    expect((await call('GET', `/v1/projects/${project.id}`, alice)).body.name).toBe('Survives restart');
    expect((await call('POST', '/v1/ingest', key, batch(sessionId, 0))).body).toEqual({ ok: true, duplicate: true });
    expect((await call('POST', '/v1/ingest', key, batch(sessionId, 1))).body).toEqual({ ok: true, duplicate: false });
  }, 60_000);
});
