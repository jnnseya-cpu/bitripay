/**
 * Smart restricted wallets, account-holder side (specification §61). Mounted at /api/restricted: a beneficiary lists
 * the restricted wallets opened for them, checks whether a merchant qualifies, and pays an eligible merchant (or one
 * of its payment intents) from the restricted balance. Programmes, wallet opening and funding are administrator
 * actions under /api/admin/insights/restricted.
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { assertPin } from '../services/auth';
import { forbidden, notFound } from '../lib/errors';
import { findUserByIdentifier, usersById } from '../services/users';
import { toTransaction } from '../services/ledger';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import { listRestrictedWallets, getRestrictedWallet, getProgramme, merchantEligibility, payFromRestrictedWallet } from '../services/restrictedWallets';

export const restrictedRouter = Router();
restrictedRouter.use(requireAuth);
const writeLimit = rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'restricted' });

restrictedRouter.get('/wallets', (req, res) => res.json({ items: listRestrictedWallets(req.user!.id) }));
restrictedRouter.get('/wallets/:id', (req, res) => {
  const w = getRestrictedWallet(String(req.params.id));
  if (w.userId !== req.user!.id) throw forbidden('This restricted wallet belongs to another account', 'not_owner');
  res.json({ wallet: w, programme: getProgramme(w.programmeId) });
});
/** Can this merchant be paid from the wallet? The answer names the rule that applies. */
restrictedRouter.get('/wallets/:id/eligibility', (req, res) => {
  const w = getRestrictedWallet(String(req.params.id));
  if (w.userId !== req.user!.id) throw forbidden('This restricted wallet belongs to another account', 'not_owner');
  const merchant = req.query.merchant ? findUserByIdentifier(String(req.query.merchant)) : undefined;
  if (!merchant) throw notFound('Merchant not found', 'merchant_not_found');
  res.json({ merchantId: merchant.id, ...merchantEligibility(getProgramme(w.programmeId), merchant) });
});
restrictedRouter.post('/wallets/:id/pay', writeLimit, (req, res) => {
  const b = validate(
    z.object({
      merchant: z.string().min(2).optional().nullable(),
      intentId: z.string().optional().nullable(),
      amount: z.string().optional().nullable(),
      note: z.string().max(200).optional().nullable(),
      pin: z.string().optional(),
    }),
    req.body,
  );
  assertPin(req.user!, b.pin, req);
  const w = getRestrictedWallet(String(req.params.id));
  const cur = getCurrency(w.currency);
  const tx = payFromRestrictedWallet(req.user!, {
    restrictedWalletId: w.id,
    merchant: b.merchant ?? null,
    intentId: b.intentId ?? null,
    amountMinor: b.amount ? toMinor(b.amount, cur.decimals) : null,
    note: b.note ?? null,
  });
  res.status(201).json({ transaction: toTransaction(tx, req.user!.id, usersById([tx.receiver_user_id!])), wallet: getRestrictedWallet(w.id) });
});
