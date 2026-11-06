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
  app = createApp({ db, verifyUser: async (t) => (t.startsWith('user-') ? { id: t, email: `${t}@example.com`, name: t.slice(5).toUpperCase() } : null), streamSecret: 's' });
}, 30_000);
afterAll(() => db.close());

/** A team org: `owner` creates it, and the other users are added with the given roles. */
async function team(roles: Record<string, 'admin' | 'member'> = {}) {
  const owner = `user-o${randomUUID().slice(0, 6)}`;
  const org = (await call('POST', '/v1/orgs', owner, { name: 'Team' })).body.id as string;
  const ids: Record<string, string> = { owner };
  for (const [name, role] of Object.entries(roles)) {
    const id = `user-${name}-${randomUUID().slice(0, 6)}`;
    await call('GET', '/v1/me', id); // signs them in, so they show up with an email
    await db.query('insert into org_members (org_id, user_id, role) values ($1, $2, $3)', [org, id, role]);
    ids[name] = id;
  }
  return { org, ids };
}

describe('who I am', () => {
  it('lists my organizations with my role, personal one first', async () => {
    const me = (await call('GET', '/v1/me', 'user-me')).body;
    expect(me.user).toMatchObject({ id: 'user-me', email: 'user-me@example.com' });
    expect(me.orgs).toMatchObject([{ personal: true, role: 'owner' }]);
    await call('POST', '/v1/orgs', 'user-me', { name: 'Acme' });
    expect((await call('GET', '/v1/me', 'user-me')).body.orgs.map((o: { name: string }) => o.name)).toEqual(['Personal', 'Acme']);
  });
});

describe('organizations', () => {
  it('makes the creator the owner, and hides the org from everyone else', async () => {
    const { org } = await team();
    expect((await call('GET', `/v1/orgs/${org}`, 'user-stranger')).status).toBe(404);
    expect((await call('GET', `/v1/orgs/${randomUUID()}`, 'user-stranger')).status).toBe(404);
    expect((await call('POST', '/v1/orgs', 'user-x', { name: '  ' })).status).toBe(400);
  });

  it('lets only owners rename or delete, and keeps personal orgs', async () => {
    const { org, ids } = await team({ admin: 'admin', member: 'member' });
    expect((await call('PATCH', `/v1/orgs/${org}`, ids.admin!, { name: 'X' })).status).toBe(403);
    expect((await call('DELETE', `/v1/orgs/${org}`, ids.admin!)).status).toBe(403);
    expect((await call('PATCH', `/v1/orgs/${org}`, ids.owner!, { name: 'Renamed' })).body.name).toBe('Renamed');
    expect((await call('DELETE', `/v1/orgs/${org}`, ids.owner!)).status).toBe(204);
    expect((await call('GET', `/v1/orgs/${org}`, ids.owner!)).status).toBe(404);
    const personal = (await call('GET', '/v1/me', 'user-solo')).body.orgs[0].id;
    expect((await call('DELETE', `/v1/orgs/${personal}`, 'user-solo')).status).toBe(409);
    expect((await call('PATCH', `/v1/orgs/${personal}`, 'user-solo', { name: 'Mine' })).status).toBe(200);
  });
});

describe('projects in an organization', () => {
  it('lets only owners and admins create them, and shows members only what they were granted', async () => {
    const { org, ids } = await team({ admin: 'admin', member: 'member' });
    expect((await call('POST', `/v1/orgs/${org}/projects`, ids.member!, { name: 'P' })).status).toBe(403);
    expect((await call('POST', `/v1/orgs/${org}/projects`, ids.admin!, { name: 'Shop' })).status).toBe(201);
    const second = (await call('POST', `/v1/orgs/${org}/projects`, ids.owner!, { name: 'Pay' })).body;
    expect(second).toMatchObject({ orgId: org, access: 'admin' });
    const names = async (u: string) => (await call('GET', `/v1/orgs/${org}/projects`, u)).body.map((p: { name: string }) => p.name).sort();
    expect(await names(ids.owner!)).toEqual(['Pay', 'Shop']);
    expect(await names(ids.member!)).toEqual([]);
    await db.query(`insert into project_members (project_id, user_id, role) values ($1, $2, 'viewer')`, [second.id, ids.member]);
    expect(await names(ids.member!)).toEqual(['Pay']);
    expect((await call('GET', `/v1/orgs/${org}/projects`, 'user-stranger')).status).toBe(404);
  });
});

describe('members', () => {
  it('lists everyone with their email and role, owners first', async () => {
    const { org, ids } = await team({ zed: 'member', amy: 'admin' });
    const list = (await call('GET', `/v1/orgs/${org}/members`, ids.zed!)).body;
    expect(list.map((m: { role: string }) => m.role)).toEqual(['owner', 'admin', 'member']);
    expect(list[1]).toMatchObject({ userId: ids.amy, email: `${ids.amy}@example.com` });
    expect((await call('GET', `/v1/orgs/${org}/members`, 'user-stranger')).status).toBe(404);
  });

  it('lets admins manage members and admins, but only owners touch ownership', async () => {
    const { org, ids } = await team({ admin: 'admin', member: 'member', other: 'admin' });
    const set = (by: string, who: string, role: string) => call('PATCH', `/v1/orgs/${org}/members/${who}`, by, { role });
    expect((await set(ids.member!, ids.other!, 'member')).status).toBe(403);
    expect((await set(ids.admin!, ids.member!, 'admin')).status).toBe(200);
    expect((await set(ids.admin!, ids.member!, 'owner')).status).toBe(403);
    expect((await set(ids.admin!, ids.owner!, 'member')).status).toBe(403);
    expect((await set(ids.admin!, ids.member!, 'boss')).status).toBe(400);
    expect((await set(ids.owner!, ids.member!, 'owner')).status).toBe(200);
    expect((await set(ids.owner!, 'user-nobody', 'member')).status).toBe(404);
  });

  it('never leaves an organization without an owner', async () => {
    const { org, ids } = await team({ admin: 'admin' });
    expect((await call('PATCH', `/v1/orgs/${org}/members/${ids.owner}`, ids.owner!, { role: 'admin' })).status).toBe(409);
    expect((await call('DELETE', `/v1/orgs/${org}/members/${ids.owner}`, ids.owner!)).status).toBe(409);
    await call('PATCH', `/v1/orgs/${org}/members/${ids.admin}`, ids.owner!, { role: 'owner' });
    expect((await call('DELETE', `/v1/orgs/${org}/members/${ids.owner}`, ids.owner!)).status).toBe(204);
    expect((await call('GET', `/v1/orgs/${org}`, ids.owner!)).status).toBe(404);
  });

  it('lets anyone leave, and admins remove others, and drops their project grants', async () => {
    const { org, ids } = await team({ admin: 'admin', a: 'member', b: 'member' });
    const project = (await call('POST', `/v1/orgs/${org}/projects`, ids.owner!, { name: 'P' })).body.id;
    await db.query(`insert into project_members (project_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')`, [project, ids.a, ids.b]);
    expect((await call('DELETE', `/v1/orgs/${org}/members/${ids.b}`, ids.a!)).status).toBe(403);
    expect((await call('DELETE', `/v1/orgs/${org}/members/${ids.owner}`, ids.admin!)).status).toBe(403);
    expect((await call('DELETE', `/v1/orgs/${org}/members/${ids.a}`, ids.admin!)).status).toBe(204);
    expect((await call('DELETE', `/v1/orgs/${org}/members/${ids.b}`, ids.b!)).status).toBe(204);
    expect(await db.query('select 1 from project_members where project_id = $1', [project])).toHaveLength(0);
    // Removed people lose the project entirely.
    expect((await call('GET', `/v1/projects/${project}`, ids.a!)).status).toBe(404);
    expect((await call('GET', `/v1/orgs/${org}/members`, ids.a!)).status).toBe(404);
  });
});
