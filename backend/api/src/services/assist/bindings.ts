/**
 * Agent mesh bindings (Part VII): which agent wakes on which surface event, with an autonomy tier. Every binding
 * starts in **shadow** mode (the agent reads, reasons and writes its findings; side-effecting tools are refused),
 * can be promoted to **propose** after ninety days of shadow operation (or earlier by an administrator with a
 * recorded reason), where proposals go through the ordinary maker-checker approvals, and never beyond: money
 * moves only when a person confirms. Each binding has its own kill switch; the global one still wins.
 */
import { getDb } from '../../db';
import { now, shortCode } from '../../lib/ids';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { recordEvent } from '../events';
import { subscribe, type DomainEvent } from '../bus';
import { getAssistSettings } from '../settings';
import { startRun } from './runtime';
import { getAgentDef } from './registry';
import type { UserRow } from '../users';

export type Autonomy = 'shadow' | 'propose';
export interface Binding {
  id: string;
  eventType: string;
  agentKey: string;
  registryId: string;
  autonomy: Autonomy;
  enabled: boolean;
  shadowSince: string;
  promotedAt: string | null;
  promotedBy: string | null;
  killSwitch: boolean;
  runs: number;
  lastRunAt: string | null;
  createdAt: string;
  eligibleForPromotionAt: string;
}
export const SHADOW_DAYS = 90;
const toView = (r: any): Binding => ({ id: r.id, eventType: r.event_type, agentKey: r.agent_key, registryId: r.registry_id, autonomy: r.autonomy, enabled: !!r.enabled, shadowSince: r.shadow_since, promotedAt: r.promoted_at, promotedBy: r.promoted_by, killSwitch: !!r.kill_switch, runs: r.runs, lastRunAt: r.last_run_at, createdAt: r.created_at, eligibleForPromotionAt: new Date(Date.parse(r.shadow_since) + SHADOW_DAYS * 86_400_000).toISOString() });

/** The canonical table of surface events → agents (registry ids per the master spec). */
export const DEFAULT_BINDINGS: { eventType: string; agentKey: string; registryId: string }[] = [
  { eventType: 'transaction.fraud_scored', agentKey: 'fraud_scorer', registryId: 'PR-F01' },
  { eventType: 'attempt.unknown', agentKey: 'retry_surgeon', registryId: 'PR-E02' },
  { eventType: 'statement.imported', agentKey: 'recon', registryId: 'PR-B01' },
  { eventType: 'recon.exception_aged', agentKey: 'exception_hunter', registryId: 'PR-B03' },
  { eventType: 'verification.requested', agentKey: 'koda_core', registryId: 'PR-A02' },
  { eventType: 'dispute.opened', agentKey: 'dispute_arbiter', registryId: 'PR-F02' },
  { eventType: 'diaspora.quote_created', agentKey: 'fx_oracle', registryId: 'PR-C02' },
  { eventType: 'agent.float_low', agentKey: 'rebalancer', registryId: 'PR-C03' },
  { eventType: 'connector.degraded', agentKey: 'connector_medic', registryId: 'PR-E01' },
  { eventType: 'merchant.created', agentKey: 'onboarding', registryId: 'PR-A01' },
  { eventType: 'sanctions.hit', agentKey: 'sanctions_sentinel', registryId: 'PR-D02' },
];
export function ensureDefaultBindings(): void {
  const db = getDb();
  const ins = db.prepare('INSERT OR IGNORE INTO agent_bindings (id, event_type, agent_key, registry_id, autonomy, enabled, shadow_since, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)');
  for (const b of DEFAULT_BINDINGS) ins.run(`bd_${shortCode(10).toLowerCase()}`, b.eventType, b.agentKey, b.registryId, 'shadow', now(), now());
}
export function listBindings(): Binding[] {
  return (getDb().prepare('SELECT * FROM agent_bindings ORDER BY registry_id').all() as any[]).map(toView);
}
export function getBinding(id: string): Binding {
  const r = getDb().prepare('SELECT * FROM agent_bindings WHERE id = ?').get(id);
  if (!r) throw notFound('Binding not found', 'binding_not_found');
  return toView(r);
}
export function setBindingEnabled(id: string, enabled: boolean, adminId: string): Binding {
  getBinding(id);
  getDb().prepare('UPDATE agent_bindings SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  recordEvent('admin', id, enabled ? 'binding.enabled' : 'binding.disabled', { type: 'admin', id: adminId }, {});
  return getBinding(id);
}
export function setBindingKillSwitch(id: string, on: boolean, adminId: string, reason?: string | null): Binding {
  getBinding(id);
  getDb().prepare('UPDATE agent_bindings SET kill_switch = ? WHERE id = ?').run(on ? 1 : 0, id);
  recordEvent('admin', id, on ? 'binding.kill_switch.on' : 'binding.kill_switch.off', { type: 'admin', id: adminId }, { reason: reason ?? null });
  return getBinding(id);
}
/** Promote shadow → propose after the shadow period, or earlier with a recorded override reason. */
export function promoteBinding(id: string, adminId: string, override?: string | null): Binding {
  const b = getBinding(id);
  if (b.autonomy !== 'shadow') throw conflict('Binding is already promoted', 'already_promoted');
  const eligible = Date.now() >= Date.parse(b.eligibleForPromotionAt);
  if (!eligible && !override) throw badRequest(`Shadow mode runs for ${SHADOW_DAYS} days (eligible ${b.eligibleForPromotionAt.slice(0, 10)}); give an override reason to promote earlier`, 'shadow_period_active', { eligibleAt: b.eligibleForPromotionAt, runs: b.runs });
  getDb().prepare("UPDATE agent_bindings SET autonomy = 'propose', promoted_at = ?, promoted_by = ? WHERE id = ?").run(now(), adminId, id);
  recordEvent('admin', id, 'binding.promoted', { type: 'admin', id: adminId }, { from: 'shadow', to: 'propose', override: override ?? null, runsInShadow: b.runs });
  return getBinding(id);
}
export function demoteBinding(id: string, adminId: string, reason: string): Binding {
  getBinding(id);
  getDb().prepare("UPDATE agent_bindings SET autonomy = 'shadow', shadow_since = ?, promoted_at = NULL, promoted_by = NULL WHERE id = ?").run(now(), id);
  recordEvent('admin', id, 'binding.demoted', { type: 'admin', id: adminId }, { reason });
  return getBinding(id);
}

function operatorUser(): UserRow | undefined {
  return getDb().prepare("SELECT * FROM users WHERE role = 'admin' AND is_system = 0 AND status = 'active' AND (permissions IS NULL OR permissions = '' OR permissions = '[]' OR permissions = '*') ORDER BY created_at ASC LIMIT 1").get() as UserRow | undefined;
}
function describeEvent(ev: DomainEvent): string {
  const p = ev.payload as Record<string, unknown>;
  switch (ev.type) {
    case 'attempt.unknown': return `Payment attempt ${p.attemptId ?? ''} on intent ${p.intentId ?? ev.aggregateId} via ${p.connector ?? 'unknown connector'} ended UNKNOWN. Own the ambiguity window: inspect, recover with inquiries only, never re-push.`;
    case 'connector.degraded': return `Connector ${p.connector ?? ev.aggregateId} opened its circuit after ${p.failures ?? '?'} consecutive failures. Check health, propose a pause or reroute, and describe the incident.`;
    case 'dispute.opened': return `Dispute ${ev.aggregateId} opened (${p.reasonCode ?? ''}, ${p.amountMinor ?? ''} ${p.currency ?? ''}). Summarise both sides and propose a ruling for a human to confirm.`;
    case 'agent.float_low': return `Agent ${p.agentId ?? ev.aggregateId} float is ${p.status ?? 'low'} in ${p.currency ?? ''} (runway ${p.runwayDays ?? '?'} days). Recommend a refill within the envelope.`;
    case 'recon.exception_aged': return `Reconciliation case ${ev.aggregateId} (${p.class ?? ''}) is older than 24 hours. Build the evidence pack and propose a resolution for approval.`;
    case 'statement.imported': return `Statement ${ev.aggregateId} imported for ${p.connectionId ?? p.gatewayId ?? ''} (${p.lines ?? '?'} lines). Review the run and the exceptions it opened.`;
    case 'verification.requested': return `Verification ${ev.aggregateId} requested (${p.reference ?? p.msisdn ?? ''}). Confirm across the three doors and explain the result.`;
    case 'diaspora.quote_created': return `Diaspora-Direct quote ${ev.aggregateId} on ${p.pair ?? ''}. Check the rate card against the live mid-market rate and the signed policy.`;
    case 'sanctions.hit': return `Sanctions hit on account ${p.userId ?? ev.aggregateId} (${(p.hits as string[] | undefined)?.join(', ') ?? ''}). Freeze outranks everything; prepare the case for the MLRO.`;
    case 'merchant.created': return `New merchant ${ev.aggregateId}. Check verification level and draft the onboarding next steps.`;
    case 'transaction.fraud_scored': return `Movement ${ev.aggregateId} scored ${p.score ?? '?'} (${p.band ?? ''}). Explain the factors and confirm the policy decision.`;
    default: return `${ev.type} on ${ev.aggregateId ?? 'platform'}: ${JSON.stringify(p).slice(0, 300)}`;
  }
}
/** Fire the bindings for an event. Runs are asynchronous; failures never propagate into the publisher. */
export async function dispatchEvent(ev: DomainEvent): Promise<{ started: string[] }> {
  const s = getAssistSettings();
  const started: string[] = [];
  if (!s.enabled || s.killSwitch) return { started };
  const rows = (getDb().prepare('SELECT * FROM agent_bindings WHERE event_type = ? AND enabled = 1 AND kill_switch = 0').all(ev.type) as any[]).map(toView);
  if (!rows.length) return { started };
  const operator = operatorUser();
  if (!operator) return { started };
  for (const b of rows) {
    const agent = getAgentDef(b.agentKey);
    if (!agent || s.paused.includes(b.agentKey)) continue;
    try {
      const run = await startRun(operator, b.agentKey, describeEvent(ev), { trigger: 'event', triggerRef: ev.eventId, context: { event: ev.type, aggregateId: ev.aggregateId, payload: ev.payload, autonomy: b.autonomy, registryId: b.registryId }, readOnly: b.autonomy === 'shadow', wait: false });
      getDb().prepare('UPDATE agent_bindings SET runs = runs + 1, last_run_at = ? WHERE id = ?').run(now(), b.id);
      started.push(run.id);
    } catch (err) {
      console.error(`[mesh] ${b.registryId} ${b.agentKey} failed on ${ev.type}: ${(err as Error).message}`);
    }
  }
  return { started };
}
const HOOK = Symbol.for('bitripay.mesh.subscribed');
if (!(globalThis as any)[HOOK]) {
  (globalThis as any)[HOOK] = true;
  subscribe('agent-mesh', '*', (ev) => {
    void dispatchEvent(ev);
  });
}
