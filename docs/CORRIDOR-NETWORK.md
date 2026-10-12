# Corridor network — specification mapped onto BitriPay

**Source:** *BitriPay Corridor Network — Developer Build Specification*, 12 October 2026.
**Status of this document:** the record of what the specification asked for, what the platform already had, what was
added as the corridor-network module, and where the implementation deliberately differs from the specification's own
technology choices. Nothing in BitriPay was removed or replaced to make room for it.

The module is **off by default** (`corridorNetwork` in Modules) and sits inside the aggregator perimeter's off-list.
It describes capabilities that depend on authorisations and partners that do not exist yet; until they do, an
administrator decides when any of it is visible, and none of it is offered to a customer.

---

## 1. What the specification asked for, and where it now lives

| Specification | Already in BitriPay | Added by this module |
| --- | --- | --- |
| §2 Ledger service, double-entry, balances, holds, reversals | `services/ledger.ts` — balanced postings, hash-chained events, `reconcileLedger()`, holds, reversals | nothing; every corridor-network movement posts through it |
| §2 Routing engine, scoring, failover, circuit breakers | `services/rails.ts` (Smart Route, health, breakers), `services/routing.ts` | nothing |
| §2 FX and pricing, quotes with expiry, fee schedules | `services/fx.ts`, `services/finops/fees.ts`, settlement conversions with `marginBps` | nothing |
| §2 Compliance engine, screening, monitoring, cases | `services/risk/`, `services/kyc.ts`, sanctions sources, case queue | ISO 20022 party enrichment and gap reporting |
| §2 KODA verification | `services/verification.ts`, `services/evidence.ts` | nothing |
| §2 Reconciliation against partner statements | `services/finops/processorRecon.ts`, `services/switch/reconciliation.ts` | counterparty statement import (camt.053) and settlement-batch reconciliation |
| §2 Webhooks and events | `services/webhooks.ts`, `services/events.ts` | a `network` event stream |
| §2 Settlement service (phase 2) | merchant settlement: `services/finops/settlement.ts` | **counterparty** settlement: positions and batches |
| §2 Wallet service (phase 3) | `services/wallets.ts`, `services/emoney.ts` (programmes, reserve backing, issuance rule) | the daily safeguarding evidence on top of it |
| §3 Money as integers in minor units with a currency | already true platform-wide; no floating point | ISO 20022 amount formatting at the currency's own exponent |
| §3 Corridor with `regulatory_mode` as data | `services/corridors.ts` (operational corridor, licence refs, sandbox/live) | `network_corridors`: phase, regulatory mode, custody model, rails, limits, settlement flags |
| §3 `partner_float` and `prefund` accounts | `services/liquidity.ts` — payout accounts with their own ledger float wallets | counterparties that **link** those accounts; no second balance is kept |
| §3 `settlement_batch`, `recon_break` | — | `network_settlement_batches`, break detection on reconcile |
| §4 RailAdapter contract per rail | `services/switch/adapter.ts`, `payments/*` gateways, `services/railCatalog.ts` | `SettlementRailAdapter` for the settlement leg |
| §4 Regulatory mode non-custodial | the aggregator perimeter (Instructions n°42 and n°58) | `regulatory_mode` recorded per corridor, with the licence basis |
| §5 Public API `GET /corridors` | — | `GET /v1/corridors`, read-only, module-gated, published in the OpenAPI document |
| §6 Positions, prefunding, treasury forecast | manual prefunding in the console | forecast from measured outflow, top-ups under four eyes |
| §6 PAPSS via a sponsor bank, ISO 20022 | — | `pacs.008` built, `pacs.002` / `pacs.004` / `camt.053` imported |
| §6 Stablecoin settlement behind a per-corridor flag | — | `settlement_token` rail, off on every corridor until a decision is recorded |
| §6 Treasury limits and exposure | `services/liquidity.ts` limits | exposure limit and utilisation per counterparty and currency |
| §7 Safeguarding, daily reconciliation, resolution pack, monthly return | the issuance rule (`assertIssuable`) | daily internal + external checks, hashed resolution pack, monthly return |
| §8 ISO 20022 native | the switch adapter is protocol-neutral by design | the four documents above, with a strict reader and writer |
| §9 AML, four eyes, audit | risk engine, maker-checker, `audit_logs`, hash-chained event log | four eyes on batches and on prefunding |
| §10 Gates, kill-or-pivot criteria | — | `network_gates`, measured with evidence; `phaseReadiness()` |
| §11 Open questions | — | `network_questions`, 11 seeded, each with what it blocks |

---

## 2. Where the implementation differs from the specification, and why

The specification proposes a technology stack. BitriPay already has one, and the standing constraints on this
project are explicit: nothing is removed, no new vendor, no dependency on external keys except the assistant
features, and hosting stays where it is. So the **architecture** of the specification was implemented in full and
its **infrastructure choices** were mapped onto what the platform runs.

| Specification says | Implemented as | Why |
| --- | --- | --- |
| Postgres 16, ledger in its own database | SQLite (better-sqlite3) with serialised writes, as the whole platform already uses | One datastore, one backup, one restore. The ledger's invariants are enforced in code and tested, not by the engine choice. Moving to another engine later is a migration, not a redesign. |
| Kubernetes on GCP or AWS, two regions | The existing Hostinger VPS deployment behind the shared proxy, plus Vercel for the front ends | "No new vendor" is a standing instruction. Nothing in the module assumes a particular host. |
| Kafka or Pub/Sub event bus | The existing in-process event bus and hash-chained `event_log` | The platform already records every state change with a hash chain, which is what a regulator asks for. A broker adds an operator, not an invariant. |
| Redis for idempotency and rate limits | The existing idempotency and rate-limit tables | Already built, already tested. |
| Go or Kotlin for the ledger | TypeScript, as the rest of the platform | One language, as the specification itself recommends for phase 1. |
| Partner adapters that call partner APIs with stored credentials | Adapters that **instruct and reconcile**: a file, a statement line or an administrator's entry with the counterparty's own reference | The platform's standing rule is that money movement depends on no external key. A rail that later offers an interface changes how the same instruction travels, not what it says. |
| Named partners (an aggregator, a token provider, a sponsor bank) | Counterparty **slots** named after the function, with the company recorded against the slot | Which company fills a slot is a commercial decision, and several of them are still open questions (Q-06 to Q-09). |

Two things the specification lists as non-goals are non-goals here too, and the code says so: BitriPay does not
build a national switch, and it does not hold customer funds before its own authorisation exists.

---

## 3. What was built

### 3.1 Posture (`services/network/registry.ts`)

A **network corridor** records the phase, the regulatory mode, the licence basis, the partner that holds the funds,
the collection, payout and settlement rails, the limits, and whether a sponsored scheme participation or a
settlement-token leg is permitted on it. `corridorReadiness()` lists what is still missing, and `setCorridorStatus()`
refuses `live` until nothing is.

A **counterparty** is an operator, a bank, a cross-border partner, a sponsor bank, a settlement-token provider or an
electronic-money principal. Its float is the existing liquidity payout accounts linked to it — not a second balance —
with an exposure limit and the utilisation against it. Liquidity accounts linked to no counterparty are listed, so
nothing is left unaccounted for.

The four phases, the two corridors, the counterparty slots, the gates, the kill-or-pivot criteria and the eleven open
questions are seeded from `content/corridorNetwork.ts` on boot. Seeding only inserts what is missing: an
administrator's edit, measurement or answer is never overwritten.

### 3.2 Counterparty settlement (`services/network/positions.ts`)

A **sub-ledger** of what each counterparty received for BitriPay (a collection it owes) and what it paid for BitriPay
out of its own funds (a post-paid payout BitriPay owes), signed, idempotent per reference. **Prefunding is
deliberately not in it**: placing BitriPay's own liquidity at a partner is a treasury movement on the liquidity
account, and counting it in both places would make every position wrong. There is a test for exactly that.

A **position** nets one counterparty, one currency and one window. Closing freezes it. A movement that arrives
afterwards goes into a supplementary window of the same period (`2026-10-12.1`) rather than reopening a frozen one.

A **batch** settles a closed window: proposed by one administrator, approved by a second, instructed on a rail that
is re-checked at instruction time, confirmed with the counterparty's reference, and reconciled against its statement.
A difference is a break: reconciliation is refused and the difference is named.

### 3.3 Settlement rails (`services/network/adapters.ts`)

`partner_network`, `bank_transfer`, `sponsor_iso20022`, `settlement_token`. Each declares what it can carry and what
has to happen for the money to move. The last two require a corridor flag that is off until the decision allowing it
is recorded, with the reason kept in the event log.

### 3.4 Treasury (`services/network/treasury.ts`)

The forecast is measured: what actually left each of the counterparty's liquidity accounts over a lookback window,
projected over the horizon, times the counterparty's safety factor, against what it holds now. A shortfall becomes a
top-up proposal; a second administrator approves it; executing it goes through `prefundAccount()` — the same posting,
the same ledger, the same reserve hook as a prefund made by hand.

### 3.5 ISO 20022 (`services/network/iso20022.ts`, `lib/xml.ts`)

`pacs.008` is built for an approved batch and refuses to build at all while a party detail a scheme requires is
missing — the reason is readable here rather than a rejection downstream. `pacs.002` confirms or fails its batch,
`pacs.004` posts a return and fails it, `camt.053` posts the day's entries into the counterparty sub-ledger.
Importing the same file twice applies nothing twice.

`lib/xml.ts` is a focused reader and writer: a document type declaration is refused rather than expanded, which
closes the entity-expansion family of attacks, and the input is size-bounded.

### 3.6 Safeguarding (`services/network/safeguarding.ts`)

Two reconciliations, kept apart because they fail for different reasons. **Internal**: every customer wallet balance
equals the sum of its own postings — a mismatch is a ledger defect. **External**: the safeguarding requirement equals
the cleared funds in designated accounts — a shortfall is money, remedied the same day from own funds through the
existing reserve maker-checker.

A **resolution pack** is generated daily: every holder with their balance, the designated accounts behind them, the
day's checks and the procedure an administrator would follow. It is hash-chained to the previous day's pack, and
`verifyResolutionChain()` says if one was edited afterwards.

The **monthly return** is produced from the ledger and the daily checks, never from a spreadsheet.
`assertSafeguardingHealthy()` is release-blocking: it refuses while a day is short or a wallet disagrees with its own
postings.

### 3.7 Corridor P&L (`services/network/pnl.ts`)

Fee revenue, foreign-exchange margin, partner cost and the cost of prefunding, each naming its source. **A line the
platform cannot derive is returned as unknown, never as zero**, and the contribution is withheld until every line is
known — so a corridor is never declared profitable on a sum that quietly left a cost out.

### 3.8 Gates and questions (`services/network/gates.ts`)

A gate is met only with a measurement **and** the evidence behind it; both are refused if absent. `phaseReadiness()`
says, per phase, which gates of the previous phase are outstanding, which questions are unanswered and whether a
kill-or-pivot criterion has been triggered.

---

## 4. Surfaces

- **Console** → Money → *Corridor network*, eight tabs: phases and corridors, counterparties and float, positions and
  settlement, treasury, sponsor messages, safeguarding, corridor P&L, gates and questions.
- **Console API** → `/api/admin/network/*`. Permissions follow the action: posture and counterparties are `settings`,
  positions, settlement, treasury and messages are `treasury`, safeguarding, gates and questions are `compliance`.
- **Public API** → `GET /v1/corridors` — the rails a corridor declares, its limits and whether it is live or in
  sandbox. It never names a partner or the licence basis: those are BitriPay's commercial facts, not part of a
  merchant's integration. Published in the OpenAPI document and therefore in the rendered API reference.

## 5. What is deliberately not built yet

- No partner interface is called. Every rail is instruct-and-reconcile until a contract and a key exist, which is the
  platform's standing rule, not a shortcut.
- No customer-facing settlement-token product. The token rail is a settlement leg between BitriPay's own accounts at
  two partners, and it is off on every corridor.
- No automatic corridor pricing from the network registry. Pricing stays where it is (`services/finops/fees.ts`);
  the corridor records its limits and its posture, not its tariff.
- Phase 3 wallets are the platform's existing wallets. The module adds the evidence an issuer must keep, not a second
  wallet engine.

## 6. Tests

`backend/api/src/tests/corridor_network.test.ts` — 22 tests: the module is off by default and inside the aggregator
perimeter; seeding is idempotent; an incomplete posture refuses to go live and says what is missing; a settlement
mechanism stays off until its decision is recorded; the sub-ledger nets a window and keeps prefunding out of it; a
batch is refused at every step taken out of order and needs a second administrator; a late movement opens a
supplementary window instead of a frozen one; a rail switched off on a corridor is refused at instruction time; the
forecast matches the measured outflow and prefunding needs four eyes; ISO 20022 amounts round-trip at the currency's
exponent and a document type declaration is refused; a pacs.008 is built, a pacs.002 confirms its batch, a re-import
applies nothing twice and a camt.053 posts its entries; the internal reconciliation balances; a shortfall blocks the
release gate; the resolution-pack chain verifies and tampering breaks it; the monthly return comes from the ledger;
P&L withholds the contribution while a line is unknown; a gate needs a measurement and its evidence; a phase is held
while questions are open; `/v1/corridors` is module-gated, publishes no draft and names no partner.
