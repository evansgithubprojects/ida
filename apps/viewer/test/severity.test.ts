import { describe, expect, it } from 'vitest';
import type { Finding } from '@eda-debugger/core';
import { compareRank, findingRank, findingScore, throwRank, tierOf } from '../src/replay/severity';

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 'f', kind: 'suspected-corrupt', occurrenceId: 'o', ts: 10, confidence: 'medium', basis: 'deep', reasons: [], diff: [],
  taintSource: { occurrenceId: 's', handlerId: 'h' }, retroactive: false, summary: '', priority: 'normal', externalTargets: [], ...over,
});

const order = (ranks: ReturnType<typeof findingRank>[]) => [...ranks].sort(compareRank).map((r) => r.ts);

describe('severity', () => {
  it('scores external and confident findings higher', () => {
    expect(findingScore(finding({ priority: 'high' }))).toBeGreaterThan(findingScore(finding({ confidence: 'high' })));
    expect(findingScore(finding({ confidence: 'high' }))).toBeGreaterThan(findingScore(finding({ confidence: 'low' })));
  });

  it('puts findings with no error thrown above everything, external first', () => {
    const ranks = [
      findingRank(finding({ ts: 1, priority: 'high' })), // external, tainted
      findingRank(finding({ ts: 2, taintSource: null })),
      findingRank(finding({ ts: 3, taintSource: null, priority: 'high', confidence: 'low' })),
      throwRank([finding({ priority: 'high' })], 4),
      findingRank(finding({ ts: 5, taintSource: null, confidence: 'high' })),
    ];
    expect(order(ranks)).toEqual([3, 5, 2, 4, 1]) // the poisoned throw (100) outranks its external finding (90);
  });

  it('ranks a throw that poisoned external data above a plain throw, and ties oldest first', () => {
    const poisoned = throwRank([finding({ priority: 'high' })], 9);
    const plain = throwRank([], 1);
    expect([plain, poisoned].sort(compareRank)).toEqual([poisoned, plain]);
    expect([throwRank([], 7), throwRank([], 3)].sort(compareRank).map((r) => r.ts)).toEqual([3, 7]);
  });

  it('caps what tainted payloads add to a throw', () => {
    const many = Array.from({ length: 12 }, () => finding());
    expect(throwRank(many, 0).score).toBe(throwRank(many.slice(0, 5), 0).score);
  });

  it('maps scores to tiers', () => {
    expect([tierOf(120), tierOf(100), tierOf(70), tierOf(40), tierOf(39)]).toEqual(['critical', 'critical', 'high', 'medium', 'low']);
  });
});
