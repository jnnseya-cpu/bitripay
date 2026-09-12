/**
 * BitriQR codes: one persistent merchant QR that any eligible rail can pay. Static codes identify the merchant and
 * location (payer enters the amount); dynamic codes carry a server-side intent reference, amount and expiry and are
 * always signed; the resolver verifies signature, expiry, merchant status, replay state and country policy before a
 * payer sees anything. Managed locations and terminals let a chain run thousands of codes under one merchant.
 */
import { randomBytes } from 'node:crypto';
import { getDb } from '../db';
import { uuid, now, shortCode } from '../lib/ids';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { config } from '../config';
import * as bitriqr from '@bitripay/bitriqr';
import type { UserRow } from './users';
import { findUserById, findUserByTag } from './users';
import { getCurrency } from './currencies';
import { merchantSigningKey, signWithKey, verifyWithKey } from './keys';
import { recordEvent, type Actor } from './events';
import { countryCapabilities } from './capabilities';
import { createIntent, getIntentRow, intentView, discoverMethods, merchantIdentity, setIntentAmount, type IntentRow, type CreateIntentInput } from './intents';
import { fromMinor } from '@bitripay/shared';

export type QrMode = 'STATIC' | 'DYNAMIC' | 'OFFLINE';
export type QrKind = 'merchant' | 'invoice' | 'p2p' | 'agent' | 'cross_border' | 'refund' | 'mandate' | 'institution';
export interface QrView {
  id: string;
  code: string;
  merchantId: string;
  locationId: string | null;
  terminalId: string | null;
  mode: QrMode;
  kind: QrKind;
  payload: string;
  uri: string;
  link: string;
  rails: string[];
  keyId: string | null;
  signed: boolean;
  amount: number | null;
  currency: string;
  purposeCode: string | null;
  reference: string | null;
  intentId: string | null;
  expiresAt: string | null;
  status: string;
  revokedReason: string | null;
  assetRef: string | null;
  scans: number;
  createdAt: string;
}
const toView = (r: any): QrView => ({ id: r.id, code: r.code, merchantId: r.merchant_user_id, locationId: r.location_id, terminalId: r.terminal_id, mode: r.mode, kind: r.kind, payload: r.payload, uri: r.uri, link: `${config.webUrl}/q/${r.code}`, rails: bitriqr.maskToRails(r.rails_mask), keyId: r.key_id, signed: !!r.key_id, amount: r.amount, currency: r.currency, purposeCode: r.purpose_code, reference: r.reference, intentId: r.intent_id, expiresAt: r.expires_at, status: r.status, revokedReason: r.revoked_reason, assetRef: r.asset_ref, scans: r.scans, createdAt: r.created_at });

export function merchantCode(merchant: UserRow): string {
  return `BM-${merchant.tag.toUpperCase()}`;
}
function merchantFromCode(code: string): UserRow | undefined {
  return code.startsWith('BM-') ? findUserByTag(code.slice(3).toLowerCase()) : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Locations and terminals
// ---------------------------------------------------------------------------------------------------------------------

export function createLocation(merchant: UserRow, input: { name: string; address?: string | null; city?: string | null; country?: string | null; mcc?: string | null; lat?: number | null; lng?: number | null }) {
  const id = `loc_${shortCode(12).toLowerCase()}`;
  getDb().prepare('INSERT INTO merchant_locations (id, merchant_user_id, name, address, city, country, mcc, lat, lng, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, merchant.id, input.name, input.address ?? null, input.city ?? null, (input.country ?? merchant.country ?? null)?.toUpperCase() ?? null, input.mcc ?? null, input.lat ?? null, input.lng ?? null, now(), now());
  return getLocation(merchant.id, id);
}
export function getLocation(merchantUserId: string, id: string) {
  const r = getDb().prepare('SELECT * FROM merchant_locations WHERE id = ? AND merchant_user_id = ?').get(id, merchantUserId) as any;
  if (!r) throw notFound('Location not found', 'location_not_found');
  return { id: r.id, name: r.name, address: r.address, city: r.city, country: r.country, mcc: r.mcc, lat: r.lat, lng: r.lng, status: r.status, createdAt: r.created_at, terminals: listTerminals(r.id) };
}
export function listLocations(merchantUserId: string) {
  return (getDb().prepare('SELECT id FROM merchant_locations WHERE merchant_user_id = ? ORDER BY created_at').all(merchantUserId) as any[]).map((r) => getLocation(merchantUserId, r.id));
}
export function createTerminal(merchant: UserRow, locationId: string, input: { label: string; deviceRef?: string | null }) {
  getLocation(merchant.id, locationId);
  const id = `term_${shortCode(10).toLowerCase()}`;
  getDb().prepare('INSERT INTO terminals (id, location_id, merchant_user_id, label, device_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, locationId, merchant.id, input.label, input.deviceRef ?? null, now());
  return listTerminals(locationId).find((t) => t.id === id)!;
}
export function listTerminals(locationId: string) {
  return (getDb().prepare('SELECT * FROM terminals WHERE location_id = ? ORDER BY created_at').all(locationId) as any[]).map((t) => ({ id: t.id, label: t.label, deviceRef: t.device_ref, status: t.status, createdAt: t.created_at }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Creating codes
// ---------------------------------------------------------------------------------------------------------------------

function fields(merchant: UserRow, input: { mode: 'static' | 'dynamic'; rails: bitriqr.Rail[]; currency: string; amount?: string | null; intentRef?: string | null; reference?: string | null; purposeCode?: string | null; keyId?: string | null; expiresAt?: number | null; corridorFlag?: string | null; location?: any }): bitriqr.BitriQrFields {
  return { mode: input.mode, merchantId: merchantCode(merchant), rails: input.rails, intentRef: input.intentRef ?? null, mcc: input.location?.mcc ?? null, currency: input.currency, amount: input.amount ?? null, country: (input.location?.country ?? merchant.country ?? 'CD').toUpperCase(), merchantName: (merchant.business_name || merchant.full_name).toUpperCase().replace(/[^A-Z0-9 .&'-]/g, ' ').slice(0, 25), city: input.location?.city ?? null, billRef: input.reference ?? null, purposeCode: input.purposeCode ?? null, keyId: input.keyId ?? null, expiresAt: input.expiresAt ?? null, corridorFlag: input.corridorFlag ?? null };
}
function railsFor(input: string[] | undefined, merchant: UserRow): bitriqr.Rail[] {
  const caps = countryCapabilities(merchant.country);
  const wanted = (input?.length ? input : ['wallet', 'mpesa', 'airtel', 'orange', 'card', 'bank']) as bitriqr.Rail[];
  return wanted.filter((r) => r in bitriqr.RAILS && (r !== 'bitcoin' || caps.bitcoin) && (r !== 'wallet' || caps.wallet));
}

export function createStaticQr(merchant: UserRow, input: { locationId?: string | null; terminalId?: string | null; rails?: string[]; currency: string; purposeCode?: string | null; reference?: string | null; kind?: QrKind; sign?: boolean; assetRef?: string | null; corridorFlag?: string | null }): QrView {
  const cur = getCurrency(input.currency);
  const location = input.locationId ? getLocation(merchant.id, input.locationId) : null;
  const rails = railsFor(input.rails, merchant);
  const key = input.sign === false ? null : merchantSigningKey(merchant.id);
  const f = fields(merchant, { mode: 'static', rails, currency: cur.code, reference: input.reference ?? null, purposeCode: input.purposeCode ?? null, keyId: key?.keyId ?? null, corridorFlag: input.corridorFlag ?? null, location });
  const payload = key ? (bitriqr.encodeSigned(f, (p) => signWithKey(key.keyId, p)) as string) : bitriqr.encodeUnsigned(f);
  const id = `qr_${shortCode(14).toLowerCase()}`;
  const code = shortCode(8);
  getDb().prepare('INSERT INTO qr_codes (id, code, merchant_user_id, location_id, terminal_id, mode, kind, payload, uri, rails_mask, key_id, amount, currency, purpose_code, reference, status, asset_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)').run(id, code, merchant.id, location?.id ?? null, input.terminalId ?? null, 'STATIC', input.kind ?? 'merchant', payload, `${config.webUrl}/q/${code}`, bitriqr.railsToMask(rails), key?.keyId ?? null, cur.code, input.purposeCode ?? null, input.reference ?? null, 'active', input.assetRef ?? null, now(), now());
  recordEvent('payment', id, 'qr.created', { type: 'merchant', id: merchant.id }, { mode: 'STATIC', signed: !!key, locationId: location?.id ?? null });
  return getQr(id);
}

/** A dynamic (per-transaction) code: signed, short-lived, tied to one intent. */
export function createDynamicQr(merchant: UserRow, intent: IntentRow, ttlSeconds = 300, corridorFlag?: string | null): QrView {
  if (!intent.amount_minor) throw badRequest('Dynamic QR needs an amount', 'amount_required');
  const cur = getCurrency(intent.currency);
  const location = intent.location_id ? getLocation(merchant.id, intent.location_id) : null;
  const rails = railsFor(JSON.parse(intent.rails), merchant);
  const key = merchantSigningKey(merchant.id);
  const intentExpiry = intent.expires_at ? Math.floor(new Date(intent.expires_at).getTime() / 1000) : 0;
  const exp = Math.min(Math.floor(Date.now() / 1000) + ttlSeconds, intentExpiry || Number.MAX_SAFE_INTEGER);
  const f = fields(merchant, { mode: 'dynamic', rails, currency: cur.code, amount: fromMinor(intent.amount_minor, cur.decimals), intentRef: intent.id, reference: intent.reference ?? null, purposeCode: intent.purpose_code ?? null, keyId: key.keyId, expiresAt: exp, corridorFlag: corridorFlag ?? null, location });
  const payload = bitriqr.encodeSigned(f, (p) => signWithKey(key.keyId, p)) as string;
  const id = `qr_${shortCode(14).toLowerCase()}`;
  const code = shortCode(8);
  const db = getDb();
  db.prepare('INSERT INTO qr_codes (id, code, merchant_user_id, location_id, terminal_id, mode, kind, payload, uri, rails_mask, key_id, amount, currency, purpose_code, reference, intent_id, payment_request_id, nonce, expires_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, code, merchant.id, intent.location_id, intent.terminal_id, 'DYNAMIC', intent.purpose_code && intent.purpose_code !== 'GENERAL_MERCHANT' ? 'institution' : 'merchant', payload, bitriqr.intentUri(intent.id), bitriqr.railsToMask(rails), key.keyId, intent.amount_minor, cur.code, intent.purpose_code, intent.reference, intent.id, intent.payment_request_id, randomBytes(8).toString('base64url'), new Date(exp * 1000).toISOString(), 'active', now(), now());
  db.prepare('UPDATE payment_intents SET qr_id = ?, updated_at = ? WHERE id = ?').run(id, now(), intent.id);
  return getQr(id);
}

export function getQr(id: string): QrView {
  const r = getDb().prepare('SELECT * FROM qr_codes WHERE id = ? OR code = ?').get(id, id);
  if (!r) throw notFound('QR code not found', 'qr_not_found');
  return toView(r);
}
export function listQrs(merchantUserId: string, filter: { locationId?: string | null; mode?: string | null; status?: string | null } = {}): QrView[] {
  const where = ['merchant_user_id = ?'];
  const params: unknown[] = [merchantUserId];
  if (filter.locationId) { where.push('location_id = ?'); params.push(filter.locationId); }
  if (filter.mode) { where.push('mode = ?'); params.push(filter.mode); }
  if (filter.status) { where.push('status = ?'); params.push(filter.status); }
  return (getDb().prepare(`SELECT * FROM qr_codes WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`).all(...params) as any[]).map(toView);
}
export function revokeQr(merchant: UserRow, id: string, reason: 'lost' | 'stolen' | 'tampered' | 'replaced' | 'retired' | string): QrView {
  const q = getQr(id);
  if (q.merchantId !== merchant.id && merchant.role !== 'admin') throw forbidden('Not your QR code', 'forbidden');
  getDb().prepare("UPDATE qr_codes SET status = 'revoked', revoked_reason = ?, updated_at = ? WHERE id = ?").run(reason, now(), q.id);
  recordEvent('payment', q.id, 'qr.revoked', { type: merchant.role === 'admin' ? 'admin' : 'merchant', id: merchant.id }, { reason });
  return getQr(q.id);
}

export function qrAnalytics(merchantUserId: string, days = 30) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const db = getDb();
  const scans = db.prepare("SELECT outcome, COUNT(*) c FROM qr_scans s JOIN qr_codes q ON q.id = s.qr_id WHERE q.merchant_user_id = ? AND s.created_at >= ? GROUP BY outcome").all(merchantUserId, since) as any[];
  const paid = (db.prepare("SELECT COUNT(*) c FROM payment_intents WHERE merchant_user_id = ? AND source = 'qr' AND status IN ('CAPTURED', 'SETTLEMENT_PENDING', 'SETTLED') AND created_at >= ?").get(merchantUserId, since) as any).c;
  const created = (db.prepare("SELECT COUNT(*) c FROM payment_intents WHERE merchant_user_id = ? AND source = 'qr' AND created_at >= ?").get(merchantUserId, since) as any).c;
  const byLocation = db.prepare("SELECT COALESCE(l.name, 'No location') name, COUNT(*) scans FROM qr_scans s JOIN qr_codes q ON q.id = s.qr_id LEFT JOIN merchant_locations l ON l.id = q.location_id WHERE q.merchant_user_id = ? AND s.created_at >= ? GROUP BY name ORDER BY scans DESC").all(merchantUserId, since);
  const suspicious = (db.prepare("SELECT COUNT(*) c FROM qr_scans s JOIN qr_codes q ON q.id = s.qr_id WHERE q.merchant_user_id = ? AND s.created_at >= ? AND s.outcome IN ('revoked', 'invalid', 'expired')").get(merchantUserId, since) as any).c;
  return { days, scans: Object.fromEntries(scans.map((s) => [s.outcome, s.c])), intentsFromQr: created, paidFromQr: paid, conversion: created ? Math.round((paid / created) * 1000) / 10 : null, byLocation, suspiciousScans: suspicious };
}

// ---------------------------------------------------------------------------------------------------------------------
// Resolving a scan
// ---------------------------------------------------------------------------------------------------------------------

export interface Resolution {
  kind: 'intent' | 'static' | 'user' | 'invalid';
  trust: 'verified' | 'basic' | 'invalid';
  reasons: string[];
  merchant: ReturnType<typeof merchantIdentity> | null;
  intent: ReturnType<typeof intentView> | null;
  qr: QrView | null;
  amount: number | null;
  currency: string | null;
  purposeCode: string | null;
  reference: string | null;
  methods: ReturnType<typeof discoverMethods> | null;
  disclosures: string[];
  expiresAt: string | null;
  /** The hosted checkout for payers without the app. */
  checkoutUrl: string | null;
}

function scanLog(qrId: string | null, intentId: string | null, outcome: string, trust: string | null, ctx: { payer?: UserRow | null; ip?: string | null; channel?: string; country?: string | null }) {
  getDb().prepare('INSERT INTO qr_scans (id, qr_id, intent_id, channel, outcome, trust, payer_user_id, ip, country, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(uuid(), qrId, intentId, ctx.channel ?? 'app', outcome, trust, ctx.payer?.id ?? null, ctx.ip ?? null, ctx.country ?? null, now());
  if (qrId) getDb().prepare('UPDATE qr_codes SET scans = scans + 1 WHERE id = ?').run(qrId);
}

/** Resolve anything a camera can hand us: a TLV payload, a bitripay://pay/<intent> URI, a QR code, or an intent id. */
export async function resolveScan(content: string, ctx: { payer?: UserRow | null; ip?: string | null; channel?: string; country?: string | null } = {}): Promise<Resolution> {
  const invalid = (reasons: string[], qr: QrView | null = null): Resolution => ({ kind: 'invalid', trust: 'invalid', reasons, merchant: qr ? merchantIdentity(qr.merchantId, qr.locationId) : null, intent: null, qr, amount: null, currency: null, purposeCode: null, reference: null, methods: null, disclosures: [], expiresAt: null, checkoutUrl: null });
  const text = content.trim();
  let intentRef: string | null = null;
  let decoded: bitriqr.DecodedBitriQr | null = null;
  let qrRow: any = null;
  if (bitriqr.isBitriQr(text)) {
    try {
      decoded = bitriqr.decode(text);
    } catch (e: any) {
      scanLog(null, null, 'invalid', null, ctx);
      return invalid([`malformed: ${e?.message ?? 'payload'}`]);
    }
    qrRow = getDb().prepare('SELECT * FROM qr_codes WHERE payload = ?').get(text) as any;
    intentRef = decoded.intentRef ?? null;
  } else if (bitriqr.parseIntentUri(text)) intentRef = bitriqr.parseIntentUri(text);
  else if (/^pi_/.test(text)) intentRef = text;
  else {
    qrRow = getDb().prepare('SELECT * FROM qr_codes WHERE code = ? OR id = ?').get(text, text) as any;
    if (!qrRow) return invalid(['unknown_code']);
    intentRef = qrRow.intent_id;
    try {
      decoded = bitriqr.decode(qrRow.payload);
    } catch {
      decoded = null;
    }
  }
  const qr = qrRow ? toView(qrRow) : null;
  // trust: signature against the registry, expiry, CRC
  let trust: 'verified' | 'basic' | 'invalid' = 'basic';
  let reasons: string[] = [];
  if (decoded) {
    const v = await bitriqr.verify(decoded, (p, sig) => (decoded!.keyId ? verifyWithKey(decoded!.keyId, p, sig) : false));
    trust = v.trust;
    reasons = v.reasons;
  }
  if (qr && qr.status !== 'active') {
    scanLog(qr.id, qr.intentId, 'revoked', trust, ctx);
    return invalid(['qr_revoked', ...(qr.revokedReason ? [qr.revokedReason] : [])], qr);
  }
  if (qr && qr.expiresAt && qr.expiresAt < now()) {
    scanLog(qr.id, qr.intentId, 'expired', trust, ctx);
    return invalid(['expired'], qr);
  }
  if (trust === 'invalid') {
    scanLog(qr?.id ?? null, intentRef, 'invalid', trust, ctx);
    return invalid(reasons, qr);
  }
  const merchantUser = qr ? findUserById(qr.merchantId) : decoded ? merchantFromCode(decoded.merchantId) : null;
  if (intentRef) {
    let row: IntentRow;
    try {
      row = getIntentRow(intentRef);
    } catch {
      scanLog(qr?.id ?? null, null, 'invalid', trust, ctx);
      return invalid(['unknown_intent'], qr);
    }
    const merchant = findUserById(row.merchant_user_id)!;
    if (merchant.status !== 'active') return invalid(['merchant_suspended'], qr);
    const caps = countryCapabilities(merchant.country);
    scanLog(qr?.id ?? null, row.id, ['CAPTURED', 'SETTLEMENT_PENDING', 'SETTLED'].includes(row.status) ? 'already_paid' : row.expires_at && row.expires_at < now() ? 'expired' : 'resolved', trust, ctx);
    const view = intentView(row);
    return { kind: 'intent', trust, reasons: [], merchant: merchantIdentity(merchant.id, row.location_id), intent: view, qr, amount: row.amount_minor, currency: row.currency, purposeCode: row.purpose_code, reference: row.reference, methods: discoverMethods(row, ctx.payer ?? null, ctx.country ?? ctx.payer?.country ?? null), disclosures: caps.requiredDisclosures, expiresAt: row.expires_at, checkoutUrl: view.checkoutUrl };
  }
  if (!merchantUser) return invalid(['unknown_merchant'], qr);
  if (merchantUser.status !== 'active') return invalid(['merchant_suspended'], qr);
  scanLog(qr?.id ?? null, null, 'resolved', trust, ctx);
  const caps = countryCapabilities(merchantUser.country);
  return { kind: 'static', trust, reasons: [], merchant: merchantIdentity(merchantUser.id, qr?.locationId ?? null), intent: null, qr, amount: null, currency: qr?.currency ?? decoded?.currency ?? null, purposeCode: qr?.purposeCode ?? decoded?.purposeCode ?? null, reference: qr?.reference ?? decoded?.billRef ?? null, methods: null, disclosures: caps.requiredDisclosures, expiresAt: null, checkoutUrl: null };
}

/** A payer scanned a static code and entered an amount: create the intent for it (source 'qr'). */
export function intentFromStaticQr(qrId: string, amountMinor: number, payer: UserRow | null, extra: Partial<CreateIntentInput> = {}) {
  const qr = getQr(qrId);
  if (qr.status !== 'active') throw conflict('This QR code is no longer active', 'qr_revoked');
  if (qr.mode !== 'STATIC') throw badRequest('Only static codes take a payer-entered amount', 'not_static');
  const merchant = findUserById(qr.merchantId);
  if (!merchant) throw notFound('Merchant not found', 'merchant_not_found');
  const { row } = createIntent(merchant, { amountMinor, currency: qr.currency, rails: qr.rails, purposeCode: qr.purposeCode, reference: qr.reference, description: extra.description ?? null, source: 'qr', qrId: qr.id, locationId: qr.locationId, terminalId: qr.terminalId, customerUserId: payer?.id ?? null, customerCountry: payer?.country ?? null, expiresInMinutes: 15, ...extra });
  return intentView(row);
}
export { setIntentAmount };
