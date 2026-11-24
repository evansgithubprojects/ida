import type { Template } from './types';

const MAX_DEPTH = 4;
const MAX_KEYS = 40;

/**
 * Stable, value-free signature of a payload: keys (sorted) and types only.
 * `{id:string,items:number[],total:number}`. NaN/undefined/null are kept distinct on purpose.
 */
export function payloadShape(value: unknown, depth = 0, seen: Set<object> = new Set()): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'undefined': return 'undefined';
    case 'number': return Number.isNaN(value) ? 'NaN' : 'number';
    case 'string': case 'boolean': case 'bigint': case 'symbol': return typeof value;
    case 'function': return 'function';
  }
  const obj = value as object;
  if (seen.has(obj)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '…';
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const kinds = new Set<string>();
      for (const item of obj.slice(0, 20)) kinds.add(payloadShape(item, depth + 1, seen));
      if (kinds.size === 0) return '[]';
      const inner = [...kinds].sort().join('|');
      return (kinds.size > 1 ? `(${inner})` : inner) + '[]';
    }
    if (obj instanceof Date) return 'Date';
    if (obj instanceof Error) return 'Error';
    if (obj instanceof Map) return 'Map';
    if (obj instanceof Set) return 'Set';
    const keys = Object.keys(obj).sort();
    const body = keys.slice(0, MAX_KEYS).map((k) => `${k}:${payloadShape((obj as Record<string, unknown>)[k], depth + 1, seen)}`);
    if (keys.length > MAX_KEYS) body.push('…');
    const ctor = (obj as { constructor?: { name?: string } }).constructor?.name;
    return (ctor && ctor !== 'Object' ? ctor : '') + `{${body.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

export interface TemplateParts {
  emitterId: string;
  eventName: string;
  handlerIds: string[];
  payloadShape: string;
}

export type TemplateKeyFn = (parts: TemplateParts) => string;

/** emitter + event name + handler set + payload shape. Pass a coarser function to group differently. */
export const defaultTemplateKey: TemplateKeyFn = (p) =>
  [p.emitterId, p.eventName, [...p.handlerIds].sort().join(','), p.payloadShape].join('|');

/** Interns templates by key and counts their occurrences. @internal */
export class TemplateRegistry {
  private byKey = new Map<string, Template>();
  private byId = new Map<string, Template>();
  private seq = 0;

  constructor(private keyFn: TemplateKeyFn = defaultTemplateKey) {}

  intern(parts: TemplateParts): Template {
    const key = this.keyFn(parts);
    let t = this.byKey.get(key);
    if (!t) {
      t = {
        id: `t${++this.seq}`, key, emitterId: parts.emitterId, eventName: parts.eventName,
        handlerIds: [...parts.handlerIds], payloadShape: parts.payloadShape, sampleCount: 0,
      };
      this.byKey.set(key, t);
      this.byId.set(t.id, t);
    }
    t.sampleCount++;
    return t;
  }

  /** Called when an occurrence is evicted; drops the template once nothing references it. */
  release(id: string): void {
    const t = this.byId.get(id);
    if (!t || --t.sampleCount > 0) return;
    this.byId.delete(id);
    this.byKey.delete(t.key);
  }

  get(id: string): Template | undefined { return this.byId.get(id); }
  all(): Template[] { return [...this.byId.values()]; }
  clear(): void { this.byKey.clear(); this.byId.clear(); }
}
