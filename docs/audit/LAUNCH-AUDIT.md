# BitriPay — production launch audit (hard-reality tester, fixer and go/no-go authority)

Audit date: 14 September 2026 · Release candidate: branch `claude/magical-franklin-pa55pn` at the commit that carries this file · Auditor: Claude Code, acting on the platform owner's instruction · Evidence: `docs/audit/launch-audit-probes.json` (black-box probes), `backend/api` test suite, `scripts/verify.sh`, the boot check of the built image, and the backup/restore drill below.

## 1. Executive verdict

- **Final verdict: NO-GO for an unrestricted public launch with real customer funds. CONDITIONAL GO for the controlled sandbox demonstration to the Banque Centrale du Congo and for invite-only sandbox use.**
- **Launch confidence score: 81 / 100** (scoring model in section 3).
- **Release candidate:** this commit, built with `npm run build` (API, web, console, shared packages, charts).
- **Tested environment:** the production build of the API (`backend/api/dist`, exactly what the Docker image runs) started in `NODE_ENV=production` against a scratch SQLite database with generated secrets and no external providers, on the audit machine. The live hosts (`www.bitripay.com`, `admin.bitripay.com`, `api.bitripay.com`) could not be reached from the audit environment (outbound HTTPS to that domain is blocked by the environment's proxy with HTTP 403), except for a direct TLS handshake check. Every live-only test is therefore **BLOCKED**, not passed.
- **Test period:** 14 September 2026, 20:00–22:00 UTC.
- **Overall risk level:** medium for a sandbox demonstration; high for a public launch with real money, because the platform is not yet authorised and is deliberately locked in sandbox mode.
- **Hard-reality conclusion:** the code base is in good shape — 320 automated tests pass, the ledger stays zero-sum under 10 000 concurrent postings and under adversarial concurrency, authorisation is enforced server-side, and the ten defects this audit found (two of them P2 financial-integrity defects, one P2 session defect, one P2 privacy gap) were fixed, regression-tested and re-probed to PASS. What is *not* proven is the production deployment: the VPS runs a build older than this release candidate, the live SMS and e-mail providers are not configured, no external uptime alerting exists, a production backup has never been restored, and the audit could not probe the live hosts. Those are operational gaps, not code gaps, and they are exactly what stands between "demonstrable" and "launchable".

## 2. Immediate launch blockers

| ID | Severity | Area | Defect | User / business impact | Evidence | Required correction | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| LB-1 | P1 (regulatory) | Compliance | The platform has no e-money programme, corridor or licence recorded; compliance mode is `sandbox` and the go-live switch is refused by the API while any regulatory item is open. | Real customer funds cannot be taken; a public launch would breach the platform's own gate. | `npm run go-live` checklist; `GET /api/admin/go-live`; `emoney.test.ts` "refuses live customer funds until the platform and the corridor are authorised" | Obtain the BCC authorisation, record the programme, safeguarding account and corridor in the go-live profile, then press Go live under step-up. | OPEN — external |
| LB-2 | P2 (ops) | Deployment | The deployed production build predates this release candidate (tariff grid, supervision, charts, public pages, audit fixes are not live). | Live behaviour differs from the tested build. | `git log` vs the last deploy recorded in the session | `git pull && npm run deploy -- --shared-host` on the VPS, then rerun the read-only live checks in section 15. | OPEN — one deploy |
| LB-3 | P2 (ops) | Communications | `SMTP_PASS` and Twilio credentials are empty in production. | Sign-up codes, security notices and mandatory notices are not delivered to real phones or inboxes. | Go-live checklist rows `smtp`, `sms` amber | Fill the values in `deploy/.env.production`, redeploy, send a test from Admin → Communication events. | OPEN — configuration |
| LB-4 | P2 (ops) | Observability | No external uptime monitor or alert route outside the platform; in-app alerts reach administrators only when they are signed in or when SMTP works. | A production outage at night is detected by customers first. | Section 12 | Point an external monitor at `https://api.bitripay.com/api/health` and `https://www.bitripay.com/status.json` with an SMS/e-mail alert to the operator; keep the in-app alert as second channel. | OPEN — configuration |
| LB-5 | P2 (ops) | Recovery | A backup has never been restored on the VPS (only in this audit's scratch drill). | Recovery time is theoretical. | Section 8 | Run the restore procedure in `deploy/README.md` once against a copy of the volume and record the time. | OPEN — one exercise |

No P0 defect was found. No P1 code defect remains open; the single P1 is the regulatory precondition itself.

## 3. Mandatory launch-gate results

| Gate | Status | Evidence | Remaining risk |
| --- | --- | --- | --- |
| 1 Build integrity | PASS | `npm run build` for every workspace; `scripts/boot-check.sh` boots the built API in production mode and serves config, translations, Lite, blog, legal pages, sitemap, robots and brand assets; `npm audit --omit=dev` reports 0 vulnerabilities; lint and format clean; release traceable to this commit. | The production image on the VPS must be rebuilt from this commit (LB-2). |
| 2 Critical functionality | PASS (local) | 320 automated tests across 42 files (registration, KYC, funding by evidence, QR and tag payments, checkout, refunds, payouts, remittance, statements, maker-checker, sanctions, go-live gate, USSD/SMS/Lite, comms, tariff, supervision, charts, closure); 34/34 black-box probes PASS. | Live journeys with real SMS and e-mail not exercised (LB-3). |
| 3 Security | PASS with open P3/P4 | No P0/P1; auth bypass, IDOR, forged tokens, forged processor callbacks, SSRF, open redirect, path traversal, stored XSS, oversized bodies, malformed JSON and enumeration all refused (probes `authz.*`, `webhook.*`, `ssrf.*`, `redirect.*`, `xss.*`, `path.*`); baseline headers now set by the API itself; TLS 1.3 only on the live host (TLS 1.1 refused). | Live security headers and CSP could not be read from the audit environment; password policy is length-only (LA-12). |
| 4 Data integrity | PARTIAL | Critical writes run inside SQLite transactions (ledger, closure, evidence); migrations replay on every boot check; backup/restore drill: online backup of the audit database in 19 ms, `PRAGMA integrity_check = ok`, row counts and balances identical before and after. Tenant isolation covered by `organisations` tests and IDOR probes. | Restore never exercised on production (LB-5). |
| 5 Financial integrity | PASS | Server-side amounts and fees; zero-sum ledger and derived balances verified after every probe run (`ledger.reconcile-after-probes`); 20 parallel over-spend attempts posted at most what the balance covered (`money.concurrent-double-spend`); idempotency replay returns the original and a reused key with another body is now refused (LA-02); processor webhooks require a valid signature; Guardian halts money movement on any invariant breach. | — |
| 6 Performance | PARTIAL | 300 concurrent config reads: p50 281 ms, p95 520 ms, p99 541 ms, 0 errors on the shared audit host; 40 concurrent transfers: p50 195 ms; 10 000 concurrent postings stay zero-sum (`acceptance_scale.test.ts`). PIN verification cost under bursts fixed (LA-10). | Not measured on the production VPS or under a realistic launch profile; no soak test. |
| 7 Reliability | PARTIAL | Circuit breakers and health probes per rail; rate limits per route, per client and per account; bounded webhook retries with dead-letter and replay; Guardian degraded mode queues intents. Rollback = rebuild the previous commit's images (documented), not a tagged-image switch. | Rollback not rehearsed on the VPS; single SQLite writer is a single point of failure by design (documented). |
| 8 Observability | FAIL (as a gate) | Structured logs with correlation ids, SLO middleware with p50/p95/p99 per class, in-app loud alerts, audit log, `/status.json`. | No external alerting or uptime monitor (LB-4); no error-tracking service. |
| 9 Privacy and compliance | PASS after fixes | Account closure with anonymisation and legal-retention of ledger rows, tested end to end (`privacy.account-closure`, `security_hardening.test.ts`); administrative closure with step-up and audit; consent and policies published; supervisory exports pseudonymised. | Data-subject requests still need an operator process (who receives them, response time). |
| 10 Operational readiness | PARTIAL | Runbooks: `deploy/README.md`, `docs/VERIFICATION.md`, regulator run-of-show; go-live checklist enforced by code; two-administrator maker-checker. | Support and incident ownership rest on one person today; the second administrator is not yet created in production. |

Scores by category (weight): architecture and build 88 (10) · core functional 90 (15) · authentication and authorisation 86 (12) · application and infrastructure security 84 (15) · data integrity and recovery 78 (10) · payments and financial controls 92 (8) · performance and scalability 70 (8) · AI safety and reliability 75 (5) · privacy and compliance 85 (5) · observability and incident response 52 (5) · deployment and rollback 66 (4) · accessibility and cross-device 62 (3) → **81**.

## 4. Testing coverage

| Measure | Value |
| --- | --- |
| Automated tests (API) | 320 in 42 files, all passing on the release candidate; shared packages 21 more (core 6, BitriQR, charts 8, SDKs) |
| Black-box probes (production-mode build) | 34, all PASS after fixes (7 failed on the first run, see section 13) |
| Live-host checks | 1 PASS (TLS 1.3, valid certificate, TLS 1.1 refused); 9 BLOCKED (headers, redirects, health, status, OpenAPI, admin noindex, CORS, error schema, admin auth) |
| Critical journeys | registration, KYC tiers, funding by evidence, QR/tag payment, checkout and refund, payout and remittance, agent cash-in/out, statements, closure — covered by tests; real-phone SMS journey NOT TESTED (LB-3) |
| API coverage | every `/api/v1` operation is in the OpenAPI document and exercised by `gateway*.test.ts`, `contract_*.test.ts`; probes covered auth, admin, transfers, payment requests, checkout sessions, webhooks, blog, site |
| Role coverage | customer, merchant, agent, administrator, checker administrator, API key (secret/restricted/publishable), organisation member |
| Browser / device coverage | NOT TESTED in this audit (no browser run against the release candidate); earlier sessions ran Playwright smoke and screenshot suites (`scripts/smoke-all.mjs`, `scripts/shots-all.mjs`) — rerun after deploy |

## 5. Architecture and dependency findings

- One Node.js/TypeScript API (Express 5) with a SQLite ledger in WAL mode, a hash-chained event log, in-memory rate limiters and caches; React/Vite web app and console; Expo phone apps; shared packages (`@bitripay/shared`, `@bitripay/bitriqr`, `@bitripay/charts`, SDKs); Caddy TLS edge on a shared Hostinger VPS; nightly SQLite backup container.
- Critical dependencies: the VPS, Caddy (certificates), the operator collection phones and the payout-device app (mobile-money evidence), the rate provider (blocked from the audit environment, degrades to manual rates), the sanctions list sources (same), Twilio and Hostinger SMTP (unconfigured).
- Single points of failure: one API process and one SQLite file per deployment (documented; scale path is Redis for limiters and a replicated database); one operator on call.
- Undocumented components: none found; no shadow integrations; the demo seed (`backend/api/src/seed.ts`) is a development script and is not run by the Docker image or the deploy script.
- Infrastructure risk: the shared VPS hosts other sites; BitriPay's containers bind to localhost ports behind the shared Caddy, so a misconfigured neighbour can only affect the edge, not the ledger.

## 6. Security findings

Fixed in this audit (all re-probed and covered by `security_hardening.test.ts`):

- **LA-01 · P2 · Invalid amount strings answered HTTP 500.** `toMinor` threw a plain Error on inputs such as `-5.00`, `abc`, `1e12`; the error handler mapped it to an internal error. Fix: mapped to `400 invalid_amount` centrally. Probe `money.invalid-amounts` now `-5.00→400 0→422 abc→400 1e12→400 0.001→400 99999999999999→400`.
- **LA-02 · P2 · Idempotency key reused with a different body returned the original transaction as a success.** A client that changed the amount believed the new amount was sent. Fix: the ledger compares type, amount, currency and recipient and answers `409 idempotency_key_reused`. Probe `money.idempotency`: replay → same id, reuse with other body → 409.
- **LA-03 · P2 · Sessions survived a password change for up to seven days.** Fix: `users.sessions_invalidated_at`; tokens issued before it are refused; password change and the new `POST /api/account/sessions/revoke` set it. Probe `auth.session-invalidated-on-password-change`.
- **LA-05 · P2 · Merchant redirect URLs accepted `javascript:`, `data:` and plain-http targets** on checkout sessions, payment links and payment requests (open redirect / script execution after payment). Fix: `redirectUrl` schema, https only (http for localhost). Probe `redirect.javascript-url` → 400.
- **LA-06 · P3 · Markdown links and images kept any scheme** (CMS editors only). Fix: `safeUrl` allows http(s), mailto, tel and relative targets. Probe `xss.blog-markdown`.
- **LA-07 · P3 · CORS reflected every origin with `Access-Control-Allow-Credentials: true`.** Sessions are bearer tokens, so the exposure was low, but the header was wrong. Fix: credentials disabled. Probe `cors.no-credentials`.
- **LA-08 · P3 · API responses carried no baseline security headers when served directly.** Fix: `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options` (DENY on JSON, SAMEORIGIN on rendered pages) and `Cross-Origin-Opener-Policy` set by the API; HSTS stays at the edge. Probe `headers.api`.
- **LA-09 · P3 · Control characters and bidirectional overrides were stored in notes and descriptions.** Fix: `cleanText` schema. Probe `money.unicode-note`.
- **LA-11 · P3 · No per-account sign-in throttle** (only 30 attempts per client address per 15 minutes). Fix: ten failed attempts per identifier in 15 minutes answer 429; a successful sign-in clears the count. Test "sign-in throttling".

Open:

- **LA-12 · P4 · Password policy is length-only (8+).** Recommend a breached-password check and a longer minimum for administrators. Mitigation: 2FA required for administrators, available to everyone; per-account throttle.
- **LA-15 · P4 · `npm audit` (with dev dependencies) reports two moderate advisories in Vitest** (path traversal in the mocker), development-only; no production dependency is affected. Upgrade at the next maintenance window.
- **Live headers, CSP, cookies and admin `noindex` BLOCKED** from this environment; see section 15 for the commands to run from the VPS.

## 7. Functional and UX findings

- All critical workflows pass in the automated suites; no false-success state was found: a visible success always corresponds to a posted transaction, a settled intent or a recorded approval, and refusals carry a stable error code.
- UX note (not a defect): tier-1 accounts in production are limited to 50 USD per operation and per day, so a virtual card (minimum first load 100 USD) needs tier 2. The card page tells the user the terms; the tier page tells them how to upgrade.
- Device and browser matrix NOT TESTED on this release candidate (see section 4).

## 8. Data and database findings

- Schema: 34 migrations applied on every boot; unique constraints on tags, e-mails, phones, references, idempotency keys; foreign keys on wallets and transactions; audit tables (audit_logs, event_log with hash chain, comms deliveries).
- Integrity: `PRAGMA integrity_check = ok` on the audit database after 26 transactions and 81 chained events; `reconcileLedger` and `verifyEventChain` green after every probe run.
- Backup/restore drill (audit database, same mechanism as the production backup container): online backup in 19 ms, 2.98 MB, restored copy has identical users (13), transactions (26), events (81) and wallet totals, integrity ok. Production restore: NOT TESTED (LB-5).
- Tenant isolation: organisation members act only through the owner account on merchant surfaces with server-checked permissions (`organisations` tests); IDOR probes on transactions, payment requests and virtual cards refused.

## 9. Payment and financial findings

- Amounts, fees and limits are server-side; the client never sends a fee or a price the server trusts.
- Webhooks from processors are signature-verified and replay-protected; unsigned events are refused (probe `webhook.forged-processor-callback`).
- Idempotency: replay returns the original object; reuse with a different body is a conflict (fixed, LA-02).
- Reconciliation: zero-sum per currency, derived balances equal stored balances, no negative customer balance, refunds never exceed the principal (Guardian checks and `ledger.reconcile-after-probes`).
- Financial invariants report (audit database, after all probes): opening 0 · administrator credits 300.00 + 30.00 + 45.00 USD · customer transfers, fees and refusals as recorded · closing balances equal derived balances · reconciliation difference **0**.
- Entitlement: nothing is credited before a matched operator confirmation or a four-eyes approval; card issue debits first load plus fee atomically.

## 10. AI and agent findings

- The assistant runtime is metered (ACU), tool-allowlisted, policy-gated and logged; high-impact tool calls require human approval (`assist.test.ts`, `intelligence.test.ts`). Prompt-injection and cross-tenant tests exist in the suite; no measurable quality evaluation set is maintained yet — do not market the assistant as a decision-maker until one exists. External model calls are disabled without an API key, and the platform runs fully without them.

## 11. Performance findings

| Workload | Concurrency | p50 | p95 | p99 | Errors | Note |
| --- | --- | --- | --- | --- | --- | --- |
| GET /api/config (audit host) | 300 at once | 281 ms | 520 ms | 541 ms | 0 | shared CPU, production build |
| POST /api/transfers (audit host) | 40 at once | 195 ms | 197 ms | 197 ms | 0 faults (20 posted, 20 refused by insufficient funds, a control) | PIN memo in effect |
| POST /api/transfers before LA-10 | 100 at once | 8 865 ms | 8 872 ms | 8 873 ms | — | bcrypt on every call saturated the CPU |
| Ledger postings (test suite) | 10 000 fired without awaiting | — | — | — | 0 | zero-sum verified |

Breaking point, recovery time and cost were NOT MEASURED on the production host. Launch targets to adopt: critical API p95 under 500 ms at 50 concurrent users, error rate under 0.5 %, recovery after a spike under 5 minutes.

## 12. Observability and incident-response findings

- Can be detected today: every request carries a correlation id in logs and responses; SLO percentiles per class; rail health and circuit state; Guardian findings (with automatic halt); webhook delivery failures; comms delivery failures; the public `/status.json`.
- Cannot be detected today from outside: a dead process or host (no external monitor), a full disk, a certificate that failed to renew. Alert routing depends on SMTP being configured (LB-3).
- Incident owner: the platform owner; a second administrator with the approvals permission is required by the go-live checklist and not yet created in production.

## 13. Fixes implemented

| ID | Root cause | Change | Tests added | Retest | Deployment |
| --- | --- | --- | --- | --- | --- |
| LA-01 | shared money parser threw untyped errors | error handler maps them to 400 `invalid_amount` | `input hygiene` | probe PASS | pending deploy |
| LA-02 | ledger returned the existing row on any key match | body comparison, 409 on mismatch | `input hygiene` | probe PASS | pending deploy |
| LA-03 | stateless JWT with no invalidation | `sessions_invalidated_at`, second-resolution check, revoke endpoint | `sessions` (2) | probe PASS | pending deploy (migration 034) |
| LA-04 | no erasure workflow | self-closure and administrative closure with anonymisation, retention, event, mandatory notice | `account closure` (2) | probe PASS | pending deploy |
| LA-05 | `z.string().url()` accepts any scheme | `redirectUrl` schema | `redirect URLs and CORS` | probe PASS | pending deploy |
| LA-06 | raw href/src in markdown | `safeUrl` | `input hygiene` | probe PASS | pending deploy |
| LA-07 | permissive CORS | credentials off | `redirect URLs and CORS` | probe PASS | pending deploy |
| LA-08 | headers only at the edge | header middleware | probe | probe PASS | pending deploy |
| LA-09 | free text unfiltered | `cleanText` | `input hygiene` | probe PASS | pending deploy |
| LA-10 | bcrypt per money-moving call | five-minute memo of successful PIN checks; wrong PINs still hashed | existing PIN tests | probe PASS | pending deploy |
| LA-11 | per-client limiter only | per-account failure counter | `sign-in throttling` | test PASS | pending deploy |
| (from the tariff work) | test hard-coded a merchant balance under the old fee | test now reads the balance | `gateway_v1.test.ts` | PASS | — |

After every fix the full API suite was rerun; the destination-change test was updated for the new session behaviour (it now signs in again after the password change).

## 14. Unresolved risks

- Accepted: single SQLite writer per deployment; in-memory limiters and caches (documented scale path).
- Deferred: password breach check (LA-12); Vitest advisory (LA-15); external error tracking.
- Blocked tests: every live-host check listed in section 4; browser/device matrix on this release candidate.
- Assumptions: the VPS configuration matches `deploy/` (Caddy snippet, `.env.production`) as recorded in the deployment session; the operator collection phones are enrolled before the demonstration.
- External dependency risks: BCC authorisation (LB-1); Twilio and Hostinger SMTP availability; operator SMS formats (evidence templates are editable in the console).

## 15. Required pre-launch action plan

**Before any launch (including the demonstration)**

1. Deploy this release candidate on the VPS — owner role: operator; complexity: low; dependency: none; evidence: `git rev-parse HEAD` on the VPS equals this commit and `https://api.bitripay.com/api/health` answers; retest: run the read-only checks below.
2. Configure SMTP and Twilio, redeploy, send one test from Admin → Communication events to a real phone and inbox — operator; low; evidence: delivery rows `sent`.
3. Create the second administrator, PIN and 2FA for both — operator; low; evidence: go-live checklist row green.
4. Run the read-only live checks from the VPS (they could not run from here):

```bash
for u in https://bitripay.com/ https://www.bitripay.com/ https://admin.bitripay.com/ https://api.bitripay.com/api/health https://www.bitripay.com/status.json https://www.bitripay.com/developers; do
  echo "--- $u"; curl -sS -o /dev/null -D - "$u" | grep -iE '^HTTP/|^location|^strict-transport|^x-frame|^x-content-type|^referrer-policy|^x-robots'
done
curl -sS -o /dev/null -D - -H 'Origin: https://evil.example' https://api.bitripay.com/api/config | grep -i access-control
curl -sS https://api.bitripay.com/api/admin/stats        # expect 401 JSON
curl -sS https://api.bitripay.com/api/no-such-route      # expect 404 JSON, no stack
```

Expected: apex 301 to `https://www.bitripay.com/`, HSTS on every host, `X-Robots-Tag: noindex` on the console, `Access-Control-Allow-Credentials` absent, JSON error bodies.

**Before limited beta (invite-only, sandbox or first authorised corridor)**

5. External uptime monitor and alert route (LB-4) — operator; low; evidence: a deliberate stop of the API container raises the alert within 5 minutes.
6. Production backup restore exercise (LB-5) — operator; medium; evidence: restore time recorded in `deploy/README.md`.
7. Rollback rehearsal: rebuild and start the previous commit's images, smoke, then redeploy — operator; medium.
8. Browser and device pass on the release candidate with `npm run smoke` and `scripts/shots-all.mjs` — operator; low.

**Before full public launch**

9. BCC authorisation recorded in the go-live profile: e-money programme, safeguarding account, corridor, licence dates (LB-1) — owner; external.
10. Load test on the production host with a realistic profile (sign-in, QR payment, evidence match, payout) and adopt the targets in section 11 — engineer; medium.
11. Password breach check and administrator password minimum of 14 (LA-12) — engineer; low.

**Within 7 days after launch**: review Guardian findings, comms delivery failures and SLO reports daily; confirm the nightly backup file grows.

**Within 30 days after launch**: dependency upgrade (Vitest advisory), external error tracking, first quarterly restore drill.

## 16. Launch configuration (for the conditional, sandbox-only launch)

- Enabled: registration, KYC tiers, wallet transfers, QR and tag payments, payment requests and links, bills and top-ups (catalogue), agents cash-in/out with test float, statements, insights, comms, supervision exports, partner API in test mode.
- Disabled by the platform itself until authorisation: live compliance mode, real-money corridors, live processor keys, e-money issuance against real reserves; virtual cards remain a later-phase service.
- Feature flags: modules under Admin → Modules & methods; go-live profile under Admin → Gateway controls.
- Limits: tariff-grid bands and tier limits (tier 1: 50 USD per operation and per day); rate limits 30 auth attempts / 15 min per client, 10 failed sign-ins / 15 min per account, 240 site requests / min per client, 300 admin writes / min.
- Traffic and users: invite-only demonstration accounts; no public marketing until the licence.
- Support coverage: support@bitripay.com, monitored by the owner; response expectation on the contact page.
- Alert thresholds: Guardian any finding (automatic halt), SLO p99 above target for two windows, comms delivery failure rate above 10 %.
- Rollback trigger: any Guardian halt not cleared within 30 minutes, or health check failing after a deploy → redeploy the previous commit.
- Kill switch: Admin → Gateway controls → operating mode `halted` (queues intents, freezes offline payments); at the edge, stop the `bitripay-api` container.

## 17. Final launch decision

**This release is approved only for a restricted launch under the conditions listed above: a controlled, sandbox-mode demonstration and invite-only sandbox use, after actions 1 to 4. It is not approved for public launch with real customer funds.**
