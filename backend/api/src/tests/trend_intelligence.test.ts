/**
 * Ingestion, snapshots and the brief lifecycle, against the specification's conformance scenarios.
 *
 * The negative cases are the point. A signal pipeline that double-counts manufactures confidence, an approval that
 * survives an edit is not an approval, and a brief that keeps steering an agent after it has lapsed is worse than no
 * brief at all — so TI-01, TI-04 and TI-05 are asserted here rather than assumed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setupApp } from './helpers';
import { setSetting } from '../services/settings';
import { DEFAULT_MODULES } from '../services/modules';
import { getDb } from '../db';
import { upsertSource, ingestObservations, upsertTopic, snapshotTopic, canonicalise, listSources, markSourceUnavailable } from '../services/trend/detect';
import {
  proposeBrief,
  approveBrief,
  effectiveBrief,
  revokeBrief,
  payloadHash,
  getBrief,
  expireLapsedBriefs,
  recordBriefUse,
  listBriefUses,
  upsertClaim,
  listClaims,
  BRIEF_TTL_HOURS,
} from '../services/trend/briefs';
import { uuid } from '../lib/ids';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

/**
 * A fresh database with the module switched on. It ships off, so every test that exercises the pipeline has to turn
 * it on first — which is the point: the gate is asserted at the bottom of this file, not assumed.
 */
function reset() {
  setupApp();
  setSetting('modules', { ...DEFAULT_MODULES, trendIntelligence: true });
}

/** A source family with `periods` complete windows of history, then a current window at `current`. */
function seedFamily(sourceId: string, family: string, term: string, opts: { quality?: number; history: number[]; current: number; market?: string; contextOnly?: boolean; indexed?: boolean }) {
  upsertSource({ id: sourceId, name: sourceId, family, accessPath: 'first_party', quality: opts.quality ?? 90, staleAfterHours: 48, contextOnly: opts.contextOnly });
  const items = [...opts.history, opts.current].map((value, i) => {
    const age = (opts.history.length - i) * 24 + 1;
    return {
      sourceId,
      sourceRecordId: `${sourceId}-${i}`,
      observedAt: hoursAgo(age),
      windowStart: hoursAgo(age + 24),
      windowEnd: hoursAgo(age),
      term,
      metric: 'searches',
      value,
      market: opts.market ?? 'CD',
      scalingScope: opts.indexed ? ('indexed' as const) : ('absolute' as const),
    };
  });
  return ingestObservations(items);
}

const PROFILE = { fit: 95, commercialIntent: 85, timing: 90, readiness: 80 };

describe('ingestion rules', () => {
  // A returned value from a hook is vitest's teardown, so the app must not escape: these cases exercise the services directly.
  beforeEach(reset);

  it('TI-01 · an exact replay is a duplicate, and an altered payload under the same key is a conflict', () => {
    upsertSource({ id: 'src_a', name: 'First-party search', family: 'first_party', accessPath: 'first_party' });
    const one = {
      sourceId: 'src_a',
      sourceRecordId: 'rec-1',
      observedAt: hoursAgo(2),
      windowStart: hoursAgo(26),
      windowEnd: hoursAgo(2),
      term: 'envoyer de l’argent',
      metric: 'searches',
      value: 42,
      market: 'CD',
    };
    expect(ingestObservations([one])).toMatchObject({ accepted: 1, duplicate: 0 });
    expect(ingestObservations([one]), 'the same record replayed must not land twice').toMatchObject({ accepted: 0, duplicate: 1 });

    const altered = ingestObservations([{ ...one, value: 9000 }]);
    expect(altered.accepted).toBe(0);
    expect(altered.conflict).toHaveLength(1);
    expect(altered.conflict[0].reason).toContain('different payload');
    expect(getDb().prepare('SELECT COUNT(*) c FROM ti_observations').pluck().get()).toBe(1);
  });

  it('rejects an unregistered source and an unavailable one, by index, without failing the batch', () => {
    upsertSource({ id: 'src_ok', name: 'ok', family: 'first_party', accessPath: 'first_party' });
    upsertSource({ id: 'src_off', name: 'off', family: 'public_feed', accessPath: 'public_keyless' });
    markSourceUnavailable('src_off', 'needs a credential this platform does not hold');
    const base = { observedAt: hoursAgo(2), windowStart: hoursAgo(26), windowEnd: hoursAgo(2), term: 'x', metric: 'searches', value: 5, market: 'CD' };
    const res = ingestObservations([
      { ...base, sourceId: 'src_ok', sourceRecordId: 'a' },
      { ...base, sourceId: 'src_nope', sourceRecordId: 'b' },
      { ...base, sourceId: 'src_off', sourceRecordId: 'c' },
    ]);
    expect(res.accepted).toBe(1);
    expect(res.rejected.map((r) => r.index)).toEqual([1, 2]);
    expect(res.rejected[1].reason).toContain('unavailable');
    // Unavailable is a recorded state with a reason, never a prompt for a new key.
    expect(listSources().find((s) => s.id === 'src_off')!.unavailable_reason).toContain('credential');
  });

  it('refuses a window that ends before it starts, and a value that is not a number', () => {
    upsertSource({ id: 'src_a', name: 'a', family: 'first_party', accessPath: 'first_party' });
    const res = ingestObservations([
      { sourceId: 'src_a', sourceRecordId: 'bad-window', observedAt: hoursAgo(2), windowStart: hoursAgo(1), windowEnd: hoursAgo(5), term: 'x', metric: 'm', value: 1 },
      { sourceId: 'src_a', sourceRecordId: 'bad-value', observedAt: hoursAgo(2), windowStart: hoursAgo(26), windowEnd: hoursAgo(2), term: 'x', metric: 'm', value: Number.NaN },
    ]);
    expect(res.accepted).toBe(0);
    expect(res.rejected).toHaveLength(2);
  });

  it('canonicalises accents and punctuation while keeping the original term', () => {
    expect(canonicalise('Envoyer de l’argent — à Kinshasa!')).toBe('envoyer de l argent a kinshasa');
    upsertSource({ id: 'src_a', name: 'a', family: 'first_party', accessPath: 'first_party' });
    ingestObservations([
      { sourceId: 'src_a', sourceRecordId: 'r', observedAt: hoursAgo(2), windowStart: hoursAgo(26), windowEnd: hoursAgo(2), term: 'Envoyer de l’argent', metric: 'm', value: 1, market: 'CD' },
    ]);
    const row = getDb().prepare('SELECT term, term_canonical FROM ti_observations').get() as { term: string; term_canonical: string };
    expect(row.term).toBe('Envoyer de l’argent');
    expect(row.term_canonical).toBe('envoyer de l argent');
  });
});

describe('snapshots', () => {
  // A returned value from a hook is vitest's teardown, so the app must not escape: these cases exercise the services directly.
  beforeEach(reset);

  it('scores a topic from two independent families and freezes the result', () => {
    const term = 'payer par code qr';
    seedFamily('src_fp', 'first_party', term, { history: [20, 21, 19, 20, 20, 21], current: 70 });
    seedFamily('src_crm', 'crm', term, { history: [22, 20, 21, 20, 19, 20], current: 75 });
    const topic = upsertTopic({ label: 'payer par code qr', market: 'CD', locale: 'fr-CD', terms: [term] });
    const snap = snapshotTopic(topic.id, PROFILE);

    expect(snap.families.sort()).toEqual(['crm', 'first_party']);
    expect(snap.corroboration).toBe(80);
    expect(snap.band).toBe('brief');
    expect(snap.evidenceIds.length).toBe(2);
    // Frozen: the same inputs at the same window end return the same row rather than a second one.
    const again = snapshotTopic(topic.id, PROFILE, snap.windowEnd);
    expect(again.id).toBe(snap.id);
    expect(getDb().prepare('SELECT COUNT(*) c FROM ti_opportunities').pluck().get()).toBe(1);
  });

  it('TI-04 · four records from one family corroborate nothing and cannot reach the brief band', () => {
    const term = 'nouvelle licence paiement';
    // Four separate source ids, all the same family: syndication, not agreement.
    for (const id of ['src_s1', 'src_s2', 'src_s3', 'src_s4']) seedFamily(id, 'public_feed', term, { history: [20, 20, 21, 20, 19, 20], current: 90 });
    const topic = upsertTopic({ label: term, market: 'CD', terms: [term] });
    const snap = snapshotTopic(topic.id, PROFILE);
    expect(snap.families).toEqual(['public_feed']);
    expect(snap.corroboration).toBe(0);
    expect(snap.band).toBe('watch');
  });

  it('keeps a topic out of the brief band when a market has no evidence of its own', () => {
    const term = 'retrait agent';
    seedFamily('src_fp', 'first_party', term, { history: [20, 20, 20, 21, 20, 20], current: 80, market: 'CD' });
    const other = upsertTopic({ label: term, market: 'GB', terms: [term] });
    const snap = snapshotTopic(other.id, PROFILE);
    // Market is part of the key: CD evidence does not score a GB topic.
    expect(snap.families).toEqual([]);
    expect(snap.demand).toBe(0);
    expect(snap.band).not.toBe('brief');
  });

  it('records why a family was excluded instead of silently dropping it', () => {
    const term = 'nouveau sujet';
    seedFamily('src_thin', 'first_party', term, { history: [1, 2], current: 3 });
    const topic = upsertTopic({ label: term, market: 'CD', terms: [term] });
    const snap = snapshotTopic(topic.id, PROFILE);
    expect(snap.notes.join(' ')).toMatch(/comparable periods/);
  });
});

let topicId: string;
let opportunityId: string;

const seedEligible = () => {
  reset();
  const term = 'ouvrir un compte marchand';
  seedFamily('src_fp', 'first_party', term, { history: [20, 21, 20, 19, 20, 21], current: 80 });
  seedFamily('src_crm', 'crm', term, { history: [20, 20, 21, 20, 20, 19], current: 85 });
  const topic = upsertTopic({ label: term, market: 'CD', locale: 'fr-CD', terms: [term] });
  const snap = snapshotTopic(topic.id, PROFILE);
  expect(snap.band).toBe('brief');
  topicId = topic.id;
  opportunityId = snap.id;
};

const propose = (over: Record<string, unknown> = {}) =>
  proposeBrief(
    {
      topicId,
      opportunityId,
      market: 'CD',
      locale: 'fr-CD',
      audience: 'Commerçantes de marché à Kinshasa',
      intent: 'ouvrir un compte marchand',
      objective: 'comptes marchands ouverts par session éligible',
      allowedChannels: ['seo', 'content'],
      ...over,
    },
    'admin_maker',
  );

describe('the brief lifecycle', () => {
  beforeEach(seedEligible);

  it('proposes a draft that steers nothing until it is approved', () => {
    const draft = propose();
    expect(draft.status).toBe('draft');
    expect(effectiveBrief({ market: 'CD', locale: 'fr-CD', channel: 'seo' }), 'a draft must not resolve').toBeNull();
  });

  it('refuses a brief on a snapshot the scorer did not put in the brief band', () => {
    const term = 'sujet faible';
    seedFamily('src_weak', 'public_feed', term, { history: [20, 20, 20, 20, 20, 20], current: 24 });
    const weak = upsertTopic({ label: term, market: 'CD', terms: [term] });
    const snap = snapshotTopic(weak.id, { fit: 30, commercialIntent: 30, timing: 30, readiness: 30 });
    expect(() => proposeBrief({ topicId: weak.id, opportunityId: snap.id, market: 'CD', locale: 'fr-CD', audience: 'a', intent: 'b', objective: 'c' }, 'admin_maker')).toThrow(/band/);
  });

  it('refuses a claim the platform does not hold', () => {
    expect(() => propose({ approvedClaimIds: [uuid()] })).toThrow(/Unknown approved claim/);
  });

  it('binds approval to the exact payload, and refuses self-approval', () => {
    const draft = propose();
    const hash = payloadHash(draft);
    expect(() => approveBrief(draft.id, hash, 'admin_maker')).toThrow(/cannot be approved by the person who proposed it/);
    expect(() => approveBrief(draft.id, 'not-the-hash', 'admin_checker')).toThrow(/changed after it was shown/);
    const approved = approveBrief(draft.id, hash, 'admin_checker');
    expect(approved.status).toBe('approved');
    expect(approved.approved_by).toBe('admin_checker');
  });

  it('resolves exactly one approved brief per scope, superseding the previous one atomically', () => {
    const first = propose();
    approveBrief(first.id, payloadHash(first), 'admin_checker');
    const resolvedFirst = effectiveBrief({ market: 'CD', locale: 'fr-CD', channel: 'seo' })!;
    expect(resolvedFirst.briefId).toBe(first.id);
    expect(resolvedFirst.briefVersion).toBe(1);

    const second = propose({ audience: 'Boutiques de quartier' });
    expect(second.version).toBe(2);
    approveBrief(second.id, payloadHash(second), 'admin_checker');
    expect(getBrief(first.id)!.status).toBe('superseded');
    const resolvedSecond = effectiveBrief({ market: 'CD', locale: 'fr-CD', channel: 'seo' })!;
    expect(resolvedSecond.briefId).toBe(second.id);
    expect(resolvedSecond.audience).toBe('Boutiques de quartier');
    // The database refuses two approved briefs for one scope whatever the caller does.
    expect(getDb().prepare("SELECT COUNT(*) c FROM ti_briefs WHERE status = 'approved' AND topic_id = ?").pluck().get(topicId)).toBe(1);
  });

  it('TI-05 · an expired brief resolves as baseline, without waiting for a sweeper', () => {
    const draft = propose({ ttlHours: BRIEF_TTL_HOURS.breaking });
    approveBrief(draft.id, payloadHash(draft), 'admin_checker');
    expect(effectiveBrief({ market: 'CD', locale: 'fr-CD', channel: 'seo' })).not.toBeNull();

    // Lapse it in place: the row still says approved, which is exactly the state a cache would trust.
    getDb().prepare('UPDATE ti_briefs SET expires_at = ? WHERE id = ?').run(hoursAgo(1), draft.id);
    expect(effectiveBrief({ market: 'CD', locale: 'fr-CD', channel: 'seo' }), 'expiry is evaluated on the read').toBeNull();
    expect(getBrief(draft.id)!.status, 'and the row has not been touched yet').toBe('approved');
    expect(expireLapsedBriefs()).toBe(1);
    expect(getBrief(draft.id)!.status).toBe('expired');
  });

  it('stops steering the agent the moment a brief is revoked', () => {
    const draft = propose();
    approveBrief(draft.id, payloadHash(draft), 'admin_checker');
    revokeBrief(draft.id, 'claim withdrawn by compliance');
    expect(effectiveBrief({ market: 'CD', locale: 'fr-CD', channel: 'seo' })).toBeNull();
  });

  it('only resolves for a channel the brief actually allows', () => {
    const draft = propose({ allowedChannels: ['seo'] });
    approveBrief(draft.id, payloadHash(draft), 'admin_checker');
    expect(effectiveBrief({ market: 'CD', locale: 'fr-CD', channel: 'seo' })).not.toBeNull();
    expect(effectiveBrief({ market: 'CD', locale: 'fr-CD', channel: 'organic_social' })).toBeNull();
  });

  it('does not let a country-targeted lookup match another market', () => {
    const draft = propose();
    approveBrief(draft.id, payloadHash(draft), 'admin_checker');
    expect(effectiveBrief({ market: 'GB', locale: 'en-GB', channel: 'seo' })).toBeNull();
  });

  it('records every resolution, so the console can answer why the agent wrote something', () => {
    const draft = propose();
    const approved = approveBrief(draft.id, payloadHash(draft), 'admin_checker');
    recordBriefUse({ briefId: approved.id, briefVersion: approved.version, channel: 'seo', outcome: 'used', postId: 'post_1' });
    recordBriefUse({ channel: 'seo', outcome: 'baseline', detail: 'no approved brief for this scope' });
    const uses = listBriefUses();
    expect(uses).toHaveLength(2);
    expect(uses.map((u) => u.outcome)).toEqual(expect.arrayContaining(['used', 'baseline']));
  });
});

describe('the module switch', () => {
  beforeEach(seedEligible);

  it('refuses every write while the module is off, and lets the agents keep their baseline', () => {
    const draft = propose();
    approveBrief(draft.id, payloadHash(draft), 'admin_checker');
    expect(effectiveBrief({ market: 'CD', locale: 'fr-CD', channel: 'seo' }), 'approved while on').not.toBeNull();

    setSetting('modules', { ...DEFAULT_MODULES, trendIntelligence: false });

    // Writes refuse: nothing accumulates behind a control that reads "off".
    for (const write of [
      () => upsertSource({ id: 'src_new', name: 'new', family: 'first_party', accessPath: 'first_party' }),
      () => ingestObservations([]),
      () => upsertTopic({ label: 'quoi que ce soit', market: 'CD' }),
      () => snapshotTopic(topicId, PROFILE),
      () => propose(),
      () => revokeBrief(draft.id, 'off'),
    ]) {
      expect(write, 'a write must refuse while the module is off').toThrowError(/switched off/i);
    }

    // Resolution does not throw — it resolves as baseline, so the content schedule keeps running.
    expect(effectiveBrief({ market: 'CD', locale: 'fr-CD', channel: 'seo' })).toBeNull();
    expect(() => recordBriefUse({ channel: 'seo', outcome: 'unavailable', detail: 'module off' })).not.toThrow();
  });

  it('does not lose an approved brief: switching the module back on resolves it again', () => {
    const draft = propose();
    approveBrief(draft.id, payloadHash(draft), 'admin_checker');
    setSetting('modules', { ...DEFAULT_MODULES, trendIntelligence: false });
    expect(effectiveBrief({ market: 'CD', locale: 'fr-CD', channel: 'seo' })).toBeNull();
    setSetting('modules', { ...DEFAULT_MODULES, trendIntelligence: true });
    expect(effectiveBrief({ market: 'CD', locale: 'fr-CD', channel: 'seo' })?.briefId).toBe(draft.id);
  });
});

describe('the claim registry', () => {
  beforeEach(seedEligible);

  const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  it('revises rather than edits, so an approval keeps meaning what its approver read', () => {
    const first = upsertClaim({ code: 'fee_shown', text: 'Fees are shown before every payment.' }, 'admin_checker');
    expect(first.revision).toBe(1);
    // The same text is the same claim: no revision churn from an idempotent save.
    expect(upsertClaim({ code: 'FEE_SHOWN', text: 'Fees are shown before every payment.' }, 'admin_checker').id).toBe(first.id);

    const second = upsertClaim({ code: 'fee_shown', text: 'Every fee is shown before the payment is confirmed.' }, 'admin_checker');
    expect(second.revision).toBe(2);
    expect(second.id).not.toBe(first.id);
    // Revision 1 is still there, with its original text, because a brief may have cited it.
    expect(listClaims().find((c) => c.id === first.id)!.text).toBe('Fees are shown before every payment.');
  });

  it('refuses a brief that cites a claim the platform does not hold, or one whose window has closed', () => {
    expect(() => propose({ approvedClaimIds: ['claim_does_not_exist'] })).toThrowError(/Unknown approved claim/);

    const lapsed = upsertClaim({ code: 'promo_2024', text: 'The launch promotion is running.', validUntil: hoursAgo(1) }, 'admin_checker');
    expect(() => propose({ approvedClaimIds: [lapsed.id] })).toThrowError(/expired/i);

    const future = upsertClaim({ code: 'promo_next', text: 'The next promotion is running.', validFrom: hoursFromNow(48) }, 'admin_checker');
    expect(() => propose({ approvedClaimIds: [future.id] })).toThrowError(/not valid yet/i);

    const live = upsertClaim({ code: 'fee_shown', text: 'Fees are shown before every payment.', validUntil: hoursFromNow(48) }, 'admin_checker');
    expect(propose({ approvedClaimIds: [live.id] }).status).toBe('draft');
  });

  it('refuses a claim with no code, no text, or a window that closes before it opens', () => {
    expect(() => upsertClaim({ code: '  ', text: 'x' }, 'a')).toThrowError(/code/i);
    expect(() => upsertClaim({ code: 'c', text: '   ' }, 'a')).toThrowError(/text/i);
    expect(() => upsertClaim({ code: 'c', text: 'x', validFrom: hoursFromNow(48), validUntil: hoursFromNow(2) }, 'a')).toThrowError(/before it starts/i);
  });
});
