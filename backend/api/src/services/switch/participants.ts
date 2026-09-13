/**
 * CMP-06 Participant registry: official codes, kinds, services, currencies, channels, validity dates and routing
 * identifiers, versioned, with the author distinct from the approver. Capability is never inferred from a trade
 * name: a service is open for a (debtor, creditor, currency, product, channel) tuple only when every factor of the
 * intersection rule holds (§5) and the pair has passed its test. Simulation participants are seeded for the
 * simulator and are labelled SIMULATION; official entries come from the scheme's signed directory (BCC-05).
 */
import { getDb } from '../../db';
import { now, shortCode } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { recordEvent } from '../events';
import { countryCapabilities } from '../capabilities';
import { getSwitchSettings } from './settings';

export type ParticipantKind = 'BANK' | 'MMO' | 'PSP' | 'SWITCH' | 'SPONSOR' | 'AGGREGATOR';
export type ParticipantStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'RETIRED';
export const SWITCH_PRODUCTS = ['MERCHANT_PAYMENT', 'P2P', 'REFUND', 'REVERSAL', 'INQUIRY'] as const;
export type SwitchProduct = (typeof SWITCH_PRODUCTS)[number];

export interface Participant {
  id: string;
  name: string;
  kind: ParticipantKind;
  country: string;
  currencies: string[];
  services: string[];
  channels: string[];
  routingIds: Record<string, string>;
  status: ParticipantStatus;
  source: 'SIMULATION' | 'OFFICIAL';
  evidenceRef: string | null;
  validFrom: string | null;
  validTo: string | null;
  version: number;
  authorId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
const toView = (r: any): Participant => ({ id: r.id, name: r.name, kind: r.kind, country: r.country, currencies: parseJson(r.currencies, []), services: parseJson(r.services, []), channels: parseJson(r.channels, []), routingIds: parseJson(r.routing_ids, {}), status: r.status, source: r.source, evidenceRef: r.evidence_ref, validFrom: r.valid_from, validTo: r.valid_to, version: r.version, authorId: r.author_id, approvedBy: r.approved_by, approvedAt: r.approved_at, createdAt: r.created_at, updatedAt: r.updated_at });

export function listParticipants(filter: { country?: string | null; status?: string | null; kind?: string | null } = {}): Participant[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.country) {
    where.push('country = ?');
    params.push(filter.country.toUpperCase());
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.kind) {
    where.push('kind = ?');
    params.push(filter.kind);
  }
  return (getDb().prepare(`SELECT * FROM participants ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY country, kind, name`).all(...params) as any[]).map(toView);
}
export function getParticipant(id: string): Participant {
  const r = getDb().prepare('SELECT * FROM participants WHERE id = ?').get(id);
  if (!r) throw notFound(`Participant ${id} is not in the registry`, 'participant_not_found');
  return toView(r);
}

export interface ParticipantInput {
  id: string;
  name: string;
  kind: ParticipantKind;
  country: string;
  currencies: string[];
  services: string[];
  channels?: string[];
  routingIds?: Record<string, string>;
  source?: 'SIMULATION' | 'OFFICIAL';
  evidenceRef?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
}

/** Create or revise a participant. A revision bumps the version and returns to PENDING until approved. */
export function upsertParticipant(input: ParticipantInput, authorId: string | null): Participant {
  const db = getDb();
  if (!/^[A-Z0-9_\-]{3,32}$/.test(input.id)) throw badRequest('Participant id must be the official code (A-Z, 0-9, _ -)', 'invalid_participant_id');
  for (const s of input.services) if (!(SWITCH_PRODUCTS as readonly string[]).includes(s)) throw badRequest(`Unknown service ${s}`, 'invalid_service');
  if (input.source === 'OFFICIAL' && !input.evidenceRef) throw badRequest('Official entries need the signed directory/file reference', 'evidence_required');
  const existing = db.prepare('SELECT * FROM participants WHERE id = ?').get(input.id) as any;
  if (!existing) {
    db.prepare('INSERT INTO participants (id, name, kind, country, currencies, services, channels, routing_ids, status, source, evidence_ref, valid_from, valid_to, version, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)').run(input.id, input.name, input.kind, input.country.toUpperCase(), JSON.stringify(input.currencies.map((c) => c.toUpperCase())), JSON.stringify(input.services), JSON.stringify(input.channels ?? ['api', 'qr']), JSON.stringify(input.routingIds ?? {}), 'PENDING', input.source ?? 'SIMULATION', input.evidenceRef ?? null, input.validFrom ?? null, input.validTo ?? null, authorId, now(), now());
  } else {
    db.prepare('UPDATE participants SET name = ?, kind = ?, country = ?, currencies = ?, services = ?, channels = ?, routing_ids = ?, status = ?, source = ?, evidence_ref = ?, valid_from = ?, valid_to = ?, version = version + 1, author_id = ?, approved_by = NULL, approved_at = NULL, updated_at = ? WHERE id = ?').run(input.name, input.kind, input.country.toUpperCase(), JSON.stringify(input.currencies.map((c) => c.toUpperCase())), JSON.stringify(input.services), JSON.stringify(input.channels ?? parseJson(existing.channels, ['api', 'qr'])), JSON.stringify(input.routingIds ?? parseJson(existing.routing_ids, {})), existing.status === 'RETIRED' ? 'RETIRED' : 'PENDING', input.source ?? existing.source, input.evidenceRef ?? existing.evidence_ref, input.validFrom ?? existing.valid_from, input.validTo ?? existing.valid_to, authorId, now(), input.id);
  }
  recordEvent('corridor', input.id, existing ? 'participant.revised' : 'participant.created', { type: authorId ? 'admin' : 'system', id: authorId }, { version: existing ? existing.version + 1 : 1, source: input.source ?? 'SIMULATION' });
  return getParticipant(input.id);
}

export function approveParticipant(id: string, approverId: string): Participant {
  const p = getParticipant(id);
  if (p.status !== 'PENDING') throw conflict(`Participant is ${p.status}`, 'participant_not_pending');
  if (p.authorId && p.authorId === approverId) throw badRequest('The approver must differ from the author', 'approver_required');
  getDb().prepare("UPDATE participants SET status = 'ACTIVE', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?").run(approverId, now(), now(), id);
  recordEvent('corridor', id, 'participant.approved', { type: 'admin', id: approverId }, { version: p.version });
  return getParticipant(id);
}

export function setParticipantStatus(id: string, status: 'SUSPENDED' | 'RETIRED' | 'ACTIVE', adminId: string, reason?: string | null): Participant {
  const p = getParticipant(id);
  if (status === 'ACTIVE' && !p.approvedBy) throw conflict('Approve the participant first', 'participant_not_approved');
  getDb().prepare('UPDATE participants SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
  recordEvent('corridor', id, `participant.${status.toLowerCase()}`, { type: 'admin', id: adminId }, { reason: reason ?? null });
  return getParticipant(id);
}

// ---------------------------------------------------------------------------------------------------------------------
// Pair capability tests
// ---------------------------------------------------------------------------------------------------------------------
export interface ParticipantPair {
  id: string;
  connectionId: string;
  debtorId: string;
  creditorId: string;
  currency: string;
  product: string;
  channel: string;
  status: 'UNTESTED' | 'OPEN' | 'FAILED' | 'CLOSED';
  testedAt: string | null;
  evidenceRef: string | null;
  validFrom: string | null;
  validTo: string | null;
  authorId: string | null;
  approvedBy: string | null;
}
const toPair = (r: any): ParticipantPair => ({ id: r.id, connectionId: r.connection_id, debtorId: r.debtor_id, creditorId: r.creditor_id, currency: r.currency, product: r.product, channel: r.channel, status: r.status, testedAt: r.tested_at, evidenceRef: r.evidence_ref, validFrom: r.valid_from, validTo: r.valid_to, authorId: r.author_id, approvedBy: r.approved_by });

export function upsertPair(input: { connectionId: string; debtorId: string; creditorId: string; currency: string; product: string; channel?: string }, authorId: string | null): ParticipantPair {
  getParticipant(input.debtorId);
  getParticipant(input.creditorId);
  const db = getDb();
  const channel = input.channel ?? 'api';
  const existing = db.prepare('SELECT * FROM participant_pairs WHERE connection_id = ? AND debtor_id = ? AND creditor_id = ? AND currency = ? AND product = ? AND channel = ?').get(input.connectionId, input.debtorId, input.creditorId, input.currency.toUpperCase(), input.product, channel) as any;
  if (existing) return toPair(existing);
  const id = `pair_${shortCode(12).toLowerCase()}`;
  db.prepare('INSERT INTO participant_pairs (id, connection_id, debtor_id, creditor_id, currency, product, channel, status, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, input.connectionId, input.debtorId, input.creditorId, input.currency.toUpperCase(), input.product, channel, 'UNTESTED', authorId, now(), now());
  return toPair(db.prepare('SELECT * FROM participant_pairs WHERE id = ?').get(id));
}

/** Record the pair test outcome; opening a pair needs evidence and an approver distinct from the author. */
export function setPairStatus(id: string, status: 'OPEN' | 'FAILED' | 'CLOSED', input: { evidenceRef?: string | null; validTo?: string | null }, approverId: string): ParticipantPair {
  const r = getDb().prepare('SELECT * FROM participant_pairs WHERE id = ?').get(id) as any;
  if (!r) throw notFound('Pair not found', 'pair_not_found');
  if (status === 'OPEN') {
    if (!input.evidenceRef) throw badRequest('Opening a pair needs the test evidence reference', 'evidence_required');
    if (r.author_id && r.author_id === approverId) throw badRequest('The approver must differ from the author', 'approver_required');
  }
  getDb().prepare('UPDATE participant_pairs SET status = ?, tested_at = ?, evidence_ref = COALESCE(?, evidence_ref), valid_from = COALESCE(valid_from, ?), valid_to = ?, approved_by = ?, updated_at = ? WHERE id = ?').run(status, now(), input.evidenceRef ?? null, now(), input.validTo ?? null, approverId, now(), id);
  recordEvent('corridor', id, `pair.${status.toLowerCase()}`, { type: 'admin', id: approverId }, { evidenceRef: input.evidenceRef ?? null });
  return toPair(getDb().prepare('SELECT * FROM participant_pairs WHERE id = ?').get(id));
}

export function listPairs(connectionId?: string | null): ParticipantPair[] {
  return (getDb().prepare(`SELECT * FROM participant_pairs ${connectionId ? 'WHERE connection_id = ?' : ''} ORDER BY created_at`).all(...(connectionId ? [connectionId] : [])) as any[]).map(toPair);
}

// ---------------------------------------------------------------------------------------------------------------------
// Registry status and the intersection rule
// ---------------------------------------------------------------------------------------------------------------------
export function registryStatus(country: string) {
  const settings = getSwitchSettings();
  const rows = listParticipants({ country });
  const active = rows.filter((p) => p.status === 'ACTIVE');
  const last = rows.reduce<string | null>((m, p) => (p.approvedAt && (!m || p.approvedAt > m) ? p.approvedAt : m), null);
  const ageHours = last ? Math.floor((Date.now() - Date.parse(last)) / 3600_000) : Number.POSITIVE_INFINITY;
  const contradictions: string[] = [];
  for (const p of active) if (p.validTo && p.validTo < now()) contradictions.push(`${p.id} active but validity ended ${p.validTo}`);
  const seen = new Map<string, string>();
  for (const p of active) {
    const rid = p.routingIds.switchParticipantId;
    if (!rid) continue;
    if (seen.has(rid) && seen.get(rid) !== p.id) contradictions.push(`routing id ${rid} shared by ${seen.get(rid)} and ${p.id}`);
    seen.set(rid, p.id);
  }
  return { country: country.toUpperCase(), participants: active.length, pending: rows.filter((p) => p.status === 'PENDING').length, lastApprovedAt: last, ageHours: Number.isFinite(ageHours) ? ageHours : null, stale: rows.length > 0 && ageHours > settings.registryToleranceHours, contradictions, sources: [...new Set(rows.map((p) => p.source))] };
}

export interface Availability {
  available: boolean;
  reasons: string[];
  factors: Record<string, boolean>;
}

/** §5: authorisation × switch admission × debtor capability × creditor capability × currency × product × channel × validity. */
export function serviceAvailability(q: { connectionId: string; connectionEnabled: boolean; environmentCertified: boolean; country: string; debtorId: string; creditorId: string; currency: string; product: string; channel: string }): Availability {
  const reasons: string[] = [];
  const factors: Record<string, boolean> = {};
  const caps = countryCapabilities(q.country);
  const t = now();
  factors.bitripayAuthorisation = q.product === 'MERCHANT_PAYMENT' || q.product === 'INQUIRY' || (q.product === 'REFUND' && true) ? true : caps.licencePhase === 'full';
  if (!factors.bitripayAuthorisation) reasons.push(`${q.product} is outside the ${caps.licencePhase} licence phase`);
  factors.switchAdmission = q.connectionEnabled && q.environmentCertified;
  if (!factors.switchAdmission) reasons.push('switch admission not granted (connection disabled or not certified for this environment)');
  const check = (id: string, role: 'debtor' | 'creditor') => {
    let p: Participant;
    try {
      p = getParticipant(id);
    } catch {
      reasons.push(`${role} participant ${id} unknown`);
      factors[`${role}Capability`] = false;
      return null;
    }
    const ok = p.status === 'ACTIVE' && p.services.includes(q.product === 'INQUIRY' ? 'MERCHANT_PAYMENT' : q.product) && p.currencies.includes(q.currency.toUpperCase()) && p.channels.includes(q.channel) && (!p.validFrom || p.validFrom <= t) && (!p.validTo || p.validTo >= t) && p.country === q.country.toUpperCase();
    factors[`${role}Capability`] = ok;
    if (!ok) reasons.push(`${role} ${p.id}: ${p.status !== 'ACTIVE' ? p.status.toLowerCase() : !p.services.includes(q.product) ? `no ${q.product} service` : !p.currencies.includes(q.currency.toUpperCase()) ? `${q.currency} not admitted` : !p.channels.includes(q.channel) ? `channel ${q.channel} not admitted` : p.country !== q.country.toUpperCase() ? 'foreign participant' : 'outside validity dates'}`);
    return p;
  };
  check(q.debtorId, 'debtor');
  check(q.creditorId, 'creditor');
  const pair = getDb().prepare('SELECT * FROM participant_pairs WHERE connection_id = ? AND debtor_id = ? AND creditor_id = ? AND currency = ? AND product = ? AND channel = ?').get(q.connectionId, q.debtorId, q.creditorId, q.currency.toUpperCase(), q.product === 'INQUIRY' ? 'MERCHANT_PAYMENT' : q.product, q.channel) as any;
  factors.pairTested = !!pair && pair.status === 'OPEN' && (!pair.valid_to || pair.valid_to >= t);
  if (!factors.pairTested) reasons.push(pair ? `pair ${q.debtorId}→${q.creditorId} is ${pair.status}` : `pair ${q.debtorId}→${q.creditorId} has no ${q.product} test for ${q.currency}/${q.channel}`);
  factors.currency = caps.collectionCurrencies.length === 0 || caps.collectionCurrencies.includes(q.currency.toUpperCase());
  if (!factors.currency) reasons.push(`${q.currency} is not enabled in ${q.country}`);
  return { available: reasons.length === 0, reasons, factors };
}

/** Seed fictitious institutions for the simulator (labelled SIMULATION; never routing-capable outside simulation). */
export function ensureSimulationParticipants(connectionId = 'NATIONAL_SWITCH_CD'): void {
  const db = getDb();
  if (db.prepare("SELECT 1 FROM participants WHERE source = 'SIMULATION' AND country = 'CD' LIMIT 1").get()) return;
  const seed = 'seed';
  const approver = 'seed-approver';
  const mk = (id: string, name: string, kind: ParticipantKind, services: string[], rid: string, extra: Partial<ParticipantInput> = {}) => {
    upsertParticipant({ id, name, kind, country: 'CD', currencies: ['CDF', 'USD'], services, channels: ['api', 'qr', 'ussd'], routingIds: { switchParticipantId: rid, reconciliationFeed: `sim://${id.toLowerCase()}/recon` }, source: 'SIMULATION', validFrom: '2026-01-01T00:00:00.000Z', ...extra }, seed);
  };
  mk('BITRIPAY_CD', 'BitriPay (aggregator, SIMULATION)', 'AGGREGATOR', ['MERCHANT_PAYMENT', 'INQUIRY', 'REFUND'], 'SIM-AGG-001');
  mk('DEMO_BANK_A', 'Demo Bank A (SIMULATION)', 'BANK', ['MERCHANT_PAYMENT', 'P2P', 'REFUND', 'REVERSAL', 'INQUIRY'], 'SIM-BNK-001');
  mk('DEMO_BANK_B', 'Demo Bank B (SIMULATION)', 'BANK', ['MERCHANT_PAYMENT', 'P2P', 'REFUND', 'INQUIRY'], 'SIM-BNK-002');
  mk('DEMO_MMO_A', 'Demo Mobile Money A (SIMULATION)', 'MMO', ['MERCHANT_PAYMENT', 'P2P', 'REFUND', 'INQUIRY'], 'SIM-MMO-001');
  mk('DEMO_MMO_B', 'Demo Mobile Money B (SIMULATION)', 'MMO', ['MERCHANT_PAYMENT', 'REFUND', 'INQUIRY'], 'SIM-MMO-002');
  mk('DEMO_SPONSOR', 'Demo Sponsor Bank (SIMULATION)', 'SPONSOR', ['MERCHANT_PAYMENT', 'INQUIRY', 'REFUND'], 'SIM-SPN-001');
  // a participant that never passed homologation: stays PENDING (T05)
  mk('DEMO_BANK_C', 'Demo Bank C — not homologated (SIMULATION)', 'BANK', ['MERCHANT_PAYMENT'], 'SIM-BNK-003');
  for (const id of ['BITRIPAY_CD', 'DEMO_BANK_A', 'DEMO_BANK_B', 'DEMO_MMO_A', 'DEMO_MMO_B', 'DEMO_SPONSOR']) approveParticipant(id, approver);
  const pairs: [string, string, string][] = [
    ['DEMO_BANK_A', 'DEMO_MMO_B', 'CDF'],
    ['DEMO_BANK_A', 'DEMO_BANK_B', 'CDF'],
    ['DEMO_MMO_A', 'DEMO_BANK_B', 'CDF'],
    ['DEMO_MMO_A', 'DEMO_MMO_B', 'CDF'],
    ['DEMO_BANK_A', 'DEMO_BANK_B', 'USD'],
    ['DEMO_MMO_A', 'DEMO_BANK_A', 'CDF'],
  ];
  for (const [d, c, cur] of pairs) {
    for (const channel of ['api', 'qr', 'ussd']) {
      const pair = upsertPair({ connectionId, debtorId: d, creditorId: c, currency: cur, product: 'MERCHANT_PAYMENT', channel }, seed);
      setPairStatus(pair.id, 'OPEN', { evidenceRef: 'SIMULATION pair test' }, approver);
    }
    // a refund travels the other way: the creditor institution returns funds to the payer's institution
    if (getParticipant(c).services.includes('REFUND')) {
      const refund = upsertPair({ connectionId, debtorId: c, creditorId: d, currency: cur, product: 'REFUND', channel: 'api' }, seed);
      setPairStatus(refund.id, 'OPEN', { evidenceRef: 'SIMULATION pair test' }, approver);
    }
  }
  // Bank A → Bank B P2P deliberately untested (pair capability is never presumed universal)
  upsertPair({ connectionId, debtorId: 'DEMO_BANK_B', creditorId: 'DEMO_MMO_A', currency: 'CDF', product: 'MERCHANT_PAYMENT', channel: 'api' }, seed);
}
