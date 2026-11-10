import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { brokerProcessId, formatParentHeader, parseParentHeader } from '../src/propagation';
import { defaultTemplateKey, payloadShape } from '../src/templates';

/** The cross-SDK conformance suite in spec/fixtures. Python's tests load the same files. */
const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../spec/fixtures/${name}`, import.meta.url)), 'utf8'));

/** Turns the fixture tags back into the values JSON can't hold. */
const revive = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.$nan === true) return NaN;
    if (typeof o.$bytes === 'string') return Buffer.from(o.$bytes, 'base64');
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, revive(x)]));
  }
  return v;
};

describe('spec: payload shapes', () => {
  for (const c of fixture('payload-shapes.json').cases) {
    it(c.name, () => expect(payloadShape(revive(c.input))).toBe(c.shape));
  }
  it('treats a plain Uint8Array like a Buffer', () => expect(payloadShape(new Uint8Array([1]))).toBe('bytes'));
});

describe('spec: template keys', () => {
  for (const c of fixture('template-keys.json').cases) {
    it(c.key, () => expect(defaultTemplateKey(c.parts)).toBe(c.key));
  }
});

describe('spec: ida-parent header', () => {
  const f = fixture('propagation.json');
  for (const c of f.format) it(`formats ${c.header}`, () => expect(formatParentHeader(c.parent)).toBe(c.header));
  for (const c of f.parse) {
    it(`parses ${JSON.stringify(c.header)}`, () => expect(parseParentHeader(c.header) ?? null).toEqual(c.parent));
  }
  it('reads a header that arrives as bytes', () => {
    expect(parseParentHeader(Buffer.from(f.format[0].header))).toEqual(f.format[0].parent);
  });
  for (const c of f.brokerProcessIds) {
    it(c.id, () => expect(brokerProcessId(...(c.args as [never, never, string, string]))).toBe(c.id));
  }
});
