/**
 * Policy engine: decides, for one agent acting for one account holder, whether a tool call is allowed, denied or
 * needs a checker. Rules are declarative (agent_policies) and layered: global → agent → account. Permissions are the
 * intersection of the agent's tool list, the account holder's role and (for administrators) their admin permissions.
 * The forbidden list is not a policy: those capabilities are not tools, and asking for them is always denied.
 */
import { getDb } from '../../db';
import { uuid, now } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { hasPermission } from '../../middleware/permissions';
import type { UserRow } from '../users';
import { getAgentDef } from './registry';
import { TOOL_BY_NAME } from './tools';
import { getAssistSettings } from '../settings';

export interface PolicyRules {
  /** Tools this scope may never call. */
  deny?: string[];
  /** Tools that need a checker's approval in this scope (in addition to tools flagged requiresApproval). */
  requireApproval?: string[];
  /** When present, only these tools may be called in this scope. */
  allow?: string[];
  /** Per-run and per-day ceilings. */
  maxStepsPerRun?: number;
  maxRunsPerDay?: number;
}
export interface PolicyRow {
  id: string;
  scope: 'global' | 'agent' | 'user';
  scopeId: string;
  version: number;
  rules: PolicyRules;
  status: 'live' | 'retired';
  note: string | null;
  authorAdminId: string | null;
  createdAt: string;
}

/** Capabilities that are never exposed as tools. Named so a denial can say why. */
export const FORBIDDEN = ['emoney.issue', 'emoney.mint', 'wallets.unfreeze', 'wallets.adjust', 'transfers.send', 'payouts.release', 'payouts.approve', 'corridors.set_status', 'api_keys.create', 'kyc.approve', 'sanctions.clear', 'settings.write'];

const toRow = (r: any): PolicyRow => ({ id: r.id, scope: r.scope, scopeId: r.scope_id, version: r.version, rules: parseJson<PolicyRules>(r.rules, {}), status: r.status, note: r.note, authorAdminId: r.author_admin_id, createdAt: r.created_at });

export function listPolicies(includeRetired = false): PolicyRow[] {
  return (getDb().prepare(`SELECT * FROM agent_policies ${includeRetired ? '' : "WHERE status = 'live'"} ORDER BY scope, scope_id, version DESC`).all() as any[]).map(toRow);
}
export function livePolicy(scope: PolicyRow['scope'], scopeId: string): PolicyRow | null {
  const r = getDb().prepare("SELECT * FROM agent_policies WHERE scope = ? AND scope_id = ? AND status = 'live' ORDER BY version DESC LIMIT 1").get(scope, scopeId);
  return r ? toRow(r) : null;
}
/** Publishing a policy retires the previous live version for the same scope; history is kept. */
export function publishPolicy(scope: PolicyRow['scope'], scopeId: string, rules: PolicyRules, adminId: string, note?: string | null): PolicyRow {
  const db = getDb();
  const clean: PolicyRules = {};
  const names = (xs?: string[]) => (Array.isArray(xs) ? xs.map(String).filter((n) => TOOL_BY_NAME.has(n) || FORBIDDEN.includes(n)) : undefined);
  if (rules.deny) clean.deny = names(rules.deny);
  if (rules.requireApproval) clean.requireApproval = names(rules.requireApproval);
  if (rules.allow) clean.allow = names(rules.allow);
  if (rules.maxStepsPerRun) clean.maxStepsPerRun = Math.max(1, Math.min(20, Number(rules.maxStepsPerRun)));
  if (rules.maxRunsPerDay) clean.maxRunsPerDay = Math.max(1, Math.min(10_000, Number(rules.maxRunsPerDay)));
  const prev = livePolicy(scope, scopeId);
  const id = uuid();
  db.transaction(() => {
    if (prev) db.prepare("UPDATE agent_policies SET status = 'retired' WHERE id = ?").run(prev.id);
    db.prepare('INSERT INTO agent_policies (id, scope, scope_id, version, rules, status, note, author_admin_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, scope, scopeId, (prev?.version ?? 0) + 1, JSON.stringify(clean), 'live', note ?? null, adminId, now());
  })();
  return toRow(db.prepare('SELECT * FROM agent_policies WHERE id = ?').get(id));
}

export interface EffectivePolicy {
  deny: Set<string>;
  requireApproval: Set<string>;
  allow: Set<string> | null;
  maxStepsPerRun: number;
  maxRunsPerDay: number;
  layers: { scope: string; scopeId: string; version: number }[];
}
export function effectivePolicy(agentKey: string, userId: string): EffectivePolicy {
  const settings = getAssistSettings();
  const out: EffectivePolicy = { deny: new Set(FORBIDDEN), requireApproval: new Set(), allow: null, maxStepsPerRun: settings.maxStepsPerRun, maxRunsPerDay: 200, layers: [] };
  for (const [scope, scopeId] of [['global', '*'], ['agent', agentKey], ['user', userId]] as const) {
    const p = livePolicy(scope, scopeId);
    if (!p) continue;
    out.layers.push({ scope, scopeId, version: p.version });
    for (const t of p.rules.deny ?? []) out.deny.add(t);
    for (const t of p.rules.requireApproval ?? []) out.requireApproval.add(t);
    if (p.rules.allow) out.allow = out.allow ? new Set([...out.allow].filter((t) => p.rules.allow!.includes(t))) : new Set(p.rules.allow);
    if (p.rules.maxStepsPerRun) out.maxStepsPerRun = Math.min(out.maxStepsPerRun, p.rules.maxStepsPerRun);
    if (p.rules.maxRunsPerDay) out.maxRunsPerDay = Math.min(out.maxRunsPerDay, p.rules.maxRunsPerDay);
  }
  return out;
}

export type Decision = { verdict: 'allow' | 'deny' | 'approval'; reason: string; permission?: string | null };

/** The single authorisation point for tool calls, for humans triggering agents and for scheduled runs alike. */
export function decide(agentKey: string, user: UserRow, toolName: string, policy = effectivePolicy(agentKey, user.id)): Decision {
  if (FORBIDDEN.includes(toolName) || policy.deny.has(toolName) && FORBIDDEN.includes(toolName)) return { verdict: 'deny', reason: 'This capability is never available to agents. A person does it in the app under the usual controls.' };
  const tool = TOOL_BY_NAME.get(toolName);
  if (!tool) return { verdict: 'deny', reason: `Unknown tool ${toolName}` };
  const agent = getAgentDef(agentKey);
  if (!agent) return { verdict: 'deny', reason: 'Unknown agent' };
  if (!agent.tools.includes(toolName)) return { verdict: 'deny', reason: `The ${agent.name} agent is not allowed to use ${toolName}` };
  if (!tool.roles.includes(user.role)) return { verdict: 'deny', reason: `${toolName} is not available for ${user.role} accounts` };
  if (tool.permission && !hasPermission(user as any, tool.permission)) return { verdict: 'deny', reason: `Missing admin permission: ${tool.permission}`, permission: tool.permission };
  if (policy.deny.has(toolName)) return { verdict: 'deny', reason: 'Denied by policy' };
  if (policy.allow && !policy.allow.has(toolName)) return { verdict: 'deny', reason: 'Not on the allow list of the active policy' };
  if (tool.requiresApproval || policy.requireApproval.has(toolName)) return { verdict: 'approval', reason: 'Needs a second administrator to approve', permission: tool.permission ?? null };
  return { verdict: 'allow', reason: 'ok', permission: tool.permission ?? null };
}

/** Tools an agent can actually use for this account holder (used to build the model's tool list). */
export function usableTools(agentKey: string, user: UserRow) {
  const policy = effectivePolicy(agentKey, user.id);
  const agent = getAgentDef(agentKey);
  if (!agent) return { policy, tools: [] as string[] };
  return { policy, tools: agent.tools.filter((t) => decide(agentKey, user, t, policy).verdict !== 'deny') };
}
