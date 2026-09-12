/**
 * Liquidity and prefunding. A UK card receipt never "becomes" mobile money: the recipient is paid
 * from an existing local balance – a merchant SIM / bank account the platform has prefunded – and the
 * corridor is rebalanced later. Every payout account has its own ledger float wallet (a system user),
 * so prefunding and payouts are ordinary balanced ledger postings.
 */
import { getDb } from '../db';
import { uuid, now, shortCode } from '../lib/ids';
import { badRequest, notFound } from '../lib/errors';
import { getCurrency } from './currencies';
import { postTransaction } from './ledger';
import { createUser, findUserById, getSystemUser, toPublicUser, type UserRow } from './users';
import { ensureWallet, getWallet } from './wallets';
import { getOperator } from './momo';
import { recordEvent, type Actor } from './events';

export interface PayoutAccount {
  id: string;
  rail: 'mobile_money' | 'bank';
  operatorId: string | null;
  operatorName: string | null;
  country: string;
  currency: string;
  label: string;
  msisdn: string | null;
  simIccid: string | null;
  bankName: string | null;
  accountNumber: string | null;
  systemUserId: string;
  walletId: string;
  balance: number;
  agent: ReturnType<typeof toPublicUser> | null;
  deviceId: string | null;
  dailyLimit: number;
  perTxLimit: number;
  paidToday: number;
  status: 'active' | 'paused';
  createdAt: string;
  updatedAt: string;
}

function paidToday(accountId: string): number {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  return ((getDb().prepare("SELECT COALESCE(SUM(amount), 0) s FROM payout_instructions WHERE payout_account_id = ? AND stage = 'SETTLED' AND updated_at >= ?").get(accountId, since) as any).s as number) ?? 0;
}

function toAccount(r: any): PayoutAccount {
  const wallet = ensureWallet(r.system_user_id, r.currency);
  const agent = r.agent_user_id ? findUserById(r.agent_user_id) : null;
  let operatorName: string | null = null;
  if (r.operator_id) {
    try {
      operatorName = getOperator(r.operator_id).name;
    } catch {
      operatorName = r.operator_id;
    }
  }
  return { id: r.id, rail: r.rail, operatorId: r.operator_id, operatorName, country: r.country, currency: r.currency, label: r.label, msisdn: r.msisdn, simIccid: r.sim_iccid, bankName: r.bank_name, accountNumber: r.account_number, systemUserId: r.system_user_id, walletId: wallet.id, balance: wallet.balance, agent: agent ? toPublicUser(agent) : null, deviceId: r.device_id, dailyLimit: r.daily_limit, perTxLimit: r.per_tx_limit, paidToday: paidToday(r.id), status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function listPayoutAccounts(filter: { rail?: string | null; operatorId?: string | null; currency?: string | null; status?: string | null } = {}): PayoutAccount[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.rail) { where.push('rail = ?'); params.push(filter.rail); }
  if (filter.operatorId) { where.push('operator_id = ?'); params.push(filter.operatorId); }
  if (filter.currency) { where.push('currency = ?'); params.push(filter.currency); }
  if (filter.status) { where.push('status = ?'); params.push(filter.status); }
  return (getDb().prepare(`SELECT * FROM payout_accounts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY country, label`).all(...params) as any[]).map(toAccount);
}

export function getPayoutAccount(id: string): PayoutAccount {
  const r = getDb().prepare('SELECT * FROM payout_accounts WHERE id = ?').get(id);
  if (!r) throw notFound('Payout account not found', 'payout_account_not_found');
  return toAccount(r);
}

export function createPayoutAccount(input: { rail: 'mobile_money' | 'bank'; operatorId?: string | null; country: string; currency: string; label: string; msisdn?: string | null; simIccid?: string | null; bankName?: string | null; accountNumber?: string | null; agentUserId?: string | null; deviceId?: string | null; dailyLimit?: number; perTxLimit?: number }, actor: Actor): PayoutAccount {
  getCurrency(input.currency, false);
  if (input.rail === 'mobile_money') {
    if (!input.operatorId) throw badRequest('Mobile money payout accounts need an operator');
    const op = getOperator(input.operatorId);
    if (op.currency !== input.currency.toUpperCase()) throw badRequest(`${op.name} pays out in ${op.currency}`);
    if (!input.msisdn) throw badRequest('Enter the merchant SIM number (MSISDN) of the payout account');
  }
  if (input.agentUserId) {
    const agent = findUserById(input.agentUserId);
    if (!agent || agent.role !== 'agent') throw badRequest('agentUserId must be an agent');
    if (agent.kyc_status !== 'verified') throw badRequest('Agents must pass due diligence (KYC verified) before operating a payout account', 'agent_due_diligence');
  }
  const id = uuid();
  const sys = createUser({ fullName: `Payout float · ${input.label}`, tag: `payout_${shortCode(6).toLowerCase()}`, role: 'admin', isSystem: true, email: `payout_${id.slice(0, 8)}@system.local`, emailVerified: true });
  getDb().prepare("UPDATE users SET status = 'active', is_system = 1 WHERE id = ?").run(sys.id);
  ensureWallet(sys.id, input.currency.toUpperCase());
  getDb().prepare('INSERT INTO payout_accounts (id, rail, operator_id, country, currency, label, msisdn, sim_iccid, bank_name, account_number, system_user_id, agent_user_id, device_id, daily_limit, per_tx_limit, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, input.rail, input.operatorId ?? null, input.country.toUpperCase(), input.currency.toUpperCase(), input.label, input.msisdn ?? null, input.simIccid ?? null, input.bankName ?? null, input.accountNumber ?? null, sys.id, input.agentUserId ?? null, input.deviceId ?? null, input.dailyLimit ?? 0, input.perTxLimit ?? 0, 'active', now(), now());
  if (input.deviceId) getDb().prepare("UPDATE evidence_devices SET payout_account_id = ?, kind = 'payout' WHERE id = ?").run(id, input.deviceId);
  recordEvent('liquidity', id, 'payout_account.created', actor, { rail: input.rail, operatorId: input.operatorId ?? null, currency: input.currency, msisdn: input.msisdn ? `…${String(input.msisdn).slice(-4)}` : null });
  return getPayoutAccount(id);
}

export function updatePayoutAccount(id: string, patch: { label?: string; status?: 'active' | 'paused'; agentUserId?: string | null; deviceId?: string | null; dailyLimit?: number; perTxLimit?: number; msisdn?: string | null; simIccid?: string | null }, actor: Actor): PayoutAccount {
  const a = getPayoutAccount(id);
  getDb().prepare('UPDATE payout_accounts SET label = ?, status = ?, agent_user_id = ?, device_id = ?, daily_limit = ?, per_tx_limit = ?, msisdn = ?, sim_iccid = ?, updated_at = ? WHERE id = ?').run(patch.label ?? a.label, patch.status ?? a.status, patch.agentUserId === undefined ? a.agent?.id ?? null : patch.agentUserId, patch.deviceId === undefined ? a.deviceId : patch.deviceId, patch.dailyLimit ?? a.dailyLimit, patch.perTxLimit ?? a.perTxLimit, patch.msisdn === undefined ? a.msisdn : patch.msisdn, patch.simIccid === undefined ? a.simIccid : patch.simIccid, now(), id);
  if (patch.deviceId) getDb().prepare("UPDATE evidence_devices SET payout_account_id = ?, kind = 'payout' WHERE id = ?").run(id, patch.deviceId);
  recordEvent('liquidity', id, 'payout_account.updated', actor, patch as Record<string, unknown>);
  return getPayoutAccount(id);
}

/** Load money onto the local account (cash-in at the operator, bank transfer to the SIM / account). Recorded as treasury → float. */
export function prefundAccount(id: string, amount: number, input: { reference?: string | null; note?: string | null }, admin: UserRow): PayoutAccount {
  const a = getPayoutAccount(id);
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest('Amount must be greater than zero');
  const tx = postTransaction({ type: 'liquidity_prefund', amount, currency: a.currency, toWalletId: a.walletId, receiverUserId: a.systemUserId, senderUserId: getSystemUser('treasury').id, note: `Prefund ${a.label}${input.reference ? ` · ${input.reference}` : ''}`, metadata: { payoutAccountId: a.id, reference: input.reference ?? null, adminId: admin.id }, issuance: { authority: 'liquidity', adminId: admin.id, reference: input.reference ?? null } });
  getDb().prepare('INSERT INTO liquidity_movements (id, payout_account_id, kind, amount, currency, transaction_id, reference, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(uuid(), a.id, 'prefund', amount, a.currency, tx.id, input.reference ?? null, input.note ?? null, admin.id, now());
  recordEvent('liquidity', a.id, 'payout_account.prefunded', { type: 'admin', id: admin.id }, { amount, currency: a.currency, reference: input.reference ?? null, transactionId: tx.id });
  return getPayoutAccount(id);
}

/** Reconcile the ledger float with the real SIM / bank balance (signed delta). */
export function adjustAccount(id: string, delta: number, note: string, admin: UserRow): PayoutAccount {
  const a = getPayoutAccount(id);
  if (!Number.isInteger(delta) || delta === 0) throw badRequest('Delta must be a non-zero integer');
  const treasury = getSystemUser('treasury');
  const tx = delta > 0
    ? postTransaction({ type: 'liquidity_adjustment', amount: delta, currency: a.currency, toWalletId: a.walletId, receiverUserId: a.systemUserId, senderUserId: treasury.id, note, metadata: { payoutAccountId: a.id, adminId: admin.id }, issuance: { authority: 'liquidity', adminId: admin.id, reference: note } })
    : postTransaction({ type: 'liquidity_adjustment', amount: -delta, currency: a.currency, fromWalletId: a.walletId, toWalletId: null, senderUserId: a.systemUserId, receiverUserId: treasury.id, note, metadata: { payoutAccountId: a.id, adminId: admin.id }, allowNegativeSender: true });
  getDb().prepare('INSERT INTO liquidity_movements (id, payout_account_id, kind, amount, currency, transaction_id, reference, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(uuid(), a.id, 'adjustment', delta, a.currency, tx.id, null, note, admin.id, now());
  recordEvent('liquidity', a.id, 'payout_account.adjusted', { type: 'admin', id: admin.id }, { delta, note, transactionId: tx.id });
  return getPayoutAccount(id);
}

/** Record the float leaving the account when a payout is executed (float → external). */
export function debitFloatForPayout(account: PayoutAccount, amount: number, payoutId: string, reference: string, externalRef: string | null) {
  const wallet = getWallet(account.walletId);
  const tx = postTransaction({ type: 'payout', amount, currency: account.currency, fromWalletId: wallet.id, toWalletId: null, senderUserId: account.systemUserId, receiverUserId: getSystemUser('treasury').id, note: `Payout ${reference}${externalRef ? ` · ${externalRef}` : ''}`, metadata: { payoutId, payoutAccountId: account.id, externalRef }, allowNegativeSender: true });
  getDb().prepare('INSERT INTO liquidity_movements (id, payout_account_id, kind, amount, currency, transaction_id, reference, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(uuid(), account.id, 'payout', -amount, account.currency, tx.id, reference, externalRef, null, now());
  return tx;
}

export function listMovements(accountId: string) {
  return (getDb().prepare('SELECT * FROM liquidity_movements WHERE payout_account_id = ? ORDER BY created_at DESC LIMIT 200').all(accountId) as any[]).map((m) => ({ id: m.id, kind: m.kind, amount: m.amount, currency: m.currency, transactionId: m.transaction_id, reference: m.reference, note: m.note, createdBy: m.created_by, createdAt: m.created_at }));
}

/** Pick the account that can pay this now: active, right rail/operator/currency, enough float, within limits. Highest float first. */
export function selectPayoutAccount(q: { rail: 'mobile_money' | 'bank'; operatorId?: string | null; currency: string; amount: number; country?: string | null }): PayoutAccount | null {
  const candidates = listPayoutAccounts({ rail: q.rail, currency: q.currency, status: 'active' }).filter((a) => (q.rail === 'mobile_money' ? a.operatorId === q.operatorId : !q.country || a.country === q.country));
  const ok = candidates.filter((a) => a.balance >= q.amount && (a.perTxLimit === 0 || q.amount <= a.perTxLimit) && (a.dailyLimit === 0 || a.paidToday + q.amount <= a.dailyLimit));
  ok.sort((a, b) => b.balance - a.balance);
  return ok[0] ?? null;
}

/** Per-corridor liquidity picture: float, paid today, queued demand and shortfall. */
export function liquidityOverview() {
  const db = getDb();
  return listPayoutAccounts().map((a) => {
    const queued = (db.prepare("SELECT COALESCE(SUM(amount), 0) s FROM payout_instructions WHERE (payout_account_id = ? OR (payout_account_id IS NULL AND rail = ? AND operator_id IS ? AND currency = ?)) AND stage IN ('QUEUED', 'IN_PROGRESS', 'LIQUIDITY_UNAVAILABLE')").get(a.id, a.rail, a.operatorId, a.currency) as any).s as number;
    return { ...a, queuedDemand: queued, shortfall: Math.max(0, queued - a.balance) };
  });
}
