import { EventEmitter } from 'node:events';
import { configure } from '@ida-dev/cloud';
import { connectRecorder, enable } from '@ida-dev/core';
import { enableEventEmitterRecording } from '@ida-dev/adapter-eventemitter';

// 1. Upload every recorder to your project. Without a key the app still runs and just records locally.
const projectKey = process.env.IDA_PROJECT_KEY;
const uploader = projectKey
  ? configure({ projectKey, endpoint: process.env.IDA_ENDPOINT ?? 'http://localhost:8787' })
  : null;
if (!uploader) console.log('[quickstart] No IDA_PROJECT_KEY, so nothing is uploaded. See README.md.');

// 2. Record every EventEmitter the app creates. enable() makes the default recorder that catches everything
//    not tracked by a keyed one; without it, untracked emitters are silently not recorded.
enable();
enableEventEmitterRecording();

// 3. A small order pipeline: placed -> charged -> shipped. Each emit is caused by the handler before it.
class Orders extends EventEmitter {}
class Payments extends EventEmitter {}
class Shipping extends EventEmitter {}

const orders = new Orders();
const payments = new Payments();
const shipping = new Shipping();

// Give the payments emitter its own recorder; everything else goes to the default one.
connectRecorder('payments').track(payments);

orders.on('order:placed', (order) => payments.emit('charge', order));
payments.on('charge', (order) => {
  if (order.total > 100) return payments.emit('charge:declined', order);
  payments.emit('charge:ok', order);
});
payments.on('charge:ok', (order) => shipping.emit('ship', order));
payments.on('charge:declined', (order) => console.log(`[quickstart] order ${order.id} declined`));
shipping.on('ship', (order) => console.log(`[quickstart] order ${order.id} shipped`));

for (let id = 1; id <= 6; id++) orders.emit('order:placed', { id, total: id * 30 });

await uploader?.close(); // flush what's recorded before the process exits
console.log('[quickstart] done');
