import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A new ingest key, `ida_<prefix>_<secret>`. Only `prefix` and `hash` are stored; `key` is shown to the user once. */
export function newIngestKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomBytes(6).toString('hex');
  const key = `ida_${prefix}_${randomBytes(24).toString('base64url')}`;
  return { key, prefix, hash: sha256(key) };
}

/** The prefix and hash to look up for a presented key, or null when it isn't shaped like one. Keys made before the rename start with `eda_` and still work. */
export function parseIngestKey(key: string): { prefix: string; hash: string } | null {
  const m = /^(?:ida|eda)_([0-9a-f]{12})_[A-Za-z0-9_-]{32}$/.exec(key);
  return m ? { prefix: m[1]!, hash: sha256(key) } : null;
}

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What a live-stream token grants, to one person in one project: one recorder's stream, or (no `recorderId`) the whole project's. */
export interface StreamGrant {
  recorderId?: string;
  projectId: string;
  userId: string;
}

export interface VerifiedStreamToken extends StreamGrant {
  /** Unique per token, so the server can refuse a second use. */
  nonce: string;
  /** Epoch ms. */
  expires: number;
}

/**
 * Short-lived, single-use tokens for the live stream. `EventSource` can't send an Authorization header, so the web app
 * trades the user's session for one of these and puts it in the stream URL. The token names the person it was made
 * for, so the server can keep checking that they still have access while the stream is open.
 */
export function signStreamToken(secret: string, grant: StreamGrant, ttlMs = 30_000, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ r: grant.recorderId ?? null, p: grant.projectId, u: grant.userId, n: randomUUID(), e: now + ttlMs })).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

/** The grant a stream token carries, or null when it is forged, malformed or expired. Does not know if it was used. */
export function verifyStreamToken(secret: string, token: string, now = Date.now()): VerifiedStreamToken | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const want = createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, 'base64url').toString()) as { r?: unknown; p?: unknown; u?: unknown; n?: unknown; e?: unknown };
    if ((typeof t.r !== 'string' && t.r !== null) || typeof t.p !== 'string' || typeof t.u !== 'string' || typeof t.n !== 'string' || typeof t.e !== 'number') return null;
    return t.e < now ? null : { ...(typeof t.r === 'string' && { recorderId: t.r }), projectId: t.p, userId: t.u, nonce: t.n, expires: t.e };
  } catch {
    return null;
  }
}
