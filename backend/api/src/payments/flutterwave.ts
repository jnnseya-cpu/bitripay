import type { Request } from 'express';
import type { GatewayProvider, InitiateContext, InitiateResult, VerifyResult, GatewayPaymentRow, WebhookEvent } from './types';

const BASE = 'https://api.flutterwave.com/v3';

async function call(secret: string, path: string, method: 'GET' | 'POST', body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json.status === 'error') throw new Error(json.message || `Flutterwave error ${res.status}`);
  return json;
}

const MOMO_NETWORKS: Record<string, string> = {
  GHS: 'mobile_money_ghana',
  KES: 'mpesa',
  UGX: 'mobile_money_uganda',
  RWF: 'mobile_money_rwanda',
  ZMW: 'mobile_money_zambia',
  TZS: 'mobile_money_tanzania',
  XAF: 'mobile_money_franco',
  XOF: 'mobile_money_franco',
};

/** Flutterwave adapter – Standard hosted checkout for cards/bank, direct mobile money charges for African wallets. */
export const flutterwaveProvider: GatewayProvider = {
  id: 'flutterwave',
  name: 'Flutterwave',
  supportedMethods: ['card', 'mobile_money', 'bank'],
  credentialFields: [
    { key: 'secretKey', label: 'Secret key', secret: true },
    { key: 'webhookHash', label: 'Webhook secret hash', secret: true },
  ],
  keyMode(credentials) {
    const k = credentials.secretKey || '';
    return k.startsWith('FLWSECK_TEST') ? 'test' : k.startsWith('FLWSECK-') ? 'live' : 'unknown';
  },
  async healthCheck(credentials) {
    const mode = flutterwaveProvider.keyMode!(credentials);
    try {
      const r: any = await call(credentials.secretKey, '/banks/NG', 'GET');
      return { ok: true, mode, message: `Connected (${mode}) · ${r.data?.length ?? 0} bank(s) listed`, details: { webhookHash: !!credentials.webhookHash } };
    } catch (err) {
      return { ok: false, mode, message: (err as Error).message };
    }
  },
  async initiate(ctx: InitiateContext): Promise<InitiateResult> {
    const secret = ctx.credentials.secretKey;
    if (!secret) throw new Error('Flutterwave secret key not configured');
    const txRef = `bp_${ctx.payment.id.replace(/-/g, '')}`;
    const email = ctx.payer.email || `${ctx.payer.phone || 'guest'}@bitripay.local`;
    if (ctx.method === 'mobile_money' && MOMO_NETWORKS[ctx.currency]) {
      const json = await call(secret, `/charges?type=${MOMO_NETWORKS[ctx.currency]}`, 'POST', {
        tx_ref: txRef,
        amount: ctx.amountMajor,
        currency: ctx.currency,
        email,
        phone_number: ctx.payer.phone,
        fullname: ctx.payer.name || undefined,
        redirect_url: ctx.returnUrl,
        meta: { bitripay_payment_id: ctx.payment.id },
      });
      const redirect = json.meta?.authorization?.redirect;
      return {
        providerRef: txRef,
        status: 'pending',
        next: redirect ? { type: 'redirect', url: redirect } : { type: 'prompt', message: `Approve the payment prompt sent to ${ctx.payer.phone}.` },
        raw: json,
      };
    }
    if (ctx.savedCardToken) {
      const json = await call(secret, '/tokenized-charges', 'POST', { token: ctx.savedCardToken, currency: ctx.currency, amount: ctx.amountMajor, email, tx_ref: txRef });
      const ok = json.data?.status === 'successful';
      return { providerRef: txRef, status: ok ? 'succeeded' : 'failed', next: { type: 'none' }, raw: json };
    }
    const json = await call(secret, '/payments', 'POST', {
      tx_ref: txRef,
      amount: ctx.amountMajor,
      currency: ctx.currency,
      redirect_url: ctx.returnUrl,
      payment_options: ctx.method === 'card' ? 'card' : ctx.method === 'mobile_money' ? 'mobilemoney' : 'banktransfer,account,ussd',
      customer: { email, phonenumber: ctx.payer.phone || undefined, name: ctx.payer.name || undefined },
      customizations: { title: 'BitriPay', description: ctx.description },
      meta: { bitripay_payment_id: ctx.payment.id },
    });
    return { providerRef: txRef, status: 'pending', next: { type: 'redirect', url: json.data.link }, raw: json };
  },
  async verify(payment: GatewayPaymentRow, credentials): Promise<VerifyResult> {
    if (!payment.provider_ref) return { status: 'pending' };
    const json = await call(credentials.secretKey, `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(payment.provider_ref)}`, 'GET');
    const data = json.data;
    if (!data) return { status: 'pending' };
    if (data.status === 'successful' && Number(data.amount) >= payment.amount / 100 - 0.01 && data.currency === payment.currency) {
      const card = data.card;
      const savedCard = card?.token
        ? { token: card.token, brand: card.type || 'card', last4: card.last_4digits, expMonth: Number(card.expiry?.split('/')[0]), expYear: 2000 + Number(card.expiry?.split('/')[1]) }
        : undefined;
      return { status: 'succeeded', raw: data, savedCard };
    }
    if (data.status === 'failed' || data.status === 'cancelled') return { status: 'failed', failureReason: data.processor_response, raw: data };
    return { status: 'pending', raw: data };
  },
  async parseWebhook(req: Request, credentials): Promise<WebhookEvent[]> {
    if (credentials.webhookHash && req.headers['verif-hash'] !== credentials.webhookHash) throw new Error('Invalid Flutterwave webhook hash');
    const body = req.body;
    const data = body.data || body;
    if (!data?.tx_ref) return [];
    const status = data.status === 'successful' ? 'succeeded' : data.status === 'failed' ? 'failed' : 'pending';
    return [{ providerRef: data.tx_ref, status, raw: body }];
  },
};
