# Overview

Ida is a debugger for event-driven code. It records every event your app emits within a time window, shows how those events connect, and replays the timeline so you can watch pathways light up as each event fires. When something goes wrong three handlers away from where it started, Ida lets you follow the chain back to the root.

Ida records JavaScript (Node and the browser) and Python, in-process emitters and messages that travel between services through Kafka or RabbitMQ.

## What Ida records

An **event** is who emitted it, what handled it, and what it carried:

- **Emitter**: the object the event was emitted on, plus the handler that was running when it was emitted, if any.
- **Handlers**: every listener the event reached, with how long each took and anything it threw.
- **Payload**: the data passed along. By default only its *shape* is kept (`{orderId:string,total:number}`), not its values. You choose which events keep full payloads.

Each event points at the event that caused it: if `chargeCard` runs because `order:placed` fired, and it emits `payment:ok`, then `payment:ok`'s parent is `order:placed`. Following those links gives you a **chain**. Handlers are the nodes of a chain, and one handler can sit in many chains, so all of them together form a **web**.

## How you use it

1. **Install** the core package and the adapter for what your events go through (Node `EventEmitter`, DOM `EventTarget`, Kafka, RabbitMQ, or Python's `ida.Emitter`).
2. **Enable** recording once at startup. Adapters hook the dispatcher, so you never instrument emit calls one by one.
3. **View** the recording in the Ida web app: upload it to a project with an ingest key, stream it live, or export it to a JSON file.

In the viewer you can:

- Play, pause and scrub through the timeline, and choose the slice of time to replay.
- Zoom from processes, into one process's handlers, into one handler's activity.
- Click any node or pathway to inspect payloads, timings and errors.
- Trace one message from the event that started it to everything it caused, across services.

Replay never re-runs your code. It plays the recorded data back against the graph, so it is safe and deterministic.

## Where to start

| If you have | Start with |
| --- | --- |
| A Node app | [Quick start: Node.js](quickstart/node.md) |
| A web page or front-end app | [Quick start: browser](quickstart/browser.md) |
| A Python service | [Quick start: Python](quickstart/python.md) |
| Services talking through Kafka or RabbitMQ | [Tracing messages across services](guides/brokers.md) |

Then read [Events and causality](concepts/events-and-causality.md) and [Recorders](concepts/recorders.md) to understand what you are looking at, and [the replay guide](viewer/replay.md) to get the most out of the viewer.

## Packages

| Package | What it does |
| --- | --- |
| `@ida-dev/core` | The recorder: templates, causality, suspected-corruption detection, JSON export, local live streaming. |
| `@ida-dev/adapter-eventemitter` | Records Node `EventEmitter`s and everything built on them. |
| `@ida-dev/adapter-eventtarget` | Records DOM `EventTarget`s: native events such as clicks, and `dispatchEvent`. |
| `@ida-dev/adapter-kafkajs` | Records Kafka producers and consumers made with `kafkajs`. |
| `@ida-dev/adapter-amqplib` | Records RabbitMQ publishes and deliveries made with `amqplib`. |
| `@ida-dev/cloud` | Uploads recorders to a project in the web app, and keeps batches safe while offline. |
| `ida-sdk` (PyPI) | The Python SDK: recorder, `ida.Emitter`, uploads, and adapters for `confluent-kafka` and `pika`. |

The full list of functions and options is in the [API reference](reference/core.md).
