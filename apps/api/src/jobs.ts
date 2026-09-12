import { getDb } from './db';
import { now } from './lib/ids';
import { getAppSettings } from './services/settings';
import { refreshRatesFromProvider } from './services/currencies';
import { runAutoSettlements } from './services/merchant';
import { expireStalePayments } from './services/payments';
import { expirePayouts } from './services/payouts';
import { config } from './config';

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
      db.prepare("DELETE FROM idempotency_keys WHERE created_at < ?").run(new Date(Date.now() - 24 * 3600_000).toISOString());
      db.prepare("DELETE FROM evidence_nonces WHERE created_at < ?").run(new Date(Date.now() - 7 * 86_400_000).toISOString());
      const app = getAppSettings();
      if (app.rateAutoRefreshHours > 0 && app.rateProvider !== 'manual' && Date.now() - lastRateRefresh > app.rateAutoRefreshHours * 3600_000) {
        lastRateRefresh = Date.now();
        const r = await refreshRatesFromProvider();
        console.log(`[jobs] refreshed ${r.updated.length} exchange rates from ${r.provider}`);
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
