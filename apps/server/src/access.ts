import type { Db } from './db';
import type { User } from './auth';

export type OrgRole = 'owner' | 'admin' | 'member';
/** What a person can do in one project. `admin` also covers deleting it and choosing who has access. */
export type Access = 'viewer' | 'editor' | 'admin';

const RANK: Record<Access, number> = { viewer: 1, editor: 2, admin: 3 };

/** Whether `have` is enough for an action that needs `need`. */
export const allows = (have: Access | null, need: Access): boolean => !!have && RANK[have] >= RANK[need];

/**
 * Records who is calling, and on someone's first sign-in gives them a personal org to create projects in.
 * Cheap on repeat visits: one upsert and one existence check.
 */
export async function ensureUser(db: Db, user: User): Promise<void> {
  await db.query(
    `insert into users (id, email, name) values ($1, $2, $3)
     on conflict (id) do update set email = coalesce(excluded.email, users.email), name = coalesce(excluded.name, users.name), last_seen_at = now()`,
    [user.id, user.email?.toLowerCase() ?? null, user.name ?? null],
  );
  const [has] = await db.query('select 1 from org_members where user_id = $1 limit 1', [user.id]);
  if (has) return;
  await db.transaction(async (tx) => {
    const [org] = await tx.query<{ id: string }>(
      `insert into orgs (name, personal, created_by) values ('Personal', true, $1) on conflict do nothing returning id`,
      [user.id],
    );
    if (org) await tx.query(`insert into org_members (org_id, user_id, role) values ($1, $2, 'owner')`, [org.id, user.id]);
  });
}

/** The user's personal org, which projects they create without naming an org go into. */
export async function personalOrg(db: Db, userId: string): Promise<string | null> {
  const [o] = await db.query<{ id: string }>('select id from orgs where personal and created_by = $1', [userId]);
  return o?.id ?? null;
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
