/**
 * Central risk policy: one versioned rule set decides what happens to a money movement once the fraud score and
 * the flags are known. Rules are evaluated in order and the first match wins, so every decision is explainable
 * ("rule FRD-003 of policy v2: score 74 ≥ 61 → review"). Policies are drafted, approved by a different
 * administrator and activated; the previous version is retired, never rewritten.
 */
import { getDb } from '../../db';
import { now, shortCode } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { recordEvent } from '../events';

export type RiskAction = 'allow' | 'step_up' | 'review' | 'block';
export interface RiskRule {
  id: string;
  description: string;
  when: {
    kinds?: string[];
    /** Base-currency minor units. */
    minBase?: number | null;
    maxBase?: number | null;
    minScore?: number | null;
    maxScore?: number | null;
    kycTiers?: number[];
    countries?: string[];
    methods?: string[];
    newBeneficiary?: boolean | null;
    /** Any flag starting with one of these prefixes (e.g. "sanctions", "velocity:hour"). */
    flags?: string[];
  };
  action: RiskAction;
  reason: string;
}
export interface RiskPolicyView {
  id: string;
  version: number;
  name: string;
  rules: RiskRule[];
  status: 'DRAFT' | 'APPROVED' | 'ACTIVE' | 'RETIRED';
  authorId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  activatedAt: string | null;
  retiredAt: string | null;
  notes: string | null;
  createdAt: string;
}
const toView = (r: any): RiskPolicyView => ({ id: r.id, version: r.version, name: r.name, rules: parseJson(r.rules, []), status: r.status, authorId: r.author_id, approvedBy: r.approved_by, approvedAt: r.approved_at, activatedAt: r.activated_at, retiredAt: r.retired_at, notes: r.notes, createdAt: r.created_at });

/** The default policy encodes the fraud bands: 0–30 approve, 31–60 step-up, 61–80 manual review, 81–100 block. */
export const DEFAULT_RULES: RiskRule[] = [
  { id: 'SAN-001', description: 'Sanctions or PEP-with-block hit on any party', when: { flags: ['sanctions:'] }, action: 'block', reason: 'sanctions_hit' },
  { id: 'BEN-001', description: 'New beneficiary above the cooling-off amount', when: { flags: ['cooling_off:'] }, action: 'block', reason: 'cooling_off' },
  { id: 'FRD-004', description: 'Fraud score 81–100', when: { minScore: 81 }, action: 'block', reason: 'fraud_block' },
  { id: 'FRD-003', description: 'Fraud score 61–80', when: { minScore: 61, maxScore: 80 }, action: 'review', reason: 'fraud_review' },
  { id: 'FRD-002', description: 'Fraud score 31–60', when: { minScore: 31, maxScore: 60 }, action: 'step_up', reason: 'fraud_step_up' },
  { id: 'FRD-001', description: 'Fraud score 0–30', when: { maxScore: 30 }, action: 'allow', reason: 'clear' },
];

function validateRules(rules: RiskRule[]) {
  if (!Array.isArray(rules) || !rules.length) throw badRequest('A policy needs at least one rule', 'validation_error');
  const ids = new Set<string>();
  for (const r of rules) {
    if (!r.id || !/^[A-Z]{2,5}-\d{3}$/.test(r.id)) throw badRequest(`Rule id ${r.id} must look like FRD-001`, 'validation_error');
    if (ids.has(r.id)) throw badRequest(`Duplicate rule id ${r.id}`, 'validation_error');
    ids.add(r.id);
    if (!['allow', 'step_up', 'review', 'block'].includes(r.action)) throw badRequest(`Rule ${r.id}: unknown action ${r.action}`, 'validation_error');
    if (!r.when || typeof r.when !== 'object') throw badRequest(`Rule ${r.id}: missing conditions`, 'validation_error');
  }
  if (!rules.some((r) => r.action === 'allow' && !r.when.minScore && !r.when.flags?.length && !r.when.kinds?.length)) throw badRequest('The last rule must be an unconditional or score-only allow so every movement gets a decision', 'validation_error');
}

export function ensureDefaultPolicy(): RiskPolicyView {
  const db = getDb();
  const active = db.prepare("SELECT * FROM risk_policies WHERE status = 'ACTIVE' LIMIT 1").get();
  if (active) return toView(active);
  const id = `rp_${shortCode(10).toLowerCase()}`;
  db.prepare("INSERT INTO risk_policies (id, version, name, rules, status, author_id, approved_by, approved_at, activated_at, notes, created_at) VALUES (?, 1, 'Fraud bands (default)', ?, 'ACTIVE', NULL, NULL, ?, ?, 'Seeded default: 0–30 allow, 31–60 step-up, 61–80 review, 81–100 block; sanctions and cooling-off block.', ?)").run(id, JSON.stringify(DEFAULT_RULES), now(), now(), now());
  return toView(db.prepare('SELECT * FROM risk_policies WHERE id = ?').get(id));
}

export function listPolicies(): RiskPolicyView[] {
  return (getDb().prepare('SELECT * FROM risk_policies ORDER BY version DESC').all() as any[]).map(toView);
}
export function getPolicy(id: string): RiskPolicyView {
  const r = getDb().prepare('SELECT * FROM risk_policies WHERE id = ?').get(id);
  if (!r) throw notFound('Risk policy not found', 'policy_not_found');
  return toView(r);
}
export function activePolicy(): RiskPolicyView {
  return ensureDefaultPolicy();
}
export function createPolicyDraft(input: { name: string; rules: RiskRule[]; notes?: string | null }, authorId: string): RiskPolicyView {
  validateRules(input.rules);
  const db = getDb();
  const version = ((db.prepare('SELECT MAX(version) v FROM risk_policies').get() as any).v ?? 0) + 1;
  const id = `rp_${shortCode(10).toLowerCase()}`;
  db.prepare('INSERT INTO risk_policies (id, version, name, rules, status, author_id, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, version, input.name, JSON.stringify(input.rules), 'DRAFT', authorId, input.notes ?? null, now());
  recordEvent('risk', id, 'risk_policy.drafted', { type: 'admin', id: authorId }, { version, rules: input.rules.length });
  return getPolicy(id);
}
export function approvePolicy(id: string, approverId: string): RiskPolicyView {
  const p = getPolicy(id);
  if (p.status !== 'DRAFT') throw conflict(`Policy is ${p.status}`, 'policy_not_draft');
  if (p.authorId === approverId) throw conflict('The approver must differ from the author', 'approver_required');
  getDb().prepare("UPDATE risk_policies SET status = 'APPROVED', approved_by = ?, approved_at = ? WHERE id = ?").run(approverId, now(), id);
  recordEvent('risk', id, 'risk_policy.approved', { type: 'admin', id: approverId }, { version: p.version });
  return getPolicy(id);
}
export function activatePolicy(id: string, adminId: string): RiskPolicyView {
  const p = getPolicy(id);
  if (p.status !== 'APPROVED') throw conflict(`Policy is ${p.status}; approve it first`, 'policy_not_approved');
  const db = getDb();
  db.transaction(() => {
    db.prepare("UPDATE risk_policies SET status = 'RETIRED', retired_at = ? WHERE status = 'ACTIVE'").run(now());
    db.prepare("UPDATE risk_policies SET status = 'ACTIVE', activated_at = ? WHERE id = ?").run(now(), id);
  })();
  recordEvent('risk', id, 'risk_policy.activated', { type: 'admin', id: adminId }, { version: p.version });
  return getPolicy(id);
}

export interface PolicyContext {
  kind: string;
  baseMinor: number;
  score: number;
  kycTier?: number | null;
  country?: string | null;
  method?: string | null;
  newBeneficiary?: boolean | null;
  flags: string[];
}
export interface PolicyDecision {
  action: RiskAction;
  rule: RiskRule | null;
  policyId: string;
  version: number;
  reason: string;
}
function matches(rule: RiskRule, ctx: PolicyContext): boolean {
  const w = rule.when;
  if (w.kinds?.length && !w.kinds.includes(ctx.kind)) return false;
  if (w.minBase != null && ctx.baseMinor < w.minBase) return false;
  if (w.maxBase != null && ctx.baseMinor > w.maxBase) return false;
  if (w.minScore != null && ctx.score < w.minScore) return false;
  if (w.maxScore != null && ctx.score > w.maxScore) return false;
  if (w.kycTiers?.length && !w.kycTiers.includes(ctx.kycTier ?? 0)) return false;
  if (w.countries?.length && !w.countries.includes((ctx.country ?? '').toUpperCase())) return false;
  if (w.methods?.length && !w.methods.includes(ctx.method ?? '')) return false;
  if (w.newBeneficiary != null && !!ctx.newBeneficiary !== w.newBeneficiary) return false;
  if (w.flags?.length && !w.flags.some((prefix) => ctx.flags.some((f) => f.startsWith(prefix)))) return false;
  return true;
}
/** Decide with the active policy; explainable and deterministic. */
export function evaluatePolicy(ctx: PolicyContext, policy = activePolicy()): PolicyDecision {
  for (const rule of policy.rules) if (matches(rule, ctx)) return { action: rule.action, rule, policyId: policy.id, version: policy.version, reason: rule.reason };
  return { action: 'allow', rule: null, policyId: policy.id, version: policy.version, reason: 'no_rule_matched' };
}
/** Dry run for the console: what would the policy (active or a draft) decide for this context? */
export function simulatePolicy(ctx: PolicyContext, policyId?: string | null): PolicyDecision {
  return evaluatePolicy(ctx, policyId ? getPolicy(policyId) : activePolicy());
}
