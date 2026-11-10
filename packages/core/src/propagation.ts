/**
 * Cross-service links. A producer adapter writes the publishing occurrence into a message header; the consumer
 * adapter reads it back as `Occurrence.remoteParent`. Same format in every SDK (see `spec/README.md`).
 */

/** Header name carried on Kafka records and AMQP messages. */
export const PARENT_HEADER = 'ida-parent';

const VERSION = '1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OCC_ID = /^[A-Za-z0-9._-]{1,64}$/;

export interface RemoteParent {
  sessionId: string;
  occurrenceId: string;
}

/** `1:<sessionId>:<occurrenceId>` */
export function formatParentHeader(p: RemoteParent): string {
  return `${VERSION}:${p.sessionId}:${p.occurrenceId}`;
}

/**
 * Reads an `ida-parent` header value. Accepts a string or bytes (Kafka headers arrive as Buffers).
 * Returns undefined for anything malformed or from an unknown version, so a bad header just starts a new chain.
 */
export function parseParentHeader(value: unknown): RemoteParent | undefined {
  const text = typeof value === 'string' ? value
    : value instanceof Uint8Array ? new TextDecoder().decode(value)
    : undefined;
  if (!text) return undefined;
  const [v, sessionId, occurrenceId, ...rest] = text.split(':');
  if (v !== VERSION || rest.length || !sessionId || !occurrenceId) return undefined;
  if (!UUID.test(sessionId) || !OCC_ID.test(occurrenceId)) return undefined;
  return { sessionId: sessionId.toLowerCase(), occurrenceId };
}

export type BrokerKind = 'topic' | 'exchange' | 'queue';

/**
 * Deterministic process id for a topic, exchange or queue, so every service that uses it shares one process.
 * `kafka:<cluster>:topic:<name>`, `rabbitmq:<vhost>:exchange:<name>`. The default exchange is `(default)`.
 */
export function brokerProcessId(broker: 'kafka' | 'rabbitmq', kind: BrokerKind, name: string, cluster = ''): string {
  return [broker, cluster, kind, name === '' && kind === 'exchange' ? '(default)' : name].join(':');
}
