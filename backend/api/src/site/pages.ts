/**
 * Server-rendered product pages of the public site: how it works, industries, enterprise groups, developers, get
 * started, growth & influencers, all policies and the live platform status. Every figure on these pages is read from
 * the running platform (tariff grid, KYC tiers, operators, billers, referral rewards, API catalogue, rail health,
 * SLOs), so the site never drifts from the product.
 */
import { layout, FOOTER_LINKS } from './render';
import { escapeHtml } from '../services/markdown';
import { absoluteUrl, breadcrumbJsonLd, pageTitle } from '../services/seo';
import { getSeoSettings, getFees, getReferralSettings, getAppSettings } from '../services/settings';
import { getKycTierSettings, TIER_LABELS } from '../services/risk/kycTiers';
import { listOperators as listMomoOperators } from '../services/momo';
import { listBillers, listOperators as listTopupOperators } from '../services/services';
import { listPages } from '../services/cms';
import { openApiDocument } from '../docs/openapi';
import { API_KEY_SCOPES } from '../services/merchant';
import { SANDBOX_MAGIC_MSISDNS } from '../payments/sandbox';
import { listRails } from '../services/rails';
import { getOperatingState, listGuardianChecks } from '../services/guardian';
import { sloReport, SLO_TARGETS } from '../middleware/slo';
import { verifyEventChain } from '../services/events';
import { getBaseCurrency } from '../services/currencies';
import { config } from '../config';
import { FEE_TYPE_LABELS, ORG_ROLES, formatMoney, type FeeType } from '@bitripay/shared';
import { CSV_COLUMNS, MAX_BATCH_ROWS } from '../services/bulkPayouts';

const CSS = `
.page-hero{padding-block:22px 10px}.page-hero h1{font-size:clamp(30px,5vw,48px);line-height:1.08;margin:0 0 12px;max-width:22ch}.page-hero p{font-size:19px;color:var(--muted);max-width:60ch;margin:0}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:22px 0}.step{border:1px solid var(--line);border-radius:14px;padding:16px 18px;background:var(--paper)}.step b{display:block;font-family:var(--mono);font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent-2);margin-bottom:6px}.step h3{margin:0 0 6px;font-size:17px}.step p{margin:0;color:var(--muted);font-size:14.5px}
.sect{margin-block:34px}.sect h2{font-size:26px;margin:0 0 6px}.sect .lead{color:var(--muted);margin:0 0 14px;max-width:70ch}
table.grid{border-collapse:collapse;width:100%;font-size:14px}table.grid th,table.grid td{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}table.grid th{font-family:var(--mono);font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}table.grid td.num,table.grid th.num{text-align:right;font-variant-numeric:tabular-nums}.table-wrap{overflow-x:auto}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px}.tile{border:1px solid var(--line);border-radius:14px;padding:16px 18px}.tile h3{margin:0 0 6px;font-size:17px}.tile p{margin:0 0 8px;color:var(--muted);font-size:14.5px}.tile ul{margin:0;padding-left:18px;font-size:14px}.tile .ico{font-size:24px;display:block;margin-bottom:6px}
.pill{display:inline-block;font-family:var(--mono);font-size:11.5px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);margin:0 4px 4px 0}.pill.ok{background:#e3f4ec;color:#0b6e4f;border-color:#bfe3d1}.pill.warn{background:#fbf0dc;color:#8a5a00;border-color:#f1d9a6}.pill.bad{background:#fde8e6;color:#b42318;border-color:#f5b8b1}.pill.muted{color:var(--muted)}
pre.code{background:#0f172a;color:#e2e8f0;border-radius:12px;padding:14px 16px;font-family:var(--mono);font-size:13px;overflow-x:auto;line-height:1.5}pre.code .c{color:#94a3b8}
.cta-row{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}.btn{display:inline-block;padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:600;border:1px solid var(--ink)}.btn.primary{background:var(--ink);color:var(--bg)}.btn.ghost{color:var(--ink)}
.status-big{display:flex;align-items:center;gap:12px;font-size:22px;font-weight:700;margin:10px 0 4px}.dot{width:14px;height:14px;border-radius:50%;display:inline-block}.dot.ok{background:#0b6e4f}.dot.warn{background:#f5b31c}.dot.bad{background:#b42318}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:14px 0}.kpi{border-top:3px solid var(--accent);padding-top:8px}.kpi b{display:block;font-size:24px}.kpi span{font-size:13px;color:var(--muted)}
`;

const MONEY = (minor: number) => formatMoney(minor, getBaseCurrency());
const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')} %`;

function page(meta: { title: string; description: string; path: string; crumb: string; jsonLd?: Record<string, unknown>[] }, body: string): string {
  const seo = getSeoSettings();
  return layout(
    {
      title: pageTitle(meta.title),
      description: meta.description,
      path: meta.path,
      jsonLd: [
        breadcrumbJsonLd([
          { name: seo.siteName, url: '/' },
          { name: meta.crumb, url: meta.path },
        ]),
        ...(meta.jsonLd ?? []),
      ],
    },
    `<style>${CSS}</style><div class="breadcrumb"><a href="/">${escapeHtml(seo.siteName)}</a> / ${escapeHtml(meta.crumb)}</div>${body}`,
  );
}
const hero = (h1: string, p: string) => `<section class="page-hero"><h1>${escapeHtml(h1)}</h1><p>${escapeHtml(p)}</p></section>`;
const ctaRow = (items: { href: string; label: string; primary?: boolean }[]) =>
  `<div class="cta-row">${items.map((i) => `<a class="btn ${i.primary ? 'primary' : 'ghost'}" href="${escapeHtml(i.href)}">${escapeHtml(i.label)}</a>`).join('')}</div>`;

/** The tariff grid as the public site shows it (same source as the app and the console). */
function feeRows(types: FeeType[]): string {
  const fees = getFees();
  return `<div class="table-wrap"><table class="grid"><tr><th>Operation</th><th class="num">BitriPay fee</th><th class="num">Fixed part</th><th class="num">Minimum</th><th class="num">Maximum</th></tr>${types
    .map((t) => {
      const f = fees[t];
      if (!f) return '';
      return `<tr><td>${escapeHtml(FEE_TYPE_LABELS[t])}</td><td class="num">${pct(f.bps)}</td><td class="num">${f.fixed ? MONEY(f.fixed) : '—'}</td><td class="num">${f.minAmount ? MONEY(f.minAmount) : '—'}</td><td class="num">${f.maxAmount ? MONEY(f.maxAmount) : '—'}</td></tr>`;
    })
    .join('')}</table></div>`;
}

// ---------------------------------------------------------------------------------------------------------------- how it works
export function howItWorksPage(): string {
  const ops = listMomoOperators({ onlyEnabled: true });
  const tiers = getKycTierSettings();
  const country = tiers.countries.CD ?? {};
  const caps = tiers.balanceCaps.countries.CD ?? {};
  const tierRows = ['1', '2', '3', '4']
    .map((t) => {
      const l = country[t] ?? tiers.default[t];
      const cap = (caps as Record<string, number | null | undefined>)[t] ?? tiers.balanceCaps.default[t];
      return `<tr><td>${escapeHtml(TIER_LABELS[Number(t)])}</td><td>${t === '1' ? 'Declared identity, verified phone or e-mail' : t === '2' ? 'Identity document and selfie' : t === '3' ? `Proof of address under ${tiers.addressDocMaxAgeDays} days` : 'Business file (KYB): registration, directors, activity'}</td><td class="num">${l ? MONEY(l.perTransaction) : 'per file'}</td><td class="num">${l ? MONEY(l.daily) : 'per file'}</td><td class="num">${l ? MONEY(l.monthly) : 'per file'}</td><td class="num">${cap ? MONEY(cap) : 'per file'}</td></tr>`;
    })
    .join('');
  const body = `${hero('How BitriPay works', 'One account of electronic money, every way to pay and be paid: QR code, @tag, phone number, mobile money, bank transfer, card, cash agents and a partner API. Money between BitriPay accounts moves instantly and digitally; money in and out goes through the operators and banks you already use, with no dependency on their technical interfaces.')}
<section class="sect"><h2>Four steps, whoever you are</h2><div class="steps">
<div class="step"><b>1 · Open</b><h3>Create your account</h3><p>Name, phone or e-mail, a code by SMS or e-mail, a transaction PIN. Tier 1 limits apply straight away; higher tiers open with your documents.</p></div>
<div class="step"><b>2 · Fund</b><h3>Add money</h3><p>Send to the BitriPay collection number of your operator with the reference shown, transfer from your bank with the reference, pay by card, or hand cash to an agent. The balance is credited once the operator's confirmation is matched.</p></div>
<div class="step"><b>3 · Pay</b><h3>Scan, send, request, pay bills</h3><p>Scan a merchant QR, send to an @tag or number, share a payment link, pay SNEL, REGIDESO or your TV, top up any phone. Fees are shown before you confirm and again on the receipt.</p></div>
<div class="step"><b>4 · Cash out</b><h3>Withdraw when you need to</h3><p>To your mobile money, your bank or in cash at an agent with a one-time code. Larger amounts wait for a second check by our operations team.</p></div>
</div></section>
<section class="sect"><h2>Mobile money without an operator API</h2><p class="lead">The platform never needs a technical integration with an operator to accept its money. A customer sends to the BitriPay collection number; the operator's confirmation SMS is received on an enrolled collection phone, signed and matched against the expected reference. Uncertain matches go to a human at four eyes; nothing is credited on a doubtful proof.</p><div class="tiles">${ops
    .map(
      (o) =>
        `<div class="tile"><span class="ico">📱</span><h3>${escapeHtml(o.name)}</h3><p>${escapeHtml(o.brand)} · ${escapeHtml(o.country)} · ${escapeHtml(o.currency)}${o.ussd ? ` · dial ${escapeHtml(o.ussd)}` : ''}</p></div>`,
    )
    .join('')}</div></section>
<section class="sect"><h2>Know-your-customer tiers</h2><p class="lead">Limits are per operation, per day and per month in ${escapeHtml(getBaseCurrency().code)} or the equivalent, plus a balance ceiling. They are the platform's defaults for the Democratic Republic of the Congo and are aligned with the instructions of the licence the platform operates under.</p><div class="table-wrap"><table class="grid"><tr><th>Tier</th><th>What you provide</th><th class="num">Per operation</th><th class="num">Per day</th><th class="num">Per month</th><th class="num">Balance ceiling</th></tr>${tierRows}</table></div></section>
<section class="sect"><h2>What it costs</h2><p class="lead">A percentage of the amount, no fixed fee except the virtual-card issue, and the agent's commission comes out of the BitriPay fee, never on top. The full grid is on the <a href="/legal/fees">fees page</a>.</p>${feeRows(['transfer', 'merchant_payment', 'payment_link', 'mobile_money_deposit', 'withdrawal', 'bill_payment', 'mobile_topup', 'remittance', 'exchange'])}</section>
<section class="sect"><h2>What keeps it honest</h2><div class="tiles">
<div class="tile"><span class="ico">📒</span><h3>Double-entry ledger</h3><p>Every operation debits and credits internal accounts; balances are derived, never typed. A watchdog pauses money movement by itself if an invariant breaks.</p></div>
<div class="tile"><span class="ico">🔗</span><h3>Hash-chained journal</h3><p>Events are chained by hash: any alteration after the fact is detectable, and exports carry an integrity manifest.</p></div>
<div class="tile"><span class="ico">👀</span><h3>Four eyes</h3><p>Administrative credits, e-money issuance, large withdrawals and manual verifications need two different administrators with PIN and second factor.</p></div>
<div class="tile"><span class="ico">🛡️</span><h3>Screening and limits</h3><p>Official sanctions lists, tiered limits, velocity rules and a cooling-off on new beneficiaries; a frozen balance is frozen everywhere.</p></div>
</div>${ctaRow([
    { href: '/register', label: 'Open an account', primary: true },
    { href: '/get-started', label: 'Get started by role' },
    { href: '/developers', label: 'Developers' },
  ])}</section>`;
  return page(
    {
      title: 'How it works',
      description: 'One electronic-money account, every way to pay and be paid: QR, @tag, mobile money without operator APIs, bank, card, agents and API. Tiers, fees and controls explained.',
      path: '/how-it-works',
      crumb: 'How it works',
    },
    body,
  );
}

// ---------------------------------------------------------------------------------------------------------------- industries
export function industriesPage(): string {
  const billers = listBillers(true, 'CD') as { name: string; category: string }[];
  const telcos = listTopupOperators(true, 'CD') as { name: string }[];
  const sectors: { ico: string; title: string; who: string; features: string[] }[] = [
    {
      ico: '🧺',
      title: 'Markets, shops and street trade',
      who: 'The mother selling food at the market, the corner shop, the pharmacy, the boutique.',
      features: [
        'Static QR printed once, dynamic QR with the amount, offline QR when the network drops',
        'Receipts to both parties, sales per day and by method in the merchant dashboard',
        'Settlement to the merchant balance in seconds; withdrawal to mobile money or bank',
      ],
    },
    {
      ico: '🏍️',
      title: 'Transport',
      who: 'Moto-taxi riders, minibus operators, fuel stations, parking.',
      features: [
        "Ride paid by scanning the rider's code or by @tag from the passenger's phone",
        'Fleet owners collect per vehicle with sub-accounts and see who collected what',
        'Cash-out at agents along the route',
      ],
    },
    {
      ico: '💡',
      title: 'Utilities and billers',
      who: billers.length ? `Billers already in the catalogue: ${billers.map((b) => b.name).join(', ')}.` : 'Electricity, water, television, internet and tax billers.',
      features: [
        'Bill pay from the app, USSD or an agent counter, with the customer reference validated',
        'Biller receives a normalised file of paid references and a settlement statement',
        "A public API for the biller's own systems to post invoices and read payments",
      ],
    },
    {
      ico: '📶',
      title: 'Telecom and digital services',
      who: telcos.length ? `Airtime and data for ${telcos.map((t) => t.name).join(', ')}.` : 'Airtime, data, subscriptions.',
      features: ['Top-ups within the published band, instantly credited', 'Subscriptions and recurring collections with dunning', 'Gift cards issued in local currency'],
    },
    {
      ico: '🛒',
      title: 'E-commerce and marketplaces',
      who: 'Online shops, delivery apps, marketplaces with many sellers.',
      features: [
        'Hosted checkout, payment links and an embeddable widget; WooCommerce and Shopify integrations',
        'Split payments to several recipients from one intent; refunds allocated back pro rata',
        'Signed webhooks, idempotent requests, a sandbox with magic numbers',
      ],
    },
    {
      ico: '🏫',
      title: 'Schools, churches and associations',
      who: 'Fees, tithes, dues and campaigns collected from many people.',
      features: ['Payment requests to a list of payers with a reference per person', 'Reusable payment links and a QR on the notice board', 'Statements per period for the treasurer'],
    },
    {
      ico: '🏛️',
      title: 'Government and institutions',
      who: 'Agencies collecting fees, taxes, permits and fines.',
      features: [
        'Citizen references and QR codes per service with a reconciliation code',
        'Agents issue references at the counter; the agency reads the dashboard and the audit export',
        'Payments observed on the national switch are journaled, never held by the platform',
      ],
    },
    {
      ico: '🌍',
      title: 'Diaspora and remittance',
      who: 'Families abroad sending money home, cash pick-up at an agent.',
      features: [
        'Corridors declared with their licences and partners; the platform refuses corridors that are not authorised',
        'Recipient chooses the currency; the rate, the margin and the fee are disclosed before sending',
        'Cash pick-up with a code, mobile money or bank payout from prefunded local accounts',
      ],
    },
    {
      ico: '🏪',
      title: 'Agents and cash networks',
      who: 'Shops that become deposit and withdrawal points.',
      features: [
        'Cash-in and cash-out with one-time codes, commission on every completed operation',
        'Float forecast, replenishment requests approved at four eyes, daily limits per agent',
        'Payout device app that turns operator SMS into signed evidence',
      ],
    },
  ];
  const body = `${hero('Built for the way money moves here', 'From the market stall to the ministry: the same account, the same QR, the same ledger. Each sector below uses features that exist today; nothing on this page is a roadmap item.')}
<section class="sect"><div class="tiles">${sectors.map((s) => `<div class="tile"><span class="ico">${s.ico}</span><h3>${escapeHtml(s.title)}</h3><p>${escapeHtml(s.who)}</p><ul>${s.features.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul></div>`).join('')}</div></section>
<section class="sect"><h2>Feature phones too</h2><p class="lead">USSD menus and SMS commands cover the essentials (balance, send, pay a bill, cash-out code) without an app, and the Lite web version works on very slow connections without JavaScript. Every interface is available in eleven languages including Lingala, Kikongo, Tshiluba and Swahili.</p>${ctaRow(
    [
      { href: '/register?role=merchant', label: 'Accept payments', primary: true },
      { href: '/enterprise', label: 'Enterprise groups' },
      { href: '/contact', label: 'Talk to us' },
    ],
  )}</section>`;
  return page(
    {
      title: 'Industries',
      description: 'Markets, transport, utilities, telecom, e-commerce, schools, government, diaspora and agent networks: how each sector pays and gets paid with BitriPay.',
      path: '/industries',
      crumb: 'Industries',
    },
    body,
  );
}

// ---------------------------------------------------------------------------------------------------------------- enterprise groups
export function enterprisePage(): string {
  const slo = Object.values(SLO_TARGETS).filter((t): t is NonNullable<typeof t> => !!t);
  const body = `${hero('Enterprise groups', 'Groups of companies, franchises, agencies with many counters and employers with many payees run on one organisation with units, roles and permissions, bulk payouts, settlement profiles and an audit trail that a finance director can rely on.')}
<section class="sect"><div class="tiles">
<div class="tile"><span class="ico">🏢</span><h3>Organisations and units</h3><p>One organisation, as many units (branches, subsidiaries, counters) as you need, each with its own balances and reporting; consolidated at the top.</p></div>
<div class="tile"><span class="ico">🔐</span><h3>Roles and permissions</h3><p>${ORG_ROLES.map((r) => escapeHtml(r.replace(/_/g, ' '))).join(' · ')}. Every API call and every screen checks the permission on the server.</p></div>
<div class="tile"><span class="ico">📤</span><h3>Bulk payouts</h3><p>Upload a CSV of up to ${MAX_BATCH_ROWS.toLocaleString('en-GB')} rows (${CSV_COLUMNS.slice(0, 6).join(', ')}, …), preview fees and readiness, approve at four eyes, follow every line to its proof.</p></div>
<div class="tile"><span class="ico">🧾</span><h3>Settlement profiles and statements</h3><p>Choose the settlement currency, schedule and destination; statements list gross, provider fee, BitriPay fee and the tax on it per line, hashed for your auditors.</p></div>
<div class="tile"><span class="ico">🔌</span><h3>Integration</h3><p>Scoped API keys per system, signed webhooks with replay protection, an OpenAPI document, SDKs, and a sandbox with the same state machine as production.</p></div>
<div class="tile"><span class="ico">📊</span><h3>Reporting</h3><p>Charts of volume, channels, counterparties and timing for each unit; bank-grade statements; exports in CSV and JSON with integrity manifests for supervision.</p></div>
</div></section>
<section class="sect"><h2>Service levels we measure</h2><p class="lead">The platform measures itself continuously; the live figures are on the <a href="/status">status page</a>.</p><div class="table-wrap"><table class="grid"><tr><th>Objective</th><th>Target</th></tr>${slo.map((t) => `<tr><td>${escapeHtml(t.label)}</td><td>${t.percentile} under ${t.maxMs} ms</td></tr>`).join('')}</table></div></section>
<section class="sect"><h2>Compliance built in</h2><p class="lead">Business verification (KYB) for the organisation and its directors, tiered limits per unit, sanctions screening before every movement, four-eyes approvals, a hash-chained event log and a supervisory journal export. The same controls apply to the API as to the apps.</p>${ctaRow(
    [
      { href: '/contact', label: 'Request a walkthrough', primary: true },
      { href: '/developers', label: 'Read the API' },
      { href: '/legal/agent-merchant-agreement', label: 'Merchant agreement' },
    ],
  )}</section>`;
  return page(
    {
      title: 'Enterprise groups',
      description:
        'Organisations with units, roles and permissions, bulk payouts, settlement profiles, statements, scoped API keys and measured service levels for groups, franchises, agencies and employers.',
      path: '/enterprise',
      crumb: 'Enterprise',
    },
    body,
  );
}

// ---------------------------------------------------------------------------------------------------------------- developers
const SCOPE_NOTES: Record<string, string> = {
  'payment_intents:write': 'Create and cancel payment intents. Publishable pk_ keys get only this: safe to ship in a browser, they can start a payment and never read your data.',
  'payment_intents:read': 'Read intents, timelines and refundable amounts.',
  'checkout_sessions:write': 'Create hosted checkout sessions.',
  'payment_links:write': 'Create and deactivate payment links.',
  'qr_codes:read': 'List your QR codes and their analytics.',
  'qr_codes:write': 'Create and revoke QR codes and locations.',
  'refunds:read': 'Read refunds.',
  'refunds:write': 'Create refunds; every refund is reserved atomically against the refundable amount.',
  'verifications:write': 'Submit a customer reference or operator SMS for verification.',
  'payouts:read': 'Read payouts and batches.',
  'payouts:write': 'Create payouts and bulk batches (approval stays with a person).',
  'payouts:approve': 'Approve a payout batch (four eyes: never the author).',
  'balance:read': 'Read balances by class (available, held, escrow, suspense).',
  'webhooks:manage': 'Register endpoints, read deliveries, replay.',
  'events:read': 'Read the event feed.',
  'transfers:read': 'Read wallet transfers.',
  'transfers:write': 'Send wallet transfers under the organisation policy.',
  'remittances:read': 'Read remittances.',
  'remittances:write': 'Quote and send remittances on authorised corridors.',
  'routes:read': 'Read routes and receipts.',
  'routes:write': 'Quote and create any-to-any routes.',
  'settlements:read': 'Read settlement profiles, cycles and statements.',
  'settlements:write': 'Manage settlement profiles and close cycles.',
  'disputes:read': 'Read disputes and chargebacks.',
  'disputes:write': 'Respond to disputes with evidence.',
  'reconciliation:read': 'Read reconciliation reports and receipts.',
  'participants:read': 'Read national-switch participants.',
  'payments:create': 'Initiate national-switch payments.',
  'payments:read': 'Read national-switch payments.',
  'payments:cancel': 'Cancel a pending national-switch payment.',
  'refunds:create': 'Create national-switch refunds.',
  'qr:create': 'Create switch-compatible QR codes.',
  'bindings:manage': 'Manage account bindings.',
  'wallets:read': 'Read wallets.',
  'ai:run': 'Run metered assistant operations (consumes prepaid units).',
  'subscriptions:read': 'Read plans, subscriptions and invoices.',
  'subscriptions:write': 'Create plans, record usage, cancel subscriptions.',
  'credit:read': 'Read the credit-readiness signal a customer consented to share.',
};

export function developersPage(): string {
  const doc = openApiDocument() as { paths: Record<string, Record<string, { summary?: string }>> };
  const rows: { method: string; path: string; summary: string }[] = [];
  for (const [path, methods] of Object.entries(doc.paths)) for (const [method, op] of Object.entries(methods)) rows.push({ method: method.toUpperCase(), path, summary: op.summary ?? '' });
  const featured = [
    '/payment_intents',
    '/payment_intents/{id}',
    '/payment_intents/{id}/cancel',
    '/checkout_sessions',
    '/payment_links',
    '/qr_codes',
    '/verifications',
    '/refunds',
    '/payouts',
    '/balance',
    '/webhook_endpoints',
    '/keys',
    '/status',
  ];
  const table = (list: typeof rows) =>
    `<div class="table-wrap"><table class="grid"><tr><th>Method</th><th>Path</th><th>Description</th></tr>${list.map((r) => `<tr><td><span class="pill">${r.method}</span></td><td><code>${escapeHtml(r.path)}</code></td><td>${escapeHtml(r.summary)}</td></tr>`).join('')}</table></div>`;
  const top = featured.map((p) => rows.filter((r) => r.path === p)).flat();
  const base = `${config.apiUrl}/v1`;
  const body = `${hero('Three calls. One coffee.', `Connect your shop, your billing system or your institution to BitriPay: create an intent, let the customer pay over the rail Smart Route picks, receive a signed webhook. A key-authenticated REST API with ${rows.length} documented operations, idempotent money movement and a sandbox that runs the same state machine as production.`)}
<section class="sect">${ctaRow([
    { href: '/register?role=developer', label: 'Create a developer account', primary: true },
    { href: '/login', label: 'Sign in to the developer portal' },
    { href: '/v1/openapi.json', label: 'OpenAPI document' },
  ])}<div class="steps">
<div class="step"><b>1 · Get a key</b><h3>Sign in → Developer portal → Create key</h3><p>Secret keys (sk_) carry every scope, restricted keys (rk_) only the scopes you list, publishable keys (pk_) can only start a payment. The secret is shown once.</p></div>
<div class="step"><b>2 · Authenticate</b><h3>Bearer on every request</h3><p><code>Authorization: Bearer sk_test_…</code> — test keys hit the sandbox, live keys the real rails, on the same base URL. Send <code>Idempotency-Key</code> on every money-moving POST.</p></div>
<div class="step"><b>3 · Call the engine</b><h3>Intent → checkout → webhook</h3><p>Create a payment intent, redirect to its checkout URL or show its BitriQR, then act on <code>payment_intent.succeeded</code> and <code>payment_intent.settled</code> after verifying the signatures.</p></div>
</div>
<pre class="code"><span class="c"># Base URL (test and live keys share it)</span>
${escapeHtml(base)}

<span class="c"># 1. Create an intent</span>
curl -X POST ${escapeHtml(base)}/payment_intents \\
  -H "Authorization: Bearer sk_test_…" -H "Idempotency-Key: order-1042" -H "Content-Type: application/json" \\
  -d '{"amount_minor":250000,"currency":"CDF","description":"Order 1042","allowed_operators":["orange_cd","mpesa_cd","airtel_cd","africell_cd"]}'

<span class="c"># 2. Send the customer to checkout_url (or render qr_payload), then</span>
<span class="c"># 3. Verify the webhook: BitriPay-Signature (HMAC of the endpoint secret) and the platform Ed25519 key from /v1/keys</span></pre></section>
<section class="sect"><h2>Endpoints you will use first</h2>${table(top)}<p class="lead" style="margin-top:12px">Every operation, every schema and every error code: <a href="/v1/openapi.json">OpenAPI 3.1 document</a> · <a href="/v1/keys">platform signing keys</a> · <a href="/v1/status">operating status</a>.</p></section>
<section class="sect"><h2>Scopes</h2><p class="lead">A restricted key holds only the scopes you choose; a scope that is missing returns <code>scope_denied</code>.</p><div class="table-wrap"><table class="grid"><tr><th>Scope</th><th>Grants</th></tr>${API_KEY_SCOPES.map((s) => `<tr><td><code>${escapeHtml(s)}</code></td><td>${escapeHtml(SCOPE_NOTES[s] ?? s)}</td></tr>`).join('')}<tr><td><code>*</code></td><td>Full account scope (sk_ keys).</td></tr></table></div></section>
<section class="sect"><h2>Drop-in checkout: pay by mobile money, automatically</h2><p class="lead">Add “Pay with BitriPay” to any website or marketplace. The customer picks the operator, pays to the collection number, and BitriPay matches the operator's confirmation; the order moves forward on its own. Two integration paths:</p><div class="tiles">
<div class="tile"><h3>1 · Hosted checkout (recommended)</h3><p>Create an intent or a checkout session and redirect to its URL. BitriPay renders the operators, the reference, the QR and the confirmation step, then returns the customer to your success URL and sends the webhook.</p></div>
<div class="tile"><h3>2 · Embedded widget</h3><p>Load the checkout script with a publishable key and mount the panel in your page; the browser can start a payment but never read your data. WooCommerce and Shopify plugins ship in the repository.</p></div>
</div></section>
<section class="sect"><h2>Install BitriPay for your clients</h2><p class="lead">BitriPay holds the aggregator licence; you integrate it into your clients' websites, apps, billing and institutional systems. Each client is the merchant of record: their money settles to their own account, their statements are theirs, and you never hold their funds or their password.</p><div class="steps">
<div class="step"><b>1 · The client opens a merchant account</b><h3>Or you open it with their details</h3><p>Every business, NGO, institution or government body you integrate registers as a merchant-class account and passes business verification as its volume grows.</p></div>
<div class="step"><b>2 · The client adds you to its team</b><h3>Command centre → Team → developer role</h3><p>You sign in with your own credentials and act for the client with the developer role: API keys, webhooks and payment creation — nothing on settlement, payouts or customer exports. Every action is written to the client's audit trail under your name.</p></div>
<div class="step"><b>3 · Integrate and hand over</b><h3>Keys per client, sandbox first</h3><p>Pick the client in the workspace selector, create its test key, integrate with the hosted checkout, the embedded widget, the WooCommerce or Shopify plugin or an SDK, then switch to a live key. The client can remove you at any time; its keys stay its own.</p></div>
</div></section>
<section class="sect"><h2>Sandbox magic numbers</h2><p class="lead">With a test key, these MSISDNs drive an intent through the real attempt machine so you can test every outcome without an operator.</p><div class="table-wrap"><table class="grid"><tr><th>Number</th><th>Outcome</th><th>What happens</th></tr>${SANDBOX_MAGIC_MSISDNS.map((m) => `<tr><td><code>${escapeHtml(m.msisdn)}</code></td><td>${escapeHtml(m.outcome)}</td><td>${escapeHtml(m.behaviour)}</td></tr>`).join('')}</table></div></section>
<section class="sect"><h2>Everything else in the catalogue</h2>${table(rows.filter((r) => !featured.includes(r.path)))}${ctaRow([
    { href: '/register?role=developer', label: 'Create a developer account', primary: true },
    { href: '/register?role=merchant', label: 'Create a merchant account' },
    { href: '/v1/openapi.json', label: 'OpenAPI document' },
    { href: '/contact', label: 'Ask a question' },
  ])}</section>`;
  return page(
    {
      title: 'Developers',
      description: `Key-authenticated REST API with ${rows.length} operations: payment intents, hosted checkout, payment links, QR, refunds, payouts, signed webhooks, scoped keys and a sandbox with magic numbers.`,
      path: '/developers',
      crumb: 'Developers',
      jsonLd: [{ '@context': 'https://schema.org', '@type': 'TechArticle', name: 'BitriPay developer guide', url: absoluteUrl('/developers'), about: 'Payment API' }],
    },
    body,
  );
}

// ---------------------------------------------------------------------------------------------------------------- get started
export function getStartedPage(): string {
  const body = `${hero('Get started', 'Four ways in, one account. Pick the one that fits; you can add the others later from your settings.')}
<section class="sect"><div class="tiles">
<div class="tile"><span class="ico">👤</span><h3>I want to pay and get paid</h3><ol><li>Open an account with your phone number; confirm the code.</li><li>Set your transaction PIN and, if you like, a passkey.</li><li>Add money by mobile money, bank, card or at an agent.</li><li>Scan, send, request, pay bills, top up, save.</li></ol>${ctaRow([{ href: '/register', label: 'Open a personal account', primary: true }])}</div>
<div class="tile"><span class="ico">🏪</span><h3>I run a business</h3><ol><li>Register as a merchant with your business name.</li><li>Print your QR, create payment links, set your settlement profile.</li><li>Complete business verification (KYB) as your volume grows.</li><li>Connect your systems with an API key and webhooks.</li></ol>${ctaRow(
    [
      { href: '/register?role=merchant', label: 'Open a merchant account', primary: true },
      { href: '/developers', label: 'Developers' },
    ],
  )}</div>
<div class="tile"><span class="ico">🧑‍💻</span><h3>I build software for others</h3><ol><li>Open a developer account; it comes with a sandbox and test keys.</li><li>Your clients open merchant accounts and add you to their team with the developer role.</li><li>Create each client's keys and webhooks in its workspace; integrate with checkout, widget, plugins or SDKs.</li><li>Go live with a live key once the client is verified; the client can remove you at any time.</li></ol>${ctaRow(
    [
      { href: '/register?role=developer', label: 'Open a developer account', primary: true },
      { href: '/developers', label: 'API reference' },
    ],
  )}</div>
<div class="tile"><span class="ico">🤝</span><h3>I want to be an agent</h3><ol><li>Register as an agent with your shop details.</li><li>Pass identity verification and agent due diligence.</li><li>Fund your float; start cash-in and cash-out with one-time codes.</li><li>Earn the commission of every completed operation; read your monthly statement.</li></ol>${ctaRow([{ href: '/register?role=agent', label: 'Apply as an agent', primary: true }])}</div>
</div></section>
<section class="sect"><h2>No smartphone? No problem.</h2><p class="lead">Dial the USSD menu or send SMS commands for balance, transfers, bill payments and cash-out codes; open the Lite site on any browser. The same account, the same limits, the same receipts.</p><p class="lead">Questions before you start: <a href="/how-it-works">how it works</a>, <a href="/legal/fees">fees</a>, <a href="/legal/safeguarding">how funds are protected</a>, <a href="/contact">contact us</a>.</p></section>`;
  return page(
    {
      title: 'Get started',
      description: 'Open a personal, merchant or agent account in minutes: steps, verification, funding and first payment, with USSD, SMS and Lite for feature phones.',
      path: '/get-started',
      crumb: 'Get started',
    },
    body,
  );
}

// ---------------------------------------------------------------------------------------------------------------- growth & influencers
export function growthPage(): string {
  const ref = getReferralSettings();
  const app = getAppSettings();
  const body = `${hero('Growth & influencers', 'Bring people to BitriPay and earn when they use it. Referral rewards are paid into your balance by the ledger, not promised in a spreadsheet; influencer and partner arrangements sit on the same tracking.')}
<section class="sect"><h2>Referral programme</h2><p class="lead">${
    ref.enabled
      ? `Share your code or link. When a person you referred ${ref.trigger === 'first_deposit' ? 'adds money for the first time' : 'registers'}, you receive ${MONEY(ref.rewards[0] ?? 0)}${
          ref.rewards.length > 1
            ? `; the person who referred you receives ${ref.rewards
                .slice(1)
                .map((r) => MONEY(r))
                .join(', then ')} for the levels above`
            : ''
        }. Rewards are promotional credit that covers BitriPay fees and is never withdrawable as money.`
      : 'The referral programme is paused at the moment.'
  }</p><div class="kpis"><div class="kpi"><b>${ref.rewards.length}</b><span>reward level${ref.rewards.length === 1 ? '' : 's'}</span></div><div class="kpi"><b>${MONEY(ref.rewards[0] ?? 0)}</b><span>direct referral reward</span></div><div class="kpi"><b>${ref.trigger === 'first_deposit' ? 'first deposit' : 'registration'}</b><span>when it is paid</span></div></div></section>
<section class="sect"><h2>Influencers and community partners</h2><div class="tiles">
<div class="tile"><span class="ico">📣</span><h3>Your own code and link</h3><p>Every account already has one; partners get a dedicated tag, a QR to print and a link with their name on it. Sign-ups and first deposits are attributed automatically.</p></div>
<div class="tile"><span class="ico">📊</span><h3>Live attribution</h3><p>See referrals, activations and rewards in your Referrals page and in the Insights charts; no screenshots, no monthly reconciliation e-mails.</p></div>
<div class="tile"><span class="ico">💸</span><h3>Paid by the ledger</h3><p>Rewards are posted as transactions with a reference you can trace; commercial partnerships with cash payment are settled through the same payout workflow, at four eyes.</p></div>
<div class="tile"><span class="ico">✅</span><h3>Fair rules</h3><p>One account per person, no self-referral, no reward on accounts closed for abuse. The <a href="/legal/acceptable-use">acceptable-use policy</a> applies to every campaign.</p></div>
</div></section>
<section class="sect"><h2>Merchant growth tools</h2><p class="lead">Payment links you can post anywhere, a QR centre with analytics per code and location, an acceptance score that tells you where customers drop off, subscriptions with dunning, and an agent network that lets customers cash in near you. Agents earn ${pct(app.agentCommissionBps)} by default on operations without a tariff-specific commission.</p>${ctaRow(
    [
      { href: '/register', label: 'Get your referral code', primary: true },
      { href: '/contact', label: 'Propose a partnership' },
      { href: '/app/referrals', label: 'My referrals' },
    ],
  )}</section>`;
  return page(
    {
      title: 'Growth & influencers',
      description:
        'Referral rewards paid by the ledger, influencer and partner attribution with a dedicated tag, QR and link, and merchant growth tools: payment links, QR analytics, acceptance score.',
      path: '/growth',
      crumb: 'Growth',
    },
    body,
  );
}

// ---------------------------------------------------------------------------------------------------------------- all policies
export function policiesPage(): string {
  const pages = listPages(true).filter((p) => !['about', 'contact'].includes(p.slug));
  const known = new Set(FOOTER_LINKS.legal.map((l) => l.href));
  const body = `${hero('All policies', 'Every policy and legal document in one place, with the date it was last updated. They are part of the agreement you accept when you open an account.')}
<section class="sect"><div class="table-wrap"><table class="grid"><tr><th>Document</th><th>Last updated</th></tr>${pages
    .map(
      (p) =>
        `<tr><td><a href="/legal/${escapeHtml(p.slug)}">${escapeHtml(p.title)}</a>${known.has(`/legal/${p.slug}`) ? '' : ' <span class="pill muted">information</span>'}</td><td>${escapeHtml(new Date(p.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}</td></tr>`,
    )
    .join('')}</table></div>
<p class="lead" style="margin-top:14px">Questions about any policy: <a href="/contact">contact us</a> or write to the address on the <a href="/legal/complaints">complaints page</a>. Changes to fees are announced to affected accounts before they apply.</p></section>`;
  return page(
    {
      title: 'All policies',
      description:
        'Terms of service, privacy, cookies, acceptable use, AML and KYC, safeguarding, refunds, complaints, accessibility, agent and merchant agreement, fees and security: every BitriPay policy with its last update.',
      path: '/policies',
      crumb: 'Policies',
    },
    body,
  );
}

// ---------------------------------------------------------------------------------------------------------------- platform status
export function statusData() {
  const state = getOperatingState();
  const rails = listRails().filter((r) => r.enabled);
  const slo = sloReport();
  const chain = verifyEventChain();
  const guardian = listGuardianChecks(1)[0] ?? null;
  const railStates = rails.map((r) => ({ id: r.id, name: r.name, kind: r.kind, mode: r.mode, state: r.health.state, paused: r.health.paused }));
  const degraded = railStates.filter((r) => r.state !== 'HEALTHY').length;
  const overall = state.mode === 'halted' ? 'major' : state.mode === 'degraded' || degraded > 0 || !chain.ok ? 'degraded' : 'operational';
  return {
    overall,
    checkedAt: new Date().toISOString(),
    api: { ok: true, version: config.appName, mode: state.mode, reason: state.reason ?? null },
    integrity: { eventChain: chain, lastGuardianCheck: guardian ? { ok: guardian.ok, createdAt: guardian.createdAt, findings: guardian.findings.length } : null },
    rails: railStates,
    slo: slo.classes.filter((c) => c.target).map((c) => ({ class: c.class, label: c.target!.label, p95Ms: c.windows['24h'].p95Ms, p99Ms: c.windows['24h'].p99Ms, requests: c.windows['24h'].count })),
    switchAvailability: slo.switchAvailability['24h'],
  };
}
export function statusPage(): string {
  const s = statusData();
  const dot = s.overall === 'operational' ? 'ok' : s.overall === 'degraded' ? 'warn' : 'bad';
  const label =
    s.overall === 'operational' ? 'All systems operational' : s.overall === 'degraded' ? 'Degraded: some rails or checks need attention' : 'Money movement paused while the ledger is verified';
  const pill = (st: string) => (st === 'HEALTHY' ? 'ok' : st === 'DEGRADED' ? 'warn' : 'bad');
  const body = `${hero('Platform status', 'Live, unedited state of the platform read at the moment you loaded this page: operating mode, ledger integrity, payment rails and measured service levels over the last 24 hours. Machine-readable at /status.json.')}
<section class="sect"><div class="status-big"><span class="dot ${dot}"></span>${escapeHtml(label)}</div><p class="lead">Checked ${escapeHtml(new Date(s.checkedAt).toUTCString())}. Operating mode: <b>${escapeHtml(s.api.mode)}</b>${s.api.reason ? ` — ${escapeHtml(s.api.reason)}` : ''}.</p>
<div class="kpis"><div class="kpi"><b>${s.integrity.eventChain.ok ? 'intact' : 'broken'}</b><span>event chain · ${s.integrity.eventChain.checked} events verified</span></div><div class="kpi"><b>${s.integrity.lastGuardianCheck ? (s.integrity.lastGuardianCheck.ok ? 'clean' : `${s.integrity.lastGuardianCheck.findings} finding(s)`) : 'not yet run'}</b><span>last ledger watchdog check${s.integrity.lastGuardianCheck ? ` · ${escapeHtml(new Date(s.integrity.lastGuardianCheck.createdAt).toUTCString())}` : ''}</span></div><div class="kpi"><b>${s.rails.filter((r) => r.state === 'HEALTHY').length}/${s.rails.length}</b><span>enabled rails healthy</span></div><div class="kpi"><b>${s.switchAvailability.availability === null ? '—' : `${Math.round(s.switchAvailability.availability * 1000) / 10}%`}</b><span>national switch availability · 24 h · target ${Math.round(slo24Target() * 100)}%</span></div></div></section>
<section class="sect"><h2>Payment rails</h2><div class="table-wrap"><table class="grid"><tr><th>Rail</th><th>Kind</th><th>Mode</th><th>Health</th></tr>${s.rails.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.kind)}</td><td>${escapeHtml(r.mode)}</td><td><span class="pill ${pill(r.state)}">${escapeHtml(r.state.toLowerCase())}${r.paused ? ' · paused' : ''}</span></td></tr>`).join('') || '<tr><td colspan="4">No rail enabled</td></tr>'}</table></div></section>
<section class="sect"><h2>Service levels, last 24 hours</h2><div class="table-wrap"><table class="grid"><tr><th>Objective</th><th class="num">Requests</th><th class="num">p95</th><th class="num">p99</th><th>Met</th></tr>${s.slo
    .map((c) => {
      const t = (SLO_TARGETS as Record<string, { percentile: 'p50' | 'p95' | 'p99'; maxMs: number } | null>)[c.class];
      const measured = t?.percentile === 'p99' ? c.p99Ms : c.p95Ms;
      const met = measured === null || !t ? null : measured <= t.maxMs;
      return `<tr><td>${escapeHtml(c.label)}</td><td class="num">${c.requests}</td><td class="num">${c.p95Ms === null ? '—' : `${Math.round(c.p95Ms)} ms`}</td><td class="num">${c.p99Ms === null ? '—' : `${Math.round(c.p99Ms)} ms`}</td><td>${met === null ? '<span class="pill muted">no traffic</span>' : met ? '<span class="pill ok">yes</span>' : '<span class="pill bad">no</span>'}</td></tr>`;
    })
    .join('')}</table></div>
<p class="lead" style="margin-top:12px">Incidents and maintenance are announced to affected accounts through the communication engine (e-mail, in-app, SMS) and on this page. Health probe for monitoring tools: <code>${escapeHtml(config.apiUrl)}/api/health</code>.</p></section>`;
  return page(
    {
      title: 'Platform status',
      description: 'Live status of BitriPay: operating mode, ledger integrity, payment rail health and measured service levels over the last 24 hours.',
      path: '/status',
      crumb: 'Status',
    },
    body,
  );
}
function slo24Target(): number {
  return sloReport().switchAvailability.target;
}

/** Product pages for the sitemap and llms.txt. */
export const PRODUCT_PAGES: { path: string; title: string; note: string }[] = [
  { path: '/how-it-works', title: 'How it works', note: 'account, funding, paying, cashing out, tiers, fees, controls' },
  { path: '/industries', title: 'Industries', note: 'markets, transport, utilities, telecom, e-commerce, schools, government, diaspora, agents' },
  { path: '/enterprise', title: 'Enterprise groups', note: 'organisations, roles, bulk payouts, settlement, integration, SLOs' },
  { path: '/developers', title: 'Developers', note: 'REST API, scopes, hosted and embedded checkout, sandbox, webhooks' },
  { path: '/get-started', title: 'Get started', note: 'personal, merchant, developer and agent onboarding' },
  { path: '/growth', title: 'Growth & influencers', note: 'referral rewards, partner attribution, merchant growth tools' },
  { path: '/policies', title: 'All policies', note: 'every legal document with its last update' },
  { path: '/status', title: 'Platform status', note: 'live operating mode, rails, integrity, service levels' },
];
