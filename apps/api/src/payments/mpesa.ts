import type { Request } from 'express';
import type { GatewayProvider, InitiateContext, InitiateResult, VerifyResult, GatewayPaymentRow, WebhookEvent } from './types';

function baseUrl(env: string) {
  return env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
}

async function token(creds: Record<string, string>) {
  const res = await fetch(`${baseUrl(creds.env)}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString('base64')}` },
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error('M-Pesa auth failed');
  return json.access_token as string;
}

function timestamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Safaricom M-Pesa Daraja – Lipa na M-Pesa STK push with callback + status query. */
export const mpesaProvider: GatewayProvider = {
  id: 'mpesa',
  name: 'M-Pesa',
  supportedMethods: ['mobile_money'],
  credentialFields: [
    { key: 'consumerKey', label: 'Consumer key', secret: true },
    { key: 'consumerSecret', label: 'Consumer secret', secret: true },
    { key: 'shortcode', label: 'Business shortcode' },
    { key: 'passkey', label: 'Passkey', secret: true },
    { key: 'env', label: 'Environment (sandbox | production)' },
  ],
  async initiate(ctx: InitiateContext): Promise<InitiateResult> {
    if (!ctx.payer.phone) throw new Error('Phone number required for M-Pesa');
    const creds = ctx.credentials;
    const accessToken = await token(creds);
    const ts = timestamp();
    const password = Buffer.from(`${creds.shortcode}${creds.passkey}${ts}`).toString('base64');
    const res = await fetch(`${baseUrl(creds.env)}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: creds.shortcode,
        Password: password,
        Timestamp: ts,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.ceil(ctx.amountMajor),
        PartyA: ctx.payer.phone.replace(/^\+/, ''),
        PartyB: creds.shortcode,
        PhoneNumber: ctx.payer.phone.replace(/^\+/, ''),
        CallBackURL: ctx.callbackUrl,
        AccountReference: ctx.payment.id.slice(0, 12),
        TransactionDesc: ctx.description.slice(0, 13),
      }),
    });
    const json: any = await res.json();
    if (json.ResponseCode !== '0') throw new Error(json.errorMessage || json.ResponseDescription || 'M-Pesa STK push failed');
    return { providerRef: json.CheckoutRequestID, status: 'pending', next: { type: 'prompt', message: `Enter your M-Pesa PIN on the prompt sent to ${ctx.payer.phone}.` }, raw: json };
  },
  async verify(payment: GatewayPaymentRow, creds): Promise<VerifyResult> {
    if (!payment.provider_ref) return { status: 'pending' };
    const accessToken = await token(creds);
    const ts = timestamp();
    const password = Buffer.from(`${creds.shortcode}${creds.passkey}${ts}`).toString('base64');
    const res = await fetch(`${baseUrl(creds.env)}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ BusinessShortCode: creds.shortcode, Password: password, Timestamp: ts, CheckoutRequestID: payment.provider_ref }),
    });
    const json: any = await res.json();
    if (json.ResultCode === '0' || json.ResultCode === 0) return { status: 'succeeded', raw: json };
    if (json.ResultCode !== undefined && json.ResultCode !== '4999' && json.errorCode !== '500.001.1001') return { status: 'failed', failureReason: json.ResultDesc, raw: json };
    return { status: 'pending', raw: json };
  },
  async parseWebhook(req: Request): Promise<WebhookEvent[]> {
    const cb = req.body?.Body?.stkCallback;
    if (!cb?.CheckoutRequestID) return [];
    return [{ providerRef: cb.CheckoutRequestID, status: cb.ResultCode === 0 ? 'succeeded' : 'failed', raw: req.body }];
  },
};
