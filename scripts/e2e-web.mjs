import { chromium } from 'playwright-core';
const base = 'http://127.0.0.1:5173';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH }).catch(async () => chromium.launch());
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
});
const shot = (n) => page.screenshot({ path: `shots/${n}.png`, fullPage: false });

await page.goto(base + '/');
await page.waitForSelector('text=Money moves');
await shot('01-landing');

await page.goto(base + '/login');
await page.fill('input[placeholder*="you@example.com"]', 'alice@example.com');
await page.fill('input[type=password]', 'Password123!');
await page.click('form button.btn');
await page.waitForURL('**/app', { timeout: 15000 });
await page.waitForSelector('text=Total balance');
await shot('02-dashboard');

await page.goto(base + '/app/receive');
await page.waitForSelector('.qr-box img');
await shot('03-receive');

await page.goto(base + '/app/send');
await page.fill('input[placeholder="@alice"]', 'bob');
await page.waitForSelector('text=@bob');
await page.fill('input[placeholder="0.00"]', '12.50');
await page.fill('input[placeholder="What\'s it for?"]', 'Playwright test');
await page.waitForSelector('text=Total');
await page.click('button:has-text("Review transfer")');
await page.fill('input.pin-input', '1234');
await page.click('.modal button:has-text("Confirm")');
await page.waitForURL('**/app/transactions/**', { timeout: 15000 });
await page.waitForSelector('text=Transfer');
await shot('04-transaction');

await page.goto(base + '/app/add-money');
await page.waitForSelector('text=Sandbox');
await page.fill('input[placeholder="0.00"]', '50');
await page.fill('input[placeholder="4242 4242 4242 4242"]', '4242424242424242');
await page.fill('input[placeholder="MM"]', '12');
await page.fill('input[placeholder="YY"]', '30');
await page.fill('input[placeholder="123"]', '123');
await page.click('button:has-text("Add 50 USD")');
await page.waitForSelector('text=succeeded', { timeout: 15000 });
await shot('05-add-money');

await page.goto(base + '/app/requests');
await page.click('button:has-text("New payment link")');
await page.fill('.modal input[placeholder="0.00"]', '9.99');
await page.fill('.modal input[placeholder*="Invoice"]', 'E2E link');
await page.click('.modal button:has-text("Create link")');
await page.waitForSelector('.modal .qr-box img');
const link = await page.locator('.modal .mono').first().innerText();
await shot('06-payment-link');
await page.keyboard.press('Escape');

// guest checkout in a fresh context
const guest = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
guest.on('pageerror', (e) => errors.push('guest pageerror: ' + e.message));
await guest.goto(link.replace(/^https?:\/\/[^/]+/, base));
await guest.waitForSelector('text=Pay with');
await guest.screenshot({ path: 'shots/07-checkout-guest.png' });

// merchant POS
await page.goto(base + '/login');
await page.evaluate(() => localStorage.clear());
await page.goto(base + '/login');
await page.fill('input[placeholder*="you@example.com"]', 'merchant@example.com');
await page.fill('input[type=password]', 'Password123!');
await page.click('form button.btn');
await page.waitForURL('**/app');
await page.goto(base + '/app/merchant/pos');
await page.fill('input[placeholder="0.00"]', '7.50');
await page.click('button:has-text("Generate QR")');
await page.waitForSelector('.qr-box img');
await shot('08-merchant-pos');
await page.goto(base + '/app/merchant/gateway');
await page.waitForSelector('text=Accepted payment methods');
await shot('09-merchant-gateway');

// agent
await page.evaluate(() => localStorage.clear());
await page.goto(base + '/login');
await page.fill('input[placeholder*="you@example.com"]', 'agent@example.com');
await page.fill('input[type=password]', 'Password123!');
await page.click('form button.btn');
await page.waitForURL('**/app');
await page.goto(base + '/app/agent');
await page.waitForSelector('text=Credit a customer');
await shot('10-agent');
await page.goto(base + '/app/p2p');
await page.waitForSelector('text=Marketplace');
await shot('11-p2p');
await page.goto(base + '/app/settings?tab=security');
await page.waitForSelector('text=Two-factor');
await page.click('button[aria-label="Toggle theme"]');
await shot('12-settings-dark');

console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
