/**
 * Safeguarding: the daily evidence an issuer of electronic money has to be able to show, and the pack an
 * administrator could act on if the firm stopped trading tomorrow.
 *
 * The platform already enforces the issuance rule — e-money may not be issued beyond cleared, safeguarded funds
 * (`services/emoney.ts`). That rule stops money being created. This module answers the other question, the one a
 * supervisor asks: on this day, in this currency, did the safeguarded funds still cover what customers are owed, and
 * can you prove it?
 *
 * Two reconciliations, kept apart because they fail for different reasons:
 *   · **internal** — the firm's own records agree with themselves: every customer wallet balance equals the sum of
 *     its own postings, so the liability figure is worth something. A mismatch here is a ledger defect.
 *   · **external** — the safeguarding requirement equals the cleared funds held in designated accounts. A shortfall
 *     here is money, and it is remedied from own funds the same day.
 *
 * A shortfall is release-blocking, not a report: `assertSafeguardingHealthy()` is what a go-live check calls, and it
 * refuses while a day is short.
 */
import { getDb } from '../../db';
import { uuid, now } from '../../lib/ids';
import { sha256 } from '../../lib/crypto';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { recordEvent } from '../events';
import { programmeForCurrency, recordReserveMovement, reservePosition, type ReservePosition } from '../emoney';
import { listCurrencies } from '../currencies';
import type { UserRow } from '../users';

export type SafeguardingStatus = 'ok' | 'shortfall' | 'remedy_pending' | 'remedied' | 'no_programme';

export interface SafeguardingCheck {
  id: string;
  day: string;
  currency: string;
  /** What customers are owed: the redeemable claims outstanding in this currency. */
  liabilityMinor: number;
  /** What the designated accounts hold, cleared. */
  safeguardedMinor: number;
  externalMinor: number | null;
  shortfallMinor: number;
  internalOk: boolean;
  externalOk: boolean;
  status: SafeguardingStatus;
  toppedUpMinor: number;
  toppedUpBy: string | null;
  toppedUpAt: string | null;
  detail: {
    walletCount?: number;
    walletSumMinor?: number;
    postedSumMinor?: number;
    mismatchedWallets?: { walletId: string; balance: number; computed: number }[];
    programmeId?: string | null;
    position?: Partial<ReservePosition>;
    note?: string;
  };
  createdAt: string;
}

export interface ResolutionPack {
  id: string;
  day: string;
  hash: string;
  prevHash: string | null;
  holderCount: number;
  currencies: string[];
  totals: Record<string, number>;
  generatedBy: string | null;
  createdAt: string;
}

const today = (at = new Date()): string => at.toISOString().slice(0, 10);

function checkRow(r: any): SafeguardingCheck {
  return {
    id: r.id,
    day: r.day,
    currency: r.currency,
    liabilityMinor: r.liability_minor,
    safeguardedMinor: r.safeguarded_minor,
    externalMinor: r.external_minor ?? null,
    shortfallMinor: r.shortfall_minor,
    internalOk: !!r.internal_ok,
    externalOk: !!r.external_ok,
    status: r.status,
    toppedUpMinor: r.topped_up_minor,
    toppedUpBy: r.topped_up_by ?? null,
    toppedUpAt: r.topped_up_at ?? null,
    detail: JSON.parse(r.detail || '{}'),
    createdAt: r.created_at,
  };
}

/**
 * The internal reconciliation: each customer wallet balance against the sum of the postings that made it. Scoped to
 * one currency so a defect in one currency does not hide behind another's totals.
 */
export function internalReconciliation(currency: string): {
  walletCount: number;
  walletSumMinor: number;
  postedSumMinor: number;
  mismatched: { walletId: string; balance: number; computed: number }[];
} {
  const db = getDb();
  const wallets = db.prepare('SELECT w.id, w.balance FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.is_system = 0 AND w.currency = ?').all(currency) as { id: string; balance: number }[];
  const mismatched: { walletId: string; balance: number; computed: number }[] = [];
  let postedSum = 0;
  for (const w of wallets) {
    const row = db.prepare("SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END), 0) s FROM ledger_entries WHERE wallet_id = ?").get(w.id) as { s: number };
    postedSum += row.s;
    if (row.s !== w.balance) mismatched.push({ walletId: w.id, balance: w.balance, computed: row.s });
  }
  return { walletCount: wallets.length, walletSumMinor: wallets.reduce((n, w) => n + w.balance, 0), postedSumMinor: postedSum, mismatched };
}

/**
 * Run and record the day's check for one currency. Re-running the same day recomputes it in place: the check is
 * evidence of the position, not a log of how often somebody looked.
 */
export function runSafeguardingCheck(currency: string, opts: { day?: string; externalMinor?: number | null; actorId?: string | null } = {}): SafeguardingCheck {
  const code = currency.toUpperCase();
  const day = opts.day ?? today();
  const programme = programmeForCurrency(code);
  const internal = internalReconciliation(code);
  const internalOk = internal.mismatched.length === 0;

  let liability = internal.walletSumMinor;
  let safeguarded = 0;
  let position: Partial<ReservePosition> = {};
  let status: SafeguardingStatus = 'ok';
  if (programme) {
    const p = reservePosition(programme);
    position = {
      clearedReserves: p.clearedReserves,
      liabilities: p.liabilities,
      pendingRedemptions: p.pendingRedemptions,
      reservedExposure: p.reservedExposure,
      headroom: p.headroom,
      sandbox: p.sandbox,
    };
    liability = p.liabilities;
    safeguarded = p.clearedReserves;
  } else {
    status = 'no_programme';
  }

  // The external comparison uses the designated-account balance an administrator entered when there is one, and the
  // cleared reserve movements otherwise. Entering the real balance is what makes the check external at all.
  const external = opts.externalMinor ?? null;
  const held = external ?? safeguarded;
  const shortfall = Math.max(0, liability - held);
  const externalOk = programme ? shortfall === 0 : false;
  if (programme) status = shortfall > 0 ? 'shortfall' : 'ok';

  const existing = getDb().prepare('SELECT * FROM network_safeguarding_checks WHERE day = ? AND currency = ?').get(day, code) as any;
  const detail = {
    walletCount: internal.walletCount,
    walletSumMinor: internal.walletSumMinor,
    postedSumMinor: internal.postedSumMinor,
    mismatchedWallets: internal.mismatched.slice(0, 50),
    programmeId: programme?.id ?? null,
    position,
    note: programme ? undefined : `No e-money programme is declared for ${code}: there is nothing to safeguard yet, and nothing to prove.`,
  };
  if (existing) {
    // A day already remedied keeps its remedy; the figures are refreshed around it.
    const keepStatus = existing.status === 'remedied' && shortfall === 0 ? 'remedied' : existing.status === 'remedy_pending' && shortfall > 0 ? 'remedy_pending' : status;
    getDb()
      .prepare(
        'UPDATE network_safeguarding_checks SET liability_minor = ?, safeguarded_minor = ?, external_minor = ?, shortfall_minor = ?, internal_ok = ?, external_ok = ?, status = ?, detail = ? WHERE id = ?',
      )
      .run(liability, safeguarded, external, shortfall, internalOk ? 1 : 0, externalOk ? 1 : 0, keepStatus, JSON.stringify(detail), existing.id);
  } else {
    getDb()
      .prepare(
        `INSERT INTO network_safeguarding_checks (id, day, currency, liability_minor, safeguarded_minor, external_minor, shortfall_minor, internal_ok, external_ok, status, topped_up_minor, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(uuid(), day, code, liability, safeguarded, external, shortfall, internalOk ? 1 : 0, externalOk ? 1 : 0, status, JSON.stringify(detail), now());
  }
  const check = getCheck(day, code);
  if (!internalOk || check.shortfallMinor > 0) {
    recordEvent(
      'network',
      check.id,
      'network.safeguarding.alert',
      { type: opts.actorId ? 'admin' : 'system', id: opts.actorId ?? null },
      {
        day,
        currency: code,
        shortfall: check.shortfallMinor,
        internalOk,
        mismatchedWallets: internal.mismatched.length,
      },
    );
  }
  return check;
}

export function getCheck(day: string, currency: string): SafeguardingCheck {
  const r = getDb().prepare('SELECT * FROM network_safeguarding_checks WHERE day = ? AND currency = ?').get(day, currency.toUpperCase()) as any;
  if (!r) throw notFound('No safeguarding check for that day and currency', 'safeguarding_check_not_found');
  return checkRow(r);
}

export function listChecks(filter: { currency?: string | null; from?: string | null; limit?: number } = {}): SafeguardingCheck[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.currency) {
    where.push('currency = ?');
    args.push(filter.currency.toUpperCase());
  }
  if (filter.from) {
    where.push('day >= ?');
    args.push(filter.from);
  }
  const sql = `SELECT * FROM network_safeguarding_checks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY day DESC, currency LIMIT ?`;
  return (
    getDb()
      .prepare(sql)
      .all(...args, Math.min(filter.limit ?? 120, 1000)) as any[]
  ).map(checkRow);
}

/** Every currency that has customer balances or a declared programme, checked for the day. */
export function runDailySafeguarding(opts: { day?: string; actorId?: string | null } = {}): SafeguardingCheck[] {
  const currencies = listCurrencies().map((c) => c.code);
  const out: SafeguardingCheck[] = [];
  for (const code of currencies) {
    const hasBalances =
      (getDb().prepare('SELECT COUNT(*) n FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.is_system = 0 AND w.currency = ? AND w.balance <> 0').get(code) as { n: number }).n > 0;
    if (!hasBalances && !programmeForCurrency(code)) continue;
    out.push(runSafeguardingCheck(code, opts));
  }
  return out;
}

/**
 * Remedy a shortfall from own funds the same day. The money is recorded as a pending funding movement on the
 * programme, which a second administrator clears through the existing reserve maker-checker: this module raises the
 * remedy, it does not clear its own money.
 */
export function remedyShortfall(day: string, currency: string, admin: UserRow, note?: string | null): SafeguardingCheck {
  const check = getCheck(day, currency);
  if (check.shortfallMinor <= 0) throw conflict('There is no shortfall on that day.', 'no_shortfall');
  if (check.status === 'remedy_pending') throw conflict('A remedy for that day is already waiting to be cleared.', 'remedy_pending');
  const programme = programmeForCurrency(check.currency);
  if (!programme) throw badRequest(`No e-money programme is declared for ${check.currency}.`, 'programme_required');
  const movement = recordReserveMovement(
    {
      programmeId: programme.id,
      kind: 'funding',
      direction: 'in',
      amount: check.shortfallMinor,
      status: 'pending',
      reference: `SAFEGUARD-${day}-${check.currency}`,
      note: note ?? `Same-day remedy of the safeguarding shortfall of ${day}`,
      proposedBy: admin.id,
    },
    { type: 'admin', id: admin.id },
  );
  getDb()
    .prepare("UPDATE network_safeguarding_checks SET status = 'remedy_pending', topped_up_minor = ?, topped_up_by = ?, topped_up_at = ? WHERE id = ?")
    .run(check.shortfallMinor, admin.id, now(), check.id);
  recordEvent('network', check.id, 'network.safeguarding.remedy_raised', { type: 'admin', id: admin.id }, { day, currency: check.currency, amount: check.shortfallMinor, movementId: movement.id });
  return getCheck(day, currency);
}

/** Re-run a remedied day and close it when the funding has cleared and the cover is back. */
export function confirmRemedy(day: string, currency: string, admin: UserRow): SafeguardingCheck {
  const refreshed = runSafeguardingCheck(currency, { day, actorId: admin.id });
  if (refreshed.shortfallMinor > 0) throw conflict(`That day is still short by ${refreshed.shortfallMinor} minor units; the funding has not cleared.`, 'still_short');
  getDb().prepare("UPDATE network_safeguarding_checks SET status = 'remedied' WHERE day = ? AND currency = ?").run(day, currency.toUpperCase());
  recordEvent('network', refreshed.id, 'network.safeguarding.remedied', { type: 'admin', id: admin.id }, { day, currency: refreshed.currency });
  return getCheck(day, currency);
}

/** What a release gate calls. Refuses while any currency is short or any wallet disagrees with its own postings. */
export function assertSafeguardingHealthy(day = today()): void {
  const checks = listChecks({ from: day });
  const short = checks.filter((c) => c.day === day && c.shortfallMinor > 0 && c.status !== 'remedied');
  if (short.length) throw conflict(`Safeguarding is short on ${day}: ${short.map((c) => `${c.currency} by ${c.shortfallMinor}`).join(', ')}.`, 'safeguarding_shortfall');
  const broken = checks.filter((c) => c.day === day && !c.internalOk);
  if (broken.length) throw conflict(`The internal reconciliation does not balance on ${day} for ${broken.map((c) => c.currency).join(', ')}.`, 'safeguarding_internal_mismatch');
}

// ---------------------------------------------------------- resolution pack

/**
 * The pack an administrator could use to return customer funds: every holder with their balance, the designated
 * accounts behind them, and the day's checks. Hash-chained to the previous day's pack, so a pack cannot be rewritten
 * afterwards without the chain saying so.
 */
export function generateResolutionPack(opts: { day?: string; actorId?: string | null } = {}): ResolutionPack {
  const day = opts.day ?? today();
  const db = getDb();
  const holders = db
    .prepare(
      `SELECT u.id user_id, u.full_name, u.email, u.phone, u.role, w.id wallet_id, w.currency, w.balance
         FROM wallets w JOIN users u ON u.id = w.user_id
        WHERE u.is_system = 0 AND w.balance <> 0
        ORDER BY w.currency, w.balance DESC`,
    )
    .all() as any[];
  const totals: Record<string, number> = {};
  for (const h of holders) totals[h.currency] = (totals[h.currency] ?? 0) + h.balance;
  const currencies = Object.keys(totals).sort();
  const checks = listChecks({ from: day }).filter((c) => c.day === day);
  const programmes = currencies.map((c) => {
    const p = programmeForCurrency(c);
    return p
      ? {
          currency: c,
          programmeId: p.id,
          jurisdiction: p.jurisdiction,
          issuerModel: p.issuer_model,
          status: p.status,
          safeguardingBank: p.safeguarding_bank ?? null,
          safeguardingAccountRef: p.safeguarding_account_ref ?? null,
          licenceRef: p.licence_ref ?? null,
        }
      : { currency: c, programmeId: null };
  });
  const content = {
    day,
    generatedAt: now(),
    procedure: [
      'Stop every issuance and every payout; the operating state of the platform is set to halted.',
      'Take the holder list below as the register of claims, in minor units, per currency.',
      'Reconcile it against the designated safeguarding accounts named under "programmes".',
      'Redeem each claim at par, oldest claim first within a currency, recording the reference of every payment made.',
      'Where the safeguarded funds do not cover the claims, apply the shortfall proportionally and record the figure used.',
    ],
    totals,
    holderCount: holders.length,
    programmes,
    checks: checks.map((c) => ({
      currency: c.currency,
      liabilityMinor: c.liabilityMinor,
      safeguardedMinor: c.safeguardedMinor,
      shortfallMinor: c.shortfallMinor,
      internalOk: c.internalOk,
      status: c.status,
    })),
    holders: holders.map((h) => ({ userId: h.user_id, name: h.full_name, role: h.role, walletId: h.wallet_id, currency: h.currency, balanceMinor: h.balance })),
  };
  const prev = db.prepare('SELECT hash FROM network_resolution_packs ORDER BY day DESC LIMIT 1').get() as { hash: string } | undefined;
  const serialised = JSON.stringify(content);
  const hash = sha256(`${prev?.hash ?? ''}|${day}|${serialised}`);
  const existing = db.prepare('SELECT id FROM network_resolution_packs WHERE day = ?').get(day) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE network_resolution_packs SET hash = ?, prev_hash = ?, holder_count = ?, currencies = ?, totals = ?, content = ?, generated_by = ? WHERE id = ?').run(
      hash,
      prev?.hash ?? null,
      holders.length,
      JSON.stringify(currencies),
      JSON.stringify(totals),
      serialised,
      opts.actorId ?? null,
      existing.id,
    );
  } else {
    db.prepare(
      `INSERT INTO network_resolution_packs (id, day, hash, prev_hash, holder_count, currencies, totals, content, generated_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(uuid(), day, hash, prev?.hash ?? null, holders.length, JSON.stringify(currencies), JSON.stringify(totals), serialised, opts.actorId ?? null, now());
  }
  const pack = getResolutionPack(day);
  recordEvent('network', pack.id, 'network.resolution_pack.generated', { type: opts.actorId ? 'admin' : 'system', id: opts.actorId ?? null }, { day, holders: holders.length, hash });
  return pack;
}

function packRow(r: any): ResolutionPack {
  return {
    id: r.id,
    day: r.day,
    hash: r.hash,
    prevHash: r.prev_hash ?? null,
    holderCount: r.holder_count,
    currencies: JSON.parse(r.currencies || '[]'),
    totals: JSON.parse(r.totals || '{}'),
    generatedBy: r.generated_by ?? null,
    createdAt: r.created_at,
  };
}

export function getResolutionPack(day: string): ResolutionPack {
  const r = getDb().prepare('SELECT * FROM network_resolution_packs WHERE day = ?').get(day) as any;
  if (!r) throw notFound('No resolution pack for that day', 'resolution_pack_not_found');
  return packRow(r);
}

export function resolutionPackContent(day: string): Record<string, unknown> {
  const r = getDb().prepare('SELECT content FROM network_resolution_packs WHERE day = ?').get(day) as { content: string } | undefined;
  if (!r) throw notFound('No resolution pack for that day', 'resolution_pack_not_found');
  return JSON.parse(r.content);
}

export function listResolutionPacks(limit = 60): ResolutionPack[] {
  return (getDb().prepare('SELECT * FROM network_resolution_packs ORDER BY day DESC LIMIT ?').all(Math.min(limit, 365)) as any[]).map(packRow);
}

/** Verify the chain: every pack must hash to what its content and its predecessor say. */
export function verifyResolutionChain(): { ok: boolean; checked: number; broken: string[] } {
  const rows = getDb().prepare('SELECT day, hash, prev_hash, content FROM network_resolution_packs ORDER BY day ASC').all() as {
    day: string;
    hash: string;
    prev_hash: string | null;
    content: string;
  }[];
  const broken: string[] = [];
  let previous: string | null = null;
  for (const r of rows) {
    const expected = sha256(`${previous ?? ''}|${r.day}|${r.content}`);
    if (expected !== r.hash || (r.prev_hash ?? null) !== previous) broken.push(r.day);
    previous = r.hash;
  }
  return { ok: broken.length === 0, checked: rows.length, broken };
}

// ------------------------------------------------------------ monthly return

export interface MonthlyReturn {
  month: string;
  currency: string;
  daysChecked: number;
  daysShort: number;
  maxShortfallMinor: number;
  closingLiabilityMinor: number;
  closingSafeguardedMinor: number;
  averageLiabilityMinor: number;
  holderCount: number;
  redemptionsMinor: number;
  issuedMinor: number;
  internalMismatchDays: number;
  generatedAt: string;
}

/**
 * The monthly return, produced from the ledger and the daily checks — never from a spreadsheet. `month` is `YYYY-MM`.
 */
export function monthlyReturn(month: string, currency: string): MonthlyReturn {
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('A month is written YYYY-MM.', 'invalid_month');
  const code = currency.toUpperCase();
  const db = getDb();
  const checks = (db.prepare('SELECT * FROM network_safeguarding_checks WHERE currency = ? AND day LIKE ? ORDER BY day').all(code, `${month}-%`) as any[]).map(checkRow);
  const from = `${month}-01T00:00:00.000Z`;
  const to = `${month}-31T23:59:59.999Z`;
  const redemptions = (
    db.prepare("SELECT COALESCE(SUM(amount + fee), 0) s FROM transactions WHERE type = 'withdrawal' AND status = 'completed' AND currency = ? AND created_at BETWEEN ? AND ?").get(code, from, to) as {
      s: number;
    }
  ).s;
  const issued = (
    db.prepare("SELECT COALESCE(SUM(amount), 0) s FROM reserve_movements WHERE direction = 'in' AND status = 'cleared' AND currency = ? AND created_at BETWEEN ? AND ?").get(code, from, to) as {
      s: number;
    }
  ).s;
  const holders = (db.prepare('SELECT COUNT(*) n FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.is_system = 0 AND w.currency = ? AND w.balance <> 0').get(code) as { n: number }).n;
  const closing = checks[checks.length - 1];
  return {
    month,
    currency: code,
    daysChecked: checks.length,
    daysShort: checks.filter((c) => c.shortfallMinor > 0 && c.status !== 'remedied').length,
    maxShortfallMinor: checks.reduce((n, c) => Math.max(n, c.shortfallMinor), 0),
    closingLiabilityMinor: closing?.liabilityMinor ?? 0,
    closingSafeguardedMinor: closing?.safeguardedMinor ?? 0,
    averageLiabilityMinor: checks.length ? Math.round(checks.reduce((n, c) => n + c.liabilityMinor, 0) / checks.length) : 0,
    holderCount: holders,
    redemptionsMinor: redemptions,
    issuedMinor: issued,
    internalMismatchDays: checks.filter((c) => !c.internalOk).length,
    generatedAt: now(),
  };
}

/** The whole safeguarding picture for the console. */
export function safeguardingOverview(day = today()) {
  const checks = listChecks({ limit: 120 });
  const todays = checks.filter((c) => c.day === day);
  return {
    day,
    today: todays,
    history: checks,
    packs: listResolutionPacks(30),
    chain: verifyResolutionChain(),
    alerts: {
      shortfalls: todays.filter((c) => c.shortfallMinor > 0 && c.status !== 'remedied').length,
      internalMismatches: todays.filter((c) => !c.internalOk).length,
      remediesWaiting: todays.filter((c) => c.status === 'remedy_pending').length,
    },
  };
}
