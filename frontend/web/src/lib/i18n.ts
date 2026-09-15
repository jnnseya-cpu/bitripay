import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import { useStore } from './store';
import { translate } from '@bitripay/shared';
import { hasOverrides, overridesFor, setOverrides, setTrLang, subscribeTr, trVersion } from './tr';

export { tr } from './tr';

/** Key-based translation (`nav.dashboard`) with the console overrides for the current language; loads them once per language. */
export function useT() {
  const { lang } = useStore();
  setTrLang(lang);
  useSyncExternalStore(subscribeTr, trVersion);
  useEffect(() => {
    if (hasOverrides(lang)) return;
    api
      .get<{ overrides: Record<string, string> }>(`/api/translations/${lang}`)
      .then((r) => setOverrides(lang, r.overrides || {}))
      .catch(() => setOverrides(lang, {}));
  }, [lang]);
  return useCallback((key: string, vars?: Record<string, string | number>) => translate(lang, key, vars, overridesFor(lang)), [lang]);
}

/** The language + overrides version, for keying a subtree so `tr()` output refreshes when either changes. */
export function useTrKey(): string {
  const { lang } = useStore();
  const v = useSyncExternalStore(subscribeTr, trVersion);
  return `${lang}:${v}`;
}
