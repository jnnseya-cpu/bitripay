/**
 * Immutable, hash-chained event log. Every authentication, evidence, approval, lifecycle and ledger
 * event is appended here with the actor that caused it; rows can never be updated or deleted
 * (enforced by database triggers) and each row's hash covers the previous row's hash, so any
 * tampering with history breaks the chain (see verifyEventChain).
 */
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { sha256 } from '../lib/crypto';
import { parseJson } from '../lib/json';

export type ActorType = 'user' | 'admin' | 'agent' | 'merchant' | 'device' | 'processor' | 'system' | 'guest';
export interface Actor {
  type: ActorType;
  id?: string | null;
}
export type EventStream = 'payment' | 'auth' | 'evidence' | 'approval' | 'ledger' | 'admin' | 'risk' | 'route' | 'payout' | 'liquidity' | 'corridor' | 'chargeback' | 'issuance' | 'switch' | 'reconciliation';

export interface EventRow {
  seq: number;
  id: string;
  stream: EventStream;
  subjectId: string | null;
  event: string;
  actor: Actor;
  details: Record<string, unknown>;
  prevHash: string | null;
  hash: string;
  createdAt: string;
}

function canonical(input: { id: string; stream: string; subjectId: string | null; event: string; actorType: string; actorId: string | null; details: string; createdAt: string; prevHash: string | null }) {
  return [input.prevHash ?? '', input.id, input.stream, input.subjectId ?? '', input.event, input.actorType, input.actorId ?? '', input.createdAt, input.details].join('|');
}

export function recordEvent(stream: EventStream, subjectId: string | null, event: string, actor: Actor, details: Record<string, unknown> = {}): EventRow {
  const db = getDb();
  return db.transaction(() => {
    const last = db.prepare('SELECT hash FROM event_log ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined;
    const id = uuid();
    const createdAt = now();
    const detailsJson = JSON.stringify(details ?? {});
    const hash = sha256(canonical({ id, stream, subjectId, event, actorType: actor.type, actorId: actor.id ?? null, details: detailsJson, createdAt, prevHash: last?.hash ?? null }));
    db.prepare('INSERT INTO event_log (id, stream, subject_id, event, actor_type, actor_id, details, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, stream, subjectId, event, actor.type, actor.id ?? null, detailsJson, last?.hash ?? null, hash, createdAt);
    return toEvent(db.prepare('SELECT * FROM event_log WHERE id = ?').get(id));
  })();
}

function toEvent(r: any): EventRow {
  return { seq: r.seq, id: r.id, stream: r.stream, subjectId: r.subject_id, event: r.event, actor: { type: r.actor_type, id: r.actor_id }, details: parseJson(r.details, {}), prevHash: r.prev_hash, hash: r.hash, createdAt: r.created_at };
}

export function listEvents(filter: { stream?: EventStream; subjectId?: string; limit?: number; page?: number } = {}): { items: EventRow[]; total: number } {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.stream) {
    where.push('stream = ?');
    params.push(filter.stream);
  }
  if (filter.subjectId) {
    where.push('subject_id = ?');
    params.push(filter.subjectId);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = filter.limit ?? 100;
  const page = filter.page ?? 1;
  const total = (db.prepare(`SELECT COUNT(*) c FROM event_log ${whereSql}`).get(...params) as any).c as number;
  const rows = db.prepare(`SELECT * FROM event_log ${whereSql} ORDER BY seq ${filter.subjectId ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit) as any[];
  return { items: rows.map(toEvent), total };
}

/** Re-hash the whole chain; returns the first broken sequence number if history was altered. */
export function verifyEventChain(): { ok: boolean; checked: number; brokenAt: number | null } {
  const rows = getDb().prepare('SELECT * FROM event_log ORDER BY seq ASC').all() as any[];
  let prev: string | null = null;
  for (const r of rows) {
    const expected = sha256(canonical({ id: r.id, stream: r.stream, subjectId: r.subject_id, event: r.event, actorType: r.actor_type, actorId: r.actor_id, details: r.details, createdAt: r.created_at, prevHash: prev }));
    if (expected !== r.hash || r.prev_hash !== prev) return { ok: false, checked: rows.length, brokenAt: r.seq };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length, brokenAt: null };
}
