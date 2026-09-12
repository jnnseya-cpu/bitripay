## 9. Production-grade architecture

### 9.1 Principles

1. **Control plane / data plane separation.** The ledger, e-money engine and route lifecycle are the data plane and never call a model. Agents live in the control plane and reach the data plane only through the same typed service functions and permissions a human operator uses. (Stripe, Goldman Sachs Marquee, Aladdin.)
2. **Every side-effect is a tool with a schema.** No agent runs SQL or shell against production. Tools are typed functions with input schemas, permission tags, rate limits and audit hooks. (Anthropic tool use, OpenAI function calling, Microsoft Copilot Studio actions.)
3. **Deterministic core, probabilistic edge.** Money movement, balance assertions, issuance headroom and evidence verification remain deterministic code with tests. Models classify, summarise, draft, rank and recommend. (Tesla Autopilot's rule-based safety envelope around learned policies; Palantir's ontology-backed actions.)
4. **Event-sourced truth.** The hash-chained `event_log` (as built) plus the ledger are the source for every read model, memory and analytic. Nothing an agent believes can contradict what the ledger says; if it does, the ledger wins and the discrepancy becomes a finding.
5. **Progressive infrastructure.** The system runs today on one process with SQLite. The architecture below scales by replacing adapters (SQLite → PostgreSQL, in-memory limiter → Redis, in-process jobs → queue workers) without changing service code. Each replacement is a milestone in section 15, not a rewrite.

### 9.2 System architecture

```
┌────────────────────────── Edge (Cloudflare) ───────────────────────────┐
│ WAF · bot management · rate limiting · TLS · caching of /blog, /legal  │
└───────────────┬────────────────────────────────┬───────────────────────┘
                │                                │
     ┌──────────▼───────────┐          ┌─────────▼──────────┐
     │ Web (React/Vite) SSR │          │ Mobile (Expo)      │  Payout device (Expo)
     │ web + admin + site   │          │ customer/merchant/ │  SMS forwarder (Android)
     └──────────┬───────────┘          │ agent              │
                │                      └─────────┬──────────┘
                └──────────────┬─────────────────┘
                     ┌─────────▼──────────┐
                     │ API gateway layer  │  auth · idempotency · rate limits · versioning
                     │ (Express 5, as     │  request signing · OpenAPI · SDK generation
                     │  built)            │
                     └────┬─────────┬─────┘
          ┌───────────────┘         └────────────────┐
┌─────────▼──────────┐                     ┌─────────▼──────────┐
│ Domain services    │                     │ AI orchestration   │
│ ledger · emoney    │◄── typed tools ─────│ agent runtime      │
│ routing · rails    │                     │ policy engine      │
│ evidence · fx      │                     │ memory · vectors   │
│ gateway · kyc      │                     │ budget · audit     │
│ notifications      │                     └─────────┬──────────┘
└─────────┬──────────┘                               │
          │  events (outbox)                         │ model calls
┌─────────▼──────────────────────────────────────────▼──────────┐
│ Event bus + workflow engine (jobs.ts today → queue workers)    │
│ reconciliation · lifecycle timers · webhooks · schedules       │
└─────────┬──────────────────────────────────────────┬──────────┘
          │                                          │
┌─────────▼──────────┐   ┌──────────────┐   ┌────────▼──────────┐
│ OLTP database      │   │ Object store │   │ Data platform     │
│ SQLite → Postgres  │   │ KYC, PDFs,   │   │ lake · warehouse  │
│ ledger, routes,    │   │ evidence     │   │ vector · graph    │
│ agents, audit      │   └──────────────┘   │ streaming         │
└────────────────────┘                      └───────────────────┘
```

### 9.3 Frontend architecture

| Surface | As built | AI-OS extension |
|---|---|---|
| Customer web (`apps/web`) | React 19, Vite, SSR-rendered marketing/blog/legal pages, cinematic landing, statements, currency-consent flow | Command Centre route (`/assist`) with streaming chat, task cards, approvals inbox, voice input (Web Speech API with server fallback), "explain this" on every transaction |
| Admin (`apps/admin`) | Treasury, e-money, corridors, users, SEO, approvals, loud alerts | Super Control Centre (section 14): agent registry, policy editor, budget dashboards, incident room, model routing, kill switches |
| Mobile (`apps/mobile`) | Expo SDK 53, passkeys/biometrics, loud alerts, statements | Voice-first assistant, offline task queue, USSD-style fallback menus for low-end devices |
| Payout device / SMS forwarder | Signed evidence capture, alarm on queue | Device health telemetry to System Health Agent, remote config |
| Developer Centre | Merchant gateway settings | Interactive docs (OpenAPI-driven), sandbox event simulator, SDK downloads, usage graphs |

Shared conventions: design tokens in `landing.css` extend to a full token set; every AI-generated element is labelled ("Drafted by Analyst Agent · review before use"); every action an agent proposes renders as an approval card with the exact tool call it will make, mirroring the transparency of Claude Code's tool-use display.

### 9.4 Backend architecture

- **Runtime**: Node 20+, TypeScript, Express 5 (as built). Services are plain functions taking a `db` handle and typed inputs; routes are thin. This is preserved because it is what makes tool exposure trivial: each service function that is safe for agents is registered as a tool with a Zod schema.
- **Modules** (as built directories) become bounded contexts with explicit public interfaces: `ledger`, `emoney`, `routing`, `rails`, `evidence`, `fx`, `gateway`, `identity`, `kyc`, `support`, `content`, `notifications`, `admin`, plus new `agents`, `policy`, `memory`, `billing`, `intelligence`.
- **Transactional outbox**: every state change that must emit an event writes the event in the same SQL transaction as the change (`event_log` as built) and a dispatcher publishes it to the bus. This guarantees at-least-once delivery without dual writes. (Pattern used by Uber, Airbnb and Stripe's internal event systems.)
- **Idempotency**: `Idempotency-Key` middleware (as built) stores request hash and response; agents are required to supply keys derived from `run_id + step_id` so retries never double-execute.
- **Workers**: `jobs.ts` timers become named queues (BullMQ on Redis at Beta, SQS/Cloud Tasks at Enterprise): `lifecycle`, `reconciliation`, `webhooks`, `notifications`, `agents`, `intelligence`, `content`. Each queue has its own concurrency, retry policy and dead-letter handling.

### 9.5 Authentication and RBAC

| Layer | As built | Extension |
|---|---|---|
| Customer auth | Password + OTP, TOTP, passkeys/WebAuthn, biometric approval for routes, step-up for risky actions | Session risk scoring (device, geo, velocity) feeding step-up decisions; passkey required for any agent-delegated payment above a per-user limit |
| Merchant/API auth | API keys (test/live), webhook secrets, HMAC signatures | OAuth 2.1 client credentials for platforms; scoped keys (`payments:write`, `payouts:read`); key rotation with overlap windows |
| Admin auth | Roles with permission lists (`users`, `kyc`, `transactions`, `treasury`, `issuance`, `approvals`, `gateways`, `settings`, `cms`, `catalogs`, `reports`, `support`, `admins`), super admin, maker-checker | New permissions `agents`, `policies`, `models`, `intelligence`, `billing`, `security`; SSO (OIDC/SAML) for staff; hardware-key enforcement for `treasury` and `agents` |
| Agent identity | — | Every agent is a principal with its own id, permission set (a strict subset of its owner's), budget and key material; every tool call carries `actor = {type:'agent', id, run_id, on_behalf_of}` and is stored in `audit_logs` and `agent_actions` |

Authorisation is evaluated in one place (`hasPermission` today; a policy engine tomorrow, OPA/Cedar-style, with the same function signature) for humans and agents alike. Agent permissions can never exceed the permissions of the user or admin who owns the agent; the intersection is computed at run start and frozen for the run.

### 9.6 AI orchestration layer

Modelled on Anthropic's tool-use loop and Managed Agents, OpenAI's Agents pattern and Microsoft's Copilot Studio orchestration; implemented in-house so no run can leave the policy boundary.

**Components**

| Component | Responsibility |
|---|---|
| Agent registry | Declares each agent: name, owner type, system prompt version, tools, permissions, budget policy, escalation policy, model routing, evaluation suite |
| Run controller | Starts a run from a trigger, builds context (identity, memory, retrieved documents, relevant records), executes the tool loop with the provider SDK (`@anthropic-ai/sdk` as built with streaming, adaptive thinking, structured output), enforces step and token budgets, persists every step |
| Tool gateway | The only path from a model to a side-effect. Validates input against the tool schema, checks permission and policy, applies rate limits, executes the service function, redacts the result according to the agent's data scope, records the call |
| Policy engine | Declarative rules: which tools an agent may call, under which conditions, what needs approval, what is forbidden outright (mint, unfreeze, corridor status change, key issuance are always human-only) |
| Approval service | Creates approval requests (the existing maker-checker table extended with `agent_run_id`), routes to the right human, resumes the run on decision, expires stale requests |
| Model router | Chooses model per task class and budget (e.g. `claude-opus-5` for drafting and reasoning, `claude-sonnet-5` for classification at volume, `claude-haiku-4-5` for extraction), with provider failover and a hard monthly cap per tenant |
| Evaluation harness | Golden datasets per agent (classification accuracy, draft quality rubric, tool-call correctness); runs on every prompt or model change; blocks promotion below threshold. (Anthropic evals, OpenAI evals, Databricks MLflow.) |
| Observability | Every run emits traces (OpenTelemetry) with spans per model call and tool call, token usage, cost, latency, outcome; dashboards per agent and per tenant |

**Run lifecycle**: `queued → context_built → running → (awaiting_approval ↔ running)* → completed | failed | cancelled | budget_exhausted`. Every transition is an event. Runs are resumable from their last persisted step, so an approval that takes a day does not hold a process open.

**Prompt management**: prompts are versioned records (`agent_prompts`) with author, change log and eval score; promotion from draft to live is maker-checker. The system prompt always contains: the agent's charter, the data scope, the list of forbidden actions, the output schema, and the current policy summary. Cache control marks the stable prefix (as built pattern).

### 9.7 Agent memory

Three memory tiers, each with an owner, a retention rule and a deletion path (GDPR):

| Tier | Storage | Contents | Retention |
|---|---|---|---|
| Working memory | Run record (`agent_runs.steps`) | Tool calls, results, intermediate reasoning summaries for the current run | Life of run + 90 days for audit |
| Episodic memory | `agent_memories` table + vector index | Per-user summaries of past interactions ("prefers WhatsApp receipts", "asked twice about FX margin"), outcome of past recommendations | Until user deletes or account closes; 24 months by default |
| Semantic memory | Knowledge base (`kb_documents`, chunks, embeddings) | Policies, product docs, runbooks, regulatory texts per corridor, FAQ, resolved tickets | Versioned; superseded versions archived |

Memory writes go through the tool gateway like any other side-effect; memory reads are scoped to the requesting principal. Nothing in memory is authoritative about money; balances and statuses are always read live from the ledger.

### 9.8 Vector database and retrieval

- **MVP/Beta**: `sqlite-vec` or `pgvector` inside the OLTP database; embeddings from the model provider (Anthropic-compatible embedding provider or Cohere/OpenAI via connector). Chunking is document-aware (headings, tables kept intact).
- **Enterprise**: dedicated vector store (pgvector on a separate PostgreSQL, or a managed store) with per-tenant namespaces, hybrid search (BM25 + vectors), reranking.
- **Collections**: `kb` (public and internal docs), `tickets` (resolved conversations, PII-redacted), `transactions_semantic` (natural-language descriptions of transaction patterns, no amounts), `regulations` (per-corridor rules), `code` (repo docs and ADRs for engineering agents).
- **Access control** is enforced at query time by filtering on tenant and permission tags, never by prompt instruction alone.

### 9.9 Event-driven workflows

The bus carries domain events already produced by the platform (`route.stage_changed`, `payment.captured`, `settlement.posted`, `reserve.movement`, `reconciliation.completed`, `kyc.submitted`, `ticket.created`, `gateway.payment.*`, `blog.published`, and so on) plus agent events (`agent.run.*`, `agent.action.*`, `approval.*`).

Workflow definitions are declarative (`workflows` table): trigger event(s), filter, steps (tool calls or agent tasks), compensation steps, SLA, owner. Examples:

- `payout_stuck`: on `route.stage_changed` to `PAYOUT_SENT` start a timer; if no `EVIDENCE_RECEIVED` within the corridor's expected window, Operations Agent investigates and either re-queues, opens a ticket, or escalates.
- `reserve_warning`: on `reconciliation.completed` with status `warning`, Risk Agent computes headroom forecast and drafts the funding request for treasury.
- `merchant_first_payment`: on first `gateway.payment.captured` for a merchant, Growth Agent sends the onboarding series and schedules a day-7 check-in.

The engine is idempotent per (event id, workflow id, step id) and exposes retries, dead letters and manual replay in the admin.

### 9.10 API gateway layer

- Versioning by path (`/api` today → `/v1` alias with a deprecation policy of 12 months per version).
- Per-key rate limits and quotas stored with the key; limiter backed by Redis at Beta (the as-built in-memory limiter remains for single-node).
- Request signing for platform partners (HMAC over method, path, timestamp, body hash) in addition to bearer keys.
- OpenAPI 3.1 generated from Zod schemas; SDKs generated for JavaScript, PHP (WooCommerce plugin as built) and Python.
- Sandbox routing by key prefix (as built `test`/`live` keys) with a full simulator for webhooks, evidence and settlement.

### 9.11 Webhook engine

As built: signed deliveries (`X-BitriPay-Signature`, `X-BitriPay-Event`, `X-BitriPay-Delivery-Id`), retry schedule, delivery log, secret rotation. Extensions: per-endpoint event subscriptions, exponential backoff with jitter up to 72 hours, manual replay, endpoint health scoring, automatic disable after sustained failure with merchant notification, and an event catalogue served from the Developer Centre.

### 9.12 Notification engine

As built: in-app, push with loud channel, email; per-user loud preference. Extensions: WhatsApp and SMS channels via connectors, template registry with per-language variants, quiet hours that never suppress money-critical alerts, delivery analytics, and an agent-usable `notify` tool constrained to approved templates (agents cannot compose arbitrary outbound messages to customers without a template or an approval).

### 9.13 Audit log and evidence of control

As built: `audit_logs` for admin actions and the hash-chained `event_log`. Extensions: agent actions written to the same chain with `actor_type='agent'`; daily chain-head anchoring to an external timestamping service; regulator export bundles (issuance, reserves, reconciliations, approvals, agent actions on regulated objects) generated by the Compliance Agent and signed.

### 9.14 Security architecture summary

Zero-trust between services (mTLS at Enterprise), secrets in a manager (never in settings tables except encrypted with the platform key as built), field-level encryption for PII, signed evidence devices (as built), signed webhooks, prompt-injection defences at the tool gateway (tool results are data, never instructions; untrusted text is wrapped and labelled), and model-output validation against schemas before any tool executes. Full treatment in section 13.

### 9.15 Observability, monitoring and error handling

| Concern | Implementation |
|---|---|
| Logs | Structured JSON, correlation id per request and per agent run, PII redaction at the logger |
| Metrics | RED metrics per route and per tool; business metrics (route stage durations, reserve headroom, evidence match rate, agent approval rate, token spend) |
| Traces | OpenTelemetry across API, workers, model calls and tool calls |
| Alerts | SLO-based (availability, p95 latency, lifecycle SLA breaches, reserve status, agent error rate), loud-alert channel for money-critical events (as built) |
| Error handling | `AppError(status, code, message, details)` (as built) is the single error type; agents receive the same codes and are trained on them; unknown errors become incidents for the Bug Detection Agent |
| Health | `/health` deep checks (DB, queue, providers), go-live checklist (as built) extended with agent and model health |

### 9.16 Scalability

| Stage | Compute | Database | Queue | Cache | Target |
|---|---|---|---|---|---|
| MVP (as built) | 1 API process + web/admin static, systemd or Docker | SQLite (WAL) | in-process timers | in-memory | 10k users, 50 tx/s bursts |
| Beta | 2–4 API replicas behind Cloudflare, worker processes | PostgreSQL (managed), pgvector | Redis + BullMQ | Redis | 100k users, 200 tx/s |
| Commercial | Autoscaled containers (ECS/Cloud Run/Kubernetes), regional | PostgreSQL with read replicas, partitioned ledger tables by month | Redis Streams or SQS | Redis cluster | 1M users, 1k tx/s |
| Enterprise / Global | Multi-region active-passive, per-tenant isolation options | Regional PostgreSQL clusters, warehouse offload | Kafka-class streaming | Global edge cache | 10M+ users, 5k tx/s, 99.95% |

Ledger writes stay single-writer per currency wallet (serialisable transactions with balance assertions as built); throughput scales by sharding on user id at Enterprise only if measurement requires it.

---

## 10. Database schema

### 10.1 As-built schema (preserved)

Migrations 001–010 define 70 tables. The core groups:

| Group | Tables |
|---|---|
| Identity | `users`, `webauthn_credentials`, `webauthn_challenges`, `otp_codes`, `push_tokens`, `api_keys`, `kyc_submissions` |
| Money | `wallets`, `transactions`, `ledger_entries`, `settlements`, `fx_quotes`, `rate_snapshots`, `currencies`, `idempotency_keys` |
| E-money | `emoney_programmes`, `reserve_movements`, `distribution_pools`, `reserve_reconciliations`, `promo_credits`, `statements` |
| Routing and rails | `money_routes`, `corridors`, `payout_accounts`, `payout_instructions`, `liquidity_movements`, `momo_operators`, `operator_parse_templates`, `evidence_devices`, `evidence_nonces`, `payment_evidence`, `manual_verifications` |
| Gateway and commerce | `gateways`, `gateway_payments`, `payment_requests`, `saved_cards`, `virtual_cards`, `bank_accounts`, `chargebacks`, `webhook_deliveries` |
| Services | `billers`, `bill_payments`, `topup_operators`, `mobile_topups`, `gift_card_products`, `gift_cards`, `remittances`, `saved_recipients`, `cash_requests`, `referral_rewards`, `p2p_ads`, `p2p_trades`, `p2p_offers`, `p2p_messages` |
| Risk and compliance | `sanctions_entries`, `risk_events`, `audit_logs`, `event_log` |
| Support and content | `support_tickets`, `support_messages`, `chat_messages`, `notifications`, `blog_posts`, `seo_link_rules`, `seo_backlinks`, `seo_runs`, `seo_pageviews`, `settings` |

### 10.2 New tables (migration 011 onward)

All new tables carry `id TEXT PRIMARY KEY` (prefixed ULIDs as built: `agt_`, `run_`, `act_`, `pol_`…), `created_at`, `updated_at`, and where relevant `tenant_id` (organisation) and `deleted_at` for soft delete. Amounts are integers in minor units with a `currency` column, as in the ledger.

**Agents and orchestration**

| Table | Key fields | Relationships / indexes |
|---|---|---|
| `agents` | `key` (unique, e.g. `compliance`), `name`, `owner_type` (system/user/merchant/agent/partner/admin), `charter`, `tools` (JSON list), `permissions` (JSON), `model_policy` (JSON), `budget_policy` (JSON), `escalation_policy` (JSON), `status` (draft/live/paused), `version` | idx `owner_type,status` |
| `agent_prompts` | `agent_id`, `version`, `system_prompt`, `output_schema` (JSON), `eval_score`, `status` (draft/live/retired), `author_admin_id`, `approved_by_admin_id` | unique `agent_id,version` |
| `agent_instances` | `agent_id`, `principal_type`, `principal_id` (the user/merchant/admin who owns this instance), `settings` (JSON), `enabled`, `budget_acu_month`, `budget_used_acu` | unique `agent_id,principal_type,principal_id` |
| `agent_runs` | `instance_id`, `trigger_type` (event/schedule/user/agent), `trigger_ref`, `status`, `input` (JSON), `output` (JSON), `steps` (JSON, append-only), `model`, `tokens_in`, `tokens_out`, `cost_micros`, `acu_used`, `started_at`, `finished_at`, `error_code` | idx `instance_id,started_at`; idx `status` |
| `agent_actions` | `run_id`, `step_no`, `tool`, `input` (JSON, redacted), `result_summary`, `permission_used`, `approval_id`, `object_type`, `object_id`, `outcome` (executed/denied/awaiting/failed), `latency_ms` | idx `run_id,step_no`; idx `object_type,object_id`; written to `event_log` |
| `approvals` (extends as-built maker-checker requests) | `subject`, `object_id`, `requested_by_type` (admin/agent), `requested_by_id`, `run_id`, `payload` (JSON), `status`, `decided_by_admin_id`, `decided_at`, `reason`, `expires_at` | idx `status,expires_at` |
| `policies` | `scope` (global/tenant/agent), `scope_id`, `rules` (JSON: allow/deny/require_approval per tool with conditions), `version`, `status`, `author_admin_id`, `approved_by_admin_id` | unique `scope,scope_id,version` |
| `workflows` | `key`, `trigger_events` (JSON), `filter` (JSON), `steps` (JSON), `compensation` (JSON), `sla_minutes`, `owner_agent_id`, `status` | idx `status` |
| `workflow_runs` | `workflow_id`, `event_id`, `status`, `current_step`, `context` (JSON), `attempts`, `next_attempt_at`, `error` | unique `workflow_id,event_id`; idx `status,next_attempt_at` |
| `agent_memories` | `principal_type`, `principal_id`, `kind` (preference/fact/outcome), `content`, `embedding_id`, `source_run_id`, `expires_at` | idx `principal_type,principal_id,kind` |
| `kb_documents` / `kb_chunks` | document: `collection`, `title`, `source`, `version`, `acl` (JSON), `hash`; chunk: `document_id`, `ordinal`, `text`, `embedding` (vector), `tokens` | vector index on `kb_chunks.embedding`; idx `collection` |
| `model_usage` | `tenant_id`, `principal_type`, `principal_id`, `agent_id`, `model`, `day`, `tokens_in`, `tokens_out`, `cached_tokens`, `cost_micros`, `acu` | unique `tenant_id,principal_type,principal_id,agent_id,model,day` |

**Organisations, billing and monetisation**

| Table | Key fields | Relationships / indexes |
|---|---|---|
| `organisations` | `name`, `type` (merchant/partner/licensee/enterprise), `owner_user_id`, `kyb_status`, `plan_id`, `settings` (JSON) | idx `type,kyb_status` |
| `organisation_members` | `organisation_id`, `user_id`, `role`, `permissions` (JSON) | unique `organisation_id,user_id` |
| `plans` | `key` (free/starter/growth/scale/enterprise), `prices` (JSON per currency), `limits` (JSON: acu, api calls, agents, seats), `features` (JSON) | — |
| `subscriptions` | `principal_type`, `principal_id`, `plan_id`, `status`, `period_start`, `period_end`, `payment_method` (wallet/card/invoice), `wallet_currency` | idx `status,period_end` |
| `usage_records` | `subscription_id`, `metric` (acu/api_call/webhook/statement/report/seat), `quantity`, `period`, `source_ref` | idx `subscription_id,period,metric` |
| `invoices` / `invoice_lines` | `subscription_id`, `amount`, `currency`, `status`, `due_at`, `transaction_id` (ledger posting) | idx `status,due_at` |
| `fee_schedules` | `scope` (global/corridor/organisation), `scope_id`, `rules` (JSON: percentage bps, fixed minor units, caps, tiers per product), `effective_from`, `status`, `approved_by_admin_id` | unique `scope,scope_id,effective_from` |
| `commission_splits` | `gateway_payment_id` or `transaction_id`, `party_type`, `party_id`, `amount`, `currency`, `settlement_id` | idx `party_type,party_id` |
| `marketplace_listings` / `marketplace_installs` | listing: `publisher_org_id`, `type` (agent/workflow/connector/template), `pricing` (JSON), `review_status`; install: `listing_id`, `principal_type`, `principal_id`, `status` | idx `type,review_status` |

**Security and intelligence**

| Table | Key fields | Relationships / indexes |
|---|---|---|
| `sessions` | `user_id`, `device_fingerprint`, `ip`, `geo`, `risk_score`, `last_seen_at`, `revoked_at` | idx `user_id,revoked_at` |
| `security_events` | `kind` (login_failed, key_leak_detected, anomaly, waf_block…), `severity`, `principal_type`, `principal_id`, `details` (JSON), `handled_by_run_id` | idx `kind,severity,created_at` |
| `incidents` | `title`, `severity`, `status`, `detected_by` (agent/admin/alert), `timeline` (JSON), `postmortem` | idx `status,severity` |
| `features_daily` | `principal_type`, `principal_id`, `day`, `features` (JSON: volumes, counts, ratios used by risk and growth models) | unique `principal_type,principal_id,day` |
| `recommendations` | `principal_type`, `principal_id`, `kind`, `payload` (JSON), `score`, `agent_run_id`, `shown_at`, `acted_at`, `outcome` | idx `principal_type,principal_id,kind` |
| `experiments` / `experiment_assignments` | experiment: `key`, `hypothesis`, `variants` (JSON), `metric`, `status`; assignment: `experiment_id`, `principal_id`, `variant` | unique `experiment_id,principal_id` |

### 10.3 Entity relationship summary (ERD)

```
users 1─∞ wallets 1─∞ ledger_entries ∞─1 transactions
users 1─∞ money_routes ∞─1 corridors 1─∞ payout_accounts
money_routes 1─∞ payout_instructions 1─∞ payment_evidence ∞─1 evidence_devices
emoney_programmes 1─∞ reserve_movements ; emoney_programmes 1─∞ distribution_pools ; emoney_programmes 1─∞ reserve_reconciliations
users 1─∞ api_keys 1─∞ gateway_payments 1─∞ webhook_deliveries ; gateway_payments 1─∞ commission_splits
organisations 1─∞ organisation_members ∞─1 users ; organisations 1─1 subscriptions ∞─1 plans ; subscriptions 1─∞ usage_records ; subscriptions 1─∞ invoices
agents 1─∞ agent_prompts ; agents 1─∞ agent_instances ∞─1 (users|organisations|admins)
agent_instances 1─∞ agent_runs 1─∞ agent_actions ∞─0..1 approvals
policies (scope) ─ agents ; workflows 1─∞ workflow_runs ∞─1 event_log
kb_documents 1─∞ kb_chunks ; agent_memories ∞─1 (users|organisations)
users 1─∞ sessions ; security_events ∞─0..1 agent_runs ; incidents ∞─∞ security_events
event_log (hash chain) ← every table above via outbox
```

### 10.4 Permissions and audit at the schema level

- Row-level scope: every query from the tool gateway is wrapped with the principal's scope predicate (`user_id = ?`, `organisation_id IN (?)`, or admin permission). At PostgreSQL this becomes row-level security policies keyed on a session variable set per request.
- Append-only tables: `ledger_entries`, `event_log`, `agent_actions`, `audit_logs`, `reserve_movements`, `statements`. Database roles deny `UPDATE`/`DELETE` on them; corrections are compensating entries.
- Encryption: columns `kyc_submissions.document_*`, `users.phone`, `users.email`, `agent_memories.content` (when containing PII), `settings.value` for secrets — encrypted with the platform key (as built helper in `lib/crypto.ts`) and, at Enterprise, envelope-encrypted with a KMS.
- Retention: a `retention_policies` record per table drives scheduled purge or anonymisation, with the Compliance Agent producing the monthly retention report.

---

## 11. API specification

### 11.1 Conventions

- Base URL: `https://api.bitripay.com/v1` (alias of the as-built `/api`); sandbox is selected by the key prefix, not by host.
- Authentication: `Authorization: Bearer <api_key>` for merchants and platforms; `Authorization: Bearer <jwt>` for first-party apps; agent tokens are internal only and never accepted at the public edge.
- Idempotency: `Idempotency-Key` header on every `POST` that creates money movement (as built); 24-hour retention; same key with different body → `422 idempotency_key_reused`; in-flight → `409 request_in_progress`.
- Money: integer minor units plus ISO 4217 `currency`.
- Pagination: `?limit=50&cursor=<opaque>`; responses carry `next_cursor`.
- Errors (as built envelope):

```json
{ "error": { "code": "unprocessable", "message": "Route cannot be funded: insufficient liquidity", "details": { "stage": "INSUFFICIENT_LIQUIDITY" } } }
```

| HTTP | code | Meaning |
|---|---|---|
| 400 | `bad_request`, `invalid_json`, `invalid_idempotency_key` | Malformed input |
| 401 | `unauthorized` | Missing or invalid credential |
| 403 | `forbidden` | Credential valid, permission or policy denies |
| 404 | `not_found` | Object not visible to caller |
| 409 | `conflict`, `request_in_progress` | State conflict |
| 413 | `payload_too_large` | Body limit exceeded |
| 422 | `unprocessable`, `idempotency_key_reused` | Semantically invalid; includes lifecycle and control rejections (headroom, consent missing, frozen wallet) |
| 429 | `rate_limited` | Limit exceeded; `Retry-After` header |
| 5xx | `internal` | Never exposes internals; correlation id in `X-Request-Id` |

- Rate limits (per key, defaults; configurable per plan): reads 600/min, writes 120/min, quotes 300/min, webhooks outbound 50/s per endpoint. Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
- Permissions: each endpoint lists the scope required; scopes map to the as-built permission model.

### 11.2 Endpoint catalogue

**As built (public and first-party)** — `/auth`, `/account`, `/account/passkeys`, `/auth/passkey`, `/money` (routes, catalog, corridors, receipts), `/evidence`, `/payouts` (device and agent queues), `/wallets` (balances, exchange quotes, transactions, statements), `/transfers`, `/qr`, `/payment-requests`, `/checkout`, `/deposits`, `/cards`, `/webhooks`, `/virtual-cards`, `/bank-accounts`, `/withdrawals`, `/agents` (cash agents), `/remittances`, `/recipients`, `/bills`, `/topups`, `/gift-cards`, `/kyc`, `/support`, `/p2p`, `/merchant` (stats, gateway, API keys, webhook rotate, deliveries, settlements, payment requests, transactions), `/admin/*` (143 endpoints including e-money, corridors, users, blog, SEO), `/blog`, and the SSR site routes.

**New: gateway API door** (scope in brackets)

| Method | Path | Purpose |
|---|---|---|
| POST | `/payments` [payments:write] | Create a payment intent (amount, currency, methods, customer, metadata, `return_url`, `split[]`) |
| GET | `/payments/:id` [payments:read] | Retrieve with full timeline |
| POST | `/payments/:id/capture` / `/cancel` | Manual capture or cancel |
| POST | `/payments/:id/refunds` [refunds:write] | Full or partial refund; ledger reversal |
| POST | `/payment-links` [links:write] | Hosted link with optional QR |
| POST | `/qr` [qr:write] | Static or dynamic QR for a merchant account |
| GET | `/balance` [balance:read] | Merchant balances by currency and classification |
| GET | `/settlements`, `/settlements/:id` [settlements:read] | Settlement batches with lines |
| POST | `/payouts` [payouts:write] | Payout to mobile money, bank or wallet with recipient-currency options |
| GET | `/payouts/:id` [payouts:read] | Lifecycle stage and evidence summary |
| GET | `/disputes`, POST `/disputes/:id/evidence` [disputes:*] | Chargeback handling |
| GET/POST/DELETE | `/webhook-endpoints` [webhooks:*] | Manage endpoints and subscriptions |
| POST | `/webhook-endpoints/:id/test` | Send a signed sample event |
| GET | `/events`, `/events/:id` [events:read] | Event log for the merchant |
| POST | `/sandbox/simulate` [sandbox] | Simulate evidence, settlement, dispute, failure |

**New: AI-OS API**

| Method | Path | Purpose |
|---|---|---|
| GET | `/assist/agents` | Agents available to the caller with status and budget |
| POST | `/assist/runs` | Start a run: `{ agent: "analyst", input: "...", context: {...} }`; returns run id; streams via SSE at `/assist/runs/:id/stream` |
| GET | `/assist/runs/:id` | Run status, steps (redacted), outputs |
| POST | `/assist/runs/:id/cancel` | Cancel |
| GET | `/assist/approvals`, POST `/assist/approvals/:id/decide` | Approvals for the caller (owner) |
| GET/PUT | `/assist/instances/:agent` | Per-user agent settings and budgets |
| GET/POST/DELETE | `/assist/memories` | View and delete personal memories (GDPR) |
| GET | `/usage` | ACU, API calls, webhook counts for the period |
| GET | `/billing/subscription`, POST `/billing/subscription` | Plan management |
| GET | `/billing/invoices` | Invoices |
| GET/POST | `/organisations`, `/organisations/:id/members` | Organisation management |
| GET | `/admin/agents`, `/admin/agents/:id/runs`, `/admin/policies`, PUT `/admin/policies/:id`, POST `/admin/agents/:id/pause` … [agents, policies] | Super Control Centre (section 14) |

### 11.3 Examples

Create a payment with a commission split:

```http
POST /v1/payments
Authorization: Bearer live_sk_...
Idempotency-Key: order-8812-attempt-1
Content-Type: application/json

{
  "amount": 250000,
  "currency": "XAF",
  "methods": ["wallet", "momo", "card"],
  "customer": { "phone": "+2376XXXXXXX" },
  "split": [ { "account": "acct_platform", "bps": 300 } ],
  "metadata": { "order_id": "8812" },
  "return_url": "https://shop.example/thanks"
}
```

```json
{ "id": "gpay_01J...", "status": "requires_action", "checkout_url": "https://pay.bitripay.com/c/8f2k...", "expires_at": "2026-09-12T10:15:00Z" }
```

Start an agent run and stream it:

```http
POST /v1/assist/runs
Authorization: Bearer <jwt>
{ "agent": "analyst", "input": "Why did my settlement on Tuesday come in short?", "context": { "settlement_id": "stl_01J..." } }
```

```
GET /v1/assist/runs/run_01J.../stream   (text/event-stream)
event: step      data: {"tool":"settlements.get","status":"executed"}
event: step      data: {"tool":"ledger.entries","status":"executed"}
event: message   data: {"text":"The batch was short by 12,400 XAF because two payments were refunded on Monday..."}
event: done      data: {"acu_used":0.8}
```

Webhook delivery (as built headers):

```http
POST https://shop.example/webhooks/bitripay
X-BitriPay-Signature: t=1757671200,v1=hex(hmac_sha256(secret, t + "." + body))
X-BitriPay-Event: payment.captured
X-BitriPay-Delivery-Id: whd_01J...
```

Verification: recompute HMAC with the endpoint secret; reject if `t` older than 5 minutes; process idempotently on `X-BitriPay-Delivery-Id`.

### 11.4 Webhook event catalogue

`payment.created|requires_action|captured|failed|refunded`, `payment_link.paid`, `payout.stage_changed` (with `stage`), `payout.settled|failed|mismatched`, `settlement.created|paid`, `dispute.opened|evidence_required|won|lost`, `balance.low` (merchant float), `kyb.status_changed`, `webhook_endpoint.disabled`, `agent.run.completed` (for organisation-owned agents), `approval.requested|decided`, `invoice.created|paid|overdue`, `usage.threshold` (80%, 100% of plan).

### 11.5 SDK and plugin surface

JavaScript/TypeScript (`@bitripay/sdk`), PHP (`bitripay/bitripay-php`, used by the WooCommerce plugin as built), Python (`bitripay`), and a React checkout component. Each SDK wraps idempotency, signature verification, pagination and typed webhooks. Plugins: WooCommerce (as built), Shopify app, Magento, PrestaShop, WordPress payment links, Odoo.
