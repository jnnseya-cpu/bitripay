/**
 * Holds: money that stays in the wallet but cannot be spent or settled (a dispute under review, a compliance reserve,
 * a settlement in preparation). A hold is not a ledger movement; it only shrinks the available class of the balance.
 */
import { getDb } from '../../db';
import { now, shortCode } from '../../lib/ids';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { recordEvent, type Actor } from '../events';
import { getWallet, type WalletRow } from '../wallets';

export type HoldKind = 'dispute' | 'reserve' | 'review' | 'settlement' | 'compliance';
export interface HoldView {
  id: string;
  walletId: string;
  userId: string;
  amountMinor: number;
  currency: string;
  kind: HoldKind;
  refType: string | null;
  refId: string | null;
  reason: string | null;
  status: 'ACTIVE' | 'RELEASED';
  createdBy: string | null;
  releasedBy: string | null;
  expiresAt: string | null;
  createdAt: string;
  releasedAt: string | null;
}
const toView = (r: any): HoldView => ({ id: r.id, walletId: r.wallet_id, userId: r.user_id, amountMinor: r.amount_minor, currency: r.currency, kind: r.kind, refType: r.ref_type, refId: r.ref_id, reason: r.reason, status: r.status, createdBy: r.created_by, releasedBy: r.released_by, expiresAt: r.expires_at, createdAt: r.created_at, releasedAt: r.released_at });

export function createHold(input: { walletId: string; amountMinor: number; kind: HoldKind; refType?: string | null; refId?: string | null; reason?: string | null; expiresAt?: string | null }, actor: Actor): HoldView {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw badRequest('Hold amount must be a positive integer', 'invalid_amount');
  const wallet = getWallet(input.walletId);
  const id = `hold_${shortCode(12).toLowerCase()}`;
  getDb().prepare('INSERT INTO holds (id, wallet_id, user_id, amount_minor, currency, kind, ref_type, ref_id, reason, status, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, wallet.id, wallet.user_id, input.amountMinor, wallet.currency, input.kind, input.refType ?? null, input.refId ?? null, input.reason ?? null, 'ACTIVE', actor.id ?? null, input.expiresAt ?? null, now());
  recordEvent('ledger', wallet.id, 'hold.created', actor, { holdId: id, amount: input.amountMinor, kind: input.kind, ref: input.refId ?? null });
  return getHold(id);
}

export function getHold(id: string): HoldView {
  const r = getDb().prepare('SELECT * FROM holds WHERE id = ?').get(id);
  if (!r) throw notFound('Hold not found', 'hold_not_found');
  return toView(r);
}

export function releaseHold(id: string, actor: Actor, reason?: string | null): HoldView {
  const h = getHold(id);
  if (h.status !== 'ACTIVE') throw conflict('Hold already released', 'hold_released');
  getDb().prepare("UPDATE holds SET status = 'RELEASED', released_by = ?, released_at = ? WHERE id = ?").run(actor.id ?? null, now(), id);
  recordEvent('ledger', h.walletId, 'hold.released', actor, { holdId: id, amount: h.amountMinor, reason: reason ?? null });
  return getHold(id);
}

export function releaseHoldsFor(refType: string, refId: string, actor: Actor, reason?: string | null): number {
  const rows = getDb().prepare("SELECT id FROM holds WHERE ref_type = ? AND ref_id = ? AND status = 'ACTIVE'").all(refType, refId) as { id: string }[];
  for (const r of rows) releaseHold(r.id, actor, reason);
  return rows.length;
}

export function heldAmount(walletId: string, kind?: HoldKind | null): number {
  return (getDb().prepare(`SELECT COALESCE(SUM(amount_minor), 0) s FROM holds WHERE wallet_id = ? AND status = 'ACTIVE' ${kind ? 'AND kind = ?' : ''}`).get(...(kind ? [walletId, kind] : [walletId])) as any).s as number;
}

export function heldByKind(walletId: string): Record<string, number> {
  const rows = getDb().prepare("SELECT kind, COALESCE(SUM(amount_minor), 0) s FROM holds WHERE wallet_id = ? AND status = 'ACTIVE' GROUP BY kind").all(walletId) as any[];
  return Object.fromEntries(rows.map((r) => [r.kind, r.s]));
}

export function availableBalance(wallet: WalletRow): number {
  if (wallet.frozen_at) return 0;
  return Math.max(0, wallet.balance - heldAmount(wallet.id));
}

export function listHolds(filter: { userId?: string | null; walletId?: string | null; status?: string | null; limit?: number } = {}): HoldView[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.userId) {
    where.push('user_id = ?');
    params.push(filter.userId);
  }
  if (filter.walletId) {
    where.push('wallet_id = ?');
    params.push(filter.walletId);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  return (getDb().prepare(`SELECT * FROM holds ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`).all(...params, Math.min(200, filter.limit ?? 50)) as any[]).map(toView);
}

/** Scheduler: holds with an expiry release themselves. */
export function expireHolds(): number {
  const rows = getDb().prepare("SELECT id FROM holds WHERE status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at < ?").all(now()) as { id: string }[];
  for (const r of rows) releaseHold(r.id, { type: 'system' }, 'expired');
  return rows.length;
}
