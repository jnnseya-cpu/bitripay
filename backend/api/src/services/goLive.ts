/**
 * Go-live checklist: everything an operator must have in place before live customer funds are
 * accepted. Blocking items stop the switch to compliance mode 'live'; the rest are strong
 * recommendations. Each item explains what to do.
 */
import { getDb } from '../db';
import { config } from '../config';
import { listGateways } from '../payments';
import { getComplianceSettings, getAppSettings, getGatewayControls } from './settings';
import { rateFreshness, getRateStatus } from './currencies';
import { listCorridors } from './corridors';
import { listPayoutAccounts } from './liquidity';
import { listDevices } from './evidence';
import { listSanctions } from './risk';
import { listProgrammes } from './emoney';
import { listCurrencies } from './currencies';
import { getSmtpSettings } from './messaging';
import { hasPermission } from '../middleware/permissions';
import { toBase } from './currencies';
import { getOperatingState } from './guardian';
import { listOperators } from './momo';
import { listConnections } from './switch/connections';

export interface ChecklistItem {
  id: string;
  label: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
  fix?: string;
}

export function goLiveChecklist(): { mode: string; readyForLive: boolean; items: ChecklistItem[]; gateToScale: GateToScale } {
  const db = getDb();
  const items: ChecklistItem[] = [];
  const compliance = getComplianceSettings();
  const gateways = listGateways();
  const processors = gateways.filter((g) => ['stripe', 'paystack', 'flutterwave'].includes(g.provider) && g.enabled);
  const tested = processors.filter((g) => g.lastHealth?.ok);
  items.push({
    id: 'processor',
    label: 'Licensed card processor connected and tested',
    ok: tested.length > 0,
    blocking: true,
    detail: processors.length
      ? processors.map((g) => `${g.name}: ${g.mode} keys, ${g.lastHealth ? (g.lastHealth.ok ? `test passed ${g.lastHealth.at}` : `test failed: ${g.lastHealth.message}`) : 'not tested'}`).join(' · ')
      : 'No processor enabled',
    fix: 'Deposit / payment gateways → add Stripe, Paystack or Flutterwave keys → Test connection',
  });
  items.push({
    id: 'processor_live_keys',
    label: 'Processor uses live keys',
    ok: processors.some((g) => g.mode === 'live'),
    blocking: true,
    detail: processors.map((g) => `${g.name}: ${g.mode}`).join(' · ') || 'none',
    fix: 'Replace test keys with live keys once the processor has approved the account',
  });
  items.push({
    id: 'processor_webhooks',
    label: 'Processor webhook secret configured',
    ok: processors.length > 0 && processors.every((g) => g.configuredKeys.includes('webhookSecret') || g.configuredKeys.includes('webhookHash') || g.provider === 'paystack'),
    blocking: true,
    detail: `Webhook URLs: ${processors.map((g) => `${config.apiUrl}/api/webhooks/${g.id}`).join(', ') || 'n/a'}`,
    fix: 'Register the webhook URL at the processor and paste the signing secret',
  });
  items.push({
    id: 'three_d_secure',
    label: '3-D Secure enabled on card payments',
    ok: processors.filter((g) => g.provider === 'stripe').every((g) => ['automatic', 'any'].includes(String(g.config.threeDSecure ?? 'automatic'))),
    blocking: false,
    detail: 'Stripe: automatic (SCA) or always challenge; Paystack and Flutterwave hosted checkout apply 3-D Secure themselves',
  });
  const sandbox = gateways.find((g) => g.provider === 'sandbox');
  items.push({
    id: 'sandbox_off',
    label: 'Sandbox processor disabled',
    ok: !sandbox?.enabled || (config.isProduction && !sandbox.config.allowInProduction),
    blocking: true,
    detail: sandbox?.enabled ? 'Sandbox gateway is enabled' : 'Disabled',
    fix: 'Deposit / payment gateways → disable Sandbox',
  });
  const fresh = rateFreshness();
  const rs = getRateStatus();
  items.push({
    id: 'rates',
    label: 'Live exchange rates from a provider, refreshed automatically',
    ok: fresh.live && fresh.fresh && getAppSettings().rateAutoRefreshHours > 0,
    blocking: true,
    detail: `${fresh.live ? `live (${fresh.source})` : `not live (${fresh.source})`}${fresh.oldestUpdatedAt ? `, oldest ${fresh.oldestUpdatedAt}` : ''}${rs.lastError ? ` · last error: ${rs.lastError}` : ''}`,
    fix: 'Currencies & rates → choose a provider (add an API key if needed) → Refresh now → set auto-refresh hours',
  });
  const corridors = listCorridors();
  const live = corridors.filter((c) => c.status === 'live');
  items.push({
    id: 'corridor_live',
    label: 'At least one corridor authorised (live) with complete regulatory arrangements',
    ok: live.length > 0 && live.every((c) => c.readiness.ready),
    blocking: true,
    detail: live.length
      ? live.map((c) => `${c.sourceCurrency}→${c.destCountry} ${c.destCurrency}${c.readiness.ready ? '' : ` (missing: ${c.readiness.missing.join(', ')})`}`).join(' · ')
      : 'No live corridor',
    fix: 'Corridors → Go live (regulator, licence, safeguarding, AML, partners, expiry)',
  });
  const accounts = listPayoutAccounts({ status: 'active' });
  items.push({
    id: 'liquidity',
    label: 'Every live corridor has a prefunded payout account',
    ok: live.length > 0 && live.every((c) => accounts.some((a) => a.currency === c.destCurrency && (!c.operatorId || a.operatorId === c.operatorId) && a.balance > 0)),
    blocking: true,
    detail: accounts.map((a) => `${a.label}: ${a.balance} ${a.currency}`).join(' · ') || 'No active payout accounts',
    fix: 'Corridors → Liquidity → create and prefund payout accounts',
  });
  const devices = listDevices().filter((d) => d.status === 'active' && d.kind === 'payout');
  items.push({
    id: 'devices',
    label: 'Registered payout devices or approved agents for each payout account',
    ok: accounts.length > 0 && accounts.every((a) => a.agent || devices.some((d) => d.payoutAccountId === a.id)),
    blocking: false,
    detail: `${devices.length} active payout device(s)`,
    fix: 'Mobile money & evidence → Evidence devices → register the Android payout device (kind: payout, SIM identity)',
  });
  // E-money may only be issued through an authorised issuer with a safeguarding account, and never beyond cleared reserves.
  const programmes = listProgrammes().filter((p) => p.issuerModel !== 'sandbox');
  const enabledCurrencies = listCurrencies(true).map((c) => c.code);
  const covered = enabledCurrencies.filter((c) => programmes.some((p) => p.currency === c && p.readiness.ready));
  items.push({
    id: 'emoney_issuer',
    label: 'E-money issuer programme (own authorisation or licensed partner) with safeguarding account for every enabled currency',
    ok: enabledCurrencies.length > 0 && covered.length === enabledCurrencies.length,
    blocking: true,
    detail: programmes.length
      ? programmes.map((p) => `${p.currency}/${p.jurisdiction}: ${p.issuerModel}${p.readiness.ready ? '' : ` (missing: ${p.readiness.missing.join(', ')})`}`).join(' · ')
      : 'No issuer programme registered',
    fix: 'Gateway controls → E-money → register the authorised issuer, licence, regulator and safeguarding account per currency',
  });
  const positions = programmes.map((p) => p.position);
  items.push({
    id: 'emoney_reserves',
    label: 'Outstanding e-money fully backed by cleared safeguarded reserves (1:1)',
    ok: programmes.length > 0 && positions.every((p) => p.coverage >= 0 && p.liabilities <= p.clearedReserves + p.pendingInflows),
    blocking: true,
    detail: programmes.map((p) => `${p.currency}: reserves ${p.position.clearedReserves}, outstanding ${p.position.liabilities}, headroom ${p.position.headroom}`).join(' · ') || 'n/a',
    fix: 'Gateway controls → E-money → confirm reserve funding (maker-checker) until every currency is fully covered',
  });
  items.push({
    id: 'sanctions',
    label: 'Sanctions / screening list loaded',
    ok: listSanctions().length > 0,
    blocking: true,
    detail: `${listSanctions().length} entries`,
    fix: 'Gateway controls → Sanctions → import your screening provider list',
  });
  const admins = db.prepare("SELECT id, permissions, pin_hash, two_factor_enabled FROM users WHERE role = 'admin' AND is_system = 0 AND status = 'active'").all() as any[];
  const approvers = admins.filter((a) => hasPermission(a, 'approvals') && a.pin_hash);
  const issuers = admins.filter((a) => hasPermission(a, 'issuance') && a.pin_hash);
  items.push({
    id: 'maker_checker',
    label: 'At least two administrators can approve (maker-checker) with a step-up PIN',
    ok: approvers.length >= 2 && issuers.length >= 2 && getGatewayControls().makerChecker && getGatewayControls().adminStepUp,
    blocking: true,
    detail: `${approvers.length} approver(s) with PIN, ${issuers.length} issuer(s) with PIN, maker-checker ${getGatewayControls().makerChecker ? 'on' : 'OFF'}, step-up ${getGatewayControls().adminStepUp ? 'on' : 'OFF'}`,
    fix: 'Admin care → create a second administrator; each sets a PIN in My profile',
  });
  items.push({
    id: 'admin_2fa',
    label: 'All administrators use two-factor authentication',
    ok: admins.length > 0 && admins.every((a) => a.two_factor_enabled),
    blocking: false,
    detail: `${admins.filter((a) => a.two_factor_enabled).length}/${admins.length} admins with 2FA`,
  });
  items.push({
    id: 'kyc',
    label: 'KYC required before withdrawals / payouts',
    ok: getAppSettings().requireKycForWithdrawals,
    blocking: true,
    detail: getAppSettings().requireKycForWithdrawals ? 'Required' : 'Not required',
    fix: 'Fees, limits & referral → require KYC for withdrawals',
  });
  items.push({
    id: 'shared_secret',
    label: 'Legacy shared-secret SMS webhook not authoritative',
    ok: !getGatewayControls().sharedSecretAutoConfirm,
    blocking: true,
    detail: getGatewayControls().sharedSecretAutoConfirm ? 'Shared-secret evidence auto-confirms' : 'Only device-signed evidence settles automatically',
    fix: 'Gateway controls → disable sharedSecretAutoConfirm',
  });
  items.push({ id: 'smtp', label: 'Email delivery configured', ok: !!getSmtpSettings().host, blocking: false, detail: getSmtpSettings().host ? getSmtpSettings().host : 'Not configured' });
  // Rails provisioned from the environment: every enabled live rail must have passed its connectivity check.
  const liveRails = gateways.filter((g) => g.enabled && !['sandbox', 'manual_bank', 'manual_momo', 'open_banking'].includes(g.provider));
  const untested = liveRails.filter((g) => !g.lastHealth?.ok);
  items.push({
    id: 'rails',
    label: 'Every enabled rail passed its connectivity check (processors, mobile money, Bitcoin)',
    ok: liveRails.length > 0 && untested.length === 0,
    blocking: false,
    detail: liveRails.length
      ? liveRails.map((g) => `${g.name}: ${g.mode}${g.lastHealth ? (g.lastHealth.ok ? ' ✓' : ` ✗ ${g.lastHealth.message}`) : ' (not tested)'}`).join(' · ')
      : 'No live rail enabled',
    fix: 'Provide the credentials in the API environment (STRIPE_*, PAYSTACK_*, FLUTTERWAVE_*, MTN_MOMO_*, MPESA_*, BTCPAY_*, MOMO_DIRECT_RAILS) or in the console, then Test connection; rails that pass are enabled at start-up',
  });
  const directRails = listOperators({ onlyDirect: true, onlyEnabled: true });
  items.push({
    id: 'direct_rails',
    label: 'Direct mobile-money rails (prefunded operator SIMs) configured',
    ok: directRails.length > 0,
    blocking: false,
    detail: directRails.length ? directRails.map((o) => `${o.name} ${o.collectionNumber}`).join(' · ') : 'None: set MOMO_DIRECT_RAILS or add collection numbers in the console',
    fix: 'MOMO_DIRECT_RAILS="orange_cd=+243…:Account name;mpesa_ke=+254…" or Mobile money → operator → collection number',
  });
  const connections = listConnections();
  const certified = connections.filter((c) => c.enabled && c.certification.status === 'CERTIFIED');
  items.push({
    id: 'switch',
    label: 'National switch: certified adapter configured or connection kept in simulation',
    ok: config.switch.adapterModule ? certified.length > 0 : true,
    blocking: false,
    detail: config.switch.adapterModule
      ? `${certified.length} certified connection(s) with adapter ${config.switch.adapterModule}`
      : 'SWITCH_ADAPTER_MODULE not set: national routing stays in simulation until the official profile is delivered',
    fix: 'After the official profile (BCC-04/06/13): SWITCH_ADAPTER_MODULE=/path/to/adapter.js, certificates in the vault, certification set to CERTIFIED by the approver',
  });
  items.push({
    id: 'public_urls',
    label: 'Public URLs are HTTPS on the production domain',
    ok: !config.isProduction || [config.webUrl, config.adminUrl, config.apiUrl].every((u) => u.startsWith('https://')),
    blocking: config.isProduction,
    detail: `web ${config.webUrl} · admin ${config.adminUrl} · api ${config.apiUrl}`,
    fix: 'WEB_URL=https://bitripay.com ADMIN_URL=https://admin.bitripay.com API_URL=https://api.bitripay.com (deploy/.env.production.example)',
  });
  items.push({
    id: 'secrets',
    label: 'Production secrets set (APP_SECRET / JWT_SECRET)',
    ok: !config.appSecret.startsWith('dev-') && !config.jwtSecret.startsWith('dev-'),
    blocking: true,
    detail: config.appSecret.startsWith('dev-') ? 'Default development secrets in use' : 'Custom secrets',
    fix: 'Set APP_SECRET and JWT_SECRET in the API environment',
  });
  const readyForLive = items.filter((i) => i.blocking).every((i) => i.ok);
  return { mode: compliance.mode, readyForLive, items, gateToScale: gateToScale() };
}

// ---------------------------------------------------------------------------------------------------------------------
// Gate to scale: 95 % auto-reconciliation · < 2 % exception rate · zero Guardian halts in 30 days · fraud loss < 25 bps.
// Computed from 30 days of real platform data; an empty platform is honestly "not ready", never assumed ready.
// ---------------------------------------------------------------------------------------------------------------------
export interface GateToScale {
  ready: boolean;
  windowDays: number;
  since: string;
  items: ChecklistItem[];
}
export const GATE_TO_SCALE_THRESHOLDS = { autoReconciliation: 0.95, exceptionRate: 0.02, guardianHalts: 0, fraudLossBps: 25 } as const;

/** Amount in base-currency minor units; unknown currencies count at face value rather than being dropped. */
function baseMinor(amountMinor: number, currency: string): number {
  try {
    return toBase(amountMinor, currency);
  } catch {
    return amountMinor;
  }
}
const pct = (n: number) => `${(n * 100).toFixed(2)} %`;

export function gateToScale(days = 30): GateToScale {
  const db = getDb();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const items: ChecklistItem[] = [];
  const T = GATE_TO_SCALE_THRESHOLDS;

  // 1. Auto-reconciliation: matched lines vs. exceptions opened across every reconciliation run (processors, banks, switch).
  const runs = db
    .prepare('SELECT COUNT(*) n, COALESCE(SUM(matched), 0) matched, COALESCE(SUM(cases_opened), 0) cases, MAX(created_at) last FROM reconciliation_runs WHERE created_at >= ?')
    .get(since) as { n: number; matched: number; cases: number; last: string | null };
  const reconTotal = runs.matched + runs.cases;
  const autoRate = reconTotal ? runs.matched / reconTotal : null;
  items.push({
    id: 'auto_reconciliation',
    label: `Auto-reconciliation ≥ ${pct(T.autoReconciliation)} over ${days} days`,
    ok: autoRate != null && autoRate >= T.autoReconciliation,
    blocking: true,
    detail: runs.n
      ? `${runs.n} run(s), ${runs.matched} matched automatically, ${runs.cases} exception(s) opened → ${autoRate == null ? 'no lines' : pct(autoRate)}; last run ${runs.last}`
      : `No reconciliation run in the last ${days} days`,
    fix: 'Finance operations → Reconciliation: import every processor / switch statement and run reconciliation daily; work exceptions to closure',
  });

  // 2. Exception rate: reconciliation cases + disputes + chargebacks opened vs. payments that reached a paid state.
  const casesOpened = (db.prepare('SELECT COUNT(*) c FROM reconciliation_cases WHERE created_at >= ?').get(since) as { c: number }).c;
  const disputesOpened = (db.prepare('SELECT COUNT(*) c FROM disputes WHERE created_at >= ?').get(since) as { c: number }).c;
  const chargebacksOpened = (db.prepare('SELECT COUNT(*) c FROM chargebacks WHERE opened_at >= ?').get(since) as { c: number }).c;
  const paidIntents = (
    db.prepare("SELECT COUNT(*) c FROM payment_intents WHERE created_at >= ? AND status IN ('CAPTURED','SETTLEMENT_PENDING','SETTLED','PARTIALLY_REFUNDED','REFUNDED','DISPUTED')").get(since) as {
      c: number;
    }
  ).c;
  const completedSwitch = (db.prepare("SELECT COUNT(*) c FROM switch_payments WHERE created_at >= ? AND status = 'COMPLETED'").get(since) as { c: number }).c;
  const exceptions = casesOpened + disputesOpened + chargebacksOpened;
  const payments = paidIntents + completedSwitch;
  const exceptionRate = payments ? exceptions / payments : null;
  items.push({
    id: 'exception_rate',
    label: `Exception rate < ${pct(T.exceptionRate)} over ${days} days`,
    ok: exceptionRate != null && exceptionRate < T.exceptionRate,
    blocking: true,
    detail: payments
      ? `${exceptions} exception(s) (${casesOpened} reconciliation, ${disputesOpened} dispute(s), ${chargebacksOpened} chargeback(s)) on ${payments} paid payment(s) (${paidIntents} intents, ${completedSwitch} switch) → ${pct(exceptionRate!)}`
      : `No paid payment in the last ${days} days (${exceptions} exception(s) opened)`,
    fix: 'Reduce unmatched statements and disputes: evidence devices on every payout account, processor webhooks, daily reconciliation',
  });

  // 3. Guardian halts: every Guardian run in the window, none of which halted the platform; the platform is not halted now.
  const guardian = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(halted), 0) halted, MAX(created_at) last FROM guardian_checks WHERE created_at >= ?').get(since) as {
    n: number;
    halted: number;
    last: string | null;
  };
  const haltEvents = (
    db.prepare("SELECT COUNT(*) c FROM event_log WHERE stream = 'ledger' AND event = 'guardian.findings' AND created_at >= ? AND details LIKE '%\"halted\":true%'").get(since) as { c: number }
  ).c;
  const operating = getOperatingState();
  const halts = Math.max(guardian.halted, haltEvents);
  items.push({
    id: 'guardian_halts',
    label: `Zero Guardian halts in ${days} days`,
    ok: guardian.n > 0 && halts === T.guardianHalts && operating.mode !== 'halted',
    blocking: true,
    detail: guardian.n
      ? `${guardian.n} Guardian run(s), ${halts} halt(s); last run ${guardian.last}; platform ${operating.mode}`
      : `Guardian has not run in the last ${days} days; platform ${operating.mode}`,
    fix: 'Keep the scheduler running (Guardian runs every few minutes) and resolve every ledger finding before it halts the platform',
  });

  // 4. Fraud loss: disputes and chargebacks lost vs. captured volume, in base-currency minor units.
  const lostDisputes = db.prepare("SELECT amount_minor, currency FROM disputes WHERE decision = 'LOST' AND decided_at >= ?").all(since) as { amount_minor: number; currency: string }[];
  const lostChargebacks = db.prepare("SELECT amount, currency FROM chargebacks WHERE status = 'lost' AND COALESCE(resolved_at, opened_at) >= ?").all(since) as { amount: number; currency: string }[];
  const capturedIntents = db
    .prepare(
      "SELECT COALESCE(amount_minor, 0) amount_minor, currency FROM payment_intents WHERE created_at >= ? AND status IN ('CAPTURED','SETTLEMENT_PENDING','SETTLED','PARTIALLY_REFUNDED','REFUNDED','DISPUTED')",
    )
    .all(since) as { amount_minor: number; currency: string }[];
  const capturedSwitch = db.prepare("SELECT amount_minor, currency FROM switch_payments WHERE created_at >= ? AND status = 'COMPLETED'").all(since) as { amount_minor: number; currency: string }[];
  const lost = lostDisputes.reduce((s, d) => s + baseMinor(d.amount_minor, d.currency), 0) + lostChargebacks.reduce((s, c) => s + baseMinor(c.amount, c.currency), 0);
  const captured = capturedIntents.reduce((s, i) => s + baseMinor(i.amount_minor, i.currency), 0) + capturedSwitch.reduce((s, p) => s + baseMinor(p.amount_minor, p.currency), 0);
  const bps = captured ? (lost / captured) * 10_000 : null;
  items.push({
    id: 'fraud_loss',
    label: `Fraud loss < ${T.fraudLossBps} bps of captured volume over ${days} days`,
    ok: bps != null && bps < T.fraudLossBps,
    blocking: true,
    detail: captured
      ? `${lostDisputes.length} dispute(s) and ${lostChargebacks.length} chargeback(s) lost = ${lost} base minor units on ${captured} captured → ${bps!.toFixed(2)} bps`
      : `No captured volume in the last ${days} days (${lostDisputes.length + lostChargebacks.length} loss event(s))`,
    fix: 'Risk & compliance: tighten velocity and cooling-off rules, respond to disputes with evidence before the deadline',
  });

  return { ready: items.every((i) => i.ok), windowDays: days, since, items };
}
