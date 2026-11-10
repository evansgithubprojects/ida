import { EventEmitter } from 'node:events';
import { configure } from '@ida-dev/cloud';
import { connectRecorder, enable } from '@ida-dev/core';
import { enableEventEmitterRecording } from '@ida-dev/adapter-eventemitter';

// Setup, copied from the README's "upload to a project" snippet.
configure({ projectKey: process.env.IDA_PROJECT_KEY, endpoint: process.env.IDA_ENDPOINT ?? 'http://localhost:8787' });
if (!process.env.NO_ENABLE) enable();
enableEventEmitterRecording();

// An order pipeline: placed -> charge -> ship.
const orders = new EventEmitter();
const paymentsBus = new EventEmitter();
const shipping = new EventEmitter();
connectRecorder('payments').track(paymentsBus);

orders.on('order:placed', (o) => paymentsBus.emit('charge', o));
paymentsBus.on('charge', (o) => paymentsBus.emit(o.total > 100 ? 'charge:declined' : 'charge:ok', o));
paymentsBus.on('charge:ok', (o) => shipping.emit('ship', o));
shipping.on('ship', (o) => console.log(`order ${o.id} shipped`));

for (let id = 1; id <= 6; id++) orders.emit('order:placed', { id, total: id * 30 });
console.log('done');
