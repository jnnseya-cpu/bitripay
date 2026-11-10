# Defects — cycle 1

## LA-001 · Module switch "KYC verification" was enforced in the interface only

- **Severity** P2 (high) · **Blocker** No · **Area** authorisation / regulatory control surface · **Status** FIXED, retested
- **Preconditions** Administrator switches *KYC verification* off in Console → Modules.
- **Steps** `GET /api/kyc` and `POST /api/kyc` with any authenticated user token.
- **Expected** `422 module_disabled` — the route family is off.
- **Actual (before)** `200` / submission accepted. The flag was read in exactly one place,
  `frontend/web/src/pages/Settings.tsx:21`, which hid a settings tab. Lite, the phone app and any direct API
  caller were unaffected.
- **Root cause** `app.use('/api/kyc', kycRouter)` was the only mount in that block without `requireModule(...)`.
  Every sibling line (`transfers`, `qrPayments`, `savings`, `creditScore`, `openBanking`, `restrictedWallets`)
  has one, so this was an omission, not a design decision.
- **Impact** A control in a regulated console reported a state it did not enforce. An administrator switching KYC
  off — because a provider is down, or a programme is not live — would believe submissions had stopped while they
  continued. Not an exploitable bypass: tier limits still applied, so no user gained anything. The harm is a false
  belief about control state.
- **Fix** `app.use('/api/kyc', requireModule('kyc'), kycRouter)`.
- **Regression test** `module_switches.test.ts` — "refuses the KYC route family when KYC verification is switched off".
- **Residual risk** None known.

## LA-002 · Module switch "Referral system" was enforced nowhere

- **Severity** P3 (medium) · **Blocker** No · **Area** treasury / growth controls · **Status** FIXED, retested
- **Steps** Switch *Referral system* off; register a user carrying a referral code; complete a first deposit.
- **Expected** No attribution, no reward paid.
- **Actual (before)** Rewards paid from the treasury as normal. `modules.referrals` was read in **no** file.
- **Root cause** The flag was added to `ModuleFlags`, `DEFAULT_MODULES` and the console's switch list without a
  reader. Attribution happens inside registration and payout inside deposit completion, so there was no referral
  endpoint for route middleware to guard and the gap was invisible to a route-level audit.
- **Impact** Money left the treasury on a programme an administrator believed was stopped.
- **Fix** `referralsOn()` guard in `services/referrals.ts` at all three entry points (`payRewards`,
  `onUserRegistered`, `onDepositCompleted`), plus `enabled` on `referralStats` so no interface keeps offering a
  share link that would attribute nobody. Past earnings stay readable — they were earned.
- **Regression test** `module_switches.test.ts` — "stops attributing and paying referral rewards…".
- **Residual risk** None known.

## LA-003 · Pattern sweep made permanent

Not a defect — the control that stops LA-001 and LA-002 recurring. `module_switches.test.ts` walks the whole
server source and fails if any flag in `DEFAULT_MODULES` has no reader. Adding a switch to the console without
enforcing it is now a failing test.

## LA-004 · Eight tests reported a failure that was not in the code

- **Severity** P4 (low, test harness) · **Blocker** No · **Area** test infrastructure · **Status** FIXED, retested
- **Steps** `npx vitest run src/tests/trend_intelligence.test.ts`.
- **Expected** The suite exercises services directly and passes.
- **Actual (before)** Eight failures, all `TypeError: Cannot set properties of undefined (setting 'res')` from
  `express/lib/application.js:165`.
- **Root cause** `beforeEach(() => setupApp())` — the arrow returns `setupApp()`'s value, which is an Express app,
  and an Express app is a function. A function returned from a vitest hook is its **teardown**, so vitest invoked
  the app as `app(undefined, undefined)` after every test in those two suites. The third suite passed only because
  its hook has statements after the call and so returns `undefined`.
- **Impact** None on the product. It is listed because the failure pointed at Express and at the services under
  test, and chasing it there would have wasted a cycle or, worse, produced a "fix" to working code.
- **Fix** The hooks return nothing.
- **Regression test** A sweep confirmed no other test file in the repository returns a value from a hook.
- **Residual risk** None known.

## LA-005 · A console column that silently read nothing

- **Severity** P3 (medium) · **Blocker** No · **Area** trend-intelligence console · **Status** FIXED, retested
- **Steps** Open Trend intelligence → Opportunities with a scored topic present.
- **Expected** The Market column shows the topic's market.
- **Actual (before)** An em dash on every row. Nothing threw; the page rendered; only somebody who knew the value
  should be there could tell.
- **Root cause** `listOpportunities` joined `ti_topics` for its label but selected no market, and
  `ti_opportunities` has no market column of its own.
- **Impact** Market is part of the topic key in this module and is never inferred, so a console that cannot show
  it undercuts the one thing the design is careful about.
- **Fix** Select `t.market` and `t.locale` in the join.
- **Regression test** `trend_routes.test.ts` — "returns every field the console page renders" asserts every field
  of all four lists, and that the three JSON columns the page parses are really JSON text. Confirmed end to end
  against the compiled build and a live database.
- **Residual risk** None known.

## LA-006 · Raw floats in the console

- **Severity** P4 (low, presentation) · **Blocker** No · **Area** trend-intelligence console · **Status** FIXED
- **Actual (before)** Confidence displayed as `91.0833296875`, which told a reader nothing and squeezed the header
  row into "MARKE / T" and "DEMAN / D".
- **Root cause** The scorer deliberately does not round before deciding a band — that is why the specification's
  worked example reproduces exactly — and the console printed the value it was given.
- **Fix** One decimal in the console, exact value on the cell; headers keep their words together via a new opt-in
  class, since `.table-wrap` already scrolls. Nothing server-side changed.
- **Residual risk** None. Long topics still break mid-word in narrow cells on a phone; that is
  `overflow-wrap: anywhere`, which is platform-wide and is what stops brief ids overflowing on this same page.

## LA-007 · A console switch with no feature behind it

- **Severity** P3 (medium) · **Blocker** No · **Area** product surface · **Status** FIXED, retested
- **Actual (before)** `features.test.ts` failed: `modules with no feature: trendIntelligence`.
- **Root cause** A new module flag was added without a catalogue entry tracing it to an enforced code path.
- **Impact** None reached a user — the guard caught it before the suite went green. It is recorded because the
  tempting fix was to exempt the flag, which would have weakened the invariant that caught LA-001 and LA-002.
- **Fix** The feature was written instead: feature 42, English and French, openly not a customer product and
  explicit that it ships off.
- **Regression test** The existing `features.test.ts` coverage test, unchanged.
- **Residual risk** None known.

## LA-008 · The collector invented a baseline of zero

- **Severity** P2 (high, correctness of a signal) · **Blocker** No · **Area** trend intelligence · **Status** FIXED, retested
- **Steps** Switch trend intelligence on for a platform that has never recorded a support ticket or a domain event, and run the daily cycle.
- **Expected** No observation for a period the platform was not counting.
- **Actual (before)** Forty-five days of zeros per mapped feature, for every signal with no history.
- **Root cause** `completedDays(null, days)` returned the whole window when there was no first row. The page-view
  path had the guard; the ticket and event paths did not.
- **Impact** Every mapped feature got a flat zero baseline, so the first real ticket or event would read as an
  enormous spike against it. The module's whole claim is that it refuses to assert what it cannot support, and this
  manufactured exactly the kind of confident number it exists to avoid.
- **Fix** No row means no history; those days are skipped entirely.
- **Regression test** `trend_platform.test.ts` — "invents no baseline for days the platform was not counting".
- **Residual risk** None known.

## LA-009 · A scheduled pass overruled an administrator

- **Severity** P2 (high) · **Blocker** No · **Area** trend intelligence / claims · **Status** FIXED, retested
- **Steps** Register the catalogue claims, close one claim's validity window by hand (the sentence stopped being
  true), wait for the next daily cycle.
- **Expected** The claim stays retired, and any brief citing it is refused.
- **Actual (before)** `claimsForFeature` re-registered every proof line each pass, and `upsertClaim` treats a
  changed validity window as a new revision — so the retired claim came back the next morning as a fresh, open
  revision, and the brief citing it was approved.
- **Impact** The automatic loop silently reversed a human decision about **what the platform is allowed to claim**,
  which is the one thing in this module that is supposed to be a person's to decide.
- **Fix** A revision is created only when the catalogue *text* differs. An existing revision with the same words is
  reused whatever its window, so a retired claim stays retired, is still cited, and `proposeBrief` refuses by name.
- **Regression test** `trend_platform.test.ts` — "says why a topic in the brief band was not drafted…".
- **Residual risk** None known. Found only because the test for LA-010 could not be made to fail.

## LA-010 · Briefs were declined in silence

- **Severity** P3 (medium, observability) · **Blocker** No · **Area** trend intelligence · **Status** FIXED, retested
- **Actual (before)** `autoProposeBriefs` swallowed every refusal into a counter. A veto is on the snapshot, but a
  lapsed claim or a band that moved is not, so an administrator saw "nothing drafted" and no reason.
- **Impact** None directly; but a module that insists on saying why it scored something and then declines to act
  without explanation has given up the property it is built on.
- **Fix** Refusals carry the topic and the reason, through the cycle result and into the daily log. A topic skipped
  because it already has a live brief is not a refusal — that is the one-brief-per-topic rule working.
- **Regression test** `trend_platform.test.ts`, same case as LA-009.
- **Residual risk** None known.

## LA-011 · The daily collector scanned the platform's busiest table

- **Severity** P3 (medium, performance) · **Blocker** No · **Area** trend intelligence · **Status** FIXED, retested
- **Steps** `EXPLAIN QUERY PLAN` on the collector's three aggregate queries.
- **Actual (before)** `SCAN domain_events` (covering index, but the whole history) and `SCAN support_tickets` (no
  index at all). The retention sweep deleted by an unindexed column.
- **Root cause** `domain_events` was indexed `(type, occurred_at)`, which cannot seek a range on `occurred_at`
  alone. `support_tickets` had no date index.
- **Impact** The morning cycle read every event the platform had ever emitted, getting slower every month. It
  returned the right answer throughout, so there was no symptom to notice.
- **Fix** Migration `046_trend_signal_indexes.sql`, grouping column second so each index covers its query. All
  three plans are now `SEARCH … USING COVERING INDEX`.
- **Regression test** `trend_platform.test.ts` — asserts the query plan, not a timing.
- **Residual risk** None known. Cycle cost measured at 282 ms cold / 126 ms warm against a year of synthetic data
  (49,200 page-view rows, 200,000 events, 8,000 tickets) on an in-memory database — a scale check, not a VPS
  prediction.
