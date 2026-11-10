/**
 * The platform reading itself, end to end, from the tables it already fills.
 *
 * This is the test that decides whether trend intelligence is embedded in BitriPay or merely sitting beside it.
 * Nothing here registers a source, types a topic or enters a score: the fixture writes page views, support tickets
 * and domain events exactly as the running platform writes them, and then the whole loop has to produce a brief
 * the content agent can use.
 *
 * Two of these cases are the ones that matter most, and neither is about accuracy:
 *
 *  - A capability awaiting an authorisation, or switched off, carries a veto and can never carry a brief. Writing
 *    marketing for a function the API would refuse is the single failure here that could cost the licence.
 *  - No ticket subject, body or user ever reaches a trend table. The only reliable guarantee is never reading it,
 *    so the test greps the stored rows for the fixture's own private strings.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setupApp } from './helpers';
import { getDb } from '../db';
import { setSetting, getSeoSettings } from '../services/settings';
import { DEFAULT_MODULES, type ModuleFlags } from '../services/modules';
import { FEATURES, PUBLIC_FEATURES } from '../content/features';
import { uuid } from '../lib/ids';
import {
  EVENT_TYPE_FEATURE,
  PLATFORM_MARKET,
  PLATFORM_SOURCES,
  SUPPORT_CATEGORY_FEATURE,
  autoProposeBriefs,
  claimsForFeature,
  OBSERVATION_RETENTION_DAYS,
  collectPlatformSignals,
  featurePaths,
  pruneObservations,
  platformProfile,
  platformTrendStatus,
  runPlatformTrendCycle,
  scorePlatformTopics,
  syncPlatformTopics,
  timingFromSeries,
} from '../services/trend/platformSignals';
import { listSources, listTopics } from '../services/trend/detect';
import { DOMAIN_EVENT_TYPES } from '../services/bus';
import { approveBrief, listBriefs, payloadHash } from '../services/trend/briefs';
import { resolveSteer, claimBoundary, agentStatus } from '../services/seoAgent';

const QR = 'qr-payments';
const dayOf = (back: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - back)).toISOString().slice(0, 10);

/** Write page views the way the site router writes them: one row per day per path. */
function pageviews(path: string, perDay: number[]) {
  const db = getDb();
  for (const [i, v] of perDay.entries()) {
    if (v <= 0) continue;
    db.prepare('INSERT INTO seo_pageviews (day, path, views) VALUES (?, ?, ?) ON CONFLICT(day, path) DO UPDATE SET views = views + excluded.views').run(dayOf(perDay.length - i), path, v);
  }
}

/** Write tickets the way the support service writes them — subject and body included, as in production. */
function tickets(category: string, perDay: number[], subject = 'My card ending 4242 was declined, I am Jean Bankwa') {
  const db = getDb();
  for (const [i, n] of perDay.entries()) {
    for (let k = 0; k < n; k++) {
      const at = `${dayOf(perDay.length - i)}T09:0${k % 10}:00.000Z`;
      db.prepare('INSERT INTO support_tickets (id, user_id, subject, category, priority, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        uuid(),
        'user_private_identifier',
        subject,
        category,
        'normal',
        'open',
        at,
        at,
      );
    }
  }
}

function events(type: string, perDay: number[]) {
  const db = getDb();
  for (const [i, n] of perDay.entries()) {
    for (let k = 0; k < n; k++) {
      const at = `${dayOf(perDay.length - i)}T12:0${k % 10}:00.000Z`;
      db.prepare('INSERT INTO domain_events (event_id, type, tenant_id, aggregate_id, occurred_at, payload, version, handled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        uuid(),
        type,
        'platform',
        null,
        at,
        '{}',
        1,
        '[]',
      );
    }
  }
}

/**
 * A week of quiet then a surge, in each of three families. Every current figure clears the specification's own
 * gate of twenty: below that a family is excluded however steep its rise, which is why a fixture that looked like
 * a surge in page views alone produced `watch` and no brief — correctly.
 */
const RISING_VIEWS = [10, 11, 10, 9, 10, 11, 10, 95];
const RISING_TICKETS = [3, 4, 3, 3, 4, 3, 3, 26];
const RISING_EVENTS = [5, 6, 5, 5, 6, 5, 5, 42];

function seedRisingInterest(modules: Partial<ModuleFlags> = {}) {
  setSetting('modules', { ...DEFAULT_MODULES, trendIntelligence: true, ...modules });
  const qr = FEATURES.find((f) => f.key === QR)!;
  for (const p of featurePaths(qr)) pageviews(p, RISING_VIEWS);
  tickets('payments', RISING_TICKETS);
  events('payment.captured', RISING_EVENTS);
}

beforeEach(() => {
  setupApp();
  setSetting('modules', { ...DEFAULT_MODULES, trendIntelligence: true });
});

describe('the platform reading its own signals', () => {
  it('registers its own sources and needs no credential to do it', () => {
    collectPlatformSignals();
    const ids = listSources().map((s) => s.id);
    for (const s of PLATFORM_SOURCES) expect(ids, s.id).toContain(s.id);
    // Three independent families, because three people doing three different things is corroboration and a
    // hundred page views is not.
    expect(new Set(listSources().map((s) => s.family)).size).toBeGreaterThanOrEqual(3);
    for (const s of listSources()) expect(s.access_path).toBe('first_party');
  });

  it('never lets a ticket subject, body or user id reach a trend table', () => {
    const secret = 'Jean Bankwa card 4242 private';
    tickets('payments', [3, 4, 5], secret);
    collectPlatformSignals();
    const dump = JSON.stringify(['ti_observations', 'ti_topics', 'ti_opportunities', 'ti_briefs', 'ti_claims', 'ti_sources'].map((t) => getDb().prepare(`SELECT * FROM ${t}`).all()));
    expect(dump).not.toContain('Jean Bankwa');
    expect(dump).not.toContain('4242');
    expect(dump).not.toContain('user_private_identifier');
    // What did land is a count, not a sentence.
    const row = getDb().prepare("SELECT metric, value FROM ti_observations WHERE source_id = 'platform_support' AND value > 0 LIMIT 1").get() as { metric: string; value: number } | undefined;
    expect(row?.metric).toBe('support_tickets');
    expect(typeof row?.value).toBe('number');
  });

  it('invents no baseline for days the platform was not counting', () => {
    // No page view has ever been recorded. Forty-five days of zeros would make the first real visit a spike.
    const res = collectPlatformSignals();
    const pageRows = getDb().prepare("SELECT COUNT(*) c FROM ti_observations WHERE source_id = 'platform_pages'").pluck().get() as number;
    expect(pageRows).toBe(0);
    expect(res.rejected).toBe(0);
  });

  it('lands each day exactly once, so a second pass of the same day is a duplicate and not a second count', () => {
    seedRisingInterest();
    const first = collectPlatformSignals();
    expect(first.accepted).toBeGreaterThan(0);
    expect(first.conflict).toBe(0);
    const second = collectPlatformSignals();
    expect(second.accepted, 'a re-run must add nothing').toBe(0);
    expect(second.duplicate).toBe(first.accepted);
    expect(second.conflict).toBe(0);
  });

  it('excludes the day in progress, so a partial day is never read as a fall', () => {
    seedRisingInterest();
    pageviews('/features/qr-code-payments', []); // no-op; today is written below
    getDb().prepare('INSERT INTO seo_pageviews (day, path, views) VALUES (?, ?, ?)').run(new Date().toISOString().slice(0, 10), '/features/qr-code-payments', 1);
    collectPlatformSignals();
    const windows = getDb().prepare("SELECT DISTINCT substr(window_end, 1, 10) d FROM ti_observations WHERE source_id = 'platform_pages'").pluck().all() as string[];
    expect(windows).not.toContain(new Date().toISOString().slice(0, 10));
  });
});

describe('topics and the profile, from the catalogue', () => {
  it('makes one topic per public feature and none for internal machinery', () => {
    syncPlatformTopics();
    const topics = listTopics().filter((t) => t.market === PLATFORM_MARKET);
    expect(topics).toHaveLength(PUBLIC_FEATURES.length);
    const internal = FEATURES.filter((f) => f.internal);
    for (const f of internal)
      expect(
        topics.some((t) => t.label === f.name),
        `${f.key} must not be a topic`,
      ).toBe(false);
  });

  it('computes the profile from live module state rather than from anyone typing a number', () => {
    const qr = FEATURES.find((f) => f.key === QR)!;
    setSetting('modules', { ...DEFAULT_MODULES, trendIntelligence: true });
    const on = platformProfile(qr);
    expect(on.readiness).toBeGreaterThan(50);
    expect(on.vetoes).toEqual([]);

    setSetting('modules', { ...DEFAULT_MODULES, trendIntelligence: true, qrPayments: false });
    const off = platformProfile(qr);
    expect(off.readiness).toBe(0);
    expect(off.vetoes.join(' ')).toContain('module_off');
  });

  /**
   * The two maps are judgements rather than measurements, and a wrong one is silent: a mistyped feature key
   * attributes real interest to nothing at all, and nobody notices because the figure simply stays flat. They are
   * small enough to read in one screen, so they are checked here instead of being trusted.
   */
  it('maps only to features and event types that actually exist', () => {
    const publicKeys = new Set(PUBLIC_FEATURES.map((f) => f.key));
    for (const [category, key] of Object.entries(SUPPORT_CATEGORY_FEATURE)) {
      expect(
        FEATURES.some((f) => f.key === key),
        `support category "${category}" → unknown feature "${key}"`,
      ).toBe(true);
      expect(publicKeys.has(key), `support category "${category}" → internal feature "${key}"`).toBe(true);
    }
    for (const [type, key] of Object.entries(EVENT_TYPE_FEATURE)) {
      expect(DOMAIN_EVENT_TYPES as readonly string[], `"${type}" is not an event this platform emits`).toContain(type);
      expect(
        FEATURES.some((f) => f.key === key),
        `event "${type}" → unknown feature "${key}"`,
      ).toBe(true);
      expect(publicKeys.has(key), `event "${type}" → internal feature "${key}"`).toBe(true);
    }
    // The support vocabulary is the one the support form offers; an unmapped category contributes to nothing
    // rather than being guessed at, which is deliberate, but a category that does not exist is a typo.
    const offered = ['general', 'payments', 'kyc', 'withdrawals', 'merchant', 'agent', 'security', 'other'];
    for (const category of Object.keys(SUPPORT_CATEGORY_FEATURE)) expect(offered, `"${category}" is not a category the support form offers`).toContain(category);
  });

  it('reads the window from the series, not from a constant somebody chose', () => {
    expect(timingFromSeries([10, 10, 50])).toBe(90);
    expect(timingFromSeries([10, 50, 46])).toBe(70);
    expect(timingFromSeries([10, 50, 30])).toBe(45);
    expect(timingFromSeries([10, 50, 5])).toBe(25);
    expect(timingFromSeries([7]), 'nothing to compare against claims no urgency').toBe(50);
  });
});

describe('the loop, with nobody operating it', () => {
  it('goes from the platform’s own tables to a brief the content agent uses, without a source or score being typed', () => {
    seedRisingInterest();
    expect(resolveSteer()!.outcome, 'the backlog runs until something is approved').toBe('baseline');

    const cycle = runPlatformTrendCycle();
    expect(cycle.ran).toBe(true);
    expect(cycle.collected!.accepted).toBeGreaterThan(0);
    expect(cycle.scored!.scored).toBeGreaterThan(0);
    expect(cycle.proposed, 'the rise should have produced a draft to approve').toBeGreaterThan(0);

    const draft = listBriefs({ status: 'draft' }, 50).find((b) => b.intent.length > 0)!;
    expect(draft.proposed_by, 'the platform proposes; a person disposes').toBe('platform');
    // A draft steers nothing.
    expect(resolveSteer()!.outcome).toBe('baseline');

    // Any administrator may approve, because the maker was not a person.
    approveBrief(draft.id, payloadHash(draft), 'admin_checker');
    const steer = resolveSteer()!;
    expect(steer.outcome).toBe('used');
    expect(steer.brief!.briefId).toBe(draft.id);
    expect(agentStatus().steering.source).toBe('brief');
  });

  it('bounds every agent that writes public copy, not only the article writer', () => {
    seedRisingInterest();
    runPlatformTrendCycle();
    const draft = listBriefs({ status: 'draft' }, 50)[0];
    approveBrief(draft.id, payloadHash(draft), 'admin_checker');

    // The same boundary reaches the article writer, the keyword planner and the auditor.
    const content = claimBoundary('content');
    const seo = claimBoundary('seo');
    for (const text of [content, seo]) {
      expect(text).toContain('must not make');
      expect(text).toContain('unhackable');
      expect(text).toContain(draft.id);
    }
    // The social writer gets nothing, because this brief does not allow that channel.
    expect(claimBoundary('organic_social')).toBe('');
  });

  it('will not brief on one family alone, however steep the rise', () => {
    // Page views surge; nobody opens a ticket and nothing happens in the product. That is one observation of
    // interest repeated, not three sources agreeing, and it must not reach the brief band.
    setSetting('modules', { ...DEFAULT_MODULES, trendIntelligence: true });
    const qr = FEATURES.find((f) => f.key === QR)!;
    for (const p of featurePaths(qr)) pageviews(p, RISING_VIEWS);
    const cycle = runPlatformTrendCycle();
    expect(cycle.proposed).toBe(0);
    const topic = listTopics().find((t) => t.label === qr.name)!;
    const snap = getDb().prepare('SELECT band, corroboration, confidence, families, reasons FROM ti_opportunities WHERE topic_id = ? ORDER BY created_at DESC LIMIT 1').get(topic.id) as {
      band: string;
      corroboration: number;
      confidence: number;
      families: string;
      reasons: string;
    };
    expect(JSON.parse(snap.families)).toEqual(['site_traffic']);
    expect(snap.corroboration).toBe(0);
    expect(snap.confidence).toBeLessThan(70);
    expect(snap.band).toBe('watch');
    // And it says why, rather than returning a confident number nobody can trace.
    expect(JSON.parse(snap.reasons).join(' ')).toMatch(/below the .* brief bar/);
  });

  it('refuses to brief a capability the platform would itself refuse', () => {
    // QR acceptance is switched off by the administrator: interest in it is real, marketing it is not allowed.
    seedRisingInterest({ qrPayments: false });
    const cycle = runPlatformTrendCycle();
    expect(cycle.scored!.scored).toBeGreaterThan(0);
    const qrTopic = listTopics().find((t) => t.label === FEATURES.find((f) => f.key === QR)!.name)!;
    const snap = getDb().prepare('SELECT band, vetoes FROM ti_opportunities WHERE topic_id = ? ORDER BY created_at DESC LIMIT 1').get(qrTopic.id) as { band: string; vetoes: string };
    expect(JSON.parse(snap.vetoes).join(' ')).toContain('module_off');
    expect(snap.band, 'a vetoed snapshot is never in the brief band').not.toBe('brief');
    expect(
      listBriefs({}, 50).some((b) => b.topic_id === qrTopic.id),
      'no brief for a switched-off capability',
    ).toBe(false);
  });

  it('only ever lets the writer restate what the platform already publishes', () => {
    const qr = FEATURES.find((f) => f.key === QR)!;
    const ids = claimsForFeature(qr);
    expect(ids).toHaveLength(qr.proof.length);
    const stored = getDb()
      .prepare(`SELECT text, evidence, approved_by FROM ti_claims WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as { text: string; evidence: string; approved_by: string }[];
    for (const row of stored) {
      expect(qr.proof, 'a claim must be a line the feature page already carries').toContain(row.text);
      expect(row.evidence).toContain(`/features/${qr.slug}`);
      expect(row.approved_by).toBe('catalogue');
    }
    // Registering twice is the same claim, not a second revision.
    expect(claimsForFeature(qr)).toEqual(ids);
  });

  it('does nothing at all while the module is off, and resumes without losing what it read', () => {
    seedRisingInterest();
    runPlatformTrendCycle();
    const before = platformTrendStatus().observations;
    expect(before).toBeGreaterThan(0);

    setSetting('modules', { ...DEFAULT_MODULES, trendIntelligence: false });
    const off = runPlatformTrendCycle();
    expect(off.ran).toBe(false);
    expect(off.proposed).toBe(0);
    expect(resolveSteer()!.outcome).toBe('baseline');
    expect(claimBoundary('content')).toBe('');

    setSetting('modules', { ...DEFAULT_MODULES, trendIntelligence: true });
    expect(platformTrendStatus().observations, 'what it read is still there').toBe(before);
  });

  it('keeps a bounded window of its own counts, and never sweeps the audit trail', () => {
    seedRisingInterest();
    runPlatformTrendCycle();
    const db = getDb();
    const before = db.prepare('SELECT COUNT(*) c FROM ti_observations').pluck().get() as number;
    const briefsBefore = listBriefs({}, 100).length;
    const snapshotsBefore = db.prepare('SELECT COUNT(*) c FROM ti_opportunities').pluck().get() as number;
    expect(before).toBeGreaterThan(0);
    expect(briefsBefore).toBeGreaterThan(0);

    // Nothing is old enough yet, so an ordinary pass removes nothing.
    expect(pruneObservations()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM ti_observations').pluck().get()).toBe(before);

    // Age one row past the window and it goes.
    const victim = db.prepare('SELECT id FROM ti_observations LIMIT 1').pluck().get() as string;
    const old = new Date(Date.now() - (OBSERVATION_RETENTION_DAYS + 5) * 86_400_000).toISOString();
    db.prepare('UPDATE ti_observations SET window_end = ? WHERE id = ?').run(old, victim);
    expect(pruneObservations()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM ti_observations').pluck().get()).toBe(before - 1);

    // What must never be swept: the frozen decision and what the platform was allowed to say.
    expect(db.prepare('SELECT COUNT(*) c FROM ti_opportunities').pluck().get()).toBe(snapshotsBefore);
    expect(listBriefs({}, 100)).toHaveLength(briefsBefore);
    expect(db.prepare('SELECT COUNT(*) c FROM ti_claims').pluck().get() as number).toBeGreaterThan(0);
  });

  it('drafts one brief per topic, not one per run', () => {
    seedRisingInterest();
    runPlatformTrendCycle();
    const after1 = listBriefs({}, 100).length;
    expect(after1).toBeGreaterThan(0);
    const again = autoProposeBriefs();
    expect(again.proposed, 'a topic that already has an open brief is skipped').toHaveLength(0);
    expect(listBriefs({}, 100)).toHaveLength(after1);
  });

  it('says nothing rather than guessing while it has too little of its own history', () => {
    setSetting('modules', { ...DEFAULT_MODULES, trendIntelligence: true });
    const qr = FEATURES.find((f) => f.key === QR)!;
    for (const p of featurePaths(qr)) pageviews(p, [5, 6]); // two days only
    collectPlatformSignals();
    syncPlatformTopics();
    const scored = scorePlatformTopics();
    expect(scored.scored, 'two days is not a baseline').toBe(0);
    expect(scored.skipped).toBeGreaterThan(0);
    expect(autoProposeBriefs().proposed).toHaveLength(0);
  });

  it('publishes to whatever markets the platform serves, because a page view names no country', () => {
    seedRisingInterest();
    runPlatformTrendCycle();
    const draft = listBriefs({ status: 'draft' }, 50)[0];
    expect(draft.market, 'ZZ is the ISO code for unknown, and the resolver reads it as any market').toBe(PLATFORM_MARKET);
    approveBrief(draft.id, payloadHash(draft), 'admin_checker');
    // Whichever configured market the agent asks about, this brief answers.
    const markets = getSeoSettings().agent.markets;
    expect(markets.length).toBeGreaterThan(1);
    expect(resolveSteer()!.brief!.briefId).toBe(draft.id);
  });
});
