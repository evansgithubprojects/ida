import { onRecorder, type IngestBatch, type Recorder, type RecorderMessage } from '@ida-dev/core';
import { fitMessage, jsonBytes } from './fit';
import { memoryStore, Spool, type SpoolStore } from './spool';

export interface CloudOptions {
  /** The project's ingest key from the web app (`ida_…`). It can only write, so it is safe in a browser bundle. */
  projectKey: string;
  /** The server, e.g. `https://api.example.com`. */
  endpoint: string;
  /** How long messages wait to be batched, in milliseconds. @default 1000 */
  flushMs?: number;
  /** Most messages per batch; a full batch is sent straight away. @default 500 */
  maxBatch?: number;
  /**
   * Largest batch body, in bytes. Keep it under the server's limit (2 MiB by default). An event too big on its own is
   * sent without its captured payload (template-only). @default 1 MiB
   */
  maxBatchBytes?: number;
  /**
   * Where batches wait while the server can't be reached. `false` keeps nothing: what can't be sent is dropped.
   * @default files under `.ida/spool` in Node, IndexedDB in browsers
   */
  spool?: SpoolStore | false;
  /** Most bytes the spool keeps; past that the oldest data is dropped and reported as a gap. @default 50 MiB */
  spoolMaxBytes?: number;
  /** Called when uploads go offline, recover, or are refused. The console is told too unless `quiet`. */
  onStatus?: (status: UploadStatus) => void;
  /** Don't write connection changes to the console. @default false */
  quiet?: boolean;
  /** Shown with each session in the web app. @default the Node version or the browser's user agent */
  runtime?: string;
  /** For tests. */
  fetch?: typeof fetch;
}

export type UploadStatus =
  | { state: 'online' }
  /** The server can't be reached: batches are going to the spool. */
  | { state: 'offline'; error: string; where: string; spooled: number }
  /** Back online: `uploaded` batches waiting in the spool were delivered. */
  | { state: 'recovered'; uploaded: number }
  /** The server refused a batch for good (bad or revoked key, malformed data). It was dropped. */
  | { state: 'rejected'; status: number; error: string };

export interface Uploader {
  readonly status: UploadStatus;
  /** Sends everything recorded so far, waiting for the attempt to finish. */
  flush(): Promise<void>;
  /** Flushes, then stops uploading. */
  close(): Promise<void>;
}

interface Stream {
  recorder: Recorder;
  sessionId: string;
  startedAt: number;
  seq: number;
  pending: RecorderMessage[];
  unsubscribe: () => void;
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

/** A configuration mistake: the one-line problem comes first so it is what a skimmer reads, then what to do about it. */
function configError(problem: string, fix: string, caller: Function): TypeError {
  const err = new TypeError(`[ida] ${problem}\n  ${fix}`);
  // Start the stack at the user's `configure(...)` call, not inside this package (V8 only; elsewhere it is just longer).
  (Error as { captureStackTrace?: (e: Error, fn: Function) => void }).captureStackTrace?.(err, caller);
  return err;
}

/**
 * Fails at startup, with what to do, when the project key or endpoint is missing or can't be right. Left unchecked, a
 * missing key only shows up later as "can't reach <endpoint>" or a refused upload, which points at the wrong thing.
 * `caller` is the function the stack should start below: `configure`, so the first frame is the user's own call.
 */
export function checkOptions(opts: Pick<CloudOptions, 'projectKey' | 'endpoint'>, caller: Function = checkOptions): void {
  const key = typeof opts.projectKey === 'string' ? opts.projectKey.trim() : '';
  if (!key) {
    throw configError(
      'configure() is missing a projectKey.',
      "Create a project in the web app, make an ingest key and pass it: configure({ projectKey: process.env.IDA_PROJECT_KEY, endpoint }).",
      caller,
    );
  }
  // Keys made before the rename start with `eda_` and still work.
  if (!/^(ida|eda)_/.test(key)) {
    throw configError(
      "configure() was given a projectKey that isn't an ingest key.",
      "Ingest keys start with 'ida_'. Use one made under the project's ingest keys in the web app, not an account, API or Supabase key.",
      caller,
    );
  }
  if (typeof opts.endpoint !== 'string' || !opts.endpoint.trim()) {
    throw configError(
      'configure() is missing an endpoint.',
      "Pass the URL of your Ida server: configure({ projectKey, endpoint: 'https://api.example.com' }).",
      caller,
    );
  }
}

export function createUploader(opts: CloudOptions, defaultStore: () => SpoolStore | null, defaultRuntime: string): Uploader {
  checkOptions(opts, createUploader);
  const doFetch = opts.fetch ?? fetch;
  const url = `${opts.endpoint.replace(/\/$/, '')}/v1/ingest`;
  const flushMs = opts.flushMs ?? 1000;
  const maxBatch = opts.maxBatch ?? 500;
  // Room for the batch envelope around the messages.
  const budget = (opts.maxBatchBytes ?? 1024 * 1024) - 1024;
  const store = opts.spool === false ? null : (opts.spool ?? defaultStore() ?? memoryStore());
  const spool = store ? new Spool(store, opts.spoolMaxBytes) : null;
  const runtime = opts.runtime ?? defaultRuntime;
  const streams: Stream[] = [];
  const ready: IngestBatch[] = [];
  let status: UploadStatus = { state: 'online' };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let sending: Promise<void> | null = null;
  let closed = false;
  let rejectedOnce = false;

  const setStatus = (s: UploadStatus) => {
    status = s;
    opts.onStatus?.(s);
    if (opts.quiet) return;
    if (s.state === 'offline') {
      console.warn(`[ida] can't reach ${opts.endpoint} (${s.error}). Recording continues: batches are kept in ${s.where} and will be uploaded when the connection is back.`);
    } else if (s.state === 'recovered') {
      console.info(`[ida] reconnected to ${opts.endpoint}; uploaded ${s.uploaded} batch${s.uploaded === 1 ? '' : 'es'} recorded while offline.`);
    } else if (s.state === 'rejected' && !rejectedOnce) {
      rejectedOnce = true;
      const hint = s.status === 401 || s.status === 403 ? ' Check the project key.' : '';
      console.error(`[ida] ${opts.endpoint} refused an upload (${s.status}: ${s.error}).${hint} Refused data is dropped.`);
    }
  };

  const schedule = () => {
    if (timer || closed) return;
    timer = setTimeout(() => { timer = null; void flush(); }, flushMs);
    (timer as { unref?: () => void }).unref?.();
  };

  /** Turns a stream's pending messages into batches, each within `maxBatch` messages and the byte budget. */
  const cut = (s: Stream) => {
    let messages: RecorderMessage[] = [];
    let bytes = 0;
    let dropped = 0;
    const emit = () => {
      if (messages.length) ready.push({ recorderKey: s.recorder.key, sessionId: s.sessionId, startedAt: s.startedAt, seq: s.seq++, runtime, messages });
      messages = [];
      bytes = 0;
    };
    for (const pending of s.pending.splice(0)) {
      const fit = fitMessage(pending, budget);
      dropped += fit.dropped;
      for (const m of fit.fits) {
        const size = jsonBytes(m) + 1;
        if (messages.length && (messages.length >= maxBatch || bytes + size > budget)) emit();
        messages.push(m);
        bytes += size;
      }
    }
    emit();
    if (dropped) setStatus({ state: 'rejected', status: 413, error: `${dropped} message${dropped === 1 ? ' was' : 's were'} too large to upload even without payloads, and dropped` });
  };

  const attach = (recorder: Recorder) => {
    // What the recorder already holds goes first, as one snapshot, so events from before `configure` aren't lost.
    const recording = recorder.export();
    const s: Stream = {
      recorder, sessionId: recorder.sessionId, startedAt: recording.startedAt, seq: 0,
      pending: recording.occurrences.length ? [{ type: 'snapshot', recording }] : [], unsubscribe: () => {},
    };
    s.unsubscribe = recorder.subscribe((m) => {
      s.pending.push(m);
      if (s.pending.length >= maxBatch) void flush();
      else schedule();
    });
    streams.push(s);
    if (s.pending.length) schedule();
  };

  type Sent = 'ok' | 'retry' | 'refused';
  const post = async (batch: IngestBatch): Promise<{ result: Sent; error: string; status?: number }> => {
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.projectKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
      if (res.ok) return { result: 'ok', error: '' };
      const error = await res.text().then((t) => { try { return JSON.parse(t).error ?? t; } catch { return t; } }, () => res.statusText);
      // Retry what may succeed later; anything else would fail the same way forever.
      const transient = res.status >= 500 || res.status === 429 || res.status === 408;
      return { result: transient ? 'retry' : 'refused', error: String(error || res.statusText), status: res.status };
    } catch (err) {
      return { result: 'retry', error: err instanceof Error ? err.message : String(err) };
    }
  };

  const goOffline = async (error: string, batch?: IngestBatch) => {
    if (batch) await spool?.push(batch);
    if (status.state !== 'offline') setStatus({ state: 'offline', error, where: store?.where ?? 'nowhere (spool disabled)', spooled: (await spool?.size()) ?? 0 });
    if (!retry && !closed) {
      retry = setTimeout(() => { retry = null; void flush(); }, BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]);
      (retry as { unref?: () => void }).unref?.();
    }
  };

  /** Spooled batches first, oldest first; then the ones just cut. Stops at the first failure. */
  const drain = async () => {
    let uploaded = 0;
    for (let b = await spool?.peek(); b; b = await spool?.peek()) {
      const r = await post({ ...b, spooled: true });
      if (r.result === 'retry') return goOffline(r.error);
      if (r.result === 'refused') setStatus({ state: 'rejected', status: r.status!, error: r.error });
      await spool!.shift();
      uploaded++;
    }
    // Recovered from an outage, or delivered what an earlier run of the app left in the spool.
    if (status.state === 'offline' || uploaded) {
      attempt = 0;
      setStatus({ state: 'recovered', uploaded });
    }
    while (ready.length) {
      const batch = ready.shift()!;
      const r = await post(batch);
      if (r.result === 'retry') {
        // Keep the order: this batch and every one after it waits in the spool.
        await goOffline(r.error, batch);
        while (ready.length) await spool?.push(ready.shift()!);
        return;
      }
      if (r.result === 'refused') setStatus({ state: 'rejected', status: r.status!, error: r.error });
    }
  };

  async function flush(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null; }
    streams.forEach(cut);
    if (sending) {
      await sending;
      if (!ready.length) return;
    }
    sending = (async () => {
      if (status.state === 'offline' && retry) {
        // Waiting out a backoff: queue behind the spool rather than jump ahead of it.
        while (ready.length) await spool?.push(ready.shift()!);
        if (!spool) ready.length = 0;
        return;
      }
      await drain();
    })().finally(() => { sending = null; });
    return sending;
  }

  const stopWatching = onRecorder(attach);
  // Batches left in the spool by an earlier run go up as soon as possible.
  void spool?.size().then((n) => { if (n) void flush(); });

  return {
    get status() { return status; },
    flush,
    async close() {
      stopWatching();
      streams.forEach((s) => s.unsubscribe());
      await flush();
      closed = true;
      if (timer) clearTimeout(timer);
      if (retry) clearTimeout(retry);
    },
  };
}
