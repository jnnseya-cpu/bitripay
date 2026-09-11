import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import { validate, wrap, parsePagination } from '../../lib/http';
import { requireAdmin } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import { audit, listAuditLogs } from '../../services/audit';
import { createUser, findUserById, getUserById, toUser, updateUser, normalizeEmail, normalizePhone, type UserRow, toPublicUser } from '../../services/users';
import { hashPassword } from '../../lib/password';
import { listWallets, toWallet, ensureWallet } from '../../services/wallets';
import { listTransactions, getTransaction, toTransaction, postTransaction, refundTransaction } from '../../services/ledger';
import { approveWithdrawal, rejectWithdrawal } from '../../services/withdrawals';
import { listPayments, confirmManualPayment } from '../../services/payments';
import { listKyc, getKyc, reviewKyc } from '../../services/kyc';
import { settleRemittance, toRemittance } from '../../services/remittance';
import { getCurrency, listCurrencies, upsertCurrency, refreshRatesFromProvider } from '../../services/currencies';
import { getSetting, setSetting, getFees, getLimits, getReferralSettings, getAppSettings } from '../../services/settings';
import { getModules, DEFAULT_MODULES } from '../../services/modules';
import { listGateways, upsertGateway, deleteGateway, PROVIDERS } from '../../payments';
import { listBillers, upsertBiller, deleteBiller, listOperators, upsertOperator, deleteOperator, listGiftProducts, upsertGiftProduct, deleteGiftProduct } from '../../services/services';
import { getSiteSettings, updateSiteSettings, listPages, upsertPage, deletePage, listContactMessages, replyContactMessage, listSubscribers, sendNewsletter, listLanguages, upsertLanguage, deleteLanguage, getTranslationOverrides, setTranslationOverrides } from '../../services/cms';
import { listTickets, getTicket, replyTicket, setTicketStatus, chatConversations, chatHistory, sendChat } from '../../services/support';
import * as p2p from '../../services/p2p';
import { broadcast, notify } from '../../services/notifications';
import { runAutoSettlements, listSettlements } from '../../services/merchant';
import { getSmtpSettings, sendEmail, outbox } from '../../services/messaging';
import { toMinor, formatMoney } from '@bitripay/shared';
import { badRequest, notFound } from '../../lib/errors';
import { listPaymentRequests, toPaymentRequest, type PaymentRequestRow } from '../../services/paymentRequests';
import { usersById } from '../../services/users';
import { ADMIN_PERMISSIONS } from '../../middleware/permissions';

export const adminRouter = Router();
adminRouter.use(...requireAdmin);

// ---------------- Dashboard ----------------
adminRouter.get('/stats', requirePermission('reports'), (_req, res) => {
  const db = getDb();
  const dayAgo = new Date(Date.now() - 86400_000).toISOString();
  const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
  const users = db.prepare("SELECT role, COUNT(*) c FROM users WHERE is_system = 0 GROUP BY role").all() as any[];
  const newUsers = (db.prepare('SELECT COUNT(*) c FROM users WHERE is_system = 0 AND created_at >= ?').get(monthAgo) as any).c;
  const txByType = db.prepare("SELECT type, currency, COUNT(*) c, COALESCE(SUM(amount),0) volume, COALESCE(SUM(fee),0) fees FROM transactions WHERE status = 'completed' AND created_at >= ? GROUP BY type, currency").all(monthAgo);
  const today = db.prepare("SELECT currency, COUNT(*) c, COALESCE(SUM(amount),0) volume, COALESCE(SUM(fee),0) fees FROM transactions WHERE status = 'completed' AND created_at >= ? GROUP BY currency").all(dayAgo);
  const daily = db.prepare("SELECT substr(created_at,1,10) day, currency, COUNT(*) c, COALESCE(SUM(amount),0) volume, COALESCE(SUM(fee),0) fees FROM transactions WHERE status = 'completed' AND created_at >= ? GROUP BY day, currency ORDER BY day").all(monthAgo);
  const pending = {
    withdrawals: (db.prepare("SELECT COUNT(*) c FROM transactions WHERE type = 'withdrawal' AND status = 'pending'").get() as any).c,
    bankDeposits: (db.prepare("SELECT COUNT(*) c FROM gateway_payments WHERE method = 'bank' AND status IN ('pending','initiated')").get() as any).c,
    kyc: (db.prepare("SELECT COUNT(*) c FROM kyc_submissions WHERE status = 'pending'").get() as any).c,
    remittances: (db.prepare("SELECT COUNT(*) c FROM remittances WHERE status IN ('pending','processing')").get() as any).c,
    tickets: (db.prepare("SELECT COUNT(*) c FROM support_tickets WHERE status = 'open'").get() as any).c,
    disputes: (db.prepare("SELECT COUNT(*) c FROM p2p_trades WHERE status = 'disputed'").get() as any).c,
    chats: (db.prepare("SELECT COUNT(DISTINCT user_id) c FROM chat_messages WHERE is_admin = 0 AND read = 0").get() as any).c,
  };
  const balances = db.prepare('SELECT w.currency, COALESCE(SUM(w.balance),0) total FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.is_system = 0 GROUP BY w.currency').all();
  const revenue = db.prepare("SELECT w.currency, w.balance FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.tag = 'bitripay_fees'").all();
  const recent = listTransactions({ page: 1, pageSize: 10 });
  res.json({ users: Object.fromEntries(users.map((u) => [u.role, u.c])), newUsers30d: newUsers, txByType, today, daily, pending, balances, revenue, recent: recent.items });
});

// ---------------- Users / merchants / agents / admins ----------------
adminRouter.get('/users', requirePermission('users'), (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  const db = getDb();
  const where = ['is_system = 0'];
  const params: unknown[] = [];
  if (req.query.role) {
    where.push('role = ?');
    params.push(String(req.query.role));
  }
  if (req.query.status) {
    where.push('status = ?');
    params.push(String(req.query.status));
  }
  if (req.query.kyc) {
    where.push('kyc_status = ?');
    params.push(String(req.query.kyc));
  }
  if (req.query.search) {
    const s = `%${String(req.query.search)}%`;
    where.push('(full_name LIKE ? OR email LIKE ? OR phone LIKE ? OR tag LIKE ? OR business_name LIKE ?)');
    params.push(s, s, s, s, s);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = (db.prepare(`SELECT COUNT(*) c FROM users ${whereSql}`).get(...params) as any).c;
  const rows = db.prepare(`SELECT * FROM users ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as UserRow[];
  res.json({ items: rows.map((r) => ({ ...toUser(r), permissions: JSON.parse((r as any).permissions || '[]'), wallets: listWallets(r.id).map(toWallet), lastLoginAt: r.last_login_at })), total, page, pageSize });
});

adminRouter.post(
  '/users',
  requirePermission('admins'),
  wrap(async (req, res) => {
    const body = validate(z.object({ fullName: z.string().min(2), email: z.string().email().optional().nullable(), phone: z.string().optional().nullable(), password: z.string().min(8), role: z.enum(['user', 'merchant', 'agent', 'admin']).default('user'), permissions: z.array(z.string()).optional(), businessName: z.string().optional().nullable(), country: z.string().length(2).optional().nullable() }), req.body);
    const user = createUser({ ...body, emailVerified: true });
    if (body.role === 'admin') updateUser(user.id, { permissions: JSON.stringify(body.permissions ?? []) } as any);
    audit(req.user!.id, 'user.create', 'user', user.id, { role: body.role });
    res.status(201).json({ user: toUser(getUserById(user.id)) });
  }),
);

adminRouter.get('/users/:id', requirePermission('users'), (req, res) => {
  const user = getUserById(String(req.params.id));
  const tx = listTransactions({ userId: user.id, page: 1, pageSize: 20 });
  const kyc = getDb().prepare('SELECT * FROM kyc_submissions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(user.id) as any;
  const referrer = user.referred_by ? findUserById(user.referred_by) : null;
  res.json({
    user: { ...toUser(user), permissions: JSON.parse((user as any).permissions || '[]'), lastLoginAt: user.last_login_at, webhookUrl: user.webhook_url },
    wallets: listWallets(user.id).map(toWallet),
    transactions: tx.items,
    kyc: kyc ? { id: kyc.id, status: kyc.status, docType: kyc.doc_type, createdAt: kyc.created_at } : null,
    referrer: referrer ? toPublicUser(referrer) : null,
    bankAccounts: getDb().prepare('SELECT * FROM bank_accounts WHERE user_id = ?').all(user.id),
    apiKeys: getDb().prepare('SELECT id, label, prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? AND revoked_at IS NULL').all(user.id),
  });
});

adminRouter.patch(
  '/users/:id',
  requirePermission('users'),
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        fullName: z.string().min(2).optional(),
        email: z.string().email().optional().nullable(),
        phone: z.string().optional().nullable(),
        role: z.enum(['user', 'merchant', 'agent', 'admin']).optional(),
        status: z.enum(['active', 'suspended']).optional(),
        kycStatus: z.enum(['none', 'pending', 'verified', 'rejected']).optional(),
        country: z.string().length(2).optional().nullable(),
        businessName: z.string().optional().nullable(),
        agentCommissionBps: z.number().int().min(0).max(10000).optional().nullable(),
        permissions: z.array(z.string()).optional(),
        emailVerified: z.boolean().optional(),
        phoneVerified: z.boolean().optional(),
        twoFactorEnabled: z.literal(false).optional(),
        password: z.string().min(8).optional(),
      }),
      req.body,
    );
    const target = getUserById(String(req.params.id));
    if (target.id === req.user!.id && (body.status === 'suspended' || (body.role && body.role !== 'admin'))) throw badRequest('You cannot suspend or demote yourself');
    const fields: Record<string, unknown> = {};
    if (body.fullName) fields.full_name = body.fullName;
    if (body.email !== undefined) fields.email = normalizeEmail(body.email);
    if (body.phone !== undefined) fields.phone = normalizePhone(body.phone);
    if (body.role) fields.role = body.role;
    if (body.status) fields.status = body.status;
    if (body.kycStatus) fields.kyc_status = body.kycStatus;
    if (body.country !== undefined) fields.country = body.country?.toUpperCase() ?? null;
    if (body.businessName !== undefined) fields.business_name = body.businessName;
    if (body.agentCommissionBps !== undefined) fields.agent_commission_bps = body.agentCommissionBps;
    if (body.permissions) fields.permissions = JSON.stringify(body.permissions);
    if (body.emailVerified !== undefined) fields.email_verified = body.emailVerified ? 1 : 0;
    if (body.phoneVerified !== undefined) fields.phone_verified = body.phoneVerified ? 1 : 0;
    if (body.twoFactorEnabled === false) {
      fields.two_factor_enabled = 0;
      fields.two_factor_secret = null;
    }
    if (body.password) fields.password_hash = hashPassword(body.password);
    const updated = updateUser(target.id, fields as any);
    audit(req.user!.id, 'user.update', 'user', target.id, { ...body, password: body.password ? '***' : undefined });
    if (body.status === 'suspended') notify(target.id, 'Account suspended', 'Your account has been suspended. Contact support for help.', { kind: 'account' });
    res.json({ user: { ...toUser(updated), permissions: JSON.parse((updated as any).permissions || '[]') } });
  }),
);

adminRouter.post(
  '/users/:id/adjust',
  requirePermission('users'),
  wrap(async (req, res) => {
    const body = validate(z.object({ direction: z.enum(['credit', 'debit']), amount: z.string(), currency: z.string().length(3), reason: z.string().min(3).max(300) }), req.body);
    const target = getUserById(String(req.params.id));
    const cur = getCurrency(body.currency);
    const amount = toMinor(body.amount, cur.decimals);
    const wallet = ensureWallet(target.id, cur.code);
    const tx = postTransaction({
      type: 'admin_adjustment',
      amount,
      currency: cur.code,
      fromWalletId: body.direction === 'credit' ? null : wallet.id,
      toWalletId: body.direction === 'credit' ? wallet.id : null,
      senderUserId: body.direction === 'credit' ? null : target.id,
      receiverUserId: body.direction === 'credit' ? target.id : null,
      note: body.reason,
      metadata: { adminId: req.user!.id, direction: body.direction },
    });
    audit(req.user!.id, `balance.${body.direction}`, 'user', target.id, { amount, currency: cur.code, reason: body.reason, transactionId: tx.id });
    notify(target.id, body.direction === 'credit' ? 'Balance credited' : 'Balance debited', `${formatMoney(amount, cur)} was ${body.direction === 'credit' ? 'added to' : 'deducted from'} your wallet: ${body.reason}`, { kind: 'adjustment', transactionId: tx.id });
    res.status(201).json({ transaction: toTransaction(tx), wallet: toWallet(ensureWallet(target.id, cur.code)) });
  }),
);

adminRouter.get('/permissions', (_req, res) => res.json({ items: ADMIN_PERMISSIONS }));

// ---------------- Transactions ----------------
adminRouter.get('/transactions', requirePermission('transactions'), (req, res) => {
  const { page, pageSize } = parsePagination(req.query, 25);
  const q = req.query;
  const result = listTransactions({ userId: q.userId ? String(q.userId) : undefined, type: q.type ? String(q.type) : undefined, status: q.status ? String(q.status) : undefined, currency: q.currency ? String(q.currency) : undefined, search: q.search ? String(q.search) : undefined, from: q.from ? String(q.from) : undefined, to: q.to ? String(q.to) : undefined, page, pageSize });
  const users = usersById(result.items.flatMap((t) => [t.senderUserId!, t.receiverUserId!]));
  res.json({ ...result, items: result.items.map((t) => ({ ...t, sender: users.get(t.senderUserId!) ?? null, receiver: users.get(t.receiverUserId!) ?? null })), page, pageSize });
});
adminRouter.get('/transactions/:id', requirePermission('transactions'), (req, res) => {
  const tx = getTransaction(String(req.params.id));
  if (!tx) throw notFound('Transaction not found');
  const users = usersById([tx.sender_user_id!, tx.receiver_user_id!]);
  const entries = getDb().prepare('SELECT l.*, w.currency, w.user_id FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id WHERE transaction_id = ? ORDER BY l.created_at').all(tx.id);
  res.json({ transaction: toTransaction(tx), sender: users.get(tx.sender_user_id!) ?? null, receiver: users.get(tx.receiver_user_id!) ?? null, entries });
});
adminRouter.post(
  '/transactions/:id/refund',
  requirePermission('transactions'),
  wrap(async (req, res) => {
    const body = validate(z.object({ refundFee: z.boolean().optional(), note: z.string().optional() }), req.body);
    const tx = refundTransaction(String(req.params.id), body);
    audit(req.user!.id, 'transaction.refund', 'transaction', String(req.params.id), body);
    res.json({ transaction: toTransaction(tx) });
  }),
);
adminRouter.get('/payment-requests', requirePermission('transactions'), (req, res) => {
  const { page, pageSize } = parsePagination(req.query, 25);
  const db = getDb();
  const where = req.query.status ? 'WHERE status = ?' : '';
  const params = req.query.status ? [String(req.query.status)] : [];
  const total = (db.prepare(`SELECT COUNT(*) c FROM payment_requests ${where}`).get(...params) as any).c;
  const rows = db.prepare(`SELECT * FROM payment_requests ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as PaymentRequestRow[];
  res.json({ items: rows.map((r) => toPaymentRequest(r)), total, page, pageSize });
});

// ---------------- Approvals: withdrawals, bank deposits, remittances, KYC ----------------
adminRouter.get('/withdrawals', requirePermission('approvals'), (req, res) => {
  const { page, pageSize } = parsePagination(req.query, 25);
  const result = listTransactions({ type: 'withdrawal', status: req.query.status ? String(req.query.status) : undefined, page, pageSize });
  const users = usersById(result.items.map((t) => t.senderUserId!));
  res.json({ ...result, items: result.items.map((t) => ({ ...t, sender: users.get(t.senderUserId!) ?? null })), page, pageSize });
});
adminRouter.post('/withdrawals/:id/approve', requirePermission('approvals'), (req, res) => {
  const tx = approveWithdrawal(String(req.params.id), req.user!.id, req.body?.payoutReference);
  audit(req.user!.id, 'withdrawal.approve', 'transaction', tx.id);
  res.json({ transaction: toTransaction(tx) });
});
adminRouter.post('/withdrawals/:id/reject', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ reason: z.string().min(2).max(300) }), req.body);
  const tx = rejectWithdrawal(String(req.params.id), req.user!.id, body.reason);
  audit(req.user!.id, 'withdrawal.reject', 'transaction', tx.id, body);
  res.json({ transaction: toTransaction(tx) });
});
adminRouter.get('/payments', requirePermission('approvals'), (req, res) => {
  const { page, pageSize } = parsePagination(req.query, 25);
  const result = listPayments({ purpose: req.query.purpose ? String(req.query.purpose) : undefined, status: req.query.status ? String(req.query.status) : undefined, method: req.query.method ? String(req.query.method) : undefined, page, pageSize });
  const rows = getDb().prepare(`SELECT id, user_id, payer_email, payer_name, metadata FROM gateway_payments WHERE id IN (${result.items.map(() => '?').join(',') || "''"})`).all(...result.items.map((p) => p.id)) as any[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const users = usersById(rows.map((r) => r.user_id));
  res.json({ ...result, items: result.items.map((p) => ({ ...p, user: users.get(byId.get(p.id)?.user_id) ?? null, payerEmail: byId.get(p.id)?.payer_email, payerName: byId.get(p.id)?.payer_name, proof: JSON.parse(byId.get(p.id)?.metadata || '{}').proof ?? null })), page, pageSize });
});
adminRouter.post('/payments/:id/confirm', requirePermission('approvals'), (req, res) => {
  const payment = confirmManualPayment(String(req.params.id), 'succeeded');
  audit(req.user!.id, 'payment.confirm', 'payment', String(req.params.id));
  res.json({ payment });
});
adminRouter.post('/payments/:id/reject', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ reason: z.string().min(2).max(300) }), req.body);
  const payment = confirmManualPayment(String(req.params.id), 'failed', body.reason);
  audit(req.user!.id, 'payment.reject', 'payment', String(req.params.id), body);
  res.json({ payment });
});
adminRouter.get('/remittances', requirePermission('approvals'), (req, res) => {
  const where = req.query.status ? 'WHERE status = ?' : '';
  const rows = getDb().prepare(`SELECT * FROM remittances ${where} ORDER BY created_at DESC LIMIT 200`).all(...(req.query.status ? [String(req.query.status)] : []));
  res.json({ items: rows.map(toRemittance) });
});
adminRouter.post('/remittances/:id/settle', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ outcome: z.enum(['completed', 'rejected']), reason: z.string().optional() }), req.body);
  const r = settleRemittance(String(req.params.id), req.user!.id, body.outcome, body.reason);
  audit(req.user!.id, `remittance.${body.outcome}`, 'remittance', String(req.params.id), body);
  res.json({ remittance: r });
});
adminRouter.get('/kyc', requirePermission('kyc'), (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  res.json({ ...listKyc(req.query.status ? String(req.query.status) : undefined, page, pageSize), page, pageSize });
});
adminRouter.get('/kyc/:id', requirePermission('kyc'), (req, res) => res.json({ submission: getKyc(String(req.params.id)) }));
adminRouter.post('/kyc/:id/review', requirePermission('kyc'), (req, res) => {
  const body = validate(z.object({ decision: z.enum(['verified', 'rejected']), note: z.string().max(500).optional() }), req.body);
  const submission = reviewKyc(String(req.params.id), req.user!.id, body.decision, body.note);
  audit(req.user!.id, `kyc.${body.decision}`, 'kyc', String(req.params.id), body);
  res.json({ submission });
});
adminRouter.get('/settlements', requirePermission('approvals'), (_req, res) => res.json({ items: listSettlements() }));
adminRouter.post('/settlements/run', requirePermission('approvals'), (req, res) => {
  const result = runAutoSettlements();
  audit(req.user!.id, 'settlements.run', undefined, undefined, result);
  res.json(result);
});

// ---------------- Settings ----------------
adminRouter.get('/settings', requirePermission('settings'), (_req, res) => {
  const smtp = getSmtpSettings();
  res.json({
    fees: getFees(),
    limits: getLimits(),
    referral: getReferralSettings(),
    app: getAppSettings(),
    modules: getModules(),
    moduleKeys: Object.keys(DEFAULT_MODULES),
    countries: getSetting('countries', { mode: 'none', countries: [] }),
    smtp: { ...smtp, pass: smtp.pass ? '••••••••' : '' },
    sms: getSetting('sms', { provider: 'console' }),
    site: getSiteSettings(),
    languages: listLanguages(),
  });
});
adminRouter.put(
  '/settings/:key',
  requirePermission('settings'),
  wrap(async (req, res) => {
    const key = String(req.params.key);
    const allowed = ['fees', 'limits', 'referral', 'app', 'modules', 'countries', 'smtp', 'sms'];
    if (!allowed.includes(key)) throw badRequest('Unknown settings key');
    let value = req.body?.value ?? req.body;
    if (key === 'smtp' && value?.pass === '••••••••') value = { ...value, pass: getSmtpSettings().pass };
    if (key === 'fees') for (const [t, f] of Object.entries<any>(value)) if (typeof f?.bps !== 'number' || typeof f?.fixed !== 'number') throw badRequest(`Invalid fee config for ${t}`);
    setSetting(key, value);
    audit(req.user!.id, 'settings.update', 'settings', key, key === 'smtp' ? { host: value?.host } : value);
    res.json({ key, value: getSetting(key) });
  }),
);
adminRouter.put(
  '/site',
  requirePermission('cms'),
  wrap(async (req, res) => {
    const site = updateSiteSettings(req.body);
    audit(req.user!.id, 'site.update');
    res.json({ site });
  }),
);
adminRouter.post(
  '/settings/smtp/test',
  requirePermission('settings'),
  wrap(async (req, res) => {
    const body = validate(z.object({ to: z.string().email() }), req.body);
    res.json(await sendEmail(body.to, 'BitriPay SMTP test', 'If you can read this, SMTP is configured correctly.'));
  }),
);
adminRouter.get('/outbox', requirePermission('settings'), (_req, res) => res.json({ items: [...outbox].reverse() }));

// ---------------- Currencies & rates ----------------
adminRouter.get('/currencies', requirePermission('settings'), (_req, res) => res.json({ items: listCurrencies(false) }));
adminRouter.put(
  '/currencies/:code',
  requirePermission('settings'),
  wrap(async (req, res) => {
    const body = validate(z.object({ name: z.string().min(1), symbol: z.string().min(1).max(6), decimals: z.number().int().min(0).max(4), rateToBase: z.number().positive(), enabled: z.boolean(), sortOrder: z.number().int().optional() }), req.body);
    const cur = upsertCurrency({ code: String(req.params.code).toUpperCase(), ...body });
    audit(req.user!.id, 'currency.update', 'currency', cur.code, body);
    res.json({ currency: cur });
  }),
);
adminRouter.post(
  '/currencies/refresh',
  requirePermission('settings'),
  wrap(async (req, res) => {
    const result = await refreshRatesFromProvider(req.body?.provider);
    audit(req.user!.id, 'currency.refresh_rates', undefined, undefined, { provider: result.provider, updated: result.updated.length });
    res.json(result);
  }),
);

// ---------------- Gateways (payment aggregator) ----------------
adminRouter.get('/gateways', requirePermission('gateways'), (_req, res) =>
  res.json({ items: listGateways(), providers: Object.values(PROVIDERS).map((p) => ({ id: p.id, name: p.name, methods: p.supportedMethods, credentialFields: p.credentialFields })) }),
);
adminRouter.put(
  '/gateways/:id',
  requirePermission('gateways'),
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        name: z.string().min(1),
        provider: z.enum(['sandbox', 'stripe', 'paystack', 'flutterwave', 'mtn_momo', 'mpesa', 'manual_bank']),
        enabled: z.boolean(),
        methods: z.array(z.enum(['card', 'mobile_money', 'bank'])),
        currencies: z.array(z.string().length(3)),
        countries: z.array(z.string().length(2)).optional(),
        credentials: z.record(z.string()).optional(),
        config: z.record(z.unknown()).optional(),
        sortOrder: z.number().int().optional(),
      }),
      req.body,
    );
    const gateway = upsertGateway({ id: String(req.params.id).toLowerCase().replace(/[^a-z0-9_]/g, '_'), ...body });
    audit(req.user!.id, 'gateway.update', 'gateway', gateway.id, { enabled: body.enabled, methods: body.methods });
    res.json({ gateway });
  }),
);
adminRouter.delete('/gateways/:id', requirePermission('gateways'), (req, res) => {
  deleteGateway(String(req.params.id));
  audit(req.user!.id, 'gateway.delete', 'gateway', String(req.params.id));
  res.json({ ok: true });
});

// ---------------- Catalogs: billers, operators, gift cards ----------------
adminRouter.get('/billers', requirePermission('catalogs'), (_req, res) => res.json({ items: listBillers(false) }));
adminRouter.put('/billers/:id', requirePermission('catalogs'), (req, res) => {
  const body = validate(z.object({ category: z.string(), name: z.string(), country: z.string().length(2), currency: z.string().length(3), minAmount: z.number().int().min(0), maxAmount: z.number().int().min(0), feeBps: z.number().int().min(0), accountLabel: z.string().default('Account number'), enabled: z.boolean(), color: z.string().optional() }), req.body);
  res.json({ biller: upsertBiller({ id: String(req.params.id) === 'new' ? undefined : String(req.params.id), ...body }) });
});
adminRouter.delete('/billers/:id', requirePermission('catalogs'), (req, res) => {
  deleteBiller(String(req.params.id));
  res.json({ ok: true });
});
adminRouter.get('/operators', requirePermission('catalogs'), (_req, res) => res.json({ items: listOperators(false) }));
adminRouter.put('/operators/:id', requirePermission('catalogs'), (req, res) => {
  const body = validate(z.object({ name: z.string(), country: z.string().length(2), currency: z.string().length(3), minAmount: z.number().int().min(0), maxAmount: z.number().int().min(0), denominations: z.array(z.number().int().positive()), enabled: z.boolean(), color: z.string().optional() }), req.body);
  res.json({ operator: upsertOperator({ id: String(req.params.id) === 'new' ? undefined : String(req.params.id), ...body }) });
});
adminRouter.delete('/operators/:id', requirePermission('catalogs'), (req, res) => {
  deleteOperator(String(req.params.id));
  res.json({ ok: true });
});
adminRouter.get('/gift-products', requirePermission('catalogs'), (_req, res) => res.json({ items: listGiftProducts(false) }));
adminRouter.put('/gift-products/:id', requirePermission('catalogs'), (req, res) => {
  const body = validate(z.object({ brand: z.string(), name: z.string(), description: z.string().optional().nullable(), category: z.string().default('shopping'), currency: z.string().length(3), denominations: z.array(z.number().int().positive()), color: z.string().optional(), enabled: z.boolean() }), req.body);
  res.json({ product: upsertGiftProduct({ id: String(req.params.id) === 'new' ? undefined : String(req.params.id), ...body }) });
});
adminRouter.delete('/gift-products/:id', requirePermission('catalogs'), (req, res) => {
  deleteGiftProduct(String(req.params.id));
  res.json({ ok: true });
});

// ---------------- CMS: pages, languages, translations, contact, newsletter, notifications ----------------
adminRouter.get('/pages', requirePermission('cms'), (_req, res) => res.json({ items: listPages(false) }));
adminRouter.put('/pages/:slug', requirePermission('cms'), (req, res) => {
  const body = validate(z.object({ title: z.string().min(1), content: z.string(), published: z.boolean().default(true) }), req.body);
  res.json({ page: upsertPage({ slug: String(req.params.slug), ...body }) });
});
adminRouter.delete('/pages/:slug', requirePermission('cms'), (req, res) => {
  deletePage(String(req.params.slug));
  res.json({ ok: true });
});
adminRouter.get('/languages', requirePermission('cms'), (_req, res) => res.json({ items: listLanguages() }));
adminRouter.put('/languages/:code', requirePermission('cms'), (req, res) => {
  const body = validate(z.object({ name: z.string(), nativeName: z.string(), rtl: z.boolean().default(false), enabled: z.boolean().default(true) }), req.body);
  res.json({ items: upsertLanguage({ code: String(req.params.code).toLowerCase(), name: body.name, nativeName: body.nativeName, rtl: body.rtl ?? false, enabled: body.enabled ?? true }) });
});
adminRouter.delete('/languages/:code', requirePermission('cms'), (req, res) => {
  deleteLanguage(String(req.params.code));
  res.json({ ok: true });
});
adminRouter.get('/translations/:lang', requirePermission('cms'), (req, res) => res.json({ lang: String(req.params.lang), overrides: getTranslationOverrides(String(req.params.lang)) }));
adminRouter.put('/translations/:lang', requirePermission('cms'), (req, res) => {
  const body = validate(z.record(z.string()), req.body?.overrides ?? req.body);
  setTranslationOverrides(String(req.params.lang), body);
  res.json({ ok: true });
});
adminRouter.get('/contact-messages', requirePermission('cms'), (_req, res) => res.json({ items: listContactMessages() }));
adminRouter.post(
  '/contact-messages/:id/reply',
  requirePermission('cms'),
  wrap(async (req, res) => {
    const body = validate(z.object({ reply: z.string().min(1) }), req.body);
    await replyContactMessage(String(req.params.id), body.reply);
    res.json({ ok: true });
  }),
);
adminRouter.get('/newsletter/subscribers', requirePermission('cms'), (_req, res) => res.json({ items: listSubscribers() }));
adminRouter.post(
  '/newsletter/send',
  requirePermission('cms'),
  wrap(async (req, res) => {
    const body = validate(z.object({ subject: z.string().min(1), body: z.string().min(1), includeUsers: z.boolean().default(true) }), req.body);
    const result = await sendNewsletter(body.subject, body.body, body.includeUsers);
    audit(req.user!.id, 'newsletter.send', undefined, undefined, { subject: body.subject, sent: result.sent });
    res.json(result);
  }),
);
adminRouter.post('/notifications/broadcast', requirePermission('cms'), (req, res) => {
  const body = validate(z.object({ title: z.string().min(1).max(120), body: z.string().min(1).max(500), role: z.enum(['user', 'merchant', 'agent']).optional() }), req.body);
  const count = broadcast(body.title, body.body, body.role);
  audit(req.user!.id, 'notifications.broadcast', undefined, undefined, { ...body, count });
  res.json({ sent: count });
});

// ---------------- Support & live chat ----------------
adminRouter.get('/support/tickets', requirePermission('support'), (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  res.json({ ...listTickets(req.user!, { all: true, status: req.query.status ? String(req.query.status) : undefined, page, pageSize }), page, pageSize });
});
adminRouter.get('/support/tickets/:id', requirePermission('support'), (req, res) => res.json({ ticket: getTicket(String(req.params.id), req.user!) }));
adminRouter.post('/support/tickets/:id/reply', requirePermission('support'), (req, res) => {
  const body = validate(z.object({ body: z.string().min(1) }), req.body);
  res.json({ ticket: replyTicket(String(req.params.id), req.user!, body.body) });
});
adminRouter.post('/support/tickets/:id/status', requirePermission('support'), (req, res) => {
  const body = validate(z.object({ status: z.enum(['open', 'answered', 'closed']) }), req.body);
  res.json({ ticket: setTicketStatus(String(req.params.id), req.user!, body.status) });
});
adminRouter.get('/support/chats', requirePermission('support'), (_req, res) => res.json({ items: chatConversations() }));
adminRouter.get('/support/chats/:userId', requirePermission('support'), (req, res) => res.json({ items: chatHistory(String(req.params.userId), req.query.since ? String(req.query.since) : null, 'admin'), user: findUserById(String(req.params.userId)) ? toPublicUser(findUserById(String(req.params.userId))!) : null }));
adminRouter.post('/support/chats/:userId', requirePermission('support'), (req, res) => {
  const body = validate(z.object({ body: z.string().min(1) }), req.body);
  res.status(201).json({ message: sendChat(req.user!, body.body, String(req.params.userId)) });
});

// ---------------- P2P ----------------
adminRouter.get('/p2p/stats', requirePermission('p2p'), (_req, res) => res.json(p2p.marketplaceStats()));
adminRouter.get('/p2p/trades', requirePermission('p2p'), (req, res) => res.json({ items: p2p.listTrades(req.user!, { all: true, status: req.query.status ? String(req.query.status) : undefined }) }));
adminRouter.get('/p2p/trades/:id', requirePermission('p2p'), (req, res) => res.json({ trade: p2p.getTrade(req.user!, String(req.params.id)) }));
adminRouter.post('/p2p/trades/:id/resolve', requirePermission('p2p'), (req, res) => {
  const body = validate(z.object({ outcome: z.enum(['release', 'refund']), note: z.string().optional() }), req.body);
  const trade = p2p.resolveDispute(req.user!, String(req.params.id), body.outcome, body.note);
  audit(req.user!.id, `p2p.dispute.${body.outcome}`, 'p2p_trade', String(req.params.id), body);
  res.json({ trade });
});
adminRouter.get('/p2p/ads', requirePermission('p2p'), (_req, res) => res.json({ items: p2p.listAds({ includeInactive: true }) }));
adminRouter.post('/p2p/ads/:id/status', requirePermission('p2p'), (req, res) => {
  const body = validate(z.object({ status: z.enum(['active', 'paused', 'closed']) }), req.body);
  res.json({ ad: p2p.setAdStatus(req.user!, String(req.params.id), body.status) });
});

// ---------------- Reports & audit ----------------
adminRouter.get('/reports/transactions', requirePermission('reports'), (req, res) => {
  const db = getDb();
  const from = req.query.from ? String(req.query.from) : new Date(Date.now() - 30 * 86400_000).toISOString();
  const to = req.query.to ? String(req.query.to) : new Date().toISOString();
  const currency = req.query.currency ? String(req.query.currency).toUpperCase() : null;
  const params: unknown[] = [from, to];
  const curSql = currency ? 'AND currency = ?' : '';
  if (currency) params.push(currency);
  const byType = db.prepare(`SELECT type, status, currency, COUNT(*) c, COALESCE(SUM(amount),0) volume, COALESCE(SUM(fee),0) fees FROM transactions WHERE created_at BETWEEN ? AND ? ${curSql} GROUP BY type, status, currency ORDER BY volume DESC`).all(...params);
  const byDay = db.prepare(`SELECT substr(created_at,1,10) day, currency, COUNT(*) c, COALESCE(SUM(amount),0) volume, COALESCE(SUM(fee),0) fees FROM transactions WHERE status = 'completed' AND created_at BETWEEN ? AND ? ${curSql} GROUP BY day, currency ORDER BY day`).all(...params);
  const byCurrency = db.prepare(`SELECT currency, COUNT(*) c, COALESCE(SUM(amount),0) volume, COALESCE(SUM(fee),0) fees FROM transactions WHERE status = 'completed' AND created_at BETWEEN ? AND ? ${curSql} GROUP BY currency`).all(...params);
  const topMerchants = db.prepare(`SELECT receiver_user_id id, currency, COUNT(*) c, COALESCE(SUM(amount),0) volume FROM transactions WHERE type = 'merchant_payment' AND status = 'completed' AND created_at BETWEEN ? AND ? ${curSql} GROUP BY receiver_user_id, currency ORDER BY volume DESC LIMIT 10`).all(...params) as any[];
  const topAgents = db.prepare(`SELECT sender_user_id id, currency, COUNT(*) c, COALESCE(SUM(amount),0) volume FROM transactions WHERE type = 'agent_cash_in' AND status = 'completed' AND created_at BETWEEN ? AND ? ${curSql} GROUP BY sender_user_id, currency ORDER BY volume DESC LIMIT 10`).all(...params) as any[];
  const users = usersById([...topMerchants, ...topAgents].map((r) => r.id));
  if (req.query.format === 'csv') {
    const rows = db.prepare(`SELECT reference, type, status, amount, fee, currency, receive_amount, receive_currency, sender_user_id, receiver_user_id, note, created_at FROM transactions WHERE created_at BETWEEN ? AND ? ${curSql} ORDER BY created_at DESC LIMIT 50000`).all(...params) as any[];
    const header = 'reference,type,status,amount,fee,currency,receive_amount,receive_currency,sender_user_id,receiver_user_id,note,created_at';
    const csv = [header, ...rows.map((r) => [r.reference, r.type, r.status, r.amount, r.fee, r.currency, r.receive_amount ?? '', r.receive_currency ?? '', r.sender_user_id ?? '', r.receiver_user_id ?? '', JSON.stringify(r.note ?? ''), r.created_at].join(','))].join('\n');
    res.setHeader('Content-Disposition', `attachment; filename="transactions-${from.slice(0, 10)}-${to.slice(0, 10)}.csv"`);
    return res.type('text/csv').send(csv);
  }
  res.json({ from, to, currency, byType, byDay, byCurrency, topMerchants: topMerchants.map((r) => ({ ...r, user: users.get(r.id) })), topAgents: topAgents.map((r) => ({ ...r, user: users.get(r.id) })) });
});
adminRouter.get('/audit-logs', requirePermission('admins'), (req, res) => {
  const { page, pageSize } = parsePagination(req.query, 50);
  res.json({ ...listAuditLogs(page, pageSize, req.query.search ? String(req.query.search) : undefined), page, pageSize });
});
