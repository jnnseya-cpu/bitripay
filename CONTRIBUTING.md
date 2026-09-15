# Contributing to BitriPay

BitriPay is one repository with three layers that only meet through published packages and HTTP:

| Layer | Path | Talks to |
| --- | --- | --- |
| Backend | `backend/api` | `@bitripay/shared`, `@bitripay/bitriqr`, SQLite, payment rails |
| Frontend | `frontend/web`, `frontend/admin`, `frontend/mobile`, `frontend/payout-device` | the HTTP API and the shared packages |
| Shared | `shared/core`, `shared/bitriqr`, `shared/sdk-*` | nothing above them |

A frontend never imports backend code and the backend never imports a frontend. Keep it that way.

## Before you open a pull request

```bash
npm run verify        # lint → shared build/tests → backend typecheck/build/tests → web + admin typecheck/build → mobile + payout device
npm run smoke         # optional: 51 live checks against a running `npm run dev` with the seeded database
```

`npm run verify` is exactly what CI runs. `npm run format` applies Prettier; `npm run deps:check` (knip) reports unused files, exports and dependencies.

## Rules that are not negotiable

1. **Nothing existing is removed.** Features are added or enhanced. If a change must retire behaviour, it keeps the old path working and documents the migration.
2. **No placeholders, no fake data presented as live.** A screen that cannot yet show real data says so. A successful screen is not proof of payment: only a settled ledger posting is.
3. **Money is integers in minor units.** Never floats. Every posting goes through the double-entry ledger and balances by construction.
4. **No "unhackable", "bank-grade security guaranteed" or similar claims** in copy, docs or commit messages. Describe the control that exists (signed QR, step-up, maker-checker, encrypted at rest) and the residual risk.
5. **Every requirement has a test or a smoke check.** New backend behaviour ships with a Vitest suite under `backend/api/src/tests`; new pages ship with a smoke flow in `scripts/smoke-all.mjs`.
6. **Secrets never enter the repository.** `backend/api/.env.example` documents every variable; production refuses to start with development defaults.
7. **The brand is BitriPay.** Internal names (PAYRAIL, BitriQR, KODA, Sentinel) stay in code and docs, never in customer-facing copy.
8. **Providers are never disclosed to end customers.** Receipts and API responses name the rail category, not the processor.

## Coding conventions

- TypeScript strict everywhere; loosely typed database rows are acceptable at the SQLite boundary, nowhere else.
- One file per bounded concern under `backend/api/src/services`; routes stay thin and validate with zod.
- Shared helpers (`money`, `phone`, `countries`, `locales`) live in `shared/core`; do not re-implement them in a layer.
- Locale packs must carry every English key with the same placeholders (`shared/core/src/shared.test.ts` enforces it).
- Commit messages describe the behaviour change, not the files touched.

## Reporting a security issue

Email support@bitripay.com (subject "Security") with reproduction steps. Do not open a public issue for vulnerabilities.
