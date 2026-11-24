// The storefront: places an order every few seconds and publishes it to the Kafka topic `orders`.
import { EventEmitter } from 'node:events';
import { Kafka, Partitioners, logLevel } from 'kafkajs';
import { configure } from '@ida-dev/cloud';
import { connectRecorder, setDefaultRecorder } from '@ida-dev/core';
import { enableEventEmitterRecording } from '@ida-dev/adapter-eventemitter';
import { enableKafkajsRecording } from '@ida-dev/adapter-kafkajs';
import { env, onShutdown } from './env.js';

// Everything this service records goes to one recorder, so it shows up as `orders` in the system view.
const uploader = configure({ projectKey: env.projectKey, endpoint: env.endpoint });
setDefaultRecorder(connectRecorder('orders'));
enableEventEmitterRecording();
enableKafkajsRecording(Kafka);

const kafka = new Kafka({ clientId: 'orders', brokers: env.kafkaBrokers, logLevel: logLevel.WARN });
const producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });

class Storefront extends EventEmitter {}
const shop = new Storefront();

shop.on('order.placed', async function publishOrder(order) {
  await producer.send({ topic: 'orders', messages: [{ key: order.id, value: JSON.stringify(order) }] });
});
shop.on('order.placed', function reserveStock(order) {
  shop.emit('stock.reserved', { orderId: order.id, items: order.items.length });
});

const admin = kafka.admin();
await admin.connect();
await admin.createTopics({ topics: [{ topic: 'orders', numPartitions: 1 }], waitForLeaders: true });
await admin.disconnect();
await producer.connect();

let n = 0;
const timer = setInterval(() => {
  n++;
  const items = Array.from({ length: 1 + (n % 3) }, (_, i) => ({ sku: `sku-${(n + i) % 7}`, qty: 1 + (i % 2) }));
  // Every seventh order is too expensive, so payments declines it and you can trace the error.
  const total = n % 7 === 0 ? 950 + n : 20 + ((n * 37) % 300);
  shop.emit('order.placed', { id: `o-${n}`, customer: `c-${n % 5}`, items, total });
}, env.orderEveryMs);

console.log(`[orders] placing an order every ${env.orderEveryMs} ms on ${env.kafkaBrokers.join(',')}`);

onShutdown(async () => {
  clearInterval(timer);
  await producer.disconnect();
  await uploader.close();
});
