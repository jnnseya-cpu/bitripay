/**
 * CMP-03 Payment Orchestrator + CMP-08 Transaction Store + CMP-09 Inbox/Outbox for the National Switch Gateway.
 *
 * A switch payment is the merchant's durable order: validated, consented, classified by the route policy engine,
 * then committed with its first event and its outbox message in ONE database transaction (IDM-003). The dispatcher
 * holds a lease with a fencing token, revalidates every revocable control immediately before emission (RTE-006),
 * persists the stable message id BEFORE the network write, and applies the response through the versioned message
 * catalogue under optimistic `state_version` control. A timeout after a possible transmission never leads to a
 * resend: the payment goes UNKNOWN and an inquiry is queued (IDM-004); a provisional NOT_FOUND is not proof of no
 * debit (IDM-005). Inbound messages are verified, deduplicated on (source, external id) and quarantined when their
 * code is unknown or their signature invalid. Nothing here writes a customer balance: the observation journal records
 * facts (principal requested, credit confirmed, fees, refunds, settlement references) and the linked platform intent
 * mirrors the state for webhooks, timelines and the guardian without a ledger posting.
 */
import { getDb } from '../../db';
import { now, shortCode } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { sha256 } from '../../lib/crypto';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { recordEvent, type Actor } from '../events';
import { findUserById, type UserRow } from '../users';
import { getCurrency } from '../currencies';
import { accrueAggregationFee, feeEntryForPayment, quoteAggregationFee, reverseAggregationFee, type FeeEntry, type FeeQuote } from './fees';
import { countryCapabilities } from '../capabilities';
import { screenSanctions } from '../risk';
import { emitEvent } from '../webhooks';
import { createIntent, getIntentRow, startAttempt, finishAttempt, cancelIntent, reconcileOpenAttempt, listAttempts, intentView } from '../intents';
import { getSwitchSettings } from './settings';
import { getConnection, emissionGate, openIncident, type SwitchConnection } from './connections';
import { getParticipant, serviceAvailability } from './participants';
import { decideRoute, revalidateBeforeEmission, type RouteDecision } from './policy';
import { adapterFor, SwitchTimeoutError, CapabilityNotAvailable, type ExternalObservation, type CanonicalPayment, type TransportEvidence } from './adapter';
import { storeEvidence } from './vault';
import { openCase } from './reconciliation';

export const SWITCH_STATES = ['RECEIVED', 'REQUIRES_ACTION', 'READY', 'DISPATCHING', 'PENDING', 'AUTHORIZED', 'UNKNOWN', 'COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED'] as const;
export type SwitchState = (typeof SWITCH_STATES)[number];
const TRANSITIONS: Record<SwitchState, SwitchState[]> = {
  RECEIVED: ['REQUIRES_ACTION', 'READY', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  REQUIRES_ACTION: ['READY', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  READY: ['DISPATCHING', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  DISPATCHING: ['PENDING', 'AUTHORIZED', 'COMPLETED', 'REJECTED', 'UNKNOWN'],
  PENDING: ['AUTHORIZED', 'COMPLETED', 'REJECTED', 'UNKNOWN'],
  AUTHORIZED: ['COMPLETED', 'UNKNOWN', 'REJECTED'],
  UNKNOWN: ['PENDING', 'AUTHORIZED', 'COMPLETED', 'REJECTED', 'READY'],
  COMPLETED: [],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
};
const BEFORE_EMISSION: SwitchState[] = ['RECEIVED', 'REQUIRES_ACTION', 'READY'];

/** Link conditions that are not payment states but still need customer wording (link down, timeout, circuit open). */
export const SWITCH_LINK_CONDITIONS = ['UNAVAILABLE', 'TIMEOUT', 'CIRCUIT_OPEN'] as const;
export type SwitchLinkCondition = (typeof SWITCH_LINK_CONDITIONS)[number];
/** Wording for UNAVAILABLE / timeout / circuit-open: the same sentence in both languages, never "try again now". */
export const SWITCH_UNAVAILABLE_MESSAGE = { fr: 'Service temporairement indisponible. Réessayez plus tard.', en: 'Service temporarily unavailable. Try again later.' } as const;

/** 7.2 customer-facing wording (FR business rule, EN identifier). Every state and link condition has both languages. */
export function customerMessage(status: SwitchState | SwitchLinkCondition, ctx: { amount?: string; reference?: string | null; reason?: string | null } = {}): { fr: string; en: string } {
  switch (status) {
    case 'UNAVAILABLE':
    case 'TIMEOUT':
    case 'CIRCUIT_OPEN':
      return { ...SWITCH_UNAVAILABLE_MESSAGE };
    case 'RECEIVED':
    case 'REQUIRES_ACTION':
    case 'READY':
      return { fr: 'Paiement créé. Autorisation nécessaire.', en: 'Payment created. Authorisation required.' };
    case 'DISPATCHING':
    case 'PENDING':
    case 'AUTHORIZED':
      return { fr: 'Paiement en cours de confirmation.', en: 'Payment confirmation in progress.' };
    case 'UNKNOWN':
      return { fr: 'Confirmation en cours. Ne recommencez pas ce paiement.', en: 'Confirmation in progress. Do not repeat this payment.' };
    case 'COMPLETED':
      return {
        fr: `Paiement confirmé${ctx.reference ? ` — référence ${ctx.reference}` : ''}${ctx.amount ? ` — ${ctx.amount}` : ''}.`,
        en: `Payment confirmed${ctx.reference ? ` — reference ${ctx.reference}` : ''}${ctx.amount ? ` — ${ctx.amount}` : ''}.`,
      };
    case 'REJECTED':
      return { fr: `Paiement refusé${ctx.reason ? ` : ${ctx.reason}` : ''}.`, en: `Payment declined${ctx.reason ? `: ${ctx.reason}` : ''}.` };
    case 'EXPIRED':
      return { fr: 'Paiement expiré avant toute émission.', en: 'Payment expired before any transmission.' };
    case 'CANCELLED':
      return { fr: 'Paiement annulé avant toute émission.', en: 'Payment cancelled before any transmission.' };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Message catalogue (8.2)
// ---------------------------------------------------------------------------------------------------------------------
export interface CatalogueEntry {
  id: string;
  product: string;
  externalCode: string;
  phase: string;
  meaning: string;
  finality: 'NONE' | 'AUTHORIZATION' | 'COMPLETION' | 'REJECTION';
  minimumProof: string;
  authority: string;
  transition: string;
  version: number;
  source: string;
}
const toEntry = (r: any): CatalogueEntry => ({
  id: r.id,
  product: r.product,
  externalCode: r.external_code,
  phase: r.phase,
  meaning: r.meaning,
  finality: r.finality,
  minimumProof: r.minimum_proof,
  authority: r.authority,
  transition: r.transition,
  version: r.version,
  source: r.source,
});

export function ensureMessageCatalogue(): void {
  const db = getDb();
  if ((db.prepare('SELECT COUNT(*) c FROM message_catalogue').get() as any).c > 0) return;
  const rows: [string, string, string, string, CatalogueEntry['finality'], string, string, string][] = [
    ['MERCHANT_PAYMENT', 'A00', 'transport', 'Technical acknowledgement by the network', 'NONE', 'none', 'NETWORK', 'PENDING'],
    ['MERCHANT_PAYMENT', 'P01', 'processing', 'Accepted for processing by the switch', 'NONE', 'none', 'SWITCH', 'PENDING'],
    ['MERCHANT_PAYMENT', 'A10', 'authorization', 'Debit authorised by the debtor institution', 'AUTHORIZATION', 'authenticated message', 'DEBTOR', 'AUTHORIZED'],
    ['MERCHANT_PAYMENT', '000', 'completion', 'Credit confirmed by the creditor institution', 'COMPLETION', 'authenticated message + external reference', 'CREDITOR', 'COMPLETED'],
    ['MERCHANT_PAYMENT', 'R05', 'rejection', 'Insufficient funds at the debtor institution', 'REJECTION', 'authenticated message', 'DEBTOR', 'REJECTED'],
    ['MERCHANT_PAYMENT', 'R10', 'rejection', 'Payer account invalid or closed', 'REJECTION', 'authenticated message', 'DEBTOR', 'REJECTED'],
    ['MERCHANT_PAYMENT', 'R99', 'rejection', 'Rejected by the switch (generic)', 'REJECTION', 'authenticated message', 'SWITCH', 'REJECTED'],
    ['MERCHANT_PAYMENT', 'N01', 'inquiry', 'No record of the message yet (provisional)', 'NONE', 'none', 'SWITCH', 'KEEP'],
    [
      'MERCHANT_PAYMENT',
      'N02',
      'inquiry',
      'No record of the message (definitive per scheme rules; re-emission allowed with the same identity)',
      'REJECTION',
      'authenticated message after the visibility window',
      'SWITCH',
      'RE_EMISSION_ALLOWED',
    ],
    ['REFUND', 'F00', 'completion', 'Refund executed to the original instrument', 'COMPLETION', 'authenticated message + external reference', 'DEBTOR', 'SUCCEEDED'],
    ['REFUND', 'F01', 'rejection', 'Refund refused', 'REJECTION', 'authenticated message', 'DEBTOR', 'REJECTED'],
    ['REVERSAL', 'V00', 'completion', 'Reversal executed', 'COMPLETION', 'authenticated message', 'SWITCH', 'SUCCEEDED'],
    ['REVERSAL', 'V01', 'rejection', 'Reversal refused', 'REJECTION', 'authenticated message', 'SWITCH', 'REJECTED'],
  ];
  const ins = db.prepare(
    'INSERT INTO message_catalogue (id, product, external_code, phase, meaning, finality, minimum_proof, authority, transition, version, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
  );
  for (const r of rows) ins.run(`mc_${shortCode(10).toLowerCase()}`, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], 'SIMULATION', now());
}
export function listCatalogue(product?: string | null): CatalogueEntry[] {
  return (
    getDb()
      .prepare(`SELECT * FROM message_catalogue ${product ? 'WHERE product = ?' : ''} ORDER BY product, external_code, version DESC`)
      .all(...(product ? [product] : [])) as any[]
  ).map(toEntry);
}
export function upsertCatalogueEntry(input: Omit<CatalogueEntry, 'id' | 'version'> & { version?: number }, adminId: string): CatalogueEntry {
  const db = getDb();
  const latest = db.prepare('SELECT MAX(version) v FROM message_catalogue WHERE product = ? AND external_code = ?').get(input.product, input.externalCode) as any;
  const version = (latest?.v ?? 0) + 1;
  const id = `mc_${shortCode(10).toLowerCase()}`;
  db.prepare(
    'INSERT INTO message_catalogue (id, product, external_code, phase, meaning, finality, minimum_proof, authority, transition, version, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, input.product, input.externalCode, input.phase, input.meaning, input.finality, input.minimumProof, input.authority, input.transition, version, input.source, now());
  recordEvent('switch', id, 'catalogue.versioned', { type: 'admin', id: adminId }, { product: input.product, code: input.externalCode, version });
  return toEntry(db.prepare('SELECT * FROM message_catalogue WHERE id = ?').get(id));
}
function catalogueFor(product: string, code: string): CatalogueEntry | null {
  const r = getDb().prepare('SELECT * FROM message_catalogue WHERE product = ? AND external_code = ? ORDER BY version DESC LIMIT 1').get(product, code);
  return r ? toEntry(r) : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Beneficiary bindings (CMP-02)
// ---------------------------------------------------------------------------------------------------------------------
export interface BindingView {
  id: string;
  merchantId: string;
  participantId: string;
  accountMasked: string;
  accountName: string;
  status: 'PENDING' | 'VERIFIED' | 'ACTIVE' | 'SUSPENDED' | 'SUPERSEDED';
  version: number;
  verification: Record<string, unknown>;
  requestedBy: string | null;
  approvedBy: string | null;
  replacesId: string | null;
  createdAt: string;
  updatedAt: string;
}
const toBinding = (r: any): BindingView => ({
  id: r.id,
  merchantId: r.merchant_user_id,
  participantId: r.participant_id,
  accountMasked: r.account_masked,
  accountName: r.account_name,
  status: r.status,
  version: r.version,
  verification: parseJson(r.verification, {}),
  requestedBy: r.requested_by,
  approvedBy: r.approved_by,
  replacesId: r.replaces_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const mask = (t: string) => (t.length <= 4 ? '••••' : `${'•'.repeat(Math.max(2, t.length - 4))}${t.slice(-4)}`);

export function createBinding(merchant: UserRow, input: { participantId: string; accountToken: string; accountName: string; replacesId?: string | null }): BindingView {
  const p = getParticipant(input.participantId);
  if (p.status !== 'ACTIVE') throw new AppError(422, 'UNSUPPORTED_PARTICIPANT_PAIR', `Participant ${p.id} is ${p.status}`);
  if (!input.accountToken.trim() || !input.accountName.trim()) throw new AppError(400, 'INVALID_REQUEST', 'accountToken and accountName are required');
  const db = getDb();
  if (input.replacesId) {
    const old = db.prepare('SELECT * FROM beneficiary_bindings WHERE id = ? AND merchant_user_id = ?').get(input.replacesId, merchant.id) as any;
    if (!old) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Binding to replace not found');
  }
  const id = `bind_${shortCode(14).toLowerCase()}`;
  db.prepare(
    'INSERT INTO beneficiary_bindings (id, merchant_user_id, participant_id, account_token, account_masked, account_name, status, verification, version, requested_by, replaces_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
  ).run(id, merchant.id, p.id, input.accountToken, mask(input.accountToken), input.accountName.trim(), 'PENDING', '{}', merchant.id, input.replacesId ?? null, now(), now());
  recordEvent('switch', id, 'binding.requested', { type: 'merchant', id: merchant.id }, { participantId: p.id, replaces: input.replacesId ?? null });
  return getBinding(merchant.id, id);
}
export function getBinding(merchantUserId: string | null, id: string): BindingView {
  const r = getDb().prepare('SELECT * FROM beneficiary_bindings WHERE id = ?').get(id) as any;
  if (!r || (merchantUserId && r.merchant_user_id !== merchantUserId)) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Beneficiary binding not found');
  return toBinding(r);
}
export function listBindings(merchantUserId: string): BindingView[] {
  return (getDb().prepare('SELECT * FROM beneficiary_bindings WHERE merchant_user_id = ? ORDER BY created_at DESC').all(merchantUserId) as any[]).map(toBinding);
}
/** Independent verification of the account with the institution (compliance / operations), then dual approval. */
export function verifyBinding(id: string, adminId: string, verification: { method: string; reference: string; note?: string | null }): BindingView {
  const b = getBinding(null, id);
  if (b.status !== 'PENDING') throw conflict(`Binding is ${b.status}`, 'binding_not_pending');
  getDb()
    .prepare("UPDATE beneficiary_bindings SET status = 'VERIFIED', verification = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify({ ...verification, verifiedBy: adminId, verifiedAt: now() }), now(), id);
  recordEvent('switch', id, 'binding.verified', { type: 'admin', id: adminId }, { method: verification.method, reference: verification.reference });
  return getBinding(null, id);
}
export function activateBinding(id: string, approverId: string): BindingView {
  const b = getBinding(null, id);
  if (b.status !== 'VERIFIED') throw conflict(`Binding is ${b.status}; verify it first`, 'binding_not_verified');
  if (b.verification.verifiedBy === approverId || b.requestedBy === approverId) throw badRequest('Activation needs an approver different from the verifier and the requester', 'approver_required');
  const db = getDb();
  db.transaction(() => {
    db.prepare("UPDATE beneficiary_bindings SET status = 'ACTIVE', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?").run(approverId, now(), now(), id);
    if (b.replacesId) db.prepare("UPDATE beneficiary_bindings SET status = 'SUPERSEDED', updated_at = ? WHERE id = ?").run(now(), b.replacesId);
  })();
  recordEvent('switch', id, 'binding.activated', { type: 'admin', id: approverId }, { superseded: b.replacesId });
  return getBinding(null, id);
}
export function suspendBinding(id: string, adminId: string, reason: string): BindingView {
  getBinding(null, id);
  getDb().prepare("UPDATE beneficiary_bindings SET status = 'SUSPENDED', updated_at = ? WHERE id = ?").run(now(), id);
  recordEvent('switch', id, 'binding.suspended', { type: 'admin', id: adminId }, { reason });
  return getBinding(null, id);
}

// ---------------------------------------------------------------------------------------------------------------------
// Consent evidence
// ---------------------------------------------------------------------------------------------------------------------
export function recordConsent(input: {
  participantId: string;
  audience: string;
  merchantUserId: string;
  bindingId?: string | null;
  amountMinor: number;
  currency: string;
  accountToken?: string | null;
  ttlSeconds?: number;
  proof: string;
}): { reference: string; expiresAt: string } {
  getParticipant(input.participantId);
  const reference = `consent_${shortCode(16).toLowerCase()}`;
  const expiresAt = new Date(Date.now() + (input.ttlSeconds ?? 600) * 1000).toISOString();
  getDb()
    .prepare(
      'INSERT INTO consent_evidence (id, reference, participant_id, audience, merchant_user_id, beneficiary_binding_id, amount_minor, currency, account_token, proof_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      `ce_${shortCode(12).toLowerCase()}`,
      reference,
      input.participantId,
      input.audience,
      input.merchantUserId,
      input.bindingId ?? null,
      input.amountMinor,
      input.currency.toUpperCase(),
      input.accountToken ?? null,
      sha256(input.proof),
      expiresAt,
      now(),
    );
  return { reference, expiresAt };
}
export function validateConsent(
  reference: string | null | undefined,
  expect: { merchantUserId: string; bindingId: string; amountMinor: number; currency: string; participantId: string },
): { ok: boolean; reason: string | null } {
  if (!reference) return { ok: false, reason: 'consent missing' };
  const c = getDb().prepare('SELECT * FROM consent_evidence WHERE reference = ?').get(reference) as any;
  if (!c) return { ok: false, reason: 'consent unknown' };
  if (c.expires_at < now()) return { ok: false, reason: 'consent expired' };
  if (c.used_at) return { ok: false, reason: 'consent already used' };
  if (c.merchant_user_id !== expect.merchantUserId) return { ok: false, reason: 'consent audience mismatch' };
  if (c.beneficiary_binding_id && c.beneficiary_binding_id !== expect.bindingId) return { ok: false, reason: 'consent bound to another beneficiary' };
  if (c.amount_minor !== expect.amountMinor || c.currency !== expect.currency.toUpperCase()) return { ok: false, reason: 'consent amount or currency mismatch' };
  if (c.participant_id !== expect.participantId) return { ok: false, reason: 'consent issued by another institution' };
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------------------------------------------------
// Payment rows, events, views
// ---------------------------------------------------------------------------------------------------------------------
export interface SwitchPaymentRow {
  id: string;
  tenant_id: string;
  merchant_user_id: string;
  api_client_id: string | null;
  merchant_order_id: string;
  product: string;
  intent_id: string | null;
  connection_id: string | null;
  amount_minor: number;
  currency: string;
  payer_participant_id: string;
  payer_account_token: string | null;
  beneficiary_binding_id: string;
  beneficiary_binding_version: number;
  consent_reference: string | null;
  description: string | null;
  status: SwitchState;
  state_version: number;
  authorization_status: string;
  beneficiary_credit_status: string;
  settlement_status: string;
  reconciliation_status: string;
  resolution_status: string;
  route: string;
  external_message_id: string | null;
  external_reference: string | null;
  switch_correlation_id: string | null;
  rejection: string | null;
  expires_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
  fingerprint: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}
export function getPaymentRow(id: string): SwitchPaymentRow {
  const r = getDb().prepare('SELECT * FROM switch_payments WHERE id = ?').get(id) as SwitchPaymentRow | undefined;
  if (!r) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Payment not found');
  return r;
}

function appendEvent(
  paymentId: string,
  type: string,
  source: string,
  from: SwitchState | null,
  to: SwitchState | null,
  stateVersion: number,
  payload: Record<string, unknown>,
  proofRef: string | null = null,
  occurredAt = now(),
): void {
  const db = getDb();
  const seq = ((db.prepare('SELECT MAX(seq) m FROM switch_events WHERE payment_id = ?').get(paymentId) as any).m ?? 0) + 1;
  const fingerprint = sha256(`${paymentId}|${seq}|${type}|${JSON.stringify(payload)}`);
  db.prepare(
    'INSERT INTO switch_events (id, payment_id, seq, type, source, from_status, to_status, state_version, fingerprint, proof_ref, payload, occurred_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(`se_${shortCode(14).toLowerCase()}`, paymentId, seq, type, source, from, to, stateVersion, fingerprint, proofRef, JSON.stringify(payload), occurredAt, now());
}
function journal(
  paymentId: string,
  fact: string,
  amountMinor: number | null,
  currency: string | null,
  source: string,
  reference: string | null,
  proofRef: string | null = null,
  occurredAt = now(),
): void {
  getDb()
    .prepare('INSERT INTO switch_journal (id, payment_id, fact, amount_minor, currency, source, reference, proof_ref, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`sj_${shortCode(14).toLowerCase()}`, paymentId, fact, amountMinor, currency, source, reference, proofRef, occurredAt, now());
}

/** Optimistic state change: the row must still be at the version we read. Returns the new version. */
function transition(p: SwitchPaymentRow, to: SwitchState, source: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, proofRef: string | null = null): number {
  if (p.status === to) return p.state_version;
  if (!TRANSITIONS[p.status].includes(to)) throw conflict(`Payment cannot move from ${p.status} to ${to}`, 'invalid_switch_transition');
  const db = getDb();
  const sets = ['status = ?', 'state_version = state_version + 1', 'updated_at = ?'];
  const params: unknown[] = [to, now()];
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = ?`);
    params.push(v);
  }
  const res = db.prepare(`UPDATE switch_payments SET ${sets.join(', ')} WHERE id = ? AND state_version = ?`).run(...params, p.id, p.state_version);
  if (!res.changes) throw conflict('Payment changed concurrently; re-read and retry', 'stale_state_version');
  appendEvent(p.id, `payment.${to.toLowerCase()}`, source, p.status, to, p.state_version + 1, payload, proofRef);
  recordEvent('switch', p.id, `switch.${to.toLowerCase()}`, { type: 'system' }, { from: p.status, source, ...payload });
  return p.state_version + 1;
}

export interface SwitchPaymentView {
  payment_id: string;
  object: 'payment';
  merchant_order_id: string;
  product: string;
  status: SwitchState;
  state_version: number;
  amount: { currency: string; value_minor: string };
  route: { class: string; rail: string; access_mode: string | null; scheme_id: string | null; policy_version: number | null; config_version: string | null; rule: string | null };
  authorization_status: string;
  beneficiary_credit_status: string;
  settlement_status: string;
  reconciliation_status: string;
  resolution_status: string;
  payer: { participant_id: string; account_masked: string | null };
  beneficiary_binding_id: string;
  consent_reference: string | null;
  tracking_reference: string;
  external_reference: string | null;
  intent_id: string | null;
  description: string | null;
  rejection: { code: string; message: string } | null;
  action: { type: string; message: string } | null;
  customer_message: { fr: string; en: string };
  /** The aggregator's fee on this payment: quoted before emission, accrued (with its period and status) once completed. */
  fees: { aggregation: FeeEntry | (FeeQuote & { status: 'quoted' }) };
  simulation: boolean;
  expires_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}
export function paymentView(p: SwitchPaymentRow): SwitchPaymentView {
  const route = parseJson<Partial<RouteDecision>>(p.route, {});
  const rejection = p.rejection ? parseJson<{ code: string; message: string }>(p.rejection, null as any) : null;
  const conn = p.connection_id ? (getDb().prepare('SELECT adapter FROM switch_connections WHERE id = ?').get(p.connection_id) as any) : null;
  const cur = getCurrency(p.currency, false);
  return {
    payment_id: p.id,
    object: 'payment',
    merchant_order_id: p.merchant_order_id,
    product: p.product,
    status: p.status,
    state_version: p.state_version,
    amount: { currency: p.currency, value_minor: String(p.amount_minor) },
    route: {
      class: route.class ?? 'UNSUPPORTED',
      rail: route.rail ?? 'NONE',
      access_mode: route.accessMode ?? null,
      scheme_id: route.schemeId ?? null,
      policy_version: route.policyVersion ?? null,
      config_version: route.configVersion ?? null,
      rule: route.rule ?? null,
    },
    authorization_status: p.authorization_status,
    beneficiary_credit_status: p.beneficiary_credit_status,
    settlement_status: p.settlement_status,
    reconciliation_status: p.reconciliation_status,
    resolution_status: p.resolution_status,
    payer: { participant_id: p.payer_participant_id, account_masked: p.payer_account_token ? mask(p.payer_account_token) : null },
    beneficiary_binding_id: p.beneficiary_binding_id,
    consent_reference: p.consent_reference,
    tracking_reference: `${p.id}${p.switch_correlation_id ? `/${p.switch_correlation_id}` : ''}`,
    external_reference: p.external_reference,
    intent_id: p.intent_id,
    description: p.description,
    rejection,
    action: p.status === 'REQUIRES_ACTION' ? { type: 'consent', message: 'The payer must authorise this payment with their institution; attach the consent reference to continue.' } : null,
    customer_message: customerMessage(p.status, {
      amount: `${(p.amount_minor / 10 ** cur.decimals).toFixed(cur.decimals)} ${p.currency}`,
      reference: p.external_reference,
      reason: rejection?.message ?? null,
    }),
    fees: { aggregation: feeEntryForPayment(p.id) ?? { ...quoteAggregationFee(p.merchant_user_id, p.amount_minor, p.currency), status: 'quoted' as const } },
    simulation: conn?.adapter === 'simulator',
    expires_at: p.expires_at,
    dispatched_at: p.dispatched_at,
    completed_at: p.completed_at,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

function webhook(p: SwitchPaymentRow, type: string, extra: Record<string, unknown> = {}): void {
  emitEvent(p.merchant_user_id, type, { payment: paymentView(p), ...extra }, { resource: { type: 'payment', id: p.id }, stateVersion: p.state_version });
}

// ---------------------------------------------------------------------------------------------------------------------
// Creation (6.2 normative algorithm, IDM-001/002/003)
// ---------------------------------------------------------------------------------------------------------------------
export interface CreatePaymentBody {
  merchant_order_id: string;
  product: string;
  amount: { currency: string; value_minor: string | number };
  payer: { participant_id: string; account_token?: string | null };
  beneficiary_binding_id: string;
  consent_reference?: string | null;
  expires_at?: string | null;
  description?: string | null;
  channel?: string;
  /** Settle an existing open intent of the merchant (QR intent, point-of-sale sale) instead of opening a new one. */
  intent_id?: string | null;
  metadata?: Record<string, unknown>;
}
const FORBIDDEN_FIELDS = ['rail', 'route', 'sponsor_id', 'sponsor', 'access_mode', 'exemption', 'exception_id', 'connection_id', 'switch', 'bypass', 'currency_override'];

export function createPayment(
  merchant: UserRow,
  apiClientId: string | null,
  body: CreatePaymentBody & Record<string, unknown>,
  idemKey: string | null,
): { created: boolean; payment: SwitchPaymentView } {
  const db = getDb();
  const settings = getSwitchSettings();
  const tenantId = (db.prepare('SELECT organisation_id FROM organisation_members WHERE user_id = ? ORDER BY created_at LIMIT 1').get(merchant.id) as any)?.organisation_id ?? merchant.id;
  const clientId = apiClientId ?? 'session';
  // RTE-002: no caller may steer the route
  const injected = FORBIDDEN_FIELDS.filter((f) => f in body);
  if (injected.length) throw new AppError(400, 'INVALID_REQUEST', `Routing is computed by the server; remove ${injected.join(', ')} from the request`, { rejected_fields: injected });
  if (!body.merchant_order_id?.trim()) throw new AppError(400, 'INVALID_REQUEST', 'merchant_order_id is required');
  if (body.product !== 'MERCHANT_PAYMENT') {
    // aggregator-phase perimeter: wallets, e-money, cards, credit, crypto and any other product are refused server-side and the attempt is audited (T30)
    recordEvent('switch', null, 'perimeter.denied', { type: 'merchant', id: merchant.id }, { product: body.product, merchantOrderId: body.merchant_order_id, apiClientId: clientId });
    throw new AppError(422, 'UNSUPPORTED_PRODUCT', `${body.product} is not available in the aggregator phase; only MERCHANT_PAYMENT is admitted`);
  }
  const currency = String(body.amount?.currency ?? settings.defaultCurrency).toUpperCase();
  getCurrency(currency); // the currency must be enabled on the platform
  const valueStr = String(body.amount?.value_minor ?? '');
  if (!/^\d+$/.test(valueStr) || valueStr === '0') throw new AppError(400, 'INVALID_REQUEST', 'amount.value_minor must be a positive integer expressed as a string (no floating point)');
  const amountMinor = Number(valueStr);
  if (!Number.isSafeInteger(amountMinor)) throw new AppError(400, 'INVALID_REQUEST', 'amount exceeds the supported precision');
  const channel = body.channel ?? 'api';
  const fingerprint = sha256(`${merchant.id}|${body.merchant_order_id}|${body.beneficiary_binding_id}|${amountMinor}|${currency}`);
  // IDM-001
  if (idemKey) {
    const t = db.prepare('SELECT * FROM switch_idempotency WHERE tenant_id = ? AND client_id = ? AND operation = ? AND key = ?').get(tenantId, clientId, 'payments.create', idemKey) as any;
    if (t) {
      if (t.fingerprint !== fingerprint) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with different content');
      if (t.resource_id) return { created: false, payment: paymentView(getPaymentRow(t.resource_id)) };
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'A request with this Idempotency-Key is still being processed');
    }
  }
  // IDM-002
  const dupOrder = db
    .prepare('SELECT id, fingerprint FROM switch_payments WHERE tenant_id = ? AND merchant_user_id = ? AND merchant_order_id = ?')
    .get(tenantId, merchant.id, body.merchant_order_id) as any;
  if (dupOrder) throw new AppError(409, 'ORDER_ALREADY_EXISTS', `Order ${body.merchant_order_id} already has payment ${dupOrder.id}`, { payment_id: dupOrder.id });
  // beneficiary binding: the merchant's own, active
  const binding = db.prepare('SELECT * FROM beneficiary_bindings WHERE id = ?').get(body.beneficiary_binding_id) as any;
  if (!binding || binding.merchant_user_id !== merchant.id) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Beneficiary binding not found');
  if (binding.status !== 'ACTIVE') throw new AppError(422, 'INVALID_REQUEST', `Beneficiary binding is ${binding.status}; only verified, active bindings can receive payments`);
  if (merchant.status !== 'active') throw new AppError(403, 'SCOPE_DENIED', 'Merchant account is not active');
  const caps = countryCapabilities(merchant.country);
  if (caps.licencePhase === 'aggregator' && ['WALLET', 'MINT', 'E_MONEY'].includes(body.product)) throw new AppError(403, 'SCOPE_DENIED', 'Not available in the aggregator phase');
  // policy decision (RTE-001..005)
  const decision = decideRoute({ country: merchant.country ?? 'CD', debtorId: body.payer.participant_id, creditorId: binding.participant_id, product: body.product, channel, currency, amountMinor });
  if (!decision.allowed)
    throw new AppError(decision.rejection!.code === 'SERVICE_UNAVAILABLE' ? 503 : decision.rejection!.code === 'INVALID_REQUEST' ? 400 : 422, decision.rejection!.code, decision.rejection!.message, {
      rule: decision.rule,
      reasons: decision.reasons,
      config_version: decision.configVersion,
    });
  if (decision.rail === 'INTERNAL') throw new AppError(422, 'UNSUPPORTED_PARTICIPANT_PAIR', 'Closed-loop payments use the wallet and QR products, not the switch API');
  // compliance gate (17.3) before emission
  const velocity = (db.prepare('SELECT COUNT(*) c FROM switch_payments WHERE merchant_user_id = ? AND created_at >= ?').get(merchant.id, new Date(Date.now() - 3600_000).toISOString()) as any)
    .c as number;
  if (velocity >= settings.velocityPerHour) throw new AppError(429, 'RATE_LIMITED', `Merchant velocity limit of ${settings.velocityPerHour} payments per hour reached`);
  const hits = screenSanctions({ name: binding.account_name, country: merchant.country });
  if (hits.length) throw new AppError(403, 'SCOPE_DENIED', 'Screening prevented this payment', { flags: hits });
  const consent = validateConsent(body.consent_reference, { merchantUserId: merchant.id, bindingId: binding.id, amountMinor, currency, participantId: body.payer.participant_id });
  const expiresAt = body.expires_at && body.expires_at > now() ? body.expires_at : new Date(Date.now() + 15 * 60_000).toISOString();
  const id = `pay_${shortCode(18).toLowerCase()}`;
  const initial: SwitchState = consent.ok ? 'READY' : 'REQUIRES_ACTION';
  const conn = getConnection(decision.connectionId!);
  const gate = emissionGate(conn);
  if (!gate.allowed && !gate.inquiryOnly && settings.refuseWhenLinkDown && gate.reasons.some((r) => /link down/.test(r)))
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Service temporarily unavailable: the switch link is down; keep your Idempotency-Key and retry', { reasons: gate.reasons });
  // an existing intent (the merchant's QR code or point-of-sale sale) may be settled by this payment: same merchant,
  // still open, same amount and currency; the switch payment then carries the QR intent to SETTLED through the mirror
  const linked = body.intent_id ? getIntentRow(body.intent_id) : null;
  if (body.intent_id) {
    if (!linked || linked.merchant_user_id !== merchant.id) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Intent not found');
    if (!['CREATED', 'REQUIRES_PAYMENT_METHOD', 'ROUTING', 'REQUIRES_CUSTOMER_ACTION'].includes(linked.status))
      throw new AppError(409, 'INVALID_REQUEST', `Intent ${linked.id} is ${linked.status}; only an open intent can be settled through the switch`);
    if (linked.amount_minor !== amountMinor || linked.currency.toUpperCase() !== currency)
      throw new AppError(409, 'INVALID_REQUEST', 'The switch payment must carry exactly the amount and currency of the intent it settles');
    const already = db.prepare('SELECT id FROM switch_payments WHERE intent_id = ? AND status NOT IN (?, ?, ?)').get(linked.id, 'REJECTED', 'EXPIRED', 'CANCELLED') as any;
    if (already) throw new AppError(409, 'ORDER_ALREADY_EXISTS', `Intent ${linked.id} is already being settled by payment ${already.id}`);
  }
  db.transaction(() => {
    const intent = linked
      ? linked
      : createIntent(merchant, {
          amountMinor,
          currency,
          rails: ['national_switch'],
          reference: body.merchant_order_id,
          description: body.description ?? null,
          purposeCode: 'GENERAL_MERCHANT',
          expiresInMinutes: Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 60_000)),
          metadata: { ...(body.metadata ?? {}), switchPaymentId: id },
          source: 'api',
          customerMsisdn: null,
        }).row;
    if (linked) {
      const meta = { ...parseJson(linked.metadata, {}), switchPaymentId: id };
      db.prepare('UPDATE payment_intents SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(meta), now(), linked.id);
    }
    db.prepare('UPDATE payment_intents SET route_connector = ?, updated_at = ? WHERE id = ?').run(conn.id, now(), intent.id);
    db.prepare(
      'INSERT INTO switch_payments (id, tenant_id, merchant_user_id, api_client_id, merchant_order_id, product, intent_id, connection_id, amount_minor, currency, payer_participant_id, payer_account_token, beneficiary_binding_id, beneficiary_binding_version, consent_reference, description, status, state_version, route, expires_at, fingerprint, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      tenantId,
      merchant.id,
      clientId,
      body.merchant_order_id,
      body.product,
      intent.id,
      conn.id,
      amountMinor,
      currency,
      body.payer.participant_id,
      body.payer.account_token ?? null,
      binding.id,
      binding.version,
      consent.ok ? body.consent_reference : null,
      body.description ?? null,
      initial,
      JSON.stringify(decision),
      expiresAt,
      fingerprint,
      JSON.stringify(body.metadata ?? {}),
      now(),
      now(),
    );
    appendEvent(id, 'payment.received', 'merchant', null, 'RECEIVED', 1, {
      merchantOrderId: body.merchant_order_id,
      amountMinor,
      currency,
      decision: { rule: decision.rule, class: decision.class, configVersion: decision.configVersion },
    });
    appendEvent(id, `payment.${initial.toLowerCase()}`, 'orchestrator', 'RECEIVED', initial, 1, { consent: consent.ok ? 'valid' : consent.reason });
    journal(id, 'PRINCIPAL_REQUESTED', amountMinor, currency, 'merchant', body.merchant_order_id);
    if (consent.ok) {
      db.prepare('UPDATE consent_evidence SET payment_id = ?, used_at = ? WHERE reference = ?').run(id, now(), body.consent_reference);
      db.prepare('INSERT INTO outbox_messages (id, kind, payment_id, connection_id, payload, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        `ob_${shortCode(14).toLowerCase()}`,
        'switch.submit',
        id,
        conn.id,
        '{}',
        now(),
        now(),
      );
    }
    if (idemKey)
      db.prepare('INSERT INTO switch_idempotency (tenant_id, client_id, operation, key, fingerprint, resource_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        tenantId,
        clientId,
        'payments.create',
        idemKey,
        fingerprint,
        id,
        'COMMITTED',
        now(),
      );
    recordEvent(
      'switch',
      id,
      'switch.created',
      { type: 'merchant', id: merchant.id },
      {
        intentId: intent.id,
        status: initial,
        accessMode: decision.accessMode,
        participantId: decision.participantId,
        sponsorId: decision.sponsorId,
        schemeId: decision.schemeId,
        policyVersion: decision.policyVersion,
      },
    );
  })();
  const row = getPaymentRow(id);
  webhook(row, 'payment.created');
  if (initial === 'REQUIRES_ACTION') webhook(row, 'payment.action_required', { reason: consent.reason });
  return { created: true, payment: paymentView(row) };
}

export function attachConsent(merchant: UserRow, id: string, consentReference: string): SwitchPaymentView {
  const p = getPaymentRow(id);
  if (p.merchant_user_id !== merchant.id) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Payment not found');
  if (p.status !== 'REQUIRES_ACTION') throw new AppError(409, 'PAYMENT_ALREADY_DISPATCHED', `Payment is ${p.status}`);
  const consent = validateConsent(consentReference, {
    merchantUserId: merchant.id,
    bindingId: p.beneficiary_binding_id,
    amountMinor: p.amount_minor,
    currency: p.currency,
    participantId: p.payer_participant_id,
  });
  if (!consent.ok) throw new AppError(422, 'INVALID_REQUEST', `Consent cannot be used: ${consent.reason}`);
  const db = getDb();
  db.transaction(() => {
    transition(p, 'READY', 'orchestrator', { consent: consentReference }, { consent_reference: consentReference });
    db.prepare('UPDATE consent_evidence SET payment_id = ?, used_at = ? WHERE reference = ?').run(id, now(), consentReference);
    db.prepare('INSERT INTO outbox_messages (id, kind, payment_id, connection_id, payload, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      `ob_${shortCode(14).toLowerCase()}`,
      'switch.submit',
      id,
      p.connection_id,
      '{}',
      now(),
      now(),
    );
  })();
  return paymentView(getPaymentRow(id));
}

export function getPayment(merchantUserId: string | null, id: string): SwitchPaymentView {
  const p = getPaymentRow(id);
  if (merchantUserId && p.merchant_user_id !== merchantUserId) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Payment not found');
  return paymentView(p);
}
export function listPayments(filter: { merchantUserId?: string | null; status?: string | null; connectionId?: string | null; uncertainOnly?: boolean; limit?: number } = {}): SwitchPaymentView[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.merchantUserId) {
    where.push('merchant_user_id = ?');
    params.push(filter.merchantUserId);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.connectionId) {
    where.push('connection_id = ?');
    params.push(filter.connectionId);
  }
  if (filter.uncertainOnly) where.push("(status = 'UNKNOWN' OR resolution_status = 'REVIEW_REQUIRED')");
  return (
    getDb()
      .prepare(`SELECT * FROM switch_payments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, Math.min(200, filter.limit ?? 50)) as SwitchPaymentRow[]
  ).map(paymentView);
}

/** Local cancellation only while non-transmission is guaranteed (same lock as the dispatcher: one SQLite writer). */
export function cancelPayment(merchant: UserRow | null, id: string, actor: Actor, reason?: string | null): SwitchPaymentView {
  const db = getDb();
  db.transaction(() => {
    const p = getPaymentRow(id);
    if (merchant && p.merchant_user_id !== merchant.id) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Payment not found');
    const emitted = db.prepare('SELECT 1 FROM switch_attempts WHERE payment_id = ? AND emission_possible = 1').get(id);
    if (!BEFORE_EMISSION.includes(p.status) || emitted) throw new AppError(409, 'PAYMENT_ALREADY_DISPATCHED', `Payment is ${p.status}; cancellation is no longer possible locally`);
    transition(p, 'CANCELLED', actor.type, { reason: reason ?? null });
    db.prepare("UPDATE outbox_messages SET delivered_at = ?, last_error = 'cancelled' WHERE payment_id = ? AND delivered_at IS NULL").run(now(), id);
    if (p.intent_id) {
      try {
        cancelIntent(p.intent_id, actor, reason ?? 'switch payment cancelled');
      } catch {
        /* intent may already be terminal */
      }
    }
  })();
  const row = getPaymentRow(id);
  webhook(row, 'payment.cancelled');
  return paymentView(row);
}

/** Payments that expire before any possible transmission become EXPIRED; anything possibly transmitted stays UNKNOWN. */
export function expirePayments(): number {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM switch_payments WHERE status IN ('RECEIVED', 'REQUIRES_ACTION', 'READY') AND expires_at < ?`).all(now()) as SwitchPaymentRow[];
  let n = 0;
  for (const p of rows) {
    if (db.prepare('SELECT 1 FROM switch_attempts WHERE payment_id = ? AND emission_possible = 1').get(p.id)) continue;
    transition(p, 'EXPIRED', 'scheduler', { reason: 'expired before any transmission' });
    db.prepare("UPDATE outbox_messages SET delivered_at = ?, last_error = 'expired' WHERE payment_id = ? AND delivered_at IS NULL").run(now(), p.id);
    webhook(getPaymentRow(p.id), 'payment.expired');
    n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------------
// Dispatcher lease with fencing (18.1)
// ---------------------------------------------------------------------------------------------------------------------
export interface Lease {
  owner: string | null;
  fencingToken: number;
  expiresAt: string | null;
}
export function currentLease(name = 'switch'): Lease {
  const r = getDb().prepare('SELECT * FROM dispatcher_lease WHERE name = ?').get(name) as any;
  return r ? { owner: r.owner, fencingToken: r.fencing_token, expiresAt: r.expires_at } : { owner: null, fencingToken: 0, expiresAt: null };
}
/** Acquire or renew; a takeover of an expired (or forced) lease increments the fencing token so the old owner is fenced out. */
export function acquireLease(owner: string, opts: { force?: boolean; ttlSeconds?: number; name?: string } = {}): Lease | null {
  const db = getDb();
  const name = opts.name ?? 'switch';
  const ttl = (opts.ttlSeconds ?? getSwitchSettings().dispatcherLeaseSeconds) * 1000;
  return db.transaction(() => {
    const cur = currentLease(name);
    const expired = !cur.owner || !cur.expiresAt || cur.expiresAt < now();
    if (cur.owner && cur.owner !== owner && !expired && !opts.force) return null;
    const token = cur.owner === owner ? cur.fencingToken : cur.fencingToken + 1;
    db.prepare(
      'INSERT INTO dispatcher_lease (name, owner, fencing_token, expires_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, fencing_token = excluded.fencing_token, expires_at = excluded.expires_at, updated_at = excluded.updated_at',
    ).run(name, owner, token, new Date(Date.now() + ttl).toISOString(), now());
    if (cur.owner !== owner) recordEvent('switch', name, 'dispatcher.lease_taken', { type: 'system' }, { owner, fencingToken: token, from: cur.owner, forced: !!opts.force });
    return { owner, fencingToken: token, expiresAt: new Date(Date.now() + ttl).toISOString() };
  })();
}
function holdsLease(owner: string, token: number, name = 'switch'): boolean {
  const cur = currentLease(name);
  return cur.owner === owner && cur.fencingToken === token && !!cur.expiresAt && cur.expiresAt >= now();
}

// ---------------------------------------------------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------------------------------------------------
function canonical(p: SwitchPaymentRow, conn: SwitchConnection, binding: any): CanonicalPayment {
  const debtor = getParticipant(p.payer_participant_id);
  const creditor = getParticipant(binding.participant_id);
  return {
    paymentId: p.id,
    product: p.product,
    amountMinor: String(p.amount_minor),
    currency: p.currency,
    debtor: { participantId: debtor.id, accountToken: p.payer_account_token, routingId: debtor.routingIds.switchParticipantId ?? null },
    creditor: { participantId: creditor.id, accountToken: binding.account_token, routingId: creditor.routingIds.switchParticipantId ?? null, merchantId: p.merchant_user_id },
    accessMode: conn.accessMode,
    participantId: conn.participantId,
    sponsorId: conn.sponsorId,
    schemeId: conn.schemeId,
    consentReference: p.consent_reference,
    occurredAt: now(),
    description: p.description,
  };
}

/** Mirror onto the platform intent (webhooks, timeline, guardian) without any ledger posting. */
function mirrorIntent(p: SwitchPaymentRow, outcome: 'start' | 'captured' | 'failed' | 'unknown' | 'authorised', detail: Record<string, unknown> = {}): void {
  if (!p.intent_id) return;
  try {
    const attempts = listAttempts(p.intent_id);
    const open = attempts.find((a) => ['CREATED', 'PROCESSING', 'AUTHORISED', 'UNKNOWN'].includes(a.status));
    if (outcome === 'start') {
      if (!open) {
        reconcileOpenAttempt(p.intent_id);
        const r = getIntentRow(p.intent_id);
        if (r.status === 'CREATED') return;
        startAttempt(p.intent_id, { methodClass: 'national_switch', rail: 'national_switch', connector: p.connection_id, providerRef: p.external_message_id }, { type: 'system' });
      }
      return;
    }
    if (!open) return;
    finishAttempt(
      open.id,
      outcome === 'captured' ? 'CAPTURED' : outcome === 'failed' ? 'FAILED' : outcome === 'authorised' ? 'AUTHORISED' : 'UNKNOWN',
      { providerRef: p.external_reference ?? p.external_message_id, failureCategory: outcome === 'failed' ? 'declined' : null, error: (detail.reason as string) ?? null, source: 'processor' },
      { type: 'processor', id: p.connection_id },
    );
  } catch (err) {
    recordEvent('switch', p.id, 'intent.mirror_failed', { type: 'system' }, { error: (err as Error).message });
  }
}

/**
 * Emit one payment. The attempt row (stable message id, emission_possible=1) is committed BEFORE the network call;
 * the adapter's answer, or its absence, is applied afterwards. Returns what happened for the console.
 */
export async function emitPayment(paymentId: string, ctx: { owner: string; fencingToken: number }): Promise<{ result: string; payment: SwitchPaymentView }> {
  const db = getDb();
  let p = getPaymentRow(paymentId);
  if (p.status !== 'READY') return { result: `skipped:${p.status}`, payment: paymentView(p) };
  const conn = getConnection(p.connection_id!);
  const binding = db.prepare('SELECT * FROM beneficiary_bindings WHERE id = ?').get(p.beneficiary_binding_id) as any;
  // RTE-006 revalidation of every revocable control
  const route = parseJson<RouteDecision>(p.route, {} as RouteDecision);
  const re = revalidateBeforeEmission({
    country: (findUserById(p.merchant_user_id)?.country ?? 'CD') as string,
    debtorId: p.payer_participant_id,
    creditorId: binding.participant_id,
    product: p.product,
    channel: route.channel ?? 'api',
    currency: p.currency,
    amountMinor: p.amount_minor,
    policyVersion: route.policyVersion ?? 0,
    connectionId: p.connection_id,
  });
  const reasons = [...re.reasons];
  if (binding.status !== 'ACTIVE' || binding.version !== p.beneficiary_binding_version) reasons.push('beneficiary binding changed or no longer active');
  const merchant = findUserById(p.merchant_user_id);
  if (!merchant || merchant.status !== 'active') reasons.push('merchant no longer active');
  const consentRow = p.consent_reference ? (db.prepare('SELECT expires_at FROM consent_evidence WHERE reference = ?').get(p.consent_reference) as any) : null;
  if (!consentRow || consentRow.expires_at < now()) reasons.push('consent expired or missing');
  if (p.expires_at < now()) reasons.push('payment expired');
  if (reasons.length) {
    const gateDown = reasons.some((r) => /link down|registry|unavailable/i.test(r)) && p.expires_at >= now();
    if (gateDown) return { result: 'deferred:' + reasons[0], payment: paymentView(p) };
    // a lapse of time (payment or consent expiry) while queued is an expiry; a revoked right is a documented rejection
    const lapsed = p.expires_at < now() || reasons.some((r) => /consent expired/.test(r));
    transition(
      p,
      lapsed ? 'EXPIRED' : 'REJECTED',
      'orchestrator',
      { reasons },
      { rejection: JSON.stringify({ code: lapsed ? 'EXPIRED_BEFORE_EMISSION' : 'REVALIDATION_FAILED', message: reasons[0] }) },
    );
    db.prepare("UPDATE outbox_messages SET delivered_at = ?, last_error = ? WHERE payment_id = ? AND kind = 'switch.submit' AND delivered_at IS NULL").run(now(), reasons[0], p.id);
    p = getPaymentRow(p.id);
    webhook(p, p.status === 'EXPIRED' ? 'payment.expired' : 'payment.rejected', { reasons });
    return { result: 'rejected_before_emission', payment: paymentView(p) };
  }
  // fencing: an old leader never emits
  if (!holdsLease(ctx.owner, ctx.fencingToken)) {
    recordEvent('switch', p.id, 'dispatcher.fenced', { type: 'system' }, { owner: ctx.owner, fencingToken: ctx.fencingToken, current: currentLease() });
    return { result: 'fenced', payment: paymentView(p) };
  }
  const gate = emissionGate(conn);
  if (!gate.allowed || gate.inquiryOnly) return { result: 'deferred:' + (gate.reasons[0] ?? 'inquiry-only'), payment: paymentView(p) };
  // IDM-003: persist the stable identity before any network write
  const seq = ((db.prepare('SELECT MAX(seq) m FROM switch_attempts WHERE payment_id = ?').get(p.id) as any).m ?? 0) + 1;
  const stableMessageId = `${p.id}-${seq}`;
  const attemptId = `sa_${shortCode(14).toLowerCase()}`;
  db.transaction(() => {
    db.prepare(
      'INSERT INTO switch_attempts (id, payment_id, seq, kind, stable_message_id, access_mode, participant_id, sponsor_id, fencing_token, emission_possible, sent_at, status, codec_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
    ).run(attemptId, p.id, seq, 'SUBMIT', stableMessageId, conn.accessMode, conn.participantId, conn.sponsorId, ctx.fencingToken, now(), 'SENT', conn.profileVersion, now());
    transition(
      p,
      'DISPATCHING',
      'dispatcher',
      { attemptId, stableMessageId, accessMode: conn.accessMode, participantId: conn.participantId, sponsorId: conn.sponsorId, schemeId: conn.schemeId },
      { external_message_id: stableMessageId, dispatched_at: now() },
    );
  })();
  p = getPaymentRow(p.id);
  mirrorIntent(p, 'start');
  let obs: ExternalObservation | null = null;
  let timeout: SwitchTimeoutError | null = null;
  try {
    obs = await adapterFor(conn).submit(canonical(p, conn, binding), stableMessageId);
  } catch (err) {
    if (err instanceof SwitchTimeoutError) timeout = err;
    else {
      // any other failure after the identity was persisted is treated as uncertain too (IDM-004)
      timeout = new SwitchTimeoutError(stableMessageId, false);
      recordEvent('switch', p.id, 'adapter.error', { type: 'system' }, { error: (err as Error).message });
    }
  }
  if (obs) {
    db.prepare('UPDATE switch_attempts SET responded_at = ?, status = ? WHERE id = ?').run(now(), 'RESPONDED', attemptId);
    const applied = applyObservation(p.id, obs, { source: 'sync_response', attemptId });
    // a response we cannot trust (unknown code, invalid signature) leaves the outcome unknown: inquire, never resend
    if (applied.outcome.startsWith('quarantined')) markUncertain(p.id, attemptId, `response quarantined (${applied.outcome})`);
  } else {
    markUncertain(p.id, attemptId, timeout?.afterEffect ? 'timeout after possible financial effect' : 'no response within the timeout');
  }
  p = getPaymentRow(p.id);
  return { result: obs ? `observed:${obs.kind}` : 'uncertain', payment: paymentView(p) };
}

function markUncertain(paymentId: string, attemptId: string, reason: string): void {
  const db = getDb();
  const settings = getSwitchSettings();
  const p = getPaymentRow(paymentId);
  db.prepare("UPDATE switch_attempts SET status = 'UNCERTAIN' WHERE id = ?").run(attemptId);
  if (p.status === 'DISPATCHING' || p.status === 'PENDING' || p.status === 'AUTHORIZED') transition(p, 'UNKNOWN', 'dispatcher', { attemptId, reason });
  scheduleInquiry(paymentId, attemptId, 1, settings.inquiryDelaysSeconds[0] ?? 10);
  const fresh = getPaymentRow(paymentId);
  mirrorIntent(fresh, 'unknown', { reason });
  webhook(fresh, 'payment.unknown', { reason });
}

function scheduleInquiry(paymentId: string, attemptId: string, n: number, delaySeconds: number): void {
  getDb()
    .prepare('INSERT INTO outbox_messages (id, kind, payment_id, connection_id, payload, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      `ob_${shortCode(14).toLowerCase()}`,
      'switch.inquire',
      paymentId,
      getPaymentRow(paymentId).connection_id,
      JSON.stringify({ attemptId, n }),
      new Date(Date.now() + delaySeconds * 1000).toISOString(),
      now(),
    );
}

/** Inquiry: never a resend. Provisional NOT_FOUND keeps UNKNOWN; after the configured number of inquiries a LOCAL_ONLY case opens. */
export async function inquirePayment(paymentId: string, attemptId: string, n: number): Promise<{ result: string }> {
  const db = getDb();
  const settings = getSwitchSettings();
  const p = getPaymentRow(paymentId);
  const a = db.prepare('SELECT * FROM switch_attempts WHERE id = ?').get(attemptId) as any;
  if (!a) return { result: 'no_attempt' };
  if (!['UNKNOWN', 'PENDING', 'AUTHORIZED', 'DISPATCHING'].includes(p.status)) return { result: `settled:${p.status}` };
  const conn = getConnection(p.connection_id!);
  let obs: ExternalObservation | null = null;
  try {
    obs = await adapterFor(conn).inquire({ stableMessageId: a.stable_message_id, externalReference: p.external_reference, correlationId: p.switch_correlation_id });
  } catch (err) {
    recordEvent('switch', p.id, 'inquiry.failed', { type: 'system' }, { n, error: (err as Error).message });
  }
  recordEvent('switch', p.id, 'inquiry.made', { type: 'system' }, { n, kind: obs?.kind ?? null, code: obs?.externalCode ?? null });
  if (obs) applyObservation(p.id, obs, { source: `inquiry:${n}`, attemptId });
  const after = getPaymentRow(paymentId);
  if (['UNKNOWN', 'PENDING', 'AUTHORIZED', 'DISPATCHING'].includes(after.status)) {
    if (n < settings.maxInquiries) scheduleInquiry(paymentId, attemptId, n + 1, settings.inquiryDelaysSeconds[Math.min(n, settings.inquiryDelaysSeconds.length - 1)] ?? 60);
    else {
      openCase({
        connectionId: conn.id,
        class: 'LOCAL_ONLY',
        paymentId: p.id,
        exposureMinor: p.amount_minor,
        currency: p.currency,
        references: { stableMessageId: a.stable_message_id, inquiries: n },
        sources: ['BITRIPAY'],
        merchantUserId: p.merchant_user_id,
      });
      openIncident('P2', `Payment ${p.id} still uncertain after ${n} inquiries`, 'Escalate to the switch operator; the payment stays UNKNOWN and is never re-emitted.', 'switch_payment', p.id);
    }
  }
  return { result: obs ? `observed:${obs.kind}` : 'no_answer' };
}

/** IDM-004 recovery worker: attempts sent without a persisted response after the timeout become uncertain and get an inquiry, never a resend. */
export function recoverUncertainEmissions(): number {
  const db = getDb();
  const settings = getSwitchSettings();
  const cutoff = new Date(Date.now() - settings.uncertainTimeoutSeconds * 1000).toISOString();
  const rows = db.prepare("SELECT * FROM switch_attempts WHERE status = 'SENT' AND emission_possible = 1 AND responded_at IS NULL AND sent_at < ?").all(cutoff) as any[];
  for (const a of rows) {
    recordEvent('switch', a.payment_id, 'recovery.uncertain_emission', { type: 'system' }, { attemptId: a.id, stableMessageId: a.stable_message_id, sentAt: a.sent_at });
    markUncertain(a.payment_id, a.id, 'crash or restart after transmission before the response was persisted');
  }
  // payments acknowledged but never concluded past the product timeout are monitored through the inquiry chain (never resent)
  const stuck = db
    .prepare(
      `SELECT p.id, (SELECT id FROM switch_attempts WHERE payment_id = p.id ORDER BY seq DESC LIMIT 1) attempt_id FROM switch_payments p
    WHERE p.status IN ('PENDING', 'AUTHORIZED') AND p.dispatched_at < ? AND NOT EXISTS (SELECT 1 FROM outbox_messages o WHERE o.payment_id = p.id AND o.kind = 'switch.inquire')`,
    )
    .all(cutoff) as any[];
  for (const s of stuck) {
    if (!s.attempt_id) continue;
    recordEvent('switch', s.id, 'recovery.pending_timeout', { type: 'system' }, { attemptId: s.attempt_id, timeoutSeconds: settings.uncertainTimeoutSeconds });
    scheduleInquiry(s.id, s.attempt_id, 1, 0);
  }
  return rows.length + stuck.length;
}

/** Process due outbox messages under the lease; submits are throttled to leave the inquiry reserve. */
export async function dispatchOutbox(
  owner: string,
  opts: { limit?: number; force?: boolean } = {},
): Promise<{ processed: number; results: { id: string; kind: string; result: string }[]; lease: Lease | null }> {
  const db = getDb();
  const lease = acquireLease(owner, { force: opts.force });
  if (!lease) return { processed: 0, results: [], lease: currentLease() };
  const rows = db
    .prepare('SELECT * FROM outbox_messages WHERE delivered_at IS NULL AND dead = 0 AND available_at <= ? AND (lease_until IS NULL OR lease_until < ?) ORDER BY available_at LIMIT ?')
    .all(now(), now(), opts.limit ?? 50) as any[];
  const results: { id: string; kind: string; result: string }[] = [];
  const quotas = new Map<string, { submits: number; inquiries: number }>();
  for (const m of rows) {
    const conn = m.connection_id ? getConnection(m.connection_id) : null;
    const q = quotas.get(m.connection_id) ?? { submits: 0, inquiries: 0 };
    const perTick = conn?.quotaPerSecond ?? 20;
    const submitCap = Math.max(1, Math.floor((perTick * (100 - (conn?.inquiryReservePct ?? 25))) / 100));
    if (m.kind === 'switch.submit' && q.submits >= submitCap) continue;
    if (m.kind !== 'switch.submit' && q.inquiries >= perTick) continue;
    const leased = db
      .prepare('UPDATE outbox_messages SET lease_until = ?, lease_owner = ?, attempts = attempts + 1 WHERE id = ? AND delivered_at IS NULL AND (lease_until IS NULL OR lease_until < ?)')
      .run(new Date(Date.now() + 60_000).toISOString(), owner, m.id, now());
    if (!leased.changes) continue;
    let result = 'unknown';
    try {
      const payload = parseJson<Record<string, any>>(m.payload, {});
      if (m.kind === 'switch.submit') {
        q.submits += 1;
        const r = await emitPayment(m.payment_id, { owner, fencingToken: lease.fencingToken });
        result = r.result;
        if (result.startsWith('deferred') || result === 'fenced') {
          db.prepare('UPDATE outbox_messages SET lease_until = NULL, available_at = ?, last_error = ? WHERE id = ?').run(new Date(Date.now() + 30_000).toISOString(), result, m.id);
          if (m.attempts + 1 >= m.max_attempts && getPaymentRow(m.payment_id).expires_at < now()) db.prepare('UPDATE outbox_messages SET dead = 1 WHERE id = ?').run(m.id);
          results.push({ id: m.id, kind: m.kind, result });
          continue;
        }
      } else if (m.kind === 'switch.inquire') {
        q.inquiries += 1;
        result = (await inquirePayment(m.payment_id, payload.attemptId, payload.n ?? 1)).result;
      } else if (m.kind === 'switch.refund' || m.kind === 'switch.reversal') {
        q.submits += 1;
        result = (await emitLinkedOperation(payload.operationId, { owner, fencingToken: lease.fencingToken })).result;
      }
      db.prepare('UPDATE outbox_messages SET delivered_at = ?, lease_until = NULL, last_error = NULL WHERE id = ?').run(now(), m.id);
    } catch (err) {
      result = `error:${(err as Error).message}`;
      const dead = m.attempts + 1 >= m.max_attempts;
      db.prepare('UPDATE outbox_messages SET lease_until = NULL, available_at = ?, last_error = ?, dead = ? WHERE id = ?').run(
        new Date(Date.now() + 30_000).toISOString(),
        (err as Error).message,
        dead ? 1 : 0,
        m.id,
      );
      if (dead) openIncident('P2', `Outbox message ${m.id} dead-lettered`, (err as Error).message, 'outbox', m.id);
    }
    quotas.set(m.connection_id, q);
    results.push({ id: m.id, kind: m.kind, result });
  }
  return { processed: results.length, results, lease };
}

// ---------------------------------------------------------------------------------------------------------------------
// Observations (8.1/8.2, IDM-006)
// ---------------------------------------------------------------------------------------------------------------------
export interface ApplyResult {
  applied: boolean;
  outcome: string;
  status: SwitchState;
}
export function applyObservation(paymentId: string, obs: ExternalObservation, ctx: { source: string; attemptId?: string | null; inboundId?: string | null }): ApplyResult {
  const db = getDb();
  const proofRef = storeEvidence('switch_observation', paymentId, obs.raw, {
    kind: obs.kind,
    code: obs.externalCode,
    externalMessageId: obs.externalMessageId,
    authority: obs.authority,
    source: ctx.source,
    signatureValid: obs.signatureValid,
  });
  let p = getPaymentRow(paymentId);
  const conn = getConnection(p.connection_id!);
  const done = (outcome: string) => ({ applied: outcome.startsWith('applied'), outcome, status: getPaymentRow(paymentId).status });
  // signature and catalogue gates (quarantine, never success or definitive rejection)
  if (!obs.signatureValid) {
    quarantine(conn.id, obs, paymentId, 'INVALID_SIGNATURE', proofRef);
    return done('quarantined:invalid_signature');
  }
  if (obs.kind === 'MALFORMED') {
    quarantine(conn.id, obs, paymentId, 'MALFORMED', proofRef);
    return done('quarantined:malformed');
  }
  const entry = catalogueFor(p.product, obs.externalCode);
  if (!entry) {
    quarantine(conn.id, obs, paymentId, `UNKNOWN_CODE:${obs.externalCode}`, proofRef);
    openIncident(
      'P2',
      `Unknown external code ${obs.externalCode} on ${p.id}`,
      'Quarantined; add the code to the versioned catalogue after confirming its meaning with the scheme.',
      'switch_payment',
      p.id,
    );
    return done('quarantined:unknown_code');
  }
  // IDM-006 deduplication on the external message id
  const seen = db.prepare("SELECT payload FROM switch_events WHERE payment_id = ? AND json_extract(payload, '$.externalMessageId') = ?").all(paymentId, obs.externalMessageId) as any[];
  if (seen.length) {
    const prior = parseJson<Record<string, unknown>>(seen[0].payload, {});
    const same = prior.bodyHash === bodyHash(obs);
    appendEvent(
      paymentId,
      same ? 'observation.duplicate' : 'observation.integrity_conflict',
      ctx.source,
      null,
      null,
      p.state_version,
      { externalMessageId: obs.externalMessageId, code: obs.externalCode, bodyHash: bodyHash(obs), prior: prior.bodyHash },
      proofRef,
      obs.occurredAt,
    );
    if (!same) {
      openCase({
        connectionId: conn.id,
        class: 'INTEGRITY',
        paymentId,
        exposureMinor: p.amount_minor,
        currency: p.currency,
        references: { externalMessageId: obs.externalMessageId, priorHash: prior.bodyHash, newHash: bodyHash(obs) },
        sources: [obs.authority],
      });
      db.prepare("UPDATE switch_payments SET resolution_status = 'REVIEW_REQUIRED', updated_at = ? WHERE id = ?").run(now(), paymentId);
      return done('integrity_incident');
    }
    return done('duplicate_acknowledged');
  }
  const payload = {
    kind: obs.kind,
    code: obs.externalCode,
    externalMessageId: obs.externalMessageId,
    externalReference: obs.externalReference,
    correlationId: obs.correlationId,
    authority: obs.authority,
    catalogue: entry.id,
    finality: entry.finality,
    bodyHash: bodyHash(obs),
    receivedAt: obs.receivedAt,
    occurredAt: obs.occurredAt,
    attemptId: ctx.attemptId ?? null,
  };
  const record = (type: string) => appendEvent(paymentId, type, ctx.source, p.status, null, p.state_version, payload, proofRef, obs.occurredAt);
  const setRefs = () =>
    db
      .prepare('UPDATE switch_payments SET external_reference = COALESCE(external_reference, ?), switch_correlation_id = COALESCE(switch_correlation_id, ?), updated_at = ? WHERE id = ?')
      .run(obs.externalReference, obs.correlationId, now(), paymentId);
  if (ctx.attemptId) db.prepare('UPDATE switch_attempts SET observation = ?, responded_at = COALESCE(responded_at, ?) WHERE id = ?').run(JSON.stringify(payload), now(), ctx.attemptId);

  switch (entry.transition) {
    case 'PENDING': {
      setRefs();
      p = getPaymentRow(paymentId);
      if (p.status === 'DISPATCHING' || p.status === 'UNKNOWN') {
        transition(p, 'PENDING', ctx.source, payload, {}, proofRef);
        webhook(getPaymentRow(paymentId), 'payment.pending');
        return done('applied:PENDING');
      }
      record(p.status === 'COMPLETED' ? 'observation.ignored_regression' : 'observation.recorded');
      return done(p.status === 'COMPLETED' ? 'ignored_regression' : 'recorded');
    }
    case 'AUTHORIZED': {
      setRefs();
      p = getPaymentRow(paymentId);
      if (['DISPATCHING', 'PENDING', 'UNKNOWN'].includes(p.status)) {
        transition(p, 'AUTHORIZED', ctx.source, payload, { authorization_status: 'AUTHORIZED' }, proofRef);
        mirrorIntent(getPaymentRow(paymentId), 'authorised');
        return done('applied:AUTHORIZED');
      }
      record(p.status === 'COMPLETED' ? 'observation.ignored_regression' : 'observation.recorded');
      return done('recorded');
    }
    case 'COMPLETED': {
      const proofOk = obs.signatureValid && !!obs.externalReference;
      if (!proofOk) {
        record('observation.insufficient_proof');
        return done('insufficient_proof');
      }
      setRefs();
      p = getPaymentRow(paymentId);
      if (['DISPATCHING', 'PENDING', 'AUTHORIZED', 'UNKNOWN'].includes(p.status)) {
        if (obs.amountMinor && Number(obs.amountMinor) !== p.amount_minor) {
          record('observation.amount_conflict');
          openCase({
            connectionId: conn.id,
            class: 'AMOUNT_MISMATCH',
            paymentId,
            exposureMinor: Math.abs(Number(obs.amountMinor) - p.amount_minor),
            currency: p.currency,
            references: { externalReference: obs.externalReference, local: p.amount_minor, external: obs.amountMinor },
            sources: ['BITRIPAY', obs.authority],
            merchantUserId: p.merchant_user_id,
          });
          db.prepare("UPDATE switch_payments SET resolution_status = 'REVIEW_REQUIRED', updated_at = ? WHERE id = ?").run(now(), paymentId);
          return done('amount_conflict');
        }
        transition(
          p,
          'COMPLETED',
          ctx.source,
          payload,
          {
            beneficiary_credit_status: obs.authority === 'CREDITOR' ? 'CONFIRMED' : 'REPORTED',
            authorization_status: p.authorization_status === 'NOT_OBSERVED' ? 'IMPLIED' : p.authorization_status,
            completed_at: obs.occurredAt,
            reconciliation_status: 'DUE',
          },
          proofRef,
        );
        journal(paymentId, 'CREDIT_CONFIRMED', p.amount_minor, p.currency, obs.authority, obs.externalReference, proofRef, obs.occurredAt);
        if (ctx.attemptId) db.prepare("UPDATE switch_attempts SET status = 'COMPLETED' WHERE id = ?").run(ctx.attemptId);
        const fresh = getPaymentRow(paymentId);
        // the aggregator's remuneration: accrued for invoicing, never deducted from the interbank flow
        accrueAggregationFee(fresh);
        mirrorIntent(fresh, 'captured');
        webhook(fresh, 'payment.completed');
        return done('applied:COMPLETED');
      }
      record(p.status === 'COMPLETED' ? 'observation.repeat_completion' : 'observation.recorded');
      if (p.status === 'REJECTED') {
        openCase({
          connectionId: conn.id,
          class: 'STATUS_CONFLICT',
          paymentId,
          exposureMinor: p.amount_minor,
          currency: p.currency,
          references: { local: 'REJECTED', external: 'COMPLETED', externalMessageId: obs.externalMessageId },
          sources: ['BITRIPAY', obs.authority],
          merchantUserId: p.merchant_user_id,
        });
        db.prepare("UPDATE switch_payments SET resolution_status = 'REVIEW_REQUIRED', updated_at = ? WHERE id = ?").run(now(), paymentId);
        return done('status_conflict');
      }
      return done('recorded');
    }
    case 'REJECTED': {
      p = getPaymentRow(paymentId);
      if (p.status === 'COMPLETED') {
        // T13: authentic contradictory rejection after completion — both proofs kept, no regression, no automatic compensation
        record('observation.contradiction');
        openCase({
          connectionId: conn.id,
          class: 'STATUS_CONFLICT',
          paymentId,
          exposureMinor: p.amount_minor,
          currency: p.currency,
          references: { local: 'COMPLETED', external: `REJECTED:${obs.externalCode}`, externalMessageId: obs.externalMessageId, reason: obs.reason },
          sources: ['BITRIPAY', obs.authority],
          merchantUserId: p.merchant_user_id,
        });
        db.prepare("UPDATE switch_payments SET resolution_status = 'REVIEW_REQUIRED', updated_at = ? WHERE id = ?").run(now(), paymentId);
        return done('status_conflict');
      }
      if (p.status === 'AUTHORIZED' && !obs.resolvesAuthorization) {
        record('observation.rejection_without_authorization_resolution');
        openCase({
          connectionId: conn.id,
          class: 'STATUS_CONFLICT',
          paymentId,
          exposureMinor: p.amount_minor,
          currency: p.currency,
          references: { local: 'AUTHORIZED', external: `REJECTED:${obs.externalCode}` },
          sources: ['BITRIPAY', obs.authority],
          merchantUserId: p.merchant_user_id,
        });
        db.prepare("UPDATE switch_payments SET resolution_status = 'REVIEW_REQUIRED', updated_at = ? WHERE id = ?").run(now(), paymentId);
        return done('authorization_unresolved');
      }
      if (['DISPATCHING', 'PENDING', 'AUTHORIZED', 'UNKNOWN'].includes(p.status)) {
        transition(
          p,
          'REJECTED',
          ctx.source,
          payload,
          { rejection: JSON.stringify({ code: obs.externalCode, message: obs.reason ?? entry.meaning }), authorization_status: p.status === 'AUTHORIZED' ? 'RESOLVED' : 'DECLINED' },
          proofRef,
        );
        if (ctx.attemptId) db.prepare("UPDATE switch_attempts SET status = 'REJECTED' WHERE id = ?").run(ctx.attemptId);
        const fresh = getPaymentRow(paymentId);
        mirrorIntent(fresh, 'failed', { reason: obs.reason ?? entry.meaning });
        webhook(fresh, 'payment.rejected', { reason: obs.reason ?? entry.meaning });
        return done('applied:REJECTED');
      }
      record('observation.recorded');
      return done('recorded');
    }
    case 'KEEP': {
      record('observation.provisional_not_found');
      return done('provisional_not_found');
    }
    case 'RE_EMISSION_ALLOWED': {
      p = getPaymentRow(paymentId);
      record('observation.definitive_not_found');
      if (p.status === 'UNKNOWN' && ctx.attemptId) {
        db.prepare("UPDATE switch_attempts SET status = 'NOT_FOUND', emission_possible = 0 WHERE id = ?").run(ctx.attemptId);
        if (p.expires_at >= now()) {
          transition(p, 'READY', ctx.source, { ...payload, reason: 'definitive NOT_FOUND: re-emission with the same identity allowed by the catalogue' }, {}, proofRef);
          mirrorIntent(getPaymentRow(paymentId), 'failed', { reason: 'not found: re-emission' });
          db.prepare('INSERT INTO outbox_messages (id, kind, payment_id, connection_id, payload, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
            `ob_${shortCode(14).toLowerCase()}`,
            'switch.submit',
            paymentId,
            conn.id,
            '{}',
            now(),
            now(),
          );
          return done('applied:READY');
        }
        transition(
          p,
          'REJECTED',
          ctx.source,
          { ...payload, reason: 'definitive NOT_FOUND after expiry' },
          { rejection: JSON.stringify({ code: obs.externalCode, message: 'not found by the switch; expired' }) },
          proofRef,
        );
        mirrorIntent(getPaymentRow(paymentId), 'failed', { reason: 'not found' });
        webhook(getPaymentRow(paymentId), 'payment.rejected');
        return done('applied:REJECTED');
      }
      return done('recorded');
    }
    default:
      record('observation.recorded');
      return done('recorded');
  }
}
const bodyHash = (obs: ExternalObservation) => sha256(`${obs.kind}|${obs.externalCode}|${obs.externalReference ?? ''}|${obs.amountMinor ?? ''}|${obs.currency ?? ''}|${obs.reason ?? ''}`);

function quarantine(connectionId: string, obs: ExternalObservation, paymentId: string | null, reason: string, proofRef: string): void {
  const db = getDb();
  db.prepare(
    'INSERT OR IGNORE INTO inbox_messages (id, connection_id, source, external_message_id, fingerprint, payment_id, verified, quarantine, reason, payload, proof_ref, occurred_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)',
  ).run(
    `in_${shortCode(14).toLowerCase()}`,
    connectionId,
    obs.authority,
    obs.externalMessageId,
    bodyHash(obs),
    paymentId,
    obs.signatureValid ? 1 : 0,
    reason,
    JSON.stringify({ kind: obs.kind, code: obs.externalCode, externalReference: obs.externalReference, reason: obs.reason }),
    proofRef,
    obs.occurredAt,
    obs.receivedAt,
  );
  if (paymentId)
    appendEvent(
      paymentId,
      'observation.quarantined',
      obs.authority,
      null,
      null,
      getPaymentRow(paymentId).state_version,
      { externalMessageId: obs.externalMessageId, code: obs.externalCode, reason },
      proofRef,
      obs.occurredAt,
    );
  recordEvent('switch', paymentId, 'inbox.quarantined', { type: 'system' }, { reason, code: obs.externalCode, externalMessageId: obs.externalMessageId });
}

/** Inbound message from the switch/institutions: verify, deduplicate, correlate, apply. Duplicates get the ACK and no effect. */
export function ingestInbound(
  connectionId: string,
  raw: Uint8Array,
  transport: TransportEvidence,
): { ack: boolean; duplicate: boolean; quarantined: boolean; outcome: string; paymentId: string | null } {
  const db = getDb();
  const conn = getConnection(connectionId);
  const obs = adapterFor(conn).verifyAndDecodeInbound(raw, transport);
  const fingerprint = bodyHash(obs);
  const proofRef = storeEvidence('switch_inbound', obs.stableMessageId, obs.raw, { externalMessageId: obs.externalMessageId, source: transport.source, signatureValid: obs.signatureValid });
  const existing = db.prepare('SELECT * FROM inbox_messages WHERE connection_id = ? AND source = ? AND external_message_id = ?').get(connectionId, transport.source, obs.externalMessageId) as any;
  if (existing) {
    if (existing.fingerprint === fingerprint) {
      recordEvent('switch', existing.payment_id, 'inbox.duplicate', { type: 'processor', id: connectionId }, { externalMessageId: obs.externalMessageId });
      return { ack: true, duplicate: true, quarantined: !!existing.quarantine, outcome: 'duplicate_acknowledged', paymentId: existing.payment_id };
    }
    // same external id, different content: integrity incident (IDM-006, T28)
    openIncident(
      'P1',
      `Integrity: external message ${obs.externalMessageId} received with different content`,
      'Two different bodies under one external identifier; security review before any processing.',
      'inbox',
      existing.id,
    );
    if (existing.payment_id) {
      openCase({
        connectionId,
        class: 'INTEGRITY',
        paymentId: existing.payment_id,
        references: { externalMessageId: obs.externalMessageId, priorHash: existing.fingerprint, newHash: fingerprint },
        sources: [transport.source],
      });
      db.prepare("UPDATE switch_payments SET resolution_status = 'REVIEW_REQUIRED', updated_at = ? WHERE id = ?").run(now(), existing.payment_id);
    }
    return { ack: false, duplicate: false, quarantined: true, outcome: 'integrity_incident', paymentId: existing.payment_id };
  }
  const payment = obs.stableMessageId
    ? (db.prepare('SELECT id FROM switch_payments WHERE external_message_id = ? OR id = ?').get(obs.stableMessageId, obs.stableMessageId.replace(/-\d+$/, '')) as any)
    : obs.externalReference
      ? (db.prepare('SELECT id FROM switch_payments WHERE external_reference = ?').get(obs.externalReference) as any)
      : null;
  const inboxId = `in_${shortCode(14).toLowerCase()}`;
  if (!obs.signatureValid || obs.kind === 'MALFORMED') {
    db.prepare(
      'INSERT INTO inbox_messages (id, connection_id, source, external_message_id, fingerprint, payment_id, verified, quarantine, reason, payload, proof_ref, occurred_at, received_at) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?)',
    ).run(
      inboxId,
      connectionId,
      transport.source,
      obs.externalMessageId,
      fingerprint,
      payment?.id ?? null,
      obs.signatureValid ? 'MALFORMED' : 'INVALID_SIGNATURE',
      JSON.stringify({ kind: obs.kind, code: obs.externalCode }),
      proofRef,
      obs.occurredAt,
      obs.receivedAt,
    );
    if (payment?.id)
      appendEvent(
        payment.id,
        'observation.quarantined',
        transport.source,
        null,
        null,
        getPaymentRow(payment.id).state_version,
        { externalMessageId: obs.externalMessageId, reason: obs.signatureValid ? 'MALFORMED' : 'INVALID_SIGNATURE' },
        proofRef,
        obs.occurredAt,
      );
    openIncident(
      'P2',
      `Inbound message ${obs.externalMessageId} quarantined (${obs.signatureValid ? 'malformed' : 'invalid signature'})`,
      'Security review; no status change was applied.',
      'inbox',
      inboxId,
    );
    return { ack: false, duplicate: false, quarantined: true, outcome: obs.signatureValid ? 'quarantined:malformed' : 'quarantined:invalid_signature', paymentId: payment?.id ?? null };
  }
  if (!payment) {
    db.prepare(
      'INSERT INTO inbox_messages (id, connection_id, source, external_message_id, fingerprint, payment_id, verified, quarantine, reason, payload, proof_ref, occurred_at, received_at) VALUES (?, ?, ?, ?, ?, NULL, 1, 1, ?, ?, ?, ?, ?)',
    ).run(
      inboxId,
      connectionId,
      transport.source,
      obs.externalMessageId,
      fingerprint,
      'NO_LOCAL_PAYMENT',
      JSON.stringify({ kind: obs.kind, code: obs.externalCode, externalReference: obs.externalReference }),
      proofRef,
      obs.occurredAt,
      obs.receivedAt,
    );
    openCase({
      connectionId,
      class: 'EXTERNAL_ONLY',
      references: { externalMessageId: obs.externalMessageId, externalReference: obs.externalReference, stableMessageId: obs.stableMessageId },
      sources: [transport.source],
      exposureMinor: Number(obs.amountMinor ?? 0),
      currency: obs.currency,
    });
    return { ack: true, duplicate: false, quarantined: true, outcome: 'external_only', paymentId: null };
  }
  const attempt = db.prepare('SELECT id FROM switch_attempts WHERE payment_id = ? AND stable_message_id = ?').get(payment.id, obs.stableMessageId ?? '') as any;
  db.prepare(
    'INSERT INTO inbox_messages (id, connection_id, source, external_message_id, fingerprint, payment_id, verified, quarantine, reason, payload, proof_ref, occurred_at, received_at, processed_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?, ?, ?, ?)',
  ).run(
    inboxId,
    connectionId,
    transport.source,
    obs.externalMessageId,
    fingerprint,
    payment.id,
    JSON.stringify({ kind: obs.kind, code: obs.externalCode, externalReference: obs.externalReference }),
    proofRef,
    obs.occurredAt,
    obs.receivedAt,
    now(),
  );
  const r = applyObservation(payment.id, obs, { source: `inbound:${transport.source}`, attemptId: attempt?.id ?? null, inboundId: inboxId });
  if (r.outcome.startsWith('quarantined')) db.prepare('UPDATE inbox_messages SET quarantine = 1, reason = ? WHERE id = ?').run(r.outcome, inboxId);
  return { ack: true, duplicate: false, quarantined: r.outcome.startsWith('quarantined'), outcome: r.outcome, paymentId: payment.id };
}

// ---------------------------------------------------------------------------------------------------------------------
// Linked operations: refunds and reversals (15)
// ---------------------------------------------------------------------------------------------------------------------
export interface LinkedOperationView {
  id: string;
  payment_id: string;
  kind: 'REFUND' | 'REVERSAL';
  amount: { currency: string; value_minor: string };
  status: 'RESERVED' | 'PENDING' | 'SUCCEEDED' | 'REJECTED' | 'UNKNOWN';
  reason: string | null;
  external_reference: string | null;
  requested_by: string | null;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
}
const toLinked = (r: any): LinkedOperationView => ({
  id: r.id,
  payment_id: r.payment_id,
  kind: r.kind,
  amount: { currency: r.currency, value_minor: String(r.amount_minor) },
  status: r.status,
  reason: r.reason,
  external_reference: r.external_reference,
  requested_by: r.requested_by,
  approved_by: r.approved_by,
  created_at: r.created_at,
  updated_at: r.updated_at,
});
const RESERVING = ['RESERVED', 'PENDING', 'SUCCEEDED', 'UNKNOWN'];

export function refundable(paymentId: string): { principal: number; reserved: number; refundable: number } {
  const p = getPaymentRow(paymentId);
  const reserved = (
    getDb()
      .prepare(`SELECT COALESCE(SUM(amount_minor), 0) s FROM linked_operations WHERE payment_id = ? AND kind = 'REFUND' AND status IN (${RESERVING.map(() => '?').join(',')})`)
      .get(paymentId, ...RESERVING) as any
  ).s as number;
  return { principal: p.amount_minor, reserved, refundable: Math.max(0, p.amount_minor - reserved) };
}

export function createLinkedRefund(merchant: UserRow | null, paymentId: string, input: { amountMinor?: number | null; reason: string; idemKey?: string | null }, actor: Actor): LinkedOperationView {
  const db = getDb();
  const p = getPaymentRow(paymentId);
  if (merchant && p.merchant_user_id !== merchant.id) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Payment not found');
  if (p.status !== 'COMPLETED') throw new AppError(409, 'INVALID_REQUEST', `Only COMPLETED payments can be refunded (payment is ${p.status})`);
  if (p.resolution_status === 'REVIEW_REQUIRED') throw new AppError(409, 'INVALID_REQUEST', 'This payment is under review; no compensating operation can start automatically');
  const conn = getConnection(p.connection_id!);
  const binding = db.prepare('SELECT * FROM beneficiary_bindings WHERE id = ?').get(p.beneficiary_binding_id) as any;
  const creditor = getParticipant(binding.participant_id);
  if (!creditor.services.includes('REFUND')) throw new CapabilityNotAvailable(`${creditor.id} does not support refunds; no emulation through two transfers`);
  const avail = serviceAvailability({
    connectionId: conn.id,
    connectionEnabled: conn.enabled,
    environmentCertified: conn.environment !== 'production' || conn.certification.status === 'CERTIFIED',
    country: conn.country,
    debtorId: creditor.id,
    creditorId: p.payer_participant_id,
    currency: p.currency,
    product: 'REFUND',
    channel: 'api',
  });
  if (!avail.available) throw new CapabilityNotAvailable(avail.reasons[0]);
  if (input.idemKey) {
    const existing = db.prepare('SELECT * FROM linked_operations WHERE payment_id = ? AND idem_key = ?').get(paymentId, input.idemKey) as any;
    if (existing) return toLinked(existing);
  }
  const id = `lo_${shortCode(14).toLowerCase()}`;
  db.transaction(() => {
    const { refundable: left } = refundable(paymentId);
    const amount = input.amountMinor ?? left;
    if (!Number.isInteger(amount) || amount <= 0) throw new AppError(400, 'INVALID_REQUEST', 'Refund amount must be a positive integer');
    if (amount > left) throw new AppError(409, 'REFUND_EXCEEDS_REFUNDABLE', `Only ${left} minor units of this payment can still be refunded (reservations included)`);
    db.prepare(
      'INSERT INTO linked_operations (id, payment_id, kind, amount_minor, currency, status, reason, idem_key, stable_message_id, requested_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, paymentId, 'REFUND', amount, p.currency, 'RESERVED', input.reason, input.idemKey ?? null, `${id}-1`, actor.id ?? null, now(), now());
    db.prepare('INSERT INTO outbox_messages (id, kind, payment_id, connection_id, payload, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      `ob_${shortCode(14).toLowerCase()}`,
      'switch.refund',
      paymentId,
      conn.id,
      JSON.stringify({ operationId: id }),
      now(),
      now(),
    );
    appendEvent(paymentId, 'refund.reserved', actor.type, null, null, p.state_version, { operationId: id, amount });
  })();
  emitEvent(
    p.merchant_user_id,
    'refund.updated',
    { refund: toLinked(db.prepare('SELECT * FROM linked_operations WHERE id = ?').get(id)), payment_id: paymentId },
    { resource: { type: 'payment', id: paymentId } },
  );
  return toLinked(db.prepare('SELECT * FROM linked_operations WHERE id = ?').get(id));
}

export function listLinkedOperations(paymentId: string): LinkedOperationView[] {
  return (getDb().prepare('SELECT * FROM linked_operations WHERE payment_id = ? ORDER BY created_at').all(paymentId) as any[]).map(toLinked);
}

async function emitLinkedOperation(operationId: string, ctx: { owner: string; fencingToken: number }): Promise<{ result: string }> {
  const db = getDb();
  const op = db.prepare('SELECT * FROM linked_operations WHERE id = ?').get(operationId) as any;
  if (!op || op.status !== 'RESERVED') return { result: `skipped:${op?.status ?? 'missing'}` };
  if (!holdsLease(ctx.owner, ctx.fencingToken)) return { result: 'fenced' };
  const p = getPaymentRow(op.payment_id);
  const conn = getConnection(p.connection_id!);
  const gate = emissionGate(conn);
  if (!gate.allowed) return { result: 'deferred' };
  const original = db.prepare('SELECT stable_message_id FROM switch_attempts WHERE payment_id = ? AND status = ? ORDER BY seq DESC LIMIT 1').get(p.id, 'COMPLETED') as any;
  db.prepare("UPDATE linked_operations SET status = 'PENDING', updated_at = ? WHERE id = ?").run(now(), op.id);
  let obs: ExternalObservation | null = null;
  try {
    const cmd = {
      paymentId: p.id,
      originalStableMessageId: original?.stable_message_id ?? p.external_message_id ?? '',
      originalExternalReference: p.external_reference,
      stableMessageId: op.stable_message_id,
      amountMinor: String(op.amount_minor),
      currency: op.currency,
      reason: op.reason ?? '',
      merchantId: p.merchant_user_id,
    };
    obs = op.kind === 'REFUND' ? await adapterFor(conn).requestRefund(cmd) : await adapterFor(conn).requestReversal(cmd);
  } catch (err) {
    // timeout: the reservation is kept until an authenticated resolution (never released by time)
    db.prepare("UPDATE linked_operations SET status = 'UNKNOWN', updated_at = ? WHERE id = ?").run(now(), op.id);
    appendEvent(p.id, `${op.kind.toLowerCase()}.unknown`, 'dispatcher', null, null, p.state_version, { operationId: op.id, error: (err as Error).message });
    openIncident('P2', `${op.kind} ${op.id} uncertain`, 'Resolve with the institution; the reservation stays until authenticated proof.', 'linked_operation', op.id);
    emitEvent(
      p.merchant_user_id,
      'refund.updated',
      { refund: toLinked(db.prepare('SELECT * FROM linked_operations WHERE id = ?').get(op.id)), payment_id: p.id },
      { resource: { type: 'payment', id: p.id } },
    );
    return { result: 'uncertain' };
  }
  const proofRef = storeEvidence('switch_observation', p.id, obs.raw, { kind: obs.kind, code: obs.externalCode, operationId: op.id });
  const entry = catalogueFor(op.kind, obs.externalCode);
  const outcome = entry?.transition === 'SUCCEEDED' && obs.signatureValid ? 'SUCCEEDED' : entry?.transition === 'REJECTED' ? 'REJECTED' : 'UNKNOWN';
  db.prepare('UPDATE linked_operations SET status = ?, external_reference = ?, observation = ?, updated_at = ? WHERE id = ?').run(
    outcome,
    obs.externalReference,
    JSON.stringify({ kind: obs.kind, code: obs.externalCode, externalMessageId: obs.externalMessageId }),
    now(),
    op.id,
  );
  appendEvent(
    p.id,
    `${op.kind.toLowerCase()}.${outcome.toLowerCase()}`,
    obs.authority,
    null,
    null,
    p.state_version,
    { operationId: op.id, code: obs.externalCode, externalReference: obs.externalReference },
    proofRef,
    obs.occurredAt,
  );
  if (outcome === 'SUCCEEDED') {
    journal(p.id, op.kind === 'REFUND' ? 'REFUND_CONFIRMED' : 'REVERSAL_CONFIRMED', -op.amount_minor, op.currency, obs.authority, obs.externalReference, proofRef, obs.occurredAt);
    // Instruction n°58 art. 23: a reversal returns principal and fees; the aggregation fee accrued on the reversed part is credited back to the merchant
    reverseAggregationFee(p.id, op.amount_minor, op.kind, obs.externalReference ?? op.id);
  }
  emitEvent(
    p.merchant_user_id,
    'refund.updated',
    { refund: toLinked(db.prepare('SELECT * FROM linked_operations WHERE id = ?').get(op.id)), payment_id: p.id },
    { resource: { type: 'payment', id: p.id } },
  );
  return { result: `observed:${outcome}` };
}

/** Operations resolve an UNKNOWN linked operation with authenticated proof; the approver must differ from the requester. */
export function resolveLinkedOperation(id: string, outcome: 'SUCCEEDED' | 'REJECTED', evidenceRef: string, approverId: string): LinkedOperationView {
  const db = getDb();
  const op = db.prepare('SELECT * FROM linked_operations WHERE id = ?').get(id) as any;
  if (!op) throw notFound('Operation not found', 'operation_not_found');
  if (op.status !== 'UNKNOWN') throw conflict(`Operation is ${op.status}`, 'operation_closed');
  if (op.requested_by === approverId) throw badRequest('The approver must differ from the requester', 'approver_required');
  if (!evidenceRef.trim()) throw badRequest('Official evidence reference required', 'evidence_required');
  db.prepare('UPDATE linked_operations SET status = ?, approved_by = ?, observation = ?, updated_at = ? WHERE id = ?').run(
    outcome,
    approverId,
    JSON.stringify({ resolvedWith: evidenceRef }),
    now(),
    id,
  );
  const p = getPaymentRow(op.payment_id);
  appendEvent(p.id, `${op.kind.toLowerCase()}.resolved`, 'operations', null, null, p.state_version, { operationId: id, outcome, evidenceRef, approverId });
  if (outcome === 'SUCCEEDED') journal(p.id, 'REFUND_CONFIRMED', -op.amount_minor, op.currency, 'operations', evidenceRef);
  return toLinked(db.prepare('SELECT * FROM linked_operations WHERE id = ?').get(id));
}

// ---------------------------------------------------------------------------------------------------------------------
// Console views
// ---------------------------------------------------------------------------------------------------------------------
export function paymentTimeline(id: string) {
  const db = getDb();
  const p = getPaymentRow(id);
  return {
    payment: paymentView(p),
    route: parseJson(p.route, {}),
    events: (db.prepare('SELECT * FROM switch_events WHERE payment_id = ? ORDER BY seq').all(id) as any[]).map((e) => ({
      seq: e.seq,
      type: e.type,
      source: e.source,
      from: e.from_status,
      to: e.to_status,
      stateVersion: e.state_version,
      occurredAt: e.occurred_at,
      receivedAt: e.received_at,
      proofRef: e.proof_ref,
      payload: parseJson(e.payload, {}),
    })),
    attempts: (db.prepare('SELECT * FROM switch_attempts WHERE payment_id = ? ORDER BY seq').all(id) as any[]).map((a) => ({
      id: a.id,
      seq: a.seq,
      kind: a.kind,
      stableMessageId: a.stable_message_id,
      accessMode: a.access_mode,
      participantId: a.participant_id,
      sponsorId: a.sponsor_id,
      fencingToken: a.fencing_token,
      emissionPossible: !!a.emission_possible,
      sentAt: a.sent_at,
      respondedAt: a.responded_at,
      status: a.status,
      codecVersion: a.codec_version,
      observation: parseJson(a.observation, null),
    })),
    journal: (db.prepare('SELECT * FROM switch_journal WHERE payment_id = ? ORDER BY occurred_at').all(id) as any[]).map((j) => ({
      fact: j.fact,
      amountMinor: j.amount_minor,
      currency: j.currency,
      source: j.source,
      reference: j.reference,
      proofRef: j.proof_ref,
      occurredAt: j.occurred_at,
    })),
    inbox: (db.prepare('SELECT * FROM inbox_messages WHERE payment_id = ? ORDER BY received_at').all(id) as any[]).map((m) => ({
      id: m.id,
      source: m.source,
      externalMessageId: m.external_message_id,
      verified: !!m.verified,
      quarantine: !!m.quarantine,
      reason: m.reason,
      receivedAt: m.received_at,
      occurredAt: m.occurred_at,
      processedAt: m.processed_at,
    })),
    linkedOperations: listLinkedOperations(id),
    cases: (
      db.prepare('SELECT id, class, status, priority, exposure_minor, currency, owner_id, due_at, created_at FROM reconciliation_cases WHERE payment_id = ? ORDER BY created_at').all(id) as any[]
    ).map((c) => ({
      id: c.id,
      class: c.class,
      status: c.status,
      priority: c.priority,
      exposureMinor: c.exposure_minor,
      currency: c.currency,
      ownerId: c.owner_id,
      dueAt: c.due_at,
      createdAt: c.created_at,
    })),
    webhooks: (db.prepare("SELECT id, type, created_at FROM webhook_events WHERE resource_type = 'payment' AND resource_id = ? ORDER BY created_at").all(id) as any[]).map((w) => ({
      id: w.id,
      type: w.type,
      createdAt: w.created_at,
    })),
    intent: p.intent_id ? intentView(getIntentRow(p.intent_id)) : null,
    consent: p.consent_reference
      ? (db.prepare('SELECT reference, participant_id, audience, amount_minor, currency, expires_at, used_at FROM consent_evidence WHERE reference = ?').get(p.consent_reference) as any)
      : null,
  };
}

/** 20.1 national view: availability per participant/service/currency, latency, volumes, uncertain statuses, coverage. */
export function nationalView(connectionId: string) {
  const db = getDb();
  const conn = getConnection(connectionId);
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const byStatus = db
    .prepare('SELECT status, currency, COUNT(*) n, COALESCE(SUM(amount_minor), 0) s FROM switch_payments WHERE connection_id = ? AND created_at >= ? GROUP BY status, currency')
    .all(connectionId, since) as any[];
  const uncertain = (db.prepare("SELECT COUNT(*) c FROM switch_payments WHERE connection_id = ? AND (status = 'UNKNOWN' OR resolution_status = 'REVIEW_REQUIRED')").get(connectionId) as any)
    .c as number;
  const latency = db
    .prepare(
      'SELECT AVG((julianday(responded_at) - julianday(sent_at)) * 86400000) avg, MAX((julianday(responded_at) - julianday(sent_at)) * 86400000) max, COUNT(*) n FROM switch_attempts sa JOIN switch_payments p ON p.id = sa.payment_id WHERE p.connection_id = ? AND sa.responded_at IS NOT NULL AND sa.sent_at >= ?',
    )
    .get(connectionId, since) as any;
  const participants = (db.prepare('SELECT * FROM participants WHERE country = ? ORDER BY name').all(conn.country) as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    status: r.status,
    currencies: parseJson(r.currencies, []),
    services: parseJson(r.services, []),
    volume24h: (db.prepare('SELECT COUNT(*) c FROM switch_payments WHERE connection_id = ? AND payer_participant_id = ? AND created_at >= ?').get(connectionId, r.id, since) as any).c,
    pairsOpen: (db.prepare("SELECT COUNT(*) c FROM participant_pairs WHERE connection_id = ? AND (debtor_id = ? OR creditor_id = ?) AND status = 'OPEN'").get(connectionId, r.id, r.id) as any).c,
  }));
  const openCases = db.prepare("SELECT class, COUNT(*) n FROM reconciliation_cases WHERE connection_id = ? AND status != 'CLOSED' GROUP BY class").all(connectionId) as any[];
  const lastRun = db.prepare('SELECT * FROM reconciliation_runs WHERE connection_id = ? ORDER BY created_at DESC LIMIT 1').get(connectionId) as any;
  const outbox = db.prepare('SELECT kind, COUNT(*) n FROM outbox_messages WHERE connection_id = ? AND delivered_at IS NULL AND dead = 0 GROUP BY kind').all(connectionId) as any[];
  return {
    connection: conn,
    simulation: conn.simulation,
    gate: emissionGate(conn),
    lease: currentLease(),
    volumes24h: byStatus.map((r) => ({ status: r.status, currency: r.currency, count: r.n, sumMinor: r.s })),
    uncertain,
    latencyMs: { avg: latency?.avg ? Math.round(latency.avg) : null, max: latency?.max ? Math.round(latency.max) : null, samples: latency?.n ?? 0 },
    participants,
    openCases: openCases.map((c) => ({ class: c.class, count: c.n })),
    coverage: lastRun ? parseJson(lastRun.coverage, null) : null,
    outboxBacklog: outbox.map((o) => ({ kind: o.kind, count: o.n })),
    quarantined: (db.prepare('SELECT COUNT(*) c FROM inbox_messages WHERE connection_id = ? AND quarantine = 1 AND processed_at IS NULL').get(connectionId) as any).c,
  };
}

export function listInbox(filter: { connectionId?: string | null; quarantine?: boolean | null; limit?: number } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.connectionId) {
    where.push('connection_id = ?');
    params.push(filter.connectionId);
  }
  if (filter.quarantine != null) where.push(`quarantine = ${filter.quarantine ? 1 : 0}`);
  return (
    getDb()
      .prepare(`SELECT * FROM inbox_messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY received_at DESC LIMIT ?`)
      .all(...params, Math.min(200, filter.limit ?? 50)) as any[]
  ).map((m) => ({
    id: m.id,
    connectionId: m.connection_id,
    source: m.source,
    externalMessageId: m.external_message_id,
    paymentId: m.payment_id,
    verified: !!m.verified,
    quarantine: !!m.quarantine,
    reason: m.reason,
    payload: parseJson(m.payload, {}),
    proofRef: m.proof_ref,
    occurredAt: m.occurred_at,
    receivedAt: m.received_at,
    processedAt: m.processed_at,
  }));
}
export function listOutbox(filter: { dead?: boolean | null; pending?: boolean | null; limit?: number } = {}) {
  const where: string[] = [];
  if (filter.dead) where.push('dead = 1');
  if (filter.pending) where.push('delivered_at IS NULL AND dead = 0');
  return (
    getDb()
      .prepare(`SELECT * FROM outbox_messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(Math.min(200, filter.limit ?? 50)) as any[]
  ).map((m) => ({
    id: m.id,
    kind: m.kind,
    paymentId: m.payment_id,
    connectionId: m.connection_id,
    payload: parseJson(m.payload, {}),
    availableAt: m.available_at,
    leaseUntil: m.lease_until,
    leaseOwner: m.lease_owner,
    attempts: m.attempts,
    maxAttempts: m.max_attempts,
    lastError: m.last_error,
    deliveredAt: m.delivered_at,
    dead: !!m.dead,
    createdAt: m.created_at,
  }));
}
export function retryOutbox(id: string, adminId: string) {
  const r = getDb().prepare('UPDATE outbox_messages SET dead = 0, attempts = 0, available_at = ?, lease_until = NULL WHERE id = ?').run(now(), id);
  if (!r.changes) throw notFound('Outbox message not found', 'outbox_not_found');
  recordEvent('switch', id, 'outbox.retried', { type: 'admin', id: adminId }, {});
  return listOutbox({ limit: 200 }).find((m) => m.id === id);
}
export function discardInbox(id: string, adminId: string, reason: string) {
  const r = getDb().prepare('UPDATE inbox_messages SET processed_at = ?, reason = ? WHERE id = ? AND quarantine = 1').run(now(), `discarded: ${reason}`, id);
  if (!r.changes) throw notFound('Quarantined message not found', 'inbox_not_found');
  recordEvent('switch', id, 'inbox.discarded', { type: 'admin', id: adminId }, { reason });
}
