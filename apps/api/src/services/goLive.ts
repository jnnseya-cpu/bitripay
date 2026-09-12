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

export interface ChecklistItem {
  id: string;
  label: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
  fix?: string;
}

export function goLiveChecklist(): { mode: string; readyForLive: boolean; items: ChecklistItem[] } {
  const db = getDb();
  const items: ChecklistItem[] = [];
  const compliance = getComplianceSettings();
  const gateways = listGateways();
  const processors = gateways.filter((g) => ['stripe', 'paystack', 'flutterwave'].includes(g.provider) && g.enabled);
  const tested = processors.filter((g) => g.lastHealth?.ok);
  items.push({ id: 'processor', label: 'Licensed card processor connected and tested', ok: tested.length > 0, blocking: true, detail: processors.length ? processors.map((g) => `${g.name}: ${g.mode} keys, ${g.lastHealth ? (g.lastHealth.ok ? `test passed ${g.lastHealth.at}` : `test failed: ${g.lastHealth.message}`) : 'not tested'}`).join(' · ') : 'No processor enabled', fix: 'Deposit / payment gateways → add Stripe, Paystack or Flutterwave keys → Test connection' });
  items.push({ id: 'processor_live_keys', label: 'Processor uses live keys', ok: processors.some((g) => g.mode === 'live'), blocking: true, detail: processors.map((g) => `${g.name}: ${g.mode}`).join(' · ') || 'none', fix: 'Replace test keys with live keys once the processor has approved the account' });
  items.push({ id: 'processor_webhooks', label: 'Processor webhook secret configured', ok: processors.length > 0 && processors.every((g) => g.configuredKeys.includes('webhookSecret') || g.configuredKeys.includes('webhookHash') || g.provider === 'paystack'), blocking: true, detail: `Webhook URLs: ${processors.map((g) => `${config.apiUrl}/api/webhooks/${g.id}`).join(', ') || 'n/a'}`, fix: 'Register the webhook URL at the processor and paste the signing secret' });
  items.push({ id: 'three_d_secure', label: '3-D Secure enabled on card payments', ok: processors.filter((g) => g.provider === 'stripe').every((g) => ['automatic', 'any'].includes(String(g.config.threeDSecure ?? 'automatic'))), blocking: false, detail: 'Stripe: automatic (SCA) or always challenge; Paystack and Flutterwave hosted checkout apply 3-D Secure themselves' });
  const sandbox = gateways.find((g) => g.provider === 'sandbox');
  items.push({ id: 'sandbox_off', label: 'Sandbox processor disabled', ok: !sandbox?.enabled || (config.isProduction && !sandbox.config.allowInProduction), blocking: true, detail: sandbox?.enabled ? 'Sandbox gateway is enabled' : 'Disabled', fix: 'Deposit / payment gateways → disable Sandbox' });
  const fresh = rateFreshness();
  const rs = getRateStatus();
  items.push({ id: 'rates', label: 'Live exchange rates from a provider, refreshed automatically', ok: fresh.live && fresh.fresh && getAppSettings().rateAutoRefreshHours > 0, blocking: true, detail: `${fresh.live ? `live (${fresh.source})` : `not live (${fresh.source})`}${fresh.oldestUpdatedAt ? `, oldest ${fresh.oldestUpdatedAt}` : ''}${rs.lastError ? ` · last error: ${rs.lastError}` : ''}`, fix: 'Currencies & rates → choose a provider (add an API key if needed) → Refresh now → set auto-refresh hours' });
  const corridors = listCorridors();
  const live = corridors.filter((c) => c.status === 'live');
  items.push({ id: 'corridor_live', label: 'At least one corridor authorised (live) with complete regulatory arrangements', ok: live.length > 0 && live.every((c) => c.readiness.ready), blocking: true, detail: live.length ? live.map((c) => `${c.sourceCurrency}→${c.destCountry} ${c.destCurrency}${c.readiness.ready ? '' : ` (missing: ${c.readiness.missing.join(', ')})`}`).join(' · ') : 'No live corridor', fix: 'Corridors → Go live (regulator, licence, safeguarding, AML, partners, expiry)' });
  const accounts = listPayoutAccounts({ status: 'active' });
  items.push({ id: 'liquidity', label: 'Every live corridor has a prefunded payout account', ok: live.length > 0 && live.every((c) => accounts.some((a) => a.currency === c.destCurrency && (!c.operatorId || a.operatorId === c.operatorId) && a.balance > 0)), blocking: true, detail: accounts.map((a) => `${a.label}: ${a.balance} ${a.currency}`).join(' · ') || 'No active payout accounts', fix: 'Corridors → Liquidity → create and prefund payout accounts' });
  const devices = listDevices().filter((d) => d.status === 'active' && d.kind === 'payout');
  items.push({ id: 'devices', label: 'Registered payout devices or approved agents for each payout account', ok: accounts.length > 0 && accounts.every((a) => a.agent || devices.some((d) => d.payoutAccountId === a.id)), blocking: false, detail: `${devices.length} active payout device(s)`, fix: 'Mobile money & evidence → Evidence devices → register the Android payout device (kind: payout, SIM identity)' });
  // E-money may only be issued through an authorised issuer with a safeguarding account, and never beyond cleared reserves.
  const programmes = listProgrammes().filter((p) => p.issuerModel !== 'sandbox');
  const enabledCurrencies = listCurrencies(true).map((c) => c.code);
  const covered = enabledCurrencies.filter((c) => programmes.some((p) => p.currency === c && p.readiness.ready));
  items.push({ id: 'emoney_issuer', label: 'E-money issuer programme (own authorisation or licensed partner) with safeguarding account for every enabled currency', ok: enabledCurrencies.length > 0 && covered.length === enabledCurrencies.length, blocking: true, detail: programmes.length ? programmes.map((p) => `${p.currency}/${p.jurisdiction}: ${p.issuerModel}${p.readiness.ready ? '' : ` (missing: ${p.readiness.missing.join(', ')})`}`).join(' · ') : 'No issuer programme registered', fix: 'Gateway controls → E-money → register the authorised issuer, licence, regulator and safeguarding account per currency' });
  const positions = programmes.map((p) => p.position);
  items.push({ id: 'emoney_reserves', label: 'Outstanding e-money fully backed by cleared safeguarded reserves (1:1)', ok: programmes.length > 0 && positions.every((p) => p.coverage >= 0 && p.liabilities <= p.clearedReserves + p.pendingInflows), blocking: true, detail: programmes.map((p) => `${p.currency}: reserves ${p.position.clearedReserves}, outstanding ${p.position.liabilities}, headroom ${p.position.headroom}`).join(' · ') || 'n/a', fix: 'Gateway controls → E-money → confirm reserve funding (maker-checker) until every currency is fully covered' });
  items.push({ id: 'sanctions', label: 'Sanctions / screening list loaded', ok: listSanctions().length > 0, blocking: true, detail: `${listSanctions().length} entries`, fix: 'Gateway controls → Sanctions → import your screening provider list' });
  const admins = db.prepare("SELECT id, permissions, pin_hash, two_factor_enabled FROM users WHERE role = 'admin' AND is_system = 0 AND status = 'active'").all() as any[];
  const approvers = admins.filter((a) => hasPermission(a, 'approvals') && a.pin_hash);
  const issuers = admins.filter((a) => hasPermission(a, 'issuance') && a.pin_hash);
  items.push({ id: 'maker_checker', label: 'At least two administrators can approve (maker-checker) with a step-up PIN', ok: approvers.length >= 2 && issuers.length >= 2 && getGatewayControls().makerChecker && getGatewayControls().adminStepUp, blocking: true, detail: `${approvers.length} approver(s) with PIN, ${issuers.length} issuer(s) with PIN, maker-checker ${getGatewayControls().makerChecker ? 'on' : 'OFF'}, step-up ${getGatewayControls().adminStepUp ? 'on' : 'OFF'}`, fix: 'Admin care → create a second administrator; each sets a PIN in My profile' });
  items.push({ id: 'admin_2fa', label: 'All administrators use two-factor authentication', ok: admins.length > 0 && admins.every((a) => a.two_factor_enabled), blocking: false, detail: `${admins.filter((a) => a.two_factor_enabled).length}/${admins.length} admins with 2FA` });
  items.push({ id: 'kyc', label: 'KYC required before withdrawals / payouts', ok: getAppSettings().requireKycForWithdrawals, blocking: true, detail: getAppSettings().requireKycForWithdrawals ? 'Required' : 'Not required', fix: 'Fees, limits & referral → require KYC for withdrawals' });
  items.push({ id: 'shared_secret', label: 'Legacy shared-secret SMS webhook not authoritative', ok: !getGatewayControls().sharedSecretAutoConfirm, blocking: true, detail: getGatewayControls().sharedSecretAutoConfirm ? 'Shared-secret evidence auto-confirms' : 'Only device-signed evidence settles automatically', fix: 'Gateway controls → disable sharedSecretAutoConfirm' });
  items.push({ id: 'smtp', label: 'Email delivery configured', ok: !!getSmtpSettings().host, blocking: false, detail: getSmtpSettings().host ? getSmtpSettings().host : 'Not configured' });
  items.push({ id: 'secrets', label: 'Production secrets set (APP_SECRET / JWT_SECRET)', ok: !config.appSecret.startsWith('dev-') && !config.jwtSecret.startsWith('dev-'), blocking: true, detail: config.appSecret.startsWith('dev-') ? 'Default development secrets in use' : 'Custom secrets', fix: 'Set APP_SECRET and JWT_SECRET in the API environment' });
  const readyForLive = items.filter((i) => i.blocking).every((i) => i.ok);
  return { mode: compliance.mode, readyForLive, items };
}
