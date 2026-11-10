/**
 * Ingestion, clustering and the frozen opportunity snapshot.
 *
 * The ingestion rules matter more than the clustering. A signal pipeline that double-counts is worse than no
 * pipeline, because it manufactures confidence: four syndicated copies of one announcement look like four
 * independent sources agreeing. So the same source record at the same revision lands exactly once, a changed
 * payload under a key that already exists is a conflict for the caller rather than a second observation, and a feed
 * gap is recorded as unknown coverage rather than as zero interest.
 *
 * Clustering is deliberately lexical. An embedding would merge "send money to Kinshasa" with "send money from
 * Kinshasa", and would merge two markets whose words are similar — which is exactly the mistake that puts a brief in
 * front of the wrong audience. Canonicalisation strips accents and punctuation and keeps the original text beside
 * it, and market is part of the key, never inferred.
 */
import { getDb } from '../../db';
import { uuid, now } from '../../lib/ids';
import { sha256 } from '../../lib/crypto';
import { badRequest, notFound } from '../../lib/errors';
import { parseJson } from '../../lib/json';
import { score, movement, demandFromZ, SCORING_VERSION, type FamilyEvidence, type Score } from './scoring';
import { assertTrendIntelligence } from './gate';

export interface SourceRow {
  id: string;
  name: string;
  family: string;
  access_path: 'first_party' | 'public_keyless' | 'host_mediated' | 'file_import';
  quality: number;
  stale_after_hours: number;
  cadence_minutes: number;
  context_only: number;
  enabled: number;
  unavailable_reason: string | null;
  last_window_end: string | null;
}

/** Accents, punctuation and case folded away; the original term is kept on the observation beside it. */
export function canonicalise(term: string): string {
  return term
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function upsertSource(input: {
  id?: string;
  name: string;
  family: string;
  accessPath: SourceRow['access_path'];
  quality?: number;
  staleAfterHours?: number;
  cadenceMinutes?: number;
  contextOnly?: boolean;
  terms?: string | null;
  permittedUses?: string[];
  territories?: string[];
  enabled?: boolean;
  unavailableReason?: string | null;
}): SourceRow {
  assertTrendIntelligence();
  const db = getDb();
  const id = input.id ?? `src_${canonicalise(input.name).replace(/ /g, '_')}`;
  db.prepare(
    `INSERT INTO ti_sources (id, name, family, access_path, quality, stale_after_hours, cadence_minutes, context_only, terms,
       permitted_uses, territories, enabled, unavailable_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, family = excluded.family, access_path = excluded.access_path,
       quality = excluded.quality, stale_after_hours = excluded.stale_after_hours, cadence_minutes = excluded.cadence_minutes,
       context_only = excluded.context_only, terms = excluded.terms, permitted_uses = excluded.permitted_uses,
       territories = excluded.territories, enabled = excluded.enabled, unavailable_reason = excluded.unavailable_reason`,
  ).run(
    id,
    input.name,
    input.family,
    input.accessPath,
    input.quality ?? 50,
    input.staleAfterHours ?? 48,
    input.cadenceMinutes ?? 60,
    input.contextOnly ? 1 : 0,
    input.terms ?? null,
    JSON.stringify(input.permittedUses ?? []),
    JSON.stringify(input.territories ?? []),
    input.enabled === false ? 0 : 1,
    input.unavailableReason ?? null,
    now(),
  );
  return getDb().prepare('SELECT * FROM ti_sources WHERE id = ?').get(id) as SourceRow;
}

export const listSources = (): SourceRow[] => getDb().prepare('SELECT * FROM ti_sources ORDER BY family, name').all() as SourceRow[];

/**
 * A source whose credential the platform does not already hold is recorded as unavailable with a reason. It is
 * never turned into a prompt for a new key: the whole product rule is that the core workflow asks for none.
 */
export function markSourceUnavailable(id: string, reason: string): SourceRow {
  assertTrendIntelligence();
  const db = getDb();
  if (!db.prepare('SELECT id FROM ti_sources WHERE id = ?').get(id)) throw notFound('Source not found', 'source_not_found');
  db.prepare('UPDATE ti_sources SET enabled = 0, unavailable_reason = ? WHERE id = ?').run(reason, id);
  return db.prepare('SELECT * FROM ti_sources WHERE id = ?').get(id) as SourceRow;
}

export interface ObservationInput {
  sourceId: string;
  sourceRecordId: string;
  revision?: number;
  observedAt: string;
  windowStart: string;
  windowEnd: string;
  market?: string;
  locale?: string | null;
  segment?: string | null;
  term: string;
  metric: string;
  value: number;
  unit?: string;
  scalingScope?: 'absolute' | 'indexed';
  /** Valid observed / expected windows, 0-1. Short of 1 means part of the period is unknown, not empty. */
  coverage?: number;
  evidenceUri?: string | null;
  termsVersion?: string | null;
}

export interface IngestResult {
  accepted: number;
  duplicate: number;
  conflict: { sourceRecordId: string; reason: string }[];
  rejected: { index: number; reason: string }[];
}

/**
 * Ingest a batch. An invalid item is reported by index and rejected; it does not take the batch down, because a
 * single malformed row in an hourly import should not cost an hour of signal.
 */
export function ingestObservations(items: ObservationInput[]): IngestResult {
  assertTrendIntelligence();
  const db = getDb();
  const out: IngestResult = { accepted: 0, duplicate: 0, conflict: [], rejected: [] };
  if (items.length > 500) throw badRequest('At most 500 observations per batch', 'batch_too_large');

  for (const [index, item] of items.entries()) {
    const source = db.prepare('SELECT * FROM ti_sources WHERE id = ?').get(item.sourceId) as SourceRow | undefined;
    if (!source) {
      out.rejected.push({ index, reason: `unregistered source ${item.sourceId}` });
      continue;
    }
    if (!source.enabled) {
      out.rejected.push({ index, reason: `source ${item.sourceId} is unavailable: ${source.unavailable_reason ?? 'disabled'}` });
      continue;
    }
    if (!Number.isFinite(item.value)) {
      out.rejected.push({ index, reason: 'value must be a finite number' });
      continue;
    }
    if (Date.parse(item.windowEnd) <= Date.parse(item.windowStart)) {
      out.rejected.push({ index, reason: 'window end must be after window start' });
      continue;
    }
    const revision = item.revision ?? 1;
    // The hash is over what the observation claims, so an identical replay is a duplicate and an altered payload
    // under the same key is a conflict. Without this, a retried import inflates every count it touches.
    const hash = sha256(JSON.stringify([item.sourceId, item.sourceRecordId, revision, item.windowStart, item.windowEnd, canonicalise(item.term), item.metric, item.value, item.market ?? 'ZZ']));
    const existing = db.prepare('SELECT id, evidence_hash FROM ti_observations WHERE source_id = ? AND source_record_id = ? AND revision = ?').get(item.sourceId, item.sourceRecordId, revision) as
      { id: string; evidence_hash: string } | undefined;
    if (existing) {
      if (existing.evidence_hash === hash) out.duplicate += 1;
      else out.conflict.push({ sourceRecordId: item.sourceRecordId, reason: 'same source record and revision with a different payload' });
      continue;
    }
    const ts = now();
    db.prepare(
      `INSERT INTO ti_observations (id, source_id, source_record_id, revision, observed_at, window_start, window_end, ingested_at,
         market, locale, segment, term, term_canonical, metric, value, unit, scaling_scope, coverage, evidence_hash, evidence_uri,
         terms_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      uuid(),
      item.sourceId,
      item.sourceRecordId,
      revision,
      item.observedAt,
      item.windowStart,
      item.windowEnd,
      ts,
      (item.market ?? 'ZZ').toUpperCase(),
      item.locale ?? null,
      item.segment ?? null,
      item.term,
      canonicalise(item.term),
      item.metric,
      item.value,
      item.unit ?? 'count',
      item.scalingScope ?? 'absolute',
      item.coverage ?? 1,
      hash,
      item.evidenceUri ?? null,
      item.termsVersion ?? null,
      ts,
    );
    out.accepted += 1;
    if (!source.last_window_end || source.last_window_end < item.windowEnd) {
      db.prepare('UPDATE ti_sources SET last_window_end = ?, last_polled_at = ? WHERE id = ?').run(item.windowEnd, ts, item.sourceId);
    }
  }
  return out;
}

export interface TopicRow {
  id: string;
  slug: string;
  label: string;
  market: string;
  locale: string | null;
  intent: string | null;
  terms: string;
  status: string;
  cooldown_until: string | null;
}

/** Market is part of the key and is never inferred from language: two markets are two topics, always. */
export function upsertTopic(input: { label: string; market: string; locale?: string | null; intent?: string | null; terms?: string[] }): TopicRow {
  assertTrendIntelligence();
  const db = getDb();
  const slug = canonicalise(input.label).replace(/ /g, '-');
  const market = input.market.toUpperCase();
  const existing = db.prepare('SELECT * FROM ti_topics WHERE slug = ? AND market = ?').get(slug, market) as TopicRow | undefined;
  const ts = now();
  if (existing) {
    const terms = [...new Set([...parseJson<string[]>(existing.terms, []), ...(input.terms ?? []).map(canonicalise)])];
    db.prepare('UPDATE ti_topics SET label = ?, locale = ?, intent = ?, terms = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(
      input.label,
      input.locale ?? existing.locale,
      input.intent ?? existing.intent,
      JSON.stringify(terms),
      ts,
      existing.id,
    );
    return db.prepare('SELECT * FROM ti_topics WHERE id = ?').get(existing.id) as TopicRow;
  }
  const id = uuid();
  db.prepare('INSERT INTO ti_topics (id, slug, label, market, locale, intent, terms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    slug,
    input.label,
    market,
    input.locale ?? null,
    input.intent ?? null,
    JSON.stringify((input.terms ?? [input.label]).map(canonicalise)),
    ts,
    ts,
  );
  return db.prepare('SELECT * FROM ti_topics WHERE id = ?').get(id) as TopicRow;
}

export const listTopics = (): TopicRow[] => getDb().prepare('SELECT * FROM ti_topics ORDER BY updated_at DESC').all() as TopicRow[];

export interface ProfileInputs {
  /** 0-100 from the platform profile's verified mapping. A model may suggest these; only a mapping sets them. */
  fit: number;
  commercialIntent: number;
  timing: number;
  readiness: number;
  vetoes?: string[];
  autoActionOptIn?: boolean;
}

/**
 * Build one family's evidence from its observations for a topic: its best valid observation becomes that family's
 * demand, and the family contributes once however many records it sent.
 */
function familyEvidence(topic: TopicRow, at: string): { families: FamilyEvidence[]; evidenceIds: string[]; notes: string[] } {
  const db = getDb();
  const terms = parseJson<string[]>(topic.terms, []);
  if (!terms.length) return { families: [], evidenceIds: [], notes: ['topic has no terms'] };
  const placeholders = terms.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT o.*, s.family, s.quality, s.stale_after_hours, s.context_only FROM ti_observations o JOIN ti_sources s ON s.id = o.source_id
       WHERE o.term_canonical IN (${placeholders}) AND o.market IN (?, 'ZZ') ORDER BY o.window_end DESC`,
    )
    .all(...terms, topic.market) as (Record<string, any> & { family: string; quality: number; stale_after_hours: number; context_only: number })[];

  const byFamily = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byFamily.get(r.family) ?? [];
    arr.push(r);
    byFamily.set(r.family, arr);
  }

  const families: FamilyEvidence[] = [];
  const evidenceIds: string[] = [];
  const notes: string[] = [];
  for (const [family, obs] of byFamily) {
    // The most recent complete window for this family, with its own history behind it.
    const latest = obs[0];
    const history = obs.slice(1).map((o) => Number(o.value));
    const m = movement({
      current: Number(latest.value),
      history,
      indexed: latest.scaling_scope === 'indexed',
    });
    if (m.insufficientHistory) notes.push(`${family}: ${m.reason}`);
    if (!m.passes) {
      notes.push(`${family}: ${m.reason}`);
      continue;
    }
    const ageHours = Math.max(0, (Date.parse(at) - Date.parse(String(latest.window_end))) / 3_600_000);
    families.push({
      family,
      quality: Number(latest.quality),
      demand: demandFromZ(m.z),
      coverage: Number(latest.coverage),
      ageHours,
      staleAfterHours: Number(latest.stale_after_hours),
      contextOnly: Number(latest.context_only) === 1,
      sourceId: String(latest.source_id),
    });
    evidenceIds.push(String(latest.id));
  }
  return { families, evidenceIds, notes };
}

export interface Snapshot extends Score {
  id: string;
  topicId: string;
  windowEnd: string;
  scoringVersion: string;
  inputDigest: string;
  evidenceIds: string[];
  notes: string[];
}

/**
 * Score a topic and freeze the result.
 *
 * Frozen because an experiment's evidence must not move under it. A correction arriving later creates a superseding
 * snapshot and leaves the original readable, so the question "what did we know when we decided this" always has an
 * answer.
 */
export function snapshotTopic(topicId: string, profile: ProfileInputs, at = now()): Snapshot {
  assertTrendIntelligence();
  const db = getDb();
  const topic = db.prepare('SELECT * FROM ti_topics WHERE id = ?').get(topicId) as TopicRow | undefined;
  if (!topic) throw notFound('Topic not found', 'topic_not_found');

  const { families, evidenceIds, notes } = familyEvidence(topic, at);
  const result = score({ families, ...profile });
  const windowEnd = at;
  const inputDigest = sha256(JSON.stringify([families, profile]));

  const existing = db
    .prepare('SELECT * FROM ti_opportunities WHERE topic_id = ? AND window_end = ? AND scoring_version = ? AND input_digest = ?')
    .get(topicId, windowEnd, SCORING_VERSION, inputDigest) as { id: string } | undefined;
  if (existing) return { ...result, id: existing.id, topicId, windowEnd, scoringVersion: SCORING_VERSION, inputDigest, evidenceIds, notes };

  const id = uuid();
  db.prepare(
    `INSERT INTO ti_opportunities (id, topic_id, window_end, scoring_version, input_digest, opportunity_score, confidence,
       demand, fit, commercial_intent, timing, readiness, source_quality, corroboration, coverage, freshness, families,
       evidence_ids, vetoes, band, reasons, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    topicId,
    windowEnd,
    SCORING_VERSION,
    inputDigest,
    result.opportunityScore,
    result.confidence,
    result.demand,
    result.fit,
    result.commercialIntent,
    result.timing,
    result.readiness,
    result.sourceQuality,
    result.corroboration,
    result.coverage,
    result.freshness,
    JSON.stringify(result.families),
    JSON.stringify(evidenceIds),
    JSON.stringify(result.vetoes),
    result.band,
    JSON.stringify([...result.reasons, ...notes]),
    now(),
  );
  // The topic's status follows the band, so the console shows what the evidence currently supports.
  const status = result.band === 'archive' ? 'dismissed' : result.band === 'watch' ? 'watching' : 'eligible';
  db.prepare('UPDATE ti_topics SET status = ?, updated_at = ? WHERE id = ? AND status NOT IN (?, ?)').run(status, now(), topicId, 'briefed', 'dismissed');
  return { ...result, id, topicId, windowEnd, scoringVersion: SCORING_VERSION, inputDigest, evidenceIds, notes };
}

/**
 * Newest first was the wrong order once the platform started scoring every topic it has: forty archived rows
 * buried the one thing worth reading. Banded first, highest first — the console shows what to act on.
 */
export const listOpportunities = (limit = 50): Record<string, unknown>[] =>
  getDb()
    .prepare(
      `SELECT o.*, t.label, t.slug, t.market, t.locale, t.status AS topic_status FROM ti_opportunities o JOIN ti_topics t ON t.id = o.topic_id
       WHERE o.superseded_by IS NULL
       ORDER BY CASE o.band WHEN 'auto_eligible' THEN 0 WHEN 'brief' THEN 1 WHEN 'watch' THEN 2 ELSE 3 END, o.opportunity_score DESC, o.created_at DESC
       LIMIT ?`,
    )
    .all(Math.min(200, Math.max(1, limit))) as Record<string, unknown>[];
