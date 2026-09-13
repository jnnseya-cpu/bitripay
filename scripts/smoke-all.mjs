/**
 * Live smoke of the whole platform against running servers (API on :4000, web on :5173, admin on :5174, seeded DB):
 * public site, user flows (send, move money quote, remittance quote, add money by sandbox card, savings, linked banks,
 * rates & forwards, credit readiness, subscriptions), merchant surfaces (POS, command centre, QR centre, developer
 * portal), agent tools, the admin console pages, BitriPay Lite (no JavaScript) and the partner API (OpenAPI, keys,
 * cross-border route quote). Prints one line per check and exits non-zero on the first hard failure.
 *
 *   npm run dev            # in one terminal (API + web + admin), then
 *   npm run smoke          # CHROME_PATH=/path/to/chrome to use a system Chromium
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const web = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const admin = process.env.ADMIN_URL ?? 'http://127.0.0.1:5174';
const api = process.env.API_URL ?? 'http://127.0.0.1:4000';
const chrome = process.env.CHROME_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
const shotsDir = process.env.SHOTS_DIR ?? 'shots/smoke';
fs.mkdirSync(shotsDir, { recursive: true });
const results = [];
let failed = 0;
const ok = (name, detail = '') => { results.push(['ok', name, detail]); console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`); };
const bad = (name, detail = '') => { failed += 1; results.push(['FAIL', name, detail]); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); };
async function check(name, fn) { try { const d = await fn(); ok(name, typeof d === 'string' ? d : ''); } catch (e) { bad(name, e.message.split('\n')[0]); } }
const json = async (path, init = {}) => { const r = await fetch(api + path, init); const body = await r.json().catch(() => ({})); return { status: r.status, body }; };
const browser = await chromium.launch({ executablePath: chrome });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
const login = async (email) => {
  await page.goto(web + '/login');
  await page.evaluate(() => localStorage.clear());
  await page.goto(web + '/login');
  await page.fill('input[placeholder*="you@example.com"]', email);
  await page.fill('input[type=password]', 'Password123!');
  await page.click('button:text-is("Sign in")');
  await page.waitForURL('**/app', { timeout: 20000 });
};
const see = async (path, text, shot) => { await page.goto(web + path); await page.waitForSelector(`text=${text}`, { timeout: 15000 }); if (shot) await page.screenshot({ path: `${shotsDir}/${shot}.png`, fullPage: true }); };

console.log('\nPublic site and API');
await check('API config', async () => { const r = await json('/api/config'); if (r.status !== 200 || !r.body.modules) throw new Error(`status ${r.status}`); return `${r.body.currencies.length} currencies`; });
await check('OpenAPI 3.1 document', async () => { const r = await json('/api/v1/openapi.json'); const n = Object.keys(r.body.paths ?? {}).length; if (n < 60) throw new Error(`only ${n} paths`); return `${n} paths`; });
await check('Locale chain (CD → fr / CDF)', async () => { const r = await json('/api/locale', { headers: { 'x-ip-country': 'CD' } }); if (r.body.language !== 'fr') throw new Error(JSON.stringify(r.body)); return `${r.body.language}/${r.body.currency}`; });
await check('Landing page', async () => { await page.goto(web + '/'); await page.waitForSelector('text=Money moves', { timeout: 15000 }); await page.screenshot({ path: `${shotsDir}/landing.png` }); });
await check('Blog and policy pages', async () => { for (const p of ['/blog', '/pages/privacy-policy']) { const r = await fetch(web + p); if (r.status !== 200) throw new Error(`${p} → ${r.status}`); } });

console.log('\nUser app (alice)');
await check('Sign in', () => login('alice@example.com'));
await check('Dashboard', () => see('/app', 'Total balance', 'dashboard'));
await check('Send money form', () => see('/app/send', 'Recipient'));
await check('Move money (any → any)', () => see('/app/move', 'Fund from a card', 'move-money'));
await check('Remittance', () => see('/app/remittance', 'Recipient receives in', 'remittance'));
await check('Add money by sandbox card', async () => {
  await page.goto(web + '/app/add-money');
  await page.waitForSelector('text=Sandbox');
  await page.fill('input[placeholder="0.00"]', '50');
  await page.fill('input[placeholder="4242 4242 4242 4242"]', '4242424242424242');
  await page.fill('input[placeholder="MM"]', '12'); await page.fill('input[placeholder="YY"]', '30'); await page.fill('input[placeholder="123"]', '123');
  await page.locator('main button', { hasText: /confirm and add 50/i }).click();
  // the payment is authenticated with the transaction PIN (or a passkey) before the processor is called
  const pin = page.locator('input.pin-input');
  if (await pin.count()) { await pin.fill('1234'); await page.click('.modal button:has-text("Confirm")'); }
  await page.waitForSelector('text=/succeeded|money added|settled/i', { timeout: 20000 });
  await page.screenshot({ path: `${shotsDir}/add-money.png` });
});
await check('Send 1.25 USD to bob (PIN)', async () => {
  await page.goto(web + '/app/send');
  await page.fill('input[placeholder="@alice"]', 'bob');
  await page.waitForSelector('text=@bob');
  await page.fill('input[placeholder="0.00"]', '1.25');
  await page.click('button:has-text("Review transfer")');
  await page.fill('input.pin-input', '1234');
  await page.click('.modal button:has-text("Confirm")');
  await page.waitForURL('**/app/transactions/**', { timeout: 20000 });
});
await check('Receive QR', async () => { await page.goto(web + '/app/receive'); await page.waitForSelector('.qr-box img', { timeout: 15000 }); });
await check('Savings & goals', () => see('/app/savings', 'Living within your means', 'savings'));
await check('Rates & forwards', () => see('/app/fx', 'Rate alerts', 'fx-tools'));
await check('Credit readiness', () => see('/app/credit', 'How to improve', 'credit'));
await check('Linked banks', () => see('/app/banks', 'Connect a bank', 'banks'));
await check('Subscriptions', () => see('/app/subscriptions', 'Add a subscription'));
await check('Command centre', () => see('/app/assist', 'agent'));
await check('Statements', () => see('/app/statements', 'Statement'));
await check('Settings (security)', () => see('/app/settings?tab=security', 'Two-factor'));

console.log('\nMerchant (Coffee Corner)');
await check('Sign in', () => login('merchant@example.com'));
await check('Point of sale QR', async () => { await page.goto(web + '/app/merchant/pos'); await page.fill('input[placeholder="0.00"]', '7.50'); await page.click('button:has-text("Generate QR")'); await page.waitForSelector('.qr-box img', { timeout: 15000 }); await page.screenshot({ path: `${shotsDir}/pos.png` }); });
await check('Merchant command centre', () => see('/app/merchant/centre', 'Command centre', 'merchant-centre'));
await check('Bulk payouts tab', async () => { await page.goto(web + '/app/merchant/centre'); await page.click('text=Bulk payouts'); await page.waitForSelector('text=New batch'); });
await check('Plans & billing tab', async () => { await page.click('text=Plans & billing'); await page.waitForSelector('text=New plan'); });
await check('QR centre', () => see('/app/merchant/qr', 'QR centre', 'qr-centre'));
await check('Developer portal', () => see('/app/merchant/developer', 'Developer portal', 'developer'));
await check('Gateway & API keys', () => see('/app/merchant/gateway', 'Accepted payment methods'));

console.log('\nAgent (Kwame)');
await check('Sign in', () => login('agent@example.com'));
await check('Agent tools', () => see('/app/agent', 'Credit a customer', 'agent'));
await check('Offline kit reachable', () => see('/app/merchant/centre', 'Command centre'));

console.log('\nAdmin console');
await check('Admin sign in', async () => { await page.goto(admin + '/login'); await page.fill('input:not([type=password])', 'admin@bitripay.local'); await page.fill('input[type=password]', 'Admin123!'); await page.click('form button.btn'); await page.waitForSelector('text=Analytics dashboard', { timeout: 20000 }); await page.screenshot({ path: `${shotsDir}/admin-dashboard.png` }); });
for (const [path, text, name] of [
  ['/users?role=user', 'User care', 'users'], ['/transactions', 'All transactions', 'transactions'], ['/approvals', 'Approvals', 'approvals'], ['/kyc', 'KYC', 'kyc'],
  ['/currencies', 'Exchange rate', 'currencies'], ['/fees', 'Fees', 'fees'], ['/gateways', 'aggregator', 'gateways'], ['/modules', 'Modules', 'modules'],
  ['/switch', 'switch', 'switch'], ['/finops', 'Finance operations', 'finops'], ['/risk', 'Risk', 'risk'], ['/intelligence', 'Intelligence', 'intelligence'],
  ['/agents', 'Agent', 'agents'], ['/channels', 'USSD', 'channels'], ['/emoney', 'E-money', 'emoney'], ['/corridors', 'Corridor', 'corridors'],
]) await check(`Admin ${name}`, async () => { await page.goto(admin + path); await page.waitForSelector(`text=${text}`, { timeout: 15000 }); });

console.log('\nBitriPay Lite (no JavaScript)');
await check('Lite sign in and home', async () => {
  const lite = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
  await lite.goto(api + '/lite/');
  await lite.fill('input[name=identifier]', 'alice@example.com');
  await lite.fill('input[name=secret]', 'Password123!');
  await lite.click('form button');
  await lite.waitForURL('**/lite/home', { timeout: 15000 });
  await lite.screenshot({ path: `${shotsDir}/lite-home.png` });
  for (const p of ['/lite/send', '/lite/remit', '/lite/receive', '/lite/cash', '/lite/history']) { await lite.goto(api + p); if (!(await lite.content()).includes('BitriPay')) throw new Error(`${p} did not render`); }
  await lite.close();
});

console.log('\nPartner API v1 (merchant key)');
await check('Create restricted key, quote a cross-border route, read wallets', async () => {
  const login = await json('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: 'merchant@example.com', password: 'Password123!' }) });
  const auth = { Authorization: `Bearer ${login.body.token}`, 'content-type': 'application/json' };
  const key = await json('/api/v1/api_keys', { method: 'POST', headers: auth, body: JSON.stringify({ label: `smoke-${Date.now()}`, mode: 'test', kind: 'restricted', scopes: ['routes:read', 'wallets:read'] }) });
  if (key.status !== 201) throw new Error(JSON.stringify(key.body));
  const k = { Authorization: `Bearer ${key.body.secret}`, 'content-type': 'application/json' };
  const q = await json('/api/v1/routes/quote', { method: 'POST', headers: k, body: JSON.stringify({ amount_minor: 5000, currency: 'USD', target_currency: 'KES', source: { method: 'card' }, destination: { method: 'mobile_money', operator_id: 'mpesa_ke', phone: '+254712345678', name: 'Wanjiru' } }) });
  if (q.status !== 200 || !q.body.quote?.recipientAmount) throw new Error(JSON.stringify(q.body).slice(0, 200));
  const w = await json('/api/v1/wallets', { headers: k });
  if (w.status !== 200) throw new Error(`wallets ${w.status}`);
  await json(`/api/v1/api_keys/${key.body.id}`, { method: 'DELETE', headers: auth });
  return `recipient gets ${q.body.quote.recipientAmount} KES minor for 50.00 USD by card`;
});

await browser.close();
console.log(`\n${results.length - failed} passed, ${failed} failed${pageErrors.length ? `; page errors: ${pageErrors.slice(0, 3).join(' | ')}` : ''}`);
fs.writeFileSync(`${shotsDir}/results.json`, JSON.stringify({ at: new Date().toISOString(), results, pageErrors }, null, 2));
process.exit(failed ? 1 : 0);
