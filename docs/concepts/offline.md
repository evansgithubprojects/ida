# Offline and delivery

`@ida-dev/cloud` (and `ida.cloud` in Python) uploads what your recorders capture in small batches. This page covers what happens when the server can't be reached, and how the viewer shows it.

## Batching

Messages wait up to `flushMs` (1 s) to be grouped into a batch. A batch is sent sooner once it holds `maxBatch` (500) messages or reaches `maxBatchBytes` (1 MiB; the server accepts up to 2 MiB). Batches are also flushed:

- in Node, when the process is about to exit (`beforeExit`);
- in browsers, when the tab is hidden;
- in Python, at exit, for up to 3 seconds.

Call `uploader.flush()` (JavaScript, from the value `configure` returns) or `ida.cloud.get_uploader().flush()` (Python) to upload right away, for example at the end of a short script or a test.

## When the server can't be reached

Recording carries on and your app isn't slowed down or failed. The uploader:

1. Writes the batches it can't send to a **spool**, in order.
2. Says so once on the console (or the `ida` logger in Python):

   ```
   [ida] can't reach https://ida.example.com (fetch failed). Recording continues: batches are kept in /app/.ida/spool and will be uploaded when the connection is back.
   ```

3. Retries with backoff: 1 s, 2 s, 5 s, 10 s, 30 s, then every 60 s.
4. On recovery, uploads the spool in order and says so:

   ```
   [ida] reconnected to https://ida.example.com; uploaded 16 batches recorded while offline.
   ```

Network errors, `5xx`, `408` and `429` responses are retried this way.

### Where the spool lives

| Runtime | Default spool |
| --- | --- |
| Node | Files in `.ida/spool` under the working directory. Add `.ida/` to `.gitignore`. |
| Browser | IndexedDB database `ida-spool` (memory if IndexedDB isn't available). |
| Python | Files in `.ida/spool`, the same layout as Node, so either SDK can deliver what the other left. |

The spool survives restarts: batches left by an earlier run are uploaded when the app next starts. Choose another location with `spool: fileStore(dir)` / `indexedDbStore(name)` (Python: `FileStore(dir)`), keep it in memory with `memoryStore()`, or turn it off with `spool: false` to drop what can't be sent.

> **Note:** two processes sharing one spool folder will deliver each other's batches. Give each app (or each instance on one machine) its own folder.

### When the spool fills up

The spool is limited to `spoolMaxBytes` (50 MiB). Past that, the oldest batches are dropped, and the server is told how many events were lost and when. The viewer shows that stretch as a **gap** on the timeline, and the recording is marked **gaps** in the Recordings list.

## Duplicates and order

Each batch carries the recording's `sessionId` and a sequence number. The server stores a `(sessionId, seq)` pair once, so a batch sent twice (for example, when a response is lost) is never recorded twice. Batches are delivered in order.

## Late events

Events uploaded from the spool are marked **late**. The viewer draws a small tick at the top of the timeline where late events arrived, so you know the live view didn't show them at the time.

## Refused batches

A batch the server refuses for good (an unknown or revoked key, malformed data) is dropped, with one console error. For `401` and `403` the message ends with "Check the project key." A single event too large to send even without its payload is dropped and reported the same way, with status `413`.

## Watching the connection yourself

```js
configure({
  projectKey, endpoint,
  quiet: true, // no console output
  onStatus: (s) => {
    // s.state: 'online' | 'offline' | 'recovered' | 'rejected'
    if (s.state === 'offline') showBanner(`Ida offline, ${s.spooled} batches waiting`);
  },
});
```

See [`UploadStatus`](../reference/cloud.md#uploadstatus) for every field.
