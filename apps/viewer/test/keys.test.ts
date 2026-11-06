import { describe, expect, it } from 'vitest';
import { newIngestKey } from '../../server/src/keys';
import { maskKey } from '../src/cloud/keys';

describe('maskKey', () => {
  it('shows only `ida_` and masks the rest, as long as a real key', () => {
    const real = newIngestKey().key;
    expect(maskKey()).toBe(`ida_${'•'.repeat(real.length - 'ida_'.length)}`);
  });
});
