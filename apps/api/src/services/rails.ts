/**
 * Rail registry, Smart Route and connector health.
 *
 * A rail is anything money can move on: the internal wallet, a processor gateway (card, mobile money API, bank), a
 * direct mobile-money operator (evidence rail), a national switch connection or a crypto rail. The registry is a
 * composed view over the objects that already exist (gateways, operators, switch connections) plus the telemetry this
 * module owns: per-connector success/failure/latency statistics in hourly buckets, a circuit breaker per connector
 * (closed → open after consecutive faults → half-open after a cooldown → closed on the next success) and the
 * operator pause. Smart Route scores candidate connectors for a method from those numbers; the choice is deterministic
 * and explainable (every score lists its components). Declines are the customer's outcome, not the connector's: they
 * count as attempts but never trip the breaker. Failover never crosses a regulatory boundary: candidates come from the
 * same capability set the caller already filtered, and DOMESTIC_INTEROPERABLE flows only ever fail over to another
 * link of the same certified switch (route policy engine).
 */
import { getDb } from '../db';
import { now } from '../lib/ids';
import { parseJson } from '../lib/json';
import { badRequest, notFound } from '../lib/errors';
import { listGateways, testGateway, type GatewayConfig } from '../payments';
import { listOperators } from './momo';
import { getSetting } from './settings';
import { recordEvent } from './events';
import { notify } from './notifications';

export interface RoutingSettings {
  circuit: { failureThreshold: number; cooldownSeconds: number; probeIntervalMinutes: number };
  weights: { success: number; latency: number; cost: number; health: number; preference: number };
  minSample: number;
  /** Indicative cost in basis points per rail kind when a connector declares none. */
  defaultCostBps: Record<string, number>;
  /** Latency (ms) considered "slow" for scoring (0 points). */
  slowLatencyMs: number;
}
const DEFAULT_ROUTING: RoutingSettings = {
  circuit: { failureThreshold: 5, cooldownSeconds: 120, probeIntervalMinutes: 5 },
  weights: { success: 40, latency: 15, cost: 20, health: 15, preference: 10 },
  minSample: 5,
  defaultCostBps: { wallet: 0, card: 290, mobile_money: 150, bank: 50, national_switch: 30, bitcoin: 100 },
  slowLatencyMs: 15_000,
};
export const getRoutingSettings = (): RoutingSettings => {
  const s = getSetting<Partial<RoutingSettings>>('routing', {});
  return { ...DEFAULT_ROUTING, ...s, circuit: { ...DEFAULT_ROUTING.circuit, ...(s.circuit ?? {}) }, weights: { ...DEFAULT_ROUTING.weights, ...(s.weights ?? {}) }, defaultCostBps: { ...DEFAULT_ROUTING.defaultCostBps, ...(s.defaultCostBps ?? {}) } };
};

export type RailKind = 'wallet' | 'card' | 'mobile_money' | 'bank' | 'national_switch' | 'bitcoin';
export type CircuitState = 'closed' | 'open' | 'half_open';
export type RoutingOutcome = 'success' | 'failure' | 'unknown' | 'decline';

export interface ConnectorStats {
  hours: number;
  attempts: number;
  successes: number;
  failures: number;
  unknowns: number;
  declines: number;
  /** successes / (attempts − declines); null below the minimum sample. */
  successRate: number | null;
  unknownRate: number | null;
  avgLatencyMs: number | null;
  maxLatencyMs: number | null;
}

export interface ConnectorHealth {
  connector: string;
  circuit: CircuitState;
  consecutiveFailures: number;
  openedAt: string | null;
  paused: boolean;
  pausedReason: string | null;
  lastProbe: { ok: boolean; at: string; message: string } | null;
  usable: boolean;
  reason: string | null;
}

export interface RailEntry {
  id: string;
  name: string;
  kind: RailKind;
  provider: string;
  methods: string[];
  countries: string[];
  currencies: string[];
  enabled: boolean;
  ready: boolean;
  mode: string;
  costBps: number;
  health: ConnectorHealth;
  stats: ConnectorStats;
}

// ---------------------------------------------------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------------------------------------------------
const bucketOf = (d = new Date()) => d.toISOString().slice(0, 13);

export function recordRoutingOutcome(connector: string | null | undefined, method: string, outcome: RoutingOutcome, latencyMs?: number | null): void {
  if (!connector) return;
  const db = getDb();
  const lat = Math.max(0, Math.round(latencyMs ?? 0));
  db.prepare(
    `INSERT INTO routing_stats (connector, method, bucket, attempts, successes, failures, unknowns, declines, latency_sum_ms, latency_max_ms)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(connector, method, bucket) DO UPDATE SET attempts = attempts + 1, successes = successes + excluded.successes, failures = failures + excluded.failures,
       unknowns = unknowns + excluded.unknowns, declines = declines + excluded.declines, latency_sum_ms = latency_sum_ms + excluded.latency_sum_ms, latency_max_ms = MAX(latency_max_ms, excluded.latency_max_ms)`,
  ).run(connector, method, bucketOf(), outcome === 'success' ? 1 : 0, outcome === 'failure' ? 1 : 0, outcome === 'unknown' ? 1 : 0, outcome === 'decline' ? 1 : 0, lat, lat);
  if (outcome === 'success') noteCircuit(connector, 'success');
  else if (outcome === 'failure' || outcome === 'unknown') noteCircuit(connector, 'failure');
}

export function connectorStats(connector: string, method?: string | null, hours = 24): ConnectorStats {
  const since = bucketOf(new Date(Date.now() - hours * 3600_000));
  const r = getDb().prepare(`SELECT COALESCE(SUM(attempts),0) a, COALESCE(SUM(successes),0) s, COALESCE(SUM(failures),0) f, COALESCE(SUM(unknowns),0) u, COALESCE(SUM(declines),0) d, COALESCE(SUM(latency_sum_ms),0) ls, COALESCE(MAX(latency_max_ms),0) lm FROM routing_stats WHERE connector = ? ${method ? 'AND method = ?' : ''} AND bucket >= ?`).get(...(method ? [connector, method, since] : [connector, since])) as any;
  const { minSample } = getRoutingSettings();
  const decided = r.a - r.d;
  return {
    hours,
    attempts: r.a,
    successes: r.s,
    failures: r.f,
    unknowns: r.u,
    declines: r.d,
    successRate: decided >= minSample ? Math.round((r.s / decided) * 1000) / 10 : null,
    unknownRate: decided >= minSample ? Math.round((r.u / decided) * 1000) / 10 : null,
    avgLatencyMs: r.a > 0 && r.ls > 0 ? Math.round(r.ls / r.a) : null,
    maxLatencyMs: r.lm || null,
  };
}

/** Hourly series for dashboards. */
export function connectorSeries(connector: string, hours = 24) {
  const since = bucketOf(new Date(Date.now() - hours * 3600_000));
  return (getDb().prepare('SELECT bucket, method, attempts, successes, failures, unknowns, declines, latency_sum_ms, latency_max_ms FROM routing_stats WHERE connector = ? AND bucket >= ? ORDER BY bucket').all(connector, since) as any[]).map((r) => ({ bucket: r.bucket, method: r.method, attempts: r.attempts, successes: r.successes, failures: r.failures, unknowns: r.unknowns, declines: r.declines, avgLatencyMs: r.attempts ? Math.round(r.latency_sum_ms / r.attempts) : null, maxLatencyMs: r.latency_max_ms }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Circuit breaker and operator pause
// ---------------------------------------------------------------------------------------------------------------------
function stateRow(connector: string): any {
  const db = getDb();
  let r = db.prepare('SELECT * FROM connector_state WHERE connector = ?').get(connector) as any;
  if (!r) {
    db.prepare('INSERT INTO connector_state (connector, circuit, consecutive_failures, updated_at) VALUES (?, ?, 0, ?)').run(connector, 'closed', now());
    r = db.prepare('SELECT * FROM connector_state WHERE connector = ?').get(connector);
  }
  return r;
}

function noteCircuit(connector: string, outcome: 'success' | 'failure'): void {
  const db = getDb();
  const s = getRoutingSettings().circuit;
  const r = stateRow(connector);
  if (outcome === 'success') {
    if (r.circuit !== 'closed' || r.consecutive_failures > 0) {
      db.prepare("UPDATE connector_state SET circuit = 'closed', consecutive_failures = 0, opened_at = NULL, half_open_at = NULL, updated_at = ? WHERE connector = ?").run(now(), connector);
      if (r.circuit !== 'closed') recordEvent('route', connector, 'circuit.closed', { type: 'system' }, { after: r.consecutive_failures });
    }
    return;
  }
  const failures = r.consecutive_failures + 1;
  if (r.circuit === 'half_open' || (r.circuit === 'closed' && failures >= s.failureThreshold)) {
    db.prepare("UPDATE connector_state SET circuit = 'open', consecutive_failures = ?, opened_at = ?, half_open_at = NULL, updated_at = ? WHERE connector = ?").run(failures, now(), now(), connector);
    if (r.circuit !== 'open') {
      recordEvent('route', connector, 'circuit.opened', { type: 'system' }, { failures, cooldownSeconds: s.cooldownSeconds });
      for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_system = 0 AND status = 'active'").all() as { id: string }[]) notify(a.id, 'Connector circuit opened', `${connector} failed ${failures} times in a row and is paused for ${s.cooldownSeconds}s. Traffic fails over to the other connectors for the same rail.`, { kind: 'connector', connector });
    }
  } else db.prepare('UPDATE connector_state SET consecutive_failures = ?, updated_at = ? WHERE connector = ?').run(failures, now(), connector);
}

export function connectorHealth(connector: string): ConnectorHealth {
  const s = getRoutingSettings().circuit;
  const db = getDb();
  let r = stateRow(connector);
  // open → half-open once the cooldown elapsed (one trial call is allowed)
  if (r.circuit === 'open' && r.opened_at && Date.now() - Date.parse(r.opened_at) >= s.cooldownSeconds * 1000) {
    db.prepare("UPDATE connector_state SET circuit = 'half_open', half_open_at = ?, updated_at = ? WHERE connector = ?").run(now(), now(), connector);
    r = stateRow(connector);
  }
  const lastProbe = r.last_probe ? parseJson<{ ok: boolean; at: string; message: string }>(r.last_probe, null as any) : null;
  const paused = !!r.paused_by;
  const usable = !paused && r.circuit !== 'open';
  return { connector, circuit: r.circuit, consecutiveFailures: r.consecutive_failures, openedAt: r.opened_at, paused, pausedReason: r.paused_reason, lastProbe, usable, reason: paused ? `paused: ${r.paused_reason ?? 'by operations'}` : r.circuit === 'open' ? 'circuit open after consecutive failures' : null };
}

export function pauseConnector(connector: string, adminId: string, reason: string): ConnectorHealth {
  stateRow(connector);
  getDb().prepare('UPDATE connector_state SET paused_by = ?, paused_reason = ?, updated_at = ? WHERE connector = ?').run(adminId, reason, now(), connector);
  recordEvent('route', connector, 'connector.paused', { type: 'admin', id: adminId }, { reason });
  return connectorHealth(connector);
}

export function resumeConnector(connector: string, adminId: string): ConnectorHealth {
  stateRow(connector);
  getDb().prepare("UPDATE connector_state SET paused_by = NULL, paused_reason = NULL, circuit = 'closed', consecutive_failures = 0, opened_at = NULL, half_open_at = NULL, updated_at = ? WHERE connector = ?").run(now(), connector);
  recordEvent('route', connector, 'connector.resumed', { type: 'admin', id: adminId }, {});
  return connectorHealth(connector);
}

export function recordProbe(connector: string, ok: boolean, message: string, details: Record<string, unknown> = {}): void {
  stateRow(connector);
  getDb().prepare('UPDATE connector_state SET last_probe = ?, updated_at = ? WHERE connector = ?').run(JSON.stringify({ ok, at: now(), message, ...details }), now(), connector);
  noteCircuit(connector, ok ? 'success' : 'failure');
}

// ---------------------------------------------------------------------------------------------------------------------
// Registry view
// ---------------------------------------------------------------------------------------------------------------------
function kindOfGateway(g: GatewayConfig): RailKind {
  if (g.methods.includes('mobile_money') && g.methods.length === 1) return 'mobile_money';
  if (g.provider === 'manual_bank') return 'bank';
  if (g.methods.includes('card')) return 'card';
  return g.methods.includes('bank') ? 'bank' : 'mobile_money';
}

export function listRails(filter: { kind?: RailKind | null; country?: string | null; currency?: string | null; method?: string | null } = {}): RailEntry[] {
  const settings = getRoutingSettings();
  const entries: RailEntry[] = [];
  const wallet: RailEntry = { id: 'wallet', name: 'BitriPay balance', kind: 'wallet', provider: 'ledger', methods: ['wallet'], countries: [], currencies: [], enabled: true, ready: true, mode: 'live', costBps: settings.defaultCostBps.wallet ?? 0, health: connectorHealth('wallet'), stats: connectorStats('wallet') };
  entries.push(wallet);
  for (const g of listGateways()) {
    const kind = kindOfGateway(g);
    entries.push({ id: g.id, name: g.name, kind, provider: g.provider, methods: g.methods, countries: g.countries, currencies: g.currencies, enabled: g.enabled, ready: g.enabled && (g.mode !== 'unknown' || ['sandbox', 'manual_momo', 'manual_bank'].includes(g.provider)), mode: g.mode, costBps: typeof g.config.costBps === 'number' ? (g.config.costBps as number) : settings.defaultCostBps[kind] ?? 100, health: connectorHealth(g.id), stats: connectorStats(g.id) });
  }
  for (const o of listOperators({ onlyDirect: true })) {
    entries.push({ id: `operator:${o.id}`, name: `${o.name} (direct rail)`, kind: 'mobile_money', provider: 'manual_momo', methods: ['mobile_money'], countries: [o.country], currencies: [o.currency], enabled: o.enabled, ready: o.enabled && o.directRail, mode: 'test', costBps: settings.defaultCostBps.mobile_money ?? 150, health: connectorHealth(`operator:${o.id}`), stats: connectorStats(`operator:${o.id}`) });
  }
  const switches = getDb().prepare('SELECT * FROM switch_connections').all() as any[];
  for (const c of switches) {
    const cert = parseJson<{ status: string }>(c.certification, { status: 'NOT_STARTED' });
    entries.push({ id: c.id, name: c.name, kind: 'national_switch', provider: `switch:${c.adapter}`, methods: ['national_switch'], countries: [c.country], currencies: [], enabled: !!c.enabled, ready: !!c.enabled && (c.environment !== 'production' || cert.status === 'CERTIFIED'), mode: c.environment === 'production' ? 'live' : 'test', costBps: settings.defaultCostBps.national_switch ?? 30, health: connectorHealth(c.id), stats: connectorStats(c.id) });
  }
  return entries.filter((e) => (!filter.kind || e.kind === filter.kind) && (!filter.method || e.methods.includes(filter.method)) && (!filter.country || !e.countries.length || e.countries.includes(filter.country.toUpperCase())) && (!filter.currency || !e.currencies.length || e.currencies.includes(filter.currency.toUpperCase())));
}

export function getRail(id: string): RailEntry {
  const r = listRails().find((e) => e.id === id);
  if (!r) throw notFound('Rail not found', 'rail_not_found');
  return r;
}

// ---------------------------------------------------------------------------------------------------------------------
// Smart Route scoring
// ---------------------------------------------------------------------------------------------------------------------
export type RoutePolicy = 'smart' | 'cheapest' | 'fastest' | 'most_reliable';
export interface RouteCandidate {
  id: string;
  method: string;
  costBps?: number | null;
  /** Merchant preference rank (0 = first choice). */
  preferenceRank?: number | null;
}
export interface RouteScore {
  id: string;
  score: number;
  usable: boolean;
  reason: string | null;
  components: { success: number; latency: number; cost: number; health: number; preference: number };
  stats: ConnectorStats;
}

/**
 * Score candidates 0–100. Weights follow the policy: `smart` uses the configured mix, `cheapest` doubles cost,
 * `fastest` doubles latency, `most_reliable` doubles success/health. Unusable connectors (open circuit, paused) are
 * returned last with `usable: false` so the caller can explain why they were skipped.
 */
export function scoreConnectors(candidates: RouteCandidate[], policy: RoutePolicy = 'smart', opts: { hours?: number } = {}): RouteScore[] {
  const settings = getRoutingSettings();
  const w = { ...settings.weights };
  if (policy === 'cheapest') w.cost *= 2;
  if (policy === 'fastest') w.latency *= 2;
  if (policy === 'most_reliable') {
    w.success *= 2;
    w.health *= 2;
  }
  const total = w.success + w.latency + w.cost + w.health + w.preference;
  const costs = candidates.map((c) => c.costBps ?? settings.defaultCostBps[c.method] ?? 100);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  return candidates
    .map((c, i) => {
      const stats = connectorStats(c.id, c.method, opts.hours ?? 24);
      const health = connectorHealth(c.id);
      // success: measured rate, or a neutral 85 when there is no sample yet (new connectors get a fair trial)
      const successPts = (stats.successRate ?? 85) - (stats.unknownRate ?? 0) * 2;
      const latencyPts = stats.avgLatencyMs == null ? 70 : Math.max(0, 100 - (stats.avgLatencyMs / settings.slowLatencyMs) * 100);
      const costPts = maxCost === minCost ? 100 : 100 - ((costs[i] - minCost) / (maxCost - minCost)) * 100;
      const healthPts = !health.usable ? 0 : health.circuit === 'half_open' ? 40 : health.lastProbe ? (health.lastProbe.ok ? 100 : 20) : 80;
      const prefPts = c.preferenceRank == null ? 50 : Math.max(0, 100 - c.preferenceRank * 25);
      const score = Math.round((w.success * successPts + w.latency * latencyPts + w.cost * costPts + w.health * healthPts + w.preference * prefPts) / total);
      return { id: c.id, score: health.usable ? score : 0, usable: health.usable, reason: health.reason, components: { success: Math.round(successPts), latency: Math.round(latencyPts), cost: Math.round(costPts), health: healthPts, preference: prefPts }, stats };
    })
    .sort((a, b) => Number(b.usable) - Number(a.usable) || b.score - a.score);
}

/** Pick the best usable candidate id, or null when every candidate is unusable. */
export function pickConnector(candidates: RouteCandidate[], policy: RoutePolicy = 'smart'): { id: string | null; scores: RouteScore[] } {
  const scores = scoreConnectors(candidates, policy);
  return { id: scores.find((s) => s.usable)?.id ?? null, scores };
}

// ---------------------------------------------------------------------------------------------------------------------
// Health probes (scheduler)
// ---------------------------------------------------------------------------------------------------------------------
let lastProbeAt = 0;
export async function probeConnectors(force = false): Promise<{ probed: string[]; failed: string[] }> {
  const s = getRoutingSettings().circuit;
  if (!force && Date.now() - lastProbeAt < s.probeIntervalMinutes * 60_000) return { probed: [], failed: [] };
  lastProbeAt = Date.now();
  const probed: string[] = [];
  const failed: string[] = [];
  for (const g of listGateways().filter((g) => g.enabled)) {
    try {
      const r = await testGateway(g.id);
      recordProbe(g.id, r.ok, r.message, { mode: r.mode });
      if (!r.ok) failed.push(g.id);
    } catch (err) {
      recordProbe(g.id, false, (err as Error).message);
      failed.push(g.id);
    }
    probed.push(g.id);
  }
  const { probeSwitchConnections } = await import('./switch/connections');
  for (const r of await probeSwitchConnections()) {
    probed.push(r.id);
    if (!r.ok) failed.push(r.id);
  }
  return { probed, failed };
}

export function assertRailKnown(id: string): void {
  if (!listRails().some((e) => e.id === id)) throw badRequest(`Unknown rail ${id}`, 'unknown_rail');
}
