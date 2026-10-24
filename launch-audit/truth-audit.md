# Truth audit — does the product do what it claims?

RC `a12964b` · method: every public claim traced to an enforced code path, then executed.
Claim source: the 41-entry feature catalogue (`backend/api/src/content/features.ts`), the server-rendered
marketing pages, `README.md` and `docs/PLATFORM.md`.

## Method

For each claimed capability: find the module flag it declares, then prove enforcement exists either as route
middleware (`requireModule('<flag>')`) or as a service-layer guard throwing `module_disabled`. Machine-readable
output: `evidence/feature-trace.json`.

## Result

| Status | Count | Notes |
|---|---|---|
| REAL — enforced code path proven | 39 | 18 infrastructure (no flag, always on) + 21 flag-gated with enforcement found |
| BROKEN — claim real, control over it was not | 2 | `kyc`, `referrals` — see defects LA-001 / LA-002. **Fixed this cycle.** |
| STUBBED | 0 | |
| ABSENT | 0 | |

15 of the 41 are deliberately switched off under the aggregator perimeter and the product says so: the feature
pages compute availability from live module state and render *awaiting authorisation* rather than selling them as
running. That is honest presentation, not a stub, and there is a test forbidding the prose from asserting
availability at all.

## Stub-pattern sweep — all negative

Searched for every pattern a fake feature leaves behind:

- artificial `setTimeout` progress in app code: **none**
- `<button>` with no handler: **none**
- `TODO` / `FIXME` / `HACK` / `XXX` in non-test source: **zero**
- lorem ipsum, `your_api_key`, `sk_test_123`, dummy data in app code: **none**
- dead files, duplicate exports, unused/unlisted dependencies (knip, all reporters): **zero across 9 workspaces**

## What this audit does NOT cover

The value test in 6.1 — "can a novice reach the core value promise unaided, on a phone, in under 10 minutes" —
is **NOT TESTED**. It needs the web app driven in a throttled mobile browser against a running stack. Until it is
run, no claim about fitness for purpose for a first-time user is earned. This is the largest open gap in the audit
and it is not blocked by access: it is blocked by time.
