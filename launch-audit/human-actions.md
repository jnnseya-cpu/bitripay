# Human Action List

Each item blocks a gate and cannot be completed from this session. The moment one is supplied, the loop resumes
at the named phase.

| # | Item | Owner role | Why it blocks | What I do when it exists |
|---|---|---|---|---|
| H-1 | A reachable staging environment with production-like data volume | Platform owner / VPS admin | Production is unreachable from this session (egress refuses `*.bitripay.com`). Gates 7 (performance), 8 (reliability), 9 (observability) and the deployed-build check in §8 cannot be earned against a stack I cannot reach. | Run phases 6.16 load/stress/soak, 6.20 failure injection, 6.19 alert-firing drills, and the deploy→smoke→rollback→redeploy drill in 6.21. |
| H-2 | Deploy RC `a12964b`+ to the VPS | VPS admin | §7 gate: "the deployed build differing from the tested build" is an automatic NO-GO. Everything verified here was verified on a local build. | Re-run the 34 probes and the smoke suite against the real origin and confirm parity. |
| H-3 | Monitoring / alerting credentials, or a decision to install it | Platform owner | Gate 9 requires proving alerts fire and reach a named person. I cannot verify what I cannot see. If none exists, installing it is a fix I can do — but it needs a destination (email, webhook) and that is yours. | Configure, trigger controlled failures, prove each alert fires with useful context. |
| H-4 | Payment-provider sandbox credentials (6 providers referenced in `.env.example`, no keys present) | Platform owner | Gate 6 (financial integrity) is proven here only against the internal ledger and the sandbox rail. Real provider webhook signatures, idempotency semantics and pending-state behaviour are untested. | Run phase 6.12 in full, including duplicate/forged/out-of-order webhooks and the mobile-money pending cases. |
| H-5 | Legal sign-off on terms, privacy, cookies, refund policy and AI disclosures | Owner + legal | Gate 10. I can draft and correct copy; I cannot approve it. | Apply approved copy and re-run the 6.22 legal-surface check. |
| H-6 | Decision on checkout framing | Platform owner | `/checkout*` now allows `frame-ancestors https:` so the embed SDK works at all. Any https site can frame the payment page. The stronger design is a per-merchant origin allowlist. | Implement the allowlist (needs checkout served by the API rather than static nginx). |
| H-7 | 2FA on both administrator accounts; a PIN on the second | Platform owner | Gate 4 / 6.8. Two administrators with no second factor is the single highest-value credential target on the platform. | Nothing — this is a console action only you can take. |
| H-8 | Confirmation that domain, DNS, VPS and every third-party account is owned by the organisation, not an individual | Platform owner | Gate 11 (operational readiness) explicitly requires organisational ownership and documented emergency admin access. | Record it in the audit and close the gate. |
| H-9 | A BCC authorisation decision, or confirmation to stay inside the aggregator perimeter | Owner / regulator | 15 of 41 features are deliberately off awaiting authorisation. Scope of any launch depends on this. | Adjust the launch configuration and re-score. |
