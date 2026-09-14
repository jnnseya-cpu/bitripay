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

/** Built-in UI dictionaries shared by the web and mobile apps. Admin overrides are merged on top at runtime. */
export const LOCALES: Record<string, Record<string, string>> = { en, fr, es, pt, ar, sw, hi, bn, ln, kg, lua };
/** Partial launch packs and the language each falls back to before English (francophone Central Africa → French). */
export const LOCALE_FALLBACKS: Record<string, string> = { ln: 'fr', kg: 'fr', lua: 'fr' };
export const PARTIAL_LOCALES = Object.keys(LOCALE_FALLBACKS);

export function translate(lang: string, key: string, vars?: Record<string, string | number>, overrides?: Record<string, string>): string {
  const fallback = LOCALE_FALLBACKS[lang];
  let text = overrides?.[key] ?? LOCALES[lang]?.[key] ?? (fallback ? LOCALES[fallback]?.[key] : undefined) ?? LOCALES.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(String(v));
  return text;
}
