import { Router } from 'express';
import { z } from 'zod';
import { cleanText, validate, wrap } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { sendMoney } from '../services/transfers';
import { toTransaction, calculateFee } from '../services/ledger';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import { assertPin } from '../services/auth';
import { usersById } from '../services/users';
import { riskContext } from '../services/risk';

export const transfersRouter = Router();
transfersRouter.use(requireAuth);

const schema = z.object({
  to: z.string().min(2),
  amount: z.string(),
  currency: z.string().length(3),
  note: cleanText(200).optional().nullable(),
  pin: z.string().optional(),
  idempotencyKey: z.string().max(100).optional().nullable(),
});

transfersRouter.get('/fee', (req, res) => {
  const cur = getCurrency(String(req.query.currency || ''));
  const amount = toMinor(String(req.query.amount || '0'), cur.decimals);
  const type = String(req.query.type || 'transfer');
  const fee = calculateFee(type, amount, cur.code, null, { userId: req.user!.id });
  res.json({ amount, fee, total: amount + fee, currency: cur.code });
});

transfersRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = validate(schema, req.body);
    assertPin(req.user!, body.pin, req);
    const cur = getCurrency(body.currency);
    const tx = sendMoney(req.user!, { to: body.to, amount: toMinor(body.amount, cur.decimals), currency: cur.code, note: body.note, idempotencyKey: body.idempotencyKey, ...riskContext(req) });
    res.status(201).json({ transaction: toTransaction(tx, req.user!.id, usersById([tx.receiver_user_id!])) });
  }),
);
