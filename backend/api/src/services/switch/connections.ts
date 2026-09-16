/**
 * Switch connections (one per scheme and country). A connection carries the access mode (DIRECT or SPONSORED), the
 * adapter in use, the environment, the certification status and the certificate inventory. The homologation gate is
 * enforced here: a connection can only be enabled in production once its certification is CERTIFIED with evidence,
 * approved by someone other than the author, with a valid certificate and — for sponsored access — an active sponsor
 * that provides switch identifiers. Simulation connections are always labelled as such.
 */
import { getDb } from '../../db';
import { now } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { encrypt } from '../../lib/crypto';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { config } from '../../config';
import { recordEvent } from '../events';
import { notify } from '../notifications';
import { recordProbe } from '../rails';
import { getSwitchSettings } from './settings';
import { registryStatus, getParticipant } from './participants';
import { adapterFor } from './adapter';

export type AccessMode = 'DIRECT' | 'SPONSORED';
export type CertificationStatus = 'NOT_STARTED' | 'INTERNAL_TESTS' | 'SANDBOX' | 'CERTIFIED' | 'REVOKED';
export type Environment = 'simulation' | 'sandbox' | 'production';
export type LinkState = 'UP' | 'DEGRADED' | 'DOWN' | 'INQUIRY_ONLY';

export interface Certification {
  status: CertificationStatus;
  evidenceRef?: string | null;
  authorId?: string | null;
  approvedBy?: string | null;
  at?: string | null;
  history?: { status: CertificationStatus; at: string; by: string | null; evidenceRef?: string | null }[];
}
export interface CertificateInfo {
  fingerprint?: string | null;
  subject?: string | null;
  notBefore?: string | null;
  notAfter?: string | null;
  status?: 'VALID' | 'EXPIRED' | 'REVOKED' | 'MISSING';
  owner?: string | null;
  usage?: string | null;
  revocationProcedure?: string | null;
}
export interface SwitchConnection {
  id: string;
  name: string;
  country: string;
  schemeId: string;
  accessMode: AccessMode;
  participantId: string | null;
  sponsorId: string | null;
  adapter: 'simulator' | 'certified';
  environment: Environment;
  profileVersion: string | null;
  certification: Certification;
  certificate: CertificateInfo;
  quotaPerSecond: number;
  inquiryReservePct: number;
  enabled: boolean;
  health: Record<string, unknown>;
  linkState: LinkState;
  simulation: boolean;
  simulatorScenarios: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const toView = (r: any): SwitchConnection => ({
  id: r.id,
  name: r.name,
  country: r.country,
  schemeId: r.scheme_id,
  accessMode: r.access_mode,
  participantId: r.participant_id,
  sponsorId: r.sponsor_id,
  adapter: r.adapter,
  environment: r.environment,
  profileVersion: r.profile_version,
  certification: parseJson(r.certification, { status: 'NOT_STARTED' }),
  certificate: parseJson(r.certificate, {}),
  quotaPerSecond: r.quota_per_second,
  inquiryReservePct: r.inquiry_reserve_pct,
  enabled: !!r.enabled,
  health: parseJson(r.health, {}),
  linkState: r.link_state,
  simulation: r.adapter === 'simulator',
  simulatorScenarios: parseJson(r.simulator_scenarios, {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function listConnections(): SwitchConnection[] {
  return (getDb().prepare('SELECT * FROM switch_connections ORDER BY country, id').all() as any[]).map(toView);
}
export function getConnection(id: string): SwitchConnection {
  const r = getDb().prepare('SELECT * FROM switch_connections WHERE id = ?').get(id);
  if (!r) throw notFound('Switch connection not found', 'connection_not_found');
  return toView(r);
}
export function connectionForCountry(country: string | null | undefined): SwitchConnection | null {
  const r = getDb()
    .prepare('SELECT * FROM switch_connections WHERE country = ? ORDER BY enabled DESC, created_at LIMIT 1')
    .get((country ?? '').toUpperCase());
  return r ? toView(r) : null;
}

/** Seed the DRC connection in simulation mode (the real profile, codec and certificates come after BCC-04/06). */
export function ensureDefaultConnections(): void {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM switch_connections WHERE id = ?').get('NATIONAL_SWITCH_CD')) {
    db.prepare(
      'INSERT INTO switch_connections (id, name, country, scheme_id, access_mode, participant_id, sponsor_id, adapter, environment, profile_version, certification, certificate, quota_per_second, inquiry_reserve_pct, enabled, health, link_state, simulator_scenarios, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'NATIONAL_SWITCH_CD',
      'Switch Monétique National (RDC) — SIMULATION',
      'CD',
      'SMN-CD',
      'DIRECT',
      'BITRIPAY_CD',
      null,
      'simulator',
      'simulation',
      'sim-1.0',
      JSON.stringify({ status: 'NOT_STARTED', history: [] }),
      JSON.stringify({ status: 'MISSING', owner: 'Security Administrator', usage: 'switch channel authentication', revocationProcedure: 'revoke at the scheme CA, rotate, re-run joint tests' }),
      20,
      25,
      1,
      JSON.stringify({}),
      'UP',
      JSON.stringify({}),
      now(),
      now(),
    );
  }
}

export function upsertConnection(
  input: {
    id: string;
    name: string;
    country: string;
    schemeId: string;
    accessMode?: AccessMode;
    participantId?: string | null;
    sponsorId?: string | null;
    adapter?: 'simulator' | 'certified';
    environment?: Environment;
    profileVersion?: string | null;
    quotaPerSecond?: number;
    inquiryReservePct?: number;
    endpoint?: string | null;
    simulatorScenarios?: Record<string, unknown>;
  },
  adminId: string,
): SwitchConnection {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM switch_connections WHERE id = ?').get(input.id) as any;
  if (input.accessMode === 'SPONSORED' && !input.sponsorId) throw badRequest('Sponsored access needs a sponsor participant', 'sponsor_required');
  if (input.sponsorId) {
    const sp = getParticipant(input.sponsorId);
    if (sp.kind !== 'SPONSOR' && sp.kind !== 'BANK' && sp.kind !== 'PSP') throw badRequest('The sponsor must be a sponsor, bank or PSP participant', 'invalid_sponsor');
  }
  if (existing && existing.enabled && existing.environment === 'production' && (input.accessMode ?? existing.access_mode) !== existing.access_mode)
    throw conflict('The access mode of an enabled production connection cannot change silently; disable it, change, re-certify, re-enable', 'access_mode_locked');
  if (!existing) {
    db.prepare(
      'INSERT INTO switch_connections (id, name, country, scheme_id, access_mode, participant_id, sponsor_id, adapter, environment, profile_version, certification, certificate, quota_per_second, inquiry_reserve_pct, enabled, health, link_state, simulator_scenarios, endpoint_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)',
    ).run(
      input.id,
      input.name,
      input.country.toUpperCase(),
      input.schemeId,
      input.accessMode ?? 'DIRECT',
      input.participantId ?? null,
      input.sponsorId ?? null,
      input.adapter ?? 'simulator',
      input.environment ?? 'simulation',
      input.profileVersion ?? null,
      JSON.stringify({ status: 'NOT_STARTED', history: [] }),
      JSON.stringify({ status: 'MISSING' }),
      input.quotaPerSecond ?? 20,
      input.inquiryReservePct ?? 25,
      '{}',
      (input.adapter ?? 'simulator') === 'simulator' ? 'UP' : 'DOWN',
      JSON.stringify(input.simulatorScenarios ?? {}),
      input.endpoint ? encrypt(input.endpoint) : null,
      now(),
      now(),
    );
  } else {
    db.prepare(
      'UPDATE switch_connections SET name = ?, country = ?, scheme_id = ?, access_mode = ?, participant_id = ?, sponsor_id = ?, adapter = ?, environment = ?, profile_version = ?, quota_per_second = ?, inquiry_reserve_pct = ?, simulator_scenarios = ?, endpoint_enc = COALESCE(?, endpoint_enc), updated_at = ? WHERE id = ?',
    ).run(
      input.name,
      input.country.toUpperCase(),
      input.schemeId,
      input.accessMode ?? existing.access_mode,
      input.participantId ?? existing.participant_id,
      input.sponsorId ?? existing.sponsor_id,
      input.adapter ?? existing.adapter,
      input.environment ?? existing.environment,
      input.profileVersion ?? existing.profile_version,
      input.quotaPerSecond ?? existing.quota_per_second,
      input.inquiryReservePct ?? existing.inquiry_reserve_pct,
      JSON.stringify(input.simulatorScenarios ?? parseJson(existing.simulator_scenarios, {})),
      input.endpoint ? encrypt(input.endpoint) : null,
      now(),
      input.id,
    );
  }
  recordEvent(
    'corridor',
    input.id,
    existing ? 'switch.connection.updated' : 'switch.connection.created',
    { type: 'admin', id: adminId },
    { accessMode: input.accessMode ?? null, environment: input.environment ?? null, adapter: input.adapter ?? null },
  );
  return getConnection(input.id);
}

const CERT_ORDER: CertificationStatus[] = ['NOT_STARTED', 'INTERNAL_TESTS', 'SANDBOX', 'CERTIFIED'];

/** Move the certification forward one step (or revoke). CERTIFIED needs evidence and an approver distinct from the author. */
export function setCertification(
  id: string,
  status: CertificationStatus,
  input: { evidenceRef?: string | null; profileVersion?: string | null; approverId?: string | null },
  adminId: string,
): SwitchConnection {
  const c = getConnection(id);
  const cur = c.certification;
  if (status !== 'REVOKED') {
    const from = CERT_ORDER.indexOf(cur.status === 'REVOKED' ? 'NOT_STARTED' : cur.status);
    const to = CERT_ORDER.indexOf(status);
    if (to !== from + 1) throw conflict(`Certification moves one step at a time (${cur.status} → ${CERT_ORDER[from + 1] ?? 'none'})`, 'certification_sequence');
    if (status === 'CERTIFIED') {
      if (!input.evidenceRef) throw badRequest('CERTIFIED needs the certification evidence reference (report, test vectors, scheme attestation)', 'evidence_required');
      if (!input.approverId || input.approverId === adminId) throw badRequest('CERTIFIED needs an approver different from the author', 'approver_required');
      if (!(input.profileVersion ?? c.profileVersion)) throw badRequest('CERTIFIED needs the signed technical profile version', 'profile_required');
    }
  }
  const next: Certification = {
    status,
    evidenceRef: input.evidenceRef ?? cur.evidenceRef ?? null,
    authorId: adminId,
    approvedBy: status === 'CERTIFIED' ? (input.approverId ?? null) : null,
    at: now(),
    history: [...(cur.history ?? []), { status, at: now(), by: adminId, evidenceRef: input.evidenceRef ?? null }],
  };
  getDb()
    .prepare('UPDATE switch_connections SET certification = ?, profile_version = COALESCE(?, profile_version), enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(next), input.profileVersion ?? null, status === 'REVOKED' ? 1 : 0, now(), id);
  recordEvent('corridor', id, 'switch.certification', { type: 'admin', id: adminId }, { status, evidenceRef: input.evidenceRef ?? null, approvedBy: next.approvedBy });
  return getConnection(id);
}

export function setCertificate(id: string, cert: CertificateInfo, adminId: string): SwitchConnection {
  getConnection(id);
  const status: CertificateInfo['status'] = cert.status ?? (cert.notAfter && cert.notAfter < now() ? 'EXPIRED' : cert.fingerprint ? 'VALID' : 'MISSING');
  getDb()
    .prepare('UPDATE switch_connections SET certificate = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify({ ...cert, status }), now(), id);
  recordEvent('corridor', id, 'switch.certificate', { type: 'admin', id: adminId }, { fingerprint: cert.fingerprint ?? null, notAfter: cert.notAfter ?? null, status });
  return getConnection(id);
}

/** Enabling is the homologation gate. */
export function setEnabled(id: string, enabled: boolean, adminId: string): SwitchConnection {
  const c = getConnection(id);
  if (enabled) {
    const why = enableBlockers(c);
    if (why.length) throw new AppError(409, 'connector_not_certified', `Connection cannot be enabled: ${why.join('; ')}`, { blockers: why });
  }
  getDb()
    .prepare('UPDATE switch_connections SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, now(), id);
  recordEvent('corridor', id, enabled ? 'switch.enabled' : 'switch.disabled', { type: 'admin', id: adminId }, {});
  return getConnection(id);
}

export function enableBlockers(c: SwitchConnection): string[] {
  const why: string[] = [];
  if (c.environment === 'production') {
    if (c.adapter !== 'certified') why.push('production requires the certified adapter (the simulator never reaches production)');
    if (c.certification.status !== 'CERTIFIED') why.push(`certification is ${c.certification.status}, not CERTIFIED`);
    if (!c.certification.evidenceRef) why.push('certification evidence missing');
    if (!c.certification.approvedBy || c.certification.approvedBy === c.certification.authorId) why.push('certification approver must differ from the author');
    if (c.certificate.status !== 'VALID' || !c.certificate.notAfter || c.certificate.notAfter < now()) why.push('production certificate missing or expired');
    if (!c.profileVersion) why.push('signed technical profile version missing');
    if (!config.switch.adapterModule) why.push('SWITCH_ADAPTER_MODULE is not configured');
  }
  if (c.adapter === 'certified' && c.environment === 'simulation') why.push('the certified adapter cannot run in the simulation environment');
  if (!c.participantId) why.push('BitriPay participant identifier missing');
  if (c.accessMode === 'SPONSORED') {
    if (!c.sponsorId) why.push('sponsor missing');
    else {
      try {
        const sp = getParticipant(c.sponsorId);
        if (sp.status !== 'ACTIVE') why.push(`sponsor ${sp.id} is ${sp.status}`);
        if (!sp.routingIds.switchParticipantId || !sp.routingIds.reconciliationFeed) why.push('sponsor has not provided switch identifiers and reconciliation elements (internal certification fails)');
      } catch {
        why.push('sponsor participant unknown');
      }
    }
  }
  return why;
}

export interface EmissionGate {
  allowed: boolean;
  reasons: string[];
  inquiryOnly: boolean;
}

/** Everything that must be true right now for a message to leave BitriPay (checked before every emission). */
export function emissionGate(c: SwitchConnection): EmissionGate {
  const reasons: string[] = [];
  const settings = getSwitchSettings();
  if (!c.enabled) reasons.push('connection disabled');
  const blockers = enableBlockers(c);
  if (blockers.length) reasons.push(...blockers);
  if (c.environment !== 'simulation' && c.certificate.notAfter && c.certificate.notAfter < now()) reasons.push('certificate expired: emission stopped (security is never disabled for availability)');
  if (c.environment !== 'simulation' && c.certificate.status === 'REVOKED') reasons.push('certificate revoked');
  if (c.linkState === 'DOWN' && settings.refuseWhenLinkDown) reasons.push('switch link down');
  const reg = registryStatus(c.country);
  if (reg.stale) reasons.push(`participant registry stale (${reg.ageHours}h > ${settings.registryToleranceHours}h tolerance)`);
  if (reg.contradictions.length) reasons.push(`participant registry contradictory: ${reg.contradictions.join(', ')}`);
  if (reg.participants === 0) reasons.push('participant registry absent');
  return { allowed: reasons.length === 0, reasons, inquiryOnly: c.linkState === 'INQUIRY_ONLY' };
}

export function setLinkState(id: string, state: LinkState, detail: Record<string, unknown> = {}): void {
  getDb()
    .prepare('UPDATE switch_connections SET link_state = ?, health = ?, updated_at = ? WHERE id = ?')
    .run(state, JSON.stringify({ ...detail, at: now() }), now(), id);
}

/** Health probe for every connection: the adapter's health() answers; production links also check certificate validity. */
export async function probeSwitchConnections(): Promise<{ id: string; ok: boolean; message: string }[]> {
  const out: { id: string; ok: boolean; message: string }[] = [];
  for (const c of listConnections()) {
    let ok = false;
    let message = '';
    let state: LinkState = 'DOWN';
    try {
      const adapter = adapterFor(c);
      const h = await adapter.health();
      ok = h.up;
      message = h.message;
      state = h.up ? (h.degraded ? 'DEGRADED' : 'UP') : h.inquiryOnly ? 'INQUIRY_ONLY' : 'DOWN';
      if (c.environment !== 'simulation' && c.certificate.notAfter && c.certificate.notAfter < now()) {
        ok = false;
        state = 'INQUIRY_ONLY';
        message = `${message}; certificate expired`;
      }
      setLinkState(c.id, state, { ok, message, sessions: h.sessions ?? null, latencyMs: h.latencyMs ?? null, quota: h.quota ?? null, simulation: h.simulation ?? false });
    } catch (err) {
      message = (err as Error).message;
      setLinkState(c.id, 'DOWN', { ok: false, message });
    }
    recordProbe(c.id, ok, message, { linkState: state });
    out.push({ id: c.id, ok, message });
  }
  return out;
}

/** Certificate inventory alerts at 60/30/14/7 days; expiry stops emission and opens a P1 incident. */
export function certificateAlerts(): { alerted: string[]; expired: string[] } {
  const settings = getSwitchSettings();
  const alerted: string[] = [];
  const expired: string[] = [];
  const db = getDb();
  for (const c of listConnections()) {
    if (c.environment === 'simulation' || !c.certificate.notAfter) continue;
    const days = Math.floor((Date.parse(c.certificate.notAfter) - Date.now()) / 86_400_000);
    if (days < 0) {
      expired.push(c.id);
      if (c.certificate.status !== 'EXPIRED')
        db.prepare('UPDATE switch_connections SET certificate = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...c.certificate, status: 'EXPIRED' }), now(), c.id);
      openIncident(
        'P1',
        `Certificate expired on ${c.id}`,
        'Emission is stopped until a valid certificate is installed and joint tests pass. TLS is never disabled to keep the link up.',
        'switch_connection',
        c.id,
      );
      continue;
    }
    if (settings.certificateAlertDays.includes(days)) {
      alerted.push(c.id);
      for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_system = 0 AND status = 'active'").all() as { id: string }[])
        notify(
          a.id,
          `Switch certificate expires in ${days} days`,
          `${c.name}: certificate ${c.certificate.fingerprint ?? ''} expires ${c.certificate.notAfter}. Run the rotation procedure and overlap tests.`,
          { kind: 'security', connectionId: c.id },
        );
    }
  }
  return { alerted, expired };
}

// ---------------------------------------------------------------------------------------------------------------------
// Incidents (19.2)
// ---------------------------------------------------------------------------------------------------------------------
export type IncidentLevel = 'P1' | 'P2' | 'P3';
export function openIncident(level: IncidentLevel, title: string, detail: string | null, subjectType: string | null, subjectId: string | null): string {
  const db = getDb();
  const dup = db.prepare("SELECT id FROM incidents WHERE status = 'OPEN' AND subject_type IS ? AND subject_id IS ? AND title = ?").get(subjectType, subjectId, title) as any;
  if (dup) return dup.id;
  const id = `inc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  db.prepare('INSERT INTO incidents (id, level, title, detail, subject_type, subject_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    level,
    title,
    detail,
    subjectType,
    subjectId,
    'OPEN',
    now(),
  );
  recordEvent('corridor', subjectId, 'incident.opened', { type: 'system' }, { id, level, title });
  const targets = { P1: 5, P2: 15, P3: 240 }[level];
  for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_system = 0 AND status = 'active'").all() as { id: string }[])
    notify(a.id, `${level} incident: ${title}`, `${detail ?? ''} Acknowledge within ${targets} minutes.`, { kind: 'incident', incidentId: id, level });
  return id;
}
/** Console view of an incident: level, subject (rail, connection, corridor…), cause, and the outage duration so far or until resolution. */
export function incidentView(r: any) {
  const end = r.resolved_at ? new Date(r.resolved_at).getTime() : Date.now();
  return {
    id: r.id,
    level: r.level,
    severity: r.level,
    title: r.title,
    detail: r.detail,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    status: r.status,
    openedAt: r.created_at,
    acknowledgedAt: r.acknowledged_at,
    acknowledgedBy: r.acknowledged_by,
    resolvedAt: r.resolved_at,
    durationMinutes: Math.max(0, Math.round((end - new Date(r.created_at).getTime()) / 60_000)),
  };
}
export function listIncidents(status?: string | null) {
  return (
    getDb()
      .prepare(`SELECT * FROM incidents ${status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC LIMIT 200`)
      .all(...(status ? [status] : [])) as any[]
  ).map(incidentView);
}
export function acknowledgeIncident(id: string, adminId: string) {
  const r = getDb()
    .prepare(
      "UPDATE incidents SET acknowledged_at = COALESCE(acknowledged_at, ?), acknowledged_by = COALESCE(acknowledged_by, ?), status = CASE WHEN status = 'OPEN' THEN 'ACKNOWLEDGED' ELSE status END WHERE id = ?",
    )
    .run(now(), adminId, id);
  if (!r.changes) throw notFound('Incident not found', 'incident_not_found');
  return incidentView(getDb().prepare('SELECT * FROM incidents WHERE id = ?').get(id));
}
export function resolveIncident(id: string, adminId: string, note?: string | null) {
  const r = getDb()
    .prepare("UPDATE incidents SET status = 'RESOLVED', resolved_at = ?, detail = CASE WHEN ? IS NULL THEN detail ELSE detail || ' — resolution: ' || ? END WHERE id = ?")
    .run(now(), note ?? null, note ?? null, id);
  if (!r.changes) throw notFound('Incident not found', 'incident_not_found');
  recordEvent('corridor', id, 'incident.resolved', { type: 'admin', id: adminId }, { note: note ?? null });
  return incidentView(getDb().prepare('SELECT * FROM incidents WHERE id = ?').get(id));
}
