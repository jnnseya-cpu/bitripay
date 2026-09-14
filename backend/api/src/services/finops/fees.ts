/**
 * Versioned fee schedules. The flat `fees` setting stays the platform default; schedules layer on top by scope —
 * platform, country, tier, merchant — with effective dates, draft/approve/activate (author ≠ approver) and a full
 * history. Fee resolution is deterministic and explainable: it returns the rule and where it came from. Amounts are
 * in basis points plus a fixed part in base-currency minor units, with optional per-transaction min and max.
 */
import { getDb } from '../../db';
import { now, shortCode } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { getFees, getSetting, setSetting } from '../settings';
import { recordEvent } from '../events';
import { FEE_TYPES } from '@bitripay/shared';

export interface FeeRule {
  fixed: number;
  bps: number;
  /** Floor and cap in base-currency minor units (0 = none). */
  min?: number;
  max?: number;
}
export type FeeScope = 'platform' | 'country' | 'tier' | 'merchant';
export interface FeeScheduleView {
  id: string;
  version: number;
  scope: FeeScope;
  scopeRef: string | null;
  rules: Record<string, FeeRule>;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: 'DRAFT' | 'APPROVED' | 'ACTIVE' | 'RETIRED';
  authorId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  notes: string | null;
  createdAt: string;
}
const toView = (r: any): FeeScheduleView => ({
  id: r.id,
  version: r.version,
  scope: r.scope,
  scopeRef: r.scope_ref,
  rules: parseJson(r.rules, {}),
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
  status: r.status,
  authorId: r.author_id,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at,
  notes: r.notes,
  createdAt: r.created_at,
});

export function listFeeSchedules(filter: { scope?: FeeScope | null; scopeRef?: string | null; status?: string | null } = {}): FeeScheduleView[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.scope) {
    where.push('scope = ?');
    params.push(filter.scope);
  }
  if (filter.scopeRef) {
    where.push('scope_ref = ?');
    params.push(filter.scopeRef);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  return (
    getDb()
      .prepare(`SELECT * FROM fee_schedules ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY scope, scope_ref, version DESC`)
      .all(...params) as any[]
  ).map(toView);
}
export function getFeeSchedule(id: string): FeeScheduleView {
  const r = getDb().prepare('SELECT * FROM fee_schedules WHERE id = ?').get(id);
  if (!r) throw notFound('Fee schedule not found', 'fee_schedule_not_found');
  return toView(r);
}

export function createFeeSchedule(
  input: { scope: FeeScope; scopeRef?: string | null; rules: Record<string, Partial<FeeRule>>; effectiveFrom?: string | null; effectiveTo?: string | null; notes?: string | null },
  authorId: string,
): FeeScheduleView {
  if (input.scope !== 'platform' && !input.scopeRef) throw badRequest(`${input.scope} schedules need a scope reference (country code, tier name or merchant id)`, 'scope_ref_required');
  const rules: Record<string, FeeRule> = {};
  for (const [type, rule] of Object.entries(input.rules)) {
    if (!(FEE_TYPES as readonly string[]).includes(type)) throw badRequest(`Unknown fee type ${type}`, 'unknown_fee_type');
    const fixed = Math.max(0, Math.round(rule.fixed ?? 0));
    const bps = Math.max(0, Math.round(rule.bps ?? 0));
    if (bps > 10_000) throw badRequest('bps cannot exceed 10000', 'invalid_bps');
    rules[type] = { fixed, bps, min: Math.max(0, Math.round(rule.min ?? 0)), max: Math.max(0, Math.round(rule.max ?? 0)) };
  }
  if (!Object.keys(rules).length) throw badRequest('A schedule needs at least one rule', 'rules_required');
  const db = getDb();
  const version = ((db.prepare('SELECT MAX(version) v FROM fee_schedules WHERE scope = ? AND scope_ref IS ?').get(input.scope, input.scopeRef ?? null) as any).v ?? 0) + 1;
  const id = `fs_${shortCode(12).toLowerCase()}`;
  db.prepare('INSERT INTO fee_schedules (id, version, scope, scope_ref, rules, effective_from, effective_to, status, author_id, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    version,
    input.scope,
    input.scopeRef ?? null,
    JSON.stringify(rules),
    input.effectiveFrom ?? now(),
    input.effectiveTo ?? null,
    'DRAFT',
    authorId,
    input.notes ?? null,
    now(),
  );
  recordEvent('ledger', id, 'fee_schedule.drafted', { type: 'admin', id: authorId }, { scope: input.scope, scopeRef: input.scopeRef ?? null, version });
  return getFeeSchedule(id);
}

export function approveFeeSchedule(id: string, approverId: string): FeeScheduleView {
  const s = getFeeSchedule(id);
  if (s.status !== 'DRAFT') throw conflict(`Schedule is ${s.status}`, 'schedule_not_draft');
  if (s.authorId === approverId) throw conflict('The approver must differ from the author', 'approver_required');
  getDb().prepare("UPDATE fee_schedules SET status = 'APPROVED', approved_by = ?, approved_at = ? WHERE id = ?").run(approverId, now(), id);
  recordEvent('ledger', id, 'fee_schedule.approved', { type: 'admin', id: approverId }, { version: s.version });
  return getFeeSchedule(id);
}

/** Activation retires the previously active schedule of the same scope; history is never rewritten. */
export function activateFeeSchedule(id: string, adminId: string): FeeScheduleView {
  const s = getFeeSchedule(id);
  if (s.status !== 'APPROVED') throw conflict('Only approved schedules can be activated', 'schedule_not_approved');
  const db = getDb();
  db.transaction(() => {
    db.prepare("UPDATE fee_schedules SET status = 'RETIRED', effective_to = COALESCE(effective_to, ?) WHERE scope = ? AND scope_ref IS ? AND status = 'ACTIVE'").run(now(), s.scope, s.scopeRef);
    db.prepare("UPDATE fee_schedules SET status = 'ACTIVE' WHERE id = ?").run(id);
  })();
  recordEvent('ledger', id, 'fee_schedule.activated', { type: 'admin', id: adminId }, { scope: s.scope, scopeRef: s.scopeRef, version: s.version });
  return getFeeSchedule(id);
}

export function retireFeeSchedule(id: string, adminId: string): FeeScheduleView {
  const s = getFeeSchedule(id);
  getDb().prepare("UPDATE fee_schedules SET status = 'RETIRED', effective_to = COALESCE(effective_to, ?) WHERE id = ?").run(now(), id);
  recordEvent('ledger', id, 'fee_schedule.retired', { type: 'admin', id: adminId }, { version: s.version });
  return getFeeSchedule(id);
}

export interface FeeContext {
  userId?: string | null;
  country?: string | null;
  tier?: string | null;
}
export interface ResolvedFee {
  rule: FeeRule;
  source: { scope: FeeScope | 'settings'; scheduleId: string | null; version: number | null };
}

function activeFor(scope: FeeScope, scopeRef: string | null, type: string): FeeScheduleView | null {
  const t = now();
  const r = getDb()
    .prepare(
      "SELECT * FROM fee_schedules WHERE scope = ? AND scope_ref IS ? AND status = 'ACTIVE' AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?) ORDER BY version DESC LIMIT 1",
    )
    .get(scope, scopeRef, t, t) as any;
  if (!r) return null;
  const v = toView(r);
  return v.rules[type] ? v : null;
}

/** Precedence: merchant > tier > country > platform schedule > flat settings. */
export function resolveFeeRule(type: string, ctx: FeeContext = {}): ResolvedFee | null {
  const tier = ctx.tier ?? (ctx.userId ? ((getDb().prepare('SELECT fee_tier FROM users WHERE id = ?').get(ctx.userId) as any)?.fee_tier ?? null) : null);
  const country = ctx.country ?? (ctx.userId ? ((getDb().prepare('SELECT country FROM users WHERE id = ?').get(ctx.userId) as any)?.country ?? null) : null);
  const chain: [FeeScope, string | null][] = [
    ['merchant', ctx.userId ?? null],
    ['tier', tier],
    ['country', country ? country.toUpperCase() : null],
    ['platform', null],
  ];
  for (const [scope, ref] of chain) {
    if (scope !== 'platform' && !ref) continue;
    const s = activeFor(scope, ref, type);
    if (s) return { rule: s.rules[type], source: { scope, scheduleId: s.id, version: s.version } };
  }
  const flat = getFees()[type];
  if (!flat) return null;
  return { rule: { fixed: flat.fixed, bps: flat.bps }, source: { scope: 'settings', scheduleId: null, version: null } };
}

/** What a merchant will pay, per fee type, with provenance (merchant dashboard and developer portal). */
export function effectiveFees(ctx: FeeContext): { type: string; rule: FeeRule; source: ResolvedFee['source'] }[] {
  return FEE_TYPES.map((type) => {
    const r = resolveFeeRule(type, ctx);
    return r ? { type, rule: r.rule, source: r.source } : { type, rule: { fixed: 0, bps: 0 }, source: { scope: 'settings' as const, scheduleId: null, version: null } };
  });
}

/** Financial-operations settings: the tax applied to the BitriPay fee (VAT / digital-services tax), tax-inclusive. */
export interface FinopsSettings {
  /** Basis points of tax contained in every BitriPay fee (0 = no tax configured). */
  feeTaxRateBps: number;
  /** Label printed on statements next to the tax line (VAT, DST, …). */
  feeTaxLabel: string;
}
const DEFAULT_FINOPS: FinopsSettings = { feeTaxRateBps: 0, feeTaxLabel: 'VAT' };
export const getFinopsSettings = (): FinopsSettings => ({ ...DEFAULT_FINOPS, ...getSetting<Partial<FinopsSettings>>('finops', {}) });

/**
 * Tax on the BitriPay fee (VAT / digital-services tax), in basis points. Read from the `finops` setting
 * (`feeTaxRateBps`), falling back to a `taxRateBps` on the `fees` setting; tax-inclusive: the fee charged already
 * contains it. 0 when no rate is configured.
 */
export function feeTaxRateBps(): number {
  const configured = getFinopsSettings().feeTaxRateBps;
  const raw = configured || (getSetting<Record<string, unknown>>('fees', {}) as Record<string, unknown>).taxRateBps;
  const bps = Number(raw ?? 0);
  return Number.isFinite(bps) && bps > 0 ? Math.min(10_000, Math.round(bps)) : 0;
}

/** Administrative change of the fee tax rate (and its label); every change is recorded in the event log. */
export function setFeeTaxRate(input: { feeTaxRateBps: number; feeTaxLabel?: string | null }, adminId: string): FinopsSettings {
  if (!Number.isInteger(input.feeTaxRateBps) || input.feeTaxRateBps < 0 || input.feeTaxRateBps > 10_000) throw badRequest('feeTaxRateBps must be an integer between 0 and 10000', 'invalid_tax_rate');
  const previous = getFinopsSettings();
  const next: FinopsSettings = { ...previous, feeTaxRateBps: input.feeTaxRateBps, feeTaxLabel: input.feeTaxLabel?.trim() || previous.feeTaxLabel };
  setSetting('finops', next);
  recordEvent('ledger', 'finops', 'finops.fee_tax_rate.set', { type: 'admin', id: adminId }, { previous, next });
  return next;
}

/**
 * Break a fee charged by the platform into the BitriPay fee proper and the tax it contains, so statements never
 * show one blended figure. Tax-inclusive: `platformFeeMinor + feeTaxMinor === feeMinor`.
 */
export function splitFeeTax(feeMinor: number, taxRateBps = feeTaxRateBps()): { platformFeeMinor: number; feeTaxMinor: number; taxRateBps: number } {
  const total = Math.max(0, Math.round(feeMinor));
  if (!taxRateBps) return { platformFeeMinor: total, feeTaxMinor: 0, taxRateBps: 0 };
  const platformFeeMinor = Math.round((total * 10_000) / (10_000 + taxRateBps));
  return { platformFeeMinor, feeTaxMinor: total - platformFeeMinor, taxRateBps };
}

export function setFeeTier(userId: string, tier: string | null, adminId: string): void {
  getDb().prepare('UPDATE users SET fee_tier = ? WHERE id = ?').run(tier, userId);
  recordEvent('ledger', userId, 'fee_tier.set', { type: 'admin', id: adminId }, { tier });
}
