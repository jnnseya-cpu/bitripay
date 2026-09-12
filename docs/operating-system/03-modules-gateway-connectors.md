## 6. Full platform modules

Module-by-module specification. "As built" modules are listed with their existing scope so nothing is lost; "extended" describes what the BitriPay OS adds.

| Module | As built | Extended by the BitriPay OS |
|---|---|---|
| Accounts & identity | Email/phone OTP registration, 2FA (TOTP), transaction PIN, passkeys (WebAuthn), biometric step-up, device registration, KYC submissions and review, loud-alert preference | Organisations, roles as permissions (regulator, developer, partner), device fingerprinting and risk-based authentication (section 13), session risk scoring |
| Wallets & ledger | Double-entry multi-currency ledger, per-currency balance assertion, escrow holds, fee splits, conversion legs through treasury, promotional credit, wallet freezes, balance classification | Feature store views for agents; ledger projections to the warehouse in near-real time |
| E-money issuance | Programmes, safeguarded reserve movements with maker-checker, headroom rule, pools and allocation, daily reconciliation with auto-suspension, issuance register | Treasury Centre agents (forecasting, explanations); regulator read-only reporting |
| Payments & gateway | Aggregator (Sandbox, Stripe, Paystack, Flutterwave, manual bank, manual mobile money), payment intents with lifecycle stages, 3-D Secure config, webhooks with replay protection, refunds, disputes/chargebacks, health checks and live/test modes | Payment Agent routing, processor connectors (Adyen, Checkout.com, PayPal), acceptance analytics |
| Routing & corridors | Any-to-any routes with quotes and FX disclosure, corridor registry with compliance arrangements and licence expiry, recipient currency choice with beneficiary consent, confirmation methods per leg | Corridor demand forecasting, automatic corridor readiness reports |
| Liquidity & payouts | Prefunded payout accounts with float wallets, payout instructions and stages, device and agent claims, evidence verification, expiry and requeue, chargeback recall | Operations Agent prefunding and rebalancing proposals; float forecasting |
| Evidence engine | Registered Ed25519 devices, signed request auth, parsing templates per operator, confidence scoring, replay/duplicate detection, SIM identity checks, manual review | Learned parsing templates proposed from unmatched messages (human-approved), anomaly detection on device behaviour |
| Payout device app | Android SMS receiver, queue, claim, USSD, signed evidence, offline retry, alarm | Telemetry into System Health; remote policy (allowed hours, per-payout caps) |
| Merchant tools | POS, payment links, hosted checkout, API keys, webhooks, settlements (auto and manual), sales analytics, WooCommerce plugin | Merchant Growth Centre; dispute evidence assembly; product analytics |
| Agent tools | Cash-in, cash-out codes, remittance pickup, payout queue, commission, statistics | Agent Operations Centre; float forecasting; network views |
| Remittance & FX | Remittance to wallet, bank, cash pickup; exchange with margin; live rate providers with snapshots and freshness; guaranteed quotes | Pricing Agent margin proposals; FX exposure monitoring |
| Cards | Virtual cards (issue, fund, withdraw, freeze, reveal with PIN), saved external cards tokenised with processors | Card programme connector (issuer processor) for network acceptance where licensed |
| Services | Bills, airtime, gift cards, catalogs | Biller connectors; failure-rate monitoring |
| P2P trading | Offers, escrow, chat, disputes | Fraud Agent graph analysis on P2P counterparties |
| Statements & reporting | Numbered, hashed statements (JSON/CSV/PDF), public verification, admin generation, reports, CSV export | Warehouse-backed reporting; regulator schema exports |
| Notifications | In-app, push (Expo) with loud channel, email, SMS, broadcasts | Channel connectors (WhatsApp, Twilio, SendGrid, Brevo), preference centre, delivery analytics |
| Support | Tickets, live chat, contact inbox, newsletter | Support Agent first line; complaint timeline tracking |
| CMS & site | Pages, languages and overrides, site settings, blog with SEO engine, policies, landing page | Marketing Agent campaigns; multilingual generation with review |
| Admin | User/merchant/agent/admin care, approvals, verification console, corridors and liquidity, e-money and reserves, go-live checklist, gateways, rates, mobile money and evidence, sanctions and risk events, event log and reconciliation, audit logs, Blog & SEO | Admin Super Control Centre (section 14), agent management, connector health, cost |
| Audit & events | Append-only audit logs and hash-chained event log with streams (payment, auth, evidence, approval, ledger, admin, risk, route, payout, liquidity, corridor, chargeback, issuance) | New streams: `agent`, `connector`, `release`, `security`; regulator verification endpoint |
| Security | Rate limits, idempotency keys, signed webhooks, encryption of secrets, sanctions, velocity, cooling-off, step-up, maker-checker | Section 13 in full |
| Billing & subscriptions | Fees and limits configuration | New: plans, subscriptions, AI credit accounts, invoices, usage metering (section 12) |
| Marketplace | none | New: connector and template marketplace with revenue share |
| Developer portal | Merchant API keys and v1 API | New: Developer Centre (section 7) |

---

## 7. BitriPay payment gateway API door

The gateway already exists for merchants (API keys, v1 API, hosted checkout, webhooks, WooCommerce plugin). This section specifies the **installation door**: the complete surface a merchant, partner or external platform uses to plug BitriPay in, in sandbox first and then live.

### 7.1 Environments and keys

- Two environments per organisation, **sandbox** and **live**, with separate key pairs, separate webhook endpoints and separate data. Sandbox is the compliance-mode sandbox as built: real flows, labelled balances, simulated processors and operator confirmations.
- Keys: `pk_test_…` / `sk_test_…` and `pk_live_…` / `sk_live_…`. Secret keys are shown once, stored hashed (as built), rotatable with a grace period, and scoped by permission set (payments, refunds, payouts, read-only). Restricted keys for plugins.
- Live keys are issued only when the organisation's KYB is verified and the platform is in live compliance mode for the merchant's country.

### 7.2 Merchant onboarding
1. Register as merchant (as built) → 2. KYB documents and owners (Compliance Agent pre-check) → 3. Choose settlement destination and schedule → 4. Sandbox keys issued immediately → 5. Integration checklist (create intent, handle webhook, refund, dispute response) verified by the API Integration Agent from real sandbox traffic → 6. Live keys on approval.

### 7.3 Payment services exposed

| Capability | Endpoint family | Notes |
|---|---|---|
| QR payment | `POST /v1/qr` (static per merchant, dynamic per amount) | Returns image, payload and deep link; as built |
| Payment links | `POST /v1/payment_links` | Expiry, amount or open, success/cancel URLs |
| Hosted checkout | `POST /v1/checkout_sessions` | Wallet, card, mobile money, bank transfer, BitriPay virtual card |
| Payment intents | `POST /v1/payment_intents`, `GET`, `POST …/confirm`, `…/cancel` | Lifecycle stages as built; 3-D Secure handled by the processor |
| Wallet payments | Customer pays from BitriPay balance by scanning or approving a request | Approval on the customer's device; never a merchant-initiated debit without a mandate |
| Mandates (new) | `POST /v1/mandates` | Customer-approved recurring debits with caps; step-up on creation |
| Refunds | `POST /v1/refunds` | Partial and full; to original method; as built rules |
| Disputes | `GET /v1/disputes`, `POST /v1/disputes/{id}/evidence` | Chargeback cases as built; evidence assembly by agents |
| Payouts (new for partners) | `POST /v1/payouts` | Bank, mobile money, agent; executed by the payout engine as built; requires payouts scope and prefunded balance |
| Settlements | `GET /v1/settlements`, `GET /v1/balance` | Schedule and statements |
| Commission split (new) | `split` object on intents and links | Platform fee and multi-party splits posted as fee splits in the ledger (as built primitive) |
| Transaction monitoring | `GET /v1/events`, `GET /v1/transactions` | With filters; risk reason codes |

### 7.4 Webhooks
- Signed with HMAC-SHA256 over timestamp + body, header `BitriPay-Signature: t=…,v1=…`; replay protection window 5 minutes (as built pattern).
- Event catalogue: `payment_intent.*`, `checkout_session.completed`, `refund.*`, `dispute.*`, `payout.*` with the payout stages as built, `settlement.paid`, `mandate.*`, `balance.low`.
- Delivery: at-least-once, exponential retry for 72 hours, endpoint health score, manual and agent-driven replay, delivery log in the Developer Centre.

### 7.5 Developer Centre
- Documentation generated from the OpenAPI specification (section 11) with runnable examples per language; SDKs for JavaScript/TypeScript, PHP, Python, Java, Kotlin/Android, Swift; the WooCommerce plugin as built plus Shopify, Magento and a generic WordPress plugin as roadmap items.
- Testing tools: sandbox card numbers and mobile-money prompts (as built), simulated operator confirmations, webhook tester, request inspector, "integration score".
- API Integration Agent available in the console and via `POST /v1/assist`.

### 7.6 Revenue management
- Fee schedule per organisation (percentage, fixed, minimum, per method and corridor).
- Revenue sharing: platform partners and licensees receive a share of fees on traffic they bring, computed per transaction as fee splits and settled monthly.
- Settlement engine: netting of fees, refunds, chargebacks and reserves; rolling reserve for high-risk merchants; statements as built.

---

## 8. Third-party connector ecosystem

Connectors are implemented as adapters behind one interface per category (as built for payment providers: `PaymentProvider` with `createPayment`, `verify`, `refund`, `keyMode`, `healthCheck`, webhook parsing). Each connector declares: credentials schema, health check, sandbox behaviour, data sent and received, and the events it emits. Credentials are encrypted at rest (as built); connector health feeds System Health.

| Category | Why it is needed | Where it connects | Data sent / received | Provider options |
|---|---|---|---|---|
| Payments (cards, wallets) | Card acquiring, 3-D Secure, tokenisation | Payment aggregator | Intent, card token → status, fees, disputes | BitriPay (own), Stripe, Adyen, Checkout.com, PayPal, Paystack, Flutterwave |
| Banking-as-a-Service | Virtual accounts, real bank payouts, safeguarding accounts | Funding (bank transfer), withdrawals, treasury | Account details, transfers → statements, confirmations | Regional BaaS providers, ClearBank-class institutions, partner banks |
| Open banking | Account-to-account funding with consent, balance checks | Add money | Consent, payment initiation → status | Local open-banking APIs where they exist |
| KYC / KYB | Document and liveness verification, business registry checks | Onboarding, KYC review | Documents, selfie → decision, extracted fields | Sumsub, Persona, Veriff, Smile ID (Africa coverage) |
| AML screening | Sanctions, PEP, adverse media | Sanctions module | Names, DOB → hits with scores | ComplyAdvantage, Dow Jones, LexisNexis, Refinitiv |
| Fraud prevention / device intelligence | Device fingerprint, bot detection, behavioural signals | Risk Agent | Device signals → risk score | Sardine, SEON, Fingerprint |
| Identity verification (phone, email) | Number ownership, SIM swap detection | Registration, step-up | MSISDN → carrier, SIM-swap date | Twilio Lookup, TeleSign, local operator APIs |
| Email | Transactional and campaigns | Notifications, marketing | Templates, recipients → delivery events | SendGrid, Brevo, Postmark, Amazon SES |
| SMS | OTP, alerts, fallback for low-data users | Notifications | Message → delivery status | Twilio, Africa's Talking, Infobip |
| WhatsApp | Alerts, receipts, support, campaigns | Notifications, support | Templates → delivery, replies | WhatsApp Business Platform via Meta, Twilio |
| Push | Money alerts with loud channel (as built) | Notifications | Payload → receipts | Expo push (as built), FCM, APNs |
| Maps / geolocation | Agent finder, distance to cash, location risk | Agents & cash, risk | Coordinates → places, distances | Google Maps Platform, Mapbox |
| Logistics | Delivery confirmation for merchant disputes | Merchant disputes | Tracking numbers → status | Local carriers, Shippo-class aggregators |
| Accounting | Merchant bookkeeping export | Merchant Growth Centre | Settlements, fees → journal entries | QuickBooks, Xero |
| Tax | VAT/withholding calculation on fees where required | Billing | Amount, jurisdiction → tax | Local tax engines, Avalara-class |
| CRM | Sales and partner pipeline | Revenue agents | Leads, activities | HubSpot, Salesforce |
| Analytics | Product analytics, session replay (consented) | Data intelligence | Events → dashboards | PostHog (self-hosted option), Mixpanel |
| AI model providers | Agents, embeddings, speech | Orchestration layer | Prompts, tools → completions; text → vectors | Anthropic (primary, as built), OpenAI, Google Gemini/Vertex AI, Cohere, Mistral for fallback and embeddings |
| Speech and translation | Voice command centre for low-literacy users | Command centres | Audio ↔ text; text ↔ text | Google Speech/Translate, Azure Speech, Whisper-class models |
| Cloud storage | KYC documents, statements, evidence archives | Everything with files | Objects, signed URLs | Cloudflare R2, Amazon S3, Google Cloud Storage |
| Authentication | Enterprise SSO for organisations, passkeys (as built) | Identity | SAML/OIDC assertions | Okta, Microsoft Entra, Google Workspace |
| Document generation | Contracts, statements (as built PDF), letters | Statements, partners | Data → PDF | Built-in PDF writer (as built); DocRaptor-class for complex layouts |
| E-signature | Partner and agent agreements | Partner Centre, onboarding | Documents → signed PDFs, audit trail | DocuSign, Dropbox Sign |
| Customer support | Ticketing beyond the built-in | Support | Tickets, transcripts | Built-in (as built); Zendesk, Intercom for enterprise licensees |
| Data enrichment | Business data for KYB, merchant category | Onboarding, risk | Registry numbers → company data | Local registries, Creditsafe-class |
| Currency exchange | Rates and hedging | FX module (as built providers) | Pairs → rates; exposure → hedges | Frankfurter/ECB, Open Exchange Rates (as built); bank FX desks for hedging |
| Subscription billing | Plans, invoices, dunning for the OS's own customers | Billing module | Plans, usage → invoices | Built-in ledger-based billing (section 12); Stripe Billing for card-paid plans |
| Cloud | Compute, database, queues | Infrastructure | — | AWS, Azure, GCP; Cloudflare in front |

Each connector ships with: an adapter, a contract test against the provider's sandbox, a health check on the go-live checklist (as built pattern for processors and rate providers), a runbook for outages, and a cost model feeding the Infrastructure Optimisation Agent.
