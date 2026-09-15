import { en } from './en';
import { fr } from './fr';
import { es } from './es';
import { pt } from './pt';
import { ar } from './ar';
import { sw } from './sw';
import { hi } from './hi';
import { bn } from './bn';
import { ln } from './ln';
import { kg } from './kg';
import { lua } from './lua';
import { frPhrases } from './phrases/fr';

/** Built-in UI dictionaries shared by the web and mobile apps. Admin overrides are merged on top at runtime. */
/** Phrase packs translate the app's English sentences by phrase (see `phrases/catalogue.ts`); keyed packs translate by key. */
export const LOCALES: Record<string, Record<string, string>> = { en, fr: { ...fr, ...frPhrases }, es, pt, ar, sw, hi, bn, ln, kg, lua };
/**
 * Regional fallback before English for the Central-African packs (a key added to `en` before its translation lands
 * shows in French rather than English). Every shipped pack is complete: the parity test enforces it.
 */
export const LOCALE_FALLBACKS: Record<string, string> = { ln: 'fr', kg: 'fr', lua: 'fr' };
/** No pack ships partially any more; kept for callers that checked it. */
export const PARTIAL_LOCALES: string[] = [];
export { PHRASES } from './phrases/catalogue';

export function translate(lang: string, key: string, vars?: Record<string, string | number>, overrides?: Record<string, string>): string {
  const fallback = LOCALE_FALLBACKS[lang];
  let text = overrides?.[key] ?? LOCALES[lang]?.[key] ?? (fallback ? LOCALES[fallback]?.[key] : undefined) ?? LOCALES.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(String(v));
  return text;
}
