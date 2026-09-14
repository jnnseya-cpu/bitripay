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

## Where to read next

| Document | What it covers |
| --- | --- |
| [docs/DEVELOPER.md](docs/DEVELOPER.md) | Day-to-day developer guide: environment, scripts, tests, smoke, conventions |
| [docs/PLATFORM.md](docs/PLATFORM.md) | Complete feature, brand, configuration, API, WooCommerce, deployment and security reference |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | Requirement → implementation → proof matrix, and how to reproduce every check |
| [deploy/README.md](deploy/README.md) | Go-live deployment for bitripay.com: DNS, TLS, environment, webhooks, `npm run deploy`, `npm run go-live` |
| [docs/operating-system](docs/operating-system) | The BitriPay operating-system dossier (gateway, switch, financial operations, risk, intelligence) |
| [docs-api.http](docs-api.http) | Generated REST Client quick reference for the partner API (`npm run docs:http`) |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Layer boundaries, non-negotiable rules and the verification gate |

## Verify everything

```bash
npm ci
npm run verify          # lint, shared build + tests, backend typecheck/build/tests, web + admin typecheck/build, mobile + payout device
npm run smoke           # live checks against `npm run dev` with a seeded database (needs Chromium; see scripts/README.md)
```

Production refuses to start with development secrets: set `JWT_SECRET`, `APP_SECRET` (32+ random characters) and a
strong `ADMIN_PASSWORD` before `NODE_ENV=production` or `docker compose up`.

## License

MIT
