/**
 * Bank-grade transaction statements for every account holder (users, merchants, agents).
 *
 * A statement is generated from the immutable ledger entries of one wallet for a period: opening balance, every
 * posting with its running balance, closing balance, holds, promotional credit movements, and a content hash that
 * is registered with a sequential statement number so any copy can be verified later (GET /api/statements/verify/:id).
 * Formats: JSON, CSV and PDF (rendered in-process, no third-party service sees the data).
 */
import { createHash } from 'node:crypto';
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { parseJson } from '../lib/json';
import { badRequest, notFound } from '../lib/errors';
import { getCurrency } from './currencies';
import { usersById, type UserRow } from './users';
import { getUserWallet } from './wallets';
import { classifyBalance } from './emoney';
import { config } from '../config';
import { PdfDocument } from '../lib/pdf';
import { formatMoney, TRANSACTION_TYPE_LABELS, countryName } from '@bitripay/shared';

export interface StatementLine {
  date: string;
  reference: string;
  type: string;
  typeLabel: string;
  description: string;
  counterparty: string | null;
  status: string;
  debit: number;
  credit: number;
  balance: number;
  transactionId: string;
}

export interface Statement {
  id: string;
  number: string;
  generatedAt: string;
  period: { from: string; to: string };
  holder: { id: string; name: string; tag: string; email: string | null; phone: string | null; country: string | null; role: string; businessName: string | null };
  account: { walletId: string; currency: string; currencyName: string; classification: string; iban: string };
  opening: number;
  closing: number;
  totalDebits: number;
  totalCredits: number;
  entryCount: number;
  lines: StatementLine[];
  promo: { opening: number; closing: number; movements: { date: string; description: string; amount: number }[] };
  hash: string;
  verifyUrl: string;
  issuer: string;
  disclaimer: string;
}

function dayStart(d: string) {
  return `${d.slice(0, 10)}T00:00:00.000Z`;
}
function dayEnd(d: string) {
  return `${d.slice(0, 10)}T23:59:59.999Z`;
}

/** Stable account identifier printed on statements (not a bank IBAN – a BitriPay account reference). */
function accountRef(walletId: string, currency: string) {
  return `BP-${currency}-${walletId.replace(/-/g, '').slice(0, 12).toUpperCase()}`;
}

export function buildStatement(user: UserRow, currency: string, from: string, to: string, generatedBy?: string | null): Statement {
  if (!/^\d{4}-\d{2}-\d{2}/.test(from) || !/^\d{4}-\d{2}-\d{2}/.test(to)) throw badRequest('Dates must be YYYY-MM-DD', 'validation_error');
  if (from.slice(0, 10) > to.slice(0, 10)) throw badRequest('The start date must be before the end date', 'validation_error');
  const cur = getCurrency(currency, false);
  const wallet = getUserWallet(user.id, cur.code, true);
  const db = getDb();
  const start = dayStart(from);
  const end = dayEnd(to);
  const before = db.prepare('SELECT balance_after FROM ledger_entries WHERE wallet_id = ? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(wallet.id, start) as
    { balance_after: number } | undefined;
  const opening = before?.balance_after ?? 0;
  const rows = db
    .prepare(
      `SELECT e.id, e.direction, e.amount, e.balance_after, e.created_at, t.id tx_id, t.reference, t.type, t.status, t.note, t.metadata, t.sender_user_id, t.receiver_user_id, t.currency tx_currency, t.receive_currency
       FROM ledger_entries e JOIN transactions t ON t.id = e.transaction_id
       WHERE e.wallet_id = ? AND e.created_at >= ? AND e.created_at <= ? ORDER BY e.created_at ASC, e.rowid ASC`,
    )
    .all(wallet.id, start, end) as any[];
  const names = usersById(rows.flatMap((r) => [r.sender_user_id, r.receiver_user_id]).filter(Boolean));
  const lines: StatementLine[] = rows.map((r) => {
    const outgoing = r.direction === 'debit';
    const otherId = outgoing ? r.receiver_user_id : r.sender_user_id;
    const other = otherId && otherId !== user.id ? names.get(otherId) : null;
    const meta = parseJson<any>(r.metadata, {});
    const label = (TRANSACTION_TYPE_LABELS as Record<string, string>)[r.type] ?? r.type;
    const parts = [label];
    if (r.note) parts.push(r.note);
    if (meta.payoutReference) parts.push(`ref ${meta.payoutReference}`);
    if (meta.externalRef) parts.push(`operator ref ${meta.externalRef}`);
    if (r.status === 'pending') parts.push('(held)');
    if (['rejected', 'cancelled', 'failed'].includes(r.status) && outgoing === false) parts.push('(returned)');
    return {
      date: r.created_at,
      reference: r.reference,
      type: r.type,
      typeLabel: label,
      description: parts.join(' · '),
      counterparty: other ? (other.businessName || other.fullName) + (other.tag ? ` (@${other.tag})` : '') : null,
      status: r.status,
      debit: outgoing ? r.amount : 0,
      credit: outgoing ? 0 : r.amount,
      balance: r.balance_after,
      transactionId: r.tx_id,
    };
  });
  const closing = lines.length ? lines[lines.length - 1].balance : opening;
  const promoRows = db.prepare('SELECT * FROM promo_credits WHERE wallet_id = ? ORDER BY created_at ASC').all(wallet.id) as any[];
  const promoMovements = promoRows
    .filter((p) => p.created_at >= start && p.created_at <= end)
    .map((p) => ({ date: p.created_at, description: `${p.programme.replace(/_/g, ' ')}: ${p.reason ?? ''}`.trim(), amount: p.amount }));
  const promoBefore = promoRows.filter((p) => p.created_at < start).reduce((s, p) => s + p.amount, 0);
  const promoClosing = wallet.promo_balance ?? 0;
  const id = uuid();
  const seq = ((db.prepare('SELECT COALESCE(MAX(number), 0) n FROM statements').get() as any).n as number) + 1;
  const number = `ST-${String(seq).padStart(8, '0')}`;
  const generatedAt = now();
  const canonical = JSON.stringify({
    number,
    userId: user.id,
    walletId: wallet.id,
    currency: cur.code,
    from: from.slice(0, 10),
    to: to.slice(0, 10),
    opening,
    closing,
    lines: lines.map((l) => [l.date, l.reference, l.debit, l.credit, l.balance]),
  });
  const hash = createHash('sha256').update(canonical).digest('hex');
  db.prepare(
    'INSERT INTO statements (id, number, user_id, currency, period_from, period_to, opening_balance, closing_balance, entry_count, hash, generated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, seq, user.id, cur.code, from.slice(0, 10), to.slice(0, 10), opening, closing, lines.length, hash, generatedBy ?? user.id, generatedAt);
  const classification = classifyBalance(user, cur.code);
  return {
    id,
    number,
    generatedAt,
    period: { from: from.slice(0, 10), to: to.slice(0, 10) },
    holder: { id: user.id, name: user.full_name, tag: user.tag, email: user.email, phone: user.phone, country: user.country, role: user.role, businessName: (user as any).business_name ?? null },
    account: { walletId: wallet.id, currency: cur.code, currencyName: cur.name, classification: classification.label, iban: accountRef(wallet.id, cur.code) },
    opening,
    closing,
    totalDebits: lines.reduce((s, l) => s + l.debit, 0),
    totalCredits: lines.reduce((s, l) => s + l.credit, 0),
    entryCount: lines.length,
    lines,
    promo: { opening: promoBefore, closing: promoClosing, movements: promoMovements },
    hash,
    verifyUrl: `${config.apiUrl}/api/statements/verify/${id}`,
    issuer: classification.issuer ?? config.appName,
    disclaimer:
      classification.class === 'sandbox'
        ? 'SANDBOX STATEMENT – balances shown have no real-world value.'
        : `Balances are ${classification.label.toLowerCase()} issued by ${classification.issuer ?? config.appName} and backed 1:1 by safeguarded funds. Promotional credit is not money and cannot be withdrawn.`,
  };
}

export function verifyStatement(id: string) {
  const r = getDb()
    .prepare('SELECT * FROM statements WHERE id = ? OR number = ?')
    .get(id, Number(String(id).replace(/^ST-/, '')) || -1) as any;
  if (!r) throw notFound('Statement not found', 'statement_not_found');
  return {
    id: r.id,
    number: `ST-${String(r.number).padStart(8, '0')}`,
    currency: r.currency,
    period: { from: r.period_from, to: r.period_to },
    opening: r.opening_balance,
    closing: r.closing_balance,
    entryCount: r.entry_count,
    hash: r.hash,
    generatedAt: r.created_at,
    holderRef: r.user_id.slice(0, 8),
  };
}

export function listStatements(userId: string, limit = 50) {
  return (getDb().prepare('SELECT * FROM statements WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit) as any[]).map((r) => ({
    id: r.id,
    number: `ST-${String(r.number).padStart(8, '0')}`,
    currency: r.currency,
    period: { from: r.period_from, to: r.period_to },
    opening: r.opening_balance,
    closing: r.closing_balance,
    entryCount: r.entry_count,
    hash: r.hash,
    generatedAt: r.created_at,
  }));
}

export function statementCsv(s: Statement): string {
  const cur = getCurrency(s.account.currency, false);
  const money = (n: number) => (n / 10 ** cur.decimals).toFixed(cur.decimals);
  const q = (v: string | null | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = [
    `# ${config.appName} statement ${s.number}`,
    `# Holder: ${s.holder.name} (@${s.holder.tag})`,
    `# Account: ${s.account.iban} ${s.account.currency}`,
    `# Period: ${s.period.from} to ${s.period.to}`,
    `# Opening balance: ${money(s.opening)}`,
    `# Closing balance: ${money(s.closing)}`,
    `# Hash: ${s.hash}`,
    `# Verify: ${s.verifyUrl}`,
  ];
  const rows = [['Date', 'Reference', 'Type', 'Description', 'Counterparty', 'Status', 'Debit', 'Credit', 'Balance'].join(',')];
  for (const l of s.lines)
    rows.push([l.date, l.reference, l.typeLabel, q(l.description), q(l.counterparty), l.status, l.debit ? money(l.debit) : '', l.credit ? money(l.credit) : '', money(l.balance)].join(','));
  return [...head, ...rows].join('\n') + '\n';
}

export function statementPdf(s: Statement): Buffer {
  const cur = getCurrency(s.account.currency, false);
  const money = (n: number) => formatMoney(n, cur);
  const doc = new PdfDocument({ title: `${config.appName} statement ${s.number}`, author: config.appName });
  doc.setFooter((p, t) => `${config.appName} · Statement ${s.number} · SHA-256 ${s.hash.slice(0, 32)}… · Verify at ${s.verifyUrl} · Page ${p} of ${t}`);
  doc.text(config.appName, { size: 20, bold: true });
  doc.text('Account statement', { size: 12, gray: 0.35 });
  doc.space(6);
  doc.rule();
  doc.pair('Statement number', s.number);
  doc.pair('Account holder', `${s.holder.businessName ? `${s.holder.businessName} · ` : ''}${s.holder.name} (@${s.holder.tag})`);
  doc.pair('Contact', [s.holder.email, s.holder.phone, s.holder.country ? countryName(s.holder.country) : null].filter(Boolean).join(' · ') || '—');
  doc.pair('Account', `${s.account.iban} · ${s.account.currency} (${s.account.currencyName})`);
  doc.pair('Balance type', s.account.classification);
  doc.pair('Period', `${s.period.from} to ${s.period.to}`);
  doc.pair('Generated', new Date(s.generatedAt).toUTCString());
  doc.space(4);
  doc.rule();
  doc.pair('Opening balance', money(s.opening));
  doc.pair('Total credits', money(s.totalCredits));
  doc.pair('Total debits', money(s.totalDebits));
  doc.pair('Closing balance', money(s.closing), { size: 11 });
  doc.space(10);
  doc.text(`Transactions (${s.entryCount})`, { size: 12, bold: true });
  doc.space(4);
  const columns = [
    { title: 'Date', width: 78 },
    { title: 'Reference', width: 70 },
    { title: 'Description', width: 185 },
    { title: 'Debit', width: 60, align: 'right' as const },
    { title: 'Credit', width: 60, align: 'right' as const },
    { title: 'Balance', width: 62, align: 'right' as const },
  ];
  const rows = s.lines.map((l) => [
    l.date.slice(0, 16).replace('T', ' '),
    l.reference,
    `${l.description}${l.counterparty ? ` · ${l.counterparty}` : ''}`,
    l.debit ? money(l.debit) : '',
    l.credit ? money(l.credit) : '',
    money(l.balance),
  ]);
  if (rows.length) doc.table(columns, rows, { zebra: true });
  else doc.text('No transactions in this period.', { gray: 0.4 });
  if (s.promo.movements.length || s.promo.closing) {
    doc.space(12);
    doc.text('Promotional credit (not money – covers BitriPay fees only, cannot be withdrawn)', { size: 11, bold: true });
    doc.space(4);
    doc.table(
      [
        { title: 'Date', width: 78 },
        { title: 'Programme', width: 315 },
        { title: 'Amount', width: 122, align: 'right' as const },
      ],
      s.promo.movements.map((m) => [m.date.slice(0, 10), m.description, money(m.amount)]),
      { zebra: true },
    );
    doc.pair('Promotional credit balance', money(s.promo.closing));
  }
  doc.space(12);
  doc.rule();
  doc.text(s.disclaimer, { size: 8, gray: 0.35 });
  doc.text(`Issuer: ${s.issuer}. This statement was generated from the immutable double-entry ledger; every line carries the ledger reference. Integrity hash (SHA-256): ${s.hash}`, {
    size: 8,
    gray: 0.35,
  });
  return doc.render();
}
