import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { config } from './config';
import { getDb } from './db';
import { errorHandler, notFoundHandler } from './middleware/error';
import { siteRouter, blogApiRouter } from './routes/site';
import { ensureDefaultContent } from './content/defaults';
import { assistRouter } from './routes/assist';
import { channelsRouter } from './routes/channels';
import { v1Router as gatewayV1Router } from './routes/v1';
import { liteRouter } from './site/lite';
import { publicRouter } from './routes/public';
import { authRouter } from './routes/auth';
import { accountRouter } from './routes/account';
import { walletsRouter } from './routes/wallets';
import { transfersRouter } from './routes/transfers';
import { qrRouter } from './routes/qr';
import { paymentRequestsRouter } from './routes/paymentRequests';
import { checkoutRouter } from './routes/checkout';
import { depositsRouter, cardsRouter } from './routes/payments';
import { webhooksRouter } from './routes/webhooks';
import { virtualCardsRouter } from './routes/virtualCards';
import { bankAccountsRouter, withdrawalsRouter } from './routes/withdrawals';
import { agentsRouter } from './routes/agents';
import { remittanceRouter, recipientsRouter } from './routes/remittance';
import { billsRouter, topupRouter, giftCardsRouter } from './routes/services';
import { kycRouter } from './routes/kyc';
import { supportRouter } from './routes/support';
import { p2pRouter } from './routes/p2p';
import { merchantRouter, v1Router as merchantV1Router } from './routes/merchant';
import { adminRouter } from './routes/admin';
import { switchRouter } from './routes/switch';
import { finopsRouter } from './routes/finops';
import { riskRouter } from './routes/risk';
import { intelligenceRouter } from './routes/intelligence';
import { savingsRouter } from './routes/savings';
import { fxToolsRouter, creditRouter, billingRouter } from './routes/growth';
import { openBankingRouter } from './routes/openBanking';
import { ensureDefaultBindings } from './services/assist/bindings';
import './services/assist/meshTools';
import { ensureDefaultConnections } from './services/switch/connections';
import { ensureDefaultPolicy } from './services/risk/policy';
import { ensureMessageCatalogue } from './services/switch/payments';
import { ensureSimulationParticipants } from './services/switch/participants';
import { passkeysRouter, passkeyAuthRouter } from './routes/passkeys';
import { routingRouter } from './routes/routing';
import { evidenceRouter } from './routes/evidence';
import { payoutsRouter } from './routes/payouts';
import { idempotency } from './middleware/idempotency';
import { correlation } from './middleware/correlation';
import { ensureParseTemplates } from './services/evidence';
import { ensureMomoOperators } from './services/momo';
import { ensureDefaultCurrencies } from './services/currencies';
import { ensureAdminExists } from './services/auth';
import { ensureDefaultGateways } from './payments';
import { getSystemUser } from './services/users';
import { seedDefaultCatalogs } from './seedDefaults';

export function bootstrap() {
  getDb();
  ensureDefaultCurrencies();
  getSystemUser('treasury');
  getSystemUser('fees');
  getSystemUser('escrow');
  ensureAdminExists();
  ensureDefaultGateways();
  ensureMomoOperators();
  ensureParseTemplates();
  // National switch gateway: the DRC connection in simulation, the message catalogue and (outside production) the fictitious institutions the simulator uses.
  ensureDefaultConnections();
  ensureMessageCatalogue();
  ensureDefaultPolicy();
  ensureDefaultBindings();
  if (!config.isProduction) ensureSimulationParticipants();
  seedDefaultCatalogs();
}

export function createApp() {
  ensureDefaultContent();
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  // Correlation id first: every response (including parse errors and 404s) echoes X-Correlation-Id and every
  // service down the chain can read it from the request context.
  app.use(correlation);
  app.use(
    cors({
      origin: (origin, cb) => cb(null, true),
      credentials: true,
    }),
  );
  app.use(
    express.json({
      limit: '12mb',
      verify: (req, _res, buf) => {
        (req as any).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true }));
  app.use(idempotency);

  // Brand assets (logo, mark, favicon) served from backend/api/public/brand and proxied by the web and admin apps.
  app.use('/brand', express.static(path.join(__dirname, '..', 'public', 'brand'), { maxAge: '7d', immutable: false }));
  app.use('/api', publicRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/account', accountRouter);
  app.use('/api/account/passkeys', passkeysRouter);
  app.use('/api/auth/passkey', passkeyAuthRouter);
  app.use('/api/money', routingRouter);
  app.use('/api/evidence', evidenceRouter);
  app.use('/api/payouts', payoutsRouter);
  app.use('/api/wallets', walletsRouter);
  app.use('/api/transfers', transfersRouter);
  app.use('/api/qr', qrRouter);
  app.use('/api/payment-requests', paymentRequestsRouter);
  app.use('/api/checkout', checkoutRouter);
  app.use('/api/deposits', depositsRouter);
  app.use('/api/cards', cardsRouter);
  app.use('/api/webhooks', webhooksRouter);
  app.use('/api/virtual-cards', virtualCardsRouter);
  app.use('/api/bank-accounts', bankAccountsRouter);
  app.use('/api/withdrawals', withdrawalsRouter);
  app.use('/api/agents', agentsRouter);
  app.use('/api/remittances', remittanceRouter);
  app.use('/api/recipients', recipientsRouter);
  app.use('/api/bills', billsRouter);
  app.use('/api/topups', topupRouter);
  app.use('/api/gift-cards', giftCardsRouter);
  app.use('/api/kyc', kycRouter);
  app.use('/api/risk', riskRouter);
  app.use('/api/savings', savingsRouter);
  app.use('/api/fx-tools', fxToolsRouter);
  app.use('/api/credit', creditRouter);
  app.use('/api/billing', billingRouter);
  app.use('/api/open-banking', openBankingRouter);
  app.use('/api/support', supportRouter);
  app.use('/api/p2p', p2pRouter);
  app.use('/api/merchant', merchantRouter);
  app.use('/api/assist', assistRouter);
  app.use('/api', channelsRouter);
  // One partner API, served identically at /api/v1 and /v1: gateway (intents, QR, resolver, keys, balance), switch,
  // financial operations, intelligence, then the legacy merchant paths (/me, payment-requests, transactions).
  const partnerV1 = express.Router();
  partnerV1.use(gatewayV1Router);
  partnerV1.use(switchRouter);
  partnerV1.use(finopsRouter);
  partnerV1.use(intelligenceRouter);
  partnerV1.use(merchantV1Router);
  app.use('/api/v1', partnerV1);
  app.use('/v1', partnerV1);
  app.use('/lite', liteRouter);
  app.use('/api/admin', adminRouter);

  app.get('/', (_req, res) => res.json({ name: `${config.appName} API`, docs: '/api/health', web: config.webUrl }));
  // Public, server-rendered marketing pages, feeds and the blog JSON API.
  app.use('/api/blog', blogApiRouter);
  app.use('/', siteRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
