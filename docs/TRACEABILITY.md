# Sprint traceability

The build sequence from the specification ("agents-first, licence-light") mapped to what exists in this repository.
Every row cites real files, test suites and commits (`git log --oneline`); nothing listed here is planned-only.

| Sprint (specification) | Deliverable | Where it lives | Proof | Commits |
| --- | --- | --- | --- | --- |
| 0–4 · Ledger + TLV | Double-entry ledger with Guardian invariants; BitriQR TLV package with test vectors | `backend/api/src/services/ledger.ts`, `services/guardian.ts`, `shared/bitriqr` | `core.test.ts`, `acceptance.test.ts` "ledger under load", `acceptance_scale.test.ts` (10 000 postings), `bitriqr.test.ts`, `shared/bitriqr/src/*.test.ts` | 7150de0, 13ea54f, 42b4957 |
| 5–10 · Flow A + Flow C | Closed-loop wallet QR; Scan-to-Verify (KODA) on app and WhatsApp; Phase-1 agents in shadow mode | `services/qrcodes.ts`, `services/verification.ts`, `services/channels/*`, `services/assist/*` | `gateway_v1.test.ts` (Scan-to-Verify), `channels.test.ts`, `assist.test.ts` | c2aa065, 9c08c56, 785a8b4 |
| 11–18 · Gateway + first interop connector | Payment intents API, hosted checkout, webhooks, sandbox with failure-mode MSISDNs; mobile-money connector through the aggregator contract; AMBIGUOUS machinery | `routes/v1.ts`, `services/intents.ts`, `services/webhooks.ts`, `payments/sandbox.ts`, `services/rails.ts` | `gateway_v1.test.ts`, `gateway.test.ts`, `rails.test.ts`, `contract_gateway.test.ts` | c2aa065, dcad25a, 5877f67 |
| 19–26 · Aggregator GA + offline + Diaspora-Direct pilot | Multiple operator connectors with Smart Route on live stats; offline protocol; Diaspora-Direct purpose-locked quotes | `services/rails.ts`, `services/offline.ts`, `services/diaspora.ts`, `frontend/mobile/src/lib/offline.ts` | `switch.test.ts` (T01–T32), `intelligence.test.ts`, `contract_offline.test.ts`, `acceptance.test.ts` "offline batch" | dcad25a, d8bebe8, c857535 |
| Gate to scale | 95 % auto-reconciliation, < 2 % exception rate, zero Guardian halts in 30 days, fraud loss < 25 bps, measured before any marketing spend | `services/goLive.ts` (gate-to-scale section), `services/finops/processorRecon.ts`, `services/switch/reconciliation.ts` | `contract_operations.test.ts`, admin go-live checklist | 260299e, 83738f7 |
| Financial operations | Fee schedules, commissions, settlement profiles and cycles with separate provider / BitriPay / tax lines, disputes, holds, splits with refund allocation, processor reconciliation | `services/finops/*` | `finops.test.ts`, `contract_finops.test.ts` | 83738f7 |
| Risk, compliance, agents | Policy engine, fraud scoring, compliance cases, KYC tiers with per-country seeds, KYB, destination protection, agent float intelligence and trust score | `services/risk/*`, `services/risk.ts` | `risk.test.ts`, `onboarding.test.ts`, `contract_security.test.ts` | 3a50f7b |
| Growth modules | Savings anchor, wellbeing, FX tools, credit readiness, subscriptions and billing, bulk payouts, open banking | `services/savings.ts`, `services/fxTools.ts`, `services/creditReadiness.ts`, `services/billing.ts`, `services/bulkPayouts.ts`, `services/openBanking.ts` | `growth.test.ts`, `v1ext.test.ts`, `openBanking.test.ts` | feba5a9, 25277a3, e2f489d, faaca0c |
| Surfaces | Web (user / merchant / agent), admin console, mobile app with Pay and Wallet hubs, payout device, BitriPay Lite, USSD / SMS / WhatsApp channels, developer portal, SDKs, WooCommerce | `frontend/*`, `backend/api/src/site`, `shared/sdk-*`, `integrations/woocommerce-bitripay` | `npm run verify`, `npm run smoke` | 7150de0, f1048e4, 15e926b, 4ecdaa4, 38155a3 |

## Commit index

```
5877f67 Harden and clean: production refuses default secrets, one partner API prefix, one balance rule
47dc3b1 Developer readiness: lint across all layers, developer guide, complete env example
faeadc6 Separate backend, frontend and shared; one verification command; CI; live smoke
07be0d6 Cross-border routes and card-funded remittance on the partner API; lite Send abroad
c857535 Mobile: offline-signed QR payments and savings & goals screen
faaca0c Open banking: linked accounts, statement import, income verification, pay by bank, VRP mandates
e2f489d FX alerts, auto-convert rules and forwards; credit readiness; merchant subscriptions and billing
25277a3 Bulk payouts and v1 account endpoints
feba5a9 Savings anchor and goals, wellbeing monitor, locale chains, ring-fenced holds, acceptance tests
38155a3 Phase 7 (part 2): merchant command centre, QR centre, developer portal, PWA, admin consoles, SDKs, OpenAPI
d8bebe8 Phase 7 (part 1): offline QR protocol, Diaspora-Direct, AI gateway, agent mesh, domain events
3a50f7b Phase 6 risk, compliance and agents
83738f7 Phase 5 financial operations
dcad25a National Switch Gateway with acceptance tests T01–T32
c2aa065 Gateway v1: checkout sessions, payment links, atomic refunds, Scan-to-Verify, payouts, webhook engine, scoped API keys, sandbox simulator
42b4957 Wire BitriQR scanning into web and mobile, admin guardian/capability/intent consoles
13ea54f Add BitriQR standard, payment intents with attempts and event store, Guardian, capability matrix
9c08c56 Add agent runtime and command centre API
7f3d005 Add payment lifecycle, no-API evidence engine, maker-checker and gateway controls
250e342 Add corridor registry, prefunded liquidity, payout devices and the transfer lifecycle
8311f21 Add passkey/biometric auth, direct mobile money rail, any-to-any money routing
7150de0 Add BitriPay web app for users, merchants and agents
```
