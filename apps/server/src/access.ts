import type { Db } from './db';
import type { User } from './auth';
import { cleanName } from './http';

export type OrgRole = 'owner' | 'admin' | 'member';
/** What a person can do in one project. `admin` also covers deleting it and choosing who has access. */
export type Access = 'viewer' | 'editor' | 'admin';

const RANK: Record<Access, number> = { viewer: 1, editor: 2, admin: 3 };

/** Whether `have` is enough for an action that needs `need`. */
export const allows = (have: Access | null, need: Access): boolean => !!have && RANK[have] >= RANK[need];

/**
 * Records who is calling. On someone's very first request it also creates the organization they named when signing
 * up, with them as owner. That happens only once: someone who later leaves every org is asked to create or join one
 * instead of getting it back. Cheap on repeat visits: one insert that does nothing and one update.
 */
export async function ensureUser(db: Db, user: User): Promise<void> {
  const email = user.email?.toLowerCase() ?? null;
  const orgName = cleanName(user.orgName);
  await db.transaction(async (tx) => {
    const [fresh] = await tx.query<{ id: string }>(
      'insert into users (id, email, name) values ($1, $2, $3) on conflict (id) do nothing returning id',
      [user.id, email, user.name ?? null],
    );
    if (!fresh) {
      await tx.query(
        'update users set email = coalesce($2, email), name = coalesce($3, name), last_seen_at = now() where id = $1',
        [user.id, email, user.name ?? null],
      );
      return;
    }
    if (!orgName) return;
    const [org] = await tx.query<{ id: string }>('insert into orgs (name, created_by) values ($1, $2) returning id', [orgName, user.id]);
    await tx.query(`insert into org_members (org_id, user_id, role) values ($1, $2, 'owner')`, [org!.id, user.id]);
  });
}

export async function orgRole(db: Db, userId: string, orgId: string): Promise<OrgRole | null> {
  const [m] = await db.query<{ role: OrgRole }>('select role from org_members where org_id = $1 and user_id = $2', [orgId, userId]);
  return m?.role ?? null;
}

/**
 * What the user may do in a project: owners and admins of its org can do everything, other members only what a
 * project grant allows, and everyone else nothing.
 */
export async function projectAccess(db: Db, userId: string, projectId: string): Promise<Access | null> {
  const [row] = await db.query<{ role: OrgRole; grant: 'editor' | 'viewer' | null }>(
    `select om.role, pm.role as grant
     from projects p
     join org_members om on om.org_id = p.org_id and om.user_id = $1
     left join project_members pm on pm.project_id = p.id and pm.user_id = $1
     where p.id = $2`,
    [userId, projectId],
  );
  if (!row) return null;
  return row.role === 'owner' || row.role === 'admin' ? 'admin' : row.grant;
}

/** The projects a user can see, newest first, with how many recorders each has. Limited to one org when given. */
export async function visibleProjects(db: Db, userId: string, orgId?: string) {
  return db.query<{ id: string; name: string; created_at: string; org_id: string; recorders: number; last_seen_at: string | null }>(
    `select p.id, p.name, p.created_at, p.org_id, count(r.id)::int as recorders, max(r.last_seen_at) as last_seen_at
     from projects p left join recorders r on r.project_id = p.id
     where ($2::uuid is null or p.org_id = $2)
       and exists (select 1 from org_members om where om.org_id = p.org_id and om.user_id = $1
                     and (om.role in ('owner', 'admin') or exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = $1)))
     group by p.id order by p.created_at desc`,
    [userId, orgId ?? null],
  );
}
