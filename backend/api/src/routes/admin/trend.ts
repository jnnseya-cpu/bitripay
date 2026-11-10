/**
 * Trend-intelligence console API, mounted at /api/admin/trend.
 *
 * Permissions follow what the action is. Sources, ingestion, topics and snapshots are growth data, so they sit with
 * `cms`. The claim registry is `compliance`, because what this platform is prepared to assert about itself is not a
 * marketing decision. Approving a brief is the one act that changes what the agents publish, so it keeps author and
 * approver apart, takes PIN step-up, and binds to the payload hash the console displayed.
 *
 * Every route is behind the module switch. There is no route that registers a credential, because the detection
 * side of this module holds none: a source whose credential the platform does not have is recorded as unavailable
 * with its reason, and that is the end of it.
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../../lib/http';
import { requirePermission } from '../../middleware/permissions';
import { requireModule } from '../../middleware/modules';
import { audit } from '../../services/audit';
import { assertAdminStepUp } from '../../services/verification';
import { ingestObservations, listOpportunities, listSources, listTopics, markSourceUnavailable, snapshotTopic, upsertSource, upsertTopic } from '../../services/trend/detect';
import {
  BRIEF_CHANNELS,
  BRIEF_TTL_HOURS,
  approveBrief,
  effectiveBrief,
  expireLapsedBriefs,
  getBrief,
  listBriefUses,
  listBriefs,
  listClaims,
  proposeBrief,
  revokeBrief,
  upsertClaim,
} from '../../services/trend/briefs';
import { SCORING_VERSION } from '../../services/trend/scoring';
import { agentStatus } from '../../services/seoAgent';

export const adminTrendRouter = Router();
const r = adminTrendRouter;

// The module switch guards the whole surface, so no handler has to remember it.
r.use(requireModule('trendIntelligence'));

const cms = requirePermission('cms');
const compliance = requirePermission('compliance');

const market = z.string().length(2).toUpperCase();
const score100 = z.number().min(0).max(100);
const iso = z.string().datetime({ offset: true });

// ------------------------------------------------------------------- overview

r.get('/overview', cms, (_req, res) =>
  res.json({
    scoringVersion: SCORING_VERSION,
    ttlHours: BRIEF_TTL_HOURS,
    channels: BRIEF_CHANNELS,
    sources: listSources(),
    topics: listTopics(),
    opportunities: listOpportunities(50),
    briefs: listBriefs({}, 100),
    /** What the content agent would write next, so the console answers the question without a second call. */
    steering: agentStatus().steering,
  }),
);

// -------------------------------------------------------------------- sources

r.get('/sources', cms, (_req, res) => res.json({ data: listSources() }));

const sourceInput = z.object({
  id: z
    .string()
    .max(64)
    .regex(/^[a-z0-9_]+$/, 'A source id is lower-case letters, digits and underscores')
    .optional(),
  name: z.string().min(2).max(120),
  family: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9_]+$/, 'A family is lower-case letters, digits and underscores'),
  accessPath: z.enum(['first_party', 'public_keyless', 'host_mediated', 'file_import']),
  quality: score100.optional(),
  staleAfterHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .optional(),
  cadenceMinutes: z
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 7)
    .optional(),
  /** A context-only source informs the reader but never contributes demand or corroboration. */
  contextOnly: z.boolean().optional(),
  terms: z.string().max(2000).optional().nullable(),
  permittedUses: z.array(z.string().max(60)).max(20).optional(),
  territories: z.array(market).max(50).optional(),
  enabled: z.boolean().optional(),
});

r.post(
  '/sources',
  cms,
  wrap(async (req, res) => {
    const source = upsertSource(validate(sourceInput, req.body));
    audit(req.user!.id, 'trend.source.upsert', 'ti_source', source.id, { family: source.family, accessPath: source.access_path });
    res.status(201).json({ source });
  }),
);

/** Unavailable is a recorded state with a reason. It is never turned into a prompt for a new key. */
r.post(
  '/sources/:id/unavailable',
  cms,
  wrap(async (req, res) => {
    const body = validate(z.object({ reason: z.string().min(4).max(400) }), req.body);
    const source = markSourceUnavailable(String(req.params.id), body.reason);
    audit(req.user!.id, 'trend.source.unavailable', 'ti_source', source.id, { reason: body.reason });
    res.json({ source });
  }),
);

// --------------------------------------------------------------- observations

const observation = z.object({
  sourceId: z.string().max(64),
  sourceRecordId: z.string().min(1).max(200),
  revision: z.number().int().min(1).optional(),
  observedAt: iso,
  windowStart: iso,
  windowEnd: iso,
  term: z.string().min(1).max(300),
  metric: z.string().min(1).max(60),
  value: z.number().finite(),
  unit: z.string().max(20).optional(),
  market: market.optional(),
  locale: z.string().max(12).optional().nullable(),
  segment: z.string().max(60).optional().nullable(),
  scalingScope: z.enum(['absolute', 'indexed']).optional(),
  /** Valid observed over expected windows, 0-1. Short of 1 means part of the period is unknown, not empty. */
  coverage: z.number().min(0).max(1).optional(),
  evidenceUri: z.string().max(500).optional().nullable(),
  termsVersion: z.string().max(60).optional().nullable(),
});

/**
 * Ingestion reports per record: accepted, duplicate, conflict or rejected with the index. A conflict is an operator
 * decision — the same key with a different payload is never resolved by overwriting.
 */
r.post(
  '/observations',
  cms,
  wrap(async (req, res) => {
    const body = validate(z.object({ items: z.array(observation).min(1).max(500) }), req.body);
    const result = ingestObservations(body.items);
    audit(req.user!.id, 'trend.observations.ingest', 'ti_observations', undefined, {
      accepted: result.accepted,
      duplicate: result.duplicate,
      conflict: result.conflict.length,
      rejected: result.rejected.length,
    });
    res.status(201).json(result);
  }),
);

// --------------------------------------------------------- topics & snapshots

r.get('/topics', cms, (_req, res) => res.json({ data: listTopics() }));

r.post(
  '/topics',
  cms,
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        label: z.string().min(2).max(200),
        market,
        locale: z.string().max(12).optional().nullable(),
        intent: z.string().max(300).optional().nullable(),
        terms: z.array(z.string().max(300)).max(50).optional(),
      }),
      req.body,
    );
    const topic = upsertTopic(body);
    audit(req.user!.id, 'trend.topic.upsert', 'ti_topic', topic.id, { slug: topic.slug, market: topic.market });
    res.status(201).json({ topic });
  }),
);

r.get('/opportunities', cms, (req, res) => res.json({ data: listOpportunities(req.query.limit ? Number(req.query.limit) : 50) }));

/**
 * Score a topic now. The profile inputs come from the platform's own mapping, never from a model: a model may
 * suggest a fit, but only an administrator's mapping sets one, which is why they are request fields here.
 */
r.post(
  '/topics/:id/snapshot',
  cms,
  wrap(async (req, res) => {
    const body = validate(
      z.object({ fit: score100, commercialIntent: score100, timing: score100, readiness: score100, vetoes: z.array(z.string().max(200)).max(20).optional(), autoActionOptIn: z.boolean().optional() }),
      req.body,
    );
    const snapshot = snapshotTopic(String(req.params.id), body);
    audit(req.user!.id, 'trend.topic.snapshot', 'ti_opportunity', snapshot.id, { band: snapshot.band, opportunity: snapshot.opportunityScore, confidence: snapshot.confidence });
    res.status(201).json({ snapshot });
  }),
);

// --------------------------------------------------------------------- claims

r.get('/claims', compliance, (_req, res) => res.json({ data: listClaims() }));

r.post(
  '/claims',
  compliance,
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        code: z.string().min(2).max(60),
        text: z.string().min(4).max(600),
        evidence: z.string().max(2000).optional().nullable(),
        validFrom: iso.optional().nullable(),
        validUntil: iso.optional().nullable(),
      }),
      req.body,
    );
    const claim = upsertClaim(body, req.user!.id);
    audit(req.user!.id, 'trend.claim.upsert', 'ti_claim', claim.id, { code: claim.code, revision: claim.revision });
    res.status(201).json({ claim });
  }),
);

// --------------------------------------------------------------------- briefs

r.get('/briefs', cms, (req, res) =>
  res.json({ data: listBriefs({ status: (req.query.status as any) ?? undefined, market: req.query.market ? String(req.query.market).toUpperCase() : undefined }, 200) }),
);
r.get('/briefs/uses', cms, (req, res) => res.json({ data: listBriefUses(req.query.limit ? Number(req.query.limit) : 50) }));

/** What the agents would actually resolve right now, for one scope. The console's "why did it write that" answer. */
r.get('/briefs/effective', cms, (req, res) => {
  const q = validate(z.object({ market, locale: z.string().max(12).optional(), channel: z.enum(BRIEF_CHANNELS), topicId: z.string().max(64).optional() }), {
    market: req.query.market,
    locale: req.query.locale,
    channel: req.query.channel ?? 'seo',
    topicId: req.query.topicId,
  });
  res.json({ brief: effectiveBrief(q) });
});

r.get('/briefs/:id', cms, (req, res) => {
  const brief = getBrief(String(req.params.id));
  if (!brief) return res.status(404).json({ error: { code: 'brief_not_found', message: 'Brief not found' } });
  res.json({ brief: listBriefs({}, 500).find((b) => b.id === brief.id) ?? brief });
});

r.post(
  '/briefs',
  cms,
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        topicId: z.string().max(64),
        opportunityId: z.string().max(64),
        market,
        locale: z.string().max(12),
        audience: z.string().min(4).max(300),
        intent: z.string().min(4).max(300),
        objective: z.string().min(4).max(300),
        allowedChannels: z.array(z.enum(BRIEF_CHANNELS)).min(1).max(BRIEF_CHANNELS.length).optional(),
        approvedClaimIds: z.array(z.string().max(64)).max(20).optional(),
        prohibitedClaims: z.array(z.string().max(300)).max(20).optional(),
        ctaId: z.string().max(64).optional().nullable(),
        experimentId: z.string().max(64).optional().nullable(),
        ttlHours: z.number().int().min(1).max(BRIEF_TTL_HOURS.persistent).optional(),
      }),
      req.body,
    );
    const brief = proposeBrief(body, req.user!.id);
    audit(req.user!.id, 'trend.brief.propose', 'ti_brief', brief.id, { market: brief.market, version: brief.version, topicId: brief.topic_id });
    res.status(201).json({ brief });
  }),
);

/**
 * Maker-checker, step-up, and a hash. A different administrator approves, under PIN, and sends back the hash of the
 * payload the console displayed — so an approval covers the exact brief its approver read and nothing else.
 */
r.post(
  '/briefs/:id/approve',
  cms,
  wrap(async (req, res) => {
    const body = validate(z.object({ payloadHash: z.string().length(64), pin: z.string().optional() }), req.body);
    assertAdminStepUp(req.user!, body.pin, req);
    const brief = approveBrief(String(req.params.id), body.payloadHash, req.user!.id);
    audit(req.user!.id, 'trend.brief.approve', 'ti_brief', brief.id, { market: brief.market, version: brief.version, expiresAt: brief.expires_at });
    res.json({ brief });
  }),
);

r.post(
  '/briefs/:id/revoke',
  cms,
  wrap(async (req, res) => {
    const body = validate(z.object({ reason: z.string().min(4).max(400), pin: z.string().optional() }), req.body);
    assertAdminStepUp(req.user!, body.pin, req);
    const brief = revokeBrief(String(req.params.id), body.reason);
    audit(req.user!.id, 'trend.brief.revoke', 'ti_brief', brief.id, { reason: body.reason });
    res.json({ brief });
  }),
);

/** Housekeeping only. Resolution never depends on this having run — expiry is checked on the read. */
r.post(
  '/briefs/expire-lapsed',
  cms,
  wrap(async (req, res) => {
    const marked = expireLapsedBriefs();
    audit(req.user!.id, 'trend.briefs.expire_lapsed', 'ti_briefs', undefined, { marked });
    res.json({ marked });
  }),
);
