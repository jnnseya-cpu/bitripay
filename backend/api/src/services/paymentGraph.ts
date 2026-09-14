/**
 * Payment graph (specification §58): the money network as nodes (user, merchant, agent, device, beneficiary, hashed
 * payment method, provider, location) and dated edges (paid, received, cashed_in, cashed_out, used_device,
 * used_method, routed_via, shares_beneficiary, located_at). It is maintained incrementally from the domain bus
 * (every completed or settled transaction is projected inside the posting's own database transaction) and can be
 * rebuilt from the ledger at any time. The queries are the compliance officer's tools: neighbourhoods, shared
 * devices, payment rings (3–5 node cycles within 24 h), mules (many payers in, most of it forwarded within an hour)
 * and duplicate identities. Identities are only exposed to administrators holding the compliance permission;
 * merchants receive aggregates.
 */
import { getDb } from '../db';
import { uuid } from '../lib/ids';
import { parseJson } from '../lib/json';
import { sha256 } from '../lib/crypto';
import { subscribe } from './bus';
import { findUserById, type UserRow } from './users';
import type { TransactionRow } from './ledger';

export type GraphNodeKind = 'user' | 'merchant' | 'agent' | 'device' | 'beneficiary' | 'payment_method' | 'provider' | 'location';
export type GraphEdgeKind = 'paid' | 'received' | 'cashed_in' | 'cashed_out' | 'used_device' | 'used_method' | 'routed_via' | 'shares_beneficiary' | 'located_at';
export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  ref: string;
  label: string | null;
  meta: Record<string, unknown>;
  firstSeen: string;
  lastSeen: string;
}
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  amountMinor: number;
  currency: string | null;
  ref: string | null;
  occurredAt: string;
}
/** Transaction types that are a payment from one account holder to another. */
const PAYMENT_TYPES = new Set([
  'transfer',
  'qr_payment',
  'merchant_payment',
  'money_request',
  'bill_payment',
  'remittance',
  'distribution',
  'refund',
  'payout',
  'gift_card',
  'mobile_topup',
  'subscription',
]);

export const nodeId = (kind: GraphNodeKind, ref: string) => `${kind}:${ref}`;
export function personNodeId(user: Pick<UserRow, 'id' | 'role'>): string {
  return nodeId(user.role === 'agent' ? 'agent' : user.role === 'merchant' ? 'merchant' : 'user', user.id);
}
const toNode = (r: any): GraphNode => ({ id: r.id, kind: r.kind, ref: r.ref, label: r.label, meta: parseJson(r.meta, {}), firstSeen: r.first_seen, lastSeen: r.last_seen });
const toEdge = (r: any): GraphEdge => ({ id: r.id, from: r.from_node, to: r.to_node, kind: r.kind, amountMinor: r.amount_minor, currency: r.currency, ref: r.ref, occurredAt: r.occurred_at });

function upsertNode(kind: GraphNodeKind, ref: string, label: string | null, meta: Record<string, unknown>, seenAt: string): string {
  const id = nodeId(kind, ref);
  getDb()
    .prepare(
      'INSERT INTO graph_nodes (id, kind, ref, label, meta, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen), label = COALESCE(excluded.label, label)',
    )
    .run(id, kind, ref, label, JSON.stringify(meta), seenAt, seenAt);
  return id;
}
function addEdge(from: string, to: string, kind: GraphEdgeKind, occurredAt: string, opts: { amountMinor?: number; currency?: string | null; ref?: string | null } = {}): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO graph_edges (id, from_node, to_node, kind, amount_minor, currency, ref, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uuid(), from, to, kind, opts.amountMinor ?? 0, opts.currency ?? null, opts.ref ?? null, occurredAt);
}
function personNode(user: UserRow, seenAt: string): string {
  const kind: GraphNodeKind = user.role === 'agent' ? 'agent' : user.role === 'merchant' ? 'merchant' : 'user';
  return upsertNode(kind, user.id, user.business_name || user.full_name, { tag: user.tag, country: user.country }, seenAt);
}

/** Hash an identifier (MSISDN, card fingerprint, recipient phone) so the graph never stores the raw value. */
const hashRef = (value: string) => sha256(value.trim().toLowerCase()).slice(0, 32);

/** Project one ledger transaction into the graph (idempotent: edges are unique per transaction and kind). */
export function projectTransaction(tx: TransactionRow): void {
  // a reversed transaction did happen (the refund is its own movement), so it stays in the graph
  if (tx.status !== 'completed' && tx.status !== 'reversed') return;
  const at = tx.completed_at ?? tx.created_at;
  const meta = parseJson<Record<string, any>>(tx.metadata, {});
  const sender = tx.sender_user_id ? findUserById(tx.sender_user_id) : undefined;
  const receiver = tx.receiver_user_id ? findUserById(tx.receiver_user_id) : undefined;
  const s = sender && !sender.is_system ? personNode(sender, at) : null;
  const r = receiver && !receiver.is_system ? personNode(receiver, at) : null;
  const money = { amountMinor: tx.amount, currency: tx.currency, ref: tx.id };
  if (s && r && s !== r) {
    if (tx.type === 'agent_cash_in') addEdge(s, r, 'cashed_in', at, money);
    else if (tx.type === 'agent_cash_out') addEdge(s, r, 'cashed_out', at, money);
    else if (PAYMENT_TYPES.has(tx.type)) {
      addEdge(s, r, 'paid', at, money);
      addEdge(r, s, 'received', at, money);
      if (receiver!.role === 'user') linkSharedBeneficiary(s, r, at, tx.id);
    }
  }
  if (s) {
    const devices = new Set<string>();
    if (typeof meta.deviceHash === 'string' && meta.deviceHash) devices.add(meta.deviceHash);
    // The fraud assessment that preceded the posting (same account, moments before) carries the device the movement was made from.
    const assessedSince = new Date(Date.parse(tx.created_at) - 60_000).toISOString();
    for (const f of getDb()
      .prepare('SELECT device_hash FROM fraud_scores WHERE device_hash IS NOT NULL AND (subject_id = ? OR (user_id = ? AND created_at >= ? AND created_at <= ?))')
      .all(tx.id, tx.sender_user_id, assessedSince, tx.created_at) as { device_hash: string }[])
      devices.add(f.device_hash);
    for (const d of devices) addEdge(s, upsertNode('device', d, null, {}, at), 'used_device', at, { ref: tx.id });
    const identifier = meta.paymentMethodHash ?? meta.cardFingerprint ?? meta.msisdn ?? meta.phone ?? meta.last4 ?? null;
    if (identifier && meta.method && meta.method !== 'wallet' && meta.method !== 'agent')
      addEdge(s, upsertNode('payment_method', hashRef(`${meta.method}:${identifier}`), String(meta.method), { method: meta.method }, at), 'used_method', at, { ref: tx.id });
    const provider = meta.gateway ?? meta.connector ?? meta.provider ?? meta.operator ?? null;
    if (provider && provider !== 'wallet') addEdge(s, upsertNode('provider', String(provider).toLowerCase(), String(provider), {}, at), 'routed_via', at, money);
    const intentId = tx.intent_id ?? meta.intentId ?? null;
    const intent = intentId ? (getDb().prepare('SELECT location_id, route_connector, customer_country FROM payment_intents WHERE id = ?').get(intentId) as any) : null;
    if (intent?.route_connector && intent.route_connector !== 'wallet')
      addEdge(s, upsertNode('provider', String(intent.route_connector).toLowerCase(), intent.route_connector, {}, at), 'routed_via', at, money);
    if (intent?.location_id) addEdge(s, upsertNode('location', intent.location_id, null, { type: 'merchant_location' }, at), 'located_at', at, { ref: tx.id });
    const country = meta.ipCountry ?? intent?.customer_country ?? null;
    if (typeof country === 'string' && country)
      addEdge(s, upsertNode('location', `country:${country.toUpperCase()}`, country.toUpperCase(), { type: 'country' }, at), 'located_at', at, { ref: tx.id });
    const rem = getDb().prepare('SELECT recipient FROM remittances WHERE transaction_id = ?').get(tx.id) as { recipient: string } | undefined;
    if (rem) {
      const recipient = parseJson<Record<string, any>>(rem.recipient, {});
      const key = recipient.phone ?? recipient.accountNumber ?? recipient.email ?? recipient.name ?? null;
      if (key) {
        const b = upsertNode('beneficiary', hashRef(String(key)), recipient.name ?? null, { country: recipient.country ?? null }, at);
        addEdge(s, b, 'paid', at, money);
        linkSharedBeneficiary(s, b, at, tx.id);
      }
    }
  }
}

/** Every other payer of the same beneficiary shares it with this payer (both directions, one edge per pair). */
function linkSharedBeneficiary(payer: string, beneficiary: string, at: string, ref: string): void {
  const others = getDb().prepare("SELECT DISTINCT from_node FROM graph_edges WHERE to_node = ? AND kind = 'paid' AND from_node != ?").all(beneficiary, payer) as { from_node: string }[];
  for (const o of others) {
    addEdge(payer, o.from_node, 'shares_beneficiary', at, { ref: beneficiary });
    addEdge(o.from_node, payer, 'shares_beneficiary', at, { ref: `${beneficiary}#${ref}` });
  }
}

/** Drop and re-project the whole graph from completed (and later reversed) ledger transactions, oldest first. */
export function rebuildGraph(): { nodes: number; edges: number; transactions: number } {
  const db = getDb();
  return db.transaction(() => {
    db.prepare('DELETE FROM graph_edges').run();
    db.prepare('DELETE FROM graph_nodes').run();
    const rows = db.prepare("SELECT * FROM transactions WHERE status IN ('completed', 'reversed') ORDER BY COALESCE(completed_at, created_at) ASC, rowid ASC").all() as TransactionRow[];
    for (const tx of rows) projectTransaction(tx);
    return {
      nodes: (db.prepare('SELECT COUNT(*) c FROM graph_nodes').get() as any).c as number,
      edges: (db.prepare('SELECT COUNT(*) c FROM graph_edges').get() as any).c as number,
      transactions: rows.length,
    };
  })();
}

export function getNode(id: string): GraphNode | null {
  const r = getDb().prepare('SELECT * FROM graph_nodes WHERE id = ?').get(id);
  return r ? toNode(r) : null;
}

/** Resolve a user id or a node id to a node id. */
export function resolveNodeId(idOrUser: string): string {
  if (idOrUser.includes(':')) return idOrUser;
  const u = findUserById(idOrUser);
  return u ? personNodeId(u) : nodeId('user', idOrUser);
}

/** Breadth-first neighbourhood up to `depth` hops (max 3) in either direction, capped to keep responses bounded. */
export function neighbours(nodeIdOrUser: string, depth = 1, opts: { maxNodes?: number; kinds?: GraphEdgeKind[] } = {}): { root: string; depth: number; nodes: GraphNode[]; edges: GraphEdge[] } {
  const db = getDb();
  const root = resolveNodeId(nodeIdOrUser);
  const maxDepth = Math.max(1, Math.min(3, Math.floor(depth)));
  const maxNodes = Math.min(2000, opts.maxNodes ?? 500);
  const kindFilter = opts.kinds?.length ? ` AND kind IN (${opts.kinds.map(() => '?').join(',')})` : '';
  const stmt = db.prepare(`SELECT * FROM graph_edges WHERE (from_node = ? OR to_node = ?)${kindFilter} ORDER BY occurred_at DESC LIMIT 500`);
  const seen = new Set<string>([root]);
  const edges = new Map<string, GraphEdge>();
  let frontier = [root];
  for (let d = 0; d < maxDepth && frontier.length && seen.size < maxNodes; d += 1) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const e of (stmt.all(n, n, ...(opts.kinds ?? [])) as any[]).map(toEdge)) {
        edges.set(e.id, e);
        for (const other of [e.from, e.to]) {
          if (seen.has(other) || seen.size >= maxNodes) continue;
          seen.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  const nodes = Array.from(seen)
    .map((id) => getNode(id))
    .filter((n): n is GraphNode => !!n);
  // an account the graph has not seen yet is still a node (with no edges), so a lookup never comes back empty-handed
  if (!nodes.some((n) => n.id === root)) {
    const [kind, ref] = root.split(':') as [GraphNodeKind, string];
    const user = ref ? findUserById(ref) : undefined;
    if (user && !user.is_system)
      nodes.unshift({ id: root, kind, ref, label: user.business_name || user.full_name, meta: { tag: user.tag, country: user.country }, firstSeen: user.created_at, lastSeen: user.created_at });
  }
  return { root, depth: maxDepth, nodes, edges: Array.from(edges.values()) };
}

/** Device nodes both accounts used (ids may be user ids or node ids). */
export function sharedDevices(a: string, b: string): GraphNode[] {
  const na = resolveNodeId(a);
  const nb = resolveNodeId(b);
  return (
    getDb()
      .prepare(
        "SELECT n.* FROM graph_nodes n WHERE n.kind = 'device' AND EXISTS (SELECT 1 FROM graph_edges e WHERE e.kind = 'used_device' AND e.to_node = n.id AND e.from_node = ?) AND EXISTS (SELECT 1 FROM graph_edges e WHERE e.kind = 'used_device' AND e.to_node = n.id AND e.from_node = ?) ORDER BY n.last_seen DESC",
      )
      .all(na, nb) as any[]
  ).map(toNode);
}

export interface RingCandidate {
  nodes: string[];
  edges: GraphEdge[];
  startedAt: string;
  closedAt: string;
  spanMinutes: number;
  amountMinor: number;
}
/** Payment cycles A→B→…→A of 3–5 people whose hops all happen within `windowHours` (24 h) of the first hop. */
export function ringCandidates(opts: { sinceDays?: number; windowHours?: number; minLength?: number; maxLength?: number; limit?: number } = {}): RingCandidate[] {
  const sinceDays = opts.sinceDays ?? 7;
  const windowMs = (opts.windowHours ?? 24) * 3_600_000;
  const minLength = Math.max(3, opts.minLength ?? 3);
  const maxLength = Math.min(5, Math.max(minLength, opts.maxLength ?? 5));
  const since = new Date(Date.now() - (sinceDays * 24 + (opts.windowHours ?? 24)) * 3_600_000).toISOString();
  const edges = (
    getDb()
      .prepare("SELECT * FROM graph_edges WHERE kind = 'paid' AND occurred_at >= ? AND from_node NOT LIKE 'beneficiary:%' AND to_node NOT LIKE 'beneficiary:%' ORDER BY occurred_at ASC")
      .all(since) as any[]
  ).map(toEdge);
  const out = new Map<string, GraphEdge[]>();
  for (const e of edges) (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
  const found = new Map<string, RingCandidate>();
  let budget = 200_000;
  const walk = (start: string, path: string[], trail: GraphEdge[], t0: number, tPrev: number) => {
    if (budget-- <= 0) return;
    const here = path[path.length - 1];
    for (const e of out.get(here) ?? []) {
      const t = Date.parse(e.occurredAt);
      if (t < tPrev || t > t0 + windowMs) continue;
      if (e.to === start) {
        if (path.length >= minLength) {
          const key = [...path].sort().join('>');
          if (!found.has(key))
            found.set(key, {
              nodes: [...path],
              edges: [...trail, e],
              startedAt: trail[0].occurredAt,
              closedAt: e.occurredAt,
              spanMinutes: Math.round((t - t0) / 60_000),
              amountMinor: [...trail, e].reduce((a, x) => a + x.amountMinor, 0),
            });
        }
        continue;
      }
      if (path.length >= maxLength || path.includes(e.to)) continue;
      walk(start, [...path, e.to], [...trail, e], t0, t);
    }
  };
  for (const e of edges) {
    if (found.size >= (opts.limit ?? 50)) break;
    walk(e.from, [e.from, e.to], [e], Date.parse(e.occurredAt), Date.parse(e.occurredAt));
  }
  return Array.from(found.values()).slice(0, opts.limit ?? 50);
}

export interface MuleCandidate {
  node: string;
  payers: number;
  inboundMinor: number;
  forwardedMinor: number;
  forwardedShare: number;
  window: { sinceDays: number; forwardMinutes: number };
}
/** Accounts that receive from many payers and forward more than `threshold` (80 %) of it within `forwardMinutes` (60). */
export function muleCandidates(opts: { sinceDays?: number; minPayers?: number; forwardMinutes?: number; threshold?: number; limit?: number } = {}): MuleCandidate[] {
  const sinceDays = opts.sinceDays ?? 30;
  const minPayers = opts.minPayers ?? 3;
  const forwardMs = (opts.forwardMinutes ?? 60) * 60_000;
  const threshold = opts.threshold ?? 0.8;
  const db = getDb();
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const receivers = db
    .prepare(
      "SELECT to_node node, COUNT(DISTINCT from_node) payers, SUM(amount_minor) inbound FROM graph_edges WHERE kind = 'paid' AND occurred_at >= ? AND to_node NOT LIKE 'beneficiary:%' AND to_node NOT LIKE 'merchant:%' GROUP BY to_node HAVING COUNT(DISTINCT from_node) >= ? ORDER BY inbound DESC LIMIT 500",
    )
    .all(since, minPayers) as { node: string; payers: number; inbound: number }[];
  const inStmt = db.prepare("SELECT occurred_at FROM graph_edges WHERE kind = 'paid' AND to_node = ? AND occurred_at >= ? ORDER BY occurred_at ASC");
  const outStmt = db.prepare("SELECT amount_minor, occurred_at FROM graph_edges WHERE kind IN ('paid', 'cashed_out') AND from_node = ? AND occurred_at >= ? ORDER BY occurred_at ASC");
  const result: MuleCandidate[] = [];
  for (const r of receivers) {
    const ins = (inStmt.all(r.node, since) as { occurred_at: string }[]).map((x) => Date.parse(x.occurred_at));
    let forwarded = 0;
    for (const o of outStmt.all(r.node, since) as { amount_minor: number; occurred_at: string }[]) {
      const t = Date.parse(o.occurred_at);
      if (ins.some((i) => t >= i && t <= i + forwardMs)) forwarded += o.amount_minor;
    }
    const share = r.inbound > 0 ? Math.min(1, forwarded / r.inbound) : 0;
    if (share > threshold)
      result.push({
        node: r.node,
        payers: r.payers,
        inboundMinor: r.inbound,
        forwardedMinor: forwarded,
        forwardedShare: Math.round(share * 1000) / 1000,
        window: { sinceDays, forwardMinutes: opts.forwardMinutes ?? 60 },
      });
  }
  return result.slice(0, opts.limit ?? 100);
}

export interface DuplicateIdentityCandidate {
  a: string;
  b: string;
  signals: { kind: 'shared_device' | 'shared_method' | 'same_name'; ref: string }[];
  confidence: number;
}
/** Pairs of accounts that share a device, a hashed payment method or the same full name (each signal listed). */
export function duplicateIdentityCandidates(opts: { limit?: number } = {}): DuplicateIdentityCandidate[] {
  const db = getDb();
  const pairs = new Map<string, DuplicateIdentityCandidate>();
  const add = (a: string, b: string, kind: DuplicateIdentityCandidate['signals'][number]['kind'], ref: string) => {
    if (a === b) return;
    const [x, y] = [a, b].sort();
    const key = `${x}|${y}`;
    const entry = pairs.get(key) ?? { a: x, b: y, signals: [], confidence: 0 };
    if (!entry.signals.some((s) => s.kind === kind && s.ref === ref)) entry.signals.push({ kind, ref });
    pairs.set(key, entry);
  };
  for (const kind of ['used_device', 'used_method'] as const) {
    const rows = db
      .prepare(
        `SELECT e1.from_node a, e2.from_node b, e1.to_node shared FROM graph_edges e1 JOIN graph_edges e2 ON e1.to_node = e2.to_node AND e1.kind = e2.kind AND e1.from_node < e2.from_node WHERE e1.kind = ? GROUP BY 1, 2, 3 LIMIT 5000`,
      )
      .all(kind) as { a: string; b: string; shared: string }[];
    for (const r of rows) add(r.a, r.b, kind === 'used_device' ? 'shared_device' : 'shared_method', r.shared);
  }
  const names = db
    .prepare("SELECT LOWER(TRIM(full_name)) name, GROUP_CONCAT(id) ids, COUNT(*) n FROM users WHERE is_system = 0 AND role IN ('user', 'merchant', 'agent') GROUP BY 1 HAVING COUNT(*) > 1 LIMIT 2000")
    .all() as { name: string; ids: string; n: number }[];
  for (const r of names) {
    const ids = r.ids.split(',');
    for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) add(resolveNodeId(ids[i]), resolveNodeId(ids[j]), 'same_name', r.name);
  }
  const weight = { shared_device: 0.6, shared_method: 0.5, same_name: 0.25 };
  return Array.from(pairs.values())
    .map((p) => ({ ...p, confidence: Math.min(1, Math.round(p.signals.reduce((a, s) => a + weight[s.kind], 0) * 100) / 100) }))
    .filter((p) => p.signals.some((s) => s.kind !== 'same_name') || p.signals.length > 1)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, opts.limit ?? 200);
}

/** What a merchant may see: counts only, nothing that names another account. */
export function merchantGraphSummary(merchantUserId: string, days = 30) {
  const db = getDb();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const me = resolveNodeId(merchantUserId);
  const payers = db.prepare("SELECT from_node node, COUNT(*) n FROM graph_edges WHERE kind = 'paid' AND to_node = ? AND occurred_at >= ? GROUP BY from_node").all(me, since) as {
    node: string;
    n: number;
  }[];
  const payerIds = payers.map((p) => p.node);
  const placeholders = payerIds.map(() => '?').join(',');
  const countLinked = (edgeKind: GraphEdgeKind, nodeKind: GraphNodeKind) =>
    payerIds.length
      ? ((db.prepare(`SELECT COUNT(DISTINCT to_node) c FROM graph_edges WHERE kind = ? AND to_node LIKE '${nodeKind}:%' AND from_node IN (${placeholders})`).get(edgeKind, ...payerIds) as any)
          .c as number)
      : 0;
  const sharedDevicePairs = payerIds.length
    ? ((
        db
          .prepare(
            `SELECT COUNT(*) c FROM (SELECT e1.from_node, e2.from_node b FROM graph_edges e1 JOIN graph_edges e2 ON e1.to_node = e2.to_node AND e1.kind = 'used_device' AND e2.kind = 'used_device' AND e1.from_node < e2.from_node WHERE e1.from_node IN (${placeholders}) AND e2.from_node IN (${placeholders}) GROUP BY 1, 2)`,
          )
          .get(...payerIds, ...payerIds) as any
      ).c as number)
    : 0;
  const rings = ringCandidates({ sinceDays: days });
  const mules = muleCandidates({ sinceDays: days });
  const payerSet = new Set(payerIds);
  return {
    window: { days, from: since },
    payers: payers.length,
    repeatPayers: payers.filter((p) => p.n >= 2).length,
    payments: payers.reduce((a, p) => a + p.n, 0),
    devices: countLinked('used_device', 'device'),
    paymentMethods: countLinked('used_method', 'payment_method'),
    providers: countLinked('routed_via', 'provider'),
    locations: countLinked('located_at', 'location'),
    sharedDevicePayerPairs: sharedDevicePairs,
    ringExposure: rings.filter((r) => r.nodes.some((n) => payerSet.has(n))).length,
    muleExposure: mules.filter((m) => payerSet.has(m.node)).length,
  };
}

export function graphStats() {
  const db = getDb();
  return {
    nodes: (db.prepare('SELECT kind, COUNT(*) c FROM graph_nodes GROUP BY kind').all() as { kind: string; c: number }[]).reduce((a, r) => ({ ...a, [r.kind]: r.c }), {} as Record<string, number>),
    edges: (db.prepare('SELECT kind, COUNT(*) c FROM graph_edges GROUP BY kind').all() as { kind: string; c: number }[]).reduce((a, r) => ({ ...a, [r.kind]: r.c }), {} as Record<string, number>),
  };
}

// Incremental maintenance: every completed posting and every settlement is projected as it happens.
const HOOK = Symbol.for('bitripay.paymentGraph.subscribed');
if (!(globalThis as any)[HOOK]) {
  (globalThis as any)[HOOK] = true;
  subscribe('payment_graph', ['transaction.created', 'transaction.settled'], (ev) => {
    const id = ev.payload.transactionId as string | undefined;
    if (!id) return;
    const tx = getDb().prepare('SELECT * FROM transactions WHERE id = ?').get(id) as TransactionRow | undefined;
    if (tx) projectTransaction(tx);
  });
}
