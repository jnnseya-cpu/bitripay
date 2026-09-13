import { getDb } from '../db';
import { now } from '../lib/ids';
import { notFound } from '../lib/errors';
import { MOBILE_MONEY_OPERATORS } from '@bitripay/shared';

export interface MomoOperator {
  id: string;
  name: string;
  brand: string;
  country: string;
  currency: string;
  ussd: string | null;
  color: string;
  collectionNumber: string | null;
  collectionName: string | null;
  instructions: string | null;
  payoutEnabled: boolean;
  enabled: boolean;
  sortOrder: number;
  /** True when customers can pay this operator through the direct rail (collection number configured). */
  directRail: boolean;
}

function map(r: any): MomoOperator {
  return {
    id: r.id,
    name: r.name,
    brand: r.brand,
    country: r.country,
    currency: r.currency,
    ussd: r.ussd,
    color: r.color,
    collectionNumber: r.collection_number,
    collectionName: r.collection_name,
    instructions: r.instructions,
    payoutEnabled: !!r.payout_enabled,
    enabled: !!r.enabled,
    sortOrder: r.sort_order,
    directRail: !!r.collection_number,
  };
}

/** Seed the world operator directory (idempotent; keeps admin edits). */
export function ensureMomoOperators() {
  const db = getDb();
  const existing = new Set((db.prepare('SELECT id FROM momo_operators').all() as any[]).map((r) => r.id));
  const insert = db.prepare(
    'INSERT INTO momo_operators (id, name, brand, country, currency, ussd, color, payout_enabled, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)',
  );
  db.transaction(() => {
    MOBILE_MONEY_OPERATORS.forEach((o, i) => {
      if (existing.has(o.id)) return;
      insert.run(o.id, o.name, o.brand, o.country, o.currency, o.ussd ?? null, o.color, i, now(), now());
    });
  })();
}

export function listOperators(filter: { country?: string | null; currency?: string | null; onlyEnabled?: boolean; onlyDirect?: boolean } = {}): MomoOperator[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.onlyEnabled !== false) where.push('enabled = 1');
  if (filter.country) {
    where.push('country = ?');
    params.push(filter.country.toUpperCase());
  }
  if (filter.currency) {
    where.push('currency = ?');
    params.push(filter.currency.toUpperCase());
  }
  if (filter.onlyDirect) where.push("collection_number IS NOT NULL AND collection_number != ''");
  const sql = `SELECT * FROM momo_operators ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY country, sort_order, name`;
  return getDb()
    .prepare(sql)
    .all(...params)
    .map(map);
}

export function getOperator(id: string): MomoOperator {
  const row = getDb().prepare('SELECT * FROM momo_operators WHERE id = ?').get(id);
  if (!row) throw notFound('Mobile money operator not found', 'operator_not_found');
  return map(row);
}

export function upsertOperator(input: {
  id: string;
  name: string;
  brand: string;
  country: string;
  currency: string;
  ussd?: string | null;
  color?: string;
  collectionNumber?: string | null;
  collectionName?: string | null;
  instructions?: string | null;
  payoutEnabled: boolean;
  enabled: boolean;
  sortOrder?: number;
}): MomoOperator {
  getDb()
    .prepare(
      `INSERT INTO momo_operators (id, name, brand, country, currency, ussd, color, collection_number, collection_name, instructions, payout_enabled, enabled, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, brand = excluded.brand, country = excluded.country, currency = excluded.currency, ussd = excluded.ussd, color = excluded.color,
         collection_number = excluded.collection_number, collection_name = excluded.collection_name, instructions = excluded.instructions, payout_enabled = excluded.payout_enabled, enabled = excluded.enabled, sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
    )
    .run(
      input.id,
      input.name,
      input.brand,
      input.country.toUpperCase(),
      input.currency.toUpperCase(),
      input.ussd ?? null,
      input.color ?? '#6366f1',
      input.collectionNumber || null,
      input.collectionName || null,
      input.instructions || null,
      input.payoutEnabled ? 1 : 0,
      input.enabled ? 1 : 0,
      input.sortOrder ?? 0,
      now(),
      now(),
    );
  return getOperator(input.id);
}

export function deleteOperator(id: string) {
  getDb().prepare('DELETE FROM momo_operators WHERE id = ?').run(id);
}
