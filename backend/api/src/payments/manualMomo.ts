import type { Request } from 'express';
import { shortCode } from '../lib/ids';
import { getOperator } from '../services/momo';
import { fromMinor } from '@bitripay/shared';
import type { GatewayProvider, InitiateContext, InitiateResult, VerifyResult, GatewayPaymentRow, WebhookEvent } from './types';

/**
 * Direct mobile money rail – works with every operator in the world without an operator API.
 * The customer sends money from their own mobile money account (USSD / app) to the platform's
 * collection number for that operator, using the reference we display. The payment is confirmed:
 *   1. automatically, when the receipt SMS from the operator is forwarded to POST /api/webhooks/manual_momo
 *      (any SMS-forwarder app on the collection phone can do this – configure `smsSecret` on the gateway), or
 *   2. by an admin/agent in Approvals after checking the operator statement.
 */
export const manualMomoProvider: GatewayProvider = {
  id: 'manual_momo',
  name: 'Mobile money (direct, all operators)',
  supportedMethods: ['mobile_money'],
  credentialFields: [
    { key: 'smsSecret', label: 'Shared secret for the SMS-forwarder auto-confirm webhook', secret: true },
    { key: 'defaultInstructions', label: 'Default instructions shown to customers (optional)' },
  ],
  async initiate(ctx: InitiateContext): Promise<InitiateResult> {
    const operatorId = ctx.operatorId;
    if (!operatorId) throw new Error('Choose a mobile money operator');
    const op = getOperator(operatorId);
    if (!op.enabled) throw new Error(`${op.name} is currently disabled`);
    if (!op.collectionNumber) throw new Error(`${op.name} is not yet set up for direct payments. Contact support or choose another operator.`);
    const reference = `MM${shortCode(6)}`;
    const amountMajor = fromMinor(ctx.amountMinor, ctx.decimals);
    const instructions: Record<string, string> = {
      Operator: op.name,
      'Send to': op.collectionNumber,
      ...(op.collectionName ? { 'Account name': op.collectionName } : {}),
      Amount: `${amountMajor} ${ctx.currency}`,
      Reference: reference,
      ...(op.ussd ? { 'USSD code': op.ussd } : {}),
    };
    return {
      providerRef: reference,
      status: 'pending',
      next: {
        type: 'bank_instructions',
        message:
          op.instructions ||
          ctx.credentials.defaultInstructions ||
          `Open ${op.name}${op.ussd ? ` (dial ${op.ussd})` : ''}, send exactly ${amountMajor} ${ctx.currency} to ${op.collectionNumber} and use ${reference} as the reference/note. Then enter the transaction ID below. Your wallet is credited as soon as the payment is confirmed.`,
        instructions,
      },
    };
  },
  async verify(payment: GatewayPaymentRow): Promise<VerifyResult> {
    return { status: payment.status === 'succeeded' ? 'succeeded' : payment.status === 'failed' ? 'failed' : 'pending' };
  },
  /**
   * Auto-confirm from forwarded receipt SMS. Body: { secret, text, from? }.
   * Matches our reference (MMXXXXXX) and the amount inside the message text.
   */
  async parseWebhook(req: Request, credentials): Promise<WebhookEvent[]> {
    const body = req.body ?? {};
    if (!credentials.smsSecret || body.secret !== credentials.smsSecret) throw new Error('Invalid secret');
    const text = String(body.text ?? body.message ?? '');
    const ref = text.match(/MM[A-Z2-9]{6}/i)?.[0]?.toUpperCase();
    if (!ref) return [];
    return [{ providerRef: ref, status: 'succeeded', raw: { text, from: body.from ?? null, matchedAmount: text.match(/(\d[\d,]*(?:\.\d+)?)/)?.[1] ?? null } }];
  },
};
