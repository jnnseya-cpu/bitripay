/**
 * Any → any money routing (the "route" / transfer). The wallet is the hub: a funding leg brings money
 * in (card via a licensed processor, bank, mobile money, wallet) and a payout leg sends it on (wallet
 * user / QR, bank, mobile money, agent cash). External legs never move value through BitriPay
 * itself: cards go through the processor, and payouts are executed from prefunded local accounts by
 * approved devices / agents and confirmed by signed operator evidence.
 *
 * Lifecycle (see routeLifecycle.ts):
 *   CREATED → QUOTED → BIOMETRIC_APPROVAL_REQUIRED → FUNDING_PENDING → FUNDED
 *   → PAYOUT_ROUTED → PAYOUT_SENT → EVIDENCE_RECEIVED → VERIFYING → SETTLED
 */
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { parseJson } from '../lib/json';
import { decodeQr, formatMoney, COUNTRY_BY_CODE } from '@bitripay/shared';
import { getCurrency, fromBase, toBase } from './currencies';
import { getFees, getComplianceSettings, getFxSettings } from './settings';
import { calculateFee } from './ledger';
import { getUserById, findUserByIdentifier, findUserByTag, toPublicUser, type UserRow } from './users';
import { getUserWallet, ensureWallet } from './wallets';
import { sendMoney, exchange } from './transfers';
import { requestWithdrawal } from './withdrawals';
import { payWithWallet, getPaymentRequestByCode } from './paymentRequests';
import { createCashOutRequest } from './agents';
import { initiatePayment, verifyPayment, refundPayment, getPayment, toPaymentView, type InitiatePaymentInput, type PaymentAuth, type PaymentView } from './payments';
import { notify } from './notifications';
import { getOperator } from './momo';
import { fxDisclosure, type FxDisclosure } from './fx';
import { describeRoute, type RouteDeclaration } from './railCatalog';
import { recordEvent, listEvents, type Actor } from './events';
import { ROUTE_STAGE_LABELS, ROUTE_REFUNDABLE, ROUTE_TERMINAL, transitionRoute, tryTransitionRoute, type RouteStage } from './routeLifecycle';
import { findCorridor, ensureCorridor, assertCorridorAllowed, type Corridor } from './corridors';
import { listPayoutAccounts } from './liquidity';
import { listCurrencies } from './currencies';
import { config } from '../config';
import { randomBytes } from 'node:crypto';
import { availableGateways, getGateway } from '../payments';
import { assessRisk } from './risk';
import { getPayout, cancelPayout, requeuePayout, type PayoutView } from './payouts';

export type RouteDestination =
  | { method: 'wallet'; to: string; note?: string | null }
  | { method: 'qr'; data: string; note?: string | null }
  | { method: 'bank'; bankAccountId?: string | null; bankName?: string | null; accountName?: string | null; accountNumber?: string | null; country?: string | null; currency?: string | null }
  | { method: 'mobile_money'; operatorId: string; phone: string; name?: string | null }
  | { method: 'agent'; agent: string }
  | { method: 'keep' };

export interface RouteSource {
  method: 'wallet' | 'card' | 'bank' | 'mobile_money';
  gateway?: string | null;
  operatorId?: string | null;
  phone?: string | null;
  card?: InitiatePaymentInput['card'];
  savedCardId?: string | null;
  saveCard?: boolean;
  returnUrl?: string | null;
}

export interface RouteView {
  id: string;
  source: RouteSource['method'];
  sourceDetails: Record<string, unknown>;
  destination: RouteDestination['method'];
  destinationDetails: Record<string, unknown>;
  amount: number;
  currency: string;
  targetCurrency: string;
  status: string;
  stage: RouteStage;
  stageLabel: string;
  stageGroup: string;
  stageDescription: string;
  quote: RouteQuote | null;
  corridor: { id: string; status: string; destCountry: string; operatorId: string | null; estimatedPayoutMinutes: number } | null;
  paymentId: string | null;
  fundingTransactionId: string | null;
  payoutTransactionId: string | null;
  payout: PayoutView | null;
  note: string | null;
  error: string | null;
  expiresAt: string | null;
  payment?: PaymentView | null;
  /** Confirmation method that actually settled the external leg (declared methods are in the quote). */
  confirmationMethod: string | null;
  consent: { required: boolean; confirmedAt: string | null; url: string | null } | null;
  currencyOptions: PayoutCurrencyOptions | null;
  createdAt: string;
  updatedAt: string;
}

function toView(r: any): RouteView {
  const label = ROUTE_STAGE_LABELS[(r.stage ?? 'CREATED') as RouteStage];
  let corridor: RouteView['corridor'] = null;
  if (r.corridor_id) {
    const c = getDb().prepare('SELECT * FROM corridors WHERE id = ?').get(r.corridor_id) as any;
    if (c) corridor = { id: c.id, status: c.status, destCountry: c.dest_country, operatorId: c.operator_id, estimatedPayoutMinutes: c.estimated_payout_minutes };
  }
  return {
    id: r.id,
    source: r.source_method,
    sourceDetails: parseJson(r.source_details, {}),
    destination: r.destination_method,
    destinationDetails: parseJson(r.destination_details, {}),
    amount: r.amount,
    currency: r.currency,
    targetCurrency: r.target_currency,
    status: r.status,
    stage: r.stage ?? 'CREATED',
    stageLabel: label.label,
    stageGroup: label.group,
    stageDescription: label.description,
    quote: parseJson<RouteQuote | null>(r.quote, null),
    corridor,
    paymentId: r.payment_id,
    fundingTransactionId: r.funding_transaction_id,
    payoutTransactionId: r.payout_transaction_id,
    payout: r.payout_id ? (() => { try { return getPayout(r.payout_id, false); } catch { return null; } })() : null,
    note: r.note,
    error: r.error,
    expiresAt: r.expires_at,
    payment: r.payment_id ? (() => { try { return toPaymentView(getPayment(r.payment_id)); } catch { return null; } })() : null,
    confirmationMethod: r.confirmation_method ?? null,
    consent: r.consent_token ? { required: true, confirmedAt: r.consent_confirmed_at ?? null, url: `${config.webUrl}/confirm-currency/${r.consent_token}` } : null,
    currencyOptions: parseJson<PayoutCurrencyOptions | null>(r.currency_options, null),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function setRoute(id: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  getDb().prepare(`UPDATE money_routes SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), now(), id);
}
export function getRouteRow(id: string): any {
  const r = getDb().prepare('SELECT * FROM money_routes WHERE id = ?').get(id);
  if (!r) throw notFound('Route not found', 'route_not_found');
  return r;
}

/** Describe a destination for previews (resolves users/QR codes/operators without moving money). */
export function previewDestination(dest: RouteDestination) {
  switch (dest.method) {
    case 'wallet': {
      const u = findUserByIdentifier(dest.to);
      if (!u || u.is_system) throw notFound('Recipient not found', 'recipient_not_found');
      return { label: `${u.business_name || u.full_name} (@${u.tag})`, user: toPublicUser(u), instant: true };
    }
    case 'qr': {
      const payload = decodeQr(dest.data);
      if (!payload) throw badRequest('Not a BitriPay QR code', 'invalid_qr');
      if (payload.type === 'pr') {
        const pr = getPaymentRequestByCode(payload.id);
        const u = getUserById(pr.requester_user_id);
        return { label: `Payment request ${pr.code} · ${u.business_name || u.full_name}`, user: toPublicUser(u), amount: pr.amount, currency: pr.currency, instant: true };
      }
      const u = findUserByTag(payload.id);
      if (!u) throw notFound('User not found', 'user_not_found');
      return { label: `${u.business_name || u.full_name} (@${u.tag})`, user: toPublicUser(u), amount: payload.amount ? Number(payload.amount) : null, currency: payload.currency ?? null, instant: true };
    }
    case 'mobile_money': {
      const op = getOperator(dest.operatorId);
      return { label: `${op.name} · ${dest.phone}`, operator: op, instant: false };
    }
    case 'bank':
      return { label: dest.bankName ? `${dest.bankName} · ${dest.accountNumber}` : 'Saved bank account', instant: false };
    case 'agent': {
      const a = findUserByIdentifier(dest.agent);
      if (!a || a.role !== 'agent') throw notFound('Agent not found', 'agent_not_found');
      return { label: `Cash at ${a.business_name || a.full_name}`, user: toPublicUser(a), instant: false };
    }
    default:
      return { label: 'Keep in wallet', instant: true };
  }
}

/** Largest X such that X + fee(X) <= available (fees charged on top of the sender). */
export function maxSendable(type: string, available: number, currency: string): number {
  const cfg = getFees()[type];
  if (!cfg) return available;
  const fixed = cfg.fixed ? fromBase(cfg.fixed, currency) : 0;
  let x = Math.floor(((available - fixed) * 10000) / (10000 + cfg.bps));
  while (x > 0 && x + calculateFee(type, x, currency) > available) x -= 1;
  return Math.max(0, x);
}

function payoutFeeType(dest: RouteDestination, targetUser?: UserRow | null): string | null {
  switch (dest.method) {
    case 'wallet':
    case 'qr':
      return targetUser?.role === 'merchant' ? null : 'transfer';
    case 'bank':
    case 'mobile_money':
      return 'withdrawal';
    case 'agent':
      return 'agent_cash_out';
    default:
      return null;
  }
}

function destCorridor(dest: RouteDestination | undefined, sourceCurrency: string, targetCurrency: string, create = false): Corridor | null {
  if (!dest) return null;
  if (dest.method === 'mobile_money') {
    const op = getOperator(dest.operatorId);
    const q = { sourceCurrency, destCountry: op.country, destCurrency: targetCurrency, operatorId: op.id, rail: 'mobile_money' as const };
    return create ? ensureCorridor(q) : findCorridor(q);
  }
  if (dest.method === 'bank') {
    const country = dest.country ?? (dest.bankAccountId ? ((getDb().prepare('SELECT country FROM bank_accounts WHERE id = ?').get(dest.bankAccountId) as any)?.country ?? null) : null);
    if (!country) return null;
    const q = { sourceCurrency, destCountry: country, destCurrency: targetCurrency, rail: 'bank' as const };
    return create ? ensureCorridor(q) : findCorridor(q);
  }
  return null;
}

/**
 * Execute the payout leg from the user's wallet. `amount` is in `currency` (the wallet that was funded);
 * `targetCurrency` triggers an exchange first when different.
 */
export function executeDestination(user: UserRow, dest: RouteDestination, amount: number, currency: string, targetCurrency: string, note?: string | null, quoteId?: string | null, routeId?: string | null): { transactionId: string | null; status: string; extra?: Record<string, unknown> } {
  let payCurrency = currency;
  let payAmount = amount;
  if (targetCurrency !== currency) {
    const ex = exchange(user, currency, targetCurrency, maxSendable('exchange', amount, currency), { quoteId });
    payCurrency = targetCurrency;
    payAmount = ex.received;
  }
  const targetUser = dest.method === 'wallet' ? findUserByIdentifier(dest.to) : dest.method === 'qr' ? (() => { const p = decodeQr(dest.data); return p?.type === 'pr' ? getUserById(getPaymentRequestByCode(p.id).requester_user_id) : p ? findUserByTag(p.id) : null; })() : null;
  const feeType = payoutFeeType(dest, targetUser);
  if (feeType) payAmount = maxSendable(feeType, payAmount, payCurrency);
  if (payAmount <= 0) throw unprocessable('Amount is too small to cover the fees', 'amount_too_small');
  switch (dest.method) {
    case 'keep':
      return { transactionId: null, status: 'completed' };
    case 'wallet': {
      const tx = sendMoney(user, { to: dest.to, amount: payAmount, currency: payCurrency, note: note ?? dest.note ?? null });
      return { transactionId: tx.id, status: 'completed' };
    }
    case 'qr': {
      const payload = decodeQr(dest.data)!;
      if (payload.type === 'pr') {
        const pr = getPaymentRequestByCode(payload.id);
        const r = payWithWallet(user, pr.code, pr.amount ?? payAmount, note ?? dest.note ?? null);
        return { transactionId: r.tx.id, status: 'completed' };
      }
      const tx = sendMoney(user, { to: payload.id, amount: payAmount, currency: payCurrency, note: note ?? payload.note ?? null });
      return { transactionId: tx.id, status: 'completed' };
    }
    case 'bank': {
      const tx = requestWithdrawal(user, { amount: payAmount, currency: payCurrency, destination: dest.bankAccountId ? { method: 'bank', bankAccountId: dest.bankAccountId } : { method: 'bank', bankName: dest.bankName ?? '', accountName: dest.accountName ?? '', accountNumber: dest.accountNumber ?? '', country: dest.country ?? null }, note, routeId, sourceCurrency: currency });
      return { transactionId: tx.id, status: 'pending' };
    }
    case 'mobile_money': {
      const tx = requestWithdrawal(user, { amount: payAmount, currency: payCurrency, destination: { method: 'mobile_money', operatorId: dest.operatorId, phone: dest.phone, name: dest.name ?? null }, note, routeId, sourceCurrency: currency });
      return { transactionId: tx.id, status: 'pending' };
    }
    case 'agent': {
      const req = createCashOutRequest(user, { agent: dest.agent, amount: payAmount, currency: payCurrency });
      return { transactionId: null, status: 'pending', extra: { cashOutCode: req.code, expiresAt: req.expiresAt } };
    }
  }
}

export interface RouteQuote {
  amount: number;
  currency: string;
  /** Exact amount the sender pays (funding amount, funding fee included). */
  senderAmount: number;
  /** Estimated amount the recipient receives, in the destination currency. */
  recipientAmount: number;
  fundingFee: number;
  /** Card / processor fee (same as fundingFee for card funding). */
  cardFee: number;
  exchangeFee: number;
  payoutFee: number;
  /** Platform fees excluding the card fee. */
  platformFee: number;
  rate: number;
  targetAmount: number;
  targetCurrency: string;
  fx: FxDisclosure | null;
  declaration: RouteDeclaration;
  estimatedPayoutTime: string;
  quoteExpiresAt: string;
  refundConditions: string;
  corridor: { id: string; status: string; destCountry: string; operatorId: string | null; estimatedPayoutMinutes: number } | null;
  sourceOfFundsRequired: boolean;
  /** FX margin applied on top of the reference rate, in basis points. */
  fxMarginBps: number;
  /** The recipient amount is guaranteed only when the rate is live, fresh and locked for the quote TTL (or no conversion is needed). */
  guaranteedRecipientAmount: number | null;
  /** Default and optional receiving currencies with real-time availability (corridor rules, licence coverage, liquidity). */
  receivingCurrencies: PayoutCurrencyOptions | null;
  estimatedDeliveryMinutes: number | null;
  payoutConditions: string;
  /** Declared confirmation method of each external leg. */
  confirmation: { funding: string; payout: string };
  /** The beneficiary must confirm the payout currency before the payout executes (regulated corridor, non-local currency). */
  recipientConsentRequired: boolean;
}

export interface PayoutCurrencyOption {
  currency: string;
  available: boolean;
  isLocal: boolean;
  /** Why the currency cannot be chosen right now. */
  reasons: string[];
  /** Non-blocking notes (e.g. the local currency will wait for liquidity rather than be refused). */
  warnings: string[];
  consentRequired: boolean;
  liquidityAvailable: number | null;
}
export interface PayoutCurrencyOptions {
  defaultCurrency: string;
  localCurrency: string | null;
  options: PayoutCurrencyOption[];
}

/** Country the destination pays into and its local currency. */
function destinationCountry(dest: RouteDestination | undefined): { country: string | null; localCurrency: string | null; operatorId: string | null } {
  if (!dest) return { country: null, localCurrency: null, operatorId: null };
  if (dest.method === 'mobile_money') {
    try {
      const op = getOperator(dest.operatorId);
      return { country: op.country, localCurrency: op.currency, operatorId: op.id };
    } catch {
      return { country: null, localCurrency: null, operatorId: null };
    }
  }
  if (dest.method === 'bank') {
    const country = dest.country ?? (dest.bankAccountId ? ((getDb().prepare('SELECT country FROM bank_accounts WHERE id = ?').get(dest.bankAccountId) as any)?.country ?? null) : null);
    return { country, localCurrency: country ? COUNTRY_BY_CODE[country.toUpperCase()]?.currency ?? null : null, operatorId: null };
  }
  return { country: null, localCurrency: null, operatorId: null };
}

/** The destination country's local currency is the default payout currency for external destinations; otherwise the source currency. */
export function defaultTargetCurrency(dest: RouteDestination | undefined, sourceCurrency: string): string {
  const { localCurrency } = destinationCountry(dest);
  if (!localCurrency) return sourceCurrency;
  try {
    return getCurrency(localCurrency).code;
  } catch {
    return sourceCurrency;
  }
}

/**
 * Recipient-controlled payout currency. A currency is offered only when, right now: the corridor permits it, the
 * destination institution / agent can pay it, prefunded liquidity exists, the recipient account supports it and FX /
 * capital-control rules allow it. The destination country's local currency is always the default.
 */
export function payoutCurrencyOptions(dest: RouteDestination | undefined, sourceCurrency: string, amount: number, ctx: { requested?: string | null } = {}): PayoutCurrencyOptions | null {
  if (!dest || !['mobile_money', 'bank', 'wallet'].includes(dest.method)) return null;
  const compliance = getComplianceSettings();
  const enabled = new Set(listCurrencies(true).map((c) => c.code));
  const { country, localCurrency, operatorId } = destinationCountry(dest);
  if (dest.method === 'wallet') {
    const target = findUserByIdentifier(dest.to);
    const local = target?.country ? COUNTRY_BY_CODE[target.country]?.currency ?? null : null;
    const held = target ? (getDb().prepare('SELECT currency FROM wallets WHERE user_id = ?').all(target.id) as { currency: string }[]).map((w) => w.currency) : [];
    const candidates = [...new Set([sourceCurrency, ...(local ? [local] : []), ...held, ...(ctx.requested ? [ctx.requested] : [])])].filter((c) => enabled.has(c));
    return { defaultCurrency: held.includes(sourceCurrency) || !local ? sourceCurrency : local, localCurrency: local, options: candidates.map((c) => ({ currency: c, available: true, isLocal: c === local, reasons: [], warnings: [], consentRequired: false, liquidityAvailable: null })) };
  }
  if (!country || !localCurrency) return null;
  const rail = dest.method === 'mobile_money' ? 'mobile_money' : 'bank';
  const local = findCorridor({ sourceCurrency, destCountry: country, destCurrency: localCurrency, operatorId, rail });
  const listed = local?.payoutCurrencies ?? [];
  const candidates = [...new Set([localCurrency, ...listed, ...(ctx.requested ? [ctx.requested.toUpperCase()] : [])])];
  const accounts = listPayoutAccounts({ rail, status: 'active' }).filter((a) => !operatorId || a.operatorId === operatorId);
  const options: PayoutCurrencyOption[] = candidates.map((cur) => {
    const reasons: string[] = [];
    const warnings: string[] = [];
    const isLocal = cur === localCurrency;
    if (!enabled.has(cur)) reasons.push('Currency is not enabled on the platform');
    const corridor = isLocal ? local : findCorridor({ sourceCurrency, destCountry: country, destCurrency: cur, operatorId, rail }) ?? (listed.includes(cur) ? local : null);
    // The local currency is always the default: a missing corridor is registered (sandbox) on first use and missing liquidity
    // parks the transfer in INSUFFICIENT_LIQUIDITY with the funds safely held. Optional currencies must be fully available now.
    if (!corridor && !isLocal) reasons.push(`No corridor permits ${cur} payouts to ${country}${operatorId ? ` via ${operatorId}` : ''}`);
    else if (corridor && (corridor.status === 'suspended' || !corridor.enabled)) reasons.push('Corridor is suspended');
    if (!isLocal) {
      if (dest.method === 'mobile_money') {
        const op = getOperator(dest.operatorId);
        if (op.currency !== cur && !listed.includes(cur)) reasons.push(`${op.name} wallets in ${country} cannot legally be paid in ${cur}`);
      }
      if (dest.method === 'bank' && dest.currency && dest.currency.toUpperCase() !== cur) reasons.push(`The recipient bank account is a ${dest.currency.toUpperCase()} account`);
      if (compliance.mode === 'live' && !corridor?.compliance?.fxApprovalRef) reasons.push(`No FX / capital-control approval recorded for ${cur} payouts in ${country}`);
    }
    let liquidity: number | null = null;
    let needed = amount;
    try {
      if (cur !== sourceCurrency) {
        const fx = fxDisclosure(sourceCurrency, cur, null, false);
        needed = Math.round((amount / 10 ** getCurrency(sourceCurrency, false).decimals) * fx.rate * 10 ** getCurrency(cur, false).decimals);
      }
    } catch {
      reasons.push(`No exchange rate available for ${cur}`);
    }
    const usable = accounts.filter((a) => a.currency === cur && (!a.perTxLimit || a.perTxLimit >= needed));
    liquidity = usable.reduce((sum, a) => sum + a.balance, 0);
    if (!usable.some((a) => a.balance >= needed)) (isLocal ? warnings : reasons).push(liquidity > 0 ? `Prefunded ${cur} liquidity is insufficient for this amount right now${isLocal ? '; the transfer will wait for liquidity' : ''}` : `No prefunded ${cur} payout account for ${country}${operatorId ? ` (${operatorId})` : ''}${isLocal ? '; the transfer will wait for liquidity' : ''}`);
    return { currency: cur, available: reasons.length === 0, isLocal, reasons, warnings, consentRequired: !isLocal && !!(corridor?.beneficiaryConsent || local?.beneficiaryConsent), liquidityAvailable: liquidity };
  });
  return { defaultCurrency: localCurrency, localCurrency, options };
}

/** Quote how much arrives at the destination after funding fee, FX and payout fee, with the full disclosure. */
export function quoteRoute(amount: number, currency: string, targetCurrency: string, sourceMethod: RouteSource['method'] = 'wallet', dest?: RouteDestination, ctx: { userId?: string | null; country?: string | null; operatorId?: string | null; gateway?: string | null; persistQuote?: boolean } = {}): RouteQuote {
  const c = getCurrency(currency);
  const t = getCurrency(targetCurrency);
  const fundingFeeType = sourceMethod === 'card' ? 'card_deposit' : sourceMethod === 'mobile_money' ? 'mobile_money_deposit' : sourceMethod === 'bank' ? 'bank_deposit' : null;
  const fundingFee = fundingFeeType ? calculateFee(fundingFeeType, amount, c.code) : 0;
  let available = amount - fundingFee;
  let exchangeFee = 0;
  let rate = 1;
  let converted = available;
  let fx: FxDisclosure | null = null;
  if (c.code !== t.code) {
    const sendable = maxSendable('exchange', available, c.code);
    exchangeFee = available - sendable;
    fx = fxDisclosure(c.code, t.code, ctx.userId ?? null, ctx.persistQuote !== false);
    converted = Math.round((sendable / 10 ** c.decimals) * fx.rate * 10 ** t.decimals);
    rate = fx.rate;
  }
  let targetUser: UserRow | null = null;
  if (dest?.method === 'wallet') targetUser = findUserByIdentifier(dest.to) ?? null;
  const feeType = dest ? payoutFeeType(dest, targetUser) : null;
  const delivered = feeType ? maxSendable(feeType, converted, t.code) : converted;
  const destKind = dest?.method === 'wallet' && targetUser?.role === 'merchant' ? 'merchant' : dest?.method ?? 'keep';
  const corridor = destCorridor(dest, c.code, t.code, false);
  const declaration = describeRoute(sourceMethod, destKind as any, { currency: c.code, targetCurrency: t.code, country: ctx.country, operatorId: ctx.operatorId, destinationOperatorId: dest?.method === 'mobile_money' ? dest.operatorId : null, gateway: ctx.gateway, payoutConfirmation: corridor?.payoutConfirmation ?? null });
  const compliance = getComplianceSettings();
  const external = dest?.method === 'bank' || dest?.method === 'mobile_money';
  const ttl = getFxSettings().quoteTtlSeconds;
  const receiving = external ? payoutCurrencyOptions(dest, c.code, amount, { requested: t.code }) : null;
  const chosen = receiving?.options.find((o) => o.currency === t.code) ?? null;
  const guaranteed = c.code === t.code || (!!fx && fx.guaranteed);
  return {
    fxMarginBps: fx?.markupBps ?? 0,
    guaranteedRecipientAmount: guaranteed ? delivered : null,
    receivingCurrencies: receiving,
    estimatedDeliveryMinutes: corridor ? corridor.estimatedPayoutMinutes : external ? null : 0,
    payoutConditions: external
      ? `Paid out in ${t.code}${chosen && !chosen.isLocal ? ` (non-local currency${chosen.consentRequired ? '; the recipient must confirm this currency before payout' : ''})` : ''} from a prefunded local account once funding is confirmed and risk checks pass. Settlement only on a verified operator / bank confirmation (${declaration.payout.confirmationMethod}). Card-funded transfers may be held for chargeback review.`
      : 'Credited to the recipient\'s BitriPay balance instantly after approval.',
    confirmation: { funding: declaration.funding.confirmationMethod, payout: declaration.payout.confirmationMethod },
    recipientConsentRequired: !!chosen?.consentRequired,
    amount, currency: c.code, senderAmount: amount, recipientAmount: delivered, fundingFee, cardFee: sourceMethod === 'card' ? fundingFee : 0, exchangeFee, payoutFee: converted - delivered, platformFee: exchangeFee + (converted - delivered) + (sourceMethod === 'card' ? 0 : fundingFee), rate, targetAmount: delivered, targetCurrency: t.code, fx, declaration,
    estimatedPayoutTime: corridor ? `~${corridor.estimatedPayoutMinutes} min after funds are confirmed (business hours)` : declaration.expectedCompletion,
    quoteExpiresAt: fx?.expiresAt ?? new Date(Date.now() + ttl * 1000).toISOString(),
    refundConditions: external
      ? 'Refundable in full (minus non-refundable processor fees) at any time before the local payout is executed. Once the recipient has been paid by the operator, the transfer cannot be recalled; reversals then depend on the operator and may require manual processing.'
      : 'Internal wallet transfers settle instantly and are refundable only with the recipient\'s consent.',
    corridor: corridor ? { id: corridor.id, status: corridor.status, destCountry: corridor.destCountry, operatorId: corridor.operatorId, estimatedPayoutMinutes: corridor.estimatedPayoutMinutes } : null,
    sourceOfFundsRequired: toBase(amount, c.code) >= compliance.sourceOfFundsThreshold,
  };
}

/** Which processor would fund this route – used by the compliance gate before any money is taken. */
function predictedFundingProvider(source: RouteSource, currency: string, country?: string | null): string | null {
  if (source.method === 'wallet') return null;
  const candidates = availableGateways(source.method, currency, country ?? undefined);
  if (source.gateway) return getGateway(source.gateway)?.provider ?? null;
  if (source.method === 'mobile_money') {
    const op = source.operatorId ? getOperator(source.operatorId) : null;
    const api = op ? candidates.find((g) => g.provider !== 'manual_momo' && g.provider !== 'sandbox' && (g.countries.length === 0 || g.countries.includes(op.country)) && (g.currencies.length === 0 || g.currencies.includes(op.currency))) : candidates.find((g) => g.provider !== 'manual_momo');
    if (api) return api.provider;
    return op?.collectionNumber ? 'manual_momo' : candidates.find((g) => g.provider === 'sandbox')?.provider ?? 'manual_momo';
  }
  return candidates.find((g) => g.provider !== 'manual_momo')?.provider ?? null;
}

export async function createRoute(user: UserRow, input: { source: RouteSource; destination: RouteDestination; amount: number; currency: string; targetCurrency?: string | null; note?: string | null; quoteId?: string | null; sourceOfFunds?: string | null }, auth?: PaymentAuth): Promise<RouteView> {
  const cur = getCurrency(input.currency);
  previewDestination(input.destination); // validates
  const target = getCurrency(input.targetCurrency || defaultTargetCurrency(input.destination, cur.code));
  const quote = quoteRoute(input.amount, cur.code, target.code, input.source.method, input.destination, { userId: user.id, country: user.country, operatorId: input.source.operatorId, gateway: input.source.gateway, persistQuote: false });
  if (quote.sourceOfFundsRequired && !input.sourceOfFunds) throw badRequest('Please declare the source of funds for a transfer of this size', 'source_of_funds_required');
  const provider = predictedFundingProvider(input.source, cur.code, user.country);
  const existingCorridor = destCorridor(input.destination, cur.code, target.code, false);
  if (existingCorridor) assertCorridorAllowed(existingCorridor, provider);
  // A currency is offered only when corridor rules, licence coverage, the paying institution and liquidity allow it right now.
  if (quote.receivingCurrencies) {
    const opt = quote.receivingCurrencies.options.find((o) => o.currency === target.code);
    if (!opt || !opt.available) throw unprocessable(`${target.code} cannot be paid out for this destination right now: ${(opt?.reasons ?? ['not offered in this corridor']).join('; ')}`, 'payout_currency_unavailable', { options: quote.receivingCurrencies });
  }
  const corridor = existingCorridor ?? destCorridor(input.destination, cur.code, target.code, true);
  if (corridor?.maxAmount && toBase(input.amount, cur.code) > corridor.maxAmount) throw unprocessable('Amount exceeds the corridor limit', 'corridor_limit');
  assertCorridorAllowed(corridor, provider);
  const id = uuid();
  const actor: Actor = { type: 'user', id: user.id };
  getDb()
    .prepare('INSERT INTO money_routes (id, user_id, source_method, source_details, destination_method, destination_details, amount, currency, target_currency, status, stage, quote, corridor_id, expires_at, source_of_funds, note, created_at, updated_at, consent_token, currency_options) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, user.id, input.source.method, JSON.stringify({ operatorId: input.source.operatorId ?? null, phone: input.source.phone ?? null, gateway: input.source.gateway ?? null, quoteId: input.quoteId ?? null }), input.destination.method, JSON.stringify(input.destination), input.amount, cur.code, target.code, 'pending', 'CREATED', JSON.stringify({ ...quote, fx: quote.fx ? { ...quote.fx, quoteId: input.quoteId ?? quote.fx.quoteId } : null }), corridor?.id ?? null, quote.quoteExpiresAt, input.sourceOfFunds ?? null, input.note ?? null, now(), now(), quote.recipientConsentRequired ? randomBytes(24).toString('base64url') : null, quote.receivingCurrencies ? JSON.stringify(quote.receivingCurrencies) : null);
  recordEvent('route', id, 'route.created', actor, { source: input.source.method, destination: input.destination.method, amount: input.amount, currency: cur.code, targetCurrency: target.code, corridorId: corridor?.id ?? null });
  transitionRoute(id, 'QUOTED', actor, { recipientAmount: quote.recipientAmount, rate: quote.rate, quoteExpiresAt: quote.quoteExpiresAt, provider: quote.fx?.provider ?? null });

  if (input.source.method === 'wallet') {
    // Biometric / PIN approval already verified by the route handler; wallet funds are confirmed instantly.
    getUserWallet(user.id, cur.code);
    transitionRoute(id, 'FUNDED', actor, { funding: 'wallet' });
    dispatchPayout(getRouteRow(id), user, input.amount, actor);
    return getRoute(user.id, id);
  }

  // External funding leg first; the payout continues automatically in continueRouteAfterFunding.
  let payment: PaymentView;
  try {
    payment = await initiatePayment(user, { purpose: 'deposit', method: input.source.method, gateway: input.source.gateway, amount: input.amount, currency: cur.code, card: input.source.card, savedCardId: input.source.savedCardId, saveCard: input.source.saveCard, phone: input.source.phone, operatorId: input.source.operatorId, returnUrl: input.source.returnUrl, route: input.destination, routeId: id }, auth);
  } catch (err) {
    tryTransitionRoute(id, 'FAILED', actor, { reason: (err as Error).message });
    setRoute(id, { error: (err as Error).message });
    throw err;
  }
  const current = getRouteRow(id);
  if (!current.payment_id) setRoute(id, { payment_id: payment.id });
  if (current.stage === 'QUOTED') {
    if (payment.status === 'failed') {
      transitionRoute(id, 'FAILED', actor, { reason: payment.failureReason });
      setRoute(id, { error: payment.failureReason });
    } else if (payment.stage === 'AUTHENTICATION_REQUIRED') transitionRoute(id, 'BIOMETRIC_APPROVAL_REQUIRED', actor, { paymentId: payment.id });
    else transitionRoute(id, 'FUNDING_PENDING', actor, { paymentId: payment.id, gateway: payment.gateway });
  }
  return getRoute(user.id, id);
}

/** Chargeback exposure: a card authorisation alone must not trigger an irreversible payout. */
function payoutHold(row: any, user: UserRow, amount: number): { hold: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const external = ['bank', 'mobile_money', 'agent'].includes(row.destination_method);
  if (!external) return { hold: false, reasons };
  const c = getComplianceSettings();
  if (row.source_method === 'card') {
    if (c.cardReviewAmount && toBase(amount, row.currency) >= c.cardReviewAmount) reasons.push('card_funded_amount_review');
    if (c.cardPayoutHoldMinutes > 0 && Date.now() - new Date(row.created_at).getTime() < c.cardPayoutHoldMinutes * 60_000) reasons.push(`card_settlement_hold_${c.cardPayoutHoldMinutes}m`);
    if (user.kyc_status !== 'verified') reasons.push('card_funded_unverified_sender');
  }
  const dest = parseJson<any>(row.destination_details, {});
  const risk = assessRisk({ userId: user.id, kind: 'route', amount, currency: row.currency, subjectType: 'route', subjectId: row.id, counterparty: { name: dest.name ?? dest.accountName ?? null, phone: dest.phone ?? null, country: dest.country ?? null } });
  if (risk.action !== 'allow') reasons.push(...risk.flags);
  return { hold: reasons.length > 0, reasons };
}

/** Funds are confirmed in the wallet: apply the chargeback / risk hold, then execute the payout leg. */
function dispatchPayout(row: any, user: UserRow, amount: number, actor: Actor, skipHold = false) {
  const dest = parseJson<RouteDestination>(row.destination_details, { method: 'keep' });
  const src = parseJson<{ quoteId?: string | null }>(row.source_details, {});
  if (!skipHold) {
    const hold = payoutHold(row, user, amount);
    if (hold.hold) {
      transitionRoute(row.id, 'MANUAL_REVIEW', { type: 'system' }, { reason: 'payout_hold', flags: hold.reasons, amount });
      setRoute(row.id, { error: `Held before payout: ${hold.reasons.join(', ')}`, destination_details: JSON.stringify({ ...dest, heldAmount: amount }) });
      notify(user.id, 'Transfer under review', 'Your funds are confirmed and held. A verifier will release the payout shortly.', { kind: 'route', routeId: row.id });
      return;
    }
  }
  // Regulated corridors: the beneficiary must confirm a non-local payout currency before anything is executed.
  if (row.consent_token && !row.consent_confirmed_at) {
    transitionRoute(row.id, 'AWAITING_CONFIRMATION', { type: 'system' }, { reason: 'recipient_currency_consent', targetCurrency: row.target_currency, amount });
    setRoute(row.id, { destination_details: JSON.stringify({ ...dest, heldAmount: amount }) });
    const recipient = dest.method === 'wallet' ? findUserByIdentifier((dest as any).to) : null;
    if (recipient) notify(recipient.id, 'Confirm your payout currency', `${toPublicUser(user).fullName} is sending you money in ${row.target_currency}. Confirm the currency to receive it.`, { kind: 'route_consent', routeId: row.id, token: row.consent_token, loud: true });
    notify(user.id, 'Recipient confirmation needed', `The recipient must confirm receiving ${row.target_currency} before the payout is executed. Share the confirmation link from the transfer details.`, { kind: 'route', routeId: row.id });
    return;
  }
  try {
    const quote = parseJson<RouteQuote | null>(row.quote, null);
    if (row.currency !== row.target_currency) transitionRoute(row.id, 'FX_RESERVED', actor, { rate: quote?.rate ?? null, quoteId: src.quoteId ?? quote?.fx?.quoteId ?? null, provider: quote?.fx?.provider ?? null, guaranteed: quote?.fx?.guaranteed ?? false, targetCurrency: row.target_currency });
    const r = executeDestination(user, dest, amount, row.currency, row.target_currency, row.note, src.quoteId ?? null, row.id);
    const fields: Record<string, unknown> = { payout_transaction_id: r.transactionId, error: null, destination_details: JSON.stringify({ ...dest, ...(r.extra ?? {}) }) };
    setRoute(row.id, fields);
    if (r.status === 'completed') transitionRoute(row.id, 'SETTLED', actor, { transactionId: r.transactionId, internal: true });
    else if (dest.method === 'agent') transitionRoute(row.id, 'PAYOUT_ROUTED', actor, { agent: true, cashOutCode: r.extra?.cashOutCode });
    // bank / mobile money: the payout instruction already moved the route to PAYOUT_ROUTED or INSUFFICIENT_LIQUIDITY
    const stage = getRouteRow(row.id).stage as RouteStage;
    notify(user.id, stage === 'SETTLED' ? 'Money delivered' : 'Money on its way', `${formatMoney(amount, getCurrency(row.currency, false))} ${stage === 'SETTLED' ? 'was delivered' : stage === 'INSUFFICIENT_LIQUIDITY' ? 'is held safely while local liquidity is arranged' : 'is queued for local payout'} to ${previewDestination(dest).label}.`, { kind: 'route', routeId: row.id });
  } catch (err) {
    // Funds stay safely in the user's wallet; the sender can retry or be refunded.
    tryTransitionRoute(row.id, 'FAILED', { type: 'system' }, { reason: (err as Error).message, fundsInWallet: true });
    setRoute(row.id, { error: (err as Error).message });
    notify(user.id, 'Payout needs attention', `Your money arrived in your wallet but the onward transfer failed: ${(err as Error).message}`, { kind: 'route', routeId: row.id });
  }
}

/** Called by settlePayment once a deposit that carries a route has credited the wallet. */
export function continueRouteAfterFunding(routeId: string, paymentId: string, fundingTxId: string, creditedAmount: number) {
  const row = getRouteRow(routeId);
  if (row.payout_transaction_id || ROUTE_TERMINAL.includes(row.stage) || !['CREATED', 'QUOTED', 'BIOMETRIC_APPROVAL_REQUIRED', 'FUNDING_PENDING'].includes(row.stage)) return;
  setRoute(routeId, { payment_id: paymentId, funding_transaction_id: fundingTxId });
  const actor: Actor = { type: 'processor', id: getPayment(paymentId).gateway };
  transitionRoute(routeId, 'FUNDED', actor, { paymentId, fundingTransactionId: fundingTxId, credited: creditedAmount });
  dispatchPayout(getRouteRow(routeId), getUserById(row.user_id), creditedAmount, actor);
}

/** Maker-checker release of a held (MANUAL_REVIEW) route: approve = execute the payout, reject = leave funds in the wallet, mark failed. */
export function releaseRoute(routeId: string, actor: Actor, verificationId: string, approve: boolean) {
  const row = getRouteRow(routeId);
  if (row.stage !== 'MANUAL_REVIEW') throw conflict(`Transfer is ${row.stage.toLowerCase()}`, 'invalid_stage_transition');
  const user = getUserById(row.user_id);
  const dest = parseJson<any>(row.destination_details, {});
  const amount = dest.heldAmount ?? row.amount;
  if (!approve) {
    transitionRoute(routeId, 'FAILED', actor, { verificationId, reason: 'release_rejected', fundsInWallet: true });
    setRoute(routeId, { error: 'Payout rejected after review; funds remain in your wallet' });
    return;
  }
  if (row.payout_id) {
    // A payout already existed (evidence / device issue): put it back on the queue.
    requeuePayout(row.payout_id, actor);
    return;
  }
  transitionRoute(routeId, 'FUNDED', actor, { verificationId, released: true });
  dispatchPayout(getRouteRow(routeId), user, amount, actor, true);
}

/** Retry the payout leg (after prefunding, a failed payout, or corrected recipient details). Funds are still in the wallet / escrow. */
export function retryRoute(user: UserRow, id: string, destination?: RouteDestination): RouteView {
  const row = getDb().prepare('SELECT * FROM money_routes WHERE id = ? AND user_id = ?').get(id, user.id) as any;
  if (!row) throw notFound('Route not found');
  if (row.stage === 'INSUFFICIENT_LIQUIDITY' && row.payout_id) {
    requeuePayout(row.payout_id, { type: 'user', id: user.id });
    return getRoute(user.id, id);
  }
  if (!['FUNDED', 'FAILED'].includes(row.stage)) throw unprocessable(`Transfer is ${row.stage.toLowerCase().replace(/_/g, ' ')}`, 'invalid_stage_transition');
  const held = getDb().prepare('SELECT status FROM transactions WHERE id = ?').get(row.payout_transaction_id ?? '') as any;
  if (held && held.status === 'pending') throw unprocessable('A payout is still held for this transfer', 'invalid_stage_transition');
  const dest = destination ?? parseJson<RouteDestination>(row.destination_details, { method: 'keep' });
  setRoute(id, { destination_details: JSON.stringify(dest), payout_transaction_id: null, payout_id: null });
  if (row.stage === 'FAILED') transitionRoute(id, 'PAYOUT_ROUTED', { type: 'user', id: user.id }, { retry: true });
  // Re-run through the normal dispatch (from FUNDED / PAYOUT_ROUTED the payout instruction syncs the stage).
  const fresh = getRouteRow(id);
  if (fresh.stage === 'PAYOUT_ROUTED') { /* dispatch will transition again via instruction */ }
  dispatchPayout(fresh, user, parseJson<any>(row.destination_details, {}).heldAmount ?? row.amount, { type: 'user', id: user.id }, true);
  return getRoute(user.id, id);
}

/** Sender cancels before the local payout is executed: the payout is cancelled and the funding refunded through the processor when possible. */
export async function cancelRoute(user: UserRow, id: string, reason = 'Cancelled by sender'): Promise<RouteView> {
  const row = getDb().prepare('SELECT * FROM money_routes WHERE id = ? AND user_id = ?').get(id, user.id) as any;
  if (!row) throw notFound('Route not found');
  if (!ROUTE_REFUNDABLE.includes(row.stage) && row.stage !== 'EXPIRED') throw conflict(`Transfer is ${row.stage.toLowerCase().replace(/_/g, ' ')} and can no longer be cancelled`, 'invalid_stage_transition');
  await refundRoute(id, { type: 'user', id: user.id }, reason, null);
  return getRoute(user.id, id);
}

/**
 * Recall the funds of a transfer whose local payout has not been executed: cancel the payout (held
 * funds return to the wallet) and convert any exchanged amount back to the funding currency.
 * Returns how much of the funding is now sitting in the funding-currency wallet.
 */
export function recallRouteFunds(routeId: string, actor: Actor, reason: string): { recalled: number; currency: string } {
  const row = getRouteRow(routeId);
  if (row.payout_id) {
    const p = getPayout(row.payout_id);
    if (['IN_PROGRESS', 'EVIDENCE_RECEIVED', 'VERIFYING'].includes(p.stage)) throw conflict('The local payout is being executed right now; it can no longer be recalled', 'payout_in_progress');
    if (p.stage !== 'SETTLED' && p.stage !== 'CANCELLED') cancelPayout(p.id, actor, reason);
  }
  const user = getUserById(row.user_id);
  const cur = getCurrency(row.currency, false);
  let recalled = 0;
  if (row.target_currency !== row.currency) {
    const tw = ensureWallet(user.id, row.target_currency);
    if (tw.balance > 0) {
      try {
        recalled += exchange(user, row.target_currency, row.currency, maxSendable('exchange', tw.balance, row.target_currency)).received;
      } catch {
        /* leave in target wallet */
      }
    }
  } else recalled = Math.max(0, ensureWallet(user.id, cur.code).balance);
  recordEvent('route', routeId, 'route.funds_recalled', actor, { reason, recalled, currency: cur.code });
  return { recalled, currency: cur.code };
}

/**
 * Refund: cancel the payout (funds back to the wallet), then refund the funding leg through the
 * processor (card) or leave the money in the wallet when the funding rail has no refund API.
 */
export async function refundRoute(routeId: string, actor: Actor, reason: string, verificationId: string | null): Promise<RouteView> {
  const row = getRouteRow(routeId);
  if (!ROUTE_REFUNDABLE.includes(row.stage) && row.stage !== 'EXPIRED' && row.stage !== 'DISPUTED') throw conflict(`Transfer is ${row.stage.toLowerCase().replace(/_/g, ' ')} and cannot be refunded`, 'invalid_stage_transition');
  recallRouteFunds(routeId, actor, reason);
  const user = getUserById(row.user_id);
  let refundedTo = 'wallet';
  let note = 'Funds returned to your wallet.';
  if (row.payment_id && row.source_method !== 'wallet') {
    const payment = getPayment(row.payment_id);
    if (payment.stage === 'SETTLED') {
      const cur = getCurrency(row.currency, false);
      const refundable = Math.min(ensureWallet(user.id, cur.code).balance, payment.amount - payment.fee);
      if (refundable > 0) {
        const r = await refundPayment(payment.id, refundable, reason, actor);
        if (r.result.status !== 'manual') {
          refundedTo = 'processor';
          note = `${formatMoney(refundable, cur)} refunded to your original payment method (${payment.gateway}).`;
        } else note = `${formatMoney(refundable, cur)} is in your wallet; ${r.result.message}`;
      }
    }
  }
  transitionRoute(routeId, 'REFUNDED', actor, { reason, verificationId, refundedTo });
  setRoute(routeId, { error: null });
  notify(user.id, 'Transfer refunded', note, { kind: 'route', routeId });
  return toView(getRouteRow(routeId));
}

/** Public view for the beneficiary consent link (no login): what is being sent and the currencies on offer. */
export function consentView(token: string) {
  const row = getDb().prepare('SELECT * FROM money_routes WHERE consent_token = ?').get(token) as any;
  if (!row) throw notFound('Confirmation link not found', 'consent_not_found');
  const sender = getUserById(row.user_id);
  const options = parseJson<PayoutCurrencyOptions | null>(row.currency_options, null);
  const quote = parseJson<RouteQuote | null>(row.quote, null);
  return { routeId: row.id, stage: row.stage, sender: { name: toPublicUser(sender).fullName }, amount: quote?.recipientAmount ?? null, currency: row.target_currency, localCurrency: options?.localCurrency ?? null, options: options?.options.filter((o) => o.available).map((o) => ({ currency: o.currency, isLocal: o.isLocal })) ?? [], confirmedAt: row.consent_confirmed_at, expiresAt: row.expires_at };
}

/**
 * Beneficiary decides the payout currency (regulated corridors). Accepting continues the payout in the quoted currency;
 * choosing another available currency re-quotes; declining leaves the funds with the sender (refundable).
 */
export function confirmPayoutCurrency(token: string, decision: { accept: boolean; currency?: string | null }, actor: Actor): RouteView {
  const row = getDb().prepare('SELECT * FROM money_routes WHERE consent_token = ?').get(token) as any;
  if (!row) throw notFound('Confirmation link not found', 'consent_not_found');
  if (row.consent_confirmed_at) throw conflict('The payout currency was already confirmed', 'consent_already_given');
  if (row.stage !== 'AWAITING_CONFIRMATION') throw conflict(`Transfer is ${String(row.stage).toLowerCase().replace(/_/g, ' ')}`, 'invalid_stage_transition');
  const user = getUserById(row.user_id);
  const dest = parseJson<any>(row.destination_details, {});
  const amount = dest.heldAmount ?? row.amount;
  if (!decision.accept) {
    transitionRoute(row.id, 'FAILED', actor, { reason: 'recipient_declined_currency', fundsInWallet: true });
    setRoute(row.id, { error: 'The recipient declined the payout currency; your funds remain in your wallet', consent_confirmed_at: now() });
    notify(user.id, 'Recipient declined the currency', 'Your money stays in your wallet. You can retry in the local currency.', { kind: 'route', routeId: row.id });
    return getRoute(user.id, row.id);
  }
  let target = row.target_currency as string;
  if (decision.currency && decision.currency.toUpperCase() !== target) {
    const options = payoutCurrencyOptions(dest, row.currency, amount, { requested: decision.currency.toUpperCase() });
    const opt = options?.options.find((o) => o.currency === decision.currency!.toUpperCase());
    if (!opt?.available) throw unprocessable(`${decision.currency.toUpperCase()} is not available for this payout: ${(opt?.reasons ?? []).join('; ')}`, 'payout_currency_unavailable');
    target = opt.currency;
    const quote = quoteRoute(row.amount, row.currency, target, row.source_method, dest, { userId: user.id, country: user.country, persistQuote: false });
    const corridor = destCorridor(dest, row.currency, target, true);
    setRoute(row.id, { target_currency: target, quote: JSON.stringify(quote), corridor_id: corridor?.id ?? null });
  }
  setRoute(row.id, { consent_confirmed_at: now() });
  recordEvent('route', row.id, 'route.currency_confirmed', actor, { currency: target, changed: target !== row.target_currency });
  transitionRoute(row.id, 'FUNDED', actor, { consent: true, targetCurrency: target });
  dispatchPayout(getRouteRow(row.id), user, amount, actor, true);
  return getRoute(user.id, row.id);
}

export function getRoute(userId: string, id: string): RouteView {
  const row = getDb().prepare('SELECT * FROM money_routes WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) throw notFound('Route not found');
  return toView(row);
}
export function adminRouteView(id: string): RouteView {
  return toView(getRouteRow(id));
}

export function listRoutes(userId: string): RouteView[] {
  return (getDb().prepare('SELECT * FROM money_routes WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(userId) as any[]).map(toView);
}

/** Sync a funding-stage route with its payment (used by the client while polling); agent cash-outs settle when the agent confirms. */
export async function refreshRoute(userId: string, id: string): Promise<RouteView> {
  const row = getDb().prepare('SELECT * FROM money_routes WHERE id = ? AND user_id = ?').get(id, userId) as any;
  if (!row) throw notFound('Route not found');
  if (['FUNDING_PENDING', 'BIOMETRIC_APPROVAL_REQUIRED'].includes(row.stage) && row.payment_id) {
    const p = await verifyPayment(row.payment_id);
    if (p.status === 'failed') {
      tryTransitionRoute(id, 'FAILED', { type: 'system' }, { reason: p.failureReason });
      setRoute(id, { error: p.failureReason });
    } else if (row.stage === 'BIOMETRIC_APPROVAL_REQUIRED' && p.stage !== 'AUTHENTICATION_REQUIRED' && p.status !== 'succeeded') tryTransitionRoute(id, 'FUNDING_PENDING', { type: 'system' }, { paymentId: p.id });
  }
  const fresh = getRouteRow(id);
  if (fresh.stage === 'PAYOUT_ROUTED' && fresh.destination_method === 'agent') {
    const dest = parseJson<any>(fresh.destination_details, {});
    const cr = dest.cashOutCode ? (getDb().prepare('SELECT status, transaction_id FROM cash_requests WHERE code = ?').get(dest.cashOutCode) as any) : null;
    if (cr?.status === 'completed') {
      setRoute(id, { payout_transaction_id: cr.transaction_id });
      transitionRoute(id, 'SETTLED', { type: 'agent' }, { cashOutCode: dest.cashOutCode });
    } else if (cr && ['expired', 'cancelled'].includes(cr.status)) {
      tryTransitionRoute(id, 'FAILED', { type: 'system' }, { reason: `cash-out ${cr.status}`, fundsInWallet: true });
    }
  }
  return getRoute(userId, id);
}

/** Receipt for the sender: what was paid, what arrived, and the evidence trail (hashes only). */
export function routeReceipt(userId: string, id: string) {
  const r = getRoute(userId, id);
  const events = listEvents({ subjectId: id, limit: 200 }).items.map((e) => ({ at: e.createdAt, event: e.event, actor: e.actor.type, hash: e.hash }));
  const evidence = r.payout ? (getDb().prepare('SELECT id, outcome, raw_hash, external_ref, created_at FROM payment_evidence WHERE payout_id = ? ORDER BY created_at').all(r.payout.id) as any[]).map((e) => ({ id: e.id, outcome: e.outcome, hash: e.raw_hash, operatorReference: e.external_ref, at: e.created_at })) : [];
  return { route: r, events, evidence, generatedAt: now() };
}

export { ensureWallet };
