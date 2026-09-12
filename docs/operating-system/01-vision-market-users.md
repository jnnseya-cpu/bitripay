# BitriPay Operating System

**Developer-ready product and architecture document · version 1.0 · September 2026**

This document specifies the transformation of the BitriPay platform, as built in this repository, into an operating system: a governed, self-managing, multi-agent infrastructure layer around a regulated payments core. Nothing that exists today is removed. Every module, workflow, user journey, control and revenue stream already implemented is preserved and named where it is extended.

Conventions: "as built" marks a capability that exists in the repository today; "new" marks a capability specified by this document. Every new capability cites the proven pattern it is modelled on. Where a number is an estimate it is labelled as one. No feature is included that a serious engineering organisation cannot build with today's tooling.

---

## 1. Executive product vision

### 1.1 What it is

BitriPay OS is a **payments-native operating system for autonomous work**. At its centre sits the regulated money core that exists today: a double-entry, multi-currency ledger; e-money issuance backed 1:1 by safeguarded funds; corridors with prefunded local liquidity; an evidence engine that settles mobile-money payouts on cryptographically signed operator confirmations rather than operator APIs; maker-checker controls and a hash-chained event log. Around that core the OS adds four layers:

1. **Command centres**: every user type (customer, merchant, agent, developer, partner, regulator, administrator) receives a dedicated AI command centre with a fixed set of agents that see only that user's data and act only within that user's permissions.
2. **An agent workforce**: specialised, permission-scoped agents for executive, product, engineering, quality, security, revenue, customer and compliance functions, orchestrated through a single control plane with budgets, approvals and audit.
3. **A self-managing platform layer**: agents that watch health, detect defects, repair, optimise spend, manage releases and govern the other agents, each bounded by policies a human can read and change.
4. **An integration and commercial layer**: the BitriPay gateway as an API door for merchants and platforms, a connector ecosystem for third-party services, and a revenue engine covering subscriptions, transactions, AI usage, APIs, marketplace, licensing and white-label distribution.

### 1.2 The problem it solves

Financial platforms today are built as static software plus people. Operations teams reconcile by hand, compliance teams review alerts one by one, growth teams read dashboards after the fact, engineering teams learn about defects from customers, and the platform's own knowledge lives in the heads of a few staff. Meanwhile the customers who need financial services most, a market trader or a moto-taxi rider, receive the least attention because serving them individually does not scale.

A BitriPay OS replaces "software plus people" with "software plus governed agents plus people who decide". The agents do the reading, the reconciling, the drafting, the watching and the first-line fixing, continuously; people set policy, approve what policy requires them to approve, and handle what the agents escalate.

### 1.3 Why it is different

- **Money is the ground truth.** Every agent operates on the same immutable ledger and event log, so recommendations and actions are auditable against real balances, not derived metrics. This is the Bloomberg / Aladdin pattern: one canonical data model that every analytical tool reads.
- **Controls are not optional.** The maker-checker, step-up authentication, issuance-headroom and evidence-verification rules that already gate humans also gate agents. An agent cannot mint balance, release a payout or change a corridor; it can only propose, and a human or a second control approves. This is the Stripe / Goldman pattern of separating the control plane from the data plane.
- **Governance is a product feature.** Agent policies, budgets, permissions and behaviour logs are visible to administrators and, for regulated actions, to regulators. This mirrors how Anthropic and OpenAI expose usage, policy and audit for enterprise deployments.
- **Built for the underserved first.** The command centre for a market trader is a voice-and-sound experience in her language; the command centre for a developer is an API and a console. Same OS, different surfaces.

### 1.4 Why the market needs it

Three converging facts: (a) agentic AI now performs reliable multi-step work when given tools, budgets and guardrails (the pattern behind Claude Code, OpenAI Agents and Microsoft Copilot Studio); (b) payments infrastructure is a commodity at the API level (Stripe, Adyen, Checkout.com) but not at the operations level, where cost still scales with headcount; (c) in the markets BitriPay serves, mobile money is the dominant rail and most of the value chain is manual (agents, cash, reconciliation, disputes). The gap is an operating system that automates operations on top of commodity rails while keeping regulated control points human.

### 1.5 Why it can dominate

Dominance comes from compounding data and distribution, not from any single feature: every settled payout improves the evidence-matching models; every agent run improves the knowledge graph; every merchant integration adds a node to the network; every corridor opened adds liquidity that lowers cost for the next. The commercial architecture in section 12 turns that compounding into eight revenue lines with different margins and different buyers.

---

## 2. Market gap review

### 2.1 What existing platforms do well and where they stop

| Platform class | Examples | Strength | Where they stop | How the BitriPay OS fills the gap |
|---|---|---|---|---|
| Card-first payment APIs | Stripe, Adyen, Checkout.com | Developer experience, global card acquiring, dispute tooling | No mobile-money last mile without operator APIs; operations remain the customer's problem; no agent network | Evidence engine and payout devices (as built) plus operations agents that run reconciliation, disputes and liquidity |
| Mobile money operators | M-Pesa, Orange Money, Airtel Money, MTN MoMo | Ubiquity, cash agent networks | Closed ecosystems, weak cross-operator and cross-border interoperability, thin merchant tooling, no AI assistance for agents | Any-to-any routing (as built), agent command centre, merchant POS and gateway |
| Remittance apps | Wise, Remitly, WorldRemit, Sendwave | Price transparency, speed on corridors they own | Sender-side only, no receiver-side wallet, no merchant acceptance, limited corridor breadth to secondary cities | Receiver-side wallet, agents, recipient currency choice (as built), corridor engine that opens markets with prefunded liquidity |
| Neobanks and super-apps | Chipper, Wave, OPay, Flutterwave apps | Consumer UX, bill pay, cards | Human-scaled operations, limited developer platform, no governed AI | Command centres, agent workforce, API door and marketplace |
| Enterprise AI platforms | Microsoft Copilot Studio, Salesforce Agentforce, ServiceNow Now Assist | Governed agents inside a suite | Not payments-native; no ledger ground truth; expensive; not built for low-connectivity users | Payments-native agents on an immutable ledger, low-bandwidth surfaces |

### 2.2 Where users are underserved

- **Traders and riders** lose money to cash shrinkage, fake payment screenshots and change disputes. Nobody helps them price, save or reconcile.
- **Agents** run out of float on the busiest days and have no forecasting; liquidity is managed by phone calls.
- **Merchants** cannot see which customers return, which products sell, or when a dispute is likely; chargebacks arrive as surprises.
- **Diaspora senders** cannot see where their money is between "sent" and "received" and are charged an exchange margin they never see.
- **Developers** in these markets have no local, sandboxed, well-documented payment API that reaches mobile money without operator contracts.
- **Regulators** receive spreadsheets weeks late instead of live, verifiable reporting.

### 2.3 Where businesses lose money

- Manual reconciliation of operator statements against payouts.
- Idle or stranded float across prefunded accounts.
- Chargebacks on card-funded transfers already paid out.
- Support tickets that repeat the same twenty questions.
- Engineering time spent on incident triage that follows a known pattern.
- Cloud spend that scales with peak, not with usage.

### 2.4 Where automation is missing

Liquidity forecasting and rebalancing, evidence review queues, dispute evidence assembly, KYC document quality checks, SEO and social distribution, release verification, cost optimisation, and regulatory reporting. Each of these is a named agent in this document.

---

## 3. Complete user ecosystem

Every user type, what they see, what they can do, and which command centre they receive. Roles marked "as built" exist today with their journeys; the command centre column is new.

| User type | As built | Primary journeys | Command centre |
|---|---|---|---|
| **Customer** (individual) | yes | Register with phone; receive by QR / @tag; send; add money by card, bank, mobile money, agent; withdraw; remittance; virtual cards; bills, airtime, gift cards; P2P trading; statements; loud alerts | Personal Money Centre |
| **Merchant** | yes | POS QR; payment links; hosted checkout; gateway keys and webhooks; refunds; settlements; WooCommerce plugin | Merchant Growth Centre |
| **Agent** (cash-in / cash-out / payouts) | yes | Float and prefunding; cash-in, cash-out codes; remittance pickup; payout queue; payout device enrolment | Agent Operations Centre |
| **Master agent / institution** | yes (distribution pools) | Pool balances; allocation to agents; oversight of a network | Network Centre |
| **Payout device** (Android app on merchant SIM) | yes | Claim, USSD, signed SMS evidence, alarm | Device telemetry surface (no chat) |
| **Developer** | partial (merchant API keys, v1 API, webhooks) | Keys, sandbox, docs, SDKs, testing tools, usage | Developer Centre |
| **Partner** (payout partner, collection partner, issuer, distributor, white-label licensee) | partial (corridor arrangements) | Contracts, liquidity, settlement, reporting, SLA | Partner Centre |
| **Administrator** (super, staff with permissions: users, transactions, approvals, kyc, settings, gateways, catalogs, cms, support, p2p, reports, admins, issuance, treasury) | yes | All consoles as built: verification, corridors, liquidity, e-money & reserves, go-live checklist, Blog & SEO, evidence, risk, audit | Admin Super Control Centre |
| **Compliance officer / MLRO** | via permissions | KYC review, sanctions, risk events, SAR preparation, reconciliation review | Compliance Centre (a view of the Admin centre) |
| **Treasury** | via `treasury` permission | Reserve funding, programmes, pools, freezes | Treasury Centre (a view of the Admin centre) |
| **Regulator / auditor** | new (read-only role) | Verified ledger and event-chain reports, safeguarding reconciliation, corridor status, complaint statistics | Regulator Centre |
| **Third-party API partner** (KYC provider, processor, rate provider, AI provider) | as connectors | Health, keys, usage, incidents | Connector health in Admin centre |

### 3.1 Identity model

One `users` table with `role` (user, merchant, agent, admin) and permission lists for admins (as built). New roles are added as permissions, not new tables: `regulator` (read-only scoped views), `developer` (a flag on any account that has generated API keys), `partner` (organisation record linked to one or more admin-scoped users). Organisations are introduced as a first-class table (section 10) so that a merchant with staff, a master agent with a network and a licensee with a white-label deployment all share one model.
