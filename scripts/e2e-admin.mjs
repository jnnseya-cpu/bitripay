import { chromium } from 'playwright';
const base = 'http://127.0.0.1:5174';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(base + '/login');
await page.fill('input:not([type=password])', 'admin@bitripay.local');
await page.fill('input[type=password]', 'Admin123!');
await page.click('form button.btn');
await page.waitForSelector('text=Analytics dashboard', { timeout: 15000 });
await page.screenshot({ path: 'shots/admin-01-dashboard.png' });
for (const [path, wait, name] of [
  ['/users?role=user', 'text=User care', 'users'],
  ['/transactions', 'text=All transactions', 'transactions'],
  ['/approvals', 'text=Approvals', 'approvals'],
  ['/kyc', 'text=KYC verification', 'kyc'],
  ['/currencies', 'text=Exchange rate management', 'currencies'],
  ['/fees', 'text=Fees & charges', 'fees'],
  ['/gateways', 'text=aggregator', 'gateways'],
  ['/modules', 'text=Modules setup', 'modules'],
  ['/catalogs', 'text=Bill pay methods', 'catalogs'],
  ['/site', 'text=Basic web settings', 'site'],
  ['/pages', 'text=/pages/', 'pages'],
  ['/languages', 'text=Translation overrides', 'languages'],
  ['/messaging', 'text=SMTP email', 'messaging'],
  ['/support', 'text=Support tickets', 'support'],
  ['/chat', 'text=Live chat', 'chat'],
  ['/inbox', 'text=Contact messages', 'inbox'],
  ['/p2p', 'text=P2P marketplace', 'p2p'],
  ['/reports', 'text=Detailed reporting', 'reports'],
  ['/audit', 'text=Audit logs', 'audit'],
  ['/profile', 'text=Two-factor', 'profile'],
]) {
  await page.goto(base + path);
  await page.waitForSelector(wait, { timeout: 15000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `shots/admin-${name}.png` });
}
// open a user detail and the gateway config modal
await page.goto(base + '/users?role=merchant');
await page.waitForSelector('text=Manage');
await page.click('button:has-text("Manage")');
await page.waitForSelector('text=Adjust balance');
await page.screenshot({ path: 'shots/admin-user-detail.png' });
await page.goto(base + '/gateways');
await page.waitForSelector('text=Configure');
await page.click('button:has-text("Configure")');
await page.waitForSelector('text=Credentials');
await page.screenshot({ path: 'shots/admin-gateway-modal.png' });
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
