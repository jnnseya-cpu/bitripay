import { detectCardBrand, luhnCheck, isExpiryValid } from '@bitripay/shared';
import { shortCode } from '../lib/ids';
import type { GatewayProvider, InitiateContext, InitiateResult, VerifyResult, GatewayPaymentRow, RefundResult } from './types';

/**
 * Sandbox gateway – simulates cards, mobile money and bank transfers without any external service.
 * Test cards: any Luhn-valid number succeeds; last4 0002 = declined, 9995 = insufficient funds, 0069 = expired.
 * Mobile money: numbers ending in 0000 fail, everything else succeeds after ~3 seconds ("customer approved the prompt").
 * Magic MSISDNs (documented in the developer portal so integrators can exercise every branch of the state machine):
 *   +243000000404  wallet not found (immediate failure, category invalid_msisdn)
 *   +243000000408  provider outcome unknown (parked as MANUAL_REVIEW, intent AMBIGUOUS)
 *   +243000000500  timeout then success (pending for 6 seconds, then the customer approves)
 *   +243000000503  provider unavailable (retryable failure)
 */
export const SANDBOX_MAGIC_MSISDNS: { msisdn: string; behaviour: string }[] = [
  { msisdn: '+243000000404', behaviour: 'Wallet not found → attempt fails (invalid_msisdn), intent returns to REQUIRES_PAYMENT_METHOD' },
  { msisdn: '+243000000408', behaviour: 'Provider outcome unknown → payment parked in MANUAL_REVIEW, intent AMBIGUOUS, payment_intent.ambiguous_hold webhook' },
  { msisdn: '+243000000500', behaviour: 'Timeout then success → pending for 6 seconds, then succeeds and settles' },
  { msisdn: '+243000000503', behaviour: 'Provider unavailable → retryable failure (provider_unavailable)' },
  { msisdn: 'any number ending in 0000', behaviour: 'Customer rejects the prompt → declined' },
];
const MAGIC_DELAY_MS = 6000;
function magic(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits === '243000000404') return '404';
  if (digits === '243000000408') return '408';
  if (digits === '243000000500') return '500';
  if (digits === '243000000503') return '503';
  return null;
}
export const sandboxProvider: GatewayProvider = {
  id: 'sandbox',
  name: 'Sandbox (test payments)',
  supportedMethods: ['card', 'mobile_money', 'bank'],
  credentialFields: [],
  async initiate(ctx: InitiateContext): Promise<InitiateResult> {
    const providerRef = `sbx_${shortCode(12)}`;
    if (ctx.method === 'card') {
      if (ctx.savedCardToken) {
        const last4 = ctx.savedCardToken.slice(-4);
        if (last4 === '0002') return { providerRef, status: 'failed', next: { type: 'none' }, failureReason: 'Card declined' };
        return { providerRef, status: 'succeeded', next: { type: 'none' } };
      }
      const card = ctx.card;
      if (!card) return { providerRef, status: 'failed', next: { type: 'none' }, failureReason: 'Card details required' };
      const number = card.number.replace(/\D/g, '');
      if (!luhnCheck(number)) return { providerRef, status: 'failed', next: { type: 'none' }, failureReason: 'Invalid card number' };
      if (!isExpiryValid(card.expMonth, card.expYear)) return { providerRef, status: 'failed', next: { type: 'none' }, failureReason: 'Card has expired' };
      if (!/^\d{3,4}$/.test(card.cvc)) return { providerRef, status: 'failed', next: { type: 'none' }, failureReason: 'Invalid security code' };
      const last4 = number.slice(-4);
      const declines: Record<string, string> = { '0002': 'Card declined by issuer', '9995': 'Insufficient funds', '0069': 'Card expired', '0127': 'Incorrect CVC' };
      if (declines[last4]) return { providerRef, status: 'failed', next: { type: 'none' }, failureReason: declines[last4] };
      return {
        providerRef,
        status: 'succeeded',
        next: { type: 'none' },
        savedCard: ctx.saveCard ? { token: `sbx_card_${shortCode(8)}_${last4}`, brand: detectCardBrand(number), last4, expMonth: card.expMonth, expYear: card.expYear } : undefined,
      };
    }
    if (ctx.method === 'mobile_money') {
      if (!ctx.payer.phone) return { providerRef, status: 'failed', next: { type: 'none' }, failureReason: 'Phone number required' };
      const m = magic(ctx.payer.phone);
      if (m === '404') return { providerRef, status: 'failed', next: { type: 'none' }, failureReason: 'Wallet not found' };
      if (m === '503') return { providerRef, status: 'failed', next: { type: 'none' }, failureReason: 'Provider unavailable' };
      return {
        providerRef,
        status: 'pending',
        next: { type: 'prompt', message: `A payment prompt was sent to ${ctx.payer.phone}. Approve it on your phone to complete the payment. (Sandbox: approves automatically in a few seconds.)` },
      };
    }
    return {
      providerRef,
      status: 'pending',
      next: {
        type: 'bank_instructions',
        message: 'Transfer the exact amount to the account below. Your wallet is credited once the transfer is confirmed.',
        instructions: { 'Bank name': 'Sandbox Bank', 'Account name': 'BitriPay Collections', 'Account number': '0001234567', Reference: providerRef },
      },
    };
  },
  async refund(payment: GatewayPaymentRow, amountMinor: number): Promise<RefundResult> {
    return { status: 'succeeded', providerRef: `sbx_refund_${shortCode(10)}`, message: `Sandbox refund of ${amountMinor} to ${payment.provider_ref}` };
  },
  async verify(payment: GatewayPaymentRow): Promise<VerifyResult> {
    if (payment.status === 'succeeded') return { status: 'succeeded' };
    if (payment.status === 'failed') return { status: 'failed' };
    if (payment.method === 'mobile_money') {
      if (payment.payer_phone?.endsWith('0000')) return { status: 'failed', failureReason: 'Customer rejected the prompt' };
      const m = magic(payment.payer_phone);
      if (m === '408') return { status: 'unknown', failureReason: 'Provider returned no final status' };
      const age = Date.now() - new Date(payment.created_at).getTime();
      if (m === '500') return age > MAGIC_DELAY_MS ? { status: 'succeeded' } : { status: 'pending' };
      return age > 3000 ? { status: 'succeeded' } : { status: 'pending' };
    }
    if (payment.method === 'bank') return { status: 'pending' }; // admin confirms manual transfers
    return { status: payment.status === 'cancelled' ? 'failed' : 'pending' };
  },
};
