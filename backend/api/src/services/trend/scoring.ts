/**
 * Deterministic detection and scoring. No model is involved here, by design.
 *
 * The build specification fixes every formula and threshold in this file, which is the point: whether a topic earns
 * a brief has to be reproducible from the stored inputs months later, when somebody asks why the platform started
 * writing about something. A model may later *label* a cluster or explain evidence, but it never moves a score.
 *
 * Two numbers come out, and they are independent on purpose. Opportunity asks "is this worth doing"; confidence asks
 * "do we actually know this". A topic can be obviously valuable and poorly evidenced, and that combination must not
 * average into a comfortable middle — it has to read as "promising, not proven", which is what keeps a single
 * excited feed from driving a campaign.
 */

/** Bumped whenever a formula or threshold changes, and frozen onto every snapshot so old scores stay readable. */
export const SCORING_VERSION = 'ti-1.0.0';

/** Opportunity weights, §5.4. */
export const OPPORTUNITY_WEIGHTS = { demand: 0.25, fit: 0.25, commercialIntent: 0.2, timing: 0.15, readiness: 0.15 } as const;
/** Confidence weights, §5.5. */
export const CONFIDENCE_WEIGHTS = { sourceQuality: 0.35, corroboration: 0.25, coverage: 0.2, freshness: 0.2 } as const;

/** A single source family's word is capped here however good the family is: one voice is not corroboration. */
export const SINGLE_FAMILY_CONFIDENCE_CAP = 69;
/** Below four comparable periods there is no baseline worth the name, so the topic stays draft-only. */
export const MIN_COMPARABLE_PERIODS = 4;

export const clamp = (n: number, lo = 0, hi = 100): number => Math.min(hi, Math.max(lo, n));

export const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Median absolute deviation: a spread that a single freak week cannot inflate, unlike a standard deviation. */
export const mad = (xs: number[]): number => {
  if (!xs.length) return 0;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
};

export interface MovementInput {
  /** Comparable current count for the complete window. */
  current: number;
  /** Comparable historical counts, one per prior comparable period. */
  history: number[];
  /** An indexed feed (a 0-100 trends index) is never held to a raw-count gate. */
  indexed?: boolean;
  /** Per-source overrides; the defaults are the specification's initial gate. */
  minCount?: number;
  minZ?: number;
}

export interface Movement {
  lift: number;
  z: number;
  /** Clears the gate for this feed kind, so it may contribute to demand. */
  passes: boolean;
  /** Fewer than four comparable periods: usable as watch evidence, never as an automated trigger. */
  insufficientHistory: boolean;
  reason: string;
}

/**
 * Movement for one source, §5.3.
 *
 * `lift` is the readable number (a log ratio against the baseline median); `z` is the one that gates, because it is
 * scaled by how noisy this series normally is. The 0.2 floor on the denominator is what stops a series that barely
 * moves from turning a trivial wobble into an enormous z.
 */
export function movement(input: MovementInput): Movement {
  const { current: c, history } = input;
  const logs = history.map((x) => Math.log1p(x));
  const baseline = median(history);
  const lift = Math.log((c + 1) / (baseline + 1));
  const spread = Math.max(1.4826 * mad(logs), 0.2);
  const z = logs.length ? (Math.log1p(c) - median(logs)) / spread : 0;
  const insufficientHistory = history.length < MIN_COMPARABLE_PERIODS;

  if (insufficientHistory) return { lift, z, passes: false, insufficientHistory, reason: `only ${history.length} comparable periods, ${MIN_COMPARABLE_PERIODS} needed` };
  // An index has no counts to threshold; holding it to c >= 20 would silently discard every indexed feed.
  const minZ = input.minZ ?? 2;
  if (input.indexed) {
    const passes = z >= minZ;
    return { lift, z, passes, insufficientHistory, reason: passes ? `indexed movement z=${z.toFixed(2)}` : `indexed movement z=${z.toFixed(2)} below ${minZ}` };
  }
  const minCount = input.minCount ?? 20;
  if (c < minCount) return { lift, z, passes: false, insufficientHistory, reason: `count ${c} below gate ${minCount}` };
  const passes = z >= minZ;
  return { lift, z, passes, insufficientHistory, reason: passes ? `count ${c}, z=${z.toFixed(2)}` : `z=${z.toFixed(2)} below ${minZ}` };
}

/** Count-feed demand mapping, §17: applied only after the volume and history gates have been cleared. */
export const demandFromZ = (z: number): number => clamp(50 + 10 * z);

export interface FamilyEvidence {
  family: string;
  /** The operator's 0-100 view of this family, from the source registry. */
  quality: number;
  /** Highest-weight valid observation for this family, already mapped to 0-100 demand. */
  demand: number;
  /** Valid observed / expected windows, 0-1. */
  coverage: number;
  /** Hours since the observation window closed. */
  ageHours: number;
  /** Hours after which this family's word is stale. */
  staleAfterHours: number;
  /** Attention rather than intent: can colour a decision, cannot corroborate one. */
  contextOnly?: boolean;
  /** Deterministic tie-break when two families carry the same weight. */
  sourceId: string;
}

export interface ScoreInputs {
  families: FamilyEvidence[];
  /** 0-100 from the platform profile's verified mapping, never from a model. */
  fit: number;
  commercialIntent: number;
  /** 0-100 from the actionable window remaining. */
  timing: number;
  /** 0-100 from stock, capacity, partner coverage and approved assets. Zero vetoes live activation. */
  readiness: number;
  /** Out-of-market, unsupported claim, restricted topic, unavailable inventory, illegal targeting. */
  vetoes?: string[];
  /** Automatic action in approved low-risk classes requires an explicit opt-in; it is never implied. */
  autoActionOptIn?: boolean;
}

export type Band = 'archive' | 'watch' | 'brief' | 'auto_eligible';

export interface Score {
  opportunityScore: number;
  confidence: number;
  demand: number;
  fit: number;
  commercialIntent: number;
  timing: number;
  readiness: number;
  sourceQuality: number;
  corroboration: number;
  coverage: number;
  freshness: number;
  families: string[];
  band: Band;
  vetoes: string[];
  reasons: string[];
}

/** Corroboration, §17: one independent family proves nothing on its own, whatever its quality. */
export const corroborationFor = (independentFamilies: number): number => (independentFamilies >= 3 ? 100 : independentFamilies === 2 ? 80 : 0);

/** Freshness, §17: full marks at window close, tapering linearly to nothing at the configured stale limit. */
export const freshnessFor = (ageHours: number, staleAfterHours: number): number => {
  if (staleAfterHours <= 0) return 0;
  return clamp(100 * (1 - ageHours / staleAfterHours));
};

/**
 * Both scores for one topic, §5.4 and §5.5. Full precision throughout — the caller rounds for display only, because
 * a decision taken on a rounded 74.5 is a different decision from the one the inputs support.
 */
export function score(inputs: ScoreInputs): Score {
  const reasons: string[] = [];
  const vetoes = [...(inputs.vetoes ?? [])];

  // Demand is the median across independent families of each family's best valid observation, so one loud family
  // cannot carry a topic and a single quiet one cannot sink it.
  const ordered = [...inputs.families].sort((a, b) => b.quality - a.quality || a.sourceId.localeCompare(b.sourceId));
  const demand = ordered.length ? median(ordered.map((f) => f.demand)) : 0;

  const sourceQuality = ordered.length ? ordered.reduce((s, f) => s + f.quality, 0) / ordered.length : 0;
  // Context-only families are excluded from the count that earns corroboration, not from the evidence list.
  const independent = new Set(ordered.filter((f) => !f.contextOnly).map((f) => f.family));
  const corroboration = corroborationFor(independent.size);
  const coverage = ordered.length ? (ordered.reduce((s, f) => s + f.coverage, 0) / ordered.length) * 100 : 0;
  const freshness = ordered.length ? ordered.reduce((s, f) => s + freshnessFor(f.ageHours, f.staleAfterHours), 0) / ordered.length : 0;

  if (inputs.readiness <= 0) vetoes.push('readiness: nothing available to serve this demand');

  const opportunityScore =
    OPPORTUNITY_WEIGHTS.demand * demand +
    OPPORTUNITY_WEIGHTS.fit * inputs.fit +
    OPPORTUNITY_WEIGHTS.commercialIntent * inputs.commercialIntent +
    OPPORTUNITY_WEIGHTS.timing * inputs.timing +
    OPPORTUNITY_WEIGHTS.readiness * inputs.readiness;

  let confidence =
    CONFIDENCE_WEIGHTS.sourceQuality * sourceQuality + CONFIDENCE_WEIGHTS.corroboration * corroboration + CONFIDENCE_WEIGHTS.coverage * coverage + CONFIDENCE_WEIGHTS.freshness * freshness;

  if (independent.size <= 1 && confidence > SINGLE_FAMILY_CONFIDENCE_CAP) {
    reasons.push(`confidence capped at ${SINGLE_FAMILY_CONFIDENCE_CAP}: ${independent.size === 1 ? 'one independent source family' : 'no independent source family'}`);
    confidence = SINGLE_FAMILY_CONFIDENCE_CAP;
  }

  let band: Band;
  if (opportunityScore < 60 || confidence < 55) {
    band = 'archive';
    reasons.push(`archived: score ${opportunityScore.toFixed(1)} / confidence ${confidence.toFixed(1)} below the 60 / 55 cutoffs`);
  } else if (opportunityScore < 75 || confidence < 75) {
    band = 'watch';
    reasons.push(`watch: score ${opportunityScore.toFixed(1)} / confidence ${confidence.toFixed(1)} below the 75 / 75 brief bar`);
  } else if (vetoes.length) {
    band = 'watch';
    reasons.push(`held at watch by ${vetoes.length} veto(es) despite clearing the brief bar`);
  } else if (opportunityScore >= 85 && confidence >= 85 && inputs.autoActionOptIn) {
    band = 'auto_eligible';
    reasons.push('eligible for bounded automatic action in approved low-risk classes');
  } else {
    band = 'brief';
    reasons.push('reviewable brief: external action still needs policy and channel approval');
  }

  return {
    opportunityScore,
    confidence,
    demand,
    fit: inputs.fit,
    commercialIntent: inputs.commercialIntent,
    timing: inputs.timing,
    readiness: inputs.readiness,
    sourceQuality,
    corroboration,
    coverage,
    freshness,
    families: [...new Set(ordered.map((f) => f.family))],
    band,
    vetoes,
    reasons,
  };
}
