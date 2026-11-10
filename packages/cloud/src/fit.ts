import type { RecorderMessage } from '@ida/core';

const encoder = new TextEncoder();
/** UTF-8 size of `value` as JSON: what it costs in a request body. */
export const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;

/**
 * `message` as one or more messages that each fit in `maxBytes`, losing as little as possible:
 * - a snapshot too big to send is split into several, each with part of the occurrences;
 * - an occurrence too big because of its captured payload is sent without it, as template-only, which is how the
 *   viewer will label it;
 * - anything still too big is dropped (returned as `dropped`).
 */
export function fitMessage(message: RecorderMessage, maxBytes: number): { fits: RecorderMessage[]; dropped: number } {
  if (jsonBytes(message) <= maxBytes) return { fits: [message], dropped: 0 };

  if (message.type === 'occurrence' && message.occurrence.payload !== undefined) {
    const { payload: _payload, ...occurrence } = message.occurrence;
    return fitMessage({ ...message, occurrence: { ...occurrence, capture: 'template' } }, maxBytes);
  }

  if (message.type === 'snapshot' && message.recording.occurrences.length > 1) {
    const { occurrences } = message.recording;
    const half = Math.ceil(occurrences.length / 2);
    // The graph (processes, nodes, templates) and findings go with the first half; the server merges snapshots.
    const first: RecorderMessage = { type: 'snapshot', recording: { ...message.recording, occurrences: occurrences.slice(0, half) } };
    const rest: RecorderMessage = {
      type: 'snapshot',
      recording: { ...message.recording, processes: [], nodes: [], templates: [], findings: [], occurrences: occurrences.slice(half) },
    };
    const a = fitMessage(first, maxBytes);
    const b = fitMessage(rest, maxBytes);
    return { fits: [...a.fits, ...b.fits], dropped: a.dropped + b.dropped };
  }

  if (message.type === 'snapshot' && message.recording.occurrences.length === 1) {
    const [only] = message.recording.occurrences;
    const graph: RecorderMessage = { type: 'snapshot', recording: { ...message.recording, occurrences: [] } };
    if (only!.payload !== undefined && jsonBytes(graph) <= maxBytes) {
      const { payload: _payload, ...bare } = only!;
      return fitMessage({ type: 'snapshot', recording: { ...message.recording, occurrences: [{ ...bare, capture: 'template' }] } }, maxBytes);
    }
  }

  return { fits: [], dropped: 1 };
}
