/**
 * The platform reading itself.
 *
 * Trend intelligence is not a separate product bolted beside BitriPay; it is the platform noticing what its own
 * people already ask for. Everything here comes from data the platform collects anyway — pages it served, support
 * tickets it received, product events it emitted — and from the catalogue it already publishes. No source is
 * registered by hand, no topic is typed, no score is entered, and nothing asks for a credential. An administrator
 * who never opens the console still gets the whole loop; the one thing a person does is approve a brief, because
 * nothing else may decide what this platform claims about itself.
 *
 * Three rules govern what is read:
 *
 *  - **Counts, never content.** A support ticket contributes its *category* and nothing else. No subject, no body,
 *    no user id, no country ever reaches a trend table. The growth tables must not become a second place where
 *    personal data lives, and the only reliable way to guarantee that is never to read it.
 *  - **The vocabulary is the platform's own.** Topics are the catalogue's features, not arbitrary strings, so a
 *    brief can only ever be about something this platform actually does.
 *  - **Availability vetoes everything.** A capability the platform would refuse — awaiting an authorisation, or
 *    switched off by an administrator — carries a veto and can never carry a brief. Writing marketing for a
 *    function the API would reject is the one failure here that could cost the licence.
 *
 * These signals have no market dimension: a page view does not say where the reader was, and asking would mean
 * reading more than we need. They are therefore recorded against `ZZ`, the ISO 3166 user-assigned code for an
 * unknown country, which the brief resolver already treats as "any market".
 */
import { getDb } from '../../db';
import { FEATURES, PUBLIC_FEATURES, featureText, type Feature } from '../../content/features';
import { featureAvailability } from '../../site/features';
import { getModules } from '../modules';
import { getSeoSettings } from '../settings';
import { canonicalise, ingestObservations, listTopics, snapshotTopic, upsertSource, upsertTopic, type ObservationInput, type ProfileInputs, type TopicRow } from './detect';
import { MIN_COMPARABLE_PERIODS } from './scoring';
import { listBriefs, proposeBrief, upsertClaim } from './briefs';
import { trendIntelligenceOn } from './gate';

/** Signals have no country, so they belong to no country. ZZ is "unknown", and the resolver reads it as "any". */
export const PLATFORM_MARKET = 'ZZ';

/** Proposed by the platform itself, never by a person — which is also why any administrator may approve one. */
export const PLATFORM_PROPOSER = 'platform';

/**
 * The three signals the platform already collects. Each is a distinct **family**, because that is what corroboration
 * counts: somebody reading a page, somebody opening a ticket and somebody using the product are three independent
 * observations of the same interest, while a hundred page views are one.
 */
export const PLATFORM_SOURCES = [
  {
    id: 'platform_pages',
    family: 'site_traffic',
    name: 'Pages this platform served',
    quality: 80,
    staleAfterHours: 48,
    permittedUses: ['own_growth'],
    terms: 'First-party: this platform’s own web server, counted per day and per path. No visitor is identified.',
  },
  {
    id: 'platform_support',
    family: 'support',
    name: 'Support queue, by category',
    quality: 90,
    staleAfterHours: 72,
    permittedUses: ['own_growth'],
    terms: 'First-party: counts of tickets per category per day. Subjects, bodies and user identities are never read.',
  },
  {
    id: 'platform_events',
    family: 'product_events',
    name: 'Product events',
    quality: 95,
    staleAfterHours: 48,
    permittedUses: ['own_growth'],
    terms: 'First-party: counts of domain events per type per day. Payloads are never read.',
  },
] as const;

export function registerPlatformSources(): void {
  for (const s of PLATFORM_SOURCES) {
    upsertSource({
      id: s.id,
      name: s.name,
      family: s.family,
      accessPath: 'first_party',
      quality: s.quality,
      staleAfterHours: s.staleAfterHours,
      cadenceMinutes: 60 * 24,
      terms: s.terms,
      permittedUses: [...s.permittedUses],
      enabled: true,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// What each feature is measured by
// ---------------------------------------------------------------------------------------------

/** The paths this platform serves for one feature: its page and its article, in both languages. */
export function featurePaths(f: Feature): string[] {
  const paths = [`/features/${f.slug}`];
  for (const lang of ['en', 'fr'] as const) {
    const slug = featureText(f, lang).articleSlug;
    if (slug) paths.push(`/blog/${slug}`);
  }
  return [...new Set(paths)];
}

/**
 * Support categories, mapped to the feature that owns them. The vocabulary is the one the support form offers;
 * anything else contributes to no feature rather than being guessed at.
 */
export const SUPPORT_CATEGORY_FEATURE: Record<string, string> = {
  payments: 'qr-payments',
  kyc: 'kyc-and-identity',
  withdrawals: 'withdrawals',
  merchant: 'hosted-checkout',
  agent: 'agents-and-cash',
  security: 'risk-and-compliance',
};

/** Domain event types, mapped to the feature whose code emits them. Unmapped types contribute to nothing. */
export const EVENT_TYPE_FEATURE: Record<string, string> = {
  'transaction.created': 'wallets-and-transfers',
  'transaction.settled': 'wallets-and-transfers',
  'wallet.credited': 'add-money',
  'wallet.debited': 'wallets-and-transfers',
  'payment.captured': 'qr-payments',
  'kyc.tier_changed': 'kyc-and-identity',
  'agent.float_low': 'agents-and-cash',
  'dispute.opened': 'disputes',
  'merchant.created': 'hosted-checkout',
  'subscription.charged': 'subscriptions',
  'open_banking.linked': 'open-banking',
  'open_banking.income_verified': 'open-banking',
  'income.received': 'open-banking',
  'credit.readiness_updated': 'credit-readiness',
  'diaspora.quote_created': 'remittance',
  'settlement.cycle_closed': 'settlement-and-statements',
  'statement.imported': 'settlement-and-statements',
  'offline.promise_rejected': 'offline-payments',
  'sanctions.hit': 'risk-and-compliance',
  'verification.requested': 'risk-and-compliance',
};

// ---------------------------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------------------------

const dayKey = (iso: string) => iso.slice(0, 10);
const dayStart = (day: string) => `${day}T00:00:00.000Z`;
const dayEnd = (day: string) => `${day}T23:59:59.999Z`;

/** Whole days only, and never today: a day still in progress would report a dip that is only the clock. */
function completedDays(fromDay: string, back: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = back; i >= 1; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    if (key >= fromDay) out.push(key);
  }
  return out;
}

const observation = (sourceId: string, featureKey: string, day: string, term: string, metric: string, value: number): ObservationInput => ({
  sourceId,
  sourceRecordId: `${sourceId}:${featureKey}:${day}`,
  observedAt: dayEnd(day),
  windowStart: dayStart(day),
  windowEnd: dayEnd(day),
  term,
  metric,
  value,
  market: PLATFORM_MARKET,
  coverage: 1,
});

export interface CollectResult {
  accepted: number;
  duplicate: number;
  conflict: number;
  rejected: number;
  days: number;
}

/**
 * Turn the last `days` complete days of the platform's own signals into observations.
 *
 * Idempotent by construction: the record id is source, feature and day, so running it twice a day, or re-running it
 * after a restart, lands nothing twice — the ingestion rules report the second pass as duplicates. A day's figure
 * never changes once the day is over, so a conflict here would mean a real inconsistency rather than a retry.
 */
export function collectPlatformSignals(days = 45): CollectResult {
  const db = getDb();
  registerPlatformSources();
  const out: CollectResult = { accepted: 0, duplicate: 0, conflict: 0, rejected: 0, days: 0 };

  // Only days the platform was actually counting. Before the first row there is no evidence of nothing; there is
  // simply no evidence, and recording a zero there would invent a baseline.
  const firstView = db.prepare('SELECT MIN(day) d FROM seo_pageviews').pluck().get() as string | null;
  const firstTicket = (db.prepare('SELECT MIN(created_at) d FROM support_tickets').pluck().get() as string | null) ?? null;
  const firstEvent = (db.prepare('SELECT MIN(occurred_at) d FROM domain_events').pluck().get() as string | null) ?? null;

  const items: ObservationInput[] = [];

  // --- pages served -----------------------------------------------------------------------
  // No pageview row at all means the platform was not counting, not that nobody came. Forty-five days of invented
  // zeros would give every feature a flat baseline and make the first real visit look like a spike.
  const viewDays = firstView ? completedDays(firstView, days) : [];
  const viewRows = viewDays.length
    ? (db.prepare('SELECT day, path, SUM(views) v FROM seo_pageviews WHERE day >= ? GROUP BY day, path').all(viewDays[0]) as { day: string; path: string; v: number }[])
    : [];
  const viewsByDayPath = new Map(viewRows.map((r) => [`${r.day}|${r.path}`, r.v]));
  for (const f of viewDays.length ? PUBLIC_FEATURES : []) {
    const paths = featurePaths(f);
    const term = featureTerm(f);
    for (const day of viewDays) {
      const v = paths.reduce((n, p) => n + (viewsByDayPath.get(`${day}|${p}`) ?? 0), 0);
      items.push(observation('platform_pages', f.key, day, term, 'page_views', v));
    }
  }

  // --- support, by category only ----------------------------------------------------------
  // Same rule as pages: no ticket ever means the queue has no history, not that every day was quiet. A flood of
  // invented zeros would give every mapped feature a flat baseline and make the first real ticket a spike.
  const ticketDays = firstTicket ? completedDays(dayKey(firstTicket), days) : [];
  if (ticketDays.length) {
    const rows = db.prepare('SELECT substr(created_at, 1, 10) day, category, COUNT(*) c FROM support_tickets WHERE created_at >= ? GROUP BY day, category').all(dayStart(ticketDays[0])) as {
      day: string;
      category: string;
      c: number;
    }[];
    const byDayCategory = new Map(rows.map((r) => [`${r.day}|${r.category}`, r.c]));
    for (const [category, featureKey] of Object.entries(SUPPORT_CATEGORY_FEATURE)) {
      const f = FEATURES.find((x) => x.key === featureKey);
      if (!f) continue;
      for (const day of ticketDays) items.push(observation('platform_support', f.key, day, featureTerm(f), 'support_tickets', byDayCategory.get(`${day}|${category}`) ?? 0));
    }
  }

  // --- product events ---------------------------------------------------------------------
  const eventDays = firstEvent ? completedDays(dayKey(firstEvent), days) : [];
  if (eventDays.length) {
    const rows = db.prepare('SELECT substr(occurred_at, 1, 10) day, type, COUNT(*) c FROM domain_events WHERE occurred_at >= ? GROUP BY day, type').all(dayStart(eventDays[0])) as {
      day: string;
      type: string;
      c: number;
    }[];
    const byDayFeature = new Map<string, number>();
    for (const r of rows) {
      const key = EVENT_TYPE_FEATURE[r.type];
      if (!key) continue;
      byDayFeature.set(`${r.day}|${key}`, (byDayFeature.get(`${r.day}|${key}`) ?? 0) + r.c);
    }
    for (const featureKey of new Set(Object.values(EVENT_TYPE_FEATURE))) {
      const f = FEATURES.find((x) => x.key === featureKey);
      if (!f) continue;
      for (const day of eventDays) items.push(observation('platform_events', f.key, day, featureTerm(f), 'product_events', byDayFeature.get(`${day}|${f.key}`) ?? 0));
    }
  }

  out.days = Math.max(viewDays.length, ticketDays.length, eventDays.length);
  for (let i = 0; i < items.length; i += 500) {
    const r = ingestObservations(items.slice(i, i + 500));
    out.accepted += r.accepted;
    out.duplicate += r.duplicate;
    out.conflict += r.conflict.length;
    out.rejected += r.rejected.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Topics, from the catalogue
// ---------------------------------------------------------------------------------------------

/** One term per feature, so every signal about a feature clusters without any guessing. */
export const featureTerm = (f: Feature): string => f.name;
export const featureTopicSlug = (f: Feature): string => canonicalise(f.name).replace(/ /g, '-');

/** A topic per feature, with the catalogue's own keywords as its terms. Idempotent; it revises rather than duplicates. */
export function syncPlatformTopics(): { topics: number } {
  const languages = getSeoSettings().agent.languages;
  let n = 0;
  for (const f of PUBLIC_FEATURES) {
    upsertTopic({
      label: f.name,
      market: PLATFORM_MARKET,
      locale: languages[0] ?? 'en',
      intent: f.usp.slice(0, 280),
      terms: [f.name, ...f.keywords],
    });
    n++;
  }
  return { topics: n };
}

const topicForFeature = (f: Feature): TopicRow | undefined => listTopics().find((t) => t.slug === featureTopicSlug(f) && t.market === PLATFORM_MARKET);

// ---------------------------------------------------------------------------------------------
// The profile, computed rather than typed
// ---------------------------------------------------------------------------------------------

/**
 * Commercial intent by what the capability is for. Money actions sit closest to somebody acting; the machinery that
 * makes them trustworthy sits furthest. These are the platform's own categories, so the mapping is a statement
 * about the catalogue rather than a guess about a market.
 */
const INTENT_BY_CATEGORY: Record<Feature['category'], number> = { accept: 85, move: 80, reach: 65, build: 60, operate: 45, trust: 40 };

/**
 * How much of the window is left, read from the series itself: a rise that is current is still actionable, one that
 * peaked a fortnight ago is not. Nothing here is a constant somebody chose — it is where the latest period sits
 * against the highest the platform has seen.
 */
export function timingFromSeries(series: number[]): number {
  if (series.length < 2) return 50;
  const latest = series[series.length - 1];
  const peak = Math.max(...series);
  if (peak <= 0) return 50;
  if (latest >= peak) return 90;
  if (latest >= peak * 0.9) return 70;
  if (latest >= peak * 0.6) return 45;
  return 25;
}

/**
 * Fit, readiness and the vetoes, read from live module state.
 *
 * The veto is the load-bearing part. A capability awaiting an authorisation, or switched off by an administrator,
 * cannot carry a brief at all — so the platform can never be made to advertise a function its own API would
 * refuse. That is not a scoring nicety; it is the rule that keeps a growth tool from costing a licence.
 */
export function platformProfile(f: Feature, series: number[] = []): ProfileInputs {
  const availability = featureAvailability(f, getModules());
  const vetoes: string[] = [];
  if (availability.state === 'awaiting_authorisation') vetoes.push('awaiting_authorisation: this capability is not authorised yet and must not be marketed');
  if (availability.state === 'switched_off') vetoes.push('module_off: an administrator has switched this capability off');
  return {
    fit: availability.state === 'available' ? 90 : 20,
    commercialIntent: INTENT_BY_CATEGORY[f.category],
    timing: timingFromSeries(series),
    readiness: availability.state === 'available' ? 85 : 0,
    vetoes,
    autoActionOptIn: false,
  };
}

/** The platform's own figures for one feature, newest last — what `timingFromSeries` reads. */
function seriesFor(f: Feature): number[] {
  const rows = getDb()
    .prepare(
      `SELECT window_end, SUM(value) v FROM ti_observations
       WHERE term_canonical = ? AND market = ? GROUP BY window_end ORDER BY window_end ASC`,
    )
    .all(canonicalise(featureTerm(f)), PLATFORM_MARKET) as { window_end: string; v: number }[];
  return rows.map((r) => r.v);
}

export interface ScoreRunResult {
  scored: number;
  skipped: number;
  banded: Record<string, number>;
}

/** Score every catalogued topic that has enough of the platform's own history behind it. */
export function scorePlatformTopics(): ScoreRunResult {
  const out: ScoreRunResult = { scored: 0, skipped: 0, banded: {} };
  for (const f of PUBLIC_FEATURES) {
    const topic = topicForFeature(f);
    if (!topic) {
      out.skipped++;
      continue;
    }
    const series = seriesFor(f);
    if (series.length <= MIN_COMPARABLE_PERIODS) {
      out.skipped++;
      continue;
    }
    const snap = snapshotTopic(topic.id, platformProfile(f, series));
    out.scored++;
    out.banded[snap.band] = (out.banded[snap.band] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Drafting a brief the platform can defend
// ---------------------------------------------------------------------------------------------

/**
 * Register this feature's published proof lines as claims the writer may restate.
 *
 * These are not new assertions. Every one of them is already on the feature's public page and in its article —
 * the platform says them today. Registering them means the writer can restate what the site already commits to and
 * nothing beyond it, with the provenance recorded as the catalogue rather than as a person who typed it.
 */
export function claimsForFeature(f: Feature): string[] {
  return f.proof.map((text, i) => upsertClaim({ code: `FEATURE_${f.key.replace(/-/g, '_').toUpperCase()}_${i + 1}`, text, evidence: `Published on /features/${f.slug}` }, 'catalogue').id);
}

/** What a brief must never say about a payment platform, whatever the topic. */
export const PLATFORM_PROHIBITED_CLAIMS = [
  'any promise of a search ranking or of traffic',
  'any guaranteed arrival time for money',
  'any statement that the platform is unhackable, fully secure or risk-free',
  'any licence, authorisation or partner the feature page does not already name',
  'any figure, statistic, price or customer quote not already published by this platform',
];

export interface ProposeResult {
  proposed: string[];
  skipped: number;
}

/**
 * Draft a brief for every topic the scorer put in the brief band that has none live.
 *
 * The platform proposes; a person disposes. `proposed_by` is the platform itself, so any administrator may approve
 * — maker-checker is preserved because the maker is not a person who could rubber-stamp their own work. Nothing
 * here approves anything, and a draft steers nothing.
 */
export function autoProposeBriefs(): ProposeResult {
  const out: ProposeResult = { proposed: [], skipped: 0 };
  const live = listBriefs({}, 500);
  const openFor = new Set(live.filter((b) => (b.status === 'approved' && !b.expired) || b.status === 'draft').map((b) => b.topic_id));

  const rows = getDb()
    .prepare(
      `SELECT o.id, o.topic_id, o.band, t.slug FROM ti_opportunities o JOIN ti_topics t ON t.id = o.topic_id
       WHERE o.superseded_by IS NULL AND o.band IN ('brief', 'auto_eligible') AND t.market = ?
       ORDER BY o.opportunity_score DESC`,
    )
    .all(PLATFORM_MARKET) as { id: string; topic_id: string; band: string; slug: string }[];

  for (const row of rows) {
    if (openFor.has(row.topic_id)) {
      out.skipped++;
      continue;
    }
    const f = PUBLIC_FEATURES.find((x) => featureTopicSlug(x) === row.slug);
    if (!f) {
      out.skipped++;
      continue;
    }
    try {
      const brief = proposeBrief(
        {
          topicId: row.topic_id,
          opportunityId: row.id,
          market: PLATFORM_MARKET,
          locale: getSeoSettings().agent.languages[0] ?? 'en',
          audience: f.audience.slice(0, 280),
          intent: f.headline.slice(0, 280),
          objective: `A reader can tell whether ${f.name} answers their problem, and what to do next`,
          allowedChannels: ['seo', 'content'],
          approvedClaimIds: claimsForFeature(f),
          prohibitedClaims: PLATFORM_PROHIBITED_CLAIMS,
        },
        PLATFORM_PROPOSER,
      );
      out.proposed.push(brief.id);
      openFor.add(row.topic_id);
    } catch {
      // A veto, a band that moved under us, or a claim that lapsed. The snapshot keeps the reason; this is a
      // scheduled pass, not a request, so one topic refusing must not stop the rest.
      out.skipped++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The whole loop
// ---------------------------------------------------------------------------------------------

export interface PlatformRunResult {
  ran: boolean;
  collected: CollectResult | null;
  topics: number;
  scored: ScoreRunResult | null;
  proposed: number;
  pruned: number;
}

/**
 * How long the platform's own observations are kept.
 *
 * Long enough to compare a period against the same period last year, and no longer. The rows hold nothing but
 * counts, so this is housekeeping rather than a privacy control — but a table that only ever grows is a table
 * somebody has to deal with later, and "we never decided" is not a retention policy.
 *
 * Frozen snapshots and briefs are deliberately **not** swept. An opportunity records what the platform decided and
 * a brief records what it was allowed to say; deleting those would erase the audit trail that answers "why did it
 * write that", which is the opposite of what retention is for.
 */
export const OBSERVATION_RETENTION_DAYS = 400;

export function pruneObservations(retainDays = OBSERVATION_RETENTION_DAYS): number {
  const cutoff = new Date(Date.now() - retainDays * 86_400_000).toISOString();
  return getDb().prepare('DELETE FROM ti_observations WHERE window_end < ?').run(cutoff).changes;
}

/**
 * Collect, cluster, score and draft — the entire loop, from the platform's own data, with nobody operating it.
 * Called once a day by the scheduler. Off means off: it does nothing at all rather than accumulating quietly.
 */
export function runPlatformTrendCycle(): PlatformRunResult {
  if (!trendIntelligenceOn()) return { ran: false, collected: null, topics: 0, scored: null, proposed: 0, pruned: 0 };
  const collected = collectPlatformSignals();
  const { topics } = syncPlatformTopics();
  const scored = scorePlatformTopics();
  const proposed = autoProposeBriefs();
  const pruned = pruneObservations();
  return { ran: true, collected, topics, scored, proposed: proposed.proposed.length, pruned };
}

/** What the console shows about the automatic side: whether it has run, and what it is holding. */
export function platformTrendStatus() {
  const db = getDb();
  const observations = db.prepare('SELECT COUNT(*) c FROM ti_observations').pluck().get() as number;
  const lastWindow = db.prepare('SELECT MAX(window_end) w FROM ti_observations').pluck().get() as string | null;
  const drafts = listBriefs({ status: 'draft' }, 100).length;
  const live = listBriefs({ status: 'approved' }, 100).filter((b) => !b.expired).length;
  return {
    sources: PLATFORM_SOURCES.map((s) => s.id),
    observations,
    lastWindowEnd: lastWindow,
    topics: listTopics().filter((t) => t.market === PLATFORM_MARKET).length,
    draftsAwaitingApproval: drafts,
    liveBriefs: live,
    /** True once there is enough of the platform's own history for the scorer to say anything at all. */
    hasEnoughHistory: Boolean(lastWindow) && observations > 0,
  };
}
