import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useStore } from './store';
import { translate } from '@bitripay/shared';

const overrides: Record<string, Record<string, string>> = {};

export function useT() {
  const { lang } = useStore();
  const [, force] = useState(0);
  useEffect(() => {
    if (overrides[lang]) return;
    api
      .get<{ overrides: Record<string, string> }>(`/api/translations/${lang}`)
      .then((r) => {
        overrides[lang] = r.overrides || {};
        force((n) => n + 1);
      })
      .catch(() => {
        overrides[lang] = {};
      });
  }, [lang]);
  return useCallback((key: string, vars?: Record<string, string | number>) => translate(lang, key, vars, overrides[lang]), [lang]);
}
