# Cycle 2 — trend intelligence

**Build:** `ce215d3` on `claude/magical-franklin-pa55pn`.
**Scope:** the trend-intelligence module, built from the attached specification, and the four defects found while
building it. Everything verified in cycle 1 stands; nothing from it was changed or removed.

**Verdict for this build is unchanged: NO-GO**, and for the same reason as cycle 1 — production is unreachable from
this session, so the deployed build is not the tested build. This cycle adds one more reason specific to the new
module, recorded as H-10: the scorer is deterministic and tested but has never been replayed against labelled
history, so it is **not calibrated**. The module therefore ships off.

## What was built

| Claim | Where it is enforced | Where it is proved |
| --- | --- | --- |
| An approved brief steers the existing content agent instead of a hand-written topic list | `services/seoAgent.ts` `resolveSteer()` | `trend_steering.test.ts` |
| Revoking, lapsing, going out of market, or switching the module off each return the agent to its backlog | same, plus `effectiveBrief()` returning null rather than throwing | `trend_steering.test.ts`, `trend_intelligence.test.ts` |
| An approval needs a second administrator, step-up, and the exact payload hash shown | `routes/admin/trend.ts`, `approveBrief()` | `trend_routes.test.ts`, and exercised against the compiled build (403 / 403 / 409) |
| An exact replay lands once; a changed payload under the same key is a conflict | `UNIQUE (source_id, source_record_id, revision)` | `trend_intelligence.test.ts` (TI-01), and reproduced live |
| One source family cannot alone reach the brief band | `SINGLE_FAMILY_CONFIDENCE_CAP` | `trend_scoring.test.ts` (TI-04) |
| The specification's worked example reproduces unrounded (86.25 / 83.5) | `services/trend/scoring.ts` | `trend_scoring.test.ts` (TI-03) |
| No credential is ever requested | there is no code path that asks for one | `trend_routes.test.ts` (TI-22), and the live source list contains no key-shaped field |

## Defects found and fixed in this cycle

| # | Defect | How it was found | Status |
| --- | --- | --- | --- |
| LA-004 | Eight tests reported a failure that was not in the code: `beforeEach(() => setupApp())` returns the Express app, and a function returned from a vitest hook is its teardown, so vitest called the app as `app(undefined, undefined)` after every test. | Running the suite. | Fixed; a sweep confirms no other test file in the repository returns a value from a hook. |
| LA-005 | `listOpportunities` joined the topic for its label but not its market, so the console's Market column read an em dash on every row. Nothing threw; the page rendered. | Rendering the page against the compiled build and the real API. | Fixed, and the whole console payload is now asserted field by field, so a query that stops selecting a field fails a test instead of blanking a column. |
| LA-006 | Scores displayed as raw floats (`91.0833296875`), which told a reader nothing and squeezed the header row into "MARKE / T". | Same render. | Fixed at the display layer only; the engine still does not round before deciding a band. |
| LA-007 | `trendIntelligence` was a console switch with no feature tracing to it, which `features.test.ts` refuses. | The existing guard caught it. | Fixed by writing the feature honestly (feature 42, English and French, openly not a customer product) rather than exempting the flag. |

## Evidence

- `SKIP_MOBILE=1 bash scripts/verify.sh`: 517 of 518 API tests pass. The one failure is the known container
  limitation — `contract_organisations` resolves webhook hosts through the SSRF guard and `example.com` does not
  resolve here. It passes in CI.
- lint (0 errors), `format:check`, `deps:check` (knip, 0 unused), API build, both front ends typecheck and build,
  `boot-check` green.
- Live run against the compiled build on a throwaway database: ingestion reported 7 accepted per family and then 7
  conflicts on a replay with shifted timestamps; the snapshot landed in the brief band; the three approval refusals
  answered 403, 403 and 409; the approved brief resolved with its claim and resolved to null for a channel it does
  not allow; the steering banner flipped from backlog to brief.
- Console page rendered on all five tabs at 1440 px and at 390 px: no console errors, no page errors, no horizontal
  page overflow.

## What this cycle does **not** claim

- That the scoring is right for this market. It is reproducible, not calibrated. See H-10.
- That any article produced under a brief causes anything. `ti_brief_uses` answers where an article came from and
  nothing more; incremental lift needs a control group and a mature window.
- That the module is safe to switch on today. It ships off, and `docs/LOCKED.md` records why.
