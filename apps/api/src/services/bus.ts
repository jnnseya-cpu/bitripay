/**
 * Domain events (topic `bitripay.events`): the one way modules talk to each other. Every event is stored with the
 * canonical envelope {eventId, type, tenantId, aggregateId, occurredAt, payload, version} and handed to the
 * in-process subscribers (the agent mesh bindings, webhooks of the future, metrics). Handlers never throw into
 * the publisher: a failing subscriber is logged and the event stays in the store with the handlers that ran.
 */
import { getDb } from '../db';
import { now, uuid } from '../lib/ids';
import { parseJson } from '../lib/json';

export const DOMAIN_EVENT_TYPES = [
  'transaction.created', 'transaction.fraud_scored', 'transaction.authorised', 'transaction.settled', 'transaction.failed',
  'wallet.credited', 'wallet.debited', 'income.received', 'kyc.tier_changed', 'agent.float_low', 'settlement.cycle_closed',
  'dispute.opened', 'acu.budget_low', 'attempt.unknown', 'connector.degraded', 'statement.imported', 'recon.exception_aged',
  'verification.requested', 'sanctions.hit', 'merchant.created', 'offline.promise_rejected', 'diaspora.quote_created',
  'fx.alert_triggered', 'credit.readiness_updated', 'subscription.charged',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number] | (string & {});
export interface DomainEvent {
  eventId: string;
  type: DomainEventType;
  tenantId: string;
  aggregateId: string | null;
  occurredAt: string;
  payload: Record<string, unknown>;
  version: number;
}
type Handler = (event: DomainEvent) => void | Promise<void>;
const subscribers: { name: string; types: Set<string> | null; handler: Handler }[] = [];

export function subscribe(name: string, types: DomainEventType[] | '*', handler: Handler): () => void {
  const entry = { name, types: types === '*' ? null : new Set(types as string[]), handler };
  subscribers.push(entry);
  return () => {
    const i = subscribers.indexOf(entry);
    if (i >= 0) subscribers.splice(i, 1);
  };
}

/** Publish: persisted first, then delivered. Returns the envelope. */
export function publish(type: DomainEventType, payload: Record<string, unknown> = {}, opts: { tenantId?: string | null; aggregateId?: string | null; version?: number } = {}): DomainEvent {
  const ev: DomainEvent = { eventId: uuid(), type, tenantId: opts.tenantId ?? 'platform', aggregateId: opts.aggregateId ?? null, occurredAt: now(), payload, version: opts.version ?? 1 };
  getDb().prepare('INSERT INTO domain_events (event_id, type, tenant_id, aggregate_id, occurred_at, payload, version, handled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(ev.eventId, ev.type, ev.tenantId, ev.aggregateId, ev.occurredAt, JSON.stringify(ev.payload), ev.version, '[]');
  const handled: string[] = [];
  for (const s of subscribers) {
    if (s.types && !s.types.has(type)) continue;
    try {
      const r = s.handler(ev);
      if (r && typeof (r as Promise<void>).then === 'function') (r as Promise<void>).catch((err) => console.error(`[bus] ${s.name} failed on ${type}: ${(err as Error).message}`));
      handled.push(s.name);
    } catch (err) {
      console.error(`[bus] ${s.name} failed on ${type}: ${(err as Error).message}`);
    }
  }
  if (handled.length) getDb().prepare('UPDATE domain_events SET handled = ? WHERE event_id = ?').run(JSON.stringify(handled), ev.eventId);
  return ev;
}

export function listDomainEvents(filter: { type?: string | null; aggregateId?: string | null; since?: string | null; limit?: number } = {}): DomainEvent[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.type) {
    where.push('type = ?');
    params.push(filter.type);
  }
  if (filter.aggregateId) {
    where.push('aggregate_id = ?');
    params.push(filter.aggregateId);
  }
  if (filter.since) {
    where.push('occurred_at >= ?');
    params.push(filter.since);
  }
  return (getDb().prepare(`SELECT * FROM domain_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY occurred_at DESC LIMIT ?`).all(...params, Math.min(500, filter.limit ?? 100)) as any[]).map((r) => ({ eventId: r.event_id, type: r.type, tenantId: r.tenant_id, aggregateId: r.aggregate_id, occurredAt: r.occurred_at, payload: parseJson(r.payload, {}), version: r.version, handled: parseJson(r.handled, []) })) as DomainEvent[];
}
