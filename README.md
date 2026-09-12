# BitriPay – QR Code Money Transfer & Payment Platform

BitriPay is a complete, ready-to-launch money transfer business built around QR code payments.
It ships with a **customer / merchant / agent web app**, a **mobile app** (iOS & Android), an
**admin panel**, a **payment aggregator** with pluggable gateways, a **merchant payment gateway
with API & webhooks**, and a **WooCommerce plugin**.

```
bitripay/
├── apps/api        Node.js + Express + SQLite REST API (double-entry ledger, auth, gateways, admin)
├── apps/web        React web app for users, merchants and agents + hosted checkout + landing site
├── apps/admin      React admin panel
├── apps/mobile     Expo (React Native) app for users, merchants and agents
├── packages/shared Shared types, money math, QR codec, all ISO countries & currencies, i18n dictionaries
└── integrations/woocommerce-bitripay  WordPress / WooCommerce payment gateway plugin
```

## Features

**Operating principle** – BitriPay is a biometric payment-orchestration platform. It never claims to
move money between unrelated banks, cards or mobile money operators without their regulated rails.
Funds enter through a licensed card processor, a bank or a mobile money operator, and leave through
**prefunded local payout accounts** (merchant SIMs / treasury bank accounts) operated by approved
agents and Android payout devices using USSD, SIM Toolkit or the operator app. Operator confirmation
SMS messages are signed by the device and verified before anything settles; a screenshot is never
settlement evidence. Where automation is unavailable, a human maker-checker decides.

**Example – UK debit card → Orange Money DRC.** The sender enters the recipient's number, country,
operator and amount; the platform quotes rate, margin, fees, recipient amount, payout time, quote
expiry and refund conditions; the sender approves with Face ID / fingerprint / passkey (PIN
fallback); the processor charges the card; once the funds are confirmed the routing engine creates a
DRC payout instruction, selects a prefunded Orange Money account (or `INSUFFICIENT_LIQUIDITY` until
treasury prefunds it); the payout device claims it, pays the recipient by USSD, and forwards the
operator SMS signed with its key and SIM identity; the verification engine matches recipient,
amount, reference, operator, SIM and timestamps, rejects replays/duplicates, and marks the transfer
`SETTLED`; both parties are notified and a receipt with the evidence hashes is available.

**Essential limitation** – "no operator API" is not "no payment rail". Without a direct operator or
bank API settlement is not instantaneous, payouts may need an authorised agent, operator interface
changes can interrupt automation, operator limits still apply, and reversals may require manual
processing. The UI says so everywhere it matters.

**Transfer lifecycle** – `CREATED → QUOTED → BIOMETRIC_APPROVAL_REQUIRED → FUNDING_PENDING →
FUNDED → PAYOUT_ROUTED → PAYOUT_SENT → EVIDENCE_RECEIVED → VERIFYING → SETTLED`,
with `EXPIRED · FAILED · MISMATCHED · DUPLICATE · INSUFFICIENT_LIQUIDITY · MANUAL_REVIEW · DISPUTED ·
REVERSED · REFUNDED`. External funds never become spendable or `SETTLED` because a customer,
administrator or agent says a payment was made.

**Non-negotiable compliance requirement** – accepting money in one country and paying a beneficiary
in another is a cross-border remittance / money-transfer service whatever the payout technique.
The platform ships in **compliance mode `sandbox`**: only the sandbox processor and the evidence
rails may fund transfers, and every corridor starts as `sandbox`. Switching the platform to `live`
and marking a corridor `live` (which records the authorised collection partner, payout partner and
licence reference under administrator step-up) is required before a real processor is accepted on
that corridor. Licensing, KYC/KYB, sanctions screening, source-of-funds controls, transaction
monitoring, agent due diligence, consumer safeguarding, data protection and country-specific
mobile-money / FX approvals are the operator's responsibility; the software enforces the gate, it
does not replace the authorisation.

**Payment lifecycle** – every payment intent moves through
`CREATED → AUTHENTICATION_REQUIRED → INSTRUCTION_ISSUED → PAYMENT_SENT → EVIDENCE_RECEIVED → VERIFYING → CONFIRMED → SETTLED`
with the exception states `EXPIRED · REJECTED · MISMATCHED · DUPLICATE · DISPUTED · REVERSED · MANUAL_REVIEW`.
An intent settles only after (1) biometric or approved-fallback authentication, (2) confirmation from
a processor, a device-signed SMS or an authorised verifier, (3) matching of reference, amount,
currency, sender, recipient and time window, (4) duplicate/replay checks, (5) fraud and sanctions
controls and (6) a balanced double-entry posting. Every stage change is time-stamped, attributable and
appended to a hash-chained, append-only event log. The UI always distinguishes *initiated*,
*confirmed* and *settled*.

**Any → any routing** – fund from a card, bank transfer, mobile money or your wallet and deliver to a
BitriPay user, a QR code / payment link, a bank account, any mobile money number or cash at an agent
in one request (`POST /api/money`). Each logical route is *declared* (`GET /api/money/catalog`):
initiation method, confirmation method, settlement mechanism, expected completion, fees and rate,
refund method, and whether processing is automatic, assisted or manual.

**No-API verification engine** – a directory of 253 mobile money operators in 128 countries ships in
`@bitripay/shared`. Give an operator your collection number and customers pay from their own app or
USSD with a reference. The receipt SMS is forwarded by a **registered device** that signs each message
with its Ed25519 key (`POST /api/evidence/sms`); the engine parses it with configurable
operator-specific templates, extracts reference / amount / currency / sender / recipient / timestamp /
balance, matches it to the intent, rejects reused references, replayed nonces, altered messages and
inconsistent amounts, and settles automatically only above the configured confidence with a trusted
device. Everything else – unsupported messages, low confidence, shared-secret webhooks, manual
entries – lands in the **verification console**, where one administrator proposes and a *different*
administrator approves under biometric/PIN step-up (maker-checker). Screenshots and typed references
are stored as supporting notes only, never as authoritative evidence. Raw evidence, parsed values,
verifier identity and the full history are preserved.

**Cards** – card payments require a licensed acquiring processor (Stripe, Paystack, Flutterwave).
The sandbox processor runs the full flow end to end for development and must stay disabled in
production.

**Biometric authentication** – passkeys (WebAuthn) on the web app and hosted checkout; Android
BiometricPrompt / Face ID / Touch ID through `expo-local-authentication` in the apps; PIN fallback.
Step-up approval is required for payments, beneficiary changes (bank accounts, saved recipients),
withdrawals and administrative approvals. Biometric templates never leave the device: the
authenticator signs a server-issued challenge with its device-bound private key.

**Foreign exchange** – before authorising a conversion the customer sees source and destination
currencies, the reference (mid-market) rate, the rate provider and timestamp, the markup, all charges,
the exact amount sent, the estimated amount received and the rate expiry. Live, fresh rates can be
locked for the quote TTL; administrator-entered or stale rates are labelled and never guaranteed.

**Regulated e-money, never unbacked money** – BitriPay balances are a redeemable claim on the
authorised issuer (BitriPay under its own e-money authorisation, or a licensed bank / EMI for which
BitriPay is the distributor), never commercial-bank deposit money. The issuance engine enforces

    issuable ≤ cleared safeguarded funds − redemptions pending − reserved exposure − e-money outstanding

at request time and again at execution. Reserve funding is confirmed by one treasury administrator
and checked by another (bank reference + statement evidence); issuance requests go through
maker-checker with step-up; minting posts *debit safeguarded cash asset / credit e-money liability*
and redemption the reverse; distribution pools (issuer → treasury → country pool → institution /
master agent → agent / merchant → user) move existing e-money and never create it. A daily 1:1
reserve-to-liability reconciliation suspends issuance automatically on a breach and alerts every
administrator. Balances are classified on every view: regulated e-money, merchant balance, agent
float, promotional credit (a marketing liability that only covers BitriPay fees – never withdrawable
or transferable) and sandbox money (no real-world value, the default until an administrator completes
the go-live checklist and marks a programme live). Administrators can freeze, release, redeem and
correct through compensating entries, but can never edit ledger history, delete a completed
transaction, bypass maker-checker or disguise promotional credit as money.

**Recipient-controlled payout currency** – the destination country's local currency is always the
default. Another currency is offered only when, right now, the corridor permits it, the destination
institution or agent can legally pay it, prefunded liquidity exists, the recipient account supports
it and FX / capital-control approval is on record. Regulated corridors can require the beneficiary
to confirm a non-local currency through a public confirmation link before anything is executed.
Every quote shows send amount, default and optional receiving currencies, rate and source, FX
margin, all fees, the guaranteed recipient amount (or that the rate is indicative), quote expiry,
delivery estimate, the declared confirmation method of each leg and the payout / refund conditions.

**Bank-grade statements** – every account holder can generate numbered, hashed statements per
currency and period (opening balance, each ledger posting with running balance, holds, promotional
credit, closing balance) as JSON, CSV or PDF, verifiable by anyone through
`GET /api/statements/verify/:id` without exposing personal data.

**Very loud alerts** – money events (payment received, payout completed, transfer under review,
issuance suspended, new maker-checker items) ring an alarm tone with a long vibration pattern on
the mobile app (max-importance channel that bypasses Do-Not-Disturb), the web app, the admin
console and the payout device; each user can switch loud alerts off.

**Controls** – `Idempotency-Key` on every mutating request, timestamped webhook signatures with replay
protection, sanctions list screening, velocity limits, cooling-off for new beneficiaries,
device registration / revocation / risk scoring, per-currency ledger balance assertion on every
posting, append-only audit / event / ledger tables (database triggers), reconciliation endpoint.

**Users** – transfer & receive with QR code, send money by @tag / email / phone, money requests,
payment links, add money (card, mobile money, bank transfer, agent cash-in), withdraw to bank,
cash-out at an agent, remittance (wallet, bank transfer, cash pickup), saved recipients,
multi-currency wallets with real-time exchange, virtual cards, gift cards, bill payment, mobile
top-up, P2P currency trading with escrow, offers/counter-offers and trade chat, referral rewards
(multi-level), transaction logs, phone & email OTP authentication, 2FA (TOTP), transaction PIN,
biometric login (mobile), push notifications, KYC verification, support tickets, live chat,
profile & password management, 8 languages, dark/light mode.

**Merchants** – accept payments with static and dynamic QR codes (point of sale), payment links
and invoices, hosted checkout accepting wallet / QR, card, mobile money, bank transfer and BitriPay
virtual cards, manage gateway (methods, branding, success/cancel URLs, auto-settlement), API keys,
signed webhooks with delivery log, refunds, sales analytics, settlements, WooCommerce plugin.

**Agents** – cash-in (credit customer wallets from float), cash-out with customer codes, remittance
cash pickup payout with ID check, commission per transaction, agent QR code, stats.

**Admin** – analytics dashboard, user / merchant / agent / admin care with role permissions,
all transaction logs with refunds and CSV export, approvals (withdrawals, bank deposits,
remittances, settlements), KYC review, currency setup with **all ISO 4217 currencies** and
automatic exchange-rate refresh, fees & charges, limits, referral level packages, payment
gateway aggregator setup (Sandbox, Stripe, Paystack, Flutterwave, MTN MoMo, M-Pesa, manual bank),
module toggles, country restrictions, bill-pay / top-up / gift-card catalogs, web & SEO settings,
image assets, splash & onboarding screens, app URLs, useful links, GDPR cookie, pages CMS,
language management with translation overrides, SMTP & SMS setup, push broadcasts, newsletter,
contact inbox, support tickets, live chat, P2P dispute resolution, reports, audit logs,
maintenance mode, admin profile & 2FA, dark mode.

## Quick start

Requirements: Node.js 20+ (22 recommended).

```bash
npm install
cp apps/api/.env.example apps/api/.env      # optional – defaults work for local development
npm run dev                                  # API :4000, web app :5173, admin :5174
```

Seed demo accounts (user, merchant, agent, sample transactions):

```bash
npm run seed
```

| Role     | Login                    | Password       | PIN  |
| -------- | ------------------------ | -------------- | ---- |
| Admin    | admin@bitripay.local     | Admin123!      | –    |
| User     | alice@example.com        | Password123!   | 1234 |
| User     | bob@example.com          | Password123!   | 1234 |
| Merchant | merchant@example.com     | Password123!   | 1234 |
| Agent    | agent@example.com        | Password123!   | 1234 |

Open http://localhost:5173 (web app) and http://localhost:5174 (admin).
The **sandbox gateway** is enabled in development: card `4242 4242 4242 4242` succeeds, cards ending
in `0002` are declined, mobile-money prompts auto-approve after a few seconds, and bank transfers are
confirmed in Admin → Approvals. Without SMTP/SMS configured, OTP codes are printed to the API console
and returned as `devCode` (never in production).

### Landing page

`apps/web/src/pages/Landing.tsx` is the public home page: a canvas-drawn cinematic hero with real
product screenshots in a device frame, the three people the product is designed around, the money
lifecycle, product pillars, the safeguarding rule, merchant and agent sections, an FAQ (also emitted as
JSON-LD) and the latest articles. Its styles are self-contained in `landing.css`.

### Run the mobile app

```bash
cd apps/mobile
npm install
# point the app at your API (edit app.json → expo.extra.apiUrl / webUrl, use your LAN IP for a device)
npx expo start
```

Scan the Expo QR code with Expo Go, or build with EAS (`eas build`). Camera scanning, biometric
unlock, push notifications and deep links (`bitripay://`, `https://pay.bitripay.app/pay/CODE`) are
configured in `app.json`.

### Run the Android payout device / SMS forwarder

`apps/payout-device` is the app for the phone that holds a merchant or agent SIM: it enrols with a
device-generated Ed25519 key, polls its payout queue with signed requests, dials the operator USSD
menu, and signs and forwards every operator confirmation SMS the instant it arrives (a native
`SMS_RECEIVED` receiver, `modules/sms-receiver`). Its protocol is unit-tested in Node against the
API's own verifier.

```bash
cd apps/payout-device
npm install
npm test                                   # protocol interop + forwarder tests
npx expo prebuild --platform android       # applies the sms-receiver config plugin
npx expo run:android                       # needs Android SDK 34+ / JDK 17, or use EAS
```

The native module was not compiled in this repository's build container (no Android SDK); see
`apps/payout-device/README.md` for permissions, distribution (managed / enterprise, not the public
Play store) and operating notes.

### Tests

Browser smoke tests (`scripts/e2e-*.mjs`, Playwright) cover the web and admin apps, including
`scripts/e2e-gateway.mjs`: passkey registration and biometric sign-in with a virtual authenticator,
PIN-gated intents on the direct rail, device-signed SMS settlement, forged-signature rejection,
maker-checker approval in the verification console and biometric step-up on Move money.

The API suite covers the e-money engine (reserve rule, maker-checker, redemption, reconciliation
breach → suspension, pools, freezes), recipient currency choice and consent, statements, the corridor
operating model and the gateway acceptance criteria.

```bash
npm test          # shared unit tests + API integration suite (vitest)
npm run typecheck # TypeScript across api, web and admin
```

## Configuration

All configuration lives in `apps/api/.env` (see `.env.example`). Everything except secrets can also
be changed at runtime in the admin panel and is stored in the database:

- **Gateways** (`Admin → Deposit / payment gateways`): enable providers and paste credentials.
  Environment variables are used as defaults; admin-entered credentials are encrypted with `APP_SECRET`.
  Provider webhooks go to `POST /api/webhooks/<gatewayId>` (e.g. `/api/webhooks/stripe`).
- **Mobile money operators** (`Admin → Mobile money operators`): enter your collection number per operator to
  accept it directly; set the SMS shared secret to auto-confirm from forwarded receipt SMS.
- **Passkeys**: `WEBAUTHN_RP_ID` (defaults to the `WEB_URL` hostname) and `WEBAUTHN_ORIGINS` (extra allowed origins).
- **Exchange rates**: manual or automatic from `open.er-api.com` / Frankfurter (keyless);
  set the provider and refresh interval in `Admin → Currencies`.
- **Fees / limits / referral / modules / countries / site / pages / languages / SMTP / SMS**: admin panel.

## API overview

All money amounts are integers in minor units (cents). Authentication: `Authorization: Bearer <JWT>`
for apps, `Authorization: Bearer bp_live_…` (merchant API key) for the v1 API.

| Area | Endpoints |
| --- | --- |
| Auth | `POST /api/auth/register`, `/login`, `/otp/request`, `/otp/verify`, `/2fa/verify`, `/password/forgot`, `/password/reset`, `GET /api/auth/me` |
| Account | `PATCH /api/account/profile`, `POST /api/account/pin`, `/password`, `/2fa/setup|enable|disable`, `/verify/request|confirm`, `GET /api/account/notifications`, `/referrals`, `/lookup?q=` |
| Wallets | `GET /api/wallets`, `POST /api/wallets`, `GET /api/wallets/transactions`, `/summary`, `/exchange/quote`, `POST /api/wallets/exchange` |
| Any → any | `POST /api/money` (source: wallet/card/bank/mobile_money → destination: wallet/qr/bank/mobile_money/agent; `quoteId` locks a guaranteed FX quote), `POST /api/money/preview` (quote + FX disclosure + route declaration), `GET /api/money/catalog`, `GET /api/money/:id`, `POST /api/money/:id/retry`, `GET /api/mobile-money-operators` |
| Evidence | `POST /api/evidence/sms` (device-signed receipt SMS), `GET /api/evidence/canonical-format`, `GET/POST/DELETE /api/evidence/devices` (admins/agents; payout devices register SIM identity), `POST /api/evidence/parse-test` |
| Payouts | Device (signed headers `X-Device-Id/-Timestamp/-Signature`): `GET /api/payouts/device/queue`, `POST /api/payouts/device/:id/claim|release|evidence`. Agent: `GET /api/payouts/agent/queue`, `POST /api/payouts/agent/:id/claim|release|evidence` (manual → maker-checker) |
| Corridors | `GET /api/money/corridors`, `POST /api/money/:id/cancel`, `GET /api/money/:id/receipt`; admin `/api/admin/corridors` (+ `/:id/status` live/suspended with arrangements), `/api/admin/liquidity` (+ `/accounts`, `/accounts/:id/prefund|adjust|movements`), `/api/admin/payouts` (+ `/:id`, `/requeue|release|settle|fail|cancel`), `/api/admin/money-routes/:id/release|refund`, `/api/admin/chargebacks` (+ `/:id/resolve`), settings key `compliance` |
| Biometrics | `POST /api/auth/passkey/options|verify` (sign-in), `GET/DELETE /api/account/passkeys`, `POST /api/account/passkeys/register/options|verify`, `POST /api/account/passkeys/step-up/options|verify` → `X-Step-Up-Token` |
| Payments | `POST /api/transfers`, `GET /api/qr/me`, `POST /api/qr/resolve`, `GET /api/qr/image.svg`, `POST /api/payment-requests`, `/:code/pay|cancel|decline` |
| Checkout (public) | `GET /api/checkout/:code`, `POST /api/checkout/:code/pay` (card / mobile money / bank / virtual card), `/:code/wallet` |
| Add money | `GET /api/deposits/options`, `POST /api/deposits` (`pin` or `X-Step-Up-Token`), `POST /api/deposits/:id/authenticate`, `GET /api/deposits/:id`, `POST /api/deposits/:id/sent` (payer's sent-report, non-authoritative), `GET /api/deposits/:id/events`, `GET /api/cards` |
| Withdraw | `GET/POST /api/bank-accounts`, `POST /api/withdrawals` |
| Agents | `GET /api/agents`, `POST /api/agents/cash-out`, `POST /api/agents/me/cash-in`, `/me/cash-out/confirm`, `/me/pickups/:code/payout`, `GET /api/agents/me/stats` |
| Remittance | `GET /api/remittances/quote`, `POST /api/remittances`, `GET/POST /api/recipients` |
| Services | `/api/virtual-cards`, `/api/bills`, `/api/topups`, `/api/gift-cards`, `/api/p2p/ads`, `/api/p2p/trades`, `/api/support/tickets`, `/api/support/chat`, `/api/kyc` |
| Merchant | `/api/merchant/stats`, `/gateway`, `/api-keys`, `/webhook`, `/settlements`, `POST /api/merchant/transactions/:id/refund` |
| Merchant API v1 | `POST /v1/payment-requests`, `GET /v1/payment-requests/:code`, `POST /v1/payment-requests/:code/cancel`, `GET /v1/transactions`, `GET /v1/balance`, `GET /v1/me` |
| Admin | `/api/admin/*` (stats, users, transactions, withdrawals, payments, remittances, kyc, settings, currencies, gateways, billers, operators, gift-products, pages, languages, translations, support, p2p, reports, audit-logs, …) |
| Verification | `GET /api/admin/verifications`, `GET /api/admin/payments/:id/case`, `POST /api/admin/payments/:id/confirm|reject` (propose), `POST /api/admin/verifications/:id/approve|decline` (second admin, step-up), `POST /api/admin/payments/:id/evidence`, `GET /api/admin/evidence`, `/evidence/devices`, `/evidence/templates`, `GET /api/admin/events` (hash chain), `GET /api/admin/reconcile`, `/sanctions`, `/risk-events`, `/route-catalog`, settings keys `gateway`, `fx`, `risk` |

Webhooks to merchants are signed with a timestamp for replay protection:
`X-BitriPay-Signature: t=<unix seconds>,v1=<HMAC-SHA256("<t>.<rawBody>", webhookSecret)>` plus
`X-BitriPay-Delivery-Id`. Reject deliveries older than 5 minutes and process each delivery id once.
Events: `payment.completed`, `payment_request.created`.

Mutating requests accept an `Idempotency-Key` header: a repeat with the same key and body replays the
stored response (`Idempotent-Replayed: true`); a repeat with a different body is refused (422).

### Public site, blog and SEO engine

The marketing surface is **server-rendered by the API** so search engines, social previews and AI answer
engines (GPTBot, ClaudeBot, PerplexityBot are explicitly allowed in `robots.txt`) receive complete HTML:
`/blog`, `/blog/:slug`, `/legal/:slug`, `/about`, `/contact`, `/sitemap.xml` (with hreflang),
`/feed.xml`, `/robots.txt`, `/llms.txt` and `/llms-full.txt`. In development Vite proxies these paths
to the API; in production the web container's nginx does the same. Every page carries canonical,
Open Graph and Twitter tags plus JSON-LD (`FinancialService` organisation, `WebSite` with
`SearchAction`, `Article`, `FAQPage`, `BreadcrumbList`, `Blog`, `AboutPage`).

- **Dynamic hyperlinks** – keyword → URL rules (Admin → Blog & SEO → Dynamic links) are applied at render
  time to articles and policy pages, and every published article's target keywords automatically link to
  it from other articles. Links are never inserted inside headings, code or existing links.
- **Backlinks** – inbound links are discovered from referrers (search engines and social hosts are
  ignored), partner and outbound links are tracked and re-verified weekly, and an outreach list shows the
  sites your articles cite that do not link back yet. Page views are counted per path, never per person.
- **Content agent** – built on the Anthropic SDK (`claude-opus-5` by default, adaptive thinking,
  structured JSON output). It drafts articles from a topic backlog on a weekly cadence or on demand,
  proposes long-tail keywords, audits articles (deterministic on-page checks plus editorial judgement),
  writes platform-native social packs and suggests internal links. Drafts always land in **review**
  unless auto-publish is switched on; without an API key the agent runs in a clearly labelled offline
  mode with template drafts and automated checks, so the pipeline still works. Every run is logged with
  model and token usage.
- **IndexNow** – set a key in SEO settings; it is published at `/<key>.txt` and Bing/Yandex/Seznam/Naver
  are pinged on every publish.
- **Policies** – privacy, terms, cookies, acceptable use, AML/KYC, safeguarding, refunds, complaints,
  accessibility, fees, security, regulatory information and the agent & merchant agreement ship as real
  texts (Admin → Pages to edit), together with the *About us* page and a site-wide footer.

Rankings cannot be promised by any tool; what the engine guarantees is that every technical and
editorial signal the engines look for is present and consistent.

### Command centres and agents

Every account holder gets a **command centre** (`/app/assist` on the web, *Command centre* on the phone) with a fixed
set of agents for their role: Chief of Staff, Analyst, Research, Automation, Security and Knowledge for everyone,
Growth for merchants and cash agents, and Operations, Compliance and System Health for administrators (these three
also run every morning and report by notification).

- **Tool gateway** (`services/assist/tools.ts`) – agents reach the platform only through typed tools over the existing
  services (balances, transactions, statements, quotes, routes, rates, profile, knowledge, merchant stats, payout
  queue, administrative reads). Money-moving capabilities are not tools: a send, top-up, withdrawal or exchange becomes
  an `actions.propose` card the account holder confirms with PIN or passkey. Three administrative actions (freeze a
  wallet, run a reconciliation, notify administrators) exist; the first two require a **second administrator** to
  approve under step-up, exactly like the existing maker-checker.
- **Policy engine** (`services/assist/policy.ts`) – layered rules (global → agent → account) with deny, require-approval
  and allow lists plus step and daily-run limits; permissions are the intersection of the agent's tool list, the
  account's role and, for staff, their admin permissions. Publishing a policy needs step-up and keeps every version.
- **Run controller** (`services/assist/runtime.ts`) – builds context (identity, balances, memories), runs the model's
  tool loop through the gateway with the Anthropic SDK (streaming, adaptive thinking), enforces step and token
  budgets, meters **Agent Compute Units** (1 ACU = one US cent of model spend at the configured list prices) against a
  monthly allowance per role, persists every step in `agent_runs` / `agent_actions` and the hash-chained event log,
  and streams progress over server-sent events. With no model key the same tools are driven by a deterministic
  planner, so every command centre works offline and in tests.
- **Memories** – only what the account holder explicitly asks to keep; viewable and deletable in the command centre.
- **Admin → Agents & command centres** – registry with pause/resume, a global kill switch, the approvals inbox,
  a runs explorer with every tool call, the policy editor, usage and cost, and model settings (permission `agents`).

**Per-question pricing, lawful and self-funding.** The agents are available to everyone; nothing is taken
silently and the platform can never lose money on them:

- **Disclosed once, shown always.** Before the first paid question the account holder reads the prices and accepts
  (versioned consent in `agent_consents`; any price change bumps the version and everyone re-reads it). The Ask
  button shows the price of the question; every charge appears in transactions and statements as
  `Agent question · <agent>`, a normal `agent_usage` ledger posting to the fees account with the tax share in its
  metadata.
- **Free where it costs nothing.** Lookups the offline planner answers from the account's own records (balances,
  statements, activity, fees, routes) are free even when a model is available. Failed runs are never charged.
- **Cost-based routing.** Standard questions go to the fast model (default £0.05, tax inclusive); in-depth analyses
  on the main model (default £0.35) only for the roles allowed to ask (merchants, agents, administrators).
- **Charged on completion, only if covered.** The wallet is checked before the run and charged after the answer;
  an account whose balance does not cover the price is told the price and can still use the free lookups.
- **A small allowance funded by fee income.** Five free standard questions a month for accounts that moved money
  that month (configurable); inactive accounts get none, so it cannot be farmed.
- **Caps that degrade instead of spending.** Per-run token budget, per-account daily cap on paid questions, and a
  platform-wide monthly cap on model spend set as a share of last month's net fee revenue (default 15%, with a
  floor). Past the cap every run falls back to the free planner and the console shows it.
- **Margin report.** Admin → Agents → Billing & margin shows revenue, tax to remit, model cost, margin, cap usage
  and runs by billing outcome; the optional flat plan (unlimited questions per period) remains available under
  Settings for heavy users. Administrators never pay.

API: `GET /api/assist/agents` (includes `billing`), `GET /api/assist/billing`, `POST /api/assist/consent`, `POST /api/assist/runs` (`depth`, `currency`; errors `consent_required`, `insufficient_balance`, `daily_cap`), `POST /api/assist/addon/activate` (flat plan) (`?wait=1` to block), `GET /api/assist/runs/:id/stream` (SSE),
`GET/PUT /api/assist/instances/:agent`, `GET/POST/DELETE /api/assist/memories`, `GET /api/assist/usage`; administrators
use `/api/admin/agents/*`. The full design is in `docs/operating-system/` (rendered as `BitriPay-OS.html`).

### USSD, SMS commands and BitriPay Lite (no smartphone, no data)

BitriPay works from any phone, including feature phones and browsers on 2G:

- **USSD** (`POST /api/ussd`) – a menu on any phone: register with a name and PIN, balance, send money, my code,
  cash-out code for an agent (agents confirm codes from their own phone), pay a merchant, mini statement, language
  (English, French, Swahili) and help. Accepts Africa's Talking form fields (`sessionId`, `phoneNumber`, `text` with
  the full `1*2*…` path) and replies `CON …` / `END …`, or generic JSON (`{sessionId, phone, input}` one step at a
  time, path kept in `ussd_sessions`) with `?format=json`. Every action uses the same services, limits and PIN checks
  as the app, plus a per-channel ceiling per transaction.
- **SMS commands** (`POST /api/sms/inbound`) – `BAL PIN`, `SEND amount [CUR] @code PIN`, `PAY amount @merchant PIN`,
  `CASH amount @agent PIN`, `STMT PIN`, `CODE`, `REG name PIN`, `HELP`. Accepts Twilio (`From`/`Body`, replies TwiML),
  Africa's Talking (`from`/`text`) or generic field names, replies synchronously in plain text, TwiML or JSON, and
  also sends the reply through the configured SMS provider.
- **BitriPay Lite** (`/lite`) – server-rendered pages with no JavaScript, fonts or images (a few KB each): sign in with
  phone + PIN or email + password, balances, send, receive code, cash-out code, history and statements (HTML, CSV,
  PDF), registration. Sessions are opaque revocable cookies.
- **Admin → USSD, SMS & Lite** – aggregator format, ceilings, webhook secrets (`X-Channel-Secret`), a phone simulator
  that drives the real menu, recent sessions and the SMS log.

### Transaction lifecycle

Cross-rail transfers move through `CREATED → QUOTED → BIOMETRIC_APPROVAL_REQUIRED →
BIOMETRICALLY_APPROVED → FUNDING_PENDING → FUNDED → FX_RESERVED → PAYOUT_ROUTED → PAYOUT_SENT →
EVIDENCE_RECEIVED → VERIFYING → VERIFIED → SETTLED`, with the exception states
`INSUFFICIENT_LIQUIDITY`, `AWAITING_CONFIRMATION` (beneficiary currency consent / operator
confirmation), `MISMATCHED`, `DUPLICATE`, `MANUAL_REVIEW`, `FAILED`, `EXPIRED`, `DISPUTED`,
`REVERSED` and `REFUNDED`. Each external leg declares its confirmation method
(`PROCESSOR_WEBHOOK`, `SIGNED_SMS_FORWARDER`, `SECURED_DEVICE_CONFIRMATION`,
`AGENT_WITH_EVIDENCE`, `ADMIN_MAKER_CHECKER`) and the method that actually settled it is recorded on
the transfer. Nothing is ever marked settled from a screenshot or an unverified statement.

### E-money console

Admin → *E-money & reserves*: issuer programmes per currency and jurisdiction (issuer model,
licence, regulator, safeguarding account, limits), reserve movements with maker-checker
confirmation, headroom per programme, distribution pools with step-up allocation, reconciliation
history and the immutable issuance register. `GET /api/admin/emoney` returns the outstanding supply,
every programme's reserve position and pending proposals; `POST /api/admin/emoney/reconcile` runs
the reconciliation on demand. The `treasury` admin permission (TREASURY_SUPER_ADMIN) is required for
reserves, pools, freezes and programme status; `issuance` for issuance requests and approvals.

### Going live: processors, rates and corridor arrangements

Everything ships in **sandbox** and stays there until an administrator deliberately completes the
go-live checklist (`GET /api/admin/go-live`, Admin → Gateway controls → *Go-live checklist*):

- **Processor onboarding** – Stripe, Paystack and Flutterwave credentials are health-checked against
  the processor (`POST /api/admin/gateways/:id/test`), their mode (test / live) is derived from the
  keys, live keys are hidden while the platform is in sandbox mode, 3-D Secure is configurable per
  gateway (Stripe `automatic` / `any`; hosted checkouts apply it themselves), webhook URLs and
  signing secrets are part of the checklist, and disputes / refunds arrive as webhook events.
- **Live rate providers** – Frankfurter (ECB) and open.er-api need no key; exchangerate.host,
  Open Exchange Rates and Fixer take an encrypted API key. Every refresh writes a versioned snapshot
  (`rate_snapshots`), failures alert administrators, staleness is reported by
  `GET /api/admin/currencies/rate-status`, and `POST /api/admin/currencies/import` loads a signed-off
  rate sheet where the provider is unreachable. Bundled `test_rates_v1` rates are labelled as such
  and never guaranteed.
- **Corridor regulatory arrangements** – each corridor records its regulator, licence type and
  number, safeguarding account, AML programme reference, licence expiry, plus data-protection, FX
  approval, consumer-disclosure and agent-supervision references. A corridor cannot be marked live
  until the mandatory items, a tested processor and an active prefunded payout account exist; expired
  licences suspend the corridor automatically and notify administrators.
- Switching `compliance.mode` to `live` is refused while any blocking checklist item is open and
  always requires a fresh step-up.

### Signed SMS evidence (no operator API)

The SMS-forwarder app on the collection phone generates an Ed25519 key pair, keeps the private key in
secure storage and registers the public key (PEM or raw base64) as an evidence device. For each
receipt SMS it posts to `POST /api/evidence/sms`:

```json
{ "deviceId": "…", "nonce": "<unique>", "receivedAt": "2026-09-11T10:15:00Z", "from": "MPESA",
  "operatorId": "mpesa_ke", "text": "<the SMS>", "signature": "<base64 ed25519 over canonical>" }
```

`canonical = deviceId + "\n" + nonce + "\n" + receivedAt + "\n" + from + "\n" + operatorId + "\n" + text`.
Nonces are single-use; invalid signatures and mismatches raise the device's risk score; a device can be
revoked at any time.

Payout devices additionally register their SIM (`simMsisdn` / `simIccid`), authenticate queue and
claim calls by signing `deviceId\ntimestamp\nMETHOD\npath`, and submit the outbound confirmation
with `simIdentity`, `deviceTimestamp` and `clientHash` (sha256 of the raw text). The engine rejects
unregistered SIMs, altered text, evidence before the claim, reused operator references, amount /
currency / recipient mismatches, expired windows, payouts to the agent's own numbers and abnormal
recipient patterns. Parsing templates (regular expressions per operator) are managed in the admin
panel under *Mobile money & evidence*; confidence is scored (reference 50, amount 25, currency 10,
operator transaction id 10, sender 5) and only matches at or above `gateway.autoConfirmScore` from a
trusted device settle automatically.

## WooCommerce plugin

Copy `integrations/woocommerce-bitripay` to `wp-content/plugins/`, activate it, and enter your API URL,
merchant API key and webhook secret (WooCommerce → Settings → Payments → BitriPay). Set the merchant
webhook URL to `https://yourstore.com/?wc-api=bitripay`. Supports hosted checkout redirect, QR code on
the order-received page, order tracking via webhook and return URL, WooCommerce Subscriptions renewals,
Cart/Checkout blocks and HPOS.

## Deployment

```bash
docker compose up --build      # api :4000, web :8080, admin :8081
```

Or build manually: `npm run build` then `node apps/api/dist/index.js` and serve `apps/web/dist` and
`apps/admin/dist` as static sites (both proxy `/api` and `/v1` to the API; set `VITE_API_URL` at build
time to use an absolute API URL instead). Set strong `JWT_SECRET` and `APP_SECRET`, `WEB_URL`,
`ADMIN_URL`, `API_URL`, and mount `apps/api/data` (SQLite, WAL mode) on persistent storage.
The data layer is plain SQL through a thin adapter, so migrating to PostgreSQL is straightforward.

## Security notes

- Double-entry ledger: every transaction posts balanced ledger entries; pending transactions hold funds
  in an escrow account; refunds and reversals are first-class.
- PINs and passwords are bcrypt-hashed; card PANs, CVVs, gift-card codes and gateway credentials are
  AES-256-GCM encrypted; 2FA secrets are encrypted; API keys are stored hashed.
- Card payments through Stripe/Paystack/Flutterwave never touch the server's storage (tokens only).
  The sandbox provider is for development and must stay disabled in production.
- Rate limiting on auth and public endpoints, role & permission checks on every admin route,
  audit log of all administrative actions.
- Unconfirmed external payments never create spendable balances: settlement is only reachable through
  `confirmAndSettle`, which requires an authenticated intent, an independent confirmation (processor,
  device-signed evidence, or maker-checker approval), passing risk controls and a balanced posting.
- Maker-checker for manual settlement; administrative approvals require a fresh passkey step-up or PIN.
- Append-only audit, event and ledger tables (database triggers) with a hash-chained event log;
  `GET /api/admin/reconcile` re-verifies the chain and every wallet against its entries.
- Biometric templates are never collected or stored; WebAuthn credentials hold only public keys.
- No CVV is ever stored for external cards; BitriPay-issued virtual cards keep their own CVV encrypted.
- Live exchange-rate refresh needs outbound access to the rate provider (blocked inside some
  development sandboxes); without it the platform labels rates as bundled test rates or
  administrator-imported, disables guaranteed quotes and keeps the go-live checklist blocking rather
  than presenting them as live.

## License

MIT
