import { EventEmitter } from 'node:events';
import amqp, { type ChannelModel } from 'amqplib';
import { Kafka, Partitioners, logLevel } from 'kafkajs';
import type { Recorder } from '@ida-dev/core';
import { enableAmqplibRecording } from '@ida-dev/adapter-amqplib';
import { enableKafkajsRecording } from '@ida-dev/adapter-kafkajs';

/**
 * The shop's broker leg, for the system view. Confirmed orders leave Payments through Kafka and come back as
 * shipping labels through RabbitMQ:
 *
 *   payments  order:confirmed -> publishOrder  --Kafka topic "orders"-->
 *   warehouse packOrder -> order:packed -> requestLabel  --RabbitMQ exchange "shipping" (label.print)-->
 *   shipping  queue "labels": printLabel -> label:printed
 *
 * Each side records on its own recorder, so payments, warehouse and shipping show as separate services.
 * Scripted bug 5: an order confirmed with a bad total (the rounding bug and the chargeback) crosses Kafka untouched
 * and only fails in the warehouse, where `requestLabel` formats the total.
 * Start the brokers first: `npm run brokers -w @ida-dev/demo` (Docker).
 */
export async function startBrokers(opts: {
  payments: Recorder;
  warehouse: Recorder;
  shipping: Recorder;
  /** The shop's Payments emitter: confirmed orders are published from it. */
  paymentsBus: EventEmitter;
}) {
  const kafkaBrokers = (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(',');
  const amqpUrl = process.env.AMQP_URL ?? 'amqp://guest:guest@localhost:5673';
  const { payments, warehouse, shipping, paymentsBus } = opts;

  enableKafkajsRecording(Kafka);
  enableAmqplibRecording(amqp);

  // One Kafka client per service, so each records on its own recorder.
  const kafkaOptions = { brokers: kafkaBrokers, logLevel: logLevel.WARN, retry: { retries: 2 } };
  const paymentsKafka = new Kafka({ clientId: 'payments', ...kafkaOptions });
  const warehouseKafka = new Kafka({ clientId: 'warehouse', ...kafkaOptions });
  payments.track(paymentsKafka);
  warehouse.track(warehouseKafka);

  let warehouseConn: ChannelModel;
  let shippingConn: ChannelModel;
  const producer = paymentsKafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });
  const consumer = warehouseKafka.consumer({ groupId: 'warehouse' });
  try {
    const admin = paymentsKafka.admin();
    await admin.connect();
    // createTopics logs an error when the topic is already there, so look first.
    if (!(await admin.listTopics()).includes('orders')) {
      await admin.createTopics({ topics: [{ topic: 'orders', numPartitions: 1 }], waitForLeaders: true });
    }
    await admin.disconnect();
    await producer.connect();
    await consumer.connect();
    warehouseConn = await amqp.connect(amqpUrl);
    shippingConn = await amqp.connect(amqpUrl);
  } catch (err) {
    throw new Error(
      `[demo] can't reach Kafka (${kafkaBrokers.join(',')}) or RabbitMQ (${amqpUrl.replace(/\/\/.*@/, '//')}). ` +
      'Start them with `npm run brokers -w @ida-dev/demo`, or leave DEMO_BROKERS unset.',
      { cause: err },
    );
  }
  warehouse.track(warehouseConn);
  shipping.track(shippingConn);

  // Payments: every confirmed order goes to the warehouse over Kafka.
  paymentsBus.on('order:confirmed', function publishOrder(order: { id: string; total: unknown; items: string[] }) {
    producer.send({ topic: 'orders', messages: [{ key: order.id, value: JSON.stringify(order) }] })
      .catch((err) => console.warn(`[demo] kafka send failed: ${err.message}`));
  });

  // Warehouse: packs each order and asks shipping for a label over RabbitMQ.
  const warehouseBus = new EventEmitter();
  warehouse.track(warehouseBus);
  warehouse.labelEmitter(warehouseBus, 'Warehouse');
  const outbox = await warehouseConn.createChannel();
  await outbox.assertExchange('shipping', 'direct', { durable: false });

  warehouseBus.on('order:packed', function requestLabel(order: { id: string; total: number; boxes: number }) {
    // Throws for a total that isn't a number: the bug that started in Payments surfaces here.
    const label = { orderId: order.id, boxes: order.boxes, declaredValue: order.total.toFixed(2) };
    outbox.publish('shipping', 'label.print', Buffer.from(JSON.stringify(label)));
  });

  await consumer.subscribe({ topic: 'orders', fromBeginning: false });
  await consumer.run({
    eachMessage: async function packOrder({ message }) {
      const order = JSON.parse(message.value!.toString());
      try {
        warehouseBus.emit('order:packed', { id: order.id, total: order.total, boxes: Math.ceil(order.items.length / 2) });
      } catch {
        /* swallowed so Kafka doesn't redeliver forever; Ida still records the throw */
      }
    },
  });

  // Shipping: prints the labels.
  const shippingBus = new EventEmitter();
  shipping.track(shippingBus);
  shipping.labelEmitter(shippingBus, 'Shipping');
  shippingBus.on('label:printed', function trackParcel() {});
  const inbox = await shippingConn.createChannel();
  await inbox.assertExchange('shipping', 'direct', { durable: false });
  await inbox.assertQueue('labels', { durable: false });
  await inbox.bindQueue('labels', 'shipping', 'label.print');
  await inbox.consume('labels', function printLabel(msg) {
    if (!msg) return;
    const label = JSON.parse(msg.content.toString());
    shippingBus.emit('label:printed', { orderId: label.orderId, carrier: label.boxes > 1 ? 'freight' : 'post' });
    inbox.ack(msg);
  });

  console.log(`[demo] broker leg on: Kafka ${kafkaBrokers.join(',')}, RabbitMQ ${amqpUrl.replace(/\/\/.*@/, '//')}`);

  return {
    close: async () => {
      await consumer.disconnect().catch(() => {});
      await producer.disconnect().catch(() => {});
      await warehouseConn.close().catch(() => {});
      await shippingConn.close().catch(() => {});
    },
  };
}
