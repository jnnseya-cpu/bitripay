/**
 * Operating-system acceptance tests (build contract §18): the ledger stays zero-sum under thousands of randomised
 * postings, the offline protocol settles a large batch in order and restores balances on failure, the locale chains
 * resolve language and currency per country without a single hard-coded market, and the savings anchor, round-ups,
 * ring-fenced holds and the live-within-means monitor behave as specified.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { setupApp, registerUser, fund, adminToken } from './helpers';
import { getDb } from '../db';
import { postTransaction, reconcileLedger, calculateFee } from '../services/ledger';
import { getUserWallet, ensureWallet } from '../services/wallets';
import { promiseCanonical } from '../services/offline';
import { resolveLocale } from '../services/locale';
import { MIN_ANCHOR_BPS } from '../services/savings';
import { listLanguages, upsertLanguage } from '../services/cms';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
  getDb().prepare("UPDATE currencies SET enabled = 1 WHERE code IN ('CDF', 'USD', 'GBP', 'EUR', 'KES', 'AED')").run();
});
const balanceOf = async (auth: Record<string, string>, currency = 'USD') =>
  ((await request(app).get('/api/wallets').set(auth)).body.items.find((w: any) => w.currency === currency)?.balance ?? 0) as number;
// deterministic pseudo-random so a failure can be replayed
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('ledger under load', () => {
  it('stays zero-sum per currency and every wallet equals its derived balance after thousands of randomised postings', async () => {
    const users = [] as Awaited<ReturnType<typeof registerUser>>[];
    for (let i = 0; i < 6; i += 1) users.push(await registerUser(app));
    for (const u of users) {
      await fund(app, u.user.id, '500.00', 'USD');
      await fund(app, u.user.id, '300.00', 'GBP');
    }
    const rand = rng(20260912);
    const currencies = ['USD', 'GBP'];
    let posted = 0;
    let refused = 0;
    let conversions = 0;
    for (let i = 0; i < 3000; i += 1) {
      const a = users[Math.floor(rand() * users.length)];
      let b = users[Math.floor(rand() * users.length)];
      if (b === a) b = users[(users.indexOf(a) + 1) % users.length];
      const currency = currencies[Math.floor(rand() * currencies.length)];
      const amount = 1 + Math.floor(rand() * 4000); // up to 40.00, sometimes more than the sender holds
      const fromWallet = getUserWallet(a.user.id, currency);
      const cross = rand() < 0.15;
      const receiveCurrency = cross ? currencies.find((c) => c !== currency)! : currency;
      const toWallet = ensureWallet(b.user.id, receiveCurrency);
      try {
        postTransaction({
          type: 'transfer',
          amount,
          fee: calculateFee('transfer', amount, currency),
          currency,
          fromWalletId: fromWallet.id,
          toWalletId: toWallet.id,
          senderUserId: a.user.id,
          receiverUserId: b.user.id,
          ...(cross ? { receiveCurrency, receiveAmount: Math.max(1, Math.round(amount * 0.8)) } : {}),
          note: `load ${i}`,
        });
        posted += 1;
        if (cross) conversions += 1;
      } catch (err: any) {
        expect(err.code ?? err.message).toMatch(/insufficient_funds|Insufficient/);
        refused += 1;
      }
    }
    expect(posted).toBeGreaterThan(2000);
    expect(refused).toBeGreaterThan(0); // the random walk did hit empty wallets
    expect(conversions).toBeGreaterThan(100);
    // 1. every transaction balances per currency and every wallet balance equals the sum of its entries
    const recon = reconcileLedger();
    expect(recon.unbalancedTransactions).toEqual([]);
    expect(recon.walletMismatches).toEqual([]);
    expect(recon.ok).toBe(true);
    expect(recon.transactionsChecked).toBeGreaterThanOrEqual(posted);
    // 2. zero-sum per currency across the whole ledger: debits == credits
    const sums = getDb()
      .prepare("SELECT w.currency, SUM(CASE WHEN e.direction = 'debit' THEN e.amount ELSE -e.amount END) net FROM ledger_entries e JOIN wallets w ON w.id = e.wallet_id GROUP BY w.currency")
      .all() as { currency: string; net: number }[];
    for (const s of sums) expect(s.net, s.currency).toBe(0);
    // 3. no user wallet went negative
    const negative = getDb().prepare('SELECT COUNT(*) c FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.is_system = 0 AND w.balance < 0').get() as { c: number };
    expect(negative.c).toBe(0);
    // 4. the API reports the same figures as the ledger
    for (const u of users) expect(await balanceOf(u.auth, 'USD')).toBe(getUserWallet(u.user.id, 'USD').balance);
  }, 120_000);
});

describe('offline batch', () => {
  it('settles fifty promises in order, refuses a replayed nonce, and restores the balance of the one that fails', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Marché Central', country: 'CD' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '60.00');
    const key = () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      return { publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), sign: (p: string) => Buffer.from(nodeSign(null, Buffer.from(p), privateKey)).toString('base64') };
    };
    const mk = key();
    const pk = key();
    const mDev = await request(app).post('/api/v1/offline/devices').set(m.auth).send({ deviceId: 'till-01', publicKey: mk.publicKey });
    const pDev = await request(app).post('/api/v1/offline/devices').set(payer.auth).send({ deviceId: 'phone-01', publicKey: pk.publicKey });
    expect(mDev.status).toBe(201);
    expect(pDev.status).toBe(201);
    // a busy market: fifty sales in one sync is normal volume, so the velocity thresholds are set for it by the platform
    const admin = await adminToken(app);
    expect((await request(app).put('/api/admin/settings/risk').set(admin.auth).send({ maxTxPerHour: 500, maxTxPerDay: 2000 })).status).toBe(200);
    expect(
      (
        await request(app)
          .put('/api/admin/risk/fraud/settings')
          .set(admin.auth)
          .send({ velocityThresholds: { hour: 500, day: 2000, week: 5000 } })
      ).status,
    ).toBe(200);
    const nonces = (await request(app).post('/api/v1/offline/nonces').set(m.auth).send({ count: 50 })).body.data as { nonce: string; expiresAt: string }[];
    expect(nonces).toHaveLength(50);
    const promise = (i: number, amountMinor: number, counter: number, nonce = nonces[i]) => {
      const base = { merchantId: m.user.id, payerId: payer.user.id, amountMinor, currency: 'USD', nonce: nonce.nonce, expiresAt: nonce.expiresAt, counter, reference: `SALE-${i}` } as any;
      const c = promiseCanonical(base);
      return { ...base, payerDeviceId: 'phone-01', merchantKeyId: mDev.body.keyId, payerKeyId: pDev.body.keyId, merchantSig: mk.sign(c), payerSig: pk.sign(c), promisedAt: new Date().toISOString() };
    };
    // 49 promises of 1.00 and one of 20.00 in the middle that the wallet cannot cover after the first 40
    const batch = Array.from({ length: 50 }, (_, i) => promise(i, i === 45 ? 2000 : 100, i + 1));
    const sync = await request(app).post('/api/v1/offline/sync').set(m.auth).send({ promises: batch });
    expect(sync.status, JSON.stringify(sync.body).slice(0, 400)).toBe(200);
    const states = sync.body.results.map((r: any) => r.state);
    expect(states.filter((s: string) => s === 'SETTLED')).toHaveLength(49);
    expect(sync.body.results[45].state).toBe('REJECTED');
    expect(sync.body.results[45].reason).toBe('insufficient_funds');
    expect(sync.body.results[45].restoreMinor).toBe(2000);
    // settled in submission order: the ledger holds them in counter order
    const refs = getDb().prepare("SELECT reference FROM offline_promises WHERE payer_user_id = ? AND sync_state = 'SETTLED' ORDER BY synced_at, payer_device_counter").all(payer.user.id) as {
      reference: string;
    }[];
    expect(refs.map((r) => r.reference)).toEqual(batch.filter((_, i) => i !== 45).map((p) => p.reference));
    expect(await balanceOf(payer.auth)).toBe(6000 - 49 * 100);
    expect(await balanceOf(m.auth)).toBe(49 * (100 - calculateFee('qr_payment', 100, 'USD')));
    // replays: the same promise is a duplicate, the same nonce under a new counter is refused and restores the payer's view
    const replay = await request(app)
      .post('/api/v1/offline/sync')
      .set(payer.auth)
      .send({ promises: [batch[3], promise(3, 100, 51)] });
    expect(replay.body.results.map((r: any) => r.state)).toEqual(['DUPLICATE', 'REJECTED']);
    expect(replay.body.results[1].reason).toBe('nonce_replayed');
    expect(replay.body.results[1].restoreMinor).toBe(100);
    expect(await balanceOf(payer.auth)).toBe(6000 - 49 * 100);
    expect(reconcileLedger().ok).toBe(true);
  }, 60_000);
});

describe('language and currency chains', () => {
  it('resolves explicit → device → IP country → default for language and explicit → wallet → IP country → browser → default for currency', async () => {
    const at = async (headers: Record<string, string>, query = '') => (await request(app).get(`/api/locale${query}`).set(headers)).body;
    // country defaults, none of them hard-coded to a single market
    const cd = await at({ 'x-ip-country': 'CD' });
    expect([cd.language, cd.languageSource, cd.currency, cd.currencySource, cd.rtl]).toEqual(['fr', 'ip_country', 'CDF', 'ip_country', false]);
    const gb = await at({ 'cf-ipcountry': 'GB' });
    expect([gb.language, gb.currency]).toEqual(['en', 'GBP']);
    const fr = await at({ 'x-ip-country': 'FR' });
    expect([fr.language, fr.currency]).toEqual(['fr', 'EUR']);
    const ke = await at({ 'x-ip-country': 'KE' });
    expect([ke.language, ke.currency]).toEqual(['sw', 'KES']);
    const ae = await at({ 'x-ip-country': 'AE' });
    expect([ae.language, ae.currency, ae.rtl]).toEqual(['ar', 'AED', true]);
    // the device beats the IP country; an explicit choice beats the device; disabled languages are skipped
    const device = await at({ 'x-ip-country': 'CD', 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.5' });
    expect([device.language, device.languageSource]).toEqual(['pt', 'device']);
    const explicit = await at({ 'x-ip-country': 'CD', 'accept-language': 'pt-BR' }, '?lang=ar');
    expect([explicit.language, explicit.languageSource, explicit.rtl]).toEqual(['ar', 'explicit', true]);
    upsertLanguage({ ...listLanguages().find((l) => l.code === 'pt')!, enabled: false });
    const skipped = await at({ 'x-ip-country': 'CD', 'accept-language': 'pt-BR,de;q=0.8' });
    expect([skipped.language, skipped.languageSource]).toEqual(['fr', 'ip_country']);
    upsertLanguage({ ...listLanguages().find((l) => l.code === 'pt')!, enabled: true });
    // currency: browser hint is used only when the IP country gives nothing usable, and never a disabled currency
    const browser = await at({ 'x-currency': 'GBP' });
    expect([browser.currency, browser.currencySource]).toEqual(['GBP', 'browser']);
    const disabled = await at({ 'x-currency': 'XXX', 'x-ip-country': 'ZZ' });
    expect(disabled.currencySource).toBe('default');
    // an account holder's most-used wallet wins over the IP country; a stored language preference is explicit
    const u = await registerUser(app, { country: 'GB' });
    await fund(app, u.user.id, '10.00', 'GBP');
    const mine = await at({ ...u.auth, 'x-ip-country': 'CD' });
    expect([mine.currency, mine.currencySource]).toEqual(['GBP', 'wallet']);
    getDb().prepare("UPDATE users SET language = 'fr' WHERE id = ?").run(u.user.id);
    const stored = resolveLocale({ userId: u.user.id, acceptLanguage: 'en-GB', ipCountry: 'GB' });
    expect([stored.language, stored.languageSource]).toEqual(['fr', 'explicit']);
    expect(await at({ 'x-ip-country': 'CD' }, '?currency=EUR').then((b) => [b.currency, b.currencySource])).toEqual(['EUR', 'explicit']);
    expect(cd.chain).toEqual({ languages: ['explicit', 'device', 'ip_country', 'default'], currencies: ['explicit', 'wallet', 'ip_country', 'browser', 'default'] });
  });
});

describe('savings anchor, round-ups and wellbeing', () => {
  it('anchors 10% of every income into the default goal, rounds up spending, ring-fences the money from being spent, and never lets the anchor drop below 10%', async () => {
    const payer = await registerUser(app);
    const saver = await registerUser(app);
    await fund(app, payer.user.id, '400.00');
    const goal = await request(app).post('/api/savings/goals').set(saver.auth).send({ name: 'Moto', currency: 'USD', target: '50.00', makeDefault: true });
    expect(goal.status, JSON.stringify(goal.body)).toBe(201);
    expect((await request(app).put('/api/savings/settings').set(saver.auth).send({ autoAnchor: true, anchorBps: 500 })).body.error.code).toBe('anchor_below_minimum');
    const settings = await request(app).put('/api/savings/settings').set(saver.auth).send({ autoAnchor: true, roundUps: true, roundToMinor: 100 });
    expect(settings.status).toBe(200);
    expect(settings.body.anchorBps).toBe(MIN_ANCHOR_BPS);
    // income: 100.00 arrives → 10.00 is set aside automatically
    const t1 = await request(app).post('/api/transfers').set(payer.auth).send({ to: saver.user.tag, amount: '100.00', currency: 'USD', pin: '1234' });
    expect(t1.status, JSON.stringify(t1.body)).toBe(201);
    let g = (await request(app).get(`/api/savings/goals/${goal.body.id}`).set(saver.auth)).body;
    expect(g.goal.savedMinor).toBe(1000);
    expect(g.movements[0]).toMatchObject({ kind: 'anchor', amountMinor: 1000, sourceTransactionId: t1.body.transaction.id });
    // spending 12.30 rounds up by 0.70; the 0.70 is ring-fenced as well
    const t2 = await request(app).post('/api/transfers').set(saver.auth).send({ to: payer.user.tag, amount: '12.30', currency: 'USD', pin: '1234' });
    expect(t2.status, JSON.stringify(t2.body)).toBe(201);
    g = (await request(app).get(`/api/savings/goals/${goal.body.id}`).set(saver.auth)).body;
    expect(g.goal.savedMinor).toBe(1070);
    expect(g.movements[0]).toMatchObject({ kind: 'round_up', amountMinor: 70 });
    // the wallet still shows the full balance, but the ring-fenced 10.70 cannot be spent
    const fee = calculateFee('transfer', 1230, 'USD');
    const balance = await balanceOf(saver.auth);
    expect(balance).toBe(10000 - 1230 - fee);
    const available = balance - 1070;
    const tooMuch = await request(app)
      .post('/api/transfers')
      .set(saver.auth)
      .send({ to: payer.user.tag, amount: ((available + 50) / 100).toFixed(2), currency: 'USD', pin: '1234' });
    expect(tooMuch.status, JSON.stringify(tooMuch.body)).toBe(422);
    expect(tooMuch.body.error.code).toBe('insufficient_funds');
    expect(tooMuch.body.error.details?.held).toBe(1070);
    // manual contribution and withdrawal move money between the goal and the spendable balance without leaving the ledger
    const contributed = await request(app).post(`/api/savings/goals/${goal.body.id}/contribute`).set(saver.auth).send({ amount: '5.00' });
    expect(contributed.body.savedMinor).toBe(1570);
    const withdrawn = await request(app).post(`/api/savings/goals/${goal.body.id}/withdraw`).set(saver.auth).send({ amount: '12.00' });
    expect(withdrawn.body.savedMinor).toBe(370);
    expect(await balanceOf(saver.auth)).toBe(balance); // wallet balance unchanged: holds are not movements
    const heldNow = (getDb().prepare("SELECT COALESCE(SUM(amount_minor), 0) s FROM holds WHERE status = 'ACTIVE' AND ref_id = ?").get(goal.body.id) as any).s;
    expect(heldNow).toBe(370);
    const overview = await request(app).get('/api/savings').set(saver.auth);
    expect(overview.body.minimumAnchorBps).toBe(1000);
    expect(overview.body.goals[0].progress).toBeCloseTo(370 / 5000, 5);
    // wellbeing: the payer received nothing and spent → red with a concrete plan; the saver is green
    const wb = await request(app).get('/api/savings/wellbeing').set(payer.auth);
    const usd = wb.body.currencies.find((c: any) => c.currency === 'USD');
    expect(usd.state).toBe('red');
    expect(usd.plan.weeklySavingMinor).toBeGreaterThan(0);
    expect(usd.plan.cutFrom[0].type).toBe('transfer');
    expect(usd.plan.message).toMatch(/more than you received/);
    expect(wb.body.overall).toBe('red');
    const saverWb = (await request(app).get('/api/savings/wellbeing').set(saver.auth)).body;
    expect(saverWb.currencies.find((c: any) => c.currency === 'USD').state).toBe('green');
    // closing the goal releases everything
    const closed = await request(app).delete(`/api/savings/goals/${goal.body.id}`).set(saver.auth);
    expect(closed.body.status).toBe('CLOSED');
    expect((getDb().prepare("SELECT COUNT(*) c FROM holds WHERE status = 'ACTIVE' AND ref_id = ?").get(goal.body.id) as any).c).toBe(0);
    expect(reconcileLedger().ok).toBe(true);
  });
});
