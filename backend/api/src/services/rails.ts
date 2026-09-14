/**
 * Rail registry, Smart Route and connector health.
 *
 * A rail is anything money can move on: the internal wallet, a processor gateway (card, mobile money API, bank), a
 * direct mobile-money operator (evidence rail), a national switch connection or a crypto rail. The registry is a
 * composed view over the objects that already exist (gateways, operators, switch connections) plus the telemetry this
 * module owns: per-connector success/failure/latency statistics in 15-minute buckets kept for 24 hours (optionally
 * keyed by amount band and MSISDN/BIN prefix), a circuit breaker per connector (closed → open after consecutive
 * faults → half-open after a cooldown → closed on the next success), the operator pause and the maintenance flag.
 * Every connector carries a health state (HEALTHY / DEGRADED / UNAVAILABLE / MAINTENANCE) derived from the circuit,
 * the last probe, the recent success rate and the maintenance flag, plus its capabilities (limits, refunds,
 * settlement T+n, webhooks, last incident). Smart Route scores candidate connectors for a method from those numbers:
 * success, p95 latency, cost, health, merchant preference, settlement speed, FX cost, fraud risk (recent dispute
 * ratio), prefunded liquidity and concentration (a connector already carrying most of the last hour's volume). The
 * choice is deterministic and explainable (every score lists its components) and the routing report measures the
 * uplift of Smart Route over the static default rail. Declines are the customer's outcome, not the connector's: they
 * count as attempts but never trip the breaker. Failover never crosses a regulatory boundary: candidates come from
 * the same capability set the caller already filtered, and DOMESTIC_INTEROPERABLE flows only ever fail over to
 * another link of the same certified switch (route policy engine).
 */
import { getDb } from '../db';
import { now } from '../lib/ids';
import { parseJson } from '../lib/json';
import { notFound } from '../lib/errors';
import { listGateways, getGateway, getGatewayCredentials, testGateway, PROVIDERS, type GatewayConfig } from '../payments';
import type { ConnectorCapabilities } from '../payments/types';
import { listOperators } from './momo';
import { getSetting, getAppSettings } from './settings';
import { getBaseCurrency, toBase } from './currencies';
import { listPayoutAccounts } from './liquidity';
import { fxDisclosure } from './fx';
import { recordEvent } from './events';
import { notify } from './notifications';
import { publish } from './bus';

export interface RoutingWeights {
  success: number;
  latency: number;
  cost: number;
  health: number;
  preference: number;
  settlementSpeed: number;
  fxCost: number;
  fraudRisk: number;
  liquidity: number;
  concentration: number;
}
export interface RoutingSettings {
  circuit: { failureThreshold: number; cooldownSeconds: number; probeIntervalMinutes: number };
  weights: RoutingWeights;
  minSample: number;
  /** Indicative cost in basis points per rail kind when a connector declares none. */
  defaultCostBps: Record<string, number>;
  /** Latency (ms) considered "slow" for scoring (0 points). */
  slowLatencyMs: number;
  /** Telemetry buckets: 15-minute buckets kept for 24 hours; latency samples per bucket feed the p95. */
  stats: { bucketMinutes: number; retentionHours: number; maxLatencySamples: number };
  /** Health state thresholds: below the success rate or above the unknown rate a closed connector is DEGRADED. */
  health: { degradedSuccessRate: number; degradedUnknownRate: number };
  /** Share of the last hour's attempts above which a connector is penalised for concentration. */
  concentrationShare: number;
  /** Settlement delay (days) per rail kind when the provider contract declares none. */
  defaultSettlementT: Record<string, number>;
}
const DEFAULT_ROUTING: RoutingSettings = {
  circuit: { failureThreshold: 5, cooldownSeconds: 120, probeIntervalMinutes: 1 },
  weights: { success: 40, latency: 15, cost: 20, health: 15, preference: 10, settlementSpeed: 10, fxCost: 10, fraudRisk: 10, liquidity: 10, concentration: 5 },
  minSample: 5,
  defaultCostBps: { wallet: 0, card: 290, mobile_money: 150, bank: 50, national_switch: 30, bitcoin: 100 },
  slowLatencyMs: 15_000,
  stats: { bucketMinutes: 15, retentionHours: 24, maxLatencySamples: 200 },
  health: { degradedSuccessRate: 90, degradedUnknownRate: 5 },
  concentrationShare: 0.6,
  defaultSettlementT: { wallet: 0, card: 2, mobile_money: 1, bank: 1, national_switch: 1, bitcoin: 0 },
};
export const getRoutingSettings = (): RoutingSettings => {
  const s = getSetting<Partial<RoutingSettings>>('routing', {});
  return {
    ...DEFAULT_ROUTING,
    ...s,
    circuit: { ...DEFAULT_ROUTING.circuit, ...(s.circuit ?? {}) },
    weights: { ...DEFAULT_ROUTING.weights, ...(s.weights ?? {}) },
    defaultCostBps: { ...DEFAULT_ROUTING.defaultCostBps, ...(s.defaultCostBps ?? {}) },
    stats: { ...DEFAULT_ROUTING.stats, ...(s.stats ?? {}) },
    health: { ...DEFAULT_ROUTING.health, ...(s.health ?? {}) },
    defaultSettlementT: { ...DEFAULT_ROUTING.defaultSettlementT, ...(s.defaultSettlementT ?? {}) },
  };
};

export type RailKind = 'wallet' | 'card' | 'mobile_money' | 'bank' | 'national_switch' | 'bitcoin';
export type CircuitState = 'closed' | 'open' | 'half_open';
export type RoutingOutcome = 'success' | 'failure' | 'unknown' | 'decline';
export type HealthState = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'MAINTENANCE';
/** Amount bands in base currency units. */
export type AmountBand = 'lt10' | '10_100' | '100_1000' | 'gt1000';
export const AMOUNT_BANDS: AmountBand[] = ['lt10', '10_100', '100_1000', 'gt1000'];

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
  /** 95th percentile of the latency samples in the window (what Smart Route scores on). */
  p95LatencyMs: number | null;
  maxLatencyMs: number | null;
  /** Outcomes recorded as Smart Route choices vs. the static default rail (uplift metric). */
  smartAttempts: number;
  smartSuccesses: number;
  defaultAttempts: number;
  defaultSuccesses: number;
  amountBand: AmountBand | null;
  prefix: string | null;
}

export interface RailMaintenance {
  railId: string;
  reason: string | null;
  setBy: string | null;
  setAt: string;
}

export interface ConnectorHealth {
  connector: string;
  /** Derived state: maintenance flag > pause / open circuit / failed probe > half-open or poor recent success rate. */
  state: HealthState;
  circuit: CircuitState;
  consecutiveFailures: number;
  openedAt: string | null;
  paused: boolean;
  pausedReason: string | null;
  maintenance: RailMaintenance | null;
  lastProbe: { ok: boolean; at: string; message: string } | null;
  /** When the circuit last opened (platform-observed incident). */
  lastIncidentAt: string | null;
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
  capabilities: ConnectorCapabilities;
}

// ---------------------------------------------------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------------------------------------------------
const pad2 = (n: number) => String(n).padStart(2, '0');
/** Bucket key `YYYY-MM-DDTHH:MM` floored to the bucket size (15 minutes). Legacy hourly keys (`YYYY-MM-DDTHH`) still sort correctly. */
export function bucketOf(d = new Date(), bucketMinutes = getRoutingSettings().stats.bucketMinutes): string {
  const size = Math.max(1, Math.min(60, Math.round(bucketMinutes || 15)));
  const mins = Math.floor(d.getUTCMinutes() / size) * size;
  return `${d.toISOString().slice(0, 13)}:${pad2(mins)}`;
}

/** Amount band of an amount in base currency units: <10, 10–100, 100–1000, >1000. Unknown currencies are unsegmented. */
export function amountBandOf(amountMinor: number | null | undefined, currency: string | null | undefined): AmountBand | null {
  if (amountMinor == null || !currency || !Number.isFinite(amountMinor)) return null;
  try {
    const base = getBaseCurrency();
    const units = toBase(Math.abs(amountMinor), currency.toUpperCase()) / 10 ** base.decimals;
    return units < 10 ? 'lt10' : units < 100 ? '10_100' : units < 1000 ? '100_1000' : 'gt1000';
  } catch {
    return null;
  }
}
/** MSISDN / BIN prefix: the first 3–6 digits (international prefix `00` stripped). Empty when there are not enough digits. */
export function prefixOf(value: string | null | undefined, length = 6): string {
  if (!value) return '';
  let d = String(value).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  const len = Math.max(3, Math.min(6, Math.round(length) || 6));
  return d.length >= 3 ? d.slice(0, len) : '';
}

export interface RoutingOutcomeOptions {
  amountMinor?: number | null;
  currency?: string | null;
  /** Explicit band (else derived from amountMinor + currency). */
  amountBand?: AmountBand | null;
  msisdn?: string | null;
  bin?: string | null;
  /** Explicit prefix (else derived from msisdn / bin). */
  prefix?: string | null;
  prefixLength?: number;
  /** Whether the connector was Smart Route's choice or the static default rail (see pickConnector). */
  chosenBy?: 'smart' | 'default' | null;
}

let outcomesSincePrune = 0;
export function recordRoutingOutcome(connector: string | null | undefined, method: string, outcome: RoutingOutcome, latencyMs?: number | null, opts: RoutingOutcomeOptions = {}): void {
  if (!connector) return;
  const db = getDb();
  const settings = getRoutingSettings();
  const lat = Math.max(0, Math.round(latencyMs ?? 0));
  const hasLatency = latencyMs != null && Number.isFinite(latencyMs);
  const band = opts.amountBand ?? amountBandOf(opts.amountMinor, opts.currency) ?? '';
  const prefix = opts.prefix != null ? prefixOf(opts.prefix, opts.prefixLength) : prefixOf(opts.msisdn ?? opts.bin, opts.prefixLength);
  const success = outcome === 'success' ? 1 : 0;
  const smart = opts.chosenBy === 'smart' ? 1 : 0;
  const dflt = opts.chosenBy === 'default' ? 1 : 0;
  db.prepare(
    `INSERT INTO routing_stats (connector, method, bucket, amount_band, prefix, attempts, successes, failures, unknowns, declines, latency_sum_ms, latency_max_ms, latency_samples, smart_attempts, smart_successes, default_attempts, default_successes)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(connector, method, bucket, amount_band, prefix) DO UPDATE SET attempts = attempts + 1, successes = successes + excluded.successes, failures = failures + excluded.failures,
       unknowns = unknowns + excluded.unknowns, declines = declines + excluded.declines, latency_sum_ms = latency_sum_ms + excluded.latency_sum_ms, latency_max_ms = MAX(latency_max_ms, excluded.latency_max_ms),
       latency_samples = CASE WHEN json_array_length(excluded.latency_samples) = 0 THEN latency_samples
         ELSE json_insert(CASE WHEN json_array_length(latency_samples) >= ? THEN json_remove(latency_samples, '$[0]') ELSE latency_samples END, '$[#]', ?) END,
       smart_attempts = smart_attempts + excluded.smart_attempts, smart_successes = smart_successes + excluded.smart_successes,
       default_attempts = default_attempts + excluded.default_attempts, default_successes = default_successes + excluded.default_successes`,
  ).run(
    connector,
    method,
    bucketOf(new Date(), settings.stats.bucketMinutes),
    band,
    prefix,
    success,
    outcome === 'failure' ? 1 : 0,
    outcome === 'unknown' ? 1 : 0,
    outcome === 'decline' ? 1 : 0,
    lat,
    lat,
    hasLatency ? JSON.stringify([lat]) : '[]',
    smart,
    smart & success,
    dflt,
    dflt & success,
    settings.stats.maxLatencySamples,
    lat,
  );
  if (outcome === 'success') noteCircuit(connector, 'success');
  else if (outcome === 'failure' || outcome === 'unknown') noteCircuit(connector, 'failure');
  if (++outcomesSincePrune >= 500) {
    outcomesSincePrune = 0;
    pruneRoutingStats();
  }
}

/** Drop telemetry buckets older than the retention window (24 hours). Returns the number of buckets removed. */
export function pruneRoutingStats(): number {
  const s = getRoutingSettings().stats;
  const cutoff = bucketOf(new Date(Date.now() - s.retentionHours * 3600_000), s.bucketMinutes);
  return getDb().prepare('DELETE FROM routing_stats WHERE bucket < ?').run(cutoff).changes;
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export interface StatsFilter {
  amountBand?: AmountBand | null;
  prefix?: string | null;
}
export function connectorStats(connector: string, method?: string | null, hours = 24, filter: StatsFilter = {}): ConnectorStats {
  const settings = getRoutingSettings();
  const since = bucketOf(new Date(Date.now() - hours * 3600_000), settings.stats.bucketMinutes);
  const where = ['connector = ?', 'bucket >= ?'];
  const params: unknown[] = [connector, since];
  if (method) {
    where.push('method = ?');
    params.push(method);
  }
  if (filter.amountBand) {
    where.push('amount_band = ?');
    params.push(filter.amountBand);
  }
  if (filter.prefix) {
    where.push('prefix = ?');
    params.push(prefixOf(filter.prefix, filter.prefix.length));
  }
  const r = getDb()
    .prepare(
      `SELECT COALESCE(SUM(attempts),0) a, COALESCE(SUM(successes),0) s, COALESCE(SUM(failures),0) f, COALESCE(SUM(unknowns),0) u, COALESCE(SUM(declines),0) d,
              COALESCE(SUM(latency_sum_ms),0) ls, COALESCE(MAX(latency_max_ms),0) lm,
              COALESCE(SUM(smart_attempts),0) sa, COALESCE(SUM(smart_successes),0) ss, COALESCE(SUM(default_attempts),0) da, COALESCE(SUM(default_successes),0) ds
       FROM routing_stats WHERE ${where.join(' AND ')}`,
    )
    .get(...params) as any;
  const samples = (
    getDb()
      .prepare(`SELECT latency_samples FROM routing_stats WHERE ${where.join(' AND ')} AND latency_samples != '[]'`)
      .all(...params) as { latency_samples: string }[]
  ).flatMap((row) => parseJson<number[]>(row.latency_samples, []).filter((n) => typeof n === 'number'));
  const decided = r.a - r.d;
  return {
    hours,
    attempts: r.a,
    successes: r.s,
    failures: r.f,
    unknowns: r.u,
    declines: r.d,
    successRate: decided >= settings.minSample ? Math.round((r.s / decided) * 1000) / 10 : null,
    unknownRate: decided >= settings.minSample ? Math.round((r.u / decided) * 1000) / 10 : null,
    avgLatencyMs: r.a > 0 && r.ls > 0 ? Math.round(r.ls / r.a) : null,
    p95LatencyMs: percentile(samples, 95),
    maxLatencyMs: r.lm || null,
    smartAttempts: r.sa,
    smartSuccesses: r.ss,
    defaultAttempts: r.da,
    defaultSuccesses: r.ds,
    amountBand: filter.amountBand ?? null,
    prefix: filter.prefix ?? null,
  };
}

/** Bucket series for dashboards (one row per bucket, method, amount band and prefix). */
export function connectorSeries(connector: string, hours = 24) {
  const settings = getRoutingSettings();
  const since = bucketOf(new Date(Date.now() - hours * 3600_000), settings.stats.bucketMinutes);
  return (
    getDb()
      .prepare(
        'SELECT bucket, method, amount_band, prefix, attempts, successes, failures, unknowns, declines, latency_sum_ms, latency_max_ms, latency_samples, smart_attempts, smart_successes, default_attempts, default_successes FROM routing_stats WHERE connector = ? AND bucket >= ? ORDER BY bucket',
      )
      .all(connector, since) as any[]
  ).map((r) => ({
    bucket: r.bucket,
    method: r.method,
    amountBand: r.amount_band || null,
    prefix: r.prefix || null,
    attempts: r.attempts,
    successes: r.successes,
    failures: r.failures,
    unknowns: r.unknowns,
    declines: r.declines,
    avgLatencyMs: r.attempts ? Math.round(r.latency_sum_ms / r.attempts) : null,
    p95LatencyMs: percentile(parseJson<number[]>(r.latency_samples, []), 95),
    maxLatencyMs: r.latency_max_ms,
    smartAttempts: r.smart_attempts,
    smartSuccesses: r.smart_successes,
    defaultAttempts: r.default_attempts,
    defaultSuccesses: r.default_successes,
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Circuit breaker, operator pause and maintenance flag
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
    if (r.circuit !== 'open') publish('connector.degraded', { connector, failures, cooldownSeconds: s.cooldownSeconds }, { aggregateId: connector });
    if (r.circuit !== 'open') {
      recordEvent('route', connector, 'circuit.opened', { type: 'system' }, { failures, cooldownSeconds: s.cooldownSeconds });
      for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_system = 0 AND status = 'active'").all() as { id: string }[])
        notify(
          a.id,
          'Connector circuit opened',
          `${connector} failed ${failures} times in a row and is paused for ${s.cooldownSeconds}s. Traffic fails over to the other connectors for the same rail.`,
          { kind: 'connector', connector },
        );
    }
  } else db.prepare('UPDATE connector_state SET consecutive_failures = ?, updated_at = ? WHERE connector = ?').run(failures, now(), connector);
}

const toMaintenance = (r: any): RailMaintenance => ({ railId: r.rail_id, reason: r.reason, setBy: r.set_by, setAt: r.set_at });
export function getRailMaintenance(railId: string): RailMaintenance | null {
  const r = getDb().prepare('SELECT * FROM rail_maintenance WHERE rail_id = ?').get(railId) as any;
  return r ? toMaintenance(r) : null;
}
export function listRailMaintenance(): RailMaintenance[] {
  return (getDb().prepare('SELECT * FROM rail_maintenance ORDER BY set_at DESC').all() as any[]).map(toMaintenance);
}
/** Administrator-set maintenance window: the connector reports MAINTENANCE and Smart Route stops choosing it until cleared. */
export function setRailMaintenance(railId: string, on: boolean, reason: string | null, actor: string | null): ConnectorHealth {
  const db = getDb();
  stateRow(railId);
  if (on) {
    db.prepare(
      'INSERT INTO rail_maintenance (rail_id, reason, set_by, set_at) VALUES (?, ?, ?, ?) ON CONFLICT(rail_id) DO UPDATE SET reason = excluded.reason, set_by = excluded.set_by, set_at = excluded.set_at',
    ).run(railId, reason, actor, now());
    publish('connector.maintenance', { connector: railId, on: true, reason }, { aggregateId: railId });
  } else db.prepare('DELETE FROM rail_maintenance WHERE rail_id = ?').run(railId);
  recordEvent('route', railId, on ? 'connector.maintenance.on' : 'connector.maintenance.off', actor ? { type: 'admin', id: actor } : { type: 'system' }, { reason });
  return connectorHealth(railId);
}

/** When the connector's circuit last opened, from the event journal. */
export function lastIncidentAt(connector: string): string | null {
  const r = getDb().prepare("SELECT created_at FROM event_log WHERE stream = 'route' AND subject_id = ? AND event = 'circuit.opened' ORDER BY seq DESC LIMIT 1").get(connector) as
    { created_at: string } | undefined;
  return r?.created_at ?? null;
}

export function connectorHealth(connector: string): ConnectorHealth {
  const settings = getRoutingSettings();
  const s = settings.circuit;
  const db = getDb();
  let r = stateRow(connector);
  // open → half-open once the cooldown elapsed (one trial call is allowed)
  if (r.circuit === 'open' && r.opened_at && Date.now() - Date.parse(r.opened_at) >= s.cooldownSeconds * 1000) {
    db.prepare("UPDATE connector_state SET circuit = 'half_open', half_open_at = ?, updated_at = ? WHERE connector = ?").run(now(), now(), connector);
    r = stateRow(connector);
  }
  const lastProbe = r.last_probe ? parseJson<{ ok: boolean; at: string; message: string }>(r.last_probe, null as any) : null;
  const paused = !!r.paused_by;
  const maintenance = getRailMaintenance(connector);
  const usable = !paused && r.circuit !== 'open' && !maintenance;
  const stats = connectorStats(connector, null, 1);
  const state: HealthState = maintenance
    ? 'MAINTENANCE'
    : paused || r.circuit === 'open' || (lastProbe && !lastProbe.ok)
      ? 'UNAVAILABLE'
      : r.circuit === 'half_open' ||
          (stats.successRate != null && stats.successRate < settings.health.degradedSuccessRate) ||
          (stats.unknownRate != null && stats.unknownRate > settings.health.degradedUnknownRate)
        ? 'DEGRADED'
        : 'HEALTHY';
  return {
    connector,
    state,
    circuit: r.circuit,
    consecutiveFailures: r.consecutive_failures,
    openedAt: r.opened_at,
    paused,
    pausedReason: r.paused_reason,
    maintenance,
    lastProbe,
    lastIncidentAt: r.opened_at ?? lastIncidentAt(connector),
    usable,
    reason: maintenance
      ? `maintenance: ${maintenance.reason ?? 'scheduled by operations'}`
      : paused
        ? `paused: ${r.paused_reason ?? 'by operations'}`
        : r.circuit === 'open'
          ? 'circuit open after consecutive failures'
          : null,
  };
}

export function pauseConnector(connector: string, adminId: string, reason: string): ConnectorHealth {
  stateRow(connector);
  getDb().prepare('UPDATE connector_state SET paused_by = ?, paused_reason = ?, updated_at = ? WHERE connector = ?').run(adminId, reason, now(), connector);
  recordEvent('route', connector, 'connector.paused', { type: 'admin', id: adminId }, { reason });
  return connectorHealth(connector);
}

export function resumeConnector(connector: string, adminId: string): ConnectorHealth {
  stateRow(connector);
  getDb()
    .prepare(
      "UPDATE connector_state SET paused_by = NULL, paused_reason = NULL, circuit = 'closed', consecutive_failures = 0, opened_at = NULL, half_open_at = NULL, updated_at = ? WHERE connector = ?",
    )
    .run(now(), connector);
  recordEvent('route', connector, 'connector.resumed', { type: 'admin', id: adminId }, {});
  return connectorHealth(connector);
}

export function recordProbe(connector: string, ok: boolean, message: string, details: Record<string, unknown> = {}): void {
  stateRow(connector);
  getDb()
    .prepare('UPDATE connector_state SET last_probe = ?, updated_at = ? WHERE connector = ?')
    .run(JSON.stringify({ ok, at: now(), message, ...details }), now(), connector);
  noteCircuit(connector, ok ? 'success' : 'failure');
}

// ---------------------------------------------------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------------------------------------------------
function kindOfGateway(g: GatewayConfig): RailKind {
  if (g.methods.includes('bitcoin')) return 'bitcoin';
  if (g.methods.includes('mobile_money') && g.methods.length === 1) return 'mobile_money';
  if (g.provider === 'manual_bank') return 'bank';
  if (g.methods.includes('card')) return 'card';
  return g.methods.includes('bank') ? 'bank' : 'mobile_money';
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null);

/** Capability overrides an administrator stored on the gateway (`config.capabilities` object or flat keys). */
function configCapabilities(config: Record<string, unknown>): Partial<ConnectorCapabilities> {
  const nested = config.capabilities && typeof config.capabilities === 'object' ? (config.capabilities as Record<string, unknown>) : {};
  const src = { ...config, ...nested };
  const out: Partial<ConnectorCapabilities> = {};
  const min = num(src.minMinor);
  const max = num(src.maxMinor);
  const t = num(src.settlementT ?? src.settlementDays);
  const refunds = bool(src.refunds);
  const webhooks = bool(src.webhooks);
  if (min != null) out.minMinor = min;
  if (max != null) out.maxMinor = max;
  if (t != null) out.settlementT = t;
  if (refunds != null) out.refunds = refunds;
  if (webhooks != null) out.webhooks = webhooks;
  return out;
}

/** Capabilities of a gateway: defaults by kind ← provider contract ← administrator configuration ← observed incident. */
export function gatewayCapabilities(g: GatewayConfig, incidentAt: string | null = null): ConnectorCapabilities {
  const settings = getRoutingSettings();
  const provider = PROVIDERS[g.provider];
  const kind = kindOfGateway(g);
  let fromProvider: Partial<ConnectorCapabilities> = {};
  if (provider?.capabilities) {
    try {
      fromProvider = provider.capabilities(getGatewayCredentials(g.id)) ?? {};
    } catch {
      fromProvider = {};
    }
  }
  return {
    minMinor: 0,
    maxMinor: 0,
    refunds: !!provider?.refund,
    settlementT: settings.defaultSettlementT[kind] ?? 1,
    webhooks: !!provider?.parseWebhook,
    ...fromProvider,
    ...configCapabilities(g.config ?? {}),
    lastIncidentAt: incidentAt ?? fromProvider.lastIncidentAt ?? null,
  };
}

/** Capabilities of any rail id (wallet, gateway, direct operator, switch connection) without composing the whole registry. */
export function railCapabilities(id: string, incidentAt: string | null = null): ConnectorCapabilities {
  const settings = getRoutingSettings();
  if (id === 'wallet') return { minMinor: 0, maxMinor: 0, refunds: true, settlementT: settings.defaultSettlementT.wallet ?? 0, webhooks: false, lastIncidentAt: incidentAt };
  if (id.startsWith('operator:')) return { minMinor: 0, maxMinor: 0, refunds: false, settlementT: settings.defaultSettlementT.mobile_money ?? 1, webhooks: false, lastIncidentAt: incidentAt };
  const g = getGateway(id);
  if (g) return gatewayCapabilities(g, incidentAt);
  const sw = getDb().prepare('SELECT id FROM switch_connections WHERE id = ?').get(id);
  if (sw) return { minMinor: 0, maxMinor: 0, refunds: false, settlementT: settings.defaultSettlementT.national_switch ?? 1, webhooks: true, lastIncidentAt: incidentAt };
  return { minMinor: 0, maxMinor: 0, refunds: false, settlementT: 1, webhooks: false, lastIncidentAt: incidentAt };
}

// ---------------------------------------------------------------------------------------------------------------------
// Registry view
// ---------------------------------------------------------------------------------------------------------------------
export function listRails(filter: { kind?: RailKind | null; country?: string | null; currency?: string | null; method?: string | null } = {}): RailEntry[] {
  const settings = getRoutingSettings();
  const entries: RailEntry[] = [];
  const walletHealth = connectorHealth('wallet');
  const wallet: RailEntry = {
    id: 'wallet',
    name: 'BitriPay balance',
    kind: 'wallet',
    provider: 'ledger',
    methods: ['wallet'],
    countries: [],
    currencies: [],
    enabled: true,
    ready: true,
    mode: 'live',
    costBps: settings.defaultCostBps.wallet ?? 0,
    health: walletHealth,
    stats: connectorStats('wallet'),
    capabilities: railCapabilities('wallet', walletHealth.lastIncidentAt),
  };
  entries.push(wallet);
  for (const g of listGateways()) {
    const kind = kindOfGateway(g);
    const health = connectorHealth(g.id);
    entries.push({
      id: g.id,
      name: g.name,
      kind,
      provider: g.provider,
      methods: g.methods,
      countries: g.countries,
      currencies: g.currencies,
      enabled: g.enabled,
      ready: g.enabled && (g.mode !== 'unknown' || ['sandbox', 'manual_momo', 'manual_bank'].includes(g.provider)),
      mode: g.mode,
      costBps: typeof g.config.costBps === 'number' ? (g.config.costBps as number) : (settings.defaultCostBps[kind] ?? 100),
      health,
      stats: connectorStats(g.id),
      capabilities: gatewayCapabilities(g, health.lastIncidentAt),
    });
  }
  for (const o of listOperators({ onlyDirect: true })) {
    const id = `operator:${o.id}`;
    const health = connectorHealth(id);
    entries.push({
      id,
      name: `${o.name} (direct rail)`,
      kind: 'mobile_money',
      provider: 'manual_momo',
      methods: ['mobile_money'],
      countries: [o.country],
      currencies: [o.currency],
      enabled: o.enabled,
      ready: o.enabled && o.directRail,
      mode: 'test',
      costBps: settings.defaultCostBps.mobile_money ?? 150,
      health,
      stats: connectorStats(id),
      capabilities: railCapabilities(id, health.lastIncidentAt),
    });
  }
  const switches = getDb().prepare('SELECT * FROM switch_connections').all() as any[];
  for (const c of switches) {
    const cert = parseJson<{ status: string }>(c.certification, { status: 'NOT_STARTED' });
    const health = connectorHealth(c.id);
    entries.push({
      id: c.id,
      name: c.name,
      kind: 'national_switch',
      provider: `switch:${c.adapter}`,
      methods: ['national_switch'],
      countries: [c.country],
      currencies: [],
      enabled: !!c.enabled,
      ready: !!c.enabled && (c.environment !== 'production' || cert.status === 'CERTIFIED'),
      mode: c.environment === 'production' ? 'live' : 'test',
      costBps: settings.defaultCostBps.national_switch ?? 30,
      health,
      stats: connectorStats(c.id),
      capabilities: railCapabilities(c.id, health.lastIncidentAt),
    });
  }
  return entries.filter(
    (e) =>
      (!filter.kind || e.kind === filter.kind) &&
      (!filter.method || e.methods.includes(filter.method)) &&
      (!filter.country || !e.countries.length || e.countries.includes(filter.country.toUpperCase())) &&
      (!filter.currency || !e.currencies.length || e.currencies.includes(filter.currency.toUpperCase())),
  );
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
  /** Merchant preference rank (0 = first choice = the static default rail). */
  preferenceRank?: number | null;
  /** Amount and currencies of the payment being routed (liquidity, FX cost and amount-band statistics). */
  amountMinor?: number | null;
  currency?: string | null;
  /** Currency the funds settle in when it differs from the charge currency (FX cost term). */
  targetCurrency?: string | null;
  country?: string | null;
  operatorId?: string | null;
  /** Narrow the statistics to the payment's amount band / MSISDN-BIN prefix when enough data exists there. */
  amountBand?: AmountBand | null;
  prefix?: string | null;
}
export interface RouteScoreComponents {
  success: number;
  latency: number;
  cost: number;
  health: number;
  preference: number;
  settlementSpeed: number;
  fxCost: number;
  fraudRisk: number;
  liquidity: number;
  concentration: number;
}
export interface RouteScore {
  id: string;
  score: number;
  usable: boolean;
  reason: string | null;
  components: RouteScoreComponents;
  stats: ConnectorStats;
  capabilities: ConnectorCapabilities;
  /** Inputs behind the newer terms, for the explanation. */
  factors: { disputeRatio: number; concentrationShare: number; floatMinor: number | null; fxMarkupBps: number; settlementT: number; p95LatencyMs: number | null };
}

/** Disputes and chargebacks attributed to a connector over the last 30 days, as a share of its payments in that period. */
export function connectorDisputeRatio(connector: string, days = 30): number {
  const db = getDb();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const disputes = (
    db
      .prepare(
        `SELECT COUNT(*) c FROM disputes d LEFT JOIN payment_intents i ON i.id = d.intent_id LEFT JOIN gateway_payments g ON g.id = d.gateway_payment_id
         WHERE d.created_at >= ? AND (i.route_connector = ? OR g.gateway = ?)`,
      )
      .get(since, connector, connector) as any
  ).c;
  const chargebacks = (db.prepare('SELECT COUNT(*) c FROM chargebacks cb JOIN gateway_payments g ON g.id = cb.payment_id WHERE cb.opened_at >= ? AND g.gateway = ?').get(since, connector) as any).c;
  const payments =
    (db.prepare('SELECT COUNT(*) c FROM gateway_payments WHERE gateway = ? AND created_at >= ?').get(connector, since) as any).c +
    (db.prepare('SELECT COUNT(*) c FROM payment_attempts WHERE connector = ? AND started_at >= ?').get(connector, since) as any).c;
  const n = disputes + chargebacks;
  if (!n) return 0;
  return Math.min(1, n / Math.max(payments, n));
}

/** Share of the last hour's attempts on a method carried by each connector. */
export function concentrationShares(method: string): Map<string, number> {
  const settings = getRoutingSettings();
  const since = bucketOf(new Date(Date.now() - 3600_000), settings.stats.bucketMinutes);
  const rows = getDb().prepare('SELECT connector, COALESCE(SUM(attempts),0) a FROM routing_stats WHERE method = ? AND bucket >= ? GROUP BY connector').all(method, since) as {
    connector: string;
    a: number;
  }[];
  const total = rows.reduce((s, r) => s + r.a, 0);
  const out = new Map<string, number>();
  if (total < settings.minSample) return out;
  for (const r of rows) out.set(r.connector, r.a / total);
  return out;
}

/** Prefunded float available for a candidate (payout rails), or null when prefunding does not apply. */
function prefundedFloat(c: RouteCandidate): number | null {
  if ((c.method !== 'mobile_money' && c.method !== 'bank') || !c.currency) return null;
  const accounts = listPayoutAccounts({ rail: c.method, currency: c.currency.toUpperCase(), status: 'active' }).filter((a) =>
    c.method === 'mobile_money' && c.operatorId ? a.operatorId === c.operatorId : true,
  );
  if (!accounts.length) return null;
  return accounts.reduce((s, a) => s + a.balance, 0);
}

function fxMarkupBps(c: RouteCandidate): number {
  if (!c.currency || !c.targetCurrency || c.currency.toUpperCase() === c.targetCurrency.toUpperCase()) return 0;
  try {
    return fxDisclosure(c.currency, c.targetCurrency, null, false).markupBps;
  } catch {
    return getAppSettings().exchangeMarginBps;
  }
}

/**
 * Score candidates 0–100. Weights follow the policy: `smart` uses the configured mix, `cheapest` doubles cost and FX
 * cost, `fastest` doubles latency and settlement speed, `most_reliable` doubles success, health and fraud risk.
 * Unusable connectors (open circuit, paused, maintenance) are returned last with `usable: false` so the caller can
 * explain why they were skipped.
 */
export function scoreConnectors(candidates: RouteCandidate[], policy: RoutePolicy = 'smart', opts: { hours?: number } = {}): RouteScore[] {
  const settings = getRoutingSettings();
  const w = { ...settings.weights };
  if (policy === 'cheapest') {
    w.cost *= 2;
    w.fxCost *= 2;
  }
  if (policy === 'fastest') {
    w.latency *= 2;
    w.settlementSpeed *= 2;
  }
  if (policy === 'most_reliable') {
    w.success *= 2;
    w.health *= 2;
    w.fraudRisk *= 2;
  }
  const total = Object.values(w).reduce((s, x) => s + x, 0);
  const costs = candidates.map((c) => c.costBps ?? settings.defaultCostBps[c.method] ?? 100);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const shares = new Map<string, Map<string, number>>();
  const sharesFor = (method: string) => {
    if (!shares.has(method)) shares.set(method, concentrationShares(method));
    return shares.get(method)!;
  };
  return candidates
    .map((c, i) => {
      const hours = opts.hours ?? 24;
      // Segment statistics (amount band / prefix) when they hold a sample; the connector-wide window otherwise.
      let stats = connectorStats(c.id, c.method, hours);
      const band = c.amountBand ?? amountBandOf(c.amountMinor, c.currency);
      const prefix = c.prefix ? prefixOf(c.prefix) : '';
      if (band || prefix) {
        const segment = connectorStats(c.id, c.method, hours, { amountBand: band, prefix: prefix || null });
        if (segment.attempts - segment.declines >= settings.minSample) stats = segment;
      }
      const health = connectorHealth(c.id);
      const capabilities = railCapabilities(c.id, health.lastIncidentAt);
      // success: measured rate, or a neutral 85 when there is no sample yet (new connectors get a fair trial)
      const successPts = (stats.successRate ?? 85) - (stats.unknownRate ?? 0) * 2;
      const latencyRef = stats.p95LatencyMs ?? stats.avgLatencyMs;
      const latencyPts = latencyRef == null ? 70 : Math.max(0, 100 - (latencyRef / settings.slowLatencyMs) * 100);
      const costPts = maxCost === minCost ? 100 : 100 - ((costs[i] - minCost) / (maxCost - minCost)) * 100;
      let healthPts = !health.usable ? 0 : health.circuit === 'half_open' ? 40 : health.lastProbe ? (health.lastProbe.ok ? 100 : 20) : 80;
      if (health.usable && health.state === 'DEGRADED') healthPts = Math.min(healthPts, 60);
      const prefPts = c.preferenceRank == null ? 50 : Math.max(0, 100 - c.preferenceRank * 25);
      const settlementPts = Math.max(0, 100 - Math.max(0, capabilities.settlementT) * 25);
      const markup = fxMarkupBps(c);
      const fxPts = Math.max(0, 100 - markup / 3);
      const disputeRatio = connectorDisputeRatio(c.id);
      const fraudPts = Math.max(0, 100 - disputeRatio * 100 * 20);
      const float = prefundedFloat(c);
      const liquidityPts = float == null ? 100 : c.amountMinor ? Math.min(100, Math.round((float / (c.amountMinor * 5)) * 100)) : float > 0 ? 100 : 0;
      const share = sharesFor(c.method).get(c.id) ?? 0;
      const concentrationPts = share <= settings.concentrationShare ? 100 : Math.max(0, Math.round(100 - ((share - settings.concentrationShare) / (1 - settings.concentrationShare)) * 100));
      const score = Math.round(
        (w.success * successPts +
          w.latency * latencyPts +
          w.cost * costPts +
          w.health * healthPts +
          w.preference * prefPts +
          w.settlementSpeed * settlementPts +
          w.fxCost * fxPts +
          w.fraudRisk * fraudPts +
          w.liquidity * liquidityPts +
          w.concentration * concentrationPts) /
          total,
      );
      return {
        id: c.id,
        score: health.usable ? score : 0,
        usable: health.usable,
        reason: health.reason,
        components: {
          success: Math.round(successPts),
          latency: Math.round(latencyPts),
          cost: Math.round(costPts),
          health: healthPts,
          preference: prefPts,
          settlementSpeed: Math.round(settlementPts),
          fxCost: Math.round(fxPts),
          fraudRisk: Math.round(fraudPts),
          liquidity: liquidityPts,
          concentration: concentrationPts,
        },
        stats,
        capabilities,
        factors: {
          disputeRatio: Math.round(disputeRatio * 10000) / 10000,
          concentrationShare: Math.round(share * 1000) / 1000,
          floatMinor: float,
          fxMarkupBps: markup,
          settlementT: capabilities.settlementT,
          p95LatencyMs: stats.p95LatencyMs,
        },
      };
    })
    .sort((a, b) => Number(b.usable) - Number(a.usable) || b.score - a.score);
}

/** The static default rail: the merchant's first preference, else the first candidate. */
export function defaultCandidate(candidates: RouteCandidate[]): RouteCandidate | null {
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => (a.preferenceRank ?? Number.MAX_SAFE_INTEGER) - (b.preferenceRank ?? Number.MAX_SAFE_INTEGER))[0];
}

/**
 * Pick the best usable candidate id, or null when every candidate is unusable. `chosenBy` says whether Smart Route
 * changed the outcome ('smart') or confirmed the static default ('default'); pass it to recordRoutingOutcome so the
 * routing report can measure the uplift.
 */
export function pickConnector(
  candidates: RouteCandidate[],
  policy: RoutePolicy = 'smart',
): { id: string | null; scores: RouteScore[]; defaultId: string | null; chosenBy: 'smart' | 'default' | null } {
  const scores = scoreConnectors(candidates, policy);
  const id = scores.find((s) => s.usable)?.id ?? null;
  const defaultId = defaultCandidate(candidates)?.id ?? null;
  return { id, scores, defaultId, chosenBy: id == null ? null : id === defaultId ? 'default' : 'smart' };
}

export interface RoutingUplift {
  /** Success rate (window) of the rail Smart Route ranks first vs. the static default rail; points = difference. */
  smartRail: string | null;
  defaultRail: string | null;
  smartSuccessRate: number | null;
  defaultSuccessRate: number | null;
  points: number | null;
  /** Measured from outcomes recorded with `chosenBy` (attempts Smart Route redirected vs. attempts on the default). */
  measured: {
    smartAttempts: number;
    smartSuccesses: number;
    smartSuccessRate: number | null;
    defaultAttempts: number;
    defaultSuccesses: number;
    defaultSuccessRate: number | null;
    points: number | null;
  };
}
export interface RoutingReport {
  method: string | null;
  policy: RoutePolicy;
  window: { hours: number; bucketMinutes: number; retentionHours: number };
  weights: RoutingWeights;
  scores: RouteScore[];
  uplift: RoutingUplift;
  /** Amount bands the statistics are keyed on (base-currency units). */
  amountBands: AmountBand[];
  generatedAt: string;
}

/** The explainable routing report: ranking with every component, and the uplift of Smart Route over the static default rail. */
export function routingReport(candidates: RouteCandidate[], policy: RoutePolicy = 'smart', opts: { hours?: number } = {}): RoutingReport {
  const settings = getRoutingSettings();
  const hours = opts.hours ?? 24;
  const scores = scoreConnectors(candidates, policy, { hours });
  const method = candidates[0]?.method ?? null;
  const smart = scores.find((s) => s.usable) ?? null;
  const dflt = defaultCandidate(candidates);
  const defaultScore = dflt ? (scores.find((s) => s.id === dflt.id) ?? null) : null;
  const rate = (a: number, s: number) => (a >= settings.minSample ? Math.round((s / a) * 1000) / 10 : null);
  const since = bucketOf(new Date(Date.now() - hours * 3600_000), settings.stats.bucketMinutes);
  const m = getDb()
    .prepare(
      `SELECT COALESCE(SUM(smart_attempts),0) sa, COALESCE(SUM(smart_successes),0) ss, COALESCE(SUM(default_attempts),0) da, COALESCE(SUM(default_successes),0) ds FROM routing_stats WHERE bucket >= ? ${method ? 'AND method = ?' : ''}`,
    )
    .get(...(method ? [since, method] : [since])) as any;
  const measuredSmart = rate(m.sa, m.ss);
  const measuredDefault = rate(m.da, m.ds);
  const smartRate = smart?.stats.successRate ?? null;
  const defaultRate = defaultScore?.stats.successRate ?? null;
  return {
    method,
    policy,
    window: { hours, bucketMinutes: settings.stats.bucketMinutes, retentionHours: settings.stats.retentionHours },
    weights: settings.weights,
    scores,
    amountBands: AMOUNT_BANDS,
    uplift: {
      smartRail: smart?.id ?? null,
      defaultRail: dflt?.id ?? null,
      smartSuccessRate: smartRate,
      defaultSuccessRate: defaultRate,
      points: smartRate != null && defaultRate != null ? Math.round((smartRate - defaultRate) * 10) / 10 : null,
      measured: {
        smartAttempts: m.sa,
        smartSuccesses: m.ss,
        smartSuccessRate: measuredSmart,
        defaultAttempts: m.da,
        defaultSuccesses: m.ds,
        defaultSuccessRate: measuredDefault,
        points: measuredSmart != null && measuredDefault != null ? Math.round((measuredSmart - measuredDefault) * 10) / 10 : null,
      },
    },
    generatedAt: now(),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Health probes (scheduler)
// ---------------------------------------------------------------------------------------------------------------------
let lastProbeAt = 0;
export async function probeConnectors(force = false): Promise<{ probed: string[]; failed: string[]; pruned: number }> {
  const s = getRoutingSettings().circuit;
  if (!force && Date.now() - lastProbeAt < s.probeIntervalMinutes * 60_000) return { probed: [], failed: [], pruned: 0 };
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
  const pruned = pruneRoutingStats();
  return { probed, failed, pruned };
}
