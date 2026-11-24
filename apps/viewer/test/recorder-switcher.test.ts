import { describe, expect, it } from 'vitest';
import { processSummary } from '../src/components/RecorderSwitcher';

describe('a recorder row subheading', () => {
  it('lists the processes separated by commas', () => {
    expect(processSummary(['Cart', 'Payments', 'Shipping'])).toBe('Cart, Payments, Shipping');
  });
  it('says so when there are none yet', () => {
    expect(processSummary([])).toBe('No emitters yet');
  });
});
