# Troubleshooting

Every message the SDKs print starts with `[ida]` (Python logs to the `ida` logger). Find yours below, or see the FAQ at the end.

## Nothing shows up

Work through these in order:

1. **Is an adapter installed?** `configure` and `enable` don't record anything on their own. Call `enableEventEmitterRecording()`, `enableEventTargetRecording()`, `enableKafkajsRecording(Kafka)`, `enableAmqplibRecording(amqp)`, or use `ida.Emitter` / `instrument()` in Python.
2. **Is there a recorder for the emitter?** Without `enable()`, only emitters a recorder `track()`s are recorded. Look for the "no recorder is receiving it" warning below.
3. **Was setup early enough?** In the browser, listeners added before `enableEventTargetRecording` aren't recorded. For Kafka in Python, import `Producer` and `Consumer` after `instrument()`. For amqplib, call the adapter before `connect`.
4. **Is the emitter filtered out?** In Node, emitters created by packages are recorded only for events your code listens to, and Node internals not at all. See [Choose what gets recorded](guides/what-gets-recorded.md).
5. **Is the app uploading?** Look for console messages from `configure` (below). A short script may exit before its first batch is sent: `await uploader.flush()` (or `ida.cloud.get_uploader().flush()`) before exiting.
6. **Are you looking at the right project and time?** The key decides the project. The live view shows the last 5 minutes; for older events, zoom into the service and open its run from **Recordings**.

## Console messages

### "was emitted but no recorder is receiving it"

```
[ida] "order:placed" was emitted but no recorder is receiving it, so it isn't recorded (and neither are other untracked emitters). Call enable() before your events start, or connectRecorder(key).track(emitter) to record an emitter on its own recorder. ...
```

The adapter is installed without a recorder, there is no default recorder, and no recorder tracks this emitter. Call `enable()` before your events start, or `track()` the emitters you want. If leaving them unrecorded is intended, pass `{ warnIfNoRecorder: false }` to the adapter. The EventTarget ("was dispatched…"), Kafka ("a Kafka message on … went unrecorded") and RabbitMQ adapters print the same kind of warning.

### "configure() is missing a projectKey" / "isn't an ingest key" / "is missing an endpoint"

```
TypeError: [ida] configure() was given a projectKey that isn't an ingest key.
  Ingest keys start with 'ida_'. Use one made under the project's ingest keys in the web app, not an account, API or Supabase key.
```

`configure` checks its options at startup. Make an ingest key under the project's **Ingest keys** (or **Connect an app**), and check that the environment variable is actually set in the process (`process.env.IDA_PROJECT_KEY` is `undefined` if it isn't). In Python these are `ValueError`s.

### "configure() was already called"

`configure` sets up one uploader per process. Call it once at startup; to change options, `await uploader.close()` first.

### "can't reach … Recording continues"

```
[ida] can't reach https://ida.example.com (fetch failed). Recording continues: batches are kept in /app/.ida/spool and will be uploaded when the connection is back.
```

Not an error in your app: the server is unreachable, so batches are being saved. Check the `endpoint` URL and your network. Once the server is reachable you'll see "reconnected … uploaded N batches". See [Offline and delivery](concepts/offline.md).

### "refused an upload (401 …)" or "(403 …)"

```
[ida] https://ida.example.com refused an upload (401: …). Check the project key. Refused data is dropped.
```

The key is wrong, revoked, or belongs to a deleted project. Make a new key in the project. Batches refused this way are dropped, not retried.

### "refused an upload (413 …)"

A single event was too large to send even without its payload. Usually a very large event name or error stack. It was dropped.

### "invalid recorder key"

Recorder keys are 1–64 letters, digits, `.`, `_`, `:` or `-`, starting with a letter or digit. Spaces and `/` aren't allowed: use `checkout-api`, not `checkout api`.

### "enableAmqplibRecording() can't wrap amqplib's connect"

Pass the module itself: `import amqp from 'amqplib'` then `enableAmqplibRecording(amqp)`, or `require('amqplib')`.

### "run() needs a recorded consumer" (Python)

The consumer was created from a `Consumer` class imported before `ida.adapters.kafka.instrument()`. Import `confluent_kafka` after `instrument()`, or wrap it: `consumer = ida.adapters.kafka.wrap_consumer(consumer, group="payments")`.

### startBridge fails with EADDRINUSE

Another process (or another bridge) is using the port. Pass another `port`, or `port: 0` for a free one and read `bridge.port`.

## In the viewer

### "Could not connect" or stuck on "Connecting…"

The live stream couldn't open. Check that you're signed in and still have access to the project, then use **Reconnect** at the top. For a local bridge, check the address and that the process is running.

### Events from another service aren't linked

Both services must record with Ida, upload to the **same project**, and use an adapter on both ends (so the `ida-parent` header is written and read). A banner counts consumed messages whose publisher Ida has no record of. For Kafka across several clusters, use the same `cluster` name for a cluster in every service.

### Handlers are called anonymous#3

Name your functions, or use `labelHandler`. See [Naming](guides/naming.md).

### An async chain is broken

On Node older than 20.16 / 22.3, and in browsers, only synchronous causes are linked: an event emitted after an `await` starts a new chain. See [Events and causality](concepts/events-and-causality.md#how-causality-is-tracked).

## FAQ

### Does Ida slow my app down?

Recording adds a little work to every emit: looking up the template, timing the handlers, and computing the payload's shape. For typical event rates it isn't noticeable. Deep logging copies payloads, so keep it to the events you're debugging. Uploading happens in the background, in batches. On a hot path with very high event rates, use `include` or `stop()` to record less.

### What data leaves my app?

Event names, emitter and handler names, timings, error names, messages and stacks, payload **shapes**, and broker facts (topic, partition, offset, exchange, routing key, queue). Payload **values** only for events you deep-log, and message keys only with `recordKeys`. Nothing is sent unless you call `configure`.

### Is it safe to put the ingest key in front-end code?

Yes. Ingest keys can only upload to their project, never read. Someone who copies it can only send data into your project; revoke it if that happens.

### Can I use it in tests?

Yes. Use `createRecorder()` and pass it to the adapter, export the recording when a test fails, and `uninstall()` the adapter afterwards. See [Exporting recordings](guides/export-and-format.md).

### Can I use it in production?

Ida is built to be safe to leave on: it never changes what your handlers receive or how errors propagate, memory is bounded by `windowMs` and `maxEvents`, and uploads never block your code. Start with template-only recording and add deep logging only where you need it.

### Does replay run my code?

No. Replay plays recorded data back against the graph. Nothing in your app runs, and nothing is sent anywhere.
