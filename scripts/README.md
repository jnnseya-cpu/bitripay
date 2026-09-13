# Scripts

- `e2e-web.mjs` / `e2e-admin.mjs` – Playwright smoke flows used to verify the web app and admin panel
  against a seeded local API (`npm run dev` + `npm run seed`). Run with `node scripts/e2e-web.mjs`
  using `playwright-core` from the root workspace and a system Chromium (`CHROME_PATH`, default `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`).

- `smoke-all.mjs` – the full live smoke (`npm run smoke`): public site, user, merchant and agent flows, every admin
  console, BitriPay Lite without JavaScript, and the partner API. Needs `npm run dev` (API + web + admin) against a
  seeded database (`npm run seed`); uses `playwright-core` from the root workspace and a system Chromium
  (`CHROME_PATH`). Screenshots and `results.json` land in `shots/smoke/`.
- `verify.sh` – `npm run verify`: builds and tests shared, backend and frontend from a clean checkout (CI runs it).
- `e2e-corridor.mjs` – UK card → Orange Money DRC corridor flow through the demo payout device. The device's private
  key is only kept on disk when the seed runs with `SEED_WRITE_DEVICE_KEY=1` (`backend/api/data/demo-payout-device.json`,
  mode 0600, never committed).
- `npm run docs:http` – regenerates `docs-api.http` from the served OpenAPI table; `npm run format` / `format:check`
  run Prettier; `npm run deps:check` runs knip for unused files, exports and dependencies.
