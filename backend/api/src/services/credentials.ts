/**
 * One place that answers "what still needs a key before this works?"
 *
 * The platform already accepted administrator-entered credentials almost everywhere: payment and mobile-money
 * providers through the gateway editor (encrypted per gateway, overriding the environment), e-mail and SMS through
 * Messaging, WhatsApp through its own screen, the exchange-rate provider through app settings, the Anthropic key
 * through the content-agent settings. What it did not have was an inventory. An operator could not find out what
 * was still unset without opening six screens and knowing what to look for, and the environment variables in
 * `.env.example` gave no hint that the console was the better place to put them.
 *
 * So this is deliberately **not** another credential store. A second place to type the same Stripe key would be two
 * sources of truth for one secret, which is how a platform ends up charging against an account nobody remembers
 * configuring. It reads the existing homes, reports what is set and where it is set, says what stops working while
 * it is missing, and owns storage for the one credential that genuinely had no console home: the Expo push token.
 *
 * No secret value is ever returned. A field reports `set` and `source`; a stored secret round-trips as the mask so
 * a form can be saved without erasing a key it was never shown.
 *
 * This module is a leaf on purpose: `config`, crypto and settings, nothing else. Low-level services import it for
 * `credential()`, so reaching for a gateway or a messaging reader here would close an import cycle and leave
 * module initialisation order deciding whether the platform boots. The console-facing inventory, which does need
 * those readers, lives in `credentialInventory.ts`.
 */
import { config } from '../config';
import { encrypt, decrypt } from '../lib/crypto';
import { getSetting, setSetting } from './settings';
import { badRequest } from '../lib/errors';

export const CREDENTIAL_MASK = '••••••••';

/** Credentials this service stores itself, because they had no console home. */
export interface OwnedField {
  key: string;
  label: string;
  secret: boolean;
  env: string;
  fromEnv: () => string;
  gates: string;
  required: boolean;
}

export const OWNED_CREDENTIALS: OwnedField[] = [
  {
    key: 'push.expoAccessToken',
    label: 'Expo push access token',
    secret: true,
    env: 'EXPO_ACCESS_TOKEN',
    fromEnv: () => config.expoAccessToken,
    gates: 'Push notifications to the phone apps. Expo delivers without a token at low volume, so this is optional until it is not.',
    required: false,
  },
];
const OWNED_BY_KEY = new Map(OWNED_CREDENTIALS.map((f) => [f.key, f]));

interface StoredCredential {
  value: string;
  updatedAt: string;
  updatedBy: string;
}
export const storedCredentials = (): Record<string, StoredCredential> => getSetting<Record<string, StoredCredential>>('credentials', {});

/** A credential this service owns: console value first, environment second. */
export function credential(key: string): string {
  const field = OWNED_BY_KEY.get(key);
  if (!field) throw new Error(`unknown credential ${key}`);
  const row = storedCredentials()[key];
  if (row?.value) {
    try {
      return field.secret ? decrypt(row.value) : row.value;
    } catch {
      return field.fromEnv() || '';
    }
  }
  return field.fromEnv() || '';
}

/**
 * The Anthropic key, resolved once for the whole platform.
 *
 * Three callers had their own copy of this. The assist runtime checked its own settings, then the content agent's,
 * then the environment; `seoAgent.ts` and `translationEngine.ts` carried byte-identical `apiKey()` functions that
 * skipped the assist setting entirely — so an administrator who set the key for assist found translation still
 * unconfigured and nothing said why. The order here keeps every place a key has ever been stored working.
 */
export function anthropicKey(assistStored?: string | null, agentStored?: string | null): string | null {
  const tryDecrypt = (v?: string | null): string | null => {
    if (!v) return null;
    try {
      return decrypt(v) || null;
    } catch {
      return null;
    }
  };
  return tryDecrypt(assistStored) ?? tryDecrypt(agentStored) ?? (config.anthropicApiKey || null);
}

/** Write the credentials this service owns. Returns which keys moved, never their values. */
export function setCredentials(patch: Record<string, unknown>, adminId: string): { changed: string[]; cleared: string[] } {
  const rows = { ...storedCredentials() };
  const changed: string[] = [];
  const cleared: string[] = [];
  for (const [key, raw] of Object.entries(patch)) {
    const field = OWNED_BY_KEY.get(key);
    if (!field) throw badRequest(`Unknown credential ${key}`, 'unknown_credential');
    const given = raw === null || raw === undefined ? '' : String(raw).trim();
    // The console shows the mask for a secret it was never given; writing it back must not erase the key.
    if (field.secret && given === CREDENTIAL_MASK) continue;
    if (!given) {
      if (rows[key]) {
        delete rows[key];
        cleared.push(key);
      }
      continue;
    }
    rows[key] = { value: field.secret ? encrypt(given) : given, updatedAt: new Date().toISOString(), updatedBy: adminId };
    changed.push(key);
  }
  setSetting('credentials', rows);
  return { changed, cleared };
}
