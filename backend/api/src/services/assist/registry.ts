/**
 * Agent registry: every command-centre agent is declared here with its charter, the tools it may call, the roles that
 * can run it and its budget. Agents are configuration over the tool gateway; adding one never adds a new way to move money.
 */
import type { Role } from '@bitripay/shared';
import { MERCHANT_CLASS_ROLES } from '@bitripay/shared';

export interface AgentDef {
  key: string;
  name: string;
  icon: string;
  /** Roles whose command centre lists this agent. */
  roles: Role[];
  /** One-line purpose shown in the picker. */
  tagline: string;
  /** Charter placed verbatim in the system prompt: purpose, boundaries, tone. */
  charter: string;
  tools: string[];
  /** Prompt suggestions shown as chips. */
  suggestions: Partial<Record<Role, string[]>> & { all?: string[] };
  budget: { maxSteps: number; maxTokens: number };
  /** System agents run on a schedule for administrators and report findings. */
  schedule?: 'daily';
  /** Agent-mesh registry id (PR-xxx) for agents bound to surface events. */
  registryId?: string;
  /** Canonical names from the operating-system contract that map onto this agent. */
  aliases?: string[];
  /** Surface events this agent is bound to (see assist/bindings). */
  bindings?: string[];
  /** Deterministic tool plan used when no model is available (rule-based, platform-funded). */
  plan?: (input: string, context: Record<string, unknown> | null) => { tool: string; input: Record<string, unknown> }[] | null;
}

const READ_TOOLS = [
  'wallets.balances',
  'transactions.list',
  'transactions.get',
  'routes.list',
  'routes.get',
  'rates.list',
  'fees.quote',
  'routes.quote',
  'profile.summary',
  'notifications.recent',
  'knowledge.search',
];
const PERSONAL_TOOLS = [...READ_TOOLS, 'statements.build', 'actions.propose', 'memory.remember', 'support.tickets', 'support.create_ticket'];
const MERCHANT_TOOLS = ['merchant.stats', 'merchant.settlements', 'merchant.payment_requests', 'merchant.webhooks'];
const CASH_AGENT_TOOLS = ['agent.queue', 'agent.stats'];
const ADMIN_READ = [
  'admin.emoney_overview',
  'admin.liquidity',
  'admin.corridors',
  'admin.routes_stuck',
  'admin.kyc_queue',
  'admin.risk_events',
  'admin.go_live',
  'admin.event_chain_verify',
  'admin.rate_status',
  'admin.users_search',
  'admin.user_summary',
  'admin.support_open',
  'admin.usage',
];
const ADMIN_ACT = ['admin.freeze_wallet', 'admin.reconcile_reserves', 'admin.notify_admins'];

const EVERYONE: Role[] = ['user', ...MERCHANT_CLASS_ROLES, 'agent', 'admin'];

const ctxStr = (c: Record<string, unknown> | null, k: string) => (c && typeof c[k] === 'string' ? (c[k] as string) : null);
const payload = (c: Record<string, unknown> | null) => (c && typeof c.payload === 'object' && c.payload ? (c.payload as Record<string, unknown>) : {});

/** The operations agent mesh: bound to surface events, shadow-first, never a way to move money. */
export const MESH_AGENTS: AgentDef[] = [
  {
    key: 'fraud_scorer',
    registryId: 'PR-F01',
    aliases: ['FraudScorer'],
    name: 'Fraud Scorer',
    icon: '🛡️',
    roles: ['admin'],
    tagline: 'Explains every risk score and the rule that decided',
    charter: `You are the Fraud Scorer (PR-F01). The deterministic scorer already decided; you explain its factors, spot patterns across recent scores and recommend policy tuning. You never override a block, clear a hit or move money. Platform-funded: the account holder never pays for this.`,
    tools: ['fraud.explain', 'compliance.cases', 'admin.risk_events', 'admin.user_summary', 'admin.notify_admins'],
    suggestions: { admin: ['Why was the last movement blocked?', 'Which factors fire most this week?'] },
    budget: { maxSteps: 6, maxTokens: 20_000 },
    bindings: ['transaction.fraud_scored'],
    plan: (_i, c) => [
      { tool: 'fraud.explain', input: { ...(ctxStr(payload(c), 'userId') ? { userId: ctxStr(payload(c), 'userId') } : {}), limit: 10 } },
      { tool: 'compliance.cases', input: { limit: 10 } },
    ],
  },
  {
    key: 'retry_surgeon',
    registryId: 'PR-E02',
    aliases: ['RetryOwner'],
    name: 'Retry Surgeon',
    icon: '🩺',
    roles: ['admin'],
    tagline: 'Owns the AMBIGUOUS window: inquire, never re-push',
    charter: `You are the Retry Surgeon (PR-E02). When a push-rail attempt ends UNKNOWN you own the ambiguity window: read the timeline, run the recovery (inquiries only, idempotent per the operator playbook) and report what is still uncertain. You never re-emit, never mark a payment paid, never contact the payer.`,
    tools: ['switch.uncertain', 'switch.recover_uncertain', 'rails.health', 'admin.notify_admins'],
    suggestions: { admin: ['What is still uncertain?', 'Run the recovery'] },
    budget: { maxSteps: 6, maxTokens: 20_000 },
    bindings: ['attempt.unknown'],
    plan: () => [
      { tool: 'switch.uncertain', input: { limit: 20 } },
      { tool: 'switch.recover_uncertain', input: {} },
    ],
  },
  {
    key: 'recon',
    registryId: 'PR-B01',
    aliases: ['PR-B02', 'ReconNormaliser'],
    name: 'Recon',
    icon: '🧾',
    roles: ['admin'],
    tagline: 'Normalises statements and drives the three-way match',
    charter: `You are the Recon agent (PR-B01/B02). After a statement import you review the run, list what matched and what did not, and explain each exception class in plain words. Target: 95% automatic matching. You never correct a figure or close a case.`,
    tools: ['recon.cases', 'recon.evidence_pack', 'admin.notify_admins'],
    suggestions: { admin: ['How did the last import reconcile?', 'What is unmatched today?'] },
    budget: { maxSteps: 6, maxTokens: 25_000 },
    bindings: ['statement.imported'],
    plan: () => [{ tool: 'recon.cases', input: { status: 'OPEN', limit: 50 } }],
  },
  {
    key: 'exception_hunter',
    registryId: 'PR-B03',
    name: 'Exception Hunter',
    icon: '🔎',
    roles: ['admin'],
    tagline: 'Evidence packs for cases older than a day, proposals for humans',
    charter: `You are the Exception Hunter (PR-B03). For every reconciliation case unmatched after 24 hours you assemble the evidence pack and propose a resolution for a human to approve. Closure always needs a different person; you never close, never adjust the ledger.`,
    tools: ['recon.cases', 'recon.evidence_pack', 'recon.propose_resolution', 'admin.notify_admins'],
    suggestions: { admin: ['Build the evidence pack for the oldest case', 'What can be resolved today?'] },
    budget: { maxSteps: 8, maxTokens: 30_000 },
    bindings: ['recon.exception_aged'],
    plan: (_i, c) =>
      ctxStr(c, 'aggregateId') ? [{ tool: 'recon.evidence_pack', input: { caseId: ctxStr(c, 'aggregateId') } }] : [{ tool: 'recon.cases', input: { status: 'OPEN', olderThanHours: 24, limit: 20 } }],
  },
  {
    key: 'koda_core',
    registryId: 'PR-A02',
    aliases: ['RecipientValidator', 'KODA'],
    name: 'KODA Core',
    icon: '✅',
    roles: [...MERCHANT_CLASS_ROLES, 'admin'],
    tagline: 'Scan-to-Verify in seconds across the three doors',
    charter: `You are KODA Core (PR-A02). A merchant asks whether a payment really arrived; you run the verification (reference, or MSISDN plus amount) across the wallet ledger, the processors and the national switch — the three doors — and answer VERIFIED, PENDING, NOT_FOUND, AMBIGUOUS or MISMATCH with the evidence. You never mark anything paid.`,
    tools: ['verification.koda', 'merchant.growth', 'transactions.list'],
    suggestions: { merchant: ['Did the payment with reference X arrive?', 'Verify 25.00 USD from +243…'] },
    budget: { maxSteps: 4, maxTokens: 12_000 },
    bindings: ['verification.requested'],
    plan: (input, c) => {
      const ref = input.match(/reference\s+([A-Za-z0-9._-]{3,})/i)?.[1] ?? ctxStr(payload(c), 'reference');
      const msisdn = input.match(/\+?\d{9,15}/)?.[0] ?? ctxStr(payload(c), 'msisdn');
      const amt = input.match(/(\d+(?:\.\d{1,2})?)\s*([A-Z]{3})/);
      if (ref) return [{ tool: 'verification.koda', input: { rail: 'any', reference: ref } }];
      if (msisdn && amt) return [{ tool: 'verification.koda', input: { rail: 'any', msisdn, amountMinor: Math.round(parseFloat(amt[1]) * 100), currency: amt[2] } }];
      return null;
    },
  },
  {
    key: 'dispute_arbiter',
    registryId: 'PR-F02',
    aliases: ['DisputeResolver'],
    name: 'Dispute Arbiter',
    icon: '⚖️',
    roles: ['admin'],
    tagline: 'Both sides’ evidence, a proposed ruling, a human confirms',
    charter: `You are the Dispute Arbiter (PR-F02). You read both sides' evidence and the chronology, weigh it against the product rules and propose WON or LOST with reasons. A human confirms; only then does money move. You never contact the parties with a decision.`,
    tools: ['disputes.summary', 'disputes.open', 'disputes.propose_ruling', 'admin.notify_admins'],
    suggestions: { admin: ['Summarise the oldest open dispute', 'Propose a ruling on dp_…'] },
    budget: { maxSteps: 6, maxTokens: 25_000 },
    bindings: ['dispute.opened'],
    plan: (input, c) => {
      const id = input.match(/dp_[a-z0-9]+/i)?.[0] ?? ctxStr(c, 'aggregateId');
      return id ? [{ tool: 'disputes.summary', input: { disputeId: id } }] : [{ tool: 'disputes.open', input: { limit: 20 } }];
    },
  },
  {
    key: 'fx_oracle',
    registryId: 'PR-C02',
    aliases: ['FxOracle'],
    name: 'FX Oracle',
    icon: '📈',
    roles: ['admin'],
    tagline: 'Rate cards versus the market, policy proposals for a signature',
    charter: `You are the FX Oracle (PR-C02). You compare the published Diaspora-Direct rate cards with the live mid-market rate and the signed policy, flag drift, and propose policy changes a treasury administrator signs. Cards refresh every four hours under the policy; you never change a rate yourself.`,
    tools: ['fx.rate_card', 'fx.propose_policy', 'rates.list', 'admin.rate_status', 'admin.notify_admins'],
    suggestions: { admin: ['Are the rate cards in line with the market?', 'Propose a GBP/CDF policy at 150 bps'] },
    budget: { maxSteps: 6, maxTokens: 20_000 },
    bindings: ['diaspora.quote_created'],
    plan: (_i, c) => {
      const pair = ctxStr(payload(c), 'pair');
      const [a, b] = (pair ?? '').split('/');
      return [{ tool: 'fx.rate_card', input: a && b ? { sourceCurrency: a, destCurrency: b } : {} }];
    },
  },
  {
    key: 'rebalancer',
    registryId: 'PR-C03',
    aliases: ['LiquidityForecaster'],
    name: 'Rebalancer',
    icon: '💧',
    roles: ['admin'],
    tagline: 'Float forecasts and refill proposals inside the envelope',
    charter: `You are the Rebalancer (PR-C03). You watch every agent's float runway, forecast shortfalls and recommend refills within the signed envelope (never above the forecast target). Money moves only through the replenishment maker-checker; you send recommendations.`,
    tools: ['agents.float_overview', 'agents.recommend_refill', 'admin.liquidity', 'admin.notify_admins'],
    suggestions: { admin: ['Who runs out of float tomorrow?', 'Recommend refills'] },
    budget: { maxSteps: 8, maxTokens: 25_000 },
    bindings: ['agent.float_low'],
    plan: (_i, c) => {
      const p = payload(c);
      const agentId = ctxStr(p, 'agentId');
      const cur = ctxStr(p, 'currency');
      const refill = typeof p.refill === 'number' ? (p.refill as number) : 0;
      return agentId && cur && refill > 0
        ? [{ tool: 'agents.recommend_refill', input: { agentId, currency: cur, amountMinor: refill, note: 'Forecast-driven recommendation' } }]
        : [{ tool: 'agents.float_overview', input: { onlyLow: true } }];
    },
  },
  {
    key: 'connector_medic',
    registryId: 'PR-E01',
    name: 'Connector Medic',
    icon: '🔌',
    roles: ['admin'],
    tagline: 'Reroute before failure, pause what is failing, describe the incident',
    charter: `You are the Connector Medic (PR-E01). When a connector degrades you read its health and statistics, propose a pause (a second administrator confirms) so Smart Route reroutes, and describe the incident for the runbook. You never change a national route or bypass the switch.`,
    tools: ['rails.health', 'rails.propose_pause', 'rails.propose_resume', 'admin.notify_admins'],
    suggestions: { admin: ['Which connectors are unhealthy?', 'Pause the failing connector'] },
    budget: { maxSteps: 6, maxTokens: 20_000 },
    bindings: ['connector.degraded'],
    plan: (_i, c) => {
      const conn = ctxStr(payload(c), 'connector');
      return [
        { tool: 'rails.health', input: {} },
        ...(conn ? [{ tool: 'rails.propose_pause', input: { connector: conn, reason: 'Circuit opened after consecutive failures; reroute while it recovers' } }] : []),
      ];
    },
  },
  {
    key: 'onboarding',
    registryId: 'PR-A01',
    aliases: ['OnboardingGuide', 'MerchantGrowth'],
    name: 'Onboarding',
    icon: '🚀',
    roles: [...MERCHANT_CLASS_ROLES, 'admin'],
    tagline: 'Tiered KYC guidance and the merchant growth picture',
    charter: `You are the Onboarding agent (PR-A01). For a new merchant you explain the verification levels, what unlocks what, and the next step; for an active one you summarise growth (sales, settlement, disputes). Conversational, four languages, never approves KYC.`,
    tools: ['onboarding.status', 'merchant.growth', 'merchant.stats', 'knowledge.search'],
    suggestions: { merchant: ['What do I need to raise my limits?', 'How is my business doing this week?'] },
    budget: { maxSteps: 5, maxTokens: 15_000 },
    bindings: ['merchant.created'],
    plan: (input) => (/(sales|grow|week|settle)/i.test(input) ? [{ tool: 'merchant.growth', input: {} }] : [{ tool: 'onboarding.status', input: {} }]),
  },
  {
    key: 'sanctions_sentinel',
    registryId: 'PR-D02',
    aliases: ['ComplianceMonitor'],
    name: 'Sanctions Sentinel',
    icon: '🚨',
    roles: ['admin'],
    tagline: 'Freeze outranks everything; the MLRO resolves',
    charter: `You are the Sanctions Sentinel (PR-D02). On a sanctions hit you gather the case, propose freezing the account's wallets (a second administrator confirms) and prepare the file for the money-laundering reporting officer. You never clear a hit.`,
    tools: ['compliance.cases', 'fraud.explain', 'admin.freeze_wallet', 'admin.user_summary', 'admin.notify_admins'],
    suggestions: { admin: ['Any sanctions hits today?'] },
    budget: { maxSteps: 6, maxTokens: 20_000 },
    bindings: ['sanctions.hit'],
    plan: (_i, c) => {
      const p = payload(c);
      const userId = ctxStr(p, 'userId');
      return [
        { tool: 'compliance.cases', input: { kind: 'SANCTIONS', limit: 10 } },
        ...(userId ? [{ tool: 'admin.freeze_wallet', input: { userId, currency: ctxStr(p, 'currency') ?? 'USD', reason: 'Sanctions hit: freeze pending MLRO review' } }] : []),
      ];
    },
  },
];

export const AGENTS: AgentDef[] = [
  {
    key: 'chief_of_staff',
    name: 'Chief of Staff',
    icon: '🧭',
    roles: EVERYONE,
    tagline: 'Your daily briefing, reminders and next steps',
    charter: `You are the Chief of Staff agent. You summarise what matters today for this account: balances, money in and out, routes still in progress, anything waiting for the account holder (consent requests, KYC, pending payouts) and one or two suggested next steps. You delegate detail to other agents by naming them. You remember stated preferences with memory.remember when the account holder asks you to.`,
    tools: [...PERSONAL_TOOLS, ...MERCHANT_TOOLS, ...CASH_AGENT_TOOLS, ...ADMIN_READ],
    suggestions: {
      all: ['What should I know today?', 'What is still in progress?', 'Remind me what I asked you last time'],
      merchant: ['How did the shop do this week?'],
      agent: ['What is in my payout queue?'],
      admin: ['Anything waiting for treasury or approvals?'],
    },
    budget: { maxSteps: 8, maxTokens: 30_000 },
  },
  {
    key: 'analyst',
    name: 'Analyst',
    icon: '📊',
    roles: EVERYONE,
    tagline: 'Explains money in, money out, fees and statements',
    charter: `You are the Analyst agent. You answer questions about transactions, fees, exchange rates, statements and trends with exact figures from the tools. When asked "why", trace the ledger: find the transaction, read its fee and rate, and explain in one or two sentences. Offer a statement (statements.build) when a period summary is useful.`,
    tools: [...PERSONAL_TOOLS, ...MERCHANT_TOOLS, ...CASH_AGENT_TOOLS],
    suggestions: {
      all: ['How much did I spend this month?', 'Why was I charged a fee on my last transfer?', 'Build my statement for last month'],
      merchant: ['Which payment method do my customers use most?'],
    },
    budget: { maxSteps: 8, maxTokens: 30_000 },
  },
  {
    key: 'research',
    name: 'Research',
    icon: '🔎',
    roles: EVERYONE,
    tagline: 'Answers from BitriPay policies, guides and fees',
    charter: `You are the Research agent. You answer questions about how BitriPay works: fees, limits, safeguarding, KYC, corridors, mobile money, refunds and policies. Always search the knowledge base first (knowledge.search) and cite the page or article you used by title. If the knowledge base does not cover the question, say so and suggest opening a support ticket.`,
    tools: ['knowledge.search', 'fees.quote', 'rates.list', 'routes.quote', 'profile.summary', 'support.create_ticket', 'memory.remember'],
    suggestions: { all: ['How is my balance protected?', 'What does it cost to send money to Kinshasa?', 'What documents do I need for KYC?'] },
    budget: { maxSteps: 6, maxTokens: 20_000 },
  },
  {
    key: 'automation',
    name: 'Automation',
    icon: '⚙️',
    roles: EVERYONE,
    tagline: 'Prepares repeat payments and routines for you to confirm',
    charter: `You are the Automation agent. You prepare repeatable actions (a weekly transfer, a monthly statement, a top-up) as proposals the account holder confirms. You never execute them yourself: every money action goes through actions.propose. When asked to "set up" something, explain exactly what will be proposed and when, then propose the first instance now.`,
    tools: [...READ_TOOLS, 'actions.propose', 'statements.build', 'memory.remember'],
    suggestions: { all: ['Prepare my rent transfer', 'Set up a monthly statement', 'Prepare a top-up for my phone'] },
    budget: { maxSteps: 6, maxTokens: 20_000 },
  },
  {
    key: 'growth',
    name: 'Growth',
    icon: '📈',
    roles: [...MERCHANT_CLASS_ROLES, 'agent', 'admin'],
    tagline: 'Finds ways to sell more and get paid faster',
    charter: `You are the Growth agent for a merchant or cash agent. You read sales, methods, settlement timing and open payment links, then recommend two or three concrete, low-cost actions (a QR at the counter, a payment link for deliveries, a settlement threshold, opening hours by demand). Ground every recommendation in a figure from the tools.`,
    tools: [...READ_TOOLS, ...MERCHANT_TOOLS, ...CASH_AGENT_TOOLS, 'actions.propose', 'memory.remember'],
    suggestions: {
      merchant: ['How can I get more customers to pay by QR?', 'When should I settle to my bank?'],
      agent: ['When is demand for cash highest?'],
      admin: ['Which merchants grew most this month?'],
    },
    budget: { maxSteps: 8, maxTokens: 30_000 },
  },
  {
    key: 'security',
    name: 'Security',
    icon: '🛡️',
    roles: EVERYONE,
    tagline: 'Checks your account safety and explains alerts',
    charter: `You are the Security agent. You review the account's protection (PIN, two-factor, passkeys, KYC level, loud alerts), recent sign-ins and unusual transactions, and explain security notifications. You recommend concrete steps in the app (Settings → Security). You never ask for passwords, PINs or codes, and you say so if asked.`,
    tools: ['profile.summary', 'notifications.recent', 'transactions.list', 'knowledge.search', 'support.create_ticket', 'actions.propose'],
    suggestions: { all: ['Is my account secure?', 'I do not recognise a transaction', 'Turn on stronger sign-in'] },
    budget: { maxSteps: 6, maxTokens: 20_000 },
  },
  {
    key: 'knowledge',
    name: 'Knowledge',
    icon: '📚',
    roles: EVERYONE,
    tagline: 'Remembers what you tell it and what you prefer',
    charter: `You are the Knowledge agent. You keep the account holder's stated preferences and facts (memory.remember) and answer questions about them. You only store what the account holder explicitly asks you to remember, never secrets, and you explain how to delete memories (Command centre → Memory).`,
    tools: ['memory.remember', 'profile.summary', 'knowledge.search'],
    suggestions: { all: ['Remember that I prefer receipts on WhatsApp', 'What do you remember about me?'] },
    budget: { maxSteps: 4, maxTokens: 10_000 },
  },
  {
    key: 'smart_route',
    aliases: ['RouteOptimiser'],
    name: 'Smart Route',
    icon: '🧭',
    roles: [...MERCHANT_CLASS_ROLES, 'admin'],
    tagline: 'Explains how rails are ranked and why a payment took the route it did',
    charter: `You are the Smart Route agent (route optimisation). You explain the rail ranking: for a payment method and currency you read the routing report (success rate, p95 latency, cost, health state, merchant preference, settlement speed, FX cost, fraud risk, liquidity, concentration) and say which connector wins, why, and what would change the choice. For merchants you use their route quotes and money routes; administrators also see every connector's health. You never change a route, pause a connector or move money; propose a pause to the Connector Medic when a rail is failing.`,
    tools: ['rails.health', 'routes.quote', 'routes.list', 'routes.get', 'fees.quote', 'rates.list', 'knowledge.search', 'memory.remember'],
    suggestions: {
      merchant: ['Which rail will my next mobile money payment use?', 'Why did this payment go through the sandbox rail?'],
      admin: ['Rank the card connectors', 'Which connector is degraded right now?'],
    },
    budget: { maxSteps: 6, maxTokens: 20_000 },
    plan: (input, c) => {
      const t = input.toLowerCase();
      const routeId = ctxStr(c, 'routeId');
      if (routeId) return [{ tool: 'routes.get', input: { id: routeId } }];
      const amt = input.match(/(\d+(?:\.\d{1,2})?)\s*([A-Z]{3})/);
      const plan: { tool: string; input: Record<string, unknown> }[] = [{ tool: 'rails.health', input: {} }];
      if (amt)
        plan.push({ tool: 'routes.quote', input: { amount: amt[1], currency: amt[2], targetCurrency: amt[2], method: /mobile|momo/.test(t) ? 'mobile_money' : /bank/.test(t) ? 'bank' : 'wallet' } });
      else plan.push({ tool: 'routes.list', input: { limit: 10 } });
      return plan;
    },
  },
  {
    key: 'seo_content',
    aliases: ['ContentEngine'],
    name: 'Content Engine',
    icon: '✍️',
    roles: [...MERCHANT_CLASS_ROLES, 'admin'],
    tagline: 'Drafts and audits articles from BitriPay knowledge, clearly marked machine-generated',
    charter: `You are the Content Engine (SEO content). You draft and audit articles, guides and product pages about BitriPay: search the knowledge base for the facts (fees, limits, corridors, safeguarding, KYC, mobile money), propose an outline, a draft and a short audit (accuracy against the sources, readability, keywords, internal links to the pages you cite). Everything you produce is machine-generated and says so; a human editor publishes. You never invent figures, rates or policies: when the knowledge base does not cover a claim, mark it as needing a source.`,
    tools: ['knowledge.search', 'profile.summary', 'memory.remember'],
    suggestions: { all: ['Draft an article on how BitriPay protects balances', 'Audit the fees page for accuracy', 'Outline a guide to mobile money payouts in Ghana'] },
    budget: { maxSteps: 6, maxTokens: 30_000 },
    plan: (input) => {
      const topic = input
        .replace(/^(please\s+)?(draft|write|audit|outline|review)\s+(an?\s+)?(article|guide|page|post)?\s*(on|about|for)?\s*/i, '')
        .trim()
        .slice(0, 120);
      return [{ tool: 'knowledge.search', input: { query: topic.length >= 2 ? topic : input.slice(0, 120), limit: 8 } }];
    },
  },
  {
    key: 'operations',
    name: 'Operations',
    icon: '🛰️',
    roles: ['admin'],
    tagline: 'Watches routes, payouts and liquidity across corridors',
    charter: `You are the Operations agent for BitriPay administrators. Each run you check routes stuck in open stages, corridors short of local liquidity, payouts waiting on devices and reserve warnings, then report findings ordered by money at risk, with the exact next action for a human (re-queue, fund an account, open verification). You may notify administrators (admin.notify_admins) when something needs attention now. Freezing a wallet or running a reconciliation requires a checker's approval; propose it with the reason.`,
    tools: [...ADMIN_READ, ...ADMIN_ACT, 'memory.remember'],
    suggestions: { admin: ['Which routes are stuck?', 'Where is liquidity short?', 'Run the morning operations check'] },
    budget: { maxSteps: 10, maxTokens: 40_000 },
    schedule: 'daily',
  },
  {
    key: 'compliance',
    name: 'Compliance',
    icon: '⚖️',
    roles: ['admin'],
    tagline: 'KYC queue, sanctions hits, reserves and regulatory dates',
    charter: `You are the Compliance agent. You review the KYC queue, risk and sanctions events, reserve coverage per programme and corridor licence dates, and draft a short compliance note with counts, oldest items and what a reviewer must decide. You never approve KYC or clear a hit; you queue it for a human. Reconciliations require approval.`,
    tools: [
      'admin.kyc_queue',
      'admin.risk_events',
      'admin.emoney_overview',
      'admin.corridors',
      'admin.reconcile_reserves',
      'admin.users_search',
      'admin.user_summary',
      'admin.freeze_wallet',
      'admin.notify_admins',
      'knowledge.search',
      'memory.remember',
    ],
    suggestions: { admin: ['Summarise the KYC queue', 'Are all programmes fully covered?', 'Any sanctions hits this week?'] },
    budget: { maxSteps: 10, maxTokens: 40_000 },
    schedule: 'daily',
  },
  {
    key: 'system_health',
    name: 'System Health',
    icon: '🩺',
    roles: ['admin'],
    tagline: 'Go-live checklist, rate feeds, event chain and agent spend',
    charter: `You are the System Health agent. You run the go-live checklist, verify the event chain, check rate freshness and report agent usage and cost, then list what is red, what is amber and who should act. Keep it to a page.`,
    tools: ['admin.go_live', 'admin.event_chain_verify', 'admin.rate_status', 'admin.usage', 'admin.routes_stuck', 'admin.notify_admins', 'memory.remember'],
    suggestions: { admin: ['Run a health check', 'How much are the agents costing this month?'] },
    budget: { maxSteps: 8, maxTokens: 30_000 },
    schedule: 'daily',
  },
];

AGENTS.push(...MESH_AGENTS);
export const AGENT_BY_KEY = new Map(AGENTS.map((a) => [a.key, a]));
/** Resolve a canonical operating-system name (RouteOptimiser, FraudScorer, …) to the agent that implements it. */
export const OS_AGENT_ALIASES: Record<string, string> = {
  RouteOptimiser: 'smart_route',
  FraudScorer: 'fraud_scorer',
  ComplianceMonitor: 'compliance',
  SavingsAdvisor: 'analyst',
  CreditReadiness: 'analyst',
  MerchantGrowth: 'onboarding',
  FinancialEducator: 'knowledge',
  SupportAgent: 'chief_of_staff',
  LiquidityForecaster: 'rebalancer',
  ContentEngine: 'seo_content',
  DisputeResolver: 'dispute_arbiter',
  RecipientValidator: 'koda_core',
};
export function agentForAlias(name: string): AgentDef | undefined {
  const direct = AGENT_BY_KEY.get(name);
  if (direct) return direct;
  const viaAlias = AGENTS.find((a) => a.aliases?.includes(name));
  if (viaAlias) return viaAlias;
  const mapped = OS_AGENT_ALIASES[name];
  return mapped ? AGENT_BY_KEY.get(mapped) : undefined;
}
export function getAgentDef(key: string): AgentDef | undefined {
  return AGENT_BY_KEY.get(key);
}
export function agentsForRole(role: Role): AgentDef[] {
  return AGENTS.filter((a) => a.roles.includes(role));
}
