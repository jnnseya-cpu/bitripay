/**
 * Webhook engine (CMP-11 Notification Service).
 *
 * Every business event is written to `webhook_events` after the database commit that produced it, then fanned out to
 * the merchant's endpoints: the endpoint objects registered through the API (`webhook_endpoints`, each with its own
 * secret and event subscriptions) and, for backwards compatibility, the single URL configured on the account
 * (`users.webhook_url`). Deliveries are persisted with their next attempt time so retries survive restarts; the
 * schedule is 10s, 30s, 2m, 10m, 30m then every 2h for 24h with jitter (configurable). After the schedule is
 * exhausted the delivery is dead-lettered and the merchant notified; the payment itself is never changed by a
 * webhook outcome. Deliveries are at-least-once: receivers deduplicate on the event id and ignore older
 * `state_version`s.
 *
 * Signatures (both headers are always sent):
 *   BitriPay-Signature: t=<unix seconds>,v1=<hex hmac-sha256(secret, `${t}.${rawBody}`)>   (X-BitriPay-Signature: legacy alias)
 *   BitriPay-Signature-Ed25519: keyId=<platform key>,t=<unix>,sig=<base64 ed25519 over `${t}\n${deliveryId}\n${url}\n${sha256(body)}`>
 * The asymmetric signature covers body, date, delivery id and destination; the public key is published in the key
 * registry (`GET /v1/keys`, scope PLATFORM) and rotated with an overlap. Receivers reject timestamps older than
 * 5 minutes and remember delivery ids they have processed.
 *
 * Destinations are checked against SSRF before every connection: https only, no private, loopback, link-local or
 * reserved addresses (resolved at connection time), no redirects followed, bounded time and response size.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getDb } from '../db';
import { uuid, now, secretToken, shortCode } from '../lib/ids';
import { hmacSha256, safeEqual, sha256, encrypt, decrypt } from '../lib/crypto';
import { badRequest, notFound, conflict } from '../lib/errors';
import { findUserById, updateUser, type UserRow } from './users';
import { config } from '../config';
import { getWebhookSettings } from './settings';
import { notify } from './notifications';
import { platformSigningKey, signWithKey, verifyWithKey } from './keys';
import { parseJson } from '../lib/json';
import { subscribe, type SettlementEventPayload } from './bus';

export const WEBHOOK_API_VERSION = '2026-09-01';
export const WEBHOOK_SCHEMA_VERSION = 1;

/** Developer-portal wording that ships with the catalogue endpoint: the rules every receiver must build on. */
export const WEBHOOK_CATALOGUE_NOTES: readonly string[] = [
  'Deliveries are at-least-once: dedupe by event id.',
  'A successful screen is not proof of payment; only a ledger posting is.',
  "We surface reality; we don't hide it: AMBIGUOUS means we do not know yet.",
  'Verified holds are applied per risk appetite before funds become available.',
];

/** Event catalogue (published on the developer portal and `GET /v1/webhook_events/types`). */
export const WEBHOOK_EVENT_TYPES: { type: string; description: string }[] = [
  { type: 'payout_batch.created', description: 'A bulk payout batch was uploaded and validated; it waits for approval.' },
  { type: 'subscription.created', description: 'A customer subscribed to one of your plans (mandate confirmed).' },
  { type: 'subscription.cancelled', description: 'A subscription was cancelled by the customer, by you, or after dunning.' },
  { type: 'invoice.paid', description: 'A subscription invoice was collected from the customer wallet.' },
  { type: 'invoice.payment_failed', description: 'A collection attempt failed; dunning retries follow (1, 3, 7 days).' },
  { type: 'payout_batch.executed', description: 'A bulk payout batch ran: paid, partial or failed, with per-row outcomes on the batch.' },
  { type: 'payment_intent.created', description: 'An intent was created (API, QR, link, checkout session or USSD).' },
  { type: 'payment_intent.requires_action', description: 'The payer must authorise the payment (PIN, prompt, redirect).' },
  { type: 'payment_intent.processing', description: 'An attempt is in flight on a rail. Do not create a second payment.' },
  {
    type: 'payment_intent.authorised',
    description: 'The payer authorised the payment and the funds are held (capture_method manual). Capture it with POST /payment_intents/{id}/capture, or cancel to void.',
  },
  { type: 'payment_intent.succeeded', description: 'Captured and posted to the ledger. Ship the goods.' },
  { type: 'payment_intent.settled', description: 'Funds settled to the merchant balance.' },
  { type: 'payment_intent.failed', description: 'The intent ended without a capture (declined, expired, cancelled).' },
  { type: 'payment_intent.cancelled', description: 'The merchant cancelled the intent before capture.' },
  { type: 'payment_intent.expired', description: 'The intent expired without capture.' },
  { type: 'payment_intent.ambiguous_hold', description: 'The provider could not say whether money moved. Funds are in suspense; a human or reconciliation resolves it. Do not retry.' },
  { type: 'payment_intent.disputed', description: 'A dispute or chargeback was opened on the payment.' },
  { type: 'dispute.opened', description: 'A dispute object was created on one of your payments (same moment as payment_intent.disputed; carries the dispute).' },
  { type: 'refund.created', description: 'A refund object was created.' },
  {
    type: 'refund.updated',
    description:
      'A refund moved state. `status` is the stored value (REQUESTED, PENDING, MANUAL, SUCCEEDED, FAILED, REJECTED); `lifecycle` maps it to REQUESTED → APPROVED → PROCESSING → SUCCEEDED | FAILED | REJECTED, plus REVERSED.',
  },
  { type: 'refund.succeeded', description: 'The refund was executed and posted.' },
  { type: 'refund.failed', description: 'The refund could not be executed.' },
  { type: 'checkout.session.completed', description: 'A hosted checkout session was paid.' },
  { type: 'checkout.session.expired', description: 'A hosted checkout session expired unpaid.' },
  { type: 'verification.completed', description: 'A Scan-to-Verify (KODA) request produced a result.' },
  { type: 'verification.confirmed', description: 'A Scan-to-Verify (KODA) request found the payment settled on the ledger (VERIFIED). Sent next to verification.completed.' },
  { type: 'payout.created', description: 'A payout request was accepted.' },
  { type: 'payout.processing', description: 'The payout was handed to the payout network (queued to a prefunded account or agent) and is being executed.' },
  { type: 'payout.completed', description: 'A payout was paid out.' },
  { type: 'payout.succeeded', description: 'The payout was paid out (same moment as payout.completed).' },
  { type: 'payout.settled', description: 'The payout left the platform ledger for good: the withdrawal posted to the treasury and the funds are with the recipient rail.' },
  { type: 'payout.failed', description: 'A payout was rejected or failed.' },
  { type: 'settlement.created', description: 'A settlement cycle was closed: the collections of the period were netted (gross, fees, refunds, splits, holds) and the statement is available.' },
  { type: 'settlement.completed', description: 'A settlement cycle was paid to its destination (or kept available in the wallet for wallet settlement).' },
  { type: 'payment.completed', description: 'Legacy event: a payment request was paid (kept for existing integrations).' },
  { type: 'payment_request.created', description: 'Legacy event: an API or link payment request was created.' },
  { type: 'reconciliation.exception', description: 'Reconciliation found a discrepancy involving one of your payments.' },
  { type: 'payment.created', description: 'National switch payment created (durable intent received).' },
  { type: 'payment.action_required', description: 'National switch payment needs payer consent or authentication before it can be sent.' },
  { type: 'payment.pending', description: 'National switch payment transmitted or technically acknowledged; confirmation in progress.' },
  { type: 'payment.unknown', description: 'National switch payment outcome uncertain after transmission: do not repeat the payment; an inquiry is running.' },
  { type: 'payment.rejected', description: 'National switch payment definitively rejected.' },
  { type: 'payment.cancelled', description: 'National switch payment cancelled locally before any transmission.' },
  { type: 'payment.expired', description: 'National switch payment expired before any possible transmission.' },
  { type: 'ping', description: 'Test event sent from the dashboard or the API.' },
];
const KNOWN_TYPES = new Set(WEBHOOK_EVENT_TYPES.map((e) => e.type));

export interface WebhookEndpointView {
  id: string;
  url: string;
  events: string[];
  description: string | null;
  apiVersion: string;
  active: boolean;
  failures: number;
  disabledReason: string | null;
  createdAt: string;
  updatedAt: string;
}
const toEndpoint = (r: any): WebhookEndpointView => ({
  id: r.id,
  url: r.url,
  events: parseJson<string[]>(r.events, ['*']),
  description: r.description,
  apiVersion: r.api_version,
  active: !!r.active,
  failures: r.failures,
  disabledReason: r.disabled_reason,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface WebhookDeliveryView {
  id: string;
  endpointId: string | null;
  eventId: string | null;
  event: string;
  url: string;
  statusCode: number | null;
  success: boolean;
  dead: boolean;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  responseBody: string | null;
  replayOf: string | null;
  createdAt: string;
  updatedAt: string;
}
const toDelivery = (r: any): WebhookDeliveryView => ({
  id: r.id,
  endpointId: r.endpoint_id ?? null,
  eventId: r.event_id ?? null,
  event: r.event,
  url: r.url,
  statusCode: r.status_code,
  success: !!r.success,
  dead: !!r.dead,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at ?? null,
  lastError: r.last_error,
  responseBody: r.response_body ?? null,
  replayOf: r.replay_of ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// ---------------------------------------------------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------------------------------------------------
export function signWebhookPayload(secret: string, payload: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${hmacSha256(secret, `${timestamp}.${payload}`)}`;
}

/** Verify a signature produced by signWebhookPayload (used by tests and the SDK docs). */
export function verifyWebhookSignature(secret: string, payload: string, header: string, toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  return safeEqual(parts.v1, hmacSha256(secret, `${t}.${payload}`));
}

/** Canonical string covered by the asymmetric signature: timestamp, delivery id, destination and body digest. */
export function ed25519SigningString(timestamp: number, deliveryId: string, url: string, body: string): string {
  return `${timestamp}\n${deliveryId}\n${url}\n${sha256(body)}`;
}

export function signWebhookEd25519(deliveryId: string, url: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const key = platformSigningKey();
  const sig = Buffer.from(signWithKey(key.keyId, ed25519SigningString(timestamp, deliveryId, url, body))).toString('base64');
  return `keyId=${key.keyId},t=${timestamp},sig=${sig}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Destination safety (SSRF)
// ---------------------------------------------------------------------------------------------------------------------
function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80')) return true;
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return false;
}

/** Validate a webhook destination at registration and again before every connection. */
export async function assertSafeDestination(url: string): Promise<void> {
  // The platform's own webhook inbox is always a valid destination (it may be served on http:// or a private address in development).
  if (url.startsWith(`${config.apiUrl}/api/v1/webhook_inbox/`)) return;
  const settings = getWebhookSettings();
  const insecureOk = (settings.allowInsecureTargets || config.isTest) && !config.isProduction;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw badRequest('Webhook URL is not a valid URL', 'invalid_webhook_url');
  }
  if (u.protocol !== 'https:' && !(insecureOk && u.protocol === 'http:')) throw badRequest('Webhook URL must use https://', 'invalid_webhook_url');
  if (u.username || u.password) throw badRequest('Webhook URL must not embed credentials', 'invalid_webhook_url');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    if (!insecureOk) throw badRequest('Webhook URL must point to a public host', 'invalid_webhook_url');
    return;
  }
  const addresses = isIP(host)
    ? [host]
    : await lookup(host, { all: true })
        .then((r) => r.map((a) => a.address))
        .catch(() => [] as string[]);
  if (!addresses.length) throw badRequest('Webhook host does not resolve', 'invalid_webhook_url');
  if (!insecureOk && addresses.some(isPrivateIp)) throw badRequest('Webhook URL must not point to a private or reserved address', 'invalid_webhook_url');
}

// ---------------------------------------------------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------------------------------------------------
function validateEvents(events: string[] | undefined): string[] {
  const list = (events?.length ? events : ['*']).map((e) => e.trim()).filter(Boolean);
  for (const e of list)
    if (e !== '*' && !KNOWN_TYPES.has(e) && !(e.endsWith('.*') && [...KNOWN_TYPES].some((t) => t.startsWith(e.slice(0, -1))))) throw badRequest(`Unknown event type "${e}"`, 'unknown_event_type');
  return [...new Set(list)];
}

export async function createEndpoint(
  userId: string,
  input: { url: string; events?: string[]; description?: string | null; apiVersion?: string | null },
): Promise<WebhookEndpointView & { secret: string }> {
  await assertSafeDestination(input.url);
  const count = (getDb().prepare('SELECT COUNT(*) c FROM webhook_endpoints WHERE user_id = ?').get(userId) as any).c;
  if (count >= 16) throw conflict('You can register at most 16 webhook endpoints', 'endpoint_limit');
  const id = `we_${shortCode(16).toLowerCase()}`;
  const secret = `whsec_${secretToken(24)}`;
  getDb()
    .prepare('INSERT INTO webhook_endpoints (id, user_id, url, secret_enc, events, description, api_version, active, failures, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)')
    .run(id, userId, input.url, encrypt(secret), JSON.stringify(validateEvents(input.events)), input.description ?? null, input.apiVersion ?? WEBHOOK_API_VERSION, now(), now());
  return { ...getEndpoint(userId, id), secret };
}

export function getEndpoint(userId: string, id: string): WebhookEndpointView {
  const r = getDb().prepare('SELECT * FROM webhook_endpoints WHERE id = ? AND user_id = ?').get(id, userId);
  if (!r) throw notFound('Webhook endpoint not found', 'endpoint_not_found');
  return toEndpoint(r);
}

export function listEndpoints(userId: string): WebhookEndpointView[] {
  return (getDb().prepare('SELECT * FROM webhook_endpoints WHERE user_id = ? ORDER BY created_at DESC').all(userId) as any[]).map(toEndpoint);
}

export async function updateEndpoint(userId: string, id: string, patch: { url?: string; events?: string[]; description?: string | null; active?: boolean }): Promise<WebhookEndpointView> {
  const cur = getEndpoint(userId, id);
  if (patch.url && patch.url !== cur.url) await assertSafeDestination(patch.url);
  const events = patch.events ? validateEvents(patch.events) : cur.events;
  const active = patch.active ?? cur.active;
  getDb()
    .prepare(
      'UPDATE webhook_endpoints SET url = ?, events = ?, description = ?, active = ?, failures = CASE WHEN ? = 1 THEN 0 ELSE failures END, disabled_reason = CASE WHEN ? = 1 THEN NULL ELSE disabled_reason END, updated_at = ? WHERE id = ?',
    )
    .run(
      patch.url ?? cur.url,
      JSON.stringify(events),
      patch.description === undefined ? cur.description : patch.description,
      active ? 1 : 0,
      active && !cur.active ? 1 : 0,
      active && !cur.active ? 1 : 0,
      now(),
      id,
    );
  return getEndpoint(userId, id);
}

export function deleteEndpoint(userId: string, id: string): void {
  const res = getDb().prepare('DELETE FROM webhook_endpoints WHERE id = ? AND user_id = ?').run(id, userId);
  if (!res.changes) throw notFound('Webhook endpoint not found', 'endpoint_not_found');
}

export function rotateEndpointSecret(userId: string, id: string): { secret: string } {
  getEndpoint(userId, id);
  const secret = `whsec_${secretToken(24)}`;
  getDb().prepare('UPDATE webhook_endpoints SET secret_enc = ?, updated_at = ? WHERE id = ?').run(encrypt(secret), now(), id);
  return { secret };
}

function endpointSecret(endpointId: string): string | null {
  const r = getDb().prepare('SELECT secret_enc FROM webhook_endpoints WHERE id = ?').get(endpointId) as any;
  return r ? decrypt(r.secret_enc) : null;
}

function subscribed(events: string[], type: string): boolean {
  return events.some((e) => e === '*' || e === type || (e.endsWith('.*') && type.startsWith(e.slice(0, -1))));
}

// ---------------------------------------------------------------------------------------------------------------------
// Events and fan-out
// ---------------------------------------------------------------------------------------------------------------------
export interface EmitOptions {
  /** Resource the event is about (used for filtering and replay). */
  resource?: { type: string; id: string } | null;
  /** Monotonic version of the resource projection so receivers can ignore stale deliveries. */
  stateVersion?: number | null;
  occurredAt?: string | null;
  /** Deliver to this endpoint only (test pings). */
  endpointId?: string | null;
  /** The connected account the event is about, when a platform receives it (`acct_…`). */
  account?: string | null;
  /** Internal: already fanned out to the platform. */
  forwarded?: boolean;
}

/**
 * Record an event and queue one delivery per subscribed endpoint. Called after the producing transaction committed.
 * Returns the event id (null only when the user does not exist).
 */
export function emitEvent(userId: string, type: string, data: Record<string, unknown>, opts: EmitOptions = {}): string | null {
  const db = getDb();
  const user = findUserById(userId);
  if (!user) return null;
  const endpoints = (db.prepare('SELECT * FROM webhook_endpoints WHERE user_id = ? AND active = 1').all(userId) as any[]).filter((e) =>
    opts.endpointId ? e.id === opts.endpointId : subscribed(parseJson<string[]>(e.events, ['*']), type),
  );
  const legacy = !opts.endpointId && user.webhook_url && user.webhook_secret ? { id: null as string | null, url: user.webhook_url } : null;
  // the event is always recorded after the durable commit (it is the merchant's event log); deliveries only exist for destinations
  const id = `evt_${shortCode(20).toLowerCase()}`;
  const ts = now();
  const envelope = {
    id,
    object: 'event',
    type,
    event: type, // legacy alias
    api_version: WEBHOOK_API_VERSION,
    schema_version: WEBHOOK_SCHEMA_VERSION,
    created: Math.floor(Date.parse(ts) / 1000),
    createdAt: ts,
    occurred_at: opts.occurredAt ?? ts,
    emitted_at: ts,
    resource: opts.resource ?? null,
    state_version: opts.stateVersion ?? null,
    account: opts.account ?? null,
    livemode: config.isProduction,
    data,
  };
  const payload = JSON.stringify(envelope);
  db.prepare('INSERT INTO webhook_events (id, user_id, type, api_version, resource_type, resource_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    userId,
    type,
    WEBHOOK_API_VERSION,
    opts.resource?.type ?? null,
    opts.resource?.id ?? null,
    payload,
    ts,
  );
  const targets = [...endpoints.map((e) => ({ id: e.id as string, url: e.url as string })), ...(legacy ? [legacy] : [])];
  const ids: string[] = [];
  for (const t of targets) {
    const did = uuid();
    db.prepare(
      'INSERT INTO webhook_deliveries (id, user_id, event, payload, url, status_code, success, attempts, created_at, updated_at, endpoint_id, event_id, next_attempt_at, dead) VALUES (?, ?, ?, ?, ?, NULL, 0, 0, ?, ?, ?, ?, ?, 0)',
    ).run(did, userId, type, payload, t.url, ts, ts, t.id, id, ts);
    ids.push(did);
  }
  if (!config.isTest) for (const did of ids) void attemptDelivery(did);
  // Aggregator model: every event of a connected account is also the platform's, carrying the account id.
  if (!opts.forwarded && !opts.endpointId) {
    const link = db.prepare("SELECT id, platform_user_id FROM connected_accounts WHERE user_id = ? AND status = 'active'").get(userId) as { id: string; platform_user_id: string } | undefined;
    if (link) emitEvent(link.platform_user_id, type, { ...data, account: link.id }, { ...opts, account: link.id, forwarded: true });
  }
  return id;
}

/** Legacy entry point used across the services; now routes through the event engine. */
export async function dispatchWebhook(userId: string, event: string, data: Record<string, unknown>, opts: EmitOptions = {}) {
  emitEvent(userId, event, data, opts);
}

/** The developer catalogue: version, schema, the receiver rules and every event with its description. */
export function webhookCatalogue() {
  return { api_version: WEBHOOK_API_VERSION, schema_version: WEBHOOK_SCHEMA_VERSION, notes: [...WEBHOOK_CATALOGUE_NOTES], data: WEBHOOK_EVENT_TYPES };
}

/**
 * Settlement cycle events: `created` when a cycle is closed, `completed` when it is paid. The finops settlement
 * service calls this at both moments; the closing moment is also covered by the `settlement.cycle_closed` domain
 * event below, so `settlement.created` is delivered even when only the bus is wired.
 */
export function emitSettlementEvent(userId: string, phase: 'created' | 'completed', cycle: { id: string; [key: string]: unknown }): string | null {
  const type = phase === 'created' ? 'settlement.created' : 'settlement.completed';
  const ts = now();
  const recent = getDb()
    .prepare('SELECT id FROM webhook_events WHERE user_id = ? AND type = ? AND resource_id = ? AND created_at >= ? LIMIT 1')
    .get(userId, type, cycle.id, new Date(Date.now() - 60_000).toISOString());
  if (recent) return null; // the bus subscription and a direct call within the same minute describe one moment
  return emitEvent(userId, type, { settlementCycle: cycle, cycleId: cycle.id, phase }, { resource: { type: 'settlement_cycle', id: cycle.id }, occurredAt: ts });
}

// Domain-bus companions: the settlement and dispute modules publish their moments on the bus; the merchant-facing
// events are derived here so the catalogue is complete without those modules calling the engine directly.
// `settlement.cycle_closed` / `settlement.closed` are the closing moment (finops/settlement.ts publishes both with the
// same cycle), `settlement.paid` is the payout of the cycle; the payload names the merchant as `merchantId` or `userId`.
subscribe('webhooks.settlement', ['settlement.cycle_closed', 'settlement.closed', 'settlement.paid'], (ev) => {
  const payload = ev.payload as Partial<SettlementEventPayload> & { merchantId?: string };
  const merchantId = payload.merchantId ?? payload.userId ?? (ev.tenantId !== 'platform' ? ev.tenantId : null);
  const cycleId = payload.cycleId ?? ev.aggregateId;
  if (!merchantId || !cycleId) return;
  emitSettlementEvent(merchantId, ev.type === 'settlement.paid' ? 'completed' : 'created', { ...ev.payload, id: cycleId });
});
subscribe('webhooks.dispute', ['dispute.opened'], (ev) => {
  const merchantId = (ev.payload.merchantId as string | undefined) ?? (ev.tenantId !== 'platform' ? ev.tenantId : null);
  const disputeId = (ev.payload.disputeId as string | undefined) ?? ev.aggregateId;
  if (!merchantId || !disputeId) return;
  // the dispute module emitted payment_intent.disputed with the full dispute object a moment ago: reuse that projection
  const twin = getDb()
    .prepare("SELECT data FROM webhook_events WHERE user_id = ? AND type = 'payment_intent.disputed' AND resource_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(merchantId, disputeId) as { data: string } | undefined;
  const dispute = twin ? (envelopeData(twin.data).dispute ?? null) : null;
  emitEvent(merchantId, 'dispute.opened', { dispute: dispute ?? { id: disputeId, ...ev.payload }, disputeId }, { resource: { type: 'dispute', id: disputeId }, occurredAt: ev.occurredAt });
});

function delayFor(attempt: number): number | null {
  const s = getWebhookSettings();
  const base = s.retryScheduleSeconds[attempt - 1];
  if (base == null) return null;
  const jitter = 1 + ((Math.random() * 2 - 1) * s.jitterPct) / 100;
  return Math.round(base * 1000 * jitter);
}

/** One delivery attempt; schedules the next one or dead-letters the delivery. Safe to call concurrently for different ids. */
export async function attemptDelivery(deliveryId: string): Promise<WebhookDeliveryView | null> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(deliveryId) as any;
  if (!row || row.success || row.dead) return row ? toDelivery(row) : null;
  const settings = getWebhookSettings();
  const secret = row.endpoint_id ? endpointSecret(row.endpoint_id) : (findUserById(row.user_id)?.webhook_secret ?? null);
  if (!secret) {
    db.prepare("UPDATE webhook_deliveries SET dead = 1, last_error = 'destination removed', next_attempt_at = NULL, updated_at = ? WHERE id = ?").run(now(), deliveryId);
    return toDelivery(db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(deliveryId));
  }
  const ts = Math.floor(Date.now() / 1000);
  const signature = signWebhookPayload(secret, row.payload, ts);
  let statusCode: number | null = null;
  let success = 0;
  let lastError: string | null = null;
  let responseBody: string | null = null;
  try {
    await assertSafeDestination(row.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    const res = await fetch(row.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'BitriPay-Signature': signature,
        'X-BitriPay-Signature': signature,
        'BitriPay-Signature-Ed25519': signWebhookEd25519(row.id, row.url, row.payload, ts),
        'BitriPay-Event': row.event,
        'X-BitriPay-Event': row.event,
        'BitriPay-Event-Id': row.event_id ?? '',
        'BitriPay-Delivery-Id': row.id,
        'X-BitriPay-Delivery-Id': row.id,
        'BitriPay-Attempt': String(row.attempts + 1),
        'User-Agent': 'BitriPay-Webhooks/2.0',
      },
      body: row.payload,
      signal: controller.signal,
    });
    clearTimeout(timer);
    statusCode = res.status;
    success = res.status >= 200 && res.status < 300 ? 1 : 0;
    if (!success) lastError = res.status >= 300 && res.status < 400 ? `HTTP ${res.status} redirect not followed` : `HTTP ${res.status}`;
    try {
      const text = await res.text();
      responseBody = text.slice(0, settings.responseBodyBytes) || null;
    } catch {
      responseBody = null;
    }
  } catch (err) {
    lastError = (err as Error).name === 'AbortError' ? `timeout after ${settings.timeoutMs}ms` : (err as Error).message;
  }
  const attempts = row.attempts + 1;
  const nextDelay = success ? null : delayFor(attempts);
  const dead = !success && nextDelay == null ? 1 : 0;
  const nextAt = nextDelay != null ? new Date(Date.now() + nextDelay).toISOString() : null;
  db.prepare('UPDATE webhook_deliveries SET status_code = ?, success = ?, attempts = ?, last_error = ?, response_body = ?, next_attempt_at = ?, dead = ?, updated_at = ? WHERE id = ?').run(
    statusCode,
    success,
    attempts,
    lastError,
    responseBody,
    nextAt,
    dead,
    now(),
    deliveryId,
  );
  if (row.endpoint_id) {
    if (success) db.prepare('UPDATE webhook_endpoints SET failures = 0, updated_at = ? WHERE id = ?').run(now(), row.endpoint_id);
    else {
      const ep = db.prepare('UPDATE webhook_endpoints SET failures = failures + 1, updated_at = ? WHERE id = ? RETURNING failures, active').get(now(), row.endpoint_id) as any;
      if (ep && ep.active && ep.failures >= settings.disableAfterConsecutiveFailures) {
        db.prepare('UPDATE webhook_endpoints SET active = 0, disabled_reason = ?, updated_at = ? WHERE id = ?').run(
          `disabled after ${ep.failures} consecutive failed deliveries`,
          now(),
          row.endpoint_id,
        );
        notify(
          row.user_id,
          'Webhook endpoint disabled',
          `${row.url} failed ${ep.failures} deliveries in a row and was disabled. Fix the endpoint, re-enable it and replay missed events from the developer console.`,
          { kind: 'webhook', endpointId: row.endpoint_id },
        );
      }
    }
  }
  if (dead)
    notify(
      row.user_id,
      'Webhook delivery failed',
      `Event ${row.event} could not be delivered to ${row.url} after ${attempts} attempts. Replay it from the developer console once the endpoint is fixed.`,
      { kind: 'webhook', deliveryId },
    );
  if (!success && !dead && !config.isTest) setTimeout(() => void attemptDelivery(deliveryId), nextDelay!).unref();
  return toDelivery(db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(deliveryId));
}

/** Scheduler entry point: deliveries whose retry time has passed (covers restarts, where in-memory timers are lost). */
export async function processDueDeliveries(limit = 50): Promise<number> {
  const rows = getDb()
    .prepare('SELECT id FROM webhook_deliveries WHERE success = 0 AND dead = 0 AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?')
    .all(now(), limit) as { id: string }[];
  let n = 0;
  for (const chunk of [...Array(Math.ceil(rows.length / 5)).keys()].map((i) => rows.slice(i * 5, i * 5 + 5))) {
    await Promise.all(chunk.map((r) => attemptDelivery(r.id).then(() => (n += 1))));
  }
  return n;
}

/** Re-send a delivery (keeps the event id; new delivery id and transport proof). */
export function replayDelivery(userId: string, deliveryId: string): WebhookDeliveryView {
  const db = getDb();
  const row = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ? AND user_id = ?').get(deliveryId, userId) as any;
  if (!row) throw notFound('Delivery not found', 'delivery_not_found');
  const id = uuid();
  db.prepare(
    'INSERT INTO webhook_deliveries (id, user_id, event, payload, url, status_code, success, attempts, created_at, updated_at, endpoint_id, event_id, next_attempt_at, dead, replay_of) VALUES (?, ?, ?, ?, ?, NULL, 0, 0, ?, ?, ?, ?, ?, 0, ?)',
  ).run(id, userId, row.event, row.payload, row.url, now(), now(), row.endpoint_id, row.event_id, now(), row.id);
  if (!config.isTest) void attemptDelivery(id);
  return toDelivery(db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id));
}

/** Re-send an event to every subscribed endpoint (or one endpoint). */
export function replayEvent(userId: string, eventId: string, endpointId?: string | null): WebhookDeliveryView[] {
  const db = getDb();
  const ev = db.prepare('SELECT * FROM webhook_events WHERE id = ? AND user_id = ?').get(eventId, userId) as any;
  if (!ev) throw notFound('Event not found', 'event_not_found');
  const endpoints = (db.prepare('SELECT * FROM webhook_endpoints WHERE user_id = ? AND active = 1').all(userId) as any[]).filter((e) =>
    endpointId ? e.id === endpointId : subscribed(parseJson<string[]>(e.events, ['*']), ev.type),
  );
  const out: WebhookDeliveryView[] = [];
  for (const e of endpoints) {
    const id = uuid();
    db.prepare(
      'INSERT INTO webhook_deliveries (id, user_id, event, payload, url, status_code, success, attempts, created_at, updated_at, endpoint_id, event_id, next_attempt_at, dead) VALUES (?, ?, ?, ?, ?, NULL, 0, 0, ?, ?, ?, ?, ?, 0)',
    ).run(id, userId, ev.type, ev.data, e.url, now(), now(), e.id, ev.id, now());
    if (!config.isTest) void attemptDelivery(id);
    out.push(toDelivery(db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id)));
  }
  return out;
}

export function pingEndpoint(userId: string, endpointId: string): { eventId: string | null } {
  getEndpoint(userId, endpointId);
  return { eventId: emitEvent(userId, 'ping', { message: 'BitriPay webhook test', endpointId }, { endpointId }) };
}

/** The stored row holds the full signed envelope; API consumers get the `data` object exactly as it was delivered. */
function envelopeData(raw: string): Record<string, unknown> {
  const env = parseJson<Record<string, unknown>>(raw, {});
  return (env.data as Record<string, unknown>) ?? env;
}

export function listEvents(userId: string, filter: { type?: string | null; resourceId?: string | null; limit?: number; before?: string | null } = {}) {
  const where = ['user_id = ?'];
  const params: unknown[] = [userId];
  if (filter.type) {
    where.push('type = ?');
    params.push(filter.type);
  }
  if (filter.resourceId) {
    where.push('resource_id = ?');
    params.push(filter.resourceId);
  }
  if (filter.before) {
    where.push('created_at < ?');
    params.push(filter.before);
  }
  const rows = getDb()
    .prepare(`SELECT * FROM webhook_events WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, Math.min(200, filter.limit ?? 50)) as any[];
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    apiVersion: r.api_version,
    resource: r.resource_type ? { type: r.resource_type, id: r.resource_id } : null,
    data: envelopeData(r.data),
    createdAt: r.created_at,
  }));
}

export function getEvent(userId: string, id: string) {
  const r = getDb().prepare('SELECT * FROM webhook_events WHERE id = ? AND user_id = ?').get(id, userId) as any;
  if (!r) throw notFound('Event not found', 'event_not_found');
  return {
    id: r.id,
    type: r.type,
    apiVersion: r.api_version,
    resource: r.resource_type ? { type: r.resource_type, id: r.resource_id } : null,
    data: envelopeData(r.data),
    createdAt: r.created_at,
    deliveries: listDeliveries(userId, { eventId: r.id }),
  };
}

export function listDeliveries(
  userId: string,
  filter: { endpointId?: string | null; eventId?: string | null; status?: 'pending' | 'succeeded' | 'failed' | 'dead' | null; limit?: number } = {},
): WebhookDeliveryView[] {
  const where = ['user_id = ?'];
  const params: unknown[] = [userId];
  if (filter.endpointId) {
    where.push('endpoint_id = ?');
    params.push(filter.endpointId);
  }
  if (filter.eventId) {
    where.push('event_id = ?');
    params.push(filter.eventId);
  }
  if (filter.status === 'succeeded') where.push('success = 1');
  else if (filter.status === 'dead') where.push('dead = 1');
  else if (filter.status === 'failed') where.push('success = 0 AND attempts > 0');
  else if (filter.status === 'pending') where.push('success = 0 AND dead = 0');
  return (
    getDb()
      .prepare(`SELECT * FROM webhook_deliveries WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, Math.min(200, filter.limit ?? 50)) as any[]
  ).map(toDelivery);
}

export function deliveryStats(userId: string, hours = 24) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const r = getDb()
    .prepare(
      'SELECT COUNT(*) total, SUM(success) succeeded, SUM(dead) dead, SUM(CASE WHEN success = 0 AND dead = 0 THEN 1 ELSE 0 END) pending FROM webhook_deliveries WHERE user_id = ? AND created_at >= ?',
    )
    .get(userId, since) as any;
  return { hours, total: r.total ?? 0, succeeded: r.succeeded ?? 0, dead: r.dead ?? 0, pending: r.pending ?? 0 };
}

// ---------------------------------------------------------------------------------------------------------------------
// Webhook inbox: a built-in receiver. A merchant points an endpoint at its inbox URL and sees every real delivery with
// its headers and the result of both signature checks, without any external receiver site. Nothing is executed on
// receipt; the inbox only records. One inbox per account, created on first use.
// ---------------------------------------------------------------------------------------------------------------------
const INBOX_KEEP = 200;
export function inboxIdFor(user: UserRow & { webhook_inbox_id?: string | null }): string {
  if (user.webhook_inbox_id) return user.webhook_inbox_id;
  const id = `wi_${secretToken(18)}`;
  updateUser(user.id, { webhook_inbox_id: id } as any);
  return id;
}
export const inboxUrl = (inboxId: string) => `${config.apiUrl}/api/v1/webhook_inbox/${inboxId}`;
const inboxPath = (inboxId: string) => `/webhook_inbox/${inboxId}`;

export interface InboxMessageView {
  id: string;
  endpointId: string | null;
  deliveryId: string | null;
  eventType: string | null;
  headers: Record<string, string>;
  body: string;
  hmacValid: boolean | null;
  ed25519Valid: boolean | null;
  receivedAt: string;
}
const toInboxMessage = (r: any): InboxMessageView => ({
  id: r.id,
  endpointId: r.endpoint_id,
  deliveryId: r.delivery_id,
  eventType: r.event_type,
  headers: parseJson(r.headers, {}),
  body: r.body,
  hmacValid: r.hmac_valid === null ? null : !!r.hmac_valid,
  ed25519Valid: r.ed25519_valid === null ? null : !!r.ed25519_valid,
  receivedAt: r.received_at,
});

/** Record one delivery that reached the inbox; both signatures are checked against the merchant's own endpoint secret and the platform key. */
export function receiveInboxMessage(inboxId: string, rawHeaders: Record<string, unknown>, body: string): InboxMessageView {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE webhook_inbox_id = ?').get(inboxId) as UserRow | undefined;
  if (!user) throw notFound('Webhook inbox not found', 'inbox_not_found');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    const key = k.toLowerCase();
    if (key.startsWith('bitripay-') || key.startsWith('x-bitripay-') || ['content-type', 'user-agent', 'content-length'].includes(key))
      headers[key] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  }
  const endpoint = (db.prepare('SELECT * FROM webhook_endpoints WHERE user_id = ? ORDER BY created_at DESC').all(user.id) as any[]).find((e) => String(e.url).endsWith(inboxPath(inboxId)));
  const sig = headers['bitripay-signature'] ?? headers['x-bitripay-signature'] ?? null;
  const ed = headers['bitripay-signature-ed25519'] ?? null;
  const deliveryId = headers['bitripay-delivery-id'] ?? headers['x-bitripay-delivery-id'] ?? null;
  let hmacValid: boolean | null = null;
  if (sig && endpoint) hmacValid = verifyWebhookSignature(decrypt(endpoint.secret_enc), body, sig);
  else if (sig) hmacValid = false;
  let ed25519Valid: boolean | null = null;
  if (ed) {
    const parts = Object.fromEntries(ed.split(',').map((kv) => kv.split('=') as [string, string]));
    const t = Number(parts.t);
    try {
      ed25519Valid =
        !!parts.keyId &&
        !!t &&
        !!parts.sig &&
        !!deliveryId &&
        verifyWithKey(parts.keyId, ed25519SigningString(t, deliveryId, endpoint?.url ?? inboxUrl(inboxId), body), Buffer.from(parts.sig, 'base64'));
    } catch {
      ed25519Valid = false;
    }
  }
  let eventType: string | null = headers['bitripay-event'] ?? headers['x-bitripay-event'] ?? null;
  if (!eventType) {
    const parsed = parseJson<any>(body, null);
    eventType = parsed && typeof parsed.type === 'string' ? parsed.type : null;
  }
  const id = `wim_${shortCode(14).toLowerCase()}`;
  db.prepare('INSERT INTO webhook_inbox_messages (id, user_id, endpoint_id, delivery_id, event_type, headers, body, hmac_valid, ed25519_valid, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    user.id,
    endpoint?.id ?? null,
    deliveryId,
    eventType,
    JSON.stringify(headers),
    body.slice(0, 64_000),
    hmacValid === null ? null : hmacValid ? 1 : 0,
    ed25519Valid === null ? null : ed25519Valid ? 1 : 0,
    now(),
  );
  db.prepare(`DELETE FROM webhook_inbox_messages WHERE user_id = ? AND id NOT IN (SELECT id FROM webhook_inbox_messages WHERE user_id = ? ORDER BY received_at DESC LIMIT ${INBOX_KEEP})`).run(
    user.id,
    user.id,
  );
  return toInboxMessage(db.prepare('SELECT * FROM webhook_inbox_messages WHERE id = ?').get(id));
}
export function listInboxMessages(userId: string, limit = 50): InboxMessageView[] {
  return (getDb().prepare('SELECT * FROM webhook_inbox_messages WHERE user_id = ? ORDER BY received_at DESC LIMIT ?').all(userId, limit) as any[]).map(toInboxMessage);
}
export function clearInbox(userId: string): number {
  return Number(getDb().prepare('DELETE FROM webhook_inbox_messages WHERE user_id = ?').run(userId).changes);
}
