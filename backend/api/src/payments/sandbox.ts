import { detectCardBrand, luhnCheck, isExpiryValid } from '@bitripay/shared';
import { shortCode } from '../lib/ids';
import { sha256 } from '../lib/crypto';
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
  StatementLine,
  CancelResult,
} from './types';

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
export const SANDBOX_MAGIC_MSISDNS: { msisdn: string; outcome: string; behaviour: string }[] = [
  { msisdn: '+243000000501', outcome: 'succeed', behaviour: 'Customer approves → captured, settled to the test balance, payment_intent.succeeded webhook' },
  { msisdn: '+243000000404', outcome: 'fail', behaviour: 'Wallet not found → attempt fails (invalid_msisdn), intent returns to REQUIRES_PAYMENT_METHOD' },
  { msisdn: '+243000000408', outcome: 'ambiguous', behaviour: 'Provider outcome unknown → payment parked in MANUAL_REVIEW, intent AMBIGUOUS, payment_intent.ambiguous_hold webhook' },
  { msisdn: '+243000000500', outcome: 'timeout_then_succeed', behaviour: 'Timeout then success → pending for 6 seconds, then succeeds and settles' },
  { msisdn: '+243000000503', outcome: 'provider_unavailable', behaviour: 'Provider unavailable → retryable failure (provider_unavailable)' },
  { msisdn: 'any number ending in 0000', outcome: 'declined', behaviour: 'Customer rejects the prompt → declined' },
];
const MAGIC_DELAY_MS = 6000;
/** Indicative sandbox pricing per method (basis points) and time to a final status. */
export const SANDBOX_FEE_BPS: Record<string, number> = { card: 290, mobile_money: 150, bank: 50, wallet: 0, virtual_card: 290 };
export const SANDBOX_ETA_SECONDS: Record<string, number> = { card: 0, mobile_money: 3, bank: 86_400, wallet: 0, virtual_card: 0 };
export const SANDBOX_CAPABILITIES: ConnectorCapabilities = { minMinor: 100, maxMinor: 100_000_000, refunds: true, settlementT: 0, webhooks: true, lastIncidentAt: null };

/** Provider reference: deterministic for a given idempotency key (a retried initiate returns the same reference), random otherwise. */
const providerRefFor = (key: string | undefined) => (key ? `sbx_${sha256(`sandbox:${key}`).slice(0, 16)}` : `sbx_${shortCode(12)}`);

const toInt = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
};
/** Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}
/**
 * Statement lines from a JSON array (`[{reference, amountMinor, status, feeMinor, currency?, settlementRef?, occurredAt?}]`)
 * or the CSV the admin statement import accepts (header row with reference, amountMinor, status, feeMinor and
 * optionally currency, settlementRef, occurredAt; column order is free, names are matched case-insensitively).
 */
export function parseSandboxStatement(csvOrJson: string): StatementLine[] {
  const text = csvOrJson.replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  const normalise = (r: Record<string, unknown>): StatementLine | null => {
    const get = (k: string) => {
      const key = Object.keys(r).find((x) => x.replace(/[\s_-]/g, '').toLowerCase() === k.toLowerCase());
      return key ? r[key] : undefined;
    };
    const reference = String(get('reference') ?? get('ref') ?? get('providerRef') ?? '').trim();
    const amountMinor = toInt(get('amountMinor') ?? get('amount'));
    if (!reference || amountMinor == null) return null;
    const currency = get('currency');
    const fee = toInt(get('feeMinor') ?? get('fee'));
    const settlementRef = get('settlementRef');
    const occurredAt = get('occurredAt') ?? get('date');
    return {
      reference,
      amountMinor,
      currency: currency ? String(currency).toUpperCase() : null,
      status: String(get('status') ?? 'succeeded')
        .trim()
        .toLowerCase(),
      feeMinor: fee,
      settlementRef: settlementRef ? String(settlementRef) : null,
      occurredAt: occurredAt ? String(occurredAt) : null,
    };
  };
  if (text.startsWith('[') || text.startsWith('{')) {
    const parsed = JSON.parse(text);
    const arr: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.lines) ? parsed.lines : [parsed];
    return arr
      .filter((x) => x && typeof x === 'object')
      .map((x) => normalise(x as Record<string, unknown>))
      .filter((x): x is StatementLine => !!x);
  }
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  return rows
    .slice(1)
    .map((cells) => normalise(Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']))))
    .filter((x): x is StatementLine => !!x);
}

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
  capabilities(): ConnectorCapabilities {
    return { ...SANDBOX_CAPABILITIES };
  },
  async quote(ctx: QuoteContext): Promise<QuoteResult> {
    const feeBps = SANDBOX_FEE_BPS[ctx.method] ?? 100;
    const target = (ctx.targetCurrency ?? ctx.currency).toUpperCase();
    const same = target === ctx.currency.toUpperCase();
    return {
      feeMinor: Math.round((ctx.amountMinor * feeBps) / 10_000),
      feeBps,
      currency: ctx.currency.toUpperCase(),
      targetCurrency: target,
      fxRate: same ? 1 : (ctx.fxRate ?? null),
      etaSeconds: SANDBOX_ETA_SECONDS[ctx.method] ?? 0,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  },
  parseStatement(csvOrJson: string): StatementLine[] {
    return parseSandboxStatement(csvOrJson);
  },
  async cancel(payment: GatewayPaymentRow): Promise<CancelResult> {
    if (payment.status === 'succeeded' || payment.status === 'failed') return { status: 'not_cancellable', providerRef: payment.provider_ref, message: `Payment is already ${payment.status}` };
    if (payment.status === 'cancelled') return { status: 'cancelled', providerRef: payment.provider_ref, message: 'Already cancelled' };
    return { status: 'cancelled', providerRef: payment.provider_ref, message: `Sandbox voided ${payment.provider_ref ?? payment.id}` };
  },
  async initiate(ctx: InitiateContext): Promise<InitiateResult> {
    const providerRef = providerRefFor(ctx.idempotencyKey);
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
