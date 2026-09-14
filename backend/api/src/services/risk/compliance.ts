/**
 * Compliance operations: cases (fraud blocks, AML patterns, sanctions hits, destination changes, manual referrals)
 * with an auto-drafted suspicious activity report, assignment, escalation, decisions and closure by a different
 * officer; the AML monitor (structuring, pass-through / mule patterns, dormant-then-burst, high-risk
 * counterparties, politically exposed persons); and sanctions list sources with versioned refreshes. Every
 * decision is appended to the event log; nothing here edits or deletes evidence.
 */
import { getDb } from '../../db';
import { now, shortCode, uuid } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { config } from '../../config';
import { getSetting } from '../settings';
import { toBase, getBaseCurrency } from '../currencies';
import { formatMoney } from '@bitripay/shared';
import { recordEvent, type Actor } from '../events';
import { findUserById, toPublicUser } from '../users';
import { notify } from '../notifications';
import { normalizeName, normalizePhoneDigits } from '../risk';
import { tierLimitsFor } from './kycTiers';

export type CaseKind = 'FRAUD' | 'AML' | 'SANCTIONS' | 'DESTINATION' | 'MANUAL';
export type CaseStatus = 'OPEN' | 'ASSIGNED' | 'ESCALATED' | 'DECIDED' | 'CLOSED';
export type CaseSeverity = 'low' | 'medium' | 'high' | 'critical';
export interface ComplianceCase {
  id: string;
  kind: CaseKind;
  userId: string | null;
  user: ReturnType<typeof toPublicUser> | null;
  subjectType: string | null;
  subjectId: string | null;
  severity: CaseSeverity;
  status: CaseStatus;
  title: string;
  summary: string;
  indicators: string[];
  sarDraft: string | null;
  sarReference: string | null;
  assignedTo: string | null;
  openedBy: string | null;
  decision: string | null;
  decisionReason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
const toView = (r: any): ComplianceCase => {
  const u = r.user_id ? findUserById(r.user_id) : null;
  return {
    id: r.id,
    kind: r.kind,
    userId: r.user_id,
    user: u ? toPublicUser(u) : null,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    severity: r.severity,
    status: r.status,
    title: r.title,
    summary: r.summary,
    indicators: parseJson(r.indicators, []),
    sarDraft: r.sar_draft,
    sarReference: r.sar_reference,
    assignedTo: r.assigned_to,
    openedBy: r.opened_by,
    decision: r.decision,
    decisionReason: r.decision_reason,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    closedBy: r.closed_by,
    closedAt: r.closed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
};

export interface AmlSettings {
  highRiskCountries: string[];
  structuring: { window24hCount: number; nearLimitPct: number };
  passThrough: { distinctSenders24h: number; forwardedPct: number };
  dormantDays: number;
  burstMultiplier: number;
  /** Sanctions-like flag that only raises the score (never blocks by itself). */
  pepPoints: number;
}
const DEFAULT_AML: AmlSettings = {
  highRiskCountries: [],
  structuring: { window24hCount: 3, nearLimitPct: 80 },
  passThrough: { distinctSenders24h: 5, forwardedPct: 80 },
  dormantDays: 60,
  burstMultiplier: 5,
  pepPoints: 45,
};
export const getAmlSettings = (): AmlSettings => {
  const s = getSetting<Partial<AmlSettings>>('aml', {});
  return { ...DEFAULT_AML, ...s, structuring: { ...DEFAULT_AML.structuring, ...(s.structuring ?? {}) }, passThrough: { ...DEFAULT_AML.passThrough, ...(s.passThrough ?? {}) } };
};

/** A suspicious activity report draft from the facts on file. Officers edit it; the platform never files it by itself. */
export function draftSar(input: {
  kind: CaseKind;
  userId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  summary: string;
  indicators: string[];
  amounts?: { valueMinor: number; currency: string }[];
}): string {
  const u = input.userId ? findUserById(input.userId) : null;
  const base = getBaseCurrency();
  const lines = [
    `SUSPICIOUS ACTIVITY REPORT — DRAFT (${config.appName})`,
    `Prepared: ${now()} · Status: draft, not filed · Category: ${input.kind}`,
    '',
    '1. Subject',
    u
      ? `   ${u.full_name}${u.business_name ? ` (${u.business_name})` : ''} · @${u.tag} · account ${u.id} · country ${u.country ?? 'n/a'} · KYC tier ${(u as any).kyc_tier ?? 0} · account since ${u.created_at.slice(0, 10)}`
      : '   No account linked (external party)',
    '',
    '2. Activity',
    `   ${input.summary}`,
    input.subjectId ? `   Reference: ${input.subjectType ?? 'object'} ${input.subjectId}` : '',
    input.amounts?.length
      ? `   Amounts: ${input.amounts.map((a) => formatMoney(a.valueMinor, { code: a.currency, decimals: 2, symbol: a.currency, name: a.currency, rateToBase: 1, enabled: true } as any)).join(', ')} (base currency ${base.code})`
      : '',
    '',
    '3. Indicators',
    ...input.indicators.map((i) => `   • ${i}`),
    '',
    '4. Actions taken by the platform',
    '   Movement refused or held per the active risk policy; account not otherwise restricted; evidence preserved in the event log.',
    '',
    '5. Recommendation',
    '   Compliance officer to review the account history, confirm or dismiss the indicators, and decide whether to file with the financial intelligence unit within the statutory delay.',
  ].filter((l) => l !== '');
  return lines.join('\n');
}

export function openCase(input: {
  kind: CaseKind;
  userId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  severity?: CaseSeverity;
  title: string;
  summary: string;
  indicators?: string[];
  dedupeKey?: string | null;
  openedBy?: string | null;
  amounts?: { valueMinor: number; currency: string }[];
  sar?: boolean;
}): ComplianceCase {
  const db = getDb();
  if (input.dedupeKey) {
    const existing = db.prepare("SELECT * FROM compliance_cases WHERE dedupe_key = ? AND status != 'CLOSED'").get(input.dedupeKey) as any;
    if (existing) return toView(existing);
  }
  const id = `cc_${shortCode(14).toLowerCase()}`;
  const severity = input.severity ?? 'medium';
  const indicators = input.indicators ?? [];
  const sar = input.sar ?? (severity === 'critical' || input.kind === 'FRAUD');
  db.prepare(
    'INSERT INTO compliance_cases (id, kind, user_id, subject_type, subject_id, severity, status, title, summary, indicators, sar_draft, opened_by, dedupe_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    input.kind,
    input.userId ?? null,
    input.subjectType ?? null,
    input.subjectId ?? null,
    severity,
    'OPEN',
    input.title,
    input.summary,
    JSON.stringify(indicators),
    sar ? draftSar({ kind: input.kind, userId: input.userId, subjectType: input.subjectType, subjectId: input.subjectId, summary: input.summary, indicators, amounts: input.amounts }) : null,
    input.openedBy ?? null,
    input.dedupeKey ?? null,
    now(),
    now(),
  );
  recordEvent('risk', id, 'compliance_case.opened', input.openedBy ? { type: 'admin', id: input.openedBy } : { type: 'system' }, {
    kind: input.kind,
    userId: input.userId ?? null,
    severity,
    indicators,
  });
  if (severity === 'critical')
    for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_system = 0 AND status = 'active'").all() as { id: string }[])
      notify(a.id, `Compliance case (${input.kind})`, input.title, { kind: 'approval', caseId: id, loud: true });
  return getCase(id);
}
export function getCase(id: string): ComplianceCase {
  const r = getDb().prepare('SELECT * FROM compliance_cases WHERE id = ?').get(id);
  if (!r) throw notFound('Compliance case not found', 'case_not_found');
  return toView(r);
}
export function listCases(
  filter: { status?: string | null; kind?: string | null; userId?: string | null; assignedTo?: string | null; severity?: string | null; limit?: number } = {},
): ComplianceCase[] {
  const where: string[] = [];
  const params: unknown[] = [];
  for (const [col, val] of [
    ['status', filter.status],
    ['kind', filter.kind],
    ['user_id', filter.userId],
    ['assigned_to', filter.assignedTo],
    ['severity', filter.severity],
  ] as const) {
    if (val) {
      where.push(`${col} = ?`);
      params.push(val);
    }
  }
  return (
    getDb()
      .prepare(
        `SELECT * FROM compliance_cases ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC LIMIT ?`,
      )
      .all(...params, Math.min(500, filter.limit ?? 100)) as any[]
  ).map(toView);
}
export function assignCase(id: string, officerId: string, actor: Actor): ComplianceCase {
  const c = getCase(id);
  if (c.status === 'CLOSED') throw conflict('Case is closed', 'case_closed');
  getDb().prepare("UPDATE compliance_cases SET assigned_to = ?, status = CASE WHEN status = 'OPEN' THEN 'ASSIGNED' ELSE status END, updated_at = ? WHERE id = ?").run(officerId, now(), id);
  recordEvent('risk', id, 'compliance_case.assigned', actor, { officerId });
  return getCase(id);
}
export function escalateCase(id: string, actor: Actor, note: string): ComplianceCase {
  const c = getCase(id);
  if (c.status === 'CLOSED') throw conflict('Case is closed', 'case_closed');
  getDb().prepare("UPDATE compliance_cases SET status = 'ESCALATED', severity = CASE WHEN severity = 'critical' THEN 'critical' ELSE 'high' END, updated_at = ? WHERE id = ?").run(now(), id);
  recordEvent('risk', id, 'compliance_case.escalated', actor, { note });
  return getCase(id);
}
export function updateSarDraft(id: string, text: string, actor: Actor): ComplianceCase {
  const c = getCase(id);
  if (c.status === 'CLOSED') throw conflict('Case is closed', 'case_closed');
  getDb().prepare('UPDATE compliance_cases SET sar_draft = ?, updated_at = ? WHERE id = ?').run(text, now(), id);
  recordEvent('risk', id, 'compliance_case.sar_edited', actor, { chars: text.length });
  return getCase(id);
}
export const CASE_DECISIONS = ['NO_ACTION', 'CLEARED', 'SAR_FILED', 'ACCOUNT_RESTRICTED', 'ACCOUNT_CLOSED'] as const;
export function decideCase(id: string, decision: (typeof CASE_DECISIONS)[number], reason: string, adminId: string, sarReference?: string | null): ComplianceCase {
  const c = getCase(id);
  if (c.status === 'CLOSED') throw conflict('Case is closed', 'case_closed');
  if (!CASE_DECISIONS.includes(decision)) throw badRequest('Unknown decision', 'validation_error');
  if (decision === 'SAR_FILED' && !sarReference) throw badRequest('A filed report needs its reference', 'sar_reference_required');
  getDb()
    .prepare(
      "UPDATE compliance_cases SET status = 'DECIDED', decision = ?, decision_reason = ?, decided_by = ?, decided_at = ?, sar_reference = COALESCE(?, sar_reference), updated_at = ? WHERE id = ?",
    )
    .run(decision, reason, adminId, now(), sarReference ?? null, now(), id);
  recordEvent('risk', id, 'compliance_case.decided', { type: 'admin', id: adminId }, { decision, reason, sarReference: sarReference ?? null });
  return getCase(id);
}
/** Four-eyes closure: the officer who decided cannot close. */
export function closeCase(id: string, adminId: string): ComplianceCase {
  const c = getCase(id);
  if (c.status !== 'DECIDED') throw conflict('Decide the case before closing it', 'case_not_decided');
  if (c.decidedBy === adminId) throw conflict('A different officer must close the case', 'approver_required');
  getDb().prepare("UPDATE compliance_cases SET status = 'CLOSED', closed_by = ?, closed_at = ?, updated_at = ? WHERE id = ?").run(adminId, now(), now(), id);
  recordEvent('risk', id, 'compliance_case.closed', { type: 'admin', id: adminId }, { decision: c.decision });
  return getCase(id);
}
export function complianceOverview() {
  const db = getDb();
  const open = db.prepare("SELECT kind, severity, COUNT(*) n, MIN(created_at) oldest FROM compliance_cases WHERE status != 'CLOSED' GROUP BY kind, severity").all() as any[];
  const sar = (db.prepare("SELECT COUNT(*) c FROM compliance_cases WHERE sar_draft IS NOT NULL AND status != 'CLOSED'").get() as any).c as number;
  return {
    open: open.map((r) => ({ kind: r.kind, severity: r.severity, count: r.n, oldestAgeHours: Math.floor((Date.now() - Date.parse(r.oldest)) / 3600_000) })),
    sarDrafts: sar,
    sources: listSources(),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// AML monitor
// ---------------------------------------------------------------------------------------------------------------------
function safeBase(amount: number, currency: string) {
  try {
    return toBase(amount, currency);
  } catch {
    return amount;
  }
}
export function runAmlScan(at = new Date()): { scanned: number; opened: number; findings: { pattern: string; userId: string }[] } {
  const db = getDb();
  const s = getAmlSettings();
  const day = at.toISOString().slice(0, 10);
  const since24 = new Date(at.getTime() - 86_400_000).toISOString();
  const since7 = new Date(at.getTime() - 7 * 86_400_000).toISOString();
  const findings: { pattern: string; userId: string }[] = [];
  let opened = 0;
  const active = db
    .prepare(
      'SELECT DISTINCT user_id FROM (SELECT sender_user_id user_id FROM transactions WHERE created_at >= ? UNION SELECT receiver_user_id FROM transactions WHERE created_at >= ?) WHERE user_id IS NOT NULL',
    )
    .all(since24, since24) as { user_id: string }[];
  const open = (pattern: string, userId: string, severity: CaseSeverity, title: string, summary: string, indicators: string[], amounts?: { valueMinor: number; currency: string }[]) => {
    const before = (db.prepare('SELECT COUNT(*) c FROM compliance_cases').get() as any).c;
    openCase({ kind: 'AML', userId, severity, title, summary, indicators, dedupeKey: `aml:${pattern}:${userId}:${day}`, amounts, sar: severity !== 'low' });
    const after = (db.prepare('SELECT COUNT(*) c FROM compliance_cases').get() as any).c;
    if (after > before) opened += 1;
    findings.push({ pattern, userId });
  };
  for (const { user_id: uid } of active) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid) as any;
    if (!u || u.is_system) continue;
    // Structuring: repeated movements just under the per-transaction limit
    const limits = tierLimitsFor(u);
    if (limits?.perTransaction) {
      const out = db.prepare("SELECT amount, currency FROM transactions WHERE sender_user_id = ? AND status IN ('pending','completed') AND created_at >= ?").all(uid, since24) as {
        amount: number;
        currency: string;
      }[];
      const near = out.filter((r) => {
        const b = safeBase(r.amount, r.currency);
        return b >= (limits.perTransaction * s.structuring.nearLimitPct) / 100 && b <= limits.perTransaction;
      });
      if (near.length >= s.structuring.window24hCount)
        open(
          'structuring',
          uid,
          'high',
          'Possible structuring below the transaction limit',
          `${near.length} movements at ${s.structuring.nearLimitPct}–100% of the tier ${u.kyc_tier} per-transaction limit within 24 hours.`,
          [`${near.length} near-limit movements in 24h`, `limit ${limits.perTransaction} base minor`],
          near.map((n) => ({ valueMinor: n.amount, currency: n.currency })),
        );
    }
    // Pass-through / mule: many distinct senders then most of it forwarded out
    const inRows = db
      .prepare(
        "SELECT sender_user_id, amount, currency FROM transactions WHERE receiver_user_id = ? AND status = 'completed' AND created_at >= ? AND sender_user_id IS NOT NULL AND sender_user_id != ?",
      )
      .all(uid, since24, uid) as any[];
    const senders = new Set(inRows.map((r) => r.sender_user_id));
    if (senders.size >= s.passThrough.distinctSenders24h) {
      const inBase = inRows.reduce((a, r) => a + safeBase(r.amount, r.currency), 0);
      const outRows = db.prepare("SELECT amount, currency FROM transactions WHERE sender_user_id = ? AND status IN ('pending','completed') AND created_at >= ?").all(uid, since24) as any[];
      const outBase = outRows.reduce((a, r) => a + safeBase(r.amount, r.currency), 0);
      if (inBase > 0 && outBase >= (inBase * s.passThrough.forwardedPct) / 100)
        open(
          'pass_through',
          uid,
          'high',
          'Funds collected from many senders and forwarded',
          `Received from ${senders.size} distinct senders in 24h and moved ${Math.round((outBase / inBase) * 100)}% of it out.`,
          [`${senders.size} distinct senders in 24h`, `${Math.round((outBase / inBase) * 100)}% forwarded within 24h`],
        );
    }
    // Dormant then burst
    const before7 = db.prepare('SELECT MAX(created_at) m FROM transactions WHERE (sender_user_id = ? OR receiver_user_id = ?) AND created_at < ?').get(uid, uid, since7) as any;
    if (before7?.m && at.getTime() - Date.parse(before7.m) > s.dormantDays * 86_400_000) {
      const recent = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM transactions WHERE sender_user_id = ? AND created_at >= ?').get(uid, since7) as any;
      const priorAvg = db.prepare('SELECT COUNT(*) c FROM transactions WHERE sender_user_id = ? AND created_at < ?').get(uid, since7) as any;
      const ageDays = Math.max(7, (Date.parse(before7.m) - Date.parse(u.created_at)) / 86_400_000);
      const weeklyBefore = (priorAvg.c / ageDays) * 7;
      if (recent.c >= 3 && recent.c >= weeklyBefore * s.burstMultiplier)
        open(
          'dormant_burst',
          uid,
          'medium',
          'Dormant account suddenly active',
          `No activity for ${Math.floor((at.getTime() - Date.parse(before7.m)) / 86_400_000)} days, then ${recent.c} outgoing movements in a week.`,
          [`dormant ${s.dormantDays}+ days`, `${recent.c} movements this week vs ${weeklyBefore.toFixed(1)}/week before`],
        );
    }
    // High-risk counterparties
    if (s.highRiskCountries.length) {
      const cps = db
        .prepare(
          'SELECT DISTINCT u.country FROM transactions t JOIN users u ON u.id = CASE WHEN t.sender_user_id = ? THEN t.receiver_user_id ELSE t.sender_user_id END WHERE (t.sender_user_id = ? OR t.receiver_user_id = ?) AND t.created_at >= ? AND u.country IS NOT NULL',
        )
        .all(uid, uid, uid, since24) as { country: string }[];
      const hits = cps.map((c) => c.country.toUpperCase()).filter((c) => s.highRiskCountries.map((x) => x.toUpperCase()).includes(c));
      if (hits.length)
        open(
          'high_risk_country',
          uid,
          'medium',
          'Counterparty in a high-risk jurisdiction',
          `Movements with counterparties registered in ${[...new Set(hits)].join(', ')} in the last 24 hours.`,
          hits.map((h) => `counterparty country ${h}`),
        );
    }
    // Politically exposed person on the list
    const pep = db.prepare("SELECT value FROM sanctions_entries WHERE kind = 'pep' AND normalized = ?").get(normalizeName(u.full_name)) as any;
    if (pep)
      open('pep', uid, 'medium', 'Politically exposed person is transacting', `${u.full_name} matches the PEP list entry "${pep.value}"; enhanced due diligence applies.`, [
        `pep list match: ${pep.value}`,
      ]);
  }
  recordEvent('risk', `aml:${day}`, 'aml.scan', { type: 'system' }, { scanned: active.length, opened, findings: findings.length });
  return { scanned: active.length, opened, findings };
}

// ---------------------------------------------------------------------------------------------------------------------
// Sanctions list sources (OFAC, UN, EU, UK HMT, BCC …) — imported rows replace the source's previous version
// ---------------------------------------------------------------------------------------------------------------------
export interface SanctionsSource {
  id: string;
  name: string;
  url: string | null;
  format: SanctionsFormat;
  kind: 'sanctions' | 'pep';
  enabled: boolean;
  lastVersion: string | null;
  lastCount: number | null;
  lastRefreshedAt: string | null;
  lastError: string | null;
  createdAt: string;
}
const toSource = (r: any): SanctionsSource => ({
  id: r.id,
  name: r.name,
  url: r.url,
  format: r.format,
  kind: r.kind,
  enabled: !!r.enabled,
  lastVersion: r.last_version,
  lastCount: r.last_count,
  lastRefreshedAt: r.last_refreshed_at,
  lastError: r.last_error,
  createdAt: r.created_at,
});
export function listSources(): SanctionsSource[] {
  return (getDb().prepare('SELECT * FROM sanctions_sources ORDER BY name').all() as any[]).map(toSource);
}
/**
 * Feed formats: `csv` (kind,value header or the OFAC SDN layout), `json` (rows), and the official publications parsed
 * as published: `ofac_sdn` (US Treasury SDN / consolidated CSV), `uk_ofsi` (UK OFSI consolidated list CSV),
 * `un_xml` (UN Security Council consolidated list XML) and `eu_fsf` (EU financial sanctions file, semicolon CSV).
 */
export type SanctionsFormat = 'csv' | 'json' | 'ofac_sdn' | 'uk_ofsi' | 'un_xml' | 'eu_fsf';
export const SANCTIONS_FORMATS: SanctionsFormat[] = ['csv', 'json', 'ofac_sdn', 'uk_ofsi', 'un_xml', 'eu_fsf'];

/**
 * The official, public consolidated lists every deployment screens against from the first start: seeded once (an
 * administrator may disable or re-point any of them) and refreshed daily by the compliance job. Nothing is invented:
 * the entries come from the publishing authority, versioned by its ETag / Last-Modified.
 */
export const OFFICIAL_SANCTIONS_SOURCES: { id: string; name: string; url: string; format: SanctionsFormat }[] = [
  { id: 'ofac_sdn', name: 'US OFAC Specially Designated Nationals (SDN)', url: 'https://www.treasury.gov/ofac/downloads/sdn.csv', format: 'ofac_sdn' },
  { id: 'ofac_consolidated', name: 'US OFAC consolidated non-SDN list', url: 'https://www.treasury.gov/ofac/downloads/consolidated/cons_prim.csv', format: 'ofac_sdn' },
  { id: 'uk_ofsi', name: 'UK OFSI consolidated list of financial sanctions targets', url: 'https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv', format: 'uk_ofsi' },
  { id: 'un_consolidated', name: 'UN Security Council consolidated list', url: 'https://scsanctions.un.org/resources/xml/en/consolidated.xml', format: 'un_xml' },
  { id: 'eu_fsf', name: 'EU consolidated financial sanctions list', url: 'https://webgate.ec.europa.eu/fsd/fsf/public/files/csvFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw', format: 'eu_fsf' },
];

/** Seed the official sources once; a source an administrator edited or disabled is left exactly as they set it. */
export function ensureOfficialSanctionsSources(): string[] {
  const db = getDb();
  const seeded: string[] = [];
  const known = new Set((db.prepare('SELECT id FROM sanctions_sources').all() as { id: string }[]).map((r) => r.id));
  for (const src of OFFICIAL_SANCTIONS_SOURCES) {
    if (known.has(src.id)) continue;
    upsertSource({ id: src.id, name: src.name, url: src.url, format: src.format, kind: 'sanctions', enabled: true });
    seeded.push(src.id);
  }
  return seeded;
}

export function upsertSource(input: { id?: string | null; name: string; url?: string | null; format?: SanctionsFormat; kind?: 'sanctions' | 'pep'; enabled?: boolean }): SanctionsSource {
  const db = getDb();
  const id = input.id ?? `src_${shortCode(8).toLowerCase()}`;
  const existing = db.prepare('SELECT * FROM sanctions_sources WHERE id = ?').get(id) as any;
  if (existing)
    db.prepare('UPDATE sanctions_sources SET name = ?, url = ?, format = ?, kind = ?, enabled = ? WHERE id = ?').run(
      input.name,
      input.url ?? existing.url,
      input.format ?? existing.format,
      input.kind ?? existing.kind,
      (input.enabled ?? !!existing.enabled) ? 1 : 0,
      id,
    );
  else
    db.prepare('INSERT INTO sanctions_sources (id, name, url, format, kind, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      input.name,
      input.url ?? null,
      input.format ?? 'csv',
      input.kind ?? 'sanctions',
      (input.enabled ?? true) ? 1 : 0,
      now(),
    );
  return toSource(db.prepare('SELECT * FROM sanctions_sources WHERE id = ?').get(id));
}
export interface SanctionRow {
  kind: 'name' | 'phone' | 'email' | 'country' | 'pep';
  value: string;
  externalId?: string | null;
  note?: string | null;
}
/** Replace the source's entries with this version. Idempotent per version. */
export function importSanctionsRows(sourceId: string, rows: SanctionRow[], version: string, actor: Actor): { imported: number; version: string; replaced: number } {
  const db = getDb();
  const src = db.prepare('SELECT * FROM sanctions_sources WHERE id = ?').get(sourceId) as any;
  if (!src) throw notFound('Sanctions source not found', 'source_not_found');
  if (!rows.length) throw badRequest('The list is empty; refusing to replace the previous version with nothing', 'empty_list');
  let replaced = 0;
  db.transaction(() => {
    replaced = db.prepare('DELETE FROM sanctions_entries WHERE source = ?').run(sourceId).changes;
    const ins = db.prepare('INSERT INTO sanctions_entries (id, kind, value, normalized, note, created_by, created_at, source, external_id, list_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of rows) {
      const kind = src.kind === 'pep' ? 'pep' : r.kind;
      const normalized = kind === 'name' || kind === 'pep' ? normalizeName(r.value) : kind === 'phone' ? normalizePhoneDigits(r.value) : r.value.trim().toLowerCase();
      if (!normalized) continue;
      ins.run(uuid(), kind, r.value, normalized, r.note ?? null, actor.id ?? null, now(), sourceId, r.externalId ?? null, version);
    }
    db.prepare('UPDATE sanctions_sources SET last_version = ?, last_count = ?, last_refreshed_at = ?, last_error = NULL WHERE id = ?').run(version, rows.length, now(), sourceId);
  })();
  recordEvent('risk', sourceId, 'sanctions.imported', actor, { version, rows: rows.length, replaced });
  return { imported: rows.length, version, replaced };
}
/** Parse a CSV list: a header with `kind,value` columns, or the OFAC SDN layout (ent_num, SDN_Name, SDN_Type, …). */
export function parseSanctionsCsv(text: string): SanctionRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const split = (l: string) =>
    l
      .match(/("([^"]|"")*"|[^,]*)(,|$)/g)
      ?.map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim())
      .filter((_, i, a) => i < a.length - 1 || _ !== '') ?? [];
  const header = split(lines[0]).map((h) => h.toLowerCase());
  const out: SanctionRow[] = [];
  if (header.includes('kind') && header.includes('value')) {
    const ki = header.indexOf('kind');
    const vi = header.indexOf('value');
    const ii = header.indexOf('id');
    const ni = header.indexOf('note');
    for (const l of lines.slice(1)) {
      const c = split(l);
      const kind = c[ki] as SanctionRow['kind'];
      if (!['name', 'phone', 'email', 'country', 'pep'].includes(kind) || !c[vi]) continue;
      out.push({ kind, value: c[vi], externalId: ii >= 0 ? c[ii] : null, note: ni >= 0 ? c[ni] : null });
    }
    return out;
  }
  for (const l of lines) {
    const c = split(l);
    if (c.length < 2 || !c[1] || c[1] === '-0-') continue;
    out.push({ kind: 'name', value: c[1], externalId: c[0], note: c[2] && c[2] !== '-0-' ? c[2] : null });
  }
  return out;
}
const XML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const decodeXml = (v: string) => v.replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m).trim();
const xmlTag = (block: string, tag: string): string => {
  const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? decodeXml(m[1]) : '';
};
const xmlTags = (block: string, tag: string): string[] => [...block.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((m) => decodeXml(m[1])).filter(Boolean);
const csvSplit = (line: string, sep: string): string[] => {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else quoted = !quoted;
    } else if (ch === sep && !quoted) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
};

/**
 * UK OFSI consolidated list (ConList.csv): a "Last Updated" line, then a header (Name 6 = surname / entity name,
 * Name 1-5 = given names, Regime, Group Type, Group ID). Every row (aliases included) becomes one name entry keyed by
 * the Group ID so a screening hit points at the designation.
 */
export function parseUkOfsiCsv(text: string): SanctionRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const headerIdx = lines.findIndex((l) => /(^|,)"?Name 6"?(,|$)/i.test(l));
  if (headerIdx < 0) return [];
  const header = csvSplit(lines[headerIdx], ',').map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name.toLowerCase());
  const nameCols = ['Name 1', 'Name 2', 'Name 3', 'Name 4', 'Name 5', 'Name 6'].map(col);
  const regime = col('Regime');
  const groupId = col('Group ID');
  const groupType = col('Group Type');
  const out: SanctionRow[] = [];
  for (const l of lines.slice(headerIdx + 1)) {
    const c = csvSplit(l, ',');
    const value = nameCols
      .map((i) => (i >= 0 ? (c[i] ?? '') : ''))
      .filter(Boolean)
      .join(' ')
      .trim();
    if (!value) continue;
    const note = [groupType >= 0 ? c[groupType] : '', regime >= 0 ? c[regime] : ''].filter(Boolean).join(' · ') || null;
    out.push({ kind: 'name', value, externalId: groupId >= 0 ? c[groupId] || null : null, note });
  }
  return out;
}

/** UN Security Council consolidated list XML: individuals (first to fourth name) and entities, each with its aliases. */
export function parseUnConsolidatedXml(text: string): SanctionRow[] {
  const out: SanctionRow[] = [];
  const push = (value: string, externalId: string, note: string | null) => {
    const v = value.replace(/\s+/g, ' ').trim();
    if (v) out.push({ kind: 'name', value: v, externalId: externalId || null, note });
  };
  for (const m of text.matchAll(/<INDIVIDUAL>([\s\S]*?)<\/INDIVIDUAL>/g)) {
    const b = m[1];
    const id = xmlTag(b, 'DATAID') || xmlTag(b, 'REFERENCE_NUMBER');
    const note = [xmlTag(b, 'UN_LIST_TYPE'), xmlTag(b, 'REFERENCE_NUMBER')].filter(Boolean).join(' · ') || null;
    push([xmlTag(b, 'FIRST_NAME'), xmlTag(b, 'SECOND_NAME'), xmlTag(b, 'THIRD_NAME'), xmlTag(b, 'FOURTH_NAME')].join(' '), id, note);
    for (const alias of xmlTags(b, 'ALIAS_NAME')) push(alias, id, note ? `${note} · alias` : 'alias');
  }
  for (const m of text.matchAll(/<ENTITY>([\s\S]*?)<\/ENTITY>/g)) {
    const b = m[1];
    const id = xmlTag(b, 'DATAID') || xmlTag(b, 'REFERENCE_NUMBER');
    const note = [xmlTag(b, 'UN_LIST_TYPE'), xmlTag(b, 'REFERENCE_NUMBER'), 'entity'].filter(Boolean).join(' · ');
    push(xmlTag(b, 'FIRST_NAME'), id, note);
    for (const alias of xmlTags(b, 'ALIAS_NAME')) push(alias, id, `${note} · alias`);
  }
  return out;
}

/** EU financial sanctions file (semicolon CSV): one row per name alias, keyed by the entity logical id. */
export function parseEuFsfCsv(text: string): SanctionRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = csvSplit(lines[0], ';').map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
  const find = (...keys: string[]) => header.findIndex((h) => keys.some((k) => h === k || h.endsWith(k)));
  const whole = find('wholename');
  const logical = find('entitylogicalid', 'logicalid');
  const ref = find('entityeureferencenumber', 'eureferencenumber');
  const type = find('entitysubjecttype', 'subjecttype');
  const programme = find('entityregulationprogramme', 'regulationprogramme');
  if (whole < 0) return [];
  const out: SanctionRow[] = [];
  for (const l of lines.slice(1)) {
    const c = csvSplit(l, ';');
    const value = (c[whole] ?? '').trim();
    if (!value) continue;
    const note = [type >= 0 ? c[type] : '', programme >= 0 ? c[programme] : '', ref >= 0 ? c[ref] : ''].filter(Boolean).join(' · ') || null;
    out.push({ kind: 'name', value, externalId: logical >= 0 ? c[logical] || null : null, note });
  }
  return out;
}

/** Parse a fetched list in the source's declared format. */
export function parseSanctionsFeed(format: SanctionsFormat, text: string): SanctionRow[] {
  switch (format) {
    case 'json':
      return JSON.parse(text) as SanctionRow[];
    case 'uk_ofsi':
      return parseUkOfsiCsv(text);
    case 'un_xml':
      return parseUnConsolidatedXml(text);
    case 'eu_fsf':
      return parseEuFsfCsv(text);
    default:
      return parseSanctionsCsv(text);
  }
}

/** Fetch and import a source from its URL (daily job). Never runs in tests. */
export async function refreshSource(id: string, actor: Actor = { type: 'system' }): Promise<{ ok: boolean; imported?: number; error?: string }> {
  const db = getDb();
  const src = db.prepare('SELECT * FROM sanctions_sources WHERE id = ?').get(id) as any;
  if (!src) throw notFound('Sanctions source not found', 'source_not_found');
  if (!src.url) return { ok: false, error: 'no url configured' };
  try {
    const res = await fetch(src.url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const rows = parseSanctionsFeed(src.format as SanctionsFormat, text);
    const version = res.headers.get('etag') ?? res.headers.get('last-modified') ?? now();
    const r = importSanctionsRows(id, rows, version, actor);
    return { ok: true, imported: r.imported };
  } catch (err) {
    db.prepare('UPDATE sanctions_sources SET last_error = ? WHERE id = ?').run((err as Error).message, id);
    recordEvent('risk', id, 'sanctions.refresh_failed', actor, { error: (err as Error).message });
    return { ok: false, error: (err as Error).message };
  }
}
export async function refreshAllSources(opts: { onlyNeverRefreshed?: boolean } = {}): Promise<{ refreshed: number; failed: string[] }> {
  let refreshed = 0;
  const failed: string[] = [];
  for (const s of listSources().filter((x) => x.enabled && x.url && (!opts.onlyNeverRefreshed || !x.lastRefreshedAt))) {
    const r = await refreshSource(s.id);
    if (r.ok) refreshed += 1;
    else failed.push(`${s.name}: ${r.error}`);
  }
  return { refreshed, failed };
}
