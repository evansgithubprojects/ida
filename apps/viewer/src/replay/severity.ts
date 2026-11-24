import type { Finding } from '@eda-debugger/core';

/** Tunable weights for ranking the notification list. Higher scores sit nearer the top. */
export const SEVERITY = {
  base: { finding: 30, throw: 40 },
  confidence: { high: 20, medium: 10, low: 0 },
  /** The payload (or a payload this error poisoned) reaches an external system. */
  external: 50,
  /** A throw gains this much per payload it is suspected of corrupting, up to `maxTainted` of them. */
  perTainted: 10,
  maxTainted: 5,
  tiers: { critical: 100, high: 70, medium: 40 },
} as const;

export type Tier = 'critical' | 'high' | 'medium' | 'low';

/** What the list needs to order a notification, without the data behind it. */
export interface Rank {
  /** 0 = a finding with no error thrown, which sits above everything else. */
  group: 0 | 1;
  score: number;
  external: boolean;
  confidence: Finding['confidence'] | null;
  ts: number;
}

const isExternal = (f: Finding) => f.priority === 'high';

export function findingScore(f: Finding): number {
  return SEVERITY.base.finding + SEVERITY.confidence[f.confidence] + (isExternal(f) ? SEVERITY.external : 0);
}

/** `tainted` are the findings whose source error is this throw. */
export function throwScore(tainted: Finding[]): number {
  return SEVERITY.base.throw + SEVERITY.perTainted * Math.min(tainted.length, SEVERITY.maxTainted) + (tainted.some(isExternal) ? SEVERITY.external : 0);
}

export function tierOf(score: number): Tier {
  if (score >= SEVERITY.tiers.critical) return 'critical';
  if (score >= SEVERITY.tiers.high) return 'high';
  return score >= SEVERITY.tiers.medium ? 'medium' : 'low';
}

export function findingRank(f: Finding): Rank {
  return { group: f.taintSource ? 1 : 0, score: findingScore(f), external: isExternal(f), confidence: f.confidence, ts: f.ts };
}

export function throwRank(tainted: Finding[], ts: number): Rank {
  return { group: 1, score: throwScore(tainted), external: tainted.some(isExternal), confidence: null, ts };
}

const CONFIDENCE_ORDER = { high: 2, medium: 1, low: 0 } as const;

/** Findings with no error thrown first (external, then confidence), then by score; oldest first on ties. */
export function compareRank(a: Rank, b: Rank): number {
  if (a.group !== b.group) return a.group - b.group;
  if (a.group === 0) {
    return Number(b.external) - Number(a.external)
      || CONFIDENCE_ORDER[b.confidence ?? 'low'] - CONFIDENCE_ORDER[a.confidence ?? 'low']
      || a.ts - b.ts;
  }
  return b.score - a.score || a.ts - b.ts;
}
