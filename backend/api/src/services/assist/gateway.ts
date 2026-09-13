/**
 * AI gateway: the only door between BitriPay and a model. Eight layers, in order — authentication and tenant guard,
 * rate limiter, ACU policy (projected cost, budget, margin floor), prompt normalisation (PII stripping, injection
 * defence), model router (task type → ordered models from configuration, failover on errors and on timeouts over
 * eight seconds), provider adapter, response normaliser (zod schema) and the usage + cost ledger that only
 * administrators can read. Callers receive a clean response: never a provider, a model, a token count or a cost.
 * The margin floor (MIN_GROSS_MARGIN, default 0.66) is checked per request, at every pricing change and at the
 * monthly reconciliation; below it the gateway refuses with MARGIN_PROTECTION_VIOLATION.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { getDb } from '../../db';
import { now, uuid } from '../../lib/ids';
import { AppError } from '../../lib/errors';
import { getSetting, getAssistSettings } from '../settings';
import { recordEvent } from '../events';
import { modelApiKey } from './runtime';
import { publish } from '../bus';

export class GatewayError extends AppError {
  constructor(
    code: 'UNAUTHENTICATED' | 'TENANT_MISMATCH' | 'RATE_LIMITED' | 'NEURAL_QUOTA_EXCEEDED' | 'MARGIN_PROTECTION_VIOLATION' | 'PROVIDER_UNAVAILABLE' | 'OUTPUT_SCHEMA_INVALID',
    message: string,
    details?: unknown,
  ) {
    super(code === 'UNAUTHENTICATED' ? 401 : code === 'TENANT_MISMATCH' ? 403 : code === 'RATE_LIMITED' ? 429 : code === 'PROVIDER_UNAVAILABLE' ? 503 : 422, code.toLowerCase(), message, details);
  }
}

export interface AcuPolicy {
  /** Price of one Agent Compute Unit in micro-dollars (10 000 = one US cent). */
  acuPriceMicros: number;
  /** How tokens map to ACU (decoupled from provider pricing; administrators tune it). */
  acuPerKiloToken: number;
  /** Gross margin floor on every neural operation: (revenue − raw cost) / revenue. */
  minGrossMargin: number;
  /** Monthly budgets (ACU); 0 = unlimited. */
  monthlyBudgetPerUser: number;
  monthlyBudgetPerTenant: number;
  overage: 'block' | 'bill';
  /** Tokens assumed per run when validating the per-run prices administrators set (standard = fast model, deep = main model). */
  expectedTokensPerRun: number;
  expectedTokensStandard: number;
  expectedTokensDeep: number;
  alertBelowMargin: number;
}
const DEFAULT_ACU: AcuPolicy = {
  acuPriceMicros: 10_000,
  acuPerKiloToken: 1,
  minGrossMargin: 0.66,
  monthlyBudgetPerUser: 0,
  monthlyBudgetPerTenant: 0,
  overage: 'block',
  expectedTokensPerRun: 6_000,
  expectedTokensStandard: 2_000,
  expectedTokensDeep: 6_000,
  alertBelowMargin: 0.7,
};
export const MIN_GROSS_MARGIN = 0.66;
export const getAcuPolicy = (): AcuPolicy => {
  const s = { ...DEFAULT_ACU, ...getSetting<Partial<AcuPolicy>>('acuPolicy', {}) };
  // the constant is a floor for the setting too: nobody configures the platform into a loss
  s.minGrossMargin = Math.max(MIN_GROSS_MARGIN, s.minGrossMargin);
  return s;
};

export type TaskType = 'classify' | 'summarise' | 'draft' | 'reason' | 'score' | 'extract';
export interface AiRouting {
  taskTypes: Record<TaskType, string[]>;
  timeoutMs: number;
  /** Failures within this window open the model's circuit. */
  circuitFailures: number;
  circuitWindowMs: number;
  providers: Record<string, { enabled: boolean; apiKey?: string | null; baseUrl?: string | null }>;
  rateLimits: { perUserPerMinute: number; perTenantPerMinute: number; perAgentPerMinute: number };
}
const DEFAULT_ROUTING: AiRouting = {
  taskTypes: {
    classify: ['claude-haiku-4-5-20251001', 'claude-sonnet-5'],
    extract: ['claude-haiku-4-5-20251001', 'claude-sonnet-5'],
    score: ['claude-haiku-4-5-20251001', 'claude-sonnet-5'],
    summarise: ['claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    draft: ['claude-sonnet-5', 'claude-opus-5'],
    reason: ['claude-opus-5', 'claude-sonnet-5'],
  },
  timeoutMs: 8000,
  circuitFailures: 3,
  circuitWindowMs: 5 * 60_000,
  providers: {
    anthropic: { enabled: true },
    openai: { enabled: false, apiKey: null, baseUrl: 'https://api.openai.com/v1' },
    gemini: { enabled: false, apiKey: null, baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  },
  rateLimits: { perUserPerMinute: 30, perTenantPerMinute: 600, perAgentPerMinute: 300 },
};
export const getAiRouting = (): AiRouting => {
  const s = getSetting<Partial<AiRouting>>('aiRouting', {});
  return {
    ...DEFAULT_ROUTING,
    ...s,
    taskTypes: { ...DEFAULT_ROUTING.taskTypes, ...(s.taskTypes ?? {}) },
    providers: { ...DEFAULT_ROUTING.providers, ...(s.providers ?? {}) },
    rateLimits: { ...DEFAULT_ROUTING.rateLimits, ...(s.rateLimits ?? {}) },
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// Economics
// ---------------------------------------------------------------------------------------------------------------------
export function providerFor(model: string): string {
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'openai';
  if (model.startsWith('gemini-')) return 'gemini';
  if (model === 'offline') return 'offline';
  return 'anthropic';
}
/** Raw provider cost in micro-dollars at the configured list price (assumes a 1:1 in/out split when only totals are known). */
export function projectCostMicros(model: string, tokensIn: number, tokensOut: number): number {
  if (model === 'offline') return 0;
  const price = getAssistSettings().pricing[model] ?? { input: 15, output: 75 };
  return Math.round(tokensIn * price.input + tokensOut * price.output);
}
export function acuFor(tokens: number): number {
  return Math.round((tokens / 1000) * getAcuPolicy().acuPerKiloToken * 1000) / 1000;
}
export function marginOf(revenueMicros: number, costMicros: number): number {
  if (revenueMicros <= 0) return costMicros > 0 ? -1 : 1;
  return (revenueMicros - costMicros) / revenueMicros;
}
export interface ProjectedEconomics {
  model: string;
  tokens: number;
  rawCostMicros: number;
  acuUsed: number;
  acuRevenueMicros: number;
  margin: number;
  floor: number;
  ok: boolean;
}
export function projectEconomics(model: string, tokens: number): ProjectedEconomics {
  const p = getAcuPolicy();
  const half = Math.ceil(tokens / 2);
  const rawCostMicros = projectCostMicros(model, half, tokens - half);
  const acuUsed = acuFor(tokens);
  const acuRevenueMicros = Math.round(acuUsed * p.acuPriceMicros);
  const margin = marginOf(acuRevenueMicros, rawCostMicros);
  return { model, tokens, rawCostMicros, acuUsed, acuRevenueMicros, margin, floor: p.minGrossMargin, ok: margin >= p.minGrossMargin };
}
/** Validate administrator-set per-run prices (price currency minor units → micro-dollars at par when the price currency is USD-like). */
export function assertPricingAboveFloor(prices: { standard: number; deep: number }, models: { standard: string; deep: string }, priceCurrencyToUsd = 1): void {
  const p = getAcuPolicy();
  for (const tier of ['standard', 'deep'] as const) {
    const revenueMicros = Math.round(prices[tier] * priceCurrencyToUsd * 10_000);
    const tokens = tier === 'standard' ? p.expectedTokensStandard : p.expectedTokensDeep;
    const half = Math.ceil(tokens / 2);
    const cost = projectCostMicros(models[tier], half, tokens - half);
    const margin = marginOf(revenueMicros, cost);
    if (margin < p.minGrossMargin)
      throw new GatewayError(
        'MARGIN_PROTECTION_VIOLATION',
        `The ${tier} price gives a ${(margin * 100).toFixed(0)}% gross margin on ${models[tier]}; the floor is ${(p.minGrossMargin * 100).toFixed(0)}%.`,
        { tier, model: models[tier], margin, floor: p.minGrossMargin, revenueMicros, costMicros: cost },
      );
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Budgets, rate limits, circuits
// ---------------------------------------------------------------------------------------------------------------------
function monthKey() {
  return now().slice(0, 7);
}
export function budgetStatus(scope: 'user' | 'tenant', scopeId: string): { budget: number; used: number; remaining: number | null } {
  const p = getAcuPolicy();
  const budget = scope === 'user' ? p.monthlyBudgetPerUser : p.monthlyBudgetPerTenant;
  const r = getDb().prepare('SELECT used_acu FROM acu_budgets WHERE scope = ? AND scope_id = ? AND month = ?').get(scope, scopeId, monthKey()) as any;
  const used = r?.used_acu ?? 0;
  return { budget, used, remaining: budget ? Math.max(0, budget - used) : null };
}
function consumeBudget(scope: 'user' | 'tenant', scopeId: string, acu: number) {
  const p = getAcuPolicy();
  const budget = scope === 'user' ? p.monthlyBudgetPerUser : p.monthlyBudgetPerTenant;
  getDb()
    .prepare(
      'INSERT INTO acu_budgets (scope, scope_id, month, budget_acu, used_acu, overage, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scope, scope_id, month) DO UPDATE SET used_acu = used_acu + excluded.used_acu, budget_acu = excluded.budget_acu, updated_at = excluded.updated_at',
    )
    .run(scope, scopeId, monthKey(), budget, acu, p.overage, now());
  const st = budgetStatus(scope, scopeId);
  if (st.budget && st.remaining !== null && st.remaining <= st.budget * 0.1) publish('acu.budget_low', { scope, scopeId, remaining: st.remaining, budget: st.budget }, { aggregateId: scopeId });
}
const windows = new Map<string, number[]>();
function rateCheck(key: string, limit: number) {
  if (!limit) return;
  const t = Date.now();
  const arr = (windows.get(key) ?? []).filter((x) => t - x < 60_000);
  if (arr.length >= limit) throw new GatewayError('RATE_LIMITED', 'Too many neural requests; slow down.', { key: key.split(':')[0], limit });
  arr.push(t);
  windows.set(key, arr);
}
const failures = new Map<string, number[]>();
function circuitOpen(model: string): boolean {
  const r = getAiRouting();
  const arr = (failures.get(model) ?? []).filter((x) => Date.now() - x < r.circuitWindowMs);
  failures.set(model, arr);
  return arr.length >= r.circuitFailures;
}
function recordFailure(model: string) {
  failures.set(model, [...(failures.get(model) ?? []), Date.now()]);
}
export function modelHealth() {
  const r = getAiRouting();
  const models = [...new Set(Object.values(r.taskTypes).flat())];
  return models.map((m) => ({
    model: m,
    provider: providerFor(m),
    circuitOpen: circuitOpen(m),
    recentFailures: (failures.get(m) ?? []).length,
    providerEnabled: !!r.providers[providerFor(m)]?.enabled,
  }));
}
/** Ordered candidates for a task, skipping open circuits and disabled providers. */
export function routeModels(taskType: TaskType): string[] {
  const r = getAiRouting();
  return (r.taskTypes[taskType] ?? r.taskTypes.reason).filter((m) => !circuitOpen(m) && r.providers[providerFor(m)]?.enabled !== false);
}

// ---------------------------------------------------------------------------------------------------------------------
// Prompt normalisation
// ---------------------------------------------------------------------------------------------------------------------
export function stripPii(text: string): { text: string; replaced: number } {
  let n = 0;
  const out = text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, () => (n++, '[email]'))
    .replace(/\b(?:\d[ -]?){13,19}\b/g, () => (n++, '[card]'))
    .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, () => (n++, '[iban]'))
    .replace(/(?<![\w-])\+?\d[\d\s().-]{7,}\d(?![\w-])/g, () => (n++, '[phone]'));
  return { text: out, replaced: n };
}
const INJECTION =
  /(ignore|disregard|forget)\s+(all\s+|the\s+|your\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts?)|you are now\b|system prompt|\bjailbreak\b|reveal (the|your) (rules|prompt|instructions)/i;
export function defendInjection(untrusted: string): { text: string; flagged: boolean } {
  const flagged = INJECTION.test(untrusted);
  const cleaned = untrusted.replace(/[‪-‮⁦-⁩]/g, '');
  return { text: `<data trust="untrusted"${flagged ? ' injection="suspected"' : ''}>\n${cleaned}\n</data>`, flagged };
}

// ---------------------------------------------------------------------------------------------------------------------
// The kernel task
// ---------------------------------------------------------------------------------------------------------------------
export interface KernelContext {
  uid: string | null;
  tenantId: string;
  locale: string;
  origin: 'server' | 'schedule' | 'event';
  role?: string | null;
}
export interface AgentSpec<I, O> {
  name: string;
  taskType: TaskType;
  urgency: 'realtime' | 'batch';
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  piiPolicy: 'strip' | 'allow';
  maxTokens: number;
  languageAware: boolean;
  /** Build the prompt from the validated input. Untrusted fields must go through `data()`. */
  prompt: (input: I, locale: string, data: (untrusted: string) => string) => { system: string; user: string };
  /** Deterministic fallback used when no provider is available (rule-based, platform-funded). */
  offline?: (input: I) => O;
  /** Who pays the ACU: the platform (fraud, compliance, operations) or the account holder. */
  billedTo?: 'platform' | 'user';
  tenantId?: string | null;
}
export interface KernelResult<O> {
  requestId: string;
  output: O;
  source: 'model' | 'rules';
  latencyMs: number;
}

async function callProvider(model: string, system: string, user: string, maxTokens: number, timeoutMs: number): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const provider = providerFor(model);
  const r = getAiRouting();
  const ctl = AbortSignal.timeout(timeoutMs);
  if (provider === 'anthropic') {
    const key = modelApiKey();
    if (!key) throw new GatewayError('PROVIDER_UNAVAILABLE', 'No Anthropic key configured');
    const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: timeoutMs });
    const msg = await client.messages.create({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }, { signal: ctl });
    return {
      text: msg.content
        .filter((b) => b.type === 'text')
        .map((b: any) => b.text)
        .join(''),
      tokensIn: msg.usage?.input_tokens ?? 0,
      tokensOut: msg.usage?.output_tokens ?? 0,
    };
  }
  if (provider === 'openai') {
    const cfg = r.providers.openai;
    if (!cfg?.apiKey) throw new GatewayError('PROVIDER_UNAVAILABLE', 'No OpenAI key configured');
    const res = await fetch(`${cfg.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`, {
      method: 'POST',
      signal: ctl,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}`);
    const j = (await res.json()) as any;
    return { text: j.choices?.[0]?.message?.content ?? '', tokensIn: j.usage?.prompt_tokens ?? 0, tokensOut: j.usage?.completion_tokens ?? 0 };
  }
  if (provider === 'gemini') {
    const cfg = r.providers.gemini;
    if (!cfg?.apiKey) throw new GatewayError('PROVIDER_UNAVAILABLE', 'No Gemini key configured');
    const res = await fetch(`${cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'}/models/${model}:generateContent?key=${cfg.apiKey}`, {
      method: 'POST',
      signal: ctl,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { maxOutputTokens: maxTokens } }),
    });
    if (!res.ok) throw new Error(`gemini ${res.status}`);
    const j = (await res.json()) as any;
    return { text: j.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') ?? '', tokensIn: j.usageMetadata?.promptTokenCount ?? 0, tokensOut: j.usageMetadata?.candidatesTokenCount ?? 0 };
  }
  throw new GatewayError('PROVIDER_UNAVAILABLE', `No adapter for ${provider}`);
}
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  const slice = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
  return JSON.parse(slice);
}
function ledger(row: {
  tenantId: string;
  userId: string | null;
  agent: string;
  taskType: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  rawCostMicros: number;
  acuUsed: number;
  acuRevenueMicros: number;
  margin: number | null;
  latencyMs: number;
  outcome: string;
  errorCode?: string | null;
  billedTo: string;
}) {
  getDb()
    .prepare(
      'INSERT INTO ai_usage_ledger (id, tenant_id, user_id, agent, task_type, provider, model, tokens_in, tokens_out, raw_cost_micros, acu_used, acu_revenue_micros, margin, latency_ms, outcome, error_code, billed_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      uuid(),
      row.tenantId,
      row.userId,
      row.agent,
      row.taskType,
      row.provider,
      row.model,
      row.tokensIn,
      row.tokensOut,
      row.rawCostMicros,
      row.acuUsed,
      row.acuRevenueMicros,
      row.margin,
      row.latencyMs,
      row.outcome,
      row.errorCode ?? null,
      row.billedTo,
      now(),
    );
}

/** The single entry point. Throws GatewayError with one of the seven codes; never leaks provider details to the caller. */
export async function executeNeuralKernelTask<I, O>(ctx: KernelContext, spec: AgentSpec<I, O>, rawInput: unknown): Promise<KernelResult<O>> {
  const started = Date.now();
  const requestId = uuid();
  // 1. authentication and tenant guard
  if (!ctx.uid && ctx.origin === 'server') throw new GatewayError('UNAUTHENTICATED', 'A neural task needs an authenticated account or a scheduled / event origin');
  if (spec.tenantId && spec.tenantId !== ctx.tenantId) throw new GatewayError('TENANT_MISMATCH', 'The agent belongs to another tenant');
  const parsedIn = spec.inputSchema.safeParse(rawInput);
  if (!parsedIn.success) throw new AppError(400, 'validation_error', 'Invalid task input', parsedIn.error.issues);
  const input = parsedIn.data;
  const billedTo = spec.billedTo ?? 'platform';
  // 2. rate limiter
  const r = getAiRouting();
  if (ctx.uid) rateCheck(`user:${ctx.uid}`, r.rateLimits.perUserPerMinute);
  rateCheck(`tenant:${ctx.tenantId}`, r.rateLimits.perTenantPerMinute);
  rateCheck(`agent:${spec.name}`, r.rateLimits.perAgentPerMinute);
  // 3. ACU policy: budget and margin floor, projected on the routed model
  const candidates = routeModels(spec.taskType);
  const offlineOnly = !candidates.length || (providerFor(candidates[0]) === 'anthropic' && !modelApiKey() && !r.providers.openai?.apiKey && !r.providers.gemini?.apiKey);
  const p = getAcuPolicy();
  if (billedTo === 'user' && ctx.uid) {
    const b = budgetStatus('user', ctx.uid);
    if (b.budget && b.remaining !== null && b.remaining <= 0 && p.overage === 'block') throw new GatewayError('NEURAL_QUOTA_EXCEEDED', 'AI paused: ACU depleted for this month.', { scope: 'user' });
  }
  const tb = budgetStatus('tenant', ctx.tenantId);
  if (tb.budget && tb.remaining !== null && tb.remaining <= 0 && p.overage === 'block' && billedTo === 'user')
    throw new GatewayError('NEURAL_QUOTA_EXCEEDED', 'AI paused: the tenant ACU budget is used up.', { scope: 'tenant' });
  // 4. prompt normalisation
  const dataWrap = (untrusted: string) => {
    const pii = spec.piiPolicy === 'strip' ? stripPii(untrusted).text : untrusted;
    return defendInjection(pii).text;
  };
  const useRules = (): KernelResult<O> => {
    if (!spec.offline) throw new GatewayError('PROVIDER_UNAVAILABLE', 'No model provider is available and this task has no rule-based fallback');
    const output = spec.offline(input);
    const parsed = spec.outputSchema.safeParse(output);
    if (!parsed.success) throw new GatewayError('OUTPUT_SCHEMA_INVALID', 'Rule-based output did not match the schema', parsed.error.issues);
    ledger({
      tenantId: ctx.tenantId,
      userId: ctx.uid,
      agent: spec.name,
      taskType: spec.taskType,
      provider: 'offline',
      model: 'offline',
      tokensIn: 0,
      tokensOut: 0,
      rawCostMicros: 0,
      acuUsed: 0,
      acuRevenueMicros: 0,
      margin: null,
      latencyMs: Date.now() - started,
      outcome: 'rules',
      billedTo,
    });
    return { requestId, output: parsed.data, source: 'rules', latencyMs: Date.now() - started };
  };
  if (offlineOnly) return useRules();
  const prompt = spec.prompt(input, ctx.locale, dataWrap);
  const system = `${prompt.system}\n\nAnswer only with a JSON object matching the required schema. ${spec.languageAware ? `Write human-readable fields in locale ${ctx.locale}.` : ''}`;
  // 5–6. router and adapters with failover; the margin floor is enforced per candidate on the projected token use
  const viable = candidates.filter((m) => projectEconomics(m, spec.maxTokens).ok);
  if (!viable.length) {
    const best = candidates.map((m) => projectEconomics(m, spec.maxTokens)).sort((a, b) => b.margin - a.margin)[0];
    ledger({
      tenantId: ctx.tenantId,
      userId: ctx.uid,
      agent: spec.name,
      taskType: spec.taskType,
      provider: best ? providerFor(best.model) : 'none',
      model: best?.model ?? 'none',
      tokensIn: 0,
      tokensOut: 0,
      rawCostMicros: best?.rawCostMicros ?? 0,
      acuUsed: best?.acuUsed ?? 0,
      acuRevenueMicros: best?.acuRevenueMicros ?? 0,
      margin: best?.margin ?? null,
      latencyMs: Date.now() - started,
      outcome: 'refused',
      errorCode: 'MARGIN_PROTECTION_VIOLATION',
      billedTo,
    });
    throw new GatewayError(
      'MARGIN_PROTECTION_VIOLATION',
      `No routed model meets the ${(p.minGrossMargin * 100).toFixed(0)}% margin floor for this task`,
      best ? { model: best.model, margin: best.margin, floor: best.floor } : undefined,
    );
  }
  let lastError: unknown = null;
  for (const model of viable) {
    const t0 = Date.now();
    try {
      const res = await callProvider(model, system, prompt.user, spec.maxTokens, r.timeoutMs);
      // 7. response normaliser
      let parsedOut: z.SafeParseReturnType<unknown, O>;
      try {
        parsedOut = spec.outputSchema.safeParse(extractJson(res.text));
      } catch (err) {
        parsedOut = { success: false, error: new z.ZodError([{ code: 'custom', path: [], message: `not JSON: ${(err as Error).message}` }]) } as any;
      }
      const tokens = res.tokensIn + res.tokensOut;
      const rawCostMicros = projectCostMicros(model, res.tokensIn, res.tokensOut);
      const acuUsed = acuFor(tokens);
      const acuRevenueMicros = Math.round(acuUsed * p.acuPriceMicros);
      const margin = marginOf(acuRevenueMicros, rawCostMicros);
      // 8. usage + cost ledger (administrators only)
      ledger({
        tenantId: ctx.tenantId,
        userId: ctx.uid,
        agent: spec.name,
        taskType: spec.taskType,
        provider: providerFor(model),
        model,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        rawCostMicros,
        acuUsed,
        acuRevenueMicros,
        margin,
        latencyMs: Date.now() - t0,
        outcome: parsedOut.success ? 'ok' : 'schema_invalid',
        errorCode: parsedOut.success ? null : 'OUTPUT_SCHEMA_INVALID',
        billedTo,
      });
      if (billedTo === 'user' && ctx.uid) consumeBudget('user', ctx.uid, acuUsed);
      consumeBudget('tenant', ctx.tenantId, acuUsed);
      if (margin < p.alertBelowMargin) recordEvent('admin', requestId, 'ai.margin_alert', { type: 'system' }, { model, margin, floor: p.minGrossMargin, agent: spec.name });
      if (!parsedOut.success) throw new GatewayError('OUTPUT_SCHEMA_INVALID', 'The model answer did not match the schema', parsedOut.error.issues);
      return { requestId, output: parsedOut.data, source: 'model', latencyMs: Date.now() - started };
    } catch (err) {
      if (err instanceof GatewayError && err.code === 'output_schema_invalid') throw err;
      lastError = err;
      recordFailure(model);
      ledger({
        tenantId: ctx.tenantId,
        userId: ctx.uid,
        agent: spec.name,
        taskType: spec.taskType,
        provider: providerFor(model),
        model,
        tokensIn: 0,
        tokensOut: 0,
        rawCostMicros: 0,
        acuUsed: 0,
        acuRevenueMicros: 0,
        margin: null,
        latencyMs: Date.now() - t0,
        outcome: 'failover',
        errorCode: (err as any)?.code ?? (err as Error)?.name ?? 'error',
        billedTo,
      });
    }
  }
  if (spec.offline) return useRules();
  throw new GatewayError('PROVIDER_UNAVAILABLE', 'Every routed model failed or timed out', { lastError: String((lastError as Error)?.message ?? lastError) });
}

// ---------------------------------------------------------------------------------------------------------------------
// Administrator views
// ---------------------------------------------------------------------------------------------------------------------
export function gatewayReport(days = 30) {
  const db = getDb();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db
    .prepare(
      'SELECT provider, model, agent, task_type, outcome, COUNT(*) n, SUM(tokens_in) tin, SUM(tokens_out) tout, SUM(raw_cost_micros) cost, SUM(acu_used) acu, SUM(acu_revenue_micros) rev, AVG(latency_ms) lat FROM ai_usage_ledger WHERE created_at >= ? GROUP BY provider, model, agent, task_type, outcome ORDER BY n DESC',
    )
    .all(since) as any[];
  const totals = rows.reduce(
    (a, r) => ({
      requests: a.requests + r.n,
      tokensIn: a.tokensIn + r.tin,
      tokensOut: a.tokensOut + r.tout,
      rawCostMicros: a.rawCostMicros + r.cost,
      acuUsed: a.acuUsed + r.acu,
      acuRevenueMicros: a.acuRevenueMicros + r.rev,
    }),
    { requests: 0, tokensIn: 0, tokensOut: 0, rawCostMicros: 0, acuUsed: 0, acuRevenueMicros: 0 },
  );
  const margin = marginOf(totals.acuRevenueMicros, totals.rawCostMicros);
  const p = getAcuPolicy();
  const s = getAssistSettings();
  return {
    days,
    totals: { ...totals, margin, floor: p.minGrossMargin, belowFloor: totals.acuRevenueMicros > 0 && margin < p.minGrossMargin },
    rows: rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      agent: r.agent,
      taskType: r.task_type,
      outcome: r.outcome,
      requests: r.n,
      tokensIn: r.tin,
      tokensOut: r.tout,
      rawCostMicros: r.cost,
      acuUsed: Math.round(r.acu * 1000) / 1000,
      acuRevenueMicros: r.rev,
      margin: marginOf(r.rev, r.cost),
      avgLatencyMs: Math.round(r.lat ?? 0),
    })),
    policy: p,
    routing: getAiRouting(),
    models: modelHealth().map((m) => ({ ...m, economics: projectEconomics(m.model, p.expectedTokensPerRun), listPrice: s.pricing[m.model] ?? null })),
    budgets: (db.prepare('SELECT * FROM acu_budgets WHERE month = ? ORDER BY used_acu DESC LIMIT 50').all(monthKey()) as any[]).map((b) => ({
      scope: b.scope,
      scopeId: b.scope_id,
      budget: b.budget_acu,
      used: b.used_acu,
      overage: b.overage,
    })),
  };
}
/** Monthly reconciliation of the margin floor: alerts administrators when realised margin fell below it. */
export function reconcileMargin(month = monthKey()): { month: string; margin: number | null; belowFloor: boolean; revenueMicros: number; costMicros: number } {
  const r = getDb()
    .prepare('SELECT SUM(raw_cost_micros) cost, SUM(acu_revenue_micros) rev FROM ai_usage_ledger WHERE created_at >= ? AND created_at < ?')
    .get(`${month}-01`, `${month}-31T23:59:59.999Z`) as any;
  const cost = r?.cost ?? 0;
  const rev = r?.rev ?? 0;
  const margin = rev > 0 ? marginOf(rev, cost) : null;
  const below = margin !== null && margin < getAcuPolicy().minGrossMargin;
  recordEvent('admin', `ai-margin:${month}`, 'ai.margin_reconciled', { type: 'system' }, { month, margin, cost, rev, belowFloor: below });
  return { month, margin, belowFloor: below, revenueMicros: rev, costMicros: cost };
}
