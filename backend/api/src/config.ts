import path from 'node:path';
import fs from 'node:fs';

function loadDotEnv() {
  const candidates = [path.resolve(process.cwd(), '.env'), path.resolve(__dirname, '..', '.env')];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
    break;
  }
}
loadDotEnv();

const env = process.env;
const isTest = env.NODE_ENV === 'test' || !!env.VITEST;

export const config = {
  env: env.NODE_ENV || 'development',
  isProduction: env.NODE_ENV === 'production',
  isTest,
  port: Number(env.PORT || 4000),
  appName: env.APP_NAME || 'BitriPay',
  webUrl: (env.WEB_URL || 'http://localhost:5173').replace(/\/+$/, ''),
  adminUrl: (env.ADMIN_URL || 'http://localhost:5174').replace(/\/+$/, ''),
  apiUrl: (env.API_URL || `http://localhost:${env.PORT || 4000}`).replace(/\/+$/, ''),
  jwtSecret: env.JWT_SECRET || 'dev-jwt-secret-change-me',
  appSecret: env.APP_SECRET || 'dev-app-secret-change-me',
  databasePath: isTest ? ':memory:' : env.DATABASE_PATH || path.resolve(process.cwd(), 'data', 'bitripay.db'),
  baseCurrency: env.BASE_CURRENCY || 'USD',
  /** National switch: path of the certified adapter module (delivered with the official profile); empty until then. */
  switch: { adapterModule: env.SWITCH_ADAPTER_MODULE || '' },
  admin: {
    email: env.ADMIN_EMAIL || 'admin@bitripay.local',
    password: env.ADMIN_PASSWORD || 'Admin123!',
    name: env.ADMIN_NAME || 'BitriPay Admin',
  },
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    publishableKey: env.STRIPE_PUBLISHABLE_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  },
  paystack: { secretKey: env.PAYSTACK_SECRET_KEY || '' },
  flutterwave: { secretKey: env.FLUTTERWAVE_SECRET_KEY || '', webhookHash: env.FLUTTERWAVE_WEBHOOK_HASH || '' },
  mtnMomo: {
    subscriptionKey: env.MTN_MOMO_SUBSCRIPTION_KEY || '',
    apiUser: env.MTN_MOMO_API_USER || '',
    apiKey: env.MTN_MOMO_API_KEY || '',
    env: env.MTN_MOMO_ENV || 'sandbox',
  },
  mpesa: {
    consumerKey: env.MPESA_CONSUMER_KEY || '',
    consumerSecret: env.MPESA_CONSUMER_SECRET || '',
    shortcode: env.MPESA_SHORTCODE || '',
    passkey: env.MPESA_PASSKEY || '',
    env: env.MPESA_ENV || 'sandbox',
  },
  /** BTCPay Server (Greenfield) for the Bitcoin rail; empty = sandbox invoices only. */
  btcpay: {
    serverUrl: (env.BTCPAY_SERVER_URL || '').replace(/\/+$/, ''),
    storeId: env.BTCPAY_STORE_ID || '',
    apiKey: env.BTCPAY_API_KEY || '',
    webhookSecret: env.BTCPAY_WEBHOOK_SECRET || '',
    network: env.BTCPAY_NETWORK || 'mainnet',
  },
  /**
   * Direct mobile-money rails provisioned from the environment: `operator_id=collection number[:collection name]`
   * entries separated by `;`, e.g. `orange_cd=+243890000100:BitriPay SARL;mpesa_ke=+254700000100`.
   */
  momoDirectRails: (env.MOMO_DIRECT_RAILS || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [operatorId, rest = ''] = entry.split('=');
      const [collectionNumber, collectionName] = rest.split(':');
      return { operatorId: operatorId.trim(), collectionNumber: (collectionNumber || '').trim(), collectionName: (collectionName || '').trim() || null };
    })
    .filter((r) => r.operatorId && r.collectionNumber),
  /** Rails whose environment credentials pass their connectivity check are enabled at start-up (set 0 to keep manual activation). */
  railsAutoEnable: env.RAILS_AUTO_ENABLE !== '0',
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || 'BitriPay <no-reply@bitripay.local>',
  },
  sms: {
    provider: env.SMS_PROVIDER || 'console',
    twilioSid: env.TWILIO_ACCOUNT_SID || '',
    twilioToken: env.TWILIO_AUTH_TOKEN || '',
    twilioFrom: env.TWILIO_FROM || '',
  },
  expoAccessToken: env.EXPO_ACCESS_TOKEN || '',
  /** Server-side model key used by the assist runtime and the content agent when no encrypted key is stored in settings. */
  anthropicApiKey: env.ANTHROPIC_API_KEY || '',
  webauthn: {
    rpId: env.WEBAUTHN_RP_ID || '',
    origins: (env.WEBAUTHN_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  /** Demo seed defaults (country of the demo accounts; wallets follow BASE_CURRENCY). */
  seed: { country: (env.SEED_COUNTRY || 'US').toUpperCase(), writeDeviceKey: env.SEED_WRITE_DEVICE_KEY === '1' },
};

const DEV_SECRET_PREFIX = 'dev-';
const DEFAULT_ADMIN_PASSWORD = 'Admin123!';
/**
 * Insecure defaults are convenient in development and tests and a breach in production: refuse to start rather than
 * run with a guessable signing key or admin password.
 */
export function assertProductionSecrets(c: { isProduction: boolean; jwtSecret: string; appSecret: string; admin: { password: string } }): string[] {
  const problems: string[] = [];
  if (c.jwtSecret.startsWith(DEV_SECRET_PREFIX) || c.jwtSecret.length < 32) problems.push('JWT_SECRET must be set to a random value of at least 32 characters');
  if (c.appSecret.startsWith(DEV_SECRET_PREFIX) || c.appSecret.length < 32) problems.push('APP_SECRET must be set to a random value of at least 32 characters');
  if (c.admin.password === DEFAULT_ADMIN_PASSWORD || c.admin.password.length < 12) problems.push('ADMIN_PASSWORD must be set to a strong value (12+ characters, not the default)');
  if (c.isProduction && problems.length) throw new Error(`[config] refusing to start in production: ${problems.join('; ')}`);
  return problems;
}

const secretProblems = assertProductionSecrets(config);
if (secretProblems.length && !config.isTest) console.warn(`[config] development defaults in use: ${secretProblems.join('; ')}`);
