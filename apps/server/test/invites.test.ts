import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { migrate, openPglite, type Db } from '../src/db';
import type { Mailer } from '../src/mail';

let db: Db;
let clock = Date.parse('2026-11-05T12:00:00Z');
const sent: Parameters<Mailer>[0][] = [];
let failMail = false;
let withMail = true;
let app: ReturnType<typeof createApp>;

const sendMail: Mailer = async (m) => {
  if (failMail) throw new Error('provider down');
  sent.push(m);
};

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
  // `withMail` lets one test run as if no mail provider was configured.
  app = createApp({
    db,
    verifyUser: async (t) => (t.startsWith('user-') ? { id: t, email: `${t}@example.com`, name: t.slice(5) } : null),
    streamSecret: 's',
    webAppUrl: 'https://app.example.com',
    sendMail: (m) => (withMail ? sendMail(m) : Promise.reject(new Error('unused'))),
    now: () => clock,
  });
}, 30_000);
afterAll(() => db.close());

const tokenOf = (link: string) => link.split('/invites/')[1]!;
const lastToken = () => tokenOf(/https:\/\/app\.example\.com\/invites\/[\w-]+/.exec(sent.at(-1)!.text)![0]);

/** An org with an owner, and two of its projects. */
async function setup() {
  const owner = `user-own${randomUUID().slice(0, 6)}`;
  const org = (await call('POST', '/v1/orgs', owner, { name: 'Acme' })).body.id as string;
  const mk = async (name: string) => (await call('POST', `/v1/orgs/${org}/projects`, owner, { name })).body.id as string;
  return { owner, org, shop: await mk('Shop'), pay: await mk('Pay') };
}
const guest = () => `user-g${randomUUID().slice(0, 6)}`;
const emailOf = (u: string) => `${u}@example.com`;

describe('sending an invitation', () => {
  it('emails one message with a link, and never returns the token', async () => {
    const { owner, org } = await setup();
    const g = guest();
    sent.length = 0;
    const res = await call('POST', `/v1/orgs/${org}/invites`, owner, { email: emailOf(g).toUpperCase(), orgRole: 'member' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: emailOf(g), orgRole: 'member', emailed: true });
    expect(res.body.link).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: emailOf(g) });
    expect(sent[0]!.subject).toContain('Acme');
    expect(sent[0]!.text).toContain('https://app.example.com/invites/');
    const listed = (await call('GET', `/v1/orgs/${org}/invites`, owner)).body;
    expect(JSON.stringify(listed)).not.toContain(lastToken());
    expect(listed).toHaveLength(1);
  });

  it('is for owners and admins only, and checks what it is given', async () => {
    const { owner, org, shop } = await setup();
    const g = guest();
    expect((await call('POST', `/v1/orgs/${org}/invites`, g, { email: 'a@b.co' })).status).toBe(404);
    await db.query(`insert into org_members (org_id, user_id, role) values ($1, $2, 'member')`, [org, g]);
    expect((await call('POST', `/v1/orgs/${org}/invites`, g, { email: 'a@b.co' })).status).toBe(403);
    expect((await call('GET', `/v1/orgs/${org}/invites`, g)).status).toBe(403);
    const send = (body: unknown) => call('POST', `/v1/orgs/${org}/invites`, owner, body);
    expect((await send({ email: 'not an email' })).status).toBe(400);
    expect((await send({ email: 'a@b.co', orgRole: 'owner' })).status).toBe(400);
    expect((await send({ email: 'a@b.co', projects: [{ projectId: randomUUID(), role: 'viewer' }] })).status).toBe(400);
    expect((await send({ email: 'a@b.co', projects: [{ projectId: shop, role: 'boss' }] })).status).toBe(400);
    expect((await send({ email: 'a@b.co', projects: [{ projectId: shop, role: 'viewer' }] })).status).toBe(201);
  });

  it('refuses someone who is already a member', async () => {
    const { owner, org } = await setup();
    await call('GET', '/v1/me', 'user-already'); // signs them in so their email is known
    await db.query(`insert into org_members (org_id, user_id, role) values ($1, 'user-already', 'member')`, [org]);
    expect((await call('POST', `/v1/orgs/${org}/invites`, owner, { email: 'user-already@example.com' })).status).toBe(409);
  });

  it('still creates the invite and hands back the link when email can not be sent', async () => {
    const { owner, org } = await setup();
    failMail = true;
    try {
      const res = await call('POST', `/v1/orgs/${org}/invites`, owner, { email: 'down@example.com' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ emailed: false, mailError: expect.stringContaining('provider down') });
      expect(res.body.link).toContain('https://app.example.com/invites/');
    } finally {
      failMail = false;
    }
  });

  it('replaces an open invitation to the same person, so the old link stops working', async () => {
    const { owner, org } = await setup();
    const g = guest();
    sent.length = 0;
    await call('POST', `/v1/orgs/${org}/invites`, owner, { email: emailOf(g) });
    const first = lastToken();
    await call('POST', `/v1/orgs/${org}/invites`, owner, { email: emailOf(g) });
    expect((await call('GET', `/v1/orgs/${org}/invites`, owner)).body).toHaveLength(1);
    expect((await call('POST', '/v1/invites/accept', g, { token: first })).status).toBe(410);
    expect((await call('POST', '/v1/invites/accept', g, { token: lastToken() })).status).toBe(200);
  });
});

describe('accepting', () => {
  it('adds the person with the role and project grants from the invitation', async () => {
    const { owner, org, shop, pay } = await setup();
    const g = guest();
    sent.length = 0;
    await call('POST', `/v1/orgs/${org}/invites`, owner, { email: emailOf(g), orgRole: 'member', projects: [{ projectId: shop, role: 'editor' }] });
    const res = await call('POST', '/v1/invites/accept', g, { token: lastToken() });
    expect(res).toMatchObject({ status: 200, body: { orgId: org } });
    expect((await call('GET', `/v1/orgs/${org}`, g)).body.role).toBe('member');
    expect((await call('GET', `/v1/projects/${shop}`, g)).body.access).toBe('editor');
    expect((await call('GET', `/v1/projects/${pay}`, g)).status).toBe(404);
    expect((await call('GET', `/v1/orgs/${org}/invites`, owner)).body).toHaveLength(0);
  });

  it('makes an invited admin see every project', async () => {
    const { owner, org, shop, pay } = await setup();
    const g = guest();
    sent.length = 0;
    await call('POST', `/v1/orgs/${org}/invites`, owner, { email: emailOf(g), orgRole: 'admin', projects: [{ projectId: shop, role: 'viewer' }] });
    await call('POST', '/v1/invites/accept', g, { token: lastToken() });
    expect((await call('GET', `/v1/projects/${pay}`, g)).body.access).toBe('admin');
    expect(await db.query('select 1 from project_members where user_id = $1', [g])).toHaveLength(0);
  });

  it('refuses a different email, and does not use the invitation up', async () => {
    const { owner, org } = await setup();
    const [g, other] = [guest(), guest()];
    sent.length = 0;
    await call('POST', `/v1/orgs/${org}/invites`, owner, { email: emailOf(g) });
    const token = lastToken();
    expect((await call('POST', '/v1/invites/accept', other, { token })).status).toBe(403);
    expect((await call('GET', `/v1/orgs/${org}`, other)).status).toBe(404);
    expect((await call('POST', '/v1/invites/accept', g, { token })).status).toBe(200);
  });

  it('works only once, and not after it was revoked or expired', async () => {
    const { owner, org } = await setup();
    const [a, b, c] = [guest(), guest(), guest()];
    sent.length = 0;
    await call('POST', `/v1/orgs/${org}/invites`, owner, { email: emailOf(a) });
    const used = lastToken();
    expect((await call('POST', '/v1/invites/accept', a, { token: used })).status).toBe(200);
    expect((await call('POST', '/v1/invites/accept', a, { token: used })).status).toBe(410);

    const revoked = (await call('POST', `/v1/orgs/${org}/invites`, owner, { email: emailOf(b) })).body.id;
    const revokedToken = lastToken();
    expect((await call('DELETE', `/v1/orgs/${org}/invites/${revoked}`, owner)).status).toBe(204);
    expect((await call('DELETE', `/v1/orgs/${org}/invites/${revoked}`, owner)).status).toBe(404);
    expect((await call('POST', '/v1/invites/accept', b, { token: revokedToken })).status).toBe(410);

    await call('POST', `/v1/orgs/${org}/invites`, owner, { email: emailOf(c) });
    const late = lastToken();
    clock += 8 * 86_400_000;
    expect((await call('POST', '/v1/invites/accept', c, { token: late })).status).toBe(410);
    expect((await call('GET', '/v1/invites', c)).body).toEqual([]);
    // An expired invitation does not block inviting the same person again.
    expect((await call('POST', `/v1/orgs/${org}/invites`, owner, { email: emailOf(c) })).status).toBe(201);
  });

  it('knows nothing about a token that does not exist', async () => {
    expect((await call('POST', '/v1/invites/accept', 'user-x', { token: 'nope' })).status).toBe(404);
    expect((await call('POST', '/v1/invites/accept', 'user-x', {})).status).toBe(404);
    expect((await call('POST', '/v1/invites/accept', 'user-x', { id: randomUUID() })).status).toBe(404);
  });

  it('lets a person find and accept their own pending invitations without the link', async () => {
    const { owner, org } = await setup();
    const g = guest();
    const made = (await call('POST', `/v1/orgs/${org}/invites`, owner, { email: emailOf(g) })).body;
    const mine = (await call('GET', '/v1/invites', g)).body;
    expect(mine).toMatchObject([{ id: made.id, orgId: org, orgName: 'Acme', orgRole: 'member' }]);
    expect((await call('GET', '/v1/invites', guest())).body).toEqual([]);
    expect((await call('POST', '/v1/invites/accept', guest(), { id: made.id })).status).toBe(403);
    expect((await call('POST', '/v1/invites/accept', g, { id: made.id })).status).toBe(200);
  });

  it('shows what a link is for, and the address only to the person it was sent to', async () => {
    const { owner, org } = await setup();
    const [g, other] = [guest(), guest()];
    sent.length = 0;
    await call('POST', `/v1/orgs/${org}/invites`, owner, { email: emailOf(g) });
    const token = lastToken();
    expect((await call('POST', '/v1/invites/lookup', g, { token })).body).toMatchObject({ orgName: 'Acme', state: 'open', forYou: true, email: emailOf(g) });
    const seen = (await call('POST', '/v1/invites/lookup', other, { token })).body;
    expect(seen).toMatchObject({ orgName: 'Acme', forYou: false });
    expect(seen.email).toBeUndefined();
  });

  it('limits guessing', async () => {
    let last = 0;
    for (let n = 0; n < 12; n++) last = (await call('POST', '/v1/invites/accept', 'user-guesser', { token: `guess-${n}` })).status;
    expect(last).toBe(429);
    clock += 61_000;
    expect((await call('POST', '/v1/invites/accept', 'user-guesser', { token: 'again' })).status).toBe(404);
  });
});

describe('resending', () => {
  it('sends a new link with a fresh expiry and cancels the old one', async () => {
    const { owner, org } = await setup();
    const g = guest();
    sent.length = 0;
    const id = (await call('POST', `/v1/orgs/${org}/invites`, owner, { email: emailOf(g) })).body.id;
    const old = lastToken();
    clock += 5 * 86_400_000;
    const again = await call('POST', `/v1/orgs/${org}/invites/${id}/resend`, owner);
    expect(again).toMatchObject({ status: 200, body: { emailed: true } });
    expect(sent).toHaveLength(2);
    expect(lastToken()).not.toBe(old);
    expect((await call('POST', '/v1/invites/accept', g, { token: old })).status).toBe(404);
    clock += 3 * 86_400_000; // past the first expiry, inside the new one
    expect((await call('POST', '/v1/invites/accept', g, { token: lastToken() })).status).toBe(200);
    expect((await call('POST', `/v1/orgs/${org}/invites/${id}/resend`, owner)).status).toBe(404);
  });
});

describe('with no mail provider', () => {
  it('returns the link to the admin instead', async () => {
    const { owner, org } = await setup();
    const bare = createApp({ db, verifyUser: async (t) => ({ id: t, email: `${t}@example.com` }), streamSecret: 's', webAppUrl: 'https://app.example.com/', now: () => clock });
    const res = await bare.request(`/v1/orgs/${org}/invites`, { method: 'POST', headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x@example.com' }) });
    const body = (await res.json()) as { link: string };
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ emailed: false });
    expect(body.link).toMatch(/^https:\/\/app\.example\.com\/invites\/[\w-]{40,}$/);
  });
});
