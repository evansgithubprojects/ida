import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { migrate, openPglite, type Db } from '../src/db';

let db: Db;
let app: ReturnType<typeof createApp>;

async function call(method: string, path: string, user: string, body?: unknown) {
  const headers: Record<string, string> = { Authorization: `Bearer ${user}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  app = createApp({ db, verifyUser: async (t) => (t.startsWith('user-') ? { id: t, email: `${t}@example.com`, name: t.slice(5) } : null), streamSecret: 's' });
}, 30_000);
afterAll(() => db.close());

/** An org with an owner, an admin, and three plain members, and one project. */
async function setup() {
  const id = randomUUID().slice(0, 6);
  const u = { owner: `user-own${id}`, admin: `user-adm${id}`, ann: `user-ann${id}`, bob: `user-bob${id}`, eve: `user-eve${id}`, out: `user-out${id}` };
  const org = (await call('POST', '/v1/orgs', u.owner, { name: 'Acme' })).body.id as string;
  for (const [name, role] of [['admin', 'admin'], ['ann', 'member'], ['bob', 'member'], ['eve', 'member']] as const) {
    await call('GET', '/v1/me', u[name]);
    await db.query('insert into org_members (org_id, user_id, role) values ($1, $2, $3)', [org, u[name], role]);
  }
  await call('GET', '/v1/me', u.out);
  const project = (await call('POST', `/v1/orgs/${org}/projects`, u.owner, { name: 'Shop' })).body.id as string;
  return { u, org, project, members: `/v1/projects/${project}/members` };
}

describe('who has access to a project', () => {
  it('lists org owners and admins, plus the members it was granted to', async () => {
    const { u, members } = await setup();
    expect((await call('PUT', `${members}/${u.ann}`, u.owner, { role: 'editor' })).status).toBe(200);
    expect((await call('PUT', `${members}/${u.bob}`, u.admin, { role: 'viewer' })).status).toBe(200);
    const list = (await call('GET', members, u.owner)).body as { userId: string; access: string; via: string; email: string }[];
    expect(list.map((m) => [m.userId, m.access, m.via])).toEqual([
      [u.owner, 'admin', 'org'], [u.admin, 'admin', 'org'], [u.ann, 'editor', 'project'], [u.bob, 'viewer', 'project'],
    ]);
    expect(list[2]!.email).toBe(`${u.ann}@example.com`);
  });

  it('is for owners and admins only, and hides the project from outsiders', async () => {
    const { u, members } = await setup();
    await call('PUT', `${members}/${u.ann}`, u.owner, { role: 'editor' });
    await call('PUT', `${members}/${u.bob}`, u.owner, { role: 'viewer' });
    for (const who of [u.ann, u.bob]) {
      expect((await call('GET', members, who)).status, who).toBe(403);
      expect((await call('PUT', `${members}/${u.eve}`, who, { role: 'viewer' })).status, who).toBe(403);
      expect((await call('DELETE', `${members}/${u.bob}`, who)).status, who).toBe(403);
    }
    expect((await call('GET', members, u.eve)).status).toBe(404);
    expect((await call('GET', members, u.out)).status).toBe(404);
  });

  it('gives a member access right away, changes it, and takes it away', async () => {
    const { u, project, members } = await setup();
    expect((await call('GET', `/v1/projects/${project}`, u.ann)).status).toBe(404);
    await call('PUT', `${members}/${u.ann}`, u.owner, { role: 'viewer' });
    expect((await call('GET', `/v1/projects/${project}`, u.ann)).body.access).toBe('viewer');
    expect((await call('GET', `/v1/projects/${project}/keys`, u.ann)).status).toBe(403);
    await call('PUT', `${members}/${u.ann}`, u.owner, { role: 'editor' });
    expect((await call('GET', `/v1/projects/${project}/keys`, u.ann)).status).toBe(200);
    expect((await call('DELETE', `${members}/${u.ann}`, u.admin)).status).toBe(204);
    expect((await call('DELETE', `${members}/${u.ann}`, u.admin)).status).toBe(404);
    expect((await call('GET', `/v1/projects/${project}`, u.ann)).status).toBe(404);
  });

  it('refuses roles that make no sense and people who are not in the organization', async () => {
    const { u, members } = await setup();
    expect((await call('PUT', `${members}/${u.ann}`, u.owner, { role: 'admin' })).status).toBe(400);
    expect((await call('PUT', `${members}/${u.ann}`, u.owner, {})).status).toBe(400);
    expect((await call('PUT', `${members}/${u.out}`, u.owner, { role: 'viewer' })).status).toBe(404);
    // Owners and admins already see everything, so a grant would only be misleading.
    expect((await call('PUT', `${members}/${u.admin}`, u.owner, { role: 'viewer' })).status).toBe(400);
    expect((await call('PUT', `/v1/projects/${randomUUID()}/members/${u.ann}`, u.owner, { role: 'viewer' })).status).toBe(404);
  });

  it('only counts grants on the project they were made for', async () => {
    const { u, org, project, members } = await setup();
    const other = (await call('POST', `/v1/orgs/${org}/projects`, u.owner, { name: 'Pay' })).body.id as string;
    await call('PUT', `${members}/${u.ann}`, u.owner, { role: 'viewer' });
    expect((await call('GET', `/v1/projects/${other}`, u.ann)).status).toBe(404);
    expect((await call('GET', `/v1/projects/${other}/members`, u.owner)).body.map((m: { userId: string }) => m.userId)).not.toContain(u.ann);
    expect((await call('GET', `/v1/projects/${project}/members`, u.owner)).body.map((m: { userId: string }) => m.userId)).toContain(u.ann);
  });
});
