/**
 * Government QR infrastructure (specification §105, §106): agencies collect fees and taxes through a merchant account
 * registered as a verified government institution; every service carries a revenue code; every citizen reference is
 * a payment intent with purpose GOVERNMENT_FEE or TAX and `metadata.gov` describing the agency, the service, the
 * citizen reference and the reconciliation code (a reusable institution QR is issued for fixed-amount services). The
 * reference is marked PAID from the bus event of the transaction that captured the intent and REFUNDED when the
 * gateway refund succeeds; the agency dashboard shows collections, revenue by service and region, settlement status,
 * unmatched credits, refunds and agent collections, and the audit export is a CSV of every reference.
 */
import { getDb } from '../db';
import { config } from '../config';
import { now, shortCode } from '../lib/ids';
import { parseJson } from '../lib/json';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { getCurrency } from './currencies';
import { findUserById, findUserByIdentifier, getUserById, toPublicUser, type UserRow } from './users';
import { recordEvent } from './events';
import { subscribe } from './bus';
import { hasPermission } from '../middleware/permissions';
import { createIntent, getIntentRow, intentView, type IntentRow } from './intents';
import { getInstitution, institutionQr, registerInstitution, reviewInstitution } from './diaspora';
import type { TransactionRow } from './ledger';

export const GOV_PURPOSES = ['GOVERNMENT_FEE', 'TAX'] as const;
export type GovReferenceStatus = 'OPEN' | 'PAID' | 'EXPIRED' | 'REFUNDED';
const CAPTURED_STATES = new Set(['CAPTURED', 'SETTLEMENT_PENDING', 'SETTLED', 'PARTIALLY_REFUNDED']);

export interface GovAgency {
  id: string;
  name: string;
  code: string;
  country: string;
  region: string | null;
  merchantUserId: string;
  merchant: ReturnType<typeof toPublicUser> | null;
  status: 'active' | 'suspended';
  createdAt: string;
}
export interface GovService {
  id: string;
  agencyId: string;
  name: string;
  revenueCode: string;
  purposeCode: (typeof GOV_PURPOSES)[number];
  currency: string;
  fixedAmountMinor: number | null;
  reusable: boolean;
  qrId: string | null;
  referenceTtlMinutes: number;
  status: 'active' | 'retired';
  createdAt: string;
}
export interface GovReference {
  id: string;
  agencyId: string;
  serviceId: string;
  citizenRef: string;
  region: string | null;
  amountMinor: number;
  currency: string;
  reconciliationCode: string;
  status: GovReferenceStatus;
  intentId: string | null;
  transactionId: string | null;
  payerUserId: string | null;
  agentUserId: string | null;
  expiresAt: string;
  paidAt: string | null;
  refundedAt: string | null;
  createdAt: string;
  payUrl: string | null;
}
const toAgency = (r: any): GovAgency => {
  const m = findUserById(r.merchant_user_id);
  return {
    id: r.id,
    name: r.name,
    code: r.code,
    country: r.country,
    region: r.region,
    merchantUserId: r.merchant_user_id,
    merchant: m ? toPublicUser(m) : null,
    status: r.status,
    createdAt: r.created_at,
  };
};
const toService = (r: any): GovService => ({
  id: r.id,
  agencyId: r.agency_id,
  name: r.name,
  revenueCode: r.revenue_code,
  purposeCode: r.purpose_code,
  currency: r.currency,
  fixedAmountMinor: r.fixed_amount_minor,
  reusable: !!r.reusable,
  qrId: r.qr_id,
  referenceTtlMinutes: r.reference_ttl_minutes,
  status: r.status,
  createdAt: r.created_at,
});
function toReference(r: any): GovReference {
  const request = r.intent_id
    ? (getDb().prepare('SELECT pr.code FROM payment_intents pi JOIN payment_requests pr ON pr.id = pi.payment_request_id WHERE pi.id = ?').get(r.intent_id) as { code: string } | undefined)
    : undefined;
  return {
    id: r.id,
    agencyId: r.agency_id,
    serviceId: r.service_id,
    citizenRef: r.citizen_ref,
    region: r.region,
    amountMinor: r.amount_minor,
    currency: r.currency,
    reconciliationCode: r.reconciliation_code,
    status: r.status,
    intentId: r.intent_id,
    transactionId: r.transaction_id,
    payerUserId: r.payer_user_id,
    agentUserId: r.agent_user_id,
    expiresAt: r.expires_at,
    paidAt: r.paid_at,
    refundedAt: r.refunded_at,
    createdAt: r.created_at,
    payUrl: request ? `${config.webUrl}/pay/${request.code}` : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Agencies, operators, services
// ---------------------------------------------------------------------------------------------------------------------
export function createAgency(admin: UserRow, input: { name: string; code: string; country: string; region?: string | null; merchant: string }): GovAgency {
  const merchant = findUserByIdentifier(input.merchant);
  if (!merchant || merchant.role !== 'merchant') throw notFound('The agency needs an existing merchant account to collect into', 'merchant_not_found');
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) throw badRequest('Agency code: 2–20 letters, digits, - or _', 'validation_error');
  const db = getDb();
  if (db.prepare('SELECT 1 FROM gov_agencies WHERE code = ?').get(code)) throw conflict('An agency with this code already exists', 'agency_code_taken');
  if (db.prepare('SELECT 1 FROM gov_agencies WHERE merchant_user_id = ?').get(merchant.id)) throw conflict('This merchant account already collects for an agency', 'agency_merchant_taken');
  const id = `ga_${shortCode(12).toLowerCase()}`;
  const ts = now();
  return db.transaction(() => {
    db.prepare('INSERT INTO gov_agencies (id, name, code, country, region, merchant_user_id, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      input.name.trim(),
      code,
      input.country.toUpperCase(),
      input.region ?? null,
      merchant.id,
      'active',
      admin.id,
      ts,
      ts,
    );
    db.prepare('INSERT OR IGNORE INTO gov_agency_operators (agency_id, user_id, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?)').run(id, merchant.id, 'owner', admin.id, ts);
    // The collecting account is a government institution registered and verified for fees and taxes, so purpose-locked
    // payments and Diaspora-Direct codes reach it.
    const inst = getInstitution(merchant.id);
    const codes = Array.from(new Set([...(inst?.purposeCodes ?? []), ...GOV_PURPOSES]));
    registerInstitution(merchant, { kind: 'government', name: input.name.trim(), registryRef: code, purposeCodes: codes, country: input.country.toUpperCase() });
    reviewInstitution(merchant.id, admin, 'verified', `government agency ${code}`);
    recordEvent('admin', id, 'gov.agency_created', { type: 'admin', id: admin.id }, { code, merchantUserId: merchant.id, country: input.country.toUpperCase() });
    return getAgency(id);
  })();
}
export function getAgency(id: string): GovAgency {
  const r = getDb().prepare('SELECT * FROM gov_agencies WHERE id = ? OR code = ?').get(id, id.toUpperCase());
  if (!r) throw notFound('Agency not found', 'agency_not_found');
  return toAgency(r);
}
export function addOperator(
  admin: UserRow,
  agencyId: string,
  input: { user: string; role?: 'owner' | 'operator' | 'auditor' },
): { agencyId: string; user: ReturnType<typeof toPublicUser>; role: string } {
  const a = getAgency(agencyId);
  const u = findUserByIdentifier(input.user);
  if (!u || u.is_system) throw notFound('User not found', 'user_not_found');
  getDb()
    .prepare('INSERT INTO gov_agency_operators (agency_id, user_id, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(agency_id, user_id) DO UPDATE SET role = excluded.role')
    .run(a.id, u.id, input.role ?? 'operator', admin.id, now());
  recordEvent('admin', a.id, 'gov.operator_added', { type: 'admin', id: admin.id }, { userId: u.id, role: input.role ?? 'operator' });
  return { agencyId: a.id, user: toPublicUser(u), role: input.role ?? 'operator' };
}
/** Agencies this account may operate: every agency for administrators, otherwise those it is an operator of. */
export function agenciesFor(user: UserRow): GovAgency[] {
  const db = getDb();
  if (user.role === 'admin') return (db.prepare('SELECT * FROM gov_agencies ORDER BY name').all() as any[]).map(toAgency);
  return (db.prepare('SELECT a.* FROM gov_agencies a JOIN gov_agency_operators o ON o.agency_id = a.id WHERE o.user_id = ? ORDER BY a.name').all(user.id) as any[]).map(toAgency);
}
export function assertOperator(user: UserRow, agencyId: string): GovAgency {
  const a = getAgency(agencyId);
  if (user.role === 'admin') return a;
  if (!getDb().prepare('SELECT 1 FROM gov_agency_operators WHERE agency_id = ? AND user_id = ?').get(a.id, user.id)) throw forbidden('You do not operate this agency', 'not_agency_operator');
  return a;
}
export function createService(
  actor: UserRow,
  agencyId: string,
  input: { name: string; revenueCode: string; purposeCode?: string | null; currency: string; fixedAmountMinor?: number | null; reusable?: boolean; referenceTtlMinutes?: number | null },
): GovService {
  const a = assertOperator(actor, agencyId);
  const cur = getCurrency(input.currency);
  const purpose = (input.purposeCode ?? 'GOVERNMENT_FEE').toUpperCase();
  if (!(GOV_PURPOSES as readonly string[]).includes(purpose)) throw badRequest('Purpose must be GOVERNMENT_FEE or TAX', 'invalid_purpose');
  if (input.fixedAmountMinor != null && (!Number.isInteger(input.fixedAmountMinor) || input.fixedAmountMinor <= 0))
    throw badRequest('fixedAmountMinor must be a positive integer in minor units', 'invalid_amount');
  const revenueCode = input.revenueCode.trim().toUpperCase();
  const db = getDb();
  if (db.prepare('SELECT 1 FROM gov_services WHERE agency_id = ? AND revenue_code = ?').get(a.id, revenueCode)) throw conflict('This revenue code already exists for the agency', 'revenue_code_taken');
  const id = `gs_${shortCode(12).toLowerCase()}`;
  const ts = now();
  return db.transaction(() => {
    // A reusable service with a fixed amount gets a signed institution QR that citizens can scan again and again.
    let qrId: string | null = null;
    if (input.reusable && input.fixedAmountMinor) {
      const merchant = getUserById(a.merchantUserId);
      qrId = institutionQr(merchant, { purposeCode: purpose, currency: cur.code, reference: `${a.code}-${revenueCode}`, amountMinor: input.fixedAmountMinor }).id;
    }
    db.prepare(
      'INSERT INTO gov_services (id, agency_id, name, revenue_code, purpose_code, currency, fixed_amount_minor, reusable, qr_id, reference_ttl_minutes, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, a.id, input.name.trim(), revenueCode, purpose, cur.code, input.fixedAmountMinor ?? null, input.reusable ? 1 : 0, qrId, input.referenceTtlMinutes ?? 4320, 'active', ts, ts);
    recordEvent(
      'admin',
      a.id,
      'gov.service_created',
      { type: actor.role === 'admin' ? 'admin' : 'merchant', id: actor.id },
      { serviceId: id, revenueCode, purpose, currency: cur.code, fixedAmountMinor: input.fixedAmountMinor ?? null, qrId },
    );
    return getService(id);
  })();
}
export function getService(id: string): GovService {
  const r = getDb().prepare('SELECT * FROM gov_services WHERE id = ?').get(id);
  if (!r) throw notFound('Service not found', 'service_not_found');
  return toService(r);
}
export function listServices(agencyId: string): GovService[] {
  return (getDb().prepare('SELECT * FROM gov_services WHERE agency_id = ? ORDER BY revenue_code').all(agencyId) as any[]).map(toService);
}

// ---------------------------------------------------------------------------------------------------------------------
// References: one payment intent per citizen reference
// ---------------------------------------------------------------------------------------------------------------------
export function createReference(
  actor: UserRow,
  serviceId: string,
  input: { citizenRef: string; amountMinor?: number | null; region?: string | null; expiresInMinutes?: number | null },
): { reference: GovReference; intent: ReturnType<typeof intentView> } {
  const service = getService(serviceId);
  if (service.status !== 'active') throw conflict('Service is retired', 'service_retired');
  const agency = getAgency(service.agencyId);
  // operators and administrators issue references for their agency; agents issue them at the counter for citizens
  if (actor.role !== 'agent') assertOperator(actor, agency.id);
  const amount = service.fixedAmountMinor ?? input.amountMinor ?? null;
  if (!amount || !Number.isInteger(amount) || amount <= 0) throw badRequest('This service has no fixed amount: provide amountMinor', 'amount_required');
  if (service.fixedAmountMinor && input.amountMinor != null && input.amountMinor !== service.fixedAmountMinor) throw badRequest('The amount of this service is fixed', 'amount_fixed');
  const citizenRef = input.citizenRef.trim();
  if (citizenRef.length < 2 || citizenRef.length > 80) throw badRequest('citizenRef must be 2–80 characters', 'validation_error');
  const merchant = getUserById(agency.merchantUserId);
  const id = `gr_${shortCode(12).toLowerCase()}`;
  const reconciliationCode = `${agency.code}-${service.revenueCode}-${shortCode(8)}`;
  const ttl = Math.max(5, input.expiresInMinutes ?? service.referenceTtlMinutes);
  const db = getDb();
  return db.transaction(() => {
    const { row } = createIntent(merchant, {
      amountMinor: amount,
      currency: service.currency,
      purposeCode: service.purposeCode,
      reference: reconciliationCode,
      description: `${service.name} · ${citizenRef}`,
      expiresInMinutes: ttl,
      source: 'qr',
      qrId: service.qrId,
      metadata: {
        gov: {
          agencyId: agency.id,
          agencyCode: agency.code,
          serviceId: service.id,
          revenueCode: service.revenueCode,
          referenceId: id,
          citizenRef,
          reconciliationCode,
          region: input.region ?? agency.region ?? null,
          agentUserId: actor.role === 'agent' ? actor.id : null,
        },
      },
      idemKey: `gov:${id}`,
    });
    const ts = now();
    db.prepare(
      'INSERT INTO gov_references (id, agency_id, service_id, citizen_ref, region, amount_minor, currency, reconciliation_code, status, intent_id, agent_user_id, expires_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      agency.id,
      service.id,
      citizenRef,
      input.region ?? agency.region ?? null,
      amount,
      service.currency,
      reconciliationCode,
      'OPEN',
      row.id,
      actor.role === 'agent' ? actor.id : null,
      row.expires_at ?? new Date(Date.now() + ttl * 60_000).toISOString(),
      actor.id,
      ts,
      ts,
    );
    recordEvent(
      'payment',
      id,
      'gov.reference_created',
      { type: actor.role === 'admin' ? 'admin' : actor.role === 'agent' ? 'agent' : 'merchant', id: actor.id },
      { intentId: row.id, amount, currency: service.currency, revenueCode: service.revenueCode, reconciliationCode },
    );
    return { reference: getReference(id), intent: intentView(getIntentRow(row.id)) };
  })();
}
export function getReference(idOrCode: string): GovReference {
  const r = getDb().prepare('SELECT * FROM gov_references WHERE id = ? OR reconciliation_code = ? OR intent_id = ?').get(idOrCode, idOrCode.toUpperCase(), idOrCode);
  if (!r) throw notFound('Reference not found', 'reference_not_found');
  return toReference(r);
}
export function listReferences(filter: { agencyId?: string | null; status?: string | null; from?: string | null; to?: string | null; limit?: number } = {}): GovReference[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.agencyId) {
    where.push('agency_id = ?');
    params.push(filter.agencyId);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.from) {
    where.push('created_at >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('created_at <= ?');
    params.push(filter.to);
  }
  return (
    getDb()
      .prepare(`SELECT * FROM gov_references ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, Math.min(5000, filter.limit ?? 500)) as any[]
  ).map(toReference);
}

function markPaid(ref: any, tx: TransactionRow | null, at: string): void {
  const payer = tx?.sender_user_id ? findUserById(tx.sender_user_id) : undefined;
  const meta = tx ? parseJson<Record<string, any>>(tx.metadata, {}) : {};
  const agentId = ref.agent_user_id ?? (payer?.role === 'agent' ? payer.id : typeof meta.agentId === 'string' ? meta.agentId : null);
  getDb()
    .prepare(
      "UPDATE gov_references SET status = 'PAID', transaction_id = COALESCE(?, transaction_id), payer_user_id = COALESCE(?, payer_user_id), agent_user_id = COALESCE(?, agent_user_id), paid_at = ?, updated_at = ? WHERE id = ? AND status = 'OPEN'",
    )
    .run(tx?.id ?? null, tx?.sender_user_id ?? null, agentId, at, now(), ref.id);
  recordEvent(
    'payment',
    ref.id,
    'gov.reference_paid',
    { type: 'system' },
    { transactionId: tx?.id ?? null, intentId: ref.intent_id, amount: ref.amount_minor, currency: ref.currency, reconciliationCode: ref.reconciliation_code },
  );
}
function markRefunded(ref: any, refundId: string | null): void {
  getDb().prepare("UPDATE gov_references SET status = 'REFUNDED', refunded_at = ?, updated_at = ? WHERE id = ? AND status = 'PAID'").run(now(), now(), ref.id);
  recordEvent('payment', ref.id, 'gov.reference_refunded', { type: 'system' }, { refundId, intentId: ref.intent_id });
}
/** Expire open references past their expiry and align any reference whose intent was captured or refunded without the bus. */
export function syncGovReferences(): { expired: number; paid: number; refunded: number } {
  const db = getDb();
  const ts = now();
  let paid = 0;
  let refunded = 0;
  for (const r of db.prepare("SELECT * FROM gov_references WHERE status IN ('OPEN', 'PAID') AND intent_id IS NOT NULL").all() as any[]) {
    const intent = db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(r.intent_id) as IntentRow | undefined;
    if (!intent) continue;
    if (r.status === 'OPEN' && CAPTURED_STATES.has(intent.status)) {
      const tx = intent.transaction_id ? (db.prepare('SELECT * FROM transactions WHERE id = ?').get(intent.transaction_id) as TransactionRow | undefined) : undefined;
      markPaid(r, tx ?? null, intent.succeeded_at ?? ts);
      paid += 1;
    } else if (r.status === 'PAID' && intent.status === 'REFUNDED') {
      markRefunded(r, null);
      refunded += 1;
    }
  }
  const expired = db.prepare("UPDATE gov_references SET status = 'EXPIRED', updated_at = ? WHERE status = 'OPEN' AND expires_at < ?").run(ts, ts).changes;
  return { expired, paid, refunded };
}

// ---------------------------------------------------------------------------------------------------------------------
// Dashboard and audit export
// ---------------------------------------------------------------------------------------------------------------------
const PAYMENT_TYPES = "('merchant_payment', 'qr_payment', 'transfer', 'money_request', 'card_deposit', 'bank_deposit', 'mobile_money_deposit', 'remittance', 'distribution')";
export function agencyDashboard(user: UserRow, filter: { agencyId?: string | null; from?: string | null; to?: string | null } = {}) {
  syncGovReferences();
  const db = getDb();
  const agencies = filter.agencyId ? [assertOperator(user, filter.agencyId)] : agenciesFor(user);
  const ids = agencies.map((a) => a.id);
  const merchantIds = agencies.map((a) => a.merchantUserId);
  const from = filter.from ?? '0000';
  const to = filter.to ?? '9999';
  if (!ids.length)
    return {
      agencies: [],
      collections: [],
      byService: [],
      byRegion: [],
      byStatus: {},
      settlement: [],
      unmatched: [],
      refunds: { count: 0, byCurrency: [] },
      agentCollections: [],
      window: { from: filter.from ?? null, to: filter.to ?? null },
    };
  const inAgencies = `agency_id IN (${ids.map(() => '?').join(',')})`;
  const inMerchants = `IN (${merchantIds.map(() => '?').join(',')})`;
  const collections = db
    .prepare(
      `SELECT currency, COUNT(*) count, COALESCE(SUM(amount_minor), 0) total FROM gov_references WHERE ${inAgencies} AND status = 'PAID' AND paid_at >= ? AND paid_at <= ? GROUP BY currency ORDER BY currency`,
    )
    .all(...ids, from, to) as { currency: string; count: number; total: number }[];
  const byService = db
    .prepare(
      `SELECT s.id serviceId, s.name, s.revenue_code revenueCode, a.code agencyCode, r.currency, COUNT(*) count, COALESCE(SUM(r.amount_minor), 0) total FROM gov_references r JOIN gov_services s ON s.id = r.service_id JOIN gov_agencies a ON a.id = r.agency_id WHERE r.${inAgencies} AND r.status = 'PAID' AND r.paid_at >= ? AND r.paid_at <= ? GROUP BY s.id, r.currency ORDER BY total DESC`,
    )
    .all(...ids, from, to);
  const byRegion = db
    .prepare(
      `SELECT COALESCE(region, 'unspecified') region, currency, COUNT(*) count, COALESCE(SUM(amount_minor), 0) total FROM gov_references WHERE ${inAgencies} AND status = 'PAID' AND paid_at >= ? AND paid_at <= ? GROUP BY 1, 2 ORDER BY total DESC`,
    )
    .all(...ids, from, to);
  const byStatus = (
    db
      .prepare(`SELECT status, COUNT(*) c, COALESCE(SUM(amount_minor), 0) total FROM gov_references WHERE ${inAgencies} AND created_at >= ? AND created_at <= ? GROUP BY status`)
      .all(...ids, from, to) as any[]
  ).reduce((acc, r) => ({ ...acc, [r.status]: { count: r.c, total: r.total } }), {} as Record<string, { count: number; total: number }>);
  const settlement = db
    .prepare(
      `SELECT user_id merchantUserId, currency, status, COUNT(*) cycles, COALESCE(SUM(net_minor), 0) net FROM settlement_cycles WHERE user_id ${inMerchants} GROUP BY user_id, currency, status ORDER BY user_id, currency, status`,
    )
    .all(...merchantIds);
  // Money that reached an agency account without a reference behind it: a transfer, a direct QR scan, a deposit.
  const unmatched = (
    db
      .prepare(
        `SELECT t.id, t.reference, t.type, t.amount, t.currency, t.sender_user_id senderUserId, t.receiver_user_id merchantUserId, t.intent_id intentId, t.created_at createdAt FROM transactions t WHERE t.receiver_user_id ${inMerchants} AND t.status = 'completed' AND t.type IN ${PAYMENT_TYPES} AND t.created_at >= ? AND t.created_at <= ? AND NOT EXISTS (SELECT 1 FROM gov_references g WHERE g.transaction_id = t.id OR (t.intent_id IS NOT NULL AND g.intent_id = t.intent_id)) ORDER BY t.created_at DESC LIMIT 200`,
      )
      .all(...merchantIds, from, to) as any[]
  ).map((t) => {
    const sender = t.senderUserId ? findUserById(t.senderUserId) : undefined;
    return { ...t, sender: sender ? toPublicUser(sender) : null };
  });
  const refundRows = db
    .prepare(
      `SELECT currency, COUNT(*) c, COALESCE(SUM(amount_minor), 0) total FROM gov_references WHERE ${inAgencies} AND status = 'REFUNDED' AND refunded_at >= ? AND refunded_at <= ? GROUP BY currency`,
    )
    .all(...ids, from, to) as any[];
  const agentCollections = (
    db
      .prepare(
        `SELECT agent_user_id agentUserId, currency, COUNT(*) count, COALESCE(SUM(amount_minor), 0) total FROM gov_references WHERE ${inAgencies} AND status = 'PAID' AND agent_user_id IS NOT NULL AND paid_at >= ? AND paid_at <= ? GROUP BY agent_user_id, currency ORDER BY total DESC`,
      )
      .all(...ids, from, to) as any[]
  ).map((r) => {
    const agent = findUserById(r.agentUserId);
    return { ...r, agent: agent ? toPublicUser(agent) : null };
  });
  return {
    agencies,
    window: { from: filter.from ?? null, to: filter.to ?? null },
    collections,
    byService,
    byRegion,
    byStatus,
    settlement,
    unmatched,
    refunds: { count: refundRows.reduce((a, r) => a + r.c, 0), byCurrency: refundRows.map((r) => ({ currency: r.currency, count: r.c, total: r.total })) },
    agentCollections,
  };
}
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function auditExportCsv(user: UserRow, filter: { agencyId?: string | null; from?: string | null; to?: string | null } = {}): string {
  syncGovReferences();
  const agencies = filter.agencyId ? [assertOperator(user, filter.agencyId)] : agenciesFor(user);
  const services = new Map<string, GovService>();
  const header = [
    'reconciliation_code',
    'agency_code',
    'agency_name',
    'service',
    'revenue_code',
    'purpose_code',
    'citizen_ref',
    'region',
    'amount_minor',
    'currency',
    'status',
    'intent_id',
    'transaction_id',
    'payer_user_id',
    'agent_user_id',
    'created_at',
    'paid_at',
    'refunded_at',
    'expires_at',
  ];
  const lines = [header.join(',')];
  for (const a of agencies) {
    for (const r of listReferences({ agencyId: a.id, from: filter.from, to: filter.to, limit: 5000 })) {
      const s = services.get(r.serviceId) ?? services.set(r.serviceId, getService(r.serviceId)).get(r.serviceId)!;
      lines.push(
        [
          r.reconciliationCode,
          a.code,
          a.name,
          s.name,
          s.revenueCode,
          s.purposeCode,
          r.citizenRef,
          r.region,
          r.amountMinor,
          r.currency,
          r.status,
          r.intentId,
          r.transactionId,
          r.payerUserId,
          r.agentUserId,
          r.createdAt,
          r.paidAt,
          r.refundedAt,
          r.expiresAt,
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
/** Whether the account may read a given reference: operators of the agency, administrators, the payer, the issuing agent. */
export function canReadReference(user: UserRow, ref: GovReference): boolean {
  if (user.role === 'admin' && hasPermission(user as any, 'reports')) return true;
  if (ref.payerUserId === user.id || ref.agentUserId === user.id) return true;
  return !!getDb().prepare('SELECT 1 FROM gov_agency_operators WHERE agency_id = ? AND user_id = ?').get(ref.agencyId, user.id);
}

// ---------------------------------------------------------------------------------------------------------------------
// Bus: the captured intent's transaction marks the reference PAID; a succeeded refund marks it REFUNDED.
// ---------------------------------------------------------------------------------------------------------------------
const HOOK = Symbol.for('bitripay.government.subscribed');
if (!(globalThis as any)[HOOK]) {
  (globalThis as any)[HOOK] = true;
  subscribe('gov_references', ['transaction.created', 'transaction.settled'], (ev) => {
    const id = ev.payload.transactionId as string | undefined;
    if (!id) return;
    const db = getDb();
    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as TransactionRow | undefined;
    if (!tx || tx.status !== 'completed') return;
    const intentId = tx.intent_id ?? parseJson<Record<string, any>>(tx.metadata, {}).intentId ?? null;
    if (!intentId) return;
    const ref = db.prepare("SELECT * FROM gov_references WHERE intent_id = ? AND status = 'OPEN'").get(intentId) as any;
    if (ref) markPaid(ref, tx, tx.completed_at ?? tx.created_at);
  });
  subscribe('gov_references.refunds', ['refund.succeeded'], (ev) => {
    const intentId = ev.payload.intentId as string | null | undefined;
    if (!intentId) return;
    const ref = getDb().prepare("SELECT * FROM gov_references WHERE intent_id = ? AND status = 'PAID'").get(intentId) as any;
    if (ref) markRefunded(ref, (ev.payload.refundId as string) ?? null);
  });
}
