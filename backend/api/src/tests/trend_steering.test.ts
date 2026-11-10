/**
 * The claim this module stands on: an approved brief changes what the existing content agent writes next.
 *
 * Everything else in trend intelligence could be correct and the module would still be decoration if
 * `runContentSchedule()` kept taking the next entry off a hand-written list. So these tests assert the handover —
 * and, just as importantly, the fallback. A growth control that cannot be revoked without stopping the platform
 * from publishing is not a control, so the backlog must still run when no brief resolves, when the brief has
 * lapsed, and when an administrator switches the module off.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setupApp } from './helpers';
import { getSeoSettings, setSetting } from '../services/settings';
import { DEFAULT_MODULES } from '../services/modules';
import { resolveSteer, briefInstructions, claimBoundary, agentStatus } from '../services/seoAgent';
import { upsertSource, ingestObservations, upsertTopic, snapshotTopic } from '../services/trend/detect';
import { proposeBrief, approveBrief, revokeBrief, payloadHash, effectiveBrief, upsertClaim, type GrowthBrief } from '../services/trend/briefs';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const INTENT = 'ouvrir un compte marchand';

function seedFamily(sourceId: string, family: string, term: string, history: number[], current: number, market = 'CD') {
  upsertSource({ id: sourceId, name: sourceId, family, accessPath: 'first_party', quality: 90, staleAfterHours: 48 });
  ingestObservations(
    [...history, current].map((value, i) => ({
      sourceId,
      sourceRecordId: `${sourceId}-${i}`,
      observedAt: hoursAgo((history.length - i) * 24 + 1),
      windowStart: hoursAgo((history.length - i) * 24 + 25),
      windowEnd: hoursAgo((history.length - i) * 24 + 1),
      term,
      metric: 'searches',
      value,
      market,
    })),
  );
}

/** An approved brief for CD, through the real lifecycle rather than an insert. */
function approvedBrief(over: Record<string, unknown> = {}): GrowthBrief {
  seedFamily('src_fp', 'first_party', INTENT, [20, 21, 20, 19, 20, 21], 80);
  seedFamily('src_crm', 'crm', INTENT, [20, 20, 21, 20, 20, 19], 85);
  const topic = upsertTopic({ label: INTENT, market: 'CD', locale: 'fr-CD', terms: [INTENT] });
  const snap = snapshotTopic(topic.id, { fit: 95, commercialIntent: 85, timing: 90, readiness: 80 });
  expect(snap.band).toBe('brief');
  const draft = proposeBrief(
    {
      topicId: topic.id,
      opportunityId: snap.id,
      market: 'CD',
      locale: 'fr-CD',
      audience: 'Commerçantes de marché à Kinshasa',
      intent: INTENT,
      objective: 'comptes marchands ouverts par session éligible',
      allowedChannels: ['seo', 'content'],
      ...over,
    },
    'admin_maker',
  );
  approveBrief(draft.id, payloadHash(draft), 'admin_checker');
  return effectiveBrief({ market: 'CD', channel: 'seo' })!;
}

beforeEach(() => {
  setupApp();
  setSetting('modules', { ...DEFAULT_MODULES, trendIntelligence: true });
});

describe('what the content agent writes next', () => {
  it('runs the hand-written backlog while no brief has been approved', () => {
    const steer = resolveSteer()!;
    expect(steer.outcome).toBe('baseline');
    expect(steer.brief).toBeNull();
    expect(steer.topic).toBe(getSeoSettings().agent.topics[0]);
    expect(steer.detail).toContain('no approved brief');
  });

  it('prefers an approved brief over the backlog, and does not consume a queued topic', () => {
    const brief = approvedBrief();
    const steer = resolveSteer()!;
    expect(steer.outcome).toBe('used');
    expect(steer.brief?.briefId).toBe(brief.briefId);
    expect(steer.topic).toBe(INTENT);
    // The backlog is untouched: the first queued topic is still first.
    expect(getSeoSettings().agent.topics[0]).toBe('How mobile money agents keep cash flowing in markets');
  });

  it('falls back to the backlog the moment the brief is revoked', () => {
    const brief = approvedBrief();
    expect(resolveSteer()!.outcome).toBe('used');
    revokeBrief(brief.briefId, 'claim withdrawn');
    const steer = resolveSteer()!;
    expect(steer.outcome).toBe('baseline');
    expect(steer.topic).toBe(getSeoSettings().agent.topics[0]);
  });

  it('falls back to the backlog when an administrator switches the module off', () => {
    approvedBrief();
    expect(resolveSteer()!.outcome).toBe('used');
    setSetting('modules', { ...DEFAULT_MODULES, trendIntelligence: false });
    const steer = resolveSteer()!;
    expect(steer.outcome).toBe('baseline');
    expect(steer.detail).toContain('switched off');
  });

  it('has nothing to write when the backlog is empty and no brief resolves', () => {
    const s = getSeoSettings();
    setSetting('seo', { ...s, agent: { ...s.agent, topics: [] } });
    expect(resolveSteer()).toBeNull();
    expect(agentStatus().steering.source).toBe('idle');
  });

  it('reports in the console which of the two is steering', () => {
    expect(agentStatus().steering.source).toBe('backlog');
    const brief = approvedBrief();
    const status = agentStatus();
    expect(status.steering.source).toBe('brief');
    expect(status.steering.briefId).toBe(brief.briefId);
  });

  it('does not publish in a language the platform has not enabled, and says so', () => {
    approvedBrief();
    // The brief is fr-CD; the platform publishes in English only.
    const steer = resolveSteer()!;
    expect(steer.language).toBe('en');
    expect(steer.detail).toContain('not an enabled content language');

    const s = getSeoSettings();
    setSetting('seo', { ...s, agent: { ...s.agent, languages: ['en', 'fr'] } });
    expect(resolveSteer()!.language).toBe('fr');
  });

  it('does not let a brief for another market steer a market the platform does not serve', () => {
    approvedBrief();
    const s = getSeoSettings();
    setSetting('seo', { ...s, agent: { ...s.agent, markets: ['KE', 'NG'] } });
    expect(resolveSteer()!.outcome).toBe('baseline');
  });
});

describe('what the writer is allowed to say', () => {
  it('carries the approved claims and the prohibitions to every agent that writes public copy', () => {
    const claim = upsertClaim({ code: 'fee_shown', text: 'Fees are shown before every payment.', evidence: 'The fee line is rendered on every confirmation screen.' }, 'admin_checker');
    const brief = approvedBrief({ approvedClaimIds: [claim.id], prohibitedClaims: ['any ranking promise', 'any guaranteed arrival time'] });
    // The boundary lives in the shared site rules, so the article writer, the keyword planner and the auditor
    // all inherit it — not just whichever call site remembered to pass it.
    for (const channel of ['content', 'seo'] as const) {
      const bound = claimBoundary(channel);
      expect(bound, channel).toContain(claim.text);
      expect(bound, channel).toContain('(FEE_SHOWN)');
      expect(bound, channel).toContain('any ranking promise');
      expect(bound, channel).toContain(brief.briefId);
      expect(bound, channel).toContain(brief.expiresAt);
    }
    // A channel the brief does not allow gets nothing at all.
    expect(claimBoundary('organic_social')).toBe('');

    // The assignment is separate from the boundary, and says so rather than repeating it into the prompt twice.
    const note = briefInstructions(brief);
    expect(note).toContain(brief.briefId);
    expect(note).toContain(brief.audience);
    expect(note).toContain('set out in the site rules above');
    expect(note, 'the claim text must not be duplicated into the same prompt twice').not.toContain(claim.text);
  });

  it('tells the writer to assert nothing when no claim has been approved', () => {
    approvedBrief();
    const bound = claimBoundary('content');
    expect(bound).toMatch(/No claim has been approved/);
    expect(bound).toMatch(/without asserting any outcome/);
  });

  it('bounds nothing while trend intelligence is off, so the agents behave exactly as before', () => {
    approvedBrief();
    expect(claimBoundary('content')).not.toBe('');
    setSetting('modules', { ...DEFAULT_MODULES, trendIntelligence: false });
    expect(claimBoundary('content')).toBe('');
    expect(claimBoundary('seo')).toBe('');
  });
});
