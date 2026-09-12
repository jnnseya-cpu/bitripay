/**
 * BitriPay SDK for Node.js / TypeScript. Zero dependencies: uses the global fetch and node:crypto.
 * Every money-moving call takes an idempotency key; errors carry the API code and the BP-xxxx family.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface BitriPayOptions {
  apiKey: string;
  /** Defaults to https://api.bitripay.com; use your own host for self-hosted deployments. */
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}
export class BitriPayError extends Error {
  status: number;
  code: string;
  bp?: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, bp?: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.bp = bp;
    this.details = details;
  }
}
export interface RequestOptions { idempotencyKey?: string; stepUpToken?: string }
type Query = Record<string, string | number | boolean | undefined | null>;

export class BitriPay {
  private base: string;
  private key: string;
  private timeout: number;
  private f: typeof fetch;
  constructor(opts: BitriPayOptions) {
    if (!opts.apiKey) throw new Error('apiKey is required');
    this.key = opts.apiKey;
    this.base = (opts.baseUrl ?? 'https://api.bitripay.com').replace(/\/$/, '');
    this.timeout = opts.timeoutMs ?? 30_000;
    this.f = opts.fetch ?? fetch;
  }
  async request<T>(method: string, path: string, body?: unknown, opts: RequestOptions & { query?: Query } = {}): Promise<T> {
    const q = opts.query ? '?' + Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&') : '';
    const headers: Record<string, string> = { authorization: `Bearer ${this.key}`, accept: 'application/json', 'user-agent': 'bitripay-sdk-node/1.0.0' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    if (opts.stepUpToken) headers['x-step-up-token'] = opts.stepUpToken;
    const res = await this.f(`${this.base}${path}${q}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.timeout) });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new BitriPayError(res.status, json?.error?.code ?? 'error', json?.error?.message ?? `HTTP ${res.status}`, json?.error?.bp, json?.error?.details);
    return json as T;
  }
  private get = <T>(path: string, query?: Query) => this.request<T>('GET', path, undefined, { query });
  private post = <T>(path: string, body?: unknown, opts?: RequestOptions) => this.request<T>('POST', path, body ?? {}, opts);

  paymentIntents = {
    create: (body: { amount_minor?: number; currency: string; rails?: string[]; reference?: string; description?: string; purpose_code?: string; metadata?: Record<string, unknown>; customer_msisdn?: string; success_url?: string; cancel_url?: string; splits?: { recipient: string; bps?: number; fixed_minor?: number; label?: string }[]; qr?: boolean }, opts?: RequestOptions) => this.post<any>('/v1/payment_intents', body, opts),
    retrieve: (id: string) => this.get<any>(`/v1/payment_intents/${id}`),
    list: (query?: Query) => this.get<{ data: any[] }>('/v1/payment_intents', query),
    timeline: (id: string) => this.get<any>(`/v1/payment_intents/${id}/timeline`),
    cancel: (id: string, reason?: string) => this.post<any>(`/v1/payment_intents/${id}/cancel`, { reason }),
    methods: (id: string) => this.get<any>(`/v1/payment_intents/${id}/methods`),
    refundable: (id: string) => this.get<any>(`/v1/payment_intents/${id}/refundable`),
    splits: (id: string) => this.get<{ data: any[] }>(`/v1/payment_intents/${id}/splits`),
  };
  checkoutSessions = {
    create: (body: Record<string, unknown>, opts?: RequestOptions) => this.post<any>('/v1/checkout_sessions', body, opts),
    retrieve: (id: string) => this.get<any>(`/v1/checkout_sessions/${id}`),
    list: (query?: Query) => this.get<{ data: any[] }>('/v1/checkout_sessions', query),
    expire: (id: string) => this.post<any>(`/v1/checkout_sessions/${id}/expire`),
  };
  paymentLinks = {
    create: (body: Record<string, unknown>, opts?: RequestOptions) => this.post<any>('/v1/payment_links', body, opts),
    retrieve: (id: string) => this.get<any>(`/v1/payment_links/${id}`),
    list: (query?: Query) => this.get<{ data: any[] }>('/v1/payment_links', query),
    deactivate: (id: string) => this.post<any>(`/v1/payment_links/${id}/deactivate`),
  };
  qrCodes = {
    create: (body: Record<string, unknown>) => this.post<any>('/v1/qr_codes', body),
    list: (query?: Query) => this.get<{ data: any[] }>('/v1/qr_codes', query),
    retrieve: (id: string) => this.get<any>(`/v1/qr_codes/${id}`),
    revoke: (id: string, reason: string) => this.post<any>(`/v1/qr_codes/${id}/revoke`, { reason }),
    analytics: (query?: Query) => this.get<any>('/v1/qr_codes/analytics', query),
    resolve: (payload: string) => this.post<any>('/v1/resolve', { data: payload }),
  };
  locations = {
    create: (body: Record<string, unknown>) => this.post<any>('/v1/locations', body),
    list: () => this.get<{ data: any[] }>('/v1/locations'),
    addTerminal: (locationId: string, label: string, deviceRef?: string) => this.post<any>(`/v1/locations/${locationId}/terminals`, { label, device_ref: deviceRef }),
  };
  refunds = {
    create: (body: { payment_intent: string; amount_minor?: number; reason?: string; method?: string }, opts?: RequestOptions) => this.post<any>('/v1/refunds', body, opts),
    retrieve: (id: string) => this.get<any>(`/v1/refunds/${id}`),
    list: (query?: Query) => this.get<{ data: any[] }>('/v1/refunds', query),
  };
  verifications = {
    create: (body: { rail?: string; reference?: string; msisdn?: string; amount_minor?: number; currency?: string; window_hours?: number }) => this.post<any>('/v1/verifications', body),
    retrieve: (id: string) => this.get<any>(`/v1/verifications/${id}`),
    quota: () => this.get<any>('/v1/verifications/quota'),
  };
  payouts = {
    create: (body: Record<string, unknown>, opts?: RequestOptions) => this.post<any>('/v1/payouts', body, opts),
    retrieve: (id: string) => this.get<any>(`/v1/payouts/${id}`),
    list: (query?: Query) => this.get<{ data: any[] }>('/v1/payouts', query),
  };
  balance = () => this.get<any>('/v1/balance');
  settlements = {
    profiles: () => this.get<{ data: any[] }>('/v1/settlement_profiles'),
    upsertProfile: (body: Record<string, unknown>) => this.post<any>('/v1/settlement_profiles', body),
    calendar: () => this.get<any>('/v1/settlement_calendar'),
    cycles: (query?: Query) => this.get<{ data: any[] }>('/v1/settlement_cycles', query),
    close: (currency: string, pay = false, rail?: string) => this.post<any>('/v1/settlement_cycles', { currency, pay, rail }),
    statement: (id: string) => this.get<any>(`/v1/settlement_cycles/${id}/statement`),
    pay: (id: string) => this.post<any>(`/v1/settlement_cycles/${id}/pay`),
  };
  disputes = {
    list: (query?: Query) => this.get<{ data: any[] }>('/v1/disputes', query),
    retrieve: (id: string) => this.get<any>(`/v1/disputes/${id}`),
    respond: (id: string, response: string, files: string[] = []) => this.post<any>(`/v1/disputes/${id}/respond`, { response, files }),
    evidence: (id: string, text: string, files: string[] = []) => this.post<any>(`/v1/disputes/${id}/evidence`, { text, files }),
  };
  webhookEndpoints = {
    create: (body: { url: string; events: string[]; description?: string }) => this.post<any>('/v1/webhook_endpoints', body),
    list: () => this.get<{ data: any[] }>('/v1/webhook_endpoints'),
    update: (id: string, body: Record<string, unknown>) => this.request<any>('PATCH', `/v1/webhook_endpoints/${id}`, body),
    remove: (id: string) => this.request<any>('DELETE', `/v1/webhook_endpoints/${id}`),
    rotate: (id: string) => this.post<any>(`/v1/webhook_endpoints/${id}/rotate`),
    ping: (id: string) => this.post<any>(`/v1/webhook_endpoints/${id}/ping`),
    deliveries: (id: string) => this.get<{ data: any[] }>(`/v1/webhook_endpoints/${id}/deliveries`),
  };
  events = {
    list: (query?: Query) => this.get<{ data: any[] }>('/v1/events', query),
    retrieve: (id: string) => this.get<any>(`/v1/events/${id}`),
    replay: (id: string) => this.post<any>(`/v1/events/${id}/replay`),
    types: () => this.get<any>('/v1/webhook_events/types'),
  };
  offline = {
    settings: () => this.get<any>('/v1/offline/settings'),
    registerDevice: (body: { deviceId: string; publicKey: string; label?: string }) => this.post<any>('/v1/offline/devices', body),
    qr: (body: { amount_minor: number; currency: string; reference?: string; ttl_seconds?: number }) => this.post<any>('/v1/offline/qr', body),
    nonces: (count = 10) => this.post<{ data: { nonce: string; expiresAt: string }[] }>('/v1/offline/nonces', { count }),
    sync: (promises: Record<string, unknown>[]) => this.post<{ results: any[]; settled: number; rejected: number; duplicates: number }>('/v1/offline/sync', { promises }),
    promises: (query?: Query) => this.get<{ data: any[] }>('/v1/offline/promises', query),
  };
  diaspora = {
    rateCards: () => this.get<any>('/v1/diaspora/rate-cards'),
    institutions: (query?: Query) => this.get<{ data: any[] }>('/v1/institutions', query),
    quote: (body: { beneficiary: string; sourceCurrency: string; destCurrency?: string; sourceMinor?: number; destMinor?: number; purposeCode: string; reference?: string }) => this.post<any>('/v1/diaspora/quotes', body),
    pay: (id: string, pin?: string, opts?: RequestOptions) => this.post<any>(`/v1/diaspora/quotes/${id}/pay`, { pin }, opts),
  };
  /** National switch payments (aggregator perimeter). */
  payments = {
    create: (body: Record<string, unknown>, idempotencyKey: string) => this.post<any>('/v1/payments', body, { idempotencyKey }),
    retrieve: (id: string) => this.get<any>(`/v1/payments/${id}`),
    list: (query?: Query) => this.get<{ data: any[] }>('/v1/payments', query),
    cancel: (id: string, reason?: string) => this.post<any>(`/v1/payments/${id}/cancel`, { reason }),
  };
  keys = () => this.get<{ algorithm: string; keys: any[] }>('/v1/keys');
  sandbox = { catalogue: () => this.get<any>('/v1/sandbox'), simulate: (body: Record<string, unknown>) => this.post<any>('/v1/sandbox/simulate', body) };
  webhooks = Webhooks;
}

/** Verify BitriPay-Signature (t=…,v1=…) over the raw body with the endpoint secret. Throws on failure. */
export const Webhooks = {
  verify(rawBody: string | Buffer, signatureHeader: string | undefined, secret: string, toleranceSeconds = 300): any {
    if (!signatureHeader) throw new BitriPayError(400, 'missing_signature', 'Missing BitriPay-Signature header');
    const parts = Object.fromEntries(signatureHeader.split(',').map((p) => p.trim().split('=') as [string, string]));
    const t = Number(parts.t);
    if (!t || !parts.v1) throw new BitriPayError(400, 'malformed_signature', 'Malformed signature header');
    if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) throw new BitriPayError(400, 'signature_expired', 'Signature timestamp outside tolerance');
    const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(parts.v1);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new BitriPayError(400, 'invalid_signature', 'Signature does not match');
    return JSON.parse(body);
  },
};
export default BitriPay;
