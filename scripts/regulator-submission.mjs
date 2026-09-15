/**
 * Build the version of the BCC presentation that is handed to the Direction des Agréments: the working deck minus
 * every passage marked `data-internal` (notes for our side only), with the company fields filled in from the command
 * line. Writes the submission HTML next to the working deck and renders it to a branded PDF.
 *
 *   MERMAID_JS=node_modules/mermaid/dist/mermaid.min.js node scripts/regulator-submission.mjs \
 *     --set denomination="BitriPay SARL" --set rccm="CD/KNG/RCCM/26-B-00000" --set idnat="01-F4300-N00000X" \
 *     --set delegation="Nom Prénom (Directeur général), …"
 *
 * Fields left unset stay highlighted « à compléter » and are listed at the end so nobody sends the file with a blank.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { renderPdf, wrapDocument } from './render-pdf.mjs';

const SRC = 'docs/regulator/bcc-presentation-2026-09-17.html';
const OUT_HTML = 'docs/regulator/bcc-presentation-2026-09-17-remise.html';
const OUT_PDF = 'docs/regulator/pdf/BitriPay-BCC-presentation-2026-09-17-remise.pdf';

const values = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const pair = argv[i] === '--set' ? argv[++i] : argv[i].startsWith('--set=') ? argv[i].slice(6) : null;
  const m = pair ? /^([a-z]+)=(.*)$/s.exec(pair) : null;
  if (!m) {
    console.error(`unknown argument ${argv[i]}; use --set field=value`);
    process.exit(2);
  }
  values[m[1]] = m[2];
}

const html = fs.readFileSync(SRC, 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
let body;
let missing;
try {
  const page = await browser.newPage();
  // no diagram rendering here: the markup is serialised as written so the submission file stays a source document
  await page.setContent(wrapDocument(html), { waitUntil: 'domcontentloaded' });
  ({ body, missing } = await page.evaluate((vals) => {
    for (const el of Array.from(document.querySelectorAll('[data-internal]'))) el.remove();
    const missing = [];
    for (const el of Array.from(document.querySelectorAll('[data-field]'))) {
      const key = el.getAttribute('data-field');
      const v = vals[key];
      if (v && v.trim()) {
        el.textContent = v.trim();
        el.classList.remove('fill');
        el.removeAttribute('data-field');
      } else missing.push(key);
    }
    return { body: document.body.innerHTML, missing: Array.from(new Set(missing)) };
  }, values));
} finally {
  await browser.close();
}

const stamp = `<!-- Version remise, générée par scripts/regulator-submission.mjs depuis ${path.basename(SRC)} ; les notes internes sont retirées. -->\n`;
fs.writeFileSync(OUT_HTML, stamp + body.replace(/^\s+/, '') + '\n');
const size = await renderPdf(body, OUT_PDF);
console.log('html', OUT_HTML);
console.log('pdf', OUT_PDF, size, 'bytes');
if (missing.length) {
  console.log(`fields still marked « à compléter » (pass --set field=value): ${missing.join(', ')}`);
  process.exitCode = 1;
} else console.log('every company field is filled in');
