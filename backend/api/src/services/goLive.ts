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
import { getModules, aggregatorPerimeterApplied, AGGREGATOR_PERIMETER_OFF } from './modules';
import { listAgents } from './agents';
import { listSources } from './risk/compliance';

export interface ChecklistItem {
  id: string;
  label: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
  fix?: string;
  /** Console screen where the item is completed (admin route); absent when the fix lives in the host environment. */
  href?: string;
}

export function goLiveChecklist(): { mode: string; readyForLive: boolean; items: ChecklistItem[]; gateToScale: GateToScale } {
  const db = getDb();
  const items: ChecklistItem[] = [];
  const compliance = getComplianceSettings();
  const gateways = listGateways();
  // Money movement (transfers, QR, cross-payments, remittance) runs on the BitriPay digital rail: the double-entry
  // ledger, direct operator collection numbers, the bank-transfer instructions, payout accounts, payout devices and
  // agents. No bank, mobile-money operator or BTCPay API is required for it, so none may ever block go-live.
  const modules = getModules();
  const directMomo = gateways.find((g) => g.provider === 'manual_momo');
  const directBank = gateways.find((g) => g.provider === 'manual_bank');
  const collectionNumbers = listOperators({ onlyDirect: true, onlyEnabled: true });
  const payoutAccounts = listPayoutAccounts({ status: 'active' });
  const payoutDevices = listDevices().filter((d) => d.status === 'active' && d.kind === 'payout');
  const agents = listAgents();
  // Aggregator perimeter (Instructions n°42 and n°58): while no e-money authorisation is recorded, every issuer and
  // acquirer function must be off; the platform goes live as an aggregator through the certified switch connection only.
  const perimeter = aggregatorPerimeterApplied(modules);
  const issuerAuthorised = !!compliance.emoneyAuthorisationRef;
  const acceptanceModules = (['qrPayments', 'paymentLinks', 'moneyRequests', 'merchantGateway'] as const).filter((m) => !modules[m]);
  const moneyMoveModules = (['transfers', 'qrPayments', 'remittance', 'agents', 'withdrawals'] as const).filter((m) => !modules[m]);
  items.push({
    id: 'digital_rail',
    label: perimeter
      ? 'Acceptance on (QR, payment links, requests, merchant gateway and API); issuer rails wait for the e-money authorisation'
      : 'Money moves on the BitriPay digital rail (ledger, direct operator numbers, bank instructions, payout devices, agents) without any bank, mobile-money or BTCPay API',
    ok: perimeter ? acceptanceModules.length === 0 : !!directMomo?.enabled && !!directBank?.enabled && moneyMoveModules.length === 0,
    blocking: true,
    detail: [
      `direct mobile money ${directMomo?.enabled ? 'on' : 'off'} (${collectionNumbers.length} collection number${collectionNumbers.length === 1 ? '' : 's'})`,
      `bank transfer ${directBank?.enabled ? 'on' : 'off'}${directBank?.configuredKeys.includes('accountNumber') ? '' : ' (account details not yet entered)'}`,
      `${payoutAccounts.length} payout account(s)`,
      `${payoutDevices.length} payout device(s)`,
      `${agents.length} active agent(s)`,
      moneyMoveModules.length ? `modules off: ${moneyMoveModules.join(', ')}` : 'transfers, QR, remittance, agents and withdrawals on',
    ].join(' · '),
    fix: perimeter
      ? 'Modules → QR payments, payment links, money requests and merchant gateway on'
      : 'Deposit / payment gateways → enable "Mobile money (direct, all operators)" and "Bank transfer" (enter the account details); Modules → transfers, QR payments, remittance, agents, withdrawals on. Collection numbers, payout accounts and payout devices are enrolled in the console and the payout-device app, never through an operator API',
  });
  const stillOn = AGGREGATOR_PERIMETER_OFF.filter((k) => modules[k] !== false);
  items.push({
    id: 'aggregator_perimeter',
    label: 'Aggregator perimeter applied: issuer and acquirer functions off until an e-money authorisation is recorded (Instruction n°42, art. 37, 40, 42)',
    ok: perimeter || issuerAuthorised,
    blocking: true,
    detail: issuerAuthorised
      ? `E-money authorisation / licensed issuer recorded: ${compliance.emoneyAuthorisationRef}`
      : perimeter
        ? 'Perimeter in force: every issuer and acquirer function is off and refused by the API'
        : `Still on: ${stillOn.join(', ')}`,
    fix: 'Modules → Apply the aggregator perimeter (Instructions n°42 and n°58), or record the e-money authorisation reference under Controls → Compliance once it exists',
  });
  items.push({
    id: 'bcc_authorisation',
    label: 'Banque Centrale du Congo authorisation as prestataire de services connexes – agrégateur recorded (Instruction n°42, art. 9)',
    ok: !!compliance.aggregatorAuthorisationRef && !!compliance.aggregatorAuthorisationDate,
    blocking: true,
    detail: compliance.aggregatorAuthorisationRef
      ? `${compliance.aggregatorAuthorisationRef} (${compliance.aggregatorAuthorisationDate || 'date missing'})`
      : 'No authorisation recorded: the request is under instruction',
    fix: 'Controls → Compliance → enter the authorisation reference and date once the Banque Centrale has granted it',
  });
  items.push({
    id: 'switch_membership',
    label: 'Switch Monétique National participation recorded: indirect SAREC participation convention with a bank, GMIC membership, guarantee fund (Instruction n°58, art. 10, 12, 13)',
    ok: !!compliance.sarecConventionBank && !!compliance.sarecConventionRef && !!compliance.gmicMembershipRef,
    blocking: true,
    detail: [
      compliance.sarecConventionRef ? `SAREC convention ${compliance.sarecConventionRef} with ${compliance.sarecConventionBank || 'bank not named'}` : 'No SAREC convention',
      compliance.gmicMembershipRef ? `GMIC ${compliance.gmicMembershipRef}` : 'No GMIC membership',
      compliance.guaranteeFundRef ? `guarantee fund ${compliance.guaranteeFundRef}` : 'guarantee fund contribution not recorded',
    ].join(' · '),
    fix: 'Controls → Compliance → record the bank and reference of the SAREC convention, the GMIC membership and the guarantee fund contribution',
  });
  // A licensed card processor is the one external API in the model and it serves card acceptance only: the three items
  // below block when a processor is enabled and are satisfied ("cards not offered") when none is, because the digital
  // rail never depends on one.
  const processors = gateways.filter((g) => ['stripe', 'paystack', 'flutterwave'].includes(g.provider) && g.enabled);
  const tested = processors.filter((g) => g.lastHealth?.ok);
  const cardsNotOffered = 'No card processor enabled: payment cards are not offered (not needed for the digital rail); add one only to accept cards';
  items.push({
    id: 'processor',
    label: 'Licensed card processor connected and tested (only if cards are offered)',
    ok: processors.length === 0 || tested.length > 0,
    blocking: true,
    detail: processors.length
      ? processors.map((g) => `${g.name}: ${g.mode} keys, ${g.lastHealth ? (g.lastHealth.ok ? `test passed ${g.lastHealth.at}` : `test failed: ${g.lastHealth.message}`) : 'not tested'}`).join(' · ')
      : cardsNotOffered,
    fix: 'Deposit / payment gateways → add Stripe, Paystack or Flutterwave keys → Test connection',
  });
  items.push({
    id: 'processor_live_keys',
    label: 'Card processor uses live keys (only if cards are offered)',
    ok: processors.length === 0 || processors.some((g) => g.mode === 'live'),
    blocking: true,
    detail: processors.map((g) => `${g.name}: ${g.mode}`).join(' · ') || cardsNotOffered,
    fix: 'Replace test keys with live keys once the processor has approved the account',
  });
  items.push({
    id: 'processor_webhooks',
    label: 'Card processor webhook secret configured (only if cards are offered)',
    ok: processors.length === 0 || processors.every((g) => g.configuredKeys.includes('webhookSecret') || g.configuredKeys.includes('webhookHash') || g.provider === 'paystack'),
    blocking: true,
    detail: processors.length ? `Webhook URLs: ${processors.map((g) => `${config.apiUrl}/api/webhooks/${g.id}`).join(', ')}` : cardsNotOffered,
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
    label: 'Exchange rates fresh: a keyless provider refreshed automatically, or the official reference rate entered by the treasury',
    ok: fresh.live && fresh.fresh && (fresh.manual || getAppSettings().rateAutoRefreshHours > 0),
    blocking: true,
    detail: `${fresh.live ? `live (${fresh.source})` : `not live (${fresh.source})`}${fresh.oldestUpdatedAt ? `, oldest ${fresh.oldestUpdatedAt}` : ''}${rs.lastError ? ` · last error: ${rs.lastError}` : ''}`,
    fix: 'Currencies & rates → choose a keyless provider and set auto-refresh hours, or enter the official reference rate (source manual) at least every maxRateAgeHours',
  });
  const corridors = listCorridors();
  const live = corridors.filter((c) => c.status === 'live');
  items.push({
    id: 'corridor_live',
    label: 'At least one corridor authorised (live) with complete regulatory arrangements',
    ok: perimeter || (live.length > 0 && live.every((c) => c.readiness.ready)),
    blocking: !perimeter,
    detail:
      (perimeter ? 'Not required in the aggregator perimeter (issuer phase) · ' : '') +
      (live.length
        ? live.map((c) => `${c.sourceCurrency}→${c.destCountry} ${c.destCurrency}${c.readiness.ready ? '' : ` (missing: ${c.readiness.missing.join(', ')})`}`).join(' · ')
        : 'No live corridor'),
    fix: 'Corridors → Go live (regulator, licence, safeguarding, AML, partners, expiry)',
  });
  const accounts = payoutAccounts;
  items.push({
    id: 'liquidity',
    label: 'Every live corridor has a prefunded payout account',
    ok: perimeter || (live.length > 0 && live.every((c) => accounts.some((a) => a.currency === c.destCurrency && (!c.operatorId || a.operatorId === c.operatorId) && a.balance > 0))),
    blocking: !perimeter,
    detail:
      (perimeter ? 'Not required in the aggregator perimeter (issuer phase) · ' : '') + (accounts.map((a) => `${a.label}: ${a.balance} ${a.currency}`).join(' · ') || 'No active payout accounts'),
    fix: 'Corridors → Liquidity → create and prefund payout accounts',
  });
  const devices = payoutDevices;
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
    ok: perimeter || (enabledCurrencies.length > 0 && covered.length === enabledCurrencies.length),
    blocking: !perimeter,
    detail:
      (perimeter ? 'Not required in the aggregator perimeter (issuer phase) · ' : '') +
      (programmes.length
        ? programmes.map((p) => `${p.currency}/${p.jurisdiction}: ${p.issuerModel}${p.readiness.ready ? '' : ` (missing: ${p.readiness.missing.join(', ')})`}`).join(' · ')
        : 'No issuer programme registered'),
    fix: 'Gateway controls → E-money → register the authorised issuer, licence, regulator and safeguarding account per currency',
  });
  const positions = programmes.map((p) => p.position);
  items.push({
    id: 'emoney_reserves',
    label: 'Outstanding e-money fully backed by cleared safeguarded reserves (1:1)',
    ok: perimeter || (programmes.length > 0 && positions.every((p) => p.coverage >= 0 && p.liabilities <= p.clearedReserves + p.pendingInflows)),
    blocking: !perimeter,
    detail:
      (perimeter ? 'Not required in the aggregator perimeter (issuer phase) · ' : '') +
      (programmes.map((p) => `${p.currency}: reserves ${p.position.clearedReserves}, outstanding ${p.position.liabilities}, headroom ${p.position.headroom}`).join(' · ') || 'n/a'),
    fix: 'Gateway controls → E-money → confirm reserve funding (maker-checker) until every currency is fully covered',
  });
  const sanctionSources = listSources().filter((x) => x.enabled);
  const loadedSources = sanctionSources.filter((x) => (x.lastCount ?? 0) > 0);
  const sanctionEntries = listSanctions({ limit: 5000 }).length;
  items.push({
    id: 'sanctions',
    label: 'Sanctions / screening lists loaded (official consolidated lists refresh daily)',
    ok: sanctionEntries > 0,
    blocking: true,
    detail: sanctionSources.length
      ? `${sanctionEntries >= 5000 ? '5000+' : sanctionEntries} entries · ${sanctionSources
          .map((x) => `${x.name.replace(/ \(.*\)$/, '')}: ${x.lastCount ?? 0}${x.lastError ? ` ✗ ${x.lastError}` : x.lastRefreshedAt ? '' : ' (not loaded yet)'}`)
          .join(' · ')}`
      : `${sanctionEntries} entries, no list source registered`,
    fix:
      loadedSources.length === 0 && sanctionSources.length
        ? 'Lists load automatically at start-up and daily (outbound HTTPS to treasury.gov, ofsistorage.blob.core.windows.net, scsanctions.un.org, webgate.ec.europa.eu); Risk & compliance → Sanctions → Refresh to retry now, or import your provider file'
        : 'Risk & compliance → Sanctions → Refresh the official sources or import your screening provider list',
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
    fix: 'Each administrator: Profile → Two-factor authentication → Set up 2FA (production enforces it after the grace period)',
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
  items.push({
    id: 'smtp',
    label: 'Email delivery configured',
    ok: !!getSmtpSettings().host,
    blocking: false,
    detail: getSmtpSettings().host ? getSmtpSettings().host : 'Not configured',
    fix: 'SMTP_HOST / SMTP_USER / SMTP_PASS / SMTP_FROM in the API environment, or Messaging → Email in the console',
  });
  // External rails are optional add-ons (card processors; operator and Bitcoin adapters kept for deployments that
  // contract them). One that is enabled must have passed its connectivity check; none is required.
  const liveRails = gateways.filter((g) => g.enabled && !['sandbox', 'manual_bank', 'manual_momo', 'open_banking'].includes(g.provider));
  const untested = liveRails.filter((g) => !g.lastHealth?.ok);
  items.push({
    id: 'rails',
    label: 'Every enabled external rail passed its connectivity check (none is required for money movement)',
    ok: untested.length === 0,
    blocking: false,
    detail: liveRails.length
      ? liveRails.map((g) => `${g.name}: ${g.mode}${g.lastHealth ? (g.lastHealth.ok ? ' ✓' : ` ✗ ${g.lastHealth.message}`) : ' (not tested)'}`).join(' · ')
      : 'No external rail enabled: transfers, QR, cross-payments and remittance run on the digital rail',
    fix: 'Deposit / payment gateways → Test connection on each enabled rail, or disable the rail; a card processor only matters if you accept cards',
  });
  items.push({
    id: 'direct_rails',
    label: 'Direct mobile-money collection numbers enrolled (customers pay the operator number shown; receipts confirmed by the payout device, the SMS forwarder or maker-checker)',
    ok: collectionNumbers.length > 0,
    blocking: false,
    detail: collectionNumbers.length ? collectionNumbers.map((o) => `${o.name} ${o.collectionNumber}`).join(' · ') : 'None yet: Mobile money → operator → collection number',
    fix: 'Mobile money → operator → collection number and account name (your own SIM at that operator; no operator API), then register the payout device that holds the SIM',
  });
  const connections = listConnections();
  const certified = connections.filter((c) => c.enabled && c.certification.status === 'CERTIFIED');
  items.push({
    id: 'switch',
    label: perimeter
      ? 'National switch connection certified (homologation): the aggregator goes live through the Switch Monétique National only'
      : 'National switch: certified adapter configured or connection kept in simulation',
    ok: perimeter ? certified.length > 0 : config.switch.adapterModule ? certified.length > 0 : true,
    blocking: perimeter,
    detail: config.switch.adapterModule
      ? `${certified.length} certified connection(s) with adapter ${config.switch.adapterModule}`
      : `SWITCH_ADAPTER_MODULE not set: national routing stays in simulation until the official profile is delivered${perimeter ? '; certification with the Switch is required before going live as an aggregator' : ''}`,
    fix: 'After the official profile (BCC-04/06/13): SWITCH_ADAPTER_MODULE=/path/to/adapter.js, certificates in the vault, certification set to CERTIFIED by the approver',
  });
  items.push({
    id: 'public_urls',
    label: 'Public URLs are HTTPS on the production domain',
    ok: !config.isProduction || [config.webUrl, config.adminUrl, config.apiUrl].every((u) => u.startsWith('https://')),
    blocking: config.isProduction,
    detail: `web ${config.webUrl} · admin ${config.adminUrl} · api ${config.apiUrl}`,
    fix: 'WEB_URL=https://www.bitripay.com ADMIN_URL=https://admin.bitripay.com API_URL=https://api.bitripay.com (deploy/.env.production.example)',
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
  const HREFS: Record<string, string> = {
    digital_rail: '/gateways',
    aggregator_perimeter: '/modules',
    bcc_authorisation: '/controls',
    switch_membership: '/controls',
    processor: '/gateways',
    processor_live_keys: '/gateways',
    processor_webhooks: '/gateways',
    three_d_secure: '/gateways',
    sandbox_off: '/gateways',
    rates: '/currencies',
    corridor_live: '/corridors',
    liquidity: '/corridors',
    devices: '/mobile-money',
    emoney_issuer: '/emoney',
    emoney_reserves: '/emoney',
    sanctions: '/risk',
    maker_checker: '/users?role=admin',
    admin_2fa: '/profile',
    kyc: '/fees',
    shared_secret: '/controls',
    smtp: '/messaging',
    rails: '/gateways',
    direct_rails: '/mobile-money',
    switch: '/switch',
  };
  for (const item of items) if (HREFS[item.id]) item.href = HREFS[item.id];

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
