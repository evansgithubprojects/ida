# @ida-dev/cloud

Uploads recorders to a project in the web app, so you can browse every run and watch them live. Works in Node and browsers; the right build is picked by your runtime or bundler.

```bash
npm install @ida-dev/core @ida-dev/cloud
```

## configure

```ts
function configure(options: CloudOptions): Uploader
```

Starts uploading every keyed recorder: those made with `enable()` or `connectRecorder()` before the call (including what they already recorded) and those made after. Call it once, at startup. Recorders made with `createRecorder()` aren't uploaded.

`configure` only uploads: an adapter still has to be installed for anything to be recorded.

```js
import { configure } from '@ida-dev/cloud';
import { enable } from '@ida-dev/core';
import { enableEventEmitterRecording } from '@ida-dev/adapter-eventemitter';

configure({ projectKey: process.env.IDA_PROJECT_KEY, endpoint: '{{API_URL}}' });
enable();
enableEventEmitterRecording();
```

**Throws** at startup, with what to do, when:

- `projectKey` is missing or empty, or isn't an ingest key (`ida_…`);
- `endpoint` is missing or empty;
- `configure` was already called (`close()` the uploader it returned first).

In Node, batches are flushed when the process is about to exit (`beforeExit`). In browsers, when the tab is hidden.

### CloudOptions

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `projectKey` | `string` | required | The project's ingest key (`ida_…`). Keys can only upload, so it is safe in a browser bundle. |
| `endpoint` | `string` | required | The Ida server's URL. Batches are posted to `<endpoint>/v1/ingest`. |
| `flushMs` | `number` | `1000` | How long messages wait to be batched. |
| `maxBatch` | `number` | `500` | Most messages per batch; a full batch is sent at once. |
| `maxBatchBytes` | `number` | 1 MiB | Largest batch body. Keep it under the server's 2 MiB limit. An event too big on its own is sent without its payload (template-only). |
| `spool` | `SpoolStore \| false` | files / IndexedDB | Where batches wait while the server can't be reached. `false` drops them instead. See below. |
| `spoolMaxBytes` | `number` | 50 MiB | Spool size limit. Past it the oldest batches are dropped and recorded as a gap. |
| `onStatus` | `(status: UploadStatus) => void` | none | Called when uploads go offline, recover, or are refused. |
| `quiet` | `boolean` | `false` | Don't write connection changes to the console. |
| `runtime` | `string` | Node version / user agent | Shown with each recording in the web app. |
| `fetch` | `typeof fetch` | global `fetch` | For tests. |

See [Offline and delivery](../concepts/offline.md) for how batching, retries and the spool behave.

## Uploader

The value `configure` returns.

| Member | |
| --- | --- |
| `status` | The latest [`UploadStatus`](#uploadstatus). |
| `flush(): Promise<void>` | Sends everything recorded so far and waits for the attempt to finish. |
| `close(): Promise<void>` | Flushes, then stops uploading and removes the exit hooks. You can call `configure` again afterwards. |

```js
const uploader = configure({ projectKey, endpoint });
// at the end of a script or test
await uploader.close();
```

## UploadStatus

```ts
type UploadStatus =
  | { state: 'online' }
  | { state: 'offline'; error: string; where: string; spooled: number }
  | { state: 'recovered'; uploaded: number }
  | { state: 'rejected'; status: number; error: string };
```

| State | When | Fields |
| --- | --- | --- |
| `online` | Uploads are going through. | |
| `offline` | The server can't be reached; batches are going to the spool. | `error`: what failed. `where`: the spool's location. `spooled`: batches waiting. |
| `recovered` | Back online. | `uploaded`: spooled batches delivered. |
| `rejected` | The server refused a batch for good (bad or revoked key, malformed data, too large). It was dropped. | `status`: the HTTP status. `error`: the server's reason. |

## Spool stores

| Export | |
| --- | --- |
| `fileStore(dir = '.ida/spool')` | Files in a folder. Node only (not in the browser build). The default in Node. |
| `indexedDbStore(name = 'ida-spool')` | An IndexedDB database. The default in browsers. |
| `memoryStore()` | In memory: survives outages but not restarts. Used in browsers without IndexedDB. |

```js
import { configure, fileStore } from '@ida-dev/cloud';
configure({ projectKey, endpoint, spool: fileStore('/var/tmp/my-app-ida') });
```

A `SpoolStore` is any object with `where: string` (shown in messages) and async `list()`, `write(id, data)`, `read(id)` and `remove(id)`, if you need to keep batches elsewhere.

## Exports

| Export | Node | Browser |
| --- | --- | --- |
| `configure` | ✓ | ✓ |
| `fileStore` | ✓ | |
| `indexedDbStore`, `memoryStore` | ✓ | ✓ |
| `CloudOptions`, `Uploader`, `UploadStatus`, `SpoolStore` (types) | ✓ | ✓ |

The type definitions follow the same split: Node resolution (`"moduleResolution": "nodenext"`) sees the Node exports, and `"bundler"` resolution sees the browser ones, so a browser app can't import `fileStore` by mistake. A Node app compiled with `"bundler"` resolution that needs `fileStore` can add `"customConditions": ["node"]` to its `tsconfig.json`.
