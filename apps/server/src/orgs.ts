import { Hono, type Context } from 'hono';
import { visibleProjects, type OrgRole } from './access';
import type { User } from './auth';
import type { Db } from './db';
import { cleanName, forbidden, iso, notFound, UUID } from './http';

export type Env = { Variables: { user: User } };

export const RANK: Record<OrgRole, number> = { member: 1, admin: 2, owner: 3 };
const ROLES: readonly string[] = ['owner', 'admin', 'member'];

export interface OrgRow { id: string; name: string; personal: boolean; created_by: string; created_at: string }
const org = (o: OrgRow, role: OrgRole) => ({ id: o.id, name: o.name, personal: o.personal, role, createdAt: iso(o.created_at) });

/**
 * The org in the URL when the user belongs to it with at least `need`. Non-members get the same 404 as a missing org,
 * and members without enough role get a 403. Returns a response to send otherwise.
 */
export const orgGuard = (db: Db) => async (c: Context<Env>, need: OrgRole): Promise<{ org: OrgRow; role: OrgRole } | Response> => {
  const id = c.req.param('orgId');
  if (!id || !UUID.test(id)) return notFound(c);
  const [row] = await db.query<OrgRow & { role: OrgRole }>(
    'select o.id, o.name, o.personal, o.created_by, o.created_at, m.role from orgs o join org_members m on m.org_id = o.id and m.user_id = $2 where o.id = $1',
    [id, c.get('user').id],
  );
  if (!row) return notFound(c);
  return RANK[row.role] >= RANK[need] ? { org: row, role: row.role } : forbidden(c);
};

/**
 * Who the signed-in user is, and the organizations, their members and the projects in them. Mounted under /v1 by
 * `createApp`, behind its sign-in check.
 */
export function orgRoutes(db: Db) {
  const app = new Hono<Env>();

  const guard = orgGuard(db);

  app.get('/me', async (c) => {
    const u = c.get('user');
    const rows = await db.query<OrgRow & { role: OrgRole }>(
      `select o.id, o.name, o.personal, o.created_by, o.created_at, m.role
       from org_members m join orgs o on o.id = m.org_id where m.user_id = $1 order by o.personal desc, o.name`,
      [u.id],
    );
    return c.json({ user: { id: u.id, email: u.email ?? null, name: u.name ?? null }, orgs: rows.map((o) => org(o, o.role)) });
  });

  app.post('/orgs', async (c) => {
    const name = cleanName((await c.req.json().catch(() => ({}))).name);
    if (!name) return c.json({ error: 'name is required (1-100 characters)' }, 400);
    const created = await db.transaction(async (tx) => {
      const [o] = await tx.query<OrgRow>('insert into orgs (name, created_by) values ($1, $2) returning id, name, personal, created_by, created_at', [name, c.get('user').id]);
      await tx.query(`insert into org_members (org_id, user_id, role) values ($1, $2, 'owner')`, [o!.id, c.get('user').id]);
      return o!;
    });
    return c.json(org(created, 'owner'), 201);
  });

  app.get('/orgs/:orgId', async (c) => {
    const g = await guard(c, 'member');
    return g instanceof Response ? g : c.json(org(g.org, g.role));
  });

  app.patch('/orgs/:orgId', async (c) => {
    const g = await guard(c, 'owner');
    if (g instanceof Response) return g;
    const name = cleanName((await c.req.json().catch(() => ({}))).name);
    if (!name) return c.json({ error: 'name is required (1-100 characters)' }, 400);
    const [o] = await db.query<OrgRow>('update orgs set name = $2 where id = $1 returning id, name, personal, created_by, created_at', [g.org.id, name]);
    return c.json(org(o!, g.role));
  });

  app.delete('/orgs/:orgId', async (c) => {
    const g = await guard(c, 'owner');
    if (g instanceof Response) return g;
    // Everyone keeps a personal org to create projects in, so it goes only once its creator is no longer an owner of it.
    if (g.org.personal) {
      const [still] = await db.query(`select 1 from org_members where org_id = $1 and user_id = $2 and role = 'owner'`, [g.org.id, g.org.created_by]);
      if (still) return c.json({ error: 'a personal organization can not be deleted' }, 409);
    }
    await db.query('delete from orgs where id = $1', [g.org.id]);
    return c.body(null, 204);
  });

  app.get('/orgs/:orgId/projects', async (c) => {
    const g = await guard(c, 'member');
    if (g instanceof Response) return g;
    const rows = await visibleProjects(db, c.get('user').id, g.org.id);
    return c.json(rows.map((p) => ({ id: p.id, name: p.name, orgId: p.org_id, createdAt: iso(p.created_at), recorders: p.recorders, lastSeenAt: iso(p.last_seen_at) })));
  });

  app.post('/orgs/:orgId/projects', async (c) => {
    const g = await guard(c, 'admin');
    if (g instanceof Response) return g;
    const name = cleanName((await c.req.json().catch(() => ({}))).name);
    if (!name) return c.json({ error: 'name is required (1-100 characters)' }, 400);
    const [p] = await db.query<{ id: string; name: string; created_at: string; org_id: string }>(
      'insert into projects (org_id, name, created_by) values ($1, $2, $3) returning id, name, created_at, org_id',
      [g.org.id, name, c.get('user').id],
    );
    return c.json({ id: p!.id, name: p!.name, orgId: p!.org_id, createdAt: iso(p!.created_at), access: 'admin' }, 201);
  });

  app.get('/orgs/:orgId/members', async (c) => {
    const g = await guard(c, 'member');
    if (g instanceof Response) return g;
    const rows = await db.query<{ user_id: string; role: OrgRole; created_at: string; email: string | null; name: string | null }>(
      `select m.user_id, m.role, m.created_at, u.email, u.name
       from org_members m left join users u on u.id = m.user_id where m.org_id = $1
       order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, lower(coalesce(u.name, u.email, m.user_id))`,
      [g.org.id],
    );
    return c.json(rows.map((m) => ({ userId: m.user_id, email: m.email, name: m.name, role: m.role, joinedAt: iso(m.created_at) })));
  });

  /** Who holds each role, so a change can be refused when it would leave the org without an owner. */
  const roleOf = async (orgId: string, userId: string) =>
    (await db.query<{ role: OrgRole }>('select role from org_members where org_id = $1 and user_id = $2', [orgId, userId]))[0]?.role ?? null;
  const ownerCount = async (orgId: string) =>
    (await db.query<{ n: number }>(`select count(*)::int as n from org_members where org_id = $1 and role = 'owner'`, [orgId]))[0]!.n;

  app.patch('/orgs/:orgId/members/:userId', async (c) => {
    const g = await guard(c, 'admin');
    if (g instanceof Response) return g;
    const userId = c.req.param('userId');
    const role = (await c.req.json().catch(() => ({}))).role;
    if (typeof role !== 'string' || !ROLES.includes(role)) return c.json({ error: 'role must be owner, admin or member' }, 400);
    const current = await roleOf(g.org.id, userId);
    if (!current) return notFound(c);
    // Only owners hand out ownership or change an owner's role.
    if ((role === 'owner' || current === 'owner') && g.role !== 'owner') return forbidden(c);
    if (current === 'owner' && role !== 'owner' && (await ownerCount(g.org.id)) <= 1) return c.json({ error: 'an organization needs at least one owner' }, 409);
    await db.query('update org_members set role = $3 where org_id = $1 and user_id = $2', [g.org.id, userId, role]);
    return c.json({ userId, role });
  });

  app.delete('/orgs/:orgId/members/:userId', async (c) => {
    const g = await guard(c, 'member');
    if (g instanceof Response) return g;
    const userId = c.req.param('userId');
    const current = await roleOf(g.org.id, userId);
    if (!current) return notFound(c);
    const leaving = userId === c.get('user').id;
    // Anyone can leave. Removing someone else takes an admin, and only an owner can remove an owner.
    if (!leaving && (RANK[g.role] < RANK.admin || (current === 'owner' && g.role !== 'owner'))) return forbidden(c);
    if (current === 'owner' && (await ownerCount(g.org.id)) <= 1) return c.json({ error: 'an organization needs at least one owner' }, 409);
    await db.transaction(async (tx) => {
      await tx.query('delete from project_members where user_id = $2 and project_id in (select id from projects where org_id = $1)', [g.org.id, userId]);
      await tx.query('delete from org_members where org_id = $1 and user_id = $2', [g.org.id, userId]);
    });
    return c.body(null, 204);
  });

  return app;
}
