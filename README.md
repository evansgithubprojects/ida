# Ida

Ida helps you understand code that runs on events. In event-driven code, one part of your app sends an event and other parts react to it, often in another file or another service. That makes it hard to see what actually happened and why.

Ida records the events your app sends, which handler received each one, what data it carried, and which earlier event caused it. It then draws them as a map you can play back like a video: you watch each step light up in order, pause on any of them, and see the data that was passed.

Ida never re-runs your code during playback. It only shows what was recorded.

**Full documentation** is in [`docs/`](docs/overview.md) and is also served by the web app at `/docs`.

## What it works with

**Languages**

- JavaScript and TypeScript, in Node and in the browser
- Python 3.9 or later

**Events it can record**

- Node's built-in `EventEmitter`
- Browser events such as clicks and inputs, and your own `CustomEvent`s
- Python events sent with `ida.Emitter`
- Kafka messages, with kafkajs (JavaScript) or confluent-kafka (Python)
- RabbitMQ messages, with amqplib (JavaScript) or pika (Python)

When services talk through Kafka or RabbitMQ, Ida links a message sent by one service to the code that handled it in another, even when the two services are written in different languages.

## What you can do with it

- **See the whole system.** Each service appears as a card, with arrows for the messages that pass between services. Kafka topics and RabbitMQ queues sit between the services that use them.
- **Zoom in.** Go from services, to the parts of one service that send events, to the individual handlers, to everything one handler did: the events it received, how long each one took, and any errors.
- **Play it back.** Play, pause and scrub through the recording, and choose which stretch of time to replay.
- **Inspect anything.** Click a card, an arrow or an event to see its details and data.
- **Follow an error to its cause.** Errors appear as notifications. Clicking one shows a step-by-step path of the events that led to it, across services.
- **Spot bad data.** When a handler fails and the code keeps going, Ida checks whether the data sent afterwards looks different from before, and flags it as *possibly* bad. You can mark handlers that talk to outside systems, such as a billing API, so warnings about them are raised as high priority.
- **Watch live.** Recordings upload as your app runs, and the viewer follows them as they arrive.

## Getting started

1. Sign in to the Ida web app and create a project.
2. Click **Connect an app** to get a **project key**. The key lets your app send recordings to the project. It can't read anything, so it's safe to put in a browser app.
3. Add a few lines to your app's startup code, before it sets up its events.

**Node**

```bash
npm install @ida-dev/core @ida-dev/cloud @ida-dev/adapter-eventemitter
```

```ts
import { configure } from '@ida-dev/cloud';
import { enable } from '@ida-dev/core';
import { enableEventEmitterRecording } from '@ida-dev/adapter-eventemitter';

configure({ projectKey: process.env.IDA_PROJECT_KEY!, endpoint: 'https://your-ida-server' });
enable();                      // start recording
enableEventEmitterRecording(); // record every EventEmitter in the app
```

**Browser**

```bash
npm install @ida-dev/core @ida-dev/cloud @ida-dev/adapter-eventtarget
```

```ts
import { configure } from '@ida-dev/cloud';
import { enable } from '@ida-dev/core';
import { enableEventTargetRecording } from '@ida-dev/adapter-eventtarget';

configure({ projectKey: 'ida_…', endpoint: 'https://your-ida-server' });
enable();
enableEventTargetRecording();
```

**Python**

```bash
pip install ida-sdk                  # add [kafka] and/or [rabbitmq] to record those
```

```python
import os
import ida
import ida.cloud

ida.cloud.configure(project_key=os.environ["IDA_PROJECT_KEY"], endpoint="https://your-ida-server")
ida.enable()
```

4. Run your app, open the project in the web app, and click **Open viewer**.

The [quick start guide](docs/quickstart.md) goes through this step by step. To link services that use Kafka or RabbitMQ, see [Tracing messages across services](docs/guides/brokers.md).

### Without an account

You can also save a recording to a file and open it in the viewer. The file is read in your browser and isn't uploaded.

```ts
const recorder = enable({ windowMs: 60_000 }); // keep the last 60 seconds
enableEventEmitterRecording(recorder);
// ... run your app ...
fs.writeFileSync('recording.json', JSON.stringify(recorder.export()));
```

In the viewer, open **Recordings** and click **Open file…**, or drag the file onto the page.

## Good to know

- **Ida keeps the last stretch of time, not everything.** You choose how long (`windowMs`). Older events are dropped so memory use stays bounded.
- **The data your events carry isn't saved unless you ask for it.** By default, Ida saves the *shape* of the data (its field names and types) and groups events that look alike, which keeps recordings small. To save the actual values for particular events, list them:

  ```ts
  enable({ deepLogging: { events: ['order:confirmed'] } });
  ```

  The viewer shows, for each event, whether its full data was saved.
- **Losing the connection doesn't lose data.** If your app can't reach the server, recordings wait on disk (or in browser storage) and upload, in order, when the connection comes back. The viewer marks anything that arrived late, or was lost because the waiting space filled up.
- **Clocks don't have to agree.** Each service's clock can be a little off. Ida corrects for this so messages play back in the order they really happened.
- **Waiting code is followed in Node and Python.** When a handler waits (an `await`, a timer) and then sends another event, Ida still knows which event caused it. Browsers don't support this yet, so in the browser only events sent straight away are linked.

## Teams

Every project belongs to an organization, and signing up creates one with you as its owner. Owners and admins can open every project in the organization and invite people by email. Members open only the projects they're given, either to view or also to manage project keys. See [Projects and teams](docs/projects.md).

## Contributing

Contributions are welcome. Bug reports and feature ideas go in [GitHub issues](https://github.com/evansgithubprojects/ida/issues). Code changes go in pull requests against the `release` branch.

To run Ida locally you need Node 20 or later and a [Supabase](https://supabase.com) project for sign-in:

```bash
npm install
cp apps/server/.env.example apps/server/.env   # set SUPABASE_URL
cp apps/viewer/.env.example apps/viewer/.env.local
npm run dev    # the server, the web app at http://localhost:5173, and a demo app that sends events
npm test
```

A few things to know before you open a pull request:

- **Add or update tests** for what you change, and make sure `npm test` and `npm run typecheck` pass.
- **The JavaScript and Python packages must record the same way.** The rules they share, and the test cases both must pass, are in [`spec/`](spec/README.md). A change to how events are recorded usually means updating both packages and the spec.
- **Update the docs** in [`docs/`](docs/overview.md) when you change something people use.

To see what is planned, and find a place to start, read the [roadmap](ROADMAP.md).
