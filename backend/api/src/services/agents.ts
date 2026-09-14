import { getDb } from '../db';
import { uuid, now, shortCode } from '../lib/ids';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { applyBps, formatMoney } from '@bitripay/shared';
import { getCurrency } from './currencies';
import { calculateFee, enforceLimits, postTransaction, type TransactionRow } from './ledger';
import { ensureWallet, getUserWallet } from './wallets';
import { findUserByIdentifier, findUserById, toPublicUser, type UserRow } from './users';
import { notify } from './notifications';
import { onDepositCompleted } from './referrals';
import { getModules } from './modules';
import { recordCommission } from './finops/commissions';
import { dynamicCommissionBps, enforceAgentLimits } from './risk/agentIntel';

/** Base commission plus the trust-band bonus and the liquidity bonus where float is short (see risk/agentIntel). */
function agentCommissionBps(agent: UserRow, kind: 'cash_in' | 'cash_out' | 'other' = 'other') {
  return dynamicCommissionBps(agent, kind).bps;
}

export function listAgents(search?: string, country?: string | null) {
  const where = ["role = 'agent'", "status = 'active'"];
  const params: unknown[] = [];
  if (search) {
    where.push('(full_name LIKE ? OR tag LIKE ? OR business_name LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (country) {
    where.push('country = ?');
    params.push(country.toUpperCase());
  }
  return (
    getDb()
      .prepare(`SELECT * FROM users WHERE ${where.join(' AND ')} ORDER BY full_name LIMIT 100`)
      .all(...params) as UserRow[]
  ).map((r) => ({ ...toPublicUser(r), commissionBps: agentCommissionBps(r) }));
}

/** Agent gives cash to nobody – the customer hands cash to the agent; agent credits the customer from the agent float. */
export function agentCashIn(agent: UserRow, input: { customer: string; amount: number; currency: string; note?: string | null }): TransactionRow {
  if (!getModules().agents) throw unprocessable('Agent services are currently disabled', 'module_disabled');
  const customer = findUserByIdentifier(input.customer);
  if (!customer || customer.is_system) throw notFound('Customer not found', 'recipient_not_found');
  if (customer.id === agent.id) throw badRequest('You cannot cash in to yourself');
  const cur = getCurrency(input.currency);
  // §59: the agent's cash-operation ceilings scale with the trust band (on top of the customer's own limits).
  enforceAgentLimits(agent, input.amount, cur.code);
  const fee = calculateFee('agent_cash_in', input.amount, cur.code, null, { userId: agent.id });
  const commission = Math.min(fee, applyBps(input.amount, agentCommissionBps(agent, 'cash_in')));
  const agentWallet = getUserWallet(agent.id, cur.code);
  const customerWallet = ensureWallet(customer.id, cur.code);
  const tx = postTransaction({
    type: 'agent_cash_in',
    amount: input.amount,
    fee,
    currency: cur.code,
    fromWalletId: agentWallet.id,
    toWalletId: customerWallet.id,
    receiveAmount: input.amount - fee,
    feeFrom: 'receiver',
    senderUserId: agent.id,
    receiverUserId: customer.id,
    note: input.note ?? `Cash in via agent @${agent.tag}`,
    metadata: { agentId: agent.id, commission, method: 'agent' },
    feeSplits: [{ walletId: agentWallet.id, amount: commission }],
  });
  if (commission > 0)
    recordCommission({ agentUserId: agent.id, transactionId: tx.id, kind: 'cash_in', amountMinor: commission, currency: cur.code, metadata: { customerId: customer.id, amount: input.amount, fee } });
  notify(customer.id, 'Cash-in received', `${formatMoney(input.amount - fee, cur)} was added to your wallet by agent ${agent.business_name || agent.full_name}.`, {
    kind: 'agent_cash_in',
    transactionId: tx.id,
  });
  onDepositCompleted(customer.id);
  return tx;
}

/** Customer requests cash from an agent: funds are moved to the agent when the agent confirms handing over cash. */
export function createCashOutRequest(customer: UserRow, input: { agent: string; amount: number; currency: string }) {
  if (!getModules().agents) throw unprocessable('Agent services are currently disabled', 'module_disabled');
  const agent = findUserByIdentifier(input.agent);
  if (!agent || agent.role !== 'agent') throw notFound('Agent not found', 'agent_not_found');
  const cur = getCurrency(input.currency);
  const fee = calculateFee('agent_cash_out', input.amount, cur.code, null, { userId: agent.id });
  enforceLimits(customer, input.amount, cur.code);
  const wallet = getUserWallet(customer.id, cur.code);
  if (wallet.balance < input.amount + fee) throw unprocessable('Insufficient balance', 'insufficient_funds');
  const id = uuid();
  const code = shortCode(6);
  getDb()
    .prepare("INSERT INTO cash_requests (id, code, kind, user_id, agent_id, amount, currency, status, created_at, expires_at) VALUES (?, ?, 'cash_out', ?, ?, ?, ?, 'pending', ?, ?)")
    .run(id, code, customer.id, agent.id, input.amount, cur.code, now(), new Date(Date.now() + 30 * 60_000).toISOString());
  notify(agent.id, 'Cash-out request', `${customer.full_name} (@${customer.tag}) wants to cash out ${formatMoney(input.amount, cur)}. Code: ${code}`, { kind: 'cash_out_request', code });
  return { id, code, amount: input.amount, fee, currency: cur.code, agent: toPublicUser(agent), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
}

export function listCashRequests(user: UserRow) {
  const rows = getDb().prepare('SELECT * FROM cash_requests WHERE (user_id = ? OR agent_id = ?) ORDER BY created_at DESC LIMIT 50').all(user.id, user.id) as any[];
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    kind: r.kind,
    amount: r.amount,
    currency: r.currency,
    status: r.status === 'pending' && r.expires_at < now() ? 'expired' : r.status,
    customer: toPublicUser(findUserById(r.user_id)!),
    agent: r.agent_id ? toPublicUser(findUserById(r.agent_id)!) : null,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
}

/** Agent confirms a cash-out with the customer's code: wallet → agent float, commission to agent. */
export function confirmCashOut(agent: UserRow, code: string): TransactionRow {
  const db = getDb();
  return db.transaction(() => {
    const req = db.prepare("SELECT * FROM cash_requests WHERE code = ? AND kind = 'cash_out'").get(code.toUpperCase()) as any;
    if (!req) throw notFound('Cash-out request not found', 'request_not_found');
    if (req.agent_id !== agent.id) throw forbidden('This request was made to another agent');
    if (req.status !== 'pending') throw conflict(`Request is ${req.status}`);
    if (req.expires_at < now()) {
      db.prepare("UPDATE cash_requests SET status = 'expired' WHERE id = ?").run(req.id);
      throw conflict('Request has expired', 'request_expired');
    }
    const customer = findUserById(req.user_id)!;
    const cur = getCurrency(req.currency);
    enforceAgentLimits(agent, req.amount, cur.code);
    const fee = calculateFee('agent_cash_out', req.amount, cur.code, null, { userId: agent.id });
    const commission = Math.min(fee, applyBps(req.amount, agentCommissionBps(agent, 'cash_out')));
    const customerWallet = getUserWallet(customer.id, cur.code);
    const agentWallet = ensureWallet(agent.id, cur.code);
    const tx = postTransaction({
      type: 'agent_cash_out',
      amount: req.amount,
      fee,
      currency: cur.code,
      fromWalletId: customerWallet.id,
      toWalletId: agentWallet.id,
      senderUserId: customer.id,
      receiverUserId: agent.id,
      note: `Cash out via agent @${agent.tag}`,
      metadata: { agentId: agent.id, commission, cashRequestId: req.id, method: 'agent' },
      feeSplits: [{ walletId: agentWallet.id, amount: commission }],
    });
    db.prepare("UPDATE cash_requests SET status = 'completed', transaction_id = ? WHERE id = ?").run(tx.id, req.id);
    if (commission > 0)
      recordCommission({
        agentUserId: agent.id,
        transactionId: tx.id,
        kind: 'cash_out',
        amountMinor: commission,
        currency: cur.code,
        metadata: { customerId: customer.id, amount: req.amount, fee, cashRequestId: req.id },
      });
    notify(customer.id, 'Cash-out completed', `${formatMoney(req.amount, cur)} was paid out in cash by agent ${agent.business_name || agent.full_name}.`, {
      kind: 'agent_cash_out',
      transactionId: tx.id,
    });
    return tx;
  })();
}

export function cancelCashRequest(user: UserRow, code: string) {
  const db = getDb();
  const req = db.prepare('SELECT * FROM cash_requests WHERE code = ?').get(code.toUpperCase()) as any;
  if (!req) throw notFound('Request not found');
  if (req.user_id !== user.id && req.agent_id !== user.id) throw forbidden();
  if (req.status !== 'pending') throw conflict(`Request is ${req.status}`);
  db.prepare("UPDATE cash_requests SET status = 'cancelled' WHERE id = ?").run(req.id);
}

export function agentStats(agent: UserRow) {
  const db = getDb();
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const cashIn = db
    .prepare("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM transactions WHERE sender_user_id = ? AND type = 'agent_cash_in' AND status = 'completed' AND created_at >= ?")
    .get(agent.id, since) as any;
  const cashOut = db
    .prepare("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM transactions WHERE receiver_user_id = ? AND type = 'agent_cash_out' AND status = 'completed' AND created_at >= ?")
    .get(agent.id, since) as any;
  const pickups = db.prepare("SELECT COUNT(*) c FROM remittances WHERE pickup_agent_id = ? AND status = 'completed'").get(agent.id) as any;
  const commissionRows = db
    .prepare("SELECT metadata FROM transactions WHERE (sender_user_id = ? OR receiver_user_id = ?) AND type IN ('agent_cash_in','agent_cash_out') AND status = 'completed' AND created_at >= ?")
    .all(agent.id, agent.id, since) as any[];
  const commission = commissionRows.reduce((s, r) => s + (JSON.parse(r.metadata || '{}').commission || 0), 0);
  const pending = (db.prepare("SELECT COUNT(*) c FROM cash_requests WHERE agent_id = ? AND status = 'pending' AND expires_at > ?").get(agent.id, now()) as any).c;
  return {
    cashInCount: cashIn.c,
    cashInVolume: cashIn.s,
    cashOutCount: cashOut.c,
    cashOutVolume: cashOut.s,
    cashPickups: pickups.c,
    commissionEarned: commission,
    pendingRequests: pending,
    commissionBps: agentCommissionBps(agent),
  };
}
