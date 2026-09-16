/**
 * Phrase-level translation for everything the console shows: `tr('Add money')` looks the English phrase up in the
 * language packs (shared) and the console overrides, and falls back to the phrase itself. Module state, not a hook,
 * so every component can call it; the layout remounts pages when the language or the overrides change.
 */
import { translate } from '@bitripay/shared';

let currentLang = 'en';
const overrides: Record<string, Record<string, string>> = {};
let version = 0;
const listeners = new Set<() => void>();

export function tr(phrase: string, vars?: Record<string, string | number>): string {
  return translate(currentLang, phrase, vars, overrides[currentLang]);
}
export function setTrLang(lang: string): void {
  if (lang === currentLang) return;
  currentLang = lang;
  bump();
}
export function hasOverrides(lang: string): boolean {
  return !!overrides[lang];
}
export function overridesFor(lang: string): Record<string, string> | undefined {
  return overrides[lang];
}
export function setOverrides(lang: string, dict: Record<string, string>): void {
  overrides[lang] = dict;
  bump();
}
function bump() {
  version += 1;
  for (const l of listeners) l();
}
/** Changes whenever the language or its overrides change; pages keyed on it re-render with the new phrases. */
export const trVersion = () => version;
export function subscribeTr(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
