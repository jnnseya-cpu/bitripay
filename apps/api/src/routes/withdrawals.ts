import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap, parsePagination } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { listBankAccounts, addBankAccount, deleteBankAccount, requestWithdrawal } from '../services/withdrawals';
import { assertPin } from '../services/auth';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import { calculateFee, listTransactions, toTransaction } from '../services/ledger';

export const bankAccountsRouter = Router();
bankAccountsRouter.use(requireAuth);
bankAccountsRouter.get('/', (req, res) => res.json({ items: listBankAccounts(req.user!.id) }));
bankAccountsRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = validate(z.object({ bankName: z.string().min(2).max(120), accountName: z.string().min(2).max(120), accountNumber: z.string().min(4).max(40), currency: z.string().length(3), country: z.string().length(2).optional().nullable(), swift: z.string().max(20).optional().nullable() }), req.body);
    res.status(201).json({ bankAccount: addBankAccount(req.user!.id, body) });
  }),
);
bankAccountsRouter.delete('/:id', (req, res) => {
  deleteBankAccount(req.user!.id, String(String(req.params.id)));
  res.json({ ok: true });
});

export const withdrawalsRouter = Router();
withdrawalsRouter.use(requireAuth);
withdrawalsRouter.get('/fee', (req, res) => {
  const cur = getCurrency(String(req.query.currency || 'USD'));
  const amount = toMinor(String(req.query.amount || '0'), cur.decimals);
  res.json({ amount, fee: calculateFee('withdrawal', amount, cur.code), currency: cur.code });
});
withdrawalsRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = validate(z.object({ amount: z.string(), currency: z.string().length(3), bankAccountId: z.string(), note: z.string().max(200).optional().nullable(), pin: z.string().optional() }), req.body);
    assertPin(req.user!, body.pin);
    const cur = getCurrency(body.currency);
    const tx = requestWithdrawal(req.user!, { ...body, amount: toMinor(body.amount, cur.decimals), currency: cur.code });
    res.status(201).json({ transaction: toTransaction(tx, req.user!.id) });
  }),
);
withdrawalsRouter.get('/', (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  res.json({ ...listTransactions({ userId: req.user!.id, type: 'withdrawal', page, pageSize }), page, pageSize });
});
