/**
 * The scoring engine, against the build specification's own figures.
 *
 * TI-03 is the reason this file exists: the specification states that inputs of 80 demand, 95 fit, 85 intent, 90
 * timing and 80 readiness must produce 86.25, and confidence inputs of 90, 80, 70 and 90 must produce 83.5, and that
 * neither may be rounded before the decision is taken. Those two numbers pin every weight at once — get one weight
 * wrong and they do not come out — so they are worth more than a dozen hand-written assertions.
 */
import { describe, it, expect } from 'vitest';
import {
  score,
  movement,
  median,
  mad,
  demandFromZ,
  corroborationFor,
  freshnessFor,
  SINGLE_FAMILY_CONFIDENCE_CAP,
  MIN_COMPARABLE_PERIODS,
  SCORING_VERSION,
  type FamilyEvidence,
} from '../services/trend/scoring';

/** Independent families whose median demand is `demand` and whose mean quality is `quality`. */
const familiesN = (names: string[], demand: number, quality: number, over: Partial<FamilyEvidence> = {}): FamilyEvidence[] =>
  names.map((family, i) => ({
    family,
    quality,
    demand,
    coverage: 1,
    ageHours: 0,
    staleAfterHours: 48,
    sourceId: `src_${i}`,
    ...over,
  }));

/** Three families, so corroboration scores 100 — the general-purpose fixture. */
const families = (demand: number, quality: number, over: Partial<FamilyEvidence> = {}): FamilyEvidence[] => familiesN(['first_party', 'public_feed', 'crm'], demand, quality, over);
/** Exactly two, so corroboration scores 80 — which is what the worked example states. */
const twoFamilies = (demand: number, quality: number, over: Partial<FamilyEvidence> = {}): FamilyEvidence[] => familiesN(['first_party', 'public_feed'], demand, quality, over);

describe('TI-03 · the specification’s worked example', () => {
  it('produces 86.25 opportunity and 83.5 confidence, unrounded, and asks for a reviewable brief', () => {
    // The example states confidence inputs of 90 quality, 80 corroboration, 70 coverage and 90 freshness. By §17
    // corroboration of 80 means exactly two independent families — three would score 100 — so the fixture has two.
    // Coverage of 0.7 gives 70, and an age of 4.8h against a 48h stale limit gives 90.
    const s = score({
      families: twoFamilies(80, 90, { coverage: 0.7, ageHours: 4.8, staleAfterHours: 48 }),
      fit: 95,
      commercialIntent: 85,
      timing: 90,
      readiness: 80,
    });
    expect(s.demand).toBe(80);
    expect(s.sourceQuality).toBe(90);
    expect(s.corroboration).toBe(80);
    expect(s.coverage).toBeCloseTo(70, 9);
    expect(s.freshness).toBeCloseTo(90, 9);

    expect(s.opportunityScore).toBe(86.25);
    expect(s.confidence).toBe(83.5);
    // "Neither score is rounded before the decision": a rounded 86 and 84 would still band the same way here, so
    // the assertion that matters is on the exact values the inputs imply.
    expect(Number.isInteger(s.opportunityScore)).toBe(false);
    expect(s.band).toBe('brief');
    expect(s.vetoes).toEqual([]);
  });

  it('does not promote that example to automatic action without an explicit opt-in', () => {
    const base = { families: families(95, 95), fit: 95, commercialIntent: 95, timing: 95, readiness: 95 };
    expect(score(base).band).toBe('brief');
    expect(score({ ...base, autoActionOptIn: true }).band).toBe('auto_eligible');
  });
});

describe('decision bands', () => {
  const at = (demand: number, quality: number, over: Partial<FamilyEvidence> = {}) =>
    score({ families: families(demand, quality, over), fit: demand, commercialIntent: demand, timing: demand, readiness: demand });

  it('archives below the cutoffs and reopens nothing by itself', () => {
    const s = at(40, 40);
    expect(s.band).toBe('archive');
    expect(s.reasons.join(' ')).toContain('archived');
  });

  it('holds a well-evidenced topic at watch while it is short of the brief bar', () => {
    expect(at(70, 90).band).toBe('watch');
  });

  it('never briefs a topic carrying a veto, however high it scores', () => {
    const s = score({ families: families(95, 95), fit: 95, commercialIntent: 95, timing: 95, readiness: 95, vetoes: ['restricted topic'], autoActionOptIn: true });
    expect(s.band).toBe('watch');
    expect(s.reasons.join(' ')).toContain('veto');
  });

  it('treats missing readiness as a veto, because demand nobody can serve is not an opportunity', () => {
    const s = score({ families: families(95, 95), fit: 95, commercialIntent: 95, timing: 95, readiness: 0 });
    expect(s.vetoes.join(' ')).toContain('readiness');
    expect(s.band).not.toBe('brief');
  });
});

describe('confidence is independent of enthusiasm', () => {
  it('caps a single source family at 69 however good that family is', () => {
    const one: FamilyEvidence[] = [{ family: 'public_feed', quality: 100, demand: 100, coverage: 1, ageHours: 0, staleAfterHours: 48, sourceId: 'a' }];
    const s = score({ families: one, fit: 100, commercialIntent: 100, timing: 100, readiness: 100 });
    expect(s.corroboration).toBe(0);
    expect(s.confidence).toBe(SINGLE_FAMILY_CONFIDENCE_CAP);
    // High opportunity, capped confidence: the pair has to read as "promising, not proven".
    expect(s.opportunityScore).toBe(100);
    expect(s.band).toBe('watch');
  });

  it('TI-04 · syndicated copies of one story are one family, so they cannot corroborate each other', () => {
    const syndicated: FamilyEvidence[] = ['a', 'b', 'c', 'd'].map((id) => ({
      family: 'public_feed',
      quality: 90,
      demand: 95,
      coverage: 1,
      ageHours: 1,
      staleAfterHours: 48,
      sourceId: id,
    }));
    const s = score({ families: syndicated, fit: 95, commercialIntent: 95, timing: 95, readiness: 95 });
    expect(s.families).toEqual(['public_feed']);
    expect(s.corroboration).toBe(0);
    expect(s.confidence).toBe(SINGLE_FAMILY_CONFIDENCE_CAP);
    expect(s.band).toBe('watch');
  });

  it('does not let a context-only family stand in for corroboration', () => {
    const mixed: FamilyEvidence[] = [
      { family: 'first_party', quality: 90, demand: 90, coverage: 1, ageHours: 0, staleAfterHours: 48, sourceId: 'fp' },
      { family: 'pageviews', quality: 90, demand: 90, coverage: 1, ageHours: 0, staleAfterHours: 48, sourceId: 'pv', contextOnly: true },
    ];
    const s = score({ families: mixed, fit: 90, commercialIntent: 90, timing: 90, readiness: 90 });
    expect(s.corroboration, 'attention is not intent').toBe(0);
    expect(s.families, 'it still appears as evidence').toContain('pageviews');
  });

  it('scores corroboration in the stated steps', () => {
    expect([corroborationFor(0), corroborationFor(1), corroborationFor(2), corroborationFor(3), corroborationFor(9)]).toEqual([0, 0, 80, 100, 100]);
  });

  it('tapers freshness linearly from window close to the stale limit', () => {
    expect(freshnessFor(0, 48)).toBe(100);
    expect(freshnessFor(24, 48)).toBe(50);
    expect(freshnessFor(48, 48)).toBe(0);
    expect(freshnessFor(96, 48), 'a stale source cannot go negative').toBe(0);
  });
});

describe('movement gates', () => {
  const steady = [18, 20, 19, 21, 20, 19, 20, 21];

  it('passes a real jump on a count feed and reports both numbers', () => {
    const m = movement({ current: 60, history: steady });
    expect(m.passes).toBe(true);
    expect(m.lift).toBeGreaterThan(1);
    expect(m.z).toBeGreaterThan(2);
  });

  it('refuses a jump that is only a jump in percentage terms', () => {
    // Four to twelve is a tripling, and still too few events to act on.
    const m = movement({ current: 12, history: [3, 4, 5, 4, 3, 4, 5, 4] });
    expect(m.passes).toBe(false);
    expect(m.reason).toContain('below gate 20');
  });

  it('never applies a raw-count gate to an indexed feed', () => {
    const idx = movement({ current: 14, history: [4, 5, 4, 6, 5, 4, 5, 5], indexed: true });
    expect(idx.passes, 'an index has no counts to threshold').toBe(true);
    expect(movement({ current: 14, history: [4, 5, 4, 6, 5, 4, 5, 5] }).passes, 'the same series as counts is gated').toBe(false);
  });

  it('labels insufficient history rather than inventing a baseline', () => {
    const m = movement({ current: 500, history: [20, 20, 20] });
    expect(m.insufficientHistory).toBe(true);
    expect(m.passes, 'draft-only until there is a baseline worth the name').toBe(false);
    expect(m.reason).toContain(`${MIN_COMPARABLE_PERIODS} needed`);
  });

  it('holds the denominator floor, so a flat series cannot manufacture a huge z', () => {
    // MAD is zero here; without the 0.2 floor this divides by zero and every wobble becomes significant.
    const m = movement({ current: 25, history: [20, 20, 20, 20, 20, 20] });
    expect(Number.isFinite(m.z)).toBe(true);
    expect(m.z).toBeLessThan(2);
    expect(m.passes).toBe(false);
  });

  it('maps a gated z onto demand as specified, clamped at both ends', () => {
    expect(demandFromZ(0)).toBe(50);
    expect(demandFromZ(2)).toBe(70);
    expect(demandFromZ(-9)).toBe(0);
    expect(demandFromZ(99)).toBe(100);
  });

  it('computes median and MAD the way the formula assumes', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([5, 1, 3])).toBe(3);
    expect(mad([1, 1, 1, 1])).toBe(0);
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
  });
});

it('freezes a scoring version onto every result, so an old score stays readable', () => {
  expect(SCORING_VERSION).toMatch(/^ti-\d+\.\d+\.\d+$/);
});
