/**
 * Regulatory supervision: the normalised operations journal (every ledger transaction in one standard record shape,
 * parties pseudonymised, KYC tier and country attached, evidence references kept), exportable as CSV or JSON with an
 * integrity manifest (SHA-256 of the export and the result of the hash-chain verification of the event log), and the
 * real-time supervisory report (volumes, channels, KYC distribution, AML activity, e-money cover, liquidity, corridors,
 * Guardian state). Read-only; nothing here changes a balance.
 */
import { createHash, createHmac } from 'node:crypto';
import { getDb } from '../db';
import { config } from '../config';
import { parseJson } from '../lib/json';
import { verifyEventChain } from './events';
import { complianceOverview } from './risk/compliance';
import { listProgrammes } from './emoney';
import { liquidityOverview } from './liquidity';
import { listCorridors } from './corridors';
import { getOperatingState } from './guardian';
import { getComplianceSettings } from './settings';
import { listSanctions } from './risk';
import { TIER_LABELS } from './risk/kycTiers';

export interface JournalRecord {
  /** ISO 8601 UTC timestamps. */
  createdAt: string;
  completedAt: string | null;
  reference: string;
  type: string;
  status: string;
  /** Normalised channel: wallet, qr, card, bank_transfer, mobile_money, agent, remittance, fx, card_issuing, services, platform. */
  channel: string;
  operator: string | null;
  amount: number;
  currency: string;
  fee: number;
  receiveAmount: number | null;
  receiveCurrency: string | null;
  /** Pseudonymous party ids (HMAC of the account id under the platform secret): stable, re-identifiable by the platform on a lawful request. */
  payer: string | null;
  payerRole: string | null;
  payerKycTier: number | null;
  payerCountry: string | null;
  payee: string | null;
  payeeRole: string | null;
  payeeKycTier: number | null;
  payeeCountry: string | null;
  /** Operator / processor / evidence reference when the leg touched an external rail. */
  evidenceRef: string | null;
  idempotencyKey: string | null;
}

export const JOURNAL_COLUMNS: (keyof JournalRecord)[] = [
  'createdAt',
  'completedAt',
  'reference',
  'type',
  'status',
  'channel',
  'operator',
  'amount',
  'currency',
  'fee',
  'receiveAmount',
  'receiveCurrency',
  'payer',
  'payerRole',
  'payerKycTier',
  'payerCountry',
  'payee',
  'payeeRole',
  'payeeKycTier',
  'payeeCountry',
  'evidenceRef',
  'idempotencyKey',
];

export const pseudonym = (userId: string | null | undefined): string | null => (userId ? `P-${createHmac('sha256', config.appSecret).update(userId).digest('hex').slice(0, 16).toUpperCase()}` : null);

const CHANNEL_BY_TYPE: Record<string, string> = {
  transfer: 'wallet',
  qr_payment: 'qr',
  merchant_payment: 'qr',
  money_request: 'wallet',
  card_deposit: 'card',
  bank_deposit: 'bank_transfer',
  mobile_money_deposit: 'mobile_money',
  agent_cash_in: 'agent',
  agent_cash_out: 'agent',
  withdrawal: 'withdrawal',
  remittance: 'remittance',
  exchange: 'fx',
  virtual_card_funding: 'card_issuing',
  gift_card: 'services',
  bill_payment: 'services',
  mobile_topup: 'services',
  payout: 'payout',
  refund: 'refund',
};
function channelOf(type: string, meta: Record<string, unknown>): { channel: string; operator: string | null } {
  const method = typeof meta.method === 'string' ? meta.method : typeof meta.payoutMethod === 'string' ? meta.payoutMethod : null;
  const operator = typeof meta.operatorId === 'string' ? meta.operatorId : typeof meta.operator === 'string' ? meta.operator : null;
  if (type === 'withdrawal' || type === 'remittance' || type === 'payout') return { channel: method ? `${CHANNEL_BY_TYPE[type]}:${method}` : CHANNEL_BY_TYPE[type], operator };
  if (type === 'merchant_payment' && method) return { channel: method === 'qr' ? 'qr' : `checkout:${method}`, operator };
  return { channel: CHANNEL_BY_TYPE[type] ?? 'platform', operator };
}

export interface JournalFilter {
  from: string;
  to: string;
  currency?: string | null;
  type?: string | null;
  limit?: number;
}

export function supervisoryJournal(f: JournalFilter): JournalRecord[] {
  const db = getDb();
  const where = ['t.created_at BETWEEN ? AND ?'];
  const params: unknown[] = [f.from, f.to];
  if (f.currency) {
    where.push('t.currency = ?');
    params.push(f.currency.toUpperCase());
  }
  if (f.type) {
    where.push('t.type = ?');
    params.push(f.type);
  }
  const rows = db
    .prepare(
      `SELECT t.*, s.role s_role, s.kyc_tier s_tier, s.country s_country, r.role r_role, r.kyc_tier r_tier, r.country r_country
       FROM transactions t LEFT JOIN users s ON s.id = t.sender_user_id LEFT JOIN users r ON r.id = t.receiver_user_id
       WHERE ${where.join(' AND ')} ORDER BY t.created_at ASC, t.reference ASC LIMIT ?`,
    )
    .all(...params, Math.min(200_000, f.limit ?? 50_000)) as any[];
  return rows.map((t) => {
    const meta = parseJson<Record<string, unknown>>(t.metadata, {});
    const { channel, operator } = channelOf(t.type, meta);
    const evidence = [meta.providerRef, meta.reference, meta.operatorReference, meta.externalRef, meta.pickupCode].find((v) => typeof v === 'string' && v) as string | undefined;
    return {
      createdAt: t.created_at,
      completedAt: t.completed_at ?? null,
      reference: t.reference,
      type: t.type,
      status: t.status,
      channel,
      operator,
      amount: t.amount,
      currency: t.currency,
      fee: t.fee,
      receiveAmount: t.receive_amount ?? null,
      receiveCurrency: t.receive_currency ?? null,
      payer: pseudonym(t.sender_user_id),
      payerRole: t.s_role ?? null,
      payerKycTier: t.sender_user_id ? (t.s_tier ?? 0) : null,
      payerCountry: t.s_country ?? null,
      payee: pseudonym(t.receiver_user_id),
      payeeRole: t.r_role ?? null,
      payeeKycTier: t.receiver_user_id ? (t.r_tier ?? 0) : null,
      payeeCountry: t.r_country ?? null,
      evidenceRef: evidence ?? null,
      idempotencyKey: t.idempotency_key ?? null,
    };
  });
}

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function journalCsv(records: JournalRecord[]): string {
  return [JOURNAL_COLUMNS.join(','), ...records.map((r) => JOURNAL_COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\n');
}

export interface JournalManifest {
  format: 'csv' | 'json';
  from: string;
  to: string;
  records: number;
  sha256: string;
  columns: string[];
  eventChain: { ok: boolean; checked: number; brokenAt: number | null };
  complianceMode: string;
  generatedAt: string;
  platform: string;
  /** How party ids are formed, so the supervisor can read the file without the platform's help. */
  pseudonymisation: string;
}
export function journalExport(f: JournalFilter, format: 'csv' | 'json'): { body: string; manifest: JournalManifest } {
  const records = supervisoryJournal(f);
  const body = format === 'csv' ? journalCsv(records) : JSON.stringify(records);
  return {
    body,
    manifest: {
      format,
      from: f.from,
      to: f.to,
      records: records.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      columns: JOURNAL_COLUMNS,
      eventChain: verifyEventChain(),
      complianceMode: getComplianceSettings().mode,
      generatedAt: new Date().toISOString(),
      platform: `${config.appName} ${config.apiUrl}`,
      pseudonymisation: 'payer/payee = "P-" + first 16 hex characters of HMAC-SHA256(account id, platform secret); stable per account; re-identified by the platform on a lawful request',
    },
  };
}

/** Real-time supervisory report over a period (default: today UTC) plus the live control-room indicators. */
export function supervisoryReport(from?: string | null, to?: string | null) {
  const db = getDb();
  const start = from ?? `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  const end = to ?? new Date().toISOString();
  const byTypeStatus = db
    .prepare(
      'SELECT type, status, currency, COUNT(*) count, COALESCE(SUM(amount),0) volume, COALESCE(SUM(fee),0) fees FROM transactions WHERE created_at BETWEEN ? AND ? GROUP BY type, status, currency ORDER BY type, status, currency',
    )
    .all(start, end) as { type: string; status: string; currency: string; count: number; volume: number; fees: number }[];
  const completed = db
    .prepare("SELECT type, currency, COUNT(*) count, COALESCE(SUM(amount),0) volume FROM transactions WHERE status = 'completed' AND created_at BETWEEN ? AND ? GROUP BY type, currency")
    .all(start, end) as { type: string; currency: string; count: number; volume: number }[];
  const channels: Record<string, { count: number; volumeByCurrency: Record<string, number> }> = {};
  for (const r of completed) {
    const ch = CHANNEL_BY_TYPE[r.type] ?? 'platform';
    channels[ch] ??= { count: 0, volumeByCurrency: {} };
    channels[ch].count += r.count;
    channels[ch].volumeByCurrency[r.currency] = (channels[ch].volumeByCurrency[r.currency] ?? 0) + r.volume;
  }
  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
  const hourly = db
    .prepare(
      "SELECT substr(created_at,1,13) hour, COUNT(*) count, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) completed, SUM(CASE WHEN status IN ('failed','rejected') THEN 1 ELSE 0 END) failed FROM transactions WHERE created_at >= ? GROUP BY hour ORDER BY hour",
    )
    .all(since24h) as { hour: string; count: number; completed: number; failed: number }[];
  const failures = db.prepare("SELECT COUNT(*) c FROM transactions WHERE status IN ('failed','rejected','reversed') AND created_at BETWEEN ? AND ?").get(start, end) as { c: number };
  const total = db.prepare('SELECT COUNT(*) c FROM transactions WHERE created_at BETWEEN ? AND ?').get(start, end) as { c: number };

  const kyc = db.prepare('SELECT role, kyc_status, kyc_tier, COUNT(*) count FROM users WHERE is_system = 0 GROUP BY role, kyc_status, kyc_tier').all() as {
    role: string;
    kyc_status: string;
    kyc_tier: number;
    count: number;
  }[];
  const accounts = db.prepare('SELECT role, status, COUNT(*) count FROM users WHERE is_system = 0 GROUP BY role, status').all() as { role: string; status: string; count: number }[];
  const newAccounts = (db.prepare('SELECT COUNT(*) c FROM users WHERE is_system = 0 AND created_at BETWEEN ? AND ?').get(start, end) as { c: number }).c;

  const compliance = complianceOverview();
  const risk = db.prepare('SELECT action, COUNT(*) count FROM risk_events WHERE created_at BETWEEN ? AND ? GROUP BY action').all(start, end) as { action: string; count: number }[];
  const sanctionsEntries = listSanctions({ limit: 5000 }).length;

  const programmes = listProgrammes().map((p) => ({
    currency: p.currency,
    jurisdiction: p.jurisdiction,
    status: p.status,
    issuerModel: p.issuerModel,
    clearedReserves: p.position.clearedReserves,
    liabilities: p.position.liabilities,
    coverRatio: p.position.liabilities > 0 ? Math.round((p.position.clearedReserves / p.position.liabilities) * 10000) / 100 : null,
  }));
  const liquidity = liquidityOverview().map((a) => ({
    label: a.label,
    rail: a.rail,
    operatorId: a.operatorId,
    currency: a.currency,
    balance: a.balance,
    queuedDemand: a.queuedDemand,
    shortfall: a.shortfall,
    status: a.status,
  }));
  const corridors = listCorridors().map((c) => ({
    corridor: `${c.sourceCurrency}→${c.destCountry} ${c.destCurrency}${c.operatorId ? ` via ${c.operatorId}` : ''}`,
    status: c.status,
    ready: c.readiness.ready,
    licenceExpiresAt: c.licenceExpiresAt,
  }));
  const guardian = getOperatingState();
  const chain = verifyEventChain();

  return {
    generatedAt: new Date().toISOString(),
    period: { from: start, to: end },
    complianceMode: getComplianceSettings().mode,
    transactions: {
      total: total.c,
      failed: failures.c,
      exceptionRate: total.c ? Math.round((failures.c / total.c) * 10000) / 100 : 0,
      byTypeStatus,
      channels,
      hourly,
    },
    accounts: { byRoleStatus: accounts, newInPeriod: newAccounts, kyc: kyc.map((k) => ({ ...k, tierLabel: TIER_LABELS[k.kyc_tier] ?? String(k.kyc_tier) })) },
    aml: { openCases: compliance, riskEvents: risk, sanctionsEntries },
    emoney: programmes,
    liquidity,
    corridors,
    integrity: { eventChain: chain, guardian },
  };
}
