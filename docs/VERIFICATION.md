# Verification report

How every requirement sent for BitriPay is built, where it lives after the backend / frontend / shared split, and
how it is proven. Three layers of proof are used:

| Proof | Command | What it covers |
| --- | --- | --- |
| **Unit and integration tests** | `npm run verify` (CI runs the same) | every API suite under `backend/api/src/tests` against an in-memory ledger (the run prints the current count), plus the shared packages (money math, QR codec, phone normalisation, locale parity, BitriQR signing, Node SDK) and the payout-device protocol tests |
| **Builds and type checks** | `npm run verify` | ESLint over every layer, then shared packages, backend, web, admin, mobile and payout device |
| **Live smoke** | `npm run dev && npm run seed`, then `npm run smoke` | the real servers, 51 checks: public site, user / merchant / agent flows, every admin console, BitriPay Lite without JavaScript, the partner API (last run: 51 passed, 0 failed) |

The API test suites (`backend/api/src/tests`) are named after what they prove; the table below maps each requirement
area to them.

## Layer map

| Layer | Path | Talks to |
| --- | --- | --- |
| Backend | `backend/api` | SQLite ledger; publishes `/api/*`, `/api/v1/*` (partner API), `/api/admin/*`, `/lite/*`, USSD/SMS webhooks; imports only `@bitripay/shared` and `@bitripay/bitriqr` |
| Frontend | `frontend/web`, `frontend/admin`, `frontend/mobile`, `frontend/payout-device` | HTTP to the backend only; import `@bitripay/shared` (and `@bitripay/bitriqr` where QR codes are produced on the device) |
| Shared | `shared/core`, `shared/bitriqr`, `shared/sdk-node`, `shared/sdk-php`, `shared/sdk-python` | No dependency on either side |

## Requirements → implementation → proof

### Money, ledger and accounts

| Requirement | Where | Proof |
| --- | --- | --- |
| Immutable double-entry ledger, no direct balance writes, derived balance equals materialised balance | `backend/api/src/services/ledger.ts` (`postTransaction`, `reconcileLedger`) | `core.test.ts` "wallets, transfers & ledger"; `acceptance.test.ts` "ledger under load" (3 000 randomised postings, zero-sum per currency) |
| Wallets in any enabled currency, exchange at disclosed rate and margin | `services/wallets.ts`, `services/transfers.ts` (`exchange`), `services/fx.ts` | `core.test.ts`; `gateway.test.ts` "FX disclosure and route declarations" |
| Ring-fenced holds (disputes, reserves, review, settlement, compliance, savings) that block spending | `services/finops/holds.ts`, ledger `heldOnWallet` guard | `finops.test.ts` "holds and balance classes"; `acceptance.test.ts` savings |
| E-money issuance, safeguarded reserves, headroom, pools, daily reconciliation | `services/emoney.ts` | `emoney.test.ts`; `gateway.test.ts` "e-money issuance" |
| Bank-grade statements (CSV, PDF) | `services/statements.ts` | `statements.test.ts` |
| Idempotency keys on every money POST, hash-chained event log | `middleware/idempotency.ts`, `services/events.ts` | `gateway.test.ts` "ledger, audit and idempotency"; `v1ext.test.ts` |

### Sending, receiving and cross-border

| Requirement | Where | Proof |
| --- | --- | --- |
| Send by @tag / phone / email, QR payment requests, payment links, hosted checkout | `services/transfers.ts`, `services/paymentRequests.ts`, `services/qrcodes.ts`, `frontend/web/src/pages/{Send,Receive,Requests,Checkout}.tsx` | `core.test.ts` "QR & payment requests"; smoke "Send 1.25 USD to bob", "Receive QR", "Point of sale QR" |
| BitriQR: EMVCo merchant-presented QR with signed extension, key registry and rotation, resolver | `shared/bitriqr`, `services/keys.ts`, `services/qrcodes.ts` | `shared/bitriqr` unit tests; `bitriqr.test.ts` "BitriQR payment intents" |
| **Any → any**: fund from wallet, any card, bank or mobile money; deliver to wallet, QR, any bank, any mobile money number, agent, own wallet; recipient chooses the currency received | `services/routing.ts` (`quoteRoute`, `payoutCurrencyOptions`, `createRoute`), web **Move money**, partner API `/v1/routes` | `rails.test.ts` "any → any routing"; `corridor.test.ts` "UK card → Orange Money DRC", "recipient-controlled payout currency"; `v1ext.test.ts` "cross-border routes on the partner API"; smoke "Move money", partner-API quote |
| Remittance to wallet, bank, mobile money or cash pickup in the recipient currency, from the wallet or any card | `services/remittance.ts`, `/v1/remittances`, web **Remittance**, Lite **Send abroad** | `core.test.ts` "withdrawals, agents, remittance"; `v1ext.test.ts`; smoke "Remittance", Lite pages |
| Diaspora-Direct: signed rate policies, four-hour rate cards, institutions, purpose-locked quotes | `services/diaspora.ts` | `intelligence.test.ts` "Diaspora-Direct" |
| Corridors, licences, compliance mode, liquidity, prefunded payout accounts, payout devices, signed SMS evidence | `services/corridors.ts`, `services/liquidity.ts`, `services/payouts.ts`, `services/evidence.ts`, `frontend/payout-device` | `corridor.test.ts`; `gateway.test.ts` "no-API evidence engine"; `onboarding.test.ts` "agent device enrolment"; payout-device protocol tests |
| Withdrawals to bank or mobile money with maker-checker settlement | `services/withdrawals.ts`, `services/verification.ts` | `core.test.ts`; `gateway.test.ts` "maker-checker and administrative step-up" |
| Bulk payouts: CSV validation, four-eyes / step-up approval, in-order execution | `services/bulkPayouts.ts`, `/v1/payouts/batches`, merchant centre tab, admin finops tab | `v1ext.test.ts` bulk payout batch |

### Funding rails and the switch

| Requirement | Where | Proof |
| --- | --- | --- |
| Pluggable processors (sandbox, Stripe, Paystack, Flutterwave, MTN MoMo, M-Pesa, manual bank / mobile money, open banking), health checks, live / test key modes, 3-D Secure, go-live checklist | `backend/api/src/payments/*`, `services/goLive.ts` | `core.test.ts` "deposits & checkout via sandbox gateway"; `onboarding.test.ts` "processor onboarding"; `openBanking.test.ts` |
| Payment intents and attempts, canonical state machine, failover, AMBIGUOUS suspense, reconciliation | `services/intents.ts`, `services/lifecycle.ts`, `services/rails.ts` | `gateway.test.ts` "payment lifecycle"; `switch.test.ts` L1–L5 |
| National switch (Switch Monétique National): participants, connections, certification, vault, reconciliation | `services/switch/*` | `switch.test.ts` |
| Rail registry, Smart Route scoring, circuit breakers, merchant routing policies | `services/rails.ts` | `switch.test.ts` "rail registry and Smart Route"; `v1ext.test.ts` ranked routes |
| Direct mobile-money rail without operator API (collection numbers, SMS auto-confirm) | `services/momo.ts`, `payments/manualMomo.ts` | `rails.test.ts` "direct mobile money rail" |
| Live rate providers with versioned snapshots, staleness rules | `services/currencies.ts`, `services/fx.ts` | `onboarding.test.ts` "live rate providers" |

### Merchants, gateway API, developers

| Requirement | Where | Proof |
| --- | --- | --- |
| Partner API v1: intents, checkout sessions, links, refunds, payouts, balance, wallets, transfers, remittances, routes, plans / subscriptions, payout batches, agents, credit readiness; scoped keys; `BitriPay-Signature` webhooks with 8 retries / 24 h and replay | `routes/v1.ts`, `routes/v1ext.ts`, `services/webhooks.ts`, `docs/openapi.ts` | `gateway_v1.test.ts` (checkout, webhooks, scoped keys, sandbox simulator); `v1ext.test.ts`; `growth.test.ts` billing |
| Developer portal, OpenAPI 3.1, SDKs (Node, PHP, Python), WooCommerce plugin, generated `docs-api.http`, one sandbox magic-number table shared by the simulator | `frontend/web/src/pages/Developer.tsx`, `shared/sdk-*`, `integrations/woocommerce-bitripay`, `backend/api/src/docs/httpFile.ts`, `backend/api/src/payments/sandbox.ts` | Node SDK tests; `hardening.test.ts` "developer surface", "sandbox magic-number table"; smoke "OpenAPI 3.1 document", "Developer portal" |
| One partner API at `/api/v1` and `/v1` (gateway, switch, financial operations, intelligence, merchant profile); one available-balance rule (holds and frozen wallets) used by balance classes, wallets, savings and forwards | `backend/api/src/app.ts`, `services/finops/holds.ts` `availableBalance` | `hardening.test.ts` "same partner API", "one available-balance rule" |
| Signing-key registry: public `/v1/keys`, administrator listing and step-up revocation with audit | `services/keys.ts`, `routes/admin/index.ts` | `hardening.test.ts` "platform signing keys" |
| Merchant command centre (balance classes, settlement, disputes, fees, bulk payouts, plans, offline kit) and QR centre | `frontend/web/src/pages/{MerchantCentre,QrCentre}.tsx` | smoke merchant section |
| Fees with history, commissions, settlement profiles / cycles / statements, disputes as objects, split payments, processor reconciliation workbench | `services/finops/*` | `finops.test.ts` (7 suites) |
| Subscriptions and billing: plans, trials, tax, metered usage, mandates, dunning | `services/billing.ts` | `growth.test.ts` "subscriptions and billing"; `openBanking.test.ts` mandate top-up |

### Risk, compliance, identity

| Requirement | Where | Proof |
| --- | --- | --- |
| Versioned policy engine, fraud score 0–100 with bands, sanctions pre-commit hook, AML monitor, SAR drafts, compliance cases with four-eyes decisions | `services/risk.ts`, `services/risk/*` | `risk.test.ts` (6 suites) |
| KYC tiers 1–4 with per-country limits, KYB, settlement-account change protection, cooling-off, step-up (PIN / passkey / biometrics), 2FA | `services/risk/kycTiers.ts`, `services/risk/accountProtection.ts`, `services/auth.ts`, `services/webauthn.ts` | `risk.test.ts`; `rails.test.ts` "biometric step-up"; `core.test.ts` "config & auth" |
| Error catalogue BP-1xxx … 6xxx on every error | `lib/bpCodes.ts`, `middleware/error.ts` | every test asserting `error.code`; smoke |
| Audit log for admin, KYC and fraud actions; maker-checker on administrative money movements | `services/audit.ts`, `services/verification.ts` | `gateway.test.ts` "maker-checker and administrative step-up", `core.test.ts` "admin" |

### Intelligence and agents

| Requirement | Where | Proof |
| --- | --- | --- |
| One AI gateway with eight layers, ACU metering decoupled from tokens, 66 % gross-margin floor at request, pricing and reconciliation; users never see provider / model / cost; zero-ACU users keep every core flow | `services/assist/gateway.ts`, `services/assist/runtime.ts`, `services/assist/billing.ts` | `intelligence.test.ts` "AI gateway and ACU policy"; `assist.test.ts` "command centres"; `v1ext.test.ts` sanitised runs |
| Agent mesh (RouteOptimiser, FraudScorer, ComplianceMonitor, SavingsAdvisor, CreditReadiness, MerchantGrowth, SupportAgent, LiquidityForecaster, ContentEngine, DisputeResolver, RecipientValidator, Retry Surgeon, Connector Medic, Recon, Exception Hunter, FX Oracle, Rebalancer, Dispute Arbiter, KODA Core), bindings, shadow mode, kill switches, domain events | `services/assist/registry.ts`, `services/assist/bindings.ts`, `services/bus.ts` | `intelligence.test.ts` "agent mesh" |
| Agent float intelligence, trust scores, dynamic commissions, agent-assisted onboarding (Tier 1) | `services/risk/agentIntel.ts` | `risk.test.ts` "agent intelligence" |
| Content engine, blog, SEO, sitemap, IndexNow | `services/blog.ts`, `services/seo*.ts` | `seo.test.ts` |

### Access, offline, locale

| Requirement | Where | Proof |
| --- | --- | --- |
| Offline-signed QR promises (device subkeys, nonces, counters, ceilings, in-order sync, restore on failure, signed receipts) on web, mobile and API | `services/offline.ts`, `frontend/web/src/lib/offline.ts`, `frontend/mobile/src/lib/offline.ts` | `intelligence.test.ts` "offline-signed QR protocol"; `acceptance.test.ts` "offline batch" (50 promises) |
| USSD sessions, SMS commands, BitriPay Lite without JavaScript, PWA with service worker | `services/channels/*`, `site/lite.ts`, `frontend/web/public/sw.js` | `channels.test.ts` (USSD, SMS commands, Lite web); smoke Lite section |
| Language chain (explicit → device → IP country → default) and currency chain (explicit → wallet → IP country → browser → default), Arabic RTL, launch languages | `services/locale.ts`, `services/cms.ts`, `shared/core/src/locales` | `acceptance.test.ts` "language and currency chains"; smoke "Locale chain" |
| Loud money alerts (push, sound, vibration) with a per-device toggle on web, admin and mobile | `frontend/mobile/src/lib/alerts.ts`, `frontend/web/src/lib/alerts.ts`, `frontend/admin/src/lib/alerts.ts`, `services/notifications.ts` | `channels.test.ts`; mobile type check; smoke settings |
| Every locale pack carries every English key with the same placeholders; shared phone normalisation (E.164 and national significant number) used by accounts, evidence matching and sanctions | `shared/core/src/locales`, `shared/core/src/phone.ts` | `shared/core/src/shared.test.ts` |
| Production refuses development secrets and the sample admin password; compose requires them; settings defaults follow `BASE_CURRENCY`, USSD `*149*01#`, 90 s sessions, 8 webhook attempts within 24 h; every documented settings group is administrator-editable | `backend/api/src/config.ts`, `docker-compose.yml`, `services/settings.ts`, `routes/admin/index.ts` | `hardening.test.ts` "refuses to start", "defaults follow", "edit every documented settings group" |

### Personal finance

| Requirement | Where | Proof |
| --- | --- | --- |
| Savings goals as holds, 10 % anchor (raise-only), round-ups, live-within-means monitor with a plan | `services/savings.ts`, web / mobile **Savings & goals** | `acceptance.test.ts` savings; smoke |
| FX alerts, auto-convert rules with a rate floor, forwards with ring-fenced funds and capped exposure | `services/fxTools.ts`, web **Rates & forwards** | `growth.test.ts` "FX engine tools" |
| Credit readiness signal with explained factors, consented lender access, verified income from linked banks | `services/creditReadiness.ts`, `services/openBanking.ts` | `growth.test.ts` "credit readiness"; `openBanking.test.ts` |
| Open banking: linking under consent, statement import, income verification, pay by bank, VRP mandates | `services/openBanking.ts`, `payments/openBanking.ts`, web **Linked banks** | `openBanking.test.ts` (3 suites) |
| Virtual cards, bills, top-ups, gift cards, P2P exchange with escrow and disputes, referrals, support | `services/{virtualCards,services,p2p,referrals,support}.ts` | `core.test.ts` "services & referrals", "P2P trading" |

## Known limits (stated, not hidden)

- Live processor, operator, open-banking and rate-provider credentials are not bundled; every integration runs
  end to end on its sandbox or evidence rail, and switching a corridor to `live` is an administrator decision
  under step-up.
- The mobile and payout-device apps are type-checked and their protocol code is tested against Node's crypto; they
  are not driven on a device in CI.
- Acceptance item 12 of the operating-system contract (p95 latency, Lighthouse on low-end Android) is an
  operational measurement to take on the deployed stack, not a unit test.
