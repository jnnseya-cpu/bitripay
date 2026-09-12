## 4. AI command centres

A command centre is not a chat window. It is a **scoped runtime**: a fixed roster of agents, a data scope, an action scope, a budget and an audit stream, rendered on the surface appropriate to the user (voice and sound for a trader, a console for a developer). All command centres share one implementation (section 9.4) and differ only in roster and scope. The pattern is the one Microsoft uses for Copilot (one orchestrator, per-app plugins and permissions) and Salesforce uses for Agentforce (topics, actions, guardrails).

### 4.1 The seven personal agents (every command centre)

| Agent | Sees | Can recommend | Can execute (within the user's own permissions and after the same approvals a human needs) |
|---|---|---|---|
| **Chief of Staff** | The user's calendar of obligations (settlements, bills, agent rebalancing, licence expiries), open items, unread alerts | Priorities for the day, what to do first, what can wait | Schedule reminders, prepare drafts, open tickets, queue actions for one-tap approval |
| **Analyst** | The user's ledger, statements, sales, float, fees, FX | Trends, anomalies, forecasts (next-week float, expected settlements), fee savings | Generate statements and reports; export CSV/PDF |
| **Research** | Public data the platform indexes: corridor prices, operator outages, competitor fees, blog performance | Where money is cheaper to send this week, which corridor is degraded, what customers ask about | Save research to the knowledge base |
| **Automation** | Workflow definitions the user has enabled | Rules to automate ("cash out when float exceeds X", "resend failed link after 1h") | Run enabled workflows; never a payment without the user's approval unless a pre-approved rule with limits exists |
| **Growth** | Sales, customers, retention, conversion of payment links | Which customers are lapsing, which products to push, price points, campaign copy | Send campaigns through connected channels within consent rules |
| **Security** | Sign-ins, devices, risk events on the user's account, unusual counterparties | Freeze suggestions, device revocations, "this looks like a scam" | Freeze the user's own account or card; revoke a device; block a counterparty |
| **Knowledge** | The user's documents, past conversations, FAQs, policies | Answers with citations; onboarding steps; where a feature is | Store notes, retrieve context for the other agents |

### 4.2 Command centres by user type

**Personal Money Centre (customer).** Surface: mobile and web app, voice in six languages, large text, sound cues. Data: own wallets, transactions, recipients, cards, statements. Typical automations: "tell me when my sister's money arrives", "cash out every Friday", "warn me before a fee above X". Executes only own-account actions; every payment still requires biometrics or PIN. Escalates scams and freezes to human support.

**Merchant Growth Centre.** Surface: web dashboard, POS phone, WhatsApp. Data: sales, settlements, payment links, disputes, webhooks. Agents add: dispute evidence assembly (order, delivery, messages), settlement forecasting, product-level analytics, campaign drafting, chargeback risk scoring before shipping. Executes: refunds within a per-day cap, campaign sends with consent, webhook replays. Escalates: disputes above a threshold, refund cap breaches.

**Agent Operations Centre.** Surface: agent app, payout device telemetry, SMS fallback. Data: float, cash-in/out history, payout queue, device status, commission. Agents add: float forecasting per weekday, rebalancing suggestions with the nearest master agent, queue prioritisation, evidence quality checks, fraud pattern alerts (same recipient repeated, unusual hours). Executes: prefund requests, queue claims, releases. Never: settlement of a payout (that is the verification engine's job).

**Network Centre (master agent / institution).** Data: pool balances, agents under the pool, aggregate payouts. Agents add: network liquidity planning, agent performance ranking, anomaly detection across agents. Executes: allocations within pool limits under step-up.

**Developer Centre.** Surface: console and CLI. Data: keys, webhooks, usage, error rates, sandbox state. Agents add: integration assistant that reads the developer's failing request and returns the fix, webhook debugger, SDK snippet generator, migration helper when API versions change. Executes: key rotation, webhook replays, sandbox resets.

**Partner Centre.** Data: corridor volumes, settlement statements, liquidity commitments, SLA metrics, disputes involving the partner. Agents add: settlement reconciliation against the partner's statement, SLA breach alerts, forecast of prefunding needs. Executes: statement acknowledgement, dispute responses.

**Admin Super Control Centre.** Section 14.

**Compliance Centre.** Data: KYC queue, sanctions hits, risk events, SAR drafts, reconciliation results, corridor licences. Agents add: document quality pre-check, adverse-media summarisation, alert triage with reasoning, SAR narrative drafting, licence-expiry tracking. Executes: nothing on a customer without a human decision; drafts and prioritises only.

**Treasury Centre.** Data: programmes, reserve movements, headroom, pools, floats, FX exposure. Agents add: reserve forecasting, prefunding recommendations per corridor, FX exposure alerts, reconciliation explanations. Executes: proposals only; every reserve or issuance action stays maker-checker (as built).

**Regulator Centre.** Read-only, time-boxed access to: safeguarding reconciliation history, event-chain verification, corridor and programme status, complaint statistics, aggregate transaction reporting in the regulator's schema. Agents add: natural-language querying over the permitted views with every answer citing the underlying record.

### 4.3 Guardrails common to every command centre

1. **Scope enforcement at the data layer.** Agents query through the same authenticated API the user's app uses; there is no privileged data path.
2. **Action allow-lists.** Each agent has an explicit tool list; anything not listed cannot be called. Financial actions carry the same authentication requirement as for humans (PIN/passkey step-up or maker-checker).
3. **Budgets.** Tokens, tool calls and money-moving actions per agent per day; exhaustion pauses the agent and notifies the user.
4. **Explanations.** Every recommendation includes the records it used; every action is logged to the event stream `agent` (new stream in the hash-chained event log).
5. **Kill switch.** A user can pause their command centre; an administrator can pause any agent class globally (AI Governance Agent, section 5.4).

---

## 5. Core AI agents

Each agent below is specified with purpose, inputs, outputs, permissions, triggers, workflow, escalation, APIs and business value. Agents are implemented as **agent definitions** (system prompt, tool allow-list, model, budget, schedule, escalation policy) executed by the orchestration layer (section 9.4) using the Anthropic SDK with structured outputs and tool use, the same pattern already used by the SEO content agent as built.

### 5.1 Onboarding Agent
- **Purpose:** take a new customer, merchant, agent or developer from sign-up to first successful transaction.
- **Inputs:** registration event, role, country, language, KYC status, device capabilities, first-session events.
- **Outputs:** next-best-step prompts, pre-filled forms, document-quality feedback ("photo is blurred, retake"), a first-transaction plan (e.g. print QR, test payment).
- **Permissions:** read own profile and KYC status; write onboarding checklist; send notifications; no money movement.
- **Triggers:** `user.registered`, `kyc.submitted`, `session.idle_in_onboarding`.
- **Workflow:** classify user intent → assemble checklist → guide step by step → detect drop-off → re-engage through the channel the user opened (push, SMS, WhatsApp).
- **Escalation:** three failed document uploads → human onboarding officer; suspected duplicate identity → Compliance.
- **APIs:** account, KYC, notifications, connectors (identity verification).
- **Value:** activation rate; measured as share of registrations with a transaction within seven days.

### 5.2 Compliance Agent
- **Purpose:** first-line triage of KYC, sanctions and monitoring alerts; drafting for humans.
- **Inputs:** KYC submissions, screening hits, risk events, transaction context, adverse media from connectors.
- **Outputs:** prioritised queue with reasoning, document pre-checks, SAR narrative drafts, licence-expiry alerts.
- **Permissions:** read compliance data; write drafts and priorities; **no decisions** on customers.
- **Triggers:** `kyc.submitted`, `risk.event`, `sanctions.hit`, daily licence sweep.
- **Escalation:** everything is escalated by design; the agent never closes an alert.
- **APIs:** KYC, risk, sanctions, corridors, events.
- **Value:** reviewer throughput and consistency; auditable reasoning per alert.

### 5.3 Risk Agent
- **Purpose:** real-time transaction and behaviour scoring beyond the static rules as built (velocity, cooling-off, sanctions).
- **Inputs:** transaction features, device fingerprint, behavioural biometrics summary (typing cadence, session patterns), counterparty graph, historical outcomes.
- **Outputs:** a score and reason codes per transaction; recommended action (allow, step-up, hold, block).
- **Permissions:** may **hold** (route to MANUAL_REVIEW, as built) and request step-up; may not release or settle.
- **Triggers:** synchronous on every payment intent and payout instruction.
- **Workflow:** feature assembly → rules (as built) → model score → policy table → action.
- **Escalation:** holds go to the verification console; model drift alerts go to the AI Governance Agent.
- **APIs:** risk, routing, payouts, device intelligence connector.
- **Value:** lower fraud losses and chargebacks with fewer false holds.

### 5.4 AI Governance Agent
- **Purpose:** enforce policy over every other agent.
- **Inputs:** agent definitions, run logs, budgets, evaluation results, policy documents.
- **Outputs:** policy violations, budget alerts, prompt-change reviews, model-change approvals, red-team findings.
- **Permissions:** pause any agent; block a tool; require human approval for an action class; cannot change money rules.
- **Triggers:** every agent run (sampled), every definition change, weekly evaluation.
- **Workflow:** static checks on definitions → sampled review of runs against policy → evaluation suite → report.
- **Value:** the platform can prove to regulators and customers that agents act within policy. Pattern: OpenAI and Anthropic usage policies with enterprise audit, plus ServiceNow's governance workflows.

### 5.5 Revenue Agent
- **Purpose:** find and act on revenue.
- **Inputs:** fee configuration, transaction mix, plan usage, churn signals, corridor margins, competitor prices (Research Agent).
- **Outputs:** pricing experiments, plan upgrade recommendations, fee anomalies, corridor margin proposals.
- **Permissions:** propose fee changes (maker) for human approval; run A/B experiments within configured bounds.
- **Triggers:** weekly; on plan usage threshold; on margin change.
- **Escalation:** any fee change → administrator with `settings` permission (checker).
- **Value:** revenue per user, take rate, margin per corridor.

### 5.6 Pricing Agent
- **Purpose:** dynamic pricing within policy: corridor margins by liquidity and competition, merchant plan tiers, AI credit pricing.
- **Inputs:** live rates and margins (as built), liquidity per corridor, competitor prices, elasticity estimates.
- **Outputs:** proposed margin/fees per corridor and segment with expected impact.
- **Permissions:** proposals only; applied under maker-checker with limits (max change per day).
- **Value:** margin without losing volume; the Uber surge and Amazon repricing pattern, bounded by policy.

### 5.7 Customer Support Agent
- **Purpose:** resolve first-line support in the user's language with the user's data.
- **Inputs:** ticket or chat, the user's transactions and route stages, knowledge base, policies.
- **Outputs:** answers with citations, transaction status explanations, refund or cancellation preparation.
- **Permissions:** read the user's data after the user is authenticated; create tickets; prepare refunds for merchant approval; cancel a transfer only if the user confirms with PIN.
- **Triggers:** chat message, ticket created, "where is my money" intent detected.
- **Escalation:** disputes, suspected fraud, complaints (regulatory timeline), anything the user asks to escalate.
- **Value:** resolution time; ticket deflection; consistent regulatory language on complaints.

### 5.8 Marketing Agent
- **Purpose:** the SEO content agent as built, extended to campaigns.
- **Inputs:** blog performance, keyword research, campaign results, consent lists, brand guidelines.
- **Outputs:** articles for review (as built), social packs (as built), campaign drafts, landing page variants, translations.
- **Permissions:** publish only when auto-publish is enabled; send campaigns only to consented lists within frequency caps.
- **Value:** organic acquisition cost; pattern: HubSpot content assistant with editorial review.

### 5.9 Data Intelligence Agent
- **Purpose:** turn the event stream into insight for every other agent and human.
- **Inputs:** ledger, events, page views, agent runs, connector telemetry.
- **Outputs:** metrics, forecasts, anomaly detections, knowledge-graph updates.
- **Permissions:** read everything at the aggregate layer; write derived tables only.
- **Value:** the shared brain; pattern: Databricks lakehouse with feature store.

### 5.10 Operations Agent
- **Purpose:** liquidity, reconciliation and payout operations.
- **Inputs:** float balances, payout queue, operator statements (parsed), reserve position, corridor demand.
- **Outputs:** prefunding proposals, rebalancing plans, reconciliation breaks with explanations, requeue suggestions.
- **Permissions:** propose prefunding (maker); requeue waiting payouts (as built action); cannot settle.
- **Value:** stranded float, failed payouts, reconciliation time.

### 5.11 Fraud Detection Agent
- **Purpose:** post-transaction pattern detection across accounts (rings, mules, collusion), complementing the real-time Risk Agent.
- **Inputs:** transaction graph, device graph, evidence mismatches, agent payout patterns (as built checks: recipient repetition, self-payout, abnormal patterns).
- **Outputs:** cases with linked entities and evidence.
- **Permissions:** open cases; recommend freezes; freezes executed by treasury under step-up (as built).
- **Value:** loss prevention; pattern: CrowdStrike-style graph detection applied to money movement.

### 5.12 Payment Agent
- **Purpose:** route each payment for success, cost and speed.
- **Inputs:** gateway health (as built), corridor liquidity, processor fees, historical success rates, recipient currency availability (as built).
- **Outputs:** routing decision with expected cost and time; retry strategy.
- **Permissions:** select among enabled gateways and payout accounts; cannot enable a gateway or bypass compliance gates.
- **Value:** authorisation rate, cost per transaction. Pattern: Stripe adaptive acceptance.

### 5.13 API Integration Agent
- **Purpose:** help developers integrate and keep integrations healthy.
- **Inputs:** API logs for the developer's keys, webhook delivery results, SDK versions, docs.
- **Outputs:** diagnosis of failing calls, code fixes, webhook replays, deprecation notices.
- **Permissions:** read the developer's own logs; replay their webhooks; rotate their keys on request.
- **Value:** time to first successful call; support load.

### 5.14 Workflow Automation Agent
- **Purpose:** run user- and admin-defined workflows (triggers → conditions → actions) with limits.
- **Inputs:** workflow definitions, events.
- **Outputs:** executions with logs.
- **Permissions:** only actions granted to the workflow's owner; money actions require a pre-approved rule with caps or per-run approval.
- **Value:** operations automation; pattern: Zapier/Workato with enterprise guardrails.

### 5.15 Predictive Growth Agent
- **Purpose:** forecast volumes, revenue, churn and liquidity; feed Growth, Treasury and Operations.
- **Inputs:** historical series, seasonality (market days, salary days, holidays), campaigns, corridor events.
- **Outputs:** forecasts with intervals, drivers, recommended actions.
- **Value:** planning accuracy; pattern: demand forecasting as used by Uber and Amazon.

### 5.16 Admin Control Agent
- **Purpose:** the administrator's Chief of Staff over the whole platform.
- **Inputs:** every console as built (verification, corridors, liquidity, e-money, go-live, gateways, SEO), incidents, agent reports.
- **Outputs:** the daily brief, prioritised approvals, anomalies, a "what changed" log.
- **Permissions:** navigation and preparation only; every execution passes through the human's own permission and step-up.

### 5.17 Enterprise agent ecosystem (workforce)

The categories requested map onto the agents above and a small number of additional definitions. Executive agents are **views** over the workforce rather than separate reasoning entities, which avoids duplicated context and cost:

| Category | Agents | Implemented as |
|---|---|---|
| Executive | CEO, COO, CFO, CTO, CMO, CRO | Briefing agents that compose the outputs of the functional agents into a role-specific daily brief and decision queue |
| Product | Product Architect, UX, Journey, Feature | Read analytics and support themes; produce specs and journey maps as documents for human product managers |
| Engineering | Frontend, Backend, Infrastructure, API, Database | Coding agents operating in isolated branches with tests, opening pull requests only (pattern: Claude Code / GitHub Copilot agent); never deploy directly |
| Quality | QA, Testing, Performance | Generate and run tests, load tests in staging, report regressions |
| Cybersecurity | Threat Hunter, SOC, Fraud, Vulnerability, Identity | Section 13; SOC and Threat Hunter read telemetry, Vulnerability reads dependency and scan reports, Identity reviews access |
| Revenue | Sales, Pricing, Monetisation | Sales drafts outreach and proposals; Pricing (5.6); Monetisation runs plan and credit analysis |
| Customer | Support, Success, Retention | Support (5.7); Success watches activation and health; Retention acts on churn predictions |
| Compliance | GDPR, AML, KYC, Regulatory | Specialisations of the Compliance Agent with separate prompts and data scopes |

### 5.18 Self-managing platform layer

| Agent | Watches | Acts | Limits |
|---|---|---|---|
| System Health | Uptime, latency percentiles, error rates, queue depths, job lag, reconciliation status | Opens incidents, pages on-call, scales services within autoscaling policy | Cannot change money rules or data |
| Bug Detection | Error clusters, failing tests, regressions between releases, user-reported defects | Creates issues with reproduction, assigns to Engineering agents | Human triage before code change |
| Auto-Repair | Known-pattern incidents (stuck job, exhausted connection pool, expired certificate, disk full) | Executes runbooks: restart, rotate, clear, redeploy last known good | Every runbook is a signed, reviewed script; anything outside runbooks escalates |
| Infrastructure Optimisation | Compute, storage, bandwidth, cloud spend, cache hit rates | Proposes right-sizing; applies within pre-approved envelopes | Financial cap per change; rollback on error-rate increase |
| Release Management | Pull requests, test results, canary metrics | Progressive delivery: canary → 10% → 50% → 100% with automatic rollback | Money-path changes require two human approvals |
| AI Governance | Section 5.4 | | |

Pattern references: Google SRE (SLOs, error budgets, runbooks), Netflix (canaries, chaos), Tesla/SpaceX (telemetry-driven iteration), CrowdStrike (agent telemetry + graph).
