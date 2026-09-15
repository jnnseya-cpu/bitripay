import { getDb } from '../db';
import { currencyFlag } from '@bitripay/shared';
import { uuid, now } from '../lib/ids';
import { badRequest, notFound } from '../lib/errors';
import type { Wallet } from '@bitripay/shared';
import { getCurrency } from './currencies';
import { updateUser, type UserRow } from './users';
import { classifyBalance } from './emoney';

export interface WalletRow {
  id: string;
  user_id: string;
  currency: string;
  balance: number;
  created_at: string;
  promo_balance?: number;
  frozen_at?: string | null;
  frozen_reason?: string | null;
  frozen_by?: string | null;
}

export function toWallet(row: WalletRow, user?: { role: string; main_currency?: string | null; alternative_currency?: string | null } | null): Wallet {
  const base: Wallet = {
    id: row.id,
    userId: row.user_id,
    currency: row.currency,
    balance: row.balance,
    createdAt: row.created_at,
    promoBalance: row.promo_balance ?? 0,
    frozen: !!row.frozen_at,
    frozenReason: row.frozen_reason ?? null,
    flag: currencyFlag(row.currency),
    role: user ? walletRole(row.currency, user) : null,
  };
  if (user) {
    try {
      base.classification = classifyBalance(user, row.currency);
    } catch {
      /* classification is informational */
    }
  }
  return base;
}

export function ensureWallet(userId: string, currency: string): WalletRow {
  const db = getDb();
  const code = currency.toUpperCase();
  const existing = db.prepare('SELECT * FROM wallets WHERE user_id = ? AND currency = ?').get(userId, code) as WalletRow | undefined;
  if (existing) return existing;
  getCurrency(code);
  const id = uuid();
  db.prepare('INSERT INTO wallets (id, user_id, currency, balance, created_at) VALUES (?, ?, ?, 0, ?)').run(id, userId, code, now());
  return db.prepare('SELECT * FROM wallets WHERE id = ?').get(id) as WalletRow;
}

export function listWallets(userId: string): WalletRow[] {
  return getDb().prepare('SELECT * FROM wallets WHERE user_id = ? ORDER BY created_at ASC').all(userId) as WalletRow[];
}

/** `main` / `alternative` from the person's preferences, else null. */
export function walletRole(currency: string, user: { main_currency?: string | null; alternative_currency?: string | null }): 'main' | 'alternative' | null {
  if (user.main_currency === currency) return 'main';
  if (user.alternative_currency === currency) return 'alternative';
  return null;
}

/** Wallets in the order the apps show and pick them: main first, alternative second, then the others by age. */
export function listWalletsOrdered(user: { id: string; main_currency?: string | null; alternative_currency?: string | null }): WalletRow[] {
  const rank = (w: WalletRow) => (w.currency === user.main_currency ? 0 : w.currency === user.alternative_currency ? 1 : 2);
  return listWallets(user.id).sort((a, b) => rank(a) - rank(b) || a.created_at.localeCompare(b.created_at));
}

/**
 * Sets the main and alternative wallets (both optional, never the same currency); a missing wallet is created so the
 * choice is usable at once. Changeable at any time.
 */
export function setWalletPreferences(user: UserRow, prefs: { main?: string | null; alternative?: string | null }): UserRow {
  const main = prefs.main === undefined ? (user.main_currency ?? null) : prefs.main ? getCurrency(prefs.main).code : null;
  const alternative = prefs.alternative === undefined ? (user.alternative_currency ?? null) : prefs.alternative ? getCurrency(prefs.alternative).code : null;
  if (main && alternative && main === alternative) throw badRequest('The main and alternative wallets must be different currencies', 'same_currency');
  for (const c of [main, alternative]) if (c) ensureWallet(user.id, c);
  return updateUser(user.id, { main_currency: main, alternative_currency: alternative } as any);
}

export function getWallet(id: string): WalletRow {
  const w = getDb().prepare('SELECT * FROM wallets WHERE id = ?').get(id) as WalletRow | undefined;
  if (!w) throw notFound('Wallet not found', 'wallet_not_found');
  return w;
}

export function getUserWallet(userId: string, currency: string, autoCreate = false): WalletRow {
  const w = getDb().prepare('SELECT * FROM wallets WHERE user_id = ? AND currency = ?').get(userId, currency.toUpperCase()) as WalletRow | undefined;
  if (!w) {
    if (autoCreate) return ensureWallet(userId, currency);
    throw badRequest(`You do not have a ${currency.toUpperCase()} wallet`, 'wallet_not_found');
  }
  return w;
}
