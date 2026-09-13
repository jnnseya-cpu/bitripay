# Developer guide

Everything an engineer needs to run, test and extend BitriPay. The repository has three layers that meet only through
the shared packages and HTTP:

```
backend/api            Express + TypeScript + SQLite (better-sqlite3)   → http://localhost:4000
frontend/web           React + Vite (users, merchants, agents, checkout, landing, PWA)   → :5173
frontend/admin         React + Vite (administration console)            → :5174
frontend/mobile        Expo / React Native (own node_modules)
frontend/payout-device Expo / Android payout device & SMS forwarder (own node_modules)
shared/core            @bitripay/shared  — types, money math, QR codec, countries, currencies, i18n
shared/bitriqr         @bitripay/bitriqr — EMVCo QR + signed BitriPay extension
shared/sdk-node|php|python   partner SDKs
integrations/woocommerce-bitripay   WordPress plugin
```

## 1. Run it

```bash
npm install                                    # root workspaces: shared/*, backend/api, frontend/web, frontend/admin
cp backend/api/.env.example backend/api/.env   # optional: defaults work locally
npm run seed                                   # demo accounts, wallets, sample transactions, payout accounts, a demo payout device
npm run dev                                    # API :4000, web :5173, admin :5174 (concurrently)
```

Seeded logins (password `Password123!`, transaction PIN `1234`): `alice@example.com` (user), `bob@example.com` (user, NG),
`merchant@example.com` (Coffee Corner), `agent@example.com` (agent, GH), `agent.kinshasa@example.com` (DRC payout point).
Administrator: `admin@bitripay.local` / `Admin123!` (from `ADMIN_EMAIL` / `ADMIN_PASSWORD`).

The database is `backend/api/data/bitripay.db` (`DATABASE_PATH` to move it). Migrations in
`backend/api/src/db/migrations/NNN_name.sql` run in order at start-up; add a new numbered file, never edit an old one.

## 2. Verify it

| Command | What runs |
| --- | --- |
| `npm run verify` | shared build + tests, backend typecheck/build/tests (137 tests), web + admin typecheck/build, mobile and payout-device typecheck and protocol tests |
| `npm run test:backend` | API tests only (vitest, in-memory SQLite, ~1 min) — `cd backend/api && npx vitest run src/tests/core.test.ts` for one suite |
| `npm run smoke` | 51 live checks with Playwright against `npm run dev` + `npm run seed` (see `scripts/README.md`) |
| `npm run typecheck:mobile` / `typecheck:payout-device` | the Expo apps (run `npm install` inside each first) |

CI (`.github/workflows/ci.yml`) runs `npm ci` and `npm run verify` on every push.

## 3. Sandbox test data

- **Cards** (sandbox processor): `4242 4242 4242 4242` succeeds; last four `0002` declined, `9995` insufficient funds,
  `0069` expired, `0127` wrong CVC. Any future expiry, any CVC.
- **Mobile money magic numbers**: `+243000000404` wallet not found, `+243000000408` provider outcome unknown (AMBIGUOUS
  → manual review), `+243000000500` timeout then success, `+243000000503` provider unavailable, any number ending
  `0000` customer rejects the prompt. Everything else approves after ~3 seconds.
- **Bank transfer** (`manual_bank`): confirmed by an administrator under maker-checker (Admin → Approvals).
- **Pay by bank / open banking**: link a sandbox bank at Linked banks (or `POST /api/open-banking/links`), approve on the
  hosted page; `open_banking` then appears as a bank gateway.
- **Offline QR**: web Command centre → Offline kit, mobile Offline payments; the API validates every promise at sync.
- **USSD / SMS**: Admin → USSD, SMS & Lite has a simulator; Lite lives at `http://localhost:4000/lite/`.
- **OTP codes** are printed to the API console and returned as `devCode` when no SMTP/SMS provider is configured.

## 4. Partner API

- Create keys in the web app (Merchant → Developer portal) or `POST /api/v1/api_keys` with a merchant session;
  `sk_test_…` / `sk_live_…` secret keys, `pk_…` publishable keys, restricted keys with scopes.
- Authenticate with `Authorization: Bearer <secret>`; money-moving POSTs take `Idempotency-Key`.
- OpenAPI 3.1: `GET /api/v1/openapi.json` (80 paths, generated from `backend/api/src/docs/openapi.ts` — add new
  operations there so the portal, the document and the SDK snippets stay in step).
- Webhooks: `BitriPay-Signature: t=<unix>,v1=<hex hmac_sha256(secret, t + "." + body)>`, eight retries over 24 hours,
  replay from the developer portal; `POST /api/v1/webhook_endpoints/:id/ping` sends a test event.
- Errors: `{ error: { code, bp, message, details } }`; `bp` families BP-1xxx auth · 2xxx validation · 3xxx ledger ·
  4xxx rail · 5xxx compliance · 6xxx intelligence.
- `docs-api.http` is a VS Code REST Client collection of the main calls.

## 5. Where things live (backend)

| Area | Path |
| --- | --- |
| Ledger, wallets, transfers, exchange | `services/ledger.ts`, `wallets.ts`, `transfers.ts`, `fx.ts` |
| Payments, processors, intents, attempts | `services/payments.ts`, `payments/*.ts` (one adapter per provider), `services/intents.ts`, `services/lifecycle.ts` |
| Any → any routing, corridors, liquidity, payouts, evidence | `services/routing.ts`, `corridors.ts`, `liquidity.ts`, `payouts.ts`, `evidence.ts` |
| Switch, rails, smart route | `services/switch/*`, `services/rails.ts`, `services/railCatalog.ts` |
| Finance operations | `services/finops/*` (fees, commissions, settlement, disputes, holds, splits, processor reconciliation) |
| Risk and compliance | `services/risk.ts`, `services/risk/*` (policy, fraud, compliance, kycTiers, accountProtection, agentIntel) |
| Intelligence | `services/assist/*` (gateway, runtime, registry, bindings, billing, meshTools), `services/bus.ts` |
| Personal finance | `services/savings.ts`, `fxTools.ts`, `creditReadiness.ts`, `billing.ts`, `openBanking.ts`, `bulkPayouts.ts` |
| Offline, Diaspora, locale | `services/offline.ts`, `diaspora.ts`, `locale.ts` |
| Channels and Lite | `services/channels/*`, `site/lite.ts`, `site/*` |
| Partner API | `routes/v1.ts`, `routes/v1ext.ts`, `routes/intelligence.ts`, `routes/finops.ts`, `docs/openapi.ts` |
| Admin API | `routes/admin/*` |
| Background jobs | `jobs.ts` (one-minute tick: webhooks, billing, FX alerts, settlement, reconciliation, daily and weekly batches) |

Conventions: money is always an integer in minor units; every error goes through `lib/errors.ts` (`badRequest`,
`unprocessable`, `forbidden`, `conflict`, `notFound`) so it carries a `bp` family; every state change of money
records an event (`services/events.ts`) and, where other modules care, publishes on the domain bus; administrative
money movements go through maker-checker (`services/verification.ts`); nothing is hard-coded to one country,
language or currency — read `COUNTRIES`, the currency table and the language list instead.

## 6. Adding things

- **A processor**: implement `GatewayProvider` in `backend/api/src/payments/<name>.ts`, register it in
  `payments/index.ts` (`PROVIDERS`, `envCredentials`, default gateway row), add credential fields; the admin console
  shows it under Gateways with a health check.
- **A rail connector**: `services/rails.ts` registry + `services/switch/adapter.ts` contract.
- **An agent**: add an `AgentDef` in `services/assist/registry.ts` (tools it may call from `services/assist/tools`,
  budget, roles, plan, bindings); shadow mode and promotion are handled by `bindings.ts`.
- **A partner endpoint**: route in `routes/v1ext.ts` with `requireScope`, scope in `services/merchant.ts`
  (`API_KEY_SCOPES`), operation in `docs/openapi.ts`, test in `src/tests/v1ext.test.ts`.
- **A web page**: `frontend/web/src/pages/*.tsx`, route in `App.tsx`, nav item in `components/Layout.tsx`, i18n keys
  in `shared/core/src/locales/{en,fr,...}.ts` (rebuild shared: `npm run build:shared`).
- **A migration**: next number in `backend/api/src/db/migrations/`; tests run all migrations on an in-memory DB, so a
  broken migration fails every suite immediately.

## 7. Deployment

`docker compose up --build` builds three images from the repository root (`backend/api/Dockerfile`,
`frontend/web/Dockerfile`, `frontend/admin/Dockerfile`), persists the database in the `api-data` volume, and serves the
API on 4000, the web app on 8080 and the admin console on 8081. Set `JWT_SECRET`, `APP_SECRET`, `ADMIN_PASSWORD`,
`WEB_URL`, `ADMIN_URL`, `API_URL` and processor credentials in the environment; the platform starts in compliance
mode `sandbox` and an administrator switches corridors to `live` under step-up.
