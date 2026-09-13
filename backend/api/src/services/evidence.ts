/**
 * No-API verification engine. Operators and banks are not integrated; instead the receipt SMS that
 * lands on the platform's collection phone is forwarded by a registered device that signs each
 * message with its own key. The engine parses the message with operator-specific templates, matches
 * it to a payment intent (reference, amount, currency, sender, recipient, time window), rejects
 * replays and duplicates, and settles automatically only when confidence is high and the device is
 * trusted. Everything else goes to manual review. Raw evidence, parsed values, verifier identity and
 * outcome are preserved forever (append-only event log + payment_evidence).
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors';
import { parseJson } from '../lib/json';
import { sha256 } from '../lib/crypto';
import { toMinor } from '@bitripay/shared';
import { getOperator, type MomoOperator } from './momo';
import { getCurrency } from './currencies';
import { getGatewayControls } from './settings';
import { recordEvent, type Actor } from './events';
import { OPEN_STAGES, TERMINAL_STAGES, transitionStage, type PaymentStage } from './lifecycle';
import { confirmAndSettle, findPaymentByReference, getPayment } from './payments';
import type { GatewayPaymentRow } from '../payments/types';
import { normalizePhoneDigits } from './risk';
import type { UserRow } from './users';

// ---------------------------------------------------------------- devices

export interface EvidenceDevice {
  id: string;
  ownerUserId: string;
  name: string;
  publicKey: string;
  algorithm: string;
  operatorIds: string[];
  /** collection: forwards receipts for money in; payout: an approved Android payout device with a merchant SIM. */
  kind: 'collection' | 'payout';
  simMsisdn: string | null;
  simIccid: string | null;
  agentUserId: string | null;
  payoutAccountId: string | null;
  status: 'active' | 'revoked';
  riskScore: number;
  registeredBy: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

function toDevice(r: any): EvidenceDevice {
  return {
    id: r.id,
    ownerUserId: r.owner_user_id,
    name: r.name,
    publicKey: r.public_key,
    algorithm: r.algorithm,
    operatorIds: parseJson(r.operator_ids, []),
    kind: r.kind ?? 'collection',
    simMsisdn: r.sim_msisdn ?? null,
    simIccid: r.sim_iccid ?? null,
    agentUserId: r.agent_user_id ?? null,
    payoutAccountId: r.payout_account_id ?? null,
    status: r.status,
    riskScore: r.risk_score,
    registeredBy: r.registered_by,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    revokedAt: r.revoked_at,
    revokedReason: r.revoked_reason,
  };
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Accepts a PEM SPKI key or the raw 32-byte Ed25519 public key in base64/base64url. */
export function parsePublicKey(input: string): KeyObject {
  const trimmed = input.trim();
  if (trimmed.startsWith('-----')) return createPublicKey(trimmed);
  const raw = Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (raw.length === 32) return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  return createPublicKey({ key: raw, format: 'der', type: 'spki' });
}

export function registerDevice(
  owner: UserRow,
  input: {
    name: string;
    publicKey: string;
    operatorIds?: string[] | null;
    kind?: 'collection' | 'payout' | null;
    simMsisdn?: string | null;
    simIccid?: string | null;
    agentUserId?: string | null;
    payoutAccountId?: string | null;
  },
  registeredBy?: string | null,
): EvidenceDevice {
  try {
    const key = parsePublicKey(input.publicKey);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Only Ed25519 keys are supported');
  } catch (err) {
    throw badRequest(`Invalid device public key: ${(err as Error).message}`, 'invalid_public_key');
  }
  for (const op of input.operatorIds ?? []) getOperator(op);
  const kind = input.kind ?? 'collection';
  if (kind === 'payout' && !input.simMsisdn && !input.simIccid) throw badRequest('A payout device must register its SIM identity (MSISDN and/or ICCID)', 'sim_identity_required');
  const id = uuid();
  getDb()
    .prepare(
      'INSERT INTO evidence_devices (id, owner_user_id, name, public_key, algorithm, operator_ids, status, risk_score, registered_by, created_at, kind, sim_msisdn, sim_iccid, agent_user_id, payout_account_id) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      owner.id,
      input.name,
      input.publicKey.trim(),
      'ed25519',
      JSON.stringify(input.operatorIds ?? []),
      'active',
      registeredBy ?? owner.id,
      now(),
      kind,
      input.simMsisdn ?? null,
      input.simIccid ?? null,
      input.agentUserId ?? null,
      input.payoutAccountId ?? null,
    );
  if (input.payoutAccountId) getDb().prepare('UPDATE payout_accounts SET device_id = ? WHERE id = ?').run(id, input.payoutAccountId);
  recordEvent(
    'evidence',
    id,
    'device.registered',
    { type: owner.role === 'admin' ? 'admin' : 'agent', id: registeredBy ?? owner.id },
    { name: input.name, kind, operatorIds: input.operatorIds ?? [], sim: input.simMsisdn ? `…${input.simMsisdn.slice(-4)}` : null },
  );
  return getDevice(id);
}

export function getDevice(id: string): EvidenceDevice {
  const row = getDb().prepare('SELECT * FROM evidence_devices WHERE id = ?').get(id);
  if (!row) throw notFound('Device not found', 'device_not_found');
  return toDevice(row);
}

export function listDevices(ownerUserId?: string | null): EvidenceDevice[] {
  const rows = ownerUserId
    ? getDb().prepare('SELECT * FROM evidence_devices WHERE owner_user_id = ? ORDER BY created_at DESC').all(ownerUserId)
    : getDb().prepare('SELECT * FROM evidence_devices ORDER BY created_at DESC').all();
  return (rows as any[]).map(toDevice);
}

export function revokeDevice(id: string, actor: Actor, reason?: string | null): EvidenceDevice {
  getDevice(id);
  getDb()
    .prepare("UPDATE evidence_devices SET status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE id = ?")
    .run(now(), reason ?? null, id);
  recordEvent('evidence', id, 'device.revoked', actor, { reason: reason ?? null });
  return getDevice(id);
}

export function bumpDeviceRisk(id: string, delta: number) {
  getDb().prepare('UPDATE evidence_devices SET risk_score = MIN(100, MAX(0, risk_score + ?)), last_seen_at = ? WHERE id = ?').run(delta, now(), id);
}

/** Canonical string the device signs: deviceId, nonce, receivedAt, sender, operatorId, text – joined by newlines. */
export function evidenceCanonical(input: { deviceId: string; nonce: string; receivedAt: string; from: string; operatorId?: string | null; text: string }): string {
  return [input.deviceId, input.nonce, input.receivedAt, input.from, input.operatorId ?? '', input.text].join('\n');
}

// ---------------------------------------------------------------- templates

export interface ParsePatterns {
  /** Message must contain at least one of these (case-insensitive) for the template to apply. */
  keywords?: string[];
  reference?: string;
  amount?: string;
  currency?: string;
  sender?: string;
  recipient?: string;
  externalRef?: string;
  timestamp?: string;
  balance?: string;
}
export interface ParseTemplate {
  id: string;
  operatorId: string;
  name: string;
  patterns: ParsePatterns;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

function toTemplate(r: any): ParseTemplate {
  return { id: r.id, operatorId: r.operator_id, name: r.name, patterns: parseJson(r.patterns, {}), priority: r.priority, enabled: !!r.enabled, createdAt: r.created_at, updatedAt: r.updated_at };
}

const CURRENCY_WORDS =
  'GHS|GH₵|KES|Ksh|KSh|NGN|₦|UGX|USh|TZS|TSh|RWF|ZMW|MWK|ETB|XOF|XAF|FCFA|CFA|ZAR|USD|EUR|GBP|INR|PKR|BDT|PHP|EGP|MAD|SLE|LRD|GMD|MZN|AOA|CDF|BIF|SSP|SDG|SOS|MGA|NAD|BWP|LSL|SZL|MUR|SCR|CVE|GNF|NPR|LKR|MMK|KHR|VND|IDR|MYR|THB|Rs\\.?|Tk|Le|D|₹';
export const DEFAULT_TEMPLATES: Omit<ParseTemplate, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    operatorId: '*',
    name: 'Generic receipt (platform reference)',
    priority: 0,
    enabled: true,
    patterns: {
      reference: '\\b(MM[A-Z2-9]{6}|BT[A-Z2-9]{6}|sbx_[A-Z2-9]{12})\\b',
      amount: `(?:${CURRENCY_WORDS})\\s?([\\d,]+(?:\\.\\d{1,2})?)`,
      currency:
        '\\b(GHS|KES|NGN|UGX|TZS|RWF|ZMW|MWK|ETB|XOF|XAF|ZAR|USD|EUR|GBP|INR|PKR|BDT|PHP|EGP|MAD|SLE|LRD|GMD|MZN|AOA|CDF|BIF|SSP|SDG|SOS|MGA|NAD|BWP|LSL|SZL|MUR|SCR|CVE|GNF|NPR|LKR|MMK|KHR|VND|IDR|MYR|THB)\\b',
      sender: "(?:from|by)\\s+(?:([A-Z][A-Za-z .'-]{1,40}?)\\s*[-(]?\\s*)?(\\+?\\d[\\d ]{7,14}\\d)",
      recipient: "(?:sent to|paid to|transferred to|to)\\s+(?:([A-Z][A-Za-z .'-]{1,40}?)\\s*[-(]?\\s*)?(\\+?\\d[\\d ]{7,14}\\d)",
      externalRef: '(?:Transaction ID|Trans(?:action)? ?ID|Txn ?ID|TID|Financial Transaction Id|Receipt(?: No)?|Trans\\.? ?No)\\.?[:\\s#]*([A-Z0-9]{6,20})',
      balance: '(?:balance|bal)(?: is)?[:\\s]*(?:' + CURRENCY_WORDS + ')?\\s?([\\d,]+(?:\\.\\d{1,2})?)',
    },
  },
  {
    operatorId: '*',
    name: 'Generic receipt (amount before currency)',
    priority: -1,
    enabled: true,
    patterns: { amount: `(\\d[\\d,]*(?:\\.\\d{1,2})?)\\s?(?:${CURRENCY_WORDS})\\b` },
  },
  {
    operatorId: 'mpesa_ke',
    name: 'M-PESA Kenya sent',
    priority: 10,
    enabled: true,
    patterns: {
      keywords: ['sent to'],
      externalRef: '^([A-Z0-9]{10})\\s+Confirmed',
      amount: 'Ksh\\s?([\\d,]+(?:\\.\\d{1,2})?)',
      recipient: "sent to\\s+([A-Z][A-Z .'-]+?)\\s+(\\d{9,13})",
      timestamp: 'on\\s+(\\d{1,2}/\\d{1,2}/\\d{2,4}\\s+at\\s+\\d{1,2}:\\d{2}\\s?[AP]M)',
      balance: 'balance is Ksh\\s?([\\d,]+(?:\\.\\d{1,2})?)',
    },
  },
  {
    operatorId: 'orange_cd',
    name: 'Orange Money DRC sent',
    priority: 10,
    enabled: true,
    patterns: {
      keywords: ['transfert', 'transfer', 'envoy', 'sent'],
      amount: '(\\d[\\d,]*(?:\\.\\d{1,2})?)\\s?(?:CDF|FC)\\b',
      recipient: "(?:vers|to|au|a)\\s+(?:([A-Z][A-Za-z .'-]{1,40}?)\\s*[-(]?\\s*)?(\\+?\\d[\\d ]{7,14}\\d)",
      externalRef: '(?:ID|Ref|Trans(?:action)?(?: ID)?|TID)\\.?[:\\s]*([A-Z0-9.]{6,24})',
      balance: '(?:solde|balance)[:\\s]*(?:CDF|FC)?\\s?([\\d,.]+(?:\\.\\d{1,2})?)',
    },
  },
  {
    operatorId: 'mpesa_ke',
    name: 'M-PESA Kenya received',
    priority: 10,
    enabled: true,
    patterns: {
      keywords: ['Confirmed', 'received'],
      externalRef: '^([A-Z0-9]{10})\\s+Confirmed',
      amount: 'Ksh\\s?([\\d,]+(?:\\.\\d{1,2})?)',
      sender: "from\\s+([A-Z][A-Z .'-]+?)\\s+(\\d{9,13})",
      timestamp: 'on\\s+(\\d{1,2}/\\d{1,2}/\\d{2,4}\\s+at\\s+\\d{1,2}:\\d{2}\\s?[AP]M)',
      balance: 'balance is Ksh\\s?([\\d,]+(?:\\.\\d{1,2})?)',
    },
  },
  {
    operatorId: 'mtn_gh',
    name: 'MTN MoMo Ghana received',
    priority: 10,
    enabled: true,
    patterns: {
      keywords: ['received', 'Payment received'],
      amount: 'GHS\\s?([\\d,]+(?:\\.\\d{1,2})?)',
      sender: "from\\s+(?:([A-Z][A-Za-z .'-]+?)\\s*\\(?)?(0\\d{9}|\\+233\\d{9})",
      externalRef: '(?:Transaction ID|Financial Transaction Id|TID)\\.?[:\\s]*(\\d{6,14})',
      reference: '(?:Reference|Ref)\\.?[:\\s]*(MM[A-Z2-9]{6})',
      balance: '(?:Current Balance|Bal(?:ance)?)[:\\s]*GHS\\s?([\\d,]+(?:\\.\\d{1,2})?)',
    },
  },
  {
    operatorId: 'airtel_ug',
    name: 'Airtel Money Uganda received',
    priority: 10,
    enabled: true,
    patterns: {
      keywords: ['received', 'Airtel'],
      amount: 'UGX\\s?([\\d,]+(?:\\.\\d{1,2})?)',
      sender: "from\\s+(?:([A-Z][A-Za-z .'-]+?)\\s*\\(?)?(\\+?\\d{9,13})",
      externalRef: '(?:TID|Trans(?:action)? ID|Txn ?ID)\\.?[:\\s]*([A-Z0-9]{6,20})',
      balance: 'Bal(?:ance)?[:\\s]*UGX\\s?([\\d,]+(?:\\.\\d{1,2})?)',
    },
  },
];

export function ensureParseTemplates() {
  const db = getDb();
  const existing = new Set((db.prepare('SELECT operator_id, name FROM operator_parse_templates').all() as any[]).map((r) => `${r.operator_id}|${r.name}`));
  const stmt = db.prepare('INSERT INTO operator_parse_templates (id, operator_id, name, patterns, priority, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const t of DEFAULT_TEMPLATES) if (!existing.has(`${t.operatorId}|${t.name}`)) stmt.run(uuid(), t.operatorId, t.name, JSON.stringify(t.patterns), t.priority, t.enabled ? 1 : 0, now(), now());
}

export function listTemplates(operatorId?: string | null): ParseTemplate[] {
  const rows = operatorId
    ? getDb().prepare("SELECT * FROM operator_parse_templates WHERE operator_id IN (?, '*') ORDER BY priority DESC, name").all(operatorId)
    : getDb().prepare('SELECT * FROM operator_parse_templates ORDER BY operator_id, priority DESC').all();
  return (rows as any[]).map(toTemplate);
}

export function upsertTemplate(input: { id?: string | null; operatorId: string; name: string; patterns: ParsePatterns; priority?: number; enabled?: boolean }): ParseTemplate {
  for (const [k, v] of Object.entries(input.patterns)) {
    if (k === 'keywords') continue;
    try {
      new RegExp(String(v), 'im');
    } catch (err) {
      throw badRequest(`Invalid regular expression for ${k}: ${(err as Error).message}`, 'invalid_pattern');
    }
  }
  if (input.operatorId !== '*') getOperator(input.operatorId);
  const db = getDb();
  const id = input.id ?? uuid();
  db.prepare(
    `INSERT INTO operator_parse_templates (id, operator_id, name, patterns, priority, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET operator_id = excluded.operator_id, name = excluded.name, patterns = excluded.patterns, priority = excluded.priority, enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).run(id, input.operatorId, input.name, JSON.stringify(input.patterns), input.priority ?? 0, input.enabled === false ? 0 : 1, now(), now());
  return toTemplate(db.prepare('SELECT * FROM operator_parse_templates WHERE id = ?').get(id));
}

export function deleteTemplate(id: string) {
  getDb().prepare('DELETE FROM operator_parse_templates WHERE id = ?').run(id);
}

// ---------------------------------------------------------------- parsing

export interface ParsedEvidence {
  reference: string | null;
  amount: string | null;
  currency: string | null;
  senderName: string | null;
  senderPhone: string | null;
  /** Recipient of an outbound ("sent to") message – phone in `recipient`, name in `recipientName`. */
  recipient: string | null;
  recipientName: string | null;
  externalRef: string | null;
  timestamp: string | null;
  balance: string | null;
  templates: string[];
  confidence: number;
}

const SYMBOL_CURRENCY: Record<string, string> = { ksh: 'KES', ush: 'UGX', tsh: 'TZS', '₦': 'NGN', 'gh₵': 'GHS', '₹': 'INR', tk: 'BDT', le: 'SLE' };

function first(re: string | undefined, text: string, group = 1): string | null {
  if (!re) return null;
  try {
    const m = text.match(new RegExp(re, 'im'));
    return m?.[group]?.trim() || null;
  } catch {
    return null;
  }
}

export function parseEvidenceText(text: string, operatorId?: string | null): ParsedEvidence {
  const templates = listTemplates(operatorId).filter((t) => t.enabled);
  const out: ParsedEvidence = {
    reference: null,
    amount: null,
    currency: null,
    senderName: null,
    senderPhone: null,
    recipient: null,
    recipientName: null,
    externalRef: null,
    timestamp: null,
    balance: null,
    templates: [],
    confidence: 0,
  };
  for (const t of templates) {
    const p = t.patterns;
    if (p.keywords?.length && !p.keywords.some((k) => text.toLowerCase().includes(k.toLowerCase()))) continue;
    out.templates.push(t.name);
    out.reference ??= first(p.reference, text)?.toUpperCase() ?? null;
    out.amount ??= first(p.amount, text)?.replace(/,/g, '') ?? null;
    out.currency ??= first(p.currency, text)?.toUpperCase() ?? null;
    if (!out.senderPhone && p.sender) {
      try {
        const m = text.match(new RegExp(p.sender, 'im'));
        if (m) {
          out.senderName ??= m[1]?.trim() || null;
          out.senderPhone = m[2]?.replace(/\s/g, '') || null;
        }
      } catch {
        /* ignore bad pattern */
      }
    }
    if (!out.recipient && p.recipient) {
      try {
        const m = text.match(new RegExp(p.recipient, 'im'));
        if (m) {
          const phone = (m[2] ?? m[1])?.replace(/\s/g, '') ?? null;
          if (phone && /\d{7,}/.test(phone)) {
            out.recipient = phone;
            out.recipientName ??= m[2] ? m[1]?.trim() || null : null;
          }
        }
      } catch {
        /* ignore bad pattern */
      }
    }
    const ext =
      first(p.externalRef, text)
        ?.toUpperCase()
        .replace(/[.,;:]+$/, '') ?? null;
    if (ext && ext !== out.reference) out.externalRef ??= ext;
    out.timestamp ??= first(p.timestamp, text);
    out.balance ??= first(p.balance, text)?.replace(/,/g, '') ?? null;
  }
  if (!out.currency) {
    const sym = text.match(/\b(Ksh|USh|TSh|Tk|Le)\b|₦|GH₵|₹/i)?.[0]?.toLowerCase();
    if (sym && SYMBOL_CURRENCY[sym]) out.currency = SYMBOL_CURRENCY[sym];
  }
  // Confidence: what the message lets us verify independently.
  let c = 0;
  if (out.reference) c += 50;
  if (out.amount) c += 25;
  if (out.currency) c += 10;
  if (out.externalRef) c += 10;
  if (out.senderPhone || out.senderName || out.recipient) c += 5;
  out.confidence = Math.min(100, c);
  return out;
}

// ---------------------------------------------------------------- ingestion + matching

export type EvidenceSource = 'signed_device' | 'shared_secret' | 'manual';
export type EvidenceOutcome = 'matched' | 'settled' | 'review' | 'mismatched' | 'duplicate' | 'unmatched' | 'unsupported';

export interface EvidenceView {
  id: string;
  paymentId: string | null;
  deviceId: string | null;
  source: EvidenceSource;
  operatorId: string | null;
  sender: string | null;
  rawText: string;
  rawHash: string;
  receivedAt: string | null;
  parsed: ParsedEvidence;
  confidence: number;
  outcome: EvidenceOutcome;
  reasons: string[];
  externalRef: string | null;
  verifier: { type: string | null; id: string | null };
  direction: 'in' | 'out';
  payoutId: string | null;
  simIdentity: string | null;
  operatorTimestamp: string | null;
  createdAt: string;
}

export function toEvidence(r: any): EvidenceView {
  return {
    id: r.id,
    paymentId: r.payment_id,
    deviceId: r.device_id,
    source: r.source,
    operatorId: r.operator_id,
    sender: r.sender,
    rawText: r.raw_text,
    rawHash: r.raw_hash,
    receivedAt: r.received_at,
    parsed: parseJson(r.parsed, {} as ParsedEvidence),
    confidence: r.confidence,
    outcome: r.outcome,
    reasons: parseJson(r.reasons, []),
    externalRef: r.external_ref,
    verifier: { type: r.verifier_type, id: r.verifier_id },
    direction: r.direction ?? 'in',
    payoutId: r.payout_id ?? null,
    simIdentity: r.sim_identity ?? null,
    operatorTimestamp: r.operator_timestamp ?? null,
    createdAt: r.created_at,
  };
}

/** Persist one evidence record (used by the inbound engine and by the payout engine). */
export function storeEvidence(row: {
  paymentId?: string | null;
  payoutId?: string | null;
  direction: 'in' | 'out';
  deviceId?: string | null;
  source: EvidenceSource;
  operatorId?: string | null;
  sender?: string | null;
  rawText: string;
  rawHash: string;
  receivedAt?: string | null;
  parsed: ParsedEvidence;
  outcome: string;
  reasons: string[];
  nonce?: string | null;
  signature?: string | null;
  verifier: { type: string | null; id: string | null };
  simIdentity?: string | null;
  operatorTimestamp?: string | null;
  clientHash?: string | null;
}): string {
  const id = uuid();
  getDb()
    .prepare(
      `INSERT INTO payment_evidence (id, payment_id, device_id, source, operator_id, sender, raw_text, raw_hash, received_at, parsed, confidence, outcome, reasons, external_ref, nonce, signature, verifier_type, verifier_id, created_at, direction, payout_id, sim_identity, operator_timestamp, client_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      row.paymentId ?? null,
      row.deviceId ?? null,
      row.source,
      row.operatorId ?? null,
      row.sender ?? null,
      row.rawText,
      row.rawHash,
      row.receivedAt ?? now(),
      JSON.stringify(row.parsed),
      row.parsed.confidence,
      row.outcome,
      JSON.stringify(row.reasons),
      row.parsed.externalRef,
      row.nonce ?? null,
      row.signature ?? null,
      row.verifier.type,
      row.verifier.id,
      now(),
      row.direction,
      row.payoutId ?? null,
      row.simIdentity ?? null,
      row.operatorTimestamp ?? null,
      row.clientHash ?? null,
    );
  return id;
}

export interface IngestInput {
  source: EvidenceSource;
  deviceId?: string | null;
  nonce?: string | null;
  signature?: string | null;
  receivedAt?: string | null;
  from?: string | null;
  operatorId?: string | null;
  text: string;
  /** Who submitted it (device, admin, agent). */
  actor: Actor;
}

/** Devices authenticate API calls (queue, claim) by signing `deviceId\ntimestamp\nMETHOD\npath` with their key; 5-minute skew, timestamp acts as nonce. */
export function verifyDeviceRequest(headers: Record<string, unknown>, method: string, path: string): EvidenceDevice {
  const deviceId = String(headers['x-device-id'] ?? '');
  const ts = String(headers['x-device-timestamp'] ?? '');
  const sig = String(headers['x-device-signature'] ?? '');
  if (!deviceId || !ts || !sig) throw unauthorized('Device authentication headers missing', 'device_auth_required');
  const device = getDevice(deviceId);
  if (device.status !== 'active') throw forbidden('This device has been revoked', 'device_revoked');
  if (Math.abs(Date.now() - new Date(ts).getTime()) > 5 * 60_000) throw unauthorized('Device timestamp out of range', 'device_auth_stale');
  const nonce = `req:${ts}:${method}:${path}`;
  if (getDb().prepare('SELECT 1 FROM evidence_nonces WHERE device_id = ? AND nonce = ?').get(device.id, nonce)) throw unauthorized('Replayed device request', 'evidence_replay');
  let ok = false;
  try {
    ok = cryptoVerify(null, Buffer.from([deviceId, ts, method.toUpperCase(), path].join('\n')), parsePublicKey(device.publicKey), Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  } catch {
    ok = false;
  }
  if (!ok) {
    bumpDeviceRisk(device.id, 10);
    throw unauthorized('Device request signature is invalid', 'invalid_signature');
  }
  getDb().prepare('INSERT INTO evidence_nonces (device_id, nonce, created_at) VALUES (?, ?, ?)').run(device.id, nonce, now());
  getDb().prepare('UPDATE evidence_devices SET last_seen_at = ? WHERE id = ?').run(now(), device.id);
  return device;
}

/** Verify a device signature over the canonical evidence string; replays of a nonce are refused. */
export function authenticateDevice(input: IngestInput): EvidenceDevice {
  if (!input.deviceId || !input.nonce || !input.signature || !input.receivedAt || input.from == null)
    throw badRequest('deviceId, nonce, receivedAt, from, text and signature are required', 'validation_error');
  const device = getDevice(input.deviceId);
  if (device.status !== 'active') throw forbidden('This device has been revoked', 'device_revoked');
  const db = getDb();
  const seen = db.prepare('SELECT 1 FROM evidence_nonces WHERE device_id = ? AND nonce = ?').get(device.id, input.nonce);
  if (seen) {
    bumpDeviceRisk(device.id, 10);
    recordEvent('evidence', device.id, 'device.replay_rejected', { type: 'device', id: device.id }, { nonce: input.nonce });
    throw unauthorized('Replayed evidence (nonce already used)', 'evidence_replay');
  }
  const ok = (() => {
    try {
      return cryptoVerify(
        null,
        Buffer.from(evidenceCanonical({ deviceId: device.id, nonce: input.nonce!, receivedAt: input.receivedAt!, from: input.from!, operatorId: input.operatorId, text: input.text })),
        parsePublicKey(device.publicKey),
        Buffer.from(input.signature!.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
      );
    } catch {
      return false;
    }
  })();
  if (!ok) {
    bumpDeviceRisk(device.id, 25);
    recordEvent('evidence', device.id, 'device.bad_signature', { type: 'device', id: device.id }, {});
    throw unauthorized('Evidence signature is invalid', 'invalid_signature');
  }
  db.prepare('INSERT INTO evidence_nonces (device_id, nonce, created_at) VALUES (?, ?, ?)').run(device.id, input.nonce, now());
  db.prepare('UPDATE evidence_devices SET last_seen_at = ? WHERE id = ?').run(now(), device.id);
  return device;
}

function amountMatches(parsedAmount: string | null, payment: GatewayPaymentRow): boolean {
  if (!parsedAmount) return false;
  try {
    return toMinor(parsedAmount, getCurrency(payment.currency, false).decimals) === payment.amount;
  } catch {
    return false;
  }
}

/**
 * Ingest one piece of evidence. Returns the stored evidence with its outcome; the matched payment
 * (if any) is moved through the lifecycle accordingly. Never throws for a mismatch – it is recorded.
 */
export function ingestEvidence(input: IngestInput): EvidenceView {
  const controls = getGatewayControls();
  const db = getDb();
  let device: EvidenceDevice | null = null;
  if (input.source === 'signed_device') device = authenticateDevice(input);
  const operatorId = input.operatorId ?? null;
  const rawHash = sha256(`${operatorId ?? ''}|${input.from ?? ''}|${input.text.trim()}`);
  const parsed = parseEvidenceText(input.text, operatorId);
  const reasons: string[] = [];
  let outcome: EvidenceOutcome = 'unmatched';
  let payment: GatewayPaymentRow | undefined;

  // 1. Same message submitted twice (any device / source) is a duplicate submission.
  const priorSame = db.prepare("SELECT id, payment_id FROM payment_evidence WHERE raw_hash = ? AND outcome IN ('matched','settled','review')").get(rawHash) as any;
  if (priorSame) {
    outcome = 'duplicate';
    reasons.push('duplicate_submission');
    payment = priorSame.payment_id ? getPayment(priorSame.payment_id) : undefined;
  } else {
    payment = parsed.reference ? findPaymentByReference(parsed.reference) : undefined;
    if (!payment) {
      outcome = parsed.confidence < controls.reviewScore ? 'unsupported' : 'unmatched';
      reasons.push(parsed.reference ? 'reference_not_found' : 'no_reference');
    } else {
      // 2. Operator transaction id reused for another payment = replay of a real receipt.
      if (parsed.externalRef) {
        const reused = db
          .prepare("SELECT id, payment_id FROM payment_evidence WHERE external_ref = ? AND (operator_id = ? OR operator_id IS NULL) AND outcome IN ('matched','settled') AND payment_id != ?")
          .get(parsed.externalRef, operatorId, payment.id) as any;
        if (reused) {
          outcome = 'duplicate';
          reasons.push(`external_ref_reused:${reused.payment_id}`);
        }
      }
      if (outcome !== 'duplicate') {
        if (TERMINAL_STAGES.includes(payment.stage as PaymentStage) || payment.stage === 'CONFIRMED') {
          outcome = 'duplicate';
          reasons.push(`payment_already_${payment.stage.toLowerCase()}`);
        } else if (!OPEN_STAGES.includes(payment.stage as PaymentStage)) {
          outcome = 'mismatched';
          reasons.push(`payment_stage_${payment.stage.toLowerCase()}`);
        } else {
          // 3. Field matching.
          const checks: string[] = [];
          if (!amountMatches(parsed.amount, payment)) checks.push(parsed.amount ? 'amount_mismatch' : 'amount_missing');
          if (parsed.currency && parsed.currency !== payment.currency) checks.push('currency_mismatch');
          const op: MomoOperator | null = operatorId ? safeOperator(operatorId) : null;
          const paymentOperator = parseJson<any>(payment.metadata, {}).operatorId as string | null;
          if (op && paymentOperator && op.id !== paymentOperator) checks.push('operator_mismatch');
          if (op && op.currency !== payment.currency) checks.push('operator_currency_mismatch');
          if (parsed.recipient && op?.collectionNumber && normalizePhoneDigits(parsed.recipient) !== normalizePhoneDigits(op.collectionNumber)) checks.push('recipient_mismatch');
          if (parsed.senderPhone && payment.payer_phone && normalizePhoneDigits(parsed.senderPhone) !== normalizePhoneDigits(payment.payer_phone)) checks.push('sender_mismatch');
          const received = input.receivedAt ? new Date(input.receivedAt).getTime() : Date.now();
          const created = new Date(payment.created_at).getTime();
          if (received < created - 5 * 60_000) checks.push('received_before_intent');
          if (received > created + controls.evidenceWindowHours * 3600_000) checks.push('outside_time_window');
          if (device && device.operatorIds.length && operatorId && !device.operatorIds.includes(operatorId)) checks.push('device_not_authorised_for_operator');
          if (checks.length) {
            outcome = 'mismatched';
            reasons.push(...checks);
          } else {
            outcome = 'matched';
          }
        }
      }
    }
  }

  // Trust decides whether a match may settle automatically.
  const trusted = (input.source === 'signed_device' && device && device.riskScore < 50 && device.kind === 'collection') || (input.source === 'shared_secret' && controls.sharedSecretAutoConfirm);
  if (outcome === 'matched') {
    if (!trusted) reasons.push(input.source === 'shared_secret' ? 'shared_secret_not_authoritative' : input.source === 'manual' ? 'manual_entry_needs_approval' : 'device_risk');
    if (parsed.confidence < controls.autoConfirmScore) reasons.push(`confidence_${parsed.confidence}_below_${controls.autoConfirmScore}`);
  }
  const autoSettle = outcome === 'matched' && trusted && parsed.confidence >= controls.autoConfirmScore;

  const id = uuid();
  const verifier = device ? { type: 'device', id: device.id } : { type: input.actor.type, id: input.actor.id ?? null };
  db.prepare(
    `INSERT INTO payment_evidence (id, payment_id, device_id, source, operator_id, sender, raw_text, raw_hash, received_at, parsed, confidence, outcome, reasons, external_ref, nonce, signature, verifier_type, verifier_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    payment?.id ?? null,
    device?.id ?? null,
    input.source,
    operatorId,
    input.from ?? null,
    input.text,
    rawHash,
    input.receivedAt ?? now(),
    JSON.stringify(parsed),
    parsed.confidence,
    autoSettle ? 'matched' : outcome === 'matched' ? 'review' : outcome,
    JSON.stringify(reasons),
    parsed.externalRef,
    input.nonce ?? null,
    input.signature ?? null,
    verifier.type,
    verifier.id,
    now(),
  );
  recordEvent('evidence', payment?.id ?? id, 'evidence.received', input.actor, {
    evidenceId: id,
    source: input.source,
    deviceId: device?.id ?? null,
    outcome: autoSettle ? 'matched' : outcome === 'matched' ? 'review' : outcome,
    confidence: parsed.confidence,
    reasons,
    rawHash,
    externalRef: parsed.externalRef,
  });

  if (payment) {
    const actor: Actor = device ? { type: 'device', id: device.id } : input.actor;
    if (autoSettle) {
      transitionStage(payment.id, 'EVIDENCE_RECEIVED', actor, { evidenceId: id });
      const after = confirmAndSettle(getPayment(payment.id), { actor, source: input.source, evidenceId: id, details: { confidence: parsed.confidence, externalRef: parsed.externalRef } });
      if (after.stage === 'SETTLED') db.prepare("UPDATE payment_evidence SET outcome = 'settled' WHERE id = ?").run(id);
    } else if (outcome === 'matched') {
      if (OPEN_STAGES.includes(payment.stage as PaymentStage)) {
        transitionStage(payment.id, 'EVIDENCE_RECEIVED', actor, { evidenceId: id });
        transitionStage(payment.id, 'MANUAL_REVIEW', { type: 'system' }, { evidenceId: id, reasons });
      }
    } else if (outcome === 'mismatched' && OPEN_STAGES.includes(payment.stage as PaymentStage)) {
      if (device) bumpDeviceRisk(device.id, 5);
      transitionStage(payment.id, 'MISMATCHED', actor, { evidenceId: id, reasons });
    } else if (outcome === 'duplicate' && OPEN_STAGES.includes(payment.stage as PaymentStage) && payment.stage !== 'CONFIRMED') {
      if (device) bumpDeviceRisk(device.id, 10);
      transitionStage(payment.id, 'DUPLICATE', actor, { evidenceId: id, reasons });
    }
  }
  return getEvidence(id);
}

function safeOperator(id: string): MomoOperator | null {
  try {
    return getOperator(id);
  } catch {
    return null;
  }
}

export function getEvidence(id: string): EvidenceView {
  const row = getDb().prepare('SELECT * FROM payment_evidence WHERE id = ?').get(id);
  if (!row) throw notFound('Evidence not found', 'evidence_not_found');
  return toEvidence(row);
}

export function listEvidence(filter: { paymentId?: string | null; payoutId?: string | null; outcome?: string | null; page?: number; pageSize?: number } = {}): {
  items: EvidenceView[];
  total: number;
} {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.paymentId) {
    where.push('payment_id = ?');
    params.push(filter.paymentId);
  }
  if (filter.payoutId) {
    where.push('payout_id = ?');
    params.push(filter.payoutId);
  }
  if (filter.outcome) {
    where.push('outcome = ?');
    params.push(filter.outcome);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageSize = filter.pageSize ?? 50;
  const page = filter.page ?? 1;
  const total = (db.prepare(`SELECT COUNT(*) c FROM payment_evidence ${whereSql}`).get(...params) as any).c as number;
  const rows = db.prepare(`SELECT * FROM payment_evidence ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as any[];
  return { items: rows.map(toEvidence), total };
}
