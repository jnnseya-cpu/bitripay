/** Account-holder routes for open banking: institutions, links (hosted authorisation, callback, sync, revoke), statement import, transactions, income verification, VRP mandates. */
import { config } from '../config';
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { assertPin } from '../services/auth';
import { riskContext } from '../services/risk';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import { getDb } from '../db';
import { notFound } from '../lib/errors';
import {
  openBankingOverview,
  listInstitutions,
  createLink,
  completeLink,
  syncLink,
  revokeLink,
  listLinks,
  listTransactions,
  importStatement,
  verifyIncome,
  getIncomeReport,
  createMandate,
  listMandates,
  revokeMandate,
} from '../services/openBanking';

export const openBankingRouter = Router();
/** The sandbox bank's hosted authorisation page: approve or decline, then return to the app. No credentials, no real bank. */
openBankingRouter.get('/sandbox/authorise/:linkId', (req, res) => {
  const link = getDb().prepare("SELECT id, institution_name, status FROM open_banking_links WHERE id = ? AND provider = 'sandbox'").get(String(req.params.linkId)) as any;
  if (!link) throw notFound('Link not found', 'link_not_found');
  res
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8"><title>${link.institution_name} — authorise BitriPay</title><style>body{font-family:system-ui;max-width:420px;margin:48px auto;padding:0 16px;color:#1b1b1b}button{padding:12px 18px;border-radius:8px;border:0;font-size:16px;margin-right:8px}.ok{background:#0f766e;color:#fff}.no{background:#eee}</style><h1>${link.institution_name}</h1><p>BitriPay asks to read your accounts and transactions for 90 days and to make payments you confirm. This is the sandbox bank: nothing here is real.</p>${link.status === 'PENDING' ? `<form method="post" action="/api/open-banking/sandbox/authorise/${link.id}"><button class="ok" name="decision" value="approved">Approve</button><button class="no" name="decision" value="declined">Decline</button></form>` : `<p>This authorisation is already ${link.status.toLowerCase()}.</p>`}`,
    );
});
openBankingRouter.post('/sandbox/authorise/:linkId', (req, res) => {
  const link = getDb().prepare("SELECT user_id FROM open_banking_links WHERE id = ? AND provider = 'sandbox'").get(String(req.params.linkId)) as any;
  if (!link) throw notFound('Link not found', 'link_not_found');
  const decision = String(req.body?.decision ?? 'approved');
  const view = completeLink(link.user_id, String(req.params.linkId), { decision });
  if ((req.headers.accept ?? '').includes('text/html')) return res.redirect(`${config.webUrl}/app/banks?link=${view.id}&status=${view.status.toLowerCase()}`);
  res.json({ link: view });
});

openBankingRouter.use(requireAuth);
openBankingRouter.get('/', (req, res) => res.json(openBankingOverview(req.user!)));
openBankingRouter.get('/institutions', (req, res) => res.json({ items: listInstitutions(req.query.country ? String(req.query.country) : null) }));
openBankingRouter.post('/links', (req, res) => {
  const b = validate(z.object({ institutionId: z.string().min(2), redirectUrl: z.string().url().optional().nullable() }), req.body);
  res.status(201).json({ link: createLink(req.user!, b) });
});
openBankingRouter.get('/links', (req, res) => res.json({ items: listLinks(req.user!.id) }));
openBankingRouter.post('/links/:id/complete', (req, res) => res.json({ link: completeLink(req.user!.id, String(req.params.id), req.body ?? {}) }));
openBankingRouter.post('/links/:id/sync', (req, res) => res.json({ link: syncLink(req.user!.id, String(req.params.id)) }));
openBankingRouter.delete('/links/:id', (req, res) => res.json({ link: revokeLink(req.user!, String(req.params.id), { type: 'user', id: req.user!.id }) }));
openBankingRouter.get('/transactions', (req, res) =>
  res.json({
    items: listTransactions(req.user!.id, {
      linkId: req.query.link ? String(req.query.link) : null,
      accountId: req.query.account ? String(req.query.account) : null,
      limit: Number(req.query.limit) || 200,
    }),
  }),
);
openBankingRouter.post('/statements', (req, res) => {
  const b = validate(
    z.object({ institutionName: z.string().min(2).max(120), currency: z.string().length(3), accountName: z.string().max(80).optional().nullable(), csv: z.string().min(10).max(4_000_000) }),
    req.body,
  );
  res.status(201).json({ link: importStatement(req.user!, b) });
});
openBankingRouter.get('/income', (req, res) => res.json({ income: req.query.refresh === '1' ? verifyIncome(req.user!.id) : (getIncomeReport(req.user!.id) ?? verifyIncome(req.user!.id)) }));
openBankingRouter.post('/mandates', (req, res) => {
  const b = validate(
    z.object({ linkId: z.string(), accountId: z.string(), purpose: z.enum(['top_up', 'billing']), maxPerPayment: z.string(), maxPerMonth: z.string(), pin: z.string().optional() }),
    req.body,
  );
  // a mandate lets the platform draw on the bank account: step-up protected
  if (!riskContext(req).stepUpVerified) assertPin(req.user!, b.pin, req);
  const cur = getCurrency(
    String(
      listLinks(req.user!.id)
        .find((l) => l.id === b.linkId)
        ?.accounts.find((a) => a.id === b.accountId)?.currency ?? 'USD',
    ),
  );
  res.status(201).json({
    mandate: createMandate(
      req.user!,
      { linkId: b.linkId, accountId: b.accountId, purpose: b.purpose, maxPerPaymentMinor: toMinor(b.maxPerPayment, cur.decimals), maxPerMonthMinor: toMinor(b.maxPerMonth, cur.decimals) },
      { type: 'user', id: req.user!.id },
    ),
  });
});
openBankingRouter.get('/mandates', (req, res) => res.json({ items: listMandates(req.user!.id) }));
openBankingRouter.delete('/mandates/:id', (req, res) => res.json({ mandate: revokeMandate(req.user!, String(req.params.id), { type: 'user', id: req.user!.id }) }));
