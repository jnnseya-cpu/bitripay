/**
 * Smart restricted wallets (specification §61): money that can only be spent where a programme says. A programme
 * names the purpose (SCHOOL, HEALTH, …), the merchants that qualify (by id, MCC, a granted purpose code or a verified
 * institution registration), the ceiling per payment, the currency, the countries, an expiry and whether the balance
 * may ever be cashed out. A restricted wallet is a real ledger wallet – it belongs to a holder account opened for the
 * beneficiary and the programme (the ledger keeps one wallet per account and currency) – funded through the ledger by
 * an administrator, and every debit from it is checked by a posting policy inside postTransaction: an ineligible
 * merchant, a payment above the ceiling, an expired programme, a withdrawal or a cash-out without permission is
 * refused with 403 restricted_wallet_policy before anything is written.
 */
import { getDb } from '../db';
import { now, shortCode } from '../lib/ids';
import { parseJson } from '../lib/json';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { getCurrency } from './currencies';
import { PURPOSE_CODES } from './capabilities';
import { createUser, findUserById, findUserByIdentifier, getSystemUser, getUserById, toPublicUser, type UserRow } from './users';
import { ensureWallet, getWallet, type WalletRow } from './wallets';
import { calculateFee, enforceLimits, postTransaction, registerPostingPolicy, type PostTransactionInput, type TransactionRow } from './ledger';
import { recordEvent } from './events';
import { notify } from './notifications';
import { getIntentRow, onRequestPaid } from './intents';
import { getPaymentRequestByCode } from './paymentRequests';
import { formatMoney } from '@bitripay/shared';

export interface RestrictedProgramme {
  id: string;
  name: string;
  sponsorUserId: string | null;
  purposeCode: string;
  eligibleMccs: string[];
  eligibleMerchantIds: string[];
  maxTxMinor: number | null;
  currency: string;
  countries: string[];
  expiresAt: string | null;
  cashOutAllowed: boolean;
  status: 'active' | 'suspended' | 'closed';
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface RestrictedWalletView {
  id: string;
  programmeId: string;
  programme: Pick<RestrictedProgramme, 'id' | 'name' | 'purposeCode' | 'currency' | 'maxTxMinor' | 'expiresAt' | 'cashOutAllowed' | 'status'>;
  userId: string;
  holderUserId: string;
  holderTag: string | null;
  walletId: string;
  currency: string;
  balanceMinor: number;
  status: 'ACTIVE' | 'CLOSED';
  createdAt: string;
}
const toProgramme = (r: any): RestrictedProgramme => ({
  id: r.id,
  name: r.name,
  sponsorUserId: r.sponsor_user_id,
  purposeCode: r.purpose_code,
  eligibleMccs: parseJson(r.eligible_mccs, []),
  eligibleMerchantIds: parseJson(r.eligible_merchant_ids, []),
  maxTxMinor: r.max_tx_minor,
  currency: r.currency,
  countries: parseJson(r.countries, []),
  expiresAt: r.expires_at,
  cashOutAllowed: !!r.cash_out_allowed,
  status: r.status,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface ProgrammeInput {
  name: string;
  purposeCode: string;
  currency: string;
  sponsorUserId?: string | null;
  eligibleMccs?: string[];
  eligibleMerchantIds?: string[];
  maxTxMinor?: number | null;
  countries?: string[];
  expiresAt?: string | null;
  cashOutAllowed?: boolean;
}
export function createProgramme(admin: UserRow, input: ProgrammeInput): RestrictedProgramme {
  const code = input.purposeCode.toUpperCase();
  if (!(PURPOSE_CODES as readonly string[]).includes(code)) throw badRequest(`Unknown purpose code ${code}`, 'invalid_purpose');
  const cur = getCurrency(input.currency);
  if (input.maxTxMinor != null && (!Number.isInteger(input.maxTxMinor) || input.maxTxMinor <= 0)) throw badRequest('maxTxMinor must be a positive integer in minor units', 'invalid_amount');
  if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) throw badRequest('expiresAt must be an ISO date', 'validation_error');
  for (const m of input.eligibleMerchantIds ?? []) if (!findUserById(m)) throw notFound(`Merchant ${m} not found`, 'merchant_not_found');
  if (input.sponsorUserId && !findUserById(input.sponsorUserId)) throw notFound('Sponsor not found', 'user_not_found');
  const id = `rp_${shortCode(12).toLowerCase()}`;
  const ts = now();
  getDb()
    .prepare(
      'INSERT INTO restricted_programmes (id, name, sponsor_user_id, purpose_code, eligible_mccs, eligible_merchant_ids, max_tx_minor, currency, countries, expires_at, cash_out_allowed, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      input.name.trim(),
      input.sponsorUserId ?? null,
      code,
      JSON.stringify((input.eligibleMccs ?? []).map((m) => String(m).trim())),
      JSON.stringify(input.eligibleMerchantIds ?? []),
      input.maxTxMinor ?? null,
      cur.code,
      JSON.stringify((input.countries ?? []).map((c) => c.toUpperCase())),
      input.expiresAt ?? null,
      input.cashOutAllowed ? 1 : 0,
      'active',
      admin.id,
      ts,
      ts,
    );
  recordEvent('issuance', id, 'restricted_programme.created', { type: 'admin', id: admin.id }, { name: input.name, purposeCode: code, currency: cur.code });
  return getProgramme(id);
}
export function updateProgramme(admin: UserRow, id: string, patch: Partial<ProgrammeInput> & { status?: RestrictedProgramme['status'] }): RestrictedProgramme {
  const p = getProgramme(id);
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    params.push(v);
  };
  if (patch.name !== undefined) set('name', patch.name.trim());
  if (patch.eligibleMccs !== undefined) set('eligible_mccs', JSON.stringify(patch.eligibleMccs.map((m) => String(m).trim())));
  if (patch.eligibleMerchantIds !== undefined) {
    for (const m of patch.eligibleMerchantIds) if (!findUserById(m)) throw notFound(`Merchant ${m} not found`, 'merchant_not_found');
    set('eligible_merchant_ids', JSON.stringify(patch.eligibleMerchantIds));
  }
  if (patch.maxTxMinor !== undefined) {
    if (patch.maxTxMinor != null && (!Number.isInteger(patch.maxTxMinor) || patch.maxTxMinor <= 0)) throw badRequest('maxTxMinor must be a positive integer in minor units', 'invalid_amount');
    set('max_tx_minor', patch.maxTxMinor);
  }
  if (patch.countries !== undefined) set('countries', JSON.stringify(patch.countries.map((c) => c.toUpperCase())));
  if (patch.expiresAt !== undefined) set('expires_at', patch.expiresAt);
  if (patch.cashOutAllowed !== undefined) set('cash_out_allowed', patch.cashOutAllowed ? 1 : 0);
  if (patch.status !== undefined) set('status', patch.status);
  if (!sets.length) return p;
  set('updated_at', now());
  getDb()
    .prepare(`UPDATE restricted_programmes SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params, id);
  recordEvent('issuance', id, 'restricted_programme.updated', { type: 'admin', id: admin.id }, { fields: Object.keys(patch) });
  return getProgramme(id);
}
export function getProgramme(id: string): RestrictedProgramme {
  const r = getDb().prepare('SELECT * FROM restricted_programmes WHERE id = ?').get(id);
  if (!r) throw notFound('Restricted programme not found', 'programme_not_found');
  return toProgramme(r);
}
export function listProgrammes(filter: { status?: string | null } = {}): RestrictedProgramme[] {
  return (
    getDb()
      .prepare(`SELECT * FROM restricted_programmes ${filter.status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC`)
      .all(...(filter.status ? [filter.status] : [])) as any[]
  ).map(toProgramme);
}

// ---------------------------------------------------------------------------------------------------------------------
// Merchant purpose codes: what a merchant is allowed to be paid for from restricted money (granted by compliance).
// ---------------------------------------------------------------------------------------------------------------------
export function listMerchantPurposeCodes(userId: string): string[] {
  return (getDb().prepare('SELECT purpose_code FROM merchant_purpose_codes WHERE user_id = ? ORDER BY purpose_code').all(userId) as { purpose_code: string }[]).map((r) => r.purpose_code);
}
export function setMerchantPurposeCodes(admin: UserRow, userId: string, codes: string[]): string[] {
  const merchant = getUserById(userId);
  if (merchant.role !== 'merchant' && merchant.role !== 'admin') throw badRequest('Purpose codes are granted to merchant accounts', 'role_required');
  const wanted = Array.from(new Set(codes.map((c) => c.toUpperCase())));
  for (const c of wanted) if (!(PURPOSE_CODES as readonly string[]).includes(c)) throw badRequest(`Unknown purpose code ${c}`, 'invalid_purpose');
  const db = getDb();
  db.transaction(() => {
    const current = listMerchantPurposeCodes(userId);
    for (const c of current) if (!wanted.includes(c)) db.prepare('DELETE FROM merchant_purpose_codes WHERE user_id = ? AND purpose_code = ?').run(userId, c);
    for (const c of wanted)
      if (!current.includes(c)) db.prepare('INSERT INTO merchant_purpose_codes (user_id, purpose_code, granted_by, created_at) VALUES (?, ?, ?, ?)').run(userId, c, admin.id, now());
  })();
  recordEvent('risk', userId, 'merchant.purpose_codes_set', { type: 'admin', id: admin.id }, { codes: wanted });
  return listMerchantPurposeCodes(userId);
}

/** Why a merchant qualifies for a programme (or not): explicit id, MCC, granted purpose code, verified institution. */
export function merchantEligibility(p: RestrictedProgramme, merchant: UserRow): { eligible: boolean; reason: string } {
  if (p.countries.length && (!merchant.country || !p.countries.includes(merchant.country.toUpperCase())))
    return { eligible: false, reason: `merchant country ${merchant.country ?? 'unknown'} is outside the programme countries` };
  if (p.eligibleMerchantIds.includes(merchant.id)) return { eligible: true, reason: 'listed on the programme' };
  const db = getDb();
  if (p.eligibleMccs.length) {
    const mccs = new Set<string>();
    for (const r of db.prepare("SELECT mcc FROM merchant_locations WHERE merchant_user_id = ? AND status = 'active' AND mcc IS NOT NULL").all(merchant.id) as { mcc: string }[]) mccs.add(r.mcc);
    const kyb = db.prepare('SELECT mcc FROM kyb_submissions WHERE user_id = ? AND mcc IS NOT NULL ORDER BY created_at DESC LIMIT 1').get(merchant.id) as { mcc: string } | undefined;
    if (kyb?.mcc) mccs.add(kyb.mcc);
    const hit = p.eligibleMccs.find((m) => mccs.has(m));
    if (hit) return { eligible: true, reason: `merchant category ${hit} is eligible` };
  }
  if (db.prepare('SELECT 1 FROM merchant_purpose_codes WHERE user_id = ? AND purpose_code = ?').get(merchant.id, p.purposeCode))
    return { eligible: true, reason: `granted purpose code ${p.purposeCode}` };
  const inst = db.prepare("SELECT purpose_codes FROM institutions WHERE user_id = ? AND status = 'verified'").get(merchant.id) as { purpose_codes: string } | undefined;
  if (inst && parseJson<string[]>(inst.purpose_codes, []).includes(p.purposeCode)) return { eligible: true, reason: `verified institution for ${p.purposeCode}` };
  return { eligible: false, reason: `merchant is not eligible for ${p.purposeCode} under programme ${p.name}` };
}

// ---------------------------------------------------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------------------------------------------------
function toView(r: any): RestrictedWalletView {
  const p = getProgramme(r.programme_id);
  const wallet = getWallet(r.wallet_id);
  const holder = findUserById(r.holder_user_id);
  return {
    id: r.id,
    programmeId: r.programme_id,
    programme: { id: p.id, name: p.name, purposeCode: p.purposeCode, currency: p.currency, maxTxMinor: p.maxTxMinor, expiresAt: p.expiresAt, cashOutAllowed: p.cashOutAllowed, status: p.status },
    userId: r.user_id,
    holderUserId: r.holder_user_id,
    holderTag: holder?.tag ?? null,
    walletId: r.wallet_id,
    currency: r.currency,
    balanceMinor: wallet.balance,
    status: r.status,
    createdAt: r.created_at,
  };
}
export function getRestrictedWallet(id: string): RestrictedWalletView {
  const r = getDb().prepare('SELECT * FROM restricted_wallets WHERE id = ?').get(id);
  if (!r) throw notFound('Restricted wallet not found', 'restricted_wallet_not_found');
  return toView(r);
}
export function listRestrictedWallets(userId: string): RestrictedWalletView[] {
  return (getDb().prepare('SELECT * FROM restricted_wallets WHERE user_id = ? ORDER BY created_at DESC').all(userId) as any[]).map(toView);
}
/** Open the beneficiary's wallet under a programme: a holder account carries the ledger wallet in the programme currency. */
export function openRestrictedWallet(admin: UserRow, input: { programmeId: string; userId: string }): RestrictedWalletView {
  const p = getProgramme(input.programmeId);
  if (p.status !== 'active') throw conflict(`Programme is ${p.status}`, 'programme_inactive');
  const user = getUserById(input.userId);
  if (user.is_system) throw badRequest('Restricted wallets are opened for account holders', 'invalid_user');
  const db = getDb();
  if (db.prepare('SELECT 1 FROM restricted_wallets WHERE programme_id = ? AND user_id = ?').get(p.id, user.id))
    throw conflict('This user already has a wallet under the programme', 'restricted_wallet_exists');
  return db.transaction(() => {
    const tag = `rw_${shortCode(8).toLowerCase()}`;
    const holder = createUser({ fullName: `${user.full_name} · ${p.name}`, tag, role: 'user', email: `${tag}@restricted.bitripay.local`, emailVerified: true, country: user.country });
    const wallet = ensureWallet(holder.id, p.currency);
    const id = `rw_${shortCode(12).toLowerCase()}`;
    const ts = now();
    db.prepare('INSERT INTO restricted_wallets (id, programme_id, user_id, holder_user_id, wallet_id, currency, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      p.id,
      user.id,
      holder.id,
      wallet.id,
      p.currency,
      'ACTIVE',
      admin.id,
      ts,
      ts,
    );
    recordEvent('issuance', id, 'restricted_wallet.opened', { type: 'admin', id: admin.id }, { programmeId: p.id, userId: user.id, walletId: wallet.id, currency: p.currency });
    notify(user.id, `${p.name} wallet opened`, `A restricted ${p.currency} wallet for ${p.purposeCode.toLowerCase().replace('_', ' ')} payments was opened for you.`, {
      kind: 'wallet',
      restrictedWalletId: id,
    });
    return getRestrictedWallet(id);
  })();
}
/**
 * Fund a restricted wallet through the ledger: from the programme sponsor's wallet when the programme has a sponsor
 * with balance (a plain distribution, no new money), otherwise as a programme issuance from the treasury.
 */
export function fundRestrictedWallet(admin: UserRow, input: { restrictedWalletId: string; amountMinor: number; note?: string | null }): { wallet: RestrictedWalletView; transaction: TransactionRow } {
  const rw = getRestrictedWallet(input.restrictedWalletId);
  if (rw.status !== 'ACTIVE') throw conflict('Restricted wallet is closed', 'restricted_wallet_closed');
  const p = getProgramme(rw.programmeId);
  if (p.status !== 'active') throw conflict(`Programme is ${p.status}`, 'programme_inactive');
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw badRequest('Amount must be a positive integer in minor units', 'invalid_amount');
  const sponsorWallet = p.sponsorUserId ? (getDb().prepare('SELECT * FROM wallets WHERE user_id = ? AND currency = ?').get(p.sponsorUserId, p.currency) as WalletRow | undefined) : undefined;
  const fromSponsor = !!sponsorWallet && sponsorWallet.balance >= input.amountMinor;
  const tx = postTransaction({
    type: fromSponsor ? 'distribution' : 'admin_adjustment',
    amount: input.amountMinor,
    currency: p.currency,
    fromWalletId: fromSponsor ? sponsorWallet!.id : null,
    toWalletId: rw.walletId,
    senderUserId: fromSponsor ? p.sponsorUserId : null,
    receiverUserId: rw.userId,
    note: input.note ?? `${p.name}: restricted wallet funding`,
    metadata: { restrictedWalletId: rw.id, programmeId: p.id, purposeCode: p.purposeCode, fundedBy: admin.id, source: fromSponsor ? 'sponsor' : 'treasury' },
    issuance: fromSponsor ? undefined : { authority: 'programme', programme: `restricted:${p.id}`, adminId: admin.id, reference: rw.id },
  });
  recordEvent(
    'issuance',
    rw.id,
    'restricted_wallet.funded',
    { type: 'admin', id: admin.id },
    { transactionId: tx.id, amount: input.amountMinor, currency: p.currency, source: fromSponsor ? 'sponsor' : 'treasury' },
  );
  notify(rw.userId, `${p.name} wallet funded`, `${formatMoney(input.amountMinor, getCurrency(p.currency, false))} was added to your restricted wallet.`, { kind: 'wallet', transactionId: tx.id });
  return { wallet: getRestrictedWallet(rw.id), transaction: tx };
}
/** The beneficiary pays a merchant (or one of the merchant's payment intents) from the restricted wallet. */
export function payFromRestrictedWallet(
  user: UserRow,
  input: { restrictedWalletId: string; merchant?: string | null; intentId?: string | null; amountMinor?: number | null; note?: string | null },
): TransactionRow {
  const rw = getRestrictedWallet(input.restrictedWalletId);
  if (rw.userId !== user.id) throw forbidden('This restricted wallet belongs to another account', 'not_owner');
  if (rw.status !== 'ACTIVE') throw conflict('Restricted wallet is closed', 'restricted_wallet_closed');
  const p = getProgramme(rw.programmeId);
  const db = getDb();
  return db.transaction(() => {
    const intent = input.intentId ? getIntentRow(input.intentId) : null;
    const merchant = intent ? getUserById(intent.merchant_user_id) : input.merchant ? findUserByIdentifier(input.merchant) : undefined;
    if (!merchant || merchant.is_system) throw notFound('Merchant not found', 'merchant_not_found');
    const amount = intent?.amount_minor ?? input.amountMinor ?? 0;
    if (!Number.isInteger(amount) || amount <= 0) throw badRequest('Amount must be a positive integer in minor units', 'invalid_amount');
    if (intent && intent.currency !== p.currency) throw badRequest(`This payment is in ${intent.currency}; the wallet holds ${p.currency}`, 'currency_mismatch');
    const request = intent?.payment_request_id ? getPaymentRequestByCode(intent.payment_request_id) : null;
    if (request && request.status !== 'open') throw conflict(`This payment request is ${request.status}`, 'request_not_open');
    enforceLimits(user, amount, p.currency);
    const fee = calculateFee('merchant_payment', amount, p.currency, null, { userId: merchant.id });
    const tx = postTransaction({
      type: 'merchant_payment',
      amount,
      fee,
      currency: p.currency,
      fromWalletId: rw.walletId,
      toWalletId: ensureWallet(merchant.id, p.currency).id,
      senderUserId: user.id,
      receiverUserId: merchant.id,
      feeFrom: 'receiver',
      note: input.note ?? intent?.description ?? `${p.name} payment to ${merchant.business_name || merchant.full_name}`,
      metadata: {
        restrictedWalletId: rw.id,
        programmeId: p.id,
        purposeCode: p.purposeCode,
        method: 'restricted_wallet',
        ...(request ? { paymentRequestId: request.id, paymentRequestCode: request.code, kind: request.kind, ...parseJson(request.metadata, {}) } : {}),
      },
    });
    if (request) {
      db.prepare("UPDATE payment_requests SET status = 'paid', paid_transaction_id = ?, payer_user_id = ? WHERE id = ?").run(tx.id, user.id, request.id);
      onRequestPaid(getPaymentRequestByCode(request.code), tx.id, 'wallet', { type: 'user', id: user.id });
    }
    notify(merchant.id, 'Payment received', `${user.full_name} (@${user.tag}) paid ${formatMoney(amount, getCurrency(p.currency, false))} from a ${p.name} restricted wallet.`, {
      kind: 'payment_received',
      transactionId: tx.id,
    });
    return tx;
  })();
}
export function closeRestrictedWallet(admin: UserRow, id: string): RestrictedWalletView {
  const rw = getRestrictedWallet(id);
  if (rw.status !== 'ACTIVE') return rw;
  getDb().prepare("UPDATE restricted_wallets SET status = 'CLOSED', updated_at = ? WHERE id = ?").run(now(), id);
  recordEvent('issuance', id, 'restricted_wallet.closed', { type: 'admin', id: admin.id }, { balance: rw.balanceMinor });
  return getRestrictedWallet(id);
}

// ---------------------------------------------------------------------------------------------------------------------
// The posting policy: consulted by the ledger before any write on every posting whose source is a restricted wallet.
// ---------------------------------------------------------------------------------------------------------------------
const POLICY_TYPES_NEVER_ALLOWED = new Set<string>(['exchange', 'virtual_card_funding', 'remittance', 'gift_card', 'mobile_topup']);
export function restrictedWalletPolicy(ctx: { input: PostTransactionInput; fromWallet: WalletRow; toWallet: WalletRow; isSenderSystem: boolean }): void {
  if (ctx.isSenderSystem) return;
  const rw = getDb().prepare('SELECT * FROM restricted_wallets WHERE wallet_id = ?').get(ctx.fromWallet.id) as any;
  if (!rw) return;
  const refuse = (why: string) => forbidden(`Restricted wallet: ${why}`, 'restricted_wallet_policy');
  if (rw.status !== 'ACTIVE') throw refuse('this wallet is closed');
  const p = getProgramme(rw.programme_id);
  if (p.status !== 'active') throw refuse(`programme ${p.name} is ${p.status}`);
  if (p.expiresAt && p.expiresAt < now()) throw refuse(`programme ${p.name} expired on ${p.expiresAt.slice(0, 10)}`);
  if (ctx.input.currency !== p.currency) throw refuse(`only ${p.currency} payments are allowed`);
  if (p.maxTxMinor != null && ctx.input.amount > p.maxTxMinor) throw refuse(`payments are capped at ${formatMoney(p.maxTxMinor, getCurrency(p.currency, false))} per transaction`);
  if (POLICY_TYPES_NEVER_ALLOWED.has(ctx.input.type)) throw refuse(`${ctx.input.type.replace(/_/g, ' ')} is not an eligible use of ${p.purposeCode.toLowerCase().replace('_', ' ')} money`);
  const treasury = getSystemUser('treasury');
  const receiver = ctx.toWallet.user_id === treasury.id ? null : findUserById(ctx.toWallet.user_id);
  const merchantLike = receiver && !receiver.is_system && (receiver.role === 'merchant' || receiver.role === 'admin');
  if (!merchantLike) {
    if (!p.cashOutAllowed) throw refuse(`${p.purposeCode.toLowerCase().replace('_', ' ')} money cannot be withdrawn, cashed out or transferred; it can only pay eligible merchants`);
    return;
  }
  const eligibility = merchantEligibility(p, receiver!);
  if (!eligibility.eligible) throw refuse(eligibility.reason);
}
const HOOK = Symbol.for('bitripay.restrictedWallets.policy');
if (!(globalThis as any)[HOOK]) {
  (globalThis as any)[HOOK] = true;
  registerPostingPolicy(restrictedWalletPolicy);
}

export const restrictedWalletOwner = (view: RestrictedWalletView) => {
  const u = findUserById(view.userId);
  return u ? toPublicUser(u) : null;
};
