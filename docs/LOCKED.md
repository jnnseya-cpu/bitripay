# Locked invariants

What must not silently change or drop, and the guard that fails if it does. Every row names a test or gate that
runs in CI — nothing here relies on anybody remembering it.

Stabilised at `2185c85` (CI run 100, green), verified again on this branch before the lock was added.

## How to use this

If you are about to change something on this list, that is fine — change it deliberately and update the row. The
point is that you cannot change it *by accident*, and that nobody has to take an earlier session's word for it.
A guard with no test is a comment, so each row below has one, and each was mutation-tested: the invariant was
broken on purpose and the named guard was confirmed to fail.

## Money, ledger and controls

| Invariant | Guard |
| --- | --- |
| Postings balance per currency at write time; an unbalanced transaction is refused, not written and corrected | `ledger.test.ts`, `guardian.test.ts`; reconciliation probe in `scripts/launch-audit.mjs` |
| Balances are derived from entries, never stored — no administrator can set one | ledger suites; `launch-audit.mjs` probe `ledger.reconcile-after-probes` |
| E-money is not issued beyond cleared safeguarded funds; the rule refuses rather than warns | `emoney.test.ts`, `safeguarding` suites |
| Sanctions screening runs inside the posting, before entries are written | `launch-audit.mjs` probe set (`authz.*`, `money.*`); `sanctions_sources.test.ts` |
| Every module flag the console offers is read somewhere on the server | **`module_switches.test.ts`** — walks the whole server source; a new switch with no reader fails the suite |
| KYC and referral switches are enforced server-side, not only in one interface | `module_switches.test.ts` |
| Credential values never leave the server; the mask round-trips without erasing a key; writes are step-up protected and audited by key | `credentials.test.ts` |

## Security posture

| Invariant | Guard |
| --- | --- |
| Content-Security-Policy on everything the API serves, `script-src 'self'` with no `'unsafe-inline'` | `csp.test.ts` |
| No executable inline script in server-rendered HTML (only `application/ld+json`, which browsers do not run) | `csp.test.ts` |
| Hosted checkout is framable by a merchant: `/checkout*` carries `frame-ancestors https:` and **no** `X-Frame-Options` | `csp.test.ts` (API) and **`locked.test.ts`** (edge and web image) |
| No deployment config re-imposes same-origin framing on the host serving `/checkout` | **`locked.test.ts`** — covers the dedicated Caddyfile, both shared-host snippets, and the host-level nginx and apache configs |
| Production refuses the sample admin password and short secrets | `hardening.test.ts`; verified empirically against the compiled build |
| Webhook destinations are SSRF-guarded (localhost, link-local and private ranges refused) | `contract_organisations.test.ts`; `launch-audit.mjs` probe `ssrf.webhook-endpoint` |

Checkout framing deserves a note, because it is the one invariant whose guard is not obvious. In production that
page is static files served by the web image behind a proxy, so the API never touches the response and the API's own
CSP tests cannot see it. `www` proxies to that image in all four deployment shapes — the dedicated Caddyfile, both
shared-host Caddy snippets, and the host-level nginx/apache configs — which is why the rule lives in the image and
is asserted there. Before the fix, `X-Frame-Options: SAMEORIGIN` at the edge meant every cross-origin embed was
refused by the browser before it rendered, and nothing caught it: the SDK's unit tests only exercise the pure URL
and message helpers and never load a page.

## Runtime and dependencies

| Invariant | Guard |
| --- | --- |
| Node floor is a patch version, not just a supported line (22.23.4 / 24.22.1 / 26.12.1); `engines.node` matches the constant; every Dockerfile builds on a supported line | `runtime.test.ts` |
| `scripts/deploy.sh` builds with `--pull`, so an upstream security release reaches production on the next deploy | `runtime.test.ts` |
| zod ≥ 4.6.7, body-parser ≥ 2.4.0, nodemailer ≥ 10.2.1 — in the lockfile **and** in the declared range | **`locked.test.ts`** |
| No production dependency with a high-or-worse advisory | `npm audit --omit=dev --audit-level=high` in CI |

The dependency floors are not redundant with `npm audit`. The audit gate gives way at `--audit-level=high`, and the
nodemailer advisories are *moderate* — a downgrade into their range would pass CI silently. The declared range is
checked as well as the lockfile, because a lockfile can be regenerated: a fix that holds only until someone runs
`npm install` on a clean checkout is not a fix.

## Product surface

| Invariant | Guard |
| --- | --- |
| 41 features, each tracing to an enforced code path; every module flag covered by some feature | `features.test.ts` |
| Availability is computed from live module state, never asserted in prose | `features.test.ts` — a test forbids the copy from claiming availability at all |
| French is complete for all 41 features, with nothing falling back to English | `features.test.ts` (`missingTranslations`) |
| No dead files, duplicate exports, or unused/unlisted dependencies | `npm run deps:check` (knip) in CI |
| The suite does not rot with the calendar: no test or service window gives a different answer because of today's date | **`npm run test:clock -w @bitripay/api`** with `CLOCK_FORWARD_DAYS` — run it before trusting a green suite after a quiet period |
| Formatting and lint are uniform | `npm run format:check`, `npm run lint` in CI |

## Calendar drift

This platform has produced the same defect three times, and all three passed CI the day they were written:

1. The open-banking income confidence moved between medium and high depending on the day of the month, because the
   statement generator used a rolling 180-day window that contained five or six salary dates.
2. The CSV fixture in the same suite was written with absolute months and slid out of the six-month window as the
   calendar advanced — four detected salary months instead of five, two weeks after the suite was last green.
3. `verifyIncome` kept a rolling **190-day** window after the generator was anchored, so the two disagreed and
   `monthsCovered` reported 6 on most days and 7 on others. A `reviewDate` of `2027-01-31` in the SLA suite reported
   itself overdue once that date passed.

None of these is a test problem. Each was a service computing a window from "now" in a way whose answer depended on
where in the month "now" fell. The rule that comes out of it: anchor a window to a calendar boundary, never to a
count of days, and write fixtures relative to the current date unless the test needs a date to be in the past.

`npm run test:clock -w @bitripay/api` runs the whole suite with `Date` shifted forward by `CLOCK_FORWARD_DAYS`, so a
fixture or window that will break in six months breaks now instead. The suite was verified at +0, +14, +45, +75,
+100, +140, +200, +260, +330 and +400 days. It is not in CI, because it doubles the run time for a class of defect
that appears monthly rather than per commit; run it after a quiet period, or when touching anything that reads a
date.

## Not locked, because it is not verified

These are recorded so the gap is visible rather than assumed closed. Detail and owners are in
`launch-audit/human-actions.md`.

- Load, stress and soak behaviour, failure injection, alert delivery, the backup restore drill and the
  deploy-and-rollback drill: all need a reachable environment this session has never had.
- The novice value test — a first-time user reaching the core promise unaided on a phone — is **not tested**.
- Real payment-provider webhook signatures, idempotency and pending-state behaviour: sandbox credentials needed.
- Accessibility (WCAG 2.2 AA) and the cross-browser/device matrix.
- Both administrator accounts still have no second factor; one has no PIN.

A reminder that applies to the whole file: these guards prove the platform still behaves as it did when it was
verified. They do not prove it is safe to launch. The verdict in `launch-audit/` is unchanged.
