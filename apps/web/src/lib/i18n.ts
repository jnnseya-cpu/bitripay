import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useStore } from './store';
import en from '../locales/en';
import fr from '../locales/fr';
import es from '../locales/es';
import pt from '../locales/pt';
import ar from '../locales/ar';
import sw from '../locales/sw';
import hi from '../locales/hi';
import bn from '../locales/bn';

export type Dict = Record<string, string>;
const BUILT_IN: Record<string, Dict> = { en, fr, es, pt, ar, sw, hi, bn };
const overrides: Record<string, Dict> = {};

export function useT() {
  const { lang } = useStore();
  const [, force] = useState(0);
  useEffect(() => {
    if (overrides[lang]) return;
    api
      .get<{ overrides: Dict }>(`/api/translations/${lang}`)
      .then((r) => {
        overrides[lang] = r.overrides || {};
        force((n) => n + 1);
      })
      .catch(() => {
        overrides[lang] = {};
      });
  }, [lang]);
  return useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      let text = overrides[lang]?.[key] ?? BUILT_IN[lang]?.[key] ?? BUILT_IN.en[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      return text;
    },
    [lang],
  );
}
