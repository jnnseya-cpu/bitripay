/**
 * Demo seed: creates sample users (user/merchant/agent), funds wallets and generates activity.
 * Run: npm run seed -w @bitripay/api
 */
import { bootstrap } from './app';
import { getDb } from './db';
import { createUser, findUserByEmail, getUserById, updateUser } from './services/users';
import { ensureWallet } from './services/wallets';
import { postTransaction } from './services/ledger';
import { hashPassword } from './lib/password';
import { sendMoney } from './services/transfers';
import { createPaymentRequest } from './services/paymentRequests';
import { upgradeToMerchant } from './services/merchant';
import { upsertCorridor, listCorridors } from './services/corridors';
import { createPayoutAccount, listPayoutAccounts, prefundAccount } from './services/liquidity';
import { registerDevice, listDevices } from './services/evidence';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

bootstrap();
const db = getDb();

function demoUser(email: string, fullName: string, role: 'user' | 'merchant' | 'agent', tag: string, extra: Record<string, unknown> = {}) {
  let u = findUserByEmail(email);
  if (!u) {
    u = createUser({ email, fullName, role, tag, password: 'Password123!', emailVerified: true, phone: extra.phone as string, country: (extra.country as string) || 'US' });
    updateUser(u.id, { pin_hash: hashPassword('1234'), kyc_status: 'verified', ...(extra.business ? { business_name: extra.business as string } : {}) });
    if (role === 'merchant') upgradeToMerchant(getUserById(u.id), (extra.business as string) || fullName);
    for (const cur of ['USD', 'EUR', 'NGN']) {
      const w = ensureWallet(u.id, cur);
      postTransaction({ type: 'admin_adjustment', amount: cur === 'NGN' ? 50_000_000 : 250_000, currency: cur, toWalletId: w.id, receiverUserId: u.id, note: 'Demo seed funding' });
    }
    console.log(`created ${role}: ${email} / Password123! (PIN 1234)`);
  }
  return getUserById(u.id);
}

const alice = demoUser('alice@example.com', 'Alice Johnson', 'user', 'alice', { phone: '+15550000001' });
const bob = demoUser('bob@example.com', 'Bob Martins', 'user', 'bob', { phone: '+15550000002', country: 'NG' });
const shop = demoUser('merchant@example.com', 'Coffee Corner', 'merchant', 'coffeecorner', { phone: '+15550000003', business: 'Coffee Corner Ltd' });
const agent = demoUser('agent@example.com', 'Kwame Agent Services', 'agent', 'kwameagent', { phone: '+233550000004', country: 'GH', business: 'Kwame Mobile Money Shop' });

if ((db.prepare("SELECT COUNT(*) c FROM transactions WHERE type = 'transfer'").get() as any).c === 0) {
  sendMoney(alice, { to: 'bob', amount: 2500, currency: 'USD', note: 'Lunch 🍜' });
  sendMoney(bob, { to: 'alice', amount: 1200, currency: 'USD', note: 'Movie tickets' });
  sendMoney(alice, { to: 'coffeecorner', amount: 450, currency: 'USD', note: 'Latte' });
  createPaymentRequest(shop, { kind: 'link', amount: 1999, currency: 'USD', description: 'Order #1042 – 2x Cappuccino' });
  createPaymentRequest(shop, { kind: 'qr', amount: 750, currency: 'USD', description: 'Counter 1' });
  createPaymentRequest(alice, { kind: 'request', amount: 3000, currency: 'USD', description: 'Your share of dinner', payer: 'bob' });
  console.log('seeded demo transactions and payment requests');
}
// ---- Corridors, prefunded payout accounts and a demo payout device (sandbox only)
const admin = findUserByEmail(process.env.ADMIN_EMAIL || 'admin@bitripay.local')!;
const drcAgent = demoUser('agent.kinshasa@example.com', 'Kinshasa Payout Point', 'agent', 'kinagent', { phone: '+243810000001', country: 'CD', business: 'Kinshasa Payout Point' });
if (listCorridors().length === 0) {
  upsertCorridor({ sourceCountry: 'GB', sourceCurrency: 'GBP', destCountry: 'CD', destCurrency: 'CDF', operatorId: 'orange_cd', rail: 'mobile_money', status: 'sandbox', estimatedPayoutMinutes: 30, notes: 'Demo corridor: UK card → Orange Money DRC. Sandbox only until authorised.' });
  upsertCorridor({ sourceCountry: 'GB', sourceCurrency: 'GBP', destCountry: 'SN', destCurrency: 'XOF', operatorId: 'orange_sn', rail: 'mobile_money', status: 'sandbox', estimatedPayoutMinutes: 30 });
  upsertCorridor({ sourceCountry: 'GB', sourceCurrency: 'GBP', destCountry: 'KE', destCurrency: 'KES', operatorId: 'mpesa_ke', rail: 'mobile_money', status: 'sandbox', estimatedPayoutMinutes: 15 });
  upsertCorridor({ sourceCurrency: '*', destCountry: 'CD', destCurrency: 'CDF', operatorId: 'airtel_cd', rail: 'mobile_money', status: 'sandbox', estimatedPayoutMinutes: 30 });
  console.log('seeded demo corridors (all sandbox)');
}
if (listPayoutAccounts().length === 0) {
  const orange = createPayoutAccount({ rail: 'mobile_money', operatorId: 'orange_cd', country: 'CD', currency: 'CDF', label: 'Orange Money DRC – merchant SIM 1', msisdn: '+243890000100', simIccid: '8924300000000000100', agentUserId: drcAgent.id, dailyLimit: 0, perTxLimit: 0 }, { type: 'system' });
  prefundAccount(orange.id, 5_000_000_00, { reference: 'SEED-PREFUND-CDF', note: 'Demo prefunding' }, admin);
  const mpesa = createPayoutAccount({ rail: 'mobile_money', operatorId: 'mpesa_ke', country: 'KE', currency: 'KES', label: 'M-Pesa Kenya – merchant SIM', msisdn: '+254700000100', simIccid: '8925400000000000100' }, { type: 'system' });
  prefundAccount(mpesa.id, 500_000_00, { reference: 'SEED-PREFUND-KES', note: 'Demo prefunding' }, admin);
  const senegal = createPayoutAccount({ rail: 'mobile_money', operatorId: 'orange_sn', country: 'SN', currency: 'XOF', label: 'Orange Money Senegal – merchant SIM', msisdn: '+221770000100' }, { type: 'system' });
  prefundAccount(senegal.id, 2_000_000, { reference: 'SEED-PREFUND-XOF', note: 'Demo prefunding' }, admin);
  if (!listDevices().some((d) => d.kind === 'payout')) {
    // Demo payout device: the private key is written to apps/api/data/demo-payout-device.json for the smoke test / a forwarder simulator. Never ship this.
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const device = registerDevice(admin, { name: 'Demo Android payout device (Kinshasa)', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), operatorIds: ['orange_cd'], kind: 'payout', simMsisdn: '+243890000100', simIccid: '8924300000000000100', agentUserId: drcAgent.id, payoutAccountId: orange.id }, admin.id);
    const out = path.join(path.dirname(process.env.DATABASE_PATH || './data/bitripay.db'), 'demo-payout-device.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ deviceId: device.id, payoutAccountId: orange.id, simIdentity: '+243890000100', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }, null, 2));
    console.log(`seeded prefunded payout accounts (CDF, KES, XOF) and a demo payout device – key in ${out}`);
  }
}
console.log(`admin login: see ADMIN_EMAIL / ADMIN_PASSWORD in .env (default admin@bitripay.local / Admin123!)`);
console.log(`agent: ${agent.email}  merchant: ${shop.email}`);
