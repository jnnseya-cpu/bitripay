/**
 * Settlement-account change protection. Changing where money is paid out (a new bank account, a new mobile-money
 * number, a new settlement destination) is the classic account-takeover move, so every change is recorded with
 * the previous value, announced loudly to the account holder, refused while the credentials were just changed,
 * and cooled off: large payouts to the new destination wait until the cooling window passes or an administrator
 * approves the change. The account holder can revoke a change they did not make, which opens a compliance case.
 */
import { getDb } from '../../db';
import { now, shortCode } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { getSetting, getRiskSettings } from '../settings';
import { recordEvent, type Actor } from '../events';
import { findUserById, type UserRow } from '../users';
import { notify } from '../notifications';
import { openCase } from './compliance';

export interface AccountProtectionSettings {
  /** Hours a new payout destination waits before it can receive more than the cooling-off amount. */
  coolingOffHours: number;
  /** Destination changes are refused this long after a password or contact change. */
  lockAfterCredentialChangeHours: number;
  /** Payouts to a cooling destination at/above this base-minor amount are refused (defaults to risk.coolingOffAmount). */
  coolingAmountBase: number | null;
}
const DEFAULT: AccountProtectionSettings = { coolingOffHours: 24, lockAfterCredentialChangeHours: 24, coolingAmountBase: null };
export const getAccountProtectionSettings = (): AccountProtectionSettings => ({ ...DEFAULT, ...getSetting<Partial<AccountProtectionSettings>>('accountProtection', {}) });

export type DestinationKind = 'bank_account' | 'settlement_profile' | 'mobile_money' | 'remittance_recipient';
export interface DestinationChange {
  id: string;
  userId: string;
  kind: DestinationKind;
  refId: string | null;
  previous: Record<string, unknown> | null;
  next: Record<string, unknown>;
  status: 'COOLING' | 'EFFECTIVE' | 'APPROVED' | 'REVOKED';
  riskFlags: string[];
  effectiveAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  createdAt: string;
}
const toView = (r: any): DestinationChange => ({
  id: r.id,
  userId: r.user_id,
  kind: r.kind,
  refId: r.ref_id,
  previous: r.previous ? parseJson(r.previous, null) : null,
  next: parseJson(r.next, {}),
  status: r.status === 'COOLING' && r.effective_at <= now() ? 'EFFECTIVE' : r.status,
  riskFlags: parseJson(r.risk_flags, []),
  effectiveAt: r.effective_at,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at,
  revokedBy: r.revoked_by,
  revokedAt: r.revoked_at,
  createdAt: r.created_at,
});

const mask = (v: unknown) => {
  const s = String(v ?? '');
  return s.length > 4 ? `••••${s.slice(-4)}` : s;
};
export function describeDestination(d: Record<string, unknown> | null): string {
  if (!d || !Object.keys(d).length) return 'wallet (no external destination)';
  if (d.method === 'mobile_money') return `mobile money ${mask(d.phone)}${d.operatorId ? ` (${d.operatorId})` : ''}`;
  if (d.bankAccountId) return `bank account ${mask(d.bankAccountId)}`;
  if (d.accountNumber) return `${d.bankName ?? 'bank'} ${mask(d.accountNumber)}`;
  if (d.payoutMethod === 'cash_pickup') return `cash pickup for ${d.name ?? 'recipient'}`;
  if (d.tag || d.phone || d.email) return `recipient ${d.name ?? ''} ${mask(d.tag ?? d.phone ?? d.email)}`.trim();
  return 'wallet';
}

/** Record a destination change; refuse it while the credentials were just changed. */
export function registerDestinationChange(
  user: UserRow & { password_changed_at?: string | null },
  input: { kind: DestinationKind; refId?: string | null; previous?: Record<string, unknown> | null; next: Record<string, unknown> },
  actor: Actor,
): DestinationChange {
  const s = getAccountProtectionSettings();
  const db = getDb();
  const flags: string[] = [];
  const pw = (db.prepare('SELECT password_changed_at FROM users WHERE id = ?').get(user.id) as any)?.password_changed_at as string | null;
  if (pw && Date.now() - Date.parse(pw) < s.lockAfterCredentialChangeHours * 3600_000 && actor.type !== 'admin') {
    recordEvent('risk', user.id, 'destination_change.refused', actor, { kind: input.kind, reason: 'credentials_recently_changed' });
    notify(
      user.id,
      'Payout destination change refused',
      `A new ${input.kind.replace('_', ' ')} cannot be added within ${s.lockAfterCredentialChangeHours} hours of a password change. If this was not you, contact support immediately.`,
      { kind: 'approval', loud: true },
    );
    throw forbidden(`Payout destinations cannot be changed within ${s.lockAfterCredentialChangeHours} hours of a password change`, 'destination_locked');
  }
  const recentLogin = user.last_login_at && Date.now() - Date.parse(user.last_login_at) < 15 * 60_000;
  if (recentLogin) flags.push('changed_shortly_after_login');
  const priorChanges = (db.prepare('SELECT COUNT(*) c FROM destination_changes WHERE user_id = ? AND created_at >= ?').get(user.id, new Date(Date.now() - 7 * 86_400_000).toISOString()) as any)
    .c as number;
  if (priorChanges >= 2) flags.push(`${priorChanges + 1}_changes_in_7d`);
  const id = `dc_${shortCode(12).toLowerCase()}`;
  const effectiveAt = new Date(Date.now() + s.coolingOffHours * 3600_000).toISOString();
  db.prepare('INSERT INTO destination_changes (id, user_id, kind, ref_id, previous, next, status, risk_flags, effective_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    user.id,
    input.kind,
    input.refId ?? null,
    input.previous ? JSON.stringify(input.previous) : null,
    JSON.stringify(input.next),
    'COOLING',
    JSON.stringify(flags),
    effectiveAt,
    now(),
  );
  recordEvent('risk', user.id, 'destination_change.recorded', actor, {
    changeId: id,
    kind: input.kind,
    refId: input.refId ?? null,
    from: describeDestination(input.previous ?? null),
    to: describeDestination(input.next),
    flags,
    effectiveAt,
  });
  notify(
    user.id,
    'Payout destination changed',
    `${describeDestination(input.next)} was added to your account. Large payouts to it start after ${s.coolingOffHours} hours. Not you? Revoke it now in Security.`,
    { kind: 'approval', loud: true, changeId: id, template: 'destination.changed', vars: { destination: describeDestination(input.next), hours: s.coolingOffHours } },
  );
  if (flags.length >= 2)
    openCase({
      kind: 'DESTINATION',
      userId: user.id,
      subjectType: 'destination_change',
      subjectId: id,
      severity: 'high',
      title: 'Suspicious payout destination change',
      summary: `${describeDestination(input.next)} added ${flags.join(', ').replace(/_/g, ' ')}.`,
      indicators: flags,
      dedupeKey: `dest:${user.id}:${id}`,
      sar: false,
    });
  return getDestinationChange(id);
}
export function getDestinationChange(id: string): DestinationChange {
  const r = getDb().prepare('SELECT * FROM destination_changes WHERE id = ?').get(id);
  if (!r) throw notFound('Destination change not found', 'change_not_found');
  return toView(r);
}
export function listDestinationChanges(filter: { userId?: string | null; status?: string | null; limit?: number } = {}): DestinationChange[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.userId) {
    where.push('user_id = ?');
    params.push(filter.userId);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  return (
    getDb()
      .prepare(`SELECT * FROM destination_changes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, Math.min(500, filter.limit ?? 100)) as any[]
  ).map(toView);
}
/** A payout to a destination still cooling off is refused above the cooling amount unless the change was approved. */
export function assertDestinationUsable(user: UserRow, kind: DestinationKind, refId: string | null, baseMinor: number): void {
  const s = getAccountProtectionSettings();
  const limit = s.coolingAmountBase ?? getRiskSettings().coolingOffAmount;
  const rows = (
    getDb()
      .prepare(
        "SELECT * FROM destination_changes WHERE user_id = ? AND kind = ? AND (ref_id = ? OR (? IS NULL AND ref_id IS NULL)) AND status IN ('COOLING', 'REVOKED') ORDER BY created_at DESC LIMIT 1",
      )
      .all(user.id, kind, refId, refId) as any[]
  ).map(toView);
  const c = rows[0];
  if (!c) return;
  if (c.status === 'REVOKED') throw forbidden('This payout destination was revoked by the account holder', 'destination_locked');
  if (c.status === 'COOLING' && baseMinor > limit) {
    recordEvent('risk', user.id, 'destination_change.payout_refused', { type: 'system' }, { changeId: c.id, baseMinor, limit, effectiveAt: c.effectiveAt });
    throw forbidden(
      `This payout destination was changed recently. Amounts above the cooling-off limit can be paid from ${c.effectiveAt.slice(0, 16).replace('T', ' ')} UTC, or once support approves the change.`,
      'destination_cooling',
    );
  }
}
export function approveDestinationChange(id: string, adminId: string): DestinationChange {
  const c = getDestinationChange(id);
  if (c.status === 'REVOKED') throw conflict('Change was revoked', 'change_revoked');
  getDb().prepare("UPDATE destination_changes SET status = 'APPROVED', approved_by = ?, approved_at = ? WHERE id = ?").run(adminId, now(), id);
  recordEvent('risk', c.userId, 'destination_change.approved', { type: 'admin', id: adminId }, { changeId: id });
  return getDestinationChange(id);
}
/** "This wasn't me": the destination is locked, the account holder is told, and compliance gets a case. */
export function revokeDestinationChange(id: string, actor: Actor): DestinationChange {
  const c = getDestinationChange(id);
  if (actor.type !== 'admin' && actor.id !== c.userId) throw forbidden('Not your change', 'not_owner');
  getDb()
    .prepare("UPDATE destination_changes SET status = 'REVOKED', revoked_by = ?, revoked_at = ? WHERE id = ?")
    .run(actor.id ?? null, now(), id);
  recordEvent('risk', c.userId, 'destination_change.revoked', actor, { changeId: id, kind: c.kind, refId: c.refId });
  const u = findUserById(c.userId);
  openCase({
    kind: 'DESTINATION',
    userId: c.userId,
    subjectType: 'destination_change',
    subjectId: id,
    severity: 'critical',
    title: 'Account holder revoked a payout destination change',
    summary: `${u?.full_name ?? c.userId} revoked ${describeDestination(c.next)} (${c.kind}); possible account takeover.`,
    indicators: ['revoked_by_account_holder', ...c.riskFlags],
    dedupeKey: `dest-revoke:${id}`,
  });
  return getDestinationChange(id);
}
