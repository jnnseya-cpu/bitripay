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
DRC payout instruction, selects a prefunded Orange Money account (or `LIQUIDITY_UNAVAILABLE` until
treasury prefunds it); the payout device claims it, pays the recipient by USSD, and forwards the
operator SMS signed with its key and SIM identity; the verification engine matches recipient,
amount, reference, operator, SIM and timestamps, rejects replays/duplicates, and marks the transfer
`SETTLED`; both parties are notified and a receipt with the evidence hashes is available.

**Essential limitation** – "no operator API" is not "no payment rail". Without a direct operator or
bank API settlement is not instantaneous, payouts may need an authorised agent, operator interface
changes can interrupt automation, operator limits still apply, and reversals may require manual
processing. The UI says so everywhere it matters.

**Transfer lifecycle** – `CREATED → QUOTED → BIOMETRIC_APPROVAL_REQUIRED → FUNDING_PENDING →
FUNDS_CONFIRMED → PAYOUT_QUEUED → PAYOUT_IN_PROGRESS → EVIDENCE_RECEIVED → VERIFYING → SETTLED`,
with `EXPIRED · FAILED · MISMATCHED · DUPLICATE · LIQUIDITY_UNAVAILABLE · MANUAL_REVIEW · DISPUTED ·
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

**E-money is created by administrators only** – balance enters circulation through exactly four
authorities, enforced inside the ledger (`issuance_authority` on every creating transaction, plus an
immutable issuance register): `external_funding` (a processor- or evidence-confirmed deposit),
`admin` (one administrator with the *issuance* permission proposes a credit, a different one approves
it under step-up), `liquidity` (treasury prefunding a payout float) and `programme` (an
administrator-configured scheme such as referral rewards). Money returning from a platform-held
float (virtual card balances, remittance escrow) is tagged `internal_release` with its origin
transaction. Any other posting from the treasury is refused. `GET /api/admin/emoney` reports the
outstanding supply per currency and how it was issued.

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
