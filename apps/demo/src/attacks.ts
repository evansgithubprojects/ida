import type { Auth } from './auth';

export type AttackName = 'brute-force' | 'overload';

export interface AttackStatus {
  running: boolean;
  /** Requests the attacker has sent so far (the gateway may drop some of them once an address is blocked). */
  sent: number;
  elapsedMs: number;
  durationMs: number;
}

interface Run extends AttackStatus {
  startedAt: number;
  abort: AbortController;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Calls `send(i)` at `perSecond` for `durationMs`, catching up if the loop ran late, so the rate holds even when the
 * process is busy. Ends early when `signal` aborts.
 */
async function paced(signal: AbortSignal, durationMs: number, perSecond: number, send: (i: number) => void): Promise<void> {
  const start = Date.now();
  const total = Math.ceil((durationMs * perSecond) / 1000);
  let i = 0;
  while (!signal.aborted) {
    const elapsed = Date.now() - start;
    if (elapsed >= durationMs) break;
    const due = Math.min(Math.floor((elapsed * perSecond) / 1000) + 1, total);
    while (i < due) send(i++);
    await sleep(20);
  }
}

/** What a hostile client might put in a login body. Each is a different way for the payload to be wrong. */
const MALFORMED: Array<(i: number) => unknown> = [
  (i) => ({ username: `u${i % 9}` }), // no password
  (i) => ({ username: `u${i % 9}`, password: 100000 + i }), // a number
  () => ({ username: 'u1', password: { $ne: null } }), // an injection-style object
  () => ({ username: null, password: 'x' }),
  () => ({ username: 'u2', password: '' }),
  () => ({ username: 'u3', password: 'A'.repeat(5000) }), // far longer than any password
  () => ({ username: 'u4', password: 'x', $where: { sleep: 100 } }), // an extra, nested field
  () => ({ username: 'u5', password: 'x', attempt: NaN }),
];

/** The two simulated attacks. Each one only calls the same `Auth` entry points normal traffic uses. */
export function createAttacks(auth: Auth) {
  const runs = new Map<AttackName, Run>();

  const status = (name: AttackName): AttackStatus => {
    const r = runs.get(name);
    if (!r) return { running: false, sent: 0, elapsedMs: 0, durationMs: 0 };
    return { running: r.running, sent: r.sent, elapsedMs: r.running ? Date.now() - r.startedAt : r.elapsedMs, durationMs: r.durationMs };
  };

  async function launch(name: AttackName, durationMs: number, perSecond: number, send: (i: number) => void) {
    runs.get(name)?.abort.abort(); // starting again restarts it
    const run: Run = { running: true, sent: 0, elapsedMs: 0, durationMs, startedAt: Date.now(), abort: new AbortController() };
    runs.set(name, run);
    console.log(`[demo] attack started: ${name}`);
    await paced(run.abort.signal, durationMs, perSecond, (i) => { run.sent++; send(i); });
    if (runs.get(name) === run) {
      run.running = false;
      run.elapsedMs = Date.now() - run.startedAt;
      console.log(`[demo] attack ${run.abort.signal.aborted ? 'stopped' : 'finished'}: ${name} (${run.sent} requests)`);
    }
  }

  return {
    /** One address guesses passwords for `admin` (and now and then a few other accounts), far faster than a person could. */
    bruteForce: () => {
      const targets = ['admin', 'admin', 'admin', 'root', 'admin', 'u3', 'admin', 'administrator'];
      return launch('brute-force', 8000, 40, (i) =>
        auth.login(targets[i % targets.length], `password${i}`, '203.0.113.7'));
    },
    /** A flood of malformed login requests from a handful of addresses. */
    overload: () =>
      launch('overload', 6000, 250, (i) =>
        auth.request({ ip: `192.0.2.${(i % 10) + 1}`, path: '/login', body: MALFORMED[i % MALFORMED.length]!(i) })),
    stop: () => { for (const r of runs.values()) r.abort.abort(); },
    status: () => ({ 'brute-force': status('brute-force'), overload: status('overload') }),
  };
}
