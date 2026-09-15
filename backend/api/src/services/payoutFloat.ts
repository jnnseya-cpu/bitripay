/**
 * Payout float for a demonstration: one prefunded mobile-money payout account per operator SIM, created (or reused)
 * and topped up in a single step, so transfers to that operator leave "waiting for liquidity" and reach the payout
 * queue. Sandbox compliance mode only: a live prefund is a real treasury movement and goes through the console under
 * step-up. Idempotent per operator + SIM number: running it again only adds the requested float.
 */
import { badRequest, notFound } from '../lib/errors';
import { config } from '../config';
import { findUserByEmail } from './users';
import { getComplianceSettings } from './settings';
import { getCurrency } from './currencies';
import { getOperator } from './momo';
import { createPayoutAccount, listPayoutAccounts, prefundAccount, type PayoutAccount } from './liquidity';
import { requeueWaiting } from './payouts';

export interface PayoutFloatInput {
  operatorId: string;
  msisdn: string;
  currency?: string | null;
  country?: string | null;
  label?: string | null;
  amountMinor: number;
  reference?: string | null;
}

export interface PayoutFloatResult {
  account: PayoutAccount;
  created: boolean;
  prefunded: number;
  requeued: number;
}

export function assertSandboxForPayoutFloat(): void {
  const mode = getComplianceSettings().mode;
  if (mode !== 'sandbox') throw badRequest(`Demonstration float is created in sandbox compliance mode only (current mode: ${mode}); prefund live accounts from the console`, 'sandbox_required');
}

function normaliseMsisdn(v: string): string {
  const digits = v.replace(/[^\d+]/g, '');
  if (digits.replace(/\D/g, '').length < 8) throw badRequest('Enter the full SIM number of the payout account, with the country code', 'invalid_phone');
  return digits.startsWith('+') ? digits : `+${digits}`;
}

export function ensurePayoutFloat(input: PayoutFloatInput, adminEmail = config.admin.email): PayoutFloatResult {
  assertSandboxForPayoutFloat();
  const admin = findUserByEmail(adminEmail);
  if (!admin || admin.role !== 'admin') throw notFound(`Administrator ${adminEmail} not found`, 'admin_not_found');
  const op = getOperator(input.operatorId);
  const currency = getCurrency((input.currency ?? op.currency).toUpperCase(), false).code;
  const msisdn = normaliseMsisdn(input.msisdn);
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw badRequest('The float amount must be greater than zero', 'invalid_amount');
  const existing = listPayoutAccounts({ rail: 'mobile_money', operatorId: op.id, currency }).find((a) => a.msisdn === msisdn);
  const account =
    existing ??
    createPayoutAccount(
      { rail: 'mobile_money', operatorId: op.id, country: (input.country ?? op.country).toUpperCase(), currency, label: input.label ?? `${op.name} · SIM ${msisdn.slice(-4)}`, msisdn },
      { type: 'admin', id: admin.id },
    );
  const funded = prefundAccount(account.id, input.amountMinor, { reference: input.reference ?? 'demo float', note: 'Demonstration float (sandbox)' }, admin);
  const requeued = requeueWaiting(funded, { type: 'admin', id: admin.id });
  return { account: funded, created: !existing, prefunded: input.amountMinor, requeued };
}
