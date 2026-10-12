/**
 * Corridor-network registry: the regulatory posture of a corridor, and the counterparties that carry its money.
 *
 * A network corridor is not a second corridor engine. The platform already routes, prices and books a corridor
 * (`services/corridors.ts`, `services/liquidity.ts`, `services/rails.ts`); this registry adds the one thing those
 * cannot express — under which phase, which licence and which custody model the corridor runs, with which rails and
 * limits, and which settlement mechanisms are permitted on it. The posture is data, so moving from one phase to the
 * next changes rows, not code.
 *
 * A counterparty is whoever holds BitriPay's money or owes it: an operator, a bank, a cross-border partner, a
 * sponsor bank, a settlement-token provider or an electronic-money principal. Its float is not a new balance: it is
 * the existing liquidity payout accounts linked to it, so one number is never kept in two places.
 */
import { getDb } from '../../db';
import { uuid, now } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { badRequest, notFound } from '../../lib/errors';
import { recordEvent } from '../events';
import { getPayoutAccount, listPayoutAccounts, type PayoutAccount } from '../liquidity';
import { getCurrency } from '../currencies';
import { NETWORK_PHASES, REGULATORY_MODES, SEED_CORRIDORS, SEED_COUNTERPARTIES, type RegulatoryMode } from '../../content/corridorNetwork';
import type { UserRow } from '../users';

export type CorridorStatus = 'draft' | 'sandbox' | 'live' | 'suspended';
export type CounterpartyStatus = 'draft' | 'active' | 'suspended';
export type SettlementWindow = 'hourly' | 'daily' | 'weekly' | 'manual';

export const COUNTERPARTY_KINDS = ['mobile_money', 'bank', 'aggregator', 'sponsor_bank', 'token_provider', 'emi_principal'] as const;
export type CounterpartyKind = (typeof COUNTERPARTY_KINDS)[number];

export const SETTLEMENT_WINDOWS: SettlementWindow[] = ['hourly', 'daily', 'weekly', 'manual'];

export interface CorridorLimits {
  perPaymentMinor: number;
  perDayMinor: number;
  perMonthMinor: number;
  currency: string;
}

export interface NetworkCorridor {
  id: string;
  code: string;
  name: string;
  sourceCountry: string;
  destCountry: string;
  sourceCurrency: string;
  destCurrency: string;
  settlementCurrency: string;
  phase: number;
  phaseName: string;
  regulatoryMode: RegulatoryMode;
  regulatoryLabel: string;
  custody: string;
  licenceBasis: string | null;
  principalName: string | null;
  collectionRails: string[];
  payoutRails: string[];
  settlementRails: string[];
  limits: CorridorLimits;
  stablecoinAllowed: boolean;
  papssAllowed: boolean;
  corridorId: string | null;
  status: CorridorStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NetworkCounterparty {
  id: string;
  code: string;
  name: string;
  kind: CounterpartyKind;
  country: string | null;
  currencies: string[];
  settlementWindow: SettlementWindow;
  exposureLimitMinor: number;
  exposureCurrency: string | null;
  safetyFactorBps: number;
  payoutAccountIds: string[];
  status: CounterpartyStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_LIMITS: CorridorLimits = { perPaymentMinor: 0, perDayMinor: 0, perMonthMinor: 0, currency: 'USD' };

function corridorRow(r: any): NetworkCorridor {
  const phase = NETWORK_PHASES.find((p) => p.phase === r.phase);
  const mode = (r.regulatory_mode as RegulatoryMode) ?? 'non_custodial';
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    sourceCountry: r.source_country,
    destCountry: r.dest_country,
    sourceCurrency: r.source_currency,
    destCurrency: r.dest_currency,
    settlementCurrency: r.settlement_currency,
    phase: r.phase,
    phaseName: phase?.name ?? `Phase ${r.phase}`,
    regulatoryMode: mode,
    regulatoryLabel: REGULATORY_MODES[mode]?.label ?? mode,
    custody: REGULATORY_MODES[mode]?.custody ?? 'Unknown',
    licenceBasis: r.licence_basis ?? null,
    principalName: r.principal_name ?? null,
    collectionRails: parseJson<string[]>(r.collection_rails, []),
    payoutRails: parseJson<string[]>(r.payout_rails, []),
    settlementRails: parseJson<string[]>(r.settlement_rails, []),
    limits: { ...DEFAULT_LIMITS, ...parseJson<Partial<CorridorLimits>>(r.limits, {}) },
    stablecoinAllowed: !!r.stablecoin_allowed,
    papssAllowed: !!r.papss_allowed,
    corridorId: r.corridor_id ?? null,
    status: r.status,
    notes: r.notes ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function counterpartyRow(r: any): NetworkCounterparty {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    kind: r.kind,
    country: r.country ?? null,
    currencies: parseJson<string[]>(r.currencies, []),
    settlementWindow: r.settlement_window,
    exposureLimitMinor: r.exposure_limit_minor,
    exposureCurrency: r.exposure_currency ?? null,
    safetyFactorBps: r.safety_factor_bps,
    payoutAccountIds: parseJson<string[]>(r.payout_account_ids, []),
    status: r.status,
    notes: r.notes ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ------------------------------------------------------------------ corridors

export function listNetworkCorridors(filter: { status?: CorridorStatus | null; phase?: number | null } = {}): NetworkCorridor[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status) {
    where.push('status = ?');
    args.push(filter.status);
  }
  if (filter.phase) {
    where.push('phase = ?');
    args.push(filter.phase);
  }
  const sql = `SELECT * FROM network_corridors ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY phase, code`;
  return (
    getDb()
      .prepare(sql)
      .all(...args) as any[]
  ).map(corridorRow);
}

export function getNetworkCorridor(idOrCode: string): NetworkCorridor {
  const r = getDb().prepare('SELECT * FROM network_corridors WHERE id = ? OR code = ?').get(idOrCode, idOrCode) as any;
  if (!r) throw notFound('Unknown corridor', 'corridor_not_found');
  return corridorRow(r);
}

export function findNetworkCorridor(idOrCode: string | null | undefined): NetworkCorridor | null {
  if (!idOrCode) return null;
  const r = getDb().prepare('SELECT * FROM network_corridors WHERE id = ? OR code = ?').get(idOrCode, idOrCode) as any;
  return r ? corridorRow(r) : null;
}

export interface CorridorInput {
  code: string;
  name: string;
  sourceCountry: string;
  destCountry: string;
  sourceCurrency: string;
  destCurrency: string;
  settlementCurrency: string;
  phase: number;
  regulatoryMode: RegulatoryMode;
  licenceBasis?: string | null;
  principalName?: string | null;
  collectionRails?: string[];
  payoutRails?: string[];
  settlementRails?: string[];
  limits?: Partial<CorridorLimits>;
  stablecoinAllowed?: boolean;
  papssAllowed?: boolean;
  corridorId?: string | null;
  notes?: string | null;
}

function assertCurrencies(input: Pick<CorridorInput, 'sourceCurrency' | 'destCurrency' | 'settlementCurrency'>) {
  for (const c of [input.sourceCurrency, input.destCurrency, input.settlementCurrency]) {
    if (!/^[A-Z]{3}$/.test(c)) throw badRequest(`"${c}" is not a three-letter currency code`, 'unsupported_currency');
  }
}

export function upsertNetworkCorridor(input: CorridorInput, admin: UserRow): NetworkCorridor {
  assertCurrencies(input);
  if (!NETWORK_PHASES.some((p) => p.phase === input.phase)) throw badRequest('Phase must be 1, 2, 3 or 4');
  if (!REGULATORY_MODES[input.regulatoryMode]) throw badRequest('Unknown regulatory mode');
  const existing = getDb().prepare('SELECT * FROM network_corridors WHERE code = ?').get(input.code) as any;
  const id = existing?.id ?? uuid();
  const ts = now();
  const limits = { ...DEFAULT_LIMITS, ...(existing ? parseJson<Partial<CorridorLimits>>(existing.limits, {}) : {}), ...(input.limits ?? {}) };
  getDb()
    .prepare(
      `INSERT INTO network_corridors (id, code, name, source_country, dest_country, source_currency, dest_currency, settlement_currency, phase, regulatory_mode, licence_basis, principal_name,
        collection_rails, payout_rails, settlement_rails, limits, stablecoin_allowed, papss_allowed, corridor_id, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET name = excluded.name, source_country = excluded.source_country, dest_country = excluded.dest_country, source_currency = excluded.source_currency,
         dest_currency = excluded.dest_currency, settlement_currency = excluded.settlement_currency, phase = excluded.phase, regulatory_mode = excluded.regulatory_mode,
         licence_basis = excluded.licence_basis, principal_name = excluded.principal_name, collection_rails = excluded.collection_rails, payout_rails = excluded.payout_rails,
         settlement_rails = excluded.settlement_rails, limits = excluded.limits, corridor_id = excluded.corridor_id, notes = excluded.notes, updated_at = excluded.updated_at`,
    )
    .run(
      id,
      input.code,
      input.name,
      input.sourceCountry,
      input.destCountry,
      input.sourceCurrency,
      input.destCurrency,
      input.settlementCurrency,
      input.phase,
      input.regulatoryMode,
      input.licenceBasis ?? null,
      input.principalName ?? null,
      JSON.stringify(input.collectionRails ?? parseJson<string[]>(existing?.collection_rails, [])),
      JSON.stringify(input.payoutRails ?? parseJson<string[]>(existing?.payout_rails, [])),
      JSON.stringify(input.settlementRails ?? parseJson<string[]>(existing?.settlement_rails, [])),
      JSON.stringify(limits),
      input.stablecoinAllowed === undefined ? (existing?.stablecoin_allowed ?? 0) : input.stablecoinAllowed ? 1 : 0,
      input.papssAllowed === undefined ? (existing?.papss_allowed ?? 0) : input.papssAllowed ? 1 : 0,
      input.corridorId ?? null,
      existing?.status ?? 'draft',
      input.notes ?? null,
      existing?.created_at ?? ts,
      ts,
    );
  recordEvent('network', id, existing ? 'network.corridor.updated' : 'network.corridor.created', { type: 'admin', id: admin.id }, { code: input.code, phase: input.phase });
  return getNetworkCorridor(id);
}

/**
 * A corridor only carries real money when an administrator says so, and only when the posture is complete:
 * a licence basis, at least one collection and one payout rail, and limits that are actually set.
 */
export function corridorReadiness(c: NetworkCorridor): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!c.licenceBasis) missing.push('licence basis');
  if (c.regulatoryMode === 'partner_custody' && !c.principalName) missing.push('named partner holding the funds');
  if (!c.collectionRails.length) missing.push('at least one collection rail');
  if (!c.payoutRails.length) missing.push('at least one payout rail');
  if (!c.limits.perPaymentMinor) missing.push('per-payment limit');
  if (!c.limits.perDayMinor) missing.push('daily limit');
  return { ready: missing.length === 0, missing };
}

export function setCorridorStatus(idOrCode: string, status: CorridorStatus, admin: UserRow, reason?: string | null): NetworkCorridor {
  const c = getNetworkCorridor(idOrCode);
  if (status === 'live') {
    const readiness = corridorReadiness(c);
    if (!readiness.ready) throw badRequest(`This corridor is not ready to go live: ${readiness.missing.join(', ')} missing.`, 'corridor_not_ready', readiness.missing);
  }
  getDb().prepare('UPDATE network_corridors SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), c.id);
  recordEvent('network', c.id, `network.corridor.${status}`, { type: 'admin', id: admin.id }, { code: c.code, reason: reason ?? null });
  return getNetworkCorridor(c.id);
}

/**
 * Settlement mechanisms that need an explicit decision are off until that decision is recorded: a sponsor-bank
 * participation and a settlement-token leg are each switched on per corridor, with the reason kept in the event log.
 */
export function setCorridorSettlementFlag(idOrCode: string, flag: 'stablecoin' | 'papss', on: boolean, admin: UserRow, reason: string): NetworkCorridor {
  const c = getNetworkCorridor(idOrCode);
  if (on && !reason.trim()) throw badRequest('Say which decision allows this settlement mechanism on this corridor.');
  const column = flag === 'stablecoin' ? 'stablecoin_allowed' : 'papss_allowed';
  getDb()
    .prepare(`UPDATE network_corridors SET ${column} = ?, updated_at = ? WHERE id = ?`)
    .run(on ? 1 : 0, now(), c.id);
  recordEvent('network', c.id, `network.corridor.${flag}.${on ? 'allowed' : 'blocked'}`, { type: 'admin', id: admin.id }, { code: c.code, reason });
  return getNetworkCorridor(c.id);
}

// ------------------------------------------------------------ counterparties

export function listCounterparties(filter: { kind?: string | null; status?: CounterpartyStatus | null } = {}): NetworkCounterparty[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.kind) {
    where.push('kind = ?');
    args.push(filter.kind);
  }
  if (filter.status) {
    where.push('status = ?');
    args.push(filter.status);
  }
  const sql = `SELECT * FROM network_counterparties ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY kind, code`;
  return (
    getDb()
      .prepare(sql)
      .all(...args) as any[]
  ).map(counterpartyRow);
}

export function getCounterparty(idOrCode: string): NetworkCounterparty {
  const r = getDb().prepare('SELECT * FROM network_counterparties WHERE id = ? OR code = ?').get(idOrCode, idOrCode) as any;
  if (!r) throw notFound('Unknown counterparty', 'counterparty_not_found');
  return counterpartyRow(r);
}

export interface CounterpartyInput {
  code: string;
  name: string;
  kind: CounterpartyKind;
  country?: string | null;
  currencies: string[];
  settlementWindow?: SettlementWindow;
  exposureLimitMinor?: number;
  exposureCurrency?: string | null;
  safetyFactorBps?: number;
  payoutAccountIds?: string[];
  notes?: string | null;
}

export function upsertCounterparty(input: CounterpartyInput, admin: UserRow): NetworkCounterparty {
  if (!COUNTERPARTY_KINDS.includes(input.kind)) throw badRequest(`Unknown counterparty kind "${input.kind}"`);
  if (!input.currencies.length) throw badRequest('A counterparty settles in at least one currency');
  for (const c of input.currencies) getCurrency(c);
  if (input.settlementWindow && !SETTLEMENT_WINDOWS.includes(input.settlementWindow)) throw badRequest('Unknown settlement window');
  for (const accountId of input.payoutAccountIds ?? []) getPayoutAccount(accountId);
  if (input.safetyFactorBps !== undefined && (input.safetyFactorBps < 10_000 || input.safetyFactorBps > 50_000)) {
    throw badRequest('The safety factor is between 1.0 and 5.0 times the forecast (10000–50000 basis points).');
  }
  const existing = getDb().prepare('SELECT * FROM network_counterparties WHERE code = ?').get(input.code) as any;
  const id = existing?.id ?? uuid();
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO network_counterparties (id, code, name, kind, country, currencies, settlement_window, exposure_limit_minor, exposure_currency, safety_factor_bps, payout_account_ids, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET name = excluded.name, kind = excluded.kind, country = excluded.country, currencies = excluded.currencies, settlement_window = excluded.settlement_window,
         exposure_limit_minor = excluded.exposure_limit_minor, exposure_currency = excluded.exposure_currency, safety_factor_bps = excluded.safety_factor_bps,
         payout_account_ids = excluded.payout_account_ids, notes = excluded.notes, updated_at = excluded.updated_at`,
    )
    .run(
      id,
      input.code,
      input.name,
      input.kind,
      input.country ?? null,
      JSON.stringify(input.currencies),
      input.settlementWindow ?? existing?.settlement_window ?? 'daily',
      input.exposureLimitMinor ?? existing?.exposure_limit_minor ?? 0,
      input.exposureCurrency ?? existing?.exposure_currency ?? input.currencies[0],
      input.safetyFactorBps ?? existing?.safety_factor_bps ?? 15_000,
      JSON.stringify(input.payoutAccountIds ?? parseJson<string[]>(existing?.payout_account_ids, [])),
      existing?.status ?? 'draft',
      input.notes ?? null,
      existing?.created_at ?? ts,
      ts,
    );
  recordEvent('network', id, existing ? 'network.counterparty.updated' : 'network.counterparty.created', { type: 'admin', id: admin.id }, { code: input.code, kind: input.kind });
  return getCounterparty(id);
}

export function setCounterpartyStatus(idOrCode: string, status: CounterpartyStatus, admin: UserRow, reason?: string | null): NetworkCounterparty {
  const cp = getCounterparty(idOrCode);
  if (status === 'active' && !cp.payoutAccountIds.length && cp.kind !== 'sponsor_bank' && cp.kind !== 'emi_principal') {
    throw badRequest('Link the liquidity account that carries this counterparty’s float before activating it.', 'float_account_required');
  }
  getDb().prepare('UPDATE network_counterparties SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), cp.id);
  recordEvent('network', cp.id, `network.counterparty.${status}`, { type: 'admin', id: admin.id }, { code: cp.code, reason: reason ?? null });
  return getCounterparty(cp.id);
}

export interface CounterpartyFloat {
  currency: string;
  balanceMinor: number;
  accounts: { id: string; label: string; balanceMinor: number; status: PayoutAccount['status'] }[];
  exposureLimitMinor: number;
  /** Share of the exposure limit used, in basis points; null when no limit is set. */
  utilisationBps: number | null;
  overLimit: boolean;
}

/** What a counterparty holds for BitriPay right now, read from the liquidity accounts rather than kept separately. */
export function counterpartyFloat(idOrCode: string): CounterpartyFloat[] {
  const cp = getCounterparty(idOrCode);
  const accounts = cp.payoutAccountIds.map((id) => {
    try {
      return getPayoutAccount(id);
    } catch {
      return null;
    }
  });
  const byCurrency = new Map<string, PayoutAccount[]>();
  for (const a of accounts) {
    if (!a) continue;
    byCurrency.set(a.currency, [...(byCurrency.get(a.currency) ?? []), a]);
  }
  for (const currency of cp.currencies) if (!byCurrency.has(currency)) byCurrency.set(currency, []);
  return [...byCurrency.entries()]
    .map(([currency, list]) => {
      const balanceMinor = list.reduce((n, a) => n + a.balance, 0);
      const exposureLimitMinor = cp.exposureCurrency === currency ? cp.exposureLimitMinor : 0;
      return {
        currency,
        balanceMinor,
        accounts: list.map((a) => ({ id: a.id, label: a.label, balanceMinor: a.balance, status: a.status })),
        exposureLimitMinor,
        utilisationBps: exposureLimitMinor ? Math.round((balanceMinor / exposureLimitMinor) * 10_000) : null,
        overLimit: exposureLimitMinor > 0 && balanceMinor > exposureLimitMinor,
      };
    })
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Liquidity accounts not yet attached to any counterparty, so nothing is left unaccounted for. */
export function unlinkedPayoutAccounts(): PayoutAccount[] {
  const linked = new Set(listCounterparties().flatMap((c) => c.payoutAccountIds));
  return listPayoutAccounts().filter((a) => !linked.has(a.id));
}

// -------------------------------------------------------------------- seeding

/**
 * Insert what the specification declares and nothing else: an administrator's edits, answers and status changes are
 * never overwritten, so seeding is safe to run on every boot.
 */
export function seedCorridorNetwork(): { corridors: number; counterparties: number } {
  const db = getDb();
  const ts = now();
  let corridors = 0;
  let counterparties = 0;
  for (const c of SEED_CORRIDORS) {
    if (db.prepare('SELECT 1 FROM network_corridors WHERE code = ?').get(c.code)) continue;
    db.prepare(
      `INSERT INTO network_corridors (id, code, name, source_country, dest_country, source_currency, dest_currency, settlement_currency, phase, regulatory_mode, licence_basis, principal_name,
        collection_rails, payout_rails, settlement_rails, limits, stablecoin_allowed, papss_allowed, corridor_id, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, 'draft', ?, ?, ?)`,
    ).run(
      uuid(),
      c.code,
      c.name,
      c.sourceCountry,
      c.destCountry,
      c.sourceCurrency,
      c.destCurrency,
      c.settlementCurrency,
      c.phase,
      c.regulatoryMode,
      c.licenceBasis,
      null,
      JSON.stringify(c.collectionRails),
      JSON.stringify(c.payoutRails),
      JSON.stringify(c.settlementRails),
      JSON.stringify(c.limits),
      c.notes,
      ts,
      ts,
    );
    corridors += 1;
  }
  for (const cp of SEED_COUNTERPARTIES) {
    if (db.prepare('SELECT 1 FROM network_counterparties WHERE code = ?').get(cp.code)) continue;
    db.prepare(
      `INSERT INTO network_counterparties (id, code, name, kind, country, currencies, settlement_window, exposure_limit_minor, exposure_currency, safety_factor_bps, payout_account_ids, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 15000, '[]', 'draft', ?, ?, ?)`,
    ).run(uuid(), cp.code, cp.name, cp.kind, cp.country, JSON.stringify(cp.currencies), cp.settlementWindow, cp.currencies[0], cp.notes, ts, ts);
    counterparties += 1;
  }
  return { corridors, counterparties };
}

/** Everything the console needs to show the posture of the network on one screen. */
export function networkOverview() {
  const corridors = listNetworkCorridors();
  const counterparties = listCounterparties();
  const byPhase = NETWORK_PHASES.map((p) => ({
    ...p,
    corridors: corridors.filter((c) => c.phase === p.phase).length,
    live: corridors.filter((c) => c.phase === p.phase && c.status === 'live').length,
  }));
  return {
    phases: byPhase,
    regulatoryModes: REGULATORY_MODES,
    corridors: corridors.map((c) => ({ ...c, readiness: corridorReadiness(c) })),
    counterparties: counterparties.map((cp) => ({ ...cp, float: counterpartyFloat(cp.id) })),
    unlinkedPayoutAccounts: unlinkedPayoutAccounts().map((a) => ({ id: a.id, label: a.label, currency: a.currency, balanceMinor: a.balance })),
  };
}
