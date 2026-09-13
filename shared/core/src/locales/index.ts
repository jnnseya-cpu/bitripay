import { en } from './en';
import { fr } from './fr';
import { es } from './es';
import { pt } from './pt';
import { ar } from './ar';
import { sw } from './sw';
import { hi } from './hi';
import { bn } from './bn';

/** Built-in UI dictionaries shared by the web and mobile apps. Admin overrides are merged on top at runtime. */
export const LOCALES: Record<string, Record<string, string>> = { en, fr, es, pt, ar, sw, hi, bn };

export function translate(lang: string, key: string, vars?: Record<string, string | number>, overrides?: Record<string, string>): string {
  let text = overrides?.[key] ?? LOCALES[lang]?.[key] ?? LOCALES.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(String(v));
  return text;
}
