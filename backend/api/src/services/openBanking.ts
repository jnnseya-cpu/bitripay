/**
 * Open banking (module 15): account linking under consent, transaction import, income verification, pay-by-bank
 * and variable recurring payment (VRP) mandates. Providers implement one contract; the sandbox bank ships complete
 * (institutions, hosted authorisation, accounts, six months of statements, payments, mandates) so every flow runs
 * end to end without credentials, and a statement import gives real bank data today without any provider.
 * A live provider is added by implementing the same contract with its credentials — nothing else changes.
 */
import { getDb } from '../db';
import { now, shortCode, uuid } from '../lib/ids';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { parseJson } from '../lib/json';
import { encrypt, decrypt } from '../lib/crypto';
import { config } from '../config';
import { getCurrency, toBase } from './currencies';
import { findUserById, type UserRow } from './users';
import { recordEvent, type Actor } from './events';
import { notify } from './notifications';
import { publish } from './bus';
import { parseCsv } from './bulkPayouts';
import { initiatePayment, verifyPayment } from './payments';
import { formatMoney, COUNTRIES } from '@bitripay/shared';

export interface LinkedAccount { id: string; name: string; type: 'current' | 'savings' | 'business'; masked: string; currency: string; balanceMinor: number }
export interface BankTransaction { externalId: string; bookedAt: string; amountMinor: number; currency: string; description: string; counterparty: string | null; category: string | null }
export interface Institution { id: string; name: string; country: string; currencies: string[]; features: ('accounts' | 'payments' | 'vrp')[] }
export interface OpenBankingProvider {
  id: string;
  name: string;
  /** Sandbox providers never touch a real bank; live providers need credentials before any call. */
  sandbox: boolean;
  institutions(country?: string | null): Institution[];
  /** Start authorisation: where to send the account holder and what to remember. */
  createLink(link: { id: string; userId: string; institutionId: string; redirectUrl: string }): { authUrl: string; providerRef: string };
  /** Exchange the callback for consent, accounts and the first statement. */
  completeLink(link: { id: string; providerRef: string | null; institutionId: string; userId: string }, callback: Record<string, unknown>): { approved: boolean; consentToken: string | null; consentExpiresAt: string | null; accounts: LinkedAccount[]; transactions: BankTransaction[] };
  /** Newer transactions since the last sync. */
  sync(link: { id: string; consentToken: string | null; accounts: LinkedAccount[] }, since: string | null): { accounts: LinkedAccount[]; transactions: BankTransaction[] };
  /** Single immediate payment from a linked account to the platform's collection account. */
  pay(link: { id: string; consentToken: string | null }, account: LinkedAccount, amountMinor: number, currency: string, reference: string): { status: 'succeeded' | 'pending' | 'failed'; providerRef: string; failureReason?: string };
  /** Register a VRP mandate; the provider returns its own reference. */
  createMandate(link: { id: string; consentToken: string | null }, account: LinkedAccount, limits: { maxPerPaymentMinor: number; maxPerMonthMinor: number; currency: string }): { providerRef: string };
}

// ---------------------------------------------------------------- sandbox bank
const SANDBOX_INSTITUTIONS: Institution[] = [
  { id: 'sbx-rawbank', name: 'Sandbox Rawbank', country: 'CD', currencies: ['CDF', 'USD'], features: ['accounts', 'payments', 'vrp'] },
  { id: 'sbx-equity', name: 'Sandbox Equity BCDC', country: 'CD', currencies: ['CDF', 'USD'], features: ['accounts', 'payments', 'vrp'] },
  { id: 'sbx-ukbank', name: 'Sandbox UK Bank', country: 'GB', currencies: ['GBP'], features: ['accounts', 'payments', 'vrp'] },
  { id: 'sbx-eubank', name: 'Sandbox Euro Bank', country: 'FR', currencies: ['EUR'], features: ['accounts', 'payments'] },
  { id: 'sbx-kcb', name: 'Sandbox KCB', country: 'KE', currencies: ['KES', 'USD'], features: ['accounts', 'payments', 'vrp'] },
  { id: 'sbx-gtb', name: 'Sandbox GTBank', country: 'NG', currencies: ['NGN'], features: ['accounts', 'payments'] },
];
function seeded(seed: string) {
  let h = 2166136261;
  for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return () => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return h / 2 ** 32; };
}
/** Six months of plausible statements: a monthly salary, rent, utilities, groceries and transport, deterministic per link. */
function sandboxStatement(linkId: string, account: LinkedAccount, from: Date, to: Date): BankTransaction[] {
  const rand = seeded(`${linkId}:${account.id}`);
  const unit = 10 ** getCurrency(account.currency, false).decimals;
  const scale = toBase(unit, account.currency) > 0 ? unit / Math.max(1, toBase(unit, account.currency) / 100) : unit; // ~ one base-currency unit
  const salary = Math.round((900 + rand() * 1200) * scale);
  const rent = Math.round((250 + rand() * 300) * scale);
  const out: BankTransaction[] = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (d <= to) {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const day = (dd: number) => new Date(Date.UTC(y, m, dd)).toISOString();
    const inRange = (iso: string) => iso >= from.toISOString() && iso <= to.toISOString();
    const push = (t: BankTransaction) => { if (inRange(t.bookedAt)) out.push(t); };
    push({ externalId: `${y}${String(m + 1).padStart(2, '0')}-sal`, bookedAt: day(25), amountMinor: salary + Math.round((rand() - 0.5) * 0.06 * salary), currency: account.currency, description: 'SALARY PAYROLL', counterparty: 'Employer Ltd', category: 'income' });
    push({ externalId: `${y}${String(m + 1).padStart(2, '0')}-rent`, bookedAt: day(2), amountMinor: -rent, currency: account.currency, description: 'RENT STANDING ORDER', counterparty: 'Landlord', category: 'housing' });
    push({ externalId: `${y}${String(m + 1).padStart(2, '0')}-util`, bookedAt: day(9), amountMinor: -Math.round((40 + rand() * 40) * scale), currency: account.currency, description: 'ELECTRICITY BILL', counterparty: 'Power Co', category: 'utilities' });
    for (let i = 0; i < 6; i += 1) push({ externalId: `${y}${String(m + 1).padStart(2, '0')}-g${i}`, bookedAt: day(3 + i * 4), amountMinor: -Math.round((8 + rand() * 40) * scale), currency: account.currency, description: i % 2 ? 'SUPERMARKET' : 'TRANSPORT', counterparty: null, category: i % 2 ? 'groceries' : 'transport' });
    d.setUTCMonth(m + 1);
  }
  return out.sort((a, b) => a.bookedAt.localeCompare(b.bookedAt));
}
const sandboxBank: OpenBankingProvider = {
  id: 'sandbox',
  name: 'Sandbox bank',
  sandbox: true,
  institutions(country) { return SANDBOX_INSTITUTIONS.filter((i) => !country || i.country === country.toUpperCase()); },
  createLink(link) { return { authUrl: `${config.apiUrl}/api/open-banking/sandbox/authorise/${link.id}`, providerRef: `sbxob_${shortCode(10)}` }; },
  completeLink(link, callback) {
    if (callback.decision === 'declined') return { approved: false, consentToken: null, consentExpiresAt: null, accounts: [], transactions: [] };
    const inst = SANDBOX_INSTITUTIONS.find((i) => i.id === link.institutionId)!;
    const rand = seeded(link.id);
    const accounts: LinkedAccount[] = inst.currencies.slice(0, 2).map((currency, i) => ({ id: `acc_${shortCode(8).toLowerCase()}`, name: i === 0 ? 'Current account' : 'Savings account', type: i === 0 ? 'current' : 'savings', masked: `••••${String(Math.floor(rand() * 9000) + 1000)}`, currency, balanceMinor: Math.round((300 + rand() * 2500) * 10 ** getCurrency(currency, false).decimals) }));
    const to = new Date();
    const from = new Date(Date.now() - 180 * 86_400_000);
    const transactions = accounts.flatMap((a) => sandboxStatement(link.id, a, from, to).map((t) => ({ ...t, externalId: `${a.id}:${t.externalId}` })));
    return { approved: true, consentToken: `sbx-consent-${shortCode(16)}`, consentExpiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(), accounts, transactions };
  },
  sync(link, since) {
    const to = new Date();
    const from = since ? new Date(Date.parse(since) + 1) : new Date(Date.now() - 180 * 86_400_000);
    return { accounts: link.accounts, transactions: link.accounts.flatMap((a) => sandboxStatement(link.id, a, from, to).map((t) => ({ ...t, externalId: `${a.id}:${t.externalId}` }))) };
  },
  pay(_link, account, amountMinor, currency) {
    if (account.currency !== currency) return { status: 'failed', providerRef: `sbxpay_${shortCode(10)}`, failureReason: `Account is in ${account.currency}` };
    if (account.balanceMinor < amountMinor) return { status: 'failed', providerRef: `sbxpay_${shortCode(10)}`, failureReason: 'Insufficient funds at the bank' };
    return { status: 'succeeded', providerRef: `sbxpay_${shortCode(10)}` };
  },
  createMandate() { return { providerRef: `sbxvrp_${shortCode(10)}` }; },
};
const PROVIDERS: Record<string, OpenBankingProvider> = { sandbox: sandboxBank };
export function listProviders() { return Object.values(PROVIDERS).map((p) => ({ id: p.id, name: p.name, sandbox: p.sandbox })).concat([{ id: 'statement_import', name: 'Statement import (CSV)', sandbox: false }]); }
export function listInstitutions(country?: string | null): (Institution & { provider: string })[] {
  return Object.values(PROVIDERS).flatMap((p) => p.institutions(country).map((i) => ({ ...i, provider: p.id })));
}
function providerFor(id: string): OpenBankingProvider {
  const p = PROVIDERS[id];
  if (!p) throw unprocessable(`Open banking provider "${id}" is not connected`, 'provider_unavailable');
  if (p.sandbox && config.isProduction && !config.isTest) throw unprocessable('The sandbox bank is not available in production', 'provider_unavailable');
  return p;
}

// ---------------------------------------------------------------- links
export interface LinkView { id: string; provider: string; institutionId: string; institutionName: string; country: string | null; status: 'PENDING' | 'LINKED' | 'DECLINED' | 'EXPIRED' | 'REVOKED'; authUrl: string | null; consentExpiresAt: string | null; accounts: LinkedAccount[]; lastSyncedAt: string | null; transactionCount: number; createdAt: string; linkedAt: string | null }
function linkView(r: any): LinkView {
  const count = (getDb().prepare('SELECT COUNT(*) c FROM open_banking_transactions WHERE link_id = ?').get(r.id) as any).c;
  return { id: r.id, provider: r.provider, institutionId: r.institution_id, institutionName: r.institution_name, country: r.country, status: r.status, authUrl: r.status === 'PENDING' && r.provider !== 'statement_import' ? PROVIDERS[r.provider]?.createLink({ id: r.id, userId: r.user_id, institutionId: r.institution_id, redirectUrl: '' }).authUrl ?? null : null, consentExpiresAt: r.consent_expires_at, accounts: parseJson(r.accounts, []), lastSyncedAt: r.last_synced_at, transactionCount: count, createdAt: r.created_at, linkedAt: r.linked_at };
}
function loadLink(userId: string, id: string): any {
  const r = getDb().prepare('SELECT * FROM open_banking_links WHERE id = ? AND user_id = ?').get(id, userId);
  if (!r) throw notFound('Linked bank not found', 'link_not_found');
  return r;
}
export function createLink(user: UserRow, input: { institutionId: string; redirectUrl?: string | null }): LinkView {
  const inst = listInstitutions().find((i) => i.id === input.institutionId);
  if (!inst) throw notFound('Unknown institution', 'institution_not_found');
  const provider = providerFor(inst.provider);
  const open = (getDb().prepare("SELECT COUNT(*) c FROM open_banking_links WHERE user_id = ? AND status = 'LINKED'").get(user.id) as any).c;
  if (open >= 10) throw conflict('You can link at most 10 bank accounts', 'too_many_links');
  const id = `obl_${shortCode(10).toLowerCase()}`;
  const started = provider.createLink({ id, userId: user.id, institutionId: inst.id, redirectUrl: input.redirectUrl ?? `${config.webUrl}/app/banks` });
  getDb().prepare('INSERT INTO open_banking_links (id, user_id, provider, institution_id, institution_name, country, status, provider_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, user.id, provider.id, inst.id, inst.name, inst.country, 'PENDING', started.providerRef, now());
  recordEvent('auth', user.id, 'open_banking.link_started', { type: 'user', id: user.id }, { linkId: id, institution: inst.id, provider: provider.id });
  return { ...linkView(getDb().prepare('SELECT * FROM open_banking_links WHERE id = ?').get(id)), authUrl: started.authUrl };
}
function storeTransactions(linkId: string, userId: string, rows: BankTransaction[], accountOf: (t: BankTransaction) => string): number {
  const db = getDb();
  const ins = db.prepare('INSERT OR IGNORE INTO open_banking_transactions (id, link_id, user_id, account_id, external_id, booked_at, amount_minor, currency, description, counterparty, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let n = 0;
  db.transaction(() => { for (const t of rows) n += ins.run(uuid(), linkId, userId, accountOf(t), t.externalId, t.bookedAt, t.amountMinor, t.currency, t.description, t.counterparty, t.category, now()).changes; })();
  return n;
}
/** The bank's callback (or the sandbox authorisation page) completes the link with accounts and the first statement. */
export function completeLink(userId: string, id: string, callback: Record<string, unknown>): LinkView {
  const db = getDb();
  const r = loadLink(userId, id);
  if (r.status !== 'PENDING') throw conflict(`This link is ${r.status.toLowerCase()}`, 'link_not_pending');
  const provider = providerFor(r.provider);
  const result = provider.completeLink({ id: r.id, providerRef: r.provider_ref, institutionId: r.institution_id, userId }, callback);
  if (!result.approved) {
    db.prepare("UPDATE open_banking_links SET status = 'DECLINED' WHERE id = ?").run(id);
    recordEvent('auth', userId, 'open_banking.link_declined', { type: 'user', id: userId }, { linkId: id });
    return linkView(db.prepare('SELECT * FROM open_banking_links WHERE id = ?').get(id));
  }
  db.prepare("UPDATE open_banking_links SET status = 'LINKED', consent_encrypted = ?, consent_expires_at = ?, accounts = ?, linked_at = ?, last_synced_at = ? WHERE id = ?").run(result.consentToken ? encrypt(result.consentToken) : null, result.consentExpiresAt, JSON.stringify(result.accounts), now(), now(), id);
  const imported = storeTransactions(id, userId, result.transactions, (t) => t.externalId.split(':')[0]);
  recordEvent('auth', userId, 'open_banking.linked', { type: 'user', id: userId }, { linkId: id, accounts: result.accounts.length, transactions: imported });
  notify(userId, `${r.institution_name} linked`, `${result.accounts.length} account(s) connected; ${imported} transactions imported. Income verification runs from your real statement.`, { kind: 'wallet', linkId: id });
  verifyIncome(userId);
  publish('open_banking.linked', { userId, linkId: id, institution: r.institution_id }, { aggregateId: id, tenantId: userId });
  return linkView(db.prepare('SELECT * FROM open_banking_links WHERE id = ?').get(id));
}
/** Real bank data without a provider: a CSV statement (date, description, amount[, currency][, counterparty]). */
export function importStatement(user: UserRow, input: { institutionName: string; currency: string; accountName?: string | null; csv: string }): LinkView & { imported: number; rejected: number } {
  const cur = getCurrency(input.currency);
  const recs = parseCsv(input.csv);
  if (!recs.length) throw badRequest('The statement has no rows (a header row with date, description and amount is required)', 'csv_empty');
  const id = `obl_${shortCode(10).toLowerCase()}`;
  const accountId = `acc_${shortCode(8).toLowerCase()}`;
  const rows: BankTransaction[] = [];
  let rejected = 0;
  for (const rec of recs) {
    const date = rec.date || rec.booked_at || rec.booking_date || '';
    const amountStr = (rec.amount ?? '').replace(/[^\d.,-]/g, '').replace(',', '.');
    const description = rec.description || rec.narrative || rec.details || '';
    const parsed = Date.parse(date);
    if (!description || Number.isNaN(parsed) || !/^-?\d+(\.\d+)?$/.test(amountStr)) { rejected += 1; continue; }
    const credit = rec.credit ? Number(rec.credit) : null;
    const debit = rec.debit ? Number(rec.debit) : null;
    const amount = credit != null || debit != null ? (credit ?? 0) - (debit ?? 0) : Number(amountStr);
    rows.push({ externalId: rec.id || rec.reference || `${date}:${description}:${amountStr}`, bookedAt: new Date(parsed).toISOString(), amountMinor: Math.round(amount * 10 ** cur.decimals), currency: (rec.currency || cur.code).toUpperCase(), description: description.trim().toUpperCase(), counterparty: rec.counterparty || null, category: rec.category || null });
  }
  if (!rows.length) throw badRequest('No usable rows: every row needs a date, a description and an amount', 'csv_invalid');
  const balance = rows.reduce((a, t) => a + t.amountMinor, 0);
  getDb().prepare('INSERT INTO open_banking_links (id, user_id, provider, institution_id, institution_name, country, status, accounts, created_at, linked_at, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, user.id, 'statement_import', 'statement', input.institutionName.trim(), user.country ?? null, 'LINKED', JSON.stringify([{ id: accountId, name: input.accountName ?? 'Imported statement', type: 'current', masked: '••••', currency: cur.code, balanceMinor: balance }]), now(), now(), now());
  const imported = storeTransactions(id, user.id, rows, () => accountId);
  recordEvent('auth', user.id, 'open_banking.statement_imported', { type: 'user', id: user.id }, { linkId: id, imported, rejected });
  verifyIncome(user.id);
  return { ...linkView(getDb().prepare('SELECT * FROM open_banking_links WHERE id = ?').get(id)), imported, rejected };
}
export function syncLink(userId: string, id: string): LinkView & { imported: number } {
  const r = loadLink(userId, id);
  if (r.status !== 'LINKED') throw conflict('Only a linked bank can be synced', 'link_not_linked');
  if (r.provider === 'statement_import') return { ...linkView(r), imported: 0 };
  if (r.consent_expires_at && r.consent_expires_at < now()) {
    getDb().prepare("UPDATE open_banking_links SET status = 'EXPIRED' WHERE id = ?").run(id);
    throw conflict('The bank consent has expired; link the account again', 'consent_expired');
  }
  const provider = providerFor(r.provider);
  const result = provider.sync({ id, consentToken: r.consent_encrypted ? decrypt(r.consent_encrypted) : null, accounts: parseJson(r.accounts, []) }, r.last_synced_at);
  const imported = storeTransactions(id, userId, result.transactions, (t) => t.externalId.split(':')[0]);
  getDb().prepare('UPDATE open_banking_links SET accounts = ?, last_synced_at = ? WHERE id = ?').run(JSON.stringify(result.accounts), now(), id);
  if (imported) verifyIncome(userId);
  return { ...linkView(getDb().prepare('SELECT * FROM open_banking_links WHERE id = ?').get(id)), imported };
}
export function revokeLink(user: UserRow, id: string, actor: Actor): LinkView {
  const r = loadLink(user.id, id);
  if (r.status === 'REVOKED') return linkView(r);
  const db = getDb();
  db.transaction(() => {
    db.prepare("UPDATE open_banking_links SET status = 'REVOKED', consent_encrypted = NULL, revoked_at = ? WHERE id = ?").run(now(), id);
    db.prepare("UPDATE open_banking_mandates SET status = 'REVOKED', revoked_at = ? WHERE link_id = ? AND status = 'ACTIVE'").run(now(), id);
  })();
  recordEvent('auth', user.id, 'open_banking.link_revoked', actor, { linkId: id });
  return linkView(db.prepare('SELECT * FROM open_banking_links WHERE id = ?').get(id));
}
export function listLinks(userId: string): LinkView[] { return (getDb().prepare("SELECT * FROM open_banking_links WHERE user_id = ? AND status != 'DECLINED' ORDER BY created_at DESC").all(userId) as any[]).map(linkView); }
export function listTransactions(userId: string, filter: { linkId?: string | null; accountId?: string | null; limit?: number } = {}) {
  const where = ['user_id = ?'];
  const params: unknown[] = [userId];
  if (filter.linkId) { where.push('link_id = ?'); params.push(filter.linkId); }
  if (filter.accountId) { where.push('account_id = ?'); params.push(filter.accountId); }
  return (getDb().prepare(`SELECT * FROM open_banking_transactions WHERE ${where.join(' AND ')} ORDER BY booked_at DESC LIMIT ?`).all(...params, Math.min(1000, filter.limit ?? 200)) as any[]).map((t) => ({ id: t.id, linkId: t.link_id, accountId: t.account_id, bookedAt: t.booked_at, amountMinor: t.amount_minor, currency: t.currency, description: t.description, counterparty: t.counterparty, category: t.category }));
}

// ---------------------------------------------------------------- income verification
export interface IncomeStream { label: string; currency: string; months: number; medianMinor: number; monthlyBaseMinor: number; lastAt: string; regular: boolean }
export interface IncomeReport { userId: string; monthlyIncomeBase: number; baseCurrency: string; monthsCovered: number; streams: IncomeStream[]; confidence: 'none' | 'low' | 'medium' | 'high'; computedAt: string }
const normalise = (s: string) => s.toUpperCase().replace(/\d+/g, '').replace(/[^A-Z ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ');
/** Recurring credits (three or more months, amounts within a quarter of the median) become verified income streams. */
export function verifyIncome(userId: string): IncomeReport {
  const db = getDb();
  const since = new Date(Date.now() - 190 * 86_400_000).toISOString();
  const credits = db.prepare("SELECT booked_at, amount_minor, currency, description, counterparty FROM open_banking_transactions t JOIN open_banking_links l ON l.id = t.link_id WHERE t.user_id = ? AND l.status = 'LINKED' AND t.amount_minor > 0 AND t.booked_at >= ? ORDER BY booked_at").all(userId, since) as any[];
  const groups = new Map<string, any[]>();
  for (const c of credits) {
    const key = `${c.currency}:${normalise(c.counterparty || c.description)}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const months = new Set(credits.map((c) => c.booked_at.slice(0, 7)));
  const streams: IncomeStream[] = [];
  for (const [key, rows] of groups) {
    const byMonth = new Map<string, number>();
    for (const r of rows) byMonth.set(r.booked_at.slice(0, 7), (byMonth.get(r.booked_at.slice(0, 7)) ?? 0) + r.amount_minor);
    if (byMonth.size < 3) continue;
    const amounts = [...byMonth.values()].sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    const regular = amounts.every((a) => Math.abs(a - median) <= median * 0.25);
    const currency = key.split(':')[0];
    streams.push({ label: key.split(':')[1] || 'CREDIT', currency, months: byMonth.size, medianMinor: median, monthlyBaseMinor: toBase(median, currency), lastAt: rows[rows.length - 1].booked_at, regular });
  }
  const verified = streams.filter((s) => s.regular);
  const monthly = verified.reduce((a, s) => a + s.monthlyBaseMinor, 0);
  const confidence: IncomeReport['confidence'] = !verified.length ? 'none' : months.size >= 6 && verified.some((s) => s.months >= 5) ? 'high' : months.size >= 4 ? 'medium' : 'low';
  const report: IncomeReport = { userId, monthlyIncomeBase: monthly, baseCurrency: getCurrency(getDb().prepare('SELECT code FROM currencies WHERE is_base = 1').pluck().get() as string, false).code, monthsCovered: months.size, streams, confidence, computedAt: now() };
  db.prepare('INSERT INTO open_banking_income (user_id, monthly_income_base, months_covered, streams, confidence, computed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET monthly_income_base = excluded.monthly_income_base, months_covered = excluded.months_covered, streams = excluded.streams, confidence = excluded.confidence, computed_at = excluded.computed_at').run(userId, monthly, months.size, JSON.stringify(streams), confidence, report.computedAt);
  if (verified.length) publish('open_banking.income_verified', { userId, monthlyIncomeBase: monthly, confidence }, { aggregateId: userId, tenantId: userId });
  return report;
}
export function getIncomeReport(userId: string): IncomeReport | null {
  const r = getDb().prepare('SELECT * FROM open_banking_income WHERE user_id = ?').get(userId) as any;
  if (!r) return null;
  return { userId, monthlyIncomeBase: r.monthly_income_base, baseCurrency: getCurrency(getDb().prepare('SELECT code FROM currencies WHERE is_base = 1').pluck().get() as string, false).code, monthsCovered: r.months_covered, streams: parseJson(r.streams, []), confidence: r.confidence, computedAt: r.computed_at };
}

// ---------------------------------------------------------------- pay by bank and VRP mandates
export interface MandateView { id: string; linkId: string; institutionName: string; accountId: string; currency: string; purpose: 'top_up' | 'billing'; maxPerPaymentMinor: number; maxPerMonthMinor: number; usedThisMonthMinor: number; status: 'ACTIVE' | 'REVOKED'; createdAt: string }
function mandateView(r: any): MandateView {
  const month = new Date().toISOString().slice(0, 7);
  const inst = (getDb().prepare('SELECT institution_name FROM open_banking_links WHERE id = ?').get(r.link_id) as any)?.institution_name ?? '';
  return { id: r.id, linkId: r.link_id, institutionName: inst, accountId: r.account_id, currency: r.currency, purpose: r.purpose, maxPerPaymentMinor: r.max_per_payment_minor, maxPerMonthMinor: r.max_per_month_minor, usedThisMonthMinor: r.used_month === month ? r.used_month_minor : 0, status: r.status, createdAt: r.created_at };
}
export function createMandate(user: UserRow, input: { linkId: string; accountId: string; purpose: 'top_up' | 'billing'; maxPerPaymentMinor: number; maxPerMonthMinor: number }, actor: Actor): MandateView {
  const r = loadLink(user.id, input.linkId);
  if (r.status !== 'LINKED') throw conflict('Link the bank before creating a mandate', 'link_not_linked');
  if (r.provider === 'statement_import') throw unprocessable('A statement import cannot make payments; link the bank through a provider', 'provider_unavailable');
  const account = (parseJson<LinkedAccount[]>(r.accounts, [])).find((a) => a.id === input.accountId);
  if (!account) throw notFound('Account not found on this link', 'account_not_found');
  const inst = listInstitutions().find((i) => i.id === r.institution_id);
  if (inst && !inst.features.includes('vrp')) throw unprocessable(`${r.institution_name} does not support recurring mandates`, 'vrp_unsupported');
  if (!Number.isInteger(input.maxPerPaymentMinor) || input.maxPerPaymentMinor <= 0 || !Number.isInteger(input.maxPerMonthMinor) || input.maxPerMonthMinor < input.maxPerPaymentMinor) throw badRequest('Set a per-payment limit and a monthly limit at least as large', 'invalid_limits');
  const provider = providerFor(r.provider);
  const ref = provider.createMandate({ id: r.id, consentToken: r.consent_encrypted ? decrypt(r.consent_encrypted) : null }, account, { maxPerPaymentMinor: input.maxPerPaymentMinor, maxPerMonthMinor: input.maxPerMonthMinor, currency: account.currency });
  const id = `vrp_${shortCode(10).toLowerCase()}`;
  getDb().prepare('INSERT INTO open_banking_mandates (id, user_id, link_id, account_id, currency, purpose, max_per_payment_minor, max_per_month_minor, status, provider_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, user.id, r.id, account.id, account.currency, input.purpose, input.maxPerPaymentMinor, input.maxPerMonthMinor, 'ACTIVE', ref.providerRef, now());
  recordEvent('auth', user.id, 'open_banking.mandate_created', actor, { mandateId: id, purpose: input.purpose, maxPerPayment: input.maxPerPaymentMinor, maxPerMonth: input.maxPerMonthMinor, currency: account.currency });
  return mandateView(getDb().prepare('SELECT * FROM open_banking_mandates WHERE id = ?').get(id));
}
export function listMandates(userId: string): MandateView[] { return (getDb().prepare('SELECT * FROM open_banking_mandates WHERE user_id = ? ORDER BY created_at DESC').all(userId) as any[]).map(mandateView); }
export function revokeMandate(user: UserRow, id: string, actor: Actor): MandateView {
  const res = getDb().prepare("UPDATE open_banking_mandates SET status = 'REVOKED', revoked_at = ? WHERE id = ? AND user_id = ? AND status = 'ACTIVE'").run(now(), id, user.id);
  if (!res.changes) throw notFound('Mandate not found or already revoked', 'mandate_not_found');
  recordEvent('auth', user.id, 'open_banking.mandate_revoked', actor, { mandateId: id });
  return mandateView(getDb().prepare('SELECT * FROM open_banking_mandates WHERE id = ?').get(id));
}
/** Execute a bank payment from a linked account (used by the pay-by-bank gateway adapter). */
export function executeBankPayment(input: { userId: string; linkId: string; accountId: string; amountMinor: number; currency: string; reference: string; mandateId?: string | null; gatewayPaymentId?: string | null; reason?: string | null }): { status: 'succeeded' | 'pending' | 'failed'; providerRef: string; failureReason?: string } {
  const db = getDb();
  const r = db.prepare('SELECT * FROM open_banking_links WHERE id = ? AND user_id = ?').get(input.linkId, input.userId) as any;
  if (!r || r.status !== 'LINKED') return { status: 'failed', providerRef: '', failureReason: 'Bank account is not linked' };
  const accounts = parseJson<LinkedAccount[]>(r.accounts, []);
  const account = accounts.find((a) => a.id === input.accountId);
  if (!account) return { status: 'failed', providerRef: '', failureReason: 'Account not found on this link' };
  if (input.mandateId) {
    const m = db.prepare('SELECT * FROM open_banking_mandates WHERE id = ? AND user_id = ? AND status = ?').get(input.mandateId, input.userId, 'ACTIVE') as any;
    if (!m) return { status: 'failed', providerRef: '', failureReason: 'Mandate is not active' };
    const month = new Date().toISOString().slice(0, 7);
    const used = m.used_month === month ? m.used_month_minor : 0;
    if (input.amountMinor > m.max_per_payment_minor) return { status: 'failed', providerRef: '', failureReason: 'Above the mandate per-payment limit' };
    if (used + input.amountMinor > m.max_per_month_minor) return { status: 'failed', providerRef: '', failureReason: 'Above the mandate monthly limit' };
  }
  const provider = providerFor(r.provider);
  const result = provider.pay({ id: r.id, consentToken: r.consent_encrypted ? decrypt(r.consent_encrypted) : null }, account, input.amountMinor, input.currency, input.reference);
  db.prepare('INSERT INTO open_banking_payments (id, user_id, link_id, account_id, mandate_id, gateway_payment_id, amount_minor, currency, status, provider_ref, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`obp_${shortCode(10).toLowerCase()}`, input.userId, r.id, account.id, input.mandateId ?? null, input.gatewayPaymentId ?? null, input.amountMinor, input.currency, result.status, result.providerRef, input.reason ?? result.failureReason ?? null, now());
  if (result.status === 'succeeded') {
    if (provider.sandbox) db.prepare('UPDATE open_banking_links SET accounts = ? WHERE id = ?').run(JSON.stringify(accounts.map((a) => (a.id === account.id ? { ...a, balanceMinor: a.balanceMinor - input.amountMinor } : a))), r.id);
    if (input.mandateId) {
      const month = new Date().toISOString().slice(0, 7);
      db.prepare('UPDATE open_banking_mandates SET used_month_minor = CASE WHEN used_month = ? THEN used_month_minor + ? ELSE ? END, used_month = ? WHERE id = ?').run(month, input.amountMinor, input.amountMinor, month, input.mandateId);
    }
  }
  return result;
}
/** The default account for pay-by-bank in a currency: the most recently linked account in that currency. */
export function defaultBankAccount(userId: string, currency: string): { linkId: string; account: LinkedAccount } | null {
  const links = getDb().prepare("SELECT * FROM open_banking_links WHERE user_id = ? AND status = 'LINKED' AND provider != 'statement_import' ORDER BY linked_at DESC").all(userId) as any[];
  for (const l of links) {
    const a = parseJson<LinkedAccount[]>(l.accounts, []).find((x) => x.currency === currency);
    if (a) return { linkId: l.id, account: a };
  }
  return null;
}
/**
 * Draw on a VRP mandate to top up the wallet: an ordinary pay-by-bank deposit through the payments pipeline (fees,
 * issuance authority and settlement all apply), authenticated by the mandate the account holder confirmed.
 */
export async function topUpFromMandate(userId: string, currency: string, amountMinor: number, purpose: 'top_up' | 'billing', reason: string): Promise<{ ok: boolean; paymentId: string | null; failureReason?: string }> {
  const m = getDb().prepare("SELECT * FROM open_banking_mandates WHERE user_id = ? AND currency = ? AND purpose = ? AND status = 'ACTIVE' ORDER BY created_at DESC").get(userId, currency, purpose) as any;
  if (!m) return { ok: false, paymentId: null, failureReason: 'no active mandate' };
  const user = findUserById(userId);
  if (!user) return { ok: false, paymentId: null, failureReason: 'account not found' };
  const gateway = getDb().prepare("SELECT id FROM gateways WHERE provider = 'open_banking' AND enabled = 1 LIMIT 1").get() as any;
  if (!gateway) return { ok: false, paymentId: null, failureReason: 'pay-by-bank gateway not enabled' };
  try {
    const payment = await initiatePayment(user, { purpose: 'deposit', method: 'bank', gateway: gateway.id, amount: amountMinor, currency, openBanking: { linkId: m.link_id, accountId: m.account_id, mandateId: m.id, reason } }, { mandateId: m.id });
    const final = payment.status === 'pending' ? await verifyPayment(payment.id) : payment;
    if (final.status !== 'succeeded') return { ok: false, paymentId: payment.id, failureReason: (final as any).failureReason ?? final.status };
    notify(userId, 'Topped up from your bank', `${formatMoney(amountMinor, getCurrency(currency))} came in from ${(getDb().prepare('SELECT institution_name FROM open_banking_links WHERE id = ?').get(m.link_id) as any)?.institution_name} under your mandate (${reason}).`, { kind: 'deposit', paymentId: payment.id });
    return { ok: true, paymentId: payment.id };
  } catch (err) {
    return { ok: false, paymentId: null, failureReason: (err as Error).message };
  }
}
export function openBankingOverview(user: UserRow) {
  return { providers: listProviders(), institutions: listInstitutions(user.country), links: listLinks(user.id), mandates: listMandates(user.id), income: getIncomeReport(user.id), countries: [...new Set(listInstitutions().map((i) => i.country))].map((c) => ({ code: c, name: COUNTRIES.find((x) => x.code === c)?.name ?? c })) };
}

/** Platform oversight: links, mandates and bank payments across accounts (never consent tokens). */
export function listAllLinksAdmin(filter: { limit?: number } = {}) {
  const db = getDb();
  const links = (db.prepare('SELECT l.id, l.user_id, l.provider, l.institution_name, l.country, l.status, l.consent_expires_at, l.last_synced_at, l.created_at, u.full_name, u.tag FROM open_banking_links l JOIN users u ON u.id = l.user_id ORDER BY l.created_at DESC LIMIT ?').all(Math.min(1000, filter.limit ?? 200)) as any[]).map((l) => ({ id: l.id, userId: l.user_id, user: { name: l.full_name, tag: l.tag }, provider: l.provider, institutionName: l.institution_name, country: l.country, status: l.status, consentExpiresAt: l.consent_expires_at, lastSyncedAt: l.last_synced_at, createdAt: l.created_at }));
  const mandates = (db.prepare("SELECT m.*, u.tag FROM open_banking_mandates m JOIN users u ON u.id = m.user_id ORDER BY m.created_at DESC LIMIT 200").all() as any[]).map((m) => ({ ...mandateView(m), userTag: m.tag }));
  const payments = (db.prepare('SELECT * FROM open_banking_payments ORDER BY created_at DESC LIMIT 200').all() as any[]).map((p) => ({ id: p.id, userId: p.user_id, linkId: p.link_id, mandateId: p.mandate_id, gatewayPaymentId: p.gateway_payment_id, amountMinor: p.amount_minor, currency: p.currency, status: p.status, reason: p.reason, createdAt: p.created_at }));
  const stats = { links: Object.fromEntries((db.prepare('SELECT status, COUNT(*) c FROM open_banking_links GROUP BY status').all() as any[]).map((r) => [r.status, r.c])), verifiedIncome: (db.prepare("SELECT COUNT(*) c FROM open_banking_income WHERE confidence != 'none'").get() as any).c };
  return { links, mandates, payments, stats };
}
