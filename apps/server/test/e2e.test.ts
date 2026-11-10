import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectRecorder, type Recording } from '@ida/core';
import { resetRecorders } from '../../../packages/core/src/registry';
import { memoryStore } from '../../../packages/cloud/src/spool';
import { createUploader } from '../../../packages/cloud/src/uploader';
import { createApp } from '../src/app';
import { migrate, openPglite, type Db } from '../src/db';

let db: Db;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  app = createApp({ db, verifyUser: async (t) => ({ id: t }), streamSecret: 's' });
}, 30_000);
afterAll(async () => {
  resetRecorders();
  await db.close();
});

describe('SDK to server', () => {
  it('uploads through an outage and serves a complete recording with the spooled part marked late', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = async (path: string, init?: RequestInit): Promise<any> => (await app.request(path, init)).json();
    const auth = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
    const org = await json('/v1/orgs', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Acme' }) });
    const project = await json(`/v1/orgs/${org.id}/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'e2e' }) });
    const { key } = await json(`/v1/projects/${project.id}/keys`, { method: 'POST', headers: auth, body: '{}' });

    let down = false;
    const fetchToApp = (async (url: string, init: RequestInit) => {
      if (down) throw new TypeError('fetch failed');
      return app.request(new URL(url).pathname, init);
    }) as typeof fetch;
    const uploader = createUploader({ projectKey: key, endpoint: 'http://server', fetch: fetchToApp, spool: memoryStore(), quiet: true, flushMs: 60_000 }, () => null, 'e2e');

    const rec = connectRecorder('checkout');
    const h = function onCheckout() {};
    const fire = () => rec.dispatch({ emitter: rec, eventName: 'checkout', handlers: [h], payload: 1 }, (inv) => inv(h, h));

    fire();
    await uploader.flush();
    down = true;
    fire();
    await uploader.flush();
    expect(uploader.status.state).toBe('offline');
    down = false;
    await new Promise((r) => setTimeout(r, 1_100)); // the uploader's first backoff
    expect(uploader.status).toEqual({ state: 'recovered', uploaded: 1 });
    await uploader.close();

    const [session] = await json(`/v1/projects/${project.id}/recorders/checkout/sessions`, { headers: auth });
    expect(session).toMatchObject({ occurrences: 2, late: 1, runtime: 'e2e' });
    const recording = (await json(`/v1/sessions/${session.id}/recording`, { headers: auth })) as Recording;
    expect(recording.occurrences.map((o) => !!o.late)).toEqual([false, true]);
    expect(recording.nodes.map((n) => n.label)).toContain('onCheckout');
  }, 15_000);
});
