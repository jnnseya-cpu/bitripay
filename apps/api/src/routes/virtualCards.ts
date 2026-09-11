import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { listVirtualCards, issueVirtualCard, revealVirtualCard, setVirtualCardStatus, fundVirtualCard, withdrawFromVirtualCard, virtualCardTransactions } from '../services/virtualCards';
import { assertPin } from '../services/auth';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import { toTransaction } from '../services/ledger';

export const virtualCardsRouter = Router();
virtualCardsRouter.use(requireAuth);

virtualCardsRouter.get('/', (req, res) => res.json({ items: listVirtualCards(req.user!.id) }));
virtualCardsRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = validate(z.object({ currency: z.string().length(3), label: z.string().max(40).optional().nullable(), pin: z.string().optional() }), req.body);
    assertPin(req.user!, body.pin);
    res.status(201).json({ card: issueVirtualCard(req.user!, body.currency.toUpperCase(), body.label) });
  }),
);
virtualCardsRouter.post(
  '/:id/reveal',
  wrap(async (req, res) => {
    const body = validate(z.object({ pin: z.string() }), req.body);
    assertPin(req.user!, body.pin);
    res.json({ card: revealVirtualCard(req.user!.id, String(String(req.params.id))) });
  }),
);
virtualCardsRouter.post('/:id/freeze', (req, res) => res.json({ card: setVirtualCardStatus(req.user!.id, String(String(req.params.id)), 'frozen') }));
virtualCardsRouter.post('/:id/unfreeze', (req, res) => res.json({ card: setVirtualCardStatus(req.user!.id, String(String(req.params.id)), 'active') }));
virtualCardsRouter.post('/:id/close', (req, res) => res.json({ card: setVirtualCardStatus(req.user!.id, String(String(req.params.id)), 'closed') }));
virtualCardsRouter.post(
  '/:id/fund',
  wrap(async (req, res) => {
    const body = validate(z.object({ amount: z.string(), pin: z.string().optional() }), req.body);
    assertPin(req.user!, body.pin);
    const card = listVirtualCards(req.user!.id).find((c) => c.id === String(String(req.params.id)));
    const cur = getCurrency(card?.currency ?? 'USD');
    res.json({ card: fundVirtualCard(req.user!, String(String(req.params.id)), toMinor(body.amount, cur.decimals)) });
  }),
);
virtualCardsRouter.post(
  '/:id/withdraw',
  wrap(async (req, res) => {
    const body = validate(z.object({ amount: z.string(), pin: z.string().optional() }), req.body);
    assertPin(req.user!, body.pin);
    const card = listVirtualCards(req.user!.id).find((c) => c.id === String(String(req.params.id)));
    const cur = getCurrency(card?.currency ?? 'USD');
    res.json({ card: withdrawFromVirtualCard(req.user!, String(String(req.params.id)), toMinor(body.amount, cur.decimals)) });
  }),
);
virtualCardsRouter.get('/:id/transactions', (req, res) => res.json({ items: virtualCardTransactions(req.user!.id, String(String(req.params.id))).map((t) => toTransaction(t, req.user!.id)) }));
