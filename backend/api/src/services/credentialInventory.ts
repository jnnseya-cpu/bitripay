/**
 * Credential readiness for the console: what is set, where it is set, and what is waiting on it.
 *
 * Separate from `credentials.ts` because this needs the gateway, messaging and WhatsApp readers, and that module is
 * imported by low-level services — putting these imports there closed a cycle that left `preCommitHooks` undefined
 * at import time and took the whole test suite down before a single test ran. Only the admin route imports this.
 */
import { config } from '../config';
import { getSetting, getAppSettings, getSeoSettings } from './settings';
import { getSmtpSettings } from './messaging';
import { getWhatsAppSettings } from './channels/whatsapp';
import { listGateways } from '../payments';
import { anthropicKey, credential, storedCredentials, OWNED_CREDENTIALS } from './credentials';

export type CredentialSource = 'console' | 'environment' | 'unset';
/** Where an administrator sets this, so the console can link straight there. */
export type CredentialHome = 'gateways' | 'messaging' | 'whatsapp' | 'settings' | 'content-agent' | 'credentials';

export interface CredentialItem {
  key: string;
  label: string;
  home: CredentialHome;
  /** What stops working while it is unset. */
  gates: string;
  required: boolean;
  set: boolean;
  source: CredentialSource;
  env: string | null;
}

/**
 * The inventory. Reads each credential's real home and reports whether it is set, where it came from, and what is
 * waiting on it. This is the screen that answers "what do I still have to connect?" without opening six others.
 */
export function credentialInventory(): {
  items: CredentialItem[];
  summary: { total: number; set: number; missingRequired: string[] };
} {
  const items: CredentialItem[] = [];
  const push = (i: CredentialItem) => items.push(i);

  // Payment, mobile-money and Bitcoin providers: the gateway editor stores them encrypted per gateway and they
  // override the environment. `configuredKeys` reports which keys are set without ever exposing a value.
  for (const g of listGateways()) {
    const required = g.credentialFields.filter((f) => f.secret || ['secretKey', 'consumerKey', 'apiUser', 'subscriptionKey'].includes(f.key));
    if (!required.length) continue;
    const setCount = required.filter((f) => g.configuredKeys.includes(f.key)).length;
    push({
      key: `gateway.${g.id}`,
      label: g.name,
      home: 'gateways',
      gates: `${g.methods.join(', ') || 'payments'} through ${g.name}. The gateway stays off until its connectivity check passes.`,
      required: false,
      set: setCount === required.length && required.length > 0,
      source: setCount ? 'console' : 'unset',
      env: null,
    });
  }

  const smtp = getSmtpSettings();
  push({
    key: 'smtp',
    label: 'E-mail (SMTP)',
    home: 'messaging',
    gates: 'Every e-mail: address verification, password reset, statements, receipts. Without it the platform queues mail it cannot send.',
    required: true,
    set: Boolean(smtp.host && smtp.from),
    source: getSetting<Record<string, unknown>>('smtp', {}).host ? 'console' : smtp.host ? 'environment' : 'unset',
    env: 'SMTP_HOST / SMTP_USER / SMTP_PASS / SMTP_FROM',
  });

  const sms = getSetting<Record<string, string>>('sms', {});
  const smsProvider = sms.provider || config.sms.provider;
  const smsLive = smsProvider !== 'console';
  const smsKeyed =
    smsProvider === 'twilio' ? Boolean(sms.twilioToken || config.sms.twilioToken) : smsProvider === 'africastalking' ? Boolean(sms.africasTalkingApiKey || config.sms.africasTalkingApiKey) : false;
  push({
    key: 'sms',
    label: `SMS (${smsProvider})`,
    home: 'messaging',
    gates: 'One-time codes and alerts by SMS. The `console` provider writes them to the log instead of sending, which is correct for testing and wrong for customers.',
    required: true,
    set: smsLive && smsKeyed,
    source: smsLive ? (sms.provider ? 'console' : 'environment') : 'unset',
    env: 'SMS_PROVIDER / TWILIO_* / AFRICASTALKING_*',
  });

  const app = getAppSettings();
  push({
    key: 'rateProvider',
    label: `Exchange rates (${app.rateProvider || 'manual'})`,
    home: 'settings',
    gates: 'Live exchange rates. Without a keyed provider, rates are the bundled or manually imported ones and are labelled not live.',
    required: false,
    set: Boolean(app.rateProviderKey) || !['openexchangerates', 'fixer'].includes(app.rateProvider ?? ''),
    source: app.rateProviderKey ? 'console' : 'unset',
    env: null,
  });

  const wa = getWhatsAppSettings();
  push({
    key: 'whatsapp',
    label: 'WhatsApp Cloud API',
    home: 'whatsapp',
    gates: 'The WhatsApp channel: in-thread pay cards and command grammar.',
    required: false,
    set: Boolean(wa.accessToken && wa.phoneNumberId),
    source: wa.accessToken ? 'console' : 'unset',
    env: null,
  });

  const agentKey = getSeoSettings().agent.apiKey;
  push({
    key: 'ai.anthropic',
    label: 'Anthropic API key',
    home: 'content-agent',
    gates: 'The assist runtime, the content agent and the translation engine — the only parts of the platform that need an external key to work at all. Everything that moves money works without it.',
    required: false,
    set: Boolean(anthropicKey(null, agentKey)),
    source: agentKey ? 'console' : config.anthropicApiKey ? 'environment' : 'unset',
    env: 'ANTHROPIC_API_KEY',
  });

  for (const f of OWNED_CREDENTIALS) {
    const row = storedCredentials()[f.key];
    push({
      key: f.key,
      label: f.label,
      home: 'credentials',
      gates: f.gates,
      required: f.required,
      set: Boolean(credential(f.key)),
      source: row?.value ? 'console' : f.fromEnv() ? 'environment' : 'unset',
      env: f.env,
    });
  }

  return {
    items,
    summary: {
      total: items.length,
      set: items.filter((i) => i.set).length,
      missingRequired: items.filter((i) => i.required && !i.set).map((i) => i.key),
    },
  };
}
