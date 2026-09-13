# BitriPay – QR Code Money Transfer & Payment Platform

BitriPay is a complete, ready-to-launch money transfer business built around QR code payments.
It ships with a **customer / merchant / agent web app**, a **mobile app** (iOS & Android), an
**admin panel**, a **payment aggregator** with pluggable gateways, a **merchant payment gateway
with API & webhooks**, and a **WooCommerce plugin**.

```
bitripay/
├── backend/
│   └── api                Node.js + Express + SQLite REST API: double-entry ledger, auth, gateways, switch,
│                          finance operations, risk & compliance, intelligence, partner API v1, admin API,
│                          BitriPay Lite (no-JavaScript site), USSD/SMS channels
├── frontend/
│   ├── web                React web app for users, merchants and agents + hosted checkout + landing site (PWA)
│   ├── admin              React admin console
│   ├── mobile             Expo (React Native) app for users, merchants and agents (offline-signed payments)
│   └── payout-device      Expo (Android) payout device & SMS forwarder for prefunded mobile-money SIMs
├── shared/
│   ├── core               @bitripay/shared: types, money math, QR codec, ISO countries & currencies, i18n
│   ├── bitriqr            @bitripay/bitriqr: EMVCo QR + signed BitriPay extension (encode, decode, sign, verify)
│   ├── sdk-node           @bitripay/sdk (Node / TypeScript partner SDK)
│   ├── sdk-php            bitripay/sdk (PHP partner SDK)
│   └── sdk-python         bitripay (Python partner SDK)
├── integrations/
│   └── woocommerce-bitripay   WordPress / WooCommerce payment gateway plugin
├── docs/                  Operating-system dossier and verification report
└── scripts/               Playwright smoke flows and the full verification run
```

Backend, frontend and shared code only meet through the published packages (`@bitripay/shared`,
`@bitripay/bitriqr`) and the HTTP API: no frontend imports backend code, and the backend never imports
a frontend. `npm run verify` builds and tests all three layers from a clean checkout (see
[docs/VERIFICATION.md](docs/VERIFICATION.md)).

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

Engineer onboarding lives in [docs/DEVELOPER.md](docs/DEVELOPER.md) (run, verify, sandbox test data, partner API, where things live, how to add a processor / rail / agent / endpoint / page / migration).

Requirements: Node.js 20+ (22 recommended).

```bash
npm install
cp backend/api/.env.example backend/api/.env      # optional – defaults work for local development
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

`frontend/web/src/pages/Landing.tsx` is the public home page: a canvas-drawn cinematic hero with real
product screenshots in a device frame, the three people the product is designed around, the money
lifecycle, product pillars, the safeguarding rule, merchant and agent sections, an FAQ (also emitted as
JSON-LD) and the latest articles. Its styles are self-contained in `landing.css`.

### Run the mobile app

```bash
cd frontend/mobile
npm install
# point the app at your API (edit app.json → expo.extra.apiUrl / webUrl, use your LAN IP for a device)
npx expo start
```

Scan the Expo QR code with Expo Go, or build with EAS (`eas build`). Camera scanning, biometric
unlock, push notifications and deep links (`bitripay://`, `https://pay.bitripay.app/pay/CODE`) are
configured in `app.json`.

### Run the Android payout device / SMS forwarder

`frontend/payout-device` is the app for the phone that holds a merchant or agent SIM: it enrols with a
device-generated Ed25519 key, polls its payout queue with signed requests, dials the operator USSD
menu, and signs and forwards every operator confirmation SMS the instant it arrives (a native
`SMS_RECEIVED` receiver, `modules/sms-receiver`). Its protocol is unit-tested in Node against the
API's own verifier.

```bash
cd frontend/payout-device
npm install
npm test                                   # protocol interop + forwarder tests
npx expo prebuild --platform android       # applies the sms-receiver config plugin
npx expo run:android                       # needs Android SDK 34+ / JDK 17, or use EAS
```

The native module was not compiled in this repository's build container (no Android SDK); see
`frontend/payout-device/README.md` for permissions, distribution (managed / enterprise, not the public
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

## Brand

The system, product and brand name is **BitriPay**. The brand kit lives in `backend/api/public/brand/` and is served at
`/brand/*` by the API (proxied by the web and admin apps):

| File | Use |
|---|---|
| `logo.svg` | Indigo wordmark with the blue dots and the green/orange chevron, for light backgrounds |
| `logo-white.svg` | White wordmark for dark backgrounds (landing header, splash) |
| `mark.svg`, `favicon.svg` | The chevron and dots on an indigo tile: favicons, app icon |

Colours are exported once from `shared/core/src/brand.ts` (`BRAND`) and mirrored in every theme: indigo
`#2E2A7B` (primary), dots `#1A8ED8 → #1F5EAE`, green `#12A34B` (success), orange `#F49D1F` (warning/accent), ink
`#161832`, paper `#F6F6FB`. Mobile PNGs (`frontend/mobile/assets/icon.png`, `adaptive-icon.png`, `splash.png`,
`logo.png`, `logo-white.png`) are rendered from the SVGs.

The wordmark in the repository is a vector recreation of the original artwork. To use the original file exactly,
drop it in as `backend/api/public/brand/logo.svg` (or set Admin → Web, SEO & app settings → logo URL to a hosted
image) and re-render the mobile PNGs; nothing else needs to change.

## Configuration

All configuration lives in `backend/api/.env` (see `.env.example`). Everything except secrets can also
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
for apps, `Authorization: Bearer sk_live_…` (merchant API key: `sk_` secret, `rk_` restricted to listed scopes,
`pk_` publishable/read-only; legacy `bp_` keys keep working) for the v1 API.

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

### Gateway API v1 (BitriQR, intents, checkout, refunds, verifications, payouts, webhooks)

Mounted at `/api/v1` and `/v1`. Every object is built on a **payment intent** (`pi_…`) with the canonical state
machine (`CREATED → REQUIRES_PAYMENT_METHOD → … → CAPTURED → SETTLEMENT_PENDING → SETTLED`, plus `AMBIGUOUS`,
`UNDER_REVIEW`, `PARTIALLY_REFUNDED`, `REFUNDED`, …), one **attempt** per rail execution (never two in flight) and the
payment **event store**. A success screen is never proof: only a ledger posting, a verified processor callback or
verified evidence moves an intent.

| Object | Endpoints |
| --- | --- |
| Payment intents | `POST/GET /v1/payment_intents`, `GET /v1/payment_intents/:id` (+ `/timeline`, `/methods`, `/refundable`), `POST …/:id/cancel`, `…/:id/qr` (signed dynamic BitriQR, TTL ≤ 300 s), `…/:id/pay/wallet` (payer) |
| QR codes | `POST/GET /v1/qr_codes` (static, signed, optional fixed amount), `GET /v1/qr_codes/analytics`, `POST …/:id/revoke`, `POST /v1/qr/:id/intent` (a fresh intent per scan), `POST /v1/resolve` / `GET /v1/resolve/:ref` (trust: verified / basic / invalid), `GET /v1/keys` (ed25519 registry with ETag) |
| Checkout sessions | `POST /v1/checkout_sessions` (`line_items` or `amount_minor`, `success_url`, `cancel_url`, 5 min – 24 h), `GET /v1/checkout_sessions[/:id]`, `POST …/:id/expire`; `url` is the hosted checkout page; `checkout.session.completed` fires on capture |
| Payment links | `POST /v1/payment_links` (single-use = 7-day intent; `reusable: true` = static code, optional fixed amount, one intent per open), `GET /v1/payment_links[/:id]`, `POST …/:id/deactivate` |
| Refunds | `POST /v1/refunds` (`payment_intent` or `transaction`, optional `amount_minor`), `GET /v1/refunds[/:id]`. Reservations are atomic: succeeded + pending + manual refunds can never exceed the principal; wallet-paid refunds post merchant → payer, processor-paid refunds ask the processor and post merchant → treasury; `MANUAL`/`PENDING` ones are resolved by operations (`POST /api/admin/refunds/:id/resolve`) |
| Scan-to-Verify (KODA) | `POST /v1/verifications` (`reference`, or `msisdn` + `amount_minor`, `window_hours`) → `VERIFIED / PENDING / NOT_FOUND / AMBIGUOUS / MISMATCH` with confidence and reasons; 30 free per month then per-lookup pricing from the merchant balance (`GET /v1/verifications/quota`); a verification never marks anything paid |
| Payouts | `POST /v1/payouts` (bank account id, free-form bank details or mobile money), `GET /v1/payouts[/:id]`; runs through the withdrawal workflow (maker-checker, agent float) and emits `payout.created / completed / failed` |
| Balance | `GET /v1/balance` → per currency `balance`, `available`, `pending`, `reserved`, `settlement_pending`, `disputed`, `frozen` |
| Webhooks | `POST/GET/PATCH/DELETE /v1/webhook_endpoints[/:id]` (event subscriptions, `*` and `payment_intent.*` wildcards), `POST …/:id/rotate`, `…/:id/ping`, `GET …/:id/deliveries`, `GET /v1/events[/:id]`, `POST /v1/events/:id/replay`, `GET /v1/webhook_deliveries`, `POST /v1/webhook_deliveries/:id/replay`, `GET /v1/webhook_events/types` |
| API keys | `GET/POST/DELETE /v1/api_keys` (session only – a key can never mint a key), `GET /v1/api_keys/scopes` |
| Sandbox | `GET /v1/sandbox` (magic numbers), `POST /v1/sandbox/simulate` (`payment_intent`, `outcome: succeed / fail / ambiguous / timeout_then_succeed / provider_unavailable`) – drives the real attempt machine through the sandbox processor |

Sandbox magic MSISDNs: `+243000000404` wallet not found (retryable failure, intent back to
`REQUIRES_PAYMENT_METHOD`), `+243000000408` provider outcome unknown (payment parked in `MANUAL_REVIEW`, intent
`AMBIGUOUS`, `payment_intent.ambiguous_hold`), `+243000000500` timeout then success (pending 6 s), `+243000000503`
provider unavailable, any number ending `0000` customer rejected. Test cards: last four `0002` declined, `9995`
insufficient funds, `0069` expired, `0127` incorrect CVC.

Webhook deliveries carry two signatures and are at-least-once:

- `BitriPay-Signature: t=<unix seconds>,v1=<HMAC-SHA256("<t>.<rawBody>", endpoint secret)>` (also sent as
  `X-BitriPay-Signature` for existing integrations) – reject timestamps older than 5 minutes.
- `BitriPay-Signature-Ed25519: keyId=<platform key>,t=<unix>,sig=<base64 ed25519("<t>\n<deliveryId>\n<url>\n<sha256(body)>")>`
  – the public key is published at `GET /v1/keys/:keyId` (scope `PLATFORM`) and rotated with an overlap.
- Headers `BitriPay-Event`, `BitriPay-Event-Id`, `BitriPay-Delivery-Id`, `BitriPay-Attempt`. Deduplicate on the
  event id; ignore older `state_version`s. Envelope: `{ id, type, api_version, schema_version, created,
  occurred_at, emitted_at, resource, state_version, livemode, data }` (`event`/`createdAt` kept as legacy aliases).
- Retries are persisted (they survive restarts): 10 s, 30 s, 2 min, 10 min, 30 min, then every 2 h for 24 h with
  jitter; only 2xx is an acknowledgement; redirects are not followed; an endpoint that fails 50 deliveries in a row is
  disabled and the merchant notified; exhausted deliveries are dead-lettered and replayable from the developer
  console. Destinations are checked against SSRF (https only, no private or reserved addresses, DNS checked per
  connection). Settings key `webhooks`.

Event catalogue: `payment_intent.created / requires_action / processing / succeeded / settled / failed / cancelled /
expired / ambiguous_hold / disputed`, `refund.created / updated / succeeded / failed`, `checkout.session.completed /
expired`, `verification.completed`, `payout.created / completed / failed`, `reconciliation.exception`, `ping`, plus the
legacy `payment.completed` and `payment_request.created`.

Mutating requests accept an `Idempotency-Key` header: a repeat with the same key and body replays the
stored response (`Idempotent-Replayed: true`); a repeat with a different body is refused (422).

### National Switch Gateway (Switch Monétique National, DRC) and the rail registry

BitriPay is an aggregator in the DRC: it initiates, orchestrates, normalises, tracks and reconciles; it never holds
customer funds for switch flows, never executes final settlement and never routes an interinstitutional payment
around the national switch. The gateway is built so the team can develop, test and operate everything without the
switch protocol: the adapter is abstract, the **simulator** (labelled `SIMULATION`, fictitious institutions only)
exercises every branch, and a real connector cannot be enabled until it is certified.

**Objects and rules** (services under `backend/api/src/services/switch/`)

| Piece | What it does |
| --- | --- |
| Participant registry (CMP-06) | Official codes, kinds, services, currencies, channels, validity dates, routing ids, versions; author ≠ approver; pair capability tests (`OPEN` only with evidence). A service exists only when *BitriPay authorisation × switch admission × debtor capability × creditor capability × currency × product × channel × validity* all hold. |
| Route policy engine (CMP-05) | Classifies from the institutions and the product (`DOMESTIC_INTEROPERABLE`, `ON_US_REVIEW_REQUIRED`, `CLOSED_LOOP`, `CROSS_BORDER`, `UNSUPPORTED`), applies RTE-001…006, returns an explainable decision (rule, profile, institutions, currency, rejection, config version). Callers cannot force a rail, sponsor, currency or exemption. Exceptions are signed objects with an official document and two approvals; none exist by default. |
| Connections (CMP-07 gate) | Access mode `DIRECT` / `SPONSORED`, adapter `simulator` / `certified`, environment, certification steps `NOT_STARTED → INTERNAL_TESTS → SANDBOX → CERTIFIED` (evidence + distinct approver), certificate inventory with 60/30/14/7-day alerts; an expired certificate stops emission (P1 incident) — TLS is never disabled. Production needs the certified adapter module (`SWITCH_ADAPTER_MODULE`). |
| Orchestrator (CMP-03/08/09) | `switch_payments` with the state machine `RECEIVED → REQUIRES_ACTION → READY → DISPATCHING → PENDING/AUTHORIZED/COMPLETED/REJECTED/UNKNOWN` and separate `authorization_status`, `beneficiary_credit_status`, `settlement_status` (default `NOT_OBSERVED`), `reconciliation_status`, `resolution_status`; payment + event + outbox committed atomically; stable message id persisted before the network write; dispatcher lease with a fencing token; revalidation of every revocable control before emission; timeouts → `UNKNOWN` + inquiry chain, never a resend; provisional `NOT_FOUND` keeps `UNKNOWN`; versioned message catalogue (unknown code → quarantine, ACK ≠ authorisation, `AUTHORIZED` never auto-completes, no regression, contradictions → `REVIEW_REQUIRED` + case); inbound dedup on (source, external id), tampered same id → integrity incident; refunds/reversals as linked operations with atomic reservations (an unknown refund keeps its reservation). Every payment mirrors onto a platform intent (webhooks, timeline, guardian) with **no ledger posting**: the observation journal records principal, credit, fees, refunds and settlement references. |
| Reconciliation (CMP-10) | Imports with checksum and control totals (same file twice = one import; corrected file = linked import), coverage per expected source, exact-reference matching then amount/currency/status/fee checks, cases `LOCAL_ONLY`, `EXTERNAL_ONLY`, `STATUS_CONFLICT`, `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `DUPLICATE_EXTERNAL`, `FEES_MISMATCH`, `SETTLEMENT_NOT_OBSERVED`, `LATE_RECORD`, `MISSING_REPORT`, `INTEGRITY` with exposure, age, owner, next action, deadline; analyst proposes, a different approver closes; totals per currency only. |
| Evidence vault (CMP-12) | Raw switch bytes, encrypted at rest, addressed by SHA-256, append-only, integrity sweep. |
| Rail registry & Smart Route | Every connector (wallet, processors, direct operators, switch connections) with hourly success/failure/unknown/decline/latency telemetry, circuit breaker (open after consecutive faults, half-open after cooldown), operator pause, health probes, and a deterministic 0–100 score per policy (`smart`, `cheapest`, `fastest`, `most_reliable`) used by checkout method discovery and processor selection. Failover only inside the same capability set. |

**Merchant API** (scopes in brackets): `POST /v1/payments` [payments:create] (idempotent: 201 new, 200 identical, 409
`IDEMPOTENCY_CONFLICT` / `ORDER_ALREADY_EXISTS`), `GET /v1/payments[/:id]` [payments:read] (an `UNKNOWN` payment is a 200
with its business state), `GET /v1/payments/:id/timeline`, `POST /v1/payments/:id/cancel` [payments:cancel] (409
`PAYMENT_ALREADY_DISPATCHED` once transmission was possible), `POST /v1/payments/:id/consent`, `POST /v1/payments/:id/refunds`
[refunds:create] (422 `CAPABILITY_NOT_AVAILABLE` when the product does not support it), `GET /v1/participants`
[participants:read], `POST /v1/qr-intents` [qr:create], `POST /v1/webhook-endpoints` [webhooks:manage],
`GET /v1/reconciliation/cases` [reconciliation:read] (cursor pagination), `POST/GET /v1/beneficiary_bindings`
[bindings:manage] (verified by compliance, activated by a different approver), `POST /v1/consents` (simulation only).
Request body per §11.1 (`amount.value_minor` is a string, never a float); errors per §11.3 (`INVALID_REQUEST`,
`SCOPE_DENIED`, `RESOURCE_NOT_FOUND`, `UNSUPPORTED_PARTICIPANT_PAIR`, `CURRENCY_NOT_ENABLED`, `RATE_LIMITED` with
`Retry-After`, `SERVICE_UNAVAILABLE`). Webhook types `payment.created / action_required / pending / unknown / completed /
rejected / cancelled / expired`, `refund.updated`, `reconciliation.exception` carry `state_version`.

**Operations console API** `/api/admin/switch/*` (permissions `switch`, `reconciliation`, `security`, `compliance`,
`approvals`): connections (certification, certificates, enable gate, probe, simulator link and inbound injection,
national view), participants and pairs, policies and exceptions, payments (timeline with every fact's source and time,
inquiry, evidence), inbox quarantine, outbox and dead letters, message catalogue, dispatcher lease/run/recover/takeover,
reconciliation imports/runs/cases, incidents (P1/P2/P3), recovery view (journal mode, emission journal, runbook
checklist, exercises) and `/rails` (registry, pause/resume, probe, score). Scheduler: outbox dispatch under the lease,
uncertain-emission recovery, expiry of never-sent payments, probes, certificate alerts, registry staleness, daily coverage.

Simulator scenarios are selected by the payer `account_token` suffix (`tok_ok`, `tok_pending`, `tok_slow`,
`tok_reject`, `tok_timeout`, `tok_timeout_nf`, `tok_unknown_code`, `tok_ack_only`, `tok_authorized`, `tok_dup`,
`tok_contradict`, `tok_badsig`, `tok_refund_unknown`). The acceptance matrix T01–T32 of the dossier runs in
`src/tests/switch.test.ts`. Settings keys: `switch`, `routing`.

### Financial operations: fees, commissions, settlement, disputes, holds, splits, processor reconciliation

Everything money-related that used to be a flat setting or an implicit rule is now an object with a history.

- **Versioned fee schedules** (`fee_schedules`): scopes `platform`, `country`, `tier`, `merchant`; rules per fee
  type carry `fixed`, `bps` and optional `min` / `max` (base-currency minor units). Draft → approve (a different
  administrator) → activate (retires the previous active version of the same scope) → retire. `calculateFee`
  resolves merchant > tier > country > platform > the flat `fees` setting, so nothing changes for a platform with no
  schedules; `GET /api/admin/finops/fees/effective?user=…&type=…` explains which rule applies and why; a merchant
  reads its own with `GET /api/v1/fee_schedule`. Fee tiers are set per user (`PUT /api/admin/finops/fees/tier/:userId`).
- **Commission ledger** (`commission_entries`): every agent commission (cash-in, cash-out, and the other kinds the
  network pays) is recorded with its period and the platform's share (`commissions.platformShareBps`); finance sees
  the network's cost (`/api/admin/finops/commissions/overview`) and each agent has a statement.
- **Holds** (`holds`): money that stays in the wallet but is neither available nor settleable — dispute, rolling
  reserve, risk review, settlement in preparation, compliance — with a reason, an optional expiry and a release
  audit. `GET /api/v1/balance` now reports `held`, `holds` by kind and `disputed` next to `available`,
  `pending`, `reserved`, `settlement_pending` and `frozen`.
- **Disputes as objects** (`disputes`): opened by a customer, the merchant (`POST /api/v1/disputes`), a processor
  chargeback (an open chargeback on money that reached a wallet becomes a dispute automatically), an institution or
  an administrator. Opening places a hold and marks the intent `DISPUTED`; the response deadline comes from the
  product rules per rail (`disputes.responseDays`), never from the case; evidence from both sides is append-only;
  `WON` releases the hold, `LOST` refunds through the refund object; unanswered disputes are swept at the deadline.
  Merchants respond at `POST /api/v1/disputes/:id/respond`; administrators decide at `/api/admin/finops/disputes/:id/decide`.
- **Split payments**: an intent can declare up to ten recipients (`splits: [{ recipient, bps | fixed_minor, label }]`,
  validated at creation). On capture the merchant wallet pays each share as a `distribution` transaction, so the
  shares can never exceed what the merchant received; failed shares are retried from the console or the API.
- **Settlement engine** (`settlement_profiles`, `settlement_cycles`, `settlement_items`): a profile per rail and
  currency (`T0` / `T1` / `T2` / `weekly` / `manual`, cut-off hour, destination, minimum, auto). A cycle closes at
  the cut-off with the collections since the previous close, net of fees, refunds, split shares and holds, and is
  hashed; **obligations** are the closed cycles not yet paid; statements are numbered and available as JSON, CSV
  and PDF. Paying a cycle to a bank or mobile-money destination goes through the existing withdrawal workflow with
  its maker-checker controls, and the withdrawal's outcome is mirrored back onto the cycle. The scheduler runs
  cut-offs hourly and pays cycles when they fall due.
- **Processor reconciliation and the operations workbench**: processor and bank statements are imported per gateway
  (`POST /api/admin/finops/reconciliation/processors/:gatewayId/statements`, checksum deduplicated, control total
  checked, stored as evidence) and matched three ways — statement line ↔ gateway payment ↔ ledger transaction —
  opening the same reconciliation case classes as the switch (`EXTERNAL_ONLY`, `LOCAL_ONLY`, `AMOUNT_MISMATCH`,
  `STATUS_CONFLICT`, `FEES_MISMATCH`, `DUPLICATE_EXTERNAL`, `SETTLEMENT_NOT_OBSERVED`). The workbench
  (`GET /api/admin/finops/reconciliation/workbench`) lists every rail's open exceptions with exposure and age.

API keys gain the scopes `settlements:read`, `settlements:write`, `disputes:read`, `disputes:write`. The console
routes live under `/api/admin/finops/*` (permissions `settings`, `transactions`, `treasury`, `agents`,
`reconciliation`, `users`).

### Risk, compliance and agent intelligence

Rule-based controls run for every account, always, and cost the account holder nothing; the intelligence sits in
one explainable place.

- **Central risk policy** (`risk_policies`): one versioned rule set decides what happens to a movement once the
  score and flags are known. Rules are evaluated in order (first match wins) and carry an id, so every decision
  reads "rule FRD-003 of policy v2". Draft → approve (a different administrator) → activate; the default policy
  encodes the fraud bands **0–30 approve · 31–60 step-up · 61–80 manual review · 81–100 block**, with sanctions
  and cooling-off blocks ahead of them. `POST /api/admin/risk/policies/simulate` dry-runs any policy.
- **Fraud scoring** (`fraud_scores`): velocity over 1h / 24h / 7d, deviation from the account's own 30-day
  amounts, structuring under the tier limit, KYC-limit mismatch, recipient risk (prior adverse scores, open cases),
  new beneficiary, method risk, unusual hour, new device, geolocation mismatch, PEP match — every factor with its
  points and detail (`fraud` settings). A step-up decision returns `403 step_up_required` (BP-1010) until the
  request carries a valid passkey / 2FA step-up token (`x-step-up-token`); a block opens a compliance case.
- **Compliance cases** (`compliance_cases`): fraud blocks, AML findings, sanctions hits, suspicious destination
  changes and manual referrals, each with an auto-drafted **suspicious activity report** the officer edits,
  assignment, escalation, a decision (`NO_ACTION`, `CLEARED`, `SAR_FILED` with the filing reference,
  `ACCOUNT_RESTRICTED`, `ACCOUNT_CLOSED`) and four-eyes closure. The **AML monitor** runs daily (or on demand):
  structuring, pass-through / mule patterns, dormant-then-burst, high-risk jurisdictions, politically exposed
  persons. Cases are deduplicated per pattern, account and day.
- **Sanctions at commit**: besides the outbound screen, the ledger itself refuses to post money for a listed party
  (`preCommitHooks` in `postTransaction`, error `sanctions_hit`, BP-5008), whatever the code path. Lists come from
  named **sources** (OFAC, UN, EU, UK HMT, BCC, a PEP register…) with versions: import rows or CSV (OFAC SDN
  layout understood), replace-by-version, optional daily URL refresh. PEP entries raise the score; they never
  block by themselves.
- **KYC tiers** (`users.kyc_tier`): Tier 1 basic (verified contact, name, country), Tier 2 standard (identity
  document, selfie with liveness), Tier 3 enhanced (proof of address ≤ 90 days), Tier 4 business (KYB). Limits per
  tier and per country live in the `kycTiers` setting, are evaluated in the base currency at the live rate and
  are enforced server-side (BP-5005 / BP-5006, audited); untiered accounts keep the legacy limits, so nothing
  changes until an account is tiered. **KYB** (`kyb_submissions`): legal name, registration, address, MCC,
  expected volume, licence, directors (linked directors must hold Tier 2), documents; verification grants Tier 4;
  merchants above `kybMonthlyVolumeThreshold` cannot open new intents until verified (BP-5007).
- **Settlement-account change protection** (`destination_changes`): every new bank account, mobile-money number
  or settlement destination is recorded with the previous value, announced loudly, refused within 24h of a
  password change (BP-5011), and **cooled off**: payouts above the cooling amount wait 24h or an administrator's
  approval (BP-5010). The account holder can revoke a change they did not make, which locks the destination and
  opens a critical case.
- **Agent intelligence**: **float forecasts** per currency (average daily outflow, runway in days, refill to the
  target) with daily low-float alerts; a **trust score** (tenure, activity, reliability, follow-through, disputes,
  verification, float discipline, compliance) with bands new / bronze / silver / gold / platinum; **dynamic
  commissions** = base + trust-band bonus + liquidity bonus for cash-in where float is short (`agentIntel`
  setting); **float replenishment requests** fulfilled through the e-money maker-checker; **agent-assisted
  onboarding** (`POST /api/risk/agents/me/onboard`) opens a Tier 1 account with a temporary PIN in one call and
  accrues the onboarding commission.
- **Error catalogue**: every error now also carries `bp` — BP-1xxx authentication, 2xxx validation, 3xxx ledger,
  4xxx rail, 5xxx compliance, 6xxx intelligence (`lib/bpCodes.ts`).

Account-holder routes live under `/api/risk/*` (verification level, Tier 1 activation, KYB, destination changes,
agent float / trust / requests / onboarding); the console under `/api/admin/risk/*` (permissions `compliance`,
`kyc`, `agents`, `issuance`, `settings`).

### Intelligence, offline protocol, Diaspora-Direct and the developer surface

- **Offline-signed QR protocol** (innovation I-2): a merchant device shows a signed dynamic BitriQR carrying a
  nonce (server-signed while online, or signed with the device's own 72-hour ed25519 subkey from prefetched
  nonces when the network is down); the payer's phone signs a **promise** (merchant, payer, amount, currency,
  nonce, expiry, monotonic device counter) with its subkey and queues it. `POST /api/v1/offline/sync` submits the
  queue in order; the platform, and only the platform, verifies both legs (the signed QR itself or a merchant
  countersignature), refuses replayed nonces (72h registry), reused counters, expired promises, amounts above the
  offline ceilings, sanctions and policy hits and empty wallets, posts an ordinary QR payment, and returns a
  platform-signed receipt — or `REJECTED` with `restoreMinor` so the device restores its local balance. Nothing
  offline is ever shown as final before this confirmation. The web app ships the protocol (WebCrypto Ed25519 key in
  IndexedDB, nonce prefetch, promise queue, sync on reconnect) plus a PWA shell (manifest, service worker that
  never caches money-moving calls, "last synced" banner).
- **Diaspora-Direct** (innovation I-4): a treasury administrator **signs a rate policy** per currency pair
  (markup, fees, ceilings, maximum validity ≤ 4h); **rate cards** are issued from the live mid-market rate under
  that policy, signed with the platform key and refreshed before they lapse; **institutions** (schools, hospitals,
  utilities, government, NGOs, landlords, cooperatives) register their purpose codes and are verified; **quotes**
  for restricted purposes (`SCHOOL`, `HEALTH`, `RENT`, `UTILITY`, `GOVERNMENT_FEE`, `TAX`) can only be paid to a
  verified institution covering that purpose, at the card rate, in one ledger transaction with a conversion leg.
  Institutions issue "DD"-flagged BitriQR codes.
- **AI gateway** (`services/assist/gateway.ts`): the one door to a model, in eight layers — authentication and
  tenant guard, rate limiter, ACU policy (projected cost, budget, **gross-margin floor 0.66** checked per request,
  at every pricing change and at the monthly reconciliation), prompt normalisation (PII stripping, injection
  defence), task-type model router (ordered models from `aiRouting`, failover on errors and 8-second timeouts,
  per-model circuits), provider adapters (Anthropic, OpenAI-compatible, Gemini), schema normaliser (zod), and the
  `ai_usage_ledger` only administrators can read. Errors: `UNAUTHENTICATED`, `TENANT_MISMATCH`, `RATE_LIMITED`,
  `NEURAL_QUOTA_EXCEEDED`, `MARGIN_PROTECTION_VIOLATION`, `PROVIDER_UNAVAILABLE`, `OUTPUT_SCHEMA_INVALID`. Account
  holders never receive a provider, model, token count or cost (rule 4); rule-based fallbacks keep every core flow
  working with zero ACU (rule 6).
- **Agent mesh** (Part VII): PR-A01 Onboarding, PR-A02 KODA Core, PR-B01/B02 Recon, PR-B03 Exception Hunter,
  PR-C02 FX Oracle, PR-C03 Rebalancer, PR-D02 Sanctions Sentinel, PR-E01 Connector Medic, PR-E02 Retry Surgeon,
  PR-F01 Fraud Scorer, PR-F02 Dispute Arbiter — each with a charter, typed mesh tools onto the Phase 4–6 services
  and a deterministic plan, bound to **domain events** on the `bitripay.events` bus (`attempt.unknown`,
  `connector.degraded`, `dispute.opened`, `agent.float_low`, `statement.imported`, `recon.exception_aged`,
  `verification.requested`, `diaspora.quote_created`, `sanctions.hit`, `merchant.created`, …). Every binding starts
  in **shadow** (side-effecting tools refused), can be promoted to **propose** after 90 days or with a recorded
  override, and has its own kill switch; proposals go through the ordinary maker-checker approvals. The canonical
  operating-system names (RouteOptimiser, FraudScorer, ComplianceMonitor, LiquidityForecaster, DisputeResolver,
  RecipientValidator, …) resolve to these agents.
- **Surfaces**: merchant **Command centre** (balance classes, settlement calendar / cycles / statements, disputes
  with evidence, effective fees, offline kit), **QR centre** (locations, terminals, static / dynamic / offline
  codes, analytics, printable sheets, institution registration and DD codes), **Developer portal** (scoped keys,
  webhook endpoints, deliveries and replay, events, sandbox, OpenAPI, SDK snippets, error catalogue); admin
  consoles **National switch & rails**, **Finance operations**, **Risk & compliance**, **Intelligence**.
- **SDKs and docs**: `shared/sdk-node` (`@bitripay/sdk`, zero dependencies, typed resources, webhook
  verification), `shared/sdk-php` (`bitripay/sdk`), `shared/sdk-python` (`bitripay`); the OpenAPI 3.1 document
  at `/api/v1/openapi.json` is generated from the same operation table the portal shows.

### Savings, wellbeing and locale resolution

- **Savings goals are holds, not balances**: every contribution is a hold of kind `savings` on the wallet
  (`services/savings.ts`), so the money never leaves the ledger, cannot be spent by accident (the ledger refuses a
  debit that would dip into ring-fenced money with `insufficient_funds` and reports the held amount) and is released
  the moment the account holder withdraws from the goal or closes it. Goals carry a target, a deadline, a weekly pace
  projection and an on-track flag.
- **Anchor and round-ups**: opt-in per account. The anchor sets aside at least 10 % (`MIN_ANCHOR_BPS`, can be raised
  to 50 %, never lowered) of every income event (`income.received` on the domain bus: transfers, QR and merchant
  payments, deposits, remittances, refunds; administrative credits and e-money issuance never count) into the
  default goal; round-ups sweep the change of every outgoing payment to the nearest 1.00 / 5.00 / 10.00.
- **Live-within-means monitor**: 30-day income against spend per currency, green under 70 %, amber under 100 %, red
  at or above; amber and red come with a concrete plan (weekly amount to set aside, the three categories to trim and
  by how much). `GET /api/savings` (overview), `/api/savings/wellbeing`, `PUT /api/savings/settings`,
  `POST /api/savings/goals`, `/goals/:id/contribute`, `/goals/:id/withdraw`, `DELETE /goals/:id`. Web page
  **Savings & goals** (`/app/savings`).
- **Language and currency chains** (`services/locale.ts`, `GET /api/locale`): language = explicit (`?lang=`, stored
  preference) → device (`Accept-Language`, `x-language`) → IP country (`x-ip-country` / `cf-ipcountry`: French for
  francophone Africa, Portuguese, Arabic with RTL, Swahili, Hindi, Bengali, Spanish) → default; currency = explicit
  (`?currency=`) → most-used wallet → IP country (CDF in the DRC, GBP, EUR in the euro area, the ISO currency
  elsewhere) → browser hint (`x-currency`) → USD. Only enabled languages and currencies are ever returned. Launch
  languages Lingala, Kikongo, Tshiluba, Amharic, Hausa, Yoruba and Igbo are registered in the CMS language list.
- **Acceptance tests** (`src/tests/acceptance.test.ts`): 3 000 randomised postings (with cross-currency legs and
  refused overdrafts) leave every currency zero-sum and every wallet equal to its derived balance; fifty offline
  promises settle in order with the failing one restoring the payer's balance and a replayed nonce refused; the locale
  chains for CD, GB, FR, KE and AE (RTL); the anchor, round-ups, ring-fencing, manual moves and the red plan.

### Bulk payouts and the v1 account endpoints

- **Bulk payouts (module 14)** (`services/bulkPayouts.ts`): a batch is uploaded as rows or CSV (`method, amount,
  wallet, operator_id, phone, name, bank_name, account_name, account_number, country, swift, bank_account_id,
  reference`; header row required, quoted fields, up to 5 000 rows). Every row is validated against the live
  directories before anyone approves (recipient account, operator and payout availability, bank account currency,
  amount), the batch shows totals and fees, and readiness reports the available balance after holds. Approval is
  four-eyes (a different person, e.g. an administrator from the finance console) or step-up for the creator (PIN or
  passkey); an API key uploads but never approves alone. Execution runs the rows in order through the same transfer
  and payout engines as a single payment, one ledger transaction per row with an idempotency key, and reports
  per-row outcomes (`PAID`, `FAILED` with the reason, `SKIPPED`). Webhook events `payout_batch.created` and
  `payout_batch.executed`.
- **Cross-border routes on the partner API** (`POST /v1/routes/quote`, `/v1/routes/payout-currencies`, `POST /v1/routes`,
  list / get / receipt / cancel; tag *Cross-border routes*): the partner-API form of Move money and Remittance. Fund
  from the wallet or **any card, bank or mobile money through a licensed processor**, deliver to a BitriPay wallet, a
  QR code, **any bank account or mobile money number anywhere**, an agent, or the account's own wallet, **in the
  currency the recipient will receive** (the payout-currencies call lists what the corridor, licence and liquidity
  allow right now); rate, margin and every fee are fixed on the quote and the route reports every stage from quote to
  settlement. `POST /v1/remittances` accepts a `source` (card / bank / mobile money) and a `mobile_money` payout
  method, in which case it runs as a route. A secret API key authenticates funding started by the account's own
  systems; a declined card fails the route cleanly with nothing paid out. Scopes `routes:read`, `routes:write`.
- **BitriPay Lite** gains **Send abroad** (`/lite/remit`): amount, wallet, the currency the recipient receives, the
  rate and fee shown before the PIN, for feature-phone browsers.
- **v1 endpoints** (`routes/v1ext.ts`, all in the OpenAPI document): `GET /v1/wallets` (balance, available after
  holds, held by kind), `POST /v1/transfers/quote` (the disclosed quote plus rails ranked by the smart router for the
  chosen policy), `POST /v1/transfers` (idempotent), `GET /v1/transfers/{id}`, `GET /v1/remittances/quote`,
  `POST /v1/remittances` (idempotent), `GET /v1/remittances`, `POST /v1/payouts/batches` and the batch lifecycle
  (`columns`, list, get, `approve`, `cancel`), `POST /v1/ai/{agent}` (canonical agent names accepted, ACU-metered,
  provider and model never disclosed) and `GET /v1/ai/runs/{id}`. New API key scopes: `wallets:read`,
  `transfers:read|write`, `remittances:read|write`, `payouts:approve`, `ai:run`. Admin oversight and four-eyes
  approval at `/api/admin/finops/payout-batches`.

### FX engine tools, credit readiness and merchant billing

- **FX alerts, auto-convert and forwards (module 11)** (`services/fxTools.ts`, `/api/fx-tools`, web page **Rates &
  forwards**): alerts on the reference rate fire once and notify; auto-convert rules convert a share of every receipt
  or sweep whatever sits above an amount to keep, only at or above the rate floor the account holder set, and never
  without a rule they created under step-up; forwards lock today's disclosed rate plus a forward margin for a
  settlement date up to the configured tenor, ring-fence the source amount as a hold, settle at the locked rate
  whatever the market does (daily job, or early by treasury) and expire with the hold released after the grace
  period. Platform exposure is capped per forward, per account and in total (`/api/admin/growth/fx`).
- **Credit readiness (module 13)** (`services/creditReadiness.ts`, `/api/credit`, web page **Credit readiness**): a
  0–1000 signal from the account's own history — income regularity, spending versus income, savings behaviour,
  balance stability, account age and KYC tier, bills and commitments, disputes and risk reviews — each factor
  explained with a tip. Lenders read it only through a consent the account holder grants under step-up (access code,
  expiry, revocation, every read logged) at `GET /v1/credit_readiness/{code}` with the `credit:read` scope; the
  response carries the score, band and factors, never transactions, and states that BitriPay does not lend. Weekly
  batch refresh (the CreditReadiness agent's schedule).
- **Subscriptions and billing (module 16)** (`services/billing.ts`, `/v1/plans`, `/v1/subscriptions`, `/v1/invoices`,
  customer side `/api/billing`, web pages **Subscriptions** and the merchant **Plans & billing** tab): plans with
  day/week/month/year intervals, trials, tax (label and basis points) and metered usage; a customer subscribes under
  step-up (the mandate), the first period is collected immediately (or after the trial), each invoice is an ordinary
  merchant payment carrying the invoice number, usage recorded during the period is billed with the next invoice,
  failed collections retry after 1, 3 and 7 days with the subscription `PAST_DUE` and a notification at each step,
  then cancel; cancel-at-period-end ends without a charge. Webhook events `subscription.created`,
  `subscription.cancelled`, `invoice.paid`, `invoice.payment_failed`; recurring-revenue and 30-day collection
  overview per merchant.

### Open banking: linked accounts, income verification, pay by bank, recurring mandates

- **One provider contract** (`services/openBanking.ts`): institutions, hosted authorisation, consent exchange,
  statement sync, single payments and VRP mandates. The **sandbox bank** ships complete (institutions for CD, GB, FR,
  KE, NG; a hosted approve/decline page at `/api/open-banking/sandbox/authorise/:link`; one or two accounts; six
  months of deterministic statements; payments that debit the sandbox balance; mandates) so every flow runs end to end
  without credentials. No live provider credentials are bundled: a live provider is added by implementing the same
  contract. **Statement import** (`POST /api/open-banking/statements`, CSV with date / description / amount or
  credit / debit columns) gives real bank data today without any provider.
- **Consent lifecycle**: links are `PENDING → LINKED` (or `DECLINED`), expire with the bank consent, and can be revoked
  at any time; revocation drops the consent token and every mandate on the link. Consent tokens are encrypted at rest
  and never returned, not even to administrators (`/api/admin/growth/open-banking`).
- **Income verification**: recurring credits (three or more months, amounts within a quarter of the median) become
  verified income streams with a confidence level; the report feeds the **verified income** factor of credit
  readiness and is re-run on every link, sync and import.
- **Pay by bank**: the `open_banking` gateway (`src/payments/openBanking.ts`, method `bank`) runs an ordinary deposit
  through the payments pipeline — fees, issuance authority, settlement and the stage log all apply — executed from
  the account holder's linked account; a bank refusal fails the payment cleanly.
- **VRP mandates** (`POST /api/open-banking/mandates`, step-up protected): per-payment and monthly limits, purpose
  `top_up` or `billing`. Subscription collection draws a wallet shortfall under a billing mandate before it charges;
  an amount over the limits fails the invoice into dunning. Web page **Linked banks** (`/app/banks`).

### Mobile: offline payments and savings

- **Offline-native on the phone** (`frontend/mobile/src/lib/offline.ts`, screen **Offline payments**): an Ed25519 subkey
  generated on the device (tweetnacl, secret half in the secure store, only the public half registered as SPKI),
  a monotonic counter, prefetched merchant nonces, merchant-side signed offline BitriQR codes without network, and a
  payer-side queue of promises signed on the phone (SHA-256 hash and canonical string identical to the API's). The
  scan flow recognises an offline code when the resolver is unreachable and queues the payment; the queue syncs in
  order when the network returns and shows per-promise outcomes and restored balances.
- **Savings & goals** screen: goals with progress, set aside / release, the anchor share and round-ups, and the
  live-within-means monitor with its plan.

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
  on the main model (default £0.90, the lowest price that keeps the 66% gross-margin floor on a 6 000-token run) only for the roles allowed to ask (merchants, agents, administrators).
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

Or build manually: `npm run build` then `node backend/api/dist/index.js` and serve `frontend/web/dist` and
`frontend/admin/dist` as static sites (both proxy `/api` and `/v1` to the API; set `VITE_API_URL` at build
time to use an absolute API URL instead). Set strong `JWT_SECRET` and `APP_SECRET`, `WEB_URL`,
`ADMIN_URL`, `API_URL`, and mount `backend/api/data` (SQLite, WAL mode) on persistent storage.
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
