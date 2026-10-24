# Cycle 1 — RC a12964b

## Phases executed

6.0 access & safety · 6.1 truth audit · 6.2 partial architecture reconstruction · 6.4 build & release integrity
(reused this session's evidence) · 6.8 partial (module switch enforcement) · 6.14 partial (34 probes, CSP).

## Fixed

| ID | Defect | Fix | Retest |
|---|---|---|---|
| LA-001 | "KYC verification" switch enforced in the web interface only | `requireModule('kyc')` on the mount | 422 `module_disabled` on GET and POST |
| LA-002 | "Referral system" switch enforced nowhere; rewards paid from the treasury with the programme off | `referralsOn()` guard at all three service entry points; `enabled` reported to callers | no attribution, no payout, history still readable |
| LA-003 | The same class could recur silently | source sweep in `module_switches.test.ts` | fails on any console flag without a server-side reader |

## Newly broken

None. 444 of 445 API tests pass (the single failure is the webhook SSRF guard needing public DNS this sandbox
lacks — unchanged since before this cycle, reproduces on a clean tree). Knip clean, prettier clean, audit clean,
one pre-existing ESLint warning in the payout-device app.

## Remaining

Everything in `human-actions.md`, plus the novice value test (E-13), accessibility (E-21) and the
browser/device matrix (E-22), which are not access-blocked — only unstarted.

## Gate delta

Gate 2 (truth & fitness for purpose) moved from unknown to **PARTIAL**: every claim now traces to an enforced code
path, but the novice value test has not been run, so the second half of the gate is unearned.
No gate moved to PASS that was not already proven by execution.
