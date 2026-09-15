/**
 * Render a regulator document (docs/regulator/*.html) to a branded A4 PDF with Chromium: BitriPay header, numbered
 * footer, print styles of the page. Playwright's browser is pre-installed on the runners and on the VPS image.
 *   node scripts/render-pdf.mjs docs/regulator/bcc-demonstration-run-of-show.html docs/regulator/pdf/out.pdf
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('usage: node scripts/render-pdf.mjs <source.html> <out.pdf>');
  process.exit(2);
}
const html = fs.readFileSync(src, 'utf8');
const title = (html.match(/<title>([^<]+)<\/title>/) ?? [])[1] ?? 'BitriPay';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage();
await page.setContent(`<!doctype html><html lang="fr"><head><meta charset="utf-8"></head><body>${html}</body></html>`, { waitUntil: 'networkidle' });
await page.emulateMedia({ media: 'print' });
await page.waitForTimeout(800);
const bar = (left, right) =>
  `<div style="width:100%;font-family:'IBM Plex Sans',Helvetica,Arial,sans-serif;font-size:8.5px;color:#6b7690;padding:0 14mm;display:flex;justify-content:space-between"><span>${left}</span><span>${right}</span></div>`;
await page.pdf({
  path: out,
  format: 'A4',
  printBackground: true,
  margin: { top: '18mm', bottom: '16mm', left: '14mm', right: '14mm' },
  displayHeaderFooter: true,
  headerTemplate: bar(`<b style="color:#0b2a6f">BitriPay</b> · ${title.replace(/^BitriPay · /, '')}`, 'Confidentiel — Direction des Agréments'),
  footerTemplate: bar('www.bitripay.com · support@bitripay.com', 'Page <span class="pageNumber"></span> / <span class="totalPages"></span>'),
});
await browser.close();
console.log('pdf', out, fs.statSync(out).size, 'bytes');
