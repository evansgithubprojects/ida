import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { migrate, openPglite, type Db } from '../src/db';

const as = (user: string) => ({ Authorization: `Bearer ${user}` });
// `user-x#Acme` signs in as user-x who named "Acme" on the sign-up form.
const verifyUser = async (t: string) => {
  const [id = '', orgName] = t.split('#');
  return id.startsWith('user-') ? { id, email: `${id}@example.com`, ...(orgName && { orgName }) } : null;
};

function appFor(db: Db) {
  return createApp({ db, verifyUser, streamSecret: 'secret' });
}

async function call(app: ReturnType<typeof createApp>, method: string, path: string, user: string, body?: unknown) {
  const res = await app.request(path, { method, headers: { ...as(user), ...(body !== undefined && { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('moving to organizations', () => {
  it('puts each existing owner’s projects in an org they own, and nobody else’s', async () => {
    const db = await openPglite();
    try {
      // The database as it was before organizations existed.
      await db.query('create table schema_migrations (name text primary key, applied_at timestamptz not null default now())');
      const first = (await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8')).split(/;\s*$/m).map((s) => s.trim()).filter((s) => s.replace(/--.*$/gm, '').trim());
      for (const stmt of first) await db.query(stmt);
      await db.query(`insert into schema_migrations (name) values ('001_init.sql')`);
      const [a1, a2, b1] = [randomUUID(), randomUUID(), randomUUID()];
      for (const [id, owner] of [[a1, 'user-a'], [a2, 'user-a'], [b1, 'user-b']]) await db.query('insert into projects (id, owner_id, name) values ($1, $2, $3)', [id, owner, 'P']);

      expect(await migrate(db)).toEqual(['002_orgs.sql', '003_invites.sql', '004_no_personal.sql']);

      // They started as personal orgs and are now ordinary ones.
      const orgs = await db.query<{ created_by: string; name: string }>('select created_by, name from orgs order by created_by');
      expect(orgs).toEqual([{ created_by: 'user-a', name: 'Personal' }, { created_by: 'user-b', name: 'Personal' }]);
      const owners = await db.query<{ user_id: string; role: string }>('select user_id, role from org_members order by user_id');
      expect(owners).toEqual([{ user_id: 'user-a', role: 'owner' }, { user_id: 'user-b', role: 'owner' }]);

      const app = appFor(db);
      const mine = (await call(app, 'GET', '/v1/projects', 'user-a')).body as { id: string }[];
      expect(mine.map((p) => p.id).sort()).toEqual([a1, a2].sort());
      expect((await call(app, 'GET', `/v1/projects/${b1}`, 'user-a')).status).toBe(404);
      expect((await call(app, 'GET', `/v1/projects/${b1}`, 'user-b')).body).toMatchObject({ id: b1, access: 'admin' });
      // Signing in, even with an organization named, doesn't make another org for someone already known.
      await call(app, 'GET', '/v1/projects', 'user-a#Fresh');
      expect(await db.query('select 1 from orgs')).toHaveLength(2);
    } finally {
      await db.close();
    }
  }, 30_000);
});

describe('who can do what in a project', () => {
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let project: string;
  let other: string;
  const org = randomUUID();

  beforeAll(async () => {
    db = await openPglite();
    await migrate(db);
    app = appFor(db);
    await db.query(`insert into orgs (id, name, created_by) values ($1, 'Team', 'user-owner')`, [org]);
    for (const [u, role] of [['user-owner', 'owner'], ['user-admin', 'admin'], ['user-editor', 'member'], ['user-viewer', 'member'], ['user-none', 'member']]) {
      await db.query('insert into org_members (org_id, user_id, role) values ($1, $2, $3)', [org, u, role]);
    }
    project = (await db.query<{ id: string }>(`insert into projects (org_id, name, created_by) values ($1, 'Shop', 'user-owner') returning id`, [org]))[0]!.id;
    other = (await db.query<{ id: string }>(`insert into projects (org_id, name, created_by) values ($1, 'Other', 'user-owner') returning id`, [org]))[0]!.id;
    await db.query(`insert into project_members (project_id, user_id, role) values ($1, 'user-editor', 'editor'), ($1, 'user-viewer', 'viewer')`, [project]);
    await db.query(`insert into project_members (project_id, user_id, role) values ($1, 'user-viewer', 'viewer')`, [other]);
  }, 30_000);
  afterAll(() => db.close());

  const viewing = (u: string) => call(app, 'GET', `/v1/projects/${project}/recorders`, u);
  const keys = (u: string) => call(app, 'GET', `/v1/projects/${project}/keys`, u);

  it('lets every role with access look at a project, and nobody without', async () => {
    for (const u of ['user-owner', 'user-admin', 'user-editor', 'user-viewer']) expect((await viewing(u)).status, u).toBe(200);
    // Not even a hint that it exists: the same 404 as a missing project.
    for (const u of ['user-none', 'user-out']) expect((await viewing(u)).status, u).toBe(404);
    expect((await call(app, 'GET', `/v1/projects/${randomUUID()}`, 'user-owner')).status).toBe(404);
  });

  it('reports the caller’s access on the project', async () => {
    const got = async (u: string) => (await call(app, 'GET', `/v1/projects/${project}`, u)).body.access;
    expect([await got('user-owner'), await got('user-admin'), await got('user-editor'), await got('user-viewer')]).toEqual(['admin', 'admin', 'editor', 'viewer']);
  });

  it('lets editors and above manage keys and rename, but not viewers', async () => {
    for (const u of ['user-owner', 'user-admin', 'user-editor']) expect((await keys(u)).status, u).toBe(200);
    expect((await keys('user-viewer')).status).toBe(403);
    expect((await call(app, 'POST', `/v1/projects/${project}/keys`, 'user-viewer', { label: 'x' })).status).toBe(403);
    expect((await call(app, 'PATCH', `/v1/projects/${project}`, 'user-viewer', { name: 'Nope' })).status).toBe(403);
    expect((await call(app, 'PATCH', `/v1/projects/${project}`, 'user-editor', { name: 'Shop' })).status).toBe(200);
    expect((await keys('user-none')).status).toBe(404);
  });

  it('lets only owners and admins delete', async () => {
    expect((await call(app, 'DELETE', `/v1/projects/${project}`, 'user-editor')).status).toBe(403);
    expect((await call(app, 'DELETE', `/v1/projects/${project}`, 'user-viewer')).status).toBe(403);
    expect((await call(app, 'DELETE', `/v1/projects/${project}`, 'user-none')).status).toBe(404);
    const doomed = (await db.query<{ id: string }>(`insert into projects (org_id, name, created_by) values ($1, 'Doomed', 'user-owner') returning id`, [org]))[0]!.id;
    expect((await call(app, 'DELETE', `/v1/projects/${doomed}`, 'user-admin')).status).toBe(204);
  });

  it('lists only the projects a member was granted, and all of them for an admin', async () => {
    const ids = async (u: string) => ((await call(app, 'GET', '/v1/projects', u)).body as { id: string }[]).map((p) => p.id).sort();
    expect(await ids('user-owner')).toEqual(expect.arrayContaining([project, other]));
    expect(await ids('user-admin')).toEqual(expect.arrayContaining([project, other]));
    expect(await ids('user-editor')).toEqual([project]);
    expect(await ids('user-viewer')).toEqual([project, other].sort());
    expect(await ids('user-none')).toEqual([]);
  });

  it('refuses a recording to someone who lost access', async () => {
    const recorder = (await db.query<{ id: string }>(`insert into recorders (project_id, key) values ($1, 'r') returning id`, [other]))[0]!.id;
    const session = randomUUID();
    await db.query(`insert into sessions (id, recorder_id, started_at) values ($1, $2, 1)`, [session, recorder]);
    expect((await call(app, 'GET', `/v1/sessions/${session}/recording`, 'user-viewer')).status).toBe(200);
    expect((await call(app, 'GET', `/v1/sessions/${session}/recording`, 'user-editor')).status).toBe(404);
    expect((await call(app, 'POST', `/v1/projects/${other}/recorders/r/stream-token`, 'user-editor')).status).toBe(404);
    await db.query(`delete from project_members where project_id = $1 and user_id = 'user-viewer'`, [other]);
    expect((await call(app, 'GET', `/v1/sessions/${session}/recording`, 'user-viewer')).status).toBe(404);
  });
});

describe('the organization named at sign-up', () => {
  it('is created once, on the first request, with the user as owner', async () => {
    const db = await openPglite();
    try {
      await migrate(db);
      const app = appFor(db);
      await Promise.all([call(app, 'GET', '/v1/projects', 'user-new#Globex'), call(app, 'GET', '/v1/projects', 'user-new#Globex')]);
      await call(app, 'GET', '/v1/projects', 'user-new#Globex');
      expect(await db.query(`select name from orgs where created_by = 'user-new'`)).toEqual([{ name: 'Globex' }]);
      expect(await db.query(`select role from org_members where user_id = 'user-new'`)).toEqual([{ role: 'owner' }]);
      expect(await db.query(`select email from users where id = 'user-new'`)).toEqual([{ email: 'user-new@example.com' }]);
      // Projects are always created in a named org now.
      expect((await app.request('/v1/projects', { method: 'POST', headers: as('user-new'), body: '{"name":"First"}' })).status).toBe(404);
    } finally {
      await db.close();
    }
  }, 30_000);
});
