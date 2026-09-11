# Scripts

- `e2e-web.mjs` / `e2e-admin.mjs` – Playwright smoke flows used to verify the web app and admin panel
  against a seeded local API (`npm run dev` + `npm run seed`). Run with `node scripts/e2e-web.mjs`
  after `npm i -D playwright` (set `CHROME_PATH` to use a system Chromium).
