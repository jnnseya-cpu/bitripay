import { Router } from 'express';
import { wrap } from '../lib/http';
import { handleGatewayWebhook } from '../services/payments';
import { getGateway, getGatewayCredentials, listGateways } from '../payments';
import { ingestEvidence } from '../services/evidence';
import { safeEqual } from '../lib/crypto';

/** Inbound webhooks from payment providers: /api/webhooks/:gatewayId (stripe, paystack, flutterwave, mpesa ...). */
export const webhooksRouter = Router();

webhooksRouter.post(
  '/:gateway',
  wrap(async (req, res) => {
    try {
      const id = String(req.params.gateway);
      const gateway = getGateway(id) ?? listGateways().find((g) => g.provider === id);
      if (gateway && (gateway.provider === 'manual_momo' || gateway.provider === 'manual_bank')) {
        // Legacy shared-secret SMS forwarder. Treated as evidence, not as a processor callback: it only
        // settles automatically when the administrator has explicitly enabled sharedSecretAutoConfirm.
        const creds = getGatewayCredentials(gateway.id);
        const secret = String(req.body?.secret ?? '');
        if (!creds.smsSecret || !secret || !safeEqual(secret, creds.smsSecret)) return res.status(400).json({ received: false, error: 'Invalid secret' });
        const text = String(req.body?.text ?? req.body?.message ?? '');
        if (!text) return res.status(400).json({ received: false, error: 'text is required' });
        const ev = ingestEvidence({ source: 'shared_secret', text, from: req.body?.from ? String(req.body.from) : null, operatorId: req.body?.operatorId ? String(req.body.operatorId) : null, receivedAt: req.body?.receivedAt ? String(req.body.receivedAt) : null, actor: { type: 'device', id: `shared_secret:${gateway.id}` } });
        return res.json({ received: true, handled: ev.paymentId ? 1 : 0, evidence: { id: ev.id, outcome: ev.outcome, confidence: ev.confidence, reasons: ev.reasons, paymentId: ev.paymentId } });
      }
      const result = await handleGatewayWebhook(id, req);
      res.json({ received: true, ...result });
    } catch (err) {
      res.status(400).json({ received: false, error: (err as Error).message });
    }
  }),
);
