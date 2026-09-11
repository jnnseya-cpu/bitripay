import { chromium } from 'playwright';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
const API = 'http://127.0.0.1:4000';
const WEB = 'http://localhost:5173'; // must match WEB_URL for WebAuthn origin checks
const ADMIN = 'http://127.0.0.1:5174';
const j = async (method, path, body, token) => {
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
// ---- setup via API: admin PIN, checker admin, evidence device key
const adminLogin = await j('POST', '/api/auth/login', { identifier: 'admin@bitripay.local', password: 'Admin123!' });
const adminTok = adminLogin.body.token;
await j('POST', '/api/account/pin', { pin: '9999' }, adminTok);
let checker = await j('POST', '/api/auth/login', { identifier: 'checker@bitripay.local', password: 'Checker123!' });
if (checker.status !== 200) {
  await j('POST', '/api/admin/users', { fullName: 'Checker Admin', email: 'checker@bitripay.local', password: 'Checker123!', role: 'admin', permissions: [] }, adminTok);
  checker = await j('POST', '/api/auth/login', { identifier: 'checker@bitripay.local', password: 'Checker123!' });
}
await j('POST', '/api/account/pin', { pin: '2222' }, checker.body.token);
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const errors = [];
const mk = async (w = 1280) => { const p = await browser.newPage({ viewport: { width: w, height: 900 } }); p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()); }); return p; };

// ---- admin: configure MTN GH + register evidence device through the UI
const admin = await mk(1360);
await admin.goto(ADMIN + '/login');
await admin.fill('input:not([type=password])', 'admin@bitripay.local');
await admin.fill('input[type=password]', 'Admin123!');
await admin.click('form button.btn');
await admin.waitForSelector('text=Analytics dashboard');
await admin.goto(ADMIN + '/mobile-money');
await admin.waitForSelector('text=all world operators');
await admin.locator('.card select').last().selectOption('GH');
await admin.waitForTimeout(600);
const row = admin.locator('tr', { hasText: 'MTN Mobile Money' }).first();
await row.locator('button:has-text("Configure")').click();
await admin.fill('input[placeholder="0244000000"]', '0244000000');
await admin.fill('input[placeholder="BitriPay Ltd"]', 'BitriPay Ghana');
await admin.click('.modal button:has-text("Save")');
await admin.waitForSelector('text=0244000000');
await admin.click('button.tab:has-text("Evidence devices")');
await admin.waitForSelector('text=Register an SMS-forwarder device');
await admin.fill('input[placeholder="Collection phone – Nairobi"]', 'Collection phone – Accra');
await admin.fill('textarea', pem);
await admin.fill('input[placeholder="mpesa_ke, airtel_ke"]', 'mtn_gh');
await admin.click('button:has-text("Register device")');
await admin.waitForSelector('text=Collection phone – Accra');
await admin.screenshot({ path: 'shots/gw-admin-devices.png' });
const devices = await j('GET', '/api/admin/evidence/devices', null, adminTok);
const deviceId = devices.body.items.find((d) => d.name === 'Collection phone – Accra').id;
await admin.click('button.tab:has-text("SMS parsing templates")');
await admin.waitForSelector('text=Operator parsing templates');
await admin.screenshot({ path: 'shots/gw-admin-templates.png' });

// ---- user: PIN-gated intent on the direct rail, sent-report, signed SMS settles it
const page = await mk();
await page.goto(WEB + '/login');
await page.fill('input[placeholder*="you@example.com"]', 'alice@example.com');
await page.fill('input[type=password]', 'Password123!');
await page.click('form button.btn');
await page.waitForURL('**/app');
await page.goto(WEB + '/app/add-money');
await page.click('button.tab:has-text("Mobile money")');
await page.locator('.field', { hasText: 'Country' }).locator('select').selectOption('GH');
await page.waitForTimeout(600);
await page.locator('.field', { hasText: 'Mobile money operator' }).locator('select').selectOption('mtn_gh');
await page.waitForSelector('text=direct rail');
await page.fill('input[placeholder="0.00"]', '50');
await page.fill('input[placeholder="+233…"]', '+233244111222');
await page.click('button:has-text("Confirm and add 50 GHS")');
await page.waitForSelector('text=Authorise this payment');
await page.screenshot({ path: 'shots/gw-user-authorise.png' });
await page.fill('input.pin-input', '1234');
await page.click('.modal button:has-text("Confirm")');
await page.waitForSelector('text=Instructions issued');
await page.waitForSelector('text=How this payment works');
await page.screenshot({ path: 'shots/gw-user-instructions.png' });
const ref = (await page.locator('.kv', { hasText: 'Reference' }).locator('.v').innerText()).trim();
console.log('reference', ref);
await page.click('button:has-text("I have sent the money")');
await page.waitForSelector('text=Reported as sent');
await page.screenshot({ path: 'shots/gw-user-sent.png' });
// forged evidence is rejected; signed evidence from the registered device settles
const fields = { deviceId, nonce: randomUUID(), receivedAt: new Date().toISOString(), from: 'MobileMoney', operatorId: 'mtn_gh', text: `Payment received for GHS 50.00 from 0244111222 (Alice). Transaction ID: 8811223344. Reference: ${ref}. Current Balance: GHS 1,250.00` };
const canonical = [fields.deviceId, fields.nonce, fields.receivedAt, fields.from, fields.operatorId, fields.text].join('\n');
const forged = await j('POST', '/api/evidence/sms', { ...fields, signature: Buffer.from('x'.repeat(64)).toString('base64') });
console.log('forged evidence ->', forged.status, forged.body.error?.code);
const ev = await j('POST', '/api/evidence/sms', { ...fields, signature: sign(null, Buffer.from(canonical), privateKey).toString('base64') });
console.log('signed evidence ->', ev.status, ev.body.evidence?.outcome, ev.body.evidence?.confidence, ev.body.evidence?.reasons);
await page.waitForSelector('text=Settled', { timeout: 20000 });
await page.screenshot({ path: 'shots/gw-user-settled.png' });

// ---- bank transfer intent → maker-checker in the console
await page.click('button:has-text("Done")');
await page.click('button.tab:has-text("Bank")');
await page.locator('.field', { hasText: 'Amount' }).locator('select').selectOption('USD').catch(() => {});
await page.fill('input[placeholder="0.00"]', '30');
await page.click('button:has-text("Confirm and add 30 USD")');
await page.fill('input.pin-input', '1234');
await page.click('.modal button:has-text("Confirm")');
await page.waitForSelector('text=Instructions issued');
await admin.goto(ADMIN + '/verification');
await admin.waitForSelector('text=Open intents');
await admin.locator('tr', { hasText: 'bank' }).filter({ hasText: '30.00' }).first().locator('button:has-text("Review")').click();
await admin.waitForSelector('text=Decisions');
await admin.fill('textarea', 'Seen on bank statement line 42');
await admin.click('button:has-text("Propose: confirm received")');
await admin.click('.modal button:has-text("Confirm")');
await admin.waitForSelector('text=Awaiting a second approver');
await admin.screenshot({ path: 'shots/gw-admin-proposed.png' });
const walletBefore = (await j('GET', '/api/wallets', null, (await j('POST', '/api/auth/login', { identifier: 'alice@example.com', password: 'Password123!' })).body.token)).body.items.find((w) => w.currency === 'USD').balance;
const chk = await mk(1360);
await chk.goto(ADMIN + '/login');
await chk.fill('input:not([type=password])', 'checker@bitripay.local');
await chk.fill('input[type=password]', 'Checker123!');
await chk.click('form button.btn');
await chk.waitForSelector('text=Analytics dashboard');
await chk.goto(ADMIN + '/verification');
await chk.waitForSelector('text=Awaiting a second approver');
await chk.click('button:has-text("Approve confirm")');
await chk.waitForSelector('text=Your transaction PIN');
await chk.screenshot({ path: 'shots/gw-checker-stepup.png' });
await chk.fill('.modal input[type=password]', '2222');
await chk.click('.modal button:has-text("Confirm")');
await chk.waitForSelector('text=payment settled', { timeout: 10000 });
await chk.screenshot({ path: 'shots/gw-checker-approved.png' });
const walletAfter = (await j('GET', '/api/wallets', null, (await j('POST', '/api/auth/login', { identifier: 'alice@example.com', password: 'Password123!' })).body.token)).body.items.find((w) => w.currency === 'USD').balance;
console.log('USD wallet before/after maker-checker settlement', walletBefore, walletAfter);

// ---- passkey: register with a virtual authenticator, sign out, sign in biometrically, pay with biometric step-up
const cdp = await page.context().newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
await page.goto(WEB + '/app/settings?tab=security');
await page.waitForSelector('text=Biometric login & payment confirmation');
await page.click('button:has-text("Add this device")');
await page.waitForSelector('text=1 device', { timeout: 10000 });
await page.screenshot({ path: 'shots/gw-passkey-registered.png' });
await page.evaluate(() => localStorage.removeItem('bitripay.token'));
await page.goto(WEB + '/login');
await page.click('button:has-text("Sign in with biometrics")');
await page.waitForURL('**/app', { timeout: 10000 });
await page.screenshot({ path: 'shots/gw-passkey-login.png' });
await page.goto(WEB + '/app/move');
await page.waitForSelector('text=Move money');
await page.fill('input[placeholder="0.00"]', '5');
await page.fill('input[placeholder="@alice"]', 'bob');
await page.waitForSelector('text=Recipient gets', { timeout: 10000 });
await page.waitForSelector('text=How this payment works');
await page.screenshot({ path: 'shots/gw-move-disclosure.png' });
await page.click('button:has-text("Confirm and send")');
await page.waitForSelector('text=Confirm with biometrics');
await page.click('button:has-text("Confirm with biometrics")');
await page.waitForSelector('text=Money delivered', { timeout: 15000 });
await page.screenshot({ path: 'shots/gw-move-biometric.png' });

// ---- controls & reconciliation
await admin.goto(ADMIN + '/controls');
await admin.waitForSelector('text=Payment lifecycle & evidence');
await admin.click('button.tab:has-text("Reconciliation")');
await admin.waitForSelector('text=Every transaction balances');
await admin.screenshot({ path: 'shots/gw-admin-reconcile.png' });
await admin.click('button.tab:has-text("Route catalogue")');
await admin.waitForSelector('text=wallet → qr');
await admin.screenshot({ path: 'shots/gw-admin-catalog.png' });
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
