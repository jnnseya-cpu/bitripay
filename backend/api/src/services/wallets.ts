import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { badRequest, notFound } from '../lib/errors';
import type { Wallet } from '@bitripay/shared';
import { getCurrency } from './currencies';
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

export function toWallet(row: WalletRow, user?: { role: string } | null): Wallet {
  const base: Wallet = {
    id: row.id,
    userId: row.user_id,
    currency: row.currency,
    balance: row.balance,
    createdAt: row.created_at,
    promoBalance: row.promo_balance ?? 0,
    frozen: !!row.frozen_at,
    frozenReason: row.frozen_reason ?? null,
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
