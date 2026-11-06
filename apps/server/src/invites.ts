import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { orgRole } from './access';
import type { Db } from './db';
import { forbidden, iso, notFound, UUID } from './http';
import { inviteEmail, type Mailer } from './mail';
import { orgGuard, type Env } from './orgs';

/** How long an invitation link works. */
export const INVITE_DAYS = 7;
const DAY_MS = 86_400_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

interface Grant { projectId: string; role: 'editor' | 'viewer' }

interface InviteRow {
  id: string; org_id: string; email: string; org_role: 'admin' | 'member'; projects: Grant[];
  invited_by: string; created_at: string; expires_at: string; accepted_at: string | null; revoked_at: string | null;
}

export interface InviteOptions {
  db: Db;
  /** Sends the invitation. Without one, the link is only handed back to the admin to share. */
  sendMail?: Mailer;
  /** Where the web app lives, for the link in the email. */
  webAppUrl: string;
  now: () => number;
}

/**
 * Invitations to an organization: admins create, list, resend and revoke them; the invited person finds theirs by
 * their sign-in email (or by the emailed link's token) and accepts. Mounted under /v1 behind the sign-in check.
 */
export function inviteRoutes(opts: InviteOptions) {
  const { db, now } = opts;
  const app = new Hono<Env>();
  const guard = orgGuard(db);
  const linkFor = (token: string) => `${opts.webAppUrl.replace(/\/$/, '')}/invites/${token}`;

  const shape = (i: InviteRow) => ({
    id: i.id, email: i.email, orgRole: i.org_role, projects: i.projects, createdAt: iso(i.created_at), expiresAt: iso(i.expires_at),
    expired: new Date(i.expires_at).getTime() < now(),
  });

  /** Mails the link. Resolves to whether it was sent; a missing or failing mail provider never fails the invite. */
  async function deliver(i: { email: string }, orgName: string, inviter: string, token: string): Promise<{ emailed: boolean; mailError?: boolean; link?: string }> {
    const link = linkFor(token);
    if (!opts.sendMail) {
      console.log(`[server] invite for ${i.email} to ${orgName} (no mail provider set): ${link}`);
      return { emailed: false, link };
    }
    try {
      await opts.sendMail({ to: i.email, ...inviteEmail({ orgName, inviter, link, expiresInDays: INVITE_DAYS }) });
      return { emailed: true };
    } catch (err) {
      // The reason stays in the server log: a mail provider's error can describe the account, its key or its domain.
      console.warn(`[server] could not email the invite to ${i.email}: ${(err as Error).message}`);
      return { emailed: false, mailError: true, link };
    }
  }

  const inviterName = (c: { get(k: 'user'): { name?: string; email?: string; id: string } }) => c.get('user').name ?? c.get('user').email ?? 'Someone';

  // --- Admin side ---

  app.get('/orgs/:orgId/invites', async (c) => {
    const g = await guard(c, 'admin');
    if (g instanceof Response) return g;
    const rows = await db.query<InviteRow>('select * from invites where org_id = $1 and accepted_at is null and revoked_at is null order by created_at desc', [g.org.id]);
    return c.json(rows.map(shape));
  });

  app.post('/orgs/:orgId/invites', async (c) => {
    const g = await guard(c, 'admin');
    if (g instanceof Response) return g;
    const body = await c.req.json().catch(() => ({}));
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email) || email.length > 254) return c.json({ error: 'enter a valid email address' }, 400);
    const orgRole = body.orgRole ?? 'member';
    if (orgRole !== 'admin' && orgRole !== 'member') return c.json({ error: 'role must be admin or member' }, 400);

    // Admins already see every project, so grants only matter for members.
    let grants: Grant[] = [];
    if (orgRole === 'member' && body.projects !== undefined) {
      if (!Array.isArray(body.projects)) return c.json({ error: 'projects must be a list' }, 400);
      const wanted = new Map<string, Grant['role']>();
      for (const p of body.projects as { projectId?: unknown; role?: unknown }[]) {
        if (typeof p?.projectId !== 'string' || !UUID.test(p.projectId) || (p.role !== 'editor' && p.role !== 'viewer')) return c.json({ error: 'each project needs a projectId and a role of editor or viewer' }, 400);
        wanted.set(p.projectId, p.role);
      }
      if (wanted.size) {
        const found = await db.query<{ id: string }>('select id from projects where org_id = $1 and id = any($2::uuid[])', [g.org.id, [...wanted.keys()]]);
        if (found.length !== wanted.size) return c.json({ error: 'one of those projects is not in this organization' }, 400);
      }
      grants = [...wanted].map(([projectId, role]) => ({ projectId, role }));
    }

    const [member] = await db.query(
      'select 1 from org_members m join users u on u.id = m.user_id where m.org_id = $1 and lower(u.email) = $2',
      [g.org.id, email],
    );
    if (member) return c.json({ error: 'that person is already a member' }, 409);

    const token = randomBytes(32).toString('base64url');
    const expires = new Date(now() + INVITE_DAYS * DAY_MS).toISOString();
    const row = await db.transaction(async (tx) => {
      // A new invitation replaces any open one for the same person, so the old link stops working.
      await tx.query('update invites set revoked_at = now() where org_id = $1 and email = $2 and accepted_at is null and revoked_at is null', [g.org.id, email]);
      const [i] = await tx.query<InviteRow>(
        `insert into invites (org_id, email, org_role, projects, token_hash, invited_by, expires_at)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7) returning *`,
        [g.org.id, email, orgRole, JSON.stringify(grants), hashToken(token), c.get('user').id, expires],
      );
      return i!;
    });
    return c.json({ ...shape(row), ...(await deliver(row, g.org.name, inviterName(c), token)) }, 201);
  });

  app.post('/orgs/:orgId/invites/:inviteId/resend', async (c) => {
    const g = await guard(c, 'admin');
    if (g instanceof Response) return g;
    const id = c.req.param('inviteId');
    if (!UUID.test(id)) return notFound(c);
    // Only the hash is stored, so resending means a new token (the old link stops working) and a fresh expiry.
    const token = randomBytes(32).toString('base64url');
    const [row] = await db.query<InviteRow>(
      `update invites set token_hash = $3, expires_at = $4 where id = $1 and org_id = $2 and accepted_at is null and revoked_at is null returning *`,
      [id, g.org.id, hashToken(token), new Date(now() + INVITE_DAYS * DAY_MS).toISOString()],
    );
    if (!row) return notFound(c);
    return c.json({ ...shape(row), ...(await deliver(row, g.org.name, inviterName(c), token)) });
  });

  app.delete('/orgs/:orgId/invites/:inviteId', async (c) => {
    const g = await guard(c, 'admin');
    if (g instanceof Response) return g;
    const id = c.req.param('inviteId');
    if (!UUID.test(id)) return notFound(c);
    const done = await db.query('update invites set revoked_at = now() where id = $1 and org_id = $2 and accepted_at is null and revoked_at is null returning id', [id, g.org.id]);
    return done.length ? c.body(null, 204) : notFound(c);
  });

  // --- The invited person's side ---

  /** Open, unexpired invitations for the signed-in email, with enough to show who is inviting to what. */
  app.get('/invites', async (c) => {
    const email = c.get('user').email?.toLowerCase();
    if (!email) return c.json([]);
    const rows = await db.query<InviteRow & { org_name: string; inviter: string | null }>(
      `select i.*, o.name as org_name, coalesce(u.name, u.email) as inviter
       from invites i join orgs o on o.id = i.org_id left join users u on u.id = i.invited_by
       where i.email = $1 and i.accepted_at is null and i.revoked_at is null and i.expires_at > $2 order by i.created_at desc`,
      [email, new Date(now()).toISOString()],
    );
    return c.json(rows.map((i) => ({ id: i.id, orgId: i.org_id, orgName: i.org_name, orgRole: i.org_role, invitedBy: i.inviter, expiresAt: iso(i.expires_at) })));
  });

  // Accepting is guarded against guessing: a handful of tries a minute per person is plenty.
  const tries = new Map<string, { start: number; n: number }>();
  const tooMany = (user: string) => {
    const t = now();
    const w = tries.get(user);
    if (!w || t - w.start >= 60_000) { tries.set(user, { start: t, n: 1 }); return false; }
    return ++w.n > 10;
  };

  /** The invite a token or id names, with its org, or null. Never says which part was wrong. */
  async function find(body: { token?: unknown; id?: unknown }) {
    if (typeof body.token === 'string' && body.token) {
      return (await db.query<InviteRow & { org_name: string; inviter: string | null }>(
        `select i.*, o.name as org_name, coalesce(u.name, u.email) as inviter from invites i join orgs o on o.id = i.org_id left join users u on u.id = i.invited_by where i.token_hash = $1`,
        [hashToken(body.token)],
      ))[0] ?? null;
    }
    if (typeof body.id === 'string' && UUID.test(body.id)) {
      return (await db.query<InviteRow & { org_name: string; inviter: string | null }>(
        `select i.*, o.name as org_name, coalesce(u.name, u.email) as inviter from invites i join orgs o on o.id = i.org_id left join users u on u.id = i.invited_by where i.id = $1`,
        [body.id],
      ))[0] ?? null;
    }
    return null;
  }
  const state = (i: InviteRow): 'open' | 'accepted' | 'revoked' | 'expired' =>
    i.accepted_at ? 'accepted' : i.revoked_at ? 'revoked' : new Date(i.expires_at).getTime() < now() ? 'expired' : 'open';

  /** What an emailed link is for, so the page can say so before the person accepts. */
  app.post('/invites/lookup', async (c) => {
    if (tooMany(c.get('user').id)) return c.json({ error: 'too many attempts, try again in a minute' }, 429);
    const i = await find(await c.req.json().catch(() => ({})));
    if (!i) return notFound(c);
    const mine = !!c.get('user').email && c.get('user').email!.toLowerCase() === i.email;
    // The invite's address is only shown to the person it was sent to.
    // The org id only goes to people already in the org, so a used link can lead them there.
    const member = !!(await orgRole(db, c.get('user').id, i.org_id));
    return c.json({
      id: i.id, orgName: i.org_name, orgRole: i.org_role, invitedBy: i.inviter, state: state(i), forYou: mine,
      ...(mine && { email: i.email }), ...(member && { orgId: i.org_id }),
    });
  });

  app.post('/invites/accept', async (c) => {
    const user = c.get('user');
    if (tooMany(user.id)) return c.json({ error: 'too many attempts, try again in a minute' }, 429);
    const i = await find(await c.req.json().catch(() => ({})));
    if (!i) return notFound(c);
    if (!user.email || user.email.toLowerCase() !== i.email) return forbidden(c, 'this invitation was sent to a different email address');
    const s = state(i);
    if (s !== 'open') return c.json({ error: s === 'accepted' ? 'this invitation was already used' : s === 'revoked' ? 'this invitation was cancelled' : 'this invitation has expired, ask for a new one' }, 410);
    await db.transaction(async (tx) => {
      const claimed = await tx.query('update invites set accepted_at = now() where id = $1 and accepted_at is null and revoked_at is null returning id', [i.id]);
      if (!claimed.length) return;
      // Someone already in the org keeps the role they have.
      await tx.query(`insert into org_members (org_id, user_id, role) values ($1, $2, $3) on conflict do nothing`, [i.org_id, user.id, i.org_role]);
      const [me] = await tx.query<{ role: string }>('select role from org_members where org_id = $1 and user_id = $2', [i.org_id, user.id]);
      if (me?.role === 'member') {
        for (const g of i.projects) {
          // A project deleted since the invite went out is simply skipped.
          await tx.query(
            `insert into project_members (project_id, user_id, role) select p.id, $2, $3 from projects p where p.id = $1 and p.org_id = $4
             on conflict (project_id, user_id) do update set role = excluded.role`,
            [g.projectId, user.id, g.role, i.org_id],
          );
        }
      }
    });
    return c.json({ orgId: i.org_id });
  });

  return app;
}
