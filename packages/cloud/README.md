# @eda-debugger/cloud

Uploads [Ida](../../README.md) recorders to a project on the Ida server, so you can browse their recordings and watch them live in the web app. Works in Node and browsers.

```bash
npm install @eda-debugger/core @eda-debugger/cloud
```

## Setup

Create a project in the web app and make an ingest key, then call `configure` once at startup:

```ts
import { configure } from '@eda-debugger/cloud';
import { connectRecorder } from '@eda-debugger/core';

configure({ projectKey: process.env.EDA_PROJECT_KEY!, endpoint: 'https://your-server' });

const payments = connectRecorder('payments'); // anywhere in your app
```

Every recorder made with `connectRecorder()` or `enable()` is uploaded: those that exist already (including what they recorded before `configure`) and those created later. Each run of your app becomes one recording of each recorder.

Ingest keys can only upload, so a key in a browser bundle can't read anything. Revoke a leaked key in the web app.

## When the server can't be reached

Recording carries on. Batches go to a spool, and the console says where:

```
[eda-debugger] can't reach https://your-server (fetch failed). Recording continues: batches are kept in /app/.eda-debugger/spool and will be uploaded when the connection is back.
[eda-debugger] reconnected to https://your-server; uploaded 16 batches recorded while offline.
```

- Retries back off from 1 s to 60 s. Batches are delivered in order, and a batch the server already has is not stored twice.
- The spool is files under `.eda-debugger/spool` in Node and IndexedDB in browsers, so it survives a restart; batches left by an earlier run are uploaded at startup.
- Past `spoolMaxBytes` the oldest batches are dropped, and the server is told what was lost. The web app shows those gaps on the timeline, and marks events that arrived late.
- A batch the server refuses for good (unknown or revoked key, malformed data) is dropped, with one console error.

## Options

| Option | Default | |
| --- | --- | --- |
| `projectKey` | required | The project's ingest key (`ida_…`). |
| `endpoint` | required | The server URL. |
| `flushMs` | `1000` | How long messages wait to be batched. |
| `maxBatch` | `500` | Most messages per batch; a full batch is sent at once. |
| `maxBatchBytes` | 1 MiB | Largest batch body; keep it under the server's 2 MiB limit. An event too big on its own is sent without its payload (template-only). |
| `spool` | files / IndexedDB | A `SpoolStore` (`fileStore(dir)`, `indexedDbStore(name)`, `memoryStore()`), or `false` to drop what can't be sent. |
| `spoolMaxBytes` | 50 MiB | Spool size limit. |
| `onStatus` | — | Called with `{ state: 'offline' \| 'recovered' \| 'rejected' \| 'online', … }` for your own UI. |
| `quiet` | `false` | Don't write connection changes to the console. |
| `runtime` | Node version / user agent | Shown with each recording. |

`configure` returns an `Uploader` with `status`, `flush()` and `close()`. In Node it flushes before the process exits; in browsers, when the page is hidden.
