/**
 * Country / operator / corridor registry and the compliance gate.
 * A corridor is "money in (source currency) → money out (destination country, operator, currency)".
 * Every corridor starts in `sandbox`; only a corridor an administrator has marked `live` – with named
 * collection and payout partners and a licence reference – may carry real customer funds, and only
 * when the platform itself runs in compliance mode `live`.
 */
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { getComplianceSettings } from './settings';
import { parseJson } from '../lib/json';
import { recordEvent, type Actor } from './events';
import { getOperator } from './momo';

export interface Corridor {
  id: string;
  sourceCountry: string | null;
  sourceCurrency: string;
  destCountry: string;
  destCurrency: string;
  operatorId: string | null;
  rail: 'mobile_money' | 'bank' | 'agent';
  status: 'sandbox' | 'live' | 'suspended';
  collectionPartner: string | null;
  payoutPartner: string | null;
  licenceRef: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  estimatedPayoutMinutes: number;
  maxAmount: number;
  notes: string | null;
  enabled: boolean;
  /** Structured regulatory arrangements. */
  compliance: CorridorCompliance;
  licenceExpiresAt: string | null;
  readiness: { ready: boolean; missing: string[]; warnings: string[] };
  createdAt: string;
  updatedAt: string;
}

export interface CorridorCompliance {
  regulator?: string | null;
  licenceType?: string | null;
  licenceNumber?: string | null;
  safeguardingAccount?: string | null;
  amlProgrammeRef?: string | null;
  dataProtectionRef?: string | null;
  fxApprovalRef?: string | null;
  consumerDisclosureUrl?: string | null;
  agentSupervisionRef?: string | null;
}
const MANDATORY: { key: keyof CorridorCompliance; label: string }[] = [
  { key: 'regulator', label: 'Regulator / competent authority' },
  { key: 'licenceType', label: 'Licence type (e.g. payment institution, remittance licence)' },
  { key: 'licenceNumber', label: 'Licence number' },
  { key: 'safeguardingAccount', label: 'Client-fund safeguarding account' },
  { key: 'amlProgrammeRef', label: 'AML / KYC programme reference' },
];
const RECOMMENDED: { key: keyof CorridorCompliance; label: string }[] = [
  { key: 'dataProtectionRef', label: 'Data-protection registration' },
  { key: 'fxApprovalRef', label: 'FX / mobile-money approval in the destination country' },
  { key: 'consumerDisclosureUrl', label: 'Consumer disclosure / terms URL' },
  { key: 'agentSupervisionRef', label: 'Agent due-diligence & supervision procedure' },
];

/** What still stands between this corridor and live funds. */
export function corridorReadiness(r: { collection_partner: string | null; payout_partner: string | null; licence_ref: string | null; compliance: string; licence_expires_at: string | null; operator_id: string | null; dest_currency: string; rail: string }): Corridor['readiness'] {
  const c: CorridorCompliance = parseJson(r.compliance, {});
  const missing: string[] = [];
  const warnings: string[] = [];
  if (!r.collection_partner) missing.push('Authorised collection partner');
  if (!r.payout_partner) missing.push('Authorised payout partner');
  if (!r.licence_ref) missing.push('Licence / authorisation reference');
  for (const m of MANDATORY) if (!c[m.key]) missing.push(m.label);
  if (!r.licence_expires_at) missing.push('Licence expiry date');
  else if (new Date(r.licence_expires_at).getTime() < Date.now()) missing.push('Licence has expired');
  else if (new Date(r.licence_expires_at).getTime() < Date.now() + 30 * 86_400_000) warnings.push('Licence expires within 30 days');
  for (const m of RECOMMENDED) if (!c[m.key]) warnings.push(`${m.label} not recorded`);
  const db = getDb();
  const accounts = db.prepare("SELECT a.agent_user_id, u.kyc_status FROM payout_accounts a LEFT JOIN users u ON u.id = a.agent_user_id WHERE a.rail = ? AND a.currency = ? AND (a.operator_id = ? OR ? IS NULL) AND a.status = 'active'").all(r.rail, r.dest_currency, r.operator_id, r.operator_id) as any[];
  if (!accounts.length) warnings.push('No active prefunded payout account for this corridor');
  if (accounts.some((a) => a.agent_user_id && a.kyc_status !== 'verified')) missing.push('Every operating agent must pass due diligence (KYC verified)');
  return { ready: missing.length === 0, missing, warnings };
}

function toCorridor(r: any): Corridor {
  return { compliance: parseJson(r.compliance, {}), licenceExpiresAt: r.licence_expires_at ?? null, readiness: corridorReadiness(r), id: r.id, sourceCountry: r.source_country, sourceCurrency: r.source_currency, destCountry: r.dest_country, destCurrency: r.dest_currency, operatorId: r.operator_id, rail: r.rail, status: r.status, collectionPartner: r.collection_partner, payoutPartner: r.payout_partner, licenceRef: r.licence_ref, approvedBy: r.approved_by, approvedAt: r.approved_at, estimatedPayoutMinutes: r.estimated_payout_minutes, maxAmount: r.max_amount, notes: r.notes, enabled: !!r.enabled, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function listCorridors(): Corridor[] {
  return (getDb().prepare('SELECT * FROM corridors ORDER BY dest_country, operator_id, source_currency').all() as any[]).map(toCorridor);
}
export function getCorridor(id: string): Corridor {
  const r = getDb().prepare('SELECT * FROM corridors WHERE id = ?').get(id);
  if (!r) throw notFound('Corridor not found', 'corridor_not_found');
  return toCorridor(r);
}

export function upsertCorridor(input: Partial<Omit<Corridor, 'compliance'>> & { sourceCurrency: string; destCountry: string; destCurrency: string; rail?: Corridor['rail']; compliance?: CorridorCompliance | null; licenceExpiresAt?: string | null }, actor?: Actor): Corridor {
  const db = getDb();
  if (input.operatorId) getOperator(input.operatorId);
  // One corridor per (source currency, destination, operator, rail): re-registering updates it instead of duplicating.
  const byKey = !input.id ? (db.prepare('SELECT * FROM corridors WHERE source_currency = ? AND dest_country = ? AND dest_currency = ? AND rail = ? AND operator_id IS ?').get(input.sourceCurrency.toUpperCase(), input.destCountry.toUpperCase(), input.destCurrency.toUpperCase(), input.rail ?? 'mobile_money', input.operatorId ?? null) as any) : null;
  const id = input.id ?? byKey?.id ?? uuid();
  const existing = input.id ? (db.prepare('SELECT * FROM corridors WHERE id = ?').get(id) as any) : byKey;
  const status = input.status ?? existing?.status ?? 'sandbox';
  db.prepare(
    `INSERT INTO corridors (id, source_country, source_currency, dest_country, dest_currency, operator_id, rail, status, collection_partner, payout_partner, licence_ref, approved_by, approved_at, estimated_payout_minutes, max_amount, notes, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET source_country = excluded.source_country, source_currency = excluded.source_currency, dest_country = excluded.dest_country, dest_currency = excluded.dest_currency, operator_id = excluded.operator_id, rail = excluded.rail, status = excluded.status, collection_partner = excluded.collection_partner, payout_partner = excluded.payout_partner, licence_ref = excluded.licence_ref, approved_by = excluded.approved_by, approved_at = excluded.approved_at, estimated_payout_minutes = excluded.estimated_payout_minutes, max_amount = excluded.max_amount, notes = excluded.notes, enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).run(id, input.sourceCountry ?? existing?.source_country ?? null, input.sourceCurrency.toUpperCase(), input.destCountry.toUpperCase(), input.destCurrency.toUpperCase(), input.operatorId ?? existing?.operator_id ?? null, input.rail ?? existing?.rail ?? 'mobile_money', status, input.collectionPartner ?? existing?.collection_partner ?? null, input.payoutPartner ?? existing?.payout_partner ?? null, input.licenceRef ?? existing?.licence_ref ?? null, existing?.approved_by ?? null, existing?.approved_at ?? null, input.estimatedPayoutMinutes ?? existing?.estimated_payout_minutes ?? 60, input.maxAmount ?? existing?.max_amount ?? 0, input.notes ?? existing?.notes ?? null, input.enabled === false ? 0 : 1, existing?.created_at ?? now(), now());
  if (input.compliance !== undefined || input.licenceExpiresAt !== undefined) db.prepare('UPDATE corridors SET compliance = ?, licence_expires_at = ? WHERE id = ?').run(JSON.stringify({ ...parseJson(existing?.compliance, {}), ...(input.compliance ?? {}) }), input.licenceExpiresAt === undefined ? existing?.licence_expires_at ?? null : input.licenceExpiresAt, id);
  recordEvent('corridor', id, existing ? 'corridor.updated' : 'corridor.created', actor ?? { type: 'system' }, { status, destCountry: input.destCountry, operatorId: input.operatorId ?? null });
  return getCorridor(id);
}

/** Going live is an explicit, attributable administrative act that needs the regulatory arrangements on record. */
export function setCorridorStatus(id: string, status: Corridor['status'], admin: { id: string }, arrangements: { collectionPartner?: string | null; payoutPartner?: string | null; licenceRef?: string | null; notes?: string | null; compliance?: CorridorCompliance | null; licenceExpiresAt?: string | null } = {}): Corridor {
  const c = getCorridor(id);
  const collection = arrangements.collectionPartner ?? c.collectionPartner;
  const payout = arrangements.payoutPartner ?? c.payoutPartner;
  const licence = arrangements.licenceRef ?? c.licenceRef;
  if (arrangements.compliance || arrangements.licenceExpiresAt !== undefined) getDb().prepare('UPDATE corridors SET compliance = ?, licence_expires_at = ? WHERE id = ?').run(JSON.stringify({ ...c.compliance, ...(arrangements.compliance ?? {}) }), arrangements.licenceExpiresAt === undefined ? c.licenceExpiresAt : arrangements.licenceExpiresAt, id);
  if (status === 'live') {
    const row = getDb().prepare('SELECT * FROM corridors WHERE id = ?').get(id) as any;
    const readiness = corridorReadiness({ ...row, collection_partner: collection, payout_partner: payout, licence_ref: licence });
    if (!readiness.ready) throw badRequest(`This corridor cannot go live yet: ${readiness.missing.join('; ')}`, 'corridor_arrangements_required', readiness);
  }
  getDb().prepare('UPDATE corridors SET status = ?, collection_partner = ?, payout_partner = ?, licence_ref = ?, notes = COALESCE(?, notes), approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?').run(status, collection, payout, licence, arrangements.notes ?? null, status === 'live' ? admin.id : c.approvedBy, status === 'live' ? now() : c.approvedAt, now(), id);
  recordEvent('corridor', id, `corridor.${status}`, { type: 'admin', id: admin.id }, { collectionPartner: collection, payoutPartner: payout, licenceRef: licence });
  return getCorridor(id);
}

/** Live corridors whose licence has lapsed are suspended automatically; nearing expiry is logged so operators can renew. */
export function enforceLicenceExpiry(): { suspended: string[]; expiring: string[] } {
  const db = getDb();
  const suspended: string[] = [];
  const expiring: string[] = [];
  for (const r of db.prepare("SELECT id, licence_expires_at FROM corridors WHERE status = 'live'").all() as any[]) {
    if (!r.licence_expires_at) continue;
    const t = new Date(r.licence_expires_at).getTime();
    if (t < Date.now()) {
      db.prepare("UPDATE corridors SET status = 'suspended', updated_at = ? WHERE id = ?").run(now(), r.id);
      recordEvent('corridor', r.id, 'corridor.suspended', { type: 'system' }, { reason: 'licence_expired', licenceExpiresAt: r.licence_expires_at });
      suspended.push(r.id);
    } else if (t < Date.now() + 30 * 86_400_000) expiring.push(r.id);
  }
  return { suspended, expiring };
}

export function deleteCorridor(id: string) {
  getDb().prepare('DELETE FROM corridors WHERE id = ?').run(id);
}

/** Best matching corridor for a destination: operator-specific first, then country-wide, for the given source currency or any. */
export function findCorridor(q: { sourceCurrency: string; destCountry: string; destCurrency: string; operatorId?: string | null; rail: Corridor['rail'] }): Corridor | null {
  const rows = getDb().prepare('SELECT * FROM corridors WHERE enabled = 1 AND rail = ? AND dest_country = ? AND dest_currency = ? AND (operator_id = ? OR operator_id IS NULL) AND (source_currency = ? OR source_currency = ?) ').all(q.rail, q.destCountry.toUpperCase(), q.destCurrency.toUpperCase(), q.operatorId ?? null, q.sourceCurrency.toUpperCase(), '*') as any[];
  if (!rows.length) return null;
  rows.sort((a, b) => (b.operator_id ? 1 : 0) - (a.operator_id ? 1 : 0) || (b.source_currency !== '*' ? 1 : 0) - (a.source_currency !== '*' ? 1 : 0));
  return toCorridor(rows[0]);
}

/** In sandbox mode unknown corridors are registered automatically (status sandbox) so operators see what customers ask for. */
export function ensureCorridor(q: { sourceCountry?: string | null; sourceCurrency: string; destCountry: string; destCurrency: string; operatorId?: string | null; rail: Corridor['rail'] }): Corridor {
  const found = findCorridor(q);
  if (found) return found;
  return upsertCorridor({ sourceCountry: q.sourceCountry ?? null, sourceCurrency: q.sourceCurrency, destCountry: q.destCountry, destCurrency: q.destCurrency, operatorId: q.operatorId ?? null, rail: q.rail, status: 'sandbox', notes: 'Auto-registered from a customer request. Sandbox only until authorised.' });
}

export const SANDBOX_PROVIDERS = ['sandbox', 'manual_bank', 'manual_momo'];

/**
 * Compliance gate. Live customer funds are accepted only when the platform is in live mode AND the
 * corridor is live. Sandbox / direct-rail providers are always allowed (they carry no processor funds
 * in sandbox mode and are confirmed by evidence anyway).
 */
export function assertCorridorAllowed(corridor: Corridor | null, fundingProvider: string | null | undefined) {
  const c = getComplianceSettings();
  const realProcessor = !!fundingProvider && !SANDBOX_PROVIDERS.includes(fundingProvider);
  if (c.mode === 'sandbox' && realProcessor) throw forbidden('This platform runs in sandbox mode: live customer funds are not accepted until each corridor has authorised collection, settlement and payout arrangements.', 'compliance_sandbox_mode');
  if (!corridor) return;
  if (corridor.status === 'suspended') throw forbidden('This corridor is suspended', 'corridor_suspended');
  if (realProcessor && corridor.status !== 'live') throw forbidden(`The ${corridor.destCountry} corridor is not authorised for live funds yet (status: ${corridor.status}). Sandbox payments only.`, 'corridor_not_live');
}
