import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, fund, adminToken } from './helpers';
import { getCurrency } from '../services/currencies';
import { getAppSettings } from '../services/settings';
import { applyBps } from '@bitripay/shared';

/*
 * End-to-end P2P marketplace: a seller publishes a USD ad priced in CDF, a buyer opens a trade,
 * the seller accepts under PIN and the ledger settles both legs; then the external-payment path
 * (escrow → paid → release), negotiation, cancellation with refund, and an admin-resolved dispute.
 */

const app = setupApp();
const usd = () => getCurrency('USD');
const cdf = () => getCurrency('CDF');
const RATE = 2850; // CDF per USD

async function balance(auth: Record<string, string>, currency: string) {
  const res = await request(app).get('/api/wallets').set(auth);
  expect(res.status).toBe(200);
  return (res.body.items.find((w: any) => w.currency === currency)?.balance ?? 0) as number;
}

async function publishSellAd(seller: Awaited<ReturnType<typeof registerUser>>, methods = ['wallet'], available = '200') {
  const res = await request(app)
    .post('/api/p2p/ads')
    .set(seller.auth)
    .send({ side: 'sell', currency: 'USD', priceCurrency: 'CDF', rate: RATE, minAmount: '10', maxAmount: '100', availableAmount: available, paymentMethods: methods, terms: '' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.ad as any;
}

describe('P2P marketplace', () => {
  let seller: Awaited<ReturnType<typeof registerUser>>;
  let buyer: Awaited<ReturnType<typeof registerUser>>;

  beforeAll(async () => {
    seller = await registerUser(app);
    buyer = await registerUser(app);
    await fund(app, seller.user.id, '500.00', 'USD');
    await fund(app, buyer.user.id, '1000000.00', 'CDF');
  });

  it('refuses a sell ad the seller cannot cover, then publishes one they can', async () => {
    const tooBig = await request(app)
      .post('/api/p2p/ads')
      .set(seller.auth)
      .send({ side: 'sell', currency: 'USD', priceCurrency: 'CDF', rate: RATE, minAmount: '10', maxAmount: '100', availableAmount: '5000', paymentMethods: ['wallet'] });
    expect(tooBig.status).toBe(422);
    expect(tooBig.body.error.code).toBe('insufficient_funds');

    const ad = await publishSellAd(seller);
    expect(ad.status).toBe('active');
    expect(ad.availableAmount).toBe(20000);
    expect(ad.user.stats).toEqual({ trades: 0, completionRate: 100 });

    const market = await request(app).get('/api/p2p/ads?side=sell&currency=usd').set(buyer.auth);
    expect(market.status).toBe(200);
    expect(market.body.items.map((a: any) => a.id)).toContain(ad.id);

    const own = await request(app).post('/api/p2p/trades').set(seller.auth).send({ adId: ad.id, amount: '50' });
    expect(own.status).toBe(400);
    const tooSmall = await request(app).post('/api/p2p/trades').set(buyer.auth).send({ adId: ad.id, amount: '5' });
    expect(tooSmall.status).toBe(400);
  });

  it('settles a wallet-paid trade atomically: seller pays the fee in USD, buyer pays the price in CDF', async () => {
    const ad = await publishSellAd(seller);
    const sellerUsd = await balance(seller.auth, 'USD');
    const buyerCdf = await balance(buyer.auth, 'CDF');
    const buyerUsd = await balance(buyer.auth, 'USD');
    const sellerCdf = await balance(seller.auth, 'CDF');

    const opened = await request(app).post('/api/p2p/trades').set(buyer.auth).send({ adId: ad.id, amount: '50', paymentMethod: 'wallet', message: 'Bonjour' });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const trade = opened.body.trade;
    expect(trade.status).toBe('negotiating');
    expect(trade.buyerId).toBe(buyer.user.id);
    expect(trade.sellerId).toBe(seller.user.id);
    expect(trade.amount).toBe(5000);
    expect(trade.priceAmount).toBe(Math.round(50 * RATE * 10 ** cdf().decimals));
    expect(trade.offers).toHaveLength(1);
    expect(trade.offers[0].status).toBe('pending');

    // The party who made the offer cannot accept their own offer.
    const selfAccept = await request(app).post(`/api/p2p/trades/${trade.id}/accept`).set(buyer.auth).send({ pin: '1234' });
    expect(selfAccept.status).toBe(400);
    // A wrong PIN is refused before anything moves.
    const badPin = await request(app).post(`/api/p2p/trades/${trade.id}/accept`).set(seller.auth).send({ pin: '0000' });
    expect(badPin.status).toBeGreaterThanOrEqual(400);

    const accepted = await request(app).post(`/api/p2p/trades/${trade.id}/accept`).set(seller.auth).send({ pin: '1234' });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.trade.status).toBe('completed');
    expect(accepted.body.trade.completedAt).toBeTruthy();

    const fee = applyBps(5000, getAppSettings().p2pFeeBps);
    expect(await balance(seller.auth, 'USD')).toBe(sellerUsd - 5000 - fee);
    expect(await balance(buyer.auth, 'USD')).toBe(buyerUsd + 5000);
    expect(await balance(buyer.auth, 'CDF')).toBe(buyerCdf - trade.priceAmount);
    expect(await balance(seller.auth, 'CDF')).toBe(sellerCdf + trade.priceAmount);

    const after = await request(app).get('/api/p2p/ads/mine').set(seller.auth);
    expect(after.body.items.find((a: any) => a.id === ad.id).availableAmount).toBe(20000 - 5000);

    const list = await request(app).get('/api/p2p/trades?status=completed').set(buyer.auth);
    expect(list.body.items.map((t: any) => t.id)).toContain(trade.id);
    const stranger = await registerUser(app);
    const peek = await request(app).get(`/api/p2p/trades/${trade.id}`).set(stranger.auth);
    expect(peek.status).toBe(403);
  });

  it('holds escrow for an external payment until the seller releases it', async () => {
    const ad = await publishSellAd(seller, ['wallet', 'bank_transfer']);
    const sellerUsd = await balance(seller.auth, 'USD');
    const buyerUsd = await balance(buyer.auth, 'USD');

    const opened = await request(app).post('/api/p2p/trades').set(buyer.auth).send({ adId: ad.id, amount: '20', paymentMethod: 'bank_transfer' });
    expect(opened.status).toBe(201);
    const trade = opened.body.trade;
    expect(trade.paymentMethod).toBe('external');

    const accepted = await request(app).post(`/api/p2p/trades/${trade.id}/accept`).set(seller.auth).send({ pin: '1234' });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.trade.status).toBe('escrowed');
    const fee = applyBps(2000, getAppSettings().p2pFeeBps);
    expect(await balance(seller.auth, 'USD')).toBe(sellerUsd - 2000 - fee);
    expect(await balance(buyer.auth, 'USD')).toBe(buyerUsd);

    const sellerPaid = await request(app).post(`/api/p2p/trades/${trade.id}/paid`).set(seller.auth);
    expect(sellerPaid.status).toBe(403);
    const paid = await request(app).post(`/api/p2p/trades/${trade.id}/paid`).set(buyer.auth);
    expect(paid.status).toBe(200);
    expect(paid.body.trade.status).toBe('paid');

    const chat = await request(app).post(`/api/p2p/trades/${trade.id}/messages`).set(buyer.auth).send({ body: 'Sent by bank transfer, ref 4471' });
    expect(chat.status).toBe(201);
    const messages = await request(app).get(`/api/p2p/trades/${trade.id}/messages`).set(seller.auth);
    expect(messages.body.items.map((m: any) => m.body)).toEqual(['Sent by bank transfer, ref 4471']);

    const buyerRelease = await request(app).post(`/api/p2p/trades/${trade.id}/release`).set(buyer.auth).send({ pin: '1234' });
    expect(buyerRelease.status).toBe(403);
    const released = await request(app).post(`/api/p2p/trades/${trade.id}/release`).set(seller.auth).send({ pin: '1234' });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body.trade.status).toBe('completed');
    expect(await balance(buyer.auth, 'USD')).toBe(buyerUsd + 2000);
  });

  it('negotiates with counter-offers and lets either side cancel before acceptance', async () => {
    const ad = await publishSellAd(seller);
    const opened = await request(app).post('/api/p2p/trades').set(buyer.auth).send({ adId: ad.id, amount: '40', rate: 2800 });
    expect(opened.status).toBe(201);
    const trade = opened.body.trade;
    expect(trade.rate).toBe(2800);

    const counter = await request(app).post(`/api/p2p/trades/${trade.id}/counter`).set(seller.auth).send({ amount: '40', rate: 2830, message: 'Meet in the middle' });
    expect(counter.status, JSON.stringify(counter.body)).toBe(200);
    expect(counter.body.trade.rate).toBe(2830);
    expect(counter.body.trade.priceAmount).toBe(Math.round(40 * 2830 * 10 ** cdf().decimals));
    expect(counter.body.trade.offers.map((o: any) => o.status)).toEqual(['superseded', 'pending']);

    // Now it is the buyer's turn: the seller cannot accept their own counter-offer.
    const sellerAccept = await request(app).post(`/api/p2p/trades/${trade.id}/accept`).set(seller.auth).send({ pin: '1234' });
    expect(sellerAccept.status).toBe(400);

    const cancelled = await request(app).post(`/api/p2p/trades/${trade.id}/cancel`).set(buyer.auth).send({ reason: 'Changed my mind' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.trade.status).toBe('cancelled');
    const again = await request(app).post(`/api/p2p/trades/${trade.id}/accept`).set(buyer.auth).send({ pin: '1234' });
    expect(again.status).toBe(409);
  });

  it('refunds the seller when the buyer cancels an escrowed trade', async () => {
    const ad = await publishSellAd(seller, ['bank_transfer']);
    const sellerUsd = await balance(seller.auth, 'USD');
    const opened = await request(app).post('/api/p2p/trades').set(buyer.auth).send({ adId: ad.id, amount: '30' });
    expect(opened.status).toBe(201);
    const trade = opened.body.trade;
    const accepted = await request(app).post(`/api/p2p/trades/${trade.id}/accept`).set(seller.auth).send({ pin: '1234' });
    expect(accepted.body.trade.status).toBe('escrowed');
    expect(await balance(seller.auth, 'USD')).toBeLessThan(sellerUsd);

    const sellerCancel = await request(app).post(`/api/p2p/trades/${trade.id}/cancel`).set(seller.auth).send({});
    expect(sellerCancel.status).toBe(409);
    const cancelled = await request(app).post(`/api/p2p/trades/${trade.id}/cancel`).set(buyer.auth).send({ reason: 'Bank is down' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.trade.status).toBe('cancelled');
    expect(await balance(seller.auth, 'USD')).toBe(sellerUsd);
    const mine = await request(app).get('/api/p2p/ads/mine').set(seller.auth);
    expect(mine.body.items.find((a: any) => a.id === ad.id).availableAmount).toBe(20000);
  });

  it('lets an administrator resolve a dispute either way', async () => {
    const admin = await adminToken(app);
    const ad = await publishSellAd(seller, ['bank_transfer']);
    const sellerUsd = await balance(seller.auth, 'USD');
    const buyerUsd = await balance(buyer.auth, 'USD');

    // Dispute → refund to seller
    const t1 = (await request(app).post('/api/p2p/trades').set(buyer.auth).send({ adId: ad.id, amount: '10' })).body.trade;
    await request(app).post(`/api/p2p/trades/${t1.id}/accept`).set(seller.auth).send({ pin: '1234' });
    const disputed = await request(app).post(`/api/p2p/trades/${t1.id}/dispute`).set(seller.auth).send({ reason: 'Buyer never paid' });
    expect(disputed.status).toBe(200);
    expect(disputed.body.trade.status).toBe('disputed');
    const stats = await request(app).get('/api/admin/p2p/stats').set(admin.auth);
    expect(stats.status).toBe(200);
    expect(stats.body.tradesByStatus.disputed).toBeGreaterThanOrEqual(1);
    const refunded = await request(app).post(`/api/admin/p2p/trades/${t1.id}/resolve`).set(admin.auth).send({ outcome: 'refund', note: 'No proof of payment' });
    expect(refunded.status, JSON.stringify(refunded.body)).toBe(200);
    expect(refunded.body.trade.status).toBe('refunded');
    expect(await balance(seller.auth, 'USD')).toBe(sellerUsd);

    // Dispute → release to buyer
    const t2 = (await request(app).post('/api/p2p/trades').set(buyer.auth).send({ adId: ad.id, amount: '10' })).body.trade;
    await request(app).post(`/api/p2p/trades/${t2.id}/accept`).set(seller.auth).send({ pin: '1234' });
    await request(app).post(`/api/p2p/trades/${t2.id}/paid`).set(buyer.auth);
    const d2 = await request(app).post(`/api/p2p/trades/${t2.id}/dispute`).set(buyer.auth).send({ reason: 'Seller will not release' });
    expect(d2.body.trade.status).toBe('disputed');
    const released = await request(app).post(`/api/admin/p2p/trades/${t2.id}/resolve`).set(admin.auth).send({ outcome: 'release', note: 'Bank statement shows the transfer' });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body.trade.status).toBe('completed');
    expect(await balance(buyer.auth, 'USD')).toBe(buyerUsd + 1000);
    expect(await balance(seller.auth, 'USD')).toBe(sellerUsd - 1000 - applyBps(1000, getAppSettings().p2pFeeBps));

    const trades = await request(app).get('/api/admin/p2p/trades').set(admin.auth);
    expect(trades.body.items.map((t: any) => t.id)).toEqual(expect.arrayContaining([t1.id, t2.id]));
    const usdAd = usd();
    expect(usdAd.decimals).toBe(2);
  });
});
