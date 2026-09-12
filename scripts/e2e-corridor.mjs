import { chromium } from 'playwright';
import { createPrivateKey, sign, randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
const API = 'http://127.0.0.1:4000';
const WEB = 'http://localhost:5173';
const ADMIN = 'http://127.0.0.1:5174';
const j = async (method, path, body, token, headers = {}) => {
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const demo = JSON.parse(fs.readFileSync('apps/api/data/demo-payout-device.json', 'utf8'));
const pk = createPrivateKey(demo.privateKeyPem);
const devHeaders = (method, path) => { const ts = new Date().toISOString(); return { 'X-Device-Id': demo.deviceId, 'X-Device-Timestamp': ts, 'X-Device-Signature': sign(null, Buffer.from([demo.deviceId, ts, method, path].join('\n')), pk).toString('base64') }; };
// setup: admin + checker PINs; alice KYC verified (card-funded payouts otherwise hold for review)
const admin = (await j('POST', '/api/auth/login', { identifier: 'admin@bitripay.local', password: 'Admin123!' })).body.token;
await j('POST', '/api/account/pin', { pin: '9999' }, admin);
let checker = await j('POST', '/api/auth/login', { identifier: 'checker@bitripay.local', password: 'Checker123!' });
if (checker.status !== 200) { await j('POST', '/api/admin/users', { fullName: 'Checker Admin', email: 'checker@bitripay.local', password: 'Checker123!', role: 'admin', permissions: [] }, admin); checker = await j('POST', '/api/auth/login', { identifier: 'checker@bitripay.local', password: 'Checker123!' }); }
await j('POST', '/api/account/pin', { pin: '2222' }, checker.body.token);
const alice = (await j('POST', '/api/auth/login', { identifier: 'alice@example.com', password: 'Password123!' })).body;
await j('PATCH', `/api/admin/users/${alice.user.id}`, { kycStatus: 'verified' }, admin);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const errors = [];
const mk = async (w = 1280) => { const p = await browser.newPage({ viewport: { width: w, height: 900 } }); p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()); }); return p; };

// ---- sender: GBP card → Orange Money DRC through Move money
const page = await mk();
await page.goto(WEB + '/login');
await page.fill('input[placeholder*="you@example.com"]', 'alice@example.com');
await page.fill('input[type=password]', 'Password123!');
await page.click('form button.btn');
await page.waitForURL('**/app');
await page.goto(WEB + '/app/move');
await page.waitForSelector('text=Move money');
await page.click('button.tab:has-text("Card")');
await page.fill('input[placeholder*="4242"]', '4242 4242 4242 4242').catch(async () => { await page.locator('input').filter({ hasText: '' }).first(); });
await page.locator('.field', { hasText: 'Amount' }).locator('select').selectOption('GBP');
await page.fill('input[placeholder="0.00"]', '20');
await page.locator("button.tab:has-text(\"Mobile money\")").nth(1).click();
const dstCountry = page.locator('.field', { hasText: 'Country' }).locator('select').last();
await dstCountry.selectOption('CD');
await page.waitForTimeout(600);
await page.locator('.field', { hasText: 'Mobile money operator' }).locator('select').last().selectOption('orange_cd');
await page.locator('.field', { hasText: 'Recipient mobile money number' }).locator('input').fill('+243990000123');
await page.locator('.field', { hasText: 'Recipient name' }).locator('input').fill('Marie Kabila');
await page.locator('.field', { hasText: 'Deliver in currency' }).locator('select').selectOption('CDF');
await page.waitForSelector('text=Recipient gets', { timeout: 15000 });
await page.waitForSelector('text=sandbox only, no real funds');
await page.waitForSelector('text=Refunds:');
await page.screenshot({ path: 'shots/cor-quote.png', fullPage: true });
await page.fill('input[autocomplete="cc-number"]', '4242424242424242');
await page.fill('input[autocomplete="cc-exp-month"]', '12');
await page.fill('input[autocomplete="cc-exp-year"]', '30');
await page.fill('input[autocomplete="cc-csc"]', '123');
await page.click('button:has-text("Confirm and pay")');
await page.waitForSelector('text=Authorise this transfer');
await page.fill('input.pin-input', '1234');
await page.click('.modal button:has-text("Confirm")');
await page.waitForSelector('text=Payout queued', { timeout: 15000 });
await page.waitForSelector('text=Local payout');
await page.screenshot({ path: 'shots/cor-queued.png', fullPage: true });
const routes = await j('GET', '/api/money', null, alice.token);
const route = routes.body.items[0];
console.log('route', route.stage, 'payout', route.payout?.stage, route.payout?.payoutAccount?.label);

// ---- device: queue → claim → signed operator SMS
const queue = await j('GET', '/api/payouts/device/queue', null, null, devHeaders('GET', '/api/payouts/device/queue'));
console.log('device queue', queue.status, queue.body.items?.length);
const p = queue.body.items.find((x) => x.routeId === route.id);
await j('POST', `/api/payouts/device/${p.id}/claim`, {}, null, devHeaders('POST', `/api/payouts/device/${p.id}/claim`));
await page.waitForSelector('text=Payout in progress', { timeout: 15000 });
await page.screenshot({ path: 'shots/cor-in-progress.png', fullPage: true });
const text = `Transfert de ${(p.amount / 100).toFixed(2)} CDF vers Marie Kabila 243990000123 effectue. ID: PP240912.1200.D4410. Solde: 4,990,000.00 CDF`;
const f = { deviceId: demo.deviceId, nonce: randomUUID(), receivedAt: new Date().toISOString(), from: 'OrangeMoney', operatorId: 'orange_cd', text };
const sig = sign(null, Buffer.from([f.deviceId, f.nonce, f.receivedAt, f.from, f.operatorId, f.text].join('\n')), pk).toString('base64');
const ev = await j('POST', `/api/payouts/device/${p.id}/evidence`, { ...f, signature: sig, simIdentity: demo.simIdentity, deviceTimestamp: new Date().toISOString(), clientHash: createHash('sha256').update(text).digest('hex') });
console.log('evidence', ev.status, ev.body.evidence?.outcome, ev.body.evidence?.reasons);
await page.waitForSelector('text=Settled', { timeout: 20000 });
await page.waitForSelector('text=Operator confirmation');
await page.screenshot({ path: 'shots/cor-settled.png', fullPage: true });

// ---- admin: corridors, liquidity, payouts case
const a = await mk(1360);
await a.goto(ADMIN + '/login');
await a.fill('input:not([type=password])', 'admin@bitripay.local');
await a.fill('input[type=password]', 'Admin123!');
await a.click('form button.btn');
await a.waitForSelector('text=Analytics dashboard');
await a.goto(ADMIN + '/corridors');
await a.waitForSelector('text=Sandbox mode');
await a.screenshot({ path: 'shots/cor-admin-corridors.png', fullPage: true });
await a.click('button.tab:has-text("Liquidity")');
await a.waitForSelector('text=Prefunded payout accounts');
await a.screenshot({ path: 'shots/cor-admin-liquidity.png', fullPage: true });
await a.click('button.tab:has-text("Payout instructions")');
await a.waitForSelector('text=Instructions');
await a.locator('tr', { hasText: p.reference }).locator('button:has-text("Open")').click();
await a.waitForSelector('text=Evidence (1)');
await a.screenshot({ path: 'shots/cor-admin-payout.png', fullPage: true });
await a.click('button.tab:has-text("Corridors")');
await a.locator('tr', { hasText: 'GB GBP → CD CDF' }).first().locator('button:has-text("Go live")').click();
await a.waitForSelector('text=Authorise corridor for live funds');
await a.screenshot({ path: 'shots/cor-admin-golive.png' });
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
