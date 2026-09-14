/**
 * SLA register: the commitments every counterparty (processor, mobile-money operator, national switch, bank, vendor)
 * has made — availability, latency, support and escalation contacts, maintenance window, review date, document —
 * and a comparison of those commitments with what the platform actually measured (rail health, routing statistics,
 * switch availability from the SLO roll-ups). A breach here is an observation to raise with the counterparty, never
 * an automatic action.
 */
import { z } from 'zod';
import { getDb } from '../db';
import { now, uuid } from '../lib/ids';
import { badRequest, notFound } from '../lib/errors';
import { listRails, type RailEntry } from './rails';
import { sloReport, SWITCH_AVAILABILITY_TARGET } from '../middleware/slo';

export const SLA_KINDS = ['processor', 'operator', 'switch', 'bank', 'vendor'] as const;
export type SlaKind = (typeof SLA_KINDS)[number];

export interface SlaEntry {
  id: string;
  counterparty: string;
  kind: SlaKind;
  service: string;
  railId: string | null;
  /** Committed availability as a fraction (0.9995 = 99.95 %). */
  availabilityTarget: number | null;
  latencyTargetMs: number | null;
  supportContact: string | null;
  escalationContact: string | null;
  maintenanceWindow: string | null;
  incidentContact: string | null;
  reviewDate: string | null;
  documentRef: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export const slaInputSchema = z.object({
  counterparty: z.string().min(2).max(120),
  kind: z.enum(SLA_KINDS),
  service: z.string().min(2).max(160),
  railId: z.string().max(120).optional().nullable(),
  availabilityTarget: z.number().min(0).max(1).optional().nullable(),
  latencyTargetMs: z.number().int().min(1).max(3_600_000).optional().nullable(),
  supportContact: z.string().max(300).optional().nullable(),
  escalationContact: z.string().max(300).optional().nullable(),
  maintenanceWindow: z.string().max(300).optional().nullable(),
  incidentContact: z.string().max(300).optional().nullable(),
  reviewDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  documentRef: z.string().max(300).optional().nullable(),
});
export type SlaInput = z.infer<typeof slaInputSchema>;

const toView = (r: any): SlaEntry => ({
  id: r.id,
  counterparty: r.counterparty,
  kind: r.kind,
  service: r.service,
  railId: r.rail_id ?? null,
  availabilityTarget: r.availability_target ?? null,
  latencyTargetMs: r.latency_target_ms ?? null,
  supportContact: r.support_contact ?? null,
  escalationContact: r.escalation_contact ?? null,
  maintenanceWindow: r.maintenance_window ?? null,
  incidentContact: r.incident_contact ?? null,
  reviewDate: r.review_date ?? null,
  documentRef: r.document_ref ?? null,
  createdBy: r.created_by ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function listSla(filter: { kind?: SlaKind | null; railId?: string | null } = {}): SlaEntry[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.kind) {
    where.push('kind = ?');
    params.push(filter.kind);
  }
  if (filter.railId) {
    where.push('rail_id = ?');
    params.push(filter.railId);
  }
  return (
    getDb()
      .prepare(`SELECT * FROM sla_register ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY counterparty, service`)
      .all(...params) as any[]
  ).map(toView);
}

export function getSla(id: string): SlaEntry {
  const r = getDb().prepare('SELECT * FROM sla_register WHERE id = ?').get(id);
  if (!r) throw notFound('SLA entry not found', 'sla_not_found');
  return toView(r);
}

function assertRail(railId: string | null | undefined) {
  if (!railId) return;
  if (!listRails().some((r) => r.id === railId)) throw badRequest(`Unknown rail: ${railId}`, 'unknown_rail');
}

export function createSla(input: SlaInput, createdBy: string | null): SlaEntry {
  const b = slaInputSchema.parse(input);
  assertRail(b.railId);
  const id = `sla_${uuid().replace(/-/g, '').slice(0, 16)}`;
  const t = now();
  getDb()
    .prepare(
      `INSERT INTO sla_register (id, counterparty, kind, service, rail_id, availability_target, latency_target_ms, support_contact, escalation_contact, maintenance_window, incident_contact, review_date, document_ref, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      b.counterparty,
      b.kind,
      b.service,
      b.railId ?? null,
      b.availabilityTarget ?? null,
      b.latencyTargetMs ?? null,
      b.supportContact ?? null,
      b.escalationContact ?? null,
      b.maintenanceWindow ?? null,
      b.incidentContact ?? null,
      b.reviewDate ?? null,
      b.documentRef ?? null,
      createdBy,
      t,
      t,
    );
  return getSla(id);
}

export function updateSla(id: string, patch: Partial<SlaInput>): SlaEntry {
  const current = getSla(id);
  const b = slaInputSchema.partial().parse(patch);
  if (b.railId !== undefined) assertRail(b.railId);
  const next = {
    counterparty: b.counterparty ?? current.counterparty,
    kind: b.kind ?? current.kind,
    service: b.service ?? current.service,
    railId: b.railId === undefined ? current.railId : b.railId,
    availabilityTarget: b.availabilityTarget === undefined ? current.availabilityTarget : b.availabilityTarget,
    latencyTargetMs: b.latencyTargetMs === undefined ? current.latencyTargetMs : b.latencyTargetMs,
    supportContact: b.supportContact === undefined ? current.supportContact : b.supportContact,
    escalationContact: b.escalationContact === undefined ? current.escalationContact : b.escalationContact,
    maintenanceWindow: b.maintenanceWindow === undefined ? current.maintenanceWindow : b.maintenanceWindow,
    incidentContact: b.incidentContact === undefined ? current.incidentContact : b.incidentContact,
    reviewDate: b.reviewDate === undefined ? current.reviewDate : b.reviewDate,
    documentRef: b.documentRef === undefined ? current.documentRef : b.documentRef,
  };
  getDb()
    .prepare(
      `UPDATE sla_register SET counterparty = ?, kind = ?, service = ?, rail_id = ?, availability_target = ?, latency_target_ms = ?, support_contact = ?, escalation_contact = ?, maintenance_window = ?, incident_contact = ?, review_date = ?, document_ref = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      next.counterparty,
      next.kind,
      next.service,
      next.railId,
      next.availabilityTarget,
      next.latencyTargetMs,
      next.supportContact,
      next.escalationContact,
      next.maintenanceWindow,
      next.incidentContact,
      next.reviewDate,
      next.documentRef,
      now(),
      id,
    );
  return getSla(id);
}

export function deleteSla(id: string): SlaEntry {
  const entry = getSla(id);
  getDb().prepare('DELETE FROM sla_register WHERE id = ?').run(id);
  return entry;
}

// ---------------------------------------------------------------------------------------------------------------------
// Breaches: commitments compared with what the platform observed
// ---------------------------------------------------------------------------------------------------------------------
export interface SlaMeasurement {
  /** Where the measurement came from. */
  source: 'rail_health' | 'switch_slo' | 'none';
  availability: number | null;
  p95LatencyMs: number | null;
  state: string | null;
  usable: boolean | null;
  attempts: number;
}
export interface SlaBreach {
  entry: SlaEntry;
  measured: SlaMeasurement;
  breached: boolean;
  reasons: string[];
  reviewOverdue: boolean;
}

function measure(entry: SlaEntry, rails: RailEntry[], switchAvailability: { availability: number | null; requests: number }): SlaMeasurement {
  const rail = entry.railId ? rails.find((r) => r.id === entry.railId) : null;
  if (rail) {
    return {
      source: 'rail_health',
      // connectorStats reports the success rate as a percentage with one decimal; commitments are fractions.
      availability: rail.stats.successRate == null ? null : rail.stats.successRate / 100,
      p95LatencyMs: rail.stats.p95LatencyMs,
      state: rail.health.state,
      usable: rail.health.usable,
      attempts: rail.stats.attempts,
    };
  }
  if (entry.kind === 'switch') return { source: 'switch_slo', availability: switchAvailability.availability, p95LatencyMs: null, state: null, usable: null, attempts: switchAvailability.requests };
  return { source: 'none', availability: null, p95LatencyMs: null, state: null, usable: null, attempts: 0 };
}

/** Every SLA entry with its measurement; `breached` only when a measurement exists and misses the commitment. */
export function slaBreaches(nowMs = Date.now()): { items: SlaBreach[]; breached: number; unmeasured: number; switchAvailabilityTarget: number } {
  const rails = listRails();
  const report = sloReport(nowMs);
  const sw = report.switchAvailability['24h'];
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const items = listSla().map((entry): SlaBreach => {
    const measured = measure(entry, rails, sw);
    const reasons: string[] = [];
    if (entry.availabilityTarget != null && measured.availability != null && measured.availability < entry.availabilityTarget)
      reasons.push(`availability ${(measured.availability * 100).toFixed(2)} % below committed ${(entry.availabilityTarget * 100).toFixed(2)} %`);
    if (entry.latencyTargetMs != null && measured.p95LatencyMs != null && measured.p95LatencyMs > entry.latencyTargetMs)
      reasons.push(`p95 latency ${Math.round(measured.p95LatencyMs)} ms above committed ${entry.latencyTargetMs} ms`);
    if (measured.state === 'UNAVAILABLE') reasons.push('rail reported UNAVAILABLE (paused, open circuit or failed probe)');
    if (measured.state === 'DEGRADED') reasons.push('rail reported DEGRADED (half-open circuit or poor recent success rate)');
    return { entry, measured, breached: reasons.length > 0, reasons, reviewOverdue: !!entry.reviewDate && entry.reviewDate < today };
  });
  return { items, breached: items.filter((i) => i.breached).length, unmeasured: items.filter((i) => i.measured.source === 'none').length, switchAvailabilityTarget: SWITCH_AVAILABILITY_TARGET };
}
