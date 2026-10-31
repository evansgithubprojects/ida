import { describe, expect, it } from 'vitest';
import { maskKey } from '../src/cloud/keys';

describe('maskKey', () => {
  it('keeps the prefix the API returns and masks a secret as long as a real one', () => {
    expect(maskKey('eda_0123456789ab_')).toBe(`eda_0123456789ab_${'•'.repeat(32)}`);
  });
});
