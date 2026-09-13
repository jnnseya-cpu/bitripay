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
};

if (config.isProduction && (config.jwtSecret.startsWith('dev-') || config.appSecret.startsWith('dev-'))) {
  // eslint-disable-next-line no-console
  console.warn('[config] WARNING: JWT_SECRET / APP_SECRET are using insecure defaults in production!');
}
