/**
 * Tool gateway: the only path from an agent to the platform. Every tool is a typed function over an existing service,
 * with a role scope, an optional admin permission, a side-effect flag and (for the few administrative actions) a
 * checker approval. No tool can move money, mint e-money, unfreeze a wallet, change a corridor or create API keys:
 * those are not tools at all. Tool results are returned to the model as data.
 */
import { z } from 'zod';
import { getDb } from '../../db';
import { now } from '../../lib/ids';
import type { Role } from '@bitripay/shared';
import type { AdminPermission } from '../../middleware/permissions';
import type { UserRow } from '../users';
import { toPublicUser } from '../users';
import { listWallets, toWallet } from '../wallets';
import { listTransactions, getTransaction, toTransaction, calculateFee } from '../ledger';
import { buildStatement } from '../statements';
import { listRoutes, getRoute, quoteRoute } from '../routing';
import { listCurrencies, getCurrency, rateFreshness } from '../currencies';
import { getLimits } from '../settings';
import { listNotifications } from '../notifications';
import { listTickets, createTicket } from '../support';
import { listPages } from '../cms';
import { listPosts } from '../blog';
import { merchantStats, listSettlements, listWebhookDeliveries } from '../merchant';
import { queueFor } from '../payouts';
import { listPasskeys } from '../webauthn';
import { emoneyOverview, freezeWallet, reconcileReserves } from '../emoney';
import { liquidityOverview } from '../liquidity';
import { listCorridors } from '../corridors';
import { listKyc } from '../kyc';
import { listRiskEvents } from '../risk';
import { goLiveChecklist } from '../goLive';
import { verifyEventChain } from '../events';
import { notify } from '../notifications';
import { ROUTE_STAGES } from '../routeLifecycle';

export interface ToolContext {
  /** The account holder the agent works for. */
  user: UserRow;
  /** The human who executes an approved administrative action (the checker); defaults to the account holder. */
  actor: UserRow;
  runId: string;
  agentKey: string;
}

export interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  roles: Role[];
  permission?: AdminPermission;
  /** Reads never need approval; side-effecting tools are visible in the run log and may require a checker. */
  sideEffect: boolean;
  requiresApproval?: boolean;
  schema: S;
  /** Short human summary of an invocation, used on approval cards. */
  summarize?: (input: z.output<S>) => string;
  run: (ctx: ToolContext, input: z.output<S>) => unknown | Promise<unknown>;
}

const EVERYONE: Role[] = ['user', 'merchant', 'agent', 'admin'];
const ADMIN: Role[] = ['admin'];
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`;
const today = () => new Date().toISOString().slice(0, 10);

function tool<S extends z.ZodTypeAny>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/** Actions the account holder must confirm in the app; the agent only prepares them. */
export const PROPOSABLE_ACTIONS = ['send', 'move', 'add_money', 'withdraw', 'exchange', 'request', 'statement', 'topup', 'bill', 'kyc', 'security'] as const;
const ACTION_PATHS: Record<(typeof PROPOSABLE_ACTIONS)[number], string> = { send: '/app/send', move: '/app/move', add_money: '/app/add-money', withdraw: '/app/withdraw', exchange: '/app/exchange', request: '/app/requests', statement: '/app/statements', topup: '/app/topup', bill: '/app/bills', kyc: '/app/settings?tab=kyc', security: '/app/settings?tab=security' };

export const TOOLS: ToolDef<any>[] = [
  tool({
    name: 'wallets.balances',
    description: 'Balances of every wallet of the account holder, with classification (e-money, merchant, agent float, sandbox) and frozen state. Amounts in minor units.',
    roles: EVERYONE,
    sideEffect: false,
    schema: z.object({}),
    run: (ctx) => ({ wallets: listWallets(ctx.user.id).map((w) => toWallet(w, ctx.user)) }),
  }),
  tool({
    name: 'transactions.list',
    description: 'Recent transactions of the account holder. Filter by direction (in/out), currency, free text, and date range.',
    roles: EVERYONE,
    sideEffect: false,
    schema: z.object({ direction: z.enum(['in', 'out']).optional(), currency: z.string().length(3).optional(), search: z.string().max(80).optional(), from: isoDate.optional(), to: isoDate.optional(), limit: z.number().int().min(1).max(50).default(20) }),
    run: (ctx, i) => {
      const r = listTransactions({ userId: ctx.user.id, direction: i.direction, currency: i.currency?.toUpperCase(), search: i.search, from: i.from, to: i.to ? `${i.to}T23:59:59.999Z` : undefined, page: 1, pageSize: i.limit });
      return { total: r.total, items: r.items.map((t) => ({ id: t.id, type: t.type, status: t.status, amount: t.amount, fee: t.fee, currency: t.currency, direction: t.direction, counterparty: t.counterparty?.fullName ?? null, description: t.note, createdAt: t.createdAt })) };
    },
  }),
  tool({
    name: 'transactions.get',
    description: 'One transaction of the account holder with fee, rate and metadata.',
    roles: EVERYONE,
    sideEffect: false,
    schema: z.object({ id: z.string() }),
    run: (ctx, i) => {
      const tx = getTransaction(i.id);
      if (!tx || (tx.sender_user_id !== ctx.user.id && tx.receiver_user_id !== ctx.user.id)) return { error: 'not_found' };
      return { transaction: toTransaction(tx, ctx.user.id) };
    },
  }),
  tool({
    name: 'statements.build',
    description: 'Build a bank-grade statement for one currency and period (numbered, hashed, running balances). Returns totals and the first lines; the full statement is available under Statements.',
    roles: EVERYONE,
    sideEffect: false,
    schema: z.object({ currency: z.string().length(3), from: isoDate.default(monthStart), to: isoDate.default(today) }),
    run: (ctx, i) => {
      const s = buildStatement(ctx.user, i.currency.toUpperCase(), i.from, i.to, `agent:${ctx.agentKey}`);
      return { id: s.id, number: s.number, period: s.period, currency: s.account.currency, opening: s.opening, closing: s.closing, totalCredits: s.totalCredits, totalDebits: s.totalDebits, entryCount: s.entryCount, hash: s.hash, verifyUrl: s.verifyUrl, lines: s.lines.slice(0, 15), link: '/app/statements' };
    },
  }),
  tool({
    name: 'fees.quote',
    description: 'Fee for a transaction type (transfer, withdrawal, card_deposit, mobile_money_deposit, bank_deposit, exchange, remittance, merchant_payment) and amount in major units.',
    roles: EVERYONE,
    sideEffect: false,
    schema: z.object({ type: z.string().default('transfer'), amount: z.number().positive(), currency: z.string().length(3) }),
    run: (_ctx, i) => {
      const c = getCurrency(i.currency.toUpperCase());
      const minor = Math.round(i.amount * 10 ** c.decimals);
      const fee = calculateFee(i.type, minor, c.code);
      return { type: i.type, amount: minor, fee, total: minor + fee, currency: c.code, decimals: c.decimals };
    },
  }),
  tool({
    name: 'routes.quote',
    description: 'Quote for moving money from one currency to another (fees, FX margin, guaranteed recipient amount, delivery time, receiving currency options). Amount in major units.',
    roles: EVERYONE,
    sideEffect: false,
    schema: z.object({ amount: z.number().positive(), currency: z.string().length(3), targetCurrency: z.string().length(3), sourceMethod: z.enum(['wallet', 'card', 'mobile_money', 'bank']).default('wallet') }),
    run: (ctx, i) => {
      const c = getCurrency(i.currency.toUpperCase());
      const q = quoteRoute(Math.round(i.amount * 10 ** c.decimals), c.code, i.targetCurrency.toUpperCase(), i.sourceMethod, undefined, { userId: ctx.user.id, country: ctx.user.country, persistQuote: false });
      return { quote: q };
    },
  }),
  tool({
    name: 'routes.list',
    description: 'Money routes (cross-currency or cross-rail transfers) of the account holder with their lifecycle stage.',
    roles: EVERYONE,
    sideEffect: false,
    schema: z.object({ openOnly: z.boolean().default(false), limit: z.number().int().min(1).max(30).default(10) }),
    run: (ctx, i) => {
      const terminal = new Set(['SETTLED', 'EXPIRED', 'FAILED', 'REVERSED', 'REFUNDED']);
      const items = listRoutes(ctx.user.id).filter((r) => !i.openOnly || !terminal.has(r.stage)).slice(0, i.limit);
      return { items: items.map((r) => ({ id: r.id, amount: r.amount, currency: r.currency, targetCurrency: r.targetCurrency, stage: r.stage, stageLabel: r.stageLabel, destination: r.destination, createdAt: (r as any).createdAt })) };
    },
  }),
  tool({
    name: 'routes.get',
    description: 'Full detail of one money route: quote, stages with timestamps, evidence and confirmation method.',
    roles: EVERYONE,
    sideEffect: false,
    schema: z.object({ id: z.string() }),
    run: (ctx, i) => ({ route: getRoute(ctx.user.id, i.id) }),
  }),
  tool({
    name: 'rates.list',
    description: 'Enabled currencies with their rate to the base currency and how fresh the rates are.',
    roles: EVERYONE,
    sideEffect: false,
    schema: z.object({}),
    run: () => ({ freshness: rateFreshness(), currencies: listCurrencies(true).map((c) => ({ code: c.code, name: c.name, symbol: c.symbol, decimals: c.decimals, rateToBase: c.rateToBase, updatedAt: c.rateUpdatedAt })) }),
  }),
  tool({
    name: 'profile.summary',
    description: 'Account profile and protection: role, KYC status, limits, PIN set, two-factor, passkeys, loud alerts, language, country.',
    roles: EVERYONE,
    sideEffect: false,
    schema: z.object({}),
    run: (ctx) => {
      const u = ctx.user;
      const limits = getLimits();
      const loud = (getDb().prepare('SELECT loud_alerts FROM users WHERE id = ?').get(u.id) as any)?.loud_alerts ?? 1;
      return { profile: { ...toPublicUser(u), email: u.email, phone: u.phone, language: u.language, kycStatus: u.kyc_status, memberSince: u.created_at }, protection: { pinSet: !!u.pin_hash, twoFactor: !!u.two_factor_enabled, passkeys: listPasskeys(u.id).length, loudAlerts: loud === 1, emailVerified: !!u.email_verified, phoneVerified: !!u.phone_verified }, limits: u.kyc_status === 'verified' ? limits.verified : limits.unverified };
    },
  }),
  tool({
    name: 'notifications.recent',
    description: 'Latest notifications for the account holder (payments, alerts, security, approvals).',
    roles: EVERYONE,
    sideEffect: false,
    schema: z.object({ limit: z.number().int().min(1).max(30).default(10) }),
    run: (ctx, i) => ({ items: listNotifications(ctx.user.id, i.limit) }),
  }),
  tool({
    name: 'knowledge.search',
    description: 'Search BitriPay pages, policies and guides (fees, safeguarding, KYC, refunds, corridors, mobile money). Returns titles and matching excerpts.',
    roles: EVERYONE,
    sideEffect: false,
    schema: z.object({ query: z.string().min(2).max(120), limit: z.number().int().min(1).max(8).default(5) }),
    run: (_ctx, i) => ({ results: searchKnowledge(i.query, i.limit) }),
  }),
  tool({
    name: 'actions.propose',
    description: 'Prepare an action for the account holder to confirm themselves in the app (send, move, add_money, withdraw, exchange, request, statement, topup, bill, kyc, security). Never executes anything. Include the amounts and recipient you gathered.',
    roles: EVERYONE,
    sideEffect: false,
    schema: z.object({ type: z.enum(PROPOSABLE_ACTIONS), title: z.string().min(3).max(120), params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}), why: z.string().max(300).optional() }),
    run: (_ctx, i) => {
      const query = Object.entries(i.params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
      const base = ACTION_PATHS[i.type];
      return { action: { type: i.type, title: i.title, params: i.params, why: i.why ?? null, link: query ? `${base}${base.includes('?') ? '&' : '?'}${query}` : base, confirmation: 'The account holder confirms this in the app with PIN, passkey or biometrics. Nothing has been executed.' } };
    },
  }),
  tool({
    name: 'memory.remember',
    description: 'Store a preference or fact the account holder explicitly asked you to remember. Never store secrets, PINs, passwords or card numbers.',
    roles: EVERYONE,
    sideEffect: true,
    schema: z.object({ kind: z.enum(['preference', 'fact', 'outcome']).default('preference'), content: z.string().min(3).max(400) }),
    summarize: (i) => `Remember: ${i.content}`,
    run: (ctx, i) => {
      if (/\b(pin|password|otp|cvv|passcode)\b/i.test(i.content) && /\d{3,}/.test(i.content)) return { error: 'refused', reason: 'Secrets are never stored.' };
      const id = `mem_${Math.random().toString(36).slice(2, 12)}`;
      getDb().prepare('INSERT INTO agent_memories (id, user_id, agent_key, kind, content, source_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, ctx.user.id, ctx.agentKey, i.kind, i.content.trim(), ctx.runId, now());
      return { memory: { id, kind: i.kind, content: i.content.trim() } };
    },
  }),
  tool({
    name: 'support.tickets',
    description: "The account holder's support tickets and their status.",
    roles: EVERYONE,
    sideEffect: false,
    schema: z.object({ limit: z.number().int().min(1).max(20).default(10) }),
    run: (ctx, i) => listTickets(ctx.user, { page: 1, pageSize: i.limit }),
  }),
  tool({
    name: 'support.create_ticket',
    description: 'Open a support ticket on behalf of the account holder when a human needs to look at something. Summarise the problem and what was already checked.',
    roles: EVERYONE,
    sideEffect: true,
    schema: z.object({ subject: z.string().min(4).max(120), body: z.string().min(10).max(2000), category: z.string().max(40).default('general') }),
    summarize: (i) => `Open ticket: ${i.subject}`,
    run: (ctx, i) => ({ ticket: createTicket(ctx.user, { subject: i.subject, body: `${i.body}\n\n(Opened by the ${ctx.agentKey} agent on the account holder's behalf.)`, category: i.category }) }),
  }),
  // Merchant
  tool({
    name: 'merchant.stats',
    description: 'Merchant sales for the last 30 days by currency, method and day, plus open payment links.',
    roles: ['merchant', 'admin'],
    sideEffect: false,
    schema: z.object({}),
    run: (ctx) => {
      const s = merchantStats(ctx.user);
      return { byCurrency: s.byCurrency, byMethod: s.byMethod, daily: s.daily.slice(-30), openPaymentRequests: s.openPaymentRequests };
    },
  }),
  tool({
    name: 'merchant.settlements',
    description: 'Settlement batches paid to the merchant bank account.',
    roles: ['merchant', 'admin'],
    sideEffect: false,
    schema: z.object({ limit: z.number().int().min(1).max(20).default(10) }),
    run: (ctx, i) => ({ items: (listSettlements(ctx.user.id) as any[]).slice(0, i.limit) }),
  }),
  tool({
    name: 'merchant.payment_requests',
    description: 'Open payment links and QR requests of the merchant.',
    roles: ['merchant', 'agent', 'user', 'admin'],
    sideEffect: false,
    schema: z.object({ status: z.enum(['open', 'paid', 'expired', 'cancelled']).default('open'), limit: z.number().int().min(1).max(30).default(10) }),
    run: (ctx, i) => ({ items: getDb().prepare('SELECT code, kind, amount, currency, description, status, expires_at, created_at FROM payment_requests WHERE requester_user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?').all(ctx.user.id, i.status, i.limit) }),
  }),
  tool({
    name: 'merchant.webhooks',
    description: 'Recent webhook deliveries to the merchant endpoint and how many failed.',
    roles: ['merchant', 'admin'],
    sideEffect: false,
    schema: z.object({ limit: z.number().int().min(1).max(30).default(15) }),
    run: (ctx, i) => {
      const items = listWebhookDeliveries(ctx.user.id, i.limit) as any[];
      return { failed: items.filter((d) => d.status === 'failed').length, items };
    },
  }),
  // Cash agents
  tool({
    name: 'agent.queue',
    description: 'Payouts waiting for this cash agent to execute, with amounts, recipients (masked) and stages.',
    roles: ['agent', 'admin'],
    sideEffect: false,
    schema: z.object({}),
    run: (ctx) => ({ items: queueFor({ agent: ctx.user }).map((p) => ({ id: p.id, reference: p.reference, amount: p.amount, currency: p.currency, stage: p.stage, recipient: p.recipientMasked, operator: p.operatorName })) }),
  }),
  tool({
    name: 'agent.stats',
    description: 'Cash-agent activity: cash-in/cash-out counts and commissions in the last 30 days.',
    roles: ['agent', 'admin'],
    sideEffect: false,
    schema: z.object({}),
    run: (ctx) => {
      const since = new Date(Date.now() - 30 * 86400_000).toISOString();
      const rows = getDb().prepare("SELECT type, currency, COUNT(*) c, COALESCE(SUM(amount),0) volume, COALESCE(SUM(fee),0) fees FROM transactions WHERE (sender_user_id = ? OR receiver_user_id = ?) AND status = 'completed' AND created_at >= ? GROUP BY type, currency").all(ctx.user.id, ctx.user.id, since);
      const commissions = getDb().prepare("SELECT currency, COALESCE(SUM(amount),0) total, COUNT(*) c FROM transactions WHERE receiver_user_id = ? AND type = 'commission' AND status = 'completed' AND created_at >= ? GROUP BY currency").all(ctx.user.id, since);
      return { since, byType: rows, commissions };
    },
  }),
  // Administrators (read)
  tool({
    name: 'admin.emoney_overview',
    description: 'E-money programmes with reserve position (cleared reserves, liabilities, headroom, coverage, status), pools and promotional liability.',
    roles: ADMIN,
    permission: 'reports',
    sideEffect: false,
    schema: z.object({}),
    run: () => {
      const o = emoneyOverview();
      return { programmes: o.programmes.map((p: any) => ({ id: p.id, name: p.name, currency: p.currency, type: p.type, status: p.status, position: p.position })), pools: o.pools.length, promotionalLiability: o.promotionalLiability, lastReconciliation: o.lastReconciliation.slice(0, 5) };
    },
  }),
  tool({
    name: 'admin.liquidity',
    description: 'Payout float per account and currency, with shortfalls against pending payouts.',
    roles: ADMIN,
    permission: 'approvals',
    sideEffect: false,
    schema: z.object({}),
    run: () => liquidityOverview(),
  }),
  tool({
    name: 'admin.corridors',
    description: 'Corridors with status, readiness, licence expiry and compliance gaps.',
    roles: ADMIN,
    permission: 'approvals',
    sideEffect: false,
    schema: z.object({}),
    run: () => ({ items: listCorridors().map((c) => ({ id: c.id, from: `${c.sourceCountry ?? '*'}/${c.sourceCurrency}`, to: `${c.destCountry}/${c.destCurrency}`, rail: c.rail, status: c.status, ready: c.readiness.ready, missing: c.readiness.missing, warnings: c.readiness.warnings, licenceExpiresAt: c.licenceExpiresAt, maxAmount: c.maxAmount })) }),
  }),
  tool({
    name: 'admin.routes_stuck',
    description: 'Money routes that have stayed in an open stage longer than a threshold, ordered by amount.',
    roles: ADMIN,
    permission: 'transactions',
    sideEffect: false,
    schema: z.object({ olderThanMinutes: z.number().int().min(1).max(100_000).default(120), limit: z.number().int().min(1).max(50).default(20) }),
    run: (_ctx, i) => {
      const terminal = ['SETTLED', 'EXPIRED', 'FAILED', 'REVERSED', 'REFUNDED', 'CREATED', 'QUOTED'];
      const cutoff = new Date(Date.now() - i.olderThanMinutes * 60_000).toISOString();
      const rows = getDb().prepare(`SELECT id, user_id, amount, currency, target_currency, stage, updated_at, created_at FROM money_routes WHERE stage NOT IN (${terminal.map(() => '?').join(',')}) AND COALESCE(updated_at, created_at) < ? ORDER BY amount DESC LIMIT ?`).all(...terminal, cutoff, i.limit) as any[];
      return { cutoff, count: rows.length, items: rows.map((r) => ({ id: r.id, userId: r.user_id, amount: r.amount, currency: r.currency, targetCurrency: r.target_currency, stage: r.stage, since: r.updated_at ?? r.created_at })), stages: ROUTE_STAGES };
    },
  }),
  tool({
    name: 'admin.kyc_queue',
    description: 'KYC submissions waiting for review, oldest first.',
    roles: ADMIN,
    permission: 'kyc',
    sideEffect: false,
    schema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
    run: (_ctx, i) => {
      const r = listKyc('pending', 1, i.limit);
      return { total: r.total, items: r.items.map((k: any) => ({ id: k.id, userId: k.userId, level: k.level ?? null, submittedAt: k.createdAt ?? k.submittedAt })) };
    },
  }),
  tool({
    name: 'admin.risk_events',
    description: 'Recent risk, velocity and sanctions events.',
    roles: ADMIN,
    permission: 'reports',
    sideEffect: false,
    schema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
    run: (_ctx, i) => listRiskEvents(1, i.limit),
  }),
  tool({
    name: 'admin.go_live',
    description: 'Go-live checklist: processors, rate providers, corridors, e-money issuer and reserves, devices.',
    roles: ADMIN,
    permission: 'settings',
    sideEffect: false,
    schema: z.object({}),
    run: () => goLiveChecklist(),
  }),
  tool({
    name: 'admin.event_chain_verify',
    description: 'Verify the hash chain of the event log.',
    roles: ADMIN,
    permission: 'admins',
    sideEffect: false,
    schema: z.object({}),
    run: () => verifyEventChain(),
  }),
  tool({
    name: 'admin.rate_status',
    description: 'Rate provider freshness and the enabled currencies.',
    roles: ADMIN,
    permission: 'settings',
    sideEffect: false,
    schema: z.object({}),
    run: () => ({ freshness: rateFreshness(), currencies: listCurrencies(true).map((c) => ({ code: c.code, rateToBase: c.rateToBase, updatedAt: c.rateUpdatedAt, source: c.rateSource })) }),
  }),
  tool({
    name: 'admin.users_search',
    description: 'Find accounts by name, tag, email or phone.',
    roles: ADMIN,
    permission: 'users',
    sideEffect: false,
    schema: z.object({ query: z.string().min(2).max(80), limit: z.number().int().min(1).max(20).default(10) }),
    run: (_ctx, i) => {
      const q = `%${i.query.toLowerCase()}%`;
      return { items: (getDb().prepare('SELECT id, tag, full_name, role, email, phone, kyc_status, status, created_at FROM users WHERE is_system = 0 AND (lower(full_name) LIKE ? OR lower(tag) LIKE ? OR lower(email) LIKE ? OR phone LIKE ?) LIMIT ?').all(q, q, q, q, i.limit) as any[]).map((u) => ({ id: u.id, tag: u.tag, name: u.full_name, role: u.role, email: u.email, phone: u.phone, kycStatus: u.kyc_status, status: u.status, createdAt: u.created_at })) };
    },
  }),
  tool({
    name: 'admin.user_summary',
    description: 'One account with wallets, recent transactions and risk events.',
    roles: ADMIN,
    permission: 'users',
    sideEffect: false,
    schema: z.object({ userId: z.string() }),
    run: (_ctx, i) => {
      const u = getDb().prepare('SELECT * FROM users WHERE id = ?').get(i.userId) as UserRow | undefined;
      if (!u) return { error: 'not_found' };
      const tx = listTransactions({ userId: u.id, page: 1, pageSize: 10 });
      return { user: { ...toPublicUser(u), email: u.email, phone: u.phone, kycStatus: u.kyc_status, status: u.status, createdAt: u.created_at }, wallets: listWallets(u.id).map((w) => toWallet(w, u)), recentTransactions: tx.items.map((t) => ({ id: t.id, type: t.type, amount: t.amount, currency: t.currency, status: t.status, createdAt: t.createdAt })), riskEvents: getDb().prepare('SELECT kind, severity, details, created_at FROM risk_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 5').all(u.id) };
    },
  }),
  tool({
    name: 'admin.support_open',
    description: 'Open support tickets and unanswered live-chat conversations.',
    roles: ADMIN,
    permission: 'support',
    sideEffect: false,
    schema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
    run: (_ctx, i) => ({ tickets: getDb().prepare("SELECT id, user_id, subject, category, priority, status, created_at FROM support_tickets WHERE status = 'open' ORDER BY created_at ASC LIMIT ?").all(i.limit), openCount: (getDb().prepare("SELECT COUNT(*) c FROM support_tickets WHERE status = 'open'").get() as any).c }),
  }),
  tool({
    name: 'admin.usage',
    description: 'Agent runs, tokens and cost (ACU) this month by agent and model.',
    roles: ADMIN,
    permission: 'reports',
    sideEffect: false,
    schema: z.object({}),
    run: () => ({ month: new Date().toISOString().slice(0, 7), byAgent: getDb().prepare("SELECT agent_key, model, SUM(runs) runs, SUM(tokens_in) tokens_in, SUM(tokens_out) tokens_out, SUM(cost_micros) cost_micros, SUM(acu) acu FROM agent_usage WHERE day >= ? GROUP BY agent_key, model ORDER BY acu DESC").all(monthStart()) }),
  }),
  // Administrators (act, under checker approval)
  tool({
    name: 'admin.freeze_wallet',
    description: 'Freeze one wallet of an account (blocks debits) for a stated reason. Requires a second administrator to approve; unfreezing is never available to agents.',
    roles: ADMIN,
    permission: 'users',
    sideEffect: true,
    requiresApproval: true,
    schema: z.object({ userId: z.string(), currency: z.string().length(3), reason: z.string().min(8).max(300) }),
    summarize: (i) => `Freeze ${i.currency.toUpperCase()} wallet of ${i.userId}: ${i.reason}`,
    run: (ctx, i) => ({ wallet: toWallet(freezeWallet(i.userId, i.currency.toUpperCase(), ctx.actor, `[agent:${ctx.agentKey}] ${i.reason}`, true)) }),
  }),
  tool({
    name: 'admin.reconcile_reserves',
    description: 'Run the reserve reconciliation for every e-money programme now (may suspend a programme in breach). Requires approval.',
    roles: ADMIN,
    permission: 'treasury',
    sideEffect: true,
    requiresApproval: true,
    schema: z.object({ reason: z.string().min(4).max(300) }),
    summarize: (i) => `Run reserve reconciliation: ${i.reason}`,
    run: (ctx) => ({ reconciliations: reconcileReserves(`agent:${ctx.agentKey}:${ctx.actor.id}`).map((r: any) => ({ programmeId: r.programmeId, status: r.status, headroom: r.position?.headroom, coverage: r.position?.coverage })) }),
  }),
  tool({
    name: 'admin.notify_admins',
    description: 'Send an in-app (and loud, if configured) notification to every active administrator.',
    roles: ADMIN,
    permission: 'support',
    sideEffect: true,
    schema: z.object({ title: z.string().min(3).max(80), body: z.string().min(3).max(500), loud: z.boolean().default(false) }),
    summarize: (i) => `Notify administrators: ${i.title}`,
    run: (ctx, i) => {
      const admins = getDb().prepare("SELECT id FROM users WHERE role = 'admin' AND is_system = 0 AND status = 'active'").all() as { id: string }[];
      for (const a of admins) notify(a.id, i.title, i.body, { kind: i.loud ? 'reserve_breach' : 'agent', agent: ctx.agentKey, runId: ctx.runId });
      return { notified: admins.length };
    },
  }),
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** JSON schema for the model, derived from the zod (v3) schema of each tool: objects, strings, numbers, booleans, enums, records, unions, defaults. */
export function toolJsonSchema(t: ToolDef): Record<string, unknown> {
  return zodToJson(t.schema);
}
function zodToJson(schema: any): Record<string, unknown> {
  const def = schema?._def;
  if (!def) return {};
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries<any>(shape)) {
        properties[k] = zodToJson(v);
        const tn = v?._def?.typeName;
        if (tn !== 'ZodOptional' && tn !== 'ZodDefault') required.push(k);
      }
      return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
    }
    case 'ZodString': {
      const out: Record<string, unknown> = { type: 'string' };
      for (const c of def.checks ?? []) {
        if (c.kind === 'min') out.minLength = c.value;
        if (c.kind === 'max') out.maxLength = c.value;
        if (c.kind === 'length') { out.minLength = c.value; out.maxLength = c.value; }
        if (c.kind === 'regex') out.pattern = String(c.regex.source);
      }
      return out;
    }
    case 'ZodNumber': {
      const out: Record<string, unknown> = { type: 'number' };
      for (const c of def.checks ?? []) {
        if (c.kind === 'int') out.type = 'integer';
        if (c.kind === 'min') out.minimum = c.value;
        if (c.kind === 'max') out.maximum = c.value;
      }
      return out;
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return { type: 'string', enum: def.values };
    case 'ZodLiteral':
      return { const: def.value };
    case 'ZodOptional':
    case 'ZodNullable':
      return zodToJson(def.innerType);
    case 'ZodDefault': {
      const dv = typeof def.defaultValue === 'function' ? def.defaultValue() : def.defaultValue;
      return { ...zodToJson(def.innerType), default: dv };
    }
    case 'ZodRecord':
      return { type: 'object', additionalProperties: zodToJson(def.valueType) };
    case 'ZodUnion':
      return { anyOf: def.options.map((o: any) => zodToJson(o)) };
    case 'ZodArray':
      return { type: 'array', items: zodToJson(def.type) };
    default:
      return {};
  }
}

/** Text search over CMS pages and published articles; excerpts around the first match. */
export function searchKnowledge(query: string, limit = 5): { title: string; slug: string; kind: 'page' | 'article'; excerpt: string; link: string }[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2).slice(0, 6);
  const score = (title: string, text: string) => {
    const lt = text.toLowerCase();
    const ltitle = title.toLowerCase();
    return terms.reduce((n, t) => n + (ltitle.includes(t) ? 3 : 0) + Math.min(3, lt.split(t).length - 1), 0);
  };
  const excerpt = (text: string) => {
    const plain = text.replace(/[#*_>`|]/g, ' ').replace(/\s+/g, ' ');
    const idx = terms.map((t) => plain.toLowerCase().indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    return plain.slice(Math.max(0, idx - 80), idx + 240).trim();
  };
  const out: { title: string; slug: string; kind: 'page' | 'article'; excerpt: string; link: string; s: number }[] = [];
  for (const p of listPages(true)) {
    const s = score(p.title, p.content);
    if (s) out.push({ title: p.title, slug: p.slug, kind: 'page', excerpt: excerpt(p.content), link: `/legal/${p.slug}`, s });
  }
  try {
    for (const a of listPosts({ status: 'published', q: query, pageSize: limit }).items) {
      const s = score(a.title, `${a.excerpt} ${a.tags.join(' ')}`) + 1;
      out.push({ title: a.title, slug: a.slug, kind: 'article', excerpt: a.excerpt, link: `/blog/${a.slug}`, s });
    }
  } catch {
    /* blog optional */
  }
  return out.sort((a, b) => b.s - a.s).slice(0, limit).map(({ s: _s, ...r }) => r);
}

export function toolCatalogue(role: Role, permissions: (p: AdminPermission) => boolean) {
  return TOOLS.filter((t) => t.roles.includes(role) && (!t.permission || permissions(t.permission))).map((t) => ({ name: t.name, description: t.description, sideEffect: t.sideEffect, requiresApproval: !!t.requiresApproval, permission: t.permission ?? null }));
}

