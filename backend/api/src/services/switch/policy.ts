/**
 * CMP-05 Route Policy Engine. Classifies a payment from the institutions and the product (never from a caller-supplied
 * rail), applies the invariants RTE-001…RTE-006 and returns an explainable, deterministic decision: the rule applied,
 * the certified profile, the institutions, the currency, the rejection reason and the configuration version. No LLM
 * is involved. Regulatory exceptions are signed objects backed by an official document with two approvals; none
 * exist in the first version and an expired one is inapplicable.
 */
import { getDb } from '../../db';
import { now, shortCode } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { sha256 } from '../../lib/crypto';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { recordEvent } from '../events';
import { countryCapabilities } from '../capabilities';
import { getParticipant, serviceAvailability, type Participant } from './participants';
import { connectionForCountry, emissionGate } from './connections';
import { getSwitchSettings } from './settings';

export type RouteClass = 'DOMESTIC_INTEROPERABLE' | 'ON_US_REVIEW_REQUIRED' | 'CLOSED_LOOP' | 'CROSS_BORDER' | 'UNSUPPORTED';

export interface PolicyRules {
  /** What to do with same-institution payments until a documented rule exists. */
  onUs: 'REVIEW_REQUIRED' | 'SWITCH' | 'DENY';
  products: Record<string, { enabled: boolean; channels: string[] }>;
  currencies: string[];
  /** Technical failover: a second link to the same certified system only. */
  failover: 'SAME_SYSTEM_ONLY';
  bilateralFallback: false;
}
export interface RoutePolicy {
  version: number;
  country: string;
  rules: PolicyRules;
  status: 'DRAFT' | 'APPROVED' | 'ACTIVE' | 'RETIRED';
  authorId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  activatedAt: string | null;
  retiredAt: string | null;
  notes: string | null;
  createdAt: string;
}
const toPolicy = (r: any): RoutePolicy => ({
  version: r.version,
  country: r.country,
  rules: parseJson(r.rules, DEFAULT_RULES),
  status: r.status,
  authorId: r.author_id,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at,
  activatedAt: r.activated_at,
  retiredAt: r.retired_at,
  notes: r.notes,
  createdAt: r.created_at,
});

const DEFAULT_RULES: PolicyRules = {
  onUs: 'REVIEW_REQUIRED',
  products: {
    MERCHANT_PAYMENT: { enabled: true, channels: ['api', 'qr', 'ussd'] },
    REFUND: { enabled: true, channels: ['api'] },
    REVERSAL: { enabled: true, channels: ['ops'] },
    INQUIRY: { enabled: true, channels: ['api', 'ops'] },
    P2P: { enabled: false, channels: [] },
  },
  currencies: ['CDF', 'USD'],
  failover: 'SAME_SYSTEM_ONLY',
  bilateralFallback: false,
};

export function activePolicy(country: string): RoutePolicy {
  const r = getDb().prepare("SELECT * FROM route_policies WHERE country = ? AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1").get(country.toUpperCase());
  if (r) return toPolicy(r);
  return {
    version: 0,
    country: country.toUpperCase(),
    rules: DEFAULT_RULES,
    status: 'ACTIVE',
    authorId: null,
    approvedBy: null,
    approvedAt: null,
    activatedAt: null,
    retiredAt: null,
    notes: 'built-in default policy (version 0)',
    createdAt: now(),
  };
}
export function listPolicies(country?: string | null): RoutePolicy[] {
  return (
    getDb()
      .prepare(`SELECT * FROM route_policies ${country ? 'WHERE country = ?' : ''} ORDER BY version DESC`)
      .all(...(country ? [country.toUpperCase()] : [])) as any[]
  ).map(toPolicy);
}
export function createPolicyDraft(country: string, rules: Partial<PolicyRules>, authorId: string, notes?: string | null): RoutePolicy {
  const merged: PolicyRules = { ...DEFAULT_RULES, ...rules, failover: 'SAME_SYSTEM_ONLY', bilateralFallback: false };
  const r = getDb()
    .prepare('INSERT INTO route_policies (country, rules, status, author_id, notes, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
    .get(country.toUpperCase(), JSON.stringify(merged), 'DRAFT', authorId, notes ?? null, now());
  return toPolicy(r);
}
export function approvePolicy(version: number, approverId: string): RoutePolicy {
  const r = getDb().prepare('SELECT * FROM route_policies WHERE version = ?').get(version) as any;
  if (!r) throw notFound('Policy not found', 'policy_not_found');
  if (r.status !== 'DRAFT') throw conflict(`Policy is ${r.status}`, 'policy_not_draft');
  if (r.author_id === approverId) throw badRequest('The approver must differ from the author', 'approver_required');
  getDb().prepare("UPDATE route_policies SET status = 'APPROVED', approved_by = ?, approved_at = ? WHERE version = ?").run(approverId, now(), version);
  recordEvent('corridor', String(version), 'route_policy.approved', { type: 'admin', id: approverId }, {});
  return toPolicy(getDb().prepare('SELECT * FROM route_policies WHERE version = ?').get(version));
}
export function activatePolicy(version: number, adminId: string): RoutePolicy {
  const db = getDb();
  const r = db.prepare('SELECT * FROM route_policies WHERE version = ?').get(version) as any;
  if (!r) throw notFound('Policy not found', 'policy_not_found');
  if (r.status !== 'APPROVED') throw conflict('Only approved policies can be activated', 'policy_not_approved');
  db.transaction(() => {
    db.prepare("UPDATE route_policies SET status = 'RETIRED', retired_at = ? WHERE country = ? AND status = 'ACTIVE'").run(now(), r.country);
    db.prepare("UPDATE route_policies SET status = 'ACTIVE', activated_at = ? WHERE version = ?").run(now(), version);
  })();
  recordEvent('corridor', String(version), 'route_policy.activated', { type: 'admin', id: adminId }, { country: r.country });
  return toPolicy(db.prepare('SELECT * FROM route_policies WHERE version = ?').get(version));
}

// ---------------------------------------------------------------------------------------------------------------------
// Exceptions (RTE-004)
// ---------------------------------------------------------------------------------------------------------------------
export interface RoutingException {
  id: string;
  country: string;
  scope: string;
  products: string[];
  participants: string[];
  currency: string | null;
  documentRef: string;
  documentSha256: string | null;
  validFrom: string;
  validTo: string;
  status: 'DRAFT' | 'FIRST_APPROVAL' | 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  authorId: string;
  firstApproverId: string | null;
  secondApproverId: string | null;
  signature: string | null;
}
const toException = (r: any): RoutingException => ({
  id: r.id,
  country: r.country,
  scope: r.scope,
  products: parseJson(r.products, []),
  participants: parseJson(r.participants, []),
  currency: r.currency,
  documentRef: r.document_ref,
  documentSha256: r.document_sha256,
  validFrom: r.valid_from,
  validTo: r.valid_to,
  status: r.status,
  authorId: r.author_id,
  firstApproverId: r.first_approver_id,
  secondApproverId: r.second_approver_id,
  signature: r.signature,
});

export function createException(
  input: {
    country: string;
    scope: string;
    products: string[];
    participants: string[];
    currency?: string | null;
    documentRef: string;
    documentSha256?: string | null;
    validFrom: string;
    validTo: string;
  },
  authorId: string,
): RoutingException {
  if (!input.documentRef.trim()) throw badRequest('An exception must reference the official document that grants it', 'document_required');
  if (input.validTo <= input.validFrom) throw badRequest('validTo must be after validFrom', 'invalid_validity');
  const id = `rex_${shortCode(12).toLowerCase()}`;
  getDb()
    .prepare(
      'INSERT INTO routing_exceptions (id, country, scope, products, participants, currency, document_ref, document_sha256, valid_from, valid_to, status, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      input.country.toUpperCase(),
      input.scope,
      JSON.stringify(input.products),
      JSON.stringify(input.participants),
      input.currency?.toUpperCase() ?? null,
      input.documentRef,
      input.documentSha256 ?? null,
      input.validFrom,
      input.validTo,
      'DRAFT',
      authorId,
      now(),
      now(),
    );
  recordEvent('corridor', id, 'routing_exception.drafted', { type: 'admin', id: authorId }, { scope: input.scope, documentRef: input.documentRef });
  return toException(getDb().prepare('SELECT * FROM routing_exceptions WHERE id = ?').get(id));
}
/** Two approvals from two different people, neither the author; the signature binds the approved content. */
export function approveException(id: string, approverId: string): RoutingException {
  const r = getDb().prepare('SELECT * FROM routing_exceptions WHERE id = ?').get(id) as any;
  if (!r) throw notFound('Exception not found', 'exception_not_found');
  if (r.author_id === approverId || r.first_approver_id === approverId) throw badRequest('Approvers must be two different people, neither the author', 'approver_required');
  if (r.status === 'DRAFT') getDb().prepare("UPDATE routing_exceptions SET status = 'FIRST_APPROVAL', first_approver_id = ?, updated_at = ? WHERE id = ?").run(approverId, now(), id);
  else if (r.status === 'FIRST_APPROVAL') {
    const signature = sha256(
      `${r.id}|${r.country}|${r.scope}|${r.products}|${r.participants}|${r.currency ?? ''}|${r.document_ref}|${r.valid_from}|${r.valid_to}|${r.first_approver_id}|${approverId}`,
    );
    getDb().prepare("UPDATE routing_exceptions SET status = 'ACTIVE', second_approver_id = ?, signature = ?, updated_at = ? WHERE id = ?").run(approverId, signature, now(), id);
  } else throw conflict(`Exception is ${r.status}`, 'exception_closed');
  recordEvent('corridor', id, 'routing_exception.approved', { type: 'admin', id: approverId }, { step: r.status === 'DRAFT' ? 1 : 2 });
  return toException(getDb().prepare('SELECT * FROM routing_exceptions WHERE id = ?').get(id));
}
export function listExceptions(country?: string | null): RoutingException[] {
  return (
    getDb()
      .prepare(`SELECT * FROM routing_exceptions ${country ? 'WHERE country = ?' : ''} ORDER BY created_at DESC`)
      .all(...(country ? [country.toUpperCase()] : [])) as any[]
  ).map(toException);
}
function applicableException(country: string, product: string, participants: string[], currency: string): RoutingException | null {
  const t = now();
  for (const e of listExceptions(country)) {
    if (e.status !== 'ACTIVE' || !e.signature || e.validFrom > t || e.validTo < t) continue;
    if (e.products.length && !e.products.includes(product)) continue;
    if (e.participants.length && !participants.every((p) => e.participants.includes(p))) continue;
    if (e.currency && e.currency !== currency.toUpperCase()) continue;
    const expected = sha256(
      `${e.id}|${e.country}|${e.scope}|${JSON.stringify(e.products)}|${JSON.stringify(e.participants)}|${e.currency ?? ''}|${e.documentRef}|${e.validFrom}|${e.validTo}|${e.firstApproverId}|${e.secondApproverId}`,
    );
    if (expected !== e.signature) continue; // tampered after approval: inapplicable
    return e;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Classification and decision
// ---------------------------------------------------------------------------------------------------------------------
export interface RouteDecision {
  allowed: boolean;
  class: RouteClass;
  rail: 'NATIONAL_SWITCH' | 'INTERNAL' | 'NONE';
  accessMode: 'DIRECT' | 'SPONSORED' | null;
  connectionId: string | null;
  schemeId: string | null;
  participantId: string | null;
  sponsorId: string | null;
  profileVersion: string | null;
  policyVersion: number;
  configVersion: string;
  rule: string;
  institutions: { debtor: string; creditor: string };
  currency: string;
  product: string;
  channel: string;
  reasons: string[];
  rejection: { code: string; message: string } | null;
  exceptionId: string | null;
  decidedAt: string;
}

export function classify(debtor: Participant | null, creditor: Participant | null, product: string, country: string): RouteClass {
  if (!debtor || !creditor) return 'UNSUPPORTED';
  if (debtor.country !== country.toUpperCase() || creditor.country !== country.toUpperCase()) return 'CROSS_BORDER';
  if (debtor.id === creditor.id) return 'ON_US_REVIEW_REQUIRED';
  if (debtor.kind === 'AGGREGATOR' && creditor.kind === 'AGGREGATOR') return 'CLOSED_LOOP';
  if (!['BANK', 'MMO', 'PSP'].includes(debtor.kind) || !['BANK', 'MMO', 'PSP', 'AGGREGATOR'].includes(creditor.kind)) return 'UNSUPPORTED';
  return 'DOMESTIC_INTEROPERABLE';
}

export interface DecideInput {
  country: string;
  debtorId: string;
  creditorId: string;
  product: string;
  channel: string;
  currency: string;
  amountMinor: number;
  /** Caller-supplied routing fields are rejected outright (RTE-002). */
  forbiddenFields?: string[];
}

export function decideRoute(input: DecideInput): RouteDecision {
  const country = input.country.toUpperCase();
  const policy = activePolicy(country);
  const conn = connectionForCountry(country);
  const caps = countryCapabilities(country);
  const configVersion = sha256(`${policy.version}|${conn?.id ?? ''}|${conn?.profileVersion ?? ''}|${conn?.certification.status ?? ''}|${JSON.stringify(policy.rules)}`).slice(0, 12);
  const base = {
    accessMode: conn?.accessMode ?? null,
    connectionId: conn?.id ?? null,
    schemeId: conn?.schemeId ?? null,
    participantId: conn?.participantId ?? null,
    sponsorId: conn?.sponsorId ?? null,
    profileVersion: conn?.profileVersion ?? null,
    policyVersion: policy.version,
    configVersion,
    institutions: { debtor: input.debtorId, creditor: input.creditorId },
    currency: input.currency.toUpperCase(),
    product: input.product,
    channel: input.channel,
    exceptionId: null as string | null,
    decidedAt: now(),
  };
  const deny = (cls: RouteClass, rule: string, code: string, message: string, reasons: string[] = []): RouteDecision => ({
    ...base,
    allowed: false,
    class: cls,
    rail: 'NONE',
    rule,
    reasons: [message, ...reasons],
    rejection: { code, message },
  });

  if (input.forbiddenFields?.length) return deny('UNSUPPORTED', 'RTE-002', 'INVALID_REQUEST', `Routing is computed by the server; remove ${input.forbiddenFields.join(', ')} from the request`);
  let debtor: Participant | null = null;
  let creditor: Participant | null = null;
  try {
    debtor = getParticipant(input.debtorId);
  } catch {
    /* unknown */
  }
  try {
    creditor = getParticipant(input.creditorId);
  } catch {
    /* unknown */
  }
  const cls = classify(debtor, creditor, input.product, country);
  if (cls === 'UNSUPPORTED')
    return deny(cls, 'RTE-005', 'UNSUPPORTED_PARTICIPANT_PAIR', !debtor || !creditor ? 'A participant is not in the trusted registry' : 'Unsupported participant kinds for this product');
  if (cls === 'CROSS_BORDER') return deny(cls, 'PERIMETER', 'UNSUPPORTED_PARTICIPANT_PAIR', 'Cross-border legs are a later lot; the national leg is classified separately');
  if (cls === 'CLOSED_LOOP')
    return { ...base, allowed: true, class: cls, rail: 'INTERNAL', rule: 'CLOSED_LOOP', reasons: ['both parties on the aggregator: internal ledger, no interbank movement'], rejection: null };
  const productRule = policy.rules.products[input.product];
  if (!productRule?.enabled) return deny(cls, `POLICY-${policy.version}`, 'UNSUPPORTED_PRODUCT', `${input.product} is not enabled by route policy v${policy.version}`);
  if (!productRule.channels.includes(input.channel)) return deny(cls, `POLICY-${policy.version}`, 'UNSUPPORTED_CHANNEL', `${input.product} is not admitted on channel ${input.channel}`);
  if (!policy.rules.currencies.includes(input.currency.toUpperCase()))
    return deny(cls, `POLICY-${policy.version}`, 'CURRENCY_NOT_ENABLED', `${input.currency.toUpperCase()} is not enabled by route policy v${policy.version}`);
  const ceiling = getSwitchSettings().productCeilings[input.product]?.[input.currency.toUpperCase()] ?? caps.maxPerTransaction;
  if (ceiling && input.amountMinor > ceiling) return deny(cls, 'CEILING', 'INVALID_REQUEST', `Amount exceeds the ${input.product} ceiling of ${ceiling} minor units`);
  if (cls === 'ON_US_REVIEW_REQUIRED') {
    if (policy.rules.onUs === 'DENY') return deny(cls, `POLICY-${policy.version}/ON_US`, 'UNSUPPORTED_PARTICIPANT_PAIR', 'Same-institution payments are not admitted');
    if (policy.rules.onUs === 'REVIEW_REQUIRED')
      return deny(
        cls,
        `POLICY-${policy.version}/ON_US`,
        'ON_US_REVIEW_REQUIRED',
        'Same-institution payments are classified ON_US_REVIEW_REQUIRED until a documented rule exists (no automatic exemption)',
      );
  }
  // RTE-001: domestic interoperable movements must use a route containing the national switch
  if (!caps.nationalSwitch.required)
    return { ...base, allowed: true, class: cls, rail: 'NATIONAL_SWITCH', rule: 'RTE-001/optional', reasons: ['national switch not mandatory in this country'], rejection: null };
  if (!conn) return deny(cls, 'RTE-001', 'SERVICE_UNAVAILABLE', 'No switch connection is configured for this country; a bilateral route is never used');
  const exception = applicableException(country, input.product, [input.debtorId, input.creditorId], input.currency);
  const envCertified = conn.environment !== 'production' || conn.certification.status === 'CERTIFIED';
  const availability = serviceAvailability({
    connectionId: conn.id,
    connectionEnabled: conn.enabled,
    environmentCertified: envCertified,
    country,
    debtorId: input.debtorId,
    creditorId: input.creditorId,
    currency: input.currency,
    product: input.product,
    channel: input.channel,
  });
  if (!availability.available && !exception) {
    const code = !availability.factors.switchAdmission ? 'SERVICE_UNAVAILABLE' : !availability.factors.currency ? 'CURRENCY_NOT_ENABLED' : 'UNSUPPORTED_PARTICIPANT_PAIR';
    return deny(cls, 'RTE-005/§5', code, availability.reasons[0] ?? 'service not available for this pair', availability.reasons.slice(1));
  }
  const gate = emissionGate(conn);
  if (!gate.allowed && !gate.inquiryOnly) return deny(cls, 'RTE-003/RTE-005', 'SERVICE_UNAVAILABLE', `Switch route unavailable: ${gate.reasons[0]}`, gate.reasons.slice(1));
  return {
    ...base,
    allowed: true,
    class: cls,
    rail: 'NATIONAL_SWITCH',
    rule: exception ? `RTE-004 exception ${exception.id}` : 'RTE-001',
    reasons: [
      `${conn.accessMode === 'SPONSORED' ? 'sponsored' : 'direct'} participation via ${conn.schemeId}${conn.simulation ? ' (SIMULATION)' : ''}`,
      ...(gate.inquiryOnly ? ['link in inquiry-only mode: emission will wait'] : []),
    ],
    rejection: null,
    exceptionId: exception?.id ?? null,
  };
}

/** RTE-006: revalidate every revocable control immediately before emission. */
export function revalidateBeforeEmission(input: DecideInput & { policyVersion: number; connectionId: string | null }): { ok: boolean; reasons: string[]; decision: RouteDecision } {
  const decision = decideRoute(input);
  const reasons: string[] = [];
  if (!decision.allowed) reasons.push(decision.rejection?.message ?? 'route no longer allowed');
  if (decision.policyVersion !== input.policyVersion) reasons.push(`route policy changed (v${input.policyVersion} → v${decision.policyVersion}); the payment needs a new decision`);
  if (input.connectionId && decision.connectionId !== input.connectionId) reasons.push('switch connection changed since the decision');
  return { ok: reasons.length === 0, reasons, decision };
}
