/**
 * Diaspora-Direct (innovation I-4): a payer abroad pays a school fee, a hospital bill, rent or a utility at home,
 * at a rate the platform published and signed, to an institution that is registered for that purpose. Three
 * objects make it honest: a human-signed **rate policy** per currency pair (markup, fees, ceilings, maximum card
 * validity), **rate cards** re-issued under that policy at most every four hours and signed with the platform key,
 * and **purpose-locked quotes** that can only be paid to an institution whose registration covers the purpose
 * code. The FX Oracle agent proposes; a person signs the policy; the platform never converts without an explicit
 * instruction. Institutions receive a "DD" flagged BitriQR they can print or embed.
 */
import { getDb } from '../db';
import { now, shortCode } from '../lib/ids';
import { parseJson } from '../lib/json';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { getCurrency } from './currencies';
import { fxDisclosure } from './fx';
import { findUserById, findUserByIdentifier, toPublicUser, type UserRow } from './users';
import { ensureWallet, getUserWallet } from './wallets';
import { postTransaction, enforceLimits } from './ledger';
import { platformSigningKey, signWithKey, verifyWithKey } from './keys';
import { recordEvent, type Actor } from './events';
import { notify } from './notifications';
import { enforceOutboundRisk } from './risk';
import { PURPOSE_CODES } from './capabilities';
import { createStaticQr } from './qrcodes';
import { publish } from './bus';
import { emitEvent } from './webhooks';
import { assertMoneyMovementAllowed } from './guardian';

/** Purpose codes that may only be paid to a registered institution. */
export const RESTRICTED_PURPOSES = ['SCHOOL', 'HEALTH', 'RENT', 'UTILITY', 'GOVERNMENT_FEE', 'TAX'] as const;
export const INSTITUTION_KINDS = ['school', 'hospital', 'utility', 'government', 'ngo', 'landlord', 'cooperative'] as const;

// ---------------------------------------------------------------------------------------------------------------------
// Rate policy (human-signed) and rate cards (platform-signed, ≤ 4h)
// ---------------------------------------------------------------------------------------------------------------------
export interface RatePolicy {
  id: string;
  sourceCurrency: string;
  destCurrency: string;
  markupBps: number;
  maxValidityHours: number;
  feeBps: number;
  feeFixedSourceMinor: number;
  minSourceMinor: number;
  maxSourceMinor: number;
  status: 'ACTIVE' | 'RETIRED';
  signedBy: string;
  signature: string;
  version: number;
  createdAt: string;
  retiredAt: string | null;
}
const toPolicy = (r: any): RatePolicy => ({
  id: r.id,
  sourceCurrency: r.source_currency,
  destCurrency: r.dest_currency,
  markupBps: r.markup_bps,
  maxValidityHours: r.max_validity_hours,
  feeBps: r.fee_bps,
  feeFixedSourceMinor: r.fee_fixed_source_minor,
  minSourceMinor: r.min_source_minor,
  maxSourceMinor: r.max_source_minor,
  status: r.status,
  signedBy: r.signed_by,
  signature: r.signature,
  version: r.version,
  createdAt: r.created_at,
  retiredAt: r.retired_at,
});
export const policyCanonical = (p: {
  sourceCurrency: string;
  destCurrency: string;
  markupBps: number;
  maxValidityHours: number;
  feeBps: number;
  feeFixedSourceMinor: number;
  minSourceMinor: number;
  maxSourceMinor: number;
  version: number;
  signedBy: string;
}) => ['DD-RATE-POLICY', p.sourceCurrency, p.destCurrency, p.markupBps, p.maxValidityHours, p.feeBps, p.feeFixedSourceMinor, p.minSourceMinor, p.maxSourceMinor, p.version, p.signedBy].join('|');

/** Sign a policy for a pair (the previous version is retired). The signature binds the numbers to the administrator who set them. */
export function signRatePolicy(
  admin: UserRow,
  input: {
    sourceCurrency: string;
    destCurrency: string;
    markupBps: number;
    maxValidityHours?: number;
    feeBps?: number;
    feeFixedSourceMinor?: number;
    minSourceMinor?: number;
    maxSourceMinor?: number;
  },
): RatePolicy {
  const src = getCurrency(input.sourceCurrency);
  const dst = getCurrency(input.destCurrency);
  if (src.code === dst.code) throw badRequest('A Diaspora-Direct policy needs two different currencies', 'validation_error');
  if (input.markupBps < 0 || input.markupBps > 1500) throw badRequest('Markup must be 0–1500 bps', 'validation_error');
  const hours = Math.min(4, Math.max(1, input.maxValidityHours ?? 4));
  const db = getDb();
  const version = ((db.prepare('SELECT MAX(version) v FROM fx_rate_policies WHERE source_currency = ? AND dest_currency = ?').get(src.code, dst.code) as any).v ?? 0) + 1;
  const id = `rp_${shortCode(10).toLowerCase()}`;
  const body = {
    sourceCurrency: src.code,
    destCurrency: dst.code,
    markupBps: input.markupBps,
    maxValidityHours: hours,
    feeBps: input.feeBps ?? 0,
    feeFixedSourceMinor: input.feeFixedSourceMinor ?? 0,
    minSourceMinor: input.minSourceMinor ?? 0,
    maxSourceMinor: input.maxSourceMinor ?? 0,
    version,
    signedBy: admin.id,
  };
  const key = platformSigningKey();
  const signature = `${key.keyId}:${Buffer.from(signWithKey(key.keyId, policyCanonical(body))).toString('base64')}`;
  db.transaction(() => {
    db.prepare("UPDATE fx_rate_policies SET status = 'RETIRED', retired_at = ? WHERE source_currency = ? AND dest_currency = ? AND status = 'ACTIVE'").run(now(), src.code, dst.code);
    db.prepare(
      'INSERT INTO fx_rate_policies (id, source_currency, dest_currency, markup_bps, max_validity_hours, fee_bps, fee_fixed_source_minor, min_source_minor, max_source_minor, status, signed_by, signature, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      body.sourceCurrency,
      body.destCurrency,
      body.markupBps,
      body.maxValidityHours,
      body.feeBps,
      body.feeFixedSourceMinor,
      body.minSourceMinor,
      body.maxSourceMinor,
      'ACTIVE',
      admin.id,
      signature,
      version,
      now(),
    );
  })();
  recordEvent('corridor', id, 'dd.rate_policy.signed', { type: 'admin', id: admin.id }, { pair: `${src.code}/${dst.code}`, markupBps: input.markupBps, version });
  return toPolicy(db.prepare('SELECT * FROM fx_rate_policies WHERE id = ?').get(id));
}
export function listRatePolicies(includeRetired = false): RatePolicy[] {
  return (
    getDb()
      .prepare(`SELECT * FROM fx_rate_policies ${includeRetired ? '' : "WHERE status = 'ACTIVE'"} ORDER BY source_currency, dest_currency, version DESC`)
      .all() as any[]
  ).map(toPolicy);
}
export function verifyPolicySignature(p: RatePolicy): boolean {
  const [keyId, sig] = p.signature.split(':');
  return !!keyId && !!sig && verifyWithKey(keyId, policyCanonical(p), new Uint8Array(Buffer.from(sig, 'base64')));
}

export interface RateCard {
  id: string;
  policyId: string;
  sourceCurrency: string;
  destCurrency: string;
  midRate: number;
  customerRate: number;
  markupBps: number;
  provider: string;
  rateTimestamp: string | null;
  validFrom: string;
  validUntil: string;
  signature: string;
  keyId: string;
  createdAt: string;
}
const toCard = (r: any): RateCard => ({
  id: r.id,
  policyId: r.policy_id,
  sourceCurrency: r.source_currency,
  destCurrency: r.dest_currency,
  midRate: r.mid_rate,
  customerRate: r.customer_rate,
  markupBps: r.markup_bps,
  provider: r.provider,
  rateTimestamp: r.rate_timestamp,
  validFrom: r.valid_from,
  validUntil: r.valid_until,
  signature: r.signature,
  keyId: r.key_id,
  createdAt: r.created_at,
});
export const cardCanonical = (c: { id: string; sourceCurrency: string; destCurrency: string; customerRate: number; validFrom: string; validUntil: string; policyId: string }) =>
  ['DD-RATE-CARD', c.id, c.sourceCurrency, c.destCurrency, c.customerRate.toFixed(8), c.validFrom, c.validUntil, c.policyId].join('|');

/** Issue a card for the pair under its signed policy (from the live mid-market rate). */
export function issueRateCard(sourceCurrency: string, destCurrency: string, actor: Actor = { type: 'system' }): RateCard {
  const db = getDb();
  const policy = db
    .prepare("SELECT * FROM fx_rate_policies WHERE source_currency = ? AND dest_currency = ? AND status = 'ACTIVE'")
    .get(sourceCurrency.toUpperCase(), destCurrency.toUpperCase()) as any;
  if (!policy) throw unprocessable(`No signed rate policy for ${sourceCurrency}/${destCurrency}`, 'no_rate_policy');
  const p = toPolicy(policy);
  if (!verifyPolicySignature(p)) throw unprocessable('The rate policy signature does not verify; refusing to issue cards', 'policy_signature_invalid');
  const fx = fxDisclosure(p.sourceCurrency, p.destCurrency, null, false);
  const customerRate = fx.midRate * (1 - p.markupBps / 10_000);
  const id = `rc_${shortCode(12).toLowerCase()}`;
  const validFrom = now();
  const validUntil = new Date(Date.now() + p.maxValidityHours * 3600_000).toISOString();
  const key = platformSigningKey();
  const signature = Buffer.from(
    signWithKey(key.keyId, cardCanonical({ id, sourceCurrency: p.sourceCurrency, destCurrency: p.destCurrency, customerRate, validFrom, validUntil, policyId: p.id })),
  ).toString('base64');
  db.prepare(
    'INSERT INTO fx_rate_cards (id, policy_id, source_currency, dest_currency, mid_rate, customer_rate, markup_bps, provider, rate_timestamp, valid_from, valid_until, signature, key_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, p.id, p.sourceCurrency, p.destCurrency, fx.midRate, customerRate, p.markupBps, fx.provider, fx.rateTimestamp, validFrom, validUntil, signature, key.keyId, now());
  recordEvent('corridor', id, 'dd.rate_card.issued', actor, { pair: `${p.sourceCurrency}/${p.destCurrency}`, customerRate, midRate: fx.midRate, provider: fx.provider, validUntil });
  return toCard(db.prepare('SELECT * FROM fx_rate_cards WHERE id = ?').get(id));
}
export function activeRateCard(sourceCurrency: string, destCurrency: string, issueIfMissing = true): RateCard | null {
  const r = getDb()
    .prepare('SELECT * FROM fx_rate_cards WHERE source_currency = ? AND dest_currency = ? AND valid_until > ? ORDER BY valid_until DESC LIMIT 1')
    .get(sourceCurrency.toUpperCase(), destCurrency.toUpperCase(), now()) as any;
  if (r) return toCard(r);
  if (!issueIfMissing) return null;
  try {
    return issueRateCard(sourceCurrency, destCurrency);
  } catch {
    return null;
  }
}
export function listRateCards(): RateCard[] {
  return listRatePolicies()
    .map((p) => activeRateCard(p.sourceCurrency, p.destCurrency))
    .filter(Boolean) as RateCard[];
}
/** Scheduler: re-issue cards that expire within the hour so a live card is always published (the 4h refresh). */
export function refreshRateCards(): { issued: number } {
  let issued = 0;
  for (const p of listRatePolicies()) {
    const c = activeRateCard(p.sourceCurrency, p.destCurrency, false);
    if (!c || Date.parse(c.validUntil) - Date.now() < 3600_000) {
      issueRateCard(p.sourceCurrency, p.destCurrency);
      issued += 1;
    }
  }
  return { issued };
}

// ---------------------------------------------------------------------------------------------------------------------
// Institutions
// ---------------------------------------------------------------------------------------------------------------------
export interface Institution {
  userId: string;
  kind: string;
  name: string;
  registryRef: string | null;
  purposeCodes: string[];
  country: string;
  status: 'pending' | 'verified' | 'suspended';
  verifiedBy: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  user: ReturnType<typeof toPublicUser> | null;
}
const toInstitution = (r: any): Institution => {
  const u = findUserById(r.user_id);
  return {
    userId: r.user_id,
    kind: r.kind,
    name: r.name,
    registryRef: r.registry_ref,
    purposeCodes: parseJson(r.purpose_codes, []),
    country: r.country,
    status: r.status,
    verifiedBy: r.verified_by,
    verifiedAt: r.verified_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    user: u ? toPublicUser(u) : null,
  };
};
export function registerInstitution(merchant: UserRow, input: { kind: string; name: string; registryRef?: string | null; purposeCodes: string[]; country?: string | null }): Institution {
  if (merchant.role !== 'merchant' && merchant.role !== 'admin') throw forbidden('Only merchant accounts register as institutions', 'role_required');
  if (!INSTITUTION_KINDS.includes(input.kind as any)) throw badRequest(`kind must be one of ${INSTITUTION_KINDS.join(', ')}`, 'validation_error');
  const codes = [...new Set(input.purposeCodes.map((c) => c.toUpperCase()))];
  for (const c of codes) if (!PURPOSE_CODES.includes(c as any)) throw badRequest(`Unknown purpose code ${c}`, 'invalid_purpose');
  if (!codes.length) throw badRequest('At least one purpose code', 'validation_error');
  const db = getDb();
  const existing = db.prepare('SELECT * FROM institutions WHERE user_id = ?').get(merchant.id) as any;
  const country = (input.country ?? merchant.country ?? 'CD').toUpperCase();
  if (existing)
    db.prepare(
      "UPDATE institutions SET kind = ?, name = ?, registry_ref = ?, purpose_codes = ?, country = ?, status = CASE WHEN status = 'verified' THEN 'pending' ELSE status END, updated_at = ? WHERE user_id = ?",
    ).run(input.kind, input.name.trim(), input.registryRef ?? null, JSON.stringify(codes), country, now(), merchant.id);
  else
    db.prepare('INSERT INTO institutions (user_id, kind, name, registry_ref, purpose_codes, country, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      merchant.id,
      input.kind,
      input.name.trim(),
      input.registryRef ?? null,
      JSON.stringify(codes),
      country,
      'pending',
      now(),
      now(),
    );
  recordEvent('risk', merchant.id, 'institution.registered', { type: 'merchant', id: merchant.id }, { kind: input.kind, purposeCodes: codes });
  return getInstitution(merchant.id)!;
}
export function getInstitution(userId: string): Institution | null {
  const r = getDb().prepare('SELECT * FROM institutions WHERE user_id = ?').get(userId);
  return r ? toInstitution(r) : null;
}
export function listInstitutions(filter: { status?: string | null; country?: string | null; purposeCode?: string | null; q?: string | null } = {}): Institution[] {
  const rows = (
    getDb()
      .prepare(`SELECT * FROM institutions ${filter.status ? 'WHERE status = ?' : ''} ORDER BY name`)
      .all(...(filter.status ? [filter.status] : [])) as any[]
  ).map(toInstitution);
  return rows.filter(
    (i) =>
      (!filter.country || i.country === filter.country.toUpperCase()) &&
      (!filter.purposeCode || i.purposeCodes.includes(filter.purposeCode.toUpperCase())) &&
      (!filter.q || i.name.toLowerCase().includes(filter.q.toLowerCase())),
  );
}
export function reviewInstitution(userId: string, admin: UserRow, decision: 'verified' | 'suspended' | 'pending', note?: string | null): Institution {
  const i = getInstitution(userId);
  if (!i) throw notFound('Institution not found', 'institution_not_found');
  getDb()
    .prepare('UPDATE institutions SET status = ?, verified_by = ?, verified_at = ?, updated_at = ? WHERE user_id = ?')
    .run(decision, decision === 'verified' ? admin.id : i.verifiedBy, decision === 'verified' ? now() : i.verifiedAt, now(), userId);
  recordEvent('risk', userId, `institution.${decision}`, { type: 'admin', id: admin.id }, { note: note ?? null });
  notify(
    userId,
    decision === 'verified' ? 'Institution verified' : `Institution ${decision}`,
    decision === 'verified' ? 'Diaspora-Direct payments for your registered purposes are now enabled.' : (note ?? 'Contact support for details.'),
    { kind: 'kyc' },
  );
  return getInstitution(userId)!;
}
/** A "DD" flagged static BitriQR for one purpose (printable, embeddable). */
export function institutionQr(merchant: UserRow, input: { purposeCode: string; currency: string; reference?: string | null; amountMinor?: number | null }) {
  const inst = getInstitution(merchant.id);
  if (!inst || inst.status !== 'verified') throw unprocessable('Only verified institutions issue Diaspora-Direct codes', 'institution_not_verified');
  const code = input.purposeCode.toUpperCase();
  if (!inst.purposeCodes.includes(code)) throw forbidden(`Your registration does not cover ${code}`, 'purpose_not_allowed');
  return createStaticQr(merchant, {
    currency: input.currency,
    purposeCode: code,
    reference: input.reference ?? null,
    kind: 'institution',
    sign: true,
    corridorFlag: 'DD',
    amount: input.amountMinor ?? null,
    rails: ['wallet', 'card', 'bank'],
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Purpose-locked quotes and payment
// ---------------------------------------------------------------------------------------------------------------------
export interface DiasporaQuote {
  id: string;
  payerId: string;
  beneficiaryId: string;
  beneficiary: ReturnType<typeof toPublicUser> | null;
  rateCardId: string;
  sourceCurrency: string;
  destCurrency: string;
  sourceMinor: number;
  feeMinor: number;
  destMinor: number;
  customerRate: number;
  purposeCode: string;
  reference: string | null;
  status: 'QUOTED' | 'PAID' | 'EXPIRED' | 'CANCELLED';
  transactionId: string | null;
  expiresAt: string;
  paidAt: string | null;
  createdAt: string;
  disclosure: { rateCard: RateCard | null; totalSourceMinor: number };
}
const toQuote = (r: any): DiasporaQuote => {
  const card = getDb().prepare('SELECT * FROM fx_rate_cards WHERE id = ?').get(r.rate_card_id) as any;
  const b = findUserById(r.beneficiary_user_id);
  return {
    id: r.id,
    payerId: r.payer_user_id,
    beneficiaryId: r.beneficiary_user_id,
    beneficiary: b ? toPublicUser(b) : null,
    rateCardId: r.rate_card_id,
    sourceCurrency: r.source_currency,
    destCurrency: r.dest_currency,
    sourceMinor: r.source_minor,
    feeMinor: r.fee_minor,
    destMinor: r.dest_minor,
    customerRate: r.customer_rate,
    purposeCode: r.purpose_code,
    reference: r.reference,
    status: r.status === 'QUOTED' && r.expires_at < now() ? 'EXPIRED' : r.status,
    transactionId: r.transaction_id,
    expiresAt: r.expires_at,
    paidAt: r.paid_at,
    createdAt: r.created_at,
    disclosure: { rateCard: card ? toCard(card) : null, totalSourceMinor: r.source_minor + r.fee_minor },
  };
};
export function assertPurposeAllowed(beneficiary: UserRow, purposeCode: string) {
  const code = purposeCode.toUpperCase();
  if (!PURPOSE_CODES.includes(code as any)) throw badRequest('Unsupported purpose code', 'invalid_purpose');
  if (!RESTRICTED_PURPOSES.includes(code as any)) return;
  const inst = getInstitution(beneficiary.id);
  if (!inst || inst.status !== 'verified' || !inst.purposeCodes.includes(code))
    throw unprocessable(`${code} payments can only go to an institution registered and verified for that purpose`, 'purpose_not_allowed', { purposeCode: code });
}
export function createQuote(
  payer: UserRow,
  input: { beneficiary: string; sourceCurrency: string; destCurrency?: string | null; sourceMinor?: number | null; destMinor?: number | null; purposeCode: string; reference?: string | null },
): DiasporaQuote {
  const beneficiary = findUserByIdentifier(input.beneficiary) ?? findUserById(input.beneficiary);
  if (!beneficiary || beneficiary.is_system || beneficiary.status !== 'active') throw notFound('Beneficiary not found', 'recipient_not_found');
  if (beneficiary.id === payer.id) throw badRequest('You cannot pay yourself', 'self_transfer');
  assertPurposeAllowed(beneficiary, input.purposeCode);
  const src = getCurrency(input.sourceCurrency);
  const dst = getCurrency(input.destCurrency ?? (getInstitution(beneficiary.id)?.country === 'CD' || beneficiary.country === 'CD' ? 'CDF' : 'USD'));
  const card = activeRateCard(src.code, dst.code);
  if (!card) throw unprocessable(`No Diaspora-Direct rate is published for ${src.code} → ${dst.code} right now`, 'no_rate_card');
  const policy = toPolicy(getDb().prepare('SELECT * FROM fx_rate_policies WHERE id = ?').get(card.policyId));
  let sourceMinor = input.sourceMinor ?? null;
  let destMinor = input.destMinor ?? null;
  const factor = 10 ** (dst.decimals - src.decimals);
  if (sourceMinor == null && destMinor != null) sourceMinor = Math.ceil(destMinor / card.customerRate / factor);
  if (sourceMinor == null || !Number.isInteger(sourceMinor) || sourceMinor <= 0) throw badRequest('Give the amount to send (sourceMinor) or the amount to deliver (destMinor)', 'invalid_amount');
  destMinor = Math.floor(sourceMinor * card.customerRate * factor);
  if (destMinor <= 0) throw badRequest('Amount too small', 'invalid_amount');
  if (policy.minSourceMinor && sourceMinor < policy.minSourceMinor) throw unprocessable(`Minimum is ${policy.minSourceMinor} ${src.code} minor units`, 'below_minimum');
  if (policy.maxSourceMinor && sourceMinor > policy.maxSourceMinor) throw unprocessable(`Maximum is ${policy.maxSourceMinor} ${src.code} minor units`, 'above_maximum');
  const fee = Math.round((sourceMinor * policy.feeBps) / 10_000) + policy.feeFixedSourceMinor;
  const id = `dq_${shortCode(12).toLowerCase()}`;
  const expiresAt = card.validUntil < new Date(Date.now() + 30 * 60_000).toISOString() ? card.validUntil : new Date(Date.now() + 30 * 60_000).toISOString();
  getDb()
    .prepare(
      'INSERT INTO diaspora_quotes (id, payer_user_id, beneficiary_user_id, rate_card_id, source_currency, dest_currency, source_minor, fee_minor, dest_minor, customer_rate, purpose_code, reference, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      payer.id,
      beneficiary.id,
      card.id,
      src.code,
      dst.code,
      sourceMinor,
      fee,
      destMinor,
      card.customerRate,
      input.purposeCode.toUpperCase(),
      input.reference ?? null,
      'QUOTED',
      expiresAt,
      now(),
    );
  publish(
    'diaspora.quote_created',
    { quoteId: id, payerId: payer.id, beneficiaryId: beneficiary.id, pair: `${src.code}/${dst.code}`, sourceMinor, destMinor, purposeCode: input.purposeCode.toUpperCase() },
    { aggregateId: id },
  );
  return getQuote(payer.id, id);
}
export function getQuote(payerId: string | null, id: string): DiasporaQuote {
  const r = getDb().prepare('SELECT * FROM diaspora_quotes WHERE id = ?').get(id) as any;
  if (!r || (payerId && r.payer_user_id !== payerId)) throw notFound('Quote not found', 'quote_not_found');
  return toQuote(r);
}
export function listQuotes(userId: string, limit = 50): DiasporaQuote[] {
  return (getDb().prepare('SELECT * FROM diaspora_quotes WHERE payer_user_id = ? OR beneficiary_user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, userId, limit) as any[]).map(toQuote);
}
/** Pay a quote from the payer's wallet in the source currency: one ledger transaction with a conversion leg at the card rate. */
export function payQuote(payer: UserRow, id: string, ctx: { stepUpVerified?: boolean; deviceHash?: string | null; ipCountry?: string | null } = {}): DiasporaQuote {
  const q = getQuote(payer.id, id);
  if (q.status === 'PAID') return q;
  if (q.status !== 'QUOTED') throw conflict(`Quote is ${q.status.toLowerCase()}; request a new one`, 'quote_expired');
  assertMoneyMovementAllowed('intent');
  const beneficiary = findUserById(q.beneficiaryId)!;
  assertPurposeAllowed(beneficiary, q.purposeCode);
  enforceLimits(payer, q.sourceMinor + q.feeMinor, q.sourceCurrency);
  enforceOutboundRisk({
    userId: payer.id,
    kind: 'remittance',
    amount: q.sourceMinor,
    currency: q.sourceCurrency,
    subjectType: 'diaspora_quote',
    subjectId: q.id,
    counterparty: { name: beneficiary.full_name, phone: beneficiary.phone, email: beneficiary.email, country: beneficiary.country },
    method: 'wallet',
    recipientUserId: beneficiary.id,
    stepUpVerified: ctx.stepUpVerified ?? false,
    deviceHash: ctx.deviceHash ?? null,
    ipCountry: ctx.ipCountry ?? null,
  });
  const from = getUserWallet(payer.id, q.sourceCurrency);
  const to = ensureWallet(beneficiary.id, q.destCurrency);
  const tx = postTransaction({
    type: 'remittance',
    amount: q.sourceMinor,
    fee: q.feeMinor,
    currency: q.sourceCurrency,
    fromWalletId: from.id,
    toWalletId: to.id,
    receiveAmount: q.destMinor,
    receiveCurrency: q.destCurrency,
    senderUserId: payer.id,
    receiverUserId: beneficiary.id,
    note: q.reference ?? `Diaspora-Direct ${q.purposeCode.toLowerCase().replace('_', ' ')} payment`,
    metadata: {
      method: 'wallet',
      diasporaDirect: true,
      quoteId: q.id,
      rateCardId: q.rateCardId,
      customerRate: q.customerRate,
      purposeCode: q.purposeCode,
      corridor: `${q.sourceCurrency}/${q.destCurrency}`,
    },
    idempotencyKey: `dd:${q.id}`,
  });
  getDb().prepare("UPDATE diaspora_quotes SET status = 'PAID', transaction_id = ?, paid_at = ? WHERE id = ?").run(tx.id, now(), q.id);
  recordEvent('corridor', q.id, 'dd.quote.paid', { type: 'user', id: payer.id }, { transactionId: tx.id, sourceMinor: q.sourceMinor, destMinor: q.destMinor, purposeCode: q.purposeCode });
  notify(
    beneficiary.id,
    `${q.purposeCode.replace('_', ' ')} payment received`,
    `${q.destMinor / 10 ** getCurrency(q.destCurrency, false).decimals} ${q.destCurrency} from ${payer.full_name}${q.reference ? ` (${q.reference})` : ''}.`,
    { kind: 'payment_received', transactionId: tx.id },
  );
  emitEvent(
    beneficiary.id,
    'payment.completed',
    { transaction: { id: tx.id, amount: q.destMinor, currency: q.destCurrency, method: 'diaspora_direct', purposeCode: q.purposeCode, quoteId: q.id } },
    { resource: { type: 'transaction', id: tx.id } },
  );
  return getQuote(payer.id, q.id);
}
export const purposeCatalogue = () => PURPOSE_CODES.map((c) => ({ code: c, restricted: RESTRICTED_PURPOSES.includes(c as any) }));
