import { detectCardBrand, luhnCheck, isExpiryValid } from '@bitripay/shared';
import { shortCode } from '../lib/ids';
import type { GatewayProvider, InitiateContext, InitiateResult, VerifyResult, GatewayPaymentRow, RefundResult } from './types';

/**
 * Sandbox gateway – simulates cards, mobile money and bank transfers without any external service.
 * Test cards: any Luhn-valid number succeeds; last4 0002 = declined, 9995 = insufficient funds, 0069 = expired.
 * Mobile money: numbers ending in 0000 fail, everything else succeeds after ~3 seconds ("customer approved the prompt").
 */
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
      const age = Date.now() - new Date(payment.created_at).getTime();
      return age > 3000 ? { status: 'succeeded' } : { status: 'pending' };
    }
    if (payment.method === 'bank') return { status: 'pending' }; // admin confirms manual transfers
    return { status: payment.status === 'cancelled' ? 'failed' : 'pending' };
  },
};
