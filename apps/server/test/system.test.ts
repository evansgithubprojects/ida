import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GraphNode, IngestBatch, Occurrence, Process, RecorderMessage, Template } from '@ida-dev/core';
import { createApp } from '../src/app';
import { settleAllProjects } from '../src/clock';
import { migrate, openPglite, type Db } from '../src/db';
import type { SystemView } from '../src/system';

let db: Db;
let app: ReturnType<typeof createApp>;
const as = (user: string) => ({ Authorization: `Bearer ${user}` });

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  app = createApp({ db, verifyUser: async (t) => (t.startsWith('user-') ? { id: t } : null), streamSecret: 'test-secret' });
}, 30_000);
afterAll(() => db.close());

async function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await app.request(path, { method, headers: { ...headers, ...(body !== undefined && { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const orgs = new Map<string, string>();
async function newProject(user = 'user-a') {
  // One org per person: a new one for every project would run into the cap on organizations a person can create.
  let org = orgs.get(user);
  if (!org) orgs.set(user, (org = (await call('POST', '/v1/orgs', as(user), { name: 'Acme' })).body.id as string));
  const p = (await call('POST', `/v1/orgs/${org}/projects`, as(user), { name: 'Shop' })).body;
  const k = (await call('POST', `/v1/projects/${p.id}/keys`, as(user), { label: 'dev' })).body;
  return { projectId: p.id as string, key: k.key as string };
}

const ingest = (key: string, batch: IngestBatch) => call('POST', '/v1/ingest', { Authorization: `Bearer ${key}` }, batch);
const system = (projectId: string, from: number, to: number, user = 'user-a', extra = '') =>
  call('GET', `/v1/projects/${projectId}/system?from=${from}&to=${to}${extra}`, as(user));

const TOPIC = 'kafka::topic:orders';
const topic: Process = { id: TOPIC, label: 'orders', kind: 'topic', broker: { type: 'kafka' } };
const topicEmitter: GraphNode = { id: 'em1', processId: TOPIC, label: 'orders', kind: 'emitter' };

/** A producer service: its `checkout` handler publishes to the orders topic. */
function producer(ts: number): RecorderMessage[] {
  const service: Process = { id: 'p1', label: 'Checkout' };
  const handler: GraphNode = { id: 'h1', processId: 'p1', label: 'checkout', kind: 'handler' };
  const template: Template = { id: 't1', key: `${TOPIC}|orders||bytes`, emitterId: 'em1', eventName: 'orders', handlerIds: [], payloadShape: 'bytes', sampleCount: 1 };
  const occurrence: Occurrence = {
    id: 'e1', templateId: 't1', parentId: null, sourceNodeId: 'h1', ts, durationMs: 1, handlerResults: [],
    capture: 'template', causality: 'sync', meta: { topic: 'orders', partition: 0 },
  };
  return [{ type: 'occurrence', occurrence, template, nodes: [handler, topicEmitter], processes: [service, topic] }];
}

/** A consumer service: `charge` handles the message, pointing back at the producer's occurrence. */
function consumer(ts: number, parent?: { sessionId: string; occurrenceId: string }): RecorderMessage[] {
  const handler: GraphNode = { id: 'h1', processId: TOPIC, label: 'charge', kind: 'handler' };
  const template: Template = { id: 't1', key: `${TOPIC}|orders|h1|bytes`, emitterId: 'em1', eventName: 'orders', handlerIds: ['h1'], payloadShape: 'bytes', sampleCount: 1 };
  const occurrence: Occurrence = {
    id: 'e1', templateId: 't1', parentId: null, sourceNodeId: 'em1', ts, durationMs: 2,
    handlerResults: [{ handlerId: 'h1', ts, durationMs: 2 }], capture: 'template',
    causality: parent ? 'propagated' : 'sync', ...(parent && { remoteParent: parent }), meta: { topic: 'orders', group: 'payments' },
  };
  return [{ type: 'occurrence', occurrence, template, nodes: [topicEmitter, handler], processes: [topic] }];
}

const batch = (recorderKey: string, sessionId: string, startedAt: number, messages: RecorderMessage[], seq = 0): IngestBatch =>
  ({ recorderKey, sessionId, startedAt, seq, messages });

const T0 = 1_700_000_000_000;

describe('system view', () => {
  it('links a consume in one service to the publish in another', async () => {
    const { projectId, key } = await newProject();
    const a = randomUUID(), b = randomUUID();
    await ingest(key, { ...batch('checkout', a, T0, producer(10)), sdk: { language: 'js', version: '0.1.0' } });
    await ingest(key, { ...batch('payments', b, T0 + 5, consumer(20, { sessionId: a, occurrenceId: 'e1' })), sdk: { language: 'python', version: '0.1.0' } });

    const { status, body } = await system(projectId, T0, T0 + 60_000);
    expect(status).toBe(200);
    const view = body as SystemView;
    expect(view.truncated).toBe(false);
    expect(view.services.map((s) => [s.recorderKey, s.sdk?.language])).toEqual([['checkout', 'js'], ['payments', 'python']]);

    // The topic, and its emitter node, are shared; everything else is per service.
    expect(view.recording.processes.filter((p) => p.id === TOPIC)).toHaveLength(1);
    expect(view.recording.nodes.filter((n) => n.id === `${TOPIC}/emitter`)).toHaveLength(1);
    expect(view.recording.nodes.map((n) => n.id).sort()).toEqual([`${TOPIC}/emitter`, `${a}/h1`, `${b}/h1`].sort());
    expect(view.services.find((s) => s.sessionId === b)!.processIds).toEqual([TOPIC]);

    const [pub, sub] = view.recording.occurrences;
    expect(pub).toMatchObject({ id: `${a}/e1`, ts: 10, sourceNodeId: `${a}/h1`, parentId: null, templateId: `${a}/t1` });
    expect(sub).toMatchObject({
      id: `${b}/e1`, ts: 25, parentId: `${a}/e1`, causality: 'propagated', sourceNodeId: `${TOPIC}/emitter`,
      handlerResults: [{ handlerId: `${b}/h1`, ts: 25 }], meta: { group: 'payments' },
    });
    expect(view.recording.templates.find((t) => t.id === `${b}/t1`)).toMatchObject({ emitterId: `${TOPIC}/emitter`, handlerIds: [`${b}/h1`] });
    expect(view.links).toEqual([{ occurrenceId: `${b}/e1`, parent: { sessionId: a, occurrenceId: 'e1' }, status: 'in-view' }]);
  });

  it('links a parent that arrives after its child', async () => {
    const { projectId, key } = await newProject();
    const a = randomUUID(), b = randomUUID();
    await ingest(key, batch('payments', b, T0, consumer(20, { sessionId: a, occurrenceId: 'e1' })));
    expect((await system(projectId, T0, T0 + 60_000)).body.links[0].status).toBe('missing');

    await ingest(key, batch('checkout', a, T0, producer(10)));
    const view = (await system(projectId, T0, T0 + 60_000)).body as SystemView;
    expect(view.links[0]!.status).toBe('in-view');
    expect(view.recording.occurrences.find((o) => o.id === `${b}/e1`)!.parentId).toBe(`${a}/e1`);
  });

  it('says when the parent is outside the window', async () => {
    const { projectId, key } = await newProject();
    const a = randomUUID(), b = randomUUID();
    await ingest(key, batch('checkout', a, T0, producer(10)));
    await ingest(key, batch('payments', b, T0, consumer(5_000, { sessionId: a, occurrenceId: 'e1' })));
    const view = (await system(projectId, T0 + 1_000, T0 + 60_000)).body as SystemView;
    expect(view.recording.occurrences.map((o) => o.id)).toEqual([`${b}/e1`]);
    expect(view.links[0]!.status).toBe('outside-window');
    expect(view.recording.occurrences[0]!.parentId).toBeNull();
  });

  it('never links to a session in another project', async () => {
    const one = await newProject('user-a');
    const two = await newProject('user-b');
    const a = randomUUID(), b = randomUUID();
    await ingest(one.key, batch('checkout', a, T0, producer(10)));
    await ingest(two.key, batch('payments', b, T0, consumer(20, { sessionId: a, occurrenceId: 'e1' })));

    const view = (await system(two.projectId, T0, T0 + 60_000, 'user-b')).body as SystemView;
    expect(view.recording.occurrences.map((o) => o.id)).toEqual([`${b}/e1`]);
    expect(view.links[0]!.status).toBe('missing');
    expect(view.recording.occurrences[0]!.parentId).toBeNull();
    expect(JSON.stringify(view)).not.toContain('Checkout');
  });

  it('flags clock skew, and draws the consumer after the publish anyway', async () => {
    const { projectId, key } = await newProject();
    const a = randomUUID(), b = randomUUID();
    await ingest(key, batch('checkout', a, T0 + 1_000, producer(10)));
    await ingest(key, batch('payments', b, T0, consumer(400, { sessionId: a, occurrenceId: 'e1' }))); // 610 ms "before" its parent
    const view = (await system(projectId, T0, T0 + 60_000)).body as SystemView;
    expect(view.links[0]).toMatchObject({ status: 'in-view', skewMs: 610 });
    // The whole consuming session moves, its handler timings with it.
    const consumed = view.recording.occurrences.find((o) => o.id === `${b}/e1`)!;
    expect(consumed.ts).toBe(1_010);
    expect(consumed.handlerResults[0]!.ts).toBe(1_010);
    expect(view.services.find((s) => s.sessionId === b)).toMatchObject({ clockShiftMs: 610 });
    expect(view.services.find((s) => s.sessionId === a)!.clockShiftMs).toBeUndefined();
  });

  it('calls an inversion within the clocks’ measured error that error, not skew', async () => {
    const { projectId, key } = await newProject();
    const a = randomUUID(), b = randomUUID();
    await ingest(key, { ...batch('checkout', a, T0, producer(100)), clock: { offsetMs: 0, errorMs: 20 } });
    await ingest(key, { ...batch('payments', b, T0, consumer(70, { sessionId: a, occurrenceId: 'e1' })), clock: { offsetMs: 0, errorMs: 15 } });
    const view = (await system(projectId, T0, T0 + 60_000)).body as SystemView;
    expect(view.links[0]!.skewMs).toBeUndefined();
    expect(view.recording.occurrences.find((o) => o.id === `${b}/e1`)!.ts).toBe(100);
  });

  it('places handler timings with the session’s clock offset, like its events', async () => {
    const { projectId, key } = await newProject();
    const b = randomUUID();
    await ingest(key, { ...batch('payments', b, T0, consumer(50)), clock: { offsetMs: 2_000, errorMs: 5 } });
    const [o] = ((await system(projectId, T0, T0 + 60_000)).body as SystemView).recording.occurrences;
    expect(o!.ts).toBe(2_050);
    expect(o!.handlerResults[0]!.ts).toBe(2_050);
  });

  it('carries a move along a chain of services', async () => {
    const { projectId, key } = await newProject();
    const a = randomUUID(), b = randomUUID(), c = randomUUID();
    await ingest(key, batch('checkout', a, T0 + 500, producer(0)));
    // payments consumes 300 ms "early" by its clock, then publishes; once payments moves, notifier's consume is early too.
    const relay = [...consumer(200, { sessionId: a, occurrenceId: 'e1' }), ...producer(210).map((m) => (m.type === 'occurrence' ? { ...m, occurrence: { ...m.occurrence, id: 'e2', templateId: 't2' }, template: { ...m.template, id: 't2' } } : m))];
    await ingest(key, batch('payments', b, T0, relay));
    await ingest(key, batch('notifier', c, T0, consumer(220, { sessionId: b, occurrenceId: 'e2' })));
    const view = (await system(projectId, T0, T0 + 60_000)).body as SystemView;
    const ts = (sid: string, id: string) => view.recording.occurrences.find((o) => o.id === `${sid}/${id}`)!.ts;
    // Each moves by the least that puts it after its cause.
    expect([ts(a, 'e1'), ts(b, 'e1'), ts(b, 'e2'), ts(c, 'e1')]).toEqual([500, 500, 510, 510]);
  });

  it('stores the move, so every window draws the session at the same time', async () => {
    const { projectId, key } = await newProject();
    const a = randomUUID(), b = randomUUID();
    await ingest(key, batch('checkout', a, T0 + 1_000, producer(10)));
    const after = consumer(450).map((m) => (m.type === 'occurrence' ? { ...m, occurrence: { ...m.occurrence, id: 'e2' } } : m));
    await ingest(key, batch('payments', b, T0, [...consumer(400, { sessionId: a, occurrenceId: 'e1' }), ...after]));
    expect(await db.query('select clock_shift from sessions where id = $1', [b])).toEqual([{ clock_shift: 610 }]);
    // A window with neither end of the link that proved the move: payments' later event is still moved.
    const late = (await system(projectId, T0 + 1_020, T0 + 1_100)).body as SystemView;
    expect(late.recording.occurrences.map((o) => [o.id, o.ts])).toEqual([[`${b}/e2`, 40]]);
    expect(late.recording.occurrences[0]!.handlerResults[0]!.ts).toBe(40);
    expect(late.services).toMatchObject([{ sessionId: b, clockShiftMs: 610 }]);
    // Its uncorrected time is no longer where it is stored.
    expect((await system(projectId, T0 + 300, T0 + 500)).body.recording.occurrences).toEqual([]);
  });

  it('moves the consumer when the publish arrives after it', async () => {
    const { projectId, key } = await newProject();
    const a = randomUUID(), b = randomUUID();
    await ingest(key, batch('payments', b, T0, consumer(400, { sessionId: a, occurrenceId: 'e1' })));
    await ingest(key, batch('checkout', a, T0 + 1_000, producer(10)));
    const view = (await system(projectId, T0, T0 + 60_000)).body as SystemView;
    expect(view.recording.occurrences.find((o) => o.id === `${b}/e1`)!.ts).toBe(1_010);
    expect(view.services.find((s) => s.sessionId === b)).toMatchObject({ clockShiftMs: 610 });
  });

  it('doesn’t let two services that message each other push each other later', async () => {
    const { key } = await newProject();
    const a = randomUUID(), b = randomUUID();
    const named = (m: RecorderMessage[], id: string, tpl: string) =>
      m.map((x) => (x.type === 'occurrence' ? { ...x, occurrence: { ...x.occurrence, id, templateId: tpl }, template: { ...x.template, id: tpl } } : x));
    const shifts = async () => Object.fromEntries((await db.query<{ id: string; clock_shift: number }>(
      'select id, clock_shift from sessions where id = any($1::uuid[])', [[a, b]])).map((r) => [r.id, r.clock_shift]));
    // a consumes b's e2 10 ms after b sent it; then b consumes a's e1 50 ms early by its clock. b can move 10 ms.
    await ingest(key, batch('payments', b, T0, named(producer(60), 'e2', 'tp')));
    await ingest(key, batch('checkout', a, T0, [...named(consumer(70, { sessionId: b, occurrenceId: 'e2' }), 'e2', 'tc'), ...named(producer(100), 'e1', 'tp')]));
    await ingest(key, batch('payments', b, T0, named(consumer(50, { sessionId: a, occurrenceId: 'e1' }), 'e1', 'tc'), 1));
    expect(await shifts()).toEqual({ [a]: 0, [b]: 10 });
    // Another early consume changes nothing: b can't move without breaking a's.
    await ingest(key, batch('checkout', a, T0, named(producer(300), 'e3', 'tp'), 1));
    await ingest(key, batch('payments', b, T0, named(consumer(240, { sessionId: a, occurrenceId: 'e3' }), 'e3', 'tc'), 2));
    expect(await shifts()).toEqual({ [a]: 0, [b]: 10 });
  });

  it('settles the move again when a better clock estimate arrives', async () => {
    const { key } = await newProject();
    const a = randomUUID(), b = randomUUID();
    await ingest(key, batch('checkout', a, T0 + 1_000, producer(10)));
    await ingest(key, batch('payments', b, T0, consumer(400, { sessionId: a, occurrenceId: 'e1' })));
    // The estimate fixes 300 ms of the 610; the move covers the rest, not 610 on top.
    await ingest(key, { ...batch('payments', b, T0, [], 1), clock: { offsetMs: 300, errorMs: 5 } });
    expect(await db.query('select clock_offset, clock_shift from sessions where id = $1', [b])).toEqual([{ clock_offset: 300, clock_shift: 310 }]);
    expect(await db.query('select wall_ts from occurrences where session_id = $1', [b])).toEqual([{ wall_ts: T0 + 1_010 }]);
    // One that fixes all of it needs no move.
    await ingest(key, { ...batch('payments', b, T0, [], 2), clock: { offsetMs: 700, errorMs: 2 } });
    expect(await db.query('select clock_shift from sessions where id = $1', [b])).toEqual([{ clock_shift: 0 }]);
    expect(await db.query('select wall_ts from occurrences where session_id = $1', [b])).toEqual([{ wall_ts: T0 + 1_100 }]);
  });

  it('settles what was stored before moves were', async () => {
    const { projectId, key } = await newProject();
    const a = randomUUID(), b = randomUUID();
    await ingest(key, batch('checkout', a, T0 + 1_000, producer(10)));
    await ingest(key, batch('payments', b, T0, consumer(400, { sessionId: a, occurrenceId: 'e1' })));
    // As it was stored before migration 008.
    await db.query('update sessions set clock_shift = 0 where id = $1', [b]);
    await db.query('update occurrences set wall_ts = $2 where session_id = $1', [b, T0 + 400]);
    expect(await settleAllProjects(db)).toBeGreaterThanOrEqual(1);
    const view = (await system(projectId, T0, T0 + 60_000)).body as SystemView;
    expect(view.recording.occurrences.find((o) => o.id === `${b}/e1`)!.ts).toBe(1_010);
  });

  it('stores one link when a batch is replayed', async () => {
    const { projectId, key } = await newProject();
    const a = randomUUID(), b = randomUUID();
    await ingest(key, batch('checkout', a, T0, producer(10)));
    const sub = batch('payments', b, T0, consumer(20, { sessionId: a, occurrenceId: 'e1' }));
    await ingest(key, sub);
    expect((await ingest(key, { ...sub, spooled: true })).body).toMatchObject({ ok: true, duplicate: true });
    // The same occurrence again under a new seq (a snapshot after reconnecting) still makes one link.
    await ingest(key, { ...sub, seq: 1 });
    expect(await db.query('select 1 from occurrence_links where child_session = $1', [b])).toHaveLength(1);
    expect((await system(projectId, T0, T0 + 60_000)).body.links).toHaveLength(1);
  });

  it('ignores a malformed remoteParent', async () => {
    const { key } = await newProject();
    const b = randomUUID();
    const messages = consumer(20, { sessionId: 'not-a-uuid', occurrenceId: 'e1' });
    expect((await ingest(key, batch('payments', b, T0, messages))).status).toBe(200);
    expect(await db.query('select 1 from occurrence_links where child_session = $1', [b])).toHaveLength(0);
  });

  it('keeps the newest events when the window holds more than the limit', async () => {
    const { projectId, key } = await newProject();
    const a = randomUUID();
    await ingest(key, batch('checkout', a, T0, producer(10)));
    await ingest(key, batch('checkout', a, T0, producer(30).map((m) => m.type === 'occurrence' ? { ...m, occurrence: { ...m.occurrence, id: 'e2', ts: 30 } } : m), 1));
    const view = (await system(projectId, T0, T0 + 60_000, 'user-a', '&limit=1')).body as SystemView;
    expect(view.truncated).toBe(true);
    expect(view.recording.occurrences.map((o) => o.id)).toEqual([`${a}/e2`]);
  });

  it('checks access and parameters', async () => {
    const { projectId } = await newProject('user-a');
    expect((await system(projectId, T0, T0 + 1, 'user-b')).status).toBe(404);
    expect((await system(projectId, T0 + 1, T0)).status).toBe(400);
    expect((await call('GET', `/v1/projects/${projectId}/system?from=abc`, as('user-a'))).status).toBe(400);
    expect((await system(projectId, T0, T0 + 25 * 60 * 60_000)).status).toBe(400);
    expect((await system(projectId, T0, T0 + 1, 'user-a', '&limit=0')).status).toBe(400);
    const empty = (await system(projectId, T0, T0 + 1)).body as SystemView;
    expect(empty).toMatchObject({ services: [], links: [], truncated: false, recording: { occurrences: [] } });
  });
});

describe('migration 007', () => {
  it('fills project and wall time in for occurrences stored before it', async () => {
    const old = await openPglite();
    try {
      await old.query('create table schema_migrations (name text primary key, applied_at timestamptz not null default now())');
      const first = (await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8')).split(/;\s*$/m).map((s) => s.trim()).filter((s) => s.replace(/--.*$/gm, '').trim());
      for (const stmt of first) await old.query(stmt);
      await old.query(`insert into schema_migrations (name) values ('001_init.sql')`);
      const [projectId, sessionId] = [randomUUID(), randomUUID()];
      await old.query('insert into projects (id, owner_id, name) values ($1, $2, $3)', [projectId, 'user-a', 'P']);
      const [r] = await old.query<{ id: string }>(`insert into recorders (project_id, key) values ($1, 'k') returning id`, [projectId]);
      await old.query('insert into sessions (id, recorder_id, started_at) values ($1, $2, $3)', [sessionId, r!.id, T0]);
      await old.query(`insert into occurrences (session_id, id, ts, data) values ($1, 'e1', 12.5, '{}')`, [sessionId]);

      expect(await migrate(old)).toContain('007_links.sql');
      expect(await old.query('select project_id, wall_ts from occurrences')).toEqual([{ project_id: projectId, wall_ts: T0 + 12.5 }]);
    } finally {
      await old.close();
    }
  });
});

describe('clock', () => {
  const wallTs = (sessionId: string) =>
    db.query<{ id: string; wall_ts: number }>('select id, wall_ts from occurrences where session_id = $1 order by id', [sessionId]);

  it('answers each upload with when it was received and answered', async () => {
    const { key } = await newProject();
    const { body } = await ingest(key, batch('checkout', randomUUID(), T0, producer(10)));
    expect(body).toMatchObject({ ok: true, receivedAt: expect.any(Number), repliedAt: expect.any(Number) });
    expect(body.repliedAt).toBeGreaterThanOrEqual(body.receivedAt);
  });

  it('puts services with disagreeing clocks on one timeline', async () => {
    const { projectId, key } = await newProject();
    const a = randomUUID(), b = randomUUID();
    // The producer's clock runs 3 s fast. Uncorrected, its publish would land 2.99 s after the consume it caused.
    await ingest(key, { ...batch('checkout', a, T0 + 3_000, producer(10)), clock: { offsetMs: -3_000, errorMs: 4 } });
    await ingest(key, { ...batch('payments', b, T0, consumer(20, { sessionId: a, occurrenceId: 'e1' })), clock: { offsetMs: 0, errorMs: 4 } });
    const view = (await system(projectId, T0, T0 + 60_000)).body as SystemView;
    expect(view.recording.occurrences.map((o) => [o.id, o.ts])).toEqual([[`${a}/e1`, 10], [`${b}/e1`, 20]]);
    expect(view.links).toEqual([{ occurrenceId: `${b}/e1`, parent: { sessionId: a, occurrenceId: 'e1' }, status: 'in-view' }]);
  });

  it('moves a session’s earlier events together when a better estimate arrives, and ignores worse ones', async () => {
    const { key } = await newProject();
    const a = randomUUID();
    const second = (m: RecorderMessage[], id: string, ts: number) =>
      m.map((x) => (x.type === 'occurrence' ? { ...x, occurrence: { ...x.occurrence, id, ts } } : x));
    await ingest(key, { ...batch('checkout', a, T0, producer(10)), clock: { offsetMs: 100, errorMs: 50 } });
    expect(await wallTs(a)).toEqual([{ id: 'e1', wall_ts: T0 + 110 }]);

    await ingest(key, { ...batch('checkout', a, T0, second(producer(0), 'e2', 20), 1), clock: { offsetMs: 200, errorMs: 5 } });
    expect(await wallTs(a)).toEqual([{ id: 'e1', wall_ts: T0 + 210 }, { id: 'e2', wall_ts: T0 + 220 }]);

    await ingest(key, { ...batch('checkout', a, T0, second(producer(0), 'e3', 30), 2), clock: { offsetMs: 999, errorMs: 50 } });
    expect(await wallTs(a)).toEqual([{ id: 'e1', wall_ts: T0 + 210 }, { id: 'e2', wall_ts: T0 + 220 }, { id: 'e3', wall_ts: T0 + 230 }]);
  });

  it('estimates from a single request until a round trip has been measured', async () => {
    const NOW = T0 + 10_000;
    const fixed = createApp({ db, verifyUser: async (t) => (t.startsWith('user-') ? { id: t } : null), streamSecret: 's', now: () => NOW });
    const { key } = await newProject();
    const a = randomUUID();
    // The SDK's clock reads 2.5 s behind ours when it sends.
    await fixed.request('/v1/ingest', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...batch('checkout', a, T0, producer(10)), sentAt: NOW - 2_500 }),
    });
    expect(await wallTs(a)).toEqual([{ id: 'e1', wall_ts: T0 + 2_510 }]);
    // Any round-trip estimate beats it.
    await ingest(key, { ...batch('checkout', a, T0, [], 1), clock: { offsetMs: 2_480, errorMs: 30 } });
    expect(await wallTs(a)).toEqual([{ id: 'e1', wall_ts: T0 + 2_490 }]);
  });

  it('rejects a malformed clock', async () => {
    const { key } = await newProject();
    const bad = await ingest(key, { ...batch('checkout', randomUUID(), T0, producer(10)), clock: { offsetMs: 1, errorMs: -1 } });
    expect(bad.status).toBe(400);
  });

  it('rejects a start time that is not whole milliseconds, instead of failing to store it', async () => {
    const { key } = await newProject();
    const bad = await ingest(key, batch('checkout', randomUUID(), T0 + 0.5, producer(10)));
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'startedAt must be whole epoch milliseconds' });
  });
});

describe('an occurrence sent again', () => {
  it('replaces the stored one, keeping its time', async () => {
    const { key } = await newProject();
    const a = randomUUID();
    await ingest(key, batch('payments', a, T0, consumer(20)));
    // The same occurrence once its async handler settled: longer, and with the error it rejected with.
    const settled = consumer(20).map((m) => m.type === 'occurrence'
      ? { ...m, occurrence: { ...m.occurrence, durationMs: 80, handlerResults: [{ handlerId: 'h1', ts: 20, durationMs: 80, error: { name: 'Error', message: 'declined' } }] } }
      : m);
    await ingest(key, batch('payments', a, T0, settled, 1));
    const rows = await db.query<{ data: Occurrence; wall_ts: number }>('select data, wall_ts from occurrences where session_id = $1', [a]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.wall_ts).toBe(T0 + 20);
    expect(rows[0]!.data).toMatchObject({ durationMs: 80, handlerResults: [{ error: { message: 'declined' } }] });
  });

  it('keeps the later copy when both are in one batch', async () => {
    const { key } = await newProject();
    const a = randomUUID();
    const settled = consumer(20).filter((m) => m.type === 'occurrence')
      .map((m) => m.type === 'occurrence' ? { ...m, occurrence: { ...m.occurrence, durationMs: 80 } } : m);
    expect(await ingest(key, batch('payments', a, T0, [...consumer(20), ...settled]))).toMatchObject({ status: 200 });
    const rows = await db.query<{ data: Occurrence }>('select data from occurrences where session_id = $1', [a]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toMatchObject({ durationMs: 80 });
  });
});

describe('project live stream', () => {
  const NOW = T0 + 10_000;
  const SPAN = 5 * 60_000;

  /** An app on a fixed clock, so the stream's window (NOW - SPAN to NOW) holds the events above. */
  function fixedApp() {
    const fixed = createApp({ db, verifyUser: async (t) => (t.startsWith('user-') ? { id: t } : null), streamSecret: 's', now: () => NOW });
    const req = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
      const res = await fixed.request(path, { method, headers: { ...headers, ...(body !== undefined && { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    return { fixed, req, ingest: (key: string, b: IngestBatch) => req('POST', '/v1/ingest', { Authorization: `Bearer ${key}` }, b) };
  }

  async function open(fixed: ReturnType<typeof createApp>, token: string) {
    const controller = new AbortController();
    const res = await fixed.request(`/v1/live?token=${encodeURIComponent(token)}&span=${SPAN}`, { signal: controller.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let buf = '';
    const next = async (): Promise<Record<string, unknown>> => {
      while (!buf.includes('\n\n')) buf += new TextDecoder().decode((await reader.read()).value);
      const [frame, ...rest] = buf.split('\n\n');
      buf = rest.join('\n\n');
      return JSON.parse(frame!.split('\n').find((l) => l.startsWith('data: '))!.slice(6));
    };
    const close = async () => { controller.abort(); await reader.cancel().catch(() => {}); };
    return { next, close };
  }

  it('sends a system snapshot, a new one for a new session, then each batch merged onto its clock', async () => {
    const { fixed, req, ingest: send } = fixedApp();
    const { projectId, key } = await newProject();
    const a = randomUUID(), b = randomUUID();
    await send(key, batch('checkout', a, T0, producer(10)));

    const { token } = (await req('POST', `/v1/projects/${projectId}/stream-token`, as('user-a'))).body;
    const stream = await open(fixed, token);
    const first = await stream.next();
    expect(first).toMatchObject({ type: 'system-snapshot', view: { from: NOW - SPAN, services: [{ sessionId: a }] } });

    // A session the snapshot doesn't have: a fresh snapshot with it in.
    await send(key, batch('payments', b, T0 + 5, consumer(20, { sessionId: a, occurrenceId: 'e1' })));
    const second = await stream.next();
    expect(second).toMatchObject({ type: 'system-snapshot' });
    expect((second.view as SystemView).services.map((s) => s.recorderKey).sort()).toEqual(['checkout', 'payments']);

    // A later message on that session: only it, namespaced and timed the way the system view draws it.
    const again = consumer(40, { sessionId: a, occurrenceId: 'e1' }).map((m) => (m.type === 'occurrence' ? { ...m, occurrence: { ...m.occurrence, id: 'e2' } } : m));
    await send(key, batch('payments', b, T0 + 5, again, 1));
    const third = await stream.next();
    expect(third).toMatchObject({ type: 'system-batch' });
    const rec = (third as unknown as SystemView).recording;
    expect(rec.occurrences.map((o) => o.id)).toEqual([`${b}/e2`]);
    expect((third as unknown as SystemView).links).toMatchObject([{ occurrenceId: `${b}/e2`, status: 'in-view' }]);

    const whole = (await req('GET', `/v1/projects/${projectId}/system?from=${NOW - SPAN}&to=${NOW}`, as('user-a'))).body as SystemView;
    expect(rec.occurrences[0]).toEqual(whole.recording.occurrences.find((o) => o.id === `${b}/e2`));
    await stream.close();
  });

  it('sends a fresh snapshot when a batch moves a session’s clock', async () => {
    const { fixed, req, ingest: send } = fixedApp();
    const { projectId, key } = await newProject();
    const a = randomUUID(), b = randomUUID();
    await send(key, batch('checkout', a, T0, producer(10)));
    await send(key, batch('payments', b, T0, consumer(20)));
    const { token } = (await req('POST', `/v1/projects/${projectId}/stream-token`, as('user-a'))).body;
    const stream = await open(fixed, token);
    expect(await stream.next()).toMatchObject({ type: 'system-snapshot' });

    // A consume 5 ms before its publish: payments moves, so everything it already sent is redrawn.
    const early = consumer(5, { sessionId: a, occurrenceId: 'e1' }).map((m) => (m.type === 'occurrence' ? { ...m, occurrence: { ...m.occurrence, id: 'e2' } } : m));
    await send(key, batch('payments', b, T0, early, 1));
    const next = await stream.next();
    expect(next).toMatchObject({ type: 'system-snapshot' });
    const view = next.view as SystemView;
    expect(view.services.find((s) => s.sessionId === b)).toMatchObject({ clockShiftMs: 5 });
    expect(view.recording.occurrences.find((o) => o.id === `${b}/e1`)!.ts).toBe(T0 + 25 - (NOW - SPAN));
    await stream.close();
  });

  it("can't be opened for a project the person can't view", async () => {
    const { req } = fixedApp();
    const { projectId } = await newProject();
    expect((await req('POST', `/v1/projects/${projectId}/stream-token`, as('user-z'))).status).toBe(404);
  });

  it('refuses a bad span without using up the token', async () => {
    const { fixed, req } = fixedApp();
    const { projectId } = await newProject();
    const { token } = (await req('POST', `/v1/projects/${projectId}/stream-token`, as('user-a'))).body;
    expect((await fixed.request(`/v1/live?token=${encodeURIComponent(token)}&span=0`)).status).toBe(400);
    const stream = await open(fixed, token);
    expect(await stream.next()).toMatchObject({ type: 'system-snapshot' });
    await stream.close();
  });
});
