/**
 * Bitcoin rail: Lightning (BOLT11) and on-chain invoices behind the same payment intent and QR as every other method.
 *
 * Two modes, chosen by the `mode` credential:
 *   sandbox – invoices are generated locally and deterministically from the connector idempotency key; they are paid
 *             through the sandbox simulator (`POST /api/deposits/:id/bitcoin/simulate`, `POST /v1/sandbox/simulate`)
 *             and never by anything external. Rates are the sandbox BTC rate, labelled as such.
 *   btcpay  – BTCPay Server Greenfield API (`POST /api/v1/stores/{storeId}/invoices`, `GET …/invoices/{id}`,
 *             `GET …/invoices/{id}/payment-methods`, `DELETE …/invoices/{id}` to archive, `GET /api/v1/server/info`
 *             for the health check). Webhooks carry `BTCPay-Sig: sha256=<HMAC-SHA256(raw body, webhook secret)>`.
 *
 * Confirmation policy: Lightning settles the moment the invoice is paid; on-chain payments settle after
 * `confirmations` confirmations (credential, default 1). Refunds are never automatic on chain: `refund` returns
 * `manual` so operations return the funds by hand and record it. The BTC currency row is seeded disabled with a
 * sandbox rate (`sandbox_btc_rate_v1`); live rates arrive through the existing rate refresh / import mechanism.
 */
import type { Request } from 'express';
import { createHmac } from 'node:crypto';
import { exchangeRate, fromMinor } from '@bitripay/shared';
import { getDb } from '../db';
import { now } from '../lib/ids';
import { sha256, safeEqual } from '../lib/crypto';
import { parseJson } from '../lib/json';
import { getCurrency } from '../services/currencies';
import { getAppSettings } from '../services/settings';
import type { Actor } from '../services/events';
import type {
  GatewayProvider,
  InitiateContext,
  InitiateResult,
  VerifyResult,
  GatewayPaymentRow,
  RefundResult,
  QuoteContext,
  QuoteResult,
  ConnectorCapabilities,
  CancelResult,
  WebhookEvent,
  HealthResult,
  GatewayMode,
  BitcoinInvoiceView,
  BitcoinRateDisclosure,
} from './types';

export type BitcoinMode = 'sandbox' | 'btcpay';
export const BTC_CURRENCY = { code: 'BTC', name: 'Bitcoin', symbol: '₿', decimals: 8 } as const;
export const SATS_PER_BTC = 100_000_000;
/** Rate source label of the seeded sandbox rate – never presented as live. */
export const SANDBOX_BTC_RATE_SOURCE = 'sandbox_btc_rate_v1';
/** Sandbox price used to seed the BTC row: 1 BTC = 65 000 USD. A versioned test rate, labelled everywhere. */
export const SANDBOX_USD_PER_BTC = 65_000;
export const BITCOIN_FEE_BPS = 100;
export const BITCOIN_CAPABILITIES: ConnectorCapabilities = { minMinor: 0, maxMinor: 0, refunds: false, settlementT: 0, webhooks: true, lastIncidentAt: null };
const DEFAULT_CONFIRMATIONS = 1;
const DEFAULT_EXPIRY_MINUTES = 15;
const BTCPAY_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------------------------------
export function bitcoinMode(credentials: Record<string, string>): BitcoinMode {
  const mode = (credentials.mode ?? '').trim().toLowerCase();
  if (mode === 'btcpay' || mode === 'sandbox') return mode;
  return credentials.serverUrl && credentials.apiKey ? 'btcpay' : 'sandbox';
}
const positiveInt = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};
export const bitcoinConfirmations = (credentials: Record<string, string>) => positiveInt(credentials.confirmations, DEFAULT_CONFIRMATIONS);
const invoiceExpiryMinutes = (credentials: Record<string, string>) => Math.max(1, positiveInt(credentials.invoiceExpiryMinutes, DEFAULT_EXPIRY_MINUTES));
const bitcoinNetwork = (credentials: Record<string, string>, mode: BitcoinMode) => {
  const n = (credentials.network ?? '').trim().toLowerCase();
  if (['mainnet', 'testnet', 'signet', 'regtest'].includes(n)) return n;
  return mode === 'sandbox' ? 'regtest' : 'mainnet';
};

// ---------------------------------------------------------------------------------------------------------------------
// BTC currency row and rate disclosure
// ---------------------------------------------------------------------------------------------------------------------
/** Seed the BTC currency (disabled, 8 decimals, sandbox rate) so quotes, imports and BTC wallets have a row to work with. */
export function ensureBitcoinCurrency(): void {
  const db = getDb();
  if (db.prepare('SELECT 1 FROM currencies WHERE code = ?').get(BTC_CURRENCY.code)) return;
  // rate_to_base = BTC per one base-currency unit, derived from the sandbox USD price through the base currency's own USD rate.
  const usd = db.prepare('SELECT rate_to_base FROM currencies WHERE code = ?').get('USD') as { rate_to_base: number } | undefined;
  const usdPerBase = usd?.rate_to_base && usd.rate_to_base > 0 ? usd.rate_to_base : 1;
  db.prepare('INSERT INTO currencies (code, name, symbol, decimals, rate_to_base, enabled, is_base, rate_source, rate_updated_at, sort_order) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, 999)').run(
    BTC_CURRENCY.code,
    BTC_CURRENCY.name,
    BTC_CURRENCY.symbol,
    BTC_CURRENCY.decimals,
    usdPerBase / SANDBOX_USD_PER_BTC,
    SANDBOX_BTC_RATE_SOURCE,
    now(),
  );
}
/** Merchants settling in BTC need the BTC currency enabled (a BTC wallet is an ordinary ledger wallet). */
export function setBitcoinCurrencyEnabled(enabled: boolean): void {
  ensureBitcoinCurrency();
  getDb()
    .prepare('UPDATE currencies SET enabled = ? WHERE code = ?')
    .run(enabled ? 1 : 0, BTC_CURRENCY.code);
}
export function bitcoinCurrencyEnabled(): boolean {
  ensureBitcoinCurrency();
  return getCurrency(BTC_CURRENCY.code, false).enabled === true;
}

/** Fiat → BTC at the platform rate provider, margin disclosed and applied against the payer (more sats due). */
export function bitcoinRate(fiatCurrency: string): BitcoinRateDisclosure {
  ensureBitcoinCurrency();
  const fiat = getCurrency(fiatCurrency, false);
  const btc = getCurrency(BTC_CURRENCY.code, false);
  const midRate = exchangeRate(fiat, btc);
  const marginBps = getAppSettings().exchangeMarginBps;
  const rate = midRate * (1 + marginBps / 10_000);
  const source = btc.rateSource;
  const sandbox = source.startsWith('sandbox') || source.startsWith('test_rates') || source === 'manual';
  const label = source.startsWith('sandbox')
    ? `Sandbox BTC rate (${source}) – NOT a live market rate`
    : source.startsWith('test_rates')
      ? `Versioned test rate (${source}) – NOT a live market rate`
      : source.startsWith('import_')
        ? `Administrator-imported rate batch ${source.replace('import_', '')} – not live`
        : source === 'manual'
          ? 'Administrator-approved BTC rate (not a live market rate)'
          : `Live BTC rate from ${source}`;
  return { fiatCurrency: fiat.code, midRate, rate, marginBps, satsPerUnit: Math.ceil(rate * SATS_PER_BTC), rateSource: source, rateUpdatedAt: btc.rateUpdatedAt, sandbox, label };
}
/** Satoshis due for a fiat amount at the disclosed rate (rounded up: the invoice never under-collects). */
export function satsFor(amountMinor: number, fiatCurrency: string, rate: BitcoinRateDisclosure): number {
  const fiat = getCurrency(fiatCurrency, false);
  return Math.max(1, Math.ceil((amountMinor / 10 ** fiat.decimals) * rate.rate * SATS_PER_BTC));
}
export const formatBtc = (sats: number) => fromMinor(sats, BTC_CURRENCY.decimals);

// ---------------------------------------------------------------------------------------------------------------------
// Sandbox invoices (deterministic from the idempotency key)
// ---------------------------------------------------------------------------------------------------------------------
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const bech32ish = (hex: string, length: number) =>
  hex
    .slice(0, length)
    .split('')
    .map((c) => BECH32[parseInt(c, 16)])
    .join('');
const HRP: Record<string, { chain: string; ln: string }> = {
  mainnet: { chain: 'bc1q', ln: 'lnbc' },
  testnet: { chain: 'tb1q', ln: 'lntb' },
  signet: { chain: 'tb1q', ln: 'lntbs' },
  regtest: { chain: 'bcrt1q', ln: 'lnbcrt' },
};

export function sandboxInvoice(input: { key: string | undefined; amountMinor: number; currency: string; credentials: Record<string, string> }): BitcoinInvoiceView {
  const seed = input.key ?? `${Date.now()}:${Math.random()}`;
  const h = sha256(`bitcoin:sandbox:${seed}`);
  const network = bitcoinNetwork(input.credentials, 'sandbox');
  const rate = bitcoinRate(input.currency);
  const amountSats = satsFor(input.amountMinor, input.currency, rate);
  const amountBtc = formatBtc(amountSats);
  const hrp = HRP[network] ?? HRP.regtest;
  const address = `${hrp.chain}${bech32ish(h, 38)}`;
  // BOLT11-shaped sandbox invoice: amount in units of 10 msat ("n" = nano-bitcoin), payment-hash-like body from the seed.
  const lightning = `${hrp.ln}${amountSats * 10}n1p${bech32ish(sha256(h), 52)}`;
  return {
    invoiceId: `btcsbx_${h.slice(0, 16)}`,
    mode: 'sandbox',
    network,
    fiat: { amountMinor: input.amountMinor, currency: input.currency.toUpperCase() },
    amountSats,
    amountBtc,
    lightning,
    address,
    bip21: `bitcoin:${address}?amount=${amountBtc}&lightning=${lightning}`,
    checkoutUrl: null,
    rate,
    expiresAt: new Date(Date.now() + invoiceExpiryMinutes(input.credentials) * 60_000).toISOString(),
    confirmations: { lightning: 'settled_on_payment', onChain: bitcoinConfirmations(input.credentials) },
    sandbox: true,
  };
}

interface SandboxState {
  paidAt?: string | null;
  invalidatedAt?: string | null;
  paidBy?: Actor | null;
}
export function invoiceOf(payment: Pick<GatewayPaymentRow, 'metadata'>): BitcoinInvoiceView | null {
  const meta = parseJson<{ next?: { type?: string; invoice?: BitcoinInvoiceView } }>(payment.metadata, {});
  return meta.next?.type === 'bitcoin_invoice' && meta.next.invoice ? meta.next.invoice : null;
}
function sandboxState(payment: Pick<GatewayPaymentRow, 'metadata'>): SandboxState {
  return parseJson<{ bitcoin?: { sandbox?: SandboxState } }>(payment.metadata, {}).bitcoin?.sandbox ?? {};
}
/** Metadata patch recording that a sandbox invoice was paid (or marked invalid) by the simulator; merged by the payments service. */
export function markSandboxInvoice(metadata: string, outcome: 'paid' | 'invalid', actor: Actor): Record<string, unknown> {
  const current = parseJson<{ bitcoin?: Record<string, unknown> }>(metadata, {}).bitcoin ?? {};
  const state: SandboxState = { ...((current.sandbox as SandboxState | undefined) ?? {}) };
  if (outcome === 'paid') {
    state.paidAt = now();
    state.paidBy = actor;
  } else state.invalidatedAt = now();
  return { bitcoin: { ...current, sandbox: state } };
}

// ---------------------------------------------------------------------------------------------------------------------
// BTCPay Greenfield
// ---------------------------------------------------------------------------------------------------------------------
export type GreenfieldStatus = 'New' | 'Processing' | 'Settled' | 'Expired' | 'Invalid';
/** Greenfield invoice states → platform outcomes. `Expired` after a partial / late payment is `unknown` (money moved, a human decides). */
export function mapInvoiceStatus(status: string | null | undefined, additionalStatus?: string | null): VerifyResult {
  const s = String(status ?? '');
  const extra = String(additionalStatus ?? 'None');
  switch (s) {
    case 'Settled':
      return { status: 'succeeded' };
    case 'New':
      return { status: 'pending' };
    case 'Processing':
      return { status: 'pending', failureReason: 'Payment seen, awaiting confirmations' };
    case 'Expired':
      if (extra === 'PaidPartial' || extra === 'PaidLate') return { status: 'unknown', failureReason: `Invoice expired after a ${extra === 'PaidLate' ? 'late' : 'partial'} payment` };
      return { status: 'failed', failureReason: 'Invoice expired before payment' };
    case 'Invalid':
      return { status: 'failed', failureReason: extra === 'Marked' ? 'Invoice marked invalid by the operator' : 'Invoice invalid' };
    default:
      return { status: 'unknown', failureReason: `Unrecognised invoice state ${s || '(none)'}` };
  }
}
const WEBHOOK_TYPES: Record<string, WebhookEvent['status'] | null> = {
  InvoiceCreated: null,
  InvoiceReceivedPayment: 'pending',
  InvoicePaymentSettled: 'pending',
  InvoiceProcessing: 'pending',
  InvoiceSettled: 'succeeded',
  InvoiceExpired: 'failed',
  InvoiceInvalid: 'failed',
};
export const BTCPAY_SIGNATURE_HEADER = 'btcpay-sig';
export function signBtcpayWebhook(secret: string, rawBody: string | Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}
export function verifyBtcpaySignature(secret: string, rawBody: string | Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = signBtcpayWebhook(secret, rawBody);
  return safeEqual(expected, header.trim());
}
function speedPolicy(confirmations: number): string {
  if (confirmations <= 0) return 'HighSpeed';
  if (confirmations === 1) return 'MediumSpeed';
  if (confirmations < 6) return 'LowMediumSpeed';
  return 'LowSpeed';
}
function requireBtcpay(credentials: Record<string, string>) {
  const serverUrl = (credentials.serverUrl ?? '').trim().replace(/\/+$/, '');
  const storeId = (credentials.storeId ?? '').trim();
  const apiKey = (credentials.apiKey ?? '').trim();
  if (!serverUrl || !storeId || !apiKey) throw new Error('BTCPay mode needs serverUrl, storeId and apiKey');
  if (!/^https?:\/\//.test(serverUrl)) throw new Error('BTCPay serverUrl must be an http(s) URL');
  return { serverUrl, storeId, apiKey };
}
async function greenfield<T>(credentials: Record<string, string>, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { serverUrl, apiKey } = requireBtcpay(credentials);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BTCPAY_TIMEOUT_MS);
  try {
    const res = await fetch(`${serverUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `token ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`BTCPay ${res.status}: ${text.slice(0, 200) || res.statusText}`);
    return (text ? JSON.parse(text) : {}) as T;
  } finally {
    clearTimeout(timer);
  }
}
interface GreenfieldInvoice {
  id: string;
  status: GreenfieldStatus;
  additionalStatus?: string;
  checkoutLink?: string;
  amount?: string;
  currency?: string;
  expirationTime?: number;
  metadata?: Record<string, unknown>;
}
interface GreenfieldPaymentMethod {
  paymentMethodId?: string;
  paymentMethod?: string;
  destination?: string;
  paymentLink?: string;
  rate?: string;
  amount?: string;
  due?: string;
  activated?: boolean;
}
const isLightning = (pm: GreenfieldPaymentMethod) => /LN|Lightning/i.test(pm.paymentMethodId ?? pm.paymentMethod ?? '');
const toMs = (t: number | undefined) => (t == null ? Date.now() + DEFAULT_EXPIRY_MINUTES * 60_000 : t > 1e12 ? t : t * 1000);

async function btcpayInvoice(ctx: InitiateContext, credentials: Record<string, string>): Promise<BitcoinInvoiceView> {
  const { storeId } = requireBtcpay(credentials);
  const confirmations = bitcoinConfirmations(credentials);
  const rate = bitcoinRate(ctx.currency);
  const created = await greenfield<GreenfieldInvoice>(credentials, `/api/v1/stores/${encodeURIComponent(storeId)}/invoices`, {
    method: 'POST',
    body: {
      amount: fromMinor(ctx.amountMinor, ctx.decimals),
      currency: ctx.currency,
      checkout: { expirationMinutes: invoiceExpiryMinutes(credentials), speedPolicy: speedPolicy(confirmations), redirectURL: ctx.returnUrl },
      metadata: { orderId: ctx.payment.id, itemDesc: ctx.description, buyerEmail: ctx.payer.email ?? undefined, idempotencyKey: ctx.idempotencyKey ?? null },
    },
  });
  const methods = await greenfield<GreenfieldPaymentMethod[]>(credentials, `/api/v1/stores/${encodeURIComponent(storeId)}/invoices/${encodeURIComponent(created.id)}/payment-methods`);
  const ln = methods.find(isLightning);
  const chain = methods.find((m) => !isLightning(m));
  const due = Number(chain?.due ?? chain?.amount ?? ln?.due ?? ln?.amount ?? 0);
  const amountSats = due > 0 ? Math.round(due * SATS_PER_BTC) : satsFor(ctx.amountMinor, ctx.currency, rate);
  const providerRate = Number(chain?.rate ?? ln?.rate ?? 0);
  const address = chain?.destination ?? null;
  const lightning = ln?.destination ?? null;
  return {
    invoiceId: created.id,
    mode: 'btcpay',
    network: bitcoinNetwork(credentials, 'btcpay'),
    fiat: { amountMinor: ctx.amountMinor, currency: ctx.currency },
    amountSats,
    amountBtc: formatBtc(amountSats),
    lightning,
    address,
    bip21: chain?.paymentLink ?? (address ? `bitcoin:${address}?amount=${formatBtc(amountSats)}${lightning ? `&lightning=${lightning}` : ''}` : null),
    checkoutUrl: created.checkoutLink ?? null,
    // BTCPay prices the invoice at its own rate; the platform margin and source stay disclosed alongside it.
    rate:
      providerRate > 0
        ? {
            ...rate,
            midRate: 1 / providerRate,
            rate: 1 / providerRate,
            satsPerUnit: Math.ceil(SATS_PER_BTC / providerRate),
            rateSource: 'btcpay',
            sandbox: false,
            label: 'BTCPay Server rate (provider-priced invoice)',
          }
        : rate,
    expiresAt: new Date(toMs(created.expirationTime)).toISOString(),
    confirmations: { lightning: 'settled_on_payment', onChain: confirmations },
    sandbox: false,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------------------------------
function invoiceInstructions(inv: BitcoinInvoiceView): Record<string, string> {
  const out: Record<string, string> = { Amount: `${inv.amountBtc} BTC (${inv.amountSats} sats)`, Rate: `${inv.rate.satsPerUnit} sats per ${inv.rate.fiatCurrency} · ${inv.rate.label}` };
  if (inv.lightning) out['Lightning invoice'] = inv.lightning;
  if (inv.address) out['Bitcoin address'] = inv.address;
  out['Confirmation policy'] = `Lightning: settled on payment · on-chain: ${inv.confirmations.onChain} confirmation${inv.confirmations.onChain === 1 ? '' : 's'}`;
  out['Expires'] = inv.expiresAt;
  return out;
}

function keyModeOf(credentials: Record<string, string>): GatewayMode {
  if (bitcoinMode(credentials) === 'sandbox') return 'test';
  return bitcoinNetwork(credentials, 'btcpay') === 'mainnet' ? 'live' : 'test';
}

export const bitcoinProvider: GatewayProvider = {
  id: 'bitcoin',
  name: 'Bitcoin / Lightning (sandbox or BTCPay Server)',
  supportedMethods: ['bitcoin'],
  credentialFields: [
    { key: 'mode', label: 'Mode (sandbox | btcpay)' },
    { key: 'serverUrl', label: 'BTCPay Server URL (btcpay mode)' },
    { key: 'storeId', label: 'BTCPay store id (btcpay mode)' },
    { key: 'apiKey', label: 'BTCPay Greenfield API key (btcpay mode)', secret: true },
    { key: 'webhookSecret', label: 'BTCPay webhook secret (BTCPay-Sig HMAC-SHA256)', secret: true },
    { key: 'network', label: 'Network (mainnet | testnet | signet | regtest)' },
    { key: 'confirmations', label: 'On-chain confirmations required (default 1)' },
    { key: 'invoiceExpiryMinutes', label: 'Invoice expiry in minutes (default 15)' },
  ],
  keyMode(credentials): GatewayMode {
    return keyModeOf(credentials);
  },
  capabilities(): ConnectorCapabilities {
    return { ...BITCOIN_CAPABILITIES };
  },
  async quote(ctx: QuoteContext): Promise<QuoteResult> {
    const rate = bitcoinRate(ctx.currency);
    const confirmations = bitcoinConfirmations(ctx.credentials);
    return {
      feeMinor: Math.round((ctx.amountMinor * BITCOIN_FEE_BPS) / 10_000),
      feeBps: BITCOIN_FEE_BPS,
      currency: ctx.currency.toUpperCase(),
      targetCurrency: BTC_CURRENCY.code,
      fxRate: rate.rate,
      // Lightning is instant; an on-chain payment waits ~10 minutes per confirmation.
      etaSeconds: confirmations * 600,
      expiresAt: new Date(Date.now() + invoiceExpiryMinutes(ctx.credentials) * 60_000).toISOString(),
      disclosure: rate,
    };
  },
  async healthCheck(credentials): Promise<HealthResult> {
    const mode = bitcoinMode(credentials);
    if (mode === 'sandbox')
      return {
        ok: true,
        mode: 'test',
        message: 'Sandbox Bitcoin rail: invoices are generated locally and paid through the simulator; sandbox BTC rate',
        details: { network: bitcoinNetwork(credentials, mode) },
      };
    try {
      const info = await greenfield<Record<string, unknown>>(credentials, '/api/v1/server/info');
      const store = await greenfield<Record<string, unknown>>(credentials, `/api/v1/stores/${encodeURIComponent(requireBtcpay(credentials).storeId)}`);
      return {
        ok: true,
        mode: keyModeOf(credentials),
        message: `BTCPay Server ${String(info.version ?? '')} reachable · store ${String(store.name ?? store.id ?? '')}${credentials.webhookSecret ? '' : ' · webhook secret not configured'}`.trim(),
        details: { version: info.version ?? null, syncStatus: info.syncStatus ?? null, network: bitcoinNetwork(credentials, mode), webhookSecret: !!credentials.webhookSecret },
      };
    } catch (err) {
      return { ok: false, mode: keyModeOf(credentials), message: (err as Error).message };
    }
  },
  async initiate(ctx: InitiateContext): Promise<InitiateResult> {
    const mode = bitcoinMode(ctx.credentials);
    const invoice =
      mode === 'sandbox' ? sandboxInvoice({ key: ctx.idempotencyKey, amountMinor: ctx.amountMinor, currency: ctx.currency, credentials: ctx.credentials }) : await btcpayInvoice(ctx, ctx.credentials);
    return {
      providerRef: invoice.invoiceId,
      status: 'pending',
      next: {
        type: 'bitcoin_invoice',
        url: invoice.checkoutUrl ?? undefined,
        message: `Pay ${invoice.amountBtc} BTC (${invoice.amountSats} sats) with Lightning or on-chain before ${invoice.expiresAt}. ${invoice.rate.label}.${invoice.sandbox ? ' Sandbox: no real bitcoin moves; pay the invoice through the simulator.' : ''}`,
        instructions: invoiceInstructions(invoice),
        invoice,
      },
      raw: { mode, invoiceId: invoice.invoiceId },
    };
  },
  async verify(payment: GatewayPaymentRow, credentials): Promise<VerifyResult> {
    if (payment.status === 'succeeded') return { status: 'succeeded' };
    if (payment.status === 'failed' || payment.status === 'cancelled') return { status: 'failed' };
    const invoice = invoiceOf(payment);
    if (bitcoinMode(credentials) === 'sandbox') {
      const state = sandboxState(payment);
      if (state.paidAt) return { status: 'succeeded', raw: { sandbox: true, paidAt: state.paidAt } };
      if (state.invalidatedAt) return { status: 'failed', failureReason: 'Invoice marked invalid in the sandbox', raw: { sandbox: true } };
      if (invoice && invoice.expiresAt < now()) return { status: 'failed', failureReason: 'Invoice expired before payment', raw: { sandbox: true, expiresAt: invoice.expiresAt } };
      return { status: 'pending', raw: { sandbox: true } };
    }
    if (!payment.provider_ref) return { status: 'pending' };
    const { storeId } = requireBtcpay(credentials);
    const inv = await greenfield<GreenfieldInvoice>(credentials, `/api/v1/stores/${encodeURIComponent(storeId)}/invoices/${encodeURIComponent(payment.provider_ref)}`);
    return { ...mapInvoiceStatus(inv.status, inv.additionalStatus), raw: { id: inv.id, status: inv.status, additionalStatus: inv.additionalStatus ?? null } };
  },
  async parseWebhook(req: Request, credentials): Promise<WebhookEvent[]> {
    const secret = credentials.webhookSecret;
    if (!secret) throw new Error('Bitcoin webhooks need the BTCPay webhook secret to be configured');
    const raw = (req as any).rawBody as Buffer | undefined;
    const header = req.headers[BTCPAY_SIGNATURE_HEADER];
    if (!raw || !verifyBtcpaySignature(secret, raw, Array.isArray(header) ? header[0] : header)) throw new Error('Invalid BTCPay signature');
    const event = req.body ?? {};
    const type = String(event.type ?? '');
    if (!(type in WEBHOOK_TYPES)) return [];
    const status = WEBHOOK_TYPES[type];
    if (!status || !event.invoiceId) return [];
    let outcome: WebhookEvent['status'] = status;
    // An expired invoice that received money (partial / late) is not simply failed: the outcome is unknown until a human looks.
    if (type === 'InvoiceExpired' && event.partiallyPaid === true) outcome = 'unknown';
    if (type === 'InvoiceInvalid' && event.manuallyMarked === false && event.partiallyPaid === true) outcome = 'unknown';
    return [{ providerRef: String(event.invoiceId), status: outcome, reason: type, raw: event }];
  },
  async refund(payment: GatewayPaymentRow, amountMinor: number): Promise<RefundResult> {
    return {
      status: 'manual',
      providerRef: payment.provider_ref,
      message: `Bitcoin payments are not refunded automatically: send ${amountMinor} ${payment.currency} worth of BTC back to an address the payer provides (or a Lightning invoice they issue) and record the refund.`,
    };
  },
  async cancel(payment: GatewayPaymentRow, credentials): Promise<CancelResult> {
    if (payment.status === 'succeeded' || payment.status === 'failed') return { status: 'not_cancellable', providerRef: payment.provider_ref, message: `Payment is already ${payment.status}` };
    if (payment.status === 'cancelled') return { status: 'cancelled', providerRef: payment.provider_ref, message: 'Already cancelled' };
    if (bitcoinMode(credentials) === 'sandbox') return { status: 'cancelled', providerRef: payment.provider_ref, message: `Sandbox invoice ${payment.provider_ref ?? payment.id} archived` };
    if (!payment.provider_ref) return { status: 'cancelled', providerRef: null, message: 'No invoice was issued' };
    const { storeId } = requireBtcpay(credentials);
    await greenfield(credentials, `/api/v1/stores/${encodeURIComponent(storeId)}/invoices/${encodeURIComponent(payment.provider_ref)}`, { method: 'DELETE' });
    return { status: 'cancelled', providerRef: payment.provider_ref, message: `BTCPay invoice ${payment.provider_ref} archived` };
  },
};

/** Declared funding leg for the rail catalogue (what independent evidence settles a Bitcoin payment). */
export function bitcoinFundingDeclaration(credentials: Record<string, string>) {
  const mode = bitcoinMode(credentials);
  const confirmations = bitcoinConfirmations(credentials);
  return {
    kind: 'bitcoin',
    initiation: mode === 'sandbox' ? 'Sandbox Lightning / on-chain invoice (test only)' : 'BTCPay Server issues a Lightning (BOLT11) invoice and an on-chain address for the same amount',
    confirmation:
      mode === 'sandbox'
        ? 'Sandbox simulator marks the invoice paid'
        : `Signed BTCPay webhook (BTCPay-Sig) or status query; Lightning settles on payment, on-chain after ${confirmations} confirmation${confirmations === 1 ? '' : 's'}`,
    settlement: 'Merchant settles in fiat at the disclosed rate (default) or keeps a BTC balance (merchant policy); ledger credited on confirmation',
    expectedCompletion: 'Seconds (Lightning) · ~10 minutes per confirmation (on-chain)',
    processing: 'automatic' as const,
    refundMethod: 'Manual: BTC returned to an address / invoice the payer provides, recorded by operations',
    feeType: 'merchant_payment',
    regulatedRail: true,
    carrier: mode === 'sandbox' ? 'bitcoin_sandbox' : 'btcpay',
    confirmationMethod: 'PROCESSOR_WEBHOOK' as const,
  };
}
