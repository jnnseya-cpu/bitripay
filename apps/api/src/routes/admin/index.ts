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
import { listTransactions, getTransaction, toTransaction, postTransaction, refundTransaction, emoneySupply } from '../../services/ledger';
import { listCorridors, upsertCorridor, setCorridorStatus, deleteCorridor } from '../../services/corridors';
import { listPayoutAccounts, createPayoutAccount, updatePayoutAccount, prefundAccount, adjustAccount, listMovements, liquidityOverview, getPayoutAccount } from '../../services/liquidity';
import { listPayouts, getPayout, getPayoutByTransaction, payoutCase, requeuePayout, requeueWaiting, releasePayout, cancelPayout } from '../../services/payouts';
import { listChargebacks, openChargeback, resolveChargeback } from '../../services/payments';
import { adminRouteView } from '../../services/routing';
import { listPayments, getPayment, toPaymentView } from '../../services/payments';
import { proposeVerification, approveVerification, declineVerification, listVerifications, verificationCase, assertAdminStepUp } from '../../services/verification';
import { listEvidence, ingestEvidence, listDevices, registerDevice, revokeDevice, listTemplates, upsertTemplate, deleteTemplate, parseEvidenceText } from '../../services/evidence';
import { listEvents, verifyEventChain } from '../../services/events';
import { addSanction, listSanctions, deleteSanction, listRiskEvents } from '../../services/risk';
import { reconcileLedger } from '../../services/ledger';
import { routeCatalog } from '../../services/railCatalog';
import { OPEN_STAGES, STAGE_LABELS } from '../../services/lifecycle';
import { listKyc, getKyc, reviewKyc } from '../../services/kyc';
import { settleRemittance, toRemittance } from '../../services/remittance';
import { getCurrency, listCurrencies, upsertCurrency, refreshRatesFromProvider, importRates, listRateSnapshots, getRateStatus, rateFreshness, RATE_PROVIDERS } from '../../services/currencies';
import { goLiveChecklist } from '../../services/goLive';
import { listPosts, getPost, createPost, updatePost, deletePost, renderPost } from '../../services/blog';
import { listLinkRules, upsertLinkRule, deleteLinkRule, listBacklinks, upsertBacklink, deleteBacklink, verifyBacklinks, pingIndexNow, pageviewSummary } from '../../services/seo';
import { agentStats, runtimeStatus, listRuns as listAgentRuns, getRun, cancelRun, startRun, listApprovals, decideApproval } from '../../services/assist/runtime';
import { listPolicies, publishPolicy, FORBIDDEN } from '../../services/assist/policy';
import { TOOLS } from '../../services/assist/tools';
import { getAgentDef } from '../../services/assist/registry';
import { config } from '../../config';
import { runGuardian, listGuardianChecks, getOperatingState, setOperatingMode } from '../../services/guardian';
import { countryCapabilities, listCountryCapabilities, setCountryCapabilities, PURPOSE_CODES } from '../../services/capabilities';
import { listIntents, intentTimeline } from '../../services/intents';
import { listRefunds, resolveRefund } from '../../services/gateway';
import { adminSwitchRouter } from './switch';
import { adminFinopsRouter } from './finops';
import { addonReport } from '../../services/assist/addon';
import { billingReport } from '../../services/assist/billing';
import { recentUssdSessions, ussdRequest, ussdSessionId } from '../../services/channels/ussd';
import { recentSms, smsHandle } from '../../services/channels/sms';
import { getChannelSettings } from '../../services/settings';
import { draftArticle, keywordIdeas, auditPost, socialPack, listRuns, agentStatus, outreachCandidates } from '../../services/seoAgent';
import { getSeoSettings, getAssistSettings } from '../../services/settings';
import { buildStatement, statementCsv, statementPdf, listStatements } from '../../services/statements';
import { emoneyOverview, listProgrammes, getProgramme, upsertProgramme, setProgrammeStatus, listReserveMovements, recordReserveMovement, reverseReserveMovement, listPools, getPool, createPool, allocate, reconcileReserves, listReconciliations, freezeWallet, listPromoCredits } from '../../services/emoney';
import { testGateway } from '../../payments';
import { encrypt } from '../../lib/crypto';
import { getSetting, setSetting, getFees, getLimits, getReferralSettings, getAppSettings, getGatewayControls, getFxSettings, getRiskSettings } from '../../services/settings';
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
import { listOperators as listMomo, upsertOperator as upsertMomo, deleteOperator as deleteMomo } from '../../services/momo';

/** The decided item, whatever it is: payment intent, payout instruction, withdrawal transaction or route. */
function verificationSubject(v: { subjectType: string; paymentId: string }) {
  try {
    switch (v.subjectType) {
      case 'payout':
        return { payout: getPayout(v.paymentId) };
      case 'withdrawal':
        return { transaction: toTransaction(getTransaction(v.paymentId)!), payout: getPayoutByTransaction(v.paymentId) };
      case 'route_release':
      case 'route_refund':
        return { route: adminRouteView(v.paymentId) };
      case 'issuance': {
        const u = getUserById(v.paymentId);
        return { user: toUser(u), wallets: listWallets(v.paymentId).map((w) => toWallet(w, u)), pool: u.tag?.startsWith('pool_') ? listPools().find((p) => p.walletUserId === u.id) ?? null : null };
      }
      case 'reserve_funding':
        return { movement: listReserveMovements(null, 500).find((m) => m.id === v.paymentId) ?? null };
      default:
        return { payment: toPaymentView(getPayment(v.paymentId)) };
    }
  } catch {
    return {};
  }
}

const complianceSchema = z.object({ regulator: z.string().max(200).optional().nullable(), licenceType: z.string().max(200).optional().nullable(), licenceNumber: z.string().max(200).optional().nullable(), safeguardingAccount: z.string().max(200).optional().nullable(), amlProgrammeRef: z.string().max(200).optional().nullable(), dataProtectionRef: z.string().max(200).optional().nullable(), fxApprovalRef: z.string().max(200).optional().nullable(), consumerDisclosureUrl: z.string().max(300).optional().nullable(), agentSupervisionRef: z.string().max(200).optional().nullable() });

export const adminRouter = Router();
adminRouter.use(...requireAdmin);
adminRouter.use('/switch', adminSwitchRouter);
adminRouter.use('/finops', adminFinopsRouter);

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
  res.json({ items: rows.map((r) => ({ ...toUser(r), permissions: JSON.parse((r as any).permissions || '[]'), wallets: listWallets(r.id).map((w) => toWallet(w)), lastLoginAt: r.last_login_at })), total, page, pageSize });
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
    wallets: listWallets(user.id).map((w) => toWallet(w, user)),
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

/**
 * E-money is created by administrators only, and never by one alone: a credit (or debit) is a PROPOSAL
 * that a different administrator with the issuance permission approves under step-up in the
 * verification console. Only then is the balance posted, with issuance authority 'admin'.
 */
adminRouter.post(
  '/users/:id/adjust',
  requirePermission('issuance'),
  wrap(async (req, res) => {
    const body = validate(z.object({ direction: z.enum(['credit', 'debit']), amount: z.string(), currency: z.string().length(3), reason: z.string().min(3).max(300) }), req.body);
    const target = getUserById(String(req.params.id));
    if (target.is_system) throw badRequest('System accounts cannot be adjusted');
    const cur = getCurrency(body.currency);
    const amount = toMinor(body.amount, cur.decimals);
    const verification = proposeVerification(req.user!, target.id, { subjectType: 'issuance', action: 'confirm', note: body.reason, payload: { direction: body.direction, amount, currency: cur.code, reason: body.reason } });
    audit(req.user!.id, `issuance.${body.direction}.proposed`, 'user', target.id, { amount, currency: cur.code, reason: body.reason, verificationId: verification.id });
    res.status(201).json({ verification, wallet: toWallet(ensureWallet(target.id, cur.code)) });
  }),
);
/** Outstanding e-money per currency, how it was issued, the reserve position of every programme and the immutable issuance register. */
adminRouter.get('/emoney', requirePermission('reports'), (req, res) => {
  const { page, pageSize } = parsePagination(req.query, 50);
  res.json({ supply: emoneySupply(), ...emoneyOverview(), register: listEvents({ stream: 'issuance', limit: pageSize, page }), pending: listVerifications({ status: 'proposed' }).filter((v) => v.subjectType === 'issuance' || v.subjectType === 'reserve_funding') });
});

// ---------------------------------------------------------------------------------------------
// E-money issuance engine (TREASURY_SUPER_ADMIN = 'treasury' permission)
// ---------------------------------------------------------------------------------------------
const programmeSchema = z.object({ currency: z.string().length(3), jurisdiction: z.string().min(2).max(10), issuerModel: z.enum(['own_authorisation', 'partner_issuer', 'sandbox']).optional(), issuerName: z.string().max(200).optional().nullable(), licenceRef: z.string().max(200).optional().nullable(), regulator: z.string().max(200).optional().nullable(), safeguardingBank: z.string().max(200).optional().nullable(), safeguardingAccountRef: z.string().max(200).optional().nullable(), reservedExposure: z.number().int().min(0).optional(), limits: z.object({ maxIssuancePerRequest: z.number().int().min(0).optional(), dailyIssuanceLimit: z.number().int().min(0).optional(), maxHolderBalance: z.number().int().min(0).optional() }).optional() });
adminRouter.get('/emoney/programmes', requirePermission('reports'), (_req, res) => res.json({ items: listProgrammes() }));
adminRouter.put('/emoney/programmes/:id', requirePermission('treasury'), (req, res) => {
  const body = validate(programmeSchema, req.body);
  const programme = upsertProgramme({ id: String(req.params.id) === 'new' ? undefined : String(req.params.id), ...body }, req.user!);
  audit(req.user!.id, 'emoney.programme.upsert', 'programme', programme.id, { currency: programme.currency, jurisdiction: programme.jurisdiction, issuerModel: programme.issuerModel });
  res.json({ programme });
});
/** Going live / suspending a programme is an attributable, step-up protected act. */
adminRouter.post('/emoney/programmes/:id/status', requirePermission('treasury'), (req, res) => {
  const body = validate(z.object({ status: z.enum(['sandbox', 'live', 'suspended']), reason: z.string().max(300).optional().nullable(), pin: z.string().optional() }), req.body);
  assertAdminStepUp(req.user!, body.pin, req);
  const programme = setProgrammeStatus(String(req.params.id), body.status, req.user!, body.reason);
  audit(req.user!.id, `emoney.programme.${body.status}`, 'programme', programme.id, { reason: body.reason ?? null });
  res.json({ programme });
});
adminRouter.get('/emoney/programmes/:id', requirePermission('reports'), (req, res) => {
  const programme = getProgramme(String(req.params.id));
  res.json({ programme, movements: listReserveMovements(programme.id), pools: listPools({ programmeId: programme.id }), reconciliations: listReconciliations(programme.id) });
});
/**
 * Reserve funding confirmed: the treasury administrator records cleared safeguarded funds (bank reference + statement
 * evidence); a different treasury administrator must confirm before the funds count towards issuance.
 */
adminRouter.post('/emoney/programmes/:id/reserves', requirePermission('treasury'), (req, res) => {
  const body = validate(z.object({ kind: z.enum(['funding', 'adjustment', 'redemption']).default('funding'), direction: z.enum(['in', 'out']).default('in'), amount: z.string(), reference: z.string().min(2).max(200), evidence: z.record(z.string(), z.unknown()).optional().nullable(), note: z.string().min(8).max(500) }), req.body);
  const programme = getProgramme(String(req.params.id));
  const cur = getCurrency(programme.currency);
  const amount = toMinor(body.amount, cur.decimals);
  const movement = recordReserveMovement({ programmeId: programme.id, kind: body.kind, direction: body.direction, amount, status: 'pending', reference: body.reference, evidence: body.evidence ?? null, proposedBy: req.user!.id, note: body.note }, { type: 'admin', id: req.user!.id });
  const verification = proposeVerification(req.user!, movement.id, { subjectType: 'reserve_funding', action: 'confirm', note: body.note, externalRef: body.reference, payload: { programmeId: programme.id, kind: body.kind, direction: body.direction, amount, currency: programme.currency } });
  audit(req.user!.id, 'emoney.reserve.proposed', 'programme', programme.id, { movementId: movement.id, amount, direction: body.direction, reference: body.reference, verificationId: verification.id });
  res.status(201).json({ movement, verification, programme: getProgramme(programme.id) });
});
adminRouter.post('/emoney/reserves/:id/reverse', requirePermission('treasury'), (req, res) => {
  const body = validate(z.object({ reason: z.string().min(4).max(300), pin: z.string().optional() }), req.body);
  assertAdminStepUp(req.user!, body.pin, req);
  const movement = reverseReserveMovement(String(req.params.id), req.user!, body.reason);
  audit(req.user!.id, 'emoney.reserve.reversed', 'programme', movement.programmeId, { movementId: movement.id, reason: body.reason });
  res.json({ movement });
});
/** Issuance request against a distribution pool (maker → independent checker → mint). */
adminRouter.post('/emoney/issue', requirePermission('issuance'), (req, res) => {
  const body = validate(z.object({ programmeId: z.string(), poolId: z.string(), direction: z.enum(['credit', 'debit']).default('credit'), amount: z.string(), reason: z.string().min(3).max(300) }), req.body);
  const programme = getProgramme(body.programmeId);
  const pool = getPool(body.poolId);
  const cur = getCurrency(programme.currency);
  const amount = toMinor(body.amount, cur.decimals);
  const verification = proposeVerification(req.user!, pool.walletUserId, { subjectType: 'issuance', action: 'confirm', note: body.reason, payload: { direction: body.direction, amount, currency: cur.code, reason: body.reason, poolId: pool.id, programmeId: programme.id } });
  audit(req.user!.id, `issuance.${body.direction}.proposed`, 'pool', pool.id, { amount, currency: cur.code, reason: body.reason, verificationId: verification.id });
  res.status(201).json({ verification, pool: getPool(pool.id), position: programme.position });
});
adminRouter.get('/emoney/pools', requirePermission('reports'), (req, res) => res.json({ items: listPools({ programmeId: req.query.programmeId ? String(req.query.programmeId) : null }) }));
adminRouter.post('/emoney/pools', requirePermission('treasury'), (req, res) => {
  const body = validate(z.object({ programmeId: z.string(), name: z.string().min(2).max(120), level: z.enum(['country', 'institution', 'master_agent', 'agent', 'merchant']), parentId: z.string().optional().nullable(), ownerUserId: z.string().optional().nullable(), country: z.string().length(2).optional().nullable(), limits: z.record(z.string(), z.number()).optional() }), req.body);
  const pool = createPool(body, req.user!);
  audit(req.user!.id, 'emoney.pool.created', 'pool', pool.id, { name: pool.name, level: pool.level });
  res.status(201).json({ pool });
});
/** Distribution moves existing e-money down the hierarchy under step-up; it never creates money. */
adminRouter.post('/emoney/pools/:id/allocate', requirePermission('treasury'), (req, res) => {
  const body = validate(z.object({ toPoolId: z.string().optional().nullable(), toUserId: z.string().optional().nullable(), amount: z.string(), reason: z.string().min(3).max(300), pin: z.string().optional() }), req.body);
  assertAdminStepUp(req.user!, body.pin, req);
  const from = getPool(String(req.params.id));
  const amount = toMinor(body.amount, getCurrency(from.currency).decimals);
  const r = allocate({ fromPoolId: from.id, toPoolId: body.toPoolId, toUserId: body.toUserId, amount, reason: body.reason }, req.user!);
  audit(req.user!.id, 'emoney.pool.allocated', 'pool', from.id, { toPoolId: body.toPoolId ?? null, toUserId: body.toUserId ?? null, amount, transactionId: r.transaction.id });
  res.json({ transaction: toTransaction(r.transaction), from: r.from, to: r.to });
});
adminRouter.post('/emoney/reconcile', requirePermission('treasury'), (req, res) => {
  const items = reconcileReserves(req.user!.id);
  audit(req.user!.id, 'emoney.reconciled', 'programme', 'all', { results: items.map((i) => ({ programmeId: i.programmeId, status: i.status, headroom: i.headroom })) });
  res.json({ items });
});
adminRouter.get('/emoney/reconciliations', requirePermission('reports'), (req, res) => res.json({ items: listReconciliations(req.query.programmeId ? String(req.query.programmeId) : null) }));
/** Freeze / release a holder's balance where legally permitted (attributable, step-up protected). */
adminRouter.post('/users/:id/wallets/:currency/freeze', requirePermission('treasury'), (req, res) => {
  const body = validate(z.object({ freeze: z.boolean().default(true), reason: z.string().min(4).max(300), pin: z.string().optional() }), req.body);
  assertAdminStepUp(req.user!, body.pin, req);
  const target = getUserById(String(req.params.id));
  const wallet = freezeWallet(target.id, String(req.params.currency), req.user!, body.reason, body.freeze);
  audit(req.user!.id, body.freeze ? 'wallet.frozen' : 'wallet.released', 'user', target.id, { currency: wallet.currency, reason: body.reason });
  res.json({ wallet: toWallet(wallet, target) });
});
/** Statement for any holder (support / regulatory requests); every generation is audited. */
adminRouter.get('/users/:id/statement', requirePermission('users'), (req, res) => {
  const q = validate(z.object({ currency: z.string().length(3), from: z.string().min(10), to: z.string().min(10), format: z.enum(['json', 'csv', 'pdf']).default('json') }), req.query);
  const target = getUserById(String(req.params.id));
  const s = buildStatement(target, q.currency.toUpperCase(), q.from, q.to, req.user!.id);
  audit(req.user!.id, 'statement.generated', 'user', target.id, { statementId: s.id, currency: s.account.currency, from: s.period.from, to: s.period.to, format: q.format });
  const name = `bitripay-statement-${s.number}-${s.account.currency}`;
  if (q.format === 'csv') return res.type('text/csv').setHeader('Content-Disposition', `attachment; filename="${name}.csv"`).send(statementCsv(s));
  if (q.format === 'pdf') return res.type('application/pdf').setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`).send(statementPdf(s));
  res.json({ statement: s });
});
adminRouter.get('/users/:id/statements', requirePermission('users'), (req, res) => res.json({ items: listStatements(String(req.params.id)) }));
adminRouter.get('/users/:id/promo', requirePermission('users'), (req, res) => res.json({ items: listPromoCredits(String(req.params.id)) }));

adminRouter.get('/permissions', (_req, res) => res.json({ items: ADMIN_PERMISSIONS }));

// ---------------------------------------------------------------------------------------------
// Blog & SEO (cms permission)
// ---------------------------------------------------------------------------------------------
const postSchema = z.object({ title: z.string().min(3).max(200), slug: z.string().max(120).optional().nullable(), excerpt: z.string().max(400).optional().nullable(), bodyMd: z.string().min(20), coverUrl: z.string().max(500).optional().nullable(), coverAlt: z.string().max(200).optional().nullable(), category: z.string().max(60).optional().nullable(), tags: z.array(z.string().max(40)).max(12).optional(), keywords: z.array(z.string().max(80)).max(12).optional(), language: z.string().max(5).optional().nullable(), authorName: z.string().max(80).optional().nullable(), status: z.enum(['draft', 'review', 'scheduled', 'published', 'archived']).optional(), metaTitle: z.string().max(120).optional().nullable(), metaDescription: z.string().max(300).optional().nullable(), canonicalUrl: z.string().max(300).optional().nullable(), faq: z.array(z.object({ question: z.string().max(300), answer: z.string().max(2000) })).max(12).optional(), sources: z.array(z.object({ title: z.string().max(200), url: z.string().max(500) })).max(20).optional(), social: z.record(z.string(), z.string()).optional(), scheduledFor: z.string().datetime({ offset: true }).optional().nullable() });
adminRouter.get('/blog/posts', requirePermission('cms'), (req, res) => {
  const { page, pageSize } = parsePagination(req.query, 30);
  res.json(listPosts({ status: (req.query.status ? String(req.query.status) : 'all') as any, q: req.query.q ? String(req.query.q) : null, page, pageSize }));
});
adminRouter.get('/blog/posts/:id', requirePermission('cms'), (req, res) => res.json({ post: getPost(String(req.params.id), false), rendered: renderPost(String(req.params.id), false) }));
adminRouter.post('/blog/posts', requirePermission('cms'), (req, res) => {
  const body = validate(postSchema, req.body);
  const post = createPost({ ...body, authorUserId: req.user!.id, authorName: body.authorName ?? req.user!.full_name }, { type: 'admin', id: req.user!.id });
  audit(req.user!.id, 'blog.post.create', 'post', post.id, { slug: post.slug, status: post.status });
  if (post.status === 'published') void pingIndexNow([post.url]);
  res.status(201).json({ post });
});
adminRouter.patch('/blog/posts/:id', requirePermission('cms'), (req, res) => {
  const body = validate(postSchema.partial(), req.body);
  const post = updatePost(String(req.params.id), body, { type: 'admin', id: req.user!.id });
  audit(req.user!.id, 'blog.post.update', 'post', post.id, { fields: Object.keys(body) });
  if (body.status === 'published') void pingIndexNow([post.url]);
  res.json({ post });
});
adminRouter.delete('/blog/posts/:id', requirePermission('cms'), (req, res) => {
  deletePost(String(req.params.id), { type: 'admin', id: req.user!.id });
  audit(req.user!.id, 'blog.post.delete', 'post', String(req.params.id), {});
  res.json({ ok: true });
});
/** AI content agent. */
adminRouter.get('/seo', requirePermission('cms'), (_req, res) => {
  const s = getSeoSettings();
  res.json({ settings: { ...s, agent: { ...s.agent, apiKey: s.agent.apiKey ? '••••••••' : '' } }, agent: agentStatus(), views: pageviewSummary(30), rules: listLinkRules(), backlinks: listBacklinks(), runs: listRuns(30), outreach: outreachCandidates(), posts: listPosts({ status: 'all', pageSize: 100 }).items });
});
adminRouter.put('/seo/settings', requirePermission('settings'), (req, res) => {
  const current = getSeoSettings();
  const body = req.body ?? {};
  const agent = { ...current.agent, ...(body.agent ?? {}) };
  if (!body.agent || body.agent.apiKey === undefined || body.agent.apiKey === '••••••••') agent.apiKey = current.agent.apiKey;
  else if (body.agent.apiKey) agent.apiKey = encrypt(String(body.agent.apiKey));
  else agent.apiKey = '';
  const next = { ...current, ...body, agent };
  setSetting('seo', next);
  audit(req.user!.id, 'seo.settings.update', 'settings', 'seo', { keys: Object.keys(body) });
  res.json({ settings: { ...next, agent: { ...next.agent, apiKey: next.agent.apiKey ? '••••••••' : '' } }, agent: agentStatus() });
});
adminRouter.post('/seo/agent/draft', requirePermission('cms'), wrap(async (req, res) => {
  const body = validate(z.object({ topic: z.string().min(4).max(300), keywords: z.array(z.string().max(80)).max(10).optional(), language: z.string().max(5).optional(), extraInstructions: z.string().max(1000).optional().nullable() }), req.body);
  const r = await draftArticle(body, { type: 'admin', id: req.user!.id }, req.user!.id);
  audit(req.user!.id, 'seo.agent.draft', 'post', r.post.id, { runId: r.run.id, status: r.run.status });
  res.status(201).json(r);
}));
adminRouter.post('/seo/agent/keywords', requirePermission('cms'), wrap(async (req, res) => {
  const body = validate(z.object({ seed: z.string().min(2).max(200) }), req.body);
  res.json(await keywordIdeas(body.seed, { type: 'admin', id: req.user!.id }));
}));
adminRouter.post('/seo/agent/audit/:postId', requirePermission('cms'), wrap(async (req, res) => res.json(await auditPost(String(req.params.postId), { type: 'admin', id: req.user!.id }))));
adminRouter.post('/seo/agent/social/:postId', requirePermission('cms'), wrap(async (req, res) => res.json(await socialPack(String(req.params.postId), { type: 'admin', id: req.user!.id }))));
adminRouter.post('/seo/ping', requirePermission('cms'), wrap(async (req, res) => {
  const body = validate(z.object({ paths: z.array(z.string().max(300)).min(1).max(100) }), req.body);
  res.json(await pingIndexNow(body.paths));
}));
adminRouter.put('/seo/rules/:id', requirePermission('cms'), (req, res) => {
  const body = validate(z.object({ keyword: z.string().min(2).max(80), url: z.string().min(1).max(300), title: z.string().max(200).optional().nullable(), kind: z.enum(['internal', 'outbound']).optional(), maxPerPage: z.number().int().min(1).max(10).optional(), priority: z.number().int().min(0).max(100).optional(), enabled: z.boolean().optional() }), req.body);
  res.json({ rule: upsertLinkRule({ id: String(req.params.id) === 'new' ? undefined : String(req.params.id), ...body }) });
});
adminRouter.delete('/seo/rules/:id', requirePermission('cms'), (req, res) => { deleteLinkRule(String(req.params.id)); res.json({ ok: true }); });
adminRouter.put('/seo/backlinks/:id', requirePermission('cms'), (req, res) => {
  const body = validate(z.object({ direction: z.enum(['inbound', 'outbound', 'partner']), sourceUrl: z.string().url().max(500), targetUrl: z.string().max(500), anchor: z.string().max(200).optional().nullable(), status: z.enum(['live', 'pending', 'lost', 'rejected']).optional(), nofollow: z.boolean().optional(), notes: z.string().max(500).optional().nullable() }), req.body);
  res.json({ backlink: upsertBacklink({ id: String(req.params.id) === 'new' ? undefined : String(req.params.id), ...body }) });
});
adminRouter.delete('/seo/backlinks/:id', requirePermission('cms'), (req, res) => { deleteBacklink(String(req.params.id)); res.json({ ok: true }); });
adminRouter.post('/seo/backlinks/verify', requirePermission('cms'), wrap(async (_req, res) => res.json(await verifyBacklinks())));

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
// Administrative payout settlement is maker-checker: this PROPOSES with documentary evidence; a different admin approves in the console.
adminRouter.post('/withdrawals/:id/approve', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ payoutReference: z.string().min(4).max(80), note: z.string().min(8).max(500).default('Payout executed manually; reference checked against the operator/bank statement') }), req.body ?? {});
  const verification = proposeVerification(req.user!, String(req.params.id), { subjectType: 'withdrawal', action: 'confirm', note: body.note, externalRef: body.payoutReference });
  audit(req.user!.id, 'withdrawal.approve.proposed', 'transaction', String(req.params.id), { verificationId: verification.id, payoutReference: body.payoutReference });
  res.json({ verification, transaction: toTransaction(getTransaction(String(req.params.id))!) });
});
adminRouter.post('/withdrawals/:id/reject', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ reason: z.string().min(2).max(300) }), req.body);
  const verification = proposeVerification(req.user!, String(req.params.id), { subjectType: 'withdrawal', action: 'reject', note: body.reason });
  audit(req.user!.id, 'withdrawal.reject.proposed', 'transaction', String(req.params.id), { verificationId: verification.id, ...body });
  res.json({ verification, transaction: toTransaction(getTransaction(String(req.params.id))!) });
});
adminRouter.get('/payments', requirePermission('approvals'), (req, res) => {
  const { page, pageSize } = parsePagination(req.query, 25);
  const result = listPayments({ purpose: req.query.purpose ? String(req.query.purpose) : undefined, status: req.query.status ? String(req.query.status) : undefined, method: req.query.method ? String(req.query.method) : undefined, page, pageSize });
  const rows = getDb().prepare(`SELECT id, user_id, payer_email, payer_name, metadata FROM gateway_payments WHERE id IN (${result.items.map(() => '?').join(',') || "''"})`).all(...result.items.map((p) => p.id)) as any[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const users = usersById(rows.map((r) => r.user_id));
  res.json({ ...result, items: result.items.map((p) => ({ ...p, user: users.get(byId.get(p.id)?.user_id) ?? null, payerEmail: byId.get(p.id)?.payer_email, payerName: byId.get(p.id)?.payer_name, proof: JSON.parse(byId.get(p.id)?.metadata || '{}').proof ?? null })), page, pageSize });
});
// Manual settlement is maker-checker: /payments/:id/confirm and /reject PROPOSE a decision; a different admin approves it under step-up.
adminRouter.post('/payments/:id/confirm', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ note: z.string().max(500).optional().nullable(), evidenceId: z.string().optional().nullable() }), req.body ?? {});
  const verification = proposeVerification(req.user!, String(req.params.id), { action: 'confirm', note: body.note, evidenceId: body.evidenceId });
  audit(req.user!.id, 'payment.confirm.proposed', 'payment', String(req.params.id), { verificationId: verification.id });
  res.json({ verification, payment: toPaymentView(getPayment(String(req.params.id))) });
});
adminRouter.post('/payments/:id/reject', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ reason: z.string().min(2).max(300) }), req.body);
  const verification = proposeVerification(req.user!, String(req.params.id), { action: 'reject', note: body.reason });
  audit(req.user!.id, 'payment.reject.proposed', 'payment', String(req.params.id), { verificationId: verification.id, ...body });
  res.json({ verification, payment: toPaymentView(getPayment(String(req.params.id))) });
});
adminRouter.get('/payments/:id/case', requirePermission('approvals'), (req, res) => res.json(verificationCase(String(req.params.id))));
adminRouter.get('/verifications', requirePermission('approvals'), (req, res) => {
  const queue = listPayments({ stages: req.query.stage ? [String(req.query.stage)] : OPEN_STAGES, page: 1, pageSize: 100 });
  const users = usersById(queue.items.map((p) => (getPayment(p.id).user_id as string) ?? '').filter(Boolean));
  res.json({ queue: queue.items.map((p) => ({ ...p, user: users.get(getPayment(p.id).user_id ?? '') ?? null })), pending: listVerifications({ status: 'proposed' }), recent: listVerifications({}).slice(0, 50), stages: STAGE_LABELS });
});
adminRouter.post('/verifications/:id/approve', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ pin: z.string().optional() }), req.body ?? {});
  const verification = approveVerification(req.user!, String(req.params.id), body.pin, req);
  audit(req.user!.id, `verification.approved.${verification.action}`, verification.subjectType, verification.paymentId, { verificationId: verification.id });
  res.json({ verification, ...verificationSubject(verification) });
});
adminRouter.post('/verifications/:id/decline', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ reason: z.string().min(2).max(300) }), req.body);
  const verification = declineVerification(req.user!, String(req.params.id), body.reason);
  audit(req.user!.id, 'verification.declined', verification.subjectType, verification.paymentId, { verificationId: verification.id, reason: body.reason });
  res.json({ verification, ...verificationSubject(verification) });
});
/** Verifier types in an SMS/statement line by hand: recorded as manual evidence that still needs maker-checker approval. */
adminRouter.post('/payments/:id/evidence', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ text: z.string().min(5).max(2000), operatorId: z.string().optional().nullable(), from: z.string().max(40).optional().nullable(), receivedAt: z.string().datetime({ offset: true }).optional().nullable() }), req.body);
  const evidence = ingestEvidence({ source: 'manual', text: body.text, operatorId: body.operatorId, from: body.from, receivedAt: body.receivedAt, actor: { type: 'admin', id: req.user!.id } });
  audit(req.user!.id, 'evidence.manual', 'payment', String(req.params.id), { evidenceId: evidence.id, outcome: evidence.outcome });
  res.status(201).json({ evidence, payment: toPaymentView(getPayment(String(req.params.id))) });
});
adminRouter.get('/evidence', requirePermission('approvals'), (req, res) => {
  const { page, pageSize } = parsePagination(req.query, 50);
  res.json({ ...listEvidence({ paymentId: req.query.paymentId ? String(req.query.paymentId) : null, outcome: req.query.outcome ? String(req.query.outcome) : null, page, pageSize }), page, pageSize });
});
adminRouter.get('/evidence/devices', requirePermission('gateways'), (_req, res) => res.json({ items: listDevices() }));
adminRouter.post('/evidence/devices', requirePermission('gateways'), (req, res) => {
  const body = validate(z.object({ name: z.string().min(2).max(80), publicKey: z.string().min(32).max(2000), operatorIds: z.array(z.string()).max(50).optional().nullable(), kind: z.enum(['collection', 'payout']).optional().nullable(), simMsisdn: z.string().max(30).optional().nullable(), simIccid: z.string().max(30).optional().nullable(), agentUserId: z.string().optional().nullable(), payoutAccountId: z.string().optional().nullable(), ownerUserId: z.string().optional().nullable() }), req.body);
  const owner = body.ownerUserId ? getUserById(body.ownerUserId) : req.user!;
  const device = registerDevice(owner, body, req.user!.id);
  audit(req.user!.id, 'evidence_device.register', 'device', device.id, { name: body.name });
  res.status(201).json({ device });
});
adminRouter.delete('/evidence/devices/:id', requirePermission('gateways'), (req, res) => {
  const device = revokeDevice(String(req.params.id), { type: 'admin', id: req.user!.id }, req.body?.reason);
  audit(req.user!.id, 'evidence_device.revoke', 'device', device.id, { reason: req.body?.reason ?? null });
  res.json({ device });
});
adminRouter.get('/evidence/templates', requirePermission('gateways'), (_req, res) => res.json({ items: listTemplates() }));
adminRouter.put('/evidence/templates/:id', requirePermission('gateways'), (req, res) => {
  const body = validate(z.object({ operatorId: z.string().min(1), name: z.string().min(2).max(120), patterns: z.record(z.string(), z.any()), priority: z.number().int().optional(), enabled: z.boolean().optional() }), req.body);
  const template = upsertTemplate({ id: String(req.params.id) === 'new' ? null : String(req.params.id), ...body });
  audit(req.user!.id, 'parse_template.update', 'template', template.id, { operatorId: body.operatorId });
  res.json({ template });
});
adminRouter.delete('/evidence/templates/:id', requirePermission('gateways'), (req, res) => {
  deleteTemplate(String(req.params.id));
  res.json({ ok: true });
});
adminRouter.post('/evidence/parse-test', requirePermission('gateways'), (req, res) => {
  const body = validate(z.object({ text: z.string().min(1).max(2000), operatorId: z.string().optional().nullable() }), req.body);
  res.json({ parsed: parseEvidenceText(body.text, body.operatorId) });
});
adminRouter.get('/events', requirePermission('admins'), (req, res) => {
  const { page, pageSize } = parsePagination(req.query, 50);
  res.json({ ...listEvents({ stream: req.query.stream ? (String(req.query.stream) as any) : undefined, subjectId: req.query.subjectId ? String(req.query.subjectId) : undefined, limit: pageSize, page }), page, pageSize, chain: verifyEventChain() });
});
adminRouter.get('/reconcile', requirePermission('reports'), (_req, res) => res.json({ ledger: reconcileLedger(), events: verifyEventChain() }));
adminRouter.get('/sanctions', requirePermission('settings'), (_req, res) => res.json({ items: listSanctions() }));
adminRouter.post('/sanctions', requirePermission('settings'), (req, res) => {
  const body = validate(z.object({ kind: z.enum(['name', 'phone', 'email', 'country']), value: z.string().min(2).max(200), note: z.string().max(300).optional().nullable() }), req.body);
  const entry = addSanction(body.kind, body.value, body.note, req.user!.id);
  audit(req.user!.id, 'sanctions.add', 'sanction', entry.id, { kind: body.kind });
  res.status(201).json({ entry });
});
adminRouter.delete('/sanctions/:id', requirePermission('settings'), (req, res) => {
  deleteSanction(String(req.params.id));
  audit(req.user!.id, 'sanctions.delete', 'sanction', String(req.params.id));
  res.json({ ok: true });
});
adminRouter.get('/risk-events', requirePermission('reports'), (req, res) => {
  const { page, pageSize } = parsePagination(req.query, 50);
  res.json({ ...listRiskEvents(page, pageSize), page, pageSize });
});
adminRouter.get('/route-catalog', requirePermission('gateways'), (req, res) => res.json({ items: routeCatalog({ currency: req.query.currency ? String(req.query.currency) : 'USD' }) }));

// ---------------- Corridors, liquidity, payouts, chargebacks ----------------
adminRouter.get('/corridors', requirePermission('gateways'), (_req, res) => res.json({ items: listCorridors(), compliance: getSetting('compliance') }));
adminRouter.put('/corridors/:id', requirePermission('gateways'), (req, res) => {
  const body = validate(z.object({ sourceCountry: z.string().length(2).optional().nullable(), sourceCurrency: z.string().min(1).max(3), destCountry: z.string().length(2), destCurrency: z.string().length(3), operatorId: z.string().optional().nullable(), rail: z.enum(['mobile_money', 'bank', 'agent']).default('mobile_money'), estimatedPayoutMinutes: z.number().int().min(1).optional(), maxAmount: z.number().int().min(0).optional(), notes: z.string().max(1000).optional().nullable(), enabled: z.boolean().optional(), collectionPartner: z.string().max(200).optional().nullable(), payoutPartner: z.string().max(200).optional().nullable(), licenceRef: z.string().max(200).optional().nullable(), compliance: complianceSchema.optional().nullable(), licenceExpiresAt: z.string().datetime({ offset: true }).optional().nullable(), payoutCurrencies: z.array(z.string().length(3)).max(20).optional().nullable(), beneficiaryConsent: z.boolean().optional().nullable(), payoutConfirmation: z.enum(['PROCESSOR_WEBHOOK', 'SIGNED_SMS_FORWARDER', 'SECURED_DEVICE_CONFIRMATION', 'AGENT_WITH_EVIDENCE', 'ADMIN_MAKER_CHECKER']).optional().nullable() }), req.body);
  const corridor = upsertCorridor({ id: String(req.params.id) === 'new' ? undefined : String(req.params.id), ...body }, { type: 'admin', id: req.user!.id });
  audit(req.user!.id, 'corridor.upsert', 'corridor', corridor.id, { destCountry: body.destCountry, operatorId: body.operatorId ?? null });
  res.json({ corridor });
});
/** Live / suspended: an explicit, step-up protected decision that records the regulatory arrangements. */
adminRouter.post('/corridors/:id/status', requirePermission('settings'), (req, res) => {
  const body = validate(z.object({ status: z.enum(['sandbox', 'live', 'suspended']), collectionPartner: z.string().max(200).optional().nullable(), payoutPartner: z.string().max(200).optional().nullable(), licenceRef: z.string().max(200).optional().nullable(), notes: z.string().max(1000).optional().nullable(), compliance: complianceSchema.optional().nullable(), licenceExpiresAt: z.string().datetime({ offset: true }).optional().nullable(), pin: z.string().optional() }), req.body);
  assertAdminStepUp(req.user!, body.pin, req);
  const corridor = setCorridorStatus(String(req.params.id), body.status, req.user!, body);
  audit(req.user!.id, `corridor.${body.status}`, 'corridor', corridor.id, { collectionPartner: body.collectionPartner, payoutPartner: body.payoutPartner, licenceRef: body.licenceRef });
  res.json({ corridor });
});
adminRouter.delete('/corridors/:id', requirePermission('gateways'), (req, res) => {
  deleteCorridor(String(req.params.id));
  res.json({ ok: true });
});
adminRouter.get('/liquidity', requirePermission('gateways'), (_req, res) => res.json({ items: liquidityOverview() }));
adminRouter.post('/liquidity/accounts', requirePermission('gateways'), (req, res) => {
  const body = validate(z.object({ rail: z.enum(['mobile_money', 'bank']), operatorId: z.string().optional().nullable(), country: z.string().length(2), currency: z.string().length(3), label: z.string().min(2).max(120), msisdn: z.string().max(30).optional().nullable(), simIccid: z.string().max(30).optional().nullable(), bankName: z.string().max(120).optional().nullable(), accountNumber: z.string().max(60).optional().nullable(), agentUserId: z.string().optional().nullable(), deviceId: z.string().optional().nullable(), dailyLimit: z.number().int().min(0).optional(), perTxLimit: z.number().int().min(0).optional() }), req.body);
  const account = createPayoutAccount(body, { type: 'admin', id: req.user!.id });
  audit(req.user!.id, 'payout_account.create', 'payout_account', account.id, { rail: body.rail, operatorId: body.operatorId ?? null });
  res.status(201).json({ account });
});
adminRouter.patch('/liquidity/accounts/:id', requirePermission('gateways'), (req, res) => {
  const body = validate(z.object({ label: z.string().min(2).max(120).optional(), status: z.enum(['active', 'paused']).optional(), agentUserId: z.string().optional().nullable(), deviceId: z.string().optional().nullable(), dailyLimit: z.number().int().min(0).optional(), perTxLimit: z.number().int().min(0).optional(), msisdn: z.string().max(30).optional().nullable(), simIccid: z.string().max(30).optional().nullable() }), req.body);
  res.json({ account: updatePayoutAccount(String(req.params.id), body, { type: 'admin', id: req.user!.id }) });
});
adminRouter.get('/liquidity/accounts/:id/movements', requirePermission('gateways'), (req, res) => res.json({ account: getPayoutAccount(String(req.params.id)), items: listMovements(String(req.params.id)) }));
/** Prefund / rebalance (step-up protected): treasury → local float. Waiting payouts are re-queued automatically. */
adminRouter.post('/liquidity/accounts/:id/prefund', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ amount: z.string(), reference: z.string().max(120).optional().nullable(), note: z.string().max(300).optional().nullable(), pin: z.string().optional() }), req.body);
  assertAdminStepUp(req.user!, body.pin, req);
  const acc = getPayoutAccount(String(req.params.id));
  const account = prefundAccount(acc.id, toMinor(body.amount, getCurrency(acc.currency, false).decimals), body, req.user!);
  const requeued = requeueWaiting(account, { type: 'admin', id: req.user!.id });
  audit(req.user!.id, 'payout_account.prefund', 'payout_account', account.id, { amount: body.amount, reference: body.reference ?? null, requeued });
  res.json({ account, requeued });
});
adminRouter.post('/liquidity/accounts/:id/adjust', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ delta: z.string(), note: z.string().min(3).max(300), pin: z.string().optional() }), req.body);
  assertAdminStepUp(req.user!, body.pin, req);
  const acc = getPayoutAccount(String(req.params.id));
  const account = adjustAccount(acc.id, toMinor(body.delta.replace('-', ''), getCurrency(acc.currency, false).decimals) * (body.delta.trim().startsWith('-') ? -1 : 1), body.note, req.user!);
  audit(req.user!.id, 'payout_account.adjust', 'payout_account', account.id, { delta: body.delta, note: body.note });
  res.json({ account });
});
adminRouter.get('/payouts', requirePermission('approvals'), (req, res) => {
  const { page, pageSize } = parsePagination(req.query, 50);
  res.json({ ...listPayouts({ stage: req.query.stage ? String(req.query.stage) : null, payoutAccountId: req.query.accountId ? String(req.query.accountId) : null, page, pageSize }), page, pageSize, pending: listVerifications({ status: 'proposed' }).filter((v) => v.subjectType === 'payout' || v.subjectType === 'withdrawal' || v.subjectType.startsWith('route')) });
});
adminRouter.get('/payouts/:id', requirePermission('approvals'), (req, res) => res.json(payoutCase(String(req.params.id))));
adminRouter.post('/payouts/:id/requeue', requirePermission('approvals'), (req, res) => {
  const payout = requeuePayout(String(req.params.id), { type: 'admin', id: req.user!.id });
  audit(req.user!.id, 'payout.requeue', 'payout', payout.id, { stage: payout.stage });
  res.json({ payout });
});
adminRouter.post('/payouts/:id/release', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ reason: z.string().min(2).max(300) }), req.body);
  res.json({ payout: releasePayout(String(req.params.id), null, body.reason, { type: 'admin', id: req.user!.id }) });
});
/** Administrative settlement / failure PROPOSALS (maker-checker; approved in the verification console with step-up). */
adminRouter.post('/payouts/:id/settle', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ externalRef: z.string().min(4).max(80), note: z.string().min(8).max(500), evidenceId: z.string().optional().nullable() }), req.body);
  const verification = proposeVerification(req.user!, String(req.params.id), { subjectType: 'payout', action: 'confirm', note: body.note, externalRef: body.externalRef, evidenceId: body.evidenceId });
  audit(req.user!.id, 'payout.settle.proposed', 'payout', String(req.params.id), { verificationId: verification.id, externalRef: body.externalRef });
  res.json({ verification, payout: getPayout(String(req.params.id)) });
});
adminRouter.post('/payouts/:id/fail', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ reason: z.string().min(2).max(300) }), req.body);
  const verification = proposeVerification(req.user!, String(req.params.id), { subjectType: 'payout', action: 'reject', note: body.reason });
  audit(req.user!.id, 'payout.fail.proposed', 'payout', String(req.params.id), { verificationId: verification.id, reason: body.reason });
  res.json({ verification, payout: getPayout(String(req.params.id)) });
});
adminRouter.post('/payouts/:id/cancel', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ reason: z.string().min(2).max(300), pin: z.string().optional() }), req.body);
  assertAdminStepUp(req.user!, body.pin, req);
  const payout = cancelPayout(String(req.params.id), { type: 'admin', id: req.user!.id }, body.reason);
  audit(req.user!.id, 'payout.cancel', 'payout', payout.id, body);
  res.json({ payout });
});
adminRouter.get('/money-routes/:id', requirePermission('transactions'), (req, res) => res.json({ route: adminRouteView(String(req.params.id)), events: listEvents({ subjectId: String(req.params.id), limit: 200 }).items }));
/** Release a held transfer (MANUAL_REVIEW) or refund it – both maker-checker proposals. */
adminRouter.post('/money-routes/:id/release', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ approve: z.boolean().default(true), note: z.string().max(500).optional().nullable() }), req.body ?? {});
  const verification = proposeVerification(req.user!, String(req.params.id), { subjectType: 'route_release', action: body.approve ? 'confirm' : 'reject', note: body.note });
  audit(req.user!.id, 'route.release.proposed', 'route', String(req.params.id), { verificationId: verification.id, approve: body.approve });
  res.json({ verification, route: adminRouteView(String(req.params.id)) });
});
adminRouter.post('/money-routes/:id/refund', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ reason: z.string().min(2).max(300) }), req.body);
  const verification = proposeVerification(req.user!, String(req.params.id), { subjectType: 'route_refund', action: 'confirm', note: body.reason });
  audit(req.user!.id, 'route.refund.proposed', 'route', String(req.params.id), { verificationId: verification.id });
  res.json({ verification, route: adminRouteView(String(req.params.id)) });
});
adminRouter.get('/chargebacks', requirePermission('approvals'), (req, res) => res.json({ items: listChargebacks(req.query.status ? String(req.query.status) : null) }));
adminRouter.post('/chargebacks', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ paymentId: z.string(), reason: z.string().min(2).max(300), providerRef: z.string().max(120).optional().nullable(), pin: z.string().optional() }), req.body);
  assertAdminStepUp(req.user!, body.pin, req);
  const chargeback = openChargeback(body.paymentId, { reason: body.reason, providerRef: body.providerRef, actor: { type: 'admin', id: req.user!.id } });
  audit(req.user!.id, 'chargeback.open', 'payment', body.paymentId, { chargebackId: chargeback.id, status: chargeback.status });
  res.status(201).json({ chargeback });
});
adminRouter.post('/chargebacks/:id/resolve', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ outcome: z.enum(['won', 'lost']), note: z.string().max(500).optional().nullable(), pin: z.string().optional() }), req.body);
  assertAdminStepUp(req.user!, body.pin, req);
  const chargeback = resolveChargeback(String(req.params.id), body.outcome, req.user!, body.note);
  audit(req.user!.id, `chargeback.${body.outcome}`, 'chargeback', chargeback.id, { note: body.note ?? null });
  res.json({ chargeback });
});
adminRouter.get('/remittances', requirePermission('approvals'), (req, res) => {
  const where = req.query.status ? 'WHERE status = ?' : '';
  const rows = getDb().prepare(`SELECT * FROM remittances ${where} ORDER BY created_at DESC LIMIT 200`).all(...(req.query.status ? [String(req.query.status)] : []));
  res.json({ items: rows.map(toRemittance) });
});
adminRouter.post('/remittances/:id/settle', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ outcome: z.enum(['completed', 'rejected']), reason: z.string().optional(), pin: z.string().optional() }), req.body);
  assertAdminStepUp(req.user!, body.pin, req);
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
    app: { ...getAppSettings(), rateProviderKey: getAppSettings().rateProviderKey ? '••••••••' : '' },
    gateway: getGatewayControls(),
    fx: getFxSettings(),
    risk: getRiskSettings(),
    compliance: getSetting('compliance'),
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
    const allowed = ['fees', 'limits', 'referral', 'app', 'modules', 'countries', 'smtp', 'sms', 'gateway', 'fx', 'risk', 'compliance'];
    if (!allowed.includes(key)) throw badRequest('Unknown settings key');
    let value = req.body?.value ?? req.body;
    if (key === 'smtp' && value?.pass === '••••••••') value = { ...value, pass: getSmtpSettings().pass };
    if (key === 'app') {
      // Rate provider API keys are stored encrypted and never echoed back.
      const current = getAppSettings();
      if (value?.rateProviderKey === '••••••••' || value?.rateProviderKey === undefined) value = { ...value, rateProviderKey: current.rateProviderKey };
      else if (value?.rateProviderKey) value = { ...value, rateProviderKey: encrypt(String(value.rateProviderKey)) };
    }
    if (key === 'compliance' && value?.mode === 'live' && getSetting<{ mode: string }>('compliance').mode !== 'live') {
      const checklist = goLiveChecklist();
      if (!checklist.readyForLive) throw badRequest(`Cannot switch to live: ${checklist.items.filter((i) => i.blocking && !i.ok).map((i) => i.label).join('; ')}`, 'go_live_blocked', checklist);
      assertAdminStepUp(req.user!, req.body?.pin, req);
    }
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
    audit(req.user!.id, 'currency.refresh_rates', undefined, undefined, { provider: result.provider, updated: result.updated.length, snapshotId: result.snapshotId });
    res.json(result);
  }),
);
/** Rate provider status, freshness and the versioned snapshot history. */
adminRouter.get('/currencies/rate-status', requirePermission('settings'), (_req, res) => res.json({ status: getRateStatus(), freshness: rateFreshness(), providers: RATE_PROVIDERS.map((p) => ({ id: p.id, name: p.name, keyed: p.keyed })), snapshots: listRateSnapshots(20) }));
/** Versioned manual import (1 base = rate quote) for environments without outbound access – labelled non-live everywhere. */
adminRouter.post('/currencies/import', requirePermission('settings'), (req, res) => {
  const body = validate(z.object({ rates: z.record(z.string(), z.number().positive()), note: z.string().max(300).optional().nullable() }), req.body);
  const result = importRates(req.user!, body.rates, body.note);
  audit(req.user!.id, 'currency.import_rates', undefined, undefined, { snapshotId: result.snapshotId, updated: result.updated.length });
  res.status(201).json(result);
});

// ---------------- Gateways (payment aggregator) ----------------
adminRouter.get('/gateways', requirePermission('gateways'), (_req, res) =>
  res.json({ items: listGateways(), providers: Object.values(PROVIDERS).map((p) => ({ id: p.id, name: p.name, methods: p.supportedMethods, credentialFields: p.credentialFields })) }),
);
/** Onboarding: connectivity test with the stored credentials; the result is kept on the gateway for the go-live checklist. */
adminRouter.post(
  '/gateways/:id/test',
  requirePermission('gateways'),
  wrap(async (req, res) => {
    const result = await testGateway(String(req.params.id));
    audit(req.user!.id, 'gateway.test', 'gateway', String(req.params.id), { ok: result.ok, mode: result.mode });
    res.json(result);
  }),
);
/** Everything that must be in place before live customer funds are accepted. */
adminRouter.get('/go-live', requirePermission('settings'), (_req, res) => res.json(goLiveChecklist()));
adminRouter.put(
  '/gateways/:id',
  requirePermission('gateways'),
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        name: z.string().min(1),
        provider: z.enum(['sandbox', 'stripe', 'paystack', 'flutterwave', 'mtn_momo', 'mpesa', 'manual_bank', 'manual_momo']),
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

// ---------------- Mobile money operators (direct rail, all world operators) ----------------
adminRouter.get('/momo-operators', requirePermission('gateways'), (req, res) => res.json({ items: listMomo({ country: req.query.country ? String(req.query.country) : null, onlyEnabled: false }) }));
adminRouter.put(
  '/momo-operators/:id',
  requirePermission('gateways'),
  wrap(async (req, res) => {
    const body = validate(
      z.object({ name: z.string().min(1), brand: z.string().min(1), country: z.string().length(2), currency: z.string().length(3), ussd: z.string().max(20).optional().nullable(), color: z.string().optional(), collectionNumber: z.string().max(40).optional().nullable(), collectionName: z.string().max(120).optional().nullable(), instructions: z.string().max(1000).optional().nullable(), payoutEnabled: z.boolean().default(true), enabled: z.boolean().default(true), sortOrder: z.number().int().optional() }),
      req.body,
    );
    const op = upsertMomo({ id: String(req.params.id).toLowerCase().replace(/[^a-z0-9_]/g, '_'), ...body });
    audit(req.user!.id, 'momo_operator.update', 'momo_operator', op.id, { enabled: body.enabled, collectionNumber: body.collectionNumber ? '***' : null });
    res.json({ operator: op });
  }),
);
adminRouter.delete('/momo-operators/:id', requirePermission('gateways'), (req, res) => {
  deleteMomo(String(req.params.id));
  res.json({ ok: true });
});
adminRouter.get('/money-routes', requirePermission('transactions'), (req, res) => {
  const { page, pageSize } = parsePagination(req.query, 25);
  const db = getDb();
  const where = req.query.status ? 'WHERE status = ?' : '';
  const params = req.query.status ? [String(req.query.status)] : [];
  const total = (db.prepare(`SELECT COUNT(*) c FROM money_routes ${where}`).get(...params) as any).c;
  const rows = db.prepare(`SELECT * FROM money_routes ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as any[];
  const users = usersById(rows.map((r) => r.user_id));
  res.json({ items: rows.map((r) => ({ id: r.id, user: users.get(r.user_id) ?? null, source: r.source_method, destination: r.destination_method, destinationDetails: JSON.parse(r.destination_details || '{}'), amount: r.amount, currency: r.currency, targetCurrency: r.target_currency, status: r.status, error: r.error, createdAt: r.created_at })), total, page, pageSize });
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

// ---------------------------------------------------------------------------------------------------------------------
// Command centres: agent registry, runs explorer, policies, approvals (maker-checker), usage and settings
// ---------------------------------------------------------------------------------------------------------------------
adminRouter.get('/agents', requirePermission('agents'), (_req, res) => {
  const s = getAssistSettings();
  res.json({ agents: agentStats(), runtime: runtimeStatus(), policies: listPolicies(), approvals: listApprovals({ status: 'proposed' }), forbidden: FORBIDDEN, addon: addonReport(), billing: billingReport(), tools: TOOLS.map((t) => ({ name: t.name, description: t.description, roles: t.roles, permission: t.permission ?? null, sideEffect: t.sideEffect, requiresApproval: !!t.requiresApproval })), settings: { ...s, apiKey: s.apiKey ? '••••••••' : '' }, usage: getDb().prepare("SELECT day, agent_key, model, SUM(runs) runs, SUM(tokens_in) tokens_in, SUM(tokens_out) tokens_out, SUM(cost_micros) cost_micros, SUM(acu) acu FROM agent_usage WHERE day >= ? GROUP BY day, agent_key, model ORDER BY day DESC").all(new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)) });
});
adminRouter.post('/agents/:key/pause', requirePermission('agents'), (req, res) => {
  const s = getAssistSettings();
  if (!getAgentDef(String(req.params.key))) throw notFound('Unknown agent');
  const paused = Array.from(new Set([...s.paused, String(req.params.key)]));
  setSetting('assist', { ...s, paused });
  audit(req.user!.id, 'agents.pause', 'agent', String(req.params.key));
  res.json({ paused });
});
adminRouter.post('/agents/:key/resume', requirePermission('agents'), (req, res) => {
  const s = getAssistSettings();
  const paused = s.paused.filter((k) => k !== String(req.params.key));
  setSetting('assist', { ...s, paused });
  audit(req.user!.id, 'agents.resume', 'agent', String(req.params.key));
  res.json({ paused });
});
adminRouter.post('/agents/kill-switch', requirePermission('agents'), (req, res) => {
  const body = validate(z.object({ on: z.boolean(), pin: z.string().optional() }), req.body);
  assertAdminStepUp(req.user!, body.pin, req);
  const s = getAssistSettings();
  setSetting('assist', { ...s, killSwitch: body.on });
  audit(req.user!.id, body.on ? 'agents.kill_switch.on' : 'agents.kill_switch.off', 'settings', 'assist');
  res.json({ killSwitch: body.on });
});
adminRouter.put('/agents/settings', requirePermission('agents'), (req, res) => {
  const current = getAssistSettings();
  const body = req.body ?? {};
  const next = { ...current, ...body };
  if (body.apiKey === undefined || body.apiKey === '••••••••') next.apiKey = current.apiKey;
  else next.apiKey = body.apiKey ? encrypt(String(body.apiKey)) : '';
  next.paused = Array.isArray(next.paused) ? next.paused : current.paused;
  next.allowances = { ...current.allowances, ...(body.allowances ?? {}) };
  next.pricing = { ...current.pricing, ...(body.pricing ?? {}) };
  next.billing = { ...current.billing, ...(body.billing ?? {}), prices: { ...current.billing.prices, ...(body.billing?.prices ?? {}) } };
  next.billing.prices.standard = Math.max(0, Math.round(Number(next.billing.prices.standard) || 0));
  next.billing.prices.deep = Math.max(0, Math.round(Number(next.billing.prices.deep) || 0));
  next.billing.taxRateBps = Math.max(0, Math.min(5000, Math.round(Number(next.billing.taxRateBps) || 0)));
  next.billing.dailyCapPerUser = Math.max(1, Math.min(1000, Math.round(Number(next.billing.dailyCapPerUser) || 20)));
  next.billing.platformCapPctOfFees = Math.max(0, Math.min(100, Number(next.billing.platformCapPctOfFees) || 0));
  next.billing.platformCapFloorMinor = Math.max(0, Math.round(Number(next.billing.platformCapFloorMinor) || 0));
  next.billing.freeRunsPerMonth = Math.max(0, Math.min(1000, Math.round(Number(next.billing.freeRunsPerMonth) || 0)));
  if (body.billing && (JSON.stringify(body.billing.prices ?? {}) !== '{}' || body.billing.taxRateBps !== undefined || body.billing.freeRunsPerMonth !== undefined) && body.billing.disclosureVersion === undefined && (JSON.stringify(next.billing.prices) !== JSON.stringify(current.billing.prices) || next.billing.taxRateBps !== current.billing.taxRateBps || next.billing.freeRunsPerMonth !== current.billing.freeRunsPerMonth)) next.billing.disclosureVersion = (current.billing.disclosureVersion || 1) + 1;
  next.addon = { ...current.addon, ...(body.addon ?? {}) };
  next.addon.priceMinor = Math.max(0, Math.round(Number(next.addon.priceMinor) || 0));
  next.addon.periodDays = Math.max(1, Math.min(365, Number(next.addon.periodDays) || 30));
  next.addon.freeRuns = Math.max(0, Math.min(1000, Number(next.addon.freeRuns) || 0));
  next.maxStepsPerRun = Math.max(1, Math.min(20, Number(next.maxStepsPerRun) || current.maxStepsPerRun));
  next.maxTokensPerRun = Math.max(1000, Math.min(500_000, Number(next.maxTokensPerRun) || current.maxTokensPerRun));
  setSetting('assist', next);
  audit(req.user!.id, 'agents.settings.update', 'settings', 'assist', { keys: Object.keys(body) });
  res.json({ settings: { ...next, apiKey: next.apiKey ? '••••••••' : '' }, runtime: runtimeStatus() });
});
adminRouter.get('/agents/runs', requirePermission('agents'), (req, res) => res.json({ items: listAgentRuns({ userId: req.query.user ? String(req.query.user) : null, agentKey: req.query.agent ? String(req.query.agent) : null, status: req.query.status ? String(req.query.status) : null, limit: Math.min(200, Number(req.query.limit) || 50) }) }));
adminRouter.get('/agents/runs/:id', requirePermission('agents'), (req, res) => {
  const run = getRun(String(req.params.id));
  const user = findUserById(run.userId);
  res.json({ run, user: user ? toPublicUser(user) : null });
});
adminRouter.post('/agents/runs/:id/cancel', requirePermission('agents'), (req, res) => res.json({ run: cancelRun(String(req.params.id)) }));
adminRouter.post(
  '/agents/run',
  requirePermission('agents'),
  wrap(async (req, res) => {
    const body = validate(z.object({ agent: z.string(), input: z.string().min(1).max(4000) }), req.body);
    res.status(202).json({ run: await startRun(req.user!, body.agent, body.input, { trigger: 'admin', wait: req.query.wait === '1' }) });
  }),
);
adminRouter.get('/agents/policies', requirePermission('agents'), (req, res) => res.json({ items: listPolicies(req.query.all === '1'), forbidden: FORBIDDEN }));
adminRouter.put('/agents/policies', requirePermission('agents'), (req, res) => {
  const body = validate(z.object({ scope: z.enum(['global', 'agent', 'user']), scopeId: z.string().default('*'), rules: z.object({ deny: z.array(z.string()).optional(), requireApproval: z.array(z.string()).optional(), allow: z.array(z.string()).optional(), maxStepsPerRun: z.number().optional(), maxRunsPerDay: z.number().optional() }), note: z.string().max(300).optional().nullable(), pin: z.string().optional() }), req.body);
  assertAdminStepUp(req.user!, body.pin, req);
  const policy = publishPolicy(body.scope, body.scope === 'global' ? '*' : body.scopeId, body.rules, req.user!.id, body.note ?? null);
  audit(req.user!.id, 'agents.policy.publish', 'policy', policy.id, { scope: policy.scope, scopeId: policy.scopeId, version: policy.version });
  res.status(201).json({ policy });
});
adminRouter.get('/agents/approvals', requirePermission('approvals'), (req, res) => res.json({ items: listApprovals({ status: req.query.status ? String(req.query.status) : null, limit: 100 }) }));
adminRouter.post(
  '/agents/approvals/:id/approve',
  requirePermission('approvals'),
  wrap(async (req, res) => {
    const body = validate(z.object({ pin: z.string().optional(), reason: z.string().max(300).optional().nullable() }), req.body ?? {});
    assertAdminStepUp(req.user!, body.pin, req);
    const approval = await decideApproval(req.user!, String(req.params.id), true, body.reason ?? null);
    audit(req.user!.id, 'agents.approval.approve', 'agent_approval', approval.id, { tool: approval.tool });
    res.json({ approval, run: getRun(approval.runId) });
  }),
);
adminRouter.post(
  '/agents/approvals/:id/decline',
  requirePermission('approvals'),
  wrap(async (req, res) => {
    const body = validate(z.object({ reason: z.string().min(2).max(300) }), req.body ?? {});
    const approval = await decideApproval(req.user!, String(req.params.id), false, body.reason);
    audit(req.user!.id, 'agents.approval.decline', 'agent_approval', approval.id, { tool: approval.tool, reason: body.reason });
    res.json({ approval, run: getRun(approval.runId) });
  }),
);

// ---------------------------------------------------------------------------------------------------------------------
// Feature-phone channels: USSD, SMS and Lite settings, recent traffic and a simulator for administrators
// ---------------------------------------------------------------------------------------------------------------------
adminRouter.get('/channels', requirePermission('settings'), (_req, res) => {
  const s = getChannelSettings();
  res.json({ settings: { ...s, ussd: { ...s.ussd, secret: s.ussd.secret ? '••••••••' : '' }, sms: { ...s.sms, secret: s.sms.secret ? '••••••••' : '' } }, ussdSessions: recentUssdSessions(30), sms: recentSms(40), liteUrl: `${config.apiUrl}/lite` });
});
adminRouter.put('/channels/settings', requirePermission('settings'), (req, res) => {
  const current = getChannelSettings();
  const body = req.body ?? {};
  const keep = (given: unknown, cur: string) => (given === undefined || given === '••••••••' ? cur : String(given ?? ''));
  const next = { ussd: { ...current.ussd, ...(body.ussd ?? {}), secret: keep(body.ussd?.secret, current.ussd.secret) }, sms: { ...current.sms, ...(body.sms ?? {}), secret: keep(body.sms?.secret, current.sms.secret) }, lite: { ...current.lite, ...(body.lite ?? {}) } };
  setSetting('channels', next);
  audit(req.user!.id, 'channels.settings.update', 'settings', 'channels', { keys: Object.keys(body) });
  res.json({ settings: { ...next, ussd: { ...next.ussd, secret: next.ussd.secret ? '••••••••' : '' }, sms: { ...next.sms, secret: next.sms.secret ? '••••••••' : '' } } });
});
/** Simulator: drive the real USSD menu for any phone number without an aggregator. */
adminRouter.post('/channels/ussd/simulate', requirePermission('settings'), (req, res) => {
  const body = validate(z.object({ sessionId: z.string().optional(), phone: z.string().min(6), input: z.string().default('') }), req.body);
  const sessionId = body.sessionId || ussdSessionId();
  const reply = ussdRequest({ sessionId, phone: body.phone, text: body.input, provider: 'simulator', fullPath: false });
  res.json({ sessionId, ...reply });
});
adminRouter.post('/channels/sms/simulate', requirePermission('settings'), (req, res) => {
  const body = validate(z.object({ phone: z.string().min(6), text: z.string().min(1) }), req.body);
  res.json({ reply: smsHandle(body.phone, body.text) });
});

// ---------------------------------------------------------------------------------------------------------------------
// Guardian, operating mode and the country capability matrix
// ---------------------------------------------------------------------------------------------------------------------
adminRouter.get('/guardian', requirePermission('reports'), (_req, res) => res.json({ state: getOperatingState(), checks: listGuardianChecks(20) }));
adminRouter.post('/guardian/run', requirePermission('treasury'), (req, res) => {
  const result = runGuardian({ haltOnFailure: req.body?.halt !== false });
  audit(req.user!.id, 'guardian.run', 'ledger', result.id, { ok: result.ok, findings: result.findings.length });
  res.json({ result, state: getOperatingState() });
});
adminRouter.post('/guardian/mode', requirePermission('treasury'), (req, res) => {
  const body = validate(z.object({ mode: z.enum(['normal', 'degraded', 'halted']), reason: z.string().max(300).optional().nullable(), queueIntents: z.boolean().optional(), freezeOffline: z.boolean().optional(), pin: z.string().optional() }), req.body);
  assertAdminStepUp(req.user!, body.pin, req);
  if (body.mode === 'normal') {
    const last = runGuardian({ haltOnFailure: false });
    if (!last.ok) return res.status(409).json({ error: { code: 'guardian_findings', message: 'The ledger still has findings; repair them before returning to normal operation.', details: last.findings } });
  }
  const state = setOperatingMode(body.mode, body.reason ?? null, req.user!.id, { queueIntents: body.queueIntents, freezeOffline: body.freezeOffline });
  audit(req.user!.id, `platform.mode.${body.mode}`, 'settings', 'operating_mode', { reason: body.reason ?? null });
  res.json({ state });
});
adminRouter.get('/capabilities', requirePermission('settings'), (_req, res) => res.json({ items: listCountryCapabilities(), purposeCodes: PURPOSE_CODES }));
adminRouter.get('/capabilities/:country', requirePermission('settings'), (req, res) => res.json({ capabilities: countryCapabilities(String(req.params.country)) }));
adminRouter.put('/capabilities/:country', requirePermission('settings'), (req, res) => {
  const body = validate(z.object({ wallet: z.boolean().optional(), cardCollection: z.boolean().optional(), bankPayout: z.boolean().optional(), mobileMoney: z.boolean().optional(), agentCashOut: z.boolean().optional(), crossBorder: z.boolean().optional(), bitcoin: z.boolean().optional(), stablecoin: z.boolean().optional(), kycProvider: z.string().max(60).optional().nullable(), settlementCurrencies: z.array(z.string().length(3)).optional(), collectionCurrencies: z.array(z.string().length(3)).optional(), maxPerTransaction: z.number().int().min(0).optional(), requiredDisclosures: z.array(z.string()).optional(), purposeCodes: z.array(z.string()).optional(), nationalSwitch: z.object({ required: z.boolean(), connector: z.string().nullable() }).optional(), licencePhase: z.enum(['aggregator', 'full']).optional(), notes: z.string().max(500).optional().nullable() }), req.body);
  const caps = setCountryCapabilities(String(req.params.country), body as any);
  audit(req.user!.id, 'capabilities.update', 'country', caps.country, { keys: Object.keys(body) });
  res.json({ capabilities: caps });
});
adminRouter.get('/intents', requirePermission('transactions'), (req, res) => res.json({ items: listIntents({ merchantUserId: req.query.merchant ? String(req.query.merchant) : null, status: req.query.status ? String(req.query.status) : null, limit: Math.min(200, Number(req.query.limit) || 50) }) }));
adminRouter.get('/intents/:id', requirePermission('transactions'), (req, res) => res.json(intentTimeline(String(req.params.id))));

// Refund objects: MANUAL / PENDING processor refunds are confirmed or refused by operations once the processor reports.
adminRouter.get('/refunds', requirePermission('transactions'), (req, res) => res.json({ items: listRefunds({ merchantUserId: req.query.merchant ? String(req.query.merchant) : null, status: req.query.status ? String(req.query.status) : null, limit: Math.min(200, Number(req.query.limit) || 50) }) }));
adminRouter.post('/refunds/:id/resolve', requirePermission('treasury'), wrap(async (req, res) => {
  const body = validate(z.object({ outcome: z.enum(['succeeded', 'failed']), note: z.string().max(300).optional().nullable() }), req.body);
  const refund = await resolveRefund(String(req.params.id), body.outcome, req.user!, body.note ?? null);
  audit(req.user!.id, 'refund.resolve', 'refund', refund.id, { outcome: body.outcome, note: body.note ?? null });
  res.json({ refund });
}));
