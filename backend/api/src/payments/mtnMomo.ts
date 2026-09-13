import type { GatewayProvider, InitiateContext, InitiateResult, VerifyResult, GatewayPaymentRow } from './types';
import { uuid } from '../lib/ids';

function baseUrl(env: string) {
  return env === 'production' ? 'https://proxy.momoapi.mtn.com' : 'https://sandbox.momodeveloper.mtn.com';
}

async function token(creds: Record<string, string>) {
  const res = await fetch(`${baseUrl(creds.env)}/collection/token/`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.apiUser}:${creds.apiKey}`).toString('base64')}`,
      'Ocp-Apim-Subscription-Key': creds.subscriptionKey,
    },
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(json.message || 'MTN MoMo auth failed');
  return json.access_token as string;
}

/** MTN Mobile Money Collections API – request-to-pay prompt on the customer's phone, polled for status. */
export const mtnMomoProvider: GatewayProvider = {
  id: 'mtn_momo',
  name: 'MTN Mobile Money',
  supportedMethods: ['mobile_money'],
  credentialFields: [
    { key: 'subscriptionKey', label: 'Subscription key (Collections)', secret: true },
    { key: 'apiUser', label: 'API user ID' },
    { key: 'apiKey', label: 'API key', secret: true },
    { key: 'env', label: 'Environment (sandbox | production)' },
    { key: 'targetEnvironment', label: 'Target environment (e.g. mtnghana)' },
  ],
  async initiate(ctx: InitiateContext): Promise<InitiateResult> {
    if (!ctx.payer.phone) throw new Error('Phone number required for mobile money');
    const creds = ctx.credentials;
    const accessToken = await token(creds);
    const referenceId = uuid();
    const res = await fetch(`${baseUrl(creds.env)}/collection/v1_0/requesttopay`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Reference-Id': referenceId,
        'X-Target-Environment': creds.targetEnvironment || (creds.env === 'production' ? 'mtnghana' : 'sandbox'),
        'Ocp-Apim-Subscription-Key': creds.subscriptionKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: String(ctx.amountMajor),
        currency: creds.env === 'production' ? ctx.currency : 'EUR',
        externalId: ctx.payment.id,
        payer: { partyIdType: 'MSISDN', partyId: ctx.payer.phone.replace(/^\+/, '') },
        payerMessage: ctx.description.slice(0, 100),
        payeeNote: 'BitriPay',
      }),
    });
    if (res.status !== 202) throw new Error(`MTN MoMo request failed (${res.status})`);
    return { providerRef: referenceId, status: 'pending', next: { type: 'prompt', message: `Approve the MTN MoMo prompt sent to ${ctx.payer.phone}.` } };
  },
  async verify(payment: GatewayPaymentRow, creds): Promise<VerifyResult> {
    if (!payment.provider_ref) return { status: 'pending' };
    const accessToken = await token(creds);
    const res = await fetch(`${baseUrl(creds.env)}/collection/v1_0/requesttopay/${payment.provider_ref}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Target-Environment': creds.targetEnvironment || (creds.env === 'production' ? 'mtnghana' : 'sandbox'),
        'Ocp-Apim-Subscription-Key': creds.subscriptionKey,
      },
    });
    const json: any = await res.json();
    if (json.status === 'SUCCESSFUL') return { status: 'succeeded', raw: json };
    if (json.status === 'FAILED') return { status: 'failed', failureReason: json.reason, raw: json };
    return { status: 'pending', raw: json };
  },
};
