import { EventEmitter } from 'node:events';

/** A login request as it reaches the gateway. `body` is whatever the client sent. */
export interface LoginRequest {
  ip: string;
  path: string;
  body: unknown;
}

/** The two things attackers go through: the front door (`gateway`) and the login check behind it. */
export interface Auth {
  /** Emits `session:created` for every successful login; the shop hangs its chain off it. */
  sessions: EventEmitter;
  /** Sends a login request through the gateway. Errors are swallowed, like in the shop, so bad data keeps flowing. */
  login(username: unknown, password: unknown, ip: string): void;
  /** Sends an arbitrary body (what a malicious client does). */
  request(req: LoginRequest): void;
  /** What the security system has done so far, for the dashboard. */
  stats: { throttled: number; locked: number; failed: number; succeeded: number; errors: number };
}

/** More attempts than this from one address inside a second get it throttled. */
const MAX_ATTEMPTS_PER_SECOND = 20;
/** How long a throttled address is blocked at the gateway. Short, so a sustained attack keeps tripping it. */
const BLOCK_MS = 1500;
/** Failed logins in a row on one account before it is locked. */
const LOCK_AFTER = 5;

/**
 * The shop's authentication, as a chain of events:
 *
 *   Gateway `request` -> Auth `login:attempt` -> Auth `login:succeeded` -> Sessions `session:created`
 *                                              -> Auth `login:failed`    -> Security `account:locked`
 *                        (too many per second) -> Security `ip:throttled`
 *
 * `parseLoginRequest` is deliberately lax: it forwards the body's fields as they are, so a malformed request becomes a
 * malformed `login:attempt` payload. That's what the corrupt-request attack exploits and what Ida should flag.
 */
export function createAuth(label: (e: EventEmitter, name: string) => void, markExternal: (fn: Function) => void = () => {}): Auth {
  const gateway = new EventEmitter();
  const auth = new EventEmitter();
  const sessions = new EventEmitter();
  const security = new EventEmitter();
  label(gateway, 'Gateway');
  label(auth, 'Auth');
  label(sessions, 'Sessions');
  label(security, 'Security');

  const stats = { throttled: 0, locked: 0, failed: 0, succeeded: 0, errors: 0 };
  const blockedUntil = new Map<string, number>();
  const attempts = new Map<string, number[]>();
  const failures = new Map<string, { count: number; since: number }>();
  let tokenSeq = 0;

  const isNormalUser = (u: unknown) => typeof u === 'string' && /^u\d+$/.test(u);

  gateway.on('request', function parseLoginRequest(req: LoginRequest) {
    if ((blockedUntil.get(req.ip) ?? 0) > Date.now()) return; // dropped at the door
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown; attempt?: unknown };
    auth.emit('login:attempt', { ip: req.ip, username: body.username, password: body.password, attempt: body.attempt ?? 1 });
  });

  auth.on('login:attempt', function rateLimit(a: { ip: string }) {
    const now = Date.now();
    const recent = (attempts.get(a.ip) ?? []).filter((at) => now - at < 1000);
    recent.push(now);
    attempts.set(a.ip, recent);
    // One alert per second per address, not one per request.
    if (recent.length === MAX_ATTEMPTS_PER_SECOND + 1) security.emit('ip:throttled', { ip: a.ip, attempts: recent.length });
  });

  auth.on('login:attempt', function checkPassword(a: { ip: string; username: string; password: string }) {
    // Throws a TypeError when the password isn't a string: that is what a corrupt request does to this handler.
    const password = a.password.trim();
    const ok = (isNormalUser(a.username) && password === 'correct-password') || (a.username === 'admin' && password === 'S3cure!admin');
    if (ok) auth.emit('login:succeeded', { userId: a.username, ip: a.ip });
    else auth.emit('login:failed', { userId: a.username, ip: a.ip, reason: isNormalUser(a.username) || a.username === 'admin' ? 'bad-password' : 'unknown-user' });
  });

  auth.on('login:succeeded', function issueSession(u: { userId: string }) {
    stats.succeeded++;
    failures.delete(u.userId);
    sessions.emit('session:created', { userId: u.userId, token: `tok_${String(++tokenSeq).padStart(8, '0')}` });
  });

  auth.on('login:failed', function countFailures(f: { userId: string }) {
    stats.failed++;
    const now = Date.now();
    const cur = failures.get(f.userId);
    const entry = cur && now - cur.since < 10_000 ? cur : { count: 0, since: now };
    entry.count++;
    failures.set(f.userId, entry);
    if (entry.count % LOCK_AFTER === 0) security.emit('account:locked', { userId: f.userId, failures: entry.count });
  });

  security.on('ip:throttled', function blockIp(t: { ip: string }) {
    stats.throttled++;
    blockedUntil.set(t.ip, Date.now() + BLOCK_MS);
  });
  security.on('account:locked', function lockAccount() {
    stats.locked++;
  });

  // Simulated call to an outside paging service: suspect payloads reaching this are high priority in Ida.
  const alertSecurityTeam = function alertSecurityTeam(_alert: { ip?: string; userId?: string }) {};
  markExternal(alertSecurityTeam);
  security.on('ip:throttled', alertSecurityTeam);
  security.on('account:locked', alertSecurityTeam);

  const request = (req: LoginRequest) => {
    try {
      gateway.emit('request', req);
    } catch {
      stats.errors++; // the app swallows what it can't handle, which is what lets bad data leak
    }
  };

  return {
    sessions,
    stats,
    request,
    login: (username, password, ip) => request({ ip, path: '/login', body: { username, password, attempt: 1 } }),
  };
}
