import type { GatewayProvider, InitiateContext, InitiateResult, VerifyResult, GatewayPaymentRow } from './types';
import { shortCode } from '../lib/ids';

/** Manual bank transfer – shows the platform's bank details; an admin confirms receipt in the admin panel. */
export const manualBankProvider: GatewayProvider = {
  id: 'manual_bank',
  name: 'Bank transfer (manual confirmation)',
  supportedMethods: ['bank'],
  credentialFields: [
    { key: 'bankName', label: 'Bank name' },
    { key: 'accountName', label: 'Account name' },
    { key: 'accountNumber', label: 'Account number / IBAN' },
    { key: 'swift', label: 'SWIFT / routing (optional)' },
    { key: 'instructions', label: 'Extra instructions (optional)' },
  ],
  async initiate(ctx: InitiateContext): Promise<InitiateResult> {
    const ref = `BT-${shortCode(8)}`;
    const c = ctx.credentials;
    const instructions: Record<string, string> = {
      'Bank name': c.bankName || 'Configure in admin → Gateways',
      'Account name': c.accountName || '',
      'Account number': c.accountNumber || '',
      Reference: ref,
    };
    if (c.swift) instructions['SWIFT / routing'] = c.swift;
    return {
      providerRef: ref,
      status: 'pending',
      next: { type: 'bank_instructions', message: c.instructions || 'Send the exact amount using the reference below. Funds are credited once our team confirms the transfer.', instructions },
    };
  },
  async verify(payment: GatewayPaymentRow): Promise<VerifyResult> {
    return { status: payment.status === 'succeeded' ? 'succeeded' : payment.status === 'failed' ? 'failed' : 'pending' };
  },
};
