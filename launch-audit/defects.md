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
