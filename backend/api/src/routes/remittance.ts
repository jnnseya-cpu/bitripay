import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { quoteRemittance, sendRemittance, listRemittances, getRemittance, listSavedRecipients, saveRecipient, deleteSavedRecipient } from '../services/remittance';
import { assertPin } from '../services/auth';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import { toTransaction } from '../services/ledger';
import { forbidden } from '../lib/errors';

export const remittanceRouter = Router();
remittanceRouter.use(requireAuth);

const recipientSchema = z.object({
  name: z.string().min(2).max(120),
  country: z.string().length(2).optional().nullable(),
  phone: z.string().max(20).optional().nullable(),
  email: z.string().email().optional().nullable(),
  tag: z.string().max(30).optional().nullable(),
  bankName: z.string().max(120).optional().nullable(),
  accountNumber: z.string().max(40).optional().nullable(),
  swift: z.string().max(20).optional().nullable(),
  address: z.string().max(200).optional().nullable(),
  idNumber: z.string().max(40).optional().nullable(),
});

remittanceRouter.get('/quote', (req, res) => {
  const from = getCurrency(String(req.query.from || 'USD'));
  const amount = toMinor(String(req.query.amount || '0'), from.decimals);
  res.json(quoteRemittance(amount, from.code, String(req.query.to || from.code).toUpperCase()));
});

remittanceRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        amount: z.string(),
        sourceCurrency: z.string().length(3),
        targetCurrency: z.string().length(3),
        payoutMethod: z.enum(['wallet', 'bank', 'cash_pickup']),
        recipient: recipientSchema,
        savedRecipientId: z.string().optional().nullable(),
        saveRecipient: z.boolean().optional(),
        note: z.string().max(200).optional().nullable(),
        pin: z.string().optional(),
      }),
      req.body,
    );
    assertPin(req.user!, body.pin, req);
    const from = getCurrency(body.sourceCurrency);
    const result = sendRemittance(req.user!, { ...body, amount: toMinor(body.amount, from.decimals), sourceCurrency: from.code, targetCurrency: body.targetCurrency.toUpperCase() });
    res.status(201).json({ remittance: result, transaction: toTransaction(result.transaction, req.user!.id) });
  }),
);

remittanceRouter.get('/', (req, res) => res.json({ items: listRemittances(req.user!.id) }));
remittanceRouter.get('/:id', (req, res) => {
  const r = getRemittance(String(req.params.id));
  if (r.senderUserId !== req.user!.id && r.recipientUserId !== req.user!.id && req.user!.role !== 'admin') throw forbidden();
  res.json({ remittance: r });
});

export const recipientsRouter = Router();
recipientsRouter.use(requireAuth);
recipientsRouter.get('/', (req, res) => res.json({ items: listSavedRecipients(req.user!.id) }));
recipientsRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = validate(
      recipientSchema.extend({ payoutMethod: z.enum(['wallet', 'bank', 'cash_pickup']).default('wallet'), currency: z.string().length(3).optional().nullable(), pin: z.string().optional() }),
      req.body,
    );
    assertPin(req.user!, body.pin, req); // beneficiary changes need biometrics or PIN
    const { pin: _pin, ...recipient } = body;
    res.status(201).json({ recipient: saveRecipient(req.user!.id, recipient) });
  }),
);
recipientsRouter.delete('/:id', (req, res) => {
  deleteSavedRecipient(req.user!.id, String(String(req.params.id)));
  res.json({ ok: true });
});
