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
console.log(`admin login: see ADMIN_EMAIL / ADMIN_PASSWORD in .env (default admin@bitripay.local / Admin123!)`);
console.log(`agent: ${agent.email}  merchant: ${shop.email}`);
