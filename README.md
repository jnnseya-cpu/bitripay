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

**Any → any money movement** – fund from a card, bank transfer, mobile money or your wallet and deliver
to a BitriPay user, a QR code / payment link, a bank account, any mobile money number or cash at an agent,
in one request (`POST /api/money`), with fee- and FX-aware quotes. The wallet is the hub, so no extra
integration is needed between rails.

**Mobile money without operator APIs** – a directory of 253 mobile money operators in 128 countries
(MTN, Airtel, M-Pesa, Orange, Wave, bKash, GCash, Paytm, Pix, …) ships in `@bitripay/shared`. Give an
operator your collection/merchant number in the admin panel and customers pay from their own mobile
money app or USSD with a reference; the payment is confirmed automatically from the operator's receipt
SMS (forward it to `POST /api/webhooks/manual_momo` with any SMS-forwarder app), by an agent, or by an
admin. Payouts to any mobile money number are queued for your team or agents. When an API gateway
(Flutterwave, Paystack, MTN MoMo, M-Pesa Daraja) covers an operator it is used automatically instead.

**Biometric login** – passkeys (WebAuthn) on the web app and hosted checkout: sign in with Face ID,
Touch ID, Windows Hello or a phone fingerprint, and confirm payments with biometrics instead of the PIN
(a 5-minute step-up token is accepted wherever a PIN is required). The mobile app uses the device's
biometrics to unlock and to confirm payments.

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

### Tests

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
| Any → any | `POST /api/money` (source: wallet/card/bank/mobile_money → destination: wallet/qr/bank/mobile_money/agent), `POST /api/money/preview`, `GET /api/money/:id`, `POST /api/money/:id/retry`, `GET /api/mobile-money-operators` |
| Biometrics | `POST /api/auth/passkey/options|verify` (sign-in), `GET/DELETE /api/account/passkeys`, `POST /api/account/passkeys/register/options|verify`, `POST /api/account/passkeys/step-up/options|verify` → `X-Step-Up-Token` |
| Payments | `POST /api/transfers`, `GET /api/qr/me`, `POST /api/qr/resolve`, `GET /api/qr/image.svg`, `POST /api/payment-requests`, `/:code/pay|cancel|decline` |
| Checkout (public) | `GET /api/checkout/:code`, `POST /api/checkout/:code/pay` (card / mobile money / bank / virtual card), `/:code/wallet` |
| Add money | `GET /api/deposits/options`, `POST /api/deposits`, `GET /api/deposits/:id`, `POST /api/deposits/:id/proof`, `GET /api/cards` |
| Withdraw | `GET/POST /api/bank-accounts`, `POST /api/withdrawals` |
| Agents | `GET /api/agents`, `POST /api/agents/cash-out`, `POST /api/agents/me/cash-in`, `/me/cash-out/confirm`, `/me/pickups/:code/payout`, `GET /api/agents/me/stats` |
| Remittance | `GET /api/remittances/quote`, `POST /api/remittances`, `GET/POST /api/recipients` |
| Services | `/api/virtual-cards`, `/api/bills`, `/api/topups`, `/api/gift-cards`, `/api/p2p/ads`, `/api/p2p/trades`, `/api/support/tickets`, `/api/support/chat`, `/api/kyc` |
| Merchant | `/api/merchant/stats`, `/gateway`, `/api-keys`, `/webhook`, `/settlements`, `POST /api/merchant/transactions/:id/refund` |
| Merchant API v1 | `POST /v1/payment-requests`, `GET /v1/payment-requests/:code`, `POST /v1/payment-requests/:code/cancel`, `GET /v1/transactions`, `GET /v1/balance`, `GET /v1/me` |
| Admin | `/api/admin/*` (stats, users, transactions, withdrawals, payments, remittances, kyc, settings, currencies, gateways, billers, operators, gift-products, pages, languages, translations, support, p2p, reports, audit-logs, …) |

Webhooks to merchants are signed: `X-BitriPay-Signature: sha256=<HMAC-SHA256(rawBody, webhookSecret)>`,
events `payment.completed` and `payment_request.created`.

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

## License

MIT
