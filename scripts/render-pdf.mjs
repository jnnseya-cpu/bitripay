/**
 * Render a regulator document (docs/regulator/*.html) to a branded A4 PDF with Chromium: BitriPay header, numbered
 * footer, print styles of the page. Playwright's browser is pre-installed on the runners and on the VPS image.
 *   node scripts/render-pdf.mjs docs/regulator/bcc-demonstration-run-of-show.html docs/regulator/pdf/out.pdf
 *   MERMAID_JS=node_modules/mermaid/dist/mermaid.min.js node scripts/render-pdf.mjs docs/regulator/bcc-presentation-2026-09-17.html out.pdf
 * Also importable: `renderPdf(html, out)` (used by scripts/regulator-submission.mjs).
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Wrap a document fragment (title, style, body markup) into a complete page as the artifact viewer does. */
export const wrapDocument = (html) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"></head><body>${html}</body></html>`;

/** Render mermaid blocks in the page with the bundle named by MERMAID_JS; exits when the page needs it and none is set. */
export async function renderDiagrams(page, html) {
  if (!/class="mermaid"/.test(html)) return;
  const lib = process.env.MERMAID_JS;
  if (!lib || !fs.existsSync(lib)) {
    console.error('this document has mermaid diagrams: set MERMAID_JS=/path/to/mermaid.min.js (npm i --no-save mermaid, then node_modules/mermaid/dist/mermaid.min.js)');
    process.exit(2);
  }
  await page.addScriptTag({ path: lib });
  await page.evaluate(async () => {
    const m = globalThis.mermaid;
    m.initialize({
      startOnLoad: false,
      theme: 'neutral',
      securityLevel: 'loose',
      fontFamily: 'IBM Plex Sans, Helvetica, Arial, sans-serif',
      // wrapped messages and larger type so a sequence diagram stays legible once scaled to the A4 text width
      sequence: {
        wrap: true,
        width: 170,
        actorFontSize: 15,
        actorFontWeight: 600,
        messageFontSize: 14,
        noteFontSize: 13,
        actorMargin: 26,
        boxMargin: 6,
        messageMargin: 28,
        mirrorActors: false,
        diagramMarginX: 6,
        diagramMarginY: 6,
        useMaxWidth: true,
      },
      flowchart: { useMaxWidth: true, htmlLabels: true },
    });
    await m.run({ querySelector: 'pre.mermaid' });
  });
}

/** Render the document markup to `out` (A4, BitriPay header and numbered footer). Returns the file size. */
export async function renderPdf(html, out) {
  const title = (html.match(/<title>([^<]+)<\/title>/) ?? [])[1] ?? 'BitriPay';
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  try {
    const page = await browser.newPage();
    await page.setContent(wrapDocument(html), { waitUntil: 'networkidle' });
    await renderDiagrams(page, html);
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
  } finally {
    await browser.close();
  }
  return fs.statSync(out).size;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) {
    console.error('usage: node scripts/render-pdf.mjs <source.html> <out.pdf>');
    process.exit(2);
  }
  const size = await renderPdf(fs.readFileSync(src, 'utf8'), out);
  console.log('pdf', out, size, 'bytes');
}
