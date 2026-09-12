import { shortCode } from '../lib/ids';
import { getDb } from '../db';
import { parseJson } from '../lib/json';
import type { GatewayProvider, InitiateContext, InitiateResult, VerifyResult, GatewayPaymentRow, RefundResult } from './types';

/**
 * Pay by bank (open banking): an account-to-account payment from a linked bank account, executed by the open
 * banking provider behind the link. Immediate settlement when the provider confirms; a linked account is required.
 * Live providers are keyed here; the sandbox bank needs no credentials.
 */
export const openBankingProvider: GatewayProvider = {
  id: 'open_banking',
  name: 'Pay by bank (open banking)',
  supportedMethods: ['bank'],
  credentialFields: [
    { key: 'clientId', label: 'Provider client id' },
    { key: 'clientSecret', label: 'Provider client secret', secret: true },
  ],
  async initiate(ctx: InitiateContext): Promise<InitiateResult> {
    const { executeBankPayment, defaultBankAccount } = await import('../services/openBanking');
    const meta = parseJson<any>(ctx.payment.metadata, {});
    const ob = meta.openBanking ?? meta.intentInput?.openBanking ?? null;
    if (!ctx.payer.userId) return { providerRef: `ob_${shortCode(10)}`, status: 'failed', next: { type: 'none' }, failureReason: 'Sign in and link a bank account to pay by bank' };
    const target = ob?.linkId && ob?.accountId ? { linkId: ob.linkId, accountId: ob.accountId } : (() => { const d = defaultBankAccount(ctx.payer.userId!, ctx.currency); return d ? { linkId: d.linkId, accountId: d.account.id } : null; })();
    if (!target) return { providerRef: `ob_${shortCode(10)}`, status: 'failed', next: { type: 'none' }, failureReason: `No linked bank account in ${ctx.currency}` };
    const r = executeBankPayment({ userId: ctx.payer.userId, linkId: target.linkId, accountId: target.accountId, amountMinor: ctx.amountMinor, currency: ctx.currency, reference: ctx.payment.id, mandateId: ob?.mandateId ?? null, gatewayPaymentId: ctx.payment.id, reason: ob?.reason ?? ctx.description });
    if (r.status === 'failed') return { providerRef: r.providerRef || `ob_${shortCode(10)}`, status: 'failed', next: { type: 'none' }, failureReason: r.failureReason };
    return { providerRef: r.providerRef, status: r.status, next: r.status === 'succeeded' ? { type: 'none' } : { type: 'redirect', url: ctx.returnUrl, message: 'Confirm the payment in your banking app.' } };
  },
  async verify(payment: GatewayPaymentRow): Promise<VerifyResult> {
    if (payment.status === 'succeeded') return { status: 'succeeded' };
    if (payment.status === 'failed') return { status: 'failed' };
    const row = getDb().prepare('SELECT status, reason FROM open_banking_payments WHERE gateway_payment_id = ?').get(payment.id) as any;
    if (!row) return { status: 'pending' };
    return row.status === 'succeeded' ? { status: 'succeeded' } : row.status === 'failed' ? { status: 'failed', failureReason: row.reason } : { status: 'pending' };
  },
  async refund(payment: GatewayPaymentRow, amountMinor: number): Promise<RefundResult> {
    return { status: 'manual', message: `Refund ${amountMinor} to the payer's bank account for ${payment.provider_ref} by bank transfer` };
  },
  keyMode(credentials) { return credentials.clientSecret ? 'live' : 'test'; },
};
