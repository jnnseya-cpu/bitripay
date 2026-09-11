import express from 'express';
import cors from 'cors';
import { config } from './config';
import { getDb } from './db';
import { errorHandler, notFoundHandler } from './middleware/error';
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
import { merchantRouter, v1Router } from './routes/merchant';
import { adminRouter } from './routes/admin';
import { passkeysRouter, passkeyAuthRouter } from './routes/passkeys';
import { routingRouter } from './routes/routing';
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
  seedDefaultCatalogs();
}

export function createApp() {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
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

  app.use('/api', publicRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/account', accountRouter);
  app.use('/api/account/passkeys', passkeysRouter);
  app.use('/api/auth/passkey', passkeyAuthRouter);
  app.use('/api/money', routingRouter);
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
  app.use('/api/support', supportRouter);
  app.use('/api/p2p', p2pRouter);
  app.use('/api/merchant', merchantRouter);
  app.use('/v1', v1Router);
  app.use('/api/admin', adminRouter);

  app.get('/', (_req, res) => res.json({ name: `${config.appName} API`, docs: '/api/health', web: config.webUrl }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
