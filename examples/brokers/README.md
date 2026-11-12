# Kafka + RabbitMQ demo

Three small services in two languages, joined by two brokers:

```
orders (Node, kafkajs)  ──Kafka topic "orders"──▶  payments (Python, confluent-kafka + pika)
                                                          │
                                       RabbitMQ exchange "receipts" → queue "emails"
                                                          ▼
                                                  notifier (Node, amqplib)
```

- **orders** places an order every 2 seconds and publishes it to Kafka.
- **payments** charges each order and publishes a receipt to RabbitMQ. Every seventh order is over the limit and is declined, so there is an error to trace.
- **notifier** consumes the receipts and "emails" the customer.

Each service records its own events and uploads them to your Ida project. Open the project's viewer to follow one order from the storefront, through Kafka, into payments, through RabbitMQ, and out to the email. Messages carry an `ida-parent` header, so the hops between services are linked (drawn dotted).

## You need

- A local Ida server and web app. From the repo root, run `npm run dev`. The server listens on port 8787.
- A project and its ingest key. Sign in to the web app, create a project, and use **Connect an app** to make a key.
- Docker, for the brokers. The services can run in Docker too, or on your machine (see below).

## Run everything in Docker

```sh
cd examples/brokers
cp .env.example .env        # then paste your ingest key into IDA_PROJECT_KEY
cd ../..
npm run demo:brokers
```

`npm run demo:brokers` builds the Ida packages from this repo, packs them into `examples/brokers/packs`, and runs `docker compose up --build`. The Python service installs the SDK from `python/` in this repo. The demo always runs the code you are working on.

Stop it with Ctrl-C, then run `docker compose -f examples/brokers/compose.yaml down` to remove the containers.

The brokers use ports that are moved off the defaults, so they don't clash with brokers you already run:

| | Port on your machine |
|---|---|
| Kafka | 9094 |
| RabbitMQ | 5673 |
| RabbitMQ management UI | [localhost:15673](http://localhost:15673) (guest / guest) |

Inside Docker the services reach your Ida server at `http://host.docker.internal:8787`. To upload somewhere else, set `IDA_ENDPOINT` in `.env`.

## Run the services on your machine

Only the brokers run in Docker. This is handy when you are changing a service and want to restart it quickly.

```sh
cd examples/brokers
docker compose up -d kafka rabbitmq
./pack.sh && npm install

export IDA_PROJECT_KEY=...   # your ingest key
npm run orders               # in one terminal
npm run notifier             # in another

# and payments, in a third (Python 3.9 or later):
python -m venv .venv && . .venv/bin/activate
pip install "../../python[kafka,rabbitmq]"
python payments/payments.py
```

Run on your machine, the services default to `localhost:9094` for Kafka, `localhost:5673` for RabbitMQ and `http://localhost:8787` for Ida.

## Settings

| Variable | Default | |
|---|---|---|
| `IDA_PROJECT_KEY` | (required) | The project's ingest key. |
| `IDA_ENDPOINT` | `http://host.docker.internal:8787` in Docker, `http://localhost:8787` otherwise | Where the services upload. |
| `ORDER_EVERY_MS` | `2000` | How often the storefront places an order. |
| `KAFKA_BROKERS` | `kafka:9092` in Docker, `localhost:9094` otherwise | |
| `AMQP_URL` | `amqp://guest:guest@rabbitmq:5672` in Docker, `amqp://guest:guest@localhost:5673` otherwise | |

## Notes

- Each service uses one keyed recorder (`orders`, `payments`, `notifier`), so the viewer names services after them.
- payments runs its Kafka poll loop and its RabbitMQ connection on one thread, so it turns RabbitMQ heartbeats off. That is fine for a demo. A real service would give pika its own thread or use its `SelectConnection`.
- Restarting the services starts new sessions. The viewer shows every session in the time window you pick, and each past run under Recordings.
