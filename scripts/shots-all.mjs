/**
 * Capture every surface of BitriPay (public site, user app, merchant, agent, admin, lite) as JPEG screenshots for
 * the page gallery. Run with the API (4000), web (5173) and admin (5174) dev servers up and the demo seed applied.
 *   node scripts/shots-all.mjs [outDir]
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] || 'shots/gallery';
fs.mkdirSync(out, { recursive: true });
const WEB = 'http://127.0.0.1:5173';
const ADMIN = 'http://127.0.0.1:5174';
const API = 'http://127.0.0.1:4000';
const manifest = [];
const errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });

async function shot(page, group, name, title, url, opts = {}) {
  const file = path.join(out, `${name}.jpg`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (opts.wait) await page.waitForSelector(opts.wait, { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(opts.settle ?? 700);
    if (opts.before) await opts.before(page).catch((e) => errors.push(`${name}: ${e.message}`));
    await page.screenshot({ path: file, type: 'jpeg', quality: 72, fullPage: !!opts.full });
    manifest.push({ group, name, title, url: url.replace(/^http:\/\/127\.0\.0\.1:\d+/, ''), file });
    console.log('ok', name);
  } catch (e) {
    errors.push(`${name}: ${e.message}`);
    console.log('FAIL', name, e.message);
  }
}

async function loginWeb(page, email) {
  await page.goto(WEB + '/login');
  await page.evaluate(() => localStorage.clear());
  await page.goto(WEB + '/login');
  await page.fill('input[placeholder*="you@example.com"]', email);
  await page.fill('input[type=password]', 'Password123!');
  await page.click('form button.btn');
  await page.waitForURL('**/app', { timeout: 20000 });
}

// ---------------------------------------------------------------- public site
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('pageerror', (e) => errors.push('web pageerror: ' + e.message));
  await shot(page, 'Public site', 'site-landing', 'Landing page', WEB + '/', { wait: 'text=BitriPay' });
  await shot(page, 'Public site', 'site-landing-full', 'Landing page (full length)', WEB + '/', { full: true });
  await shot(page, 'Public site', 'site-login', 'Sign in', WEB + '/login');
  await shot(page, 'Public site', 'site-register', 'Open an account', WEB + '/register');
  await shot(page, 'Public site', 'site-blog', 'Blog (SEO engine)', API + '/blog');
  await shot(page, 'Public site', 'site-about', 'About BitriPay', WEB + '/pages/about');
  await page.close();
}

// ---------------------------------------------------------------- user app
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('pageerror', (e) => errors.push('app pageerror: ' + e.message));
  await loginWeb(page, 'alice@example.com');
  const pages = [
    ['app-dashboard', 'Dashboard', '/app'],
    ['app-send', 'Send money', '/app/send'],
    ['app-receive', 'Receive / my QR', '/app/receive'],
    ['app-scan', 'Scan to pay (BitriQR)', '/app/scan'],
    ['app-add-money', 'Add money', '/app/add-money'],
    ['app-move', 'Move money (any → any)', '/app/move'],
    ['app-remittance', 'Send abroad', '/app/remittance'],
    ['app-exchange', 'Currency exchange', '/app/exchange'],
    ['app-cards', 'Virtual cards', '/app/cards'],
    ['app-bills', 'Bills', '/app/bills'],
    ['app-topup', 'Mobile top-up', '/app/topup'],
    ['app-gift-cards', 'Gift cards', '/app/gift-cards'],
    ['app-p2p', 'P2P exchange', '/app/p2p'],
    ['app-transactions', 'Transactions', '/app/transactions'],
    ['app-statements', 'Statements', '/app/statements'],
    ['app-assist', 'Command centre (agents)', '/app/assist'],
    ['app-referrals', 'Referrals', '/app/referrals'],
    ['app-support', 'Support', '/app/support'],
    ['app-settings', 'Settings & security', '/app/settings?tab=security'],
    ['app-withdraw', 'Withdraw', '/app/withdraw'],
    ['app-agents', 'Find an agent', '/app/agents'],
  ];
  for (const [name, title, p] of pages) await shot(page, 'User app', name, title, WEB + p);
  await page.setViewportSize({ width: 400, height: 820 });
  await shot(page, 'User app', 'app-mobile-dashboard', 'Dashboard on a phone', WEB + '/app');
  await shot(page, 'User app', 'app-mobile-assist', 'Command centre on a phone', WEB + '/app/assist');
  await shot(page, 'User app', 'app-mobile-scan', 'Scan on a phone', WEB + '/app/scan');
  await page.close();
}

// ---------------------------------------------------------------- merchant + guest checkout
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('pageerror', (e) => errors.push('merchant pageerror: ' + e.message));
  await loginWeb(page, 'merchant@example.com');
  await shot(page, 'Merchant', 'merchant-dashboard', 'Merchant dashboard', WEB + '/app/merchant');
  await shot(page, 'Merchant', 'merchant-pos', 'Point of sale (QR)', WEB + '/app/merchant/pos', {
    before: async (p) => {
      await p.fill('input[placeholder="0.00"]', '7.50');
      await p.click('button:has-text("Generate QR")');
      await p.waitForSelector('.qr-box img', { timeout: 10000 });
    },
  });
  await shot(page, 'Merchant', 'merchant-gateway', 'Gateway, API keys & webhooks', WEB + '/app/merchant/gateway');
  await shot(page, 'Merchant', 'merchant-requests', 'Payment links & requests', WEB + '/app/requests');
  // a hosted checkout page for a guest, from a real payment link created through the merchant API
  const token = await page.evaluate(() => localStorage.getItem('token') || localStorage.getItem('bitripay_token') || '');
  const guest = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  try {
    const res = await fetch(API + '/api/v1/checkout_sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ currency: 'USD', line_items: [{ name: 'Flat white', quantity: 2, unit_amount_minor: 350 }, { name: 'Croissant', quantity: 1, unit_amount_minor: 250 }], reference: 'GALLERY-1' }) });
    const cs = await res.json();
    if (cs.url) await shot(guest, 'Merchant', 'checkout-hosted', 'Hosted checkout (guest payer)', cs.url.replace(/^https?:\/\/[^/]+/, WEB), { wait: 'text=Pay' });
    else errors.push('checkout session: ' + JSON.stringify(cs).slice(0, 200));
  } catch (e) {
    errors.push('checkout: ' + e.message);
  }
  await guest.close();
  await page.close();
}

// ---------------------------------------------------------------- agent
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await loginWeb(page, 'agent@example.com');
  await shot(page, 'Agent', 'agent-dashboard', 'Agent counter: cash-in / cash-out', WEB + '/app/agent');
  await page.close();
}

// ---------------------------------------------------------------- admin
{
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.on('pageerror', (e) => errors.push('admin pageerror: ' + e.message));
  await page.goto(ADMIN + '/login');
  await page.fill('input:not([type=password])', 'admin@bitripay.local');
  await page.fill('input[type=password]', 'Admin123!');
  await page.click('form button.btn');
  await page.waitForSelector('text=Analytics dashboard', { timeout: 20000 }).catch(() => {});
  const pages = [
    ['admin-dashboard', 'Analytics dashboard', '/'],
    ['admin-users', 'Users, merchants & agents', '/users?role=user'],
    ['admin-transactions', 'Transactions (ledger)', '/transactions'],
    ['admin-approvals', 'Maker-checker approvals', '/approvals'],
    ['admin-verification', 'Payment verification console', '/verification'],
    ['admin-controls', 'Controls & go-live checklist', '/controls'],
    ['admin-corridors', 'Corridors, liquidity & payouts', '/corridors'],
    ['admin-emoney', 'E-money console (safeguarding)', '/emoney'],
    ['admin-agents', 'Agents console (runs, approvals, billing)', '/agents'],
    ['admin-channels', 'USSD & SMS channels (simulator)', '/channels'],
    ['admin-gateways', 'Processors & rails', '/gateways'],
    ['admin-mobile-money', 'Mobile money operators', '/mobile-money'],
    ['admin-currencies', 'Currencies & FX rates', '/currencies'],
    ['admin-fees', 'Fees & limits', '/fees'],
    ['admin-kyc', 'KYC queue', '/kyc'],
    ['admin-seo', 'Blog & SEO engine', '/seo'],
    ['admin-modules', 'Modules', '/modules'],
    ['admin-reports', 'Reports', '/reports'],
    ['admin-audit', 'Audit log', '/audit'],
  ];
  for (const [name, title, p] of pages) await shot(page, 'Admin', name, title, ADMIN + p);
  await page.close();
}

// ---------------------------------------------------------------- lite (no JavaScript, feature phones / 2G)
{
  const page = await browser.newPage({ viewport: { width: 400, height: 760 } });
  await shot(page, 'BitriPay Lite & USSD', 'lite-login', 'Lite: sign in (no JavaScript)', API + '/lite/');
  await page.fill('input[name=identifier]', 'alice@example.com');
  await page.fill('input[name=secret]', 'Password123!');
  await page.click('button');
  await page.waitForTimeout(800);
  await shot(page, 'BitriPay Lite & USSD', 'lite-home', 'Lite: home', API + '/lite/home');
  await shot(page, 'BitriPay Lite & USSD', 'lite-send', 'Lite: send', API + '/lite/send');
  await shot(page, 'BitriPay Lite & USSD', 'lite-cash', 'Lite: cash out at an agent', API + '/lite/cash');
  await shot(page, 'BitriPay Lite & USSD', 'lite-history', 'Lite: history', API + '/lite/history');
  await page.close();
}

fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), shots: manifest, errors }, null, 2));
console.log(`\n${manifest.length} screenshots, ${errors.length} errors`);
if (errors.length) console.log(errors.join('\n'));
await browser.close();
