import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { User, CurrencyInfo } from '@bitripay/shared';
import { formatMoney } from '@bitripay/shared';
import { api, getToken, setToken } from './api';
import { setOverrides, setTrLang } from './tr';

interface Store {
  user: (User & { permissions?: string[] }) | null;
  config: any;
  loading: boolean;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  /** Console language (phrase translation); persisted per browser. */
  lang: string;
  setLang: (lang: string) => void;
  login: (token: string, user: User) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
  money: (minor: number, code: string) => string;
  currency: (code: string) => CurrencyInfo;
  can: (perm: string) => boolean;
  toast: (m: string, kind?: 'success' | 'error' | 'info') => void;
  toasts: { id: number; message: string; kind: string }[];
}
const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Store['user']>(null);
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('bitripay.admin.theme') as any) || 'light');
  const [toasts, setToasts] = useState<Store['toasts']>([]);
  const toast = useCallback((message: string, kind: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  const refresh = useCallback(async () => {
    try {
      const cfg = await api.get<any>('/api/config');
      setConfig(cfg);
      if (getToken()) {
        const me = await api.get<{ user: User }>('/api/auth/me');
        if (me.user.role !== 'admin') {
          setToken(null);
          setUser(null);
        } else {
          const detail = await api.get<any>(`/api/admin/users/${me.user.id}`).catch(() => null);
          setUser({ ...me.user, permissions: detail?.user?.permissions ?? [] });
        }
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const onLogout = () => setUser(null);
    window.addEventListener('bitripay:logout', onLogout);
    return () => window.removeEventListener('bitripay:logout', onLogout);
  }, [refresh]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('bitripay.admin.theme', theme);
  }, [theme]);
  const [lang, setLangState] = useState<string>(() => {
    try {
      return localStorage.getItem('bitripay.admin.lang') || 'en';
    } catch {
      return 'en';
    }
  });
  useEffect(() => {
    setTrLang(lang);
    try {
      localStorage.setItem('bitripay.admin.lang', lang);
    } catch {
      /* private mode */
    }
    api
      .get<{ overrides: Record<string, string> }>(`/api/translations/${lang}`)
      .then((r) => setOverrides(lang, r.overrides || {}))
      .catch(() => setOverrides(lang, {}));
  }, [lang]);
  const currency = useCallback((code: string) => config?.currencies?.find((c: CurrencyInfo) => c.code === code) ?? { code, name: code, symbol: code + ' ', decimals: 2, rateToBase: 1 }, [config]);
  const value = useMemo<Store>(
    () => ({
      user,
      config,
      loading,
      theme,
      toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
      lang,
      setLang: setLangState,
      login: async (token, u) => {
        setToken(token);
        await refresh();
        if (u.role !== 'admin') throw new Error('This account is not an administrator');
      },
      logout: () => {
        setToken(null);
        setUser(null);
      },
      refresh,
      money: (m, c) => formatMoney(m, currency(c)),
      currency,
      can: (perm) => !user?.permissions?.length || user.permissions.includes('*') || user.permissions.includes(perm),
      toast,
      toasts,
    }),
    [user, config, loading, theme, lang, refresh, currency, toast, toasts],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useStore = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('store');
  return c;
};
