import Stripe from 'stripe';
import type { Request } from 'express';
import type { GatewayProvider, InitiateContext, InitiateResult, VerifyResult, GatewayPaymentRow, WebhookEvent, HealthResult, GatewayMode } from './types';

const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'XAF', 'XOF', 'UGX', 'RWF']);

function client(credentials: Record<string, string>) {
  if (!credentials.secretKey) throw new Error('Stripe secret key not configured');
  return new Stripe(credentials.secretKey);
}

function stripeAmount(minor: number, currency: string, decimals: number) {
  // Stripe expects the smallest unit; for zero-decimal currencies our minor == major.
  if (ZERO_DECIMAL.has(currency) && decimals > 0) return Math.round(minor / 10 ** decimals);
  return minor;
}

/** Stripe adapter – PaymentIntents confirmed client-side with Stripe.js, verified server-side and via webhooks. */
export const stripeProvider: GatewayProvider = {
  id: 'stripe',
  name: 'Stripe',
  supportedMethods: ['card'],
  credentialFields: [
    { key: 'secretKey', label: 'Secret key', secret: true },
    { key: 'publishableKey', label: 'Publishable key' },
    { key: 'webhookSecret', label: 'Webhook signing secret', secret: true },
  ],
  async initiate(ctx: InitiateContext): Promise<InitiateResult> {
    const stripe = client(ctx.credentials);
    const params: Stripe.PaymentIntentCreateParams = {
      amount: stripeAmount(ctx.amountMinor, ctx.currency, ctx.decimals),
      currency: ctx.currency.toLowerCase(),
      description: ctx.description,
      metadata: { bitripay_payment_id: ctx.payment.id, purpose: ctx.payment.purpose },
      automatic_payment_methods: { enabled: true },
      // 3-D Secure: 'automatic' lets Stripe/issuer decide (SCA), 'any' always challenges – configurable per gateway.
      payment_method_options: { card: { request_three_d_secure: (ctx.credentials.threeDSecure === 'any' ? 'any' : 'automatic') as 'any' | 'automatic' } },
    };
    if (ctx.payer.email) params.receipt_email = ctx.payer.email;
    if (ctx.saveCard || ctx.savedCardToken) {
      // Attach to a Stripe customer so the payment method can be reused off-session.
      const customerId = await ensureCustomer(stripe, ctx);
      params.customer = customerId;
      if (ctx.saveCard) params.setup_future_usage = 'off_session';
      if (ctx.savedCardToken) {
        params.payment_method = ctx.savedCardToken;
        params.off_session = true;
        params.confirm = true;
        delete params.automatic_payment_methods;
      }
    }
    const intent = await stripe.paymentIntents.create(params);
    if (intent.status === 'succeeded') return { providerRef: intent.id, status: 'succeeded', next: { type: 'none' }, raw: intent };
    if (intent.status === 'canceled') return { providerRef: intent.id, status: 'failed', next: { type: 'none' }, failureReason: 'Payment cancelled' };
    return {
      providerRef: intent.id,
      status: 'pending',
      next: { type: 'stripe_payment_intent', clientSecret: intent.client_secret ?? undefined, publishableKey: ctx.credentials.publishableKey },
      raw: intent,
    };
  },
  keyMode(credentials): GatewayMode {
    const k = credentials.secretKey || '';
    return k.startsWith('sk_live_') || k.startsWith('rk_live_') ? 'live' : k.startsWith('sk_test_') || k.startsWith('rk_test_') ? 'test' : 'unknown';
  },
  async healthCheck(credentials): Promise<HealthResult> {
    const mode = stripeProvider.keyMode!(credentials);
    try {
      const stripe = client(credentials);
      const bal = await stripe.balance.retrieve();
      const pubOk = !credentials.publishableKey || credentials.publishableKey.startsWith(mode === 'live' ? 'pk_live_' : 'pk_test_');
      return {
        ok: pubOk,
        mode,
        message: pubOk
          ? `Connected (${mode}) · ${bal.available.map((b) => `${b.currency.toUpperCase()} ${b.amount}`).join(', ') || 'no balance yet'}`
          : 'Secret and publishable keys are from different modes',
        details: { livemode: bal.livemode, webhookSecret: !!credentials.webhookSecret },
      };
    } catch (err) {
      return { ok: false, mode, message: (err as Error).message };
    }
  },
  async refund(payment, amountMinor, reason, credentials) {
    const stripe = client(credentials);
    const r = await stripe.refunds.create({ payment_intent: payment.provider_ref!, amount: amountMinor, reason: 'requested_by_customer', metadata: { reason } });
    return { status: r.status === 'succeeded' ? 'succeeded' : 'pending', providerRef: r.id };
  },
  async verify(payment: GatewayPaymentRow, credentials): Promise<VerifyResult> {
    if (!payment.provider_ref) return { status: 'pending' };
    const stripe = client(credentials);
    const intent = await stripe.paymentIntents.retrieve(payment.provider_ref, { expand: ['payment_method'] });
    if (intent.status === 'succeeded') {
      const pm = intent.payment_method as Stripe.PaymentMethod | null;
      const savedCard = intent.setup_future_usage && pm?.card ? { token: pm.id, brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year } : undefined;
      return { status: 'succeeded', raw: intent, savedCard };
    }
    if (intent.status === 'canceled') return { status: 'failed', failureReason: 'Payment cancelled', raw: intent };
    if (intent.last_payment_error) return { status: 'failed', failureReason: intent.last_payment_error.message ?? 'Payment failed', raw: intent };
    return { status: 'pending', raw: intent };
  },
  async parseWebhook(req: Request, credentials): Promise<WebhookEvent[]> {
    const stripe = client(credentials);
    const sig = req.headers['stripe-signature'];
    const raw = (req as any).rawBody as Buffer | undefined;
    let event: Stripe.Event;
    if (credentials.webhookSecret && sig && raw) {
      event = stripe.webhooks.constructEvent(raw, sig as string, credentials.webhookSecret);
    } else {
      if (credentials.webhookSecret) throw new Error('Missing Stripe signature');
      event = req.body as Stripe.Event;
    }
    const intent = event.data.object as Stripe.PaymentIntent;
    if (event.type === 'payment_intent.succeeded') return [{ providerRef: intent.id, status: 'succeeded', raw: event }];
    if (event.type === 'payment_intent.payment_failed' || event.type === 'payment_intent.canceled') return [{ providerRef: intent.id, status: 'failed', raw: event }];
    // Chargebacks: a dispute on the charge freezes / reverses the transfer it funded.
    if (event.type === 'charge.dispute.created')
      return [{ providerRef: String((event.data.object as any).payment_intent ?? ''), status: 'disputed', reason: (event.data.object as any).reason ?? 'dispute', raw: event }];
    if (event.type === 'charge.refunded') return [{ providerRef: String((event.data.object as any).payment_intent ?? ''), status: 'refunded', raw: event }];
    return [];
  },
};

async function ensureCustomer(stripe: Stripe, ctx: InitiateContext): Promise<string> {
  const email = ctx.payer.email ?? undefined;
  if (email) {
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data[0]) return existing.data[0].id;
  }
  const customer = await stripe.customers.create({ email, name: ctx.payer.name ?? undefined, metadata: { bitripay_user_id: ctx.payer.userId ?? '' } });
  return customer.id;
}
