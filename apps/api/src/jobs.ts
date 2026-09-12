import { getDb } from './db';
import { now } from './lib/ids';
import { getAppSettings } from './services/settings';
import { refreshRatesFromProvider } from './services/currencies';
import { runAutoSettlements } from './services/merchant';
import { expireStalePayments } from './services/payments';
import { expirePayouts } from './services/payouts';
import { enforceLicenceExpiry } from './services/corridors';
import { rateFreshness, getRateStatus } from './services/currencies';
import { notify } from './services/notifications';
import { getFxSettings } from './services/settings';
import { config } from './config';
import { reconcileReserves, expirePromoCredits } from './services/emoney';
import { publishScheduled } from './services/blog';
import { runContentSchedule } from './services/seoAgent';
import { pingIndexNow, verifyBacklinks } from './services/seo';
import { runScheduledAgents, expireApprovals } from './services/assist/runtime';
import { renewSubscriptions } from './services/assist/addon';
import { expireIntents } from './services/intents';
import { runGuardian } from './services/guardian';
import { processDueDeliveries } from './services/webhooks';
import { syncCheckoutSessions } from './services/gateway';
import { dispatchOutbox, recoverUncertainEmissions, expirePayments as expireSwitchPayments } from './services/switch/payments';
import { certificateAlerts } from './services/switch/connections';
import { checkCoverage } from './services/switch/reconciliation';
import { runSettlementSchedules } from './services/finops/settlement';
import { sweepDisputeDeadlines } from './services/finops/disputes';
import { expireHolds } from './services/finops/holds';
import { runAmlScan, refreshAllSources } from './services/risk/compliance';
import { runFloatAlerts, runTrustScores } from './services/risk/agentIntel';
import { probeConnectors } from './services/rails';
import { registryStatus } from './services/switch/participants';
import { listConnections } from './services/switch/connections';
let lastCertificateCheck = 0;
let lastSettlementRun = 0;
let lastCoverageDay = '';
let lastRegistryAlert = 0;
const dispatcherOwner = `node:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
let lastGuardian = 0;
let lastAgentDay = '';
let lastRiskDay = '';
let lastBacklinkCheck = 0;
import { getEmoneySettings } from './services/settings';
let lastReconciliationDay = '';

let lastRateRefresh = 0;
let lastSettlement = 0;

/** Lightweight in-process scheduler: expire stale payment/cash requests, refresh rates, run settlements. */
export function startJobs() {
  if (config.isTest) return;
  const tick = async () => {
    try {
      const db = getDb();
      db.prepare("UPDATE payment_requests SET status = 'expired' WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at < ?").run(now());
      db.prepare("UPDATE cash_requests SET status = 'expired' WHERE status = 'pending' AND expires_at < ?").run(now());
      const expired = expireStalePayments();
      if (expired) console.log(`[jobs] expired ${expired} unconfirmed payment intents`);
      const p = expirePayouts();
      if (p.released || p.expired) console.log(`[jobs] payouts: released ${p.released} stale claims, expired ${p.expired}`);
      const lic = enforceLicenceExpiry();
      if (lic.suspended.length) {
        console.warn(`[jobs] suspended corridors with expired licences: ${lic.suspended.join(', ')}`);
        for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_system = 0 AND status = 'active'").all() as { id: string }[]) notify(a.id, 'Corridor suspended', `${lic.suspended.length} corridor(s) were suspended because the licence expired.`, { kind: 'corridor' });
      }
      // Blog: publish scheduled articles and let the content agent work through its backlog; re-verify backlinks weekly.
      const published = publishScheduled();
      if (published.length) {
        console.log(`[jobs] published ${published.length} scheduled article(s)`);
        void pingIndexNow(published);
      }
      // Command centres: expire stale approvals; run the system agents once a day at 05:00 UTC for administrators.
      expireApprovals();
      const expiredIntents = expireIntents();
      if (expiredIntents) console.log(`[jobs] expired ${expiredIntents} payment intent(s)`);
      const cs = syncCheckoutSessions();
      if (cs.completed || cs.expired) console.log(`[jobs] checkout sessions: completed ${cs.completed}, expired ${cs.expired}`);
      // National switch: recover uncertain emissions (never resend), expire never-sent payments, dispatch the outbox under the lease.
      const recovered = recoverUncertainEmissions();
      if (recovered) console.warn(`[switch] ${recovered} uncertain emission(s) recovered into inquiry`);
      const expiredSwitch = expireSwitchPayments();
      if (expiredSwitch) console.log(`[switch] expired ${expiredSwitch} never-transmitted payment(s)`);
      const dispatched = await dispatchOutbox(dispatcherOwner, { limit: 100 });
      if (dispatched.processed) console.log(`[switch] dispatched ${dispatched.processed} outbox message(s) as ${dispatched.lease?.owner} (fencing token ${dispatched.lease?.fencingToken})`);
      const probes = await probeConnectors();
      if (probes.failed.length) console.warn(`[rails] probe failures: ${probes.failed.join(', ')}`);
      if (Date.now() - lastCertificateCheck > 24 * 3600_000) {
        lastCertificateCheck = Date.now();
        const certs = certificateAlerts();
        if (certs.expired.length) console.error(`[switch] certificates expired on ${certs.expired.join(', ')} — emission stopped`);
      }
      if (Date.now() - lastRegistryAlert > 6 * 3600_000) {
        lastRegistryAlert = Date.now();
        for (const c of listConnections()) {
          const reg = registryStatus(c.country);
          if (reg.stale || reg.contradictions.length) console.warn(`[switch] participant registry for ${c.country}: ${reg.stale ? 'stale' : ''} ${reg.contradictions.join('; ')}`);
        }
      }
      const coverageDay = new Date().toISOString().slice(0, 10);
      if (coverageDay !== lastCoverageDay && new Date().getUTCHours() >= 7) {
        lastCoverageDay = coverageDay;
        const cov = checkCoverage();
        if (cov.missing.length) console.warn(`[reconciliation] missing reports: ${cov.missing.join(', ')}`);
      }
      // Financial operations: settlement cut-offs and due payouts (hourly), dispute deadlines and expiring holds.
      if (Date.now() - lastSettlementRun > 3600_000) {
        lastSettlementRun = Date.now();
        const st = runSettlementSchedules();
        if (st.closed || st.paid) console.log(`[finops] settlement cycles: closed ${st.closed}, paid ${st.paid}, skipped ${st.skipped}`);
      }
      const swept = sweepDisputeDeadlines();
      if (swept) console.warn(`[finops] ${swept} dispute(s) passed their response deadline`);
      const releasedHolds = expireHolds();
      if (releasedHolds) console.log(`[finops] released ${releasedHolds} expired hold(s)`);
      // Webhook retries survive restarts: deliveries whose retry time has passed are attempted here.
      const delivered = await processDueDeliveries();
      if (delivered) console.log(`[jobs] retried ${delivered} webhook deliver${delivered === 1 ? 'y' : 'ies'}`);
      if (Date.now() - lastGuardian > 3600_000) {
        lastGuardian = Date.now();
        const g = runGuardian();
        if (!g.ok) console.error(`[guardian] ${g.findings.length} finding(s)${g.halted ? ' — platform HALTED' : ''}`);
      }
      const renewed = renewSubscriptions();
      if (renewed.renewed || renewed.expired) console.log(`[jobs] add-on subscriptions: renewed ${renewed.renewed}, expired ${renewed.expired}`);
      const dayKey = new Date().toISOString().slice(0, 10);
      // Risk and compliance: AML monitor, sanctions list refresh, agent float alerts and trust scores, once a day.
      if (lastRiskDay !== dayKey && new Date().getUTCHours() >= 3) {
        lastRiskDay = dayKey;
        const aml = runAmlScan();
        if (aml.opened) console.warn(`[compliance] AML monitor opened ${aml.opened} case(s) from ${aml.scanned} active account(s)`);
        const lists = await refreshAllSources();
        if (lists.failed.length) console.warn(`[compliance] sanctions refresh failed: ${lists.failed.join('; ')}`);
        const floats = runFloatAlerts();
        if (floats.alerted) console.log(`[agents] float alerts sent: ${floats.alerted}`);
        const trust = runTrustScores();
        if (trust.scored) console.log(`[agents] trust scores computed for ${trust.scored} agent(s)`);
      }
      if (new Date().getUTCHours() === 5 && lastAgentDay !== dayKey) {
        lastAgentDay = dayKey;
        const r = await runScheduledAgents();
        if (r.ran.length) console.log(`[jobs] scheduled agents ran: ${r.ran.join(', ')}`);
      }
      if (new Date().getUTCHours() === 6 && new Date().getUTCMinutes() < 2) {
        const c = await runContentSchedule();
        if (c.drafted) console.log('[jobs] content agent drafted a new article');
      }
      if (Date.now() - lastBacklinkCheck > 7 * 86_400_000) {
        lastBacklinkCheck = Date.now();
        void verifyBacklinks().then((r) => console.log(`[jobs] backlinks: checked ${r.checked}, lost ${r.lost}`));
      }
      // Daily safeguarding reconciliation (1:1 reserve-to-liability); breaches suspend issuance automatically.
      const day = new Date().toISOString().slice(0, 10);
      if (day !== lastReconciliationDay && new Date().getUTCHours() >= getEmoneySettings().reconciliationHourUtc) {
        lastReconciliationDay = day;
        const recon = reconcileReserves(null);
        const breaches = recon.filter((r) => r.status === 'breach');
        console.log(`[jobs] safeguarding reconciliation: ${recon.length} programme(s), ${breaches.length} breach(es)`);
        const expiredPromo = expirePromoCredits();
        if (expiredPromo) console.log(`[jobs] expired ${expiredPromo} promotional credits`);
      }
      db.prepare("DELETE FROM idempotency_keys WHERE created_at < ?").run(new Date(Date.now() - 24 * 3600_000).toISOString());
      db.prepare("DELETE FROM evidence_nonces WHERE created_at < ?").run(new Date(Date.now() - 7 * 86_400_000).toISOString());
      const app = getAppSettings();
      if (app.rateAutoRefreshHours > 0 && app.rateProvider !== 'manual' && Date.now() - lastRateRefresh > app.rateAutoRefreshHours * 3600_000) {
        lastRateRefresh = Date.now();
        try {
          const r = await refreshRatesFromProvider();
          console.log(`[jobs] refreshed ${r.updated.length} exchange rates from ${r.provider} (snapshot ${r.snapshotId})`);
        } catch (err) {
          const st = getRateStatus();
          console.error(`[jobs] rate refresh failed (${st.consecutiveFailures}x): ${(err as Error).message}`);
          const fresh = rateFreshness();
          // Alert administrators once rates are stale beyond the guaranteed-quote window (guaranteed quotes are already disabled by then).
          if (!fresh.fresh && st.consecutiveFailures % 6 === 1) for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_system = 0 AND status = 'active'").all() as { id: string }[]) notify(a.id, 'Exchange rates are stale', `Rate refresh from ${st.provider} keeps failing: ${st.lastError}. Guaranteed quotes are disabled until rates are fresher than ${getFxSettings().maxRateAgeHours}h.`, { kind: 'rates' });
        }
      }
      if (app.autoSettlement.enabled && Date.now() - lastSettlement > app.autoSettlement.intervalHours * 3600_000) {
        lastSettlement = Date.now();
        const r = runAutoSettlements();
        if (r.settled) console.log(`[jobs] auto-settled ${r.settled} merchant balances`);
      }
    } catch (err) {
      console.error('[jobs] tick failed', (err as Error).message);
    }
  };
  setInterval(tick, 60_000).unref();
  void tick();
}
