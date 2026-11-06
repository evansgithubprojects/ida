import type { EventEmitter } from 'node:events';
import { configure } from '@eda-debugger/cloud';
import { connectRecorder, setDefaultRecorder } from '@eda-debugger/core';
import { enableEventEmitterRecording } from '@eda-debugger/adapter-eventemitter';
import { createAttacks } from './attacks';
import { createAuth } from './auth';
import { startDashboard } from './dashboard';
import { createShop } from './shop';

/**
 * The shop, uploaded to a project. Payments get their own recorder; everything else goes to `shop`.
 *   npm run node -w @eda-debugger/demo [-- --outage]   (reads EDA_PROJECT_KEY from apps/demo/.env)
 * The attack simulator is served at http://localhost:5175 (DEMO_PORT): brute force and corrupt-request overload.
 * `--outage` cuts the connection for 8 s out of every 20, to watch the spool and the recovery.
 */
try { process.loadEnvFile(); } catch { /* no .env */ }
const waitForKey = (): Promise<never> => {
  console.log('[demo] No EDA_PROJECT_KEY. Create a project in the web app, make an ingest key, and put it in apps/demo/.env (see .env.example). Waiting...');
  return new Promise<never>(() => setInterval(() => {}, 1 << 30));
};
const projectKey = process.env.EDA_PROJECT_KEY || (await waitForKey());
const endpoint = process.env.EDA_ENDPOINT ?? 'http://localhost:8787';
const outage = process.argv.includes('--outage');

let down = false;
if (outage) {
  setInterval(() => {
    down = true;
    console.log('[demo] --- connection cut ---');
    setTimeout(() => { down = false; console.log('[demo] --- connection restored ---'); }, 8_000);
  }, 20_000);
}

configure({
  projectKey,
  endpoint,
  fetch: (async (url, init) => {
    if (down) throw new TypeError('fetch failed (simulated outage)');
    return fetch(url, init);
  }) as typeof fetch,
});

/** During an attack the console would print hundreds of lines, so suspect payloads are summed up once a second instead. */
let suspects = 0;
setInterval(() => {
  if (suspects) console.log(`[demo] ${suspects} suspect payload${suspects === 1 ? '' : 's'} in the last second`);
  suspects = 0;
}, 1000).unref();

const options = {
  deepLogging: { events: ['order:confirmed', 'charge', 'notify', 'request', 'login:attempt', 'session:created'] },
  corruption: { notify: [() => { suspects++; }] },
};
const shop = connectRecorder('shop', options);
const payments = connectRecorder('payments', options);
setDefaultRecorder(shop);
enableEventEmitterRecording();

const label = (e: EventEmitter, name: string) => {
  if (name === 'Payments') payments.track(e);
  (name === 'Payments' ? payments : shop).labelEmitter(e, name);
};
const markExternal = (fn: Function) => { shop.markExternal(fn); payments.markExternal(fn); };

const auth = createAuth(label, markExternal);
const app = createShop(auth, label, markExternal);
const attacks = createAttacks(auth);

let rounds = 0;
startDashboard({ port: Number(process.env.DEMO_PORT) || 5175, attacks, auth, idaUrl: process.env.IDA_URL ?? 'http://localhost:5173', normal: () => ({ rounds }) });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
console.log(`[demo] uploading to ${endpoint}${outage ? ' with simulated outages' : ''}; open the project in the web app`);
for (let round = 1; ; round++) {
  rounds = round;
  for (let i = 1; i <= 3; i++) {
    app.login(round * 10 + i);
    for (const total of [20 + i, 35 + i, 50 + i]) {
      app.checkout(total);
      await sleep(300);
    }
  }
  app.checkout(44, round % 2 ? 'rounding-bug' : 'chargeback');
  await sleep(1_000);
}
