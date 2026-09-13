import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { notFound } from '../lib/errors';
import type { SavedCard } from '@bitripay/shared';

export function toSavedCard(row: any): SavedCard {
  return { id: row.id, provider: row.provider, brand: row.brand, last4: row.last4, expMonth: row.exp_month, expYear: row.exp_year, holderName: row.holder_name, isDefault: !!row.is_default };
}

export function listSavedCards(userId: string): SavedCard[] {
  return getDb().prepare('SELECT * FROM saved_cards WHERE user_id = ? ORDER BY is_default DESC, created_at DESC').all(userId).map(toSavedCard);
}

export function saveCardFromToken(userId: string, provider: string, card: { token: string; brand: string; last4: string; expMonth: number; expYear: number }, holderName: string): SavedCard {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM saved_cards WHERE user_id = ? AND provider = ? AND provider_ref = ?').get(userId, provider, card.token) as any;
  if (existing) return toSavedCard(existing);
  const count = (db.prepare('SELECT COUNT(*) c FROM saved_cards WHERE user_id = ?').get(userId) as any).c;
  const id = uuid();
  db.prepare('INSERT INTO saved_cards (id, user_id, provider, provider_ref, brand, last4, exp_month, exp_year, holder_name, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    userId,
    provider,
    card.token,
    card.brand,
    card.last4,
    card.expMonth,
    card.expYear,
    holderName,
    count === 0 ? 1 : 0,
    now(),
  );
  return toSavedCard(db.prepare('SELECT * FROM saved_cards WHERE id = ?').get(id));
}

export function setDefaultCard(userId: string, id: string) {
  const db = getDb();
  const card = db.prepare('SELECT * FROM saved_cards WHERE id = ? AND user_id = ?').get(id, userId);
  if (!card) throw notFound('Card not found');
  db.prepare('UPDATE saved_cards SET is_default = 0 WHERE user_id = ?').run(userId);
  db.prepare('UPDATE saved_cards SET is_default = 1 WHERE id = ?').run(id);
}

export function deleteSavedCard(userId: string, id: string) {
  const res = getDb().prepare('DELETE FROM saved_cards WHERE id = ? AND user_id = ?').run(id, userId);
  if (res.changes === 0) throw notFound('Card not found');
}
