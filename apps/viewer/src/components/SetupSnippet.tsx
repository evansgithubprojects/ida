import { API_URL } from '../cloud/supabase';

export const LANGUAGES = [
  { id: 'node', label: 'Node.js' },
  { id: 'browser', label: 'JavaScript (browser)' },
  { id: 'python', label: 'Python' },
] as const;
export type Language = (typeof LANGUAGES)[number]['id'];

/** What an app's events go through. Each has a docs page at `/docs/<id>`. */
export const SOURCES = [
  { id: 'eventemitter', label: 'EventEmitter', blurb: "Node's built-in emitters, and every library built on them." },
  { id: 'eventtarget', label: 'EventTarget', blurb: 'DOM events and anything else that dispatches through EventTarget.' },
  { id: 'kafka', label: 'Kafka', blurb: 'Producers and consumers, linked across services by a message header.' },
  { id: 'rabbitmq', label: 'RabbitMQ', blurb: 'Publishes and deliveries through exchanges and queues, linked across services.' },
] as const;
export type Source = (typeof SOURCES)[number]['id'];

interface Setup {
  /** The client library the adapter wraps, when it isn't the language's own. */
  library?: string;
  install: string;
  /** `key` is the project key, or a placeholder; `endpoint` the server URL. */
  code(key: string, endpoint: string): string;
  /** Publishing and consuming once set up, for a docs page. */
  example?: string;
}

/** Setup for each language and event source that has an adapter. */
export const SETUPS: Record<Language, Partial<Record<Source, Setup>>> = {
  node: {
    eventemitter: {
      install: 'npm install @ida-dev/core @ida-dev/cloud @ida-dev/adapter-eventemitter',
      code: (key, endpoint) => `# .env
IDA_PROJECT_KEY=${key}

import { configure } from '@ida-dev/cloud';
import { connectRecorder, enable } from '@ida-dev/core';
import { enableEventEmitterRecording } from '@ida-dev/adapter-eventemitter';

configure({ projectKey: process.env.IDA_PROJECT_KEY, endpoint: '${endpoint}' });
enable(); // records every emitter nothing else claims
enableEventEmitterRecording();

// anywhere in your app
connectRecorder('payments').track(paymentsBus);`,
    },
    kafka: {
      library: 'kafkajs',
      install: 'npm install @ida-dev/core @ida-dev/cloud @ida-dev/adapter-kafkajs',
      code: (key, endpoint) => `# .env
IDA_PROJECT_KEY=${key}

import { Kafka } from 'kafkajs';
import { configure } from '@ida-dev/cloud';
import { connectRecorder, enable } from '@ida-dev/core';
import { enableKafkajsRecording } from '@ida-dev/adapter-kafkajs';

configure({ projectKey: process.env.IDA_PROJECT_KEY, endpoint: '${endpoint}' });
enable();
enableKafkajsRecording(Kafka); // before you create producers and consumers

const kafka = new Kafka({ brokers: ['localhost:9092'] });
connectRecorder('checkout').track(kafka); // optional: name this service`,
      example: `const producer = kafka.producer();
await producer.connect();
await producer.send({ topic: 'orders', messages: [{ value: JSON.stringify(order) }] });

const consumer = kafka.consumer({ groupId: 'payments' });
await consumer.connect();
await consumer.subscribe({ topic: 'orders' });
await consumer.run({
  eachMessage: async ({ message }) => chargeCard(JSON.parse(message.value.toString())),
});`,
    },
    rabbitmq: {
      library: 'amqplib',
      install: 'npm install @ida-dev/core @ida-dev/cloud @ida-dev/adapter-amqplib',
      code: (key, endpoint) => `# .env
IDA_PROJECT_KEY=${key}

import amqp from 'amqplib';
import { configure } from '@ida-dev/cloud';
import { connectRecorder, enable } from '@ida-dev/core';
import { enableAmqplibRecording } from '@ida-dev/adapter-amqplib';

configure({ projectKey: process.env.IDA_PROJECT_KEY, endpoint: '${endpoint}' });
enable();
enableAmqplibRecording(amqp); // pass the module itself, before connecting

const connection = await amqp.connect('amqp://localhost');
connectRecorder('notifier').track(connection); // optional: name this service`,
      example: `const channel = await connection.createChannel();
await channel.assertExchange('receipts', 'direct');
channel.publish('receipts', 'receipt.send', Buffer.from(JSON.stringify(receipt)));

await channel.assertQueue('emails');
await channel.bindQueue('emails', 'receipts', 'receipt.send');
await channel.consume('emails', (msg) => {
  sendEmail(JSON.parse(msg.content.toString()));
  channel.ack(msg);
});`,
    },
  },
  browser: {
    eventtarget: {
      install: 'npm install @ida-dev/core @ida-dev/cloud @ida-dev/adapter-eventtarget',
      code: (key, endpoint) => `import { configure } from '@ida-dev/cloud';
import { connectRecorder } from '@ida-dev/core';
import { enableEventTargetRecording } from '@ida-dev/adapter-eventtarget';

configure({ projectKey: '${key}', endpoint: '${endpoint}' });

const recorder = connectRecorder('page');
enableEventTargetRecording(recorder);`,
    },
  },
  python: {
    kafka: {
      library: 'confluent-kafka',
      install: 'pip install "ida-sdk[kafka]"',
      code: (key, endpoint) => `# .env
IDA_PROJECT_KEY=${key}

import os
import ida, ida.cloud, ida.adapters.kafka

ida.cloud.configure(project_key=os.environ["IDA_PROJECT_KEY"], endpoint="${endpoint}")
ida.enable()
ida.adapters.kafka.instrument()

from confluent_kafka import Consumer, Producer  # import after instrument()`,
      example: `producer = Producer({"bootstrap.servers": "localhost:9092"})
producer.produce("orders", value=json.dumps(order))

consumer = Consumer({"bootstrap.servers": "localhost:9092", "group.id": "payments"})
consumer.subscribe(["orders"])
ida.adapters.kafka.run(consumer, charge_card)  # charge_card(message) for each message`,
    },
    rabbitmq: {
      library: 'pika',
      install: 'pip install "ida-sdk[rabbitmq]"',
      code: (key, endpoint) => `# .env
IDA_PROJECT_KEY=${key}

import os
import ida, ida.cloud, ida.adapters.rabbitmq

ida.cloud.configure(project_key=os.environ["IDA_PROJECT_KEY"], endpoint="${endpoint}")
ida.enable()
ida.adapters.rabbitmq.instrument()`,
      example: `connection = pika.BlockingConnection(pika.ConnectionParameters("localhost"))
channel = connection.channel()
channel.basic_publish(exchange="receipts", routing_key="receipt.send", body=json.dumps(receipt))

def send_email(ch, method, properties, body): ...
channel.basic_consume(queue="emails", on_message_callback=send_email)
channel.start_consuming()`,
    },
    eventemitter: {
      install: 'pip install ida-sdk',
      code: (key, endpoint) => `# .env
IDA_PROJECT_KEY=${key}

import os
import ida, ida.cloud

ida.cloud.configure(project_key=os.environ["IDA_PROJECT_KEY"], endpoint="${endpoint}")
ida.enable()

orders = ida.Emitter("Orders")  # records every emit and handler

@orders.on("placed")
def reserve_stock(order): ...

orders.emit("placed", {"orderId": "o-1"})`,
    },
  },
};

/** The event sources a language has an adapter for, in `SOURCES` order. */
export const sourcesFor = (language: Language) => SOURCES.filter((s) => SETUPS[language][s.id]);

/** The languages with an adapter for a source, in `LANGUAGES` order. */
export const languagesFor = (source: Source) => LANGUAGES.filter((l) => SETUPS[l.id][source]);

/** Install and configure steps for an app that uploads to a project. `projectKey` is filled in when it is known. */
export function SetupSnippet({ language, source, projectKey }: { language: Language; source?: Source; projectKey?: string | null }) {
  const setup = SETUPS[language][source ?? sourcesFor(language)[0]!.id] ?? SETUPS[language][sourcesFor(language)[0]!.id]!;
  return <pre className="snippet">{`${setup.install}\n\n${setup.code(projectKey ?? 'ida_…', API_URL)}`}</pre>;
}
