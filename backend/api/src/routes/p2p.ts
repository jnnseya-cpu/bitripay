import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import * as p2p from '../services/p2p';
import { assertPin } from '../services/auth';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';

export const p2pRouter = Router();
p2pRouter.use(requireAuth);

p2pRouter.get('/ads', (req, res) =>
  res.json({ items: p2p.listAds({ side: req.query.side ? String(req.query.side) : undefined, currency: req.query.currency ? String(req.query.currency) : undefined, priceCurrency: req.query.priceCurrency ? String(req.query.priceCurrency) : undefined }) }),
);
p2pRouter.get('/ads/mine', (req, res) => res.json({ items: p2p.listAds({ userId: req.user!.id, includeInactive: true }) }));
p2pRouter.post(
  '/ads',
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        side: z.enum(['buy', 'sell']),
        currency: z.string().length(3),
        priceCurrency: z.string().length(3),
        rate: z.number().positive(),
        minAmount: z.string(),
        maxAmount: z.string(),
        availableAmount: z.string(),
        paymentMethods: z.array(z.string()).default(['wallet']),
        terms: z.string().max(1000).optional().nullable(),
      }),
      req.body,
    );
    const cur = getCurrency(body.currency);
    const ad = p2p.createAd(req.user!, { ...body, minAmount: toMinor(body.minAmount, cur.decimals), maxAmount: toMinor(body.maxAmount, cur.decimals), availableAmount: toMinor(body.availableAmount, cur.decimals) });
    res.status(201).json({ ad });
  }),
);
p2pRouter.post('/ads/:id/status', (req, res) => {
  const body = validate(z.object({ status: z.enum(['active', 'paused', 'closed']) }), req.body);
  res.json({ ad: p2p.setAdStatus(req.user!, String(String(req.params.id)), body.status) });
});

p2pRouter.get('/trades', (req, res) => res.json({ items: p2p.listTrades(req.user!, { status: req.query.status ? String(req.query.status) : undefined }) }));
p2pRouter.post(
  '/trades',
  wrap(async (req, res) => {
    const body = validate(z.object({ adId: z.string(), amount: z.string(), rate: z.number().positive().optional().nullable(), paymentMethod: z.string().optional(), message: z.string().max(500).optional().nullable() }), req.body);
    const ad = p2p.listAds({ includeInactive: true }).find((a) => a.id === body.adId);
    const cur = getCurrency(ad?.currency ?? 'USD');
    res.status(201).json({ trade: p2p.openTrade(req.user!, { ...body, amount: toMinor(body.amount, cur.decimals) }) });
  }),
);
p2pRouter.get('/trades/:id', (req, res) => res.json({ trade: p2p.getTrade(req.user!, String(String(req.params.id))) }));
p2pRouter.post(
  '/trades/:id/counter',
  wrap(async (req, res) => {
    const body = validate(z.object({ amount: z.string(), rate: z.number().positive(), message: z.string().max(500).optional().nullable() }), req.body);
    const trade = p2p.getTrade(req.user!, String(String(req.params.id)));
    const cur = getCurrency(trade.currency);
    res.json({ trade: p2p.counterOffer(req.user!, String(String(req.params.id)), { ...body, amount: toMinor(body.amount, cur.decimals) }) });
  }),
);
p2pRouter.post(
  '/trades/:id/accept',
  wrap(async (req, res) => {
    const body = validate(z.object({ pin: z.string().optional() }), req.body);
    assertPin(req.user!, body.pin, req);
    res.json({ trade: p2p.acceptOffer(req.user!, String(String(req.params.id))) });
  }),
);
p2pRouter.post('/trades/:id/paid', (req, res) => res.json({ trade: p2p.markPaid(req.user!, String(String(req.params.id))) }));
p2pRouter.post(
  '/trades/:id/release',
  wrap(async (req, res) => {
    const body = validate(z.object({ pin: z.string().optional() }), req.body);
    assertPin(req.user!, body.pin, req);
    res.json({ trade: p2p.release(req.user!, String(String(req.params.id))) });
  }),
);
p2pRouter.post('/trades/:id/cancel', (req, res) => res.json({ trade: p2p.cancelTrade(req.user!, String(String(req.params.id)), req.body?.reason) }));
p2pRouter.post('/trades/:id/dispute', (req, res) => {
  const body = validate(z.object({ reason: z.string().min(3).max(1000) }), req.body);
  res.json({ trade: p2p.dispute(req.user!, String(String(req.params.id)), body.reason) });
});
p2pRouter.get('/trades/:id/messages', (req, res) => res.json({ items: p2p.tradeMessages(req.user!, String(String(req.params.id)), req.query.since ? String(req.query.since) : null) }));
p2pRouter.post('/trades/:id/messages', (req, res) => {
  const body = validate(z.object({ body: z.string().min(1).max(2000) }), req.body);
  res.status(201).json({ message: p2p.sendTradeMessage(req.user!, String(String(req.params.id)), body.body) });
});
