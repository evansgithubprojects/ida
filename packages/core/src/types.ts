/** Version of the `Recording` format, written to `Recording.version` on export. */
export const RECORDING_VERSION = 1;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** How much of an occurrence was stored: `'template'` keeps only the template (shape), `'full'` also keeps the payload. */
export type Capture = 'template' | 'full';

/** How sure a finding is. Shape-only findings are always `'low'`. */
export type Confidence = 'high' | 'medium' | 'low';

/** A group of nodes that belong together, one per emitter (for example `Payments` or `button#save`). */
export interface Process {
  id: string;
  /** Display name, from `recorder.labelEmitter()` or the adapter's guess. */
  label: string;
}

/** A node in the web: either a handler, or the emitter itself (root of events fired outside any handler). */
export interface GraphNode {
  id: string;
  /** The process this node belongs to. */
  processId: string;
  /** Display name, from `recorder.labelHandler()` or the function's name. */
  label: string;
  kind: 'handler' | 'emitter';
}

/**
 * A group of events that look alike. Occurrences store a reference to their template instead of repeating this data.
 * By default the group is emitter + event name + handler set + payload shape (see `RecorderOptions.templateKey`).
 */
export interface Template {
  id: string;
  key: string;
  /** Node id of the emitter. */
  emitterId: string;
  eventName: string;
  /** Node ids of the handlers the event reached. */
  handlerIds: string[];
  /** Value-free signature of the payload: keys and types only, such as `{id:string,total:number}`. */
  payloadShape: string;
  sampleCount: number;
  /** Set when this event reaches an external system (API, DB, third party): who, by label. */
  external?: string[];
}

export interface ErrorInfo {
  name: string;
  message: string;
  stack?: string;
}

/** What one handler did when an event reached it. */
export interface HandlerResult {
  /** Node id of the handler. */
  handlerId: string;
  /** Start of the handler call, same clock as Occurrence.ts. */
  ts: number;
  /** How long the handler ran, in milliseconds. */
  durationMs: number;
  /** Set when the handler threw. */
  error?: ErrorInfo;
  /**
   * Set when `error` is not new: an earlier handler threw this same error, and it propagated out of an emit made
   * while this handler ran. Points at the first place it was thrown, which is the one failure it counts as.
   */
  rethrown?: { occurrenceId: string; handlerId: string };
}

/** One recorded emit: who called it, what it reached, and when. */
export interface Occurrence {
  id: string;
  /** The template this occurrence belongs to. */
  templateId: string;
  /** The event that was being handled when this one was emitted. */
  parentId: string | null;
  /** The handler that was running when this was emitted, or the emitter node for root events. */
  sourceNodeId: string;
  /** When the emit started, in milliseconds on the recorder's clock (`RecorderOptions.now`). */
  ts: number;
  /** How long the emit took, including all of its handlers, in milliseconds. */
  durationMs: number;
  handlerResults: HandlerResult[];
  /** 'template' = only the template (shape) is known; 'full' = payload below was captured. */
  capture: Capture;
  /** The payload, as JSON-safe data. Only present when `capture` is `'full'`. */
  payload?: JsonValue;
  /** 'inferred' is reserved for async hops once async context tracking lands. */
  causality: 'sync' | 'inferred';
  /** Emitted as an `error` event carrying an Error: treated as a taint signal. */
  signalsError?: boolean;
  /** Suspected-corrupt and policy was 'block': no handler was called. */
  blocked?: boolean;
  /** Set by the server: this reached it from the uploader's offline spool, after the fact, not as it happened. */
  late?: boolean;
}

/** One field that differs between a suspect payload and what was logged before. */
export interface DiffEntry {
  /** Dotted path into the payload, or empty for the whole payload. */
  path: string;
  /** What earlier, healthy payloads had here. */
  baseline: unknown;
  /** What the suspect payload has here. */
  actual: unknown;
}

/** One check a payload failed. */
export interface Reason {
  code: ReasonCode;
  /** Dotted path into the payload the check applies to. */
  path: string;
  /** Human-readable explanation. */
  message: string;
}

/**
 * Why a payload was flagged:
 * - `missing-field`: a field that was always present is gone
 * - `bad-value`: `NaN`, `undefined`, or another value that is never valid
 * - `type-change`: a field changed type
 * - `empty-value`: a field that was always filled is now empty
 * - `outlier`: a number far outside its usual range
 * - `format-change`: a string stopped matching its usual format
 * - `stale-payload`: identical to the previous payload although payloads normally vary
 * - `shape-changed`: the payload's overall shape differs from earlier ones
 */
export type ReasonCode =
  | 'missing-field'
  | 'bad-value'
  | 'type-change'
  | 'empty-value'
  | 'outlier'
  | 'format-change'
  | 'stale-payload'
  | 'shape-changed';

/** A payload suspected to be corrupt. It says "suspected", never "corrupt": core can't see inside your handlers. */
export interface Finding {
  id: string;
  kind: 'suspected-corrupt';
  /** The occurrence that carried the suspect payload. */
  occurrenceId: string;
  ts: number;
  confidence: Confidence;
  /** 'deep' compared payload values against logged baselines; 'shape' only compared payload shapes. */
  basis: 'deep' | 'shape';
  reasons: Reason[];
  diff: DiffEntry[];
  /** The failure this payload is suspected to come from; null when it was flagged with no error thrown. */
  taintSource: { occurrenceId: string; handlerId: string } | null;
  /** Found after the fact (the payload was emitted before the handler threw). */
  retroactive: boolean;
  /** One-line description, used by the `'console'` notifier. */
  summary: string;
  /** 'high' when the suspect payload goes to an external system, which warrants prompt attention. */
  priority: 'high' | 'normal';
  /** Labels of the external systems the payload reached. */
  externalTargets: string[];
}

/** Everything recorded in the window, as plain JSON. This is what `recorder.export()` returns and the viewer opens. */
export interface Recording {
  /** `RECORDING_VERSION` at the time of export. */
  version: number;
  /** Wall-clock start of the recorder, in epoch milliseconds. */
  startedAt: number;
  processes: Process[];
  nodes: GraphNode[];
  templates: Template[];
  occurrences: Occurrence[];
  findings?: Finding[];
  /** Stretches of time whose events were lost because the uploader's offline spool was full. */
  gaps?: Gap[];
}

/** Events recorded between `fromTs` and `toTs` that never reached the server. */
export interface Gap {
  fromTs: number;
  toTs: number;
  /** How many occurrences were dropped. */
  dropped: number;
}

/** One upload from `@ida-dev/cloud` to the server's `POST /v1/ingest`. */
export interface IngestBatch {
  /** The `connectRecorder` key. */
  recorderKey: string;
  /** One recorder run, chosen by the uploader (a UUID). */
  sessionId: string;
  /** `Recording.startedAt` for this run. */
  startedAt: number;
  /** Increases by one per batch in a session; the server ignores a `seq` it already has. */
  seq: number;
  /** Where the recorder runs, e.g. "node 24.1" or a browser user agent. */
  runtime?: string;
  /** Sent from the offline spool rather than straight away. */
  spooled?: boolean;
  messages: RecorderMessage[];
  /** Data dropped before this batch because the spool overflowed. */
  gap?: Gap;
}

/** What `recorder.subscribe()` listeners receive, and what the live bridge streams to the viewer. */
export type RecorderMessage =
  | { type: 'occurrence'; occurrence: Occurrence; template: Template; nodes: GraphNode[]; processes: Process[] }
  | { type: 'finding'; finding: Finding }
  | { type: 'snapshot'; recording: Recording };
