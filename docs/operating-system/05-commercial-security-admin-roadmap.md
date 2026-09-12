## 12. Monetisation model

### 12.1 Revenue architecture

Every charge is a ledger posting to the `fees` system user (as built), so revenue is reconciled in the same double-entry system as customer money. Prices live in `fee_schedules` and `plans`, are versioned, and changes are maker-checker. Nothing is hard-coded.

| Stream | Mechanism | Who pays | Pricing logic | Proven pattern |
|---|---|---|---|---|
| Transaction fees (as built, extended) | Percentage + fixed per product and corridor; FX margin in basis points; promo fee cover for campaigns | Customers, merchants | Tiered by monthly volume; corridor-specific; margin visible on every quote (guaranteed recipient amount as built) | Wise, Stripe, M-Pesa |
| Gateway fees | Per successful payment (bps + fixed), per payout, per refund; dispute fee | Merchants, platforms | Interchange-plus style for cards, flat for wallet/momo; volume tiers | Stripe, Adyen, Paystack |
| Subscriptions | Monthly/annual plans for merchants, developers, organisations, agents: Free, Starter, Growth, Scale, Enterprise | Merchants, developers, organisations | Plan includes ACU allowance, API quota, agent seats, features; billed to wallet, card, or invoice | Shopify, HubSpot, GitHub |
| AI credits (ACU) | Agent Compute Unit: 1 ACU = a normalised bundle of model tokens and tool calls, priced per model class; plans include an allowance; overage metered daily from `model_usage` | All users of agents beyond the free tier | Cost-plus with a target gross margin of 70% on model spend; cached tokens discounted; enterprise reserved capacity | OpenAI/Anthropic usage billing, Microsoft Copilot seats, Snowflake credits |
| API usage | Calls above plan quota, premium endpoints (intelligence, bulk export), sandbox always free | Developers, platforms | Per 1,000 calls; committed-use discounts | Twilio, Cloudflare Workers |
| Commissions | Platform split on marketplace merchant payments; agent (cash) commissions; referral rewards (as built) | Platforms, merchants | `split[]` on payment creation; settled through `commission_splits` | Shopify Payments, Uber/Airbnb take rates |
| Merchant and partner fees | Onboarding for high-risk categories, chargeback handling, premium settlement (T+0) | Merchants | Flat fees, itemised on invoices | Adyen, Checkout.com |
| Premium automation | Workflow packs (e.g. automatic reconciliation to accounting, dispute defence, growth campaigns) | Merchants, organisations | Add-on per month or per execution | ServiceNow, Zapier |
| Data intelligence | Benchmarks, market reports, anonymised aggregates, risk scoring API, partner analytics | Organisations, partners, financial institutions | Subscription per seat or per API call; only aggregated and consented data | Bloomberg Terminal, Palantir Foundry, Databricks marketplace |
| White-label | Licensed deployment of the platform (own brand, own programmes, own corridors) | Licensees (fintechs, banks, MNOs) | Set-up fee + monthly licence + revenue share; multi-tenant or dedicated | Marqeta, Mambu, Thought Machine |
| Enterprise | Dedicated tenancy, SSO, custom agents, SLAs, on-prem data residency | Enterprises, regulated institutions | Annual contract; reserved ACU; professional services | Palantir, ServiceNow, Snowflake |
| Add-ons | Extra seats, extra sandbox environments, statement archives, priority support, loud-alert SMS bundles | All | Itemised monthly | Atlassian, Slack |
| Marketplace | Third-party agents, workflows, connectors, templates | Buyers pay publishers; platform takes 20% | Review before listing; revenue share settled through the ledger | Apple App Store, Salesforce AppExchange, HubSpot marketplace |

### 12.2 Plan matrix (initial)

| Plan | Price (USD-equivalent, local currency billed) | Included | Target |
|---|---|---|---|
| Free | 0 | Wallet, transfers, statements, Chief of Staff (5 ACU/month), sandbox API | Individuals, students, testing |
| Starter | 9/month | Merchant tools, payment links, QR, 50 ACU, 10k API calls, 1 agent seat | Market traders, small shops, riders |
| Growth | 49/month | All agents, 400 ACU, 100k API calls, workflow packs, WhatsApp channel, 5 seats | Growing merchants, developers |
| Scale | 249/month | 2,500 ACU, 1M API calls, dedicated support, premium settlement, 20 seats | Platforms, larger merchants |
| Enterprise | Contract | Reserved ACU, SSO, custom agents, tenancy options, SLAs | Institutions, licensees |

### 12.3 ACU accounting

- Computed per run from `agent_runs.tokens_in/out`, cached tokens, tool calls and model class; written to `model_usage` daily and to `usage_records` per subscription.
- Budgets enforced before each model call: run is paused with `budget_exhausted` and the owner notified; hard tenant cap prevents runaway cost (Infrastructure Optimisation Agent watches spend per tenant in real time).
- Pricing engine (Pricing Agent, section 5) proposes plan and ACU price changes from margin data; changes are maker-checker and never applied by the agent.

### 12.4 Unit economics targets (estimates, to validate in Beta)

| Metric | Target |
|---|---|
| Blended take rate on payments | 1.2–1.8% |
| Gross margin on ACU | ≥70% |
| Gross margin on subscriptions | ≥85% |
| Cost to serve a Starter merchant per month | <2 USD (agents replace manual support and reconciliation) |
| Payback on merchant acquisition | <6 months |

---

## 13. Security, compliance and risk

### 13.1 Regulatory framework

| Domain | As built | Extension |
|---|---|---|
| E-money and safeguarding | Programmes (own authorisation / partner issuer / sandbox), 1:1 reserve rule enforced in code, headroom formula, reconciliation with auto-suspend, regulator export | Daily signed reserve attestation; safeguarding account feeds via BaaS connector; regulator read-only portal (section 3) |
| KYC / KYB | Tiered KYC submissions, admin review, sanctions screening, risk events | Provider connectors (Sumsub/Smile ID), continuous KYC (re-screening on trigger), KYB for organisations with UBO capture, Onboarding Agent pre-review |
| AML / CTF | Sanctions entries, risk events, corridor limits, manual verification | Transaction monitoring rules engine + Fraud Agent models; SAR/STR drafting by Compliance Agent with human filing; travel-rule data on cross-border payouts where required |
| PCI DSS | Cards tokenised via processor; no PAN stored (saved_cards hold tokens) | SAQ-A/A-EP posture maintained; hosted checkout; annual scan; scope documented |
| GDPR and local data protection | Consent records, statement access, data export | Records of processing, DPIA for agents and profiling, right-to-erasure pipeline (memories, tickets, analytics), retention policies per table, data residency options at Enterprise |
| Consumer protection | Quotes with guaranteed recipient amount, beneficiary consent, complaints policy, fees page | Agent disclosures ("drafted by"), cooling-off on agent-initiated payments above limits, plain-language and voice explanations |
| Audit | Hash-chained event log, admin audit logs, statements with hashes | Agent actions on the chain, external anchoring, regulator bundles, SOC 2 Type II programme from Commercial launch |

### 13.2 Cybersecurity Command Centre

Modelled on CrowdStrike Falcon (detection and response), Cloudflare (edge and zero trust) and Microsoft's Security Copilot pattern (analyst agents over signals).

| Capability | Implementation |
|---|---|
| Zero-trust security | Identity-aware access for staff (SSO + hardware keys), mTLS between services, no shared secrets in code, least-privilege database roles, per-request principal scoping |
| Identity protection layer | Session risk scoring, impossible-travel and SIM-swap checks (connector), passkey enforcement for high-risk actions, admin session recording for `treasury`/`agents` permissions |
| Threat detection | Security Agent consumes `security_events`, WAF logs, auth failures, key-usage anomalies, agent behaviour anomalies; correlates into incidents with severity and recommended containment |
| Fraud prevention | Fraud Agent scoring on every money movement (velocity, device, graph features from `features_daily`), step-up or hold decisions within policy, human review queue; model drift monitored |
| Anti-hacking framework | Secret scanning on the repo and on inbound API keys, dependency scanning (Release Management Agent), signed releases, immutable infrastructure, bug bounty at Commercial launch, quarterly penetration test |
| Data protection | Field-level encryption, envelope keys in KMS, PII redaction in logs and prompts, tokenised identifiers in analytics, backups encrypted and tested |
| Prompt and agent security | Tool results wrapped as untrusted data; instruction-like content in tickets, web pages or SMS never executed; output validated against schemas; forbidden tools enforced by the gateway regardless of prompt; canary strings to detect exfiltration; red-team suite run on every prompt change |
| Incident response | Runbooks per incident class; Auto-Repair Agent performs only pre-approved containment (rotate a key, pause an agent, block an IP range, freeze a wallet under policy); humans handle everything else; postmortems in `incidents` |

### 13.3 AI data intelligence layer

Modelled on Databricks (lakehouse), Snowflake (warehouse sharing), Palantir (ontology), Bloomberg (canonical data) and Aladdin (risk engine on one data model).

| Component | Purpose | Implementation |
|---|---|---|
| Data lake | Raw, immutable copies of events, evidence, logs | Object storage, partitioned by day and type; written by the outbox dispatcher |
| Data warehouse | Curated models: transactions, routes, reserves, merchants, agents, usage | PostgreSQL analytics schema at Beta; ClickHouse or BigQuery/Snowflake at Commercial; dbt-style transformations versioned in the repo |
| Vector database | Semantic retrieval for agents | Section 9.8 |
| Knowledge graph | Entities (users, organisations, devices, accounts, corridors, operators, agents) and relationships (paid, owns, shares device, referred, disputes) | Graph tables in PostgreSQL first; a dedicated graph store only if query patterns demand; used by Fraud, Risk and Growth agents |
| Event streaming | Real-time feed of domain and agent events | Redis Streams at Beta, Kafka-class at Enterprise; consumers: analytics, monitoring, agents |
| Real-time analytics | Live dashboards (reserve headroom, corridor SLAs, gateway conversion, agent cost) | Materialised views refreshed by workers; Super Control Centre reads them |
| Predictive engine | Liquidity demand per corridor, churn, settlement shortfalls, fraud probability | Gradient-boosted models trained on `features_daily`; retrained weekly; evaluated against holdouts; served as tools to agents |
| Behavioural analysis | User and merchant behaviour baselines for anomaly detection and personalisation | Rolling statistics per principal, stored in `features_daily` |
| Recommendation engine | Next-best actions (fund reserve, launch campaign, adjust corridor limit, enable a plugin) | Ranked candidates written to `recommendations`; outcomes tracked; only humans act on money-affecting ones |
| Decision engine | Policy-driven decisions where allowed (step-up, hold, route selection, plan suggestions) | Deterministic rules + model scores with explicit thresholds; every decision logged with inputs |
| Governance | Lineage, quality checks, access control, consent enforcement | Data catalogue with owners; quality tests run per pipeline; consent flags propagated to every derived dataset |

---

## 14. Admin Super Control Centre

The as-built admin (users, KYC, transactions, treasury, e-money, corridors, gateways, approvals, settings, CMS/SEO, reports, support, admins) is preserved and gains a control plane for the OS. Modelled on ServiceNow's operational consoles, Cloudflare's dashboard and the observability of Datadog.

| Area | Capabilities |
|---|---|
| Agent registry | List, inspect, pause, resume, retire agents; view charter, tools, permissions, budgets, prompt versions, eval scores; compare versions |
| Policy editor | Author and version policies (allow/deny/require-approval rules per tool with conditions); simulate a policy against historical runs before publishing; maker-checker on publish |
| Approvals inbox | All pending approvals across humans and agents with context, the exact proposed action, risk annotations from Risk Agent, one-click decide with reason; SLA timers |
| Budgets and cost | ACU and cost by tenant, agent, model, day; caps and alerts; model routing table; provider health |
| Runs explorer | Search runs by agent, principal, object, outcome; step-by-step replay with redaction; export for audit |
| Incident room | Open incidents, timelines, containment actions available under policy, postmortems |
| Kill switches | Global agent pause; per-agent pause; per-tool disable; model provider failover; read-only mode for the platform (money movement paused with loud alert) |
| Model and prompt management | Promote prompts, run evals, view red-team results, rollback |
| Intelligence console | Live dashboards (section 13.3), forecast views, recommendation queue with accept/decline and outcome tracking |
| Compliance workspace | Regulator bundles, retention reports, DPIA register, SAR drafts awaiting filing, consent audits |
| Tenant management | Organisations, licensees, plans, subscriptions, invoices, feature flags per tenant |
| Marketplace review | Listing review queue with automated security review by Cybersecurity Agent |
| System health | Go-live checklist (as built) extended with agents, queues, providers, data pipelines; release calendar |

Controls: every action is audited; `treasury`, `agents`, `policies` and `security` permissions require hardware-key sessions; a super admin's session cannot approve their own request (as built maker-checker rule); read-only "regulator" and "auditor" admin roles see everything and change nothing.

---

## 15. Developer build roadmap

Timelines are estimates for a team of 6–10 engineers plus product, compliance and design. Each phase has exit criteria; a phase does not close until its criteria are met in production.

### 15.1 Phase 0 — As built (today)

Ledger, e-money engine, corridors and rails, evidence engine, lifecycle, gateway, merchant tools, virtual cards, services (bills, top-ups, gift cards, remittances, P2P, cash agents), KYC, support, statements, loud alerts, admin, SEO/blog/content agent, mobile and payout-device apps, WooCommerce plugin, 59 API tests.

### 15.2 Phase 1 — MVP (months 1–3)

| Item | Detail |
|---|---|
| Modules | Agent runtime (registry, run controller, tool gateway, policy engine, approvals), memory tier 1–2, KB ingestion with pgvector/sqlite-vec, `organisations`, `plans`, `subscriptions`, `usage_records`, ACU metering |
| Agents | Chief of Staff (customer, merchant), Customer Support, Onboarding, Operations (payout_stuck, reserve_warning workflows), Analyst (merchant), Knowledge; System Health and Bug Detection (report-only) |
| APIs | `/assist/*`, `/usage`, `/billing/*`, gateway `/payments`, `/payment-links`, `/webhook-endpoints`, `/events`, `/sandbox/simulate` |
| Flows | Command centre in web and mobile (text; voice input via device speech), approvals inbox in admin, statement explanations |
| Infrastructure | PostgreSQL migration (adapter), Redis limiter and queues, OpenTelemetry, structured logs |
| Milestones | Internal dogfooding month 2; 100 pilot merchants month 3 |
| Commercial objective | Validate Starter plan and ACU pricing; measure support ticket deflection ≥50% |

### 15.3 Phase 2 — Beta (months 4–6)

| Item | Detail |
|---|---|
| Modules | Workflow engine with declarative workflows, notification channels (WhatsApp, SMS), Developer Centre with OpenAPI docs and SDKs (JS, PHP, Python), marketplace (internal listings only), warehouse schema and `features_daily` |
| Agents | Compliance, Risk, Fraud (scoring in shadow mode then enforcing within policy), Revenue, Marketing/Growth, Data Intelligence, Payment, Workflow Automation; Auto-Repair (pre-approved actions only), Release Management |
| APIs | `/payouts`, `/refunds`, `/disputes`, `/organisations`, admin agent/policy endpoints |
| Flows | Voice-first mobile assistant with translation, merchant growth campaigns, agent (cash) float forecasting, dispute defence |
| Infrastructure | Multi-replica API, worker fleet, Cloudflare WAF, SOC 2 readiness, penetration test |
| Milestones | 1,000 merchants, 2 live corridors with e-money programme, first white-label pilot |
| Commercial objective | Gateway revenue live; Growth plan conversion ≥15% of active merchants |

### 15.4 Phase 3 — Commercial launch (months 7–9)

| Item | Detail |
|---|---|
| Modules | Public marketplace with publisher onboarding, data intelligence products (benchmarks), premium automation packs, billing invoices and dunning, tenant feature flags |
| Agents | Pricing, Predictive Growth, API Integration, Admin Control, full enterprise workforce (executive, product, engineering, quality, cybersecurity, revenue, customer, compliance agents) with evals and budgets |
| APIs | Intelligence endpoints, bulk exports, OAuth 2.1 for platforms |
| Flows | Regulator portal, partner centre, licensee onboarding |
| Infrastructure | Autoscaling, read replicas, ClickHouse/BigQuery warehouse, Kafka-class streaming evaluation, DR drills |
| Milestones | 10,000 merchants, 5 corridors, SOC 2 Type II audit period started, bug bounty live |
| Commercial objective | Positive contribution margin per merchant; ACU margin ≥70% |

### 15.5 Phase 4 — Enterprise (months 10–15)

Dedicated tenancy, SSO/SAML, custom agents per tenant with private KB, reserved ACU, data residency, on-prem connector agents, white-label at scale, enterprise SLAs (99.95%), ISO 27001 programme, regulator integrations per market. Objective: three enterprise/licensee contracts; annual contract value dominating revenue mix.

### 15.6 Phase 5 — Global scale (months 16–24)

Multi-region active-passive then active-active for read paths, per-region ledgers with cross-region settlement, additional model providers per region, localisation to 20 languages including voice, corridor expansion programme driven by the Predictive Growth Agent, marketplace with hundreds of listings. Objective: 1M+ active users, 50 corridors, platform take rate stable, agent operations handling 90% of first-line work.

---

## 16. Competitive advantage

| Advantage | Why it holds |
|---|---|
| Regulated money core with agents on top | Competitors bolt chat onto dashboards; BitriPay's agents act through the same audited controls as staff, on a ledger with 1:1 reserve enforcement. Copying this requires rebuilding the core. |
| API-less rails | Signed operator confirmations let BitriPay settle mobile-money payouts where no API exists, which is most of its target markets. Combined with agents that watch every leg, corridor expansion costs a fraction of API-based competitors. |
| Underserved-first design | Voice, sound and simple flows for low-literacy users are product features with measurable adoption, not accessibility afterthoughts. This is the market nobody serves well. |
| Governance as product | Policies, budgets, approvals and replayable runs give regulators and enterprises something they can audit. This is the enterprise buying criterion for AI (the pattern Anthropic, Microsoft and Palantir sell on). |
| Unit economics | Agents replace the headcount that makes small merchants unprofitable for incumbents; the Starter plan is viable at a cost to serve under two dollars. |
| Data flywheel | Every settled route, evidence match, dispute and campaign trains better risk, liquidity and growth models, which improve corridor pricing and reduce loss; the data cannot be bought. |
| Distribution | Gateway plugins, marketplace and white-label licensing turn merchants, developers and institutions into channels. |

---

## 17. Output format and supporting documents

This document is delivered as a developer-ready set in `docs/operating-system/`, rendered to a single navigable page, and is the source of truth for the BitriPay OS programme. The following supporting documents are summarised here and expanded in the same directory as the programme proceeds.

### 17.1 Product Requirements Document (PRD) summary

- **Goal**: ship the BitriPay OS layers (command centres, agent workforce, self-managing platform, gateway door, commercial engine) without regressing any as-built capability.
- **Users and jobs**: section 3; top jobs per user type are the first three rows of each command centre in section 4.
- **Functional requirements**: sections 4–8 and 11 (each table row is a requirement with an identifier formed as `§<section>.<row>`).
- **Non-functional requirements**: availability 99.9% (Beta) → 99.95% (Enterprise); p95 API latency < 300 ms for reads and < 800 ms for money writes; agent first token < 2 s; evidence verification < 60 s from receipt; reserve reconciliation daily and on demand; all money-critical alerts loud within 5 s.
- **Acceptance**: the core rule that a route settles only on verified evidence, the issuance headroom formula, maker-checker on every regulated action, and the agent permission-intersection rule are non-negotiable acceptance criteria for every release.
- **Out of scope**: autonomous money movement by agents beyond policy limits; any feature not backed by a proven pattern cited in this document.

### 17.2 Technical Requirements Document (TRD) summary

- Language and runtime: TypeScript, Node 20+, React 19, Expo SDK 53 (as built). Database: SQLite (MVP) → PostgreSQL 16 with pgvector. Queue: BullMQ/Redis → Kafka-class. Models: Anthropic Claude family via the official SDK with streaming, adaptive thinking and structured outputs (as built), provider failover through connectors.
- Interfaces: OpenAPI 3.1 from Zod; webhook signing as built; SSE for run streaming.
- Data contracts: minor-unit integers; ULID ids with prefixes; append-only tables; hash-chained events.
- Quality gates: type-check, lint, unit and integration tests (vitest + supertest as built), Playwright end-to-end (as built scripts), agent evals, security scans; all green before deploy.

### 17.3 Architecture set

| Architecture | Where specified |
|---|---|
| System, infrastructure, scalability | 9.2, 9.16 |
| AI and agent | 9.6–9.9, section 5 |
| Security | 9.14, 13.2 |
| Database | section 10 |
| API and event | section 11, 9.9, 9.11 |
| DevOps, monitoring | 17.4, 9.15 |
| Disaster recovery, business continuity | 17.6 |
| Data governance, compliance | 13.3, 13.1 |
| Commercial | section 12 |

### 17.4 Deployment strategy

- Environments: `sandbox` (public, always free), `staging` (production-like, synthetic data), `production`. Sandbox and production share code; keys select behaviour (as built).
- Pipeline: PR → CI (type-check, lint, tests, evals, SAST, dependency audit, container build) → staging deploy → smoke tests (Playwright) → canary 5% production → full rollout. Release Management Agent drafts notes and watches error budgets; rollback is a single command.
- Database migrations: forward-only, expand/contract pattern, run before deploy; the migration runner as built extends to PostgreSQL.
- Configuration: environment variables and the encrypted `settings` table (as built); no secrets in images.
- Mobile: Expo EAS builds with staged rollout; payout-device and SMS-forwarder apps signed with device-bound keys (as built).

### 17.5 Testing strategy

| Level | Scope | Tooling |
|---|---|---|
| Unit | Ledger invariants, headroom formula, lifecycle transitions, fee schedules, policy evaluation | vitest |
| Integration | API routes with database, webhooks, idempotency, maker-checker, rails and evidence (as built suites) | vitest + supertest |
| End-to-end | Registration, KYC, funding, route to settlement, gateway checkout, statements, command centre flows | Playwright (as built scripts extended) |
| Agent evals | Per agent: golden inputs → expected tool calls and outputs; rubric-graded drafts; refusal cases; injection attempts | Evaluation harness (9.6) |
| Security | SAST, dependency audit, secret scanning, DAST on staging, annual pentest, red-team prompt suite | CI + external |
| Performance | Load tests at each scaling stage targets (9.16), soak tests on workers | k6 |
| Chaos and DR | Provider outage simulation, queue loss, region failover drill quarterly | Runbooks |
| Compliance | Reserve reconciliation test cases, regulator bundle validation, retention purge verification | Scheduled jobs + audits |

### 17.6 Disaster recovery and business continuity

- Backups: continuous WAL archiving (PostgreSQL) with point-in-time recovery; object store versioning; daily encrypted snapshots to a second region; restore tested monthly.
- Targets: RPO 5 minutes, RTO 1 hour (Commercial); RPO near-zero, RTO 15 minutes (Enterprise) with active-passive failover.
- Money safety during incidents: read-only mode pauses money movement and agents while preserving quotes and statements; reserve positions are recomputed from the ledger after recovery and any discrepancy blocks resumption until reconciled.
- Business continuity: manual verification path (as built ADMIN_MAKER_CHECKER confirmation) keeps corridors operating when devices or processors are down; agents degrade to templates (as built content-agent fallback) when model providers are unavailable; documented on-call rotation and communication plan.

### 17.7 Production readiness review

Before each phase exit, the review checks:

1. Go-live checklist green (as built) including agents, queues, providers, data pipelines.
2. All tests and evals green; no open critical or high security findings.
3. SLOs and alerting in place with a tested loud-alert path.
4. Runbooks for the top ten incident classes, including agent misbehaviour and model outage.
5. Policies published for every live agent; forbidden tools verified by an automated test that attempts each and expects denial.
6. Budgets and kill switches tested in staging.
7. Compliance sign-off: reserve attestation, KYC/AML coverage, data protection register, regulator bundle generation.
8. Commercial readiness: fee schedules approved, plans published, billing reconciled to the ledger.
9. Support readiness: knowledge base current, Customer Support Agent evals passing, escalation paths staffed.
10. Rollback rehearsed.

---

### Closing note

Everything above is buildable with the platform as it stands and the tooling named. The as-built core supplies the hard parts that most "agent fintech" plans hand-wave: a real ledger, real reserve control, real evidence, real approvals. The BitriPay OS adds governed agents around them and a commercial engine on top. Build the tool gateway and the policy engine first; every agent after that is configuration, evaluation and prompt work rather than new risk.
