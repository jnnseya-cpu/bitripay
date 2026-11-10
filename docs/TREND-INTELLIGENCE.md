# Trend intelligence — specification mapped onto BitriPay

**Source:** *Trend Intelligence AI — Developer build and distribution specification*, received 10 November 2026.
**Status of this document:** the record of what the specification asked for, what BitriPay already had, what was added
as the trend-intelligence module, and where the implementation deliberately differs from the specification's own
technology and commercial choices. Nothing in BitriPay was removed or replaced to make room for it.

The module is **off by default** (`trendIntelligence` in Modules). It changes what the platform publishes about
itself, so an administrator decides when it starts reading the platform's own demand signals. While it is off, every
write refuses with `module_disabled` and the content agent runs on its own topic backlog exactly as before.

---

## 1. The one thing this module actually changes

Before it, `runContentSchedule()` in `services/seoAgent.ts` did this:

```ts
const topic = s.agent.topics[0];
```

A hand-written queue in SEO settings was the platform's entire judgement about what its market wanted. The
specification's central claim is that detection should steer the agents that already exist rather than become
another agent, and that is what was built: an approved, unexpired **growth brief** for one of the configured markets
now supplies the topic, the audience, the objective and the claims the writer may state, and the backlog is the
fallback.

The fallback is not a detail. A growth control that cannot be revoked without stopping the platform from publishing
is not a control, so:

| Situation | What the content agent does |
| --- | --- |
| An approved brief resolves for a configured market | Writes against it; `recordBriefUse` logs `used` with the brief id and version |
| No brief resolves | Writes the next backlog topic; logged as `baseline` with the reason |
| The brief is revoked | Next run is back on the backlog, with no job having to run first |
| The brief has lapsed | Same — expiry is checked on the read, never by a sweeper |
| An administrator switches the module off | Backlog, and `effectiveBrief()` returns null instead of throwing |

The backlog is consumed **only** when the backlog is what drafted, so a brief never silently eats a queued topic.
`agentStatus().steering` reports which of the two is steering and why, and the console shows it at the top of the
page.

---

## 2. What the specification asked for, and where it now lives

| Specification | Already in BitriPay | Added by this module |
| --- | --- | --- |
| §1 Detect demand, score it, hand agents a brief | `services/seoAgent.ts` drafts, audits and writes social packs from a topic list | `services/trend/` — detection, deterministic scoring, the brief lifecycle |
| §2 Keyless installation; no new credential for the core workflow | the platform's own rule: nothing but AI functions depends on an external key | detection holds **no** credential at all; a source the platform cannot reach is recorded unavailable with its reason |
| §2 Host AI gateway, then local inference, then deterministic template | `anthropicKey()` resolver, `mode: apiKey() ? 'live' : 'fallback'`, `fallbackDraft()` | nothing — the existing three-way fallback already satisfies §2, TI-18 and TI-19 |
| §3 Source registry, what each signal can prove | — | `ti_sources`: family, access path, quality, staleness, permitted uses, territories, `context_only` |
| §3 Shared provenance must be deduplicated | — | a **family** contributes once however many records it sends (TI-04) |
| §5 Baselines, movement, z-score, gates | — | `services/trend/scoring.ts`, pinned at `ti-1.0.0` |
| §5 Opportunity and confidence weightings | — | 25/25/20/15/15 and 35/25/20/20, unrounded before the decision (TI-03) |
| §6 The versioned brief contract all agents consume | — | `ti_briefs` + `effectiveBrief()`; the same object for SEO and content |
| §6 Approval binds to the payload | maker-checker across the platform (`services/verification.ts`) | the approval carries the payload hash; editing after approval invalidates it |
| §6 One live brief per scope | — | a partial unique index, not a check a caller could skip |
| §6 Claims resolve server-side against an approved registry | the site's own hard rules in `siteContext()` | `ti_claims`, revision-not-edit, with validity windows |
| §7 SEO and organic content, draft-only, editorial approval | the existing editorial review: drafts land in `review` unless auto-publish is on | the brief narrows what is drafted; it never widens what may be published |
| §7 Paid search, CRM sends, audience exports | — | **not built** — see §4 |
| §8 Trust boundary: feed text is untrusted; the model returns bounded JSON | `DRAFT_SCHEMA`, the structured-output path, and the SSRF guard on outbound fetches | only approved claim strings and prohibitions reach the prompt; nothing free-text travels from a brief |
| §8 Admin UI: source status, scored opportunities, brief approval, receipts, freeze | the admin console and its permission model | `frontend/admin/src/pages/Trend.tsx`, and the module switch **is** the freeze |
| §9 Platform profile supplies offer, audience, markets, locales, claims | SEO settings already hold audience, tone, languages and markets | the profile inputs (fit, commercial intent, timing, readiness) are request fields set by the platform's mapping |
| §10 Freeze the hypothesis at approval; distinguish correlation from lift | — | the snapshot is frozen and its inputs digested; **lift measurement is not built** — see §4 |
| §11 Stage 3 gate: both agents consume the same versioned brief; a revoked brief triggers nothing | — | asserted in `trend_steering.test.ts` and `trend_routes.test.ts` |

---

## 3. Where the implementation deliberately differs

These are decisions, not omissions. Each one is the same decision taken for the corridor-network specification, and
for the same reason: **everything remains BitriPay.**

| The specification's choice | What was built instead | Why |
| --- | --- | --- |
| Python + FastAPI service | TypeScript in `backend/api`, in the existing Express app | A second runtime would double the deploy surface, the dependency audit and the CI matrix for no capability gain. |
| PostgreSQL + pgvector | SQLite via `better-sqlite3`, migration `045_trend_intelligence.sql` | The platform's single store. Nothing here needs a vector index, because clustering is lexical by design (below). |
| Embeddings (BGE-M3) for clustering | Canonicalisation: NFD, accents and punctuation stripped, lower-cased, with the original text kept beside it | An embedding would merge "send money **to** Kinshasa" with "send money **from** Kinshasa", and would merge two markets whose words are similar — exactly the mistake that puts a brief in front of the wrong audience. Market is part of the key and is never inferred. |
| Self-hosted Qwen3-8B on a 24 GB GPU, llama.cpp / vLLM | The existing Anthropic path, with the existing deterministic template as the offline mode | The platform has one AI gateway with a margin floor. A GPU is a new vendor and a new cost line; the spec itself calls its sizing a hypothesis. TI-10 and TI-19 are satisfied by the template writer that already exists. |
| PostgreSQL-backed outbox worker | The existing `src/jobs.ts` scheduler | Already in place, already supervised. |
| Object storage for raw snapshots | Observations store the value, the window and the evidence URI; raw text is not retained | Less to retain is less to leak, and the permitted-use fields on a source say what may be kept. |
| Multi-tenant rows, composite tenant keys, row-level security (TI-02, TI-15, TI-17) | Single platform. No tenant column exists | BitriPay is not a multi-tenant SaaS selling this module. Adding a tenant key that is always the same value would be a security theatre: a control nobody can observe failing. |
| Commercial control plane: plans, trials, metering, provisioning (§19, TI-09, TI-11, TI-13) | Not built | BitriPay does not sell this. There is nothing to meter and no plan to reconcile. |
| Helm charts, separate deployment | The existing `scripts/deploy.sh`, Caddy and compose on the Hostinger VPS | No new vendor and no new hosting target. |

**Two capabilities the specification describes that this module does not have, stated plainly so nobody plans around
them:**

1. **No paid media, no CRM sends, no audience exports.** §7 describes four more channels. `BRIEF_CHANNELS` is
   `seo`, `content`, `organic_social`, and a brief for a channel it does not allow does not resolve. TI-12's answer
   here is structural rather than configured: there is no direct-marketing execution path for a brief to reach.
2. **No incremental-lift measurement.** §10 asks for randomised assignment, matched untreated URLs and
   pre-registered caps. `ti_brief_uses` records what the agent resolved and which article came out of it, which
   answers "where did this article come from". It does **not** claim the article caused anything. Calling a
   correlation a lift would be exactly the false readiness this platform's own rules forbid.

---

## 4. The scoring, in full, because a score nobody can reproduce is an opinion

Pinned at `SCORING_VERSION = 'ti-1.0.0'`. Every snapshot stores the version and a digest of its inputs, so the same
inputs at the same window end return the same row rather than a second one.

**Movement.** `lift = ln((current + 1) / (baseline + 1))`, and
`z = (log1p(current) − median(log1p(history))) / max(1.4826 × MAD(log1p(history)), 0.2)`.
The 0.2 floor stops a flat series from turning a one-unit wobble into an infinite z. A movement counts only when
`current >= 20 && z >= 2`: below that it is labelled, not scored.

**Gates that stop a number becoming confidence.**

- Fewer than 4 comparable periods → the family is recorded with the reason, not silently dropped.
- An indexed feed (`scalingScope: 'indexed'`) can raise a question but never set demand on its own.
- `demand = clamp(50 + 10 × z)` — demand is derived from the movement, never asserted.
- Corroboration is `0` for one family, `80` for two, `100` for three or more, and a single family caps confidence at
  **69**, which is below the brief band. Four syndicated copies of one announcement are one family (TI-04).

**Weights.** Opportunity: demand 25, fit 25, commercial intent 20, timing 15, readiness 15. Confidence: source
quality 35, corroboration 25, coverage 20, freshness 20. Neither is rounded before the band decision, which is why
the specification's own worked example reproduces exactly: **86.25 opportunity, 83.5 confidence** (TI-03, asserted
in `trend_scoring.test.ts`).

Fit, commercial intent, timing and readiness come from the platform's own mapping and are request fields on
`POST /api/admin/trend/topics/:id/snapshot`. A model may suggest them; only an administrator's mapping sets them.

**Bands.** `archive` → `watch` → `brief` → `auto_eligible`. Only `brief` and `auto_eligible` may carry a brief; any
veto on a snapshot refuses a brief outright.

---

## 5. Controls

| Control | Where it is enforced |
| --- | --- |
| Module switch closes the whole surface | `requireModule('trendIntelligence')` on the router **and** `assertTrendIntelligence()` in every service write |
| Resolution never throws | `effectiveBrief()` returns null when the module is off, so the content schedule survives |
| An exact replay lands once | `UNIQUE (source_id, source_record_id, revision)`; a changed payload under the same key is a conflict for the operator, never an overwrite (TI-01) |
| One approved brief per scope | partial unique index `WHERE status = 'approved'`, superseding in one transaction |
| Approval covers the exact payload | `payloadHash` sent back by the console; a stale hash is a 409 |
| A brief cannot be self-approved | `approveBrief` refuses when the approver proposed it |
| Approval and revocation need step-up | `assertAdminStepUp` on both routes |
| Expiry does not wait for a job | checked on the read; `expire-lapsed` is housekeeping only (TI-05) |
| A claim the platform does not hold is refused | resolved server-side at propose time; a lapsed or not-yet-valid claim is refused too |
| A claim's text cannot change under an approval | a new text is a new revision with a new id |
| The claim registry is not a marketing decision | `compliance` permission; the rest of the surface is `cms` |
| No credential is ever requested | an unreachable source is recorded unavailable with its reason (TI-22) |
| A brief cannot add a publishing language | the configured languages win; the downgrade is recorded in the brief-use detail |

---

## 6. What is not locked, because it is not verified

- **The 80 % actionable-precision gate of §11 stage 2 has not been run.** It needs hand-labelled historical periods
  from this platform's own data, and no observation has been ingested on production. Until that replay exists, the
  scorer is deterministic and tested but not calibrated, and the module should stay off.
- **`auto_eligible` has no automatic path behind it.** The band exists and is scored; nothing acts on it without an
  approval. `autoActionOptIn` is recorded and never implied.
- **No source is registered on production.** The source registry ships empty on purpose: which first-party signals
  this platform may use is a decision about its own data, not a default.

---

## 7. Tests

| File | What it holds |
| --- | --- |
| `trend_scoring.test.ts` | 19 cases: the specification's worked example to the decimal, the gates, the MAD floor, the single-family cap |
| `trend_intelligence.test.ts` | 23 cases: ingestion rules, frozen snapshots, the brief lifecycle, the module switch, the claim registry |
| `trend_steering.test.ts` | 10 cases: the handover to the content agent and every fallback |
| `trend_routes.test.ts` | 7 cases: the module switch over HTTP, maker-checker with step-up and the payload hash, the permission split |
