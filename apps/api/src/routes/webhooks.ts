import { Router } from 'express';
import { wrap } from '../lib/http';
import { handleGatewayWebhook } from '../services/payments';

/** Inbound webhooks from payment providers: /api/webhooks/:gatewayId (stripe, paystack, flutterwave, mpesa ...). */
export const webhooksRouter = Router();

webhooksRouter.post(
  '/:gateway',
  wrap(async (req, res) => {
    try {
      const result = await handleGatewayWebhook(String(req.params.gateway), req);
      res.json({ received: true, ...result });
    } catch (err) {
      res.status(400).json({ received: false, error: (err as Error).message });
    }
  }),
);
