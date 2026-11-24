/** Settings shared by the Node services. The defaults fit running them on your machine against `docker compose up kafka rabbitmq`. */
export const env = {
  projectKey: process.env.IDA_PROJECT_KEY,
  endpoint: process.env.IDA_ENDPOINT ?? 'http://localhost:8787',
  kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(','),
  amqpUrl: process.env.AMQP_URL ?? 'amqp://guest:guest@localhost:5673',
  /** How often the storefront places an order. */
  orderEveryMs: Number(process.env.ORDER_EVERY_MS ?? 2000),
};

/** Runs `stop` on Ctrl-C or `docker compose down`, then exits. */
export function onShutdown(stop) {
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      try {
        await stop();
      } finally {
        process.exit(0);
      }
    });
  }
}
