/**
 * Account closure (right to erasure): the account holder, or an administrator on a lawful request, closes an account
 * once nothing is outstanding. Personal data is anonymised in place (name, e-mail, phone, tag, business name, address),
 * every session and API key is revoked, push tokens and contact channels are removed; the ledger rows stay under the
 * pseudonymous account id for the retention period the law requires, and the closure is written to the event log.
 */
import { getDb } from '../db';
import { now, shortCode } from '../lib/ids';
import { conflict, unprocessable } from '../lib/errors';
import { findUserById, updateUser, type UserRow } from './users';
import { listWallets } from './wallets';
import { heldByKind } from './finops/holds';
import { recordEvent, type Actor } from './events';
import { emitAsync } from './comms/engine';
import { removeAllPictures } from './pictures';

export interface ClosureBlocker {
  code: string;
  detail: string;
}

/** Everything that must be settled before an account can close. */
export function closureBlockers(user: UserRow): ClosureBlocker[] {
  const db = getDb();
  const blockers: ClosureBlocker[] = [];
  for (const w of listWallets(user.id)) {
    if (w.balance !== 0) blockers.push({ code: 'balance_not_zero', detail: `${w.currency} balance ${w.balance}` });
    const held = Object.values(heldByKind(w.id)).reduce((a, b) => a + b, 0);
    if (held > 0) blockers.push({ code: 'active_holds', detail: `${w.currency} held ${held}` });
  }
  const pending = (db.prepare("SELECT COUNT(*) c FROM transactions WHERE (sender_user_id = ? OR receiver_user_id = ?) AND status = 'pending'").get(user.id, user.id) as { c: number }).c;
  if (pending) blockers.push({ code: 'pending_transactions', detail: `${pending} pending transaction(s)` });
  const cards = (db.prepare("SELECT COUNT(*) c FROM virtual_cards WHERE user_id = ? AND status != 'closed' AND balance > 0").get(user.id) as { c: number }).c;
  if (cards) blockers.push({ code: 'card_balance', detail: `${cards} virtual card(s) still hold money` });
  if (user.role === 'agent') {
    const open = (db.prepare("SELECT COUNT(*) c FROM cash_requests WHERE agent_id = ? AND status = 'pending'").get(user.id) as { c: number }).c;
    if (open) blockers.push({ code: 'open_cash_requests', detail: `${open} pending cash request(s)` });
  }
  return blockers;
}

/** Close and anonymise. Throws with the blockers when something is outstanding. */
export function closeAccount(user: UserRow, actor: Actor, reason: string): UserRow {
  if (user.status === 'closed') throw conflict('This account is already closed', 'account_closed');
  const blockers = closureBlockers(user);
  if (blockers.length) throw unprocessable(`The account cannot be closed yet: ${blockers.map((b) => b.detail).join('; ')}`, 'closure_blocked', { blockers });
  const db = getDb();
  const at = now();
  // Say goodbye while the contact channels still exist (mandatory notice, bypasses opt-outs).
  emitAsync('account.closed', { userId: user.id, vars: {}, data: { kind: 'account' } });
  const pseudonym = `closed_${shortCode(10).toLowerCase()}`;
  db.transaction(() => {
    updateUser(user.id, {
      full_name: 'Closed account',
      email: null,
      phone: null,
      tag: pseudonym,
      business_name: null,
      status: 'closed',
      closed_at: at,
      sessions_invalidated_at: at,
      two_factor_enabled: 0,
      two_factor_secret: null,
      pin_hash: null,
      password_hash: null,
    } as any);
    removeAllPictures(user.id);
    db.prepare('DELETE FROM push_tokens WHERE user_id = ?').run(user.id);
    db.prepare('UPDATE api_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(at, user.id);
    db.prepare("UPDATE virtual_cards SET status = 'closed' WHERE user_id = ?").run(user.id);
    recordEvent('auth', user.id, 'account.closed', actor, { reason, pseudonym, formerRole: user.role });
  })();
  return findUserById(user.id)!;
}
