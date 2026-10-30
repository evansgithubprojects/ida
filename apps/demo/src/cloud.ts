import type { EventEmitter } from 'node:events';
import { configure } from '@eda-debugger/cloud';
import { connectRecorder, setDefaultRecorder } from '@eda-debugger/core';
import { enableEventEmitterRecording } from '@eda-debugger/adapter-eventemitter';
import { createShop } from './app';

/**
 * The shop, uploaded to a project. Payments get their own recorder; everything else goes to `shop`.
 *   EDA_PROJECT_KEY=eda_… npm run cloud -w @eda-debugger/demo [-- --outage]
 * `--outage` cuts the connection for 8 s out of every 20, to watch the spool and the recovery.
 */
const projectKey = process.env.EDA_PROJECT_KEY;
if (!projectKey) {
  console.error('[demo] set EDA_PROJECT_KEY to an ingest key from your project page');
  process.exit(1);
}
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

const options = { deepLogging: { events: ['order:confirmed', 'charge', 'notify'] }, corruption: { notify: 'console' as const } };
const shop = connectRecorder('shop', options);
const payments = connectRecorder('payments', options);
setDefaultRecorder(shop);
enableEventEmitterRecording();

const app = createShop(
  (e: EventEmitter, name: string) => {
    if (name === 'Payments') payments.track(e);
    (name === 'Payments' ? payments : shop).labelEmitter(e, name);
  },
  (fn) => { shop.markExternal(fn); payments.markExternal(fn); },
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
console.log(`[demo] uploading to ${endpoint}${outage ? ' with simulated outages' : ''}; open the project in the web app`);
for (let round = 1; ; round++) {
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
