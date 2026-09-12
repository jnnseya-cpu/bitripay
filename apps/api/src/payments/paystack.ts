import type { Request } from 'express';
import { createHmac } from 'node:crypto';
import type { GatewayProvider, InitiateContext, InitiateResult, VerifyResult, GatewayPaymentRow, WebhookEvent } from './types';

const BASE = 'https://api.paystack.co';

async function call(secret: string, path: string, method: 'GET' | 'POST', body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json.status === false) throw new Error(json.message || `Paystack error ${res.status}`);
  return json;
}

/** Paystack adapter – hosted checkout (cards, bank, USSD, mobile money) with saved authorizations for repeat charges. */
export const paystackProvider: GatewayProvider = {
  id: 'paystack',
  name: 'Paystack',
  supportedMethods: ['card', 'mobile_money', 'bank'],
  keyMode(credentials) {
    const k = credentials.secretKey || '';
    return k.startsWith('sk_live_') ? 'live' : k.startsWith('sk_test_') ? 'test' : 'unknown';
  },
  async healthCheck(credentials) {
    const mode = paystackProvider.keyMode!(credentials);
    try {
      const r: any = await call(credentials.secretKey, '/bank?perPage=1', 'GET');
      return { ok: true, mode, message: `Connected (${mode}) · ${r.data?.length ?? 0} bank(s) listed`, details: {} };
    } catch (err) {
      return { ok: false, mode, message: (err as Error).message };
    }
  },
  credentialFields: [{ key: 'secretKey', label: 'Secret key', secret: true }],
  async initiate(ctx: InitiateContext): Promise<InitiateResult> {
    const secret = ctx.credentials.secretKey;
    if (!secret) throw new Error('Paystack secret key not configured');
    const email = ctx.payer.email || `${ctx.payer.phone || 'guest'}@bitripay.local`;
    const reference = `bp_${ctx.payment.id.replace(/-/g, '')}`;
    if (ctx.savedCardToken) {
      const json = await call(secret, '/transaction/charge_authorization', 'POST', {
        email,
        amount: ctx.amountMinor,
        currency: ctx.currency,
        authorization_code: ctx.savedCardToken,
        reference,
        metadata: { bitripay_payment_id: ctx.payment.id },
      });
      const ok = json.data?.status === 'success';
      return { providerRef: reference, status: ok ? 'succeeded' : 'failed', next: { type: 'none' }, failureReason: ok ? undefined : json.data?.gateway_response, raw: json };
    }
    const channels = ctx.method === 'card' ? ['card'] : ctx.method === 'mobile_money' ? ['mobile_money'] : ['bank', 'bank_transfer', 'ussd'];
    const json = await call(secret, '/transaction/initialize', 'POST', {
      email,
      amount: ctx.amountMinor,
      currency: ctx.currency,
      reference,
      callback_url: ctx.returnUrl,
      channels,
      metadata: { bitripay_payment_id: ctx.payment.id, phone: ctx.payer.phone, custom_fields: [] },
    });
    return { providerRef: reference, status: 'pending', next: { type: 'redirect', url: json.data.authorization_url }, raw: json };
  },
  async verify(payment: GatewayPaymentRow, credentials): Promise<VerifyResult> {
    if (!payment.provider_ref) return { status: 'pending' };
    const json = await call(credentials.secretKey, `/transaction/verify/${encodeURIComponent(payment.provider_ref)}`, 'GET');
    const data = json.data;
    if (data.status === 'success') {
      const auth = data.authorization;
      const savedCard = auth?.reusable && auth.authorization_code
        ? { token: auth.authorization_code, brand: auth.brand || auth.card_type || 'card', last4: auth.last4, expMonth: Number(auth.exp_month), expYear: Number(auth.exp_year) }
        : undefined;
      return { status: 'succeeded', raw: data, savedCard };
    }
    if (data.status === 'failed' || data.status === 'abandoned' || data.status === 'reversed') return { status: 'failed', failureReason: data.gateway_response, raw: data };
    return { status: 'pending', raw: data };
  },
  async parseWebhook(req: Request, credentials): Promise<WebhookEvent[]> {
    const raw = (req as any).rawBody as Buffer | undefined;
    const sig = req.headers['x-paystack-signature'];
    if (credentials.secretKey && raw) {
      const expected = createHmac('sha512', credentials.secretKey).update(raw).digest('hex');
      if (expected !== sig) throw new Error('Invalid Paystack signature');
    }
    const event = req.body;
    if (event.event === 'charge.success') return [{ providerRef: event.data.reference, status: 'succeeded', raw: event }];
    if (event.event === 'charge.failed') return [{ providerRef: event.data.reference, status: 'failed', raw: event }];
    return [];
  },
};
