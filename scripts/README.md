# Scripts

- `e2e-web.mjs` / `e2e-admin.mjs` – Playwright smoke flows used to verify the web app and admin panel
  against a seeded local API (`npm run dev` + `npm run seed`). Run with `node scripts/e2e-web.mjs`
  after `npm i -D playwright` (set `CHROME_PATH` to use a system Chromium).

- `smoke-all.mjs` – the full live smoke (`npm run smoke`): public site, user, merchant and agent flows, every admin
  console, BitriPay Lite without JavaScript, and the partner API. Needs `npm run dev` (API + web + admin) against a
  seeded database (`npm run seed`); uses `playwright-core` from the root workspace and a system Chromium
  (`CHROME_PATH`). Screenshots and `results.json` land in `shots/smoke/`.
- `verify.sh` – `npm run verify`: builds and tests shared, backend and frontend from a clean checkout (CI runs it).
