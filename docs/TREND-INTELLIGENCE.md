# Trend intelligence — specification mapped onto BitriPay

**Source:** *Trend Intelligence AI — Developer build and distribution specification*, received 10 November 2026.
**Status of this document:** the record of what the specification asked for, what BitriPay already had, what was added
as the trend-intelligence module, and where the implementation deliberately differs from the specification's own
technology and commercial choices. Nothing in BitriPay was removed or replaced to make room for it.

The module is **off by default** (`trendIntelligence` in Modules). It changes what the platform publishes about
itself, so an administrator decides when it starts reading the platform's own demand signals. While it is off, every
write refuses with `module_disabled` and the content agent runs on its own topic backlog exactly as before.

---

## 1. Where it lives: inside the platform, invisible to customers

Two rules govern the shape of this module, and both are absolute.

**It is part of BitriPay, not a thing beside it.** Nothing here is registered, typed or scored by hand. It reads
data the platform already collects, clusters it onto the catalogue the platform already publishes, scores it
against module state the platform already holds, and steers agents the platform already runs — on the scheduler
the platform already has. An administrator who never opens its console still gets the whole loop.

**A customer never sees it.** The catalogue entry is marked `internal`, which keeps it out of the `/features` hub,
out of `/features/<slug>` (404, exactly as an unknown slug), out of the sitemap, out of blog seeding and out of
every other feature's related links. The entry still exists so the module-coverage invariant can trace the flag to
an enforced code path — `features.test.ts` sweeps both halves, so "invisible" is a property of the build rather
than of whoever wrote the page.

### What it reads, and what it refuses to read

| Signal | Source family | What is read | Table |
| --- | --- | --- | --- |
| Pages this platform served | `site_traffic` | views per day per path, for each feature's own page and articles | `seo_pageviews` |
| Support queue | `support` | **count of tickets per category per day** | `support_tickets` |
| Product events | `product_events` | count of domain events per type per day | `domain_events` |

Three distinct families, because that is what corroboration counts: somebody reading a page, somebody opening a
ticket and somebody using the product are three independent observations of one interest, while a hundred page
views are one.

No ticket subject, no message body, no user id and no country ever reaches a trend table. The only reliable way to
guarantee that is never to read it, so the collector never selects those columns, and a test greps the stored rows
for the fixture's own private strings.

These signals carry no country — a page view does not say where the reader was, and asking would mean reading more
than is needed. They are recorded against `ZZ`, the ISO 3166 code for an unknown country, which the brief resolver
already treats as "any market".

### What it decides for itself, and what it will not

| Decided automatically | How |
| --- | --- |
| Which sources exist | the three above, registered by the collector |
| Which topics are tracked | one per public feature; the vocabulary is the catalogue's own keywords, never free text |
| Demand, source quality, corroboration, coverage, freshness | measured from the observations |
| Fit and readiness | read from `featureAvailability()` — live module state |
| Commercial intent | the feature's own category |
| Timing | where the latest period sits against the highest the platform has seen |
| Which topics become draft briefs | anything the scorer puts in the brief band with none live |
| Which claims the writer may restate | the feature's own published `proof` lines, registered with their evidence |

**One thing is never automatic: approval.** A draft steers nothing. A person approves it, under step-up, bound to
the payload hash — because nothing else may decide what this platform claims about itself. The platform proposes
(`proposed_by: 'platform'`), which is also why any administrator may approve: the maker was not a person who could
rubber-stamp their own work.

### The veto that matters most

A capability **awaiting an authorisation**, or **switched off by an administrator**, carries a veto and can never
carry a brief. Interest in it may be real; marketing it is not allowed. Writing copy for a function the platform's
own API would refuse is the single failure in this module that could cost the licence, so it is refused by the
scorer rather than left to whoever reads the console.

### Every agent that writes public copy is bounded, not just one

The approved claims and the prohibitions are appended inside `siteContext()` — the one string every agent prompt
already carries. So the article writer, the keyword planner, the page auditor, the social writer and anything
added later inherit the same boundary, instead of it being passed at whichever call site remembered. The site's own
hard rules still apply on top: **a brief narrows what may be said and never widens it.**

Alongside the brief's own prohibitions, every platform-proposed brief carries these, always:

- no promise of a search ranking or of traffic
- no guaranteed arrival time for money
- no claim that the platform is unhackable, fully secure or risk-free
- no licence, authorisation or partner the feature page does not already name
- no figure, statistic, price or customer quote the platform has not already published

---

## 2. The one thing this module actually changes

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

## 3. What the specification asked for, and where it now lives

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

## 4. Where the implementation deliberately differs

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
| §8 policy-controlled retention across raw text, logs, embeddings and backups | observations are swept after 400 days; there is no raw text, no embedding and no object store to sweep | 400 days keeps a period comparable against the same period a year earlier. Snapshots, briefs and claims are **never** swept: they are the audit trail that answers "why did it write that", which is the opposite of what retention is for. |
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

## 5. The scoring, in full, because a score nobody can reproduce is an opinion

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

## 6. Controls

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

### What the daily cycle costs

Measured, because the obvious worry is real: `better-sqlite3` is synchronous, so a slow cycle blocks the API, and
the collector deliberately re-reads its whole window every day rather than trusting a cursor.

Against a year of synthetic data — 49,200 page-view rows, 200,000 domain events, 8,000 tickets, 41 features — the
whole cycle (collect, cluster, score 41 topics, draft, prune) takes **282 ms cold and 126 ms thereafter**, the
later runs being almost entirely duplicate detection. Re-reading the window is therefore cheap enough to be worth
the idempotence it buys, and no cursor or incremental watermark is justified.

That figure is from an in-memory database in a container, not production hardware, and it is a scale check rather
than a benchmark: it says the design is not accidentally quadratic, not that it will be 126 ms on the VPS.

---

## 7. What is not locked, because it is not verified

- **The 80 % actionable-precision gate of §11 stage 2 has not been run.** It needs hand-labelled historical periods
  from this platform's own data, and no observation has been ingested on production. Until that replay exists, the
  scorer is deterministic and tested but not calibrated, and the module should stay off.
- **`auto_eligible` has no automatic path behind it.** The band exists and is scored; nothing acts on it without an
  approval. `autoActionOptIn` is recorded and never implied.
- **The platform has read nothing yet.** The collector only reads days the platform was actually counting — no
  page view row means there is no evidence of nothing, and inventing a zero there would manufacture a baseline that
  makes the first real visit look like a spike. Until several complete days of traffic, tickets and events exist,
  the scorer skips every topic and the content agent runs its own backlog.
- **The support-category and event-type maps are judgements, not measurements.** `payments → QR payments`,
  `payment.captured → QR payments` and the rest are stated in `platformSignals.ts` and are readable in one screen.
  A test now checks that every one resolves to a real, public feature, to a category the support form actually
  offers and to an event this platform actually emits — so a typo fails the suite instead of silently attributing
  real interest to nothing. What a test cannot check is whether the judgement is *right* for this platform's
  ticket mix. An unmapped category or event contributes to nothing rather than being guessed at, which is the safe
  direction, but the maps should be read against real tickets before the module is switched on.

---

## 8. Tests

| File | What it holds |
| --- | --- |
| `trend_scoring.test.ts` | 19 cases: the specification's worked example to the decimal, the gates, the MAD floor, the single-family cap |
| `trend_intelligence.test.ts` | 23 cases: ingestion rules, frozen snapshots, the brief lifecycle, the module switch, the claim registry |
| `trend_steering.test.ts` | 10 cases: the handover to the content agent and every fallback |
| `trend_routes.test.ts` | 8 cases: the module switch over HTTP, maker-checker with step-up and the payload hash, the permission split, and every field the console renders |
| `trend_platform.test.ts` | 17 cases: the whole loop from the platform's own tables with nothing typed, the privacy sweep, the invented-baseline guard, the day-in-progress exclusion, the veto on an unauthorised capability, the single-family refusal, and the boundary reaching every agent |
| `features.test.ts` | the invisibility sweep: internal machinery absent from the hub, the page, the sitemap, both languages' articles and every public feature's related links |
