// Emails receipts: consumes the RabbitMQ queue `emails`, which the `receipts` exchange routes payments' receipts to.
import { EventEmitter } from 'node:events';
import amqp from 'amqplib';
import { configure } from '@ida-dev/cloud';
import { connectRecorder, setDefaultRecorder } from '@ida-dev/core';
import { enableAmqplibRecording } from '@ida-dev/adapter-amqplib';
import { enableEventEmitterRecording } from '@ida-dev/adapter-eventemitter';
import { env, onShutdown } from './env.js';

const uploader = configure({ projectKey: env.projectKey, endpoint: env.endpoint });
setDefaultRecorder(connectRecorder('notifier'));
enableEventEmitterRecording();
enableAmqplibRecording(amqp);

class Mailer extends EventEmitter {}
const mailer = new Mailer();
mailer.on('email.sent', function logDelivery(email) {
  console.log(`[notifier] emailed ${email.to} about ${email.orderId}`);
});

const connection = await amqp.connect(env.amqpUrl);
const channel = await connection.createChannel();
await channel.assertExchange('receipts', 'direct', { durable: false });
await channel.assertQueue('emails', { durable: false });
await channel.bindQueue('emails', 'receipts', 'receipt.send');

await channel.consume('emails', function sendEmail(msg) {
  const receipt = JSON.parse(msg.content.toString());
  mailer.emit('email.sent', { to: `${receipt.customer}@example.com`, orderId: receipt.orderId, amount: receipt.amount });
  channel.ack(msg);
});

console.log(`[notifier] consuming "emails" on ${env.amqpUrl.replace(/\/\/.*@/, '//')}`);

onShutdown(async () => {
  await connection.close();
  await uploader.close();
});
