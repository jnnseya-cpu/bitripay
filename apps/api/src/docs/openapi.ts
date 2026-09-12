/**
 * OpenAPI 3.1 description of the BitriPay Gateway API (v1). Built from one table of operations so the document,
 * the developer portal and the SDKs describe the same surface. Served at /api/v1/openapi.json and /v1/openapi.json.
 */
import { config } from '../config';
import { API_KEY_SCOPES } from '../services/merchant';
import { WEBHOOK_EVENT_TYPES } from '../services/webhooks';
import { BP_CODES } from '../lib/bpCodes';
import { PURPOSE_CODES } from '../services/capabilities';

type Op = { method: 'get' | 'post' | 'patch' | 'delete'; path: string; tag: string; summary: string; scope?: string; idempotent?: boolean; body?: Record<string, unknown>; query?: string[]; responses?: Record<string, string> };
const money = { type: 'object', properties: { valueMinor: { type: 'integer' }, currency: { type: 'string', minLength: 3, maxLength: 3 } } };
const OPS: Op[] = [
  { method: 'post', path: '/payment_intents', tag: 'Payment intents', summary: 'Create a payment intent (returns checkout_url, qr_payload and client_secret)', scope: 'payment_intents:write', idempotent: true, body: { amount_minor: { type: 'integer' }, currency: { type: 'string' }, rails: { type: 'array', items: { type: 'string' } }, capture_method: { enum: ['automatic', 'manual'] }, payment_method_policy: { enum: ['smart', 'cheapest', 'fastest', 'most_reliable'] }, reference: { type: 'string' }, description: { type: 'string' }, purpose_code: { enum: [...PURPOSE_CODES] }, expires_in_minutes: { type: 'integer' }, metadata: { type: 'object' }, customer_msisdn: { type: 'string' }, customer_country: { type: 'string' }, success_url: { type: 'string' }, cancel_url: { type: 'string' }, qr: { type: 'boolean' }, splits: { type: 'array', items: { type: 'object', properties: { recipient: { type: 'string' }, bps: { type: 'integer' }, fixed_minor: { type: 'integer' }, label: { type: 'string' } } } } } },
  { method: 'get', path: '/payment_intents', tag: 'Payment intents', summary: 'List payment intents', scope: 'payment_intents:read', query: ['status', 'limit'] },
  { method: 'get', path: '/payment_intents/{id}', tag: 'Payment intents', summary: 'Retrieve a payment intent', scope: 'payment_intents:read' },
  { method: 'get', path: '/payment_intents/{id}/timeline', tag: 'Payment intents', summary: 'Every state change and attempt of an intent', scope: 'payment_intents:read' },
  { method: 'post', path: '/payment_intents/{id}/cancel', tag: 'Payment intents', summary: 'Cancel an intent that has not been captured', scope: 'payment_intents:write' },
  { method: 'get', path: '/payment_intents/{id}/methods', tag: 'Payment intents', summary: 'Payment methods available to the payer for this intent', scope: 'payment_intents:read' },
  { method: 'get', path: '/payment_intents/{id}/refundable', tag: 'Refunds', summary: 'Amount still refundable on an intent', scope: 'refunds:read' },
  { method: 'get', path: '/payment_intents/{id}/splits', tag: 'Payment intents', summary: 'Split payouts made from a captured intent', scope: 'payment_intents:read' },
  { method: 'post', path: '/checkout_sessions', tag: 'Checkout', summary: 'Create a hosted checkout session with line items', scope: 'checkout_sessions:write', idempotent: true },
  { method: 'get', path: '/checkout_sessions', tag: 'Checkout', summary: 'List checkout sessions', scope: 'payment_intents:read' },
  { method: 'get', path: '/checkout_sessions/{id}', tag: 'Checkout', summary: 'Retrieve a checkout session', scope: 'payment_intents:read' },
  { method: 'post', path: '/checkout_sessions/{id}/expire', tag: 'Checkout', summary: 'Expire an open session', scope: 'checkout_sessions:write' },
  { method: 'post', path: '/payment_links', tag: 'Payment links', summary: 'Create a single-use or reusable payment link', scope: 'payment_links:write', idempotent: true },
  { method: 'get', path: '/payment_links', tag: 'Payment links', summary: 'List payment links', scope: 'payment_links:write' },
  { method: 'post', path: '/payment_links/{id}/deactivate', tag: 'Payment links', summary: 'Deactivate a link', scope: 'payment_links:write' },
  { method: 'post', path: '/qr_codes', tag: 'QR', summary: 'Create a static BitriQR (EMVCo + signed extension)', scope: 'qr_codes:write' },
  { method: 'get', path: '/qr_codes', tag: 'QR', summary: 'List QR codes', scope: 'qr_codes:read' },
  { method: 'get', path: '/qr_codes/analytics', tag: 'QR', summary: 'Scan analytics', scope: 'qr_codes:read' },
  { method: 'post', path: '/qr_codes/{id}/revoke', tag: 'QR', summary: 'Revoke a code (lost, stolen, tampered, replaced, retired)', scope: 'qr_codes:write' },
  { method: 'post', path: '/resolve', tag: 'QR', summary: 'Resolve any scanned payload (public; trust from the key registry)' },
  { method: 'get', path: '/keys', tag: 'QR', summary: 'Public signing-key registry (ed25519, ETag cached)' },
  { method: 'post', path: '/locations', tag: 'QR', summary: 'Create a merchant location', scope: 'qr_codes:write' },
  { method: 'post', path: '/locations/{id}/terminals', tag: 'QR', summary: 'Add a terminal to a location', scope: 'qr_codes:write' },
  { method: 'post', path: '/refunds', tag: 'Refunds', summary: 'Refund a captured intent (atomic reservation; wallet or processor)', scope: 'refunds:write', idempotent: true, body: { payment_intent: { type: 'string' }, amount_minor: { type: 'integer' }, reason: { type: 'string' } } },
  { method: 'get', path: '/refunds', tag: 'Refunds', summary: 'List refunds', scope: 'refunds:read' },
  { method: 'get', path: '/refunds/{id}', tag: 'Refunds', summary: 'Retrieve a refund', scope: 'refunds:read' },
  { method: 'post', path: '/verifications', tag: 'Verifications (KODA)', summary: 'Scan-to-Verify: did a payment reach me? (reference, or MSISDN + amount)', scope: 'verifications:write' },
  { method: 'get', path: '/verifications/quota', tag: 'Verifications (KODA)', summary: 'Free quota and price', scope: 'verifications:write' },
  { method: 'get', path: '/wallets', tag: 'Wallets', summary: 'Wallet balances with the available amount after holds', scope: 'wallets:read' },
  { method: 'post', path: '/transfers/quote', tag: 'Transfers', summary: 'Quote a transfer with the full fee and FX disclosure, plus rails ranked by the smart router', scope: 'transfers:write', body: { amount_minor: { type: 'integer' }, currency: { type: 'string' }, target_currency: { type: 'string' }, destination: { type: 'object' }, source_method: { enum: ['wallet', 'card', 'mobile_money', 'bank'] }, policy: { enum: ['smart', 'cheapest', 'fastest', 'most_reliable'] } } },
  { method: 'post', path: '/transfers', tag: 'Transfers', summary: 'Send from the wallet to another BitriPay account', scope: 'transfers:write', idempotent: true, body: { to: { type: 'string' }, amount_minor: { type: 'integer' }, currency: { type: 'string' }, note: { type: 'string' } } },
  { method: 'get', path: '/transfers/{id}', tag: 'Transfers', summary: 'Retrieve a transfer', scope: 'transfers:read' },
  { method: 'get', path: '/remittances/quote', tag: 'Remittances', summary: 'Quote an international transfer', scope: 'remittances:read', query: ['amount_minor', 'currency', 'target_currency'] },
  { method: 'post', path: '/remittances', tag: 'Remittances', summary: 'Send an international transfer to a wallet, bank account or cash pickup', scope: 'remittances:write', idempotent: true, body: { amount_minor: { type: 'integer' }, currency: { type: 'string' }, target_currency: { type: 'string' }, payout_method: { enum: ['wallet', 'bank', 'cash_pickup'] }, recipient: { type: 'object' }, note: { type: 'string' } } },
  { method: 'get', path: '/remittances', tag: 'Remittances', summary: 'List remittances', scope: 'remittances:read' },
  { method: 'get', path: '/payouts/batches/columns', tag: 'Bulk payouts', summary: 'CSV columns accepted for a batch upload', scope: 'payouts:read' },
  { method: 'post', path: '/payouts/batches', tag: 'Bulk payouts', summary: 'Upload a payout batch (rows or CSV); every row is validated and the totals are returned before approval', scope: 'payouts:write', idempotent: true, body: { currency: { type: 'string' }, rows: { type: 'array', items: { type: 'object' } }, csv: { type: 'string' }, reference: { type: 'string' }, note: { type: 'string' }, skip_invalid: { type: 'boolean' } } },
  { method: 'get', path: '/payouts/batches', tag: 'Bulk payouts', summary: 'List payout batches', scope: 'payouts:read', query: ['status', 'limit'] },
  { method: 'get', path: '/payouts/batches/{id}', tag: 'Bulk payouts', summary: 'Retrieve a batch with its rows and readiness (funds, invalid rows, approval rule)', scope: 'payouts:read' },
  { method: 'post', path: '/payouts/batches/{id}/approve', tag: 'Bulk payouts', summary: 'Approve and execute a batch: four-eyes by another account holder, or the creator under PIN / passkey step-up', scope: 'payouts:approve', body: { pin: { type: 'string' } } },
  { method: 'post', path: '/payouts/batches/{id}/cancel', tag: 'Bulk payouts', summary: 'Cancel a batch awaiting approval', scope: 'payouts:write' },
  { method: 'post', path: '/ai/{agent}', tag: 'Agents', summary: 'Run an agent (canonical names such as RouteOptimiser, FraudScorer, SavingsAdvisor accepted); metered in ACU, provider and model never disclosed', scope: 'ai:run', body: { input: { type: 'string' }, context: { type: 'object' }, depth: { enum: ['standard', 'deep'] }, wait: { type: 'boolean' } } },
  { method: 'get', path: '/ai/runs/{id}', tag: 'Agents', summary: 'Retrieve an agent run', scope: 'ai:run' },
  { method: 'post', path: '/payouts', tag: 'Payouts', summary: 'Pay out to a bank account or mobile-money number', scope: 'payouts:write', idempotent: true },
  { method: 'get', path: '/payouts', tag: 'Payouts', summary: 'List payouts', scope: 'payouts:read' },
  { method: 'get', path: '/balance', tag: 'Balance', summary: 'Balance classes: available, pending, reserved, settlement_pending, held, disputed, frozen', scope: 'balance:read' },
  { method: 'get', path: '/settlement_profiles', tag: 'Settlement', summary: 'Settlement profiles per rail and currency', scope: 'settlements:read' },
  { method: 'post', path: '/settlement_profiles', tag: 'Settlement', summary: 'Create or update a profile (T0/T1/T2/weekly/manual, cut-off, destination, minimum)', scope: 'settlements:write' },
  { method: 'get', path: '/settlement_calendar', tag: 'Settlement', summary: 'Upcoming cut-offs, obligations and recent cycles', scope: 'settlements:read' },
  { method: 'get', path: '/settlement_cycles', tag: 'Settlement', summary: 'List cycles', scope: 'settlements:read' },
  { method: 'post', path: '/settlement_cycles', tag: 'Settlement', summary: 'Close the running period now (optionally pay)', scope: 'settlements:write' },
  { method: 'get', path: '/settlement_cycles/{id}/statement', tag: 'Settlement', summary: 'Numbered, hashed statement (format=json|csv|pdf)', scope: 'settlements:read', query: ['format'] },
  { method: 'post', path: '/settlement_cycles/{id}/pay', tag: 'Settlement', summary: 'Pay a closed cycle to its destination', scope: 'settlements:write' },
  { method: 'get', path: '/disputes', tag: 'Disputes', summary: 'Disputes against my payments', scope: 'disputes:read' },
  { method: 'post', path: '/disputes', tag: 'Disputes', summary: 'Open a dispute on a payment I received', scope: 'disputes:write' },
  { method: 'post', path: '/disputes/{id}/respond', tag: 'Disputes', summary: 'Respond with evidence before the deadline', scope: 'disputes:write' },
  { method: 'post', path: '/webhook_endpoints', tag: 'Webhooks', summary: 'Create an endpoint (returns whsec_ secret once)', scope: 'webhooks:manage' },
  { method: 'get', path: '/webhook_endpoints/{id}/deliveries', tag: 'Webhooks', summary: 'Deliveries with attempts and status', scope: 'webhooks:manage' },
  { method: 'post', path: '/webhook_deliveries/{id}/replay', tag: 'Webhooks', summary: 'Replay a delivery', scope: 'webhooks:manage' },
  { method: 'get', path: '/events', tag: 'Webhooks', summary: 'Event log', scope: 'events:read' },
  { method: 'post', path: '/events/{id}/replay', tag: 'Webhooks', summary: 'Replay an event to every endpoint', scope: 'webhooks:manage' },
  { method: 'get', path: '/api_keys', tag: 'Keys', summary: 'List API keys (session only; keys cannot mint keys)' },
  { method: 'post', path: '/api_keys', tag: 'Keys', summary: 'Create sk_ / rk_ / pk_ key with scopes' },
  { method: 'get', path: '/sandbox', tag: 'Sandbox', summary: 'Magic MSISDNs and simulated outcomes' },
  { method: 'post', path: '/offline/devices', tag: 'Offline', summary: 'Register a device offline subkey (ed25519 SPKI, 72h)' },
  { method: 'post', path: '/offline/qr', tag: 'Offline', summary: 'Server-signed offline QR with nonce', scope: 'qr_codes:write' },
  { method: 'post', path: '/offline/nonces', tag: 'Offline', summary: 'Prefetch nonces for a merchant device' },
  { method: 'post', path: '/offline/sync', tag: 'Offline', summary: 'Submit signed promises in order; each is SETTLED, REJECTED (with restoreMinor) or DUPLICATE' },
  { method: 'get', path: '/offline/promises', tag: 'Offline', summary: 'My offline promises' },
  { method: 'get', path: '/diaspora/rate-cards', tag: 'Diaspora-Direct', summary: 'Published, platform-signed rate cards (≤ 4h validity)' },
  { method: 'get', path: '/institutions', tag: 'Diaspora-Direct', summary: 'Verified institutions and their purpose codes', query: ['country', 'purpose', 'q'] },
  { method: 'post', path: '/diaspora/quotes', tag: 'Diaspora-Direct', summary: 'Purpose-locked quote at the current rate card' },
  { method: 'post', path: '/diaspora/quotes/{id}/pay', tag: 'Diaspora-Direct', summary: 'Pay a quote from the source-currency wallet' },
  { method: 'post', path: '/payments', tag: 'National switch', summary: 'Create an interinstitutional payment (IDM-001/002/003; route computed server-side)', scope: 'payments:create', idempotent: true },
  { method: 'get', path: '/payments/{id}', tag: 'National switch', summary: 'Five status dimensions and journal', scope: 'payments:read' },
  { method: 'post', path: '/payments/{id}/cancel', tag: 'National switch', summary: 'Cancel before emission (never after)', scope: 'payments:cancel' },
  { method: 'get', path: '/status', tag: 'Platform', summary: 'Operating state (guardian mode, degraded flags)' },
];

export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPS) {
    const params = [...(op.path.match(/\{(\w+)\}/g) ?? []).map((p) => ({ name: p.slice(1, -1), in: 'path', required: true, schema: { type: 'string' } })), ...(op.query ?? []).map((q) => ({ name: q, in: 'query', required: false, schema: { type: 'string' } }))];
    if (op.idempotent) params.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } } as any);
    paths[op.path] ??= {};
    paths[op.path][op.method] = {
      tags: [op.tag],
      summary: op.summary,
      operationId: `${op.method}_${op.path.replace(/[{}/]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`,
      ...(op.scope ? { security: [{ apiKey: [op.scope] }], 'x-scope': op.scope } : {}),
      parameters: params,
      ...(op.body ? { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: op.body } } } } } : op.method === 'post' ? { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } : {}),
      responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } }, ...(op.method === 'post' ? { '201': { description: 'Created' } } : {}), '4XX': { $ref: '#/components/responses/Error' } },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: `${config.appName} Gateway API`, version: '2026-09-01', description: 'One QR. One gateway. Every eligible rail. Amounts are integers in minor units. Every money-moving POST takes an Idempotency-Key: a replay returns the same object, a reuse with a different body is refused (422). Errors carry `code`, a stable `bp` family (BP-1xxx auth · 2xxx validation · 3xxx ledger · 4xxx rail · 5xxx compliance · 6xxx intelligence) and `message`.', contact: { url: config.webUrl } },
    servers: [{ url: `${config.webUrl.replace(/\/$/, '')}/api/v1` }, { url: `${config.webUrl.replace(/\/$/, '')}/v1` }],
    tags: [...new Set(OPS.map((o) => o.tag))].map((t) => ({ name: t })),
    paths,
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: `sk_live_/sk_test_ secret keys, rk_ restricted keys with scopes (${API_KEY_SCOPES.join(', ')}), pk_ publishable keys.` } },
      schemas: { Money: money, Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, bp: { type: 'string', enum: [...new Set(Object.values(BP_CODES))] }, message: { type: 'string' }, details: {} } } } } },
      responses: { Error: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
      'x-webhooks': { signature: 'BitriPay-Signature: t=<unix>,v1=<hex hmac-sha256(secret, `${t}.${rawBody}`)> and BitriPay-Signature-Ed25519: keyId,t,sig (platform key)', retries: '10s, 30s, 2m, 10m, 30m, then every 2h for 24h', events: [...WEBHOOK_EVENT_TYPES] },
      'x-error-codes': BP_CODES,
    },
  };
}
