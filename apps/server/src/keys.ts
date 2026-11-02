import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

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

/**
 * Short-lived tokens for the live stream. `EventSource` can't send an Authorization header, so the web app trades
 * the user's session for one of these and puts it in the stream URL.
 */
export function signStreamToken(secret: string, recorderId: string, ttlMs = 60_000, now = Date.now()): string {
  const body = `${recorderId}.${now + ttlMs}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

/** The recorder id a stream token grants, or null when it is forged or expired. */
export function verifyStreamToken(secret: string, token: string, now = Date.now()): string | null {
  const [recorderId, exp, sig] = token.split('.');
  if (!recorderId || !exp || !sig || Number(exp) < now) return null;
  const want = createHmac('sha256', secret).update(`${recorderId}.${exp}`).digest();
  const got = Buffer.from(sig, 'base64url');
  return got.length === want.length && timingSafeEqual(got, want) ? recorderId : null;
}
