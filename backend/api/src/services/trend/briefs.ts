/**
 * The Growth Brief: the one object that connects detection to the agents that already exist here.
 *
 * Before this, `runContentSchedule()` took the next entry off a hand-written topic list — that was the platform's
 * entire judgement about what the market wanted. A brief replaces the list with evidence and, just as importantly,
 * with an expiry. It says what the topic is, who it is for, which claims may be made, which may not, and until
 * when. The agent resolves it at run time rather than having its prompt rewritten, so the brief can be revoked or
 * allowed to lapse and the agent falls straight back to its baseline behaviour.
 *
 * Three rules do most of the safety work:
 *
 *  - **One approved brief per scope.** Enforced by a partial unique index, not by a check the caller might skip, so
 *    two contradictory instructions for the same market, locale and topic cannot both be live.
 *  - **Approval binds to a hash.** An approval covers the exact payload it was shown. Editing a brief after approval
 *    invalidates it, because otherwise "approved" means "approved in principle", which is not a control.
 *  - **Expiry is checked on the read, not by a sweeper.** A brief that has lapsed resolves as baseline even if no job
 *    has got round to marking it expired. A cache cannot outlive it either; the resolver is the authority.
 *
 * Nothing in here publishes. A brief changes what the agent is asked to write; the existing review and audit path
 * still decides whether the draft goes anywhere.
 */
import { getDb } from '../../db';
import { uuid, now } from '../../lib/ids';
import { sha256 } from '../../lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { parseJson } from '../../lib/json';
import { assertTrendIntelligence, trendIntelligenceOn } from './gate';

/** The channels a brief may steer. Content is what this platform actually has an agent for today. */
export const BRIEF_CHANNELS = ['seo', 'content', 'organic_social'] as const;
export type BriefChannel = (typeof BRIEF_CHANNELS)[number];

/** Default validity, §17: a persistent topic is worth a week, a breaking one a day. */
export const BRIEF_TTL_HOURS = { persistent: 24 * 7, breaking: 24 } as const;

export interface BriefRow {
  id: string;
  brief_ref: string;
  version: number;
  topic_id: string;
  opportunity_id: string;
  market: string;
  locale: string;
  audience: string;
  intent: string;
  objective: string;
  cta_id: string | null;
  approved_claim_ids: string;
  prohibited_claims: string;
  allowed_channels: string;
  evidence_ids: string;
  opportunity_score: number;
  confidence: number;
  policy_version: number;
  experiment_id: string | null;
  status: 'draft' | 'approved' | 'superseded' | 'expired' | 'revoked';
  degraded: number;
  degraded_reason: string | null;
  valid_from: string | null;
  expires_at: string | null;
  proposed_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  payload_hash: string | null;
  created_at: string;
  updated_at: string;
}

/** The shape an agent receives. Closed on purpose: an agent must not act on a free-text instruction. */
export interface GrowthBrief {
  schemaVersion: 1;
  briefId: string;
  briefVersion: number;
  topicId: string;
  market: string;
  locale: string;
  opportunityScore: number;
  confidence: number;
  validFrom: string;
  expiresAt: string;
  evidenceIds: string[];
  audience: string;
  intent: string;
  approvedClaimIds: string[];
  approvedClaims: { id: string; code: string; text: string }[];
  ctaId: string | null;
  allowedChannels: BriefChannel[];
  prohibitedClaims: string[];
  objective: string;
  experimentId: string | null;
  policyVersion: number;
  /** True when the brief was produced without a model, so the reader knows the drafting mode was degraded. */
  degraded: boolean;
}

const list = (raw: string): string[] => parseJson<string[]>(raw, []);

/**
 * The bytes an approval covers. Everything that changes what the agent would do is in here; the status, timestamps
 * and approver are not, because those are what the approval itself sets.
 */
export function canonicalPayload(row: BriefRow): string {
  return JSON.stringify([
    row.brief_ref,
    row.version,
    row.topic_id,
    row.opportunity_id,
    row.market,
    row.locale,
    row.audience,
    row.intent,
    row.objective,
    row.cta_id,
    list(row.approved_claim_ids),
    list(row.prohibited_claims),
    list(row.allowed_channels),
    list(row.evidence_ids),
    row.opportunity_score,
    row.confidence,
    row.policy_version,
    row.experiment_id,
    row.expires_at,
  ]);
}

export const payloadHash = (row: BriefRow): string => sha256(canonicalPayload(row));

const expired = (row: BriefRow, at = now()): boolean => !row.expires_at || row.expires_at <= at;

export interface ProposeBriefInput {
  topicId: string;
  opportunityId: string;
  market: string;
  locale: string;
  audience: string;
  intent: string;
  objective: string;
  ctaId?: string | null;
  approvedClaimIds?: string[];
  prohibitedClaims?: string[];
  allowedChannels?: BriefChannel[];
  evidenceIds?: string[];
  ttlHours?: number;
  degraded?: boolean;
  degradedReason?: string | null;
  policyVersion?: number;
  experimentId?: string | null;
}

/** Create a draft from a frozen opportunity snapshot. A draft changes nothing until it is approved. */
export function proposeBrief(input: ProposeBriefInput, proposedBy: string): BriefRow {
  assertTrendIntelligence();
  const db = getDb();
  const snapshot = db.prepare('SELECT * FROM ti_opportunities WHERE id = ?').get(input.opportunityId) as
    { id: string; topic_id: string; band: string; opportunity_score: number; confidence: number; vetoes: string } | undefined;
  if (!snapshot) throw notFound('Opportunity snapshot not found', 'opportunity_not_found');
  if (snapshot.topic_id !== input.topicId) throw badRequest('That snapshot belongs to a different topic', 'topic_mismatch');
  // Only a snapshot the scorer put in the brief band may become a brief. Watch and archive exist to be read.
  if (snapshot.band !== 'brief' && snapshot.band !== 'auto_eligible') {
    throw badRequest(`This opportunity is in the ${snapshot.band} band and cannot carry a brief`, 'not_eligible');
  }
  const vetoes = list(snapshot.vetoes);
  if (vetoes.length) throw badRequest(`This opportunity carries ${vetoes.length} veto(es)`, 'vetoed', { vetoes });

  const channels = input.allowedChannels?.length ? input.allowedChannels : (['seo', 'content'] as BriefChannel[]);
  for (const c of channels) if (!BRIEF_CHANNELS.includes(c)) throw badRequest(`Unknown channel ${c}`, 'unknown_channel');

  // Claims resolve server-side. A claim id the platform does not hold is refused rather than passed to a model.
  const claimIds = input.approvedClaimIds ?? [];
  for (const id of claimIds) {
    const claim = db.prepare('SELECT id FROM ti_claims WHERE id = ?').get(id);
    if (!claim) throw badRequest(`Unknown approved claim ${id}`, 'unknown_claim');
  }

  const existing = db.prepare('SELECT brief_ref, MAX(version) v FROM ti_briefs WHERE topic_id = ? AND market = ? AND locale = ? GROUP BY brief_ref').get(input.topicId, input.market, input.locale) as
    { brief_ref: string; v: number } | undefined;
  const ref = existing?.brief_ref ?? `gb_${uuid().slice(0, 8)}`;
  const version = (existing?.v ?? 0) + 1;
  const ts = now();
  const ttl = input.ttlHours ?? BRIEF_TTL_HOURS.persistent;
  const row: BriefRow = {
    id: uuid(),
    brief_ref: ref,
    version,
    topic_id: input.topicId,
    opportunity_id: input.opportunityId,
    market: input.market,
    locale: input.locale,
    audience: input.audience,
    intent: input.intent,
    objective: input.objective,
    cta_id: input.ctaId ?? null,
    approved_claim_ids: JSON.stringify(claimIds),
    prohibited_claims: JSON.stringify(input.prohibitedClaims ?? []),
    allowed_channels: JSON.stringify(channels),
    evidence_ids: JSON.stringify(input.evidenceIds ?? []),
    opportunity_score: snapshot.opportunity_score,
    confidence: snapshot.confidence,
    policy_version: input.policyVersion ?? 1,
    experiment_id: input.experimentId ?? null,
    status: 'draft',
    degraded: input.degraded ? 1 : 0,
    degraded_reason: input.degradedReason ?? null,
    valid_from: null,
    expires_at: new Date(Date.parse(ts) + ttl * 3_600_000).toISOString(),
    proposed_by: proposedBy,
    approved_by: null,
    approved_at: null,
    payload_hash: null,
    created_at: ts,
    updated_at: ts,
  };
  row.payload_hash = payloadHash(row);
  db.prepare(
    `INSERT INTO ti_briefs (id, brief_ref, version, topic_id, opportunity_id, market, locale, audience, intent, objective, cta_id,
       approved_claim_ids, prohibited_claims, allowed_channels, evidence_ids, opportunity_score, confidence, policy_version,
       experiment_id, status, degraded, degraded_reason, valid_from, expires_at, proposed_by, approved_by, approved_at,
       payload_hash, created_at, updated_at)
     VALUES (@id, @brief_ref, @version, @topic_id, @opportunity_id, @market, @locale, @audience, @intent, @objective, @cta_id,
       @approved_claim_ids, @prohibited_claims, @allowed_channels, @evidence_ids, @opportunity_score, @confidence, @policy_version,
       @experiment_id, @status, @degraded, @degraded_reason, @valid_from, @expires_at, @proposed_by, @approved_by, @approved_at,
       @payload_hash, @created_at, @updated_at)`,
  ).run(row);
  return row;
}

export const getBrief = (id: string): BriefRow | undefined => getDb().prepare('SELECT * FROM ti_briefs WHERE id = ?').get(id) as BriefRow | undefined;

/**
 * Approve one exact version. The caller passes the hash it was shown; if the brief has changed since, the approval
 * is refused rather than applied to something the approver never read. Approving supersedes the previous active
 * brief for the same scope in the same transaction, so there is never a moment with two or none.
 */
export function approveBrief(id: string, expectedHash: string, approverId: string): BriefRow {
  assertTrendIntelligence();
  const db = getDb();
  const row = getBrief(id);
  if (!row) throw notFound('Brief not found', 'brief_not_found');
  if (row.status !== 'draft') throw conflict(`This brief is ${row.status} and cannot be approved`, 'invalid_status');
  if (expired(row)) throw conflict('This brief expired before it was approved', 'brief_expired');
  const current = payloadHash(row);
  if (current !== expectedHash) throw conflict('The brief changed after it was shown for approval', 'payload_hash_conflict');
  // Maker-checker: the platform's oldest control, and the one that makes an approval mean something.
  if (row.proposed_by && row.proposed_by === approverId) throw forbidden('A brief cannot be approved by the person who proposed it', 'self_approval');

  const ts = now();
  const apply = db.transaction(() => {
    db.prepare("UPDATE ti_briefs SET status = 'superseded', updated_at = ? WHERE topic_id = ? AND market = ? AND locale = ? AND status = 'approved'").run(ts, row.topic_id, row.market, row.locale);
    db.prepare("UPDATE ti_briefs SET status = 'approved', approved_by = ?, approved_at = ?, valid_from = ?, updated_at = ? WHERE id = ?").run(approverId, ts, ts, ts, id);
    db.prepare("UPDATE ti_topics SET status = 'briefed', updated_at = ? WHERE id = ?").run(ts, row.topic_id);
  });
  apply();
  return getBrief(id)!;
}

/** Withdraw an approved brief. The agent reverts to baseline on its next resolution, not on a redeploy. */
export function revokeBrief(id: string, reason: string): BriefRow {
  assertTrendIntelligence();
  const db = getDb();
  const row = getBrief(id);
  if (!row) throw notFound('Brief not found', 'brief_not_found');
  db.prepare("UPDATE ti_briefs SET status = 'revoked', degraded_reason = ?, updated_at = ? WHERE id = ?").run(reason, now(), id);
  return getBrief(id)!;
}

export interface EffectiveQuery {
  market: string;
  locale?: string | null;
  channel: BriefChannel;
  topicId?: string | null;
}

/**
 * Resolve the one approved, fresh brief for a scope, or nothing.
 *
 * Nothing is a legitimate answer and the caller must treat it as "use your baseline behaviour". Expiry is evaluated
 * here on every call, so a brief that has lapsed stops steering the agent whether or not a job has marked it
 * expired yet — which is the only way a cache can be safe.
 */
export function effectiveBrief(q: EffectiveQuery): GrowthBrief | null {
  // Switched off resolves as baseline rather than throwing: an agent must not stop writing because a growth
  // control was turned off. The caller records the `unavailable` outcome, so the console can say why.
  if (!trendIntelligenceOn()) return null;
  const db = getDb();
  const at = now();
  const rows = db
    .prepare(
      `SELECT * FROM ti_briefs WHERE status = 'approved' AND market IN (?, 'ZZ')
       AND (? IS NULL OR locale = ? OR locale = '') AND (? IS NULL OR topic_id = ?)
       ORDER BY CASE WHEN market = ? THEN 0 ELSE 1 END, opportunity_score DESC, approved_at DESC`,
    )
    .all(q.market, q.locale ?? null, q.locale ?? null, q.topicId ?? null, q.topicId ?? null, q.market) as BriefRow[];

  for (const row of rows) {
    if (expired(row, at)) continue;
    if (!list(row.allowed_channels).includes(q.channel)) continue;
    const claims = list(row.approved_claim_ids)
      .map((id) => db.prepare('SELECT id, code, text FROM ti_claims WHERE id = ?').get(id) as { id: string; code: string; text: string } | undefined)
      .filter((c): c is { id: string; code: string; text: string } => Boolean(c));
    return {
      schemaVersion: 1,
      briefId: row.id,
      briefVersion: row.version,
      topicId: row.topic_id,
      market: row.market,
      locale: row.locale,
      opportunityScore: row.opportunity_score,
      confidence: row.confidence,
      validFrom: row.valid_from ?? row.created_at,
      expiresAt: row.expires_at!,
      evidenceIds: list(row.evidence_ids),
      audience: row.audience,
      intent: row.intent,
      approvedClaimIds: list(row.approved_claim_ids),
      approvedClaims: claims,
      ctaId: row.cta_id,
      allowedChannels: list(row.allowed_channels) as BriefChannel[],
      prohibitedClaims: list(row.prohibited_claims),
      objective: row.objective,
      experimentId: row.experiment_id,
      policyVersion: row.policy_version,
      degraded: row.degraded === 1,
    };
  }
  return null;
}

/** Mark lapsed briefs, for the console's sake. Resolution never depends on this having run. */
export function expireLapsedBriefs(): number {
  const at = now();
  return getDb().prepare("UPDATE ti_briefs SET status = 'expired', updated_at = ? WHERE status IN ('draft', 'approved') AND expires_at IS NOT NULL AND expires_at <= ?").run(at, at).changes;
}

/** Record that an agent resolved a brief, and what it did. The audit answer to "why did it write that". */
export function recordBriefUse(input: {
  briefId?: string | null;
  briefVersion?: number | null;
  channel: string;
  outcome: 'used' | 'baseline' | 'expired' | 'unavailable';
  detail?: string | null;
  postId?: string | null;
}): void {
  const ts = now();
  getDb()
    .prepare('INSERT INTO ti_brief_uses (id, brief_id, brief_version, channel, resolved_at, outcome, detail, post_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uuid(), input.briefId ?? null, input.briefVersion ?? null, input.channel, ts, input.outcome, input.detail ?? null, input.postId ?? null, ts);
}

export const listBriefUses = (limit = 50): Record<string, unknown>[] =>
  getDb()
    .prepare('SELECT * FROM ti_brief_uses ORDER BY resolved_at DESC LIMIT ?')
    .all(Math.min(200, Math.max(1, limit))) as Record<string, unknown>[];
